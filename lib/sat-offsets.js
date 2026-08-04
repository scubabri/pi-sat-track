/**
 * Per-satellite UL/DL fine offsets (and dial-absorb manual DL).
 * Persisted under ~/.rpitrack/sat-offsets.json so a later load of the
 * same sat restores the operator's last calibration.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const CACHE_DIR = path.join(os.homedir(), ".rpitrack");
const OFFSETS_FILE = path.join(CACHE_DIR, "sat-offsets.json");

/** @type {Record<string, { ulFineOffset: number, dlFineOffset: number, manualDlOffset: number }>} */
let store = {};

function ensureDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function clampHz(n) {
  if (n == null || !Number.isFinite(n)) return 0;
  const v = Math.round(n);
  // Guard against absurd values (e.g. absorb race)
  if (Math.abs(v) > 500000) return 0;
  return v;
}

function normalizeEntry(e) {
  if (!e || typeof e !== "object") {
    return { ulFineOffset: 0, dlFineOffset: 0, manualDlOffset: 0 };
  }
  return {
    ulFineOffset: clampHz(e.ulFineOffset),
    dlFineOffset: clampHz(e.dlFineOffset),
    manualDlOffset: clampHz(e.manualDlOffset),
  };
}

function isZero(e) {
  return (
    !e ||
    (clampHz(e.ulFineOffset) === 0 &&
      clampHz(e.dlFineOffset) === 0 &&
      clampHz(e.manualDlOffset) === 0)
  );
}

function load() {
  try {
    ensureDir();
    if (!fs.existsSync(OFFSETS_FILE)) {
      store = {};
      return store;
    }
    const raw = JSON.parse(fs.readFileSync(OFFSETS_FILE, "utf8"));
    store = {};
    if (raw && typeof raw === "object") {
      Object.keys(raw).forEach((key) => {
        if (!key || typeof key !== "string") return;
        const e = normalizeEntry(raw[key]);
        if (!isZero(e)) store[key] = e;
      });
    }
    console.log(
      "Sat offsets: loaded",
      Object.keys(store).length,
      "sat(s) from",
      OFFSETS_FILE,
    );
  } catch (e) {
    console.warn("Sat offsets load failed:", e.message);
    store = {};
  }
  return store;
}

function save() {
  try {
    ensureDir();
    fs.writeFileSync(OFFSETS_FILE, JSON.stringify(store, null, 2));
  } catch (e) {
    console.warn("Sat offsets save failed:", e.message);
  }
}

function get(satKey) {
  if (!satKey) return null;
  const e = store[satKey];
  if (!e || isZero(e)) return null;
  return normalizeEntry(e);
}

/**
 * Save offsets for a sat. Passing all-zero (or null) removes the entry.
 */
function set(satKey, offsets) {
  if (!satKey || typeof satKey !== "string") return;
  const e = normalizeEntry(offsets);
  if (isZero(e)) {
    if (store[satKey]) {
      delete store[satKey];
      save();
      console.log("Sat offsets: cleared", satKey);
    }
    return;
  }
  store[satKey] = e;
  save();
  console.log(
    "Sat offsets: saved",
    satKey,
    "UL",
    e.ulFineOffset,
    "DL",
    e.dlFineOffset,
    "manual",
    e.manualDlOffset,
    "Hz",
  );
}

function clear(satKey) {
  set(satKey, null);
}

module.exports = {
  load,
  get,
  set,
  clear,
  OFFSETS_FILE,
};
