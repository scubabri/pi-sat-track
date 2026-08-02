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

const _serDef = defaultSerialSelection();
let SERIAL_MAKE = (process.env.SERIAL_MAKE || _serDef.make).toLowerCase();
let SERIAL_MODEL = (process.env.SERIAL_MODEL || _serDef.model).toLowerCase();

let TCI_HOST = process.env.TCI_HOST || "127.0.0.1";
let TCI_PORT = parseInt(process.env.TCI_PORT || "50001", 10);

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

// Default CAT device follows host OS (linux → ttyACM0, darwin → cu.usbmodem*, win → COM3)
let CAT_DEVICE = process.env.CAT_DEVICE || platform.defaultCatDevice();
let CAT_BAUD = parseInt(process.env.CAT_BAUD || "19200", 10);
let CAT_CIV_ADDR = parseInt(process.env.CAT_CIV_ADDR || "0xA4", 16);

let FLEX_UL_HOST =
  process.env.FLEX_UL_HOST || process.env.FLEX_HOST || "172.17.18.229";
let FLEX_UL_PORT = parseInt(
  process.env.FLEX_UL_PORT || process.env.FLEX_PORT || "60002",
  10,
);
let FLEX_DL_HOST =
  process.env.FLEX_DL_HOST || process.env.FLEX_HOST || "172.17.18.229";
let FLEX_DL_PORT = parseInt(process.env.FLEX_DL_PORT || "60001", 10);

// SmartSDR API lives on the *radio* (not the Windows CAT host).
// Empty = disabled until user sets the radio LAN IP.
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

function useFlexCat() {
  const t = normalizeRadioType(RADIO_TYPE);
  return (
    RADIO_TRANSPORT === "tcp" &&
    RADIO_PROTOCOL === "cat" &&
    (t === "smartsdr" || t === "aethersdr")
  );
}

function useTci() {
  const t = normalizeRadioType(RADIO_TYPE);
  return (
    RADIO_TRANSPORT === "tcp" && RADIO_PROTOCOL === "tci" && t === "aethersdr"
  );
}

function useSerialCat() {
  return RADIO_TRANSPORT === "serial";
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

function getEndpoints() {
  return {
    radioTransport: RADIO_TRANSPORT,
    radioType: normalizeRadioType(RADIO_TYPE),
    radioProtocol: RADIO_PROTOCOL,
    serialMake: SERIAL_MAKE,
    serialModel: SERIAL_MODEL,
    tciHost: TCI_HOST,
    tciPort: TCI_PORT,
    rotorAzDevice: ROTOR_AZ_DEVICE,
    rotorElDevice: ROTOR_EL_DEVICE,
    catDevice: CAT_DEVICE,
    serialDevice: CAT_DEVICE,
    serialBaud: CAT_BAUD,
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
    // Host OS — used later for CAT serial device picker
    host: platform.hostInfo(),
  };
}

function applyEndpoints(ep) {
  let tciChanged = false;
  let rotorChanged = false;
  let catChanged = false;
  let flexChanged = false;
  let radioSelChanged = false;
  if (!ep || typeof ep !== "object") {
    return {
      tciChanged,
      rotorChanged,
      catChanged,
      flexChanged,
      radioSelChanged,
    };
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
    if (normalizeRadioType(RADIO_TYPE) === "smartsdr") v = "cat";
    if ((v === "cat" || v === "tci") && v !== RADIO_PROTOCOL) {
      RADIO_PROTOCOL = v;
      radioSelChanged = true;
    }
  }

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

  // Radio API (CTCSS) — host may be empty to disable
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

  return { tciChanged, rotorChanged, catChanged, flexChanged, radioSelChanged };
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
  useSerialCat,
  useIcomSerial,
  getSerialModelInfo,
  platform,
};
