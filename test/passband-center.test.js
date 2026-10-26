// Center button under the DL passband reuses the existing center action
// (fine-ctcss.js sendCenter: zero fine offsets + ws {type:"center"}).
// Run: node --test --test-force-exit test/passband-center.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

test("index.html has a Center button right after the DL passband row", () => {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const dl = html.indexOf('id="passband-dl"');
  const btn = html.indexOf('id="btn-passband-center"');
  assert.ok(dl > 0 && btn > dl, "button after DL passband");
  assert.ok(html.indexOf("</section>", dl) > btn, "same section");
});

test("Center button click is wired to the same sendCenter as Step double-click", () => {
  const src = fs.readFileSync(path.join(__dirname, "../js/fine-ctcss.js"), "utf8");
  assert.match(src, /stepEl\.addEventListener\("dblclick", sendCenter\)/);
  assert.match(src, /getElementById\("btn-passband-center"\)[\s\S]{0,120}addEventListener\("click", sendCenter\)/);
  assert.match(src, /function sendCenter\(\)[\s\S]{0,300}type: "center"/);
});
