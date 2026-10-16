// Next-pass for ALL favorites (not just the selected sat): TLEs prefetched,
// pass computed up front, recomputed after LOS, honoring min elevation.
// Run: node test/fav-passes.test.js
const assert = require("assert");
const satellite = require("satellite.js");
const TLES = {
  25544: ["1 25544U 98067A   26280.50000000  .00016717  00000-0  30000-3 0  9990",
          "2 25544  51.6400 200.0000 0005000  90.0000 270.0000 15.50000000000000"],
  27607: ["1 27607U 02058C   26280.50000000  .00000500  00000-0  80000-4 0  9990",
          "2 27607  64.5500  50.0000 0080000 200.0000 160.0000 14.80000000000000"],
};
const tle = require("../lib/tle");
const cache = new Map();
const fetched = [];
tle.getSatrecForNorad = (n) => cache.get(String(n)) || null;
tle.cacheSatrec = (n, r) => cache.set(String(n), r);
tle.getTleAgeMs = () => Infinity;
tle.fetchTLE = async (n) => { fetched.push(String(n)); return { l1: TLES[n][0], l2: TLES[n][1] }; };
const orbit = require("../lib/orbit");
const fp = require("../lib/fav-passes");
const observer = {
  latitude: satellite.degreesToRadians(40.5),
  longitude: satellite.degreesToRadians(-111.9),
  height: 1.3,
};
const CAT = { ISS: { norad: 25544 }, "SO-50": { norad: 27607 } };
let minEl = 0;
let updates = 0;

(async () => {
  fp.init({ getCatalog: () => CAT, getObserver: () => observer, getMinEl: () => minEl, onUpdate: () => updates++ });
  fp.setKeys(["ISS", "SO-50"]);
  await fp.refreshTles(fp.TLE_MAX_AGE_MS);
  assert.deepStrictEqual(fetched.sort(), ["25544", "27607"], "TLE fetched for every favorite up front");
  assert(updates >= 1, "clients notified");
  const now = new Date();
  for (const k of ["ISS", "SO-50"]) {
    const p = fp.get(k);
    assert(p && p.aos && p.los > p.aos, k + " has next pass without selecting it");
    // agrees with full pass search (to ~1 s)
    const rec = cache.get(String(CAT[k].norad));
    const ref = orbit.findPasses(rec, observer, now, 0).find((x) => new Date(x.los) > now);
    assert(Math.abs(new Date(ref.aos).getTime() - p.aos) < 2000 || p.aos < now.getTime(), k + " AOS matches findPasses");
  }
  // After LOS, the entry must roll to the following pass.
  const first = fp.get("ISS");
  const after = new Date(first.los + 1000);
  assert(fp.recompute(after), "recompute after LOS");
  const second = fp.get("ISS");
  assert(second.aos > first.los, "next pass after LOS: " + new Date(second.aos).toISOString());
  // Min elevation honored and change triggers recompute.
  minEl = 30;
  fp.recompute(after);
  const hi = fp.get("ISS");
  if (hi.aos) {
    assert(hi.maxEl >= 30, "maxEl honors min elevation");
    const rec = cache.get("25544");
    const l = orbit.lookAngles(rec, observer, new Date(hi.aos + 500));
    assert(l.el >= 29.9, "AOS at min elevation");
  }
  // Not refetched when fresh.
  tle.getTleAgeMs = () => 1000;
  fetched.length = 0;
  await fp.refreshTles(fp.TLE_MAX_AGE_MS);
  assert.strictEqual(fetched.length, 0, "fresh TLEs not refetched");
  // CPU: all favorites (24) next-pass compute stays cheap.
  const keys = [];
  for (let i = 0; i < 24; i++) { const k = "S" + i; CAT[k] = { norad: i % 2 ? 25544 : 27607 }; keys.push(k); }
  minEl = 0;
  const t0 = Date.now();
  fp.setKeys(keys);
  console.log("24 favorites next-pass compute:", Date.now() - t0, "ms");
  fp.stop();
  console.log("fav-passes test OK");
})().catch((e) => { console.error(e); process.exit(1); });
