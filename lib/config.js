const path = require("path");
const os = require("os");
const {
  listMakes,
  listModels,
  findModel,
  defaultSerialSelection,
} = require("./serial-catalog");
const platform = require("./platform");

const ROOT = path.join(__dirname, "..");
const CACHE_DIR = path.join(os.homedir(), ".rpitrack");
const CATALOG_CACHE = path.join(CACHE_DIR, "amsat_catalog.json");
const STATUS_CACHE = path.join(CACHE_DIR, "amsat_status.json");

const PORT = 3000;

const CATALOG_URL =
  "https://raw.githubusercontent.com/palewire/amateur-satellite-database/main/data/amsat-all-frequencies.json";
const AMSAT_STATUS = "https://www.amsat.org/status/";

let RADIO_TRANSPORT = process.env.RADIO_TRANSPORT || "tcp";
let RADIO_TYPE = process.env.RADIO_TYPE || "smartsdr";
let RADIO_PROTOCOL = process.env.RADIO_PROTOCOL || "cat";

if (RADIO_TYPE === "flex") RADIO_TYPE = "smartsdr";

/** Per-side radio config (UL TX / DL RX). Drivers still read mapped globals. */
let RADIO_UL = null;
let SINGLE_RADIO = false;
/** TX radio dual-VFO: also command DL on VFO B / Sub. */
let TX_SPLIT = true;
let RADIO_DL = null;

function defaultSideConfig(side) {
  return {
    transport: "tcp",
    type: "smartsdr",
    protocol: "cat",
    tciEndpoint: "127.0.0.1:50001",
    rigctlEndpoint: "127.0.0.1:4532",
    catEndpoint: side === "ul" ? "172.17.18.229:60002" : "172.17.18.229:60001",
    sdrconnectEndpoint: "127.0.0.1:5454",
    apiEndpoint: "",
    serialMake: "icom",
    serialModel: "ic-705",
    serialDevice: "/dev/ttyACM0",
    serialBaud: 19200,
  };
}

function normalizeSide(s, side) {
  const d = Object.assign(defaultSideConfig(side), s || {});
  d.transport = String(d.transport || "tcp").toLowerCase();
  d.type = normalizeRadioType(d.type || "smartsdr");
  d.protocol = String(d.protocol || "cat").toLowerCase();
  if (d.type === "rigctl") d.protocol = "rigctl";
  if (d.type === "smartsdr" && d.protocol === "tci") d.protocol = "cat";
  return d;
}

function parseEp(str, defaultHost, defaultPort) {
  const s = String(str || "").trim();
  if (!s) return { host: defaultHost, port: defaultPort };
  const idx = s.lastIndexOf(":");
  if (idx > 0) {
    const host = s.slice(0, idx).trim();
    const p = parseInt(s.slice(idx + 1).trim(), 10);
    if (host && Number.isFinite(p) && p > 0 && p < 65536)
      return { host, port: p };
  }
  return { host: s || defaultHost, port: defaultPort };
}

/** Map dual side configs onto legacy single-driver globals. */
function mapSidesToGlobals() {
  const ul = RADIO_UL || defaultSideConfig("ul");
  const dl = RADIO_DL || defaultSideConfig("dl");

  // Prefer DL for "primary" RADIO_* used by single-driver matchers
  RADIO_TRANSPORT = dl.transport || ul.transport || "tcp";
  RADIO_TYPE = dl.type || ul.type || "smartsdr";
  RADIO_PROTOCOL = dl.protocol || ul.protocol || "cat";

  // TCI — either side
  for (const s of [dl, ul]) {
    if (
      s.protocol === "tci" ||
      (s.type === "aethersdr" && s.protocol === "tci")
    ) {
      const ep = parseEp(s.tciEndpoint, "127.0.0.1", 50001);
      TCI_HOST = ep.host;
      TCI_PORT = ep.port;
      break;
    }
  }

  // SDRconnect — either side (prefer DL)
  for (const s of [dl, ul]) {
    const t = normalizeRadioType(s.type || "");
    if (t === "sdrconnect" || t === "sdrplay") {
      const ep = parseEp(s.sdrconnectEndpoint, "127.0.0.1", 5454);
      SDRCONNECT_HOST = ep.host;
      SDRCONNECT_PORT = ep.port;
      break;
    }
  }

  // rigctl — DL primary, UL optional second endpoint
  if (dl.protocol === "rigctl" || dl.type === "rigctl") {
    const ep = parseEp(dl.rigctlEndpoint, "127.0.0.1", 4532);
    RIGCTL_HOST = ep.host;
    RIGCTL_PORT = ep.port;
  }
  if (ul.protocol === "rigctl" || ul.type === "rigctl") {
    const ep = parseEp(ul.rigctlEndpoint, "127.0.0.1", 4532);
    if (dl.protocol === "rigctl" || dl.type === "rigctl") {
      RIGCTL_UL_HOST = ep.host;
      RIGCTL_UL_PORT = ep.port;
    } else {
      // Only UL is rigctl — use primary slot
      RIGCTL_HOST = ep.host;
      RIGCTL_PORT = ep.port;
      RIGCTL_UL_HOST = "";
      RIGCTL_UL_PORT = 0;
    }
  } else {
    RIGCTL_UL_HOST = "";
    RIGCTL_UL_PORT = 0;
  }

  // Flex/SmartSDR CAT endpoints
  if (
    ul.protocol === "cat" &&
    (ul.type === "smartsdr" || ul.type === "aethersdr")
  ) {
    const ep = parseEp(ul.catEndpoint, "172.17.18.229", 60002);
    FLEX_UL_HOST = ep.host;
    FLEX_UL_PORT = ep.port;
    FLEX_HOST = ep.host;
    FLEX_PORT = ep.port;
  }
  if (
    dl.protocol === "cat" &&
    (dl.type === "smartsdr" || dl.type === "aethersdr")
  ) {
    const ep = parseEp(dl.catEndpoint, "172.17.18.229", 60001);
    FLEX_DL_HOST = ep.host;
    FLEX_DL_PORT = ep.port;
  }

  // API from either side
  for (const s of [dl, ul]) {
    if (s.apiEndpoint) {
      const ep = parseEp(s.apiEndpoint, "", 4992);
      if (ep.host) {
        FLEX_API_HOST = ep.host;
        FLEX_API_PORT = ep.port;
        break;
      }
    }
  }

  // Serial device mapping:
  //  - Both serial → DL = CAT_DEVICE (primary), UL = CAT2_DEVICE (dual CAT)
  //  - Only DL serial → CAT_DEVICE = DL, CAT2 blank (single / split)
  //  - Only UL serial → CAT_DEVICE = UL, CAT2 blank (TX-only serial;
  //    mixed path e.g. FT-817 UL + TCI DL must NOT leave a stale CAT_DEVICE)
  const dlSerial = dl.transport === "serial";
  const ulSerial = ul.transport === "serial";
  if (dlSerial && ulSerial) {
    CAT_DEVICE = dl.serialDevice || "/dev/ttyACM0";
    CAT_BAUD = dl.serialBaud || 19200;
    CAT2_DEVICE = ul.serialDevice || "";
    CAT2_BAUD = ul.serialBaud || 19200;
    SERIAL_MAKE = (dl.serialMake || "icom").toLowerCase();
    SERIAL_MODEL = (dl.serialModel || "ic-705").toLowerCase();
  } else if (dlSerial) {
    CAT_DEVICE = dl.serialDevice || "/dev/ttyACM0";
    CAT_BAUD = dl.serialBaud || 19200;
    CAT2_DEVICE = "";
    SERIAL_MAKE = (dl.serialMake || "icom").toLowerCase();
    SERIAL_MODEL = (dl.serialModel || "ic-705").toLowerCase();
  } else if (ulSerial) {
    CAT_DEVICE = ul.serialDevice || "/dev/ttyACM0";
    CAT_BAUD = ul.serialBaud || 19200;
    CAT2_DEVICE = "";
    SERIAL_MAKE = (ul.serialMake || "icom").toLowerCase();
    SERIAL_MODEL = (ul.serialModel || "ic-705").toLowerCase();
  }
}

