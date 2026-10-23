// Latest click wins for server-saved toggles (js/set-guard.js). Root cause:
// every "*-set" is answered with a "profiles" (and "state") broadcast; when a
// second click is sent before the first one's echo arrives, the echo carries
// the first click's value and flipped the toggle back (Footprints off -> on
// within ~0.5 s). Now each user set carries a seq, the server acks it to the
// sender after its broadcasts, and until then the echoed value is ignored and
// re-applied from the latest payload on ack (or after a timeout).
// Run: node --test --test-force-exit test/set-guard-race.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

function timers() {
  let t = 0; const q = [];
  return {
    setTimeout: (fn, ms) => { const h = { fn, at: t + ms, done: false }; q.push(h); return h; },
    clearTimeout: (h) => { if (h) h.done = true; },
    advance(ms) { t += ms; for (const h of q) if (!h.done && h.at <= t) { h.done = true; h.fn(); } },
  };
}

/** Real js/set-guard.js + js/fav-overlay.js with a fake Leaflet / DOM / socket. */
function favSandbox() {
  const tm = timers();
  const store = { favOverlayOn: "1" };
  const listeners = {};
  const sent = [];
  const group = { addLayer() {}, removeLayer() {}, addTo() { return group; } };
  const lay = () => { const o = { options: {}, on: () => o, setStyle: () => o, setLatLng: () => o, setRadius: () => o, bringToFront() {}, addTo: () => o, bindTooltip: () => o, getTooltip: () => null }; return o; };
  const L = { layerGroup: () => group, polyline: lay, circleMarker: lay, circle: lay, DomEvent: { stopPropagation() {} } };
  const map = { hasLayer: () => true, removeLayer() {}, on() {}, getContainer: () => null };
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
    setTimeout: tm.setTimeout, clearTimeout: tm.clearTimeout,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => (store[k] = String(v)) },
    CustomEvent: function (t, i) { this.type = t; this.detail = i && i.detail; },
    L, map, ws, footprintRadiusM: (h) => h * 1000, favColor: () => "#ff0000",
    document: { readyState: "complete", addEventListener() {}, dispatchEvent() {}, querySelector: (s) => (s === ".decode-toggle-control" ? bar : null), createElement: mkEl, getElementById: () => null },
  };
  sb.window = sb;
  sb.matchMedia = () => ({ matches: false });
  sb.addEventListener = () => {};
  vm.createContext(sb);
  vm.runInContext(rd("js/set-guard.js"), sb);
  vm.runInContext(rd("js/fav-overlay.js"), sb);
  intervals.forEach((f) => f()); intervals.forEach((f) => f());
  const emit = (o) => (listeners.message || []).forEach((f) => f({ data: JSON.stringify(o) }));
  const profiles = (fo) => emit({ type: "profiles", active: "A", favOverlay: fo });
  const sets = () => sent.filter((m) => m.type === "fav-overlay-set");
  return { sb, tm, emit, profiles, sets, fpBtn: () => bar.kids[1], favBtn: () => bar.kids[0] };
}

test("Footprints off -> on before the first echo: the stale 'off' echo no longer flips it back", () => {
  const s = favSandbox();
  s.profiles({ on: true, shown: null, footprints: true });
  assert.strictEqual(s.sb.isFavFootprintsOn(), true);
  s.fpBtn().click(); // off
  s.fpBtn().click(); // on again, before the server answered the first click
  const [a, b] = s.sets();
  assert.deepStrictEqual([a.footprints, b.footprints], [false, true]);
  assert.ok(Number.isFinite(a.seq) && b.seq > a.seq, "user sets carry an increasing seq");
  // Server processes "off": broadcast (stale for us) + ack to the sender.
  s.profiles({ on: true, shown: null });
  assert.strictEqual(s.sb.isFavFootprintsOn(), true, "stale echo ignored (was: flipped back off)");
  assert.ok(s.fpBtn().cls.has("active"));
  s.emit({ type: "set-ack", seq: a.seq });
  assert.strictEqual(s.sb.isFavFootprintsOn(), true, "re-applied payload is still the stale one, but 'on' is still pending");
  // Server processes "on".
  s.profiles({ on: true, shown: null, footprints: true });
  s.emit({ type: "set-ack", seq: b.seq });
  assert.strictEqual(s.sb.isFavFootprintsOn(), true);
  assert.ok(s.fpBtn().cls.has("active"));
});

test("on -> off -> on -> off: the last click wins; later server changes (other browser) still apply", () => {
  const s = favSandbox();
  s.profiles({ on: true, shown: null, footprints: false });
  for (let i = 0; i < 3; i++) s.fpBtn().click(); // on, off, on ... then one more
  s.fpBtn().click(); // off (4th)
  const seqs = s.sets().map((m) => m.seq);
  // Echoes arrive late and in order, interleaved with the acks.
  [true, false, true, false].forEach((v, i) => {
    s.profiles({ on: true, shown: null, footprints: v });
    assert.strictEqual(s.sb.isFavFootprintsOn(), false, "echo " + i + " ignored");
    s.emit({ type: "set-ack", seq: seqs[i] });
    assert.strictEqual(s.sb.isFavFootprintsOn(), false);
  });
  // Nothing pending: a change from another client applies as before.
  s.profiles({ on: true, shown: null, footprints: true });
  assert.strictEqual(s.sb.isFavFootprintsOn(), true);
});

