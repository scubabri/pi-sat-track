// Auto Engage engine (lib/auto-engage.js) with a fake clock and fake
// Radio / Antenna / rotor: top-bar button (every pass of the selected sat),
// per-pass marks, After-LOS park + Auto Select chaining, Moon skipped.
// Run: node --test --test-force-exit test/auto-engage.test.js
const test = require("node:test");
const assert = require("assert");
const AE = require("../lib/auto-engage");
const AL = require("../lib/after-los");
const C = require("../js/auto-engage-core");

const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 9, 24, 18, 0, 0);
const iso = (t) => new Date(t).toISOString();
const pass = (aosMin, losMin) => ({ aos: iso(T0 + aosMin * MIN), los: iso(T0 + losMin * MIN) });

/** Fake station: clock, radio, antenna, rotor park, selected sat. */
function rig(opts) {
  const o = Object.assign({ radio: true, antenna: true }, opts || {});
  const h = {
    t: T0,
    radioOn: false,
    antennaOn: false,
    parkPending: false,
    sat: o.sat || "ISS",
    calls: [],
    logs: [],
    events: [],
    selects: [],
    cancelResume: 0,
  };
  h.engine = AE.createEngine({
    now: () => h.t,
    log: (m) => h.logs.push(m),
    notify: (e) => h.events.push(e),
    radioAvailable: () => o.radio,
    antennaAvailable: () => o.antenna,
    radioOn: () => h.radioOn,
    antennaOn: () => h.antennaOn,
    setRadio: (on) => { h.calls.push("radio:" + (on ? "on" : "off")); h.radioOn = on; },
    setAntenna: (on) => { h.calls.push("antenna:" + (on ? "on" : "off")); h.antennaOn = on; },
    selectSat: (k) => { h.selects.push(k); return Promise.resolve(); },
    parkPending: () => h.parkPending,
    cancelParkResume: () => { h.cancelResume++; h.parkPending = false; },
  });
  h.check = (ctx) => h.engine.check(Object.assign({ sat: h.sat, passes: [], toggle: false, marks: [] }, ctx));
  h.at = (min) => { h.t = T0 + min * MIN; return h; };
  return h;
}

/* ---------------- top-bar button ---------------- */

test("button: engages Radio + Antenna at T-5 (not before), off after LOS", () => {
  const h = rig();
  const ctx = { toggle: true, passes: [pass(30, 40)] };
  h.at(24.9).check(ctx);
  assert.deepStrictEqual(h.calls, [], "nothing at T-5:06");
  h.at(25).check(ctx);
  assert.deepStrictEqual(h.calls, ["radio:on", "antenna:on"], "T-5:00");
  assert.ok(h.logs.some((l) => /Auto Engage: engage ISS pass AOS .*turned on Radio \+ Antenna/.test(l)), "info log");
  const st = h.engine.status();
  assert.strictEqual(st.engaged.sat, "ISS");
  assert.ok(st.engaged.radio && st.engaged.antenna);
  for (const m of [26, 30, 35, 39.9]) h.at(m).check(ctx);
  assert.strictEqual(h.calls.length, 2, "nothing more during the pass");
  // after LOS the state list moves on to the next pass
  h.at(40.05).check({ toggle: true, passes: [pass(130, 140)] });
  assert.deepStrictEqual(h.calls.slice(2), ["radio:off", "antenna:off"]);
  assert.ok(h.logs.some((l) => /Auto Engage: disengage ISS \(LOS\) — Radio off, Antenna off/.test(l)));
  assert.strictEqual(h.engine.status().engaged, null);
  // next pass engages again at its own T-5
  h.at(124.9).check({ toggle: true, passes: [pass(130, 140)] });
  assert.strictEqual(h.calls.length, 4);
  h.at(125).check({ toggle: true, passes: [pass(130, 140)] });
  assert.deepStrictEqual(h.calls.slice(4), ["radio:on", "antenna:on"]);
});

test("button off: never engages", () => {
  const h = rig();
  for (const m of [25, 30, 35]) h.at(m).check({ toggle: false, passes: [pass(30, 40)] });
  assert.deepStrictEqual(h.calls, []);
});

