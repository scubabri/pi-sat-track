// Pass alerts (js/pass-alerts-core.js): AOS−5 / AOS scheduling, dedupe,
// sat-level inheritance + per-pass exceptions, allFavorites, pruning.
const test = require("node:test");
const assert = require("assert");
const C = require("../js/pass-alerts-core");

const MIN = 60 * 1000;
const AOS = Date.UTC(2026, 9, 19, 23, 3, 0);
const LOS = AOS + 18 * MIN;
const pass = (key, aos, los, maxEl) => ({ key, display: key, aos, los: los != null ? los : aos + 15 * MIN, maxEl: maxEl != null ? maxEl : 40 });

test("normalize: garbage → empty shape; dedupes within tolerance", () => {
  assert.deepStrictEqual(C.normalizeAlerts(null), { sats: [], passes: [], passExceptions: [], allFavorites: false });
  const a = C.normalizeAlerts({
    sats: ["AO-7", "AO-7", 3, ""],
    passes: [{ key: "SO-50", aosMs: AOS }, { key: "SO-50", aosMs: AOS + 20000 }, { key: "x" }, { key: "RS-44", aosMs: "nope" }],
    passExceptions: "bad",
    allFavorites: "yes",
  });
  assert.deepStrictEqual(a.sats, ["AO-7"]);
  assert.deepStrictEqual(a.passes, [{ key: "SO-50", aosMs: AOS }]);
  assert.deepStrictEqual(a.passExceptions, []);
  assert.strictEqual(a.allFavorites, false);
});

test("single pass: AOS−5 and AOS fire once each; nothing outside the windows", () => {
  let al = C.togglePass(C.emptyAlerts(), [], { key: "AO-7", aosMs: AOS, losMs: LOS });
  assert.deepStrictEqual(al.passes, [{ key: "AO-7", aosMs: AOS, losMs: LOS }]);
  const cands = [pass("AO-7", AOS, LOS, 55)];
  const fired = [];
  const at = (t) => {
    const ev = C.dueAlerts(cands, al, [], t, fired);
    ev.forEach((e) => fired.push({ key: e.key, kind: e.kind, aosMs: e.aosMs }));
    return ev;
  };
  assert.deepStrictEqual(at(AOS - 6 * MIN), [], "too early");
  const e5 = at(AOS - 5 * MIN);
  assert.strictEqual(e5.length, 1);
  assert.strictEqual(e5[0].kind, "pre5");
  assert.strictEqual(e5[0].minutes, 5);
  assert.strictEqual(e5[0].maxEl, 55);
  assert.deepStrictEqual(at(AOS - 5 * MIN + 1000), [], "dedupe pre5");
  assert.deepStrictEqual(at(AOS - 2 * MIN), [], "still deduped");
  const e0 = at(AOS);
  assert.strictEqual(e0.length, 1);
  assert.strictEqual(e0[0].kind, "aos");
  assert.deepStrictEqual(at(AOS + 30000), [], "dedupe aos");
  // A different tab (empty fired list) alerts too — at least once per tab.
  assert.strictEqual(C.dueAlerts(cands, al, [], AOS + 1000, []).length, 1);
});

test("AOS jitter between server recomputes does not re-fire", () => {
  const al = C.togglePass(C.emptyAlerts(), [], { key: "AO-7", aosMs: AOS });
  const fired = [];
  let ev = C.dueAlerts([pass("AO-7", AOS)], al, [], AOS - 5 * MIN, fired);
  ev.forEach((e) => fired.push(e));
  ev = C.dueAlerts([pass("AO-7", AOS + 25000)], al, [], AOS - 4 * MIN, fired);
  assert.deepStrictEqual(ev, []);
  // the same pass listed twice (alertPasses + selected-sat passes) fires once
  ev = C.dueAlerts([pass("AO-7", AOS), pass("AO-7", AOS + 9000)], al, [], AOS, []);
  assert.strictEqual(ev.length, 1);
});

