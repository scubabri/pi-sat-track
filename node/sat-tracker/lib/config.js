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
let RADIO_DL = null;

function defaultSideConfig(side) {
  return {
    transport: "tcp",
    type: "smartsdr",
    protocol: "cat",
    tciEndpoint: "127.0.0.1:50001",
    rigctlEndpoint: "127.0.0.1:4532",
    catEndpoint: side === "ul" ? "172.17.18.229:60002" : "172.17.18.229:60001",
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
    if (host && Number.isFinite(p) && p > 0 && p < 65536) return { host, port: p };
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
    if (s.protocol === "tci" || (s.type === "aethersdr" && s.protocol === "tci")) {
      const ep = parseEp(s.tciEndpoint, "127.0.0.1", 50001);
      TCI_HOST = ep.host;
      TCI_PORT = ep.port;
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
  if (ul.protocol === "cat" && (ul.type === "smartsdr" || ul.type === "aethersdr")) {
    const ep = parseEp(ul.catEndpoint, "172.17.18.229", 60002);
    FLEX_UL_HOST = ep.host;
    FLEX_UL_PORT = ep.port;
    FLEX_HOST = ep.host;
    FLEX_PORT = ep.port;
  }
  if (dl.protocol === "cat" && (dl.type === "smartsdr" || dl.type === "aethersdr")) {
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

  // Serial: DL = primary device, UL = device2
  if (dl.transport === "serial") {
    CAT_DEVICE = dl.serialDevice || "/dev/ttyACM0";
    CAT_BAUD = dl.serialBaud || 19200;
    SERIAL_MAKE = (dl.serialMake || "icom").toLowerCase();
    SERIAL_MODEL = (dl.serialModel || "ic-705").toLowerCase();
  }
  if (ul.transport === "serial") {
    CAT2_DEVICE = ul.serialDevice || "";
    CAT2_BAUD = ul.serialBaud || 19200;
  } else if (dl.transport === "serial") {
    // single serial radio — leave CAT2 blank for SPLIT mode
    CAT2_DEVICE = "";
  }
}

const _serDef = defaultSerialSelection();
let SERIAL_MAKE = (process.env.SERIAL_MAKE || _serDef.make).toLowerCase();
let SERIAL_MODEL = (process.env.SERIAL_MODEL || _serDef.model).toLowerCase();

let TCI_HOST = process.env.TCI_HOST || "127.0.0.1";
let TCI_PORT = parseInt(process.env.TCI_PORT || "50001", 10);

// Hamlib / rigctl TCP (SDR++, remote rigctld, etc.)
let RIGCTL_HOST = process.env.RIGCTL_HOST || "127.0.0.1";
let RIGCTL_PORT = parseInt(process.env.RIGCTL_PORT || "4532", 10);
// Optional second endpoint for uplink (empty = single endpoint)
let RIGCTL_UL_HOST = (process.env.RIGCTL_UL_HOST || "").trim();
let RIGCTL_UL_PORT = parseInt(process.env.RIGCTL_UL_PORT || "0", 10);

let ROTOR_AZ_DEVICE = process.env.ROTOR_AZ_DEVICE || "/dev/ttyUSB0";
let ROTOR_EL_DEVICE = process.env.ROTOR_EL_DEVICE || "/dev/ttyUSB1";
const ROTOR_BAUD = parseInt(process.env.ROTOR_BAUD || "4800", 10);

let ROTOR_AZ_HOST = process.env.ROTOR_AZ_HOST || "127.0.0.1";
let ROTOR_AZ_PORT = parseInt(process.env.ROTOR_AZ_PORT || "4535", 10);
let ROTOR_EL_HOST =
  process.env.ROTOR_EL_HOST || process.env.ROTOR_AZ_HOST || "127.0.0.1";
let ROTOR_EL_PORT = parseInt(process.env.ROTOR_EL_PORT || "4536", 10);

const ROTOR_MIN_EL = parseFloat(process.env.ROTOR_MIN_EL || "10");
const ROTOR_PARK_EL = parseFloat(
  process.env.ROTOR_PARK_EL || String(ROTOR_MIN_EL),
);

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
  process.env.CAT2_CIV_ADDR || ("0x" + CAT_CIV_ADDR.toString(16)),
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

function sideIsSerial(s) {
  return !!(s && s.transport === "serial");
}

function useFlexCat() {
  return sideIsFlexCat(RADIO_UL) || sideIsFlexCat(RADIO_DL) || (
    !RADIO_UL && !RADIO_DL &&
    RADIO_TRANSPORT === "tcp" &&
    RADIO_PROTOCOL === "cat" &&
    (normalizeRadioType(RADIO_TYPE) === "smartsdr" ||
      normalizeRadioType(RADIO_TYPE) === "aethersdr")
  );
}

function useTci() {
  return sideIsTci(RADIO_UL) || sideIsTci(RADIO_DL) || (
    !RADIO_UL && !RADIO_DL &&
    RADIO_TRANSPORT === "tcp" &&
    RADIO_PROTOCOL === "tci" &&
    normalizeRadioType(RADIO_TYPE) === "aethersdr"
  );
}

function useRigctl() {
  return sideIsRigctl(RADIO_UL) || sideIsRigctl(RADIO_DL) || (
    !RADIO_UL && !RADIO_DL &&
    RADIO_TRANSPORT === "tcp" &&
    RADIO_PROTOCOL === "rigctl"
  );
}

function useSerialCat() {
  return sideIsSerial(RADIO_UL) || sideIsSerial(RADIO_DL) || (
    !RADIO_UL && !RADIO_DL && RADIO_TRANSPORT === "serial"
  );
}

function useIcomSerial() {
  if (RADIO_TRANSPORT !== "serial") return false;
  const make = String(SERIAL_MAKE || "").toLowerCase();
  const model = String(SERIAL_MODEL || "").toLowerCase();
  if (make && make !== "icom") return false;
  if (!model || model === "ic-705" || model === "ic705") return true;
  const m = findModel(make || "icom", model);
  return !!(m && m.supported && m.driver === "icom");
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
    radioUl: RADIO_UL || defaultSideConfig("ul"),
    radioDl: RADIO_DL || defaultSideConfig("dl"),
    radioTransport: RADIO_TRANSPORT,
    radioType: normalizeRadioType(RADIO_TYPE),
    radioProtocol: RADIO_PROTOCOL,
    serialMake: SERIAL_MAKE,
    serialModel: SERIAL_MODEL,
    tciHost: TCI_HOST,
    tciPort: TCI_PORT,
    rigctlHost: RIGCTL_HOST,
    rigctlPort: RIGCTL_PORT,
    rigctlUlHost: RIGCTL_UL_HOST,
    rigctlUlPort: RIGCTL_UL_PORT,
    rotorAzDevice: ROTOR_AZ_DEVICE,
    rotorElDevice: ROTOR_EL_DEVICE,
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
  let radioSelChanged = false;
  if (!ep || typeof ep !== "object") {
    return {
      tciChanged,
      rotorChanged,
      catChanged,
      flexChanged,
      rigctlChanged,
      radioSelChanged,
    };
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
  if (RADIO_UL || RADIO_DL) {
    if (!RADIO_UL) RADIO_UL = defaultSideConfig("ul");
    if (!RADIO_DL) RADIO_DL = defaultSideConfig("dl");
    mapSidesToGlobals();
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
    if ((v === "cat" || v === "tci" || v === "rigctl") && v !== RADIO_PROTOCOL) {
      RADIO_PROTOCOL = v;
      radioSelChanged = true;
    }
  }

  // Generic rigctl radio type implies protocol=rigctl
  if (normalizeRadioType(RADIO_TYPE) === "rigctl" && RADIO_PROTOCOL !== "rigctl") {
    RADIO_PROTOCOL = "rigctl";
    radioSelChanged = true;
  }
  // SmartSDR only supports CAT (not TCI)
  if (normalizeRadioType(RADIO_TYPE) === "smartsdr" && RADIO_PROTOCOL !== "cat") {
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
  get ROTOR_AZ_DEVICE() {
    return ROTOR_AZ_DEVICE;
  },
  get ROTOR_EL_DEVICE() {
    return ROTOR_EL_DEVICE;
  },
  ROTOR_BAUD,
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
  ROTOR_PARK_EL,
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
  useSerialCat,
  useIcomSerial,
  getSerialModelInfo,
  isDualCat,
  platform,
};
