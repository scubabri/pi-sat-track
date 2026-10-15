// Startup order: offsets store loads as "default" before profiles.json; the
// real active profile ("IC-705 Remote", with a space) must then be selected,
// logged, and used for the restore on the startup sat load.
// Run: node --test --test-force-exit test/sat-offsets-startup-profile.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "satoffs-"));
process.env.HOME = home;
fs.mkdirSync(path.join(home, ".rpitrack"));
fs.writeFileSync(path.join(home, ".rpitrack", "sat-offsets.json"), JSON.stringify({
  version: 2,
  global: { "RS-44": { ulFineOffset: 0, dlFineOffset: -2300, manualDlOffset: 0, modeIndex: null } },
  profiles: {
    default: { "RS-44": { ulFineOffset: 0, dlFineOffset: 111, manualDlOffset: 0, modeIndex: null } },
    "IC-705 Remote": { "RS-44": { ulFineOffset: 40, dlFineOffset: -950, manualDlOffset: 0, modeIndex: null } },
  },
}));
fs.writeFileSync(path.join(home, ".rpitrack", "profiles.json"), JSON.stringify({
  active: " IC-705 Remote ",
  profiles: { default: {}, "IC-705 Remote": {} },
}));
const L = ["1 07530U 74089B   26280.50000000 -.00000030  00000-0  10000-3 0  9990",
           "2 07530 101.9900 300.0000 0012000 100.0000 260.0000 12.53650000000000"];
const catalog = require("../lib/catalog");
catalog.getCatalog = () => ({ "RS-44": { norad: 44909, display: "RS-44", modes: [] } });
const tle = require("../lib/tle");
tle.fetchTLE = async () => ({ l1: L[0], l2: L[1], note: "test", orbit: null });
tle.getSatrecForNorad = () => null;
tle.cacheSatrec = () => {};
const logs = [];
const origLog = console.log;
console.log = (...a) => { logs.push(a.join(" ")); origLog(...a); };
const satOffsets = require("../lib/sat-offsets");
const state = require("../lib/state");
const radios = require("../lib/radios");
const profiles = require("../lib/profiles");
const st = () => radios.active().getRadioState() || {};

(async () => {
  satOffsets.load(); // as in state.init, before profiles
  assert.strictEqual(satOffsets.getProfile(), "default");
  profiles.load();
  assert.strictEqual(profiles.getActiveName(), "IC-705 Remote");
  state.setOffsetsProfile(profiles.getActiveName()); // as server.js startup
  assert.strictEqual(satOffsets.getProfile(), "IC-705 Remote");
  assert(logs.some((l) => l.includes('Sat offsets: profile "default" → "IC-705 Remote"')), "switch logged");
  await state.loadSatellite("RS-44");
  assert.strictEqual(st().dlFineOffset, -950, "restore from active profile");
  assert.strictEqual(st().ulFineOffset, 40);
  // Unsanitized name maps to the same profile key
  assert.strictEqual(satOffsets.profileKey("  IC-705 Remote  "), profiles.sanitizeName("  IC-705 Remote  "));
  assert.strictEqual(satOffsets.setProfile("  IC-705 Remote "), false, "same profile → no switch");
  console.log = origLog;
  console.log("sat-offsets-startup-profile test: PASS");
  process.exit(0);
})().catch((e) => { console.log = origLog; console.error("FAIL:", e.message); process.exit(1); });
