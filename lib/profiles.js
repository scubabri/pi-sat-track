/**
 * Named station profiles (favorites + config) persisted under ~/.rpitrack/profiles.json.
 * Active profile is shared by all browsers talking to this server.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const alertsCore = require("../js/pass-alerts-core");

const CACHE_DIR = path.join(os.homedir(), ".rpitrack");
const PROFILES_FILE = path.join(CACHE_DIR, "profiles.json");
const DEFAULT_NAME = "default";

function emptyProfile() {
  return {
    favorites: [],
    config: {},
    lastSat: null,
    // Map Favorites overlay: { on, shown } (shown null = all favorites).
    // null = never saved for this profile (client migrates its localStorage once).
    favOverlay: null,
    // Top-bar Auto Select button: at the selected sat's LOS, select the
    // favorite with the soonest AOS (lib/after-los.js).
    autoSelect: false,
    // Pass alerts (bells): { sats, passes, passExceptions, allFavorites }
    // — see js/pass-alerts-core.js.
    alerts: alertsCore.emptyAlerts(),
    updatedAt: new Date().toISOString(),
  };
}

/** { on, shown } with shown limited to (and ordered like) favorites; null stays null. */
function normalizeFavOverlay(fo, favorites) {
  if (!fo || typeof fo !== "object") return null;
  const favs = Array.isArray(favorites) ? favorites : [];
  let shown = null;
  if (Array.isArray(fo.shown)) {
    const want = new Set(fo.shown.filter((k) => typeof k === "string"));
    shown = favs.filter((k) => want.has(k));
  }
  return { on: !!fo.on, shown };
}

function defaultStore() {
  return {
    active: DEFAULT_NAME,
    profiles: {
      [DEFAULT_NAME]: emptyProfile(),
    },
  };
}

let store = defaultStore();

function ensureDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function sanitizeName(name) {
  return String(name || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .slice(0, 48);
}

function normalizeProfile(p) {
  const out = emptyProfile();
  if (!p || typeof p !== "object") return out;
  if (Array.isArray(p.favorites)) {
    out.favorites = p.favorites
      .filter((k) => typeof k === "string" && k)
      .filter((k, i, a) => a.indexOf(k) === i)
      .slice(0, 24);
  }
  if (p.config && typeof p.config === "object") {
    out.config = Object.assign({}, p.config);
    // After LOS used to offer "auto" (now the top-bar Auto Select button).
    if (out.config.rotorAfterLos === "auto") out.config.rotorAfterLos = "none";
  }
  out.autoSelect = p.autoSelect === true;
  if (typeof p.lastSat === "string" && p.lastSat) out.lastSat = p.lastSat;
  else out.lastSat = null;
  out.favOverlay = normalizeFavOverlay(p.favOverlay, out.favorites);
  out.alerts = alertsCore.normalizeAlerts(p.alerts);
  if (typeof p.updatedAt === "string") out.updatedAt = p.updatedAt;
  return out;
}

function load() {
  try {
    ensureDir();
    if (!fs.existsSync(PROFILES_FILE)) {
      store = defaultStore();
      save();
      console.log("Profiles: created", PROFILES_FILE);
      return store;
    }
    const raw = JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8"));
    if (!raw || typeof raw !== "object" || !raw.profiles) {
      throw new Error("invalid profiles file");
    }
    const profiles = {};
    Object.keys(raw.profiles).forEach((name) => {
      const n = sanitizeName(name);
      if (n) profiles[n] = normalizeProfile(raw.profiles[name]);
    });
    if (!Object.keys(profiles).length) {
      profiles[DEFAULT_NAME] = emptyProfile();
    }
    let active = sanitizeName(raw.active) || DEFAULT_NAME;
    if (!profiles[active]) active = Object.keys(profiles)[0];
    store = { active, profiles };
    console.log(
      "Profiles: loaded",
      Object.keys(profiles).length,
      "active=" + active,
    );
    return store;
  } catch (e) {
    console.warn("Profiles load failed:", e.message);
    store = defaultStore();
    try {
      save();
    } catch (_) {}
    return store;
  }
}

function save() {
  ensureDir();
  const tmp = PROFILES_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, PROFILES_FILE);
}

function listNames() {
  return Object.keys(store.profiles).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}

function getActiveName() {
  return store.active;
}

function getActive() {
  return normalizeProfile(store.profiles[store.active]);
}

