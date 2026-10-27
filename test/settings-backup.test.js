// Settings backup / restore (lib/backup.js, server /api/backup + /api/restore,
// js/settings-backup.js). Run: node --test --test-force-exit test/settings-backup.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const backup = require("../lib/backup");

function tmpDir(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pst-backup-"));
  for (const [f, v] of Object.entries(files || {})) fs.writeFileSync(path.join(d, f), typeof v === "string" ? v : JSON.stringify(v));
  return d;
}
const PROFILES = {
  active: "home",
  profiles: {
    home: { favorites: ["ISS", "SO-50"], config: { callsign: "N0CALL", grid: "AA00", radioType: "smartsdr", aprs: { conns: [] } }, lastSat: "ISS" },
    portable: { favorites: ["AO-91"], config: { callsign: "N0CALL/P", grid: "AA00" } },
  },
};
const OFFSETS = { version: 2, global: {}, profiles: { home: { ISS: { ulFineOffset: 120, dlFineOffset: 0, manualDlOffset: 0, modeIndex: 1 } } } };
const CACHES = {
  "tle_25544.txt": "ISS\n1 ...\n2 ...\n",
  "amsat_catalog.json": { big: true },
  "amsat_status.json": { x: 1 },
  "worked.json": { version: 1, items: [] },
  "rotor_track.log": "log line\n",
};

test("backup: config files in, caches / logs out; format header", () => {
  const d = tmpDir(Object.assign({ "profiles.json": PROFILES, "sat-offsets.json": OFFSETS, "ul-fixed.json": { "AO-91|0": true } }, CACHES));
  const b = backup.buildBackup({ dir: d, appVersion: "UAT-test.1", now: Date.UTC(2026, 9, 27, 16, 5), browser: { mapView: "globe" } });
  assert.strictEqual(b.format, "pi-sat-track-backup");
  assert.strictEqual(b.version, 1);
  assert.strictEqual(b.appVersion, "UAT-test.1");
  assert.strictEqual(b.created, "2026-10-27T16:05:00.000Z");
  assert.deepStrictEqual(Object.keys(b.server).sort(), ["profiles", "satOffsets", "tleSources", "ulFixed"]);
  assert.deepStrictEqual(b.server.profiles, PROFILES);
  assert.deepStrictEqual(b.server.satOffsets, OFFSETS);
  assert.strictEqual(b.server.tleSources, null, "absent file = null");
  const text = JSON.stringify(b);
  for (const c of ["tle_", "amsat_catalog", "big", "worked", "rotor_track", "log line"]) assert.ok(!text.includes(c), "cache leaked: " + c);
  assert.deepStrictEqual(b.browser, { mapView: "globe" });
  assert.ok(backup.validate(b).ok, "a fresh backup validates");
});

test("validate: rejects non-JSON, wrong format, newer / bad version, missing or bad profiles", () => {
  const good = backup.buildBackup({ dir: tmpDir({ "profiles.json": PROFILES }) });
  const cases = [
    ["{not json", /Not a JSON file/],
    [JSON.stringify([1, 2]), /not a JSON object/],
    [{ format: "something-else", version: 1, server: good.server }, /format/],
    [Object.assign({}, good, { version: 2 }), /newer than this app/],
    [Object.assign({}, good, { version: "1" }), /no valid version/],
    [Object.assign({}, good, { server: null }), /no server settings/],
    [Object.assign({}, good, { server: { profiles: { active: "x", profiles: {} } } }), /no station profiles/],
    [Object.assign({}, good, { server: { profiles: { active: "x", profiles: { a: "str" } } } }), /not an object/],
    [Object.assign({}, good, { server: { profiles: { active: "a", profiles: { a: { config: [1] } } } } }), /invalid config/],
    [Object.assign({}, good, { server: Object.assign({}, good.server, { tleSources: { sources: "celestrak" } }) }), /TLE sources/],
    [Object.assign({}, good, { browser: [1] }), /browser section/],
    ["x".repeat(backup.MAX_BYTES + 1), /too large/],
  ];
  for (const [input, re] of cases) {
    const r = backup.validate(input);
    assert.strictEqual(r.ok, false, "should reject: " + re);
    assert.match(r.error, re);
  }
});

