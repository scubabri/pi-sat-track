// Follow satellite (js/sat-follow.js): one shared on/off state for the map's
// top-right button, the 2D map follower and the 3D globe follow
// (js/globe-view.js, also started from the chart's Favorites legend).
// Smooth 2D motion (rAF integrator, no 1 Hz jumps), drag / center buttons
// stop it, a newly selected sat is followed, a preview centers on the
// previewed position and "Back to now" glides back to the live sat.
// Run: node --test --test-force-exit test/sat-follow.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const F = require("../js/sat-follow");

const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

/* ---------------- integrator ---------------- */

test("integrator: moves every frame between 1 s samples (no 1 Hz jump)", () => {
  const it = F.createIntegrator();
  it.sample("ISS", 10, 20, 0);
  it.sample("ISS", 10.06, 20.1, 1000); // 0.06 deg/s lat, 0.1 deg/s lng
  let prev = it.step(1000, null);
  let maxStep = 0;
  for (let t = 1016; t <= 2000; t += 16) {
    const c = it.step(t, null);
    maxStep = Math.max(maxStep, Math.abs(c.lng - prev.lng));
    assert.ok(c.lng >= prev.lng, "monotonic");
    prev = c;
  }
  assert.ok(prev.lng > 20.15 && prev.lng < 20.25, "advanced ~0.1 deg in 1 s: " + prev.lng);
  // next sample slightly off the prediction: bled in, no single-frame snap
  it.sample("ISS", 10.12, 20.18, 2000);
  const c = it.step(2016, null);
  assert.ok(Math.abs(c.lng - prev.lng) < 0.01, "no snap: " + (c.lng - prev.lng));
  assert.ok(maxStep < 0.01, "per-frame step small: " + maxStep);
});

test("integrator: preview start / end and a new sat glide (~1.5 s), then lock", () => {
  const it = F.createIntegrator();
  it.sample("ISS", 0, 0, 0);
  it.step(0, null);
  const pv = { lat: 40, lng: 60 };
  const a = it.step(16, pv);
  assert.ok(a.lat > 0 && a.lat < 10, "gliding toward the preview: " + a.lat);
  let c;
  for (let t = 32; t <= 1600; t += 16) c = it.step(t, pv);
  assert.ok(Math.abs(c.lat - 40) < 0.01 && Math.abs(c.lng - 60) < 0.01, "locked on preview");
  const b = it.step(1616, null); // Back to now
  assert.ok(b.lat < 40 && b.lat > 30, "gliding back to live: " + b.lat);
  for (let t = 1632; t <= 3300; t += 16) c = it.step(t, null);
  assert.ok(Math.abs(c.lat) < 0.01, "locked on the live sat again");
  // another sat: glide over, not snap
  it.sample("SO-50", -30, -100, 3300);
  const d = it.step(3316, null);
  assert.ok(d.lat < 0 && d.lat > -10, "gliding to the new sat: " + d.lat);
  assert.strictEqual(it.f.key, "SO-50");
});

test("integrator: dateline crossing stays continuous", () => {
  const it = F.createIntegrator();
  it.sample("ISS", 0, 179.9, 0);
  it.sample("ISS", 0, -179.9, 1000);
  const c = it.step(1000, null);
  const d = it.step(1016, null);
  assert.ok(Math.abs(F.wrap180(d.lng - c.lng)) < 0.01);
});

/* ---------------- shared state + 2D follower ---------------- */

