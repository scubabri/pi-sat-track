/**
 * APRS / KISS TNC service: owns the KISS client for the active profile's
 * config.aprs, turns RX frames into packets (list + heard store + daily log),
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
const { parseInfo } = require("./parse");
const build = require("./build");
const { createStore, summarize } = require("./store");

const PRESET_PORTS = { graywolf: 6700, direwolf: 8001 };
const MAX_PACKETS = 300;
/** Digipeater calls / aliases used by satellites (path flag "via sat"). */
const SAT_DIGIS = new Set(["RS0ISS", "NA1SS", "ARISS", "APRSAT", "DP0SNX", "W3ADO", "PCSAT", "YB0X", "PSAT", "PSAT2"]);
const TERRESTRIAL_HOP = /^(WIDE\d?|RELAY|TRACE\d?|TEMP\d?)$/;
const KINDS = new Set(["beacon", "text", "message", "header"]);
const APRS_MODE_RE = /APRS|AFSK|AX\.?25|PACKET|\bPKT\b|DIGI/i;

function defaults() {
  return {
    enabled: false,
    transport: "tcp", // tcp | bluetooth (serial port, e.g. BT SPP /dev/rfcomm0)
    preset: "graywolf", // graywolf | direwolf | custom (UI hint + default port)
    host: "", // "" = localhost
    port: 6700,
    serialDevice: "/dev/rfcomm0",
    serialBaud: 9600,
    kissPort: 0,
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
    txRequireAprsMode: true,
    minEl: 0,
    beaconIntervalS: 60,
    msgIntervalS: 10,
    heardExpireMin: 60,
    logToFile: true,
  };
}

function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

