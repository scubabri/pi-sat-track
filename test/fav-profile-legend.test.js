// Favorites pass-profile chart legend: colored swatch + sat name only (no
// pass count). Run: node --test --test-force-exit test/fav-profile-legend.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

test("legend draws only the sat name (no pass count), keeps its click hit boxes", () => {
  const src = fs.readFileSync(path.join(__dirname, "../js/profile.js"), "utf8");
  const start = src.indexOf("function drawFavProfile()");
  assert.ok(start >= 0);
  const body = src.slice(start, src.indexOf("\nfunction ", start + 10));
  assert.ok(/ctx\.fillText\(s\.display \|\| s\.key, lx \+ 16, y\)/.test(body), "name only");
  assert.ok(!/\+ "  " \+ n/.test(body) && !/"  99"/.test(body), "no pass count text / width reserve");
  assert.ok(/favProfileHits\.legend\.push\(/.test(body), "legend rows still clickable");
});