const _serDef = defaultSerialSelection();
let SERIAL_MAKE = (process.env.SERIAL_MAKE || _serDef.make).toLowerCase();
let SERIAL_MODEL = (process.env.SERIAL_MODEL || _serDef.model).toLowerCase();

let TCI_HOST = process.env.TCI_HOST || "127.0.0.1";
let TCI_PORT = parseInt(process.env.TCI_PORT || "50001", 10);

// SDRplay SDRconnect WebSocket (default port 5454)
let SDRCONNECT_HOST = process.env.SDRCONNECT_HOST || "127.0.0.1";
let SDRCONNECT_PORT = parseInt(process.env.SDRCONNECT_PORT || "5454", 10);

// Hamlib / rigctl TCP (SDR++, remote rigctld, etc.)
let RIGCTL_HOST = process.env.RIGCTL_HOST || "127.0.0.1";
let RIGCTL_PORT = parseInt(process.env.RIGCTL_PORT || "4532", 10);
// Optional second endpoint for uplink (empty = single endpoint)
let RIGCTL_UL_HOST = (process.env.RIGCTL_UL_HOST || "").trim();
let RIGCTL_UL_PORT = parseInt(process.env.RIGCTL_UL_PORT || "0", 10);

let ROTOR_AZ_DEVICE = process.env.ROTOR_AZ_DEVICE || "/dev/ttyUSB0";
let ROTOR_EL_DEVICE = process.env.ROTOR_EL_DEVICE || "/dev/ttyUSB1";
/** "rt21" (default) | "gs232" | aliases: k3ng, foxdelta, gs-232 */
let ROTOR_TYPE = (process.env.ROTOR_TYPE || "rt21").toLowerCase();
let ROTOR_BAUD = parseInt(process.env.ROTOR_BAUD || "4800", 10);

let ROTOR_AZ_HOST = process.env.ROTOR_AZ_HOST || "127.0.0.1";
let ROTOR_AZ_PORT = parseInt(process.env.ROTOR_AZ_PORT || "4535", 10);
let ROTOR_EL_HOST =
  process.env.ROTOR_EL_HOST || process.env.ROTOR_AZ_HOST || "127.0.0.1";
let ROTOR_EL_PORT = parseInt(process.env.ROTOR_EL_PORT || "4536", 10);

const ROTOR_MIN_EL = parseFloat(process.env.ROTOR_MIN_EL || "0");
/** Profile park position (Park button + below-horizon hold). */
let ROTOR_PARK_AZ = parseFloat(process.env.ROTOR_PARK_AZ || "0");
let ROTOR_PARK_EL = parseFloat(process.env.ROTOR_PARK_EL || "0");
/** 90 or 180 — 180 enables over-top / flip tracking. */
let ROTOR_EL_MAX = parseInt(process.env.ROTOR_EL_MAX || "180", 10);
if (ROTOR_EL_MAX !== 90) ROTOR_EL_MAX = 180;
/** True = azimuth-only rotator (fixed elevation, no EL commands). */
let ROTOR_AZ_ONLY =
  process.env.ROTOR_AZ_ONLY === "1" || process.env.ROTOR_AZ_ONLY === "true";
/**
 * After a pass (sat below min EL): leave AZ/EL where tracking last pointed
 * instead of slewing to LOS@0 (GS-232) or next AOS (RT-21). Park still works.
 * Default true — explicit Park is the way to home the rotator.
 */
