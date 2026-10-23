// Per-sat Flex global profile follows the Flex's role (Radio 1 / Radio 2).
// Brian (Flex705: Radio 1 = IC-705 rigctl, Radio 2 = Flex): on FO-29 the
// profile "PiTrack-432up" (Flex on 70 cm) was saved before the swap; after
// swapping the Flex to UL / 2 m it was re-selected and loaded on Radio on,
// putting the TX slice back on 70 cm. Now: role-less (pre-roles) values only
// apply with Radio 1 on UL; picks are stored per role ("@ul" / "@dl").
// No radio is started: nothing connects (addresses are 127.0.0.9).
// Run: node --test --test-force-exit test/radio-roles-flex-profile.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pst-roles-flexprof-"));

const config = require("../lib/config");
const radios = require("../lib/radios");
const flex = require("../lib/radios/flex");
const satOffsets = require("../lib/sat-offsets");
const state = require("../lib/state");
const moon = require("../lib/moon");
const { createRouter } = require("../lib/radio-role-router");

const K = moon.MOON_KEY;
let router;

test("Flex profile per sat follows the Flex role across swaps", async () => {
  const r1 = { transport: "tcp", type: "rigctl", protocol: "rigctl", rigctlEndpoint: "127.0.0.9:4532" };
  const r2 = { transport: "tcp", type: "smartsdr", protocol: "cat", catEndpoint: "127.0.0.9:60003", apiEndpoint: "127.0.0.9:4992" };
  const cfg = { singleRadio: false, txSplit: true, radioUl: r1, radioDl: r2, radioRoles: { defaultUl: 1 } };
  radios.init({ getContext: () => ({ currentSatKey: K, currentModeIndex: 0 }), broadcast: () => {} });
  router = createRouter({ config, radios, satOffsets, getConfig: () => cfg, log: () => {} });
  state.setFlexRoleHook(() => router.flexRole());
  state.setSatSelectHook((key) => router.applyForSat(key, "sat"));
  config.applyEndpoints(router.effective(cfg, null));
  satOffsets.setProfile("Flex705");
  satOffsets.setFlexProfile(K, "PiTrack-432up"); // saved before roles existed (Flex on DL)

  await state.loadSatellite(K);
  assert.deepStrictEqual(router.flexRole(), { role: "dl", legacy: true });
  assert.strictEqual(flex.getRadioState().flexProfile, "PiTrack-432up", "unswapped: legacy pick applies");

  // Swap: Flex on UL. The 70 cm profile must not be re-selected.
  router.setForSat(K, 2);
  assert.strictEqual(router.applyForSat(K, "panel"), true);
  state.reapplyRadioForCurrentSat();
  assert.deepStrictEqual(router.flexRole(), { role: "ul", legacy: false });
  assert.strictEqual(flex.getRadioState().flexProfile, "", "swapped: no profile (no change) instead of the DL one");

  // Operator picks the 2 m profile for the Flex on UL: saved for that role.
  state.setFlexProfile("PiTrack-144up");
  assert.strictEqual(flex.getRadioState().flexProfile, "PiTrack-144up");

  // Back to Radio 1 on UL: the DL pick again; then swap: the UL pick again.
  router.setForSat(K, 1);
  router.applyForSat(K, "panel");
  state.reapplyRadioForCurrentSat();
  assert.strictEqual(flex.getRadioState().flexProfile, "PiTrack-432up");
  router.setForSat(K, 2);
  router.applyForSat(K, "panel");
  state.reapplyRadioForCurrentSat();
  assert.strictEqual(flex.getRadioState().flexProfile, "PiTrack-144up");
  const map = satOffsets.getFlexProfileByMode(K);
  assert.ok(Object.keys(map).some((k) => /@ul$/.test(k) && map[k] === "PiTrack-144up"), JSON.stringify(map));
});
