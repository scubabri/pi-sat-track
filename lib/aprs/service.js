/**
 * APRS / KISS TNC service: owns one KISS client per enabled connection in the
 * active profile's config.aprs.connections (e.g. Graywolf one channel per
 * KISS TCP port + Direwolf 9600), feeds RX from every RX-capable connection
 * into one packet list / heard store / daily log (tagged with the connection
 * name, duplicates heard on two connections merged), routes TX to the
 * connection whose role and speed (1200 AFSK / 9600 G3RUH) match the
 * selected satellite, and turns RX frames into packets (list + heard store + daily log),
 * and builds / gates / sends frames the UISS way: one header (To = AX.25
 * destination, Via = path) for every send type: APRS position, UI text
 * (sent as typed), APRS message (For = addressee) or header only.
 *
 * Wiring (server.js):
 *   const aprs = createService({ broadcast, getStation, getTxContext });
 *   aprs.configure(profile.config.aprs);
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const ax25 = require("../ax25");
const { KissClient, createTransport } = require("../kiss/client");
const bt = require("../kiss/bluetooth");
const { normalizeMac } = bt;
const { parseInfo } = require("./parse");
const build = require("./build");
const { createStore, summarize } = require("./store");
const describe = require("./describe");
const satSpeeds = require("./sat-speeds");

const PRESET_PORTS = { graywolf: 6700, direwolf: 8001 };
const MAX_PACKETS = 300;
/** Digipeater calls / aliases used by satellites (path flag "via sat"). */
// Satellite digipeater calls / aliases. A Via is a satellite path only when a
// hop is one of these; WIDEn-N, RELAY, TRACE and any other call (SHEPRD,
// KF6RAL-1, ...) are terrestrial.
const SAT_DIGIS = new Set([
  "RS0ISS", "NA1SS", "ARISS", "APRSAT", "DP0SNX", "W3ADO", "PCSAT", "YB0X", "PSAT", "PSAT2",
  "9A0CC", "HA2GRB", "HS0K", "OK0KST", "OK0LSR", "OM9MAR",
]);
const GRAYWOLF_DEDUP_MS = 30000;
const RETRY_MS = 30000;
const KINDS = new Set(["beacon", "text", "message", "header"]);
const MAX_CONNECTIONS = 8;
/** Same TNC2 packet heard on another connection within this window = one packet. */
const DEDUPE_MS = 5000;
const ROLES = new Set(["rx", "tx", "rxtx"]);
const PRESET_NAMES = { graywolf: "Graywolf", direwolf: "Direwolf", "th-d74": "TH-D74", custom: "TNC" };
const APRS_MODE_RE = /APRS|AFSK|AX\.?25|PACKET|\bPKT\b|DIGI/i;

/** One KISS connection (a Graywolf channel port, Direwolf, a BT TNC...). */
function connectionDefaults() {
  return {
    id: "c1",
    name: "Graywolf",
    enabled: true,
    preset: "graywolf", // graywolf | direwolf | custom (UI hint + default port)
    transport: "tcp", // tcp | bluetooth (RFCOMM by MAC) | serial (device path: /dev/rfcomm0, /dev/ttyACM0)
    host: "", // "" = localhost
    port: 6700,
    serialDevice: "/dev/rfcomm0",
    serialBaud: 9600,
    btAddress: "", // Bluetooth MAC (transport bluetooth)
    btChannel: 2, // RFCOMM channel: TH-D74/D75 SPP = 2
    kissPort: 0, // Direwolf / multi-port TNCs only; Graywolf = one channel per TCP port
    role: "rxtx", // rx | tx | rxtx
    speed: 1200, // 1200 AFSK | 9600 G3RUH (modem on that channel)
  };
}

function defaults() {
  return {
    enabled: false, // master "Connect to a KISS TNC"
    connections: [connectionDefaults()],
    defaultTxConn: "", // "" = first TX-capable 1200 connection (terrestrial / no sat)
    satSpeeds: {}, // per-sat speed override: { "ISS": 1200, "CROCUBE": 9600 }
    ssid: "", // optional; "" = plain callsign (SSID 0)
    path: "ARISS", // default Via for sat work
    satPaths: {}, // per-sat Via override: { "ISS": "ARISS", "SONATE-2": "DP0SNX" }
    defaultTo: "CQ", // UISS-style default To (AX.25 destination)
    symbol: "/`",
    comment: "",
    posSource: "grid", // grid | latlon
    lat: null,
    lon: null,
    posAmbiguity: 0,
    txEnabled: false,
    txRequireRadioOn: true,
    retryTag: true, // repeated identical sends within 30 s get " #2", " #3" (past Graywolf / digi dupe filters)
    heardExpireMin: 60,
    digiTimeoutS: 30, // "No digipeat heard" after this long
    dupeWindowS: 30, // same source + info within this = one group (Graywolf's dupe window)
    logToFile: true,
  };
}

function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

/** Normalise one connection (i = row index, for default id / name). */
function normalizeConnection(raw, i) {
  const d = connectionDefaults();
  const r = raw && typeof raw === "object" ? raw : {};
  const c = Object.assign({}, d);
  const n = (i | 0) + 1;
  c.id = typeof r.id === "string" && /^[A-Za-z0-9_-]{1,16}$/.test(r.id) ? r.id : "c" + n;
  c.enabled = r.enabled !== false;
  // bluetooth = RFCOMM by MAC; serial = a device path. Configs from before the
  // MAC field (no btAddress key) used "bluetooth" for /dev/rfcomm0: now "serial".
  c.transport = r.transport === "serial" ? "serial" : r.transport === "bluetooth" ? (r.btAddress === undefined && !r.btChannel ? "serial" : "bluetooth") : "tcp";
  c.preset = ["graywolf", "direwolf", "th-d74", "custom"].includes(r.preset) ? r.preset : d.preset;
  c.btAddress = normalizeMac(r.btAddress);
  const ch = parseInt(r.btChannel, 10);
  c.btChannel = ch >= 1 && ch <= 30 ? ch : d.btChannel;
  c.name = build.cleanText(r.name, 24).trim() || PRESET_NAMES[c.preset] + (n > 1 ? " " + n : "");
  c.host = typeof r.host === "string" ? r.host.trim().slice(0, 253) : "";
  c.port = clampInt(r.port, 1, 65535, PRESET_PORTS[c.preset] || d.port);
  if (typeof r.serialDevice === "string" && r.serialDevice.trim()) c.serialDevice = r.serialDevice.trim();
  c.serialBaud = clampInt(r.serialBaud, 1200, 921600, d.serialBaud);
  c.kissPort = clampInt(r.kissPort, 0, 15, 0);
  c.role = ROLES.has(r.role) ? r.role : "rxtx";
  c.speed = Number(r.speed) === 9600 ? 9600 : 1200;
  // Graywolf has only AFSK / PSK modems (no 9600 G3RUH): a Graywolf channel at 9600
  // would silently never match / never decode, so it is a 1200 channel.
  if (c.preset === "graywolf" && c.speed === 9600) c.speed = 1200;
  return c;
}

