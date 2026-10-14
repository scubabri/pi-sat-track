/**
 * Schedule Contact: find mutual visibility windows between this station and
 * a remote Maidenhead grid, for FM and linear-transponder satellites.
 * Also callsign -> grid lookup via api.g7vrd.co.uk (no auth, cached).
 */
const https = require("https");
const satellite = require("satellite.js");
const { lookAngles, groundPoint } = require("./orbit");
const { getCatalog, isFmMode, amsatTagsFor, amsatStatusLoaded } = require("./catalog");
const tle = require("./tle");

const GRID_RE = /^[A-R]{2}[0-9]{2}([A-X]{2})?$/i;

function isGrid(s) {
  return GRID_RE.test(String(s || "").trim());
}

/** Grid centre in degrees (4 or 6 char). */
function gridToLatLon(grid) {
  const g = String(grid || "").trim().toUpperCase();
  if (!isGrid(g)) return null;
  let lon = (g.charCodeAt(0) - 65) * 20 - 180 + parseInt(g[2], 10) * 2;
  let lat = (g.charCodeAt(1) - 65) * 10 - 90 + parseInt(g[3], 10);
  if (g.length >= 6) {
    lon += (g.charCodeAt(4) - 65) * (2 / 24) + 1 / 24;
    lat += (g.charCodeAt(5) - 65) * (1 / 24) + 1 / 48;
  } else {
    lon += 1;
    lat += 0.5;
  }
  return { lat, lon };
}

function observerFromLatLon(lat, lon, heightKm) {
  return {
    latitude: satellite.degreesToRadians(lat),
    longitude: satellite.degreesToRadians(lon),
    height: heightKm || 0,
  };
}

/* ---------- classification ---------- */
const FM_VOICE_RE = /\bFM\b|\bNFM\b|VOICE|CTCSS|\bPL\b/i;
const LINEAR_RE = /SSB|\bCW\b|LINEAR|TRANSPONDER|INVERT|\bUSB\b|\bLSB\b/i;

/** True if the frequency text starts in an amateur satellite band (MHz). */
function hamBand(f) {
  const m = String(f || "").match(/(\d+(?:\.\d+)?)/);
  if (!m) return false;
  const v = parseFloat(m[1]);
  return (v >= 144 && v <= 146) || (v >= 435 && v <= 438) || (v >= 1260 && v <= 1270) ||
    (v >= 2400 && v <= 2450) || (v >= 10450 && v <= 10500) || (v >= 28 && v <= 29.7) || (v >= 21 && v <= 21.45);
}

/**
 * "fm" | "linear" | null from the catalog mode list. A sat with both gets
 * the class of its primary (highest-scored) qualifying mode.
 */
function classifySat(info) {
  const modes = (info && info.modes && info.modes.length ? info.modes : [info]) || [];
  for (const m of modes) {
    const txt = String((m && m.mode) || "");
    // The qualifying transmitter itself must be listed active in the DB.
    if (!m || m.status !== "active") continue;
    // Must be a two-way channel: amateur-band uplink AND downlink.
    if (!txt || !hamBand(m.uplink) || !hamBand(m.downlink)) continue;
    // Mode text without an FM/voice or linear token (pure data/beacon) is skipped below.
    if (LINEAR_RE.test(txt)) return "linear";
    if (FM_VOICE_RE.test(txt) && isFmMode(txt)) return "fm";
  }
  return null;
}

/** Class from AMSAT status-page tags: "FM" -> fm; transponder tags (V/u, U/v, V/a, NB, ...) -> linear. */
function classFromAmsatTags(tags) {
  let fm = false;
  let lin = false;
  for (const t of tags || []) {
    if (/^FM$/i.test(t)) fm = true;
    else if (/^[A-Z]\/[a-z]$/.test(t) || /^NB$/i.test(t)) lin = true;
  }
  return { fm, lin };
}

/**
 * Active FM / linear sats.
 * Primary rule: the sat appears on the AMSAT live status list
 * (https://www.amsat.org/status/, refreshed with the catalog and disk-cached)
 * with an FM or transponder mode tag. If that list is unavailable, fall back
 * to the frequency DB: sat status "active" AND the qualifying transmitter
 * row's own status "active".
 */
