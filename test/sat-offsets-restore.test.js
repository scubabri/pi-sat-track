// Saved per-sat offsets must restore on EVERY sat load: the startup sat,
// switching away and back, and must survive a fine/step message that lands
// while the new sat's TLE is still being fetched.
// Run: node test/sat-offsets-restore.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "satoff-"));
process.env.HOME = home;
fs.mkdirSync(path.join(home, ".rpitrack"));
fs.writeFileSync(path.join(home, ".rpitrack", "sat-offsets.json"), JSON.stringify({
  "RS-44": { ulFineOffset: 0, dlFineOffset: -2300, manualDlOffset: -25939, modeIndex: null },
  ISS: { ulFineOffset: 0, dlFineOffset: 100, manualDlOffset: 0, modeIndex: null },
}));
const L = ["1 07530U 74089B   26280.50000000 -.00000030  00000-0  10000-3 0  9990",
           "2 07530 101.9900 300.0000 0012000 100.0000 260.0000 12.53650000000000"];
const catalog = require("../lib/catalog");
catalog.getCatalog = () => ({
  "RS-44": { norad: 44909, display: "RS-44", modes: [] },
  ISS: { norad: 25544, display: "ISS", modes: [] },
});
const tle = require("../lib/tle");
let delay = 0;
tle.fetchTLE = () => new Promise((r) => setTimeout(() => r({ l1: L[0], l2: L[1], note: "test", orbit: null }), delay));
tle.getSatrecForNorad = () => null;
tle.cacheSatrec = () => {};
const satOffsets = require("../lib/sat-offsets");
satOffsets.load();
const state = require("../lib/state");
const radios = require("../lib/radios");
const offs = () => { const s = radios.active().getRadioState() || {}; return [s.ulFineOffset || 0, s.dlFineOffset || 0, s.manualDlOffset || 0]; };

(async () => {
  await state.loadSatellite("RS-44"); // startup sat
  assert.deepStrictEqual(offs(), [0, -2300, -25939], "startup sat restore");
  await state.loadSatellite("ISS");
  assert.deepStrictEqual(offs(), [0, 100, 0], "ISS restore");
  // Switch back with a slow fetch; a fine/step msg (delta 0) arrives mid-fetch.
  delay = 100;
  const p = state.loadSatellite("RS-44");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(offs(), [0, -2300, -25939], "restored before TLE lands");
  state.persistCurrentOffsets();
  await p;
  assert.deepStrictEqual(offs(), [0, -2300, -25939], "switch-back restore");
  assert(satOffsets.get("RS-44"), "RS-44 entry must not be wiped");
  // Tolerant key match
  assert.deepStrictEqual(satOffsets.find("RS44").dlFineOffset, -2300);
  console.log("sat-offsets-restore test: PASS");
  process.exit(0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
