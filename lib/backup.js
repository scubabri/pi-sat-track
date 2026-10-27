/**
 * Settings backup / restore (Configure → Station → Backup & restore).
 *
 * What is user config (backed up) under ~/.rpitrack:
 *   profiles.json     every station profile: callsign / grid / units, radios,
 *                     rotor, logging (ADIF / UDP), WSJT-X listener, KISS / APRS
 *                     connections, favorites, bells (pass alerts), Auto Select /
 *                     Auto Engage, map Favorites overlay, active profile
 *   sat-offsets.json  per profile + sat: UL / DL fine offsets, mode, Data / CW,
 *                     Flex profile, UL radio, roles (tuning the user did)
 *   ul-fixed.json     per sat + mode "Fix UL" choice
 *   tle-sources.json  enabled TLE sources and their order
 * Not backed up (caches / logs / data, rebuilt or not settings): tle_*.txt,
 * amsat_*.json, rotor / server logs, aprs/ packet logs + digipeats, the ADIF
 * log itself, worked.json, version, backups/.
 *
 * File: { format: "pi-sat-track-backup", version: 1, appVersion, created,
 *         server: { profiles, satOffsets, ulFixed, tleSources }, browser: {k: v} }
 * A server key that is null = that file did not exist (restore removes it);
 * a missing key = leave the current file alone.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const profilesLib = require("./profiles");

const FORMAT = "pi-sat-track-backup";
const VERSION = 1;
const FILES = {
  profiles: "profiles.json",
  satOffsets: "sat-offsets.json",
  ulFixed: "ul-fixed.json",
  tleSources: "tle-sources.json",
};
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PROFILES = 200;
const MAX_BROWSER_KEYS = 500;
const MAX_BROWSER_VALUE = 256 * 1024;
const KEEP_SAFETY_COPIES = 20;
const BACKUP_DIR = "backups";

/** Browser localStorage keys that are caches of server state, history or big data: never in a backup. */
const BROWSER_EXCLUDE = [
  "satTrackerConfig", // client copy of the active profile's config (server is the source)
  "satTrackerProfileName", // cache of the active profile name
  "satTrackerAlerts", // startup cache of bells (server)
  "satTrackerAutoEngagePasses", // startup cache (server)
  "satTrackerFavorites", // legacy copy of favorites (server profiles hold them)
  "aprsHistory", // sent-message history, not a setting
];

function defaultDir() {
  return path.join(os.homedir(), ".rpitrack");
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Server part of a backup: the config files as parsed JSON (null = file absent). */
function buildServer(dir) {
  const d = dir || defaultDir();
  const out = {};
  for (const [k, f] of Object.entries(FILES)) {
    try {
      out[k] = readJson(path.join(d, f));
    } catch (e) {
      throw new Error("cannot read " + f + ": " + e.message);
    }
  }
  return out;
}

function buildBackup(opts) {
  const o = opts || {};
  return {
    format: FORMAT,
    version: VERSION,
    appVersion: o.appVersion || "",
    created: (o.now ? new Date(o.now) : new Date()).toISOString(),
    server: buildServer(o.dir),
    browser: o.browser && typeof o.browser === "object" ? o.browser : {},
  };
}

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);

/** Keep only plain string settings, excluding caches; drops oversized values. */
function cleanBrowser(b) {
  const out = {};
  if (!isObj(b)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(b)) {
    if (typeof k !== "string" || !k || k.length > 200 || BROWSER_EXCLUDE.includes(k)) continue;
    if (typeof v !== "string" || v.length > MAX_BROWSER_VALUE) continue;
    out[k] = v;
    if (++n >= MAX_BROWSER_KEYS) break;
  }
  return out;
}

/**
 * Validate a parsed backup (or a JSON string). Returns
 * { ok, error?, summary?, normalized? } — normalized is what restore writes.
 */
