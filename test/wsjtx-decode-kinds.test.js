// WSJT-X decode classification for map colors: calling us / CQ-73 / other.
// Run: node --test --test-force-exit test/wsjtx-decode-kinds.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { classifyDecode, parseDecodeText, createStore } = require("../lib/wsjtx-decodes");

const ME = "N0CALL";
test("classifyDecode kinds", () => {
  const k = (t, me) => { const c = classifyDecode(t, me === undefined ? ME : me); return c && c.call + ":" + c.kind + ":" + c.grid; };
  assert.strictEqual(k("CQ K1ABC FN42"), "K1ABC:cq:FN42");
  assert.strictEqual(k("CQ SAT K1ABC FN42"), "K1ABC:cq:FN42");
  assert.strictEqual(k("CQ K1ABC"), "K1ABC:cq:");
  assert.strictEqual(k("QRZ K1ABC FN42"), "K1ABC:cq:FN42");
  assert.strictEqual(k("N0CALL K1ABC FN42"), "K1ABC:me:FN42");
  assert.strictEqual(k("N0CALL K1ABC -12"), "K1ABC:me:");
  assert.strictEqual(k("N0CALL K1ABC RR73"), "K1ABC:me:", "73 to us is still 'calling us'");
  assert.strictEqual(k("<N0CALL/P> K1ABC R-05"), "K1ABC:me:", "compound / hashed own call");
  assert.strictEqual(k("W9XYZ K1ABC RR73"), "K1ABC:cq:");
  assert.strictEqual(k("W9XYZ K1ABC 73"), "K1ABC:cq:");
  assert.strictEqual(k("W9XYZ K1ABC FN42"), "K1ABC:other:FN42");
  assert.strictEqual(k("W9XYZ K1ABC R-10"), "K1ABC:other:");
  assert.strictEqual(k("K1ABC N0CALL FN31"), null, "our own TX");
  assert.strictEqual(k("N0CALL K1ABC FN42", ""), "K1ABC:other:FN42", "no callsign configured: nothing is 'me'");
  assert.strictEqual(k("TNX 73 GL"), null);
});

test("parseDecodeText keeps its old contract (grid required)", () => {
  assert.deepStrictEqual(parseDecodeText("W9XYZ K1ABC FN42"), { call: "K1ABC", grid: "FN42", to: "W9XYZ" });
  assert.strictEqual(parseDecodeText("W9XYZ K1ABC RR73"), null);
  assert.strictEqual(parseDecodeText("W9XYZ K1ABC -12"), null);
});

test("store: kind per station; a report from a known-grid station still plots at its grid", () => {
  const s = createStore({ throttleMs: 0, getMyCall: () => ME });
  const t = Date.now();
  assert.ok(s.add({ message: "CQ K1ABC FN42", snr: -3, mode: "~" }, t));
  assert.strictEqual(s.list()[0].kind, "cq");
  assert.ok(s.add({ message: "N0CALL K1ABC -12", snr: -5, mode: "~" }, t + 15000));
  const e = s.list()[0];
  assert.strictEqual(e.kind, "me");
  assert.strictEqual(e.grid, "FN42");
  assert.strictEqual(e.message, "N0CALL K1ABC -12");
  assert.ok(!s.add({ message: "N0CALL W2UNK -12" }, t), "unknown grid, no position");
});

test("map overlay colors stations by kind and explains the colors", () => {
  const ls = {};
  const ctx = {
    console, Date, Math, Number, JSON, Set, Map, String, Array,
    Event: class { constructor(t) { this.type = t; } },
    localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); } },
    document: { readyState: "complete", dispatchEvent() {}, addEventListener() {} },
    setInterval: () => 0, clearInterval() {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/decode-overlay.js"), "utf8"), ctx);
  const now = Date.now();
  ctx.applyDecodeOverlay({ type: "wsjtx-decodes", expireMs: 900000, now, stations: [
    { call: "K1ABC", grid: "FN42", lat: 42.5, lon: -71, lastHeard: now, kind: "me", message: "N0CALL K1ABC -12" },
    { call: "K2DEF", grid: "FN31", lat: 41.5, lon: -73, lastHeard: now, kind: "cq" },
    { call: "K3GHI", grid: "FM19", lat: 39.5, lon: -77, lastHeard: now, kind: "other" },
  ] });
  const it = ctx.decodeOverlay.items(now);
  const col = Object.fromEntries(it.map((i) => [i.call, i.color]));
  const C = ctx.decodeOverlay.colors;
  assert.strictEqual(col.K1ABC, C.me);
  assert.strictEqual(col.K2DEF, C.cq);
  assert.strictEqual(col.K3GHI, C.other);
  assert.ok(new Set([C.me, C.cq, C.other]).size === 3);
  assert.match(it[0].tip, /calling you/);
  assert.match(ctx.decodeOverlay.legend, /calling you/);
});
