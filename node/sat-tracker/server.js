const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const satellite = require("satellite.js");

const PORT = 3000;
const ROOT = __dirname;
const CACHE_DIR = path.join(require("os").homedir(), ".rpitrack");
const CATALOG_CACHE = path.join(CACHE_DIR, "amsat_catalog.json");
const STATUS_CACHE = path.join(CACHE_DIR, "amsat_status.json");

const CATALOG_URL =
  "https://raw.githubusercontent.com/palewire/amateur-satellite-database/main/data/amsat-all-frequencies.json";
const AMSAT_STATUS = "https://www.amsat.org/status/";

const DEFAULT_SAT = "RS-44";
const MIN_EL = 0.0;
const TRAIL_MINUTES = 30;
const TRAIL_STEP_SEC = 30;
const PASS_HOURS = 12;
const PASS_STEP_SEC = 30;
const REFRESH_MS = 6 * 60 * 60 * 1000;
const SATS_BROADCAST_MS = 30 * 1000;
const TICK_MS = 250; // fast: Doppler + look
const STATE_MS = 1000; // slow: map / trails / passes
const C_MS = 299792.458; // km/s

const mime = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

let CATALOG = {};
let catalogNote = "not loaded";
let ACTIVE = new Set();
let statusNote = "not loaded";
const satrecCache = new Map();