function sandbox(opts) {
  opts = opts || {};
  const store = Object.assign({}, opts.store || {});
  const docLs = {};
  const raf = [];
  const buttons = [];
  const mkBtn = () => {
    const cls = new Set(["map-center-btn", "map-follow-btn"]);
    const attrs = {};
    return { title: "", attrs, cls, classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) }, setAttribute: (k, v) => (attrs[k] = String(v)) };
  };
  buttons.push(mkBtn());
  const bodyCls = new Set();
  const mapLs = {};
  const views = [];
  const map = {
    _animatingZoom: false,
    getZoom: () => 3,
    setView: (c, z, o) => views.push({ lat: c[0], lng: c[1], z, animate: o && o.animate }),
    on: (t, fn) => (mapLs[t] = mapLs[t] || []).push(fn),
  };
  const marker = { __sat: "ISS", ll: null, setLatLng(ll) { this.ll = ll; } };
  const sb = {
    console, Math, JSON, Number, String, Array, Object, Set, Map, isFinite,
    Date,
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0,
    requestAnimationFrame: (fn) => (raf.push(fn), raf.length), cancelAnimationFrame() {},
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => (store[k] = String(v)) },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    document: {
      hidden: false,
      body: { classList: { contains: (c) => bodyCls.has(c) } },
      addEventListener: (t, fn) => (docLs[t] = docLs[t] || []).push(fn),
      dispatchEvent: (e) => (docLs[e.type] || []).forEach((fn) => fn(e)),
      querySelectorAll: (s) => (s === ".map-follow-btn" ? buttons : []),
    },
    map, satMarker: marker, footprintCircle: { ll: null, setLatLng(ll) { this.ll = ll; } },
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(rd("js/sat-follow.js"), sb);
  vm.runInContext("var currentSatKey = " + JSON.stringify(opts.sat === undefined ? "ISS" : opts.sat) + ";", sb);
  const events = [];
  sb.document.addEventListener("sat-follow-change", (e) => events.push(e.detail.on + ":" + e.detail.source));
  const state = (sat, lat, lon) => sb.satFollow.onMapState({ type: "state", sat, position: lat == null ? null : { lat, lon, heightKm: 420 } });
  const wire = () => { sb.map.__satFollowWired = false; vm.runInContext("satFollow", sb); };
  return { sb, store, events, views, buttons, bodyCls, mapLs, marker, state, sf: () => sb.satFollow, raf };
}

test("button toggles one shared state: lit, persisted, event for the globe", () => {
  const s = sandbox();
  s.state("ISS", 10, 20);
  s.sf().syncButtons();
  const b = s.buttons[0];
  assert.ok(!b.cls.has("on") && !b.cls.has("disabled"));
  assert.strictEqual(b.title, "Follow satellite");
  assert.strictEqual(s.sf().toggle(), true);
  assert.ok(b.cls.has("on"), "lit");
  assert.strictEqual(b.attrs["aria-pressed"], "true");
  assert.strictEqual(s.store.satFollow, "1", "persisted");
  assert.deepStrictEqual(s.events, ["true:button"]);
  // the globe follow (chart legend pick) turning it on/off shows on the button too
  s.sf().set(false, { source: "globe" });
  assert.ok(!b.cls.has("on"));
  s.sf().set(true, { source: "globe" });
  assert.ok(b.cls.has("on"));
  assert.strictEqual(s.store.satFollow, "1");
});

test("disabled without a selected sat position (no TLE); persisted on restores", () => {
  const s = sandbox({ sat: null });
  s.sf().syncButtons();
  assert.ok(s.buttons[0].cls.has("disabled"));
  assert.strictEqual(s.sf().toggle(), false, "no-op");
  assert.strictEqual(s.sf().isOn(), false);
  const s2 = sandbox();
  s2.state("ISS", null); // selected but no position (no TLE)
  s2.sf().syncButtons();
  assert.ok(s2.buttons[0].cls.has("disabled"));
  assert.strictEqual(s2.sf().toggle(), false);
  const s3 = sandbox({ store: { satFollow: "1" } });
  assert.strictEqual(s3.sf().isOn(), true, "restored from localStorage");
});

