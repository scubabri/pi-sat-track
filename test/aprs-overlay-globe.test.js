// APRS heard stations: the list js/aprs-overlay.js exposes for the 3D globe
// (window.aprsOverlay), with fading, expiry, toggle and position sources.
// Run: node --test --test-force-exit test/aprs-overlay-globe.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function load(lsInit) {
  const ls = Object.assign({}, lsInit || {});
  const events = [];
  const handlers = {};
  const ctx = {
    console, Date, Math, Number, JSON, Set, Map, String, Array, Object,
    Event: class { constructor(t) { this.type = t; } },
    localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); } },
    document: { readyState: "complete", dispatchEvent: (e) => events.push(e.type), addEventListener() {}, querySelector: () => null },
    setInterval: () => 0,
    clearInterval() {},
    APRS: { on: (t, fn) => { handlers[t] = fn; }, heard: null, status: null },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/aprs-overlay.js"), "utf8"), ctx);
  return { ctx, events, handlers, ls };
}

const MIN = 60000;
function payload(now) {
  return {
    type: "aprs-heard",
    expireMs: 60 * MIN,
    now,
    stations: [
      { call: "N0SAT", symbol: "/`", lat: 39.74, lon: -104.98, posSource: "aprs", lastHeard: now - 2 * MIN, viaSat: true, recent: [] },
      { call: "DL7NDR", lat: 40.69, lon: -111.96, posSource: "grid", grid: "DN40aq", lastHeard: now - 5 * MIN, recent: [] },
      { call: "K0TEST", lat: 40.5, lon: -111, posSource: "self", lastHeard: now - 1 * MIN, recent: [] },
      { call: "OLD1", lat: 1, lon: 2, posSource: "aprs", lastHeard: now - 61 * MIN, recent: [] },
    ],
  };
}

test("aprsOverlay.items: plottable stations, fading, expiry, source labels", () => {
  const { ctx, events, handlers } = load();
  const now = Date.now();
  assert.ok(handlers["aprs-heard"], "hooks the APRS hub");
  handlers["aprs-heard"](payload(now));
  assert.ok(events.includes("aprs-overlay-change"), "globe is notified");
  const items = ctx.aprsOverlay.items(now);
  assert.strictEqual(items.map((i) => i.call).join(","), "N0SAT,DL7NDR,K0TEST", "expired station dropped");
  const n = items[0];
  assert.strictEqual(n.viaSat, true);
  assert.strictEqual(n.posSource, "aprs");
  assert.strictEqual(n.grid, "", "real positions carry no sub-label");
  assert.strictEqual(items[1].grid, "grid");
  assert.strictEqual(items[2].grid, "you");
  assert.ok(items[1].opacity < n.opacity, "older is fainter");
  assert.match(items[1].tip, /grid DN40aq/);
});

test("APRS Heard toggle off -> globe list empty", () => {
  const { ctx, handlers } = load({ aprsOverlayOn: "0" });
  handlers["aprs-heard"](payload(Date.now()));
  assert.strictEqual(ctx.aprsOverlay.isOn(), false);
  assert.strictEqual(ctx.aprsOverlay.items().length, 0);
});

test("aprsOverlay.items carry the station's APRS symbol for the globe (dot when unknown)", () => {
  const { ctx, handlers } = load();
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/aprs-symbols.js"), "utf8"), ctx);
  const now = Date.now();
  handlers["aprs-heard"](payload(now));
  const items = ctx.aprsOverlay.items(now);
  assert.strictEqual(items[0].symbol, "/`");
  assert.strictEqual(items[1].symbol, "", "no symbol -> dot");
});