/**
 * Connections from a config: config.connections, or (older configs with a
 * single endpoint: host / port / kissPort / transport at the top level) that
 * endpoint migrated into row 1 as RX+TX, 1200.
 */
function normalizeConnections(r) {
  let list;
  if (Array.isArray(r.connections)) list = r.connections.slice(0, MAX_CONNECTIONS).map(normalizeConnection);
  else {
    const legacy = ["host", "port", "kissPort", "transport", "preset", "serialDevice", "serialBaud"].some((k) => r[k] != null);
    list = [normalizeConnection(legacy ? { preset: r.preset, transport: r.transport, host: r.host, port: r.port, kissPort: r.kissPort, serialDevice: r.serialDevice, serialBaud: r.serialBaud, role: "rxtx", speed: 1200, enabled: true } : {}, 0)];
  }
  const seen = new Set();
  list.forEach((c, i) => {
    let id = c.id;
    for (let k = i + 1; seen.has(id); k++) id = "c" + k;
    c.id = id;
    seen.add(id);
  });
  return list;
}

/** Normalise / validate a config.aprs object (unknown keys dropped). */
function normalizeConfig(raw) {
  const d = defaults();
  const r = raw && typeof raw === "object" ? raw : {};
  const c = Object.assign({}, d);
  c.enabled = r.enabled === true;
  c.connections = normalizeConnections(r);
  c.defaultTxConn = typeof r.defaultTxConn === "string" && c.connections.some((x) => x.id === r.defaultTxConn) ? r.defaultTxConn : "";
  c.satSpeeds = {};
  if (r.satSpeeds && typeof r.satSpeeds === "object") {
    for (const [k, v] of Object.entries(r.satSpeeds)) {
      const key = String(k).trim().toUpperCase();
      const sp = Number(v);
      if (key && key.length <= 40 && (sp === 1200 || sp === 9600)) c.satSpeeds[key] = sp;
    }
  }
  const ss = r.ssid == null ? "" : String(r.ssid).trim().replace(/^-/, "");
  c.ssid = /^\d{1,2}$/.test(ss) && Number(ss) >= 1 && Number(ss) <= 15 ? String(Number(ss)) : "";
  c.path = typeof r.path === "string" ? r.path.trim().toUpperCase() : d.path;
  try {
    ax25.parsePath(c.path);
  } catch (_) {
    c.path = d.path;
  }
  c.satPaths = {};
  if (r.satPaths && typeof r.satPaths === "object") {
    for (const [k, v] of Object.entries(r.satPaths)) {
      const key = String(k).trim().toUpperCase();
      const val = String(v == null ? "" : v).trim().toUpperCase();
      if (!key || key.length > 40) continue;
      try {
        ax25.parsePath(val);
        c.satPaths[key] = val;
      } catch (_) {}
    }
  }
  c.defaultTo = build.normDest(r.defaultTo) || d.defaultTo;
  // table "/" or "\\" (or overlay A-Z 0-9 on the alternate table) + code "!".."~"
  c.symbol = typeof r.symbol === "string" && /^[\/\\A-Z0-9][!-~]$/.test(r.symbol) ? r.symbol : d.symbol;
  c.comment = build.cleanText(r.comment, 43);
  c.posSource = r.posSource === "latlon" ? "latlon" : "grid";
  const lat = Number(r.lat);
  const lon = Number(r.lon);
  c.lat = r.lat !== "" && r.lat != null && Number.isFinite(lat) && Math.abs(lat) <= 90 ? lat : null;
  c.lon = r.lon !== "" && r.lon != null && Number.isFinite(lon) && Math.abs(lon) <= 180 ? lon : null;
  c.posAmbiguity = clampInt(r.posAmbiguity, 0, 4, 0);
  c.txEnabled = r.txEnabled === true;
  c.txRequireRadioOn = r.txRequireRadioOn !== false;
  c.retryTag = r.retryTag !== false;
  c.heardExpireMin = clampInt(r.heardExpireMin, 5, 24 * 60, 60);
  c.digiTimeoutS = clampInt(r.digiTimeoutS, 5, 600, 30);
  c.dupeWindowS = clampInt(r.dupeWindowS, 1, 600, 30);
  c.logToFile = r.logToFile !== false;
  return c;
}

function isAprsMode(mode) {
  const m = String(mode || "");
  return APRS_MODE_RE.test(m) && !/SSTV/i.test(m);
}

/** True when any hop is not a terrestrial WIDEn-N / RELAY / TRACE alias. */
function isSatPath(via) {
  let hops;
  try {
    hops = ax25.parsePath(via);
  } catch (_) {
    return false;
  }
  return hops.some((h) => SAT_DIGIS.has(h.call));
}

function viaSatOf(fr) {
  for (const p of fr.path || []) {
    if (SAT_DIGIS.has(p.call) && p.h) return p.call;
  }
  return "";
}

function srcCall(callsign, ssid) {
  const c = String(callsign || "").trim().toUpperCase().split("-")[0];
  if (!/^[A-Z0-9]{1,6}$/.test(c)) return "";
  return ssid ? c + "-" + ssid : c;
}

