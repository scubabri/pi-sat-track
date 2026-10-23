// Map Favorites "Footprints" sub-toggle (js/fav-overlay.js + lib/profiles.js):
// saved per station profile (favOverlay.footprints, default off); when on, a
// faint dashed footprint only for favorites up or rising within 15 min (no TLE
// -> none); when off, no favorite rings at all. Real js/fav-overlay.js with a
// fake Leaflet / DOM / socket.
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pst-favfp-"));
process.env.HOME = home;
fs.mkdirSync(path.join(home, ".rpitrack"), { recursive: true });
fs.writeFileSync(path.join(home, ".rpitrack", "profiles.json"), JSON.stringify({
  active: "A", profiles: { A: { favorites: ["ISS", "AO-7"], config: {}, favOverlay: { on: true, shown: null } }, B: { favorites: ["ISS"], config: {} } },
}));
const profiles = require("../lib/profiles");
profiles.load();

test("profiles: footprints default off, persisted per profile, partial patches keep it", () => {
  assert.deepStrictEqual(profiles.getActive().favOverlay, { on: true, shown: null });
  profiles.updateActive({ favOverlay: { footprints: true } });
  assert.deepStrictEqual(profiles.publicPayload().favOverlay, { on: true, shown: null, footprints: true });
  profiles.updateActive({ favOverlay: { on: false } });
  assert.strictEqual(profiles.getActive().favOverlay.footprints, true);
  const disk = JSON.parse(fs.readFileSync(profiles.PROFILES_FILE, "utf8"));
  assert.strictEqual(disk.profiles.A.favOverlay.footprints, true);
  assert(profiles.setActive("B"));
  assert.strictEqual(profiles.getActive().favOverlay, null);
  assert(profiles.setActive("A"));
  profiles.updateActive({ favOverlay: { footprints: false } });
  assert.deepStrictEqual(profiles.getActive().favOverlay, { on: false, shown: null });
});

function sandbox() {
  const store = { favOverlayOn: "1" };
  const listeners = {};
  const sent = [];
  const layers = new Set();
  function lay(kind, opts) {
    const o = { kind, options: Object.assign({}, opts), on() { return o; }, setStyle(s) { Object.assign(o.options, s); return o; },
      setLatLng() { return o; }, setRadius(r) { o.options.radius = r; return o; }, bringToFront() {}, addTo(g) { g.addLayer(o); return o; },
      bindTooltip() { return o; }, getTooltip() { return null; } };
    return o;
  }
  const group = { addLayer: (l) => layers.add(l), removeLayer: (l) => layers.delete(l), addTo() { return group; } };
  let onMap = false;
  const map = { hasLayer: () => onMap, removeLayer: () => { onMap = false; }, on() {}, getContainer: () => null };
  group.addTo = () => { onMap = true; return group; };
  const L = { layerGroup: () => group, polyline: (p, o) => lay("line", o), circleMarker: (p, o) => lay("dot", o), circle: (p, o) => lay("circle", o), DomEvent: { stopPropagation() {} } };
  const ws = { readyState: 1, addEventListener: (t, f) => (listeners[t] = listeners[t] || []).push(f), send: (m) => sent.push(JSON.parse(m)) };
  const bar = { kids: [], querySelector: (s) => (s === ".sched-open-btn" ? {} : s === ".fav-overlay-btn" ? bar.kids[0] || null : null), insertBefore(c) { bar.kids.push(c); } };
  function mkEl() {
    const cls = new Set(); const ls = {};
    return { cls, style: {}, attrs: {}, set className(v) { String(v).split(/\s+/).forEach((c) => c && cls.add(c)); }, classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
      setAttribute(k, v) { this.attrs[k] = v; }, addEventListener: (t, f) => (ls[t] = f), click() { ls.click({ preventDefault() {}, stopPropagation() {}, target: null }); } };
  }
  const intervals = [];
  const sb = {
    console, Math, Date, JSON, Number, String, Array, Object, Set, Map, isFinite,
    setInterval: (fn) => { intervals.push(fn); return intervals.length; }, clearInterval() {},
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => (store[k] = String(v)) },
    CustomEvent: function (t, i) { this.type = t; this.detail = i && i.detail; },
    L, map, ws, footprintRadiusM: (h) => h * 1000,
    favColor: () => "#ff0000",
    document: { readyState: "complete", addEventListener() {}, dispatchEvent() {}, querySelector: (s) => (s === ".decode-toggle-control" ? bar : null), createElement: mkEl, getElementById: () => null },
  };
  sb.window = sb;
  sb.window.matchMedia = () => ({ matches: false });
  sb.addEventListener = () => {};
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "fav-overlay.js"), "utf8"), sb);
  intervals.forEach((f) => f()); intervals.forEach((f) => f());
  const emit = (o) => (listeners.message || []).forEach((f) => f({ data: JSON.stringify(o) }));
  const circles = () => [...layers].filter((l) => l.kind === "circle");
  return { emit, sent, circles, bar, store };
}

