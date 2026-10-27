// WSJT-X Reply (4): packet encoding, decode bookkeeping, and the real UDP
// round trip through the listener (fake WSJT-X on 127.0.0.1, random ports).
// Run: node --test --test-force-exit test/wsjtx-reply.test.js
const test = require("node:test");
const assert = require("assert");
const dgram = require("dgram");
const { encodeReply, decodeDatagram, createListener } = require("../lib/wsjtx-listener");
const { createStore } = require("../lib/wsjtx-decodes");

const D = { timeMs: 45015000, snr: -12, dt: 0.3, df: 1520, mode: "~", message: "CQ K1ABC FN42", lowConfidence: false };

/** Independent QDataStream reader for the Reply layout. */
function readReply(b) {
  let o = 0;
  const u32 = () => { const v = b.readUInt32BE(o); o += 4; return v; };
  const str = () => { const n = u32(); if (n === 0xffffffff) return null; const v = b.toString("utf8", o, o + n); o += n; return v; };
  const r = { magic: u32(), schema: u32(), type: u32(), id: str(), timeMs: u32() };
  r.snr = b.readInt32BE(o); o += 4;
  r.dt = b.readDoubleBE(o); o += 8;
  r.df = u32(); r.mode = str(); r.message = str();
  r.lowConfidence = b.readUInt8(o++) !== 0;
  r.modifiers = b.readUInt8(o++);
  r.rest = b.length - o;
  return r;
}

test("encodeReply: WSJT-X framing (magic, schema 2, type 4, id) + echoed decode fields", () => {
  const b = encodeReply("WSJT-X - IC9700", D);
  const r = readReply(b);
  assert.strictEqual(r.magic, 0xadbccbda);
  assert.strictEqual(r.schema, 2);
  assert.strictEqual(r.type, 4);
  assert.strictEqual(r.id, "WSJT-X - IC9700");
  assert.strictEqual(r.timeMs, D.timeMs);
  assert.strictEqual(r.snr, -12);
  assert.strictEqual(r.dt, 0.3);
  assert.strictEqual(r.df, 1520);
  assert.strictEqual(r.mode, "~");
  assert.strictEqual(r.message, "CQ K1ABC FN42");
  assert.strictEqual(r.lowConfidence, false);
  assert.strictEqual(r.modifiers, 0);
  assert.strictEqual(r.rest, 0, "no trailing bytes");
  // exact bytes for the header
  assert.strictEqual(b.subarray(0, 12).toString("hex"), "adbccbda0000000200000004");
  assert.strictEqual(readReply(encodeReply("x", Object.assign({}, D, { lowConfidence: true, snr: 5 }))).lowConfidence, true);
});

/** Decode (2) datagram as WSJT-X sends it. */
function decodePacket(id, d) {
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
  const s = (t) => { const x = Buffer.from(t, "utf8"); return Buffer.concat([u32(x.length), x]); };
  const i32 = Buffer.alloc(4); i32.writeInt32BE(d.snr);
  const f64 = Buffer.alloc(8); f64.writeDoubleBE(d.dt);
  return Buffer.concat([u32(0xadbccbda), u32(2), u32(2), s(id), Buffer.from([1]), u32(d.timeMs), i32, f64, u32(d.df), s(d.mode), s(d.message), Buffer.from([d.lowConfidence ? 1 : 0, 0])]);
}

test("store keeps the Reply target per station; listener sends Reply back to the sender", async () => {
  const store = createStore({ throttleMs: 0, getMyCall: () => "N0CALL" });
  const statuses = [];
  const lst = createListener({
    onQso() {},
    onStatus: (st) => statuses.push(st),
    onDecode: (d, id, from) => store.add(d, Date.now(), Object.assign({ id }, from)),
  });
  lst.setGate(true);
  lst.configure({ enabled: true, port: 0, bind: "127.0.0.1" });
  await new Promise((r) => { const t = setInterval(() => { if (lst.getStatus().state === "listening") { clearInterval(t); r(); } }, 10); });
  const port = lst.getStatus().port;
  const fake = dgram.createSocket("udp4");
  await new Promise((r) => fake.bind(0, "127.0.0.1", r));
  const got = new Promise((r) => fake.once("message", (m, ri) => r({ m, ri })));
  fake.send(decodePacket("WSJT-X", D), port, "127.0.0.1");
  await new Promise((r) => { const t = setInterval(() => { if (store.replyFor("K1ABC")) { clearInterval(t); r(); } }, 10); });
  assert.ok(lst.getStatus().connected, "connected after a packet");
  const info = store.replyFor("K1ABC");
  assert.deepStrictEqual(info.target, { address: "127.0.0.1", port: fake.address().port });
  assert.strictEqual(info.id, "WSJT-X");
  await lst.sendReply(info.target, info.id, info.decode);
  const { m, ri } = await got;
  assert.strictEqual(ri.port, port, "sent from the listener port");
  const r = readReply(m);
  assert.strictEqual(r.type, 4);
  assert.strictEqual(r.id, "WSJT-X");
  assert.strictEqual(r.message, "CQ K1ABC FN42");
  assert.strictEqual(r.df, 1520);
  assert.strictEqual(r.timeMs, D.timeMs);
  const dd = decodeDatagram(decodePacket("WSJT-X", D));
  assert.strictEqual(dd.decode.message, "CQ K1ABC FN42");
  fake.close();
  lst.stop();
  await assert.rejects(lst.sendReply(info.target, info.id, info.decode), /not running/);
  assert.strictEqual(lst.getStatus().connected, false);
});

test("Status (1) parse gives WSJT-X's DE call (fallback for 'calling us')", () => {
  const logbook = require("../lib/logbook");
  const b = logbook.encodeStatus("WSJT-X", { dialHz: 145990000, mode: "FT8", deCall: "N0CALL", deGrid: "AA00" });
  const m = decodeDatagram(b);
  assert.strictEqual(m.type, 1);
  assert.strictEqual(m.status.deCall, "N0CALL");
  assert.strictEqual(m.status.deGrid, "AA00");
});
