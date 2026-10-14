const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

/** Build label: VERSION file (SFX stamp) → ~/.rpitrack/version → package.json + git sha. */
function appVersion() {
  const tryRead = (f) => {
    try {
      const v = fs.readFileSync(f, "utf8").trim();
      return v || null;
    } catch (_) {
      return null;
    }
  };
  let v =
    tryRead(path.join(__dirname, "VERSION")) ||
    tryRead(path.join(require("os").homedir(), ".rpitrack", "version"));
  if (v) return v;
  let pkg = "?";
  try {
    pkg = require("./package.json").version;
  } catch (_) {}
  try {
    const sha = require("child_process")
      .execSync("git rev-parse --short HEAD", { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    if (sha) return pkg + "+" + sha;
  } catch (_) {}
  return pkg;
}
const APP_VERSION = appVersion();
console.log("Sat Tracker starting version " + APP_VERSION);

let shuttingDown = false;
function logShutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Sat Tracker shutting down (" + reason + ") version " + APP_VERSION);
}
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    logShutdown(sig);
    setTimeout(() => process.exit(0), 200); // let log stream flush
  });
}
process.on("exit", (code) => logShutdown("exit " + code));
const { WebSocketServer } = require("ws");

// Capture console as early as possible (before radio/rotor registration logs)
const logHub = require("./lib/log-hub");

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
const tle = require("./lib/tle");
const radios = require("./lib/radios");
const rotor = require("./lib/rotor");
const rotors = require("./lib/rotors");
const config = require("./lib/config");
const platform = require("./lib/platform");
const profiles = require("./lib/profiles");
const connectionTest = require("./lib/connection-test");
const logbook = require("./lib/logbook");
const wsjtxListener = require("./lib/wsjtx-listener");

/** WebSocket server; set after createServer. broadcast() is safe before that. */
let wss = null;

function broadcast(obj) {
  if (!wss) return;
  const data = JSON.stringify(obj);
  for (const c of wss.clients) {
    if (c.readyState === 1) c.send(data);
  }
}

state.init({ broadcast });
logHub.setBroadcast(broadcast);
logHub.init({ broadcast });

/** Current logging output settings (from lib/config). */
function logOutputCfg() {
  return {
    method: config.LOG_METHOD,
    adifPath: config.LOG_ADIF_PATH,
    udpHost: config.LOG_UDP_HOST,
    udpPort: config.LOG_UDP_PORT,
    udpFormat: config.LOG_UDP_FORMAT,
    udpTtl: config.LOG_UDP_TTL,
    udpIface: config.LOG_UDP_IFACE,
  };
}

function stationFromProfile(fallback) {
  const prof = profiles.getActive() || {};
  const pcfg = prof.config || {};
  const fb = fallback || {};
  return {
    callsign: pcfg.callsign || fb.callsign || "",
    grid: pcfg.grid || fb.grid || "",
  };
}

/** WSJT-X listener: enrich with sat info and re-send via the logging output. */
const wsjtx = wsjtxListener.createListener({
  onQso: (q) => {
    const ctx = state.getLogContext();
    const e = wsjtxListener.enrichRecord(q.fields, ctx, stationFromProfile());
    const rec = {
      fields: e.fields,
      txHz: e.txHz,
      rxHz: e.rxHz,
      time: new Date(),
      warnings: e.warnings.concat(e.note ? [e.note] : []),
      lotwAccepted: e.lotwAccepted,
    };
    logbook
      .outputRecord(rec, logOutputCfg())
      .then((r) => {
        const out = Object.assign(
          {
            type: "log-result",
            source: "wsjtx",
            wsjtxClient: q.clientId,
            wsjtxMessage: q.source,
            enriched: e.enriched,
          },
          r,
        );
        console.log(
          "WSJT-X QSO",
          q.fields.CALL,
          "from",
          q.clientId,
          q.source,
          e.enriched ? "+ " + e.fields.SAT_NAME : "(pass-through)",
          r.ok ? "-> " + r.method + " " + r.target : "FAILED: " + r.error,
          rec.warnings.length ? rec.warnings.join("; ") : "",
        );
        broadcast(out);
        broadcastWsjtxStatus(); // refresh forwarded count in config
      })
      .catch((err) => console.warn("WSJT-X forward:", err.message));
  },
  onStatus: () => broadcastWsjtxStatus(),
});

