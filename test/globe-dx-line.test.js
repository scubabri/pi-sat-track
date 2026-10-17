// Globe Log-box DX line: great circle from the home marker to the DX dot,
// exact endpoints, dense enough to hug the surface, same altitude as both
// markers and above the footprint fill.
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "../js/globe-view.js"), "utf8");
function loadGcLine() {
  const i = src.indexOf("window.globeGcLine = function");
  assert.ok(i >= 0, "globeGcLine defined");
  const j = src.indexOf("\n  };", i);
  const win = {};
  new Function("window", src.slice(i, j + 4))(win);
  return win.globeGcLine;
}
const toV = (lat, lon) => {
  const a = (lat * Math.PI) / 180, o = (lon * Math.PI) / 180;
  return [Math.cos(a) * Math.cos(o), Math.cos(a) * Math.sin(o), Math.sin(a)];
};

test("KA7KDX (DN30so) -> KK4YEL (EL98pk): exact ends, on the great circle, dense", () => {
  const gc = loadGcLine();
  const a = { lat: 40.604166666, lon: -112.458333333 }, b = { lat: 28.4375, lon: -80.708333333 };
  const pts = gc(a, b, 0.006);
  assert.deepStrictEqual(pts[0], [a.lat, a.lon, 0.006]);
  assert.deepStrictEqual(pts[pts.length - 1], [b.lat, b.lon, 0.006]);
  assert.ok(pts.length >= 65, "segments " + (pts.length - 1));
  // Every point lies in the plane of the great circle through a and b.
  const A = toV(a.lat, a.lon), B = toV(b.lat, b.lon);
  const n = [A[1] * B[2] - A[2] * B[1], A[2] * B[0] - A[0] * B[2], A[0] * B[1] - A[1] * B[0]];
  for (const p of pts) {
    const v = toV(p[0], p[1]);
    assert.ok(Math.abs(v[0] * n[0] + v[1] * n[1] + v[2] * n[2]) < 1e-9, "off great circle at " + p);
    assert.strictEqual(p[2], 0.006);
  }
  // Great circle bows north of the straight lat/lon line at mid-way.
  const mid = pts[Math.floor(pts.length / 2)];
  assert.ok(mid[0] > (a.lat + b.lat) / 2, "mid lat " + mid[0]);
  // Steps <= 0.5 deg of arc.
  for (let k = 1; k < pts.length; k++) {
    const u = toV(pts[k - 1][0], pts[k - 1][1]), w = toV(pts[k][0], pts[k][1]);
    const ang = (Math.acos(Math.min(1, u[0] * w[0] + u[1] * w[1] + u[2] * w[2])) * 180) / Math.PI;
    assert.ok(ang <= 0.5 + 1e-9, "step " + ang);
  }
});

test("long path gets more points; identical ends are a 2-point line", () => {
  const gc = loadGcLine();
  assert.ok(gc({ lat: 40, lon: -112 }, { lat: 35, lon: 139 }, 0.006).length > 150);
  assert.strictEqual(gc({ lat: 1, lon: 2 }, { lat: 1, lon: 2 }, 0.006).length, 2);
});

test("home, DX dot and DX line share one altitude above the footprint fill", () => {
  const alt = Number((src.match(/const MARK_ALT = ([\d.]+)/) || [])[1]);
  const fill = Number((src.match(/\.polygonAltitude\(([\d.]+)\)/) || [])[1]);
  assert.ok(alt > fill, "MARK_ALT " + alt + " must be above polygonAltitude " + fill);
  assert.match(src, /const stLabel = \{ kind: "station",[^}]*alt: MARK_ALT/);
  assert.match(src, /const dxMark = \{ kind: "dx",[^}]*alt: MARK_ALT/);
  assert.match(src, /globeGcLine\(\{ lat: stLabel\.lat, lon: stLabel\.lng \}, \{ lat: ll\.lat, lon: ll\.lon \}, MARK_ALT\)/);
});
