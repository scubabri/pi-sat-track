// Pass preview from a click anywhere along a pass curve on the 24 h chart:
// passTimeAtPoint() (js/profile.js) maps the click to a time on that pass,
// clamped to AOS..LOS (near the base → near AOS / LOS, not the peak), and the
// server preview at that time has the banner az/el of the drawn marker.
// Run: node --test --test-force-exit test/pass-preview-click.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pst-pvclick-"));
const satellite = require("satellite.js");
const tle = require("../lib/tle");
const catalog = require("../lib/catalog");
const ISS = satellite.twoline2satrec(
  "1 25544U 98067A   26280.50000000  .00016717  00000-0  30000-3 0  9990",
  "2 25544  51.6400 200.0000 0005000  90.0000 270.0000 15.50000000000000");
tle.getSatrecForNorad = (n) => (String(n) === "25544" ? ISS : null);
tle.fetchTLE = async () => null;
catalog.getCatalog = () => ({ ISS: { key: "ISS", norad: 25544, display: "ISS" } });
const state = require("../lib/state");

function loadProfile() {
  const sb = { window: {}, document: { getElementById: () => null, addEventListener() {} }, localStorage: { getItem: () => null, setItem() {} }, Math, Date, console };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/profile.js"), "utf8"), sb);
  return sb;
}
const P = loadProfile();
const R = Math.PI / 180;
const OBS = { lat: 40.5, lon: -111.9, hM: 1400 };

// Chart geometry like drawFavProfile (24 h over ~1000 px, 0..90° over 100 px).
const W = 1000, H = 100, padT = 12;
function chartArc(pass, t0, t1) {
  const X = (t) => ((t - t0) / (t1 - t0)) * W;
  const Y = (el) => padT + H - (Math.max(0, Math.min(90, el)) / 90) * H;
  return { pts: pass.pts.map((q) => [X(Math.max(t0, q[0])), Y(q[1])]), ts: pass.pts.map((q) => Math.max(t0, q[0])), aos: pass.aos, los: pass.los, X, Y };
}

test("narrow spike: the click's height on the rising / falling side picks the time; clamped to AOS..LOS", () => {
  // synthetic 10 min pass, peak 60° at +5 min, 1 min samples (spike ~7 px wide)
  const aos = Date.UTC(2026, 9, 21, 12, 0), t0 = aos - 2 * 3600000, t1 = t0 + 24 * 3600000;
  const pts = [];
  for (let m = 0; m <= 10; m++) pts.push([aos + m * 60000, 60 * Math.sin((Math.PI * m) / 10)]);
  const arc = chartArc({ pts, aos, los: aos + 600000 }, t0, t1);
  assert.ok(arc.pts[10][0] - arc.pts[0][0] < 10, "a few px wide");
  const peak = arc.pts[5];
  // near the base on the left (rising) side → close to AOS
  const tL = P.passTimeAtPoint(arc, arc.pts[0][0], arc.Y(3));
  assert.ok(tL - aos < 60000, "rising base → within 1 min of AOS, got +" + (tL - aos) / 1000 + " s");
  // near the base on the right (falling) side → close to LOS
  const tR = P.passTimeAtPoint(arc, arc.pts[10][0], arc.Y(3));
  assert.ok(aos + 600000 - tR < 60000, "falling base → within 1 min of LOS");
  // halfway up the rising side → between AOS and peak, not the peak
  const tMid = P.passTimeAtPoint(arc, arc.pts[2][0], arc.Y(30));
  assert.ok(tMid > aos + 60000 && tMid < aos + 4 * 60000, "mid rising " + (tMid - aos) / 60000 + " min");
  // above the peak → TCA
  assert.ok(Math.abs(P.passTimeAtPoint(arc, peak[0], peak[1] - 15) - (aos + 300000)) < 15000);
  // below the axis / outside: still clamped to the pass
  for (const [x, y] of [[arc.pts[0][0] - 20, H + 40], [arc.pts[10][0] + 20, H + 40], [peak[0], -500]]) {
    const t = P.passTimeAtPoint(arc, x, y);
    assert.ok(t >= aos && t <= aos + 600000);
  }
});

