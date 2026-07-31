const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const {
  ROOT,
  PORT,
  MIME,
  TCI_URI,
  REFRESH_MS,
  SATS_BROADCAST_MS,
  TICK_MS,
  STATE_MS,
} = require("./lib/config");

const catalog = require("./lib/catalog");
const state = require("./lib/state");
const tci = require("./lib/tci");
const flex = require("./lib/radios/flex");
const icom = require("./lib/radios/icom");
const rotor = require("./lib/rotor");
const config = require("./lib/config");

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const c of wss.clients) {
    if (c.readyState === 1) c.send(data);
  }
}

state.init({ broadcast });

const server = http.createServer((req, res) => {
  let urlPath = req.url === "/" ? "/index.html" : req.url;
  const q = urlPath.includes("?") ? urlPath.split("?")[1] : "";
  urlPath = urlPath.split("?")[0];

  if (urlPath === "/api/sats") {
    const params = new URLSearchParams(q);
    const filter = params.get("filter") || "trackable";
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    return res.end(JSON.stringify(state.satsPayload(filter)));
  }

  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found: " + urlPath);
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  } else {
    socket.destroy();
  }
});

function broadcastSats() {
  broadcast({ type: "sats", ...state.satsPayload("trackable") });
}

function activeDriver() {
  if (config.useSerialCat()) return "serial";
  if (config.useFlexCat()) return "flex";
  if (config.useTci()) return "tci";
  return "none";
}

function setRadio(on) {
  const want = !!on;
  // Turn off all others first
  if (tci.getRadioState().radioOn) tci.setRadio(false);
  if (flex.getRadioState().radioOn) flex.setRadio(false);
  if (icom.getRadioState().radioOn) icom.setRadio(false);

  if (!want) return;

  if (config.useSerialCat()) icom.setRadio(true);
  else if (config.useFlexCat()) flex.setRadio(true);
  else tci.setRadio(true);
}

function setLock(on) {
  if (config.useSerialCat()) icom.setLock(!!on);
  else if (config.useFlexCat()) flex.setLock(!!on);
  else tci.setLock(!!on);
}

function pushNow() {
  const tk = state.computeTick();
  if (tk) broadcast(tk);
}