test("only disengages what it turned on (Radio already on manually stays on)", () => {
  const h = rig();
  h.radioOn = true; // user turned the radio on before the pass
  const ctx = { toggle: true, passes: [pass(30, 40)] };
  h.at(25).check(ctx);
  assert.deepStrictEqual(h.calls, ["antenna:on"]);
  assert.ok(h.logs.some((l) => /Radio already on \(left as is\)/.test(l)));
  h.at(41).check({ toggle: true, passes: [pass(130, 140)] });
  assert.deepStrictEqual(h.calls, ["antenna:on", "antenna:off"]);
  assert.strictEqual(h.radioOn, true, "manual radio left on");
});

test("manual off during the pass is respected (not re-enabled, not touched at LOS)", () => {
  const h = rig();
  const ctx = { toggle: true, passes: [pass(30, 40)] };
  h.at(25).check(ctx);
  h.at(31);
  h.engine.userSet("radio", false); // Radio button
  h.radioOn = false;
  for (const m of [31, 33, 36]) h.at(m).check(ctx);
  assert.deepStrictEqual(h.calls, ["radio:on", "antenna:on"], "radio not re-enabled");
  assert.ok(h.logs.some((l) => /Radio turned off manually — not re-enabling/.test(l)));
  // user turns it back on themselves: it is theirs now, left on after LOS
  h.engine.userSet("radio", true);
  h.radioOn = true;
  h.at(41).check({ toggle: true, passes: [pass(130, 140)] });
  assert.deepStrictEqual(h.calls, ["radio:on", "antenna:on", "antenna:off"]);
  assert.strictEqual(h.radioOn, true);
});

test("manual off then sat switched away and back mid-pass: still not re-enabled", () => {
  const h = rig();
  const ctx = { toggle: true, passes: [pass(30, 40)] };
  h.at(25).check(ctx);
  h.engine.userSet("antenna", false);
  h.antennaOn = false;
  h.sat = "SO-50";
  h.at(32).check({ toggle: true, passes: [pass(300, 310)] });
  assert.deepStrictEqual(h.calls, ["radio:on", "antenna:on", "radio:off"], "SO-50 not near a pass: disengaged");
  h.sat = "ISS";
  h.at(33).check(ctx);
  assert.deepStrictEqual(h.calls.slice(3), ["radio:on"], "radio again, antenna stays off (manual off this pass)");
});

test("toggled on mid-pass (and inside T-5) engages immediately", () => {
  const h = rig();
  h.at(33).check({ toggle: false, passes: [pass(30, 40)] });
  assert.deepStrictEqual(h.calls, []);
  h.at(33.1).check({ toggle: true, passes: [pass(30, 40)] });
  assert.deepStrictEqual(h.calls, ["radio:on", "antenna:on"], "in pass");
  const g = rig();
  g.at(27).check({ toggle: true, passes: [pass(30, 40)] });
  assert.deepStrictEqual(g.calls, ["radio:on", "antenna:on"], "within T-5");
});

test("button turned off mid-pass: stops managing, leaves Radio / Antenna on", () => {
  const h = rig();
  h.at(25).check({ toggle: true, passes: [pass(30, 40)] });
  h.at(32).check({ toggle: false, passes: [pass(30, 40)] });
  h.at(41).check({ toggle: false, passes: [pass(130, 140)] });
  assert.deepStrictEqual(h.calls, ["radio:on", "antenna:on"]);
  assert.ok(h.logs.some((l) => /stopped managing ISS pass/.test(l)));
});

test("only what is configured: no rotor in the profile -> Radio only", () => {
  const h = rig({ antenna: false });
  h.at(25).check({ toggle: true, passes: [pass(30, 40)] });
  assert.deepStrictEqual(h.calls, ["radio:on"]);
  assert.ok(h.logs.some((l) => /Antenna not configured/.test(l)));
  h.at(41).check({ toggle: true, passes: [pass(130, 140)] });
  assert.deepStrictEqual(h.calls, ["radio:on", "radio:off"]);
});

test("Moon (EME) is skipped: button and marks", () => {
  const h = rig({ sat: "MOON" });
  for (const m of [25, 30, 35]) h.at(m).check({ toggle: true, isMoon: true, passes: [pass(30, 300)], marks: [{ key: "MOON", aosMs: T0 + 30 * MIN, losMs: T0 + 300 * MIN }] });
  assert.deepStrictEqual(h.calls, []);
  assert.deepStrictEqual(h.selects, []);
  assert.deepStrictEqual(C.normalizeMarks([{ key: "MOON", aosMs: T0 }, { key: "moon", aosMs: T0 }]), [], "Moon never stored");
  assert.deepStrictEqual(C.toggleMark([], { key: "MOON", aosMs: T0 }), []);
});

