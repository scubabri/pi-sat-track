/**
 * QSO logging: build one ADIF record from tracker state and write it to
 * an ADIF file or send it over UDP (WSJT-X NetworkMessage protocol).
 *
 * ADIF: https://adif.org/314/ADIF_314.htm
 * WSJT-X UDP: Network/NetworkMessage.hpp in the WSJT-X source
 *   (big-endian QDataStream; magic 0xadbccbda; schema 2 here).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const dgram = require("dgram");
const net = require("net");
const { isFmMode } = require("./catalog");
const lotw = require("./lotw-sats");

const PROGRAM_ID = "pi-sat-track";
const PROGRAM_VERSION = (() => {
  try {
    return require("../package.json").version || "0.0.0";
  } catch (_) {
    return "0.0.0";
  }
})();
const ADIF_VER = "3.1.4";
/** WSJT-X UDP client id (shown by GridTracker / Log4OM as the instance). */
const UDP_CLIENT_ID = "pi-sat-track";

const WSJTX_MAGIC = 0xadbccbda;
const WSJTX_SCHEMA = 2;
const MSG_HEARTBEAT = 0;
const MSG_STATUS = 1;
const MSG_QSO_LOGGED = 5;
const MSG_LOGGED_ADIF = 12;

/* ---------- bands (ADIF 3.1.4 Band enumeration, MHz) ---------- */
const BANDS = [
  ["2190m", 0.1357, 0.1378],
  ["630m", 0.472, 0.479],
  ["560m", 0.501, 0.504],
  ["160m", 1.8, 2.0],
  ["80m", 3.5, 4.0],
  ["60m", 5.06, 5.45],
  ["40m", 7.0, 7.3],
  ["30m", 10.1, 10.15],
  ["20m", 14.0, 14.35],
  ["17m", 18.068, 18.168],
  ["15m", 21.0, 21.45],
  ["12m", 24.89, 24.99],
  ["10m", 28.0, 29.7],
  ["8m", 40, 45],
  ["6m", 50, 54],
  ["5m", 54.000001, 69.9],
  ["4m", 70, 71],
  ["2m", 144, 148],
  ["1.25m", 222, 225],
  ["70cm", 420, 450],
  ["33cm", 902, 928],
  ["23cm", 1240, 1300],
  ["13cm", 2300, 2450],
  ["9cm", 3300, 3500],
  ["6cm", 5650, 5925],
  ["3cm", 10000, 10500],
  ["1.25cm", 24000, 24250],
  ["6mm", 47000, 47200],
  ["4mm", 75500, 81000],
  ["2.5mm", 119980, 123000],
  ["2mm", 134000, 149000],
  ["1mm", 241000, 250000],
  ["submm", 300000, 7500000],
];

function bandForMHz(mhz) {
  const f = Number(mhz);
  if (!Number.isFinite(f) || f <= 0) return "";
  for (const [b, lo, hi] of BANDS) {
    if (f >= lo && f <= hi) return b;
  }
  return "";
}

/* ---------- mode mapping (LoTW: SSB, FM, CW, DATA modes) ---------- */
/**
 * Map a catalog transponder mode string to ADIF MODE/SUBMODE.
 * Linear/SSB/transponder -> SSB; FM family -> FM; CW-only -> CW;
 * APRS/AFSK/packet -> PKT; D-STAR/C4FM/DMR -> DIGITALVOICE + submode.
 */
function adifMode(modeStr) {
  const m = String(modeStr || "").toUpperCase();
  if (/D-?STAR/.test(m)) return { mode: "DIGITALVOICE", submode: "DSTAR" };
  if (/C4FM|\bYSF\b/.test(m)) return { mode: "DIGITALVOICE", submode: "C4FM" };
  if (/\bDMR\b/.test(m)) return { mode: "DIGITALVOICE", submode: "DMR" };
  if (/APRS|AFSK|PACKET|DIGIPEAT/.test(m)) return { mode: "PKT", submode: "" };
  if (/SSB|LINEAR|TRANSPONDER|INVERT|\bUSB\b|\bLSB\b/.test(m))
    return { mode: "SSB", submode: "" };
  if (isFmMode(m)) return { mode: "FM", submode: "" };
  if (/\bCW\b/.test(m)) return { mode: "CW", submode: "" };
  if (/SSTV/.test(m)) return { mode: "SSTV", submode: "" };
  if (/RTTY/.test(m)) return { mode: "RTTY", submode: "" };
  if (/\bFM\b/.test(m)) return { mode: "FM", submode: "" };
  // Unknown (e.g. AO-7 "A", "B"): most sat QSOs on such modes are linear SSB
  return { mode: "SSB", submode: "" };
}

