// Ending a pass preview (Back to now, selector pick, server-side selection,
// legend ...) restores the globe camera mode that was active just before the
// preview started: QTH-centered glides back home, following follows the
// (newly) selected sat, free view gets its camera back. Chained previews keep
// the original mode. Real js/globe-view.js (fake globe.gl), js/preview-camera.js,
// js/pass-preview.js, js/sat-menu.js and js/map.js centerOnStation in one vm context.
// Run: node --test --test-force-exit test/preview-camera-restore.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const HOME = { lat: 40.5, lng: -105.0 }; // DN40AA-ish (stubbed maidenheadToLatLon)

function fakeElement(tag) {
  const ls = {};
  return {
    tagName: tag, style: {}, hidden: false, clientWidth: 800, clientHeight: 600, children: [], dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { this.children.push(c); return c; }, insertBefore(c) { this.children.push(c); return c; },
    addEventListener(t, fn) { (ls[t] = ls[t] || []).push(fn); }, removeEventListener() {},
    setAttribute() {}, querySelector: () => null, querySelectorAll: () => [],
    getContext: () => ({}), __ls: ls,
    dispatch(t, e) { for (const fn of ls[t] || []) fn(e); },
  };
}

function makeSandbox(opts) {
  opts = opts || {};
  const store = { mapView: "globe" };
  if (opts.savedPov) store.globePov = JSON.stringify(opts.savedPov);
  const povCalls = [];
  let pov = { lat: 0, lng: 0, altitude: 2.2 };
  const glb = {};
  const chain = new Proxy(glb, {
    get(o, k) {
      if (k === "pointOfView") return (p, ms) => { if (!p) return Object.assign({}, pov); pov = Object.assign({}, pov, p); povCalls.push(Object.assign({ ms }, p)); return chain; };
      if (k === "controls") return () => ({ addEventListener() {} });
      if (k === "renderer") return () => ({ setPixelRatio() {} });
      if (k === "scene") return () => ({ children: [], add() {}, remove() {}, traverse() {} });
      if (k === "camera") return () => ({ position: { x: 0, y: 0, z: 300 } });
      if (k === "getGlobeRadius") return () => 100;
      if (k === "then") return undefined;
      return () => chain;
    },
  });
  const host = fakeElement("div");
  const sent = [];
  const intervals = [];
  const sb = {
    console, Math, Date, JSON, Number, String, Array, Object, Set, Map, Promise, Infinity, isFinite, Proxy,
    devicePixelRatio: 1,
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => (store[k] = String(v)) },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    Globe: () => () => chain,
    WebGLRenderingContext: function () {},
    WebSocket: { OPEN: 1 },
    ws: { readyState: 1, send: (d) => sent.push(JSON.parse(d)), addEventListener() {} },
    loadConfig: () => ({ grid: "DN40AA", callsign: "N0CALL" }),
    maidenheadToLatLon: () => ({ lat: HOME.lat, lon: HOME.lng }),
    formatClockShort: (t) => new Date(t).toISOString().slice(11, 16),
    updateFineOffsetDisplay() {},
  };
  const docLs = {};
  sb.document = {
    readyState: "complete", hidden: false,
    body: Object.assign(fakeElement("body"), {}),
    getElementById: (id) => (id === "map" ? host : null),
    createElement: (t) => fakeElement(t),
    addEventListener: (t, fn) => (docLs[t] = docLs[t] || []).push(fn),
    querySelector: () => null, querySelectorAll: () => [],
    dispatchEvent: (e) => { for (const fn of docLs[e.type] || []) fn(e); },
  };
  sb.window = sb;
  sb.addEventListener = () => {};
  sb.__setPov = (p) => { pov = Object.assign({}, pov, p); }; // a user drag / zoom (no globe.gl call recorded)
  vm.createContext(sb);
  for (const f of ["sat-menu.js", "preview-camera.js", "pass-preview.js", "globe-view.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), sb);
  // map.js's station button (centerOnStation) without the Leaflet setup.
  const mapSrc = fs.readFileSync(path.join(__dirname, "../js/map.js"), "utf8");
  const cos = mapSrc.match(/function centerOnStation\(\) \{[\s\S]*?\n\}/)[0];
  vm.runInContext("var map = null;\n" + cos + "\nwindow.centerOnStation = centerOnStation;", sb);
  vm.runInContext("currentSatKey = 'ISS';", sb);
  const gv = () => sb.__globePreviewCam;
  const state = (sat, lat, lon) => {
    // tracker.js order: currentSatKey, then onServerSat (may clear the preview), then the globe's ws listener.
    if (sb.__lastSat !== sat) {
      vm.runInContext("currentSatKey = " + JSON.stringify(sat), sb);
      sb.passPreview.onServerSat(sat);
      sb.__lastSat = sat;
    }
    const msg = JSON.stringify({ type: "state", sat, display: sat, position: { lat, lon, heightKm: 420 }, favorites: [] });
    for (const fn of sb.__wsMsg) fn({ data: msg });
  };
  sb.__wsMsg = [];
  sb.ws.addEventListener = (t, fn) => { if (t === "message") sb.__wsMsg.push(fn); };
  // The page's 500 ms interval that hooks the globe into the tracker ws (patchWs).
  const patchWs = () => intervals.filter((x) => x.ms === 500).forEach((x) => x.fn());
  return { sb, gv, state, povCalls, pov: () => pov, sent, patchWs, pp: () => sb.passPreview };
}

async function ready() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); // ensureGlobe().then
}

