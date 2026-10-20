// UISS-style transmit builders (lib/aprs/build.js).
const test = require("node:test");
const assert = require("node:assert");
const b = require("../lib/aprs/build");

test("normDest: To is an AX.25 destination callsign (1-6 alnum, -SSID 0-15)", () => {
  assert.strictEqual(b.normDest("cq"), "CQ");
  assert.strictEqual(b.normDest(" APRS "), "APRS");
  assert.strictEqual(b.normDest("BEACON-0"), "BEACON");
  assert.strictEqual(b.normDest("N0CALL-15"), "N0CALL-15");
  for (const bad of ["", "CQ-16", "TOOLONG", "CQ*", "C Q"]) assert.strictEqual(b.normDest(bad), null, bad);
  assert.deepStrictEqual(b.DEST_PRESETS.slice(0, 2), ["CQ", "APRS"]);
});

test("maxUiText follows UISS: 255 direct, 80 with one digi, -10 per extra digi", () => {
  assert.strictEqual(b.maxUiText(0), 255);
  assert.strictEqual(b.maxUiText(1), 80);
  assert.strictEqual(b.maxUiText(2), 70);
  assert.strictEqual(b.maxUiText(8), 10);
});

test("uiTextInfo sends text as typed (one line, printable ASCII), enforces the length", () => {
  assert.strictEqual(b.uiTextInfo(">JO20AW Hello all", 1), ">JO20AW Hello all");
  assert.strictEqual(b.uiTextInfo("CQ de K0TEST {x} | ~  \r\n", 1), "CQ de K0TEST {x} | ~");
  assert.strictEqual(b.uiTextInfo("a\nb", 1), "a b");
  assert.throws(() => b.uiTextInfo("   ", 1), /empty/);
  assert.throws(() => b.uiTextInfo("x".repeat(71), 2), /max 70/);
  assert.strictEqual(b.uiTextInfo("x".repeat(200), 0).length, 200);
});

test("position: '=' when messaging capable (UISS), '!' otherwise", () => {
  assert.strictEqual(b.positionInfo({ lat: 40.5, lon: -111, messaging: true, comment: "hi" }), "=4030.00N/11100.00W`hi");
  assert.strictEqual(b.positionInfo({ lat: 40.5, lon: -111 }), "!4030.00N/11100.00W`");
});

test("APRS message: For addressee padded to 9, no ack id", () => {
  assert.strictEqual(b.messageInfo("email", "onxmu@amsat.org Hello Guy"), ":EMAIL    :onxmu@amsat.org Hello Guy");
  assert.throws(() => b.messageInfo("", "x"), /addressee/);
});