test("validate: summary for the confirm; browser caches dropped; bad active -> first profile", () => {
  const b = { format: "pi-sat-track-backup", version: 1, appVersion: "v9", created: "2026-10-27T16:05:00.000Z",
    server: { profiles: Object.assign({}, PROFILES, { active: "gone" }), satOffsets: OFFSETS, tleSources: { sources: ["amsat", "celestrak"] } },
    browser: { mapView: "globe", satTrackerConfig: "{}", wsjtxKindFilter: '{"me":true}', n: 5 } };
  const v = backup.validate(b);
  assert.ok(v.ok, v.error);
  assert.deepStrictEqual(v.summary.profileNames, ["home", "portable"]);
  assert.strictEqual(v.summary.activeProfile, "home");
  assert.strictEqual(v.summary.favorites, 3);
  assert.strictEqual(v.summary.offsetSats, 1);
  assert.deepStrictEqual(v.summary.tleSources, ["amsat", "celestrak"]);
  assert.deepStrictEqual(v.browser, { mapView: "globe", wsjtxKindFilter: '{"me":true}' });
  assert.strictEqual(v.summary.browserKeys, 2);
});

test("restore: safety copy of the current config first, then files replaced; null removes, missing keeps", () => {
  const cur = { active: "old", profiles: { old: { favorites: ["FO-29"], config: { callsign: "OLD" } } } };
  const d = tmpDir(Object.assign({ "profiles.json": cur, "ul-fixed.json": { "X|0": true }, "tle-sources.json": { sources: ["satnogs"] } }, CACHES));
  const b = { format: "pi-sat-track-backup", version: 1, server: { profiles: PROFILES, satOffsets: OFFSETS, ulFixed: null } };
  const r = backup.restore(JSON.stringify(b), { dir: d, appVersion: "t", now: Date.UTC(2026, 9, 27, 16, 6, 7) });
  assert.ok(r.ok, r.error);
  assert.strictEqual(path.dirname(r.safetyCopy), path.join(d, "backups"));
  assert.match(path.basename(r.safetyCopy), /^pre-restore-2026-10-27T16-06-07-000Z\.json$/);
  const safety = JSON.parse(fs.readFileSync(r.safetyCopy, "utf8"));
  assert.ok(backup.validate(safety).ok, "safety copy is itself a restorable backup");
  assert.deepStrictEqual(safety.server.profiles, cur);
  assert.deepStrictEqual(safety.server.ulFixed, { "X|0": true });
  const now = JSON.parse(fs.readFileSync(path.join(d, "profiles.json"), "utf8"));
  assert.strictEqual(now.active, "home");
  assert.deepStrictEqual(Object.keys(now.profiles), ["home", "portable"]);
  assert.strictEqual(now.profiles.home.config.callsign, "N0CALL");
  assert.deepStrictEqual(now.profiles.home.favorites, ["ISS", "SO-50"]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(d, "sat-offsets.json"), "utf8")), OFFSETS);
  assert.ok(!fs.existsSync(path.join(d, "ul-fixed.json")), "null = removed");
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(d, "tle-sources.json"), "utf8")), { sources: ["satnogs"] }, "missing key = untouched");
  assert.ok(fs.existsSync(path.join(d, "tle_25544.txt")) && fs.existsSync(path.join(d, "worked.json")), "caches untouched");
  // round trip: restoring the safety copy brings the old config back
  assert.ok(backup.restore(fs.readFileSync(r.safetyCopy, "utf8"), { dir: d, now: Date.UTC(2026, 9, 27, 16, 7) }).ok);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(d, "profiles.json"), "utf8")).active, "old");
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(d, "ul-fixed.json"), "utf8")), { "X|0": true });
});

