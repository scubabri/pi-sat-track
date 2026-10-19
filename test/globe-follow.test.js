// Globe follow mode (js/globe-view.js): extrapolated sub-point target and the
// triggers / cancels wired in the source.
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "../js/globe-view.js"), "utf8");
function loadTarget() {
  const i = src.indexOf("  const follow = {");
  const j = src.indexOf("  function followTick()");
  assert.ok(i > 0 && j > i, "follow helpers present");
  const body = src.slice(i, j).replace(/function startFollow[\s\S]*?function followSample/, "function followSample");
  return new Function("lastState", "G", body + "; return { follow, followSample, followTarget, wrap180 };")(null, null);
}

test("target extrapolates from the last two live samples (capped at 3 s)", () => {
  const f = loadTarget();
  const now = Date.now;
  try {
    let t = 1000000;
    Date.now = () => t;
    f.followSample({ position: { lat: 10, lon: 20 } });
    assert.deepStrictEqual(f.followTarget(t), { lat: 10, lng: 20 }, "one sample: hold");
    t += 1000;
    f.followSample({ position: { lat: 10.1, lon: 20.2 } });
    const a = f.followTarget(t + 500);
    assert.ok(Math.abs(a.lat - 10.15) < 1e-9 && Math.abs(a.lng - 20.3) < 1e-9, JSON.stringify(a));
    const capped = f.followTarget(t + 60000);
    assert.ok(Math.abs(capped.lat - 10.4) < 1e-9, "capped at 3 s: " + capped.lat);
    f.followSample({ position: null }); // no position: ignored
    assert.strictEqual(f.follow.samples.length, 2);
  } finally { Date.now = now; }
});

test("antimeridian: longitude wraps instead of spinning the globe", () => {
  const f = loadTarget();
  const now = Date.now;
  try {
    let t = 5000;
    Date.now = () => t;
    f.followSample({ position: { lat: 0, lon: 179.9 } });
    t += 1000;
    f.followSample({ position: { lat: 0, lon: -179.9 } });
    const g = f.followTarget(t + 1000);
    assert.ok(Math.abs(g.lng - -179.7) < 1e-9, "lng " + g.lng);
    assert.strictEqual(f.wrap180(190), -170);
  } finally { Date.now = now; }
});

test("wiring: chart snap starts follow; drag, center buttons, Map stop it; preview doesn't move it", () => {
  assert.match(src, /window\.globeSnapTo = function \(key\) \{[\s\S]*?startFollow\(key\);/);
  assert.match(src, /window\.globeCenterOn = function \(lat, lng, opts\) \{[\s\S]*?if \(opts && opts\.preview && follow\.key\) return true;[\s\S]*?stopFollow\(\);/);
  assert.match(src, /pointermove[\s\S]{0,200}stopFollow\(\)/);
  assert.match(src, /\} else \{\s*stopFollow\(\);\s*if \(el\) el\.hidden = true;/);
  assert.match(src, /const follow = \{ key: null,/, "off by default");
  const pp = fs.readFileSync(path.join(__dirname, "../js/pass-preview.js"), "utf8");
  assert.match(pp, /globeCenterOn\(cur\.position\.lat, cur\.position\.lon, \{ preview: true \}\)/);
});
