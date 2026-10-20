// APRS symbol names + sprite cells (js/aprs-symbols.js) and the vendored sprites.
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function load() {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/aprs-symbols.js"), "utf8"), ctx);
  return ctx.window.APRS_SYMBOLS;
}

test("names from the APRS symbol index; common list all named", () => {
  const S = load();
  assert.strictEqual(S.name("/>"), "Car");
  assert.strictEqual(S.name("/-"), "House");
  assert.strictEqual(S.name("/`"), "Satellite dish antenna");
  assert.strictEqual(S.name("/;"), "Campground, tent");
  assert.strictEqual(S.name("/_"), "Weather station");
  assert.strictEqual(S.name("\\S"), "Satellite");
  assert.match(S.name("S#"), /overlay S/);
  for (const c of S.COMMON) assert.ok(S.NAMES[c], "common symbol " + c + " has a name");
  assert.ok(S.list("/").length > 80);
  assert.ok(S.list("\\").length > 60);
});

test("parse: table / , \\ or overlay A-Z 0-9; invalid -> null", () => {
  const S = load();
  assert.strictEqual(S.parse("/`").table, 0);
  assert.strictEqual(S.parse("\\S").table, 1);
  const o = S.parse("S#");
  assert.strictEqual(o.table, 1);
  assert.strictEqual(o.overlay, "S");
  for (const bad of ["", "/", "x#", "/ ", "abc"]) assert.strictEqual(S.parse(bad), null, bad);
  assert.strictEqual(S.html("bad"), "");
});

test("sprite cell = char code - 33 on a 16-wide grid; overlay drawn from table 2", () => {
  const S = load();
  const car = S.html("/>", 24); // '>' = 62 -> index 29 -> col 13, row 1
  assert.match(car, /aprs-symbols-24-0\.png/);
  assert.match(car, /background-position:-312px -24px/);
  const big = S.html("/>", 48);
  assert.match(big, /background-size:768px 288px/);
  const ov = S.html("S#", 24); // '#' = 35 -> index 2 ; 'S' = 83 -> index 50 -> col 2 row 3
  assert.match(ov, /aprs-symbols-24-1\.png/);
  assert.match(ov, /aprs-symbols-24-2\.png[^"]*background-size:384px 144px;background-position:-48px -72px/);
});

test("vendored sprites present (offline) with attribution", () => {
  const dir = path.join(__dirname, "../images/aprs-symbols");
  for (const t of [0, 1, 2]) {
    for (const [suf, w, h] of [["", 384, 144], ["@2x", 768, 288]]) {
      const b = fs.readFileSync(path.join(dir, "aprs-symbols-24-" + t + suf + ".png"));
      assert.strictEqual(b.readUInt32BE(16), w);
      assert.strictEqual(b.readUInt32BE(20), h);
    }
  }
  assert.match(fs.readFileSync(path.join(dir, "ATTRIBUTION.md"), "utf8"), /CC BY-SA 2\.0/);
});
