// KISS framing: escape / unescape, streaming decode across chunk boundaries.
// Run: node --test --test-force-exit test/kiss-framing.test.js
const test = require("node:test");
const assert = require("assert");
const kiss = require("../lib/kiss/kiss");

test("encode escapes FEND/FESC and sets port nibble", () => {
  const f = kiss.encode(Buffer.from([0x01, 0xc0, 0x02, 0xdb, 0x03]), { port: 2 });
  assert.strictEqual(f.toString("hex"), "c02001dbdc02dbdd03c0");
});

test("decode round-trip, back-to-back FENDs, leading garbage", () => {
  const payload = Buffer.from([0xc0, 0xdb, 0x00, 0x41, 0xc0]);
  const wire = Buffer.concat([Buffer.from("junk"), Buffer.from([0xc0, 0xc0]), kiss.encode(payload, { port: 1 }), kiss.encode(Buffer.from("B"))]);
  const d = new kiss.Decoder();
  const frames = d.push(wire);
  assert.strictEqual(frames.length, 2);
  assert.strictEqual(frames[0].port, 1);
  assert.strictEqual(frames[0].cmd, 0);
  assert.deepStrictEqual(frames[0].data, payload);
  assert.strictEqual(frames[1].data.toString(), "B");
});

test("decode across arbitrary chunk splits", () => {
  const wire = Buffer.concat([kiss.encode(Buffer.from([0xc0, 1, 2, 0xdb])), kiss.encode(Buffer.from("hello"))]);
  for (let cut = 1; cut < wire.length; cut++) {
    const d = new kiss.Decoder();
    const out = d.push(wire.slice(0, cut)).concat(d.push(wire.slice(cut)));
    assert.strictEqual(out.length, 2, "cut " + cut);
    assert.deepStrictEqual(out[0].data, Buffer.from([0xc0, 1, 2, 0xdb]));
    assert.strictEqual(out[1].data.toString(), "hello");
  }
});

test("non-data commands are reported with cmd, oversize frames dropped", () => {
  const d = new kiss.Decoder({ maxFrame: 8 });
  const out = d.push(Buffer.concat([kiss.encode(Buffer.from([0x20]), { cmd: kiss.CMD.TXDELAY }), kiss.encode(Buffer.alloc(20, 0x41)), kiss.encode(Buffer.from("ok"))]));
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].cmd, kiss.CMD.TXDELAY);
  assert.strictEqual(out[1].data.toString(), "ok");
  assert.strictEqual(d.errors, 1);
});