function candidateSats() {
  const out = [];
  const useAmsat = amsatStatusLoaded();
  for (const s of Object.values(getCatalog() || {})) {
    if (!s || !s.trackable || s.norad == null) continue;
    if (s.status === "re-entered" || s.status === "failure") continue; // never trackable
    let cls = null;
    let via;
    if (useAmsat) {
      const tags = amsatTagsFor(s);
      if (!tags) continue;
      const c = classFromAmsatTags(tags);
      if (!c.fm && !c.lin) continue;
      cls = c.fm && c.lin ? classifySat(s) || "linear" : c.fm ? "fm" : "linear";
      via = "amsat:" + tags.join(",");
    } else {
      if (s.status !== "active") continue;
      cls = classifySat(s);
      if (!cls) continue;
      via = "catalog";
    }
    out.push({ key: s.key, name: s.display || s.name, norad: String(s.norad), cls, via });
  }
  return out;
}

async function satrecFor(norad) {
  let rec = tle.getSatrecForNorad(norad);
  if (rec) return rec;
  try {
    const t = await tle.fetchTLE(norad);
    if (!t) return null;
    rec = satellite.twoline2satrec(t.l1, t.l2);
    tle.cacheSatrec(norad, rec);
    return rec;
  } catch (_) {
    return null;
  }
}

/* ---------- mutual window search ---------- */
function elAt(rec, obs, ms) {
  const l = lookAngles(rec, obs, new Date(ms));
  return l ? l : null;
}

function bothUp(rec, a, b, ms, minEl) {
  const la = elAt(rec, a, ms);
  if (!la || la.el < minEl) return false;
  const lb = elAt(rec, b, ms);
  return !!lb && lb.el >= minEl;
}

/** Bisect the edge between tLo (state lo) and tHi (state !lo) to ~0.1 s. */
function refineEdge(rec, a, b, tLo, tHi, minEl, rising) {
  let lo = tLo;
  let hi = tHi;
  while (hi - lo > 100) {
    const mid = (lo + hi) / 2;
    const up = bothUp(rec, a, b, mid, minEl);
    if (up === rising) hi = mid;
    else lo = mid;
  }
  return rising ? hi : lo;
}

/**
 * Windows where elevation >= minEl at both observers a and b.
 * Returns [{startMs, endMs, maxElA, maxElB}].
 */
function mutualWindows(rec, a, b, startMs, endMs, minEl, stepSec) {
  const step = (stepSec || 15) * 1000;
  const out = [];
  let prevUp = bothUp(rec, a, b, startMs, minEl);
  let prevT = startMs;
  let cur = prevUp ? { startMs, maxElA: -90, maxElB: -90 } : null;
  for (let t = startMs + step; ; t += step) {
    if (t > endMs) t = endMs;
    const up = bothUp(rec, a, b, t, minEl);
    if (up && !prevUp) {
      cur = { startMs: refineEdge(rec, a, b, prevT, t, minEl, true), maxElA: -90, maxElB: -90 };
    } else if (!up && prevUp && cur) {
      cur.endMs = refineEdge(rec, a, b, prevT, t, minEl, false);
      out.push(cur);
      cur = null;
    }
    prevUp = up;
    prevT = t;
    if (t >= endMs) break;
  }
  if (cur) {
    cur.endMs = endMs;
    out.push(cur);
  }
  // max elevations sampled every 5 s inside each window (plus edges)
  for (const w of out) {
    for (let t = w.startMs; ; t += 5000) {
      if (t > w.endMs) t = w.endMs;
      const la = elAt(rec, a, t);
      const lb = elAt(rec, b, t);
      if (la && la.el > w.maxElA) w.maxElA = la.el;
      if (lb && lb.el > w.maxElB) w.maxElB = lb.el;
      if (t >= w.endMs) break;
    }
  }
  return out.filter((w) => w.endMs - w.startMs >= 1000);
}

/**
 * opts: { home:{lat,lon,heightKm}, remote:{lat,lon}, hours, minEl, now }
 */