function wsjtxStatusPayload() {
  const st = wsjtx.getStatus();
  return Object.assign({ type: "wsjtx-listener" }, st, {
    enabled: config.WSJTX_LISTEN,
    warning: wsjtxListener.outputLoopWarning(
      { enabled: config.WSJTX_LISTEN, port: config.WSJTX_LISTEN_PORT },
      logOutputCfg(),
    ),
  });
}

function broadcastWsjtxStatus() {
  broadcast(wsjtxStatusPayload());
}

/** Gate: the listener only runs while Radio AND Antenna are both on. */
function wsjtxGateState() {
  let radioOn = false;
  let antennaOn = false;
  try {
    const rs = radios.active().getRadioState();
    radioOn = !!(rs && rs.radioOn);
  } catch (_) {}
  try {
    const r = rotor.getRotorState();
    antennaOn = !!(r && r.antennaOn);
  } catch (_) {}
  return { radioOn, antennaOn };
}

function syncWsjtxGate() {
  const g = wsjtxGateState();
  const missing = [];
  if (!g.radioOn) missing.push("Radio");
  if (!g.antennaOn) missing.push("Antenna");
  const reason =
    (missing.length === 2 ? "Radio and Antenna" : missing[0] || "Radio and Antenna") +
    " must be on";
  if (wsjtx.setGate(g.radioOn && g.antennaOn, reason)) {
    console.log(
      "WSJT-X listener gate " +
        (g.radioOn && g.antennaOn ? "open" : "closed (" + reason + ")"),
    );
  }
}
// Radio/antenna state can also change inside drivers (errors, endpoint
// changes), so poll cheaply in addition to the explicit hooks below.
setInterval(syncWsjtxGate, 500).unref();

function applyWsjtxListener() {
  syncWsjtxGate();
  wsjtx.configure({
    enabled: config.WSJTX_LISTEN,
    port: config.WSJTX_LISTEN_PORT,
    bind: config.WSJTX_LISTEN_BIND,
  });
  broadcastWsjtxStatus();
}

function applyProfileToRuntime(prof) {
  if (!prof) return;
  state.setFavorites(Array.isArray(prof.favorites) ? prof.favorites : []);
  const cfg = prof.config && typeof prof.config === "object" ? prof.config : {};
  if (Object.keys(cfg).length) {
    const flags = config.applyEndpoints(cfg);
    radios.applyEndpointChange(flags);
    if (flags.rotorChanged) rotor.applyEndpointChange();
  }
  applyWsjtxListener();
}

function broadcastProfiles() {
  broadcast(profiles.publicPayload());
}

// Load named profiles from ~/.rpitrack/profiles.json and apply active one
profiles.load();
applyProfileToRuntime(profiles.getActive());

/** In-memory NORAD → SatNOGS sat_id cache (process lifetime). */
const satnogsCache = new Map();