function defaultRst(mode) {
  if (mode === "CW") return "599";
  if (mode === "SSB" || mode === "FM" || mode === "DIGITALVOICE") return "59";
  return "";
}

/* ---------- validation / helpers ---------- */
function normalizeCall(s) {
  return String(s || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function validCall(c) {
  return (
    /^[A-Z0-9/]{3,20}$/.test(c) && /[A-Z]/.test(c) && /[0-9]/.test(c)
  );
}

function expandHome(p) {
  const s = String(p || "").trim();
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || s.startsWith("~\\"))
    return path.join(os.homedir(), s.slice(2));
  return s;
}

function pad(n, w) {
  return String(n).padStart(w, "0");
}
function adifDate(d) {
  return (
    d.getUTCFullYear() + pad(d.getUTCMonth() + 1, 2) + pad(d.getUTCDate(), 2)
  );
}
function adifTime(d) {
  return pad(d.getUTCHours(), 2) + pad(d.getUTCMinutes(), 2) + pad(d.getUTCSeconds(), 2);
}
function mhzStr(hz) {
  return (hz / 1e6).toFixed(6);
}

/** ADIF non-_INTL fields are ASCII; drop anything else / control chars. */
function asciiOnly(v) {
  return String(v == null ? "" : v).replace(/[^\x20-\x7e]/g, "");
}

function adifField(name, value) {
  const v = asciiOnly(value);
  if (!v) return "";
  return "<" + name + ":" + Buffer.byteLength(v, "ascii") + ">" + v + " ";
}

function adifHeader(now) {
  const d = now || new Date();
  return (
    "pi-sat-track ADIF log\n" +
    adifField("ADIF_VER", ADIF_VER) +
    "\n" +
    adifField("PROGRAMID", PROGRAM_ID) +
    "\n" +
    adifField("PROGRAMVERSION", PROGRAM_VERSION) +
    "\n" +
    adifField("CREATED_TIMESTAMP", adifDate(d) + " " + adifTime(d)) +
    "\n<EOH>\n"
  );
}

/* ---------- record ---------- */
/** Field order written to ADIF. */
const FIELD_ORDER = [
  "CALL",
  "QSO_DATE",
  "TIME_ON",
  "QSO_DATE_OFF",
  "TIME_OFF",
  "BAND",
  "FREQ",
  "BAND_RX",
  "FREQ_RX",
  "MODE",
  "SUBMODE",
  "RST_SENT",
  "RST_RCVD",
  "PROP_MODE",
  "SAT_NAME",
  "SAT_MODE",
  "STATION_CALLSIGN",
  "OPERATOR",
  "MY_GRIDSQUARE",
  "COMMENT",
];

/**
 * Build one QSO record.
 * @param {object} p
 * @param {string} p.call  worked station
 * @param {{satName:string,satFullName?:string,satKey?:string,norad?:number,mode:string,ulHz:?number,dlHz:?number}} p.ctx
 * @param {{callsign:string,grid:string}} p.station
 * @param {Date} [p.now]
 * @returns {{ok:boolean,error?:string,fields?:object,warnings?:string[]}}
 */
function buildRecord(p) {
  const call = normalizeCall(p && p.call);
  if (!call) return { ok: false, error: "Enter a callsign" };
  if (!validCall(call)) return { ok: false, error: "Invalid callsign: " + call };
  const ctx = (p && p.ctx) || null;
  if (!ctx || !ctx.satKey) return { ok: false, error: "No satellite selected" };
  const st = (p && p.station) || {};
  const myCall = normalizeCall(st.callsign);
  if (!myCall)
    return { ok: false, error: "Set your station callsign in Config first" };
  const myGrid = String(st.grid || "").trim().toUpperCase();
  const now = p.now instanceof Date ? p.now : new Date();
  const warnings = [];

  const ul = Number.isFinite(ctx.ulHz) && ctx.ulHz > 0 ? ctx.ulHz : null;
  const dl = Number.isFinite(ctx.dlHz) && ctx.dlHz > 0 ? ctx.dlHz : null;
  if (!ul && !dl) return { ok: false, error: "No frequency for current mode" };

  // ADIF / LoTW: FREQ+BAND = TX (uplink), FREQ_RX+BAND_RX = RX (downlink)
  const txHz = ul || dl;
  const band = bandForMHz(txHz / 1e6);
  if (!band) return { ok: false, error: "Frequency " + mhzStr(txHz) + " MHz is outside amateur bands" };

  const { mode, submode } = adifMode(ctx.mode);
  const sat = lotw.resolveSatName(
    {
      display: ctx.satName,
      name: ctx.satFullName,
      key: ctx.satKey,
      norad: ctx.norad,
    },
    now,
  );
  if (sat.warning) warnings.push(sat.warning);
  if (!myGrid) warnings.push("No station grid configured (MY_GRIDSQUARE empty)");

  const rst = defaultRst(mode);
  const f = {
    CALL: call,
    QSO_DATE: adifDate(now),
    TIME_ON: adifTime(now),
    QSO_DATE_OFF: adifDate(now),
    TIME_OFF: adifTime(now),
    BAND: band,
    FREQ: mhzStr(txHz),
    MODE: mode,
    SUBMODE: submode,
    RST_SENT: rst,
    RST_RCVD: rst,
    PROP_MODE: "SAT",
    SAT_NAME: sat.satName,
    STATION_CALLSIGN: myCall,
    OPERATOR: myCall,
    MY_GRIDSQUARE: myGrid,
    COMMENT: p.comment ? String(p.comment) : "",
  };
  if (ul && dl) {
    f.BAND_RX = bandForMHz(dl / 1e6);
    f.FREQ_RX = mhzStr(dl);
  } else if (dl) {
    // only downlink known: it is both what we log as FREQ and what we hear
    f.BAND_RX = band;
    f.FREQ_RX = mhzStr(dl);
  }
  return {
    ok: true,
    fields: f,
    warnings,
    lotwAccepted: sat.accepted,
    txHz,
    rxHz: dl,
    time: now,
  };
}

function recordToAdif(fields) {
  let s = "";
  for (const k of FIELD_ORDER) {
    if (fields[k] != null && fields[k] !== "") s += adifField(k, fields[k]);
  }
  return s + "<EOR>\n";
}

/* ---------- ADIF file ---------- */
function appendAdifFile(filePath, fields) {
  const p = expandHome(filePath);
  if (!p) throw new Error("ADIF file path is empty");
  const abs = path.resolve(p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  let needHeader = true;
  try {
    needHeader = fs.statSync(abs).size === 0;
  } catch (_) {
    needHeader = true;
  }
  let out = "";
  if (needHeader) out += adifHeader(new Date());
  out += recordToAdif(fields);
  fs.appendFileSync(abs, out, "ascii");
  return abs;
}

/* ---------- WSJT-X UDP encoding (QDataStream, big-endian) ---------- */
function qU8(v) {
  const b = Buffer.alloc(1);
  b.writeUInt8(v & 0xff, 0);
  return b;
}
function qBool(v) {
  return qU8(v ? 1 : 0);
}
function qU32(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0, 0);
  return b;
}
function qI64(v) {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(BigInt(Math.trunc(v)), 0);
  return b;
}
function qU64(v) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(Math.max(0, Math.trunc(v || 0))), 0);
  return b;
}
/** "utf8" type: QByteArray = quint32 length + bytes; null = 0xffffffff. */
function qUtf8(s) {
  if (s == null) return qU32(0xffffffff);
  const body = Buffer.from(String(s), "utf8");
  return Buffer.concat([qU32(body.length), body]);
}
/** QDateTime (Qt >= 5.2): qint64 Julian day, quint32 ms since midnight, quint8 timespec (1 = UTC). */
function qDateTimeUtc(d) {
  const ms = d.getTime();
  const day = Math.floor(ms / 86400000);
  const jd = day + 2440588; // 1970-01-01 = JD 2440588
  const msOfDay = ms - day * 86400000;
  return Buffer.concat([qI64(jd), qU32(msOfDay), qU8(1)]);
}