/** Normalise / validate a config.aprs object (unknown keys dropped). */
function normalizeConfig(raw) {
  const d = defaults();
  const r = raw && typeof raw === "object" ? raw : {};
  const c = Object.assign({}, d);
  c.enabled = r.enabled === true;
  // "serial" (v1) is stored as "bluetooth": same serial-port transport.
  c.transport = r.transport === "bluetooth" || r.transport === "serial" ? "bluetooth" : "tcp";
  c.preset = ["graywolf", "direwolf", "custom"].includes(r.preset) ? r.preset : d.preset;
  c.host = typeof r.host === "string" ? r.host.trim().slice(0, 253) : "";
  c.port = clampInt(r.port, 1, 65535, PRESET_PORTS[c.preset] || d.port);
  if (typeof r.serialDevice === "string" && r.serialDevice.trim()) c.serialDevice = r.serialDevice.trim();
  c.serialBaud = clampInt(r.serialBaud, 1200, 921600, d.serialBaud);
  c.kissPort = clampInt(r.kissPort, 0, 15, 0);
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
  c.txRequireAprsMode = r.txRequireAprsMode !== false;
  c.minEl = Math.max(-5, Math.min(90, Number.isFinite(Number(r.minEl)) ? Number(r.minEl) : 0));
  c.beaconIntervalS = clampInt(r.beaconIntervalS, 60, 3600, 60);
  c.msgIntervalS = clampInt(r.msgIntervalS, 5, 600, 10);
  c.heardExpireMin = clampInt(r.heardExpireMin, 5, 24 * 60, 60);
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
  return hops.some((h) => !TERRESTRIAL_HOP.test(h.call));
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

/** Default Via for a sat: per-sat override (by sat key / display / NORAD), else config path, else ARISS. */
function viaForSat(cfg, sat) {
  const c = cfg || defaults();
  const sp = c.satPaths || {};
  if (sat) {
    for (const k of [sat.satKey, sat.satName, sat.norad != null ? String(sat.norad) : ""]) {
      const key = String(k || "").toUpperCase();
      if (key && sp[key] != null) return sp[key];
    }
  }
  return c.path || "ARISS";
}

/**
 * TX gate. ctx = {radioOn, sat: getLogContext() | null, connected, now,
 * lastBeaconMs, lastMsgMs}. Returns {ok, reasons[]}.
 */
function checkGate(cfg, kind, via, ctx, station) {
  const reasons = [];
  const c = cfg;
  const x = ctx || {};
  if (!c.enabled) reasons.push("APRS is disabled (Configure → KISS / APRS)");
  else if (!x.connected) reasons.push("KISS TNC not connected");
  if (!c.txEnabled) reasons.push("Transmit is off (Configure → KISS / APRS → Enable transmit)");
  if (!srcCall(station && station.callsign, "")) reasons.push("Set your callsign (Configure → Station)");
  if (c.txRequireRadioOn && !x.radioOn) reasons.push("Radio is off — turn Radio ON so it is tuned");
  if (isSatPath(via)) {
    const s = x.sat;
    if (!s) reasons.push("No satellite selected");
    else {
      if (c.txRequireAprsMode && !isAprsMode(s.mode))
        reasons.push("Selected mode \"" + (s.mode || "?") + "\" is not APRS — pick the sat's APRS mode");
      if (!Number.isFinite(s.el) || s.el < c.minEl)
        reasons.push(
          (s.satName || s.satKey || "Sat") + " is below " + c.minEl + "° (el " + (Number.isFinite(s.el) ? s.el.toFixed(1) : "?") + "°)",
        );
    }
  }
  const now = x.now || Date.now();
  if (kind === "beacon" && x.lastBeaconMs && now - x.lastBeaconMs < c.beaconIntervalS * 1000) {
    reasons.push("Wait " + Math.ceil((c.beaconIntervalS * 1000 - (now - x.lastBeaconMs)) / 1000) + " s (min " + c.beaconIntervalS + " s between beacons)");
  }
  if (kind !== "beacon" && x.lastMsgMs && now - x.lastMsgMs < c.msgIntervalS * 1000) {
    reasons.push("Wait " + Math.ceil((c.msgIntervalS * 1000 - (now - x.lastMsgMs)) / 1000) + " s (min " + c.msgIntervalS + " s between messages / text)");
  }
  return { ok: reasons.length === 0, reasons };
}

function logDir() {
  return path.join(os.homedir(), ".rpitrack", "aprs");
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
  let client = null;
  let clientKey = "";
  let lastBeaconMs = 0;
  let lastMsgMs = 0;
  let seq = 0;
  let lastStatusJson = "";
  const packets = [];
  const store = createStore({
    expireMs: cfg.heardExpireMin * 60000,
    onChange: () => broadcast(store.payload()),
  });

  function transportKey(c) {
    return JSON.stringify([c.enabled, c.transport, c.host, c.port, c.serialDevice, c.serialBaud, c.kissPort]);
  }

  function stopClient() {
    if (client) {
      client.removeAllListeners();
      client.close();
    }
    client = null;
  }

  function startClient() {
    stopClient();
    if (!cfg.enabled) return;
    const t = makeTransport(cfg);
    client = new KissClient(t, { kissPort: cfg.kissPort });
    client.on("frame", onFrame);
    client.on("state", (s) => {
      if (s === "connected") log("APRS: KISS connected " + t.describe());
      else if (s === "waiting") log("APRS: KISS " + t.describe() + " " + (t.lastError || "down") + ", retrying");
      pushStatus(true);
    });
    log("APRS: KISS connecting " + t.describe());
    client.open();
  }

  function configure(raw) {
    cfg = normalizeConfig(raw);
    store.setExpireMs(cfg.heardExpireMin * 60000);
    const k = transportKey(cfg);
    if (k !== clientKey || (cfg.enabled && !client)) {
      clientKey = k;
      startClient();
    }
    pushStatus(true);
    return cfg;
  }

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
        comment: parsed.comment != null ? parsed.comment : "",
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
    rec.text = summarize({ parsed, info: tnc2.slice(tnc2.indexOf(":") + 1) });
    packets.unshift(rec);
    if (packets.length > MAX_PACKETS) packets.length = MAX_PACKETS;
    // The satellite's own beacon (RS0ISS etc.) is not a ground station: list only.
    const isSat = SAT_DIGIS.has(fr.src.call);
    const ent = isSat ? null : store.add(
      { time: rec.time, dir, src: rec.src, via: rec.via, viaSat: !!viaSat, parsed },
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

  function onFrame(f) {
    const fr = f.ax25;
    if (!fr) return;
    if (!fr.isUI || fr.pid !== ax25.PID_NO_L3) return; // non-APRS AX.25
    const info = ax25.infoText(fr.info);
    const parsed = parseInfo(fr.dst.call, info);
    const me = srcCall(getStation().callsign, cfg.ssid);
    const extra = {};
    if (me && ax25.formatAddr(fr.src) === me) extra.ownEcho = true;
    const rec = record(fr, "rx", parsed, extra);
    log("APRS RX " + (rec.viaSat ? "[" + rec.viaSat + "] " : "") + rec.tnc2);
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
      connected: !!client && client.state === "connected",
      now: Date.now(),
      lastBeaconMs,
      lastMsgMs,
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
    const gate = checkGate(cfg, kind === "beacon" ? "beacon" : "message", via, ctx, station);
    if (!gate.ok) return { ok: false, kind, reasons: gate.reasons };
    let info;
    try {
      if (kind === "beacon") {
        const pos = selfPosition();
        if (!pos) throw new Error(cfg.posSource === "latlon" ? "Set beacon lat/lon (Configure → KISS / APRS)" : "Set your grid (Configure → Station)");
        info = build.positionInfo({
          lat: pos.lat,
          lon: pos.lon,
          symbol: cfg.symbol,
          comment: m.comment != null ? m.comment : cfg.comment,
          ambiguity: cfg.posAmbiguity,
          messaging: true,
        });
      } else if (kind === "message") {
        if (!String(m.for || "").trim()) throw new Error("Enter the addressee (For)");
        info = build.messageInfo(m.for, m.text);
      } else if (kind === "header") {
        info = "";
      } else {
        info = build.uiTextInfo(m.text, pathAddrs.length);
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
    if (!client || !client.sendFrame(frame)) return { ok: false, kind, reasons: ["KISS write failed"] };
    if (kind === "beacon") lastBeaconMs = Date.now();
    else lastMsgMs = Date.now();
    const fr = ax25.decode(frame);
    const rec = record(fr, "tx", parseInfo(fr.dst.call, info), { kind });
    log("APRS TX " + rec.tnc2);
    pushStatus(true);
    return { ok: true, kind, packet: rec };
  }

  function statusPayload() {
    const st = client ? client.status() : { state: cfg.enabled ? "idle" : "off", target: "", error: "", rx: 0, tx: 0 };
    const ctx = txContext();
    const station = getStation();
    const via = viaForSat(cfg, ctx.sat);
    const sp = selfPosition();
    return {
      type: "aprs-status",
      config: cfg,
      enabled: cfg.enabled,
      txEnabled: cfg.txEnabled,
      preset: cfg.preset,
      ...st,
      source: srcCall(station.callsign, cfg.ssid),
      defaultVia: via,
      defaultTo: cfg.defaultTo,
      presets: { to: build.DEST_PRESETS, via: build.VIA_PRESETS },
      viaIsSat: isSatPath(via),
      comment: cfg.comment,
      sat: ctx.sat ? { key: ctx.sat.satKey, name: ctx.sat.satName, mode: ctx.sat.mode, el: ctx.sat.el, aprsMode: isAprsMode(ctx.sat.mode) } : null,
      radioOn: ctx.radioOn,
      selfPos: sp,
      gateBeacon: checkGate(cfg, "beacon", via, ctx, station),
      gateMessage: checkGate(cfg, "message", via, ctx, station),
      gateMessageDirect: checkGate(cfg, "message", "", ctx, station),
    };
  }
  /** Broadcast status when it changed (force: always). Called on a timer too. */
  function pushStatus(force) {
    const p = statusPayload();
    const cmp = JSON.stringify(Object.assign({}, p, { lastRxMs: 0, lastTxMs: 0, nextRetryAt: 0 }));
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

  return {
    configure,
    getConfig: () => cfg,
    send,
    statusPayload,
    pushStatus,
    packetsPayload: () => ({ type: "aprs-packets", packets: packets.slice(0, MAX_PACKETS) }),
    heardPayload: () => store.payload(),
    clear() {
      packets.length = 0;
      store.clear();
      broadcast({ type: "aprs-packets", packets: [] });
    },
    reconnect() {
      clientKey = "";
      configure(cfg);
    },
    testTcp,
    stop() {
      clearInterval(iv);
      stopClient();
      store.stop();
    },
    _store: store,
    _onFrame: onFrame,
  };
}

module.exports = {
  createService,
  normalizeConfig,
  defaults,
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
