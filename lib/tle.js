const fs = require("fs");
const path = require("path");
const satellite = require("satellite.js");
const { CACHE_DIR } = require("./config");

const satrecCache = new Map();
const orbitCache = new Map();

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

async function fetchTLE(norad) {
  ensureCacheDir();
  const tlePath = path.join(CACHE_DIR, "tle_" + norad + ".txt");
  const metaPath = path.join(CACHE_DIR, "tle_" + norad + ".meta.json");

  try {
    const url =
      "https://celestrak.org/NORAD/elements/gp.php?CATNR=" +
      norad +
      "&FORMAT=TLE";
    const res = await fetch(url, {
      headers: { "User-Agent": "sat-tracker/0.1" },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = (await res.text()).trim();
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    let name, l1, l2;
    if (lines[0].startsWith("1 ")) {
      name = "NORAD " + norad;
      l1 = lines[0];
      l2 = lines[1];
    } else {
      name = lines[0];
      l1 = lines[1];
      l2 = lines[2];
    }

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
    return {
      name,
      l1,
      l2,
      note: "Celestrak (just fetched)",
      orbit,
    };
  } catch (err) {
    if (fs.existsSync(tlePath)) {
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
      const orbit = parseOrbitFromL2(l2);
      if (orbit != null) orbitCache.set(String(norad), orbit);
      return {
        name: lines[0].startsWith("1 ") ? "NORAD " + norad : lines[0],
        l1,
        l2,
        note: "TLE cache age " + age,
        orbit,
      };
    }
    throw err;
  }
}

module.exports = {
  getSatrecForNorad,
  getOrbitForNorad,
  cacheSatrec,
  fetchTLE,
  parseOrbitFromL2,
};
