// 24 h pass chart (js/profile.js) driven through its REAL event listeners with
// pointer / click events at actual curve pixels: a click on the selected sat's
// pass previews the clicked point and sends NO select; a click on another
// sat's pass selects it once and previews it at the clicked point (same
// action); a second click on it (now selected, even while the server's 24 h
// series still names the old sat) does not re-select. Drag scrubs.
// Run: node --test --test-force-exit test/pass-chart-click-events.test.js
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
  const parent = { clientWidth: W, clientHeight: H };
  const canvas = {
    width: W, height: H, clientWidth: W, clientHeight: H, style: {}, parentElement: parent,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H, x: 0, y: 0 }),
    addEventListener: (t, fn) => (listeners[t] = listeners[t] || []).push(fn),
    setPointerCapture() {},
  };
  const calls = { select: [], preview: [], snap: [] };
  let T = null;
  const sb = {
    console, Math, Date, JSON, Number, String, Array, Object, Set, Map, Infinity, isFinite,
    devicePixelRatio: 1,
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    localStorage: { getItem: () => null, setItem() {} },
    document: { getElementById: (id) => (id === "profile-canvas" ? canvas : null), addEventListener() {}, querySelector: () => null },
    SAT_SELECTED_COLOR: "#58a6ff",
    favColor: () => "#3fb950",
    formatClockShort: (t) => new Date(t).toISOString().slice(11, 16),
    currentSatKey: "ISS",
  };
  sb.window = sb;
  sb.addEventListener = () => {};
  sb.isFavOverlayOn = () => true;
  sb.selectSatellite = (k) => { calls.select.push(k); sb.currentSatKey = k; };
  sb.globeSnapTo = (k) => calls.snap.push(k);
  sb.passPreview = { get: () => T, set: (t, o) => { T = t; calls.preview.push({ t, o }); }, clear: () => { T = null; }, settle() {}, posOf: () => null };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/profile.js"), "utf8"), sb);
  // initChartPreviewEvents + initFavProfileEvents on our canvas (initProfile minus resize handle)
  vm.runInContext("profileCanvas = document.getElementById('profile-canvas'); profileCtx = profileCanvas.getContext('2d'); initFavProfileEvents(); initChartPreviewEvents();", sb);
  const fire = (type, x, y, extra) => {
    const e = Object.assign({ clientX: x, clientY: y, pointerId: 1, button: 0, preventDefault() {}, stopPropagation() {} }, extra);
    for (const fn of listeners[type] || []) fn(e);
  };
  const clickAt = (x, y) => { fire("pointermove", x, y); fire("pointerdown", x, y); fire("pointerup", x, y); fire("click", x, y); };
  return { sb, calls, fire, clickAt, listeners };
}

/** 24 h series: ISS + SO-50 10-min passes (1 min samples), server "current" = ISS. */
function series(now) {
  const pass = (aos, maxEl) => {
    const pts = [];
    for (let m = 0; m <= 10; m++) pts.push([aos + m * 60000, maxEl * Math.sin((Math.PI * m) / 10)]);
    return { aos, los: aos + 600000, maxEl, pts };
  };
  return {
    type: "fav-profile", current: "ISS",
    sats: [
      { key: "ISS", display: "ISS", passes: [pass(now + 3 * 3600000, 60)] },
      { key: "SO-50", display: "SO-50", passes: [pass(now + 9 * 3600000, 45)] },
    ],
  };
}
function arcOf(sb, key) {
  return JSON.parse(JSON.stringify(vm.runInContext("favProfileHits.arcs", sb).find((a) => a.key === key)));
}

