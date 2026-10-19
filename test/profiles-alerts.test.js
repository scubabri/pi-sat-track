// Pass alerts stored per station profile (profiles.json → alerts), synced via
// the "profiles" payload; legacy files load with empty alerts; prune after LOS.
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "pst-alerts-"));
process.env.HOME = home;
const dir = path.join(home, ".rpitrack");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "profiles.json"), JSON.stringify({
  active: "TS-2000 Remote",
  profiles: {
    "TS-2000 Remote": { favorites: ["RS-44", "AO-7"], config: {} },
    "IC9700 Local": { favorites: ["SO-50"], config: {} },
  },
}));
const profiles = require("../lib/profiles");
profiles.load();
const MIN = 60000;
const now = Date.now();

test("legacy profiles load with empty alerts", () => {
  assert.deepStrictEqual(profiles.getActive().alerts, { sats: [], passes: [], passExceptions: [], allFavorites: false });
  assert.deepStrictEqual(profiles.publicPayload().alerts, profiles.getActive().alerts);
});

test("save + reload roundtrip (normalized), per profile", () => {
  profiles.updateActive({
    alerts: {
      sats: ["AO-7", "AO-7"],
      passes: [{ key: "RS-44", aosMs: now + 60 * MIN, losMs: now + 70 * MIN, junk: 1 }],
      passExceptions: [{ key: "AO-7", aosMs: now + 90 * MIN }],
      allFavorites: true,
    },
  });
  const want = {
    sats: ["AO-7"],
    passes: [{ key: "RS-44", aosMs: now + 60 * MIN, losMs: now + 70 * MIN }],
    passExceptions: [{ key: "AO-7", aosMs: now + 90 * MIN }],
    allFavorites: true,
  };
  assert.deepStrictEqual(profiles.publicPayload().alerts, want);
  const disk = JSON.parse(fs.readFileSync(profiles.PROFILES_FILE, "utf8"));
  assert.deepStrictEqual(disk.profiles["TS-2000 Remote"].alerts, want);
  // other updates keep alerts
  profiles.updateActive({ favorites: ["RS-44", "AO-7", "ISS"] });
  assert.deepStrictEqual(profiles.getActive().alerts, want);
  profiles.load();
  assert.deepStrictEqual(profiles.getActive().alerts, want, "survives reload");
  // other profile untouched
  profiles.setActive("IC9700 Local");
  assert.deepStrictEqual(profiles.getActive().alerts.sats, []);
  profiles.setActive("TS-2000 Remote");
});

test("new profile copies alerts from the active one", () => {
  profiles.createProfile("Copy", true);
  assert.deepStrictEqual(profiles.getActive().alerts.sats, ["AO-7"]);
  profiles.setActive("TS-2000 Remote");
});

test("pruneAlerts drops passes after LOS in every profile and saves", () => {
  assert.strictEqual(profiles.pruneAlerts(now), false, "nothing to prune yet");
  const changedActive = profiles.pruneAlerts(now + 72 * MIN);
  assert.strictEqual(changedActive, true);
  const a = profiles.getActive().alerts;
  assert.deepStrictEqual(a.passes, []);
  assert.strictEqual(a.passExceptions.length, 1, "AO-7 exception (AOS+90) kept");
  assert.deepStrictEqual(a.sats, ["AO-7"]);
  const disk = JSON.parse(fs.readFileSync(profiles.PROFILES_FILE, "utf8"));
  assert.deepStrictEqual(disk.profiles["TS-2000 Remote"].alerts.passes, []);
  assert.deepStrictEqual(disk.profiles.Copy.alerts.passes, [], "non-active profile pruned too");
});
