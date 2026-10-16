// FM sats: the 2m side is held at nominal; 70cm side gets Doppler.
// Run: node --test --test-force-exit test/fm-2m-fixed.test.js
const test = require("node:test");
const assert = require("assert");
const { fixedDefaults } = require("../lib/state");

test("FM UL 2m / DL 70cm (SO-50) → UL fixed", () => {
  assert.deepStrictEqual(fixedDefaults(true, 145.85, 436.795), { ulFixed: true, dlFixed: false });
});

test("FM UL 70cm / DL 2m (e.g. AO-27 style) → DL fixed", () => {
  assert.deepStrictEqual(fixedDefaults(true, 436.5, 145.8), { ulFixed: false, dlFixed: true });
});

test("FM both 2m (ISS) → legacy rule (UL < 200 → UL fixed), DL Doppler", () => {
  assert.deepStrictEqual(fixedDefaults(true, 145.825, 145.825), { ulFixed: true, dlFixed: false });
});

test("FM neither 2m (70cm/23cm) → legacy rule: no fixed", () => {
  assert.deepStrictEqual(fixedDefaults(true, 1260.2, 436.5), { ulFixed: false, dlFixed: false });
});

test("Linear sats unchanged → nothing fixed", () => {
  assert.deepStrictEqual(fixedDefaults(false, 145.95, 435.64), { ulFixed: false, dlFixed: false });
  assert.deepStrictEqual(fixedDefaults(false, 435.25, 145.9), { ulFixed: false, dlFixed: false });
});
