// Globe favorite footprints follow the map's Footprints sub-toggle
// (js/fav-overlay.js): one dim fill + ring group per favorite that is up or
// rising soon (window.favFootprintNear), none for the selected sat / Moon / no
// position, moved as the sats move, disposed when the toggle goes off or the
// favorite leaves the list; always dimmer than the selected sat's footprint.
// Real js/globe-view.js with a fake globe.gl + minimal three.js stand-ins.
// Run: node --test --test-force-exit test/globe-fav-footprints.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function el(tag) {
  const cls = new Set();
  return {
    tagName: tag, style: {}, hidden: false, clientWidth: 800, clientHeight: 600, children: [], dataset: {}, isConnected: true, innerHTML: "", textContent: "",
    get className() { return [...cls].join(" "); }, set className(v) { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => cls.add(c)); },
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), toggle: (c, on) => { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c); }, contains: (c) => cls.has(c) },
    appendChild(c) { this.children.push(c); return c; }, insertBefore(c) { return this.appendChild(c); },
    remove() {}, addEventListener() {}, removeEventListener() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [], getContext: () => ({}), closest: () => null,
  };
}

// --- minimal three.js stand-ins (globe-view borrows constructors from the globe mesh) ---
class V3 { constructor(x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; } normalize() { const l = Math.hypot(this.x, this.y, this.z) || 1; this.x /= l; this.y /= l; this.z /= l; return this; } }
class Quat { constructor() { this.v = null; } setFromUnitVectors(a, b) { this.v = [b.x, b.y, b.z]; return this; } copy(q) { this.v = q.v; return this; } }
class Object3D {
  constructor() { this.children = []; this.parent = null; this.visible = true; this.quaternion = new Quat(); this.name = ""; }
  add(c) { c.parent = this; this.children.push(c); }
  remove(c) { this.children = this.children.filter((x) => x !== c); c.parent = null; }
  updateMatrixWorld() {}
  traverse(fn) { fn(this); this.children.forEach((c) => c.traverse(fn)); }
}
class Mesh extends Object3D { constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; } }
let disposed = 0;
class SphereGeometry { constructor(...a) { this.args = a; } dispose() { disposed++; } }
class Color { constructor(c) { this.c = c; } set(c) { this.c = c; } }
class Mat { constructor(o) { Object.assign(this, o || {}); this.color = new Color(o && o.color); } dispose() { disposed++; } }