async function findSchedule(opts) {
  const now = opts.now ? new Date(opts.now).getTime() : Date.now();
  const hours = opts.hours === 48 ? 48 : 24;
  const minEl = Number.isFinite(opts.minEl) ? opts.minEl : 0;
  const a = observerFromLatLon(opts.home.lat, opts.home.lon, opts.home.heightKm);
  const b = observerFromLatLon(opts.remote.lat, opts.remote.lon, 0);
  const endMs = now + hours * 3600 * 1000;
  const sats = candidateSats();
  const rows = [];
  let noTle = 0;
  for (const s of sats) {
    const rec = await satrecFor(s.norad);
    if (!rec) {
      noTle++;
      continue;
    }
    const wins = mutualWindows(rec, a, b, now, endMs, minEl, 15);
    for (const w of wins) {
      const mid = (w.startMs + w.endMs) / 2;
      const la = elAt(rec, a, mid);
      const lb = elAt(rec, b, mid);
      const gp = groundPoint(rec, new Date(mid));
      rows.push({
        key: s.key,
        name: s.name,
        mode: s.cls,
        start: new Date(w.startMs).toISOString(),
        end: new Date(w.endMs).toISOString(),
        durationSec: Math.round((w.endMs - w.startMs) / 1000),
        maxElMe: Math.round(w.maxElA * 10) / 10,
        maxElThem: Math.round(w.maxElB * 10) / 10,
        azMidMe: la ? Math.round(((la.az % 360) + 360) % 360) : null,
        azMidThem: lb ? Math.round(((lb.az % 360) + 360) % 360) : null,
        mid: new Date(mid).toISOString(),
        sub: gp ? { lat: gp.lat, lon: gp.lon, heightKm: gp.heightKm } : null,
      });
    }
    await new Promise((r) => setImmediate(r)); // keep ticks flowing
  }
  return { rows, satsChecked: sats.length - noTle, satsNoTle: noTle, minEl, hours, activeSource: amsatStatusLoaded() ? "AMSAT status" : "catalog" };
}

/* ---------- callsign -> grid (g7vrd, no auth) ---------- */
const lookupCache = new Map(); // CALL -> { at, result }
const CACHE_MS = 30 * 60 * 1000;

function httpGetJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs || 5000, headers: { "User-Agent": "pi-sat-track" } }, (res) => {
      let d = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        if (res.statusCode === 404) return resolve({ count: 0 });
        if (res.statusCode !== 200) return reject(new Error("HTTP " + res.statusCode));
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error("bad JSON")); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

/** Resolve callsign -> { grid, ts, source } or throw with a user-facing message. */
async function callsignGrid(callsign) {
  const cs = String(callsign || "").trim().toUpperCase();
  if (!/^[A-Z0-9/]{3,12}$/.test(cs)) throw new Error("Not a grid or callsign. Enter a grid (e.g. FN31).");
  const hit = lookupCache.get(cs);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  let j;
  try {
    j = await httpGetJson("https://api.g7vrd.co.uk/v1/locators/by-callsign/" + encodeURIComponent(cs), 5000);
  } catch (e) {
    throw new Error("Grid lookup failed (" + e.message + "). Enter a grid instead.");
  }
  const locs = (j && j.locators) || {};
  const ent = locs[cs] || Object.values(locs)[0];
  if (!j || !j.count || !ent || !ent.locator || !isGrid(String(ent.locator).slice(0, 6)))
    throw new Error("No grid found for " + cs + ". Enter a grid instead.");
  const g = String(ent.locator);
  const grid = g.length >= 6 ? g.slice(0, 4).toUpperCase() + g.slice(4, 6).toLowerCase() : g.slice(0, 4).toUpperCase();
  const result = { grid, ts: ent.ts || null, source: "g7vrd" };
  if (lookupCache.size > 200) lookupCache.clear();
  lookupCache.set(cs, { at: Date.now(), result });
  return result;
}

module.exports = {
  isGrid,
  gridToLatLon,
  classifySat,
  candidateSats,
  mutualWindows,
  findSchedule,
  callsignGrid,
  observerFromLatLon,
};