test("late tab: pre5 still fires inside the 5 min (with real minutes); AOS window is 2 min", () => {
  const al = { sats: ["AO-7"] };
  const ev = C.dueAlerts([pass("AO-7", AOS)], al, [], AOS - 2 * MIN - 10000, []);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].minutes, 2, "2m10s left → 2 min");
  assert.strictEqual(C.dueAlerts([pass("AO-7", AOS)], al, [], AOS + C.AOS_WINDOW_MS - 1, []).length, 1);
  assert.strictEqual(C.dueAlerts([pass("AO-7", AOS)], al, [], AOS + C.AOS_WINDOW_MS, []).length, 0);
});

test("unarmed passes never fire", () => {
  assert.deepStrictEqual(C.dueAlerts([pass("AO-7", AOS)], C.emptyAlerts(), ["AO-7"], AOS, []), []);
  const al = C.togglePass(C.emptyAlerts(), [], { key: "AO-7", aosMs: AOS });
  assert.deepStrictEqual(C.dueAlerts([pass("AO-7", AOS + 100 * MIN)], al, [], AOS + 100 * MIN, []), [], "other pass of same sat");
  assert.deepStrictEqual(C.dueAlerts([pass("RS-44", AOS)], al, [], AOS, []), [], "other sat");
});

test("sat bell: inherited pass bells; clicking one adds an exception, clicking again re-enables", () => {
  let al = C.toggleSat(C.emptyAlerts(), [], "AO-7");
  assert.deepStrictEqual(al.sats, ["AO-7"]);
  let st = C.passAlertState(al, [], "AO-7", AOS);
  assert.strictEqual(st.look, "inherited");
  assert.strictEqual(st.armed, true);
  al = C.togglePass(al, [], { key: "AO-7", aosMs: AOS, losMs: LOS });
  assert.deepStrictEqual(al.passExceptions, [{ key: "AO-7", aosMs: AOS, losMs: LOS }]);
  assert.deepStrictEqual(al.passes, [], "no explicit pass while sat-level");
  st = C.passAlertState(al, [], "AO-7", AOS + 10000);
  assert.strictEqual(st.look, "off");
  assert.strictEqual(st.armed, false);
  assert.strictEqual(C.passAlertState(al, [], "AO-7", AOS + 100 * MIN).look, "inherited", "other passes still on");
  assert.deepStrictEqual(C.dueAlerts([pass("AO-7", AOS)], al, [], AOS, []), [], "excepted pass silent");
  al = C.togglePass(al, [], { key: "AO-7", aosMs: AOS });
  assert.deepStrictEqual(al.passExceptions, []);
  assert.strictEqual(C.passAlertState(al, [], "AO-7", AOS).look, "inherited");
});

test("sat bell on clears that sat's single-pass flags; off clears exceptions", () => {
  let al = C.togglePass(C.emptyAlerts(), [], { key: "AO-7", aosMs: AOS });
  assert.strictEqual(C.passAlertState(al, [], "AO-7", AOS).look, "on");
  al = C.toggleSat(al, [], "AO-7");
  assert.deepStrictEqual(al.passes, []);
  al = C.togglePass(al, [], { key: "AO-7", aosMs: AOS });
  assert.strictEqual(al.passExceptions.length, 1);
  al = C.toggleSat(al, [], "AO-7");
  assert.deepStrictEqual(al, C.emptyAlerts());
});

