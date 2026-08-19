const fs = require("fs");
const path = require("path");
const satellite = require("satellite.js");
const { CACHE_DIR } = require("./config");

const satrecCache = new Map();
const orbitCache = new Map();

const UA = "sat-tracker/0.1";
const CELESTRAK_TIMEOUT_MS = 15000;
const FALLBACK_TIMEOUT_MS = 20000;

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function parseOrbitFromL2(l2) {
  try {
    const revField = String(l2).substring(63, 68).trim();
    const n = parseInt(revField, 10);
    return Number.isFinite(n) ? n : null;
  } catch (_) {
    return null;
  }
}

function getOrbitForNorad(norad) {
  if (norad == null) return null;
  const key = String(norad);
  if (orbitCache.has(key)) return orbitCache.get(key);
  const tlePath = path.join(CACHE_DIR, "tle_" + key + ".txt");
  try {
    if (fs.existsSync(tlePath)) {
      const lines = fs
        .readFileSync(tlePath, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const l2 = lines[0].startsWith("1 ") ? lines[1] : lines[2];
      const orbit = parseOrbitFromL2(l2);
      if (orbit != null) orbitCache.set(key, orbit);
      return orbit;
    }
  } catch (_) {}
  return null;
}

function getSatrecForNorad(norad) {
  if (satrecCache.has(norad)) return satrecCache.get(norad);
  const tlePath = path.join(CACHE_DIR, "tle_" + norad + ".txt");
  try {
    if (fs.existsSync(tlePath)) {
      const lines = fs
        .readFileSync(tlePath, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      let l1, l2;
      if (lines[0].startsWith("1 ")) {
        l1 = lines[0];
        l2 = lines[1];
      } else {
        l1 = lines[1];
        l2 = lines[2];
      }
      const rec = satellite.twoline2satrec(l1, l2);
      satrecCache.set(norad, rec);
      const orbit = parseOrbitFromL2(l2);
      if (orbit != null) orbitCache.set(String(norad), orbit);
      return rec;
    }
  } catch (_) {}
  return null;
}

function cacheSatrec(norad, satrec) {
  satrecCache.set(norad, satrec);
}

/** Normalize a 3-line (or 2-line) TLE blob into { name, l1, l2 }. */
function parseTleText(text, norad) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return null;

  let name, l1, l2;
  if (lines[0].startsWith("1 ")) {
    name = "NORAD " + norad;
    l1 = lines[0];
    l2 = lines[1];
  } else {
    name = lines[0].replace(/^0\s+/, "").trim() || "NORAD " + norad;
    l1 = lines[1];
    l2 = lines[2];
  }
  if (!l1 || !l2 || !l1.startsWith("1 ") || !l2.startsWith("2 ")) return null;
  return { name, l1, l2 };
}

function writeTleCache(norad, name, l1, l2) {
  ensureCacheDir();
  const tlePath = path.join(CACHE_DIR, "tle_" + norad + ".txt");
  const metaPath = path.join(CACHE_DIR, "tle_" + norad + ".meta.json");
  fs.writeFileSync(tlePath, name + "\n" + l1 + "\n" + l2 + "\n");
  fs.writeFileSync(
    metaPath,
    JSON.stringify({
      fetched_at: new Date().toISOString(),
      name,
    }),
  );
  const orbit = parseOrbitFromL2(l2);
  if (orbit != null) orbitCache.set(String(norad), orbit);
  return orbit;
}

function readTleCache(norad) {
  const tlePath = path.join(CACHE_DIR, "tle_" + norad + ".txt");
  const metaPath = path.join(CACHE_DIR, "tle_" + norad + ".meta.json");
  if (!fs.existsSync(tlePath)) return null;
  try {
    const lines = fs
      .readFileSync(tlePath, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    let age = "?";
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        const then = new Date(meta.fetched_at);
        const secs = Math.floor((Date.now() - then.getTime()) / 1000);
        if (secs < 3600) age = Math.floor(secs / 60) + "m";
        else if (secs < 86400) age = Math.floor(secs / 3600) + "h";
        else age = Math.floor(secs / 86400) + "d";
      } catch (_) {}
    }
    const l1 = lines[0].startsWith("1 ") ? lines[0] : lines[1];
    const l2 = lines[0].startsWith("1 ") ? lines[1] : lines[2];
    if (!l1 || !l2) return null;
    const orbit = parseOrbitFromL2(l2);
    if (orbit != null) orbitCache.set(String(norad), orbit);
    return {
      name: lines[0].startsWith("1 ") ? "NORAD " + norad : lines[0],
      l1,
      l2,
      note: "TLE cache age " + age,
      orbit,
    };
  } catch (_) {
    return null;
  }
}

