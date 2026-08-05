/**
 * Per-satellite UL/DL fine offsets, dial-absorb manual DL, and last mode index.
 * Persisted under ~/.rpitrack/sat-offsets.json so a later load of the
 * same sat restores the operator's last calibration and mode selection.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const CACHE_DIR = path.join(os.homedir(), ".rpitrack");
const OFFSETS_FILE = path.join(CACHE_DIR, "sat-offsets.json");

/**
 * @type {Record<string, {
 *   ulFineOffset: number,
 *   dlFineOffset: number,
 *   manualDlOffset: number,
 *   modeIndex: number|null
 * }>}
 */
let store = {};

function ensureDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function clampHz(n) {
  if (n == null || !Number.isFinite(n)) return 0;
  const v = Math.round(n);
  if (Math.abs(v) > 500000) return 0;
  return v;
}

function normalizeModeIndex(v) {
  if (v == null || v === "") return null;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function normalizeEntry(e) {
  if (!e || typeof e !== "object") {
    return {
      ulFineOffset: 0,
      dlFineOffset: 0,
      manualDlOffset: 0,
      modeIndex: null,
    };
  }
  return {
    ulFineOffset: clampHz(e.ulFineOffset),
    dlFineOffset: clampHz(e.dlFineOffset),
    manualDlOffset: clampHz(e.manualDlOffset),
    modeIndex: normalizeModeIndex(e.modeIndex),
  };
}

function isEmpty(e) {
  if (!e) return true;
  return (
    clampHz(e.ulFineOffset) === 0 &&
    clampHz(e.dlFineOffset) === 0 &&
    clampHz(e.manualDlOffset) === 0 &&
    e.modeIndex == null
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
        if (!isEmpty(e)) store[key] = e;
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
  if (!e || isEmpty(e)) return null;
  return normalizeEntry(e);
}

/**
 * Save offsets for a sat. Preserves existing modeIndex unless offsets.modeIndex
 * is explicitly provided. Passing all-zero offsets with no mode clears the entry
 * only when mode is also absent.
 */
function set(satKey, offsets) {
  if (!satKey || typeof satKey !== "string") return;
  const prev = store[satKey] ? normalizeEntry(store[satKey]) : null;
  const incoming = offsets && typeof offsets === "object" ? offsets : {};
  const e = normalizeEntry({
    ulFineOffset: incoming.ulFineOffset,
    dlFineOffset: incoming.dlFineOffset,
    manualDlOffset: incoming.manualDlOffset,
    // Keep previous mode unless caller sets modeIndex (including null to clear)
    modeIndex:
      incoming.modeIndex !== undefined
        ? incoming.modeIndex
        : prev
          ? prev.modeIndex
          : null,
  });
  if (isEmpty(e)) {
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
    e.modeIndex != null ? "mode " + e.modeIndex : "",
  );
}

/** Last selected mode index for a sat (or null). */
function getModeIndex(satKey) {
  if (!satKey) return null;
  const e = store[satKey];
  if (!e) return null;
  return normalizeModeIndex(e.modeIndex);
}

/** Persist mode selection for a sat. */
function setModeIndex(satKey, modeIndex) {
  if (!satKey || typeof satKey !== "string") return;
  const prev = store[satKey]
    ? normalizeEntry(store[satKey])
    : {
        ulFineOffset: 0,
        dlFineOffset: 0,
        manualDlOffset: 0,
        modeIndex: null,
      };
  const idx = normalizeModeIndex(modeIndex);
  const e = {
    ulFineOffset: prev.ulFineOffset,
    dlFineOffset: prev.dlFineOffset,
    manualDlOffset: prev.manualDlOffset,
    modeIndex: idx,
  };
  if (isEmpty(e)) {
    if (store[satKey]) {
      delete store[satKey];
      save();
    }
    return;
  }
  store[satKey] = e;
  save();
  console.log("Sat mode: saved", satKey, "→", idx);
}

function clear(satKey) {
  if (!satKey) return;
  if (store[satKey]) {
    delete store[satKey];
    save();
    console.log("Sat offsets: cleared", satKey);
  }
}

module.exports = {
  load,
  get,
  set,
  getModeIndex,
  setModeIndex,
  clear,
  OFFSETS_FILE,
};