/** Default Via for a sat: per-sat override (by sat key / display / NORAD), else the
 * built-in digipeater call (ISS = ARISS, SONATE-2 = DP0SNX; lib/aprs/sat-speeds.js),
 * else config path, else ARISS. */
function viaForSat(cfg, sat) {
  const c = cfg || defaults();
  const sp = c.satPaths || {};
  if (sat) {
    for (const k of [sat.satKey, sat.satName, sat.norad != null ? String(sat.norad) : ""]) {
      const key = String(k || "").toUpperCase();
      if (key && sp[key] != null) return sp[key];
    }
    const e = satSpeeds.catalogEntry(sat);
    if (e && e.via) return e.via;
  }
  return c.path || "ARISS";
}

/**
 * TX gate. ctx = {radioOn, sat: getLogContext() | null, connected, route}.
 * Returns {ok, reasons[], hints[]}. No rate limit: for satellite work the link
 * is always suspect, so the user may transmit as often as they want (the
 * windows only ignore an accidental double click within 1 s).
 */
function checkGate(cfg, kind, via, ctx, station) {
  const reasons = [];
  const c = cfg;
  const x = ctx || {};
  // route: routeTx() result for this Via (which connection would send it)
  const route = x.route || null;
  if (!c.enabled) reasons.push("APRS is disabled (Configure → KISS / APRS)");
  else if (route && !route.ok) reasons.push(route.reason);
  else if (route ? !route.connected : !x.connected)
    reasons.push(route && route.conn ? 'KISS connection "' + route.conn.name + '" not connected' : "KISS TNC not connected");
  if (!c.txEnabled) reasons.push("Transmit is off (Configure → KISS / APRS → Enable transmit)");
  if (!srcCall(station && station.callsign, "")) reasons.push("Set your callsign (Configure → Station)");
  if (c.txRequireRadioOn && !x.radioOn) reasons.push("Radio is off — turn Radio ON so it is tuned");
  // Satellite position / selection / mode never block TX (Brian: "we don't care
  // about sat status"); they only give non-blocking hints, which the windows
  // show when the Via typed there is a satellite path.
  const hints = [];
  if (x.sat) {
    const s = x.sat;
    const name = s.satName || s.satKey || "Sat";
    if (Number.isFinite(s.el) && s.el < 0) hints.push(name + " is below the horizon (el " + s.el.toFixed(1) + "°)");
    // Known AX.25 digipeaters (AMSAT list, lib/aprs/sat-speeds.js) count as packet
    // even when the frequency DB calls the mode just "9k6_GFSK".
    if (s.mode && !isAprsMode(s.mode) && !(satSpeeds.catalogEntry(s) && /\d+k\d|G?FSK|GMSK|G3RUH/i.test(s.mode)))
      hints.push('Selected mode "' + s.mode + '" is not an APRS / packet mode');
  }
  return { ok: reasons.length === 0, reasons, hints };
}

const SPEED_LABEL = { 1200: "1200 AFSK", 9600: "9600 G3RUH" };

/**
 * Which connection sends a packet. sat = getLogContext() | null.
 *  - sat selected and a satellite Via: a TX-capable (TX or RX+TX, enabled)
 *    connection whose speed matches the sat's (per-sat setting > AMSAT list >
 *    mode text > 1200); the Default TX connection first if it matches, then
 *    a connected one.
 *  - otherwise (no sat / terrestrial Via): the Default TX connection
 *    (auto = first TX-capable 1200 connection, else the first TX-capable).
 * isConnected(id) -> bool. Returns {ok, conn, connected, speed, speedSource,
 * satRoute, reason}.
 */
function routeTx(cfg, sat, via, isConnected) {
  const conns = (cfg && cfg.connections) || [];
  const tx = conns.filter((c) => c.enabled && c.role !== "rx");
  const up = (c) => !!(isConnected && isConnected(c.id));
  const satRoute = !!sat && isSatPath(via);
  const out = (o) => Object.assign({ satRoute, connected: !!(o.conn && up(o.conn)) }, o, o.conn ? { conn: { id: o.conn.id, name: o.conn.name, speed: o.conn.speed, role: o.conn.role } } : {});
  if (!conns.some((c) => c.enabled)) return out({ ok: false, reason: "No KISS connection enabled (Configure → KISS / APRS)" });
  if (satRoute) {
    const sp = satSpeeds.speedForSat(cfg.satSpeeds, sat);
    const m = tx.filter((c) => c.speed === sp.speed);
    if (!m.length) {
      const other = tx.length ? " (" + tx.map((c) => c.name + " = " + c.speed).join(", ") + ")" : "";
      return out({ ok: false, speed: sp.speed, speedSource: sp.source, reason: "No " + sp.speed + " TX connection configured for " + (sat.satName || sat.satKey) + other + " — add one in Configure → KISS / APRS" });
    }
    const pick = m.find((c) => c.id === cfg.defaultTxConn) || m.find(up) || m[0];
    return out({ ok: true, conn: pick, speed: sp.speed, speedSource: sp.source });
  }
  let pick = null;
  if (cfg.defaultTxConn) {
    pick = tx.find((c) => c.id === cfg.defaultTxConn) || null;
    if (!pick) {
      const d = conns.find((c) => c.id === cfg.defaultTxConn);
      return out({ ok: false, reason: 'Default TX connection "' + (d ? d.name : cfg.defaultTxConn) + '" is ' + (d && !d.enabled ? "disabled" : "RX-only") + " (Configure → KISS / APRS)" });
    }
  } else pick = tx.find((c) => c.speed === 1200) || tx[0] || null;
  if (!pick) return out({ ok: false, reason: "No TX connection configured (set a connection's role to TX or RX+TX)" });
  return out({ ok: true, conn: pick, speed: pick.speed });
}