test("2D: frames center the map on the smoothed sat (zoom kept, no animation) and move the marker", () => {
  const s = sandbox();
  s.state("ISS", 10, 20);
  s.sf().toggle();
  s.state("ISS", 10.06, 20.1);
  const now = Date.now();
  assert.ok(s.sf().__frame(now));
  for (let t = now + 16; t <= now + 2000; t += 16) assert.ok(s.sf().__frame(t)); // sample error bled in
  const v = s.views[s.views.length - 1];
  assert.ok(Math.abs(v.lat - 10.06) < 0.01 && Math.abs(v.lng - 20.1) < 0.01, JSON.stringify(v));
  assert.strictEqual(v.z, 3, "zoom unchanged");
  assert.strictEqual(v.animate, false);
  assert.ok(s.marker.ll && Math.abs(s.marker.ll[1] - v.lng) < 0.01, "marker moves with the camera");
  assert.ok(s.sf().smoothPos("ISS"), "map.js uses the smoothed position for the marker");
  // globe showing: the 2D loop stops (globe-view.js owns the camera)
  s.bodyCls.add("globe-mode");
  assert.strictEqual(s.sf().__frame(now + 32), false);
  assert.strictEqual(s.sf().smoothPos("ISS"), null);
});

test("2D: preview centers on the previewed position; Back to now resumes live", () => {
  const s = sandbox();
  let pv = null;
  s.sb.passPreview = { posOf: (k) => (pv && k === "ISS" ? { position: pv } : null) };
  s.state("ISS", 10, 20);
  s.sf().toggle();
  const t0 = Date.now();
  s.sf().__frame(t0);
  pv = { lat: 45, lon: -100 };
  for (let t = t0 + 16; t <= t0 + 1700; t += 16) s.sf().__frame(t);
  let v = s.views[s.views.length - 1];
  assert.ok(Math.abs(v.lat - 45) < 0.01 && Math.abs(v.lng + 100) < 0.01, "on the preview: " + JSON.stringify(v));
  pv = null;
  for (let t = t0 + 1716; t <= t0 + 3400; t += 16) s.sf().__frame(t);
  v = s.views[s.views.length - 1];
  assert.ok(Math.abs(v.lat - 10) < 0.5 && Math.abs(v.lng - 20) < 0.5, "back on the live sat: " + JSON.stringify(v));
});

test("2D: switching sats keeps following the new one; stale state of the old sat ignored", () => {
  const s = sandbox();
  s.state("ISS", 10, 20);
  s.sf().toggle();
  vm.runInContext("currentSatKey = 'SO-50'", s.sb);
  s.state("ISS", 10.1, 20.1); // stale, before the server switched
  assert.strictEqual(s.sf().__integ.f.key, "SO-50", "target is the selection");
  assert.strictEqual(s.sf().__integ.f.lat, null, "stale old-sat state not used as the new sat's position");
  s.state("SO-50", -30, 50);
  assert.strictEqual(s.sf().__integ.f.key, "SO-50");
  assert.strictEqual(s.sf().isOn(), true);
});

test("2D: a manual drag ends following everywhere (button off, globe told)", async () => {
  const s = sandbox();
  s.state("ISS", 10, 20);
  s.sf().toggle();
  // wire the map listeners (normally a 300 ms poll)
  const src = rd("js/sat-follow.js");
  assert.match(src, /m\.on\("dragstart", \(\) => \{ if \(on\) set\(false, \{ source: "drag" \}\); \}\)/);
  s.sf().set(false, { source: "drag" });
  assert.ok(!s.buttons[0].cls.has("on"));
  assert.deepStrictEqual(s.events, ["true:button", "false:drag"]);
});

/* ---------------- wiring ---------------- */

