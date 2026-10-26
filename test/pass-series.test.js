// 24 h pass elevation series (elevation chart Favorites view).
// Run: node --test test/pass-series.test.js
const test = require("node:test");
const assert = require("assert");
const satellite = require("satellite.js");
const { computePassSeries } = require("../lib/pass-series");
const { findNextPass, lookAngles } = require("../lib/orbit");

const ISS = satellite.twoline2satrec(
  "1 25544U 98067A   26280.50000000  .00016717  00000-0  30000-3 0  9990",
  "2 25544  51.6400 200.0000 0005000  90.0000 270.0000 15.50000000000000",
);
const GEO = satellite.twoline2satrec(
  "1 44910U 19097A   26289.78794699  .00000152  00000+0  00000+0 0  9996",
  "2 44910   5.2243  73.5004 0003619 163.3194 112.5366  1.00268176 24912",
);
const obs = { latitude: satellite.degreesToRadians(40.6), longitude: satellite.degreesToRadians(-112.46), height: 1.3 };
const start = Date.UTC(2026, 9, 7, 12, 0, 0);

test("ISS: several passes in 24 h, ordered, above horizon only", () => {
  const ps = computePassSeries(ISS, obs, start, 24, 60);
  assert(ps.length >= 3 && ps.length <= 12, "pass count " + ps.length);
  let last = start - 1;
  for (const p of ps) {
    assert(p.aos >= start && p.los <= start + 864e5 && p.los > p.aos);
    assert(p.aos > last, "ordered, non-overlapping");
    last = p.los;
    assert(p.pts.length >= 2);
    for (const [t, el] of p.pts) {
      assert(el >= 0 && el <= 90 && t >= p.aos && t <= p.los);
    }
    assert.strictEqual(p.maxEl, Math.max(...p.pts.map((q) => q[1])));
    assert.strictEqual(p.pts[0][1], 0, "starts on horizon (interpolated)");
    assert.strictEqual(p.pts[p.pts.length - 1][1], 0, "ends on horizon");
  }
});

test("first pass agrees with findNextPass", () => {
  const ps = computePassSeries(ISS, obs, start, 24, 30);
  const np = findNextPass(ISS, obs, new Date(start), 0, 24, 30);
  assert(np);
  assert(Math.abs(ps[0].aos - np.aos) < 30000, "AOS within 30 s");
  assert(Math.abs(ps[0].los - np.los) < 30000, "LOS within 30 s");
  assert(Math.abs(ps[0].maxEl - np.maxEl) < 3, "max el close");
});

test("pass in progress at start begins at start", () => {
  const ps = computePassSeries(ISS, obs, start, 24, 60);
  const mid = Math.round((ps[0].aos + ps[0].los) / 2);
  const ps2 = computePassSeries(ISS, obs, mid, 1, 60);
  assert.strictEqual(ps2[0].aos, mid);
  assert(ps2[0].pts[0][1] > 0);
});

test("never-visible sat yields no passes; window length honored", () => {
  const south = { latitude: satellite.degreesToRadians(-89), longitude: 0, height: 0 };
  // ISS (51.6 deg incl.) never rises at the south pole
  assert.deepStrictEqual(computePassSeries(ISS, south, start, 24, 60), []);
  const ps = computePassSeries(ISS, obs, start, 2, 60);
  for (const p of ps) assert(p.los <= start + 2 * 3600e3);
});

test("geo sat continuously up (or never) -> at most one pass spanning window", () => {
  const el = lookAngles(GEO, obs, new Date(start)).el;
  const ps = computePassSeries(GEO, obs, start, 24, 300);
  if (el > 1) {
    assert.strictEqual(ps.length, 1);
    assert.strictEqual(ps[0].aos, start);
  } else if (el < -1) assert.strictEqual(ps.length, 0);
});

test("cost: 25 sats x 24 h @ 60 s is quick", () => {
  const t = Date.now();
  for (let i = 0; i < 25; i++) computePassSeries(ISS, obs, start, 24, 60);
  const ms = Date.now() - t;
  assert(ms < 5000, "took " + ms + " ms");
  console.log("25 sats x 24h:", ms, "ms");
});

test("samples carry azimuth (0..359) agreeing with lookAngles; horizon points have none", () => {
  const ps = computePassSeries(ISS, obs, start, 24, 60);
  for (const p of ps) {
    for (let i = 1; i < p.pts.length - 1; i++) {
      const [t, , az] = p.pts[i];
      assert(Number.isInteger(az) && az >= 0 && az < 360, "az " + az);
      const l = lookAngles(ISS, obs, new Date(t));
      let d = Math.abs(((l.az % 360) + 360) % 360 - az);
      d = Math.min(d, 360 - d);
      assert(d <= 0.5 + 1e-9, "az matches lookAngles");
    }
    assert.strictEqual(p.pts[0].length, 2, "interpolated AOS point has no az");
  }
});

test("peak (maxEl / tca) is refined: same value whatever the 60 s grid phase", () => {
  const a = computePassSeries(ISS, obs, start, 24, 60);
  for (const off of [7000, 23000, 41000, 59000]) {
    const b = computePassSeries(ISS, obs, start + off, 24, 60);
    for (const p of a) {
      const q = b.find((x) => Math.abs(x.aos - p.aos) < 120000);
      if (!q) continue;
      assert(Math.abs(q.maxEl - p.maxEl) <= 0.2, "maxEl stable: " + p.maxEl + " vs " + q.maxEl);
      assert(Math.abs(q.tca - p.tca) < 5000, "tca stable");
    }
  }
  for (const p of a) {
    assert(p.tca >= p.aos && p.tca <= p.los);
    const pk = p.pts.find((q) => q[0] === p.tca);
    assert(pk && pk[1] === p.maxEl, "peak point is on the curve");
    for (let i = 1; i < p.pts.length; i++) assert(p.pts[i][0] > p.pts[i - 1][0], "pts sorted");
    // fine scan agrees with the refined peak
    let fine = -90;
    for (let t = p.aos; t <= p.los; t += 1000) fine = Math.max(fine, lookAngles(ISS, obs, new Date(t)).el);
    assert(Math.abs(fine - p.maxEl) <= 0.15, "refined " + p.maxEl + " vs 1 s scan " + fine);
  }
});