let ROTOR_HOLD_AFTER_PASS = !(
  process.env.ROTOR_HOLD_AFTER_PASS === "0" ||
  process.env.ROTOR_HOLD_AFTER_PASS === "false"
);
/**
 * Azimuth mechanical stop: "north" (0°) or "south" (180°).
 * Shortest path must never cross this stop — go the long way instead.
 * Yaesu G-5500 / Fox Delta typically north-stop.
 */
let ROTOR_AZ_STOP = String(process.env.ROTOR_AZ_STOP || "north").toLowerCase();
if (ROTOR_AZ_STOP === "s" || ROTOR_AZ_STOP === "south") ROTOR_AZ_STOP = "south";
else ROTOR_AZ_STOP = "north";

const ROTOR_SETTLE_DEG = parseFloat(process.env.ROTOR_SETTLE_DEG || "3");
const ROTOR_STILL_DEG = parseFloat(process.env.ROTOR_STILL_DEG || "0.25");
const ROTOR_STILL_COUNT = parseInt(process.env.ROTOR_STILL_COUNT || "5", 10);
const ROTOR_SETTLE_BUFFER_MS = parseInt(
  process.env.ROTOR_SETTLE_BUFFER_MS || "1500",
  10,
);
const ROTOR_DEADBAND_DEG = parseFloat(process.env.ROTOR_DEADBAND_DEG || "2.5");
const ROTOR_STALL_MS = parseInt(process.env.ROTOR_STALL_MS || "5000", 10);
const ROTOR_STALL_RETRIES = parseInt(
  process.env.ROTOR_STALL_RETRIES || "2",
  10,
);
const ROTOR_POLL_MS = parseInt(process.env.ROTOR_POLL_MS || "250", 10);
const ROTOR_LEAD_DEG = parseFloat(process.env.ROTOR_LEAD_DEG || "4");

let CAT_DEVICE = process.env.CAT_DEVICE || platform.defaultCatDevice();
let CAT_BAUD = parseInt(process.env.CAT_BAUD || "19200", 10);
let CAT_CIV_ADDR = parseInt(process.env.CAT_CIV_ADDR || "0xA4", 16);

let CAT2_DEVICE = (process.env.CAT2_DEVICE || "").trim();
let CAT2_BAUD = parseInt(process.env.CAT2_BAUD || String(CAT_BAUD), 10);
let CAT2_CIV_ADDR = parseInt(
  process.env.CAT2_CIV_ADDR || "0x" + CAT_CIV_ADDR.toString(16),
  16,
);

let FLEX_UL_HOST =
  process.env.FLEX_UL_HOST || process.env.FLEX_HOST || "172.17.18.229";
let FLEX_UL_PORT = parseInt(
  process.env.FLEX_UL_PORT || process.env.FLEX_PORT || "60002",
  10,
);
let FLEX_DL_HOST =
  process.env.FLEX_DL_HOST || process.env.FLEX_HOST || "172.17.18.229";
let FLEX_DL_PORT = parseInt(process.env.FLEX_DL_PORT || "60001", 10);

let FLEX_API_HOST = process.env.FLEX_API_HOST || "";
let FLEX_API_PORT = parseInt(process.env.FLEX_API_PORT || "4992", 10);

let FLEX_HOST = FLEX_UL_HOST;
let FLEX_PORT = FLEX_UL_PORT;

const DEFAULT_SAT = "RS-44";
const MIN_EL = 0.0;
const TRAIL_MINUTES = 30;
const TRAIL_STEP_SEC = 30;
const PASS_HOURS = 12;
const PASS_STEP_SEC = 30;
const REFRESH_MS = 6 * 60 * 60 * 1000;
const SATS_BROADCAST_MS = 30 * 1000;
const TICK_MS = 250;
const STATE_MS = 1000;
const C_MS = 299792.458;

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

function tciUri() {
  return "ws://" + TCI_HOST + ":" + TCI_PORT;
}

function normalizeRadioType(t) {
  if (!t) return "smartsdr";
  t = String(t).toLowerCase();
  if (t === "flex") return "smartsdr";
  return t;
}

function sideIsFlexCat(s) {
  if (!s || s.transport !== "tcp") return false;
  const t = normalizeRadioType(s.type);
  return s.protocol === "cat" && (t === "smartsdr" || t === "aethersdr");
}

function sideIsTci(s) {
  if (!s || s.transport !== "tcp") return false;
  return s.protocol === "tci" && normalizeRadioType(s.type) === "aethersdr";
}

function sideIsRigctl(s) {
  if (!s || s.transport !== "tcp") return false;
  return s.protocol === "rigctl" || normalizeRadioType(s.type) === "rigctl";
}

function sideIsSdrconnect(s) {
  if (!s || s.transport !== "tcp") return false;
  const t = normalizeRadioType(s.type);
  return t === "sdrconnect" || t === "sdrplay";
}

function sideIsSerial(s) {
  return !!(s && s.transport === "serial");
}

function useFlexCat() {
  return (
    sideIsFlexCat(RADIO_UL) ||
    sideIsFlexCat(RADIO_DL) ||
    (!RADIO_UL &&
      !RADIO_DL &&
      RADIO_TRANSPORT === "tcp" &&
      RADIO_PROTOCOL === "cat" &&
      (normalizeRadioType(RADIO_TYPE) === "smartsdr" ||
        normalizeRadioType(RADIO_TYPE) === "aethersdr"))
  );
}

function useTci() {
  return (
    sideIsTci(RADIO_UL) ||
    sideIsTci(RADIO_DL) ||
    (!RADIO_UL &&
      !RADIO_DL &&
      RADIO_TRANSPORT === "tcp" &&
      RADIO_PROTOCOL === "tci" &&
      normalizeRadioType(RADIO_TYPE) === "aethersdr")
  );
}

