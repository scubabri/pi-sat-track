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

/** Debounce: write this long after the last change (fine-tune steps are bursty). */
const SAVE_DEBOUNCE_MS = 1000;
let saveTimer = null;
/** satKey -> log line describing the latest pending change */
let pendingLog = new Map();

/** Schedule a debounced write; in-memory store is already updated. */
function save(satKey, logLine) {
  if (satKey) pendingLog.set(satKey, logLine || null);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, SAVE_DEBOUNCE_MS);
  if (saveTimer.unref) saveTimer.unref();
}

/** Write pending changes now (sat switch, shutdown). No-op when nothing pending. */
function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!pendingLog.size) return;
  const logs = pendingLog;
  pendingLog = new Map();
  writeNow();
  for (const [, line] of logs) if (line) console.log(line);
}

process.on("exit", flush);

function writeNow() {
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

/** Canonical form for tolerant key matching ("RS-44" ~ "RS44" ~ "rs 44"). */
function canon(k) {
  return String(k || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** get() with a fallback to an entry whose key differs only in punctuation/case. */
function find(satKey) {
  const exact = get(satKey);
  if (exact) return exact;
  const c = canon(satKey);
  if (!c) return null;
  for (const k of Object.keys(store)) {
    if (k !== satKey && canon(k) === c && !isEmpty(store[k])) {
      return normalizeEntry(store[k]);
    }
  }
  return null;
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
      save(satKey, "Sat offsets: cleared " + satKey);
    }
    return;
  }
  store[satKey] = e;
  save(
    satKey,
    "Sat offsets: saved " + satKey +
      " UL " + e.ulFineOffset +
      " DL " + e.dlFineOffset +
      " manual " + e.manualDlOffset + " Hz" +
      (e.modeIndex != null ? " mode " + e.modeIndex : ""),
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
      save(satKey, "Sat offsets: cleared " + satKey);
    }
    return;
  }
  store[satKey] = e;
  save(satKey, "Sat mode: saved " + satKey + " → " + idx);
}

function clear(satKey) {
  if (!satKey) return;
  if (store[satKey]) {
    delete store[satKey];
    save(satKey, "Sat offsets: cleared " + satKey);
  }
}

module.exports = {
  load,
  get,
  find,
  set,
  getModeIndex,
  setModeIndex,
  clear,
  flush,
  OFFSETS_FILE,
};
