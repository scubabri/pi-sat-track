// Per-sat Data flag persists alongside offsets and survives offset/mode saves.
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "satdata-"));
const so = require("../lib/sat-offsets");

test("dataMode persists with offsets", () => {
  so.load();
  so.setDataMode("JO-97", true);
  so.set("JO-97", { ulFineOffset: 0, dlFineOffset: 100, manualDlOffset: 0 });
  so.setModeIndex("JO-97", 1);
  assert.strictEqual(so.getDataMode("JO-97"), true);
  so.flush();
  so.load();
  assert.strictEqual(so.getDataMode("JO-97"), true);
  assert.strictEqual(so.find("JO97").dataMode, true);
  so.setDataMode("JO-97", false);
  assert.strictEqual(so.getDataMode("JO-97"), false);
  assert.strictEqual(so.getModeIndex("JO-97"), 1);
});

test("cwMode persists independently of dataMode", () => {
  so.load();
  so.setCwMode("RS-44", true);
  so.set("RS-44", { ulFineOffset: 0, dlFineOffset: 50, manualDlOffset: 0 });
  so.flush(); so.load();
  assert.strictEqual(so.getCwMode("RS-44"), true);
  assert.strictEqual(so.getDataMode("RS-44"), false);
  so.setCwMode("RS-44", false);
  assert.strictEqual(so.getCwMode("RS-44"), false);
});
