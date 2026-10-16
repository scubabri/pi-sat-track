// Sked Finder: Start/End/Duration must be mutual intersection (both >= minEl),
// not a single-station pass. Distant grids with partial overlap → mutual << home.
// Run: node test/schedule-mutual.test.js
const assert = require("assert");
const satellite = require("satellite.js");
const sch = require("../lib/schedule");
const { findPasses } = require("../lib/orbit");

// Fresh AO-91 (LEO) TLE — epoch near 2026-10-14
const L1 = "1 43017U 17073E   26287.14751206  .00007698  00000+0  32683-3 0  9998";
const L2 = "2 43017  97.4491 151.9314 0144343 277.4133  81.0717 15.14318225483383";
// RS-44 (HEO) for the screenshot-style case
const R1 = "1 44909U 19096E   26288.16715383  .00000013  00000+0  10746-4 0  9996";
const R2 = "2 44909  82.5178 259.9672 0216595 223.6407 134.7390 12.79749697317695";

function obs(grid, heightKm) {
  const ll = sch.gridToLatLon(grid);
  assert(ll, "grid " + grid);
  return sch.observerFromLatLon(ll.lat, ll.lon, heightKm || 0);
}

function passDurSec(pass) {
  return Math.round((Date.parse(pass.los) - Date.parse(pass.aos)) / 1000);
}

function overlappingHome(rec, homeObs, w, minEl) {
  const passes = findPasses(rec, homeObs, new Date(w.startMs - 3600e3), minEl, 6, 15);
  return passes.find((p) => Date.parse(p.aos) <= w.endMs && Date.parse(p.los) >= w.startMs) || null;
}

console.log("resolveScheduleMinEl");
assert.strictEqual(sch.resolveScheduleMinEl(undefined, 0), 10);
assert.strictEqual(sch.resolveScheduleMinEl(undefined, undefined), 10);
assert.strictEqual(sch.resolveScheduleMinEl(undefined, 5), 5);
assert.strictEqual(sch.resolveScheduleMinEl(0, 15), 0); // explicit 0 wins
assert.strictEqual(sch.resolveScheduleMinEl(12, 0), 12);

console.log("LEO partial overlap: DN40 vs FN31 (AO-91) mutual << home");
{
  const rec = satellite.twoline2satrec(L1, L2);
  const home = obs("DN40AA", 1.3);
  const remote = obs("FN31");
  const minEl = 5;
  const t0 = Date.parse("2026-10-15T12:00:00Z");
  const t1 = t0 + 24 * 3600e3;
  const wins = sch.mutualWindows(rec, home, remote, t0, t1, minEl, 15);
  assert(wins.length >= 1, "expected at least one mutual window");
  let foundPartial = false;
  for (const w of wins) {
    const mut = Math.round((w.endMs - w.startMs) / 1000);
    const hp = overlappingHome(rec, home, w, minEl);
    assert(hp, "home pass should overlap mutual window");
    const homeDur = passDurSec(hp);
    // Mutual must not exceed either single-station span
    assert(mut <= homeDur + 2, "mutual " + mut + "s must be <= home " + homeDur + "s");
    // Sample that both ends are up inside, and at least one is down just outside
    const mid = (w.startMs + w.endMs) / 2;
    const { lookAngles } = require("../lib/orbit");
    const la = lookAngles(rec, home, new Date(mid));
    const lb = lookAngles(rec, remote, new Date(mid));
    assert(la && la.el >= minEl, "home up at mutual mid");
    assert(lb && lb.el >= minEl, "remote up at mutual mid");
    // Distant FN31 with partial geometry: mutual clearly shorter than home
    if (w.maxElB < w.maxElA - 5 && homeDur > 400) {
      assert(
        mut < homeDur * 0.85,
        "partial overlap: mutual " + mut + "s should be << home " + homeDur + "s (ratio " + (mut / homeDur).toFixed(2) + ")",
      );
      foundPartial = true;
      console.log(
        "  OK mutual=" + mut + "s home=" + homeDur + "s maxEl=" +
          Math.round(w.maxElA) + "/" + Math.round(w.maxElB) +
          " ratio=" + (mut / homeDur).toFixed(2),
      );
    }
  }
  assert(foundPartial, "expected a partial-overlap window (them maxEl << me)");
}

console.log("HEO RS-44 DN40 vs FN31: start is mutual not home AOS; durationSec = end-start");
{
  const rec = satellite.twoline2satrec(R1, R2);
  const home = obs("DN40AA", 1.3);
  const remote = obs("FN31");
  const minEl = 0; // geometric (screenshot used rotor min 0)
  const t0 = Date.parse("2026-10-15T22:00:00Z");
  const t1 = Date.parse("2026-10-16T00:00:00Z");
  const wins = sch.mutualWindows(rec, home, remote, t0, t1, minEl, 15);
  assert(wins.length >= 1);
  const w = wins[0];
  const hp = overlappingHome(rec, home, w, minEl);
  assert(hp);
  const homeAos = Date.parse(hp.aos);
  const mutDur = Math.round((w.endMs - w.startMs) / 1000);
  // Mutual start is when the *second* station comes up — later than home AOS for FN31
  assert(
    w.startMs > homeAos + 60e3,
    "mutual start " + new Date(w.startMs).toISOString() + " should be after home AOS " + hp.aos,
  );
  assert(mutDur < passDurSec(hp), "mutual duration shorter than home-only pass");
  // Screenshot-ish: ~58/18 max el
  assert(w.maxElA > 50 && w.maxElB > 10 && w.maxElB < 30, "expected ~high/low max el pair");
  console.log(
    "  OK mutual " + new Date(w.startMs).toISOString().slice(11, 19) + "–" +
      new Date(w.endMs).toISOString().slice(11, 19) + " (" + mutDur + "s) vs home AOS " +
      hp.aos.slice(11, 19) + " (" + passDurSec(hp) + "s) maxEl " +
      Math.round(w.maxElA) + "/" + Math.round(w.maxElB),
  );
}

console.log("HEO at sked default minEl=10: mutual clearly below home-only");
{
  const rec = satellite.twoline2satrec(R1, R2);
  const home = obs("DN40AA", 1.3);
  const remote = obs("FN31");
  const minEl = sch.SCHEDULE_MIN_EL_DEFAULT;
  const t0 = Date.parse("2026-10-15T22:00:00Z");
  const t1 = Date.parse("2026-10-16T00:00:00Z");
  const wins = sch.mutualWindows(rec, home, remote, t0, t1, minEl, 15);
  assert(wins.length >= 1);
  const w = wins[0];
  const hp = overlappingHome(rec, home, w, minEl);
  const mut = Math.round((w.endMs - w.startMs) / 1000);
  const homeDur = passDurSec(hp);
  assert(mut < homeDur * 0.75, "at 10° mutual " + mut + "s << home " + homeDur + "s");
  console.log("  OK minEl=10 mutual=" + mut + "s home=" + homeDur + "s");
}

console.log("All schedule-mutual tests passed.");
