// APRS heard store: position reports plot at their position; messages /
// status without one use the sender's last known position, else a grid in
// the text, else are not plotted. Our own TX plots at the station position.
// Run: node --test --test-force-exit test/aprs-store.test.js
const test = require("node:test");
const assert = require("assert");
const { createStore, resolvePosition } = require("../lib/aprs/store");
const { parseInfo } = require("../lib/aprs/parse");

const pkt = (src, dst, info, extra) => Object.assign({ src, dir: "rx", parsed: parseInfo(dst, info), time: Date.now() }, extra || {});

test("resolvePosition priority: own position > last known > grid in text > none", () => {
  const prev = { lastPos: { lat: 10, lon: 20 } };
  assert.deepStrictEqual(resolvePosition(null, { posSource: "aprs", lat: 1, lon: 2 }), { lat: 1, lon: 2, posSource: "aprs" });
  assert.deepStrictEqual(resolvePosition(prev, { posSource: "grid", lat: 40.5, lon: -111, grid: "DN40" }), { lat: 10, lon: 20, posSource: "last" });
  assert.deepStrictEqual(resolvePosition(null, { posSource: "grid", lat: 40.5, lon: -111, grid: "DN40" }), { lat: 40.5, lon: -111, posSource: "grid", grid: "DN40" });
  assert.strictEqual(resolvePosition(null, { type: "status" }), null);
  assert.deepStrictEqual(resolvePosition(null, { type: "message" }, { selfPos: { lat: 5, lon: 6 } }), { lat: 5, lon: 6, posSource: "self" });
  // 0,0 placeholder (ISS beacon) is not a fix
  assert.strictEqual(resolvePosition(null, { posSource: "aprs", lat: 0.01, lon: 0.18 }), null);
});

test("message after a position report plots at the last known position", () => {
  const s = createStore({ throttleMs: 0 });
  s.add(pkt("N0SAT", "APRS", "!3944.50N/10459.00W`Denver"));
  const e = s.add(pkt("N0SAT", "APRS", ">Thanks for the contact DN70"));
  assert.strictEqual(e.posSource, "last");
  assert.ok(Math.abs(e.lat - (39 + 44.5 / 60)) < 1e-6);
  assert.strictEqual(e.recent.length, 2);
  assert.strictEqual(e.recent[0].type, "status");
  assert.strictEqual(e.comment, "Denver"); // comment from the position report
  s.stop();
});

test("message with only a grid plots at the grid centre; without either it is not plotted", () => {
  const s = createStore({ throttleMs: 0 });
  const g = s.add(pkt("DL7NDR", "JN48AP", ">QRV via ISS DN40aq"));
  assert.strictEqual(g.posSource, "grid");
  assert.strictEqual(g.grid, "DN40aq");
  s.add(pkt("W1AW", "APRS", ">no locator"));
  const calls = s.payload().stations.map((x) => x.call);
  assert.ok(calls.includes("DL7NDR"));
  assert.ok(!calls.includes("W1AW"), "unplottable station must stay off the map");
  assert.ok(s.get("W1AW"), "but it is still tracked");
  // a later position report upgrades the grid plot to the real position
  const p = s.add(pkt("DL7NDR", "APRS", "!4836.00N/01130.00E-"));
  assert.strictEqual(p.posSource, "aprs");
  s.stop();
});

test("own TX plots at the station position; payload shape and expiry", () => {
  const s = createStore({ throttleMs: 0, expireMs: 1000 });
  const t0 = Date.now();
  s.add(Object.assign(pkt("K0TEST", "APZPST", ":RS0ISS   :hi"), { dir: "tx", time: t0 }), { selfPos: { lat: 40.5, lon: -111 } });
  const st = s.payload().stations[0];
  assert.strictEqual(st.posSource, "self");
  assert.strictEqual(st.recent[0].dir, "tx");
  assert.strictEqual(s.purge(t0 + 5000), 1);
  assert.strictEqual(s.payload().stations.length, 0);
  s.stop();
});
