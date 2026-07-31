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

let ROTOR_AZ_HOST = process.env.ROTOR_AZ_HOST || "127.0.0.1";
let ROTOR_AZ_PORT = parseInt(process.env.ROTOR_AZ_PORT || "4535", 10);
let ROTOR_EL_HOST =
  process.env.ROTOR_EL_HOST || process.env.ROTOR_AZ_HOST || "127.0.0.1";
let ROTOR_EL_PORT = parseInt(process.env.ROTOR_EL_PORT || "4536", 10);

// Match Python: MIN_EL = 10, park at same elevation when below horizon
const ROTOR_MIN_EL = parseFloat(process.env.ROTOR_MIN_EL || "10");
const ROTOR_PARK_EL = parseFloat(
  process.env.ROTOR_PARK_EL || String(ROTOR_MIN_EL),
);

// Match Python: fixed 30 s between rotor commands
const ROTOR_MOVE_INTERVAL_MS = parseInt(
  process.env.ROTOR_MOVE_INTERVAL_MS || "30000",
  10,
);

// Match Python: no lead — command the current satellite position
const ROTOR_LEAD_DEG = parseFloat(process.env.ROTOR_LEAD_DEG || "0");

// Position poll interval (Python never polled; keep this slow so it
// does not interrupt set_pos on the RT-21)
const ROTOR_POLL_INTERVAL_MS = parseInt(
  process.env.ROTOR_POLL_INTERVAL_MS || "5000",
  10,
);

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
    rotorHost: ROTOR_AZ_HOST,
    rotorAzPort: ROTOR_AZ_PORT,
    rotorElPort: ROTOR_EL_PORT,
  };
}

function applyEndpoints(ep) {
  let tciChanged = false;
  let rotorChanged = false;
  if (!ep || typeof ep !== "object") return { tciChanged, rotorChanged };

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

  if (typeof ep.rotorHost === "string" && ep.rotorHost.trim()) {
    const h = ep.rotorHost.trim();
    if (h !== ROTOR_AZ_HOST || h !== ROTOR_EL_HOST) {
      ROTOR_AZ_HOST = h;
      ROTOR_EL_HOST = h;
      rotorChanged = true;
    }
  }
  if (ep.rotorAzPort != null && Number.isFinite(Number(ep.rotorAzPort))) {
    const p = parseInt(ep.rotorAzPort, 10);
    if (p > 0 && p < 65536 && p !== ROTOR_AZ_PORT) {
      ROTOR_AZ_PORT = p;
      rotorChanged = true;
    }
  }
  if (ep.rotorElPort != null && Number.isFinite(Number(ep.rotorElPort))) {
    const p = parseInt(ep.rotorElPort, 10);
    if (p > 0 && p < 65536 && p !== ROTOR_EL_PORT) {
      ROTOR_EL_PORT = p;
      rotorChanged = true;
    }
  }

  return { tciChanged, rotorChanged };
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
  ROTOR_MOVE_INTERVAL_MS,
  ROTOR_LEAD_DEG,
  ROTOR_POLL_INTERVAL_MS,
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
