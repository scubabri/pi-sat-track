// Globe favorites' labels behave like the 2D map's (js/fav-overlay.js): a
// name-only label next to every shown favorite, expanded in place to the map's
// full selected-sat content (selSatLabelHtml) while the dot or label is
// hovered, "NAME @ HH:MM" during a pass preview, other labels dimmed, the
// selected sat keeping its own full label, and the hover ending on mouse leave
// or when the sat goes behind the globe. Real js/globe-view.js with a fake
// globe.gl and DOM; selSatLabelHtml / satDotLabelLines taken from js/map.js and
// js/pass-ui.js. Run: node --test --test-force-exit test/globe-fav-labels.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function el(tag) {
  const ls = {};
  const cls = new Set();
  const e = {
    tagName: tag, style: {}, hidden: false, clientWidth: 800, clientHeight: 600, children: [], dataset: {}, parentElement: null, isConnected: true,
    _html: "", get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); },
    get textContent() { return this._html.replace(/<br>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&"); }, set textContent(v) { this._html = String(v); },
    get className() { return [...cls].join(" "); }, set className(v) { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => cls.add(c)); },
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), toggle: (c, on) => { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c); }, contains: (c) => cls.has(c) },
    appendChild(c) { c.parentElement = this; this.children.push(c); return c; }, insertBefore(c) { return this.appendChild(c); },
    remove() {}, addEventListener(t, fn) { (ls[t] = ls[t] || []).push(fn); }, removeEventListener() {},
    setAttribute() {}, querySelector: () => null, querySelectorAll: () => [], getContext: () => ({}),
    closest(sel) { const c = sel.replace(/^\./, ""); for (let n = this; n; n = n.parentElement) if (n.classList.contains(c)) return n; return null; },
    dispatch(t, ev) { for (const fn of ls[t] || []) fn(Object.assign({ stopPropagation() {}, clientX: 0, clientY: 0 }, ev)); },
  };
  return e;
}

