// Moon (EME) as a favorite: stable key "MOON" (no NORAD / TLE), next rise
// honoring min EL through the favorites pass cache, pass alerts, favorites
// payload, map tracks; never fetches a TLE; not an after-LOS auto target.
// Run: node --test --test-force-exit test/moon-favorite.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pst-moonfav-"));
const satellite = require("satellite.js");
const tle = require("../lib/tle");
const catalog = require("../lib/catalog");
const moon = require("../lib/moon");

const recs = {
  25544: satellite.twoline2satrec(
    "1 25544U 98067A   26280.50000000  .00016717  00000-0  30000-3 0  9990",
    "2 25544  51.6400 200.0000 0005000  90.0000 270.0000 15.50000000000000"),
};
const fetched = [];
tle.getSatrecForNorad = (n) => recs[n] || null;
tle.fetchTLE = async (n) => (fetched.push(String(n)), null);
const CAT = { ISS: { key: "ISS", norad: 25544, display: "ISS" }, MOON: moon.catalogEntry() };
catalog.getCatalog = () => CAT;
const favPasses = require("../lib/fav-passes");
const state = require("../lib/state");
const afterLos = require("../lib/after-los");
const alertsCore = require("../js/pass-alerts-core");

let minEl = 0;
const OBS = { latitude: 40.6, longitude: -112.46, height: 1300 };
favPasses.init({ getCatalog: () => CAT, getObserver: () => state.getObserver() || OBS, getMinEl: () => minEl, onUpdate: () => {} });
state.setObserver(OBS.latitude, OBS.longitude, OBS.height);

test("setFavorites keeps the Moon (stable key MOON), deduplicated, case-normalised", () => {
  state.setFavorites(["ISS", "moon", "MOON"]);
  const keys = state.computeFavoritesLooks().map((f) => f.key);
  assert.ok(keys.includes("MOON"), keys.join());
  assert.strictEqual(keys.filter((k) => k === "MOON").length, 1);
  state.setFavorites(["ISS"]);
  assert.ok(!state.computeFavoritesLooks().some((f) => f.key === "MOON"), "unfavorite removes it");
});

test("fav-passes: Moon next rise from its own ephemeris, honors min EL, never fetches a TLE", () => {
  fetched.length = 0;
  minEl = 0;
  favPasses.setKeys(["MOON"]);
  const p0 = favPasses.get("MOON");
  assert.ok(p0 && p0.aos != null && p0.los != null, JSON.stringify(p0));
  const ref = moon.findNextPass(state.getObserver(), new Date(), 0);
  assert.ok(Math.abs(new Date(p0.aos) - new Date(ref.aos)) < 120000, "same as lib/moon findNextPass");
  minEl = 20;
  favPasses.recompute();
  const p20 = favPasses.get("MOON");
  if (p20 && p20.aos != null) {
    assert.ok(p20.maxEl >= 20, "maxEl " + p20.maxEl);
    assert.ok(new Date(p20.aos) >= new Date(p0.aos) || new Date(p0.aos) <= Date.now(), "a higher min EL cannot rise earlier");
  }
  minEl = 0;
  favPasses.recompute();
  assert.deepStrictEqual(fetched, [], "no TLE fetch for the Moon");
});

test("favorites payload: Moon row with look angles, sub-lunar position, isMoon, no NORAD, next pass", () => {
  state.setFavorites(["ISS", "MOON"]);
  const m = state.computeFavoritesLooks().find((f) => f.key === "MOON");
  assert.ok(m, "Moon in favorites payload");
  assert.strictEqual(m.isMoon, true);
  assert.strictEqual(m.norad, null);
  assert.ok(m.look && Number.isFinite(m.look.el) && Number.isFinite(m.look.az));
  assert.ok(m.position && m.position.heightKm > 300000, "Moon distance");
  assert.ok(m.nextPass && m.nextPass.aos != null, "AOS countdown data");
  // map overlay track (sub-lunar path), no crash without a TLE
  const tr = state.computeFavoriteTracks().tracks.find((t) => t.key === "MOON");
  assert.ok(tr && tr.forward.length > 10 && tr.trail.length > 1);
  // globe orbits skip it cleanly (no satellite period)
  assert.ok(!state.computeGlobeOrbits(new Date(), 20).sats.some((s) => s.key === "MOON"));
});

test("pass alerts: a bell on the Moon (or all favorites) yields Moon alert passes", () => {
  state.setFavorites(["ISS", "MOON"]);
  state.setPassAlerts({ sats: ["MOON"] });
  let a = state.computeAlertPasses();
  assert.ok(a.some((p) => p.key === "MOON" && p.aos != null), JSON.stringify(a));
  state.setPassAlerts({ allFavorites: true });
  a = state.computeAlertPasses();
  assert.ok(a.some((p) => p.key === "MOON"));
  // the browser-side due check treats it like any sat
  const p = a.find((x) => x.key === "MOON");
  const aos = new Date(p.aos).getTime();
  const due = alertsCore.dueAlerts([p], alertsCore.normalizeAlerts({ sats: ["MOON"] }), ["MOON"], aos - 4 * 60000, []);
  assert.ok(due.some((d) => d.key === "MOON"), JSON.stringify(due));
  state.setPassAlerts(alertsCore.emptyAlerts());
});

test("after-LOS auto select never picks a favorited Moon", () => {
  const now = Date.now();
  const favs = [
    { key: "MOON", isMoon: true, nextPass: { aos: new Date(now + 60000).toISOString(), los: new Date(now + 8 * 3600000).toISOString(), maxEl: 60 } },
    { key: "SO-50", nextPass: { aos: new Date(now + 20 * 60000).toISOString(), los: new Date(now + 30 * 60000).toISOString(), maxEl: 30 } },
  ];
  const t = afterLos.pickAutoTarget("ISS", ["MOON", "SO-50"], favs, now);
  assert.strictEqual(t && t.key, "SO-50");
  assert.strictEqual(afterLos.pickAutoTarget("ISS", ["MOON"], favs.slice(0, 1), now), null);
});

test("UI code: no Moon exclusions left for the star / bell", () => {
  const menu = fs.readFileSync(path.join(__dirname, "../js/sat-menu.js"), "utf8");
  assert.ok(!/if \(!s\.isMoon\) wrap\.appendChild\((star|bell)\)/.test(menu));
  const sats = fs.readFileSync(path.join(__dirname, "../sats.html"), "utf8");
  assert.ok(!/if \(!s\.isMoon\) favTd\.appendChild/.test(sats));
  const mp = fs.readFileSync(path.join(__dirname, "../js/moon-panel.js"), "utf8");
  assert.ok(!/sat-fav-top/.test(mp), "top-bar star is not hidden for the Moon");
});