function wsjtxHeader(type, id) {
  return Buffer.concat([
    qU32(WSJTX_MAGIC),
    qU32(WSJTX_SCHEMA),
    qU32(type),
    qUtf8(id || UDP_CLIENT_ID),
  ]);
}

function encodeHeartbeat(id) {
  return Buffer.concat([
    wsjtxHeader(MSG_HEARTBEAT, id),
    qU32(3), // maximum schema number we understand
    qUtf8(PROGRAM_VERSION),
    qUtf8(""),
  ]);
}

/**
 * Status (1). GridTracker2 drops QSO Logged / Logged ADIF from an instance
 * until it has seen a Status from it, so one is sent before logging.
 */
function encodeStatus(id, s) {
  return Buffer.concat([
    wsjtxHeader(MSG_STATUS, id),
    qU64(s.dialHz || 0), // Dial frequency (Hz)
    qUtf8(s.mode || ""), // Mode
    qUtf8(s.dxCall || ""), // DX call
    qUtf8(s.report || ""), // Report
    qUtf8(s.mode || ""), // Tx Mode
    qBool(false), // Tx Enabled
    qBool(false), // Transmitting
    qBool(false), // Decoding
    qU32(0), // Rx DF
    qU32(0), // Tx DF
    qUtf8(s.deCall || ""), // DE call
    qUtf8(s.deGrid || ""), // DE grid
    qUtf8(""), // DX grid
    qBool(false), // Tx Watchdog
    qUtf8(""), // Sub-mode
    qBool(false), // Fast mode
    qU8(0), // Special operation mode: NONE
    qU32(0xffffffff), // Frequency tolerance (n/a)
    qU32(0xffffffff), // T/R period (n/a)
    qUtf8(PROGRAM_ID), // Configuration name
    qUtf8(""), // Tx message
  ]);
}

