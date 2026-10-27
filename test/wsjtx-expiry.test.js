// WSJT-X heard stations drop off 60 s after their last decode (map, globe, list).
// Run: node --test --test-force-exit test/wsjtx-expiry.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { DECODE_EXPIRE_MS, PURGE_MS, createStore } = require("../lib/wsjtx-decodes");

const dec = (msg) => ({ message: msg, snr: -10, mode: "+", timeMs: 0, dt: 0.1, df: 1000 });

test("server store: 60 s expiry, purged often enough to go close to 60 s", () => {
  assert.strictEqual(DECODE_EXPIRE_MS, 60 * 1000);
  assert.ok(PURGE_MS >= 1000 && PURGE_MS <= 10000, "purge tick " + PURGE_MS);
  const s = createStore({ throttleMs: 0 });
  const t0 = Date.now() - 59_000; // heard 59 s ago
  s.add(dec("CQ K1ABC FN42"), t0, { id: "X", address: "127.0.0.1", port: 1 });
  assert.strictEqual(s.purge(t0 + 59_000), 0, "still there at 59 s");
  assert.ok(s.replyFor("K1ABC"), "still answerable before 60 s");
  assert.strictEqual(s.purge(t0 + 60_500), 1, "gone just after 60 s");
  assert.strictEqual(s.replyFor("K1ABC"), null, "no Reply to an expired station");
});

test("client: default expiry 60 s; refresh ticks short enough for 60 s; fade spans the 60 s", () => {
  const ov = fs.readFileSync(path.join(__dirname, "../js/decode-overlay.js"), "utf8");
  assert.match(ov, /let expireMs = 60 \* 1000;/);
  const ovTick = +ov.match(/render\(\); notify\(\); \}, (\d+)\)/)[1];
  assert.ok(ovTick <= 10000, "map/globe refresh " + ovTick);
  const lst = fs.readFileSync(path.join(__dirname, "../js/wsjtx-list.js"), "utf8");
  const lsTick = +lst.match(/setInterval\(render, (\d+)\)/)[1];
  assert.ok(lsTick <= 10000, "list refresh " + lsTick);
  assert.doesNotMatch(lst + ov, /15 ?min/i, "no stale 15 min comments");
  const srv = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  assert.doesNotMatch(srv, /DECODE_EXPIRE_MS[^\n]*15 min/);
});