test("selected sat changed mid-pass: off if the new sat is not near a pass, handed over if it is", () => {
  const h = rig();
  h.at(25).check({ toggle: true, passes: [pass(30, 40)] });
  h.sat = "AO-7";
  h.at(31).check({ toggle: true, passes: [pass(200, 210)] });
  assert.deepStrictEqual(h.calls, ["radio:on", "antenna:on", "radio:off", "antenna:off"]);
  assert.ok(h.logs.some((l) => /selected sat changed ISS → AO-7/.test(l)));

  const g = rig();
  g.at(25).check({ toggle: true, passes: [pass(30, 40)] });
  g.sat = "SO-50";
  g.at(31).check({ toggle: true, passes: [pass(29, 38)] });
  assert.deepStrictEqual(g.calls, ["radio:on", "antenna:on"], "no off/on blip");
  assert.strictEqual(g.engine.status().engaged.sat, "SO-50");
  assert.ok(g.engine.status().engaged.radio, "still owns the radio");
  g.at(38.1).check({ toggle: true, passes: [pass(130, 140)] });
  assert.deepStrictEqual(g.calls.slice(2), ["radio:off", "antenna:off"]);
});

test("After-LOS park: antenna left to the park; its re-engage is cancelled once parked", () => {
  const h = rig();
  h.at(25).check({ toggle: true, passes: [pass(30, 40)] });
  h.parkPending = true; // rotor.afterLosPark() ran at LOS (watcher runs first)
  h.at(40.05).check({ toggle: true, passes: [pass(130, 140)], afterLosDone: ["park"] });
  assert.deepStrictEqual(h.calls, ["radio:on", "antenna:on", "radio:off"], "antenna not cut mid-park");
  assert.ok(h.logs.some((l) => /Antenna off when the After-LOS park completes/.test(l)));
  h.at(41).check({ toggle: true, passes: [pass(130, 140)] });
  assert.strictEqual(h.cancelResume, 0, "still parking");
  h.antennaOn = false; // park complete -> driver disconnects
  h.at(42).check({ toggle: true, passes: [pass(130, 140)] });
  assert.strictEqual(h.cancelResume, 1, "park's own T-5 re-engage cancelled");
  // the button still engages the next pass at its T-5
  h.at(125).check({ toggle: true, passes: [pass(130, 140)] });
  assert.deepStrictEqual(h.calls.slice(3), ["radio:on", "antenna:on"]);
});

/* ---------------- chaining with Auto Select ---------------- */

/** Real lib/after-los watcher + engine, server.js order: watcher, then engine. */
function chain(nextFav) {
  const h = rig();
  h.watch = AL.createWatcher({ now: () => h.t, park: () => {}, selectSat: (k) => { h.autoSel = k; return Promise.resolve(); } });
  h.cycle = (passesBySat, favNext) => {
    const passes = passesBySat[h.sat] || [];
    const favs = Object.keys(favNext).map((k) => ({ key: k, nextPass: favNext[k] }));
    const st = {
      sat: h.sat,
      passes,
      afterLos: AL.plan({ mode: "none", autoSelect: true, sat: h.sat, favoriteKeys: Object.keys(favNext), favorites: favs, passes, now: h.t }),
    };
    const done = h.watch(st);
    h.check({ toggle: true, passes, afterLos: st.afterLos, afterLosDone: done });
    if (h.autoSel) { h.sat = h.autoSel; h.autoSel = null; } // selectSat lands
  };
  const favNext = { ISS: { aos: T0 + 30 * MIN, los: T0 + 40 * MIN }, "SO-50": nextFav };
  const passesBySat = { ISS: [pass(30, 40)], "SO-50": [{ aos: iso(nextFav.aos), los: iso(nextFav.los) }] };
  return { h, favNext, passesBySat };
}

