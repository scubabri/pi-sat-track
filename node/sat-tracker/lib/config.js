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

const TCI_HOST = process.env.TCI_HOST || "172.17.18.178";
const TCI_PORT = parseInt(process.env.TCI_PORT || "50001", 10);
const TCI_URI = "ws://" + TCI_HOST + ":" + TCI_PORT;

const ROTOR_AZ_HOST = process.env.ROTOR_AZ_HOST || "127.0.0.1";
const ROTOR_AZ_PORT = parseInt(process.env.ROTOR_AZ_PORT || "4535", 10);
const ROTOR_EL_HOST = process.env.ROTOR_EL_HOST || "127.0.0.1";
const ROTOR_EL_PORT = parseInt(process.env.ROTOR_EL_PORT || "4536", 10);
const ROTOR_MIN_EL = parseFloat(process.env.ROTOR_MIN_EL || "10");
const ROTOR_PARK_EL = parseFloat(process.env.ROTOR_PARK_EL || "0");
const ROTOR_MOVE_INTERVAL_MS = parseInt(
  process.env.ROTOR_MOVE_INTERVAL_MS || "1000",
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

module.exports = {
  ROOT,
  CACHE_DIR,
  CATALOG_CACHE,
  STATUS_CACHE,
  PORT,
  CATALOG_URL,
  AMSAT_STATUS,
  TCI_HOST,
  TCI_PORT,
  TCI_URI,
  ROTOR_AZ_HOST,
  ROTOR_AZ_PORT,
  ROTOR_EL_HOST,
  ROTOR_EL_PORT,
  ROTOR_MIN_EL,
  ROTOR_PARK_EL,
  ROTOR_MOVE_INTERVAL_MS,
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
};
