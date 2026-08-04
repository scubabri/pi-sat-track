/**
 * Named station profiles (favorites + config) persisted under ~/.rpitrack/profiles.json.
 * Active profile is shared by all browsers talking to this server.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const CACHE_DIR = path.join(os.homedir(), ".rpitrack");
const PROFILES_FILE = path.join(CACHE_DIR, "profiles.json");
const DEFAULT_NAME = "default";

function emptyProfile() {
  return {
    favorites: [],
    config: {},
    lastSat: null,
    updatedAt: new Date().toISOString(),
  };
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
  }
  if (typeof p.lastSat === "string" && p.lastSat) out.lastSat = p.lastSat;
  else out.lastSat = null;
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
    p.favorites = patch.favorites
      .filter((k) => typeof k === "string" && k)
      .filter((k, i, a) => a.indexOf(k) === i)
      .slice(0, 24);
  }
  if (patch.config && typeof patch.config === "object") {
    p.config = Object.assign({}, p.config, patch.config);
  }
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
    updatedAt: p.updatedAt || null,
  };
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
  updateActive,
  publicPayload,
  PROFILES_FILE,
  DEFAULT_NAME,
};
