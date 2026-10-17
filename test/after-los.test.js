// After-LOS actions (Configure → Rotor → After LOS = Park; top-bar Auto Select): plan, auto-select pick,
// once-per-pass watcher, and rotor registry hooks (deferred prep / park resume).
// Run: node test/after-los.test.js
const assert = require("assert");
const al = require("../lib/after-los");

const T0 = Date.UTC(2026, 9, 17, 17, 0, 0);
const M = 60 * 1000;
const fav = (key, aosMin, losMin, maxEl) => ({
  key,
  display: key,
  nextPass: aosMin == null ? null : { aos: T0 + aosMin * M, los: T0 + losMin * M, maxEl },
});

// ---- normMode / plan basics
assert.strictEqual(al.normMode("PARK"), "park");
assert.strictEqual(al.normMode("auto"), "none", "legacy auto → none");
assert.strictEqual(al.normMode("bogus"), "none");
assert.strictEqual(al.normMode(undefined), "none");

const passesInPass = [{ aos: new Date(T0 - 2 * M).toISOString(), los: new Date(T0 + 8 * M).toISOString() }];
const passesBefore = [{ aos: new Date(T0 + 30 * M).toISOString(), los: new Date(T0 + 40 * M).toISOString() }];
const favs = [fav("AO-91"), fav("AO-7", 20, 30, 10), fav("SO-50", 60, 70, 40), fav("ISS", null)];
const keys = ["AO-91", "AO-7", "SO-50", "ISS"];

let p = al.plan({ mode: "none", sat: "AO-91", favoriteKeys: keys, favorites: favs, passes: passesInPass, now: T0 });
assert.deepStrictEqual(p, {
  mode: "none", autoSelect: false, losMs: T0 + 8 * M, inPass: true,
  park: false, parkFallback: null, target: null, fallback: null,
});
p = al.plan({ mode: "none", sat: "AO-91", passes: passesBefore, now: T0 });
assert.strictEqual(p.inPass, false);
assert.strictEqual(p.losMs, T0 + 40 * M, "between passes keys off the next pass LOS");

// park: antenna off → fallback
p = al.plan({ mode: "park", sat: "AO-91", passes: passesInPass, now: T0, antennaOn: false });
assert.strictEqual(p.park, false);
assert.strictEqual(p.parkFallback, "antenna-off");
p = al.plan({ mode: "park", sat: "AO-91", passes: passesInPass, now: T0, antennaOn: true });
assert.strictEqual(p.park, true);
assert.strictEqual(p.parkFallback, null);

// auto select (button): independent of After LOS mode / antenna
p = al.plan({ mode: "none", autoSelect: true, sat: "AO-91", favoriteKeys: keys, favorites: favs, passes: passesInPass, now: T0 });
assert.strictEqual(p.target && p.target.key, "AO-7");
assert.strictEqual(p.fallback, null);
p = al.plan({ mode: "none", autoSelect: false, sat: "AO-91", favoriteKeys: keys, favorites: favs, passes: passesInPass, now: T0 });
assert.strictEqual(p.target, null, "button off → no target");
// legacy mode "auto" alone does nothing
p = al.plan({ mode: "auto", sat: "AO-91", favoriteKeys: keys, favorites: favs, passes: passesInPass, now: T0 });
assert.strictEqual(p.mode, "none");
assert.strictEqual(p.target, null);
// park + auto together
p = al.plan({ mode: "park", autoSelect: true, antennaOn: true, sat: "AO-91", favoriteKeys: keys, favorites: favs, passes: passesInPass, now: T0 });
assert.strictEqual(p.park, true);
assert.strictEqual(p.target.key, "AO-7");

