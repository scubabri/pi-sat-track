// Any sat selection (selector menu, catalog link, Favorites panel, legend,
// globe dot, server-side change) ends a pass preview like "Back to now", even
// re-picking the selected sat. Only a chart pass click keeps / sets one, and
// its own server echo must not clear it. Real js/sat-menu.js selectSatellite,
// js/pass-preview.js and js/profile.js chart listeners in one vm context.
// Run: node --test --test-force-exit test/selector-clears-preview.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const W = 1000, H = 120;
function makeSandbox() {
  const listeners = {};
  const ctx = new Proxy({}, {
    get: (o, k) => (k in o ? o[k] : k === "measureText" ? (t) => ({ width: String(t).length * 6 }) : () => {}),
    set: (o, k, v) => ((o[k] = v), true),
  });
  const canvas = {
    width: W, height: H, clientWidth: W, clientHeight: H, style: {}, parentElement: { clientWidth: W, clientHeight: H },
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H, x: 0, y: 0 }),
    addEventListener: (t, fn) => (listeners[t] = listeners[t] || []).push(fn),
    setPointerCapture() {},
  };
  const sent = [];
  const events = [];
  const store = {};
  const sb = {
    console, Math, Date, JSON, Number, String, Array, Object, Set, Map, Infinity, isFinite,
    devicePixelRatio: 1,
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => (store[k] = String(v)) },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    document: {
      getElementById: (id) => (id === "profile-canvas" ? canvas : null),
      addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
      dispatchEvent: (e) => events.push(e.type + ":" + (e.detail ? e.detail.t : "")),
    },
    SAT_SELECTED_COLOR: "#58a6ff", favColor: () => "#3fb950",
    formatClockShort: (t) => new Date(t).toISOString().slice(11, 16),
    WebSocket: { OPEN: 1 },
    ws: { readyState: 1, send: (d) => sent.push(JSON.parse(d)) },
    updateFineOffsetDisplay() {},
  };
  sb.window = sb;
  sb.addEventListener = () => {};
  sb.isFavOverlayOn = () => true;
  vm.createContext(sb);
  for (const f of ["sat-menu.js", "pass-preview.js", "profile.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), sb);
  vm.runInContext("currentSatKey = 'ISS'; profileCanvas = document.getElementById('profile-canvas'); profileCtx = profileCanvas.getContext('2d'); initFavProfileEvents(); initChartPreviewEvents();", sb);
  const fire = (type, x, y) => {
    const e = { clientX: x, clientY: y, pointerId: 1, button: 0, preventDefault() {}, stopPropagation() {} };
    for (const fn of listeners[type] || []) fn(e);
  };
  const clickAt = (x, y) => { fire("pointermove", x, y); fire("pointerdown", x, y); fire("pointerup", x, y); fire("click", x, y); };
  const selects = () => sent.filter((m) => m.type === "sat").map((m) => m.key);
  return { sb, clickAt, selects, events, pp: () => sb.passPreview, cur: () => vm.runInContext("currentSatKey", sb) };
}
function series(now) {
  const pass = (aos, maxEl) => {
    const pts = [];
    for (let m = 0; m <= 10; m++) pts.push([aos + m * 60000, maxEl * Math.sin((Math.PI * m) / 10)]);
    return { aos, los: aos + 600000, maxEl, pts };
  };
  return { type: "fav-profile", current: "ISS", sats: [
    { key: "ISS", display: "ISS", passes: [pass(now + 3 * 3600000, 60)] },
    { key: "SO-50", display: "SO-50", passes: [pass(now + 9 * 3600000, 45)] },
  ] };
}

test("selector pick of another sat clears the preview (Back to now)", () => {
  const s = makeSandbox();
  s.pp().set(Date.now() + 3600000);
  assert.ok(s.pp().get() != null);
  s.sb.selectSatellite("AO-7", "AO-7"); // sat menu / Favorites panel / catalog link / globe dot
  assert.strictEqual(s.pp().get(), null, "preview cleared");
  assert.ok(s.events.includes("pass-preview-change:null"), "map / globe / polar / chart redraw live");
  assert.deepStrictEqual(s.selects(), ["AO-7"]);
});

test("re-picking the already-selected sat also clears it", () => {
  const s = makeSandbox();
  s.pp().set(Date.now() + 3600000);
  s.sb.selectSatellite("ISS", "ISS");
  assert.strictEqual(s.pp().get(), null);
});

test("chart click on another sat's pass keeps the preview at the clicked point; its server echo keeps it", () => {
  const s = makeSandbox();
  const now = Date.now();
  s.sb.__fp = series(now);
  vm.runInContext("favProfileData = __fp; drawFavProfile();", s.sb);
  const a = JSON.parse(JSON.stringify(vm.runInContext("favProfileHits.arcs", s.sb).find((x) => x.key === "SO-50")));
  s.clickAt(a.pts[2][0], a.pts[2][1]);
  assert.deepStrictEqual(s.selects(), ["SO-50"], "selected once");
  assert.strictEqual(s.cur(), "SO-50");
  const T = s.pp().get();
  assert.ok(T != null && Math.abs(T - a.ts[2]) < 20000, "preview at the clicked point");
  s.pp().onServerSat("SO-50"); // tracker: state for the new sat (echo of this click)
  assert.strictEqual(s.pp().get(), T, "own echo keeps the preview");
  // A later selection from another client / Auto Select ends it.
  s.pp().onServerSat("RS-44");
  assert.strictEqual(s.pp().get(), null);
});

test("server-side selection (other client / Auto Select) clears a preview", () => {
  const s = makeSandbox();
  s.pp().set(Date.now() + 3600000);
  s.pp().onServerSat("JO-97");
  assert.strictEqual(s.pp().get(), null);
});

test("wiring: tracker reports sat changes; legend clears; chart path passes keepPreview", () => {
  const tr = fs.readFileSync(path.join(__dirname, "../js/tracker.js"), "utf8");
  assert.ok(/if \(msg\.sat !== lastStateSat\) \{[\s\S]{0,400}passPreview\.onServerSat\(msg\.sat\)/.test(tr));
  const pr = fs.readFileSync(path.join(__dirname, "../js/profile.js"), "utf8");
  assert.ok(/selectSatellite\(h\.key, h\.display, \{ keepPreview: true \}\)/.test(pr));
});
