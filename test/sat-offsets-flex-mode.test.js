"use strict";
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "satdata-"));
const so = require("../lib/sat-offsets");

test("flex profile per sat+mode with legacy fallback", () => {
  so.setFlexProfile("SAT", "Legacy");
  assert.strictEqual(so.getFlexProfile("SAT", "FM|a|b"), "Legacy");
  so.setFlexProfile("SAT", "FMProf", "FM|a|b");
  so.setFlexProfile("SAT", "SSBProf", "USB|c|d");
  assert.strictEqual(so.getFlexProfile("SAT", "FM|a|b"), "FMProf");
  assert.strictEqual(so.getFlexProfile("SAT", "USB|c|d"), "SSBProf");
  assert.strictEqual(so.getFlexProfile("SAT", "X|y|z"), "Legacy");
  assert.strictEqual(so.getFlexProfile("SAT"), "Legacy");
  so.setModeIndex("SAT", 1);
  assert.strictEqual(so.getFlexProfile("SAT", "FM|a|b"), "FMProf");
  so.setFlexProfile("ONLY", "P", "FM|a|b");
  assert.strictEqual(so.getFlexProfile("ONLY", "FM|a|b"), "P");
  assert.strictEqual(so.getFlexProfile("ONLY", "USB|c|d"), "");
  so.setFlexProfile("ONLY", "", "FM|a|b");
  assert.strictEqual(so.getFlexProfile("ONLY", "FM|a|b"), "");
});