test("all favorites: on / partial / off, inheritance, future favorites, turning one off", () => {
  const favs = ["AO-7", "SO-50", "RS-44"];
  let al = C.emptyAlerts();
  assert.strictEqual(C.allFavoritesState(al, favs), "off");
  al = C.toggleSat(al, favs, "SO-50");
  assert.strictEqual(C.allFavoritesState(al, favs), "partial");
  al = C.toggleAllFavorites(al, favs);
  assert.strictEqual(al.allFavorites, true);
  assert.strictEqual(C.allFavoritesState(al, favs), "on");
  assert.strictEqual(C.satAlertSource(al, favs, "RS-44"), "favorites");
  assert.strictEqual(C.passAlertState(al, favs, "RS-44", AOS).look, "inherited");
  assert.strictEqual(C.satAlertOn(al, favs.concat("ISS"), "ISS"), true, "new favorite inherits");
  assert.strictEqual(C.satAlertOn(al, favs, "ISS"), false, "non-favorite not covered");
  assert.strictEqual(C.dueAlerts([pass("AO-7", AOS)], al, favs, AOS, []).length, 1, "fires for favorites");
  // turn just RS-44 off: the others stay on, allFavorites drops
  al = C.toggleSat(al, favs, "RS-44");
  assert.strictEqual(al.allFavorites, false);
  assert.deepStrictEqual(al.sats.slice().sort(), ["AO-7", "SO-50"]);
  assert.strictEqual(C.allFavoritesState(al, favs), "partial");
  // header click while partial → all on; again → all off (non-favorite sats kept)
  al = C.toggleSat(al, favs, "ISS");
  al = C.toggleAllFavorites(al, favs);
  assert.strictEqual(C.allFavoritesState(al, favs), "on");
  al = C.toggleAllFavorites(al, favs);
  assert.strictEqual(C.allFavoritesState(al, favs), "off");
  assert.strictEqual(al.allFavorites, false);
  assert.deepStrictEqual(al.sats, ["ISS"]);
});

test("prune drops single passes / exceptions after LOS (+grace), keeps the rest", () => {
  const al = {
    sats: ["AO-7"],
    passes: [{ key: "SO-50", aosMs: AOS, losMs: LOS }, { key: "RS-44", aosMs: AOS + 300 * MIN }],
    passExceptions: [{ key: "AO-7", aosMs: AOS - 200 * MIN }],
    allFavorites: true,
  };
  let r = C.pruneAlerts(al, LOS);
  assert.strictEqual(r.changed, true, "old exception (no LOS → AOS+30 min) pruned");
  assert.strictEqual(r.alerts.passes.length, 2);
  assert.deepStrictEqual(r.alerts.passExceptions, []);
  r = C.pruneAlerts(r.alerts, LOS + C.PRUNE_GRACE_MS);
  assert.deepStrictEqual(r.alerts.passes.map((p) => p.key), ["RS-44"]);
  assert.deepStrictEqual(r.alerts.sats, ["AO-7"]);
  assert.strictEqual(r.alerts.allFavorites, true);
  assert.strictEqual(C.pruneAlerts(r.alerts, LOS + 2 * MIN).changed, false);
});

test("alertSatKeys: sats + favorites (when allFavorites) + single-pass sats", () => {
  const al = { sats: ["ISS"], passes: [{ key: "AO-7", aosMs: AOS }], allFavorites: true };
  assert.deepStrictEqual(C.alertSatKeys(al, ["SO-50", "ISS"]), ["ISS", "SO-50", "AO-7"]);
  assert.deepStrictEqual(C.alertSatKeys({ sats: [] }, ["SO-50"]), []);
});

test("alert text follows the supplied clock (UTC|local toggle)", () => {
  const ev = { key: "AO-7", display: "AO-7", kind: "pre5", minutes: 5, maxEl: 55.4, aosMs: AOS };
  assert.strictEqual(C.alertText(ev, () => "17:03 MT"), "AO-7 AOS in 5 min (max 55\u00B0, 17:03 MT)");
  assert.strictEqual(C.alertText(ev, (t) => new Date(t).toISOString().substr(11, 5) + " UTC"), "AO-7 AOS in 5 min (max 55\u00B0, 23:03 UTC)");
  assert.strictEqual(C.alertText(Object.assign({}, ev, { kind: "aos" }), () => "x"), "AO-7 AOS now (max 55\u00B0)");
});
