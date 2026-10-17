/**
 * 24 h pass elevation series for the elevation chart's Favorites view.
 * One coarse scan per sat (default 60 s) keeping only above-horizon samples,
 * with the 0 deg crossings interpolated so arcs start/end on the horizon.
 * Cost: hours*3600/stepSec propagations per sat (1440 @ 60 s / 24 h).
 */
const { lookAngles } = require("./orbit");

/**
 * @returns [{ aos, los, maxEl, pts: [[tMs, elDeg], ...] }] (ms epoch, el 0.1 deg)
 * A pass in progress at startMs starts at startMs; one still up at the end
 * stops at the window end.
 */
function computePassSeries(satrec, observer, startMs, hours, stepSec) {
  hours = hours != null ? hours : 24;
  stepSec = stepSec != null ? stepSec : 60;
  const stepMs = stepSec * 1000;
  const end = startMs + hours * 3600000;
  const passes = [];
  let cur = null;
  let prevT = null;
  let prevEl = null;
  const r1 = (v) => Math.round(v * 10) / 10;
  for (let t = startMs; t <= end; t += stepMs) {
    let el;
    try {
      const l = lookAngles(satrec, observer, new Date(t));
      el = l ? l.el : null;
    } catch (_) {
      el = null;
    }
    if (el == null || !Number.isFinite(el)) {
      if (cur) { passes.push(cur); cur = null; }
      prevT = prevEl = null;
      continue;
    }
    if (el >= 0) {
      if (!cur) {
        let t0 = t;
        if (prevEl != null && prevEl < 0) t0 = Math.round(prevT + (t - prevT) * (-prevEl / (el - prevEl)));
        cur = { aos: t0, los: t, maxEl: el, pts: t0 < t ? [[t0, 0]] : [] };
      }
      cur.pts.push([t, r1(el)]);
      cur.los = t;
      if (el > cur.maxEl) cur.maxEl = el;
    } else if (cur) {
      const tl = Math.round(prevT + (t - prevT) * (prevEl / (prevEl - el)));
      cur.pts.push([tl, 0]);
      cur.los = tl;
      passes.push(cur);
      cur = null;
    }
    prevT = t;
    prevEl = el;
  }
  if (cur) passes.push(cur);
  passes.forEach((p) => (p.maxEl = r1(p.maxEl)));
  return passes;
}

module.exports = { computePassSeries };