/** QSO Logged (5). No SAT_NAME field exists in this message. */
function encodeQsoLogged(id, rec) {
  const f = rec.fields;
  const t = rec.time instanceof Date ? rec.time : new Date();
  return Buffer.concat([
    wsjtxHeader(MSG_QSO_LOGGED, id),
    qDateTimeUtc(t), // Date & Time Off
    qUtf8(f.CALL), // DX call
    qUtf8(""), // DX grid
    qU64(rec.txHz), // Tx frequency (Hz)
    qUtf8(f.MODE), // Mode
    qUtf8(f.RST_SENT || ""), // Report sent
    qUtf8(f.RST_RCVD || ""), // Report received
    qUtf8(""), // Tx power
    qUtf8(f.COMMENT || ""), // Comments
    qUtf8(""), // Name
    qDateTimeUtc(t), // Date & Time On
    qUtf8(f.OPERATOR || ""), // Operator call
    qUtf8(f.STATION_CALLSIGN || ""), // My call
    qUtf8(f.MY_GRIDSQUARE || ""), // My grid
    qUtf8(""), // Exchange sent
    qUtf8(""), // Exchange received
    qUtf8("SAT"), // ADIF propagation mode
  ]);
}

/** One-record ADIF document (with header) — used for message 12 and raw ADIF UDP. */
function adifDocument(fields) {
  return (
    adifField("ADIF_VER", ADIF_VER) +
    adifField("PROGRAMID", PROGRAM_ID) +
    adifField("PROGRAMVERSION", PROGRAM_VERSION) +
    "<EOH>\n" +
    recordToAdif(fields)
  );
}

/** Logged ADIF (12): id + ADIF text (valid ADIF file with one record). */
function encodeLoggedAdif(id, fields) {
  return Buffer.concat([
    wsjtxHeader(MSG_LOGGED_ADIF, id),
    qUtf8(adifDocument(fields)),
  ]);
}

/**
 * Datagrams for a UDP format:
 *  wsjtx   = Heartbeat + Status + QSO Logged (5) + Logged ADIF (12) (what WSJT-X sends)
 *  wsjtx12 = Heartbeat + Status + Logged ADIF (12)
 *  wsjtx5  = Heartbeat + Status + QSO Logged (5)
 *  adif    = plain ADIF text (Log4OM "ADIF message" inbound / GridTracker2 ADIF UDP)
 */