function sandbox() {
  const store = { mapView: "globe", favOverlayOn: "1" };
  let pov = { lat: 40, lng: -105, altitude: 2.2 };
  let htmlFn = null;
  const made = new Map(); // datum -> element
  const chain = new Proxy({}, {
    get(o, k) {
      if (k === "pointOfView") return (p) => { if (!p) return Object.assign({}, pov); pov = Object.assign({}, pov, p); return chain; };
      if (k === "controls") return () => ({ addEventListener() {} });
      if (k === "renderer") return () => ({ setPixelRatio() {} });
      if (k === "scene") return () => ({ children: [], add() {}, remove() {}, traverse() {} });
      if (k === "htmlElement") return (fn) => { htmlFn = fn; return chain; };
      if (k === "htmlElementsData") return (list) => { for (const d of list) if (!made.has(d)) { const e = htmlFn(d); globeEl.appendChild(e); made.set(d, e); } return chain; };
      if (k === "then") return undefined;
      return () => chain;
    },
  });
  const host = el("div");
  let globeEl = null;
  const intervals = [];
  const sb = {
    console, Math, Date, JSON, Number, String, Array, Object, Set, Map, Promise, Infinity, isFinite, Proxy, RegExp,
    devicePixelRatio: 1,
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => (store[k] = String(v)), removeItem: (k) => delete store[k] },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    Globe: () => (e) => { globeEl = e; return chain; },
    WebGLRenderingContext: function () {},
    ws: { readyState: 1, send() {}, addEventListener(t, fn) { if (t === "message") sb.__wsMsg.push(fn); } },
    loadConfig: () => ({ grid: "DN40AA", callsign: "K0TEST" }),
    maidenheadToLatLon: () => ({ lat: 40, lon: -105 }),
    formatClockShort: (t) => new Date(t).toISOString().slice(11, 16),
    formatPassTime: (t) => new Date(t).toISOString().slice(11, 19) + " UTC",
    formatCountdownClock: (s) => { s = Math.round(s); return String(Math.floor(s / 3600)).padStart(2, "0") + ":" + String(Math.floor(s / 60) % 60).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); },
    isFavOverlayOn: () => true,
    __wsMsg: [],
  };
  const docLs = {};
  let under = null; // element under the (still) pointer
  sb.document = {
    readyState: "complete", hidden: false, body: el("body"),
    getElementById: (id) => (id === "map" ? host : null),
    createElement: (t) => el(t),
    addEventListener: (t, fn) => (docLs[t] = docLs[t] || []).push(fn),
    querySelector: () => null, querySelectorAll: () => [],
    dispatchEvent: (e) => { for (const fn of docLs[e.type] || []) fn(e); },
    elementFromPoint: () => under,
  };
  sb.window = sb;
  sb.addEventListener = () => {};
  vm.createContext(sb);
  const mapSrc = fs.readFileSync(path.join(__dirname, "../js/map.js"), "utf8");
  const uiSrc = fs.readFileSync(path.join(__dirname, "../js/pass-ui.js"), "utf8");
  const fn = (src, name) => src.match(new RegExp("function " + name + "\\([\\s\\S]*?\\n\\}"))[0];
  vm.runInContext([fn(mapSrc, "escHtmlMap"), fn(mapSrc, "selSatLabelHtml"), fn(uiSrc, "satDotLabelLines")].join("\n") + "\nvar currentSatKey = 'ISS';", sb);
  for (const f of ["preview-camera.js", "pass-preview.js", "globe-view.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), sb);
  const tick = (ms) => intervals.filter((x) => x.ms === ms).forEach((x) => x.fn());
  const now = Date.now();
  const iso = (t) => new Date(t).toISOString();
  const fav = (key, lat, lon, aosIn) => ({ key, display: key, position: { lat, lon, heightKm: 800 }, look: { el: -10, rangeKm: 5000 }, passes: [{ aos: iso(now + aosIn), los: iso(now + aosIn + 600000) }] });
  const stateMsg = { type: "state", sat: "ISS", display: "ISS", position: { lat: 10, lon: 20, heightKm: 420 }, look: { el: 5, rangeKm: 2000 }, passes: [],
    favorites: [fav("ISS", 10, 20, 3600000), fav("SO-50", 30, -90, 1800000), fav("AO-7", -20, 60, 7200000)] };
  const send = (msg) => { for (const f of sb.__wsMsg) f({ data: JSON.stringify(msg) }); };
  const dot = (key) => { for (const [d, e] of made) if (d.kind === "dot" && d.key === key) return e; return null; };
  const label = (key) => dot(key).__favLabel;
  return { sb, tick, send, stateMsg, dot, label, globe: () => globeEl, setUnder: (e) => (under = e) };
}
const ready = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
async function loaded() {
  const s = sandbox();
  await ready();
  s.tick(500); // patchWs
  s.send(s.stateMsg);
  return s;
}
const mapFull = (s, f, pT) => s.sb.selSatLabelHtml(f, pT); // the map's own label HTML

test("default: every non-selected favorite shows its name only; the selected sat has no fav label", async () => {
  const s = await loaded();
  assert.strictEqual(s.label("SO-50").innerHTML, "SO-50");
  assert.strictEqual(s.label("AO-7").innerHTML, "AO-7");
  assert.strictEqual(s.label("SO-50").hidden, false);
  assert.ok(!s.label("SO-50").classList.contains("fav-full"));
  assert.strictEqual(s.label("ISS").hidden, true, "selected sat: its own full label instead");
});

test("hover (dot or its label) expands to the map's full content; others dim; leave reverts", async () => {
  const s = await loaded();
  s.dot("SO-50").dispatch("mouseenter");
  const lab = s.label("SO-50");
  const f = s.stateMsg.favorites[1];
  assert.strictEqual(lab.innerHTML, mapFull(s, f, null), "same HTML as the map's hovered fav label");
  assert.match(lab.textContent, /^SO-50\nAOS \d\d:\d\d:\d\d\n\d\d:\d\d:\d\d UTC\nEl -10°\nRng 5000 km\nAlt 800 km$/);
  assert.ok(lab.classList.contains("fav-full") && lab.classList.contains("fav-hi"));
  assert.ok(s.label("AO-7").classList.contains("fav-dim"), "other favorites dimmed");
  assert.strictEqual(s.label("AO-7").innerHTML, "AO-7");
  s.dot("SO-50").dispatch("mouseleave");
  assert.strictEqual(lab.innerHTML, "SO-50");
  assert.ok(!lab.classList.contains("fav-full") && !s.label("AO-7").classList.contains("fav-dim"));
});

test("pass preview: hover shows the map's 'NAME @ HH:MM'; labels stay name-only otherwise", async () => {
  const s = await loaded();
  const T = Date.now() + 3 * 3600000;
  s.sb.passPreview.set(T);
  s.send({ type: "preview", t: T, current: "ISS", sats: [{ key: "ISS", position: { lat: 1, lon: 2, heightKm: 420 } }, { key: "SO-50", position: { lat: 3, lon: 4, heightKm: 800 } }] });
  assert.ok(s.sb.passPreview.posOf("SO-50"), "preview reply applied");
  assert.strictEqual(s.label("SO-50").innerHTML, "SO-50");
  s.dot("SO-50").dispatch("mouseenter");
  assert.strictEqual(s.label("SO-50").innerHTML, "SO-50 @ " + s.sb.formatClockShort(T));
  assert.strictEqual(s.label("SO-50").innerHTML, mapFull(s, s.stateMsg.favorites[1], T), "same as the map");
  s.dot("SO-50").dispatch("mouseleave");
  assert.strictEqual(s.label("SO-50").innerHTML, "SO-50");
});

test("still pointer while the globe turns: hover follows what's under it; behind the globe clears it", async () => {
  const s = await loaded();
  s.globe().dispatch("pointermove", { clientX: 100, clientY: 100, pointerType: "mouse" });
  s.setUnder(s.label("AO-7")); // AO-7's label rotated under the pointer
  s.tick(200);
  assert.ok(s.label("AO-7").classList.contains("fav-full"), "hovered without a mouse move");
  s.setUnder(null);
  s.tick(200);
  assert.strictEqual(s.label("AO-7").innerHTML, "AO-7", "rotated away: back to the name");
  // hovered, then the sat goes behind the globe (globe.gl: display none)
  s.dot("SO-50").dispatch("mouseenter");
  s.setUnder(s.dot("SO-50"));
  s.dot("SO-50").style.display = "none";
  s.tick(1000);
  assert.strictEqual(s.label("SO-50").innerHTML, "SO-50");
  assert.ok(!s.label("AO-7").classList.contains("fav-dim"));
  // leaving the globe clears a hover
  s.dot("SO-50").style.display = "";
  s.dot("AO-7").dispatch("mouseenter");
  s.globe().dispatch("pointerleave");
  assert.strictEqual(s.label("AO-7").innerHTML, "AO-7");
});

test("hovering the selected sat does nothing (it already has its full label)", async () => {
  const s = await loaded();
  s.dot("ISS").dispatch("mouseenter");
  assert.ok(!s.label("SO-50").classList.contains("fav-dim"));
  assert.strictEqual(s.label("ISS").hidden, true);
});

test("CSS: label takes the pointer with slop; dot has slop", () => {
  const css = fs.readFileSync(path.join(__dirname, "../css/decode-overlay.css"), "utf8");
  assert.match(css, /\.globe-label\.globe-fav-label \{[^}]*pointer-events: auto/);
  assert.match(css, /\.globe-label\.globe-fav-label::before \{ content: ""; position: absolute; inset: -4px -5px; \}/);
  assert.match(css, /\.globe-dot::before \{ content: ""; position: absolute; inset: -5px; \}/);
});