test("Favorites on/off has the same guard; no ack (e.g. reconnect) -> server value after the timeout", () => {
  const s = favSandbox();
  s.profiles({ on: true, shown: null, footprints: false });
  s.favBtn().click(); // off
  s.favBtn().click(); // on
  s.profiles({ on: false, shown: null }); // stale echo of "off"
  assert.strictEqual(s.sb.isFavOverlayOn(), true);
  s.tm.advance(4000);
  assert.strictEqual(s.sb.isFavOverlayOn(), true);
  s.profiles({ on: false, shown: null }); // still un-acked: ignored, remembered
  s.tm.advance(1500); // guard gives up: latest server payload wins
  assert.strictEqual(s.sb.isFavOverlayOn(), false);
});

test("non-user payloads (profile switch, other clients) apply immediately as before", () => {
  const s = favSandbox();
  s.profiles({ on: true, shown: null, footprints: true });
  s.profiles({ on: true, shown: ["ISS"], footprints: false });
  assert.strictEqual(s.sb.isFavFootprintsOn(), false);
  assert.deepStrictEqual(s.sb.favOverlayShown(), ["ISS"]);
});

test("Auto Select (tracker.js): stale profiles / state values can't undo the latest click", () => {
  const tm = timers();
  const btn = { textContent: "", classList: { toggle() {} } };
  const sent = [];
  const sb = { console, JSON, Number, Map, isFinite, setTimeout: tm.setTimeout, clearTimeout: tm.clearTimeout,
    WebSocket: { OPEN: 1 }, ws: { readyState: 1, send: (m) => sent.push(JSON.parse(m)) },
    document: { getElementById: () => btn } };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(rd("js/set-guard.js"), sb);
  const src = rd("js/tracker.js");
  const block = src.slice(src.indexOf("let autoSelectOn = false;"), src.indexOf("function updateAntennaUi"));
  vm.runInContext(block.replace(/^let |^const /gm, "var "), sb);
  const on = () => vm.runInContext("autoSelectOn", sb);
  sb.applyServerAutoSelect(false);
  sb.sendAutoSelect(true);
  sb.sendAutoSelect(false);
  sb.sendAutoSelect(true);
  assert.strictEqual(on(), true);
  sb.applyServerAutoSelect(false); // 1 s state (afterLos) from before the clicks
  sb.applyServerAutoSelect(true); // echo of click 1
  sb.applyServerAutoSelect(false); // echo of click 2
  assert.strictEqual(on(), true, "held until the last click is acked");
  sb.autoSelectGuard.ack(sent[1].seq);
  assert.strictEqual(on(), true);
  sb.applyServerAutoSelect(true); // echo of click 3
  sb.autoSelectGuard.ack(sent[2].seq);
  assert.strictEqual(on(), true);
  sb.applyServerAutoSelect(false); // later change elsewhere applies
  assert.strictEqual(on(), false);
});

test("server acks every guarded set to the sender after its broadcasts", () => {
  const src = rd("server.js");
  for (const t of ["fav-overlay-set", "auto-select-set", "alerts-set"]) {
    const i = src.indexOf('msg.type === "' + t + '"');
    assert.ok(i > 0, t);
    const body = src.slice(i, src.indexOf("return;", i));
    assert.match(body, /broadcastProfiles\(\);[\s\S]*ackSet\(ws, msg\);\s*$/, t + ": ackSet after the broadcasts");
  }
  assert.match(src, /function ackSet\(ws, msg\) \{\s*if \(!msg \|\| !Number\.isFinite\(msg\.seq\)/);
  assert.match(rd("index.html"), /<script src="js\/set-guard\.js"><\/script>[\s\S]*js\/tracker\.js[\s\S]*js\/fav-overlay\.js[\s\S]*js\/pass-alerts\.js/);
});

test("pass alert bells (pass-alerts.js): rapid bell on/off isn't undone by the first echo", () => {
  const tm = timers();
  const sent = [];
  const docLs = {};
  const bell = { dataset: { alert: "sat", sat: "AO-7" }, classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, closest: (s) => (s.indexOf(".sat-alert") === 0 ? bell : null) };
  const sb = { console, JSON, Number, String, Array, Object, Set, Map, Math, Date, isFinite,
    setTimeout: tm.setTimeout, clearTimeout: tm.clearTimeout, setInterval() {},
    localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {} },
    ws: { readyState: 1, send: (m) => sent.push(JSON.parse(m)) }, loadFavorites: () => ["AO-7"],
    document: { readyState: "complete", addEventListener: (t, f) => (docLs[t] = f), getElementById: () => null, querySelectorAll: () => [], createElement: () => ({}) } };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(rd("js/set-guard.js"), sb);
  vm.runInContext(rd("js/pass-alerts-core.js"), sb);
  vm.runInContext(rd("js/pass-alerts.js"), sb);
  const click = () => docLs.click({ target: bell, preventDefault() {}, stopPropagation() {} });
  const on = () => sb.PassAlerts.getAlerts().sats.includes("AO-7");
  click(); // bell on
  click(); // bell off, before the first echo
  assert.strictEqual(on(), false);
  const [a, b] = sent.filter((m) => m.type === "alerts-set");
  sb.PassAlerts.onProfiles({ type: "profiles", alerts: a.alerts }); // stale echo (bell on)
  assert.strictEqual(on(), false, "stale echo ignored");
  sb.PassAlerts.onAck(a.seq);
  sb.PassAlerts.onProfiles({ type: "profiles", alerts: b.alerts });
  sb.PassAlerts.onAck(b.seq);
  assert.strictEqual(on(), false);
  sb.PassAlerts.onProfiles({ type: "profiles", alerts: a.alerts }); // later change from another browser
  assert.strictEqual(on(), true);
});