test("chains with Auto Select: next favorite already within T-5 -> stays on across the switch", () => {
  const { h, favNext, passesBySat } = chain({ aos: T0 + 43 * MIN, los: T0 + 52 * MIN });
  for (const m of [25, 30, 35, 39.9]) h.at(m).cycle(passesBySat, favNext);
  assert.deepStrictEqual(h.calls, ["radio:on", "antenna:on"]);
  h.at(40.05).cycle({ ISS: [pass(130, 140)], "SO-50": passesBySat["SO-50"] }, favNext);
  assert.strictEqual(h.sat, "SO-50", "Auto Select switched");
  h.at(40.1).cycle({ ISS: [pass(130, 140)], "SO-50": passesBySat["SO-50"] }, favNext);
  assert.deepStrictEqual(h.calls, ["radio:on", "antenna:on"], "no off/on blip");
  assert.strictEqual(h.engine.status().engaged.sat, "SO-50");
  h.at(52.1).cycle({ ISS: [pass(130, 140)], "SO-50": [pass(150, 160)] }, favNext);
  assert.deepStrictEqual(h.calls.slice(2), ["radio:off", "antenna:off"], "off after SO-50 LOS");
});

test("chains with Auto Select: next favorite later -> off at LOS, on at its T-5", () => {
  const { h, favNext, passesBySat } = chain({ aos: T0 + 70 * MIN, los: T0 + 80 * MIN });
  for (const m of [25, 30, 39.9]) h.at(m).cycle(passesBySat, favNext);
  h.at(40.05).cycle({ ISS: [pass(130, 140)], "SO-50": passesBySat["SO-50"] }, favNext);
  assert.strictEqual(h.sat, "SO-50");
  h.at(40.1).cycle({ ISS: [pass(130, 140)], "SO-50": passesBySat["SO-50"] }, favNext);
  assert.deepStrictEqual(h.calls, ["radio:on", "antenna:on", "radio:off", "antenna:off"]);
  h.at(64.9).cycle({ "SO-50": passesBySat["SO-50"] }, favNext);
  assert.strictEqual(h.calls.length, 4);
  h.at(65).cycle({ "SO-50": passesBySat["SO-50"] }, favNext);
  assert.deepStrictEqual(h.calls.slice(4), ["radio:on", "antenna:on"], "engaged at SO-50 T-5");
});

/* ---------------- per-pass marks ---------------- */

const mark = (key, aosMin, losMin) => ({ key, aosMs: T0 + aosMin * MIN, losMs: T0 + losMin * MIN });

test("marks: toggle on/off, pass identity within the AOS tolerance, prune after LOS", () => {
  let m = C.toggleMark([], { key: "ISS", aosMs: T0 + 30 * MIN, losMs: T0 + 40 * MIN });
  assert.deepStrictEqual(m, [mark("ISS", 30, 40)]);
  assert.ok(C.isMarked(m, "ISS", T0 + 30 * MIN + 40000), "AOS jitter still matches");
  assert.ok(!C.isMarked(m, "ISS", T0 + 130 * MIN), "other pass");
  assert.ok(!C.isMarked(m, "SO-50", T0 + 30 * MIN), "other sat");
  m = C.toggleMark(m, { key: "ISS", aosMs: T0 + 30 * MIN + 20000 });
  assert.deepStrictEqual(m, [], "second click clears");
  const r = C.pruneMarks([mark("ISS", 30, 40), mark("AO-7", 100, 110)], T0 + 45 * MIN);
  assert.ok(r.changed);
  assert.deepStrictEqual(r.marks, [mark("AO-7", 100, 110)]);
});

test("marked pass fires with another sat selected: selects it at T-5, then engages; off after LOS", async () => {
  const h = rig({ sat: "AO-7" });
  const marks = [mark("ISS", 30, 40)];
  h.at(24.9).check({ marks, passes: [pass(200, 210)] });
  assert.deepStrictEqual(h.selects, []);
  h.at(25).check({ marks, passes: [pass(200, 210)] });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepStrictEqual(h.selects, ["ISS"], "marked sat selected at T-5");
  assert.deepStrictEqual(h.calls, [], "engages once the switch landed");
  assert.strictEqual(h.engine.status().selecting, "ISS");
  h.sat = "ISS";
  h.at(25.05).check({ marks, passes: [pass(30, 40)] });
  assert.deepStrictEqual(h.calls, ["radio:on", "antenna:on"]);
  assert.ok(h.logs.some((l) => /engage ISS pass AOS .*\(marked pass\)/.test(l)));
  h.at(40.1).check({ marks, passes: [pass(130, 140)] });
  assert.deepStrictEqual(h.calls.slice(2), ["radio:off", "antenna:off"]);
  // the next ISS pass is not marked: nothing at its T-5
  h.at(125).check({ marks, passes: [pass(130, 140)] });
  assert.strictEqual(h.calls.length, 4);
});

