// Per-profile map Favorites overlay state (favOverlay {on, shown|null}).
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "pst-favov-"));
process.env.HOME = home;
const dir = path.join(home, ".rpitrack");
fs.mkdirSync(dir, { recursive: true });
// Legacy file: no favOverlay anywhere.
fs.writeFileSync(path.join(dir, "profiles.json"), JSON.stringify({
  active: "TS-2000 Remote",
  profiles: {
    "TS-2000 Remote": { favorites: ["RS-44", "AO-7", "ISS", "SO-50"], config: {} },
    "IC9700 Local": { favorites: ["SO-50", "ISS", "AO-91"], config: {} },
  },
}));
const profiles = require("../lib/profiles");
profiles.load();

test("legacy profiles load with favOverlay null (client migrates once)", () => {
  assert.strictEqual(profiles.getActive().favOverlay, null);
  assert.strictEqual(profiles.publicPayload().favOverlay, null);
});

test("set on + shown; payload carries it; persisted", () => {
  profiles.updateActive({ favOverlay: { on: true, shown: ["ISS", "RS-44", "NOPE"] } });
  const fo = profiles.publicPayload().favOverlay;
  assert.deepStrictEqual(fo, { on: true, shown: ["RS-44", "ISS"] }, "unknown dropped, favorites order");
  const disk = JSON.parse(fs.readFileSync(profiles.PROFILES_FILE, "utf8"));
  assert.deepStrictEqual(disk.profiles["TS-2000 Remote"].favOverlay, { on: true, shown: ["RS-44", "ISS"] });
});

test("partial patch keeps the other field", () => {
  profiles.updateActive({ favOverlay: { on: false } });
  assert.deepStrictEqual(profiles.getActive().favOverlay, { on: false, shown: ["RS-44", "ISS"] });
  profiles.updateActive({ favOverlay: { on: true } });
});

test("removed favorite drops out of shown; added favorite is shown", () => {
  profiles.updateActive({ favorites: ["RS-44", "AO-7", "SO-50", "FO-29"] });
  assert.deepStrictEqual(profiles.getActive().favOverlay.shown, ["RS-44", "FO-29"]);
});

test("shown null means all and stays null when favorites change", () => {
  profiles.updateActive({ favOverlay: { shown: null } });
  profiles.updateActive({ favorites: ["RS-44", "JO-97"] });
  assert.deepStrictEqual(profiles.getActive().favOverlay, { on: true, shown: null });
});

test("profiles are independent; switch restores each", () => {
  profiles.updateActive({ favOverlay: { shown: ["JO-97"] } });
  assert(profiles.setActive("IC9700 Local"));
  assert.strictEqual(profiles.getActive().favOverlay, null);
  profiles.updateActive({ favOverlay: { on: false, shown: ["AO-91"] } });
  assert(profiles.setActive("TS-2000 Remote"));
  assert.deepStrictEqual(profiles.getActive().favOverlay, { on: true, shown: ["JO-97"] });
});

test("create copies from active; rename carries; delete leaves others", () => {
  assert(profiles.createProfile("Copy"));
  assert.deepStrictEqual(profiles.getActive().favOverlay, { on: true, shown: ["JO-97"] });
  assert(profiles.renameProfile("Copy", "Copy2"));
  assert.strictEqual(profiles.getActiveName(), "Copy2");
  assert.deepStrictEqual(profiles.getActive().favOverlay, { on: true, shown: ["JO-97"] });
  assert(profiles.deleteProfile("Copy2"));
  assert(profiles.setActive("IC9700 Local"));
  assert.deepStrictEqual(profiles.getActive().favOverlay, { on: false, shown: ["AO-91"] });
});

test("garbage favOverlay normalizes safely", () => {
  assert.strictEqual(profiles.normalizeFavOverlay("x", ["A"]), null);
  assert.deepStrictEqual(profiles.normalizeFavOverlay({ on: 1, shown: [1, "A", "B"] }, ["A"]), { on: true, shown: ["A"] });
});