test("click on the selected sat's pass: preview at the clicked point, no select request", () => {
  const { sb, calls, clickAt } = makeSandbox();
  const now = Date.now();
  sb.__fp = series(now);
  vm.runInContext("favProfileData = __fp; drawFavProfile();", sb);
  const a = arcOf(sb, "ISS");
  assert.ok(a.x1 - a.x0 < 12, "narrow spike on the 24 h chart (" + (a.x1 - a.x0).toFixed(1) + " px)");
  // a point low on the rising side (sample 1 → AOS + 1 min)
  clickAt(a.pts[1][0], a.pts[1][1]);
  assert.deepStrictEqual(calls.select, [], "no select / reload");
  assert.deepStrictEqual(calls.snap, [], "no live follow");
  assert.strictEqual(calls.preview.length, 1);
  const t = calls.preview[0].t;
  assert.ok(Math.abs(t - a.ts[1]) < 20000, "clicked point (AOS+1 min), got AOS+" + ((t - a.aos) / 1000).toFixed(0) + " s");
  assert.ok(t >= a.aos && t <= a.los);
});

test("click on another sat's pass: one select + preview at the clicked point; again → no re-select", () => {
  const { sb, calls, clickAt } = makeSandbox();
  const now = Date.now();
  sb.__fp = series(now);
  vm.runInContext("favProfileData = __fp; drawFavProfile();", sb);
  const a = arcOf(sb, "SO-50");
  clickAt(a.pts[8][0], a.pts[8][1]); // falling side, near LOS
  assert.deepStrictEqual(calls.select, ["SO-50"], "selected once");
  assert.deepStrictEqual(calls.snap, [], "not 'select + follow live'");
  assert.strictEqual(calls.preview.length, 1);
  assert.ok(Math.abs(calls.preview[0].t - a.ts[8]) < 20000, "preview at the clicked point");
  assert.ok(calls.preview[0].o && calls.preview[0].o.center, "globe centers on the preview position");
  // The server's 24 h series still says current = ISS (it refreshes on a 5 s poll):
  vm.runInContext("drawFavProfile();", sb);
  const a2 = arcOf(sb, "SO-50");
  clickAt(a2.pts[3][0], a2.pts[3][1]);
  assert.deepStrictEqual(calls.select, ["SO-50"], "no second select for the now-selected sat");
  assert.strictEqual(calls.preview.length, 2);
  assert.ok(Math.abs(calls.preview[1].t - a2.ts[3]) < 20000);
});

test("drag along the selected sat's pass scrubs the preview (no select)", () => {
  const { sb, calls, fire } = makeSandbox();
  const now = Date.now();
  sb.__fp = series(now);
  vm.runInContext("favProfileData = __fp; drawFavProfile();", sb);
  const a = arcOf(sb, "ISS");
  fire("pointerdown", a.pts[1][0], a.pts[1][1]);
  for (const i of [2, 3, 4]) fire("pointermove", a.pts[i][0], a.pts[i][1]);
  fire("pointerup", a.pts[4][0], a.pts[4][1]);
  fire("click", a.pts[4][0], a.pts[4][1]); // swallowed (end of drag)
  assert.deepStrictEqual(calls.select, []);
  const ts = calls.preview.map((p) => p.t);
  assert.ok(ts.length >= 3, "moved with the drag");
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i] >= ts[i - 1], "monotonic up the rising side");
  assert.ok(Math.abs(ts[ts.length - 1] - a.ts[4]) < 20000);
});

test("legend still selects + follows; blank chart previews the time under x", () => {
  const { sb, calls, clickAt } = makeSandbox();
  const now = Date.now();
  sb.__fp = series(now);
  vm.runInContext("favProfileData = __fp; drawFavProfile();", sb);
  const leg = JSON.parse(JSON.stringify(vm.runInContext("favProfileHits.legend", sb).find((l) => l.key === "SO-50")));
  clickAt(leg.x + 20, leg.y + leg.h / 2);
  assert.deepStrictEqual(calls.select, ["SO-50"]);
  assert.deepStrictEqual(calls.snap, ["SO-50"]);
  calls.preview.length = 0;
  const g = vm.runInContext("chartGeom", sb);
  const x = g.X(now + 15 * 3600000);
  clickAt(x, g.padT + g.plotH - 1);
  assert.strictEqual(calls.preview.length, 1);
  assert.ok(Math.abs(calls.preview[0].t - (now + 15 * 3600000)) < 120000);
});