test("marked pass: a manual selection after engage is not fought", () => {
  const h = rig({ sat: "ISS" });
  const marks = [mark("ISS", 30, 40)];
  h.at(25).check({ marks, passes: [pass(30, 40)] });
  assert.deepStrictEqual(h.calls, ["radio:on", "antenna:on"]);
  h.sat = "AO-7"; // user picks another sat mid-pass
  for (const m of [31, 32, 35]) h.at(m).check({ marks, passes: [pass(200, 210)] });
  assert.deepStrictEqual(h.selects, [], "never re-selects ISS");
  assert.deepStrictEqual(h.calls, ["radio:on", "antenna:on", "radio:off", "antenna:off"]);
});

test("unmarked before T-5: nothing happens", () => {
  const h = rig({ sat: "AO-7" });
  h.at(20).check({ marks: [mark("ISS", 30, 40)], passes: [] });
  h.at(25).check({ marks: [], passes: [] });
  h.at(30).check({ marks: [], passes: [] });
  assert.deepStrictEqual(h.selects, []);
  assert.deepStrictEqual(h.calls, []);
});

test("two marked passes overlap: earlier AOS wins, the other is skipped (logged)", async () => {
  const h = rig({ sat: "AO-7" });
  const marks = [mark("SO-50", 33, 43), mark("ISS", 30, 40)];
  h.at(25).check({ marks, passes: [] });
  await Promise.resolve();
  assert.deepStrictEqual(h.selects, ["ISS"]);
  h.sat = "ISS";
  h.at(26).check({ marks, passes: [pass(30, 40)] });
  h.at(28).check({ marks, passes: [pass(30, 40)] }); // SO-50 enters its T-5 window
  assert.ok(h.logs.some((l) => /skipped marked SO-50 pass AOS .* overlaps ISS pass/.test(l)));
  assert.strictEqual(h.logs.filter((l) => /skipped marked SO-50/.test(l)).length, 1, "logged once");
  h.at(35).check({ marks, passes: [pass(30, 40)] });
  h.at(40.1).check({ marks, passes: [pass(130, 140)] });
  await Promise.resolve();
  assert.deepStrictEqual(h.selects, ["ISS"], "SO-50 never selected");
  assert.deepStrictEqual(h.calls, ["radio:on", "antenna:on", "radio:off", "antenna:off"]);
});

test("button + mark on the same pass: engages once", () => {
  const h = rig();
  const marks = [mark("ISS", 30, 40)];
  for (const m of [25, 25.1, 30, 35]) h.at(m).check({ toggle: true, marks, passes: [pass(30, 40)] });
  assert.deepStrictEqual(h.calls, ["radio:on", "antenna:on"]);
  assert.strictEqual(h.logs.filter((l) => /Auto Engage: engage/.test(l)).length, 1);
  assert.ok(h.logs.some((l) => /button \+ marked pass/.test(l)));
  // unmark mid-pass with the button still on: still managed, off after LOS
  h.at(36).check({ toggle: true, marks: [], passes: [pass(30, 40)] });
  h.at(40.1).check({ toggle: true, marks: [], passes: [pass(130, 140)] });
  assert.deepStrictEqual(h.calls.slice(2), ["radio:off", "antenna:off"]);
});

test("marks are independent of the pass alert bells (separate data)", () => {
  const A = require("../js/pass-alerts-core");
  let alerts = A.togglePass(A.emptyAlerts(), [], { key: "ISS", aosMs: T0 + 30 * MIN });
  const marks = C.toggleMark([], { key: "ISS", aosMs: T0 + 130 * MIN });
  assert.ok(A.isPassArmed(alerts, [], "ISS", T0 + 30 * MIN));
  assert.ok(!C.isMarked(marks, "ISS", T0 + 30 * MIN), "bell does not mark");
  assert.ok(!A.isPassArmed(alerts, [], "ISS", T0 + 130 * MIN), "mark does not ring");
  // a belled pass is not engaged unless marked
  const h = rig();
  h.at(25).check({ toggle: false, marks: [], passes: [pass(30, 40)] });
  assert.deepStrictEqual(h.calls, []);
});

