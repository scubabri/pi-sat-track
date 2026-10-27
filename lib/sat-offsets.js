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
      dataByMode: {},
      cwMode: false,
      flexProfile: "",
      flexProfileByMode: {},
      ulRadio: null,
      roleOff: null,
    };
  }
  return {
    ulFineOffset: clampHz(e.ulFineOffset),
    dlFineOffset: clampHz(e.dlFineOffset),
    manualDlOffset: clampHz(e.manualDlOffset),
    modeIndex: normalizeModeIndex(e.modeIndex),
    // Legacy per-sat Data flag (before per-mode): fallback for modes with no entry.
    dataMode: e.dataMode === true,
    // Data per sat + mode ("mode|uplink|downlink" -> true), e.g. ISS APRS on
    // and ISS FM voice off. Only ON is stored.
    dataByMode: normalizeFlagMap(e.dataByMode),
    cwMode: e.cwMode === true,
    flexProfile:
      typeof e.flexProfile === "string" ? e.flexProfile.trim() : "",
    flexProfileByMode: normalizeProfileMap(e.flexProfileByMode),
    // Two-radio setups: which radio (1|2) is on uplink for this sat; null =
    // the profile default (lib/radio-roles.js).
    ulRadio: normalizeUlRadio(e.ulRadio),
    // Two-radio setups: leg disabled for this sat ("ul" | "dl"), e.g. a
    // simplex digipeater on one radio; null = both legs (lib/radio-roles.js).
    roleOff: normalizeRoleOff(e.roleOff),
  };
}

function normalizeRoleOff(v) {
  return v === "ul" || v === "dl" ? v : null;
}

function normalizeUlRadio(v) {
  const n = Number(v);
  return v != null && (n === 1 || n === 2) ? n : null;
}

/** { modeKey: true } (Data per mode); anything but true dropped. */
function normalizeFlagMap(m) {
  const out = {};
  if (!m || typeof m !== "object") return out;
  for (const k of Object.keys(m)) if (k && m[k] === true) out[k] = true;
  return out;
}