test("a peak label drawn over another sat's pass does not steal clicks on that pass", () => {
  const { sb, calls, clickAt } = makeSandbox();
  const now = Date.now();
  const fp = series(now);
  // SO-50 pass right under ISS's peak label (same time, lower)
  fp.sats[1].passes = [Object.assign({}, fp.sats[0].passes[0], { maxEl: 60, pts: fp.sats[0].passes[0].pts.map(([t, el]) => [t + 30000, el * 1.08]) })];
  sb.__fp = fp;
  vm.runInContext("favProfileData = __fp; drawFavProfile();", sb);
  const lab = JSON.parse(JSON.stringify(vm.runInContext("favProfileHits.labels", sb)));
  const a = arcOf(sb, "SO-50");
  // the SO-50 curve point that sits inside a peak label box
  let hit = null;
  for (const p of a.pts) for (const l of lab) if (l.key !== "SO-50" && p[0] >= l.x && p[0] <= l.x + l.w && p[1] >= l.y && p[1] <= l.y + l.h) hit = hit || p;
  assert.ok(hit, "a label sits over the SO-50 curve");
  clickAt(hit[0], hit[1]);
  assert.deepStrictEqual(calls.select, ["SO-50"], "the pass under the click wins over the label");
});

test("legend checkbox hides one sat: its curves + peak labels go, others stay (also for the selected sat)", () => {
  const { sb, calls, clickAt, fire } = makeSandbox();
  const now = Date.now();
  sb.__fp = series(now);
  vm.runInContext("favProfileData = __fp; drawFavProfile();", sb);
  const keysOf = (what) => JSON.parse(JSON.stringify(vm.runInContext("favProfileHits." + what, sb))).map((a) => a.key);
  assert.deepStrictEqual(keysOf("labels").sort(), ["ISS", "SO-50"]);
  const box = (k) => JSON.parse(JSON.stringify(vm.runInContext("favProfileHits.legend", sb).find((l) => l.key === k)));
  // Uncheck SO-50 (not selected)
  let l = box("SO-50");
  fire("mousemove", l.x + 4, l.y + l.h / 2);
  clickAt(l.x + 4, l.y + l.h / 2);
  assert.ok(!keysOf("arcs").includes("SO-50") && !keysOf("labels").includes("SO-50"), "SO-50 curve + label gone");
  assert.ok(keysOf("arcs").includes("ISS") && keysOf("labels").includes("ISS"));
  assert.deepStrictEqual(keysOf("legend").sort(), ["ISS", "SO-50"], "hidden sat keeps its legend row");
  // Re-check SO-50, then uncheck the selected sat (ISS): only ISS goes
  l = box("SO-50");
  clickAt(l.x + 4, l.y + l.h / 2);
  l = box("ISS");
  fire("mousemove", l.x + 4, l.y + l.h / 2);
  clickAt(l.x + 4, l.y + l.h / 2);
  assert.strictEqual(vm.runInContext("favProfileHover", sb), null, "checkbox hover doesn't dim the others");
  assert.deepStrictEqual(keysOf("arcs"), ["SO-50"]);
  assert.deepStrictEqual(keysOf("labels"), ["SO-50"], "SO-50 label still drawn (not dimmed away)");
  assert.deepStrictEqual(calls.select, [], "checkbox clicks never select");
  assert.deepStrictEqual(calls.snap, []);
});

test("peak label uses the server's refined peak (tca / maxEl)", () => {
  const { sb } = makeSandbox();
  const now = Date.now();
  const fp = series(now);
  const p = fp.sats[0].passes[0];
  p.maxEl = 61.3;
  p.tca = p.aos + 290000;
  sb.__fp = fp;
  vm.runInContext("favProfileData = __fp; drawFavProfile();", sb);
  const lab = JSON.parse(JSON.stringify(vm.runInContext("favProfileHits.labels", sb))).find((x) => x.key === "ISS");
  assert.strictEqual(lab.t, p.tca);
});