// auto fallbacks
const A = (o) => al.plan(Object.assign({ mode: "none", autoSelect: true, passes: passesInPass, now: T0 }, o)).fallback;
assert.strictEqual(A({ sat: "AO-91", favoriteKeys: [], favorites: favs }), "no-favorites");
assert.strictEqual(A({ sat: "AO-27", favoriteKeys: keys, favorites: favs }), "not-favorite");
assert.strictEqual(A({ sat: "AO-91", favoriteKeys: ["AO-91", "ISS"], favorites: favs }), "no-upcoming-pass");
// before the pass, favorites' single next pass may not reach past this LOS yet
assert.strictEqual(
  al.plan({ mode: "none", autoSelect: true, sat: "AO-91", favoriteKeys: keys, favorites: favs, passes: [{ aos: T0 + 300 * M, los: T0 + 310 * M }], now: T0 }).fallback,
  "pending",
);
// computeFavoritesLooks lists the selected sat even if not a favorite — must not count
assert.strictEqual(A({ sat: "AO-27", favoriteKeys: keys, favorites: [fav("AO-27", 1, 5, 50)].concat(favs) }), "not-favorite");

// ---- pickAutoTarget: ends before LOS excluded; already-up counts as "now"; tie → higher max EL
const afterMs = T0 + 10 * M;
assert.strictEqual(al.pickAutoTarget("X", ["A", "B"], [fav("A", 0, 9, 50), fav("B", 30, 40, 20)], afterMs).key, "B", "pass ending before LOS skipped");
assert.strictEqual(al.pickAutoTarget("X", ["A", "B"], [fav("A", 5, 15, 12), fav("B", 30, 40, 80)], afterMs).key, "A", "already up wins over later");
assert.strictEqual(al.pickAutoTarget("X", ["A", "B"], [fav("A", 2, 15, 12), fav("B", 6, 20, 60)], afterMs).key, "B", "both up at LOS → higher max EL");
assert.strictEqual(al.pickAutoTarget("X", ["A", "B"], [fav("A", 30, 40, 15), fav("B", 30.5, 41, 45)], afterMs).key, "B", "AOS within 60 s → higher max EL");
assert.strictEqual(al.pickAutoTarget("X", ["A", "B"], [fav("A", 30, 40, 15), fav("B", 32, 41, 45)], afterMs).key, "A", "AOS 2 min apart → soonest");
assert.strictEqual(al.pickAutoTarget("X", ["A"], [fav("A", 30, 40, 15)], afterMs).start, undefined, "no internal fields leak");

