// Spinner/fine offsets are saved per profile (keyed by sat within profile),
// legacy global values seed a profile once, and switching profiles re-applies
// that profile's offsets live.
// Run: node --test --test-force-exit test/sat-offsets-profile.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "satoffp-"));
process.env.HOME = home;
fs.mkdirSync(path.join(home, ".rpitrack"));
const FILE = path.join(home, ".rpitrack", "sat-offsets.json");
// Legacy v1 flat (global) file
fs.writeFileSync(FILE, JSON.stringify({
  "RS-44": { ulFineOffset: 0, dlFineOffset: -2300, manualDlOffset: 0, modeIndex: null },
}));
const L = ["1 07530U 74089B   26280.50000000 -.00000030  00000-0  10000-3 0  9990",
           "2 07530 101.9900 300.0000 0012000 100.0000 260.0000 12.53650000000000"];
const catalog = require("../lib/catalog");
catalog.getCatalog = () => ({ "RS-44": { norad: 44909, display: "RS-44", modes: [] } });
const tle = require("../lib/tle");
tle.fetchTLE = async () => ({ l1: L[0], l2: L[1], note: "test", orbit: null });
tle.getSatrecForNorad = () => null;
tle.cacheSatrec = () => {};
const satOffsets = require("../lib/sat-offsets");
satOffsets.load();
const state = require("../lib/state");
const radios = require("../lib/radios");
const dl = () => (radios.active().getRadioState() || {}).dlFineOffset || 0;

(async () => {
  state.setOffsetsProfile("Flex");
  await state.loadSatellite("RS-44");
  assert.strictEqual(dl(), -2300, "Flex seeded from legacy global");
  // Change Flex's offset
  radios.active().setOffsets({ ulFineOffset: 0, dlFineOffset: 500, manualDlOffset: 0 });
  state.persistCurrentOffsets();
  // Switch to IC-9700: no own map -> legacy global, live
  state.setOffsetsProfile("IC-9700");
  assert.strictEqual(dl(), -2300, "IC-9700 falls back to legacy global, applied live");
  radios.active().setOffsets({ ulFineOffset: 0, dlFineOffset: -700, manualDlOffset: 0 });
  state.persistCurrentOffsets();
  state.setOffsetsProfile("Flex");
  assert.strictEqual(dl(), 500, "Flex keeps its own offset");
  state.setOffsetsProfile("IC-9700");
  assert.strictEqual(dl(), -700, "IC-9700 keeps its own offset");
  satOffsets.flush();
  const disk = JSON.parse(fs.readFileSync(FILE, "utf8"));
  assert.strictEqual(disk.version, 2);
  assert.strictEqual(disk.global["RS-44"].dlFineOffset, -2300, "legacy global preserved");
  assert.strictEqual(disk.profiles.Flex["RS-44"].dlFineOffset, 500);
  assert.strictEqual(disk.profiles["IC-9700"]["RS-44"].dlFineOffset, -700);
  // Reload from v2 file
  satOffsets.load();
  satOffsets.setProfile("Flex");
  assert.strictEqual(satOffsets.get("RS-44").dlFineOffset, 500, "v2 reload per profile");
  satOffsets.renameProfile("Flex", "Flex6600");
  assert.strictEqual(satOffsets.getProfile(), "Flex6600");
  assert.strictEqual(satOffsets.get("RS-44").dlFineOffset, 500, "rename keeps offsets");
  console.log("sat-offsets-profile test: PASS");
  process.exit(0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
