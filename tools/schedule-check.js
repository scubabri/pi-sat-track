// Sanity check: remote == home must reproduce normal passes above minEl.
// Usage: node tools/schedule-check.js [norad] [grid] [minEl]
const satellite = require("satellite.js");
const tle = require("../lib/tle");
const { findPasses } = require("../lib/orbit");
const sch = require("../lib/schedule");
(async () => {
  const norad = process.argv[2] || "43017";
  const grid = process.argv[3] || "DN40";
  const minEl = parseFloat(process.argv[4] || "10");
  let rec = tle.getSatrecForNorad(norad);
  if (!rec) { const t = await tle.fetchTLE(norad); rec = satellite.twoline2satrec(t.l1, t.l2); }
  const ll = sch.gridToLatLon(grid);
  const obs = sch.observerFromLatLon(ll.lat, ll.lon, 0);
  const now = new Date();
  const passes = findPasses(rec, obs, now, minEl, 48).filter((p) => new Date(p.aos) >= now);
  const wins = sch.mutualWindows(rec, obs, obs, now.getTime(), now.getTime() + 48 * 3600e3, minEl, 15);
  let bad = 0;
  passes.forEach((p, i) => {
    const w = wins.find((x) => Math.abs(x.startMs - new Date(p.aos)) < 60e3);
    const dA = w ? (w.startMs - new Date(p.aos)) / 1000 : NaN;
    const dL = w ? (w.endMs - new Date(p.los)) / 1000 : NaN;
    const dE = w ? w.maxElA - p.maxEl : NaN;
    const ok = w && Math.abs(dA) < 1 && Math.abs(dL) < 1 && dE > -0.5;
    if (!ok) bad++;
    console.log((ok ? "OK  " : "BAD ") + p.aos + " dAOS=" + dA.toFixed(2) + "s dLOS=" + dL.toFixed(2) + "s maxEl pass=" + p.maxEl.toFixed(1) + " win=" + (w ? w.maxElA.toFixed(1) : "-") + " them=" + (w ? w.maxElB.toFixed(1) : "-"));
  });
  console.log(passes.length + " passes, " + wins.length + " windows, " + bad + " mismatches");
  process.exit(bad ? 1 : 0);
})();
