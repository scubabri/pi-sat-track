// Regression (Brian 2026-10-27, "Data isn't persisting per mode on ISS"):
// the Data flag was one per-sat boolean, so ISS APRS (FM-D) and FM voice
// shared it, and a mode switch kept the previous mode's Data. Now it is
// saved per sat + mode ("mode|uplink|downlink") and re-applied on mode change.
// Run: node --test --test-force-exit test/iss-data-per-mode.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "issdata-"));
process.env.HOME = home;
fs.mkdirSync(path.join(home, ".rpitrack"));
const FILE = path.join(home, ".rpitrack", "sat-offsets.json");
const L = ["1 25544U 98067A   26280.50000000  .00010000  00000-0  18000-3 0  9990",
           "2 25544  51.6400 200.0000 0005000  80.0000 280.0000 15.50000000000000"];
const ISS_MODES = [
  { mode: "9k6 GFSK FM", uplink: "145.990", downlink: "437.800", ctcssAccess: 67 },
  { mode: "1k2 AFSK", uplink: "145.825", downlink: "145.825" },
  { mode: "1k2 AFSK APRS", uplink: "437.825", downlink: "437.825" },
  { mode: "FM", uplink: "435.050", downlink: "145.800", ctcssAccess: 67 },
];
const catalog = require("../lib/catalog");
catalog.getCatalog = () => ({ ISS: { norad: 25544, display: "ISS", modes: ISS_MODES } });
const tle = require("../lib/tle");
tle.fetchTLE = async () => ({ l1: L[0], l2: L[1], note: "test", orbit: null });
tle.getSatrecForNorad = () => null;
tle.cacheSatrec = () => {};
const satOffsets = require("../lib/sat-offsets");
satOffsets.load();
const state = require("../lib/state");
const radios = require("../lib/radios");

// Whatever radio is active in the test env: give it Data support (driver-level
// Data is covered by the radio tests; this is about what state saves / applies).
const r = radios.active();
let data = false;
let cw = false;
const origState = r.getRadioState.bind(r);
r.getRadioState = () => Object.assign({}, origState() || {}, { supportsDataMode: true, dataMode: data, supportsCwMode: true, cwMode: cw });
r.setDataMode = (on) => { data = !!on; if (data) cw = false; };
r.setCwMode = (on) => { cw = !!on; if (cw) data = false; };
const mk = (i) => [ISS_MODES[i].mode, ISS_MODES[i].uplink, ISS_MODES[i].downlink].join("|");

test("ISS: Data is remembered per mode, re-applied on mode change, survives offset saves + reload", async () => {
  await state.loadSatellite("ISS");
  state.setModeIndex(1); // 1k2 AFSK packet
  assert.strictEqual(state.setDataMode(true), true);
  assert.strictEqual(data, true);
  state.setModeIndex(3); // FM voice: never had Data
  assert.strictEqual(data, false, "FM voice must not inherit packet's Data");
  state.setModeIndex(1);
  assert.strictEqual(data, true, "back on packet: Data restored");
  state.setModeIndex(2); // APRS on 70 cm: separate choice
  assert.strictEqual(data, false);
  state.setDataMode(true);
  state.setModeIndex(0);
  assert.strictEqual(data, false);
  // fine-tune save (hand-picked field list in sat-offsets.set) must keep the map
  state.persistCurrentOffsets();
  satOffsets.flush();
  const disk = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const ent = disk.profiles.default.ISS;
  assert.deepStrictEqual(ent.dataByMode, { [mk(1)]: true, [mk(2)]: true });
  assert.strictEqual(ent.dataMode, false);
  // Center keeps per-mode Data
  state.clearPersistedOffsets();
  assert.deepStrictEqual(satOffsets.getDataByMode("ISS"), { [mk(1)]: true, [mk(2)]: true });
  // turning Data off for one mode leaves the other
  state.setModeIndex(1);
  state.setDataMode(false);
  assert.deepStrictEqual(satOffsets.getDataByMode("ISS"), { [mk(2)]: true });
  // reload from disk + reselect: last mode (APRS) comes back with its Data
  state.setModeIndex(2);
  satOffsets.flush();
  satOffsets.load();
  satOffsets.setProfile("default");
  data = false;
  await state.loadSatellite("ISS");
  assert.strictEqual(state.getModeIndex ? state.getModeIndex() : 2, 2);
  assert.strictEqual(data, true, "reselect ISS on APRS: Data on");
});

test("legacy per-sat Data flag: still applies until a mode is set, then per mode only", () => {
  satOffsets.setDataMode("SO-50", true); // as saved before this change
  assert.strictEqual(satOffsets.getDataMode("SO-50", "FM|145.850|436.795"), true, "legacy flag = all modes");
  satOffsets.setDataMode("SO-50", true, "FM|145.850|436.795");
  assert.strictEqual(satOffsets.getDataMode("SO-50", "FM|145.850|436.795"), true);
  assert.strictEqual(satOffsets.getDataMode("SO-50", "FM|145.850|436.800"), false, "other mode off once per-mode is used");
  assert.strictEqual(satOffsets.getDataMode("SO-50"), false, "legacy flag dropped");
  satOffsets.setDataMode("SO-50", false, "FM|145.850|436.795");
  assert.deepStrictEqual(satOffsets.getDataByMode("SO-50"), {});
  assert.strictEqual(satOffsets.getDataMode("SO-50", "FM|145.850|436.795"), false);
});
