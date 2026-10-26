/**
 * 24 h pass elevation series for the elevation chart's Favorites view.
 * One coarse scan per sat (default 60 s) keeping only above-horizon samples,
 * with the 0 deg crossings interpolated so arcs start/end on the horizon.
 * Cost: hours*3600/stepSec propagations per sat (1440 @ 60 s / 24 h).
 */
const { lookAngles } = require("./orbit");

/**
 * @returns [{ aos, los, maxEl, tca, pts: [[tMs, elDeg, azDeg], ...] }] (ms epoch, el 0.1 deg,
 * az whole deg). maxEl / tca are the refined peak (not just the best coarse
 * sample), and the peak point is inserted into pts, so the chart's peak label
 * does not jump by several degrees each time the series is recomputed with a
 * new start (the 60 s grid lands at a different phase of the pass). The interpolated 0 deg horizon points are [tMs, 0] (no az).
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
  let az = null;
  const r1 = (v) => Math.round(v * 10) / 10;
  for (let t = startMs; t <= end; t += stepMs) {
    let el;
    try {
      const l = lookAngles(satrec, observer, new Date(t));
      el = l ? l.el : null;
      az = l ? l.az : null;
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
      cur.pts.push([t, r1(el), Math.round(((az % 360) + 360) % 360)]);
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
  passes.forEach((p) => refinePeak(satrec, observer, p, stepMs, r1));
  return passes;
}

/**
 * Golden-section search for the true elevation maximum within one coarse
 * step either side of the best sample (clamped to the pass), then insert it
 * into pts. ~20 extra propagations per pass.
 */
function refinePeak(satrec, observer, p, stepMs, r1) {
  const elAt = (t) => {
    try {
      const l = lookAngles(satrec, observer, new Date(t));
      return l && Number.isFinite(l.el) ? l : null;
    } catch (_) {
      return null;
    }
  };
  let bi = -1;
  for (let i = 0; i < p.pts.length; i++) if (bi < 0 || p.pts[i][1] > p.pts[bi][1]) bi = i;
  if (bi < 0) { p.maxEl = r1(p.maxEl); return; }
  const tb = p.pts[bi][0];
  let a = Math.max(p.aos, tb - stepMs);
  let b = Math.min(p.los, tb + stepMs);
  let best = { t: tb, el: p.maxEl, az: p.pts[bi][2] };
  if (b > a) {
    const g = (Math.sqrt(5) - 1) / 2;
    let c = b - g * (b - a), d = a + g * (b - a);
    let lc = elAt(c), ld = elAt(d);
    for (let k = 0; k < 18 && lc && ld && b - a > 500; k++) {
      if (lc.el > ld.el) { b = d; d = c; ld = lc; c = b - g * (b - a); lc = elAt(c); }
      else { a = c; c = d; lc = ld; d = a + g * (b - a); ld = elAt(d); }
    }
    for (const [t, l] of [[c, lc], [d, ld]])
      if (l && l.el > best.el) best = { t: Math.round(t), el: l.el, az: l.az };
  }
  p.maxEl = r1(best.el);
  p.tca = best.t;
  if (best.t !== tb) {
    const az = best.az != null ? Math.round(((best.az % 360) + 360) % 360) : undefined;
    const pt = az != null ? [best.t, p.maxEl, az] : [best.t, p.maxEl];
    let j = 0;
    while (j < p.pts.length && p.pts[j][0] < best.t) j++;
    if (p.pts[j] && p.pts[j][0] === best.t) p.pts[j] = pt;
    else p.pts.splice(j, 0, pt);
  } else {
    p.pts[bi][1] = p.maxEl;
  }
}

module.exports = { computePassSeries };