wss.on("connection", (ws) => {
  console.log("Client connected");
  ws.send(JSON.stringify({ type: "sats", ...state.satsPayload("trackable") }));
  tci.broadcastStatus();
  flex.broadcastStatus();
  icom.broadcastStatus();
  rotor.broadcastStatus();

  const s = state.computeState();
  if (s) ws.send(JSON.stringify(s));
  const t = state.computeTick();
  if (t) ws.send(JSON.stringify(t));

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "observer" && typeof msg.lat === "number") {
        state.setObserver(msg.lat, msg.lon, msg.elevM);
      }

      if (msg.type === "mode" && typeof msg.index === "number") {
        state.setModeIndex(msg.index);
        const tk = state.computeTick();
        if (tk) broadcast(tk);
        const st = state.computeState();
        if (st) broadcast(st);
      }

      if (msg.type === "sat" && msg.key) {
        state
          .loadSatellite(msg.key)
          .then(() => {
            const st = state.computeState();
            if (st) broadcast(st);
            const tk = state.computeTick();
            if (tk) broadcast(tk);
            broadcastSats();
          })
          .catch((err) => {
            ws.send(JSON.stringify({ type: "error", message: err.message }));
          });
      }

      if (msg.type === "radio") {
        setRadio(!!msg.on);
      }

      if (msg.type === "lock") {
        setLock(!!msg.on);
      }

      if (msg.type === "antenna") {
        rotor.setAntenna(!!msg.on);
      }

      if (msg.type === "fine") {
        if (config.useSerialCat()) {
          if (typeof msg.step === "number") icom.setStep(msg.step);
          if (typeof msg.delta === "number") icom.adjustFine(msg.delta);
        } else if (config.useFlexCat()) {
          if (typeof msg.step === "number") flex.setStep(msg.step);
          if (typeof msg.delta === "number") flex.adjustFine(msg.delta);
        } else {
          if (typeof msg.step === "number") tci.setStep(msg.step);
          if (typeof msg.delta === "number") tci.adjustFine(msg.delta);
        }
        pushNow();
      }

      if (msg.type === "center") {
        if (config.useSerialCat()) icom.center();
        else if (config.useFlexCat()) flex.center();
        else tci.center();
        pushNow();
      }

      if (msg.type === "endpoints") {
        const {
          tciChanged,
          rotorChanged,
          catChanged,
          flexChanged,
          radioSelChanged,
        } = config.applyEndpoints({
          radioTransport: msg.radioTransport,
          radioType: msg.radioType,
          radioProtocol: msg.radioProtocol,
          tciHost: msg.tciHost,
          tciPort: msg.tciPort,
          flexUlHost: msg.flexUlHost,
          flexUlPort: msg.flexUlPort,
          flexDlHost: msg.flexDlHost,
          flexDlPort: msg.flexDlPort,
          flexHost: msg.flexHost,
          flexPort: msg.flexPort,
          serialDevice: msg.serialDevice,
          serialBaud: msg.serialBaud,
          catDevice: msg.serialDevice,
          rotorHost: msg.rotorHost,
          rotorAzPort: msg.rotorAzPort,
          rotorElPort: msg.rotorElPort,
        });
        console.log("Endpoints updated", config.getEndpoints());
        console.log("Radio path:", activeDriver());

        if (tciChanged) tci.applyEndpointChange();
        if (flexChanged || radioSelChanged) flex.applyEndpointChange();
        if (catChanged || radioSelChanged) icom.applyEndpointChange();
        if (rotorChanged) rotor.applyEndpointChange();

        if (radioSelChanged) {
          const anyOn =
            tci.getRadioState().radioOn ||
            flex.getRadioState().radioOn ||
            icom.getRadioState().radioOn;
          if (anyOn) {
            tci.setRadio(false);
            flex.setRadio(false);
            icom.setRadio(false);
            setRadio(true);
          }
        }

        broadcast({
          type: "endpoints",
          ...config.getEndpoints(),
        });
      }
    } catch (e) {
      console.warn("Bad message", e.message);
    }
  });

  ws.on("close", () => console.log("Client disconnected"));
});

setInterval(() => {
  const t = state.computeTick();
  if (t) broadcast(t);
}, TICK_MS);

setInterval(() => {
  const s = state.computeState();
  if (s) broadcast(s);
}, STATE_MS);

setInterval(broadcastSats, SATS_BROADCAST_MS);

setInterval(() => {
  catalog.refreshCatalog().catch(() => {});
  catalog.refreshStatus().catch(() => {});
}, REFRESH_MS);

(async () => {
  await catalog.refreshCatalog();
  await catalog.refreshStatus();
  const key = catalog.pickDefaultKey();
  if (key) {
    try {
      await state.loadSatellite(key);
    } catch (err) {
      console.warn("Default sat load failed (" + key + "):", err.message);
    }
  }
  server.listen(PORT, "0.0.0.0", () => {
    console.log("Sat Tracker  http://127.0.0.1:" + PORT);
    console.log("TCI target   " + TCI_URI);
    console.log(
      "Flex UL      " +
        config.FLEX_UL_HOST +
        ":" +
        config.FLEX_UL_PORT,
    );
    console.log(
      "Flex DL      " +
        config.FLEX_DL_HOST +
        ":" +
        config.FLEX_DL_PORT,
    );
    console.log(
      "Icom CI-V    " +
        config.CAT_DEVICE +
        " @ " +
        config.CAT_BAUD +
        " addr 0x" +
        config.CAT_CIV_ADDR.toString(16).toUpperCase(),
    );
    console.log(
      "Tick " + TICK_MS + "ms (Doppler), state " + STATE_MS + "ms (map)",
    );
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