/** Sandbox with the globe loaded, ws patched and an ISS state applied. */
async function globe(opts) {
  const s = makeSandbox(opts);
  await ready();
  assert.ok(s.gv(), "globe-view exposes __globePreviewCam");
  s.patchWs();
  s.state("ISS", 10, 20);
  return s;
}
function plain(x) { return JSON.parse(JSON.stringify(x)); } // vm-realm objects
function last(s) { return s.povCalls[s.povCalls.length - 1]; }
function nearHome(p) { return Math.abs(p.lat - HOME.lat) < 1e-6 && Math.abs(p.lng - HOME.lng) < 1e-6; }

test("QTH-centered -> preview -> selector pick of another sat glides back to QTH (not to the sat)", async () => {
  const s = await globe();
  s.sb.centerOnStation(); // the station button
  assert.strictEqual(s.gv().mode().mode, "qth");
  s.pp().set(Date.now() + 3600000);
  s.sb.globeCenterOn(55, 60, { preview: true, key: "ISS" }); // preview spins the globe away
  assert.ok(!nearHome(s.pov()));
  assert.deepStrictEqual(plain(s.gv().saved()), { mode: "qth" });
  s.sb.selectSatellite("AO-7", "AO-7"); // white selector
  assert.strictEqual(s.pp().get(), null, "preview ended");
  assert.ok(nearHome(last(s)), "glides home: " + JSON.stringify(last(s)));
  assert.strictEqual(last(s).ms, 800);
  s.state("AO-7", -30, 140); // new sat's state must not pull the camera to it
  assert.ok(nearHome(s.pov()), "still home after the new sat's state");
  assert.strictEqual(s.gv().mode().mode, "qth");
  assert.strictEqual(s.sb.globeFollowing(), null);
});

test("QTH-centered -> preview -> Back to now returns to QTH-centered", async () => {
  const s = await globe();
  s.sb.centerOnStation();
  s.pp().set(Date.now() + 3600000);
  s.sb.globeCenterOn(55, 60, { preview: true, key: "ISS" });
  s.pp().clear(); // badge "Back to now"
  assert.ok(nearHome(last(s)));
  s.state("ISS", 11, 21);
  assert.ok(nearHome(s.pov()));
  assert.strictEqual(s.gv().mode().mode, "qth");
});

test("QTH-centered -> preview -> server-side selection (Auto Select / other client) returns to QTH", async () => {
  const s = await globe();
  s.sb.centerOnStation();
  s.pp().set(Date.now() + 3600000);
  s.sb.globeCenterOn(55, 60, { preview: true, key: "ISS" });
  s.state("RS-44", -10, 100);
  assert.strictEqual(s.pp().get(), null);
  assert.ok(nearHome(s.pov()));
});

test("following -> preview -> selector pick follows the newly selected sat live", async () => {
  const s = await globe();
  s.sb.globeSnapTo("ISS");
  assert.strictEqual(s.sb.globeFollowing(), "ISS");
  s.pp().set(Date.now() + 3600000);
  assert.deepStrictEqual(plain(s.gv().saved()), { mode: "follow", key: "ISS" });
  s.sb.selectSatellite("FO-29", "FO-29");
  assert.strictEqual(s.pp().get(), null);
  assert.strictEqual(s.sb.globeFollowing(), "FO-29", "follows the new sat");
  s.state("FO-29", -20, 150); // its first state: snap there
  const p = last(s);
  assert.ok(Math.abs(p.lat + 20) < 1e-6 && Math.abs(p.lng - 150) < 1e-6, "camera on FO-29: " + JSON.stringify(p));
  s.state("FO-29", -19, 151);
  assert.strictEqual(s.sb.globeFollowing(), "FO-29", "still following");
});

