// Radio update interval: throttle rule + config clamp.
// Run: node --test --test-force-exit test/radio-update-rate.test.js
const test = require("node:test");
const assert = require("assert");
const config = require("../lib/config");
const state = require("../lib/state");

test("normalizeRadioUpdateMs clamps 100..2000 in 50 ms steps", () => {
  assert.strictEqual(config.normalizeRadioUpdateMs(250), 250);
  assert.strictEqual(config.normalizeRadioUpdateMs(10), 100);
  assert.strictEqual(config.normalizeRadioUpdateMs(9999), 2000);
  assert.strictEqual(config.normalizeRadioUpdateMs(274), 250);
  assert.strictEqual(config.normalizeRadioUpdateMs(276), 300);
  assert.strictEqual(config.normalizeRadioUpdateMs("x"), 250);
});

test("radioUpdateMs round-trips through applyEndpoints/getEndpoints", () => {
  config.applyEndpoints({ radioUpdateMs: 1000 });
  assert.strictEqual(config.getEndpoints().radioUpdateMs, 1000);
  assert.strictEqual(config.RADIO_UPDATE_MS, 1000);
  config.setRadioUpdateMs(250);
  assert.strictEqual(config.RADIO_UPDATE_MS, 250);
});

test("shouldPushRadio: interval gate with force/sync/key overrides", () => {
  const base = { lastAt: 1000, intervalMs: 500, force: false, syncNeeded: false, keyChanged: false };
  assert.strictEqual(state.shouldPushRadio({ ...base, nowMs: 1250 }), false);
  assert.strictEqual(state.shouldPushRadio({ ...base, nowMs: 1500 }), true);
  assert.strictEqual(state.shouldPushRadio({ ...base, nowMs: 1250, force: true }), true);
  assert.strictEqual(state.shouldPushRadio({ ...base, nowMs: 1250, syncNeeded: true }), true);
  assert.strictEqual(state.shouldPushRadio({ ...base, nowMs: 1250, keyChanged: true }), true);
});
