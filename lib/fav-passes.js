/**
 * Favorites next-pass service.
 *  - Keeps TLEs fresh for every favorite (fetch at startup / when favorites
 *    change if the disk copy is missing or older than TLE_MAX_AGE, then a
 *    periodic refresh). Fetches are sequential so a Pi 4 never sees a burst.
 *  - Computes the next pass (AOS/LOS/maxEl, honoring rotor min elevation) for
 *    every favorite with a cheap single-pass scan, caches it, and only
 *    recomputes after that pass's LOS, on TLE/observer/minEl change, or every
 *    RECALC_MS. Results ride on the regular "state" favorites payload.
 */
const satellite = require("satellite.js");
const tle = require("./tle");
const { findNextPass } = require("./orbit");

const TLE_MAX_AGE_MS = 12 * 3600 * 1000;
const TLE_REFRESH_MS = 3 * 3600 * 1000;
const RECALC_MS = 15 * 60 * 1000;
const NO_PASS_RETRY_MS = 30 * 60 * 1000;

let deps = null; // { getCatalog, getObserver, getMinEl, onUpdate }
let keys = [];
const passes = new Map(); // key -> { aos, los, maxEl, computedAt, sig }
const tleGen = new Map(); // norad -> counter bumped when a fresh TLE lands
let refreshing = null;
const lastTry = new Map(); // norad -> ms of last fetch attempt (backoff)
const RETRY_MS = 10 * 60 * 1000;
let timers = [];

function noradOf(key) {
  const info = (deps && deps.getCatalog()[key]) || {};
  return info.norad != null ? String(info.norad) : null;
}

function ctxSig(norad) {
  const o = deps.getObserver() || {};
  return [tleGen.get(norad) || 0, o.latitude, o.longitude, o.height, deps.getMinEl()].join("|");
}

/** Recompute stale/expired entries. Returns true if anything changed. */
function recompute(now) {
  if (!deps) return false;
  now = now || new Date();
  const t = now.getTime();
  let changed = false;
  for (const key of keys) {
    const norad = noradOf(key);
    if (!norad) continue;
    const rec = tle.getSatrecForNorad(norad);
    if (!rec) continue;
    const sig = ctxSig(norad);
    const p = passes.get(key);
    const expired =
      !p ||
      p.sig !== sig ||
      (p.los != null && t > p.los) ||
      (p.aos == null && t - p.computedAt > NO_PASS_RETRY_MS) ||
      (p.aos != null && t < p.aos && t - p.computedAt > RECALC_MS);
    if (!expired) continue;
    let np = null;
    try {
      np = findNextPass(rec, deps.getObserver(), now, deps.getMinEl(), 24, 30);
    } catch (_) {}
    passes.set(key, {
      aos: np ? np.aos : null,
      los: np ? np.los : null,
      maxEl: np ? np.maxEl : null,
      computedAt: t,
      sig,
    });
    changed = true;
  }
  for (const k of [...passes.keys()]) if (!keys.includes(k)) passes.delete(k);
  return changed;
}

/** Sequentially fetch TLEs that are missing or older than maxAge. */
function refreshTles(maxAgeMs) {
  if (refreshing) return refreshing;
  const list = keys.map(noradOf).filter(Boolean);
  refreshing = (async () => {
    for (const norad of [...new Set(list)]) {
      const have = tle.getSatrecForNorad(norad);
      if (have && tle.getTleAgeMs(norad) < maxAgeMs) continue;
      if (Date.now() - (lastTry.get(norad) || 0) < RETRY_MS) continue;
      lastTry.set(norad, Date.now());
      try {
        const t = await tle.fetchTLE(norad);
        if (t && t.l1 && t.l2) {
          tle.cacheSatrec(norad, satellite.twoline2satrec(t.l1, t.l2));
          tleGen.set(norad, (tleGen.get(norad) || 0) + 1);
        }
      } catch (_) {}
    }
  })().finally(() => {
    refreshing = null;
    if (recompute() && deps.onUpdate) deps.onUpdate();
  });
  return refreshing;
}

/** Call when a TLE for norad was (re)loaded elsewhere (e.g. sat select). */
function noteTle(norad) {
  norad = String(norad);
  tleGen.set(norad, (tleGen.get(norad) || 0) + 1);
}

function setKeys(newKeys) {
  keys = (newKeys || []).slice();
  if (!deps) return;
  recompute();
  refreshTles(TLE_MAX_AGE_MS);
}

function get(key) {
  const p = passes.get(key);
  return p ? { aos: p.aos, los: p.los, maxEl: p.maxEl } : null;
}

function init(d) {
  deps = d;
  timers.forEach(clearInterval);
  timers = [
    setInterval(() => refreshTles(TLE_REFRESH_MS), TLE_REFRESH_MS),
    // cheap: only expired entries do work
    setInterval(() => {
      // favorites restored before the catalog loaded / failed fetches
      if (keys.some((k) => noradOf(k) && !tle.getSatrecForNorad(noradOf(k))))
        refreshTles(TLE_MAX_AGE_MS);
      if (recompute() && deps.onUpdate) deps.onUpdate();
    }, 10000),
  ];
  timers.forEach((t) => t.unref && t.unref());
  if (keys.length) setKeys(keys);
}

function stop() {
  timers.forEach(clearInterval);
  timers = [];
}

module.exports = { init, stop, setKeys, get, recompute, refreshTles, noteTle, TLE_MAX_AGE_MS };
