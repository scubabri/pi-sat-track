const fs = require("fs");
const {
  CACHE_DIR,
  CATALOG_CACHE,
  STATUS_CACHE,
  CATALOG_URL,
  AMSAT_STATUS,
  DEFAULT_SAT,
} = require("./config");
const { getSatrecForNorad } = require("./tle");
const { lookAngles } = require("./orbit");

let CATALOG = {};
let catalogNote = "not loaded";
let ACTIVE = new Set();
let statusNote = "not loaded";

/**
 * Known FM CTCSS (Hz). access = talk tone; activation = timer arm (SO-50 only).
 * Keys: designator, aliases, and NORAD as "N#####".
 */
const CTCSS_OVERRIDES = {
  // SO-50 — dual tone
  "SO-50": { access: 67.0, activation: 74.4 },
  SO50: { access: 67.0, activation: 74.4 },
  N27607: { access: 67.0, activation: 74.4 },

  // ISS crossband FM repeater
  ISS: { access: 67.0 },
  "ZARYA": { access: 67.0 },
  N25544: { access: 67.0 },

  // IO-86 / LAPAN-A2
  "IO-86": { access: 88.5 },
  IO86: { access: 88.5 },
  "LAPAN-A2": { access: 88.5 },
  LAPANA2: { access: 88.5 },
  N40931: { access: 88.5 },

  // ASRTU-1
  "ASRTU-1": { access: 67.0 },
  ASRTU1: { access: 67.0 },
  N61781: { access: 67.0 },
};

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function norm(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function designator(name) {
  const m = String(name || "").match(/\b([A-Z]{1,4})[\s-]?(\d{1,3}[A-Z]?)\b/i);
  if (!m) return null;
  return (m[1] + "-" + m[2]).toUpperCase();
}

function callsignDesignator(cs) {
  if (!cs) return null;
  const s = String(cs).trim().toUpperCase();
  const m = s.match(/^([A-Z]{1,4})[\s-]?(\d{1,3}[A-Z]?)$/);
  if (m) return m[1] + "-" + m[2];
  return designator(s);
}

function makeKey(name, norad, callsign) {
  const d = designator(name) || callsignDesignator(callsign);
  if (d) return d;
  if (norad) return "N" + norad;
  return norm(name).slice(0, 16) || "UNKNOWN";
}

function betterName(a, b) {
  if (!a) return b;
  if (!b) return a;

  const da = designator(a);
  const db = designator(b);
  const aIsClean = da && norm(a) === norm(da);
  const bIsClean = db && norm(b) === norm(db);

  if (aIsClean && !bIsClean) return a;
  if (bIsClean && !aIsClean) return b;
  if (aIsClean && bIsClean) return a.length <= b.length ? a : b;

  if (da && !db) return a;
  if (db && !da) return b;

  return a.length <= b.length ? a : b;
}

function centerFreqMHz(field) {
  if (field == null || !String(field).trim()) return null;
  const s = String(field).trim();
  const primary = s.split(/[\/]/)[0].trim();

  const range = primary.match(/(\d+\.?\d*)\s*[-–]\s*(\d+\.?\d*)/);
  if (range) {
    const a = parseFloat(range[1]);
    const b = parseFloat(range[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return ((a + b) / 2).toFixed(3);
  }

  const single = primary.match(/(\d+\.\d+)/);
  if (single) return parseFloat(single[1]).toFixed(3);
  return null;
}

function isFmMode(mode) {
  if (!mode) return false;
  const m = String(mode).toUpperCase();
  // Explicit FM / narrow / digital voice that uses FM-family demod
  if (/\bFM\b|\bNFM\b|\bWFM\b/.test(m)) return true;
  if (/CTCSS|\bPL\b/.test(m)) return true;
  if (/GFSK|C4FM|DSTAR|DMR|YSF|NXDN/.test(m)) return true;
  // Packet / APRS voice-channel modes on FM sats
  if (/\bAFSK\b|\bAPRS\b/.test(m)) return true;
  // ARISS "Voice (Reg …)" entries are FM crossband
  if (/\bVOICE\b/.test(m)) return true;
  return false;
}

function isInverting(mode) {
  if (!mode) return true;
  const m = String(mode).toUpperCase();
  if (/\bFM\b|CTCSS/.test(m)) return false;
  if (/INVERT/.test(m)) return true;
  if (/\bSSB\b|\bCW\b|\bLINEAR\b|\bA\b|\bB\b/.test(m)) return true;
  return true;
}
