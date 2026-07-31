const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const CACHE_DIR = path.join(os.homedir(), ".rpitrack");
const CATALOG_CACHE = path.join(CACHE_DIR, "amsat_catalog.json");
const STATUS_CACHE = path.join(CACHE_DIR, "amsat_status.json");

const PORT = 3000;

const CATALOG_URL =
  "https://raw.githubusercontent.com/palewire/amateur-satellite-database/main/data/amsat-all-frequencies.json";
const AMSAT_STATUS = "https://www.amsat.org/status/";

// Mutable endpoints (defaults; overridden by client Station Configuration)
let TCI_HOST = process.env.TCI_HOST || "127.0.0.1";
let TCI_PORT = parseInt(process.env.TCI_PORT || "50001", 10);

// Direct RT-21 serial (no rotctld)
// Confirmed mapping: AZ = ttyUSB0, EL = ttyUSB1
let ROTOR_AZ_DEVICE = process.env.ROTOR_AZ_DEVICE || "/dev/ttyUSB0";
let ROTOR_EL_DEVICE = process.env.ROTOR_EL_DEVICE || "/dev/ttyUSB1";
const ROTOR_BAUD = parseInt(process.env.ROTOR_BAUD || "4800", 10);

// Legacy rotctld fields kept so old UI payloads don't crash; unused by driver
let ROTOR_AZ_HOST = process.env.ROTOR_AZ_HOST || "127.0.0.1";
let ROTOR_AZ_PORT = parseInt(process.env.ROTOR_AZ_PORT || "4535", 10);
let ROTOR_EL_HOST =
  process.env.ROTOR_EL_HOST || process.env.ROTOR_AZ_HOST || "127.0.0.1";
let ROTOR_EL_PORT = parseInt(process.env.ROTOR_EL_PORT || "4536", 10);

const ROTOR_MIN_EL = parseFloat(process.env.ROTOR_MIN_EL || "10");
const ROTOR_PARK_EL = parseFloat(
  process.env.ROTOR_PARK_EL || String(ROTOR_MIN_EL),
);

// Tracking gate (from RT-21 direct testing)
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

// Angular leapfrog: command this many degrees ahead along-track (0 = off)
const ROTOR_LEAD_DEG = parseFloat(process.env.ROTOR_LEAD_DEG || "4");

// IC-705 CI-V CAT (USB serial)
let CAT_DEVICE = process.env.CAT_DEVICE || "/dev/ttyACM0";
const CAT_BAUD = parseInt(process.env.CAT_BAUD || "19200", 10);
const CAT_CIV_ADDR = parseInt(process.env.CAT_CIV_ADDR || "0xA4", 16);

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

function getEndpoints() {
  return {
    tciHost: TCI_HOST,
    tciPort: TCI_PORT,
    rotorAzDevice: ROTOR_AZ_DEVICE,
    rotorElDevice: ROTOR_EL_DEVICE,
    catDevice: CAT_DEVICE,
    // legacy fields for older UI
    rotorHost: ROTOR_AZ_HOST,
    rotorAzPort: ROTOR_AZ_PORT,
    rotorElPort: ROTOR_EL_PORT,
  };
}

function applyEndpoints(ep) {
  let tciChanged = false;
  let rotorChanged = false;
  let catChanged = false;
  if (!ep || typeof ep !== "object") {
    return { tciChanged, rotorChanged, catChanged };
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

  if (typeof ep.catDevice === "string" && ep.catDevice.trim()) {
    const d = ep.catDevice.trim();
    if (d !== CAT_DEVICE) {
      CAT_DEVICE = d;
      catChanged = true;
    }
  }

  // Legacy host/port (ignored by serial driver, stored for UI compatibility)
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

  return { tciChanged, rotorChanged, catChanged };
}

module.exports = {
  ROOT,
  CACHE_DIR,
  CATALOG_CACHE,
  STATUS_CACHE,
  PORT,
  CATALOG_URL,
  AMSAT_STATUS,
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
  CAT_BAUD,
  CAT_CIV_ADDR,
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
};