test("following -> preview -> Back to now keeps following the selected sat", async () => {
  const s = await globe();
  s.sb.globeSnapTo("ISS");
  s.pp().set(Date.now() + 3600000);
  s.pp().clear();
  assert.strictEqual(s.sb.globeFollowing(), "ISS");
});

test("free view -> preview -> pick restores the saved camera", async () => {
  const s = await globe();
  s.sb.globeCenterOn(-33, 151); // somewhere else (not home): free view
  s.sb.__setPov({ lat: -33, lng: 151, altitude: 3.1 });
  assert.strictEqual(s.gv().mode().mode, "free");
  s.pp().set(Date.now() + 3600000);
  s.sb.globeCenterOn(55, 60, { preview: true, key: "ISS" });
  s.sb.selectSatellite("AO-7", "AO-7");
  const p = last(s);
  assert.deepStrictEqual({ lat: p.lat, lng: p.lng, altitude: p.altitude }, { lat: -33, lng: 151, altitude: 3.1 });
  s.state("AO-7", 5, 5);
  assert.strictEqual(s.pov().lat, -33, "the new sat's state doesn't move it");
});

test("chained previews (another pass clicked) keep the original pre-preview mode", async () => {
  const s = await globe();
  s.sb.centerOnStation();
  s.pp().set(Date.now() + 3600000);
  s.sb.globeCenterOn(55, 60, { preview: true, key: "ISS" });
  // Another pass clicked while previewing: select (keepPreview) + new preview time + recenter.
  s.sb.selectSatellite("SO-50", "SO-50", { keepPreview: true });
  s.pp().set(Date.now() + 7200000, { center: true });
  s.sb.globeCenterOn(-5, 120, { preview: true, key: "SO-50" });
  s.state("SO-50", 1, 2); // its echo keeps the preview
  assert.ok(s.pp().get() != null);
  assert.deepStrictEqual(plain(s.gv().saved()), { mode: "qth" }, "not overwritten by the preview's camera");
  s.pp().clear();
  assert.ok(nearHome(s.pov()));
});

test("no preview active: picking a sat doesn't move the camera (unchanged)", async () => {
  const s = await globe();
  s.sb.centerOnStation();
  const n = s.povCalls.length;
  s.sb.selectSatellite("AO-7", "AO-7");
  s.state("AO-7", -30, 140);
  assert.strictEqual(s.povCalls.length, n);
});

test("a drag ends QTH-centered: free view is restored instead", async () => {
  const s = await globe();
  s.sb.centerOnStation();
  const el = s.sb.document.getElementById("map").children.find((c) => c.id === "globe-view");
  el.dispatch("pointerdown", { clientX: 0, clientY: 0, stopPropagation() {} });
  el.dispatch("pointermove", { clientX: 30, clientY: 0, buttons: 1, stopPropagation() {} });
  s.sb.__setPov({ lat: 12, lng: 34, altitude: 2 });
  assert.strictEqual(s.gv().mode().mode, "free");
});

test("pure helper: saves on start, restores once on end, chained starts keep the first", () => {
  const { createPreviewCamera, nearHome: nh } = require("../js/preview-camera.js");
  let m = { mode: "qth" };
  const got = [];
  const c = createPreviewCamera({ getMode: () => m, restore: (x) => got.push(x) });
  c.onPreview(true);
  m = { mode: "free", pov: { lat: 1, lng: 2, altitude: 2 } };
  c.onPreview(true);
  c.onPreview(true);
  c.onPreview(false);
  c.onPreview(false);
  assert.deepStrictEqual(got, [{ mode: "qth" }]);
  assert.ok(nh({ lat: 10, lng: 179.8 }, { lat: 10.2, lng: -179.9 }, 0.5));
  assert.ok(!nh({ lat: 10, lng: 0 }, { lat: 12, lng: 0 }, 0.5));
});

test("wiring: station button marks home; legend restores instead of snapping during a preview", () => {
  const mp = fs.readFileSync(path.join(__dirname, "../js/map.js"), "utf8");
  assert.match(mp, /globeCenterOn\(ll\.lat, ll\.lon, \{ home: true \}\)/);
  const pr = fs.readFileSync(path.join(__dirname, "../js/profile.js"), "utf8");
  assert.match(pr, /if \(!hadPreview && typeof window\.globeSnapTo === "function"\) window\.globeSnapTo\(h\.key\);/);
  const ix = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  assert.ok(ix.indexOf("js/preview-camera.js") > 0 && ix.indexOf("js/preview-camera.js") < ix.indexOf("js/globe-view.js"));
});
