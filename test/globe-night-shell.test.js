// Globe night shell must draw before the footprint fill (it writes no depth);
// a later renderOrder made it depth-fight the fill as dark diamond patches.
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

test("night shell: transparent, no depth write, renderOrder below the footprint fill", () => {
  const src = fs.readFileSync(path.join(__dirname, "../js/globe-view.js"), "utf8");
  const m = src.match(/m\.renderOrder = (-?\d+);\s*m\.name = "night-shell"/);
  assert.ok(m, "night shell renderOrder set");
  assert.ok(Number(m[1]) < 0, "renderOrder " + m[1] + " must be < 0 (polygons default 0)");
  assert.match(src, /transparent: true, depthWrite: false/);
});
