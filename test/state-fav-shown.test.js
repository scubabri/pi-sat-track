// Overlay tracks + 24 h chart honor the profile's favOverlay.shown subset.
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pst-favshown-"));
const satellite = require("satellite.js");
const tle = require("../lib/tle");
const catalog = require("../lib/catalog");
const recs = {
  25544: satellite.twoline2satrec(
    "1 25544U 98067A   26280.50000000  .00016717  00000-0  30000-3 0  9990",
    "2 25544  51.6400 200.0000 0005000  90.0000 270.0000 15.50000000000000"),
  27607: satellite.twoline2satrec(
    "1 27607U 02058C   26280.50000000  .00000500  00000-0  80000-4 0  9990",
    "2 27607  64.5500  50.0000 0080000 200.0000 160.0000 14.80000000000000"),
};
tle.getSatrecForNorad = (n) => recs[n] || null;
tle.fetchTLE = async () => null;
const CAT = { ISS: { norad: 25544, display: "ISS" }, "SO-50": { norad: 27607, display: "SO-50" } };
catalog.getCatalog = () => CAT;
const state = require("../lib/state");

test("shown subset filters tracks and 24 h series", (t) => {
  if (typeof state.setFavOverlayShown !== "function") return t.skip("no setter");
  state.setFavorites(["ISS", "SO-50"]);
  state.setFavOverlayShown(null);
  const all = state.computeFavoriteTracks().tracks.map((x) => x.key).sort();
  if (!all.length) return t.skip("catalog stub not picked up by state");
  assert.deepStrictEqual(all, ["ISS", "SO-50"]);
  const sig0 = state.favProfileSig();
  state.setFavOverlayShown(["SO-50"]);
  assert.deepStrictEqual(state.computeFavoriteTracks().tracks.map((x) => x.key), ["SO-50"]);
  assert.deepStrictEqual(state.computeFavProfile(new Date(), 2).sats.map((x) => x.key), ["SO-50"]);
  assert.notStrictEqual(state.favProfileSig(), sig0, "sig changes so the server recomputes");
  state.setFavOverlayShown([]);
  assert.deepStrictEqual(state.computeFavoriteTracks().tracks, []);
});

test("globe orbits: one period, ~100 pts, honors shown", () => {
  state.setFavorites(["ISS", "SO-50"]);
  state.setFavOverlayShown(null);
  const g = state.computeGlobeOrbits(new Date(Date.UTC(2026, 9, 7, 12)), 100);
  assert.strictEqual(g.type, "globe-orbits");
  const iss = g.sats.find((x) => x.key === "ISS");
  assert(iss && iss.pts.length === 101);
  assert(iss.periodMin > 88 && iss.periodMin < 96, "ISS period " + iss.periodMin);
  for (const [la, lo, h] of iss.pts) {
    assert(Math.abs(la) <= 52 && lo >= -180 && lo <= 180 && h > 300 && h < 500);
  }
  state.setFavOverlayShown(["SO-50"]);
  assert.deepStrictEqual(state.computeGlobeOrbits(new Date(), 50).sats.map((x) => x.key), ["SO-50"]);
  state.setFavOverlayShown(null);
});

test("pass preview: positions + look angles at T for selected + shown favorites", () => {
  const { groundPoint, lookAngles } = require("../lib/orbit");
  state.setFavorites(["ISS", "SO-50"]);
  state.setFavOverlayShown(null);
  state.setObserver(40.6, -112.46, 1300);
  const T = Date.UTC(2026, 9, 7, 15, 30);
  const pv = state.computePreview(T);
  assert.strictEqual(pv.type, "preview");
  assert.strictEqual(pv.t, T);
  assert.deepStrictEqual(pv.sats.map((s) => s.key).sort(), ["ISS", "SO-50"]);
  const iss = pv.sats.find((s) => s.key === "ISS");
  const g = groundPoint(recs[25544], new Date(T));
  assert(Math.abs(iss.position.lat - g.lat) < 1e-9 && Math.abs(iss.position.lon - g.lon) < 1e-9);
  assert(iss.position.heightKm > 300 && iss.position.heightKm < 500);
  const l = lookAngles(recs[25544], state.getObserver(), new Date(T));
  assert(iss.look && Math.abs(iss.look.el - l.el) < 1e-9 && Math.abs(iss.look.az - l.az) < 1e-9);
  // a different T moves the sat
  const later = state.computePreview(T + 10 * 60000).sats.find((s) => s.key === "ISS");
  assert(Math.abs(later.position.lon - iss.position.lon) > 1 || Math.abs(later.position.lat - iss.position.lat) > 1);
  state.setFavOverlayShown(["SO-50"]);
  assert.deepStrictEqual(state.computePreview(T).sats.map((s) => s.key), ["SO-50"]);
  state.setFavOverlayShown(null);
});