test("wide arc (e.g. the Moon, hours): time under x, clamped", () => {
  const aos = Date.UTC(2026, 9, 21, 12, 0), t0 = aos - 2 * 3600000, t1 = t0 + 24 * 3600000;
  const pts = [];
  for (let m = 0; m <= 600; m += 10) pts.push([aos + m * 60000, 50 * Math.sin((Math.PI * m) / 600)]);
  const arc = chartArc({ pts, aos, los: aos + 600 * 60000 }, t0, t1);
  const xMid = arc.X(aos + 123 * 60000);
  assert.ok(Math.abs(P.passTimeAtPoint(arc, xMid, H) - (aos + 123 * 60000)) < 1000);
  assert.strictEqual(P.passTimeAtPoint(arc, arc.X(aos) - 50, 50), aos);
  assert.strictEqual(P.passTimeAtPoint(arc, arc.X(aos + 600 * 60000) + 50, 50), aos + 600 * 60000);
});

test("real ISS pass: click near the start → low-elevation preview whose banner az/el matches the marker", () => {
  state.setObserver(OBS.lat, OBS.lon, OBS.hM);
  state.setFavorites(["ISS"]);
  state.loadSatellite && state.loadSatellite("ISS");
  const now = new Date(Date.UTC(2026, 9, 7, 0, 0));
  const fp = state.computeFavProfile(now, 25.5);
  const iss = fp.sats.find((s) => s.key === "ISS");
  const pass = iss.passes.find((p) => p.maxEl > 30 && p.aos > now.getTime());
  assert.ok(pass, "an ISS pass > 30°");
  const t0 = now.getTime() - 2 * 3600000;
  const arc = chartArc(pass, t0, t0 + 24 * 3600000);
  const T = P.passTimeAtPoint(arc, arc.pts[0][0], arc.Y(4)); // click low on the rising side
  assert.ok(T >= pass.aos && T <= pass.los);
  const peakT = pass.pts.reduce((a, q) => (q[1] > a[1] ? q : a))[0];
  assert.ok(T < peakT - 120000, "well before the peak");
  const pv = state.computePreview(T).sats.find((s) => s.key === "ISS");
  assert.ok(pv.look.el > -1 && pv.look.el < 12, "low elevation " + pv.look.el);
  const gd = { latitude: pv.position.lat * R, longitude: pv.position.lon * R, height: pv.position.heightKm };
  const la = satellite.ecfToLookAngles({ latitude: OBS.lat * R, longitude: OBS.lon * R, height: OBS.hM / 1000 }, satellite.geodeticToEcf(gd));
  const az = ((la.azimuth / R) + 360) % 360;
  assert.ok(Math.abs(la.elevation / R - pv.look.el) < 0.5);
  assert.ok(Math.abs((((az - (pv.look.az + 360) % 360) + 540) % 360) - 180) < 0.5);
});

test("click wiring: selected sat's arc / label → previewTimeForHit; other sats and legend unchanged", () => {
  P.favProfileData = undefined;
  vm.runInContext('favProfileData = { current: "ISS", sats: [] };', P);
  const arc = { pts: [[0, 100], [5, 10], [10, 100]], ts: [0, 300000, 600000], aos: 0, los: 600000 };
  assert.ok(P.previewTimeForHit({ key: "ISS", arc }, 1, 90) < 150000);
  assert.strictEqual(P.previewTimeForHit({ key: "ISS", t: 300000 }, 0, 0), 300000);
  assert.strictEqual(P.previewTimeForHit({ key: "SO-50", arc }, 1, 90), null, "another sat: select + snap as before");
  assert.strictEqual(P.previewTimeForHit({ key: "ISS", legend: true }, 1, 90), null);
  assert.strictEqual(P.previewTimeForHit(null, 1, 90), null, "blank chart: time under x as before");
  const src = fs.readFileSync(path.join(__dirname, "../js/profile.js"), "utf8");
  assert.ok(/dragArc \? passTimeAtPoint\(dragArc, p\.x, p\.y\)/.test(src), "drag scrubs along the pass");
});