const now = Date.now();
const pos = { lat: 40, lon: -100, heightKm: 500 };
const favs = [
  { key: "UP", position: pos, look: { el: 20 } },
  { key: "SOON", position: pos, look: { el: -30 }, nextPass: { aos: now + 10 * 60e3 } }, // server sends epoch ms
  { key: "LATER", position: pos, look: { el: -30 }, nextPass: { aos: now + 60 * 60e3 } },
  { key: "SOONISO", position: pos, look: { el: -30 }, nextPass: { aos: new Date(now + 5 * 60e3).toISOString() } },
  { key: "NOTLE", position: null, look: null },
  { key: "SEL", position: pos, look: { el: 30 } },
];
const tracks = favs.map((f) => ({ key: f.key, trail: [], forward: [] }));

test("Footprints button sits right below Favorites with the standard toggle class", () => {
  const s = sandbox();
  const [fav, fp] = s.bar.kids;
  assert(fav.cls.has("fav-overlay-btn"));
  assert(fp.cls.has("decode-toggle-btn") && fp.cls.has("fav-fp-btn"));
  assert.strictEqual(fp.textContent, "Footprints");
  assert(!fp.cls.has("active"), "default off");
});

test("off: no favorite rings; on: faint dashed rings only for up / rising <15 min", () => {
  const s = sandbox();
  s.emit({ type: "profiles", active: "A", favOverlay: { on: true, shown: null } });
  s.emit({ type: "fav-tracks", current: "SEL", tracks });
  s.emit({ type: "state", sat: "SEL", favorites: favs });
  assert.strictEqual(s.circles().length, 0, "off -> clean map");
  s.emit({ type: "profiles", active: "A", favOverlay: { on: true, shown: null, footprints: true } });
  const c = s.circles();
  assert.strictEqual(c.length, 3, "UP + SOON + SOONISO only (LATER too far, NOTLE no position, SEL drawn by map.js)");
  for (const x of c) {
    // A bit stronger than the first cut (fill .04 / outline .28), still under the selected (fill .06 / .55 solid).
    assert(x.options.fillOpacity > 0.04 && x.options.fillOpacity < 0.06, "fill " + x.options.fillOpacity);
    assert(x.options.opacity > 0.28 && x.options.opacity < 0.55 && x.options.dashArray, "outline " + x.options.opacity);
  }
  assert(s.bar.kids[1].cls.has("active"));
  // Clicking turns it off, saves to the profile, removes the rings.
  s.bar.kids[1].click();
  assert.strictEqual(s.circles().length, 0);
  assert.deepStrictEqual(s.sent.filter((m) => m.type === "fav-overlay-set").pop(), { type: "fav-overlay-set", footprints: false });
  assert.strictEqual(s.store.favOverlayOnFp, "0");
});