function useRigctl() {
  return (
    sideIsRigctl(RADIO_UL) ||
    sideIsRigctl(RADIO_DL) ||
    (!RADIO_UL &&
      !RADIO_DL &&
      RADIO_TRANSPORT === "tcp" &&
      RADIO_PROTOCOL === "rigctl")
  );
}

function useSdrconnect() {
  return (
    sideIsSdrconnect(RADIO_UL) ||
    sideIsSdrconnect(RADIO_DL) ||
    (!RADIO_UL &&
      !RADIO_DL &&
      RADIO_TRANSPORT === "tcp" &&
      (normalizeRadioType(RADIO_TYPE) === "sdrconnect" ||
        normalizeRadioType(RADIO_TYPE) === "sdrplay"))
  );
}

function useSerialCat() {
  return (
    sideIsSerial(RADIO_UL) ||
    sideIsSerial(RADIO_DL) ||
    (!RADIO_UL && !RADIO_DL && RADIO_TRANSPORT === "serial")
  );
}

function useIc705Serial() {
  if (RADIO_TRANSPORT !== "serial") return false;
  const make = String(SERIAL_MAKE || "").toLowerCase();
  const model = String(SERIAL_MODEL || "").toLowerCase();
  if (make && make !== "icom") return false;
  if (model === "ic-9700" || model === "ic9700" || model === "9700")
    return false;
  if (
    !model ||
    model === "ic-705" ||
    model === "ic705" ||
    model === "705" ||
    model === "other"
  )
    return true;
  const m = findModel(make || "icom", model);
  return !!(m && m.supported && (m.driver === "ic705" || m.driver === "icom"));
}

function useIc9700Serial() {
  if (RADIO_TRANSPORT !== "serial") return false;
  const make = String(SERIAL_MAKE || "").toLowerCase();
  const model = String(SERIAL_MODEL || "").toLowerCase();
  if (make && make !== "icom") return false;
  if (model === "ic-9700" || model === "ic9700" || model === "9700")
    return true;
  const m = findModel(make || "icom", model);
  return !!(m && m.supported && m.driver === "ic9700");
}

function useFt991Serial() {
  if (RADIO_TRANSPORT !== "serial") return false;
  const make = String(SERIAL_MAKE || "").toLowerCase();
  const model = String(SERIAL_MODEL || "").toLowerCase();
  if (make && make !== "yaesu") return false;
  // Binary Yaesu — not ASCII FT-991
  if (
    model === "ft-817" ||
    model === "ft817" ||
    model === "ft-818" ||
    model === "ft818" ||
    model === "ft-817nd" ||
    model === "ft-847" ||
    model === "ft847"
  )
    return false;
  if (
    !model ||
    model === "ft-991" ||
    model === "ft991" ||
    model === "ft-991a" ||
    model === "other"
  )
    return true;
  const m = findModel(make || "yaesu", model);
  return !!(m && m.supported && (m.driver === "ft991" || m.driver === "yaesu"));
}

function useFt847Serial() {
  if (RADIO_TRANSPORT !== "serial") return false;
  const make = String(SERIAL_MAKE || "").toLowerCase();
  const model = String(SERIAL_MODEL || "").toLowerCase();
  if (make && make !== "yaesu") return false;
  if (model === "ft-847" || model === "ft847" || model === "847") return true;
  const m = findModel(make || "yaesu", model);
  return !!(m && m.supported && m.driver === "ft847");
}

function useFt817Serial() {
  if (RADIO_TRANSPORT !== "serial") return false;
  const make = String(SERIAL_MAKE || "").toLowerCase();
  const model = String(SERIAL_MODEL || "").toLowerCase();
  if (make && make !== "yaesu") return false;
  if (
    model === "ft-817" ||
    model === "ft817" ||
    model === "ft-818" ||
    model === "ft818" ||
    model === "ft-817nd"
  )
    return true;
  const m = findModel(make || "yaesu", model);
  return !!(m && m.supported && m.driver === "ft817");
}

function useTs2000Serial() {
  if (RADIO_TRANSPORT !== "serial") return false;
  const make = String(SERIAL_MAKE || "").toLowerCase();
  const model = String(SERIAL_MODEL || "").toLowerCase();
  if (make && make !== "kenwood") return false;
  if (!model || model === "ts-2000" || model === "ts2000" || model === "other")
    return true;
  const m = findModel(make || "kenwood", model);
  return !!(
    m &&
    m.supported &&
    (m.driver === "ts2000" || m.driver === "kenwood")
  );
}

/** Apply catalog defaults (CI-V addr, baud) for the active serial model. */
function applySerialModelDefaults() {
  const m = findModel(SERIAL_MAKE, SERIAL_MODEL);
  if (!m) return false;
  let changed = false;
  if (m.civAddr != null && Number.isFinite(Number(m.civAddr))) {
    const a = parseInt(m.civAddr, 10);
    if (a >= 0 && a <= 0xff && a !== CAT_CIV_ADDR) {
      CAT_CIV_ADDR = a;
      changed = true;
    }
  }
  return changed;
}

function getSerialModelInfo() {
  return findModel(SERIAL_MAKE, SERIAL_MODEL);
}

function isDualCat() {
  const d1 = String(CAT_DEVICE || "").trim();
  const d2 = String(CAT2_DEVICE || "").trim();
  if (!d2) return false;
  return d2 !== d1;
}

