// Auto Engage stored per station profile (profiles.json → autoEngage,
// autoEngagePasses), synced via the "profiles" payload; legacy files load
// with it off; marks pruned after LOS; independent of the alert bells.
// Run: node --test --test-force-exit test/auto-engage-profile.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "pst-autoengage-"));
process.env.HOME = home;
const dir = path.join(home, ".rpitrack");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, "profiles.json");
fs.writeFileSync(file, JSON.stringify({
  active: "Home",
  profiles: {
    Home: { favorites: ["ISS", "SO-50"], config: {}, autoSelect: true },
    Portable: { favorites: ["AO-91"], config: {} },
  },
}));
const profiles = require("../lib/profiles");
profiles.load();
const MIN = 60000;
const now = Date.now();

test("legacy profiles load with Auto Engage off and no marks", () => {
  const p = profiles.getActive();
  assert.strictEqual(p.autoEngage, false);
  assert.deepStrictEqual(p.autoEngagePasses, []);
  const pub = profiles.publicPayload();
  assert.strictEqual(pub.autoEngage, false);
  assert.deepStrictEqual(pub.autoEngagePasses, []);
  assert.strictEqual(pub.autoSelect, true, "Auto Select untouched");
});

test("button + marks persist per profile and survive a reload", () => {
  profiles.updateActive({
    autoEngage: true,
    autoEngagePasses: [
      { key: "ISS", aosMs: now + 60 * MIN, losMs: now + 70 * MIN, junk: 1 },
      { key: "ISS", aosMs: now + 60 * MIN + 30000 }, // same pass (AOS jitter)
      { key: "MOON", aosMs: now + 90 * MIN }, // never stored
    ],
  });
  const want = [{ key: "ISS", aosMs: now + 60 * MIN, losMs: now + 70 * MIN }];
  assert.strictEqual(profiles.getActive().autoEngage, true);
  assert.deepStrictEqual(profiles.getActive().autoEngagePasses, want);
  assert.deepStrictEqual(profiles.getActive().alerts.passes, [], "bells untouched");
  // other profile is independent
  assert.ok(profiles.setActive("Portable"));
  assert.strictEqual(profiles.getActive().autoEngage, false);
  assert.deepStrictEqual(profiles.getActive().autoEngagePasses, []);
  profiles.updateActive({ autoEngage: false, autoEngagePasses: [{ key: "AO-91", aosMs: now + 5 * MIN, losMs: now + 15 * MIN }] });
  assert.ok(profiles.setActive("Home"));
  // reload from disk
  const disk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(disk.profiles.Home.autoEngage, true);
  assert.deepStrictEqual(disk.profiles.Home.autoEngagePasses, want);
  assert.strictEqual(disk.profiles.Portable.autoEngage, false);
  profiles.load();
  assert.strictEqual(profiles.getActiveName(), "Home");
  assert.strictEqual(profiles.publicPayload().autoEngage, true);
  assert.deepStrictEqual(profiles.publicPayload().autoEngagePasses, want);
  // turning it off does not drop the marks
  profiles.updateActive({ autoEngage: false });
  assert.deepStrictEqual(profiles.getActive().autoEngagePasses, want);
  profiles.updateActive({ autoEngage: true });
});

test("a new profile copied from the active one carries its Auto Engage", () => {
  assert.ok(profiles.createProfile("Home copy", true));
  assert.strictEqual(profiles.getActive().autoEngage, true);
  assert.strictEqual(profiles.getActive().autoEngagePasses.length, 1);
  assert.ok(profiles.setActive("Home"));
});

test("marks pruned after LOS in every profile; active flag reported", () => {
  profiles.updateActive({
    autoEngagePasses: [
      { key: "ISS", aosMs: now - 30 * MIN, losMs: now - 20 * MIN },
      { key: "SO-50", aosMs: now + 60 * MIN, losMs: now + 70 * MIN },
    ],
  });
  assert.strictEqual(profiles.pruneAutoEngagePasses(now), true);
  assert.deepStrictEqual(profiles.getActive().autoEngagePasses.map((p) => p.key), ["SO-50"]);
  assert.strictEqual(profiles.pruneAutoEngagePasses(now), false, "nothing more to prune");
  assert.strictEqual(profiles.pruneAutoEngagePasses(now + 24 * 3600 * 1000), true, "Home + Portable pruned later");
  assert.ok(profiles.setActive("Portable"));
  assert.deepStrictEqual(profiles.getActive().autoEngagePasses, []);
});

test("state module: Auto Engage flag per profile", () => {
  const st = require("../lib/state");
  st.setAutoEngage(true);
  assert.strictEqual(st.getAutoEngage(), true);
  st.setAutoEngage("yes");
  assert.strictEqual(st.getAutoEngage(), false, "strict boolean");
});
