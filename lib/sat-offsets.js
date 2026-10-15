/**
 * Per-satellite UL/DL fine offsets, dial-absorb manual DL, and last mode index.
 * Persisted under ~/.rpitrack/sat-offsets.json so a later load of the
 * same sat restores the operator's last calibration and mode selection.
 *
 * Offsets are kept PER PROFILE (Flex vs IC-9700 setups calibrate differently):
 *   { "version": 2, "global": { <sat>: entry }, "profiles": { <name>: { <sat>: entry } } }
 * "global" holds the legacy (pre-profile) flat map. The first time a profile is
 * activated without its own map, the legacy global map is copied into it once.
 * A v1 flat file ({ <sat>: entry }) is read as the legacy global map.
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
/** Legacy (pre-profile) flat map; seed for profiles that have no map yet. */
let globalStore = {};
/** profile name -> sat map. `store` is profiles[activeProfile]. */
let profiles = {};
let activeProfile = "default";

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
      dataMode: false,
    };
  }
  return {
    ulFineOffset: clampHz(e.ulFineOffset),
    dlFineOffset: clampHz(e.dlFineOffset),
    manualDlOffset: clampHz(e.manualDlOffset),
    modeIndex: normalizeModeIndex(e.modeIndex),
    dataMode: e.dataMode === true,
  };
}

function isEmpty(e) {
  if (!e) return true;
  return (
    clampHz(e.ulFineOffset) === 0 &&
    clampHz(e.dlFineOffset) === 0 &&
    clampHz(e.manualDlOffset) === 0 &&
    e.modeIndex == null &&
    e.dataMode !== true
  );
}

function normalizeMap(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  Object.keys(raw).forEach((key) => {
    if (!key || typeof key !== "string") return;
    const e = normalizeEntry(raw[key]);
    if (!isEmpty(e)) out[key] = e;
  });
  return out;
}

function cloneMap(m) {
  const out = {};
  Object.keys(m || {}).forEach((k) => {
    out[k] = normalizeEntry(m[k]);
  });
  return out;
}

/** Point `store` at a profile's map; seed it once from the legacy global map. */
function selectProfile(name) {
  activeProfile = name || "default";
  if (!profiles[activeProfile]) {
    const seed = cloneMap(globalStore);
    profiles[activeProfile] = seed;
    if (Object.keys(seed).length) {
      console.log(
        "Sat offsets: seeded profile",
        JSON.stringify(activeProfile),
        "with",
        Object.keys(seed).length,
        "legacy global sat(s)",
      );
      save(null, null, true);
    }
  }
  store = profiles[activeProfile];
}

/**
 * Switch the active profile (flushes pending writes for the previous one).
 * Returns true if the profile actually changed.
 */
/** Same rules as lib/profiles.js sanitizeName (trim, strip reserved chars, 48 max). */
function profileKey(name) {
  return (
    String(name || "")
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
      .slice(0, 48) || "default"
  );
}

function setProfile(name) {
  name = profileKey(name);
  if (name === activeProfile && profiles[name] === store) return false;
  flush();
  const prev = activeProfile;
  selectProfile(name);
  console.log(
    "Sat offsets: profile " + JSON.stringify(prev) + " → " + JSON.stringify(name) +
      " (" + Object.keys(store).length + " sat(s))",
  );
  return true;
}

function getProfile() {
  return activeProfile;
}

/** Move a profile's offsets to a new name (profile rename). */
function renameProfile(from, to) {
  from = profileKey(from);
  to = profileKey(to);
  if (!from || !to || from === to || !profiles[from]) return;
  profiles[to] = profiles[from];
  delete profiles[from];
  if (activeProfile === from) activeProfile = to;
  store = profiles[activeProfile] || store;
  save(null, null, true);
}

function load() {
  try {
    ensureDir();
    globalStore = {};
    profiles = {};
    if (fs.existsSync(OFFSETS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(OFFSETS_FILE, "utf8"));
      if (raw && typeof raw === "object" && raw.version === 2) {
        globalStore = normalizeMap(raw.global);
        const rp = raw.profiles && typeof raw.profiles === "object" ? raw.profiles : {};
        Object.keys(rp).forEach((name) => {
          if (name) profiles[name] = normalizeMap(rp[name]);
        });
      } else {
        globalStore = normalizeMap(raw); // v1 flat file → legacy global
      }
    }
    if (profiles[activeProfile]) store = profiles[activeProfile];
    else store = cloneMap(globalStore); // provisional until setProfile() seeds
    console.log(
      "Sat offsets: loaded",
      Object.keys(store).length,
      "sat(s) for profile",
      JSON.stringify(activeProfile) +
        (profiles[activeProfile] === store ? "" : " (provisional until profiles load)"),
      "from",
      OFFSETS_FILE,
    );
  } catch (e) {
    console.warn("Sat offsets load failed:", e.message);
    globalStore = {};
    profiles = {};
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
function save(satKey, logLine, force) {
  // A provisional store (load() before setProfile()) becomes the active
  // profile's map on its first write.
  if (satKey && profiles[activeProfile] !== store) profiles[activeProfile] = store;
  if (satKey) pendingLog.set(satKey, logLine || null);
  else if (force) pendingLog.set("\u0000structural", null);
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
    fs.writeFileSync(OFFSETS_FILE, JSON.stringify({ version: 2, global: globalStore, profiles }, null, 2));
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
    dataMode:
      incoming.dataMode !== undefined
        ? incoming.dataMode
        : prev
          ? prev.dataMode
          : false,
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
    dataMode: prev.dataMode === true,
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

/** Data mode (USB-D/LSB-D) for a sat: true/false. */
function getDataMode(satKey) {
  if (!satKey || !store[satKey]) return false;
  return store[satKey].dataMode === true;
}

function setDataMode(satKey, on) {
  if (!satKey || typeof satKey !== "string") return;
  const prev = store[satKey] ? normalizeEntry(store[satKey]) : normalizeEntry(null);
  const e = { ...prev, dataMode: !!on };
  if (isEmpty(e)) {
    if (store[satKey]) {
      delete store[satKey];
      save(satKey, "Sat offsets: cleared " + satKey);
    }
    return;
  }
  store[satKey] = e;
  save(satKey, "Sat data mode: saved " + satKey + " → " + (on ? "ON" : "OFF"));
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
  getDataMode,
  setDataMode,
  clear,
  flush,
  setProfile,
  getProfile,
  renameProfile,
  profileKey,
  OFFSETS_FILE,
};