/** { modeKey: profileName } with blank keys/values dropped. */
function normalizeProfileMap(m) {
  const out = {};
  if (!m || typeof m !== "object") return out;
  for (const k of Object.keys(m)) {
    const v = m[k];
    if (k && typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return out;
}

function isEmpty(e) {
  if (!e) return true;
  return (
    clampHz(e.ulFineOffset) === 0 &&
    clampHz(e.dlFineOffset) === 0 &&
    clampHz(e.manualDlOffset) === 0 &&
    e.modeIndex == null &&
    e.dataMode !== true &&
    Object.keys(normalizeFlagMap(e.dataByMode)).length === 0 &&
    e.cwMode !== true &&
    !(typeof e.flexProfile === "string" && e.flexProfile.trim()) &&
    Object.keys(normalizeProfileMap(e.flexProfileByMode)).length === 0 &&
    normalizeUlRadio(e.ulRadio) == null &&
    normalizeRoleOff(e.roleOff) == null
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
    dataByMode:
      incoming.dataByMode !== undefined
        ? incoming.dataByMode
        : prev
          ? prev.dataByMode
          : {},
    cwMode:
      incoming.cwMode !== undefined
        ? incoming.cwMode
        : prev
          ? prev.cwMode
          : false,
    flexProfile:
      incoming.flexProfile !== undefined
        ? incoming.flexProfile
        : prev
          ? prev.flexProfile
          : "",
    flexProfileByMode:
      incoming.flexProfileByMode !== undefined
        ? incoming.flexProfileByMode
        : prev
          ? prev.flexProfileByMode
          : {},
    ulRadio:
      incoming.ulRadio !== undefined
        ? incoming.ulRadio
        : prev
          ? prev.ulRadio
          : null,
    roleOff:
      incoming.roleOff !== undefined
        ? incoming.roleOff
        : prev
          ? prev.roleOff
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
    dataMode: prev.dataMode === true,
    dataByMode: normalizeFlagMap(prev.dataByMode),
    cwMode: prev.cwMode === true,
    flexProfile: typeof prev.flexProfile === "string" ? prev.flexProfile : "",
    flexProfileByMode: normalizeProfileMap(prev.flexProfileByMode),
    ulRadio: normalizeUlRadio(prev.ulRadio),
    roleOff: normalizeRoleOff(prev.roleOff),
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

/**
 * Data mode (USB-D / LSB-D / FM-D) for a sat: true/false. With modeKey (the
 * sat's active "mode|uplink|downlink"), the per-mode choice; a sat that has
 * per-mode entries is OFF for any other mode. Sats with no per-mode entries
 * fall back to the legacy per-sat flag (saved before Data was per mode).
 */
function getDataMode(satKey, modeKey) {
  if (!satKey || !store[satKey]) return false;
  const ent = store[satKey];
  if (modeKey) {
    const m = normalizeFlagMap(ent.dataByMode);
    if (m[modeKey]) return true;
    if (Object.keys(m).length) return false;
  }
  return ent.dataMode === true;
}

/** Raw per-mode Data map for a sat (copy). */
function getDataByMode(satKey) {
  if (!satKey || !store[satKey]) return {};
  return normalizeFlagMap(store[satKey].dataByMode);
}

/**
 * Save Data. With modeKey: for that sat + mode only; the legacy per-sat flag
 * is dropped at the same time (it no longer says which mode it was for).
 * Without modeKey: legacy per-sat flag.
 */
function setDataMode(satKey, on, modeKey) {
  if (!satKey || typeof satKey !== "string") return;
  const prev = store[satKey] ? normalizeEntry(store[satKey]) : normalizeEntry(null);
  let e;
  if (modeKey) {
    const map = { ...prev.dataByMode };
    if (on) map[modeKey] = true;
    else delete map[modeKey];
    e = { ...prev, dataByMode: map, dataMode: false };
  } else e = { ...prev, dataMode: !!on };
  if (isEmpty(e)) {
    if (store[satKey]) {
      delete store[satKey];
      save(satKey, "Sat offsets: cleared " + satKey);
    }
    return;
  }
  store[satKey] = e;
  save(satKey, "Sat data mode: saved " + satKey + (modeKey ? " [" + modeKey + "]" : "") + " → " + (on ? "ON" : "OFF"));
}

/** CW mode (linear sats) for a sat: true/false. */
function getCwMode(satKey) {
  if (!satKey || !store[satKey]) return false;
  return store[satKey].cwMode === true;
}

function setCwMode(satKey, on) {
  if (!satKey || typeof satKey !== "string") return;
  const prev = store[satKey] ? normalizeEntry(store[satKey]) : normalizeEntry(null);
  const e = { ...prev, cwMode: !!on };
  if (isEmpty(e)) {
    if (store[satKey]) {
      delete store[satKey];
      save(satKey, "Sat offsets: cleared " + satKey);
    }
    return;
  }
  store[satKey] = e;
  save(satKey, "Sat CW mode: saved " + satKey + " → " + (on ? "ON" : "OFF"));
}

/**
 * SmartSDR global profile name for a sat ("" = no change). With modeKey,
 * returns the per-mode profile, falling back to the legacy per-sat value.
 */
function getFlexProfile(satKey, modeKey) {
  if (!satKey || !store[satKey]) return "";
  const ent = store[satKey];
  if (modeKey) {
    const m = normalizeProfileMap(ent.flexProfileByMode);
    if (m[modeKey]) return m[modeKey];
  }
  const v = ent.flexProfile;
  return typeof v === "string" ? v.trim() : "";
}

/** Raw per-mode profile map for a sat (copy). */
function getFlexProfileByMode(satKey) {
  if (!satKey || !store[satKey]) return {};
  return normalizeProfileMap(store[satKey].flexProfileByMode);
}

/**
 * Save profile. With modeKey: stored for that sat+mode only (blank removes
 * the per-mode entry). Without modeKey: legacy per-sat value.
 */
function setFlexProfile(satKey, name, modeKey) {
  if (!satKey || typeof satKey !== "string") return;
  const prev = store[satKey] ? normalizeEntry(store[satKey]) : normalizeEntry(null);
  const next = name == null ? "" : String(name).trim();
  let e;
  if (modeKey) {
    const map = { ...prev.flexProfileByMode };
    if (next) map[modeKey] = next;
    else delete map[modeKey];
    e = { ...prev, flexProfileByMode: map };
  } else {
    e = { ...prev, flexProfile: next };
  }
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
    "Sat Flex profile: saved " +
      satKey +
      (modeKey ? " [" + modeKey + "]" : "") +
      " → " +
      (next ? JSON.stringify(next) : "(no change)"),
  );
}

/** Radio (1|2) saved on uplink for a sat, or null (= profile default). */
function getUlRadio(satKey) {
  if (!satKey) return null;
  let e = store[satKey];
  if (!e) {
    const f = find(satKey);
    return f ? f.ulRadio : null;
  }
  return normalizeUlRadio(e.ulRadio);
}

/** Save which radio is on uplink for a sat (null clears the choice). */
function setUlRadio(satKey, n) {
  if (!satKey || typeof satKey !== "string") return;
  const prev = store[satKey] ? normalizeEntry(store[satKey]) : normalizeEntry(null);
  const e = { ...prev, ulRadio: normalizeUlRadio(n) };
  if (isEmpty(e)) {
    if (store[satKey]) {
      delete store[satKey];
      save(satKey, "Sat offsets: cleared " + satKey);
    }
    return;
  }
  store[satKey] = e;
  save(satKey, "Sat radio roles: saved " + satKey + " \u2192 UL Radio " + (e.ulRadio || "default"));
}

/** Leg ("ul" | "dl") disabled for a sat, or null (both legs). */
function getRoleOff(satKey) {
  if (!satKey) return null;
  const e = store[satKey];
  if (!e) {
    const f = find(satKey);
    return f ? f.roleOff : null;
  }
  return normalizeRoleOff(e.roleOff);
}

/** Save which leg is disabled for a sat (null = both legs on). */
function setRoleOff(satKey, off) {
  if (!satKey || typeof satKey !== "string") return;
  const prev = store[satKey] ? normalizeEntry(store[satKey]) : normalizeEntry(null);
  const e = { ...prev, roleOff: normalizeRoleOff(off) };
  if (isEmpty(e)) {
    if (store[satKey]) {
      delete store[satKey];
      save(satKey, "Sat offsets: cleared " + satKey);
    }
    return;
  }
  store[satKey] = e;
  save(satKey, "Sat radio roles: saved " + satKey + " \u2192 " + (e.roleOff ? e.roleOff.toUpperCase() + " disabled" : "both legs"));
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
  getDataByMode,
  setDataMode,
  getCwMode,
  setCwMode,
  getFlexProfile,
  setFlexProfile,
  getFlexProfileByMode,
  getUlRadio,
  setUlRadio,
  getRoleOff,
  setRoleOff,
  clear,
  flush,
  setProfile,
  getProfile,
  renameProfile,
  profileKey,
  OFFSETS_FILE,
};