let currentSatKey = null;
let satrec = null;
let tleNote = "";
let currentNorad = null;
let currentOrbit = null;
let observer = {
  latitude: satellite.degreesToRadians(40.5),
  longitude: satellite.degreesToRadians(-111.9),
  height: 1.324,
};

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function norm(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function designator(name) {
  const m = String(name || "").match(/\b([A-Z]{1,4})[\s-]?(\d{1,3}[A-Z]?)\b/i);
  if (!m) return null;
  return (m[1] + "-" + m[2]).toUpperCase();
}

function makeKey(name, norad) {
  const d = designator(name);
  if (d) return d;
  if (norad) return "N" + norad;
  return norm(name).slice(0, 16) || "UNKNOWN";
}

function centerFreqMHz(field) {
  if (field == null || !String(field).trim()) return null;
  const s = String(field).trim();
  const primary = s.split(/[\/]/)[0].trim();

  const range = primary.match(/(\d+\.?\d*)\s*[-–]\s*(\d+\.?\d*)/);
  if (range) {
    const a = parseFloat(range[1]);
    const b = parseFloat(range[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return ((a + b) / 2).toFixed(3);
  }

  const single = primary.match(/(\d+\.\d+)/);
  if (single) return parseFloat(single[1]).toFixed(3);
  return null;
}

function isFmMode(mode) {
  if (!mode) return false;
  const m = String(mode).toUpperCase();
  if (/\bFM\b/.test(m)) return true;
  if (/CTCSS/.test(m)) return true;
  return false;
}

function formatFreqDisplay(sat) {
  const ul = centerFreqMHz(sat.uplink);
  const dl = centerFreqMHz(sat.downlink);
  const fm = isFmMode(sat.mode);
  return {
    uplink: ul || "-",
    downlink: dl || "-",
    ulLabel: fm ? "Uplink (FM)" : "Uplink (LSB)",
    dlLabel: fm ? "Downlink (FM)" : "Downlink (USB)",
    isFm: fm,
    ulMHz: ul ? parseFloat(ul) : null,
    dlMHz: dl ? parseFloat(dl) : null,
  };
}

function scoreRow(row) {
  let s = 0;
  if (row.uplink) s += 2;
  if (row.downlink) s += 2;
  if (row.uplink && String(row.uplink).includes("-")) s += 2;
  if (row.downlink && String(row.downlink).includes("-")) s += 2;
  const m = String(row.mode || "").toUpperCase();
  if (/\bSSB\b|\bCW\b|\bA\b|\bB\b|\bLINEAR\b/.test(m)) s += 3;
  if (/\bFM\b|CTCSS/.test(m)) s += 1;
  if (row.status === "active" || row.status === "operational") s += 1;
  return s;
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "sat-tracker/0.1" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.text();
}

function parseAmsatJson(arr) {
  const byNorad = new Map();

  for (const row of arr) {
    if (!row || !row.name) continue;
    const norad =
      row.norad_id != null && String(row.norad_id).trim() !== ""
        ? parseInt(String(row.norad_id), 10)
        : null;
    if (!Number.isFinite(norad)) continue;

    const entry = {
      name: String(row.name).trim(),
      norad,
      uplink: row.uplink != null ? String(row.uplink).trim() : "",
      downlink: row.downlink != null ? String(row.downlink).trim() : "",
      beacon: row.beacon != null ? String(row.beacon).trim() : "",
      mode: row.mode != null ? String(row.mode).trim() : "",
      callsign: row.callsign != null ? String(row.callsign).trim() : "",
      status: String(row.status || "")
        .trim()
        .toLowerCase(),
      satnogs_id: row.satnogs_id || null,
    };

    const prev = byNorad.get(norad);
    if (!prev) {
      byNorad.set(norad, entry);
      continue;
    }

    if (scoreRow(entry) > scoreRow(prev)) {
      prev.uplink = entry.uplink || prev.uplink;
      prev.downlink = entry.downlink || prev.downlink;
      prev.beacon = entry.beacon || prev.beacon;
      prev.mode = entry.mode || prev.mode;
      if (entry.name.length <= prev.name.length) prev.name = entry.name;
    } else {
      if (!prev.uplink && entry.uplink) prev.uplink = entry.uplink;
      if (!prev.downlink && entry.downlink) prev.downlink = entry.downlink;
      if (!prev.beacon && entry.beacon) prev.beacon = entry.beacon;
      if (entry.mode && prev.mode && !prev.mode.includes(entry.mode)) {
        prev.mode = [prev.mode, entry.mode].filter(Boolean).join(", ");
      } else if (entry.mode && !prev.mode) {
        prev.mode = entry.mode;
      }
    }

    const st = entry.status;
    if (st === "active" || st === "operational") prev.status = "active";
    else if (!prev.status || prev.status === "unknown") prev.status = st;
  }

  const catalog = {};
  for (const entry of byNorad.values()) {
    if (entry.status === "operational") entry.status = "active";
    if (entry.status === "non-operational") entry.status = "inactive";

    const key = makeKey(entry.name, entry.norad);
    entry.key = key;
    entry.display = entry.name;
    entry.trackable = !!entry.norad;
    catalog[key] = entry;
  }
  return catalog;
}

function parseAmsatStatus(html) {
  const active = new Set();
  const re = /([A-Za-z0-9][A-Za-z0-9\-]{0,24})_\[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const base = m[1].trim();
    if (!base || base.length < 2) continue;
    active.add(norm(base));
    const d = designator(base);
    if (d) active.add(norm(d));
  }
  return active;
}

function isHeard(sat) {
  const candidates = new Set();
  candidates.add(norm(sat.display));
  candidates.add(norm(sat.name));
  candidates.add(norm(sat.key));
  const d = designator(sat.display || sat.name || sat.key);
  if (d) candidates.add(norm(d));

  for (const n of candidates) {
    if (n && ACTIVE.has(n)) return true;
  }
  return false;
}

async function refreshCatalog() {
  ensureCacheDir();
  try {
    const text = await fetchText(CATALOG_URL);
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error("catalog not an array");
    const catalog = parseAmsatJson(arr);
    const payload = {
      fetched_at: new Date().toISOString(),
      note: "AMSAT frequencies JSON live",
      source: CATALOG_URL,
      satellites: catalog,
    };
    fs.writeFileSync(CATALOG_CACHE, JSON.stringify(payload));
    CATALOG = catalog;
    catalogNote = payload.note;
    console.log(
      "Catalog: " + Object.keys(CATALOG).length + " sats - " + catalogNote,
    );
  } catch (e) {
    if (fs.existsSync(CATALOG_CACHE)) {
      const payload = JSON.parse(fs.readFileSync(CATALOG_CACHE, "utf8"));
      CATALOG = payload.satellites || {};
      catalogNote =
        "cache " + (payload.fetched_at || "?") + " (" + e.message + ")";
      console.log(
        "Catalog from cache: " +
          Object.keys(CATALOG).length +
          " - " +
          catalogNote,
      );
    } else {
      catalogNote = "empty (" + e.message + ")";
      console.error("Catalog failed:", e.message);
    }
  }
}

async function refreshStatus() {
  ensureCacheDir();
  try {
    const html = await fetchText(AMSAT_STATUS);
    const set = parseAmsatStatus(html);
    const payload = {
      fetched_at: new Date().toISOString(),
      note: "AMSAT status live",
      names: [...set],
    };
    fs.writeFileSync(STATUS_CACHE, JSON.stringify(payload));
    ACTIVE = set;
    statusNote = set.size + " heard - " + payload.note;
    console.log("Status: " + statusNote + " -> " + [...set].sort().join(", "));
  } catch (e) {
    if (fs.existsSync(STATUS_CACHE)) {
      const payload = JSON.parse(fs.readFileSync(STATUS_CACHE, "utf8"));
      ACTIVE = new Set(payload.names || []);
      statusNote =
        "cache " + (payload.fetched_at || "?") + " (" + e.message + ")";
      console.log("Status from cache: " + ACTIVE.size);
    } else {
      statusNote = "empty (" + e.message + ")";
      console.error("Status failed:", e.message);
    }
  }
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
      return rec;
    }
  } catch (_) {}
  return null;
}

function horizonFlags(norad) {
  const rec = getSatrecForNorad(norad);
  if (!rec) return { above: false, soon: false, el: null, secToAos: null };

  const now = new Date();
  const look = lookAngles(rec, observer, now);
  const el = look ? look.el : null;
  const above = el != null && el >= 0;
  if (above) return { above: true, soon: false, el, secToAos: 0 };

  const step = 30;
  let prev = el;
  let secToAos = null;
  for (let s = step; s <= 12 * 3600; s += step) {
    const look2 = lookAngles(rec, observer, new Date(now.getTime() + s * 1000));
    if (!look2) continue;
    if (prev != null && prev < 0 && look2.el >= 0) {
      secToAos = s;
      break;
    }
    prev = look2.el;
  }
  return {
    above: false,
    soon: secToAos != null && secToAos <= 15 * 60,
    el,
    secToAos,
  };
}

function listSatsPayload(filter) {
  const rows = [];
  for (const s of Object.values(CATALOG)) {
    if (!s.trackable) continue;
    const st = s.status || "";
    if (filter === "active" && st !== "active" && !isHeard(s)) continue;
    if (filter === "trackable" && (st === "re-entered" || st === "failure"))
      continue;

    const freqs = formatFreqDisplay(s);
    const heard = isHeard(s);
    const row = {
      key: s.key,
      name: s.display || s.name,
      norad: s.norad,
      uplink: freqs.uplink,
      downlink: freqs.downlink,
      mode: s.mode,
      status: s.status,
      heard,
      isFm: freqs.isFm,
      above: false,
      soon: false,
      el: null,
      secToAos: null,
    };

    if (heard || s.status === "active") {
      const h = horizonFlags(s.norad);
      row.above = h.above;
      row.soon = h.soon;
      row.el = h.el;
      row.secToAos = h.secToAos;
    }

    rows.push(row);
  }
  rows.sort((a, b) => {
    if (a.above !== b.above) return a.above ? -1 : 1;
    if (a.soon !== b.soon) return a.soon ? -1 : 1;
    const aSec =
      typeof a.secToAos === "number" ? a.secToAos : Number.POSITIVE_INFINITY;
    const bSec =
      typeof b.secToAos === "number" ? b.secToAos : Number.POSITIVE_INFINITY;
    if (aSec !== bSec) return aSec - bSec;
    if ((a.status === "active") !== (b.status === "active")) {
      return a.status === "active" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  return {
    catalogNote,
    statusNote,
    count: rows.length,
    satellites: rows,
  };
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
    return {
      name,
      l1,
      l2,
      note: "Celestrak (just fetched)",
      orbit: parseOrbitFromL2(l2),
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
      return {
        name: lines[0].startsWith("1 ") ? "NORAD " + norad : lines[0],
        l1,
        l2,
        note: "TLE cache age " + age,
        orbit: parseOrbitFromL2(l2),
      };
    }
    throw err;
  }
}

function gmstFromDate(date) {
  return satellite.gstime(date);
}

function eciToLatLon(positionEci, date) {
  const gmst = gmstFromDate(date);
  const geodetic = satellite.eciToGeodetic(positionEci, gmst);
  let lon = satellite.radiansToDegrees(geodetic.longitude);
  lon = ((lon + 180) % 360) - 180;
  return {
    lat: satellite.radiansToDegrees(geodetic.latitude),
    lon,
    heightKm: geodetic.height,
  };
}

function lookAngles(satrec, observer, date) {
  const pv = satellite.propagate(satrec, date);
  if (!pv.position) return null;
  const gmst = gmstFromDate(date);
  const positionEcf = satellite.eciToEcf(pv.position, gmst);
  const look = satellite.ecfToLookAngles(observer, positionEcf);
  return {
    az: satellite.radiansToDegrees(look.azimuth),
    el: satellite.radiansToDegrees(look.elevation),
    rangeKm: look.rangeSat,
  };
}

/** Range rate (km/s). Positive = receding. */
function rangeRateKmS(satrec, observer, date) {
  const pv = satellite.propagate(satrec, date);
  if (!pv.position || !pv.velocity) return null;
  const gmst = gmstFromDate(date);
  const posEcf = satellite.eciToEcf(pv.position, gmst);
  const velEcf = satellite.eciToEcf(pv.velocity, gmst);
  const obsEcf = satellite.geodeticToEcf(observer);
  const dx = posEcf.x - obsEcf.x;
  const dy = posEcf.y - obsEcf.y;
  const dz = posEcf.z - obsEcf.z;
  const range = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (range < 1e-6) return 0;
  return (dx * velEcf.x + dy * velEcf.y + dz * velEcf.z) / range;
}

function groundPoint(satrec, date) {
  const pv = satellite.propagate(satrec, date);
  if (!pv.position) return null;
  return eciToLatLon(pv.position, date);
}

function buildTrail(satrec, now, minutes, stepSec) {
  const points = [];
  const start = new Date(now.getTime() - minutes * 60 * 1000);
  for (let t = start.getTime(); t <= now.getTime(); t += stepSec * 1000) {
    const p = groundPoint(satrec, new Date(t));
    if (p) points.push([p.lat, p.lon]);
  }
  return points;
}

function buildForwardTrack(satrec, now, orbits, stepSec) {
  const periodMin = (2 * Math.PI) / satrec.no;
  const totalSec = periodMin * orbits * 60;
  const points = [];
  const end = now.getTime() + totalSec * 1000;
  for (let t = now.getTime(); t <= end; t += stepSec * 1000) {
    const p = groundPoint(satrec, new Date(t));
    if (p) points.push([p.lat, p.lon]);
  }
  return points;
}

function findPasses(satrec, observer, now, minEl, hours, stepSec) {
  const passes = [];
  const end = new Date(now.getTime() + hours * 3600 * 1000);
  const lookbackMs = 20 * 60 * 1000;
  const start = new Date(now.getTime() - lookbackMs);

  let prevEl = null;
  let aosTime = null;
  let aosAz = null;
  let maxEl = minEl;

  for (let t = start.getTime(); t <= end.getTime(); t += stepSec * 1000) {
    const date = new Date(t);
    const look = lookAngles(satrec, observer, date);
    if (!look) continue;
    const el = look.el;

    if (prevEl !== null) {
      if (prevEl < minEl && el >= minEl) {
        aosTime = date;
        aosAz = look.az;
        maxEl = el;
      } else if (prevEl >= minEl && el < minEl && aosTime) {
        if (date.getTime() >= now.getTime() - stepSec * 1000) {
          passes.push({
            aos: aosTime.toISOString(),
            los: date.toISOString(),
            maxEl,
            aosAz,
          });
          if (passes.length >= 2) break;
        }
        aosTime = null;
        maxEl = minEl;
      } else if (aosTime && el > maxEl) {
        maxEl = el;
      }
    }
    prevEl = el;
  }

  if (aosTime && passes.length < 2) {
    const lookEnd = lookAngles(satrec, observer, end);
    if (lookEnd && lookEnd.el >= minEl) {
      passes.push({
        aos: aosTime.toISOString(),
        los: end.toISOString(),
        maxEl: Math.max(maxEl, lookEnd.el),
        aosAz,
      });
    }
  }

  passes.sort((a, b) => new Date(a.aos) - new Date(b.aos));

  const currentIdx = passes.findIndex((p) => {
    const aos = new Date(p.aos).getTime();
    const los = new Date(p.los).getTime();
    return aos <= now.getTime() && los >= now.getTime();
  });
  if (currentIdx > 0) {
    const cur = passes.splice(currentIdx, 1)[0];
    passes.unshift(cur);
  }

  return passes.slice(0, 2);
}

function passSkyPath(satrec, observer, aosIso, losIso, stepSec) {
  const points = [];
  const start = new Date(aosIso).getTime();
  const end = new Date(losIso).getTime();
  for (let t = start; t <= end; t += stepSec * 1000) {
    const look = lookAngles(satrec, observer, new Date(t));
    if (look && look.el >= 0) points.push({ az: look.az, el: look.el });
  }
  return points;
}

async function loadSatellite(key) {
  const info = CATALOG[key];
  if (!info || !info.norad)
    throw new Error("Unknown or non-trackable sat: " + key);
  currentSatKey = key;
  currentNorad = info.norad;
  console.log(
    "Catalog freqs for",
    key,
    ":",
    info.uplink,
    "/",
    info.downlink,
    "mode:",
    info.mode,
  );
  const tle = await fetchTLE(info.norad);
  satrec = satellite.twoline2satrec(tle.l1, tle.l2);
  satrecCache.set(info.norad, satrec);
  tleNote = tle.note;
  currentOrbit = tle.orbit != null ? tle.orbit : null;
  console.log(
    "Loaded " +
      (info.display || key) +
      " (" +
      info.norad +
      ") - " +
      tleNote +
      (currentOrbit != null ? " orbit " + currentOrbit : ""),
  );
  broadcastSats();
}

function pickDefaultKey() {
  if (CATALOG[DEFAULT_SAT]) return DEFAULT_SAT;

  for (const [k, s] of Object.entries(CATALOG)) {
    const n = norm(s.name || s.display || k);
    if (n === "RS44" || n.includes("RS44")) return k;
  }

  const heardActive = Object.values(CATALOG).filter(
    (s) => s.trackable && isHeard(s) && s.norad,
  );
  if (heardActive.length) {
    const preferred = [
      "RS-44",
      "AO-7",
      "AO-91",
      "SO-50",
      "FO-29",
      "ISS",
      "AO-73",
    ];
    for (const p of preferred) {
      const hit = heardActive.find(
        (s) => s.key === p || norm(s.name) === norm(p),
      );
      if (hit) return hit.key;
    }
    return heardActive[0].key;
  }

  const active = Object.values(CATALOG).find(
    (s) => s.status === "active" && s.norad,
  );
  if (active) return active.key;

  const any = Object.values(CATALOG).find((s) => s.trackable && s.norad);
  return any ? any.key : null;
}

/** Fast payload: look + Doppler-corrected freqs (full Hz precision) */
function computeTick() {
  if (!satrec) return null;
  const now = new Date();
  const look = lookAngles(satrec, observer, now);
  if (!look) return null;

  const rr = rangeRateKmS(satrec, observer, now); // km/s, + = receding
  const info = CATALOG[currentSatKey] || {};
  const freqs = formatFreqDisplay(info);

  let ulDopplerHz = null;
  let dlDopplerHz = null;
  let uplink = freqs.uplink;
  let downlink = freqs.downlink;
  let ulHz = freqs.ulMHz != null ? Math.round(freqs.ulMHz * 1e6) : null;
  let dlHz = freqs.dlMHz != null ? Math.round(freqs.dlMHz * 1e6) : null;

  if (rr != null && Number.isFinite(rr)) {
    // Downlink: received lower when receding → f * (1 - rr/c)
    // Uplink: transmit higher when receding so sat hears center → f * (1 + rr/c)
    if (freqs.dlMHz != null) {
      const f0 = freqs.dlMHz * 1e6;
      const fRx = f0 * (1 - rr / C_MS);
      dlDopplerHz = fRx - f0;
      dlHz = Math.round(fRx);
      downlink = (fRx / 1e6).toFixed(6);
    }
    if (freqs.ulMHz != null) {
      const f0 = freqs.ulMHz * 1e6;
      const fTx = f0 * (1 + rr / C_MS);
      ulDopplerHz = fTx - f0;
      ulHz = Math.round(fTx);
      uplink = (fTx / 1e6).toFixed(6);
    }
  }

  return {
    type: "tick",
    sat: currentSatKey,
    time: now.toISOString(),
    look: { az: look.az, el: look.el, rangeKm: look.rangeKm },
    rangeRateKmS: rr,
    uplink,
    downlink,
    ulHz,
    dlHz,
    ulLabel: freqs.ulLabel,
    dlLabel: freqs.dlLabel,
    ulDopplerHz,
    dlDopplerHz,
    ulBase: freqs.uplink,
    dlBase: freqs.downlink,
  };
}

/** Slow payload: full map geometry */
function computeState() {
  if (!satrec) return null;
  const now = new Date();
  const pos = groundPoint(satrec, now);
  const look = lookAngles(satrec, observer, now);
  if (!pos || !look) return null;

  const trail = buildTrail(satrec, now, TRAIL_MINUTES, TRAIL_STEP_SEC);
  const forward = buildForwardTrack(satrec, now, 2, TRAIL_STEP_SEC);
  const passesRaw = findPasses(
    satrec,
    observer,
    now,
    MIN_EL,
    PASS_HOURS,
    PASS_STEP_SEC,
  );
  const passes = passesRaw.map((p) => ({
    aos: p.aos,
    los: p.los,
    maxEl: p.maxEl,
    aosAz: p.aosAz,
    sky: passSkyPath(satrec, observer, p.aos, p.los, PASS_STEP_SEC),
  }));

  const info = CATALOG[currentSatKey] || {};
  const freqs = formatFreqDisplay(info);
  const tick = computeTick();

  return {
    type: "state",
    sat: currentSatKey,
    display: info.display || info.name || currentSatKey,
    norad: currentNorad || info.norad || null,
    orbit: currentOrbit,
    uplink: tick ? tick.uplink : freqs.uplink,
    downlink: tick ? tick.downlink : freqs.downlink,
    ulHz: tick
      ? tick.ulHz
      : freqs.ulMHz != null
        ? Math.round(freqs.ulMHz * 1e6)
        : null,
    dlHz: tick
      ? tick.dlHz
      : freqs.dlMHz != null
        ? Math.round(freqs.dlMHz * 1e6)
        : null,
    ulLabel: freqs.ulLabel,
    dlLabel: freqs.dlLabel,
    mode: info.mode || "",
    tleNote,
    catalogNote,
    statusNote,
    time: now.toISOString(),
    position: { lat: pos.lat, lon: pos.lon, heightKm: pos.heightKm },
    look: { az: look.az, el: look.el, rangeKm: look.rangeKm },
    rangeRateKmS: tick ? tick.rangeRateKmS : null,
    ulDopplerHz: tick ? tick.ulDopplerHz : null,
    dlDopplerHz: tick ? tick.dlDopplerHz : null,
    trail,
    forward,
    passes,
  };
}

const server = http.createServer((req, res) => {
  let urlPath = req.url === "/" ? "/index.html" : req.url;
  const q = urlPath.includes("?") ? urlPath.split("?")[1] : "";
  urlPath = urlPath.split("?")[0];

  if (urlPath === "/api/sats") {
    const params = new URLSearchParams(q);
    const filter = params.get("filter") || "trackable";
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    return res.end(JSON.stringify(listSatsPayload(filter)));
  }

  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found: " + urlPath);
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mime[ext] || "application/octet-stream",
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  } else {
    socket.destroy();
  }
});

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const c of wss.clients) {
    if (c.readyState === 1) c.send(data);
  }
}