function buildUdpDatagrams(rec, format, id) {
  const fmt = String(format || "wsjtx").toLowerCase();
  const f = rec.fields;
  if (fmt === "adif") return [Buffer.from(adifDocument(f), "ascii")];
  const out = [
    encodeHeartbeat(id),
    encodeStatus(id, {
      dialHz: rec.rxHz || rec.txHz,
      mode: f.MODE,
      dxCall: f.CALL,
      report: f.RST_SENT,
      deCall: f.STATION_CALLSIGN,
      deGrid: f.MY_GRIDSQUARE,
    }),
  ];
  if (fmt === "wsjtx" || fmt === "wsjtx5") out.push(encodeQsoLogged(id, rec));
  if (fmt === "wsjtx" || fmt === "wsjtx12") out.push(encodeLoggedAdif(id, f));
  return out;
}

function validateUdpTarget(host, port) {
  const h = String(host || "").trim();
  if (!net.isIP(h)) throw new Error("Invalid UDP IP address: " + (h || "(empty)"));
  const p = parseInt(port, 10);
  if (!Number.isFinite(p) || p < 1 || p > 65535)
    throw new Error("Invalid UDP port: " + port);
  return { host: h, port: p, family: net.isIP(h) === 6 ? "udp6" : "udp4" };
}

function sendUdp(host, port, datagrams) {
  const t = validateUdpTarget(host, port);
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket(t.family);
    let i = 0;
    const done = (err) => {
      try {
        sock.close();
      } catch (_) {}
      if (err) reject(err);
      else resolve(t);
    };
    sock.on("error", done);
    sock.bind(0, () => {
      try {
        const last = t.host.split(".").pop();
        if (t.family === "udp4" && last === "255") sock.setBroadcast(true);
      } catch (_) {}
      const next = () => {
        if (i >= datagrams.length) return done(null);
        const buf = datagrams[i++];
        sock.send(buf, t.port, t.host, (err) => {
          if (err) return done(err);
          // small gap keeps ordering obvious to receivers (Status before log)
          setTimeout(next, 20);
        });
      };
      next();
    });
  });
}

/**
 * Log one QSO using the configured method.
 * @param {object} opts { call, ctx, station, cfg:{method,adifPath,udpHost,udpPort,udpFormat}, now? }
 * @returns {Promise<object>} log-result payload
 */
async function logQso(opts) {
  const cfg = (opts && opts.cfg) || {};
  const method = String(cfg.method || "off").toLowerCase();
  if (method === "off" || !method)
    return {
      ok: false,
      error: "Logging is off - choose ADIF file or UDP in Config > Logging",
    };
  const rec = buildRecord(opts);
  if (!rec.ok) return { ok: false, error: rec.error };
  const f = rec.fields;
  const summary = {
    call: f.CALL,
    satName: f.SAT_NAME,
    mode: f.MODE,
    band: f.BAND,
    freq: f.FREQ,
    bandRx: f.BAND_RX || "",
    freqRx: f.FREQ_RX || "",
    date: f.QSO_DATE,
    time: f.TIME_ON,
  };
  try {
    if (method === "adif") {
      const p = appendAdifFile(cfg.adifPath, f);
      return {
        ok: true,
        method,
        target: p,
        record: summary,
        warnings: rec.warnings,
        lotwAccepted: rec.lotwAccepted,
      };
    }
    if (method === "udp") {
      const dg = buildUdpDatagrams(rec, cfg.udpFormat, UDP_CLIENT_ID);
      const t = await sendUdp(cfg.udpHost, cfg.udpPort, dg);
      return {
        ok: true,
        method,
        target: t.host + ":" + t.port,
        udpFormat: cfg.udpFormat || "wsjtx",
        record: summary,
        warnings: rec.warnings,
        lotwAccepted: rec.lotwAccepted,
      };
    }
    return { ok: false, error: "Unknown logging method: " + method };
  } catch (e) {
    return { ok: false, error: e.message || String(e), record: summary };
  }
}

module.exports = {
  PROGRAM_ID,
  ADIF_VER,
  UDP_CLIENT_ID,
  WSJTX_MAGIC,
  WSJTX_SCHEMA,
  bandForMHz,
  adifMode,
  normalizeCall,
  validCall,
  expandHome,
  adifField,
  adifHeader,
  buildRecord,
  recordToAdif,
  adifDocument,
  appendAdifFile,
  encodeHeartbeat,
  encodeStatus,
  encodeQsoLogged,
  encodeLoggedAdif,
  buildUdpDatagrams,
  validateUdpTarget,
  sendUdp,
  logQso,
};