async function fetchText(url, timeoutMs) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.text();
}

/** CelesTrak single-object TLE. */
async function fetchFromCelestrak(norad) {
  const url =
    "https://celestrak.org/NORAD/elements/gp.php?CATNR=" +
    encodeURIComponent(String(norad)) +
    "&FORMAT=TLE";
  const text = (await fetchText(url, CELESTRAK_TIMEOUT_MS)).trim();
  const parsed = parseTleText(text, norad);
  if (!parsed) throw new Error("Celestrak: bad TLE body");
  return { ...parsed, note: "Celestrak (just fetched)" };
}

/**
 * AMSAT nasabare.txt — bulk 3LE list of amateur sats.
 * Match NORAD in line 1 field (cols 3–7) or name line containing the id.
 */
async function fetchFromAmsat(norad) {
  const urls = [
    "https://www.amsat.org/tle/current/nasabare.txt",
    "https://www.amsat.org/tle/dailytle.txt",
  ];
  const id = String(norad);
  let lastErr = null;
  for (const url of urls) {
    try {
      const text = await fetchText(url, FALLBACK_TIMEOUT_MS);
      const lines = text.split(/\r?\n/).map((l) => l.trim());
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.startsWith("1 ")) continue;
        // Classic TLE: cols 3-7 are catalog number (1-based col 3 → index 2)
        const catField = line.substring(2, 7).trim();
        if (
          catField !== id &&
          !catField.endsWith(id) &&
          catField !== id.padStart(5, "0")
        ) {
          continue;
        }
        const l2 = lines[i + 1];
        if (!l2 || !l2.startsWith("2 ")) continue;
        const nameLine =
          i > 0 &&
          !lines[i - 1].startsWith("1 ") &&
          !lines[i - 1].startsWith("2 ")
            ? lines[i - 1]
            : "NORAD " + id;
        const name = nameLine.replace(/^0\s+/, "").trim() || "NORAD " + id;
        return {
          name,
          l1: line,
          l2,
          note: "AMSAT nasabare (just fetched)",
        };
      }
      lastErr = new Error("AMSAT: NORAD " + id + " not in " + url);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("AMSAT: fetch failed");
}

/** SatNOGS DB — JSON TLE by norad_cat_id. */
async function fetchFromSatnogs(norad) {
  const url =
    "https://db.satnogs.org/api/tle/?norad_cat_id=" +
    encodeURIComponent(String(norad));
  const text = await fetchText(url, FALLBACK_TIMEOUT_MS);
  let arr;
  try {
    arr = JSON.parse(text);
  } catch (_) {
    throw new Error("SatNOGS: bad JSON");
  }
  if (!Array.isArray(arr) || !arr.length) {
    throw new Error("SatNOGS: no TLE for " + norad);
  }
  // Prefer newest by updated if present
  const row = arr.slice().sort((a, b) => {
    const ta = a.updated ? Date.parse(a.updated) : 0;
    const tb = b.updated ? Date.parse(b.updated) : 0;
    return tb - ta;
  })[0];
  const name =
    String(row.tle0 || "")
      .replace(/^0\s+/, "")
      .trim() || "NORAD " + norad;
  const l1 = String(row.tle1 || "").trim();
  const l2 = String(row.tle2 || "").trim();
  if (!l1.startsWith("1 ") || !l2.startsWith("2 ")) {
    throw new Error("SatNOGS: malformed tle1/tle2");
  }
  return {
    name,
    l1,
    l2,
    note: "SatNOGS (just fetched)",
  };
}

