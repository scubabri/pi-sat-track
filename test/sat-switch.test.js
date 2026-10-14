// Headless repro: rapid sat switches with slow TLE fetches must never yield
// state whose position belongs to a different sat than state.sat.
// Run: node test/sat-switch.test.js
const assert = require("assert");
const satellite = require("satellite.js");
const TLES = {
  7530: ["1 07530U 74089B   26280.50000000 -.00000030  00000-0  10000-3 0  9990",
         "2 07530 101.9900 300.0000 0012000 100.0000 260.0000 12.53650000000000"],
  27607: ["1 27607U 02058C   26280.50000000  .00000500  00000-0  80000-4 0  9990",
          "2 27607  64.5500  50.0000 0080000 200.0000 160.0000 14.80000000000000"],
  43017: ["1 43017U 17073E   26280.50000000  .00000300  00000-0  30000-4 0  9990",
          "2 43017  97.6000 150.0000 0010000  50.0000 310.0000 14.90000000000000"],
};
const catalog = require("../lib/catalog");
const CAT = {
  "AO-7": { norad: 7530, display: "AO-7", modes: [] },
  "SO-50": { norad: 27607, display: "SO-50", modes: [] },
  "AO-91": { norad: 43017, display: "AO-91", modes: [] },
};
catalog.getCatalog = () => CAT;
const tle = require("../lib/tle");
const cache = new Map();
const delays = {};
let failNext = new Set();
tle.getSatrecForNorad = (n) => cache.get(String(n)) || null;
tle.cacheSatrec = (n, r) => cache.set(String(n), r);
tle.getOrbitForNorad = () => null;
tle.fetchTLE = (n) => new Promise((res, rej) => setTimeout(() => {
  if (failNext.has(String(n))) { failNext.delete(String(n)); return rej(new Error("fetch fail")); }
  res({ l1: TLES[n][0], l2: TLES[n][1], note: "test", orbit: null });
}, delays[n] || 0));
const state = require("../lib/state");
const orbit = require("../lib/orbit");
const recOf = (n) => satellite.twoline2satrec(TLES[n][0], TLES[n][1]);

function check(label) {
  const s = state.computeState();
  if (!s) return;
  const p = orbit.groundPoint(recOf(CAT[s.sat].norad), new Date());
  const d = Math.hypot(s.position.lat - p.lat, s.position.lon - p.lon);
  assert(d < 0.5, label + ": state.sat=" + s.sat + " but position is another sat's (Δ" + d.toFixed(1) + "°)");
}

(async () => {
  await state.loadSatellite("AO-7");
  check("AO-7 loaded");
  // 1. slow fetch for new sat: states during the gap must not show AO-7 as SO-50
  delays[27607] = 200;
  const p = state.loadSatellite("SO-50");
  for (let i = 0; i < 10; i++) { check("during SO-50 load"); await new Promise((r) => setTimeout(r, 25)); }
  await p; check("SO-50 loaded");
  // 2. rapid switches, older fetch finishes last
  cache.clear();
  delays[7530] = 150; delays[43017] = 10; delays[27607] = 300;
  const a = state.loadSatellite("SO-50");
  const b = state.loadSatellite("AO-7");
  const c = state.loadSatellite("AO-91");
  await Promise.allSettled([a, b, c]);
  check("after rapid switch");
  assert.strictEqual(state.computeState().sat, "AO-91");
  // 3. failed fetch for new sat: never show old position under new name
  cache.delete("7530"); failNext.add("7530"); delays[7530] = 20;
  await state.loadSatellite("AO-7").catch(() => {});
  check("after failed fetch");
  console.log("sat-switch test: PASS");
  process.exit(0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