function logDir() {
  return path.join(os.homedir(), ".rpitrack", "aprs");
}
/** Append-only digipeat log (JSON lines), next to the daily packet logs. */
function digipeatFile() {
  return path.join(logDir(), "digipeats.jsonl");
}
/** Aliases a digipeater may mark used without inserting its own call. */
const ALIAS_HOP = /^(WIDE\d?|RELAY|TRACE\d?|TEMP\d?|ARISS|APRSAT|SGATE|ECHO|GATE)$/;
/** Used (H-bit) hops of a path, as calls; aliases dropped when a real call is present. */
function usedDigis(fr) {
  const used = (fr.path || []).filter((p) => p.h).map((p) => ax25.formatAddr(p));
  const calls = used.filter((c) => !ALIAS_HOP.test(c.split("-")[0]));
  return calls.length ? calls : used;
}
const CSV_COLS = ["time", "src", "dst", "path", "digis", "viaSat", "sat", "satAboveHorizon", "satEl", "conn", "txConn", "lat", "lon", "retry", "info", "raw"];
/** Digipeat entries -> CSV (RFC 4180 quoting). */
function digipeatsCsv(entries) {
  const q = (v) => {
    const t = Array.isArray(v) ? v.join(" ") : v == null ? "" : String(v);
    return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  return [CSV_COLS.join(",")].concat((entries || []).map((e) => CSV_COLS.map((k) => q(e[k])).join(","))).join("\r\n") + "\r\n";
}

function logFileFor(d) {
  return path.join(logDir(), "aprs-" + d.toISOString().slice(0, 10) + ".log");
}

const TEST_ERRORS = {
  ECONNREFUSED: "connection refused (nothing listening on that port?)",
  ETIMEDOUT: "timed out",
  ENOTFOUND: "host not found (DNS)",
  EAI_AGAIN: "DNS lookup failed (try again / check the name)",
  EHOSTUNREACH: "host unreachable",
  ENETUNREACH: "network unreachable",
  ECONNRESET: "connection reset by peer",
};

/**
 * One-shot KISS TCP test (Configure → Test; works while APRS is disabled):
 * connect with a connect timeout (default 5 s), listen up to listenMs
 * (default 3 s) counting KISS frames, then close. Never writes anything.
 * Resolves {ok, target, ms, frames, sample, error, code}.
 */
function testKissTcp(host, port, opts) {
  const o = opts || {};
  const kissLib = require("../kiss/kiss");
  const h = String(host || "").trim() || "127.0.0.1";
  const p = parseInt(port, 10);
  const target = (h.includes(":") ? "[" + h + "]" : h) + ":" + port;
  return new Promise((resolve) => {
    if (!(p > 0 && p < 65536)) return resolve({ ok: false, target, error: "invalid port", code: "EINVAL" });
    const t0 = Date.now();
    let connectedMs = 0;
    let frames = 0;
    let sample = "";
    let finished = false;
    let listenTimer = null;
    const dec = new kissLib.Decoder();
    const s = new net.Socket();
    const done = (r) => {
      if (finished) return;
      finished = true;
      if (listenTimer) clearTimeout(listenTimer);
      s.removeAllListeners();
      s.on("error", () => {});
      s.destroy();
      resolve(Object.assign({ target, ms: connectedMs || Date.now() - t0, frames, sample }, r));
    };
    s.setTimeout(o.connectTimeoutMs || 5000);
    s.on("timeout", () => done({ ok: false, code: "ETIMEDOUT", error: TEST_ERRORS.ETIMEDOUT }));
    s.on("connect", () => {
      connectedMs = Date.now() - t0;
      s.setTimeout(0);
      listenTimer = setTimeout(() => done({ ok: true }), o.listenMs != null ? o.listenMs : 3000);
    });
    s.on("data", (b) => {
      for (const f of dec.push(b)) {
        if (f.cmd !== kissLib.CMD.DATA) continue;
        frames++;
        if (!sample) {
          const fr = ax25.decode(f.data);
          if (fr) sample = ax25.toTnc2(fr).slice(0, 120);
        }
      }
    });
    s.on("error", (e) => done({ ok: false, code: e.code || "", error: TEST_ERRORS[e.code] || e.message }));
    s.on("close", () => {
      if (connectedMs) done({ ok: true, closedByPeer: true });
    });
    s.connect(p, h);
  });
}

function createService(opts) {
  const o = opts || {};
  const broadcast = o.broadcast || (() => {});
  const getStation = o.getStation || (() => ({ callsign: "", grid: "" }));
  const getTxContext = o.getTxContext || (() => ({ radioOn: false, sat: null }));
  const log = o.log || ((m) => console.log(m));
  const makeTransport = o.createTransport || createTransport;

  let cfg = normalizeConfig(null);
  /** id -> {conn, client, key} */
  const clients = new Map();
  /** tnc2 -> {time, rec, conns:Set} (RX only, for cross-connection de-duplication) */
  const recentRx = new Map();
  /** src|info -> {id, time} of the first copy (dupe groups, cfg.dupeWindowS) */
  const rxGroups = new Map();
  /** Our sent packets awaiting / with digipeat confirmation: {rec, src, info, time, timer} */
  const txTrack = [];
  const TX_TRACK_MS = 10 * 60 * 1000;
  const MAX_DIGIPEATS = 5000;
  const digiFile = o.digipeatFile || digipeatFile();
  /** Persistent digipeat log, newest first (loaded from digiFile, survives restarts). */
  const digipeats = loadDigipeats();
  function loadDigipeats() {
    try {
      const lines = fs.readFileSync(digiFile, "utf8").split("\n");
      const out = [];
      for (const l of lines) {
        if (!l.trim()) continue;
        try {
          out.push(JSON.parse(l));
        } catch (_) {}
      }
      return out.reverse().slice(0, MAX_DIGIPEATS);
    } catch (_) {
      return [];
    }
  }
  function saveDigipeat(e) {
    try {
      fs.mkdirSync(path.dirname(digiFile), { recursive: true });
      fs.appendFileSync(digiFile, JSON.stringify(e) + "\n");
    } catch (err) {
      log("APRS: digipeat log write failed: " + err.message);
    }
  }
  function digiUpdate(t) {
    broadcast({ type: "aprs-tx-update", id: t.rec.id, digi: t.rec.digi });
  }
  function trackTx(rec, info) {
    rec.digi = { state: "pending", by: [], viaSat: false, timeoutS: cfg.digiTimeoutS, firstMs: 0 };
    const t = { rec, src: rec.src, info, time: rec.time, timer: null };
    t.timer = setTimeout(() => {
      if (t.rec.digi.state === "pending") {
        t.rec.digi.state = "none";
        digiUpdate(t);
        pushStatus(true);
      }
    }, o.digiTimeoutMs || cfg.digiTimeoutS * 1000); // digiTimeoutMs: test override
    if (t.timer.unref) t.timer.unref();
    txTrack.unshift(t);
    while (txTrack.length > 50) {
      const old = txTrack.pop();
      clearTimeout(old.timer);
    }
  }
  /** RX frame of one of our own TX (same source + info, any path) -> the tracked TX or null. */
  function matchTx(src, info, now) {
    for (const t of txTrack) {
      if (now - t.time > TX_TRACK_MS) continue;
      if (t.src === src && t.info === info) return t;
    }
    return null;
  }
  /** An echo of our TX: record digipeaters (H bit), persist a digipeat entry. */
  function onEcho(t, fr, conn, tnc2) {
    const used = usedDigis(fr);
    if (!used.length) return null; // direct copy (TNC / RX of our own TX), not a digipeat
    const d = t.rec.digi;
    const fresh = used.filter((c) => !d.by.includes(c));
    used.forEach((c) => !d.by.includes(c) && d.by.push(c));
    const viaSat = used.some((c) => SAT_DIGIS.has(c.split("-")[0]) || SAT_DIGIS.has(c));
    d.viaSat = d.viaSat || viaSat;
    if (!d.firstMs) d.firstMs = Date.now();
    d.state = "digipeated";
    digiUpdate(t);
    const s = satInfo();
    const e = {
      time: new Date().toISOString(),
      txId: t.rec.id,
      retry: t.rec.retry || 1,
      txTime: new Date(t.rec.time).toISOString(),
      src: t.rec.src,
      dst: t.rec.dst,
      path: (t.rec.via || []).join(","),
      digis: used,
      newDigis: fresh,
      viaSat,
      sat: s ? s.satName || s.satKey || "" : "",
      satAboveHorizon: s && Number.isFinite(s.el) ? s.el > 0 : null,
      satEl: s && Number.isFinite(s.el) ? Math.round(s.el * 10) / 10 : null,
      conn: conn.name || "",
      txConn: t.rec.conn || "",
      lat: t.rec.lat,
      lon: t.rec.lon,
      info: t.info,
      raw: tnc2,
    };
    digipeats.unshift(e);
    if (digipeats.length > MAX_DIGIPEATS) digipeats.length = MAX_DIGIPEATS;
    saveDigipeat(e);
    broadcast({ type: "aprs-digipeat", entry: e, count: digipeats.length });
    log("APRS digipeat " + (viaSat ? "via sat " : "") + used.join(",") + " of TX#" + t.rec.id + " heard on [" + (conn.name || "?") + "]");
    return e;
  }
  let seq = 0;
  let lastStatusJson = "";
  const packets = [];
  /** Our own source call+SSID (case-insensitive; "-0" = no SSID). */
  const normCall = (c) => String(c || "").trim().toUpperCase().replace(/\*$/, "").replace(/-0$/, "");
  const isMe = (call) => {
    const me = normCall(srcCall(getStation().callsign, cfg.ssid));
    return !!me && normCall(call) === me;
  };
  const store = createStore({
    expireMs: cfg.heardExpireMin * 60000,
    onChange: () => broadcast(store.payload()),
    hide: isMe,
  });

  function transportKey(c) {
    return JSON.stringify([c.transport, c.host, c.port, c.serialDevice, c.serialBaud, c.btAddress, c.btChannel, c.kissPort]);
  }

  function stopClient(id) {
    const e = clients.get(id);
    if (!e) return;
    e.client.removeAllListeners();
    e.client.close();
    clients.delete(id);
  }

  function startClient(conn) {
    stopClient(conn.id);
    const t = makeTransport(conn);
    const client = new KissClient(t, { kissPort: conn.kissPort });
    const e = { conn, client, key: transportKey(conn) };
    clients.set(conn.id, e);
    client.on("frame", (f) => onFrame(f, e.conn));
    client.on("state", (s) => {
      if (s === "connected") log("APRS: KISS [" + e.conn.name + "] connected " + t.describe());
      else if (s === "waiting") log("APRS: KISS [" + e.conn.name + "] " + t.describe() + " " + (t.lastError || "down") + ", retrying");
      pushStatus(true);
    });
    log("APRS: KISS [" + conn.name + "] connecting " + t.describe());
    client.open();
  }

  /** Start / stop / restart clients so there is one per enabled connection. */
  function syncClients(force) {
    const want = cfg.enabled ? cfg.connections.filter((c) => c.enabled) : [];
    const ids = new Set(want.map((c) => c.id));
    for (const id of [...clients.keys()]) if (!ids.has(id)) stopClient(id);
    for (const c of want) {
      const e = clients.get(c.id);
      if (!e || force || e.key !== transportKey(c)) startClient(c);
      else e.conn = c; // name / role / speed changes need no reconnect
    }
  }

  function configure(raw) {
    cfg = normalizeConfig(raw);
    store.setExpireMs(cfg.heardExpireMin * 60000);
    syncClients(false);
    pushStatus(true);
    return cfg;
  }
  const isConnected = (id) => {
    const e = clients.get(id);
    return !!e && e.client.state === "connected";
  };

  function selfPosition() {
    return build.stationPosition(cfg, getStation());
  }

  function satInfo() {
    try {
      const t = getTxContext() || {};
      return t.sat || null;
    } catch (_) {
      return null;
    }
  }

  function writeLog(rec) {
    if (!cfg.logToFile) return;
    const d = new Date(rec.time);
    const line =
      d.toISOString() + "\t" + rec.dir.toUpperCase() + "\t" +
      (rec.sat ? rec.sat + (Number.isFinite(rec.el) ? " el=" + rec.el.toFixed(1) : "") : "-") + "\t" +
      rec.tnc2 + "\n";
    fs.mkdir(logDir(), { recursive: true }, (err) => {
      if (err) return;
      fs.appendFile(logFileFor(d), line, () => {});
    });
  }

  function record(fr, dir, parsed, extra) {
    const s = satInfo();
    const tnc2 = ax25.toTnc2(fr);
    const viaSat = viaSatOf(fr);
    const rec = Object.assign(
      {
        id: ++seq,
        time: Date.now(),
        dir,
        src: ax25.formatAddr(fr.src),
        dst: ax25.formatAddr(fr.dst),
        via: fr.path.map((p) => ax25.formatAddr(p, true)),
        viaSat,
        type: parsed.type,
        to: (parsed.msg && parsed.msg.to) || "",
        msgText: parsed.msg ? parsed.msg.text : "",
        msgId: (parsed.msg && parsed.msg.id) || "",
        comment: parsed.comment != null ? String(parsed.comment).trim() : "",
        lat: Number.isFinite(parsed.lat) ? parsed.lat : null,
        lon: Number.isFinite(parsed.lon) ? parsed.lon : null,
        posSource: parsed.posSource || "",
        grid: parsed.grid || "",
        symbol: parsed.symTable && parsed.symCode ? parsed.symTable + parsed.symCode : "",
        tnc2,
        sat: s ? s.satName || s.satKey : "",
        el: s && Number.isFinite(s.el) ? Math.round(s.el * 10) / 10 : null,
      },
      extra || {},
    );
    // Third-party packet (data type '}'): the station is the inner source; the
    // RF sender is the iGate that gated it (shown as "via iGate KU5R-6").
    const tp = parsed.thirdParty || null;
    if (tp) {
      rec.gateway = rec.src;
      rec.src = tp.src;
      rec.thirdParty = tp;
      rec.innerTnc2 = tp.src + ">" + tp.dst + (tp.path.length ? "," + tp.path.join(",") : "") + ":" + tp.info;
    }
    const innerInfo = tp ? tp.info : tnc2.slice(tnc2.indexOf(":") + 1);
    rec.text = summarize({ parsed, info: innerInfo });
    rec.category = describe.category(parsed, dir, rec.kind);
    rec.decoded = describe.describe(parsed);
    if (parsed.device) rec.device = parsed.device;
    if (parsed.altM != null) rec.altM = parsed.altM;
    packets.unshift(rec);
    if (packets.length > MAX_PACKETS) packets.length = MAX_PACKETS;
    // The satellite's own beacon (RS0ISS etc.) is not a ground station: list only.
    const isSat = SAT_DIGIS.has(fr.src.call) && !tp;
    // Copies of the same packet (same source + info, any path) within the dupe
    // window are one group: the heard store / map update once (latest time).
    let dupOf = null;
    if (dir === "rx" && !rec.ownEcho) {
      const gk = rec.src + "|" + innerInfo; // third-party: inner source + info (any iGate / inner dest)
      const now = rec.time;
      for (const [k, v] of rxGroups) if (now - v.time > cfg.dupeWindowS * 1000) rxGroups.delete(k);
      const g = rxGroups.get(gk);
      if (g) {
        dupOf = g.id;
        rec.dupOf = g.id;
      } else rxGroups.set(gk, { id: rec.id, time: now });
    }
    // Our own station is never a heard station (no heard-list / map entry): not our TX
    // record, not the copy the TNC hands back, not a digipeated echo, not a third-party
    // packet whose inner source is us. Digipeat confirmation is handled in onFrame.
    if (dir === "rx" && (isMe(rec.src) || isMe(ax25.formatAddr(fr.src)))) rec.ownEcho = true;
    const ent = isSat || dir === "tx" || rec.ownEcho || isMe(rec.src) ? null : dupOf != null ? store.touch(rec.src, rec.time) : store.add(
      { time: rec.time, dir, src: rec.src, via: rec.via, viaSat: !!viaSat, parsed, conn: rec.conn || "" },
      { selfPos: dir === "tx" ? selfPosition() : null },
    );
    if (ent && rec.lat == null && Number.isFinite(ent.lat)) {
      rec.plotLat = ent.lat;
      rec.plotLon = ent.lon;
      rec.plotSource = ent.posSource;
    }
    writeLog(rec);
    broadcast({ type: "aprs-packet", packet: rec });
    return rec;
  }

  function onFrame(f, conn) {
    const fr = f.ax25;
    if (!fr) return;
    const c = conn || { id: "", name: "", role: "rxtx" };
    if (c.role === "tx") return; // TX-only connection: its RX is ignored
    if (!fr.isUI || fr.pid !== ax25.PID_NO_L3) return; // non-APRS AX.25
    const tnc2 = ax25.toTnc2(fr);
    const now = Date.now();
    for (const [k, v] of recentRx) if (now - v.time > DEDUPE_MS) recentRx.delete(k);
    const dup = recentRx.get(tnc2);
    if (dup && !dup.conns.has(c.id)) {
      // The same packet heard on a second connection (two receivers / channels): one packet.
      dup.conns.add(c.id);
      if (!dup.rec.conns.includes(c.name)) dup.rec.conns.push(c.name);
      broadcast({ type: "aprs-packet-dup", id: dup.rec.id, conns: dup.rec.conns.slice() });
      log("APRS RX dup [" + c.name + "] " + tnc2);
      return;
    }
    const info = ax25.infoText(fr.info);
    const parsed = parseInfo(fr.dst.call, info);
    const extra = { conn: c.name, connId: c.id, conns: c.name ? [c.name] : [] };
    const srcA = ax25.formatAddr(fr.src);
    const t = matchTx(srcA, info, now);
    if (t) {
      extra.ownEcho = true;
      extra.echoOf = t.rec.id;
      extra.echoDigis = usedDigis(fr);
      onEcho(t, fr, c, tnc2);
    } else if (isMe(srcA)) extra.ownEcho = true;
    const rec = record(fr, "rx", parsed, extra);
    recentRx.set(tnc2, { time: now, rec, conns: new Set([c.id]) });
    log("APRS RX " + (c.name ? "[" + c.name + "] " : "") + (rec.viaSat ? "[" + rec.viaSat + "] " : "") + rec.tnc2);
    pushStatus(true);
  }

  function txContext() {
    let t = {};
    try {
      t = getTxContext() || {};
    } catch (_) {}
    return {
      radioOn: !!t.radioOn,
      sat: t.sat || null,
      connected: [...clients.values()].some((e) => e.client.state === "connected"),
      now: Date.now(),
    };
  }

  /**
   * msg: {kind, to, via, text, for, comment} -> result. Like UISS:
   *   to   = AX.25 destination (default cfg.defaultTo, e.g. CQ)
   *   via  = digipeater path (default per-sat / cfg.path)
   *   kind = "beacon"  APRS position (+ comment)
   *          "text"    UI text / data, info sent as typed
   *          "message" APRS message to `for` (no ack)
   *          "header"  UI header only (empty info)
   */
  function send(msg) {
    const m = msg || {};
    const kind = KINDS.has(m.kind) ? m.kind : "text";
    const station = getStation();
    const ctx = txContext();
    const via = m.via != null ? String(m.via).trim().toUpperCase() : viaForSat(cfg, ctx.sat);
    let pathAddrs;
    try {
      pathAddrs = ax25.parsePath(via);
    } catch (e) {
      return { ok: false, kind, reasons: [e.message] };
    }
    const toRaw = m.to != null && String(m.to).trim() ? String(m.to) : cfg.defaultTo;
    const dst = build.normDest(toRaw);
    if (!dst) return { ok: false, kind, reasons: ["Invalid To \"" + String(toRaw).trim() + "\": a callsign of 1-6 letters/digits, optional -SSID 0-15 (e.g. CQ, APRS)"] };
    const route = routeTx(cfg, ctx.sat, via, isConnected);
    ctx.route = route;
    const gate = checkGate(cfg, kind === "beacon" ? "beacon" : "message", via, ctx, station);
    if (!gate.ok) return { ok: false, kind, reasons: gate.reasons, route };
    // Retry number: the same To + content as a send within the last 30 s gets
    // " #2", " #3", ... so Graywolf (identical-frame drop) and digipeaters'
    // dupe filters pass it. Positions and UI text only; messages keep their
    // text (a message retry is the same message), header-only has no content.
    const taggable = kind === "beacon" || kind === "text";
    let retry = 1;
    let retryKey = "";
    let info;
    try {
      const make = (tag) => {
        if (kind === "beacon") {
          const pos = selfPosition();
          if (!pos) throw new Error(cfg.posSource === "latlon" ? "Set beacon lat/lon (Configure → KISS / APRS)" : "Set your grid (Configure → Station)");
          return build.positionInfo({ lat: pos.lat, lon: pos.lon, symbol: cfg.symbol, comment: m.comment != null ? m.comment : cfg.comment, ambiguity: cfg.posAmbiguity, messaging: true, tag });
        }
        return build.uiTextInfo(m.text, pathAddrs.length, tag);
      };
      if (taggable) {
        const base = make("");
        retryKey = kind + "|" + dst + "|" + base;
        const now = Date.now();
        for (const [k, v] of retries) if (now - v.time > retryMs) retries.delete(k);
        const prev = retries.get(retryKey);
        retry = prev ? prev.n + 1 : 1;
        info = cfg.retryTag && retry > 1 ? make(" #" + retry) : base;
      } else if (kind === "message") {
        if (!String(m.for || "").trim()) throw new Error("Enter the addressee (For)");
        info = build.messageInfo(m.for, m.text);
      } else if (kind === "header") {
        info = "";
      }
    } catch (e) {
      return { ok: false, kind, reasons: [e.message] };
    }
    const src = srcCall(station.callsign, cfg.ssid);
    let frame;
    try {
      frame = ax25.encodeUI({ src, dst, path: pathAddrs, info });
    } catch (e) {
      return { ok: false, kind, reasons: [e.message] };
    }
    const e = clients.get(route.conn.id);
    if (!e || !e.client.sendFrame(frame)) return { ok: false, kind, reasons: ['KISS write failed on "' + route.conn.name + '"'], route };
    const fr = ax25.decode(frame);
    if (retryKey) retries.set(retryKey, { n: retry, time: Date.now() });
    const rec = record(fr, "tx", parseInfo(fr.dst.call, info), Object.assign({ kind, conn: route.conn.name, connId: route.conn.id, conns: [route.conn.name] }, retry > 1 ? { retry, retryTagged: !!cfg.retryTag } : {}));
    trackTx(rec, info);
    log("APRS TX [" + route.conn.name + "] " + rec.tnc2);
    pushStatus(true);
    // with the retry tag on, repeats differ; the Graywolf warning is only for tag off
    const note = cfg.retryTag && taggable ? (graywolfDupNote(route.conn.id, rec), "") : graywolfDupNote(route.conn.id, rec);
    return Object.assign({ ok: true, kind, packet: rec, route }, note ? { note } : {});
  }

  /**
   * Graywolf's TX governor silently drops a frame identical (dest + source +
   * info; path ignored) to one it sent in the last 30 s (hard-coded in
   * graywolf pkg/app/wiring.go). We still send it unchanged; just say so.
   */
  const lastTxKey = new Map(); // connId|dst|src|info -> time
  /** kind|To|untagged info -> {n, time}: retry counter (resets after 30 s quiet). */
  const retries = new Map();
  const retryMs = o.retryMs || RETRY_MS; // test override
  function graywolfDupNote(connId, rec) {
    const conn = cfg.connections.find((c) => c.id === connId);
    const now = rec.time;
    for (const [k, t] of lastTxKey) if (now - t > GRAYWOLF_DEDUP_MS) lastTxKey.delete(k);
    const tnc2 = rec.tnc2 || "";
    const key = connId + "|" + rec.dst + "|" + rec.src + "|" + tnc2.slice(tnc2.indexOf(":") + 1);
    const prev = lastTxKey.get(key);
    lastTxKey.set(key, now);
    if (!conn || conn.preset !== "graywolf" || prev == null) return "";
    return "identical to a frame sent " + Math.round((now - prev) / 1000) + " s ago — Graywolf drops identical frames within 30 s, so this one may not be transmitted";
  }
  /** Per-connection live status (Configure rows, APRS window). */
  function connStatus() {
    return cfg.connections.map((c) => {
      const e = cfg.enabled && c.enabled ? clients.get(c.id) : null;
      const st = e ? e.client.status() : { state: !cfg.enabled || !c.enabled ? "off" : "idle", target: "", error: "", rx: 0, tx: 0 };
      return { id: c.id, name: c.name, role: c.role, speed: c.speed, enabled: c.enabled, ...st };
    });
  }
  /** Aggregate over enabled connections: connected (all) / partial / waiting / off. */
  function aggregate(list) {
    const on = list.filter((x) => x.enabled && x.state !== "off");
    const sum = (k) => on.reduce((n, x) => n + (Number(x[k]) || 0), 0);
    let state = "off";
    if (cfg.enabled) {
      const up = on.filter((x) => x.state === "connected").length;
      if (!on.length) state = "idle";
      else if (up === on.length) state = "connected";
      else if (up > 0) state = "partial";
      else state = on.some((x) => x.state === "connecting") ? "connecting" : on[0].state;
    }
    const down = on.filter((x) => x.state !== "connected");
    return {
      state,
      target: on.map((x) => x.target).filter(Boolean).join(", "),
      error: down.length ? down.map((x) => x.name + ": " + (x.error || x.state)).join("; ") : "",
      rx: sum("rx"),
      tx: sum("tx"),
      connected: on.filter((x) => x.state === "connected").length,
      total: on.length,
    };
  }

  function statusPayload() {
    const connections = connStatus();
    const st = aggregate(connections);
    const ctx = txContext();
    const station = getStation();
    const via = viaForSat(cfg, ctx.sat);
    const sp = selfPosition();
    const txRoute = routeTx(cfg, ctx.sat, via, isConnected);
    const txRouteDirect = routeTx(cfg, ctx.sat, "", isConnected);
    // a satellite Via typed in the window even when the configured path is terrestrial
    const satVia = isSatPath(via) ? via : "ARISS";
    const txRouteSat = routeTx(cfg, ctx.sat, satVia, isConnected);
    const gate = (kind, v, r) => checkGate(cfg, kind, v, Object.assign({}, ctx, { route: r }), station);
    const satSp = ctx.sat ? satSpeeds.speedForSat(cfg.satSpeeds, ctx.sat) : null;
    return {
      type: "aprs-status",
      config: cfg,
      enabled: cfg.enabled,
      txEnabled: cfg.txEnabled,
      ...st,
      connections,
      lastTx: (() => {
        const t = txTrack[0];
        return t ? { id: t.rec.id, time: t.rec.time, tnc2: t.rec.tnc2, conn: t.rec.conn || "", kind: t.rec.kind, digi: t.rec.digi, retry: t.rec.retry || 1 } : null;
      })(),
      digipeatCount: digipeats.length,
      txRoute,
      txRouteDirect,
      txRouteSat,
      source: srcCall(station.callsign, cfg.ssid),
      defaultVia: via,
      defaultTo: cfg.defaultTo,
      presets: { to: build.DEST_PRESETS, via: build.VIA_PRESETS },
      viaIsSat: isSatPath(via),
      comment: cfg.comment,
      sat: ctx.sat ? { key: ctx.sat.satKey, name: ctx.sat.satName, mode: ctx.sat.mode, el: ctx.sat.el, aprsMode: isAprsMode(ctx.sat.mode), speed: satSp.speed, speedSource: satSp.source } : null,
      radioOn: ctx.radioOn,
      selfPos: sp,
      gateBeacon: gate("beacon", via, txRoute),
      gateMessage: gate("message", via, txRoute),
      gateMessageDirect: gate("message", "", txRouteDirect),
      gateMessageSat: gate("message", satVia, txRouteSat),
    };
  }
  /** Broadcast status when it changed (force: always). Called on a timer too. */
  function pushStatus(force) {
    const p = statusPayload();
    const cmp = JSON.stringify(
      Object.assign({}, p, { lastRxMs: 0, lastTxMs: 0, nextRetryAt: 0, connections: p.connections.map((x) => Object.assign({}, x, { lastRxMs: 0, lastTxMs: 0, nextRetryAt: 0 })) }),
    );
    if (!force && cmp === lastStatusJson) return;
    lastStatusJson = cmp;
    broadcast(p);
  }
  const iv = setInterval(() => pushStatus(false), 2000);
  if (iv.unref) iv.unref();

  /** One-shot TCP probe for Configure → Test (see testKissTcp). */
  function testTcp(host, port, opts) {
    return testKissTcp(host, port, opts);
  }
  /** One-shot Bluetooth RFCOMM probe for Configure → Test (never writes). */
  function testBt(mac, channel, opts) {
    return (o.testBluetooth || bt.testBluetooth)(mac, channel, opts);
  }
  /** Paired Bluetooth devices (bluetoothctl) for the Configure picker. */
  function btDevices() {
    return (o.listPaired || bt.listPaired)();
  }

  return {
    configure,
    getConfig: () => cfg,
    send,
    statusPayload,
    pushStatus,
    packetsPayload: () => ({ type: "aprs-packets", packets: packets.slice(0, MAX_PACKETS) }),
    heardPayload: () => store.payload(),
    digipeatsPayload: (n) => ({ type: "aprs-digipeats", entries: digipeats.slice(0, n || 1000), count: digipeats.length }),
    digipeatsCsv: () => digipeatsCsv(digipeats),
    clear() {
      packets.length = 0;
      store.clear();
      broadcast({ type: "aprs-packets", packets: [] });
    },
    reconnect() {
      syncClients(true);
      pushStatus(true);
    },
    testTcp,
    testBt,
    btDevices,
    stop() {
      clearInterval(iv);
      txTrack.forEach((t) => clearTimeout(t.timer));
      for (const id of [...clients.keys()]) stopClient(id);
      store.stop();
    },
    _store: store,
    _onFrame: onFrame,
    _clients: clients,
  };
}

module.exports = {
  createService,
  normalizeConfig,
  normalizeConnection,
  defaults,
  routeTx,
  SPEED_LABEL,
  DEDUPE_MS,
  usedDigis,
  digipeatsCsv,
  digipeatFile,
  checkGate,
  isAprsMode,
  isSatPath,
  viaForSat,
  srcCall,
  logFileFor,
  testKissTcp,
  PRESET_PORTS,
  SAT_DIGIS,
};