function getEndpoints() {
  return {
    singleRadio: SINGLE_RADIO,
    txSplit: TX_SPLIT,
    radioUl: RADIO_UL || defaultSideConfig("ul"),
    radioDl: RADIO_DL || defaultSideConfig("dl"),
    radioTransport: RADIO_TRANSPORT,
    radioType: normalizeRadioType(RADIO_TYPE),
    radioProtocol: RADIO_PROTOCOL,
    serialMake: SERIAL_MAKE,
    serialModel: SERIAL_MODEL,
    tciHost: TCI_HOST,
    tciPort: TCI_PORT,
    sdrconnectHost: SDRCONNECT_HOST,
    sdrconnectPort: SDRCONNECT_PORT,
    rigctlHost: RIGCTL_HOST,
    rigctlPort: RIGCTL_PORT,
    rigctlUlHost: RIGCTL_UL_HOST,
    rigctlUlPort: RIGCTL_UL_PORT,
    rotorType: ROTOR_TYPE,
    rotorAzDevice: ROTOR_AZ_DEVICE,
    rotorElDevice: ROTOR_EL_DEVICE,
    rotorBaud: ROTOR_BAUD,
    rotorParkAz: ROTOR_PARK_AZ,
    rotorParkEl: ROTOR_PARK_EL,
    rotorElMax: ROTOR_EL_MAX,
    rotorAzOnly: ROTOR_AZ_ONLY,
    rotorHoldAfterPass: ROTOR_HOLD_AFTER_PASS,
    rotorAzStop: ROTOR_AZ_STOP,
    catDevice: CAT_DEVICE,
    serialDevice: CAT_DEVICE,
    serialBaud: CAT_BAUD,
    serialDevice2: CAT2_DEVICE,
    serialBaud2: CAT2_BAUD,
    catCivAddr: CAT_CIV_ADDR,
    catCivAddr2: CAT2_CIV_ADDR,
    dualCat: isDualCat(),
    flexUlHost: FLEX_UL_HOST,
    flexUlPort: FLEX_UL_PORT,
    flexDlHost: FLEX_DL_HOST,
    flexDlPort: FLEX_DL_PORT,
    flexHost: FLEX_UL_HOST,
    flexPort: FLEX_UL_PORT,
    flexApiHost: FLEX_API_HOST,
    flexApiPort: FLEX_API_PORT,
    rotorHost: ROTOR_AZ_HOST,
    rotorAzPort: ROTOR_AZ_PORT,
    rotorElPort: ROTOR_EL_PORT,
    serialCatalog: {
      makes: listMakes(),
      models: listModels(SERIAL_MAKE),
    },
    host: platform.hostInfo(),
  };
}

