// Pass preview: the selected sat is drawn where it WILL BE at the preview
// time T (server "preview" reply), the banner's az/el is the look angle of
// that drawn sub-point, the globe follow camera centers on it (and does not
// drag the marker back to the live position), and the polar plot marks it.
// Run: node --test --test-force-exit test/pass-preview-pos.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pst-pvpos-"));
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
const { lookAngles, groundPoint } = require("../lib/orbit");

const OBS = { lat: 40.5, lon: -111.9, hM: 1400 }; // Utah
const R = Math.PI / 180;

/** Look angle from the observer to a drawn marker (geodetic sub-point + height). */
function lookFromMarker(pos) {
  const gd = { latitude: pos.lat * R, longitude: pos.lon * R, height: pos.heightKm };
  const ecf = satellite.geodeticToEcf(gd);
  const la = satellite.ecfToLookAngles({ latitude: OBS.lat * R, longitude: OBS.lon * R, height: OBS.hM / 1000 }, ecf);
  return { az: ((la.azimuth / R) + 360) % 360, el: la.elevation / R };
}
function gcDeg(a, b) {
  const c = Math.sin(a.lat * R) * Math.sin(b.lat * R) + Math.cos(a.lat * R) * Math.cos(b.lat * R) * Math.cos((a.lon - b.lon) * R);
  return Math.acos(Math.max(-1, Math.min(1, c))) / R;
}

test("preview position is at T (not now) and the banner az/el matches the drawn marker (< 0.5°)", () => {
  state.setObserver(OBS.lat, OBS.lon, OBS.hM);
  state.setFavorites(["ISS"]);
  state.loadSatellite && state.loadSatellite("ISS");
  const obs = state.getObserver();
  // a future moment with ISS well above the Utah horizon (like "ISS 22° · az 54°")
  const t0 = Date.UTC(2026, 9, 7, 0, 0);
  let T = null;
  for (let t = t0 + 3600000; t < t0 + 48 * 3600000; t += 20000) {
    const l = lookAngles(ISS, obs, new Date(t));
    if (l && l.el > 15) { T = t; break; }
  }
  assert.ok(T, "found an ISS pass over Utah");
  const pv = state.computePreview(T);
  const iss = pv.sats.find((s) => s.key === "ISS");
  assert.ok(iss && iss.position && iss.look);
  const g = groundPoint(ISS, new Date(T));
  assert.ok(Math.abs(iss.position.lat - g.lat) < 1e-9 && Math.abs(iss.position.lon - g.lon) < 1e-9, "sub-point at T");
  // The drawn marker is near the observer (ISS above ~15° → within ~20° of arc), not elsewhere on Earth.
  assert.ok(gcDeg(iss.position, OBS) < 20, "marker near Utah, gc " + gcDeg(iss.position, OBS).toFixed(1));
  // ... and not the position "now" (an hour+ earlier the ISS is elsewhere)
  const gNow = groundPoint(ISS, new Date(T - 45 * 60000));
  assert.ok(gcDeg(gNow, iss.position) > 30);
  const lm = lookFromMarker(iss.position);
  const dAz = Math.abs((((lm.az - (iss.look.az + 360) % 360) + 540) % 360) - 180);
  assert.ok(Math.abs(lm.el - iss.look.el) < 0.5, "el " + lm.el + " vs " + iss.look.el);
  assert.ok(dAz < 0.5, "az " + lm.az + " vs " + iss.look.az);
});

test("globe follow: preview-aware camera, marker not dragged back to the live position", () => {
  const src = fs.readFileSync(path.join(__dirname, "../js/globe-view.js"), "utf8");
  const ff = src.slice(src.indexOf("function followFrame("), src.indexOf("window.globeFollowing"));
  assert.ok(/passPreview\.posOf\(follow\.key\)/.test(ff), "followFrame asks for the preview position");
  assert.ok(/if \(pvNow\) return;[\s\S]*p\.lat = follow\.lat/.test(ff), "while previewing it returns before moving marker / label / footprint");
  assert.ok(/G\.pointOfView\(\{ lat: cam\.lat, lng: cam\.lng/.test(ff), "camera on the preview-aware target");
  // applyState still draws the selected sat at the preview position (and the live ghost)
  assert.ok(/const fp = \(follow\.key === st\.sat && !pT\) \? followPos\(\) : null;/.test(src));
  assert.ok(/ghost\.lat = lastState\.position\.lat/.test(src));
});

test("polar plot: amber dot at the preview az/el; none without a preview", () => {
  const calls = [];
  const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : (...a) => calls.push([k, a, o.fillStyle])), set: (o, k, v) => ((o[k] = v), true) });
  let pv = null;
  const sb = {
    document: { getElementById: () => ({}), addEventListener() {} },
    window: { passPreview: { posOf: (k) => (k === "ISS" ? pv : null) } },
    currentSatKey: "ISS",
    setupGaugeCanvas: () => ctx,
    gaugeFont: () => "10px sans-serif",
    Math,
  };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/radar.js"), "utf8") + "\ninitRadar();", sb);
  const amberArcs = () => calls.filter((c) => c[0] === "fill" && c[2] === "#e3b341").length;
  calls.length = 0;
  sb.updateRadar(100, 20, null);
  assert.strictEqual(amberArcs(), 0);
  pv = { key: "ISS", look: { az: 54, el: 22 } };
  calls.length = 0;
  sb.updateRadar(100, 20, null);
  assert.strictEqual(amberArcs(), 1, "preview dot drawn");
  const xy = sb.azElToXY(54, 22);
  assert.ok(calls.some((c) => c[0] === "arc" && Math.abs(c[1][0] - xy.x) < 1e-9 && Math.abs(c[1][1] - xy.y) < 1e-9));
  pv = { key: "ISS", look: { az: 54, el: -3 } };
  calls.length = 0;
  sb.updateRadar(100, 20, null);
  assert.strictEqual(amberArcs(), 0, "below horizon: no dot");
});