/* ---------------- v2: skips under the button ---------------- */

test("skipped pass: the button does not engage it; the next pass engages; a mark still would", () => {
  const h = rig();
  const skips = [mark("ISS", 30, 40)];
  for (const m of [25, 30, 35]) h.at(m).check({ toggle: true, skips, passes: [pass(30, 40)] });
  assert.deepStrictEqual(h.calls, [], "skipped");
  h.at(125).check({ toggle: true, skips, passes: [pass(130, 140)] });
  assert.deepStrictEqual(h.calls, ["radio:on", "antenna:on"], "next pass engages");
  const g = rig();
  g.at(25).check({ toggle: true, skips, marks: [mark("ISS", 30, 40)], passes: [pass(30, 40)] });
  assert.deepStrictEqual(g.calls, ["radio:on", "antenna:on"], "explicit mark wins");
});

test("skipped mid-pass: stops managing, leaves Radio / Antenna on", () => {
  const h = rig();
  h.at(25).check({ toggle: true, passes: [pass(30, 40)] });
  h.at(32).check({ toggle: true, skips: [mark("ISS", 30, 40)], passes: [pass(30, 40)] });
  h.at(41).check({ toggle: true, skips: [mark("ISS", 30, 40)], passes: [pass(130, 140)] });
  assert.deepStrictEqual(h.calls, ["radio:on", "antenna:on"]);
  assert.ok(h.logs.some((l) => /stopped managing ISS pass .*skipped/.test(l)));
  // un-skip mid-pass would engage again (only what is off)
  const g = rig();
  g.at(30).check({ toggle: true, skips: [mark("ISS", 30, 40)], passes: [pass(30, 40)] });
  g.at(31).check({ toggle: true, skips: [], passes: [pass(30, 40)] });
  assert.deepStrictEqual(g.calls, ["radio:on", "antenna:on"]);
});

test("icon state + click logic (core): off -> marked -> off; covered -> skipped -> covered; marked+covered -> skipped", () => {
  const base = { marks: [], skips: [], toggleOn: false, selectedKey: "ISS", engaged: null };
  const P = { key: "ISS", aosMs: T0 + 30 * MIN, losMs: T0 + 40 * MIN };
  const st = (o) => C.passEngageState(Object.assign({}, o, { key: P.key, aosMs: P.aosMs })).look;
  assert.strictEqual(st(base), "off");
  let r = C.clickPass(base, P);
  assert.deepStrictEqual(r, { marks: [P], skips: [] });
  assert.strictEqual(st(Object.assign({}, base, r)), "on");
  r = C.clickPass(Object.assign({}, base, r), P);
  assert.deepStrictEqual(r, { marks: [], skips: [] });
  const on = Object.assign({}, base, { toggleOn: true });
  assert.strictEqual(st(on), "inherited");
  assert.strictEqual(C.passEngageState(Object.assign({}, on, { key: "SO-50", aosMs: P.aosMs })).look, "off", "button covers the selected sat only");
  r = C.clickPass(on, P);
  assert.deepStrictEqual(r, { marks: [], skips: [P] });
  assert.strictEqual(st(Object.assign({}, on, r)), "skipped");
  r = C.clickPass(Object.assign({}, on, r), P);
  assert.deepStrictEqual(r, { marks: [], skips: [] });
  const both = Object.assign({}, on, { marks: [P] });
  assert.strictEqual(st(both), "on", "marked shows bright over covered");
  assert.deepStrictEqual(C.clickPass(both, P), { marks: [], skips: [P] });
  assert.strictEqual(st(Object.assign({}, on, { engaged: { sat: "ISS", aosMs: P.aosMs + 30000 } })), "active");
  assert.strictEqual(st(Object.assign({}, base, { key: "MOON" })), "off");
  assert.strictEqual(C.passEngageState({ toggleOn: true, selectedKey: "MOON", key: "MOON", aosMs: T0 }).look, "off", "Moon never");
});
