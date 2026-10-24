// lib/state.js with a leg Disabled (two radios, simplex sat on one radio):
// the disabled leg's saved fine offset survives load / persist / Center-less
// reset, roleOff survives "clear offsets", and QSO logging still gets the
// sat's UL / DL frequencies from the Doppler calc exactly as with both legs.
// No radio connects (registry never started).
// Run: node --test --test-force-exit test/radio-roles-disabled-state.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pst-off-state-"));
process.env.HOME = home;
const L = ["1 25544U 98067A   26280.50000000  .00016717  00000-0  10270-3 0  9990",
           "2 25544  51.6400 208.9163 0006317  69.9862  25.2906 15.49560532000000"];
const catalog = require("../lib/catalog");
catalog.getCatalog = () => ({ ISS: { norad: 25544, display: "ISS", modes: [{ mode: "FM APRS", uplink: "145.825", downlink: "145.825" }] } });
const tle = require("../lib/tle");
tle.fetchTLE = () => Promise.resolve({ l1: L[0], l2: L[1], note: "test", orbit: null });
tle.getSatrecForNorad = () => null;
tle.cacheSatrec = () => {};
const config = require("../lib/config");
const roles = require("../lib/radio-roles");
const satOffsets = require("../lib/sat-offsets");
satOffsets.load();
const state = require("../lib/state");
const radios = require("../lib/radios");

const rig = (port) => ({ transport: "tcp", type: "rigctl", protocol: "rigctl", rigctlEndpoint: "127.0.0.1:" + port });
const cfg = { singleRadio: false, txSplit: true, radioUl: rig(1), radioDl: rig(2) };

test("UL disabled: offsets kept, roleOff kept, logging freqs unchanged", async () => {
  config.applyEndpoints(roles.effectiveEndpoints(cfg, 1, null));
  satOffsets.set("ISS", { ulFineOffset: 300, dlFineOffset: -40 });
  await state.loadSatellite("ISS");
  const both = state.getLogContext();
  assert.ok(Number.isFinite(both.ulHz) && Number.isFinite(both.dlHz));

  satOffsets.setRoleOff("ISS", "ul");
  config.applyEndpoints(roles.effectiveEndpoints(cfg, 1, "ul"));
  state.reapplyRadioForCurrentSat(); // what the router's re-apply path runs
  assert.strictEqual(radios.activeUl(), radios.nullDriver);
  const st = radios.active().getRadioState();
  assert.strictEqual(st.ulFineOffset, 300, "disabled leg's fine offset held");
  state.persistCurrentOffsets();
  assert.strictEqual(satOffsets.get("ISS").ulFineOffset, 300, "not saved as 0");
  assert.strictEqual(satOffsets.get("ISS").roleOff, "ul");
  const off = state.getLogContext();
  assert.ok(Math.abs(off.ulHz - both.ulHz) < 2000, "UL logged as before: " + off.ulHz + " vs " + both.ulHz);
  assert.ok(Math.abs(off.dlHz - both.dlHz) < 2000, "DL logged as before");

  state.clearPersistedOffsets();
  assert.strictEqual(satOffsets.getRoleOff("ISS"), "ul", "Center keeps the disabled leg");
});