function fetchSatnogsByNorad(norad) {
  const key = String(norad || "").trim();
  if (!key) return Promise.resolve(null);
  if (satnogsCache.has(key)) return Promise.resolve(satnogsCache.get(key));

  const url =
    "https://db.satnogs.org/api/satellites/?norad_cat_id=" +
    encodeURIComponent(key);
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { headers: { Accept: "application/json", "User-Agent": "pi-sat-track" } },
      (resp) => {
        let body = "";
        resp.on("data", (c) => {
          body += c;
        });
        resp.on("end", () => {
          try {
            const arr = JSON.parse(body);
            const row = Array.isArray(arr) && arr[0] ? arr[0] : null;
            const satId = row && row.sat_id ? String(row.sat_id) : null;
            const payload = satId
              ? {
                  sat_id: satId,
                  norad_cat_id: row.norad_cat_id,
                  name: row.name || null,
                  names: row.names || null,
                  status: row.status || null,
                }
              : null;
            satnogsCache.set(key, payload);
            resolve(payload);
          } catch (e) {
            satnogsCache.set(key, null);
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => {
      resolve(null);
    });
    req.setTimeout(8000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

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

  if (urlPath === "/api/host") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    return res.end(
      JSON.stringify({
        ...platform.hostInfo(),
        rotorCatalog: rotors.catalog(),
        rotorType: config.ROTOR_TYPE,
        rotorAzDevice: config.ROTOR_AZ_DEVICE,
        rotorElDevice: config.ROTOR_EL_DEVICE,
        rotorBaud: config.ROTOR_BAUD,
      }),
    );
  }

  if (urlPath === "/api/satnogs") {
    const params = new URLSearchParams(q);
    const norad = params.get("norad");
    if (!norad) {
      res.writeHead(400, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      return res.end(JSON.stringify({ error: "norad required" }));
    }
    return fetchSatnogsByNorad(norad).then((payload) => {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=86400",
      });
      res.end(JSON.stringify(payload || { sat_id: null, norad_cat_id: norad }));
    });
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

wss = new WebSocketServer({ noServer: true });

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

let wsClientSeq = 0;
wss.on("connection", (ws, req) => {
  ws._clientTag =
    "client #" + ++wsClientSeq +
    " " + ((req && req.socket && req.socket.remoteAddress) || "?");
  console.log("Client connected", ws._clientTag);
  logHub.sendHistory(ws);
  ws.send(JSON.stringify({ type: "sats", ...state.satsPayload("trackable") }));
  ws.send(
    JSON.stringify({
      type: "host",
      ...platform.hostInfo(),
      rotorCatalog: rotors.catalog(),
      rotorType: config.ROTOR_TYPE,
      rotorAzDevice: config.ROTOR_AZ_DEVICE,
      rotorElDevice: config.ROTOR_EL_DEVICE,
      rotorBaud: config.ROTOR_BAUD,
      tleSources: tle.getTleSources(),
    }),
  );
  ws.send(JSON.stringify(profiles.publicPayload()));
  ws.send(JSON.stringify(wsjtxStatusPayload()));
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

      if (msg.type === "tle-sources" && Array.isArray(msg.sources)) {
        const next = tle.setTleSources(msg.sources);
        broadcast({ type: "tle-sources", sources: next });
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

      if (msg.type === "sat" && msg.key && msg.user !== true) {
        // Old/stale clients push their remembered sat on connect. Once the
        // server has a sat, only explicit user selections may change it.
        const cur = state.getCurrentKey();
        if (cur) {
          console.log(
            "Ignored non-user sat request",
            msg.key,
            "(keeping",
            cur + ")",
          );
          const st = state.computeState();
          if (st) ws.send(JSON.stringify(st));
          return;
        }
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
        radios.setRadio(!!msg.on, ws._clientTag || "client");
        syncWsjtxGate();
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
        syncWsjtxGate();
      }

      if (msg.type === "park") {
        rotor.park();
      }

      if (msg.type === "fine") {
        const r = radios.active();
        const side = msg.side === "dl" ? "dl" : "ul";
        if (typeof msg.step === "number" && r.setStep) r.setStep(msg.step);
        if (typeof msg.delta === "number" && r.adjustFine)
          r.adjustFine(msg.delta, side);
        // Persist UL/DL fine for this sat so next load restores it
        if (typeof state.persistCurrentOffsets === "function")
          state.persistCurrentOffsets();
        pushNow();
      }

      if (msg.type === "center") {
        radios.active().center();
        // Center = clear saved calibration for current sat
        if (typeof state.clearPersistedOffsets === "function")
          state.clearPersistedOffsets();
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
          singleRadio: !!msg.singleRadio,
          txSplit: msg.txSplit !== false,
          radioUl: msg.radioUl,
          radioDl: msg.radioDl,
          radioTransport: msg.radioTransport,
          radioType: msg.radioType,
          radioProtocol: msg.radioProtocol,
          serialMake: msg.serialMake,
          serialModel: msg.serialModel,
          tciHost: msg.tciHost,
          tciPort: msg.tciPort,
          sdrconnectHost: msg.sdrconnectHost,
          sdrconnectPort: msg.sdrconnectPort,
          rigctlHost: msg.rigctlHost,
          rigctlPort: msg.rigctlPort,
          rigctlUlHost: msg.rigctlUlHost,
          rigctlUlPort: msg.rigctlUlPort,
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
          serialDevice2: msg.serialDevice2,
          serialBaud2: msg.serialBaud2,
          catDevice: msg.serialDevice,
          rotorHost: msg.rotorHost,
          rotorAzPort: msg.rotorAzPort,
          rotorElPort: msg.rotorElPort,
          rotorType: msg.rotorType,
          rotorAzDevice: msg.rotorAzDevice,
          rotorElDevice: msg.rotorElDevice,
          rotorBaud: msg.rotorBaud,
          rotorParkAz: msg.rotorParkAz,
          rotorParkEl: msg.rotorParkEl,
          rotorElMax: msg.rotorElMax,
          rotorAzOnly: !!msg.rotorAzOnly,
          rotorMinEl: msg.rotorMinEl,
          rotorAzStop: msg.rotorAzStop,
          logMethod: msg.logMethod,
          logAdifPath: msg.logAdifPath,
          logUdpHost: msg.logUdpHost,
          logUdpPort: msg.logUdpPort,
          logUdpFormat: msg.logUdpFormat,
          logUdpTtl: msg.logUdpTtl,
          logUdpIface: msg.logUdpIface,
          wsjtxListen: !!msg.wsjtxListen,
          wsjtxListenPort: msg.wsjtxListenPort,
          wsjtxListenBind: msg.wsjtxListenBind,
        };
        const flags = config.applyEndpoints(ep);
        console.log("Endpoints updated", config.getEndpoints());
        console.log("Radio path:", radios.active().meta.id);
        console.log("Rotor path:", rotors.active().meta.id);

        radios.applyEndpointChange(flags);
        if (flags.rotorChanged) rotor.applyEndpointChange();
        applyWsjtxListener();

        const cfgPatch = Object.assign({}, ep);
        if (typeof msg.callsign === "string") cfgPatch.callsign = msg.callsign;
        if (typeof msg.grid === "string") cfgPatch.grid = msg.grid;
        if (typeof msg.elevation === "number")
          cfgPatch.elevation = msg.elevation;
        profiles.updateActive({ config: cfgPatch });
        broadcastProfiles();

        broadcast({
          type: "endpoints",
          ...config.getEndpoints(),
          rotorCatalog: rotors.catalog(),
        });
      }

      if (msg.type === "log-qso") {
        const station = stationFromProfile({
          callsign: msg.stationCallsign,
          grid: msg.stationGrid,
        });
        logbook
          .logQso({
            call: msg.call,
            ctx: state.getLogContext(),
            station,
            cfg: logOutputCfg(),
          })
          .then((r) => {
            if (r.ok) {
              console.log(
                "QSO logged",
                r.record.call,
                r.record.satName,
                r.record.mode,
                r.record.freq,
                "->",
                r.method,
                r.target,
                r.warnings && r.warnings.length ? r.warnings.join("; ") : "",
              );
            } else {
              console.warn("QSO log failed:", r.error);
            }
            ws.send(
              JSON.stringify(
                Object.assign({ type: "log-result", reqId: msg.reqId || null }, r),
              ),
            );
          })
          .catch((e) => {
            ws.send(
              JSON.stringify({
                type: "log-result",
                reqId: msg.reqId || null,
                ok: false,
                error: e.message || "Log error",
              }),
            );
          });
        return;
      }

      if (msg.type === "test-rotor-step") {
        const reqId = msg.reqId || null;
        console.log(
          "Test rotor step",
          msg.action,
          msg.axis,
          connectionTest.rotorTestDevice(msg),
        );
        connectionTest
          .testRotorStep(msg, {
            onProgress: (p) => {
              try {
                ws.send(
                  JSON.stringify({
                    type: "test-rotor-progress",
                    reqId,
                    axis: p.axis,
                    pos: p.pos,
                    target: p.target,
                    phase: p.phase,
                  }),
                );
              } catch (_) {}
            },
          })
          .then((r) => {
            console.log(
              "Test rotor step result",
              msg.action,
              msg.axis,
              r.ok,
              r.message,
            );
            ws.send(
              JSON.stringify({
                type: "test-rotor-step-result",
                reqId,
                ok: !!r.ok,
                message: r.message || "",
                detail: r.detail || null,
              }),
            );
          })
          .catch((e) => {
            console.warn("Test rotor step error", e.message);
            ws.send(
              JSON.stringify({
                type: "test-rotor-step-result",
                reqId,
                ok: false,
                message: e.message || "Test error",
              }),
            );
          });
        return;
      }

      if (msg.type === "test-radio") {
        const side = msg.side === "dl" ? "dl" : "ul";
        const target = "radio-" + side;
        console.log(
          "Test radio",
          side,
          msg.radio && msg.radio.transport,
          msg.radio &&
            (msg.radio.serialDevice ||
              msg.radio.tciEndpoint ||
              msg.radio.catEndpoint ||
              msg.radio.rigctlEndpoint),
        );
        const radioCfg = Object.assign({}, msg.radio || {}, {
          _testSide: side,
        });
        connectionTest
          .testRadioSide(radioCfg)
          .then((r) => {
            console.log("Test radio result", target, r.ok, r.message);
            ws.send(
              JSON.stringify({
                type: "test-result",
                target,
                ok: !!r.ok,
                message: r.message || "",
                detail: r.detail || null,
              }),
            );
          })
          .catch((e) => {
            console.warn("Test radio error", target, e.message);
            ws.send(
              JSON.stringify({
                type: "test-result",
                target,
                ok: false,
                message: e.message || "Test error",
              }),
            );
          });
        return;
      }

      if (msg.type === "test-rotor") {
        console.log("Test rotor", msg.rotor);
        connectionTest
          .testRotor(msg.rotor || {})
          .then((r) => {
            console.log("Test rotor result", r.ok, r.message);
            ws.send(
              JSON.stringify({
                type: "test-result",
                target: "rotor",
                ok: !!r.ok,
                message: r.message || "",
                detail: r.detail || null,
              }),
            );
          })
          .catch((e) => {
            console.warn("Test rotor error", e.message);
            ws.send(
              JSON.stringify({
                type: "test-result",
                target: "rotor",
                ok: false,
                message: e.message || "Test error",
              }),
            );
          });
        return;
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
          broadcast({
            type: "endpoints",
            ...config.getEndpoints(),
            rotorCatalog: rotors.catalog(),
          });
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
          broadcast({
            type: "endpoints",
            ...config.getEndpoints(),
            rotorCatalog: rotors.catalog(),
          });
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
          broadcast({
            type: "endpoints",
            ...config.getEndpoints(),
            rotorCatalog: rotors.catalog(),
          });
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
        if (msg.config && typeof msg.config === "object")
          patch.config = msg.config;
        if (msg.lastSat !== undefined) patch.lastSat = msg.lastSat;
        profiles.updateActive(patch);
        if (patch.config) {
          const flags = config.applyEndpoints(patch.config);
          radios.applyEndpointChange(flags);
          if (flags.rotorChanged) rotor.applyEndpointChange();
          applyWsjtxListener();
        }
        if (Array.isArray(patch.favorites)) {
          state.setFavorites(patch.favorites);
        }
        broadcastProfiles();
        broadcast({
          type: "endpoints",
          ...config.getEndpoints(),
          rotorCatalog: rotors.catalog(),
        });
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
    const host = platform.hostInfo();
    console.log("Sat Tracker  http://127.0.0.1:" + PORT);
    console.log("Version     " + APP_VERSION);
    console.log(
      "Host OS     " +
        host.platform +
        " (" +
        host.type +
        " " +
        host.release +
        ") " +
        host.arch +
        " @ " +
        host.hostname,
    );
    console.log(
      "Serial      default " +
        host.defaultCatDevice +
        (host.serialDevices.length
          ? " | present: " + host.serialDevices.join(", ")
          : " | (none scanned)"),
    );
    console.log(
      "Active radio",
      radios.active().meta.id,
      radios.active().meta.label,
    );
    console.log(
      "Active rotor",
      rotors.active().meta.id,
      rotors.active().meta.label,
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