function applyEndpoints(ep) {
  let tciChanged = false;
  let rotorChanged = false;
  let catChanged = false;
  let flexChanged = false;
  let rigctlChanged = false;
  let sdrconnectChanged = false;
  let radioSelChanged = false;
  if (!ep || typeof ep !== "object") {
    return {
      tciChanged,
      rotorChanged,
      catChanged,
      flexChanged,
      rigctlChanged,
      sdrconnectChanged,
      radioSelChanged,
    };
  }

  // Single radio (split) flag — one physical radio for UL+DL
  if (typeof ep.singleRadio === "boolean") {
    if (ep.singleRadio !== SINGLE_RADIO) {
      SINGLE_RADIO = ep.singleRadio;
      radioSelChanged = true;
    }
  }
  if (typeof ep.txSplit === "boolean") {
    if (ep.txSplit !== TX_SPLIT) {
      TX_SPLIT = ep.txSplit;
      radioSelChanged = true;
    }
  }

  // Dual-side radio config (preferred)
  if (ep.radioUl && typeof ep.radioUl === "object") {
    RADIO_UL = normalizeSide(ep.radioUl, "ul");
    radioSelChanged = true;
  }
  if (ep.radioDl && typeof ep.radioDl === "object") {
    RADIO_DL = normalizeSide(ep.radioDl, "dl");
    radioSelChanged = true;
  }

  // Single radio: force DL = UL and clear second serial device (SPLIT mode)
  if (SINGLE_RADIO && RADIO_UL) {
    RADIO_DL = normalizeSide(RADIO_UL, "dl");
    // Ensure serial split (isDualCat false)
    if (RADIO_UL.transport === "serial") {
      // mapSidesToGlobals will set CAT2 blank when only one serial side differs;
      // force blank device2 explicitly via serialDevice2 override below.
    }
  }

  if (RADIO_UL || RADIO_DL) {
    if (!RADIO_UL) RADIO_UL = defaultSideConfig("ul");
    if (!RADIO_DL) RADIO_DL = defaultSideConfig("dl");
    mapSidesToGlobals();
    if (SINGLE_RADIO) {
      // One CAT/serial endpoint — never dual-cat
      CAT2_DEVICE = "";
      RIGCTL_UL_HOST = "";
      RIGCTL_UL_PORT = 0;
      // Same Flex CAT port for both sides
      FLEX_DL_HOST = FLEX_UL_HOST;
      FLEX_DL_PORT = FLEX_UL_PORT;
    }
    // continue to allow rotor / misc overrides below
  }

  if (typeof ep.radioTransport === "string" && ep.radioTransport.trim()) {
    const v = ep.radioTransport.trim().toLowerCase();
    if ((v === "tcp" || v === "serial") && v !== RADIO_TRANSPORT) {
      RADIO_TRANSPORT = v;
      radioSelChanged = true;
    }
  }
  if (typeof ep.radioType === "string" && ep.radioType.trim()) {
    const v = normalizeRadioType(ep.radioType.trim());
    if (v !== normalizeRadioType(RADIO_TYPE)) {
      RADIO_TYPE = v;
      radioSelChanged = true;
    }
  }
  if (typeof ep.radioProtocol === "string" && ep.radioProtocol.trim()) {
    let v = ep.radioProtocol.trim().toLowerCase();
    if (normalizeRadioType(RADIO_TYPE) === "smartsdr" && v === "tci") v = "cat";
    if (
      (v === "cat" || v === "tci" || v === "rigctl") &&
      v !== RADIO_PROTOCOL
    ) {
      RADIO_PROTOCOL = v;
      radioSelChanged = true;
    }
  }

  // Generic rigctl radio type implies protocol=rigctl
  if (
    normalizeRadioType(RADIO_TYPE) === "rigctl" &&
    RADIO_PROTOCOL !== "rigctl"
  ) {
    RADIO_PROTOCOL = "rigctl";
    radioSelChanged = true;
  }
  // SmartSDR only supports CAT (not TCI)
  if (
    normalizeRadioType(RADIO_TYPE) === "smartsdr" &&
    RADIO_PROTOCOL !== "cat"
  ) {
    RADIO_PROTOCOL = "cat";
    radioSelChanged = true;
  }

  if (typeof ep.serialMake === "string" && ep.serialMake.trim()) {
    const v = ep.serialMake.trim().toLowerCase();
    if (v !== SERIAL_MAKE) {
      SERIAL_MAKE = v;
      radioSelChanged = true;
      catChanged = true;
    }
  }
  if (typeof ep.serialModel === "string" && ep.serialModel.trim()) {
    const v = ep.serialModel.trim().toLowerCase();
    if (v !== SERIAL_MODEL) {
      SERIAL_MODEL = v;
      radioSelChanged = true;
      catChanged = true;
    }
  }
  // Keep CI-V address in sync with selected Icom model (e.g. 9700 = 0xA2)
  if (applySerialModelDefaults()) {
    catChanged = true;
  }

  if (typeof ep.tciHost === "string" && ep.tciHost.trim()) {
    const h = ep.tciHost.trim();
    if (h !== TCI_HOST) {
      TCI_HOST = h;
      tciChanged = true;
    }
  }
  if (ep.tciPort != null && Number.isFinite(Number(ep.tciPort))) {
    const p = parseInt(ep.tciPort, 10);
    if (p > 0 && p < 65536 && p !== TCI_PORT) {
      TCI_PORT = p;
      tciChanged = true;
    }
  }

  if (typeof ep.sdrconnectHost === "string" && ep.sdrconnectHost.trim()) {
    const h = ep.sdrconnectHost.trim();
    if (h !== SDRCONNECT_HOST) {
      SDRCONNECT_HOST = h;
      sdrconnectChanged = true;
    }
  }
  if (ep.sdrconnectPort != null && Number.isFinite(Number(ep.sdrconnectPort))) {
    const p = parseInt(ep.sdrconnectPort, 10);
    if (p > 0 && p < 65536 && p !== SDRCONNECT_PORT) {
      SDRCONNECT_PORT = p;
      sdrconnectChanged = true;
    }
  }

  if (typeof ep.rigctlHost === "string" && ep.rigctlHost.trim()) {
    const h = ep.rigctlHost.trim();
    if (h !== RIGCTL_HOST) {
      RIGCTL_HOST = h;
      rigctlChanged = true;
    }
  }
  if (ep.rigctlPort != null && Number.isFinite(Number(ep.rigctlPort))) {
    const p = parseInt(ep.rigctlPort, 10);
    if (p > 0 && p < 65536 && p !== RIGCTL_PORT) {
      RIGCTL_PORT = p;
      rigctlChanged = true;
    }
  }
  if (typeof ep.rigctlUlHost === "string") {
    const h = ep.rigctlUlHost.trim();
    if (h !== RIGCTL_UL_HOST) {
      RIGCTL_UL_HOST = h;
      rigctlChanged = true;
    }
  }
  if (ep.rigctlUlPort != null && Number.isFinite(Number(ep.rigctlUlPort))) {
    const p = parseInt(ep.rigctlUlPort, 10);
    if (p >= 0 && p < 65536 && p !== RIGCTL_UL_PORT) {
      RIGCTL_UL_PORT = p;
      rigctlChanged = true;
    }
  }

  if (typeof ep.rotorType === "string" && ep.rotorType.trim()) {
    const t = ep.rotorType.trim().toLowerCase();
    if (t && t !== ROTOR_TYPE) {
      ROTOR_TYPE = t;
      rotorChanged = true;
    }
  }
  if (typeof ep.rotorAzDevice === "string" && ep.rotorAzDevice.trim()) {
    const d = ep.rotorAzDevice.trim();
    if (d !== ROTOR_AZ_DEVICE) {
      ROTOR_AZ_DEVICE = d;
      rotorChanged = true;
    }
  }
  if (typeof ep.rotorElDevice === "string" && ep.rotorElDevice.trim()) {
    const d = ep.rotorElDevice.trim();
    if (d !== ROTOR_EL_DEVICE) {
      ROTOR_EL_DEVICE = d;
      rotorChanged = true;
    }
  }
  if (ep.rotorBaud != null && Number.isFinite(Number(ep.rotorBaud))) {
    const b = parseInt(ep.rotorBaud, 10);
    if (b > 0 && b !== ROTOR_BAUD) {
      ROTOR_BAUD = b;
      rotorChanged = true;
    }
  }
  if (ep.rotorParkAz != null && Number.isFinite(Number(ep.rotorParkAz))) {
    const a = parseFloat(ep.rotorParkAz);
    if (Number.isFinite(a) && a !== ROTOR_PARK_AZ) {
      ROTOR_PARK_AZ = ((a % 360) + 360) % 360;
      rotorChanged = true;
    }
  }
  if (ep.rotorParkEl != null && Number.isFinite(Number(ep.rotorParkEl))) {
    const e = parseFloat(ep.rotorParkEl);
    if (Number.isFinite(e) && e !== ROTOR_PARK_EL) {
      ROTOR_PARK_EL = Math.max(0, Math.min(180, e));
      rotorChanged = true;
    }
  }
  if (ep.rotorElMax != null && Number.isFinite(Number(ep.rotorElMax))) {
    const m = parseInt(ep.rotorElMax, 10) === 90 ? 90 : 180;
    if (m !== ROTOR_EL_MAX) {
      ROTOR_EL_MAX = m;
      rotorChanged = true;
    }
  }
  if (typeof ep.rotorAzOnly === "boolean") {
    if (ep.rotorAzOnly !== ROTOR_AZ_ONLY) {
      ROTOR_AZ_ONLY = ep.rotorAzOnly;
      rotorChanged = true;
    }
  }
  if (typeof ep.rotorHoldAfterPass === "boolean") {
    if (ep.rotorHoldAfterPass !== ROTOR_HOLD_AFTER_PASS) {
      ROTOR_HOLD_AFTER_PASS = ep.rotorHoldAfterPass;
      rotorChanged = true;
    }
  }
  if (ep.rotorAzStop != null && String(ep.rotorAzStop).trim()) {
    let s = String(ep.rotorAzStop).toLowerCase().trim();
    if (s === "s" || s === "south") s = "south";
    else s = "north";
    if (s !== ROTOR_AZ_STOP) {
      ROTOR_AZ_STOP = s;
      rotorChanged = true;
    }
  }

  // Legacy flat serialDevice fields — only when dual-side radioUl/radioDl
  // were NOT provided. Otherwise mapSidesToGlobals already set CAT_DEVICE
  // from the serial side(s). Applying dl.serialDevice defaults here was
  // stomping a mixed path (e.g. FT-817 UL + TCI DL) back to /dev/ttyACM0.
  const hasSideCfg = !!(ep.radioUl || ep.radioDl);
  if (!hasSideCfg) {
    const serialDev =
      (typeof ep.serialDevice === "string" && ep.serialDevice.trim()) ||
      (typeof ep.catDevice === "string" && ep.catDevice.trim()) ||
      null;
    if (serialDev && serialDev !== CAT_DEVICE) {
      CAT_DEVICE = serialDev;
      catChanged = true;
    }
    if (ep.serialBaud != null && Number.isFinite(Number(ep.serialBaud))) {
      const b = parseInt(ep.serialBaud, 10);
      if (b > 0 && b !== CAT_BAUD) {
        CAT_BAUD = b;
        catChanged = true;
      }
    }

    if (typeof ep.serialDevice2 === "string") {
      const d = ep.serialDevice2.trim();
      if (d !== CAT2_DEVICE) {
        CAT2_DEVICE = d;
        catChanged = true;
      }
    }
    if (ep.serialBaud2 != null && Number.isFinite(Number(ep.serialBaud2))) {
      const b = parseInt(ep.serialBaud2, 10);
      if (b > 0 && b !== CAT2_BAUD) {
        CAT2_BAUD = b;
        catChanged = true;
      }
    }
  }
  if (ep.catCivAddr2 != null && Number.isFinite(Number(ep.catCivAddr2))) {
    const a = parseInt(ep.catCivAddr2, 10);
    if (a >= 0 && a <= 0xff && a !== CAT2_CIV_ADDR) {
      CAT2_CIV_ADDR = a;
      catChanged = true;
    }
  }
  if (ep.catCivAddr != null && Number.isFinite(Number(ep.catCivAddr))) {
    const a = parseInt(ep.catCivAddr, 10);
    if (a >= 0 && a <= 0xff && a !== CAT_CIV_ADDR) {
      CAT_CIV_ADDR = a;
      catChanged = true;
    }
  }

  if (typeof ep.flexUlHost === "string" && ep.flexUlHost.trim()) {
    const h = ep.flexUlHost.trim();
    if (h !== FLEX_UL_HOST) {
      FLEX_UL_HOST = h;
      FLEX_HOST = h;
      flexChanged = true;
    }
  }
  if (ep.flexUlPort != null && Number.isFinite(Number(ep.flexUlPort))) {
    const p = parseInt(ep.flexUlPort, 10);
    if (p > 0 && p < 65536 && p !== FLEX_UL_PORT) {
      FLEX_UL_PORT = p;
      FLEX_PORT = p;
      flexChanged = true;
    }
  }
  if (typeof ep.flexDlHost === "string" && ep.flexDlHost.trim()) {
    const h = ep.flexDlHost.trim();
    if (h !== FLEX_DL_HOST) {
      FLEX_DL_HOST = h;
      flexChanged = true;
    }
  }
  if (ep.flexDlPort != null && Number.isFinite(Number(ep.flexDlPort))) {
    const p = parseInt(ep.flexDlPort, 10);
    if (p > 0 && p < 65536 && p !== FLEX_DL_PORT) {
      FLEX_DL_PORT = p;
      flexChanged = true;
    }
  }

  if (typeof ep.flexHost === "string" && ep.flexHost.trim()) {
    const h = ep.flexHost.trim();
    if (h !== FLEX_UL_HOST) {
      FLEX_UL_HOST = h;
      FLEX_HOST = h;
      flexChanged = true;
    }
  }
  if (ep.flexPort != null && Number.isFinite(Number(ep.flexPort))) {
    const p = parseInt(ep.flexPort, 10);
    if (p > 0 && p < 65536 && p !== FLEX_UL_PORT) {
      FLEX_UL_PORT = p;
      FLEX_PORT = p;
      flexChanged = true;
    }
  }

  if (typeof ep.flexApiHost === "string") {
    const h = ep.flexApiHost.trim();
    if (h !== FLEX_API_HOST) {
      FLEX_API_HOST = h;
      flexChanged = true;
    }
  }
  if (ep.flexApiPort != null && Number.isFinite(Number(ep.flexApiPort))) {
    const p = parseInt(ep.flexApiPort, 10);
    if (p > 0 && p < 65536 && p !== FLEX_API_PORT) {
      FLEX_API_PORT = p;
      flexChanged = true;
    }
  }

  if (typeof ep.rotorHost === "string" && ep.rotorHost.trim()) {
    ROTOR_AZ_HOST = ep.rotorHost.trim();
    ROTOR_EL_HOST = ep.rotorHost.trim();
  }
  if (ep.rotorAzPort != null && Number.isFinite(Number(ep.rotorAzPort))) {
    ROTOR_AZ_PORT = parseInt(ep.rotorAzPort, 10);
  }
  if (ep.rotorElPort != null && Number.isFinite(Number(ep.rotorElPort))) {
    ROTOR_EL_PORT = parseInt(ep.rotorElPort, 10);
  }

  return {
    tciChanged,
    rotorChanged,
    catChanged,
    flexChanged,
    rigctlChanged,
    sdrconnectChanged,
    radioSelChanged,
  };
}

