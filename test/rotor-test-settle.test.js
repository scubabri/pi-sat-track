// Configure rotor test: read-back waits until the axis settles (lib/connection-test.js waitSettled).
// Fake slow rotors on a fake clock; no hardware.
// Run: node --test --test-force-exit test/rotor-test-settle.test.js
const test = require("node:test");
const assert = require("assert");
const { waitSettled, settleTimeoutMs } = require("../lib/connection-test");

/** Fake clock + rotor: pos(t) from a motion function; read() costs 100 ms. */
function rig(motion) {
  let t = 0;
  const reads = [];
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    read: async () => { t += 100; const pos = motion(t); reads.push([t, pos]); return { pos, raw: String(pos) }; },
    reads,
  };
}
const opts = (r, extra) => Object.assign({ now: r.now, sleep: r.sleep, deadband: 2.5 }, extra || {});

test("slow EL (pauses, then creeps to 177): waits and passes — not read mid-move", async () => {
  // Brian's case: 168 -> 177, brake / start delay 2 s, then 1°/s
  const r = rig((t) => (t < 2000 ? 168 : Math.min(177, 168 + (t - 2000) / 1000)));
  const w = await waitSettled(r.read, 177, "el", opts(r, { distDeg: 9 }));
  assert.strictEqual(w.how, "target");
  assert.ok(Math.abs(w.pos - 177) <= 2.5, String(w.pos));
  assert.ok(w.ms >= 8000, "took " + w.ms + " ms (a fixed 2-5 s wait would have read ~169-171)");
});

test("stuck short at 170: settles (stopped) and reports the settled reading", async () => {
  const r = rig((t) => Math.min(170, 160 + t / 500));
  const w = await waitSettled(r.read, 177, "el", opts(r, { distDeg: 17 }));
  assert.strictEqual(w.how, "stopped");
  assert.strictEqual(w.pos, 170);
  assert.ok(w.ms >= 3000 && w.ms < 15000, String(w.ms));
});

test("never settles (keeps drifting): times out with the last reading", async () => {
  const r = rig((t) => 100 + t / 200); // 5°/s, never reaches 400
  const w = await waitSettled(r.read, 359, "az", opts(r, { timeoutMs: 30000 }));
  assert.strictEqual(w.how, "timeout");
  assert.ok(w.ms >= 30000 && w.ms < 31500, String(w.ms));
  assert.ok(w.pos > 200);
});

test("no movement at first (slow start) is not taken as stopped before the start grace", async () => {
  const r = rig((t) => (t < 2800 ? 50 : Math.min(60, 50 + (t - 2800) / 300)));
  const w = await waitSettled(r.read, 60, "az", opts(r));
  assert.strictEqual(w.how, "target");
});

test("AZ wraps across north for the deadband", async () => {
  const r = rig(() => 359.5);
  const w = await waitSettled(r.read, 1, "az", opts(r));
  assert.strictEqual(w.how, "target");
});

test("coasting inside the deadband is not settled: waits ~3 s of no change, reports the final read", async () => {
  // Brian, alpha.53: EL cmd 20 read 19 at ~5.1 s while still coasting -> 20
  const r = rig((t) => (t < 4500 ? Math.round(10 + t / 500) : t < 7000 ? 19 : 20));
  const w = await waitSettled(r.read, 20, "el", opts(r, { stillDeg: 0.5 }));
  assert.strictEqual(w.how, "target");
  assert.strictEqual(w.pos, 20, "final read");
  assert.ok(w.ms >= 7000 + 3000, "took " + w.ms + " ms");
  assert.deepStrictEqual(r.reads[r.reads.length - 1][1], 20, "reported value is the last read");
});

test("on target from the start: still waits the 3 s no-change window (no 2-reads shortcut)", async () => {
  const r = rig(() => 60);
  const w = await waitSettled(r.read, 60, "az", opts(r));
  assert.strictEqual(w.how, "target");
  assert.ok(w.ms >= 3000, String(w.ms));
});

test("timeout scales with distance: 30 s min, 90 s max", () => {
  assert.strictEqual(settleTimeoutMs(5), 30000);
  assert.strictEqual(settleTimeoutMs(100), 70000);
  assert.strictEqual(settleTimeoutMs(360), 90000);
});

test("tracking drivers untouched: no waitSettled in lib/rotors", () => {
  const fs = require("fs");
  for (const f of fs.readdirSync(require("path").join(__dirname, "../lib/rotors"))) {
    if (!f.endsWith(".js")) continue;
    assert.doesNotMatch(fs.readFileSync(require("path").join(__dirname, "../lib/rotors", f), "utf8"), /waitSettled|connection-test/, f);
  }
});