test("wiring: map button in the top-right stack; center buttons end follow; marker smoothing", () => {
  const map = rd("js/map.js");
  assert.match(map, /mkBtn\("atlantic"[\s\S]{0,200}L\.DomUtil\.create\("a", "map-center-btn map-follow-btn", container\)/, "third button below station / mid-Atlantic");
  assert.match(map, /fb\.title = "Follow satellite"/);
  assert.match(map, /window\.satFollow\.toggle\(\)/);
  assert.match(map, /satFollow\.set\(false, \{ source: "center" \}\);\s*setCenterChoice\(choice\);/);
  assert.match(map, /querySelectorAll\("\.map-center-btn\[data-center\]"\)/, "station / atlantic radio state leaves the follow button alone");
  assert.match(map, /window\.satFollow\.onMapState\(state\)/);
  assert.match(map, /window\.satFollow\.smoothPos\(state\.sat\)/);
  const html = rd("index.html");
  assert.ok(html.indexOf('src="js/sat-follow.js"') > html.indexOf('src="js/map.js"') && html.indexOf('src="js/sat-follow.js"') < html.indexOf('src="js/globe-view.js"'));
});

test("wiring: globe follow drives / follows the same shared state", () => {
  const g = rd("js/globe-view.js");
  assert.match(g, /window\.globeSnapTo = function \(key\) \{[\s\S]{0,200}window\.satFollow\.set\(true, \{ source: "globe" \}\)/, "chart legend follow lights the button");
  assert.match(g, /function stopFollow\(keep\) \{\s*if \(!keep && window\.satFollow && window\.satFollow\.isOn\(\)\) window\.satFollow\.set\(false/, "drag / center buttons turn it off everywhere");
  assert.match(g, /document\.addEventListener\("sat-follow-change", onFollowChange\)/);
  assert.match(g, /retargetFollow\(msg\.sat\); \/\/ another sat selected: follow it/);
  assert.match(g, /satFollow\.isOn\(\) && !follow\.key\)[\s\S]{0,200}window\.globeSnapTo\(k\)/, "entering the globe while on follows there");
});

/* Regression (Brian): following + switching the selected sat stayed on the old sat. */
test("regression 2D: switching sats retargets at once and glides to the new sat", (t0) => {
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  t0.after(() => { Date.now = realNow; });
  const s = sandbox();
  s.state("ISS", 10, 20);
  s.sf().toggle();
  for (let i = 0; i < 120; i++) s.sf().__frame((t += 16));
  vm.runInContext("currentSatKey = 'FO-29'", s.sb); // selectSatellite / tracker
  s.sf().__frame((t += 16));
  assert.strictEqual(s.sf().__integ.f.key, "FO-29", "old sat's position dropped right away");
  const held = s.views[s.views.length - 1];
  assert.ok(Math.abs(held.lat - 10) < 0.5, "holds until the new sat's position arrives");
  s.state("FO-29", -20, 150);
  s.sf().__frame((t += 16));
  const first = s.views[s.views.length - 1];
  assert.ok(first.lat > -15, "glides (no snap): " + JSON.stringify(first));
  for (let i = 0; i < 150; i++) s.sf().__frame((t += 16));
  const v = s.views[s.views.length - 1];
  assert.ok(Math.abs(v.lat + 20) < 0.5 && Math.abs(v.lng - 150) < 0.5, "on FO-29: " + JSON.stringify(v));
  assert.strictEqual(s.sf().isOn(), true);
});

test("regression: switched to a sat with no position (no TLE) -> follow stops, button un-lit", () => {
  const s = sandbox();
  s.state("ISS", 10, 20);
  s.sf().toggle();
  const t = Date.now();
  vm.runInContext("currentSatKey = 'NOTLE-1'", s.sb);
  s.sf().__checkTarget(t);
  assert.strictEqual(s.sf().isOn(), true, "grace period for its first state");
  s.sf().__checkTarget(t + s.sf().NO_POS_MS + 1);
  assert.strictEqual(s.sf().isOn(), false, "stopped instead of sticking on the old sat");
  s.sf().syncButtons();
  assert.ok(!s.buttons[0].cls.has("on"));
  assert.strictEqual(s.events[s.events.length - 1], "false:nosat");
});

test("globe listens for sat switches from the shared follow (sat-follow-target) and in its frame loop", () => {
  const g = rd("js/globe-view.js");
  assert.match(g, /addEventListener\("sat-follow-target"[\s\S]{0,120}retargetFollow\(k\)/);
  assert.match(g, /if \(sel && sel !== follow\.key\) retargetFollow\(sel\);/);
  assert.doesNotMatch(g, /Date\.now\(\) - follow\.since > 5000\) stopFollow\(\)/, "old behavior: dropped follow, camera stuck on the previous sat");
});