/** All known TLE backends (id matches UI data-tle-src). */
const TLE_BACKENDS = [
  { id: "celestrak", name: "Celestrak", fn: fetchFromCelestrak },
  { id: "amsat", name: "AMSAT", fn: fetchFromAmsat },
  { id: "satnogs", name: "SatNOGS", fn: fetchFromSatnogs },
];

const DEFAULT_TLE_SOURCES = ["celestrak", "amsat", "satnogs"];

/** Enabled source ids, in try order. */
let enabledSources = DEFAULT_TLE_SOURCES.slice();

function sourcesPrefPath() {
  return path.join(CACHE_DIR, "tle-sources.json");
}

function loadTleSourcesPref() {
  try {
    const raw = fs.readFileSync(sourcesPrefPath(), "utf8");
    const j = JSON.parse(raw);
    const list = Array.isArray(j.sources) ? j.sources : [];
    const clean = list
      .map((s) => String(s).toLowerCase())
      .filter((id) => TLE_BACKENDS.some((b) => b.id === id));
    if (clean.length) enabledSources = clean;
  } catch (_) {
    /* keep defaults */
  }
}

function saveTleSourcesPref() {
  try {
    ensureCacheDir();
    fs.writeFileSync(
      sourcesPrefPath(),
      JSON.stringify({ sources: enabledSources }, null, 2),
    );
  } catch (e) {
    console.warn("TLE sources pref save failed:", e.message || e);
  }
}

/** @returns {string[]} enabled source ids in order */
function getTleSources() {
  return enabledSources.slice();
}

/**
 * Set enabled TLE sources (order = try order). At least one required.
 * @param {string[]} ids
 * @returns {string[]}
 */
function setTleSources(ids) {
  const clean = (Array.isArray(ids) ? ids : [])
    .map((s) => String(s).toLowerCase().trim())
    .filter((id) => TLE_BACKENDS.some((b) => b.id === id));
  // de-dupe preserve order
  const seen = new Set();
  const ordered = [];
  for (const id of clean) {
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  if (!ordered.length) return getTleSources();
  enabledSources = ordered;
  saveTleSourcesPref();
  console.log("TLE sources →", enabledSources.join(", "));
  return getTleSources();
}

loadTleSourcesPref();

/**
 * Fetch TLE for a NORAD id.
 * Tries enabled sources in order, then local disk cache.
 */
async function fetchTLE(norad) {
  ensureCacheDir();
  const id = String(norad);
  const errors = [];

  const sources = enabledSources
    .map((sid) => TLE_BACKENDS.find((b) => b.id === sid))
    .filter(Boolean);

  if (!sources.length) {
    sources.push(...TLE_BACKENDS);
  }

  for (const src of sources) {
    try {
      const tle = await src.fn(id);
      const orbit = writeTleCache(id, tle.name, tle.l1, tle.l2);
      return {
        name: tle.name,
        l1: tle.l1,
        l2: tle.l2,
        note: tle.note,
        orbit: orbit != null ? orbit : parseOrbitFromL2(tle.l2),
      };
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      errors.push(src.name + ": " + msg);
      console.warn("TLE " + src.name + " failed for " + id + ":", msg);
    }
  }

  const cached = readTleCache(id);
  if (cached) {
    console.warn(
      "TLE using disk cache for " + id + " after remote failures:",
      errors.join(" | "),
    );
    return cached;
  }

  throw new Error("fetch failed (" + errors.join(" | ") + ")");
}

module.exports = {
  getSatrecForNorad,
  getOrbitForNorad,
  cacheSatrec,
  fetchTLE,
  parseOrbitFromL2,
  getTleSources,
  setTleSources,
  TLE_BACKENDS,
};