function sandbox() {
  const store = { mapView: "globe", favOverlayOn: "1" };
  const root = new Object3D();
  const gm = new Mat({});
  const gMesh = new Mesh(new SphereGeometry(100), gm);
  root.add(gMesh);
  const cam = { position: new V3(0, 0, 300), quaternion: new Quat() };
  const chain = new Proxy({}, {
    get(o, k) {
      if (k === "pointOfView") return (p) => (p ? chain : { lat: 0, lng: 0, altitude: 2.2 });
      if (k === "controls") return () => ({ addEventListener() {} });
      if (k === "renderer") return () => ({ setPixelRatio() {} });
      if (k === "scene") return () => root;
      if (k === "globeMaterial") return () => gm;
      if (k === "camera") return () => cam;
      if (k === "getGlobeRadius") return () => 100;
      if (k === "getCoords") return (lat, lng) => ({ x: lng, y: lat, z: 1 });
      if (k === "htmlElement") return () => chain;
      if (k === "then") return undefined;
      return () => chain;
    },
  });
  const intervals = [];
  const flags = { fav: true, fp: false, shown: null };
  const sb = {
    console: { log() {}, warn() {}, error: console.error }, Math, Date, JSON, Number, String, Array, Object, Set, Map, Promise, Infinity, isFinite, Proxy, RegExp,
    devicePixelRatio: 1,
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => (store[k] = String(v)), removeItem: (k) => delete store[k] },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    Globe: () => () => chain,
    WebGLRenderingContext: function () {},
    ws: { readyState: 1, send() {}, addEventListener(t, fn) { if (t === "message") sb.__wsMsg.push(fn); } },
    loadConfig: () => ({ grid: "AA00AA", callsign: "N0CALL" }),
    maidenheadToLatLon: () => ({ lat: 0, lon: 0 }),
    favColor: (k) => (k === "B" ? "#00ff00" : "#ff0000"),
    isFavOverlayOn: () => flags.fav,
    isFavFootprintsOn: () => flags.fp,
    favOverlayShown: () => flags.shown,
    favFootprintNear: (f) => !!(f.look && f.look.el >= -5),
    __wsMsg: [],
  };
  const docLs = {};
  sb.document = {
    readyState: "complete", hidden: false, body: el("body"),
    getElementById: () => el("div"), createElement: (t) => el(t),
    addEventListener: (t, fn) => (docLs[t] = docLs[t] || []).push(fn),
    querySelector: () => null, querySelectorAll: () => [],
    dispatchEvent: (e) => { for (const fn of docLs[e.type] || []) fn(e); },
    elementFromPoint: () => null,
  };
  sb.window = sb;
  sb.addEventListener = () => {};
  vm.createContext(sb);
  for (const f of ["preview-camera.js", "pass-preview.js", "globe-view.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), sb);
  const tick = (ms) => intervals.filter((x) => x.ms === ms).forEach((x) => x.fn());
  const send = (msg) => { for (const f of sb.__wsMsg) f({ data: JSON.stringify(msg) }); };
  const fire = (type) => sb.document.dispatchEvent(new sb.CustomEvent(type, {}));
  const groups = (name) => { const out = []; root.traverse((o) => { if (o.name === name) out.push(o); }); return out; };
  return { sb, tick, send, fire, flags, groups };
}
const ready = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const fav = (key, lat, lon, el, extra) => Object.assign({ key, display: key, position: { lat, lon, heightKm: 800 }, look: { el } }, extra || {});
const state = (favorites) => ({ type: "state", sat: "SEL", display: "SEL", position: { lat: 1, lon: 2, heightKm: 420 }, look: { el: 10 }, passes: [], favorites });

test("globe favorite footprints: toggle, selection rules, movement, cleanup, dim styling", async () => {
  const s = sandbox();
  await ready();
  s.tick(500); // patchWs
  const favs = [fav("SEL", 1, 2, 10), fav("A", 10, 20, 15), fav("B", -10, -40, 0), fav("FAR", 5, 5, -40), fav("MOON", 0, 0, 30, { isMoon: true }), { key: "NOTLE", position: null, look: null }];
  s.send(state(favs));
  assert.strictEqual(s.groups("sat-footprint").length, 1, "selected footprint built");
  assert.strictEqual(s.groups("fav-footprint").length, 0, "Footprints off: none");

  s.flags.fp = true;
  s.fire("fav-footprints-change");
  const gs = s.groups("fav-footprint");
  assert.strictEqual(gs.length, 2, "A + B only (not selected, Moon, below horizon, or without TLE)");
  assert.deepStrictEqual([...s.sb.__globeFavFp().keys()].sort(), ["A", "B"]);
  const sel = s.groups("sat-footprint")[0];
  const selFill = sel.children.find((c) => c.name === "sat-footprint-fill").material.opacity;
  const selRing = sel.children.find((c) => c.name === "sat-footprint-ring").material.opacity;
  for (const g of gs) {
    const f = g.children.find((c) => c.name === "fav-footprint-fill");
    const r = g.children.find((c) => c.name === "fav-footprint-ring");
    assert.ok(f.material.opacity < selFill / 2 && r.material.opacity < selRing / 1.5, "clearly dimmer than the selected footprint");
    assert.ok(f.renderOrder < 0 && f.renderOrder > -1, "after the night shell, before the selected footprint");
    assert.strictEqual(f.material.depthWrite, false);
    assert.ok(g.visible);
  }
  const a = s.sb.__globeFavFp().get("A");
  assert.strictEqual(a.fill.material.color.c, "#ff0000", "favorite's own color");
  assert.deepStrictEqual(a.group.quaternion.v.slice(0, 2).map((x) => Math.round(x * 1000)), [Math.round((20 / Math.hypot(20, 10, 1)) * 1000), Math.round((10 / Math.hypot(20, 10, 1)) * 1000)]);

  // Sats move: same group, reoriented (no rebuild per update).
  s.send(Object.assign(state([fav("SEL", 1, 2, 10), fav("A", 30, 40, 15), fav("B", -10, -40, 0)]), {}));
  s.fire("fav-footprints-change"); // forces an apply (state updates are throttled to 2 s)
  assert.strictEqual(s.sb.__globeFavFp().get("A"), a, "group reused");
  assert.strictEqual(Math.round(a.group.quaternion.v[0] * 1000), Math.round((40 / Math.hypot(40, 30, 1)) * 1000), "moved");

  // Favorite drops out of the list (sets / removed): its group is removed and disposed.
  const before = disposed;
  s.send(state([fav("SEL", 1, 2, 10), fav("A", 30, 40, 15), fav("B", -10, -40, -20)]));
  s.fire("fav-footprints-change");
  assert.deepStrictEqual([...s.sb.__globeFavFp().keys()], ["A"]);
  assert.strictEqual(s.groups("fav-footprint").length, 1);
  assert.ok(disposed >= before + 4, "geometry + material disposed");

  // Shown subset excludes A -> none.
  s.flags.shown = ["B"];
  s.fire("fav-overlay-change");
  assert.strictEqual(s.groups("fav-footprint").length, 0);
  s.flags.shown = null;
  s.fire("fav-overlay-change");
  assert.strictEqual(s.groups("fav-footprint").length, 1);

  // Toggle off -> all gone; Favorites overlay off -> none even with Footprints on.
  s.flags.fp = false;
  s.fire("fav-footprints-change");
  assert.strictEqual(s.groups("fav-footprint").length, 0);
  s.flags.fp = true; s.flags.fav = false;
  s.fire("fav-overlay-change");
  assert.strictEqual(s.groups("fav-footprint").length, 0);
  assert.strictEqual(s.groups("sat-footprint").length, 1, "selected footprint untouched");
});
