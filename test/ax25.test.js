// AX.25 UI frame encode / decode / TNC2 text.
// Run: node --test --test-force-exit test/ax25.test.js
const test = require("node:test");
const assert = require("assert");
const ax25 = require("../lib/ax25");

test("encodeUI matches a hand-built frame (no SSID = SSID 0)", () => {
  const f = ax25.encodeUI({ src: "N0CALL", dst: "APRS", path: [], info: "test" });
  // dst "APRS  " C=1, src "N0CALL" SSID 0 + last bit, ctl 03, pid f0, "test"
  assert.strictEqual(f.toString("hex"), "82a0a4a64040e0" + "9c608682989861" + "03f0" + "74657374");
});

test("encode with SSID and ARISS path, decode back", () => {
  const f = ax25.encodeUI({ src: "KF0ABC-7", dst: "APZPST", path: "ARISS", info: ":RS0ISS   :hi" });
  const d = ax25.decode(f);
  assert.deepStrictEqual(d.src, { call: "KF0ABC", ssid: 7 });
  assert.deepStrictEqual(d.dst, { call: "APZPST", ssid: 0 });
  assert.deepStrictEqual(d.path, [{ call: "ARISS", ssid: 0, h: false }]);
  assert.ok(d.isUI);
  assert.strictEqual(d.pid, 0xf0);
  assert.strictEqual(ax25.toTnc2(d), "KF0ABC-7>APZPST,ARISS::RS0ISS   :hi");
  // last address (ARISS) carries the extension bit, src does not
  assert.strictEqual(f[13] & 1, 0);
  assert.strictEqual(f[20] & 1, 1);
});

test("H bit marks the last repeated digi in TNC2", () => {
  const f = ax25.encodeUI({
    src: "BH2VSQ",
    dst: "CQ",
    path: [
      { call: "RS0ISS", ssid: 0, h: true },
      { call: "WIDE2", ssid: 1, h: false },
    ],
    info: "CQ BH2VSQ OL79",
  });
  const d = ax25.decode(f);
  assert.strictEqual(d.path[0].h, true);
  assert.strictEqual(ax25.toTnc2(d), "BH2VSQ>CQ,RS0ISS*,WIDE2-1:CQ BH2VSQ OL79");
});

test("parseAddr / parsePath validation", () => {
  assert.deepStrictEqual(ax25.parseAddr("rs0iss*"), { call: "RS0ISS", ssid: 0, h: true });
  assert.strictEqual(ax25.parseAddr("TOOLONGCALL"), null);
  assert.strictEqual(ax25.parseAddr("N0CALL-16"), null);
  assert.deepStrictEqual(ax25.parsePath(""), []);
  assert.strictEqual(ax25.parsePath("ARISS, WIDE2-1").length, 2);
  assert.throws(() => ax25.parsePath("A,B,C,D,E,F,G,H,I"));
  assert.throws(() => ax25.parsePath("BAD!"));
});

test("decode rejects truncated / malformed frames, flags non-UI", () => {
  assert.strictEqual(ax25.decode(Buffer.from("short")), null);
  const f = ax25.encodeUI({ src: "N0CALL", dst: "APRS", info: "x" });
  assert.strictEqual(ax25.decode(f.slice(0, 10)), null);
  const i = Buffer.from(f);
  i[14] = 0x00; // I-frame control
  const d = ax25.decode(i);
  assert.strictEqual(d.isUI, false);
});