function validate(input) {
  let b = input;
  if (typeof b === "string") {
    if (b.length > MAX_BYTES) return { ok: false, error: "File is too large to be a pi-sat-track backup." };
    try {
      b = JSON.parse(b);
    } catch (_) {
      return { ok: false, error: "Not a JSON file." };
    }
  }
  const bad = (m) => ({ ok: false, error: m });
  if (!isObj(b)) return bad("Not a pi-sat-track backup (not a JSON object).");
  if (b.format !== FORMAT) return bad('Not a pi-sat-track backup (format is not "' + FORMAT + '").');
  if (!Number.isInteger(b.version)) return bad("Backup has no valid version number.");
  if (b.version > VERSION) return bad("Backup version " + b.version + " is newer than this app understands (" + VERSION + "). Update pi-sat-track first.");
  if (b.version < 1) return bad("Unknown backup version " + b.version + ".");
  if (!isObj(b.server)) return bad("Backup has no server settings section.");
  const s = b.server;

  // profiles (required)
  const p = s.profiles;
  if (!isObj(p) || !isObj(p.profiles)) return bad("Backup has no station profiles.");
  const names = Object.keys(p.profiles);
  if (!names.length) return bad("Backup has no station profiles.");
  if (names.length > MAX_PROFILES) return bad("Backup has too many profiles (" + names.length + ").");
  const profs = {};
  for (const name of names) {
    const n = profilesLib.sanitizeName(name);
    if (!n) return bad("Backup has a profile with an invalid name: " + JSON.stringify(name));
    if (!isObj(p.profiles[name])) return bad("Profile " + JSON.stringify(name) + " is not an object.");
    const cfg = p.profiles[name].config;
    if (cfg != null && !isObj(cfg)) return bad("Profile " + JSON.stringify(name) + " has an invalid config.");
    if (p.profiles[name].favorites != null && !Array.isArray(p.profiles[name].favorites))
      return bad("Profile " + JSON.stringify(name) + " has invalid favorites.");
    profs[n] = profilesLib.normalizeProfile(p.profiles[name]);
  }
  let active = profilesLib.sanitizeName(p.active);
  if (!active || !profs[active]) active = Object.keys(profs)[0];

  const norm = { profiles: { active, profiles: profs } };
  // optional files: missing key = untouched, null = remove
  if ("satOffsets" in s) {
    if (s.satOffsets !== null && !isObj(s.satOffsets)) return bad("Backup has invalid satellite offsets.");
    norm.satOffsets = s.satOffsets;
  }
  if ("ulFixed" in s) {
    if (s.ulFixed !== null && !isObj(s.ulFixed)) return bad("Backup has invalid Fix UL settings.");
    norm.ulFixed = s.ulFixed === null ? null : Object.fromEntries(Object.entries(s.ulFixed).filter(([, v]) => typeof v === "boolean"));
  }
  if ("tleSources" in s) {
    const t = s.tleSources;
    if (t !== null && (!isObj(t) || !Array.isArray(t.sources) || !t.sources.every((x) => typeof x === "string")))
      return bad("Backup has invalid TLE sources.");
    norm.tleSources = t === null ? null : { sources: t.sources.slice(0, 20) };
  }
  if (b.browser != null && !isObj(b.browser)) return bad("Backup has an invalid browser section.");
  const browser = cleanBrowser(b.browser);

  const offsetsSats = (() => {
    const o = norm.satOffsets;
    if (!isObj(o)) return 0;
    const pr = isObj(o.profiles) ? o.profiles : {};
    const set = new Set();
    for (const m of Object.values(pr)) if (isObj(m)) Object.keys(m).forEach((k) => set.add(k));
    return set.size;
  })();
  const summary = {
    appVersion: typeof b.appVersion === "string" ? b.appVersion.slice(0, 80) : "",
    created: typeof b.created === "string" ? b.created.slice(0, 40) : "",
    profileNames: Object.keys(profs),
    activeProfile: active,
    favorites: Object.values(profs).reduce((n, x) => n + x.favorites.length, 0),
    offsetSats: offsetsSats,
    ulFixed: norm.ulFixed ? Object.keys(norm.ulFixed).length : 0,
    tleSources: norm.tleSources ? norm.tleSources.sources : null,
    browserKeys: Object.keys(browser).length,
  };
  return { ok: true, summary, normalized: norm, browser };
}

function writeAtomic(file, text) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

function stamp(now) {
  const d = now ? new Date(now) : new Date();
  return d.toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
}

/** Keep the newest KEEP_SAFETY_COPIES pre-restore copies. */
function pruneSafetyCopies(bdir, keep) {
  try {
    const files = fs.readdirSync(bdir).filter((f) => /^pre-restore-.*\.json$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(bdir, f));
  } catch (_) {}
}

/**
 * Restore: validate, save a safety copy of the current config (itself a valid
 * backup file) to <dir>/backups/pre-restore-<ts>.json, then write the files.
 * Caller reloads the running config. Returns { ok, error?, summary, safetyCopy }.
 */
function restore(input, opts) {
  const o = opts || {};
  const dir = o.dir || defaultDir();
  const v = validate(input);
  if (!v.ok) return v;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const bdir = path.join(dir, BACKUP_DIR);
  if (!fs.existsSync(bdir)) fs.mkdirSync(bdir, { recursive: true });
  let safetyCopy;
  try {
    const cur = buildBackup({ dir, appVersion: o.appVersion, now: o.now });
    safetyCopy = path.join(bdir, "pre-restore-" + stamp(o.now) + ".json");
    writeAtomic(safetyCopy, JSON.stringify(cur, null, 2) + "\n");
  } catch (e) {
    return { ok: false, error: "Could not save a safety copy of the current settings (" + e.message + "); nothing was changed." };
  }
  const n = v.normalized;
  writeAtomic(path.join(dir, FILES.profiles), JSON.stringify(n.profiles, null, 2) + "\n");
  for (const k of ["satOffsets", "ulFixed", "tleSources"]) {
    if (!(k in n)) continue;
    const f = path.join(dir, FILES[k]);
    if (n[k] === null) {
      try { fs.unlinkSync(f); } catch (_) {}
    } else writeAtomic(f, JSON.stringify(n[k], null, 2) + "\n");
  }
  pruneSafetyCopies(bdir, o.keep || KEEP_SAFETY_COPIES);
  return { ok: true, summary: v.summary, safetyCopy, browser: v.browser, normalized: n };
}

module.exports = {
  FORMAT,
  VERSION,
  FILES,
  MAX_BYTES,
  BROWSER_EXCLUDE,
  buildServer,
  buildBackup,
  validate,
  restore,
  cleanBrowser,
};
