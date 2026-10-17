// After-LOS action (Configure → Rotor → After LOS): plan, auto-select pick,
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
assert.strictEqual(al.normMode("bogus"), "none");
assert.strictEqual(al.normMode(undefined), "none");

const passesInPass = [{ aos: new Date(T0 - 2 * M).toISOString(), los: new Date(T0 + 8 * M).toISOString() }];
const passesBefore = [{ aos: new Date(T0 + 30 * M).toISOString(), los: new Date(T0 + 40 * M).toISOString() }];
const favs = [fav("AO-91"), fav("AO-7", 20, 30, 10), fav("SO-50", 60, 70, 40), fav("ISS", null)];
const keys = ["AO-91", "AO-7", "SO-50", "ISS"];

let p = al.plan({ mode: "none", sat: "AO-91", favoriteKeys: keys, favorites: favs, passes: passesInPass, now: T0 });
assert.deepStrictEqual(
  { mode: p.mode, inPass: p.inPass, losMs: p.losMs, target: p.target, fallback: p.fallback },
  { mode: "none", inPass: true, losMs: T0 + 8 * M, target: null, fallback: null },
);
p = al.plan({ mode: "none", sat: "AO-91", passes: passesBefore, now: T0 });
assert.strictEqual(p.inPass, false);
assert.strictEqual(p.losMs, T0 + 40 * M, "between passes keys off the next pass LOS");

// park: antenna off → fallback
p = al.plan({ mode: "park", sat: "AO-91", passes: passesInPass, now: T0, antennaOn: false });
assert.strictEqual(p.fallback, "antenna-off");
p = al.plan({ mode: "park", sat: "AO-91", passes: passesInPass, now: T0, antennaOn: true });
assert.strictEqual(p.fallback, null);

// auto: soonest AOS favorite after LOS, current sat excluded, no-pass favorite ignored
p = al.plan({ mode: "auto", sat: "AO-91", favoriteKeys: keys, favorites: favs, passes: passesInPass, now: T0 });
assert.strictEqual(p.target && p.target.key, "AO-7");
assert.strictEqual(p.fallback, null);

// auto fallbacks
assert.strictEqual(al.plan({ mode: "auto", sat: "AO-91", favoriteKeys: [], favorites: favs, passes: passesInPass, now: T0 }).fallback, "no-favorites");
assert.strictEqual(al.plan({ mode: "auto", sat: "AO-27", favoriteKeys: keys, favorites: favs, passes: passesInPass, now: T0 }).fallback, "not-favorite");
assert.strictEqual(
  al.plan({ mode: "auto", sat: "AO-91", favoriteKeys: ["AO-91", "ISS"], favorites: favs, passes: passesInPass, now: T0 }).fallback,
  "no-upcoming-pass",
);
// computeFavoritesLooks lists the selected sat even if not a favorite — must not count
assert.strictEqual(al.plan({ mode: "auto", sat: "AO-27", favoriteKeys: keys, favorites: [fav("AO-27", 1, 5, 50)].concat(favs), passes: passesInPass, now: T0 }).fallback, "not-favorite");

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
  const st = (sat, a) => ({ sat, afterLos: a });
  const inPass = (mode, extra) => Object.assign({ mode, inPass: true, losMs: T0 + 8 * M, target: null, fallback: null }, extra);
  const after = (mode, extra) => Object.assign({ mode, inPass: false, losMs: T0 + 90 * M, target: null, fallback: null }, extra);

  // never armed → nothing even past LOS
  assert.strictEqual(w(st("AO-91", after("park"))), null);
  // park: arm in pass, fire once after LOS
  assert.strictEqual(w(st("AO-91", inPass("park"))), null);
  assert(w.isArmed());
  now = T0 + 8 * M + 500;
  assert.strictEqual(w(st("AO-91", after("park"))), "park");
  assert.strictEqual(w(st("AO-91", after("park"))), null, "fires once per pass");
  assert.deepStrictEqual(calls, ["park"]);
  assert.deepStrictEqual(events, [{ action: "park", sat: "AO-91" }]);

  // park with antenna off at LOS → skipped
  now = T0;
  w(st("AO-91", inPass("park")));
  now = T0 + 9 * M;
  assert.strictEqual(w(st("AO-91", after("park", { fallback: "antenna-off" }))), "skip");
  assert.deepStrictEqual(calls, ["park"]);

  // auto select
  now = T0;
  const tgt = { key: "AO-7", display: "AO-7", aos: T0 + 20 * M, los: T0 + 30 * M, maxEl: 10 };
  w(st("AO-91", inPass("auto", { target: tgt })));
  now = T0 + 8 * M + 100;
  assert.strictEqual(w(st("AO-91", after("auto", { target: tgt }))), "auto");
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(calls.slice(-1), ["select:AO-7"]);
  assert.strictEqual(events.slice(-1)[0].action, "auto");
  assert.strictEqual(events.slice(-1)[0].target, "AO-7");

  // auto with nothing to select → do nothing
  now = T0;
  w(st("AO-91", inPass("auto")));
  now = T0 + 9 * M;
  assert.strictEqual(w(st("AO-91", after("auto", { fallback: "not-favorite" }))), "skip");

  // manual selection mid-pass disarms
  now = T0;
  w(st("AO-91", inPass("park")));
  now = T0 + 2 * M;
  w(st("SO-50", after("park")));
  assert(!w.isArmed(), "sat change disarms");
  now = T0 + 9 * M;
  assert.strictEqual(w(st("SO-50", after("park"))), null);

  // mode "none" → never acts
  now = T0;
  w(st("AO-91", inPass("none")));
  now = T0 + 9 * M;
  assert.strictEqual(w(st("AO-91", after("none"))), null);
  const nCalls = calls.length;
  assert.strictEqual(calls.length, nCalls);

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