function broadcastSats() {
  broadcast({ type: "sats", ...listSatsPayload("trackable") });
}

wss.on("connection", (ws) => {
  console.log("Client connected");
  ws.send(JSON.stringify({ type: "sats", ...listSatsPayload("trackable") }));

  const state = computeState();
  if (state) ws.send(JSON.stringify(state));
  const tick = computeTick();
  if (tick) ws.send(JSON.stringify(tick));

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "observer" && typeof msg.lat === "number") {
        observer = {
          latitude: satellite.degreesToRadians(msg.lat),
          longitude: satellite.degreesToRadians(msg.lon),
          height: (msg.elevM || 0) / 1000,
        };
      }
      if (msg.type === "sat" && msg.key) {
        loadSatellite(msg.key)
          .then(() => {
            const s = computeState();
            if (s) broadcast(s);
            const t = computeTick();
            if (t) broadcast(t);
          })
          .catch((err) => {
            ws.send(JSON.stringify({ type: "error", message: err.message }));
          });
      }
    } catch (e) {
      console.warn("Bad message", e.message);
    }
  });

  ws.on("close", () => console.log("Client disconnected"));
});

// Fast: Doppler + look (~4 Hz)
setInterval(() => {
  const t = computeTick();
  if (t) broadcast(t);
}, TICK_MS);

// Slow: map geometry (1 Hz)
setInterval(() => {
  const s = computeState();
  if (s) broadcast(s);
}, STATE_MS);

setInterval(() => {
  broadcastSats();
}, SATS_BROADCAST_MS);

setInterval(() => {
  refreshCatalog().catch(() => {});
  refreshStatus().catch(() => {});
}, REFRESH_MS);

(async () => {
  await refreshCatalog();
  await refreshStatus();
  const key = pickDefaultKey();
  if (key) {
    try {
      await loadSatellite(key);
    } catch (err) {
      console.warn("Default sat load failed (" + key + "):", err.message);
      console.warn(
        "Server will start without a loaded sat; pick one from the menu.",
      );
      satrec = null;
      currentSatKey = null;
    }
  }
  server.listen(PORT, "0.0.0.0", () => {
    console.log("Sat Tracker  http://127.0.0.1:" + PORT);
    console.log(
      "Tick " + TICK_MS + "ms (Doppler), state " + STATE_MS + "ms (map)",
    );
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