function setActive(name) {
  name = sanitizeName(name);
  if (!name || !store.profiles[name]) return false;
  store.active = name;
  save();
  return true;
}

function createProfile(name, fromActive) {
  name = sanitizeName(name);
  if (!name || store.profiles[name]) return false;
  const base =
    fromActive !== false
      ? normalizeProfile(JSON.parse(JSON.stringify(getActive())))
      : emptyProfile();
  base.updatedAt = new Date().toISOString();
  store.profiles[name] = base;
  store.active = name;
  save();
  return true;
}

function deleteProfile(name) {
  name = sanitizeName(name);
  if (!name || !store.profiles[name]) return false;
  if (Object.keys(store.profiles).length <= 1) return false;
  delete store.profiles[name];
  if (store.active === name) {
    store.active = listNames()[0];
  }
  save();
  return true;
}

function renameProfile(from, to) {
  from = sanitizeName(from);
  to = sanitizeName(to);
  if (!from || !to || !store.profiles[from] || store.profiles[to]) return false;
  store.profiles[to] = store.profiles[from];
  delete store.profiles[from];
  if (store.active === from) store.active = to;
  save();
  return true;
}

function updateActive(patch) {
  const p = getActive();
  if (Array.isArray(patch.favorites)) {
    const old = p.favorites || [];
    p.favorites = patch.favorites
      .filter((k) => typeof k === "string" && k)
      .filter((k, i, a) => a.indexOf(k) === i)
      .slice(0, 24);
    // Newly added favorites start shown on the overlay; removed ones drop out.
    if (p.favOverlay && Array.isArray(p.favOverlay.shown)) {
      const added = p.favorites.filter((k) => !old.includes(k));
      p.favOverlay.shown = p.favOverlay.shown.concat(added);
    }
  }
  if (patch.favOverlay && typeof patch.favOverlay === "object") {
    const prev = p.favOverlay || { on: false, shown: null };
    p.favOverlay = {
      on: patch.favOverlay.on !== undefined ? !!patch.favOverlay.on : prev.on,
      shown: patch.favOverlay.shown !== undefined ? patch.favOverlay.shown : prev.shown,
    };
  }
  p.favOverlay = normalizeFavOverlay(p.favOverlay, p.favorites);
  if (patch.config && typeof patch.config === "object") {
    p.config = Object.assign({}, p.config, patch.config);
  }
  if (patch.alerts && typeof patch.alerts === "object") {
    p.alerts = alertsCore.normalizeAlerts(patch.alerts);
  }
  if (patch.autoSelect !== undefined) p.autoSelect = patch.autoSelect === true;
  if (patch.lastSat !== undefined) {
    p.lastSat =
      typeof patch.lastSat === "string" && patch.lastSat ? patch.lastSat : null;
  }
  p.updatedAt = new Date().toISOString();
  store.profiles[store.active] = p;
  save();
  return p;
}

function publicPayload() {
  const p = getActive();
  return {
    type: "profiles",
    active: store.active,
    names: listNames(),
    favorites: p.favorites || [],
    config: p.config || {},
    lastSat: p.lastSat || null,
    favOverlay: p.favOverlay || null,
    autoSelect: p.autoSelect === true,
    alerts: p.alerts || alertsCore.emptyAlerts(),
    updatedAt: p.updatedAt || null,
  };
}

/**
 * Drop single-pass alerts / exceptions whose LOS is over, in every profile.
 * Saves only when something changed. Returns true if the ACTIVE profile changed.
 */
function pruneAlerts(now) {
  now = now != null ? now : Date.now();
  let any = false;
  let active = false;
  Object.keys(store.profiles).forEach((name) => {
    const prof = store.profiles[name];
    if (!prof || !prof.alerts) return;
    const r = alertsCore.pruneAlerts(prof.alerts, now);
    if (!r.changed) return;
    prof.alerts = r.alerts;
    any = true;
    if (name === store.active) active = true;
  });
  if (any) save();
  return active;
}

module.exports = {
  load,
  save,
  listNames,
  getActiveName,
  getActive,
  setActive,
  createProfile,
  deleteProfile,
  renameProfile,
  sanitizeName,
  updateActive,
  publicPayload,
  normalizeFavOverlay,
  pruneAlerts,
  PROFILES_FILE,
  DEFAULT_NAME,
};
