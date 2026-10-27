// WSJT-X list legend = category filters; hidden kinds leave the list AND the
// map / globe dots; persisted in localStorage "wsjtxKindFilter"; default all on.
// Run: node --test --test-force-exit test/wsjtx-kind-filter.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function load(ls) {
  const store = Object.assign({}, ls || {});
  const events = [];
  const ctx = {
    console, Date, Math, Number, JSON, Set, Map, String, Array, Object,
    Event: class { constructor(t) { this.type = t; } },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    document: { readyState: "complete", dispatchEvent: (e) => events.push(e.type), addEventListener() {} },
    setInterval: () => 0, clearInterval() {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/decode-overlay.js"), "utf8"), ctx);
  const now = Date.now();
  ctx.applyDecodeOverlay({ type: "wsjtx-decodes", expireMs: 60000, now, stations: [
    { call: "M1", kind: "me", grid: "FN42", lat: 42.5, lon: -71, lastHeard: now - 5000 },
    { call: "C1", kind: "cq", grid: "FN31", lat: 41.5, lon: -73, lastHeard: now - 5000 },
    { call: "O1", kind: "other", grid: "EM12", lat: 32.5, lon: -97, lastHeard: now - 5000 },
    { call: "O2", kind: "other", grid: "", lat: null, lon: null, lastHeard: now - 5000 },
  ] });
  return { ctx, store, events, now };
}
const calls = (a) => a.map((x) => x.call).join(",");

test("default: all categories shown", () => {
  const { ctx, now } = load();
  for (const k of ["me", "cq", "other"]) assert.strictEqual(ctx.decodeOverlay.kindShown(k), true);
  assert.strictEqual(calls(ctx.decodeOverlay.list(now)), "M1,C1,O1,O2");
  assert.strictEqual(calls(ctx.decodeOverlay.items(now)), "M1,C1,O1");
});

test("toggling a category hides it from list AND map / globe items, persists, notifies", () => {
  const { ctx, store, events, now } = load();
  ctx.decodeOverlay.toggleKind("other");
  assert.strictEqual(calls(ctx.decodeOverlay.list(now)), "M1,C1");
  assert.strictEqual(calls(ctx.decodeOverlay.items(now)), "M1,C1");
  assert.strictEqual(ctx.decodeOverlay.hiddenCount(now), 2);
  assert.deepStrictEqual(JSON.parse(store.wsjtxKindFilter), { me: true, cq: true, other: false });
  assert.ok(events.includes("decode-overlay-change"), "globe redraws");
  assert.ok(events.includes("decode-overlay-filter"), "list legend redraws");
  ctx.decodeOverlay.toggleKind("me");
  assert.strictEqual(calls(ctx.decodeOverlay.items(now)), "C1");
  ctx.decodeOverlay.toggleKind("other");
  assert.strictEqual(calls(ctx.decodeOverlay.list(now)), "C1,O1,O2");
});

test("saved filter restored on load; bad JSON = all shown", () => {
  const { ctx, now } = load({ wsjtxKindFilter: JSON.stringify({ me: true, cq: false, other: true }) });
  assert.strictEqual(ctx.decodeOverlay.kindShown("cq"), false);
  assert.strictEqual(calls(ctx.decodeOverlay.list(now)), "M1,O1,O2");
  const b = load({ wsjtxKindFilter: "{oops" });
  assert.strictEqual(calls(b.ctx.decodeOverlay.items(b.now)), "M1,C1,O1");
});

test("list legend entries are buttons that toggle the filter, styled off + hide/show tooltip", () => {
  const src = fs.readFileSync(path.join(__dirname, "../js/wsjtx-list.js"), "utf8");
  assert.match(src, /<button type="button" class="wsjtx-lg" data-kind="/);
  assert.match(src, /toggleKind\(lg\.dataset\.kind\)/);
  assert.match(src, /classList\.toggle\("off", !on\)/);
  assert.match(src, /Click to " \+ \(on \? "hide" : "show"\)/);
  const css = fs.readFileSync(path.join(__dirname, "../css/decode-overlay.css"), "utf8");
  assert.match(css, /\.wsjtx-lg\.off \{[^}]*line-through/);
  const g = fs.readFileSync(path.join(__dirname, "../js/globe-view.js"), "utf8");
  assert.match(g, /dov\.items\(\)/, "globe draws the filtered items()");
});