// ---- watcher
(async () => {
  let now = T0;
  const calls = [];
  const events = [];
  const w = al.createWatcher({
    now: () => now,
    park: () => calls.push("park"),
    selectSat: async (k) => calls.push("select:" + k),
    notify: (e) => events.push(e),
    log: () => {},
  });
  const tick = () => new Promise((r) => setImmediate(r));
  const st = (sat, a) => ({ sat, afterLos: a });
  const base = { mode: "none", autoSelect: false, park: false, parkFallback: null, target: null, fallback: null };
  const inPass = (extra) => Object.assign({}, base, { inPass: true, losMs: T0 + 8 * M }, extra);
  const after = (extra) => Object.assign({}, base, { inPass: false, losMs: T0 + 90 * M }, extra);
  const PARK = { mode: "park", park: true };
  const tgt = { key: "AO-7", display: "AO-7", aos: T0 + 20 * M, los: T0 + 30 * M, maxEl: 10 };
  const AUTO = { autoSelect: true, target: tgt };

  // never armed → nothing even past LOS
  assert.strictEqual(w(st("AO-91", after(PARK))), null);
  // park: arm in pass, fire once after LOS
  assert.strictEqual(w(st("AO-91", inPass(PARK))), null);
  assert(w.isArmed());
  now = T0 + 8 * M + 500;
  assert.deepStrictEqual(w(st("AO-91", after(PARK))), ["park"]);
  assert.strictEqual(w(st("AO-91", after(PARK))), null, "fires once per pass");
  assert.deepStrictEqual(calls, ["park"]);
  assert.deepStrictEqual(events, [{ sat: "AO-91", park: true }]);

  // park with antenna off at LOS → skipped
  now = T0;
  w(st("AO-91", inPass({ mode: "park", parkFallback: "antenna-off" })));
  now = T0 + 9 * M;
  assert.deepStrictEqual(w(st("AO-91", after({ mode: "park", parkFallback: "antenna-off" }))), []);
  assert.deepStrictEqual(calls, ["park"]);

  // auto select only
  now = T0;
  w(st("AO-91", inPass(AUTO)));
  now = T0 + 8 * M + 100;
  assert.deepStrictEqual(w(st("AO-91", after(AUTO))), ["auto"]);
  await tick();
  assert.deepStrictEqual(calls.slice(-1), ["select:AO-7"]);
  assert.deepStrictEqual(events.slice(-1)[0], { sat: "AO-91", park: false, target: "AO-7", display: "AO-7", aos: tgt.aos });

  // park + auto select together: park first, then select, one combined event
  calls.length = 0;
  events.length = 0;
  now = T0;
  w(st("AO-91", inPass(Object.assign({}, PARK, AUTO))));
  now = T0 + 9 * M;
  assert.deepStrictEqual(w(st("AO-91", after(Object.assign({}, PARK, AUTO)))), ["park", "auto"]);
  await tick();
  assert.deepStrictEqual(calls, ["park", "select:AO-7"]);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].park, true);
  assert.strictEqual(events[0].target, "AO-7");
  assert.strictEqual(w(st("AO-7", after(Object.assign({}, PARK, AUTO)))), null, "one shot");

  // regression (seen live): after LOS the live plan keys off the NEXT pass and
  // may have no target — the target from the pass that just ended is used.
  calls.length = 0;
  now = T0;
  w(st("AO-91", inPass(AUTO)));
  now = T0 + 9 * M;
  assert.deepStrictEqual(w(st("AO-91", after({ autoSelect: true, fallback: "no-upcoming-pass" }))), ["auto"]);
  await tick();
  assert.deepStrictEqual(calls, ["select:AO-7"]);
  // ...unless that target's pass is already over by the time LOS is processed
  calls.length = 0;
  now = T0;
  w(st("AO-91", inPass(AUTO)));
  now = T0 + 31 * M;
  assert.deepStrictEqual(w(st("AO-91", after(AUTO))), []);
  // button turned off during the pass → no select
  now = T0;
  w(st("AO-91", inPass(AUTO)));
  now = T0 + 9 * M;
  assert.deepStrictEqual(w(st("AO-91", after({}))), []);
  assert.deepStrictEqual(calls, []);

  // auto with nothing to select → do nothing
  now = T0;
  w(st("AO-91", inPass({ autoSelect: true, fallback: "not-favorite" })));
  now = T0 + 9 * M;
  assert.deepStrictEqual(w(st("AO-91", after({ autoSelect: true, fallback: "not-favorite" }))), []);

  // manual selection mid-pass disarms
  now = T0;
  w(st("AO-91", inPass(PARK)));
  now = T0 + 2 * M;
  w(st("SO-50", after(PARK)));
  assert(!w.isArmed(), "sat change disarms");
  now = T0 + 9 * M;
  assert.strictEqual(w(st("SO-50", after(PARK))), null);

  // nothing configured → never acts
  now = T0;
  w(st("AO-91", inPass({})));
  now = T0 + 9 * M;
  assert.deepStrictEqual(w(st("AO-91", after({}))), []);

  // ---- profiles: autoSelect persisted per profile; legacy rotorAfterLos auto → none
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "afterlos-"));
  const realHome = os.homedir;
  os.homedir = () => tmpHome;
  fs.mkdirSync(path.join(tmpHome, ".rpitrack"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpHome, ".rpitrack", "profiles.json"),
    JSON.stringify({ active: "default", profiles: { default: { favorites: ["AO-7"], config: { rotorAfterLos: "auto" } } } }),
  );
  delete require.cache[require.resolve("../lib/profiles")];
  const profiles = require("../lib/profiles");
  profiles.load();
  assert.strictEqual(profiles.getActive().config.rotorAfterLos, "none", "legacy auto migrated");
  assert.strictEqual(profiles.getActive().autoSelect, false);
  profiles.updateActive({ autoSelect: true });
  assert.strictEqual(profiles.publicPayload().autoSelect, true);
  profiles.load();
  assert.strictEqual(profiles.getActive().autoSelect, true, "persisted");
  profiles.updateActive({ favorites: ["AO-7", "SO-50"] });
  assert.strictEqual(profiles.getActive().autoSelect, true, "other patches keep it");
  profiles.updateActive({ autoSelect: false });
  assert.strictEqual(profiles.getActive().autoSelect, false);
  os.homedir = realHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });

  // ---- config: legacy "auto" → none, no rotor reconnect
  const config = require("../lib/config");
  let flags = config.applyEndpoints({ rotorAfterLos: "park" });
  assert.strictEqual(config.ROTOR_AFTER_LOS, "park");
  assert(!flags || !flags.rotorChanged, "After LOS is not a rotor hardware change");
  config.applyEndpoints({ rotorAfterLos: "auto" });
  assert.strictEqual(config.ROTOR_AFTER_LOS, "none");

  // ---- rotor registry hooks (stub the active driver's methods)
  const rotors = require("../lib/rotors");
  const d = rotors.active();
  assert.notStrictEqual(d.meta.id, "none", "a real driver is active by default");
  const seen = [];
  d.updateTracking = (look, a, l, meta) => seen.push(Object.assign({}, meta));
  d.park = () => seen.push("park");
  d.setAntenna = (on) => seen.push("antenna:" + on);
  d.resumeAfterPark = () => seen.push("resume");
  const look = { az: 100, el: -5 };

  // deferSwitchPrep: only the first update for that sat carries the flag
  rotors.deferSwitchPrep("AO-7");
  rotors.updateTracking(look, null, null, { satKey: "AO-91" });
  assert.strictEqual(seen.pop().deferSwitchPrep, undefined, "old sat tick does not consume");
  rotors.updateTracking(look, null, null, { satKey: "AO-7" });
  assert.strictEqual(seen.pop().deferSwitchPrep, true);
  rotors.updateTracking(look, null, null, { satKey: "AO-7" });
  assert.strictEqual(seen.pop().deferSwitchPrep, undefined, "flag consumed once");
  rotors.deferSwitchPrep("AO-7");
  rotors.deferSwitchPrep(null); // manual selection clears
  rotors.updateTracking(look, null, null, { satKey: "AO-7" });
  assert.strictEqual(seen.pop().deferSwitchPrep, undefined);

  // afterLosPark: resume at T-5 (not before), once
  seen.length = 0;
  rotors.afterLosPark();
  assert.deepStrictEqual(seen, ["park"]);
  const t = Date.now();
  rotors.updateTracking(look, null, null, { satKey: "AO-91", minEl: 0, nextAosMs: t + 30 * M });
  assert(!seen.includes("resume"), "no resume 30 min out");
  rotors.updateTracking(look, null, null, { satKey: "AO-91", minEl: 0, nextAosMs: t + 4 * M });
  assert.strictEqual(seen.filter((x) => x === "resume").length, 1, "resume at T-5");
  rotors.updateTracking(look, null, null, { satKey: "AO-91", minEl: 0, nextAosMs: t + 3 * M });
  assert.strictEqual(seen.filter((x) => x === "resume").length, 1, "resume once");
  // resume when already up (overlap / switched to a sat in view)
  seen.length = 0;
  rotors.afterLosPark();
  rotors.updateTracking({ az: 100, el: 20 }, null, null, { satKey: "AO-7", minEl: 10 });
  assert(seen.includes("resume"));
  // manual Antenna / Park cancel the pending resume; manual park never resumes
  for (const cancel of [() => rotors.setAntenna(false), () => rotors.park()]) {
    seen.length = 0;
    rotors.afterLosPark();
    cancel();
    rotors.updateTracking(look, null, null, { satKey: "AO-91", minEl: 0, nextAosMs: Date.now() + M });
    assert(!seen.includes("resume"), "manual action cancels resume");
  }
  assert.deepStrictEqual(rotors.afterLosPending(), { resumeAtPrep: false, deferPrepKey: null });

  console.log("after-los.test.js OK");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