module.exports = {
  ROOT,
  CACHE_DIR,
  CATALOG_CACHE,
  STATUS_CACHE,
  PORT,
  CATALOG_URL,
  AMSAT_STATUS,
  get RADIO_TRANSPORT() {
    return RADIO_TRANSPORT;
  },
  get RADIO_TYPE() {
    return normalizeRadioType(RADIO_TYPE);
  },
  get RADIO_PROTOCOL() {
    return RADIO_PROTOCOL;
  },
  get RADIO_UL() {
    return RADIO_UL || defaultSideConfig("ul");
  },
  get RADIO_DL() {
    return RADIO_DL || defaultSideConfig("dl");
  },
  get TX_SPLIT() {
    return TX_SPLIT;
  },
  get SINGLE_RADIO() {
    return SINGLE_RADIO;
  },
  get SERIAL_MAKE() {
    return SERIAL_MAKE;
  },
  get SERIAL_MODEL() {
    return SERIAL_MODEL;
  },
  get TCI_HOST() {
    return TCI_HOST;
  },
  get TCI_PORT() {
    return TCI_PORT;
  },
  get TCI_URI() {
    return tciUri();
  },
  get SDRCONNECT_HOST() {
    return SDRCONNECT_HOST;
  },
  get SDRCONNECT_PORT() {
    return SDRCONNECT_PORT;
  },
  get RIGCTL_HOST() {
    return RIGCTL_HOST;
  },
  get RIGCTL_PORT() {
    return RIGCTL_PORT;
  },
  get RIGCTL_UL_HOST() {
    return RIGCTL_UL_HOST;
  },
  get RIGCTL_UL_PORT() {
    return RIGCTL_UL_PORT;
  },
  get ROTOR_TYPE() {
    return ROTOR_TYPE;
  },
  get ROTOR_AZ_DEVICE() {
    return ROTOR_AZ_DEVICE;
  },
  get ROTOR_EL_DEVICE() {
    return ROTOR_EL_DEVICE;
  },
  get ROTOR_BAUD() {
    return ROTOR_BAUD;
  },
  get ROTOR_AZ_HOST() {
    return ROTOR_AZ_HOST;
  },
  get ROTOR_AZ_PORT() {
    return ROTOR_AZ_PORT;
  },
  get ROTOR_EL_HOST() {
    return ROTOR_EL_HOST;
  },
  get ROTOR_EL_PORT() {
    return ROTOR_EL_PORT;
  },
  ROTOR_MIN_EL,
  get ROTOR_PARK_AZ() {
    return ROTOR_PARK_AZ;
  },
  get ROTOR_PARK_EL() {
    return ROTOR_PARK_EL;
  },
  get ROTOR_EL_MAX() {
    return ROTOR_EL_MAX;
  },
  get ROTOR_AZ_ONLY() {
    return ROTOR_AZ_ONLY;
  },
  get ROTOR_HOLD_AFTER_PASS() {
    return ROTOR_HOLD_AFTER_PASS;
  },
  get ROTOR_AZ_STOP() {
    return ROTOR_AZ_STOP;
  },
  ROTOR_SETTLE_DEG,
  ROTOR_STILL_DEG,
  ROTOR_STILL_COUNT,
  ROTOR_SETTLE_BUFFER_MS,
  ROTOR_DEADBAND_DEG,
  ROTOR_STALL_MS,
  ROTOR_STALL_RETRIES,
  ROTOR_POLL_MS,
  ROTOR_LEAD_DEG,
  get CAT_DEVICE() {
    return CAT_DEVICE;
  },
  get CAT_BAUD() {
    return CAT_BAUD;
  },
  get CAT_CIV_ADDR() {
    return CAT_CIV_ADDR;
  },
  get CAT2_DEVICE() {
    return CAT2_DEVICE;
  },
  get CAT2_BAUD() {
    return CAT2_BAUD;
  },
  get CAT2_CIV_ADDR() {
    return CAT2_CIV_ADDR;
  },
  get FLEX_HOST() {
    return FLEX_UL_HOST;
  },
  get FLEX_PORT() {
    return FLEX_UL_PORT;
  },
  get FLEX_UL_HOST() {
    return FLEX_UL_HOST;
  },
  get FLEX_UL_PORT() {
    return FLEX_UL_PORT;
  },
  get FLEX_DL_HOST() {
    return FLEX_DL_HOST;
  },
  get FLEX_DL_PORT() {
    return FLEX_DL_PORT;
  },
  get FLEX_API_HOST() {
    return FLEX_API_HOST;
  },
  get FLEX_API_PORT() {
    return FLEX_API_PORT;
  },
  DEFAULT_SAT,
  MIN_EL,
  TRAIL_MINUTES,
  TRAIL_STEP_SEC,
  PASS_HOURS,
  PASS_STEP_SEC,
  REFRESH_MS,
  SATS_BROADCAST_MS,
  TICK_MS,
  STATE_MS,
  C_MS,
  MIME,
  getEndpoints,
  applyEndpoints,
  tciUri,
  useFlexCat,
  useTci,
  useRigctl,
  useSdrconnect,
  useSerialCat,
  useIc705Serial,
  useIc9700Serial,
  useFt991Serial,
  useFt847Serial,
  useFt817Serial,
  useTs2000Serial,
  getSerialModelInfo,
  isDualCat,
  platform,
};
