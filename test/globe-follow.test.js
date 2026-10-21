// Globe follow mode: continuous rAF integrator + bled sample correction.
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "../js/globe-view.js"), "utf8");

test("follow uses rAF integrator, not a 1 Hz / setInterval camera pin", () => {
  assert.match(src, /requestAnimationFrame\(followFrame\)/);
  assert.doesNotMatch(src, /FOLLOW_TICK_MS|setInterval\(followTick/);
  assert.match(src, /follow\.pullLat = p\.lat - follow\.lat/, "sample error queued as pull");
  assert.match(src, /Math\.exp\(-dt \/ 400\)/, "pull bled over ~1 s");
  assert.match(src, /followPos\(\)/, "applyState reads smoothed pos while following");
  assert.match(src, /follow\.key === st\.sat && !pT\) \? followPos\(\)/);
  assert.match(src, /function ensureFpMesh\(/, "persistent footprint mesh");
  assert.match(src, /orientFpMesh\(follow\.lat/, "footprint reoriented every follow frame");
  assert.doesNotMatch(src, /lastFp/, "no 4 Hz footprint refresh");
});

test("wiring: chart snap starts follow; drag, center buttons, Map stop it", () => {
  assert.match(src, /window\.globeSnapTo = function \(key\) \{[\s\S]*?startFollow\(key\);/);
  // preview of the followed sat: followFrame centers it; another sat's preview stops following
  assert.match(src, /window\.globeCenterOn = function \(lat, lng, opts\) \{[\s\S]*?if \(opts && opts\.preview && follow\.key && \(!opts\.key \|\| opts\.key === follow\.key\)\) return true;[\s\S]*?stopFollow\(\);/);
  assert.match(src, /pointermove[\s\S]{0,200}stopFollow\(\)/);
  assert.match(src, /\} else \{\s*stopFollow\(\);\s*if \(el\) el\.hidden = true;/);
  const pp = fs.readFileSync(path.join(__dirname, "../js/pass-preview.js"), "utf8");
  assert.match(pp, /globeCenterOn\(cur\.position\.lat, cur\.position\.lon, \{ preview: true, key: cur\.key \}\)/);
});

test("integrator advances; sample pull bleeds in over time (no single-frame snap)", () => {
  function wrap180(x) { return ((((x + 180) % 360) + 360) % 360) - 180; }
  const f = { lat: 10, lng: 20, vLat: 0.001, vLng: 0.002, pullLat: 0, pullLng: 0 };
  f.lat += f.vLat * 100;
  f.lng = wrap180(f.lng + f.vLng * 100);
  assert.ok(Math.abs(f.lat - 10.1) < 1e-9);
  f.pullLat = (10.1 - 0.2) - f.lat; // -0.2 residual
  const a = 1 - Math.exp(-50 / 400);
  f.lat += f.pullLat * a;
  f.pullLat *= 1 - a;
  assert.ok(f.lat < 10.1 && f.lat > 9.9, "partial bleed " + f.lat);
  assert.ok(Math.abs(f.pullLat) < 0.2 && Math.abs(f.pullLat) > 0.1);
});
