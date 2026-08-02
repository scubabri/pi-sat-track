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
const radios = require("./lib/radios");
const rotor = require("./lib/rotor");
const config = require("./lib/config");
const profiles = require("./lib/profiles");

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const c of wss.clients) {
    if (c.readyState === 1) c.send(data);
  }
}

state.init({ broadcast });

function applyProfileToRuntime(prof) {
  if (!prof) return;
  state.setFavorites(Array.isArray(prof.favorites) ? prof.favorites : []);
  const cfg = prof.config && typeof prof.config === "object" ? prof.config : {};
  if (Object.keys(cfg).length) {
    const flags = config.applyEndpoints(cfg);
    radios.applyEndpointChange(flags);
    if (flags.rotorChanged) rotor.applyEndpointChange();
  }
}

function broadcastProfiles() {
  broadcast(profiles.publicPayload());
}

// Load named profiles from ~/.rpitrack/profiles.json and apply active one
profiles.load();
applyProfileToRuntime(profiles.getActive());

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

function pushNow() {
  const tk = state.computeTick();
  if (tk) broadcast(tk);
}

wss.on("connection", (ws) => {
  console.log("Client connected");
  ws.send(JSON.stringify({ type: "sats", ...state.satsPayload("trackable") }));
  ws.send(JSON.stringify(profiles.publicPayload()));
  radios.broadcastAllStatus();
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

      if (msg.type === "favorites" && Array.isArray(msg.keys)) {
        state.setFavorites(msg.keys);
        profiles.updateActive({ favorites: msg.keys });
        broadcastProfiles();
        const tk = state.computeTick();
        if (tk) broadcast(tk);
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
            profiles.updateActive({ lastSat: msg.key });
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
        radios.setRadio(!!msg.on);
      }

      if (msg.type === "lock") {
        radios.setLock(!!msg.on);
      }

      if (msg.type === "ulFixed") {
        state.setUlFixed(!!msg.on);
        pushNow();
      }

      if (msg.type === "antenna") {
        rotor.setAntenna(!!msg.on);
      }

      if (msg.type === "fine") {
        const r = radios.active();
        const side = msg.side === "dl" ? "dl" : "ul";
        if (typeof msg.step === "number" && r.setStep) r.setStep(msg.step);
        if (typeof msg.delta === "number" && r.adjustFine)
          r.adjustFine(msg.delta, side);
        pushNow();
      }

      if (msg.type === "center") {
        radios.active().center();
        pushNow();
      }

      if (msg.type === "ctcss") {
        const which =
          msg.which === "access" || msg.which === "activation"
            ? msg.which
            : "off";
        const r = radios.active();
        if (typeof r.setCtcss === "function") r.setCtcss(which);
        pushNow();
      }

      if (msg.type === "endpoints") {
        const ep = {
          radioTransport: msg.radioTransport,
          radioType: msg.radioType,
          radioProtocol: msg.radioProtocol,
          serialMake: msg.serialMake,
          serialModel: msg.serialModel,
          tciHost: msg.tciHost,
          tciPort: msg.tciPort,
          flexUlHost: msg.flexUlHost,
          flexUlPort: msg.flexUlPort,
          flexDlHost: msg.flexDlHost,
          flexDlPort: msg.flexDlPort,
          flexApiHost: msg.flexApiHost,
          flexApiPort: msg.flexApiPort,
          flexHost: msg.flexHost,
          flexPort: msg.flexPort,
          serialDevice: msg.serialDevice,
          serialBaud: msg.serialBaud,
          catDevice: msg.serialDevice,
          rotorHost: msg.rotorHost,
          rotorAzPort: msg.rotorAzPort,
          rotorElPort: msg.rotorElPort,
        };
        const flags = config.applyEndpoints(ep);
        console.log("Endpoints updated", config.getEndpoints());
        console.log("Radio path:", radios.active().meta.id);

        radios.applyEndpointChange(flags);
        if (flags.rotorChanged) rotor.applyEndpointChange();

        const cfgPatch = Object.assign({}, ep);
        if (typeof msg.callsign === "string") cfgPatch.callsign = msg.callsign;
        if (typeof msg.grid === "string") cfgPatch.grid = msg.grid;
        if (typeof msg.elevation === "number") cfgPatch.elevation = msg.elevation;
        profiles.updateActive({ config: cfgPatch });
        broadcastProfiles();

        broadcast({
          type: "endpoints",
          ...config.getEndpoints(),
        });
      }

      if (msg.type === "profile-select" && msg.name) {
        if (profiles.setActive(msg.name)) {
          applyProfileToRuntime(profiles.getActive());
          broadcastProfiles();
          const st = state.computeState();
          if (st) broadcast(st);
          const tk = state.computeTick();
          if (tk) broadcast(tk);
          broadcastSats();
          broadcast({ type: "endpoints", ...config.getEndpoints() });
        } else {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Unknown profile: " + msg.name,
            }),
          );
        }
      }

      if (msg.type === "profile-create" && msg.name) {
        if (profiles.createProfile(msg.name, msg.fromActive !== false)) {
          applyProfileToRuntime(profiles.getActive());
          broadcastProfiles();
          broadcast({ type: "endpoints", ...config.getEndpoints() });
        } else {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Could not create profile (name empty or exists)",
            }),
          );
        }
      }

      if (msg.type === "profile-delete" && msg.name) {
        if (profiles.deleteProfile(msg.name)) {
          applyProfileToRuntime(profiles.getActive());
          broadcastProfiles();
          const st = state.computeState();
          if (st) broadcast(st);
          const tk = state.computeTick();
          if (tk) broadcast(tk);
          broadcastSats();
          broadcast({ type: "endpoints", ...config.getEndpoints() });
        } else {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Could not delete profile",
            }),
          );
        }
      }

      if (msg.type === "profile-rename" && msg.from && msg.to) {
        if (profiles.renameProfile(msg.from, msg.to)) {
          broadcastProfiles();
        } else {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Could not rename profile",
            }),
          );
        }
      }

      if (msg.type === "profile-save") {
        const patch = {};
        if (Array.isArray(msg.favorites)) patch.favorites = msg.favorites;
        if (msg.config && typeof msg.config === "object") patch.config = msg.config;
        if (msg.lastSat !== undefined) patch.lastSat = msg.lastSat;
        profiles.updateActive(patch);
        if (patch.config) {
          const flags = config.applyEndpoints(patch.config);
          radios.applyEndpointChange(flags);
          if (flags.rotorChanged) rotor.applyEndpointChange();
        }
        if (Array.isArray(patch.favorites)) {
          state.setFavorites(patch.favorites);
        }
        broadcastProfiles();
        broadcast({ type: "endpoints", ...config.getEndpoints() });
        const tk = state.computeTick();
        if (tk) broadcast(tk);
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
    console.log(
      "Active radio",
      radios.active().meta.id,
      radios.active().meta.label,
    );
    console.log("TCI target   " + TCI_URI);
    console.log(
      "Tick " + TICK_MS + "ms (Doppler), state " + STATE_MS + "ms (map)",
    );
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
