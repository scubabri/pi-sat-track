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

test("Center button is the only way to center (no double-click on the Step box)", () => {
  const src = fs.readFileSync(path.join(__dirname, "../js/fine-ctcss.js"), "utf8");
  assert.doesNotMatch(src, /dblclick/, "no double-click handler in fine-ctcss.js");
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  assert.doesNotMatch(html, /double-click(ing)? (Step|to center)/i, "no help text promising double-click center");
  assert.match(src, /getElementById\("btn-passband-center"\)[\s\S]{0,120}addEventListener\("click", sendCenter\)/);
  assert.match(src, /function sendCenter\(\)[\s\S]{0,300}type: "center"/);
});

test("no double-click on an editable input / textarea / select anywhere sends a center", () => {
  const dir = path.join(__dirname, "../js");
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    // any dblclick handler that centers tuning
    const re = /addEventListener\(\s*"dblclick"\s*,\s*([^)]*)\)/g;
    let m;
    while ((m = re.exec(src))) assert.doesNotMatch(m[1], /center/i, f + ": dblclick -> " + m[1]);
    assert.doesNotMatch(src, /ondblclick/i, f);
  }
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  assert.doesNotMatch(html, /ondblclick/i);
});