test("restore: a bad file changes nothing and writes no safety copy", () => {
  const cur = { active: "old", profiles: { old: { favorites: [], config: { callsign: "OLD" } } } };
  const d = tmpDir({ "profiles.json": cur });
  const before = fs.readFileSync(path.join(d, "profiles.json"), "utf8");
  for (const bad of ["nope", JSON.stringify({ format: "pi-sat-track-backup", version: 1, server: {} })]) {
    const r = backup.restore(bad, { dir: d });
    assert.strictEqual(r.ok, false);
  }
  assert.strictEqual(fs.readFileSync(path.join(d, "profiles.json"), "utf8"), before);
  assert.ok(!fs.existsSync(path.join(d, "backups")));
});

test("restore: keeps only the newest safety copies", () => {
  const d = tmpDir({ "profiles.json": PROFILES });
  const b = JSON.stringify({ format: "pi-sat-track-backup", version: 1, server: { profiles: PROFILES } });
  for (let i = 0; i < 5; i++) assert.ok(backup.restore(b, { dir: d, keep: 3, now: Date.UTC(2026, 0, 1, 0, i) }).ok);
  const left = fs.readdirSync(path.join(d, "backups")).sort();
  assert.strictEqual(left.length, 3);
  assert.match(left[0], /T00-02-00/);
});

test("server: endpoints wired, JSON content type required, live reload like a profile switch", () => {
  const src = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  assert.match(src, /urlPath === "\/api\/backup" && req\.method === "GET"/);
  assert.match(src, /urlPath === "\/api\/restore"/);
  assert.match(src, /Content-Type must be application\/json/);
  assert.match(src, /satOffsets\.flush\(\); \/\/ so the safety copy/);
  const fn = src.slice(src.indexOf("function reloadConfigAfterRestore"));
  for (const re of [/sat-offsets"\)\.reload\(\)/, /tle\.reloadTleSourcesPref\(\)/, /profiles\.load\(\)/, /applyProfileToRuntime\(profiles\.getActive\(\)\)/, /broadcastProfiles\(\)/])
    assert.match(fn, re);
});

test("client: buttons in Configure → Station, secrets note, filename, browser prefs exclude caches (same list as server)", () => {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const station = html.slice(html.indexOf('data-tab="station" role="tabpanel"'), html.indexOf('data-tab="radio" role="tabpanel"'));
  assert.match(station, /id="btn-backup-download"[^>]*>Download backup</);
  assert.match(station, /id="btn-backup-restore"[^>]*>Restore from backup</);
  assert.match(station, /passwords or passcodes/);
  assert.match(html, /<script src="js\/settings-backup\.js"><\/script>/);
  const ls = { mapView: "globe", satTrackerConfig: "{}", aprsHistory: "[]", wsjtxKindFilter: "{}" };
  const ctx = {
    console, Object, JSON, String, Date, Math, Array, Promise,
    localStorage: { get length() { return Object.keys(ls).length; }, key: (i) => Object.keys(ls)[i], getItem: (k) => (k in ls ? ls[k] : null), setItem() {}, removeItem() {} },
    document: { readyState: "complete", getElementById: () => null, addEventListener() {} },
    location: {}, setTimeout,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/settings-backup.js"), "utf8"), ctx);
  const sb = ctx.settingsBackup;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sb.browserPrefs())), { mapView: "globe", wsjtxKindFilter: "{}" });
  assert.deepStrictEqual([...sb.BROWSER_EXCLUDE].sort(), [...backup.BROWSER_EXCLUDE].sort());
  assert.strictEqual(sb.fileName(new Date(2026, 9, 27, 9, 5)), "pi-sat-track-backup-2026-10-27-0905.json");
  const txt = sb.summaryText({ created: "2026-10-27T16:05:00.000Z", appVersion: "v9", profileNames: ["home", "portable"], activeProfile: "home", favorites: 3, offsetSats: 1, tleSources: null, browserKeys: 2 });
  assert.match(txt, /2 profiles: home, portable \(active: home\)/);
  assert.match(txt, /saved first to ~\/\.rpitrack\/backups\//);
});
