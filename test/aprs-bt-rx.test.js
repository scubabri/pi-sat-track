// Bluetooth KISS RX path: the real rfcomm-bridge.py relays radio -> app and
// app -> radio unbuffered (over a local TCP socket standing in for RFCOMM),
// raw bytes are counted apart from KISS frames, and the "no KISS frames" /
// "no data" diagnostics fire (once) for a radio not in KISS12 mode.
// Run: node --test --test-force-exit test/aprs-bt-rx.test.js
const test = require("node:test");
const assert = require("assert");
const net = require("net");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pst-aprs-btrx-"));

const kiss = require("../lib/kiss/kiss");
const ax25 = require("../lib/ax25");
const { BluetoothTransport } = require("../lib/kiss/bluetooth");
const { KissClient, preview } = require("../lib/kiss/client");
const { createService } = require("../lib/aprs/service");

const MAC = "24:71:89:98:60:D5";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 4000)) {
    if (fn()) return true;
    await wait(5);
  }
  return false;
}
const frame = (src, info) => ax25.encodeUI({ src, dst: "APRS", path: [ax25.parseAddr("ARISS")], info });

/** A local TCP "radio" the bridge connects to (PST_RFCOMM_BRIDGE_TEST_INET). */
function fakeRadio() {
  return new Promise((resolve) => {
    const r = { sock: null, rx: [] };
    const srv = net.createServer((s) => {
      r.sock = s;
      s.on("data", (b) => r.rx.push(b));
      s.on("error", () => {});
    });
    srv.listen(0, "127.0.0.1", () => {
      r.port = srv.address().port;
      r.close = () => new Promise((d) => (r.sock && r.sock.destroy(), srv.close(d)));
      resolve(r);
    });
  });
}
function bridged(port) {
  process.env.PST_RFCOMM_BRIDGE_TEST_INET = "127.0.0.1:" + port;
  return new BluetoothTransport({ address: MAC, channel: 2, diagnose: false, reconnectInitialMs: 100 });
}

test("real rfcomm-bridge.py: radio -> app bytes arrive per chunk without waiting for more (unbuffered, binary), app -> radio too", async () => {
  const radio = await fakeRadio();
  const t = bridged(radio.port);
  const chunks = [];
  t.on("data", (b) => chunks.push({ b, at: Date.now() }));
  t.open();
  assert.ok(await until(() => t.state === "connected" && radio.sock), "bridge connected");
  // a lone FEND + one binary byte (no newline): must arrive on its own
  const at = Date.now();
  radio.sock.write(Buffer.from([0xc0, 0x00]));
  assert.ok(await until(() => Buffer.concat(chunks.map((c) => c.b)).length >= 2, 1500), "first 2 bytes arrived");
  assert.ok(chunks[0].at - at < 1000, "no buffering delay");
  const big = Buffer.alloc(10000);
  for (let i = 0; i < big.length; i++) big[i] = i & 0xff; // every byte value incl. 0x0a / 0x0d / 0xc0
  radio.sock.write(big);
  assert.ok(await until(() => Buffer.concat(chunks.map((c) => c.b)).length >= 10002));
  assert.ok(Buffer.concat(chunks.map((c) => c.b)).subarray(2).equals(big), "bytes intact");
  assert.strictEqual(t.write(Buffer.from([0xc0, 0x00, 0x41, 0x0a, 0xc0])), true);
  assert.ok(await until(() => Buffer.concat(radio.rx).length >= 5));
  assert.deepStrictEqual([...Buffer.concat(radio.rx)], [0xc0, 0x00, 0x41, 0x0a, 0xc0]);
  t.close();
  await radio.close();
});

test("bridge + KISS client + service: frames decode, first frame and byte counts are reported", async () => {
  const radio = await fakeRadio();
  const logs = [];
  const out = [];
  const svc = createService({
    broadcast: (m) => out.push(m),
    log: (m) => logs.push(m),
    getStation: () => ({ callsign: "K0TEST", grid: "DN40" }),
    getTxContext: () => ({ radioOn: false, sat: null }),
    createTransport: () => bridged(radio.port),
  });
  svc.configure({ enabled: true, connections: [{ id: "d74", name: "TH-D74", preset: "th-d74", transport: "bluetooth", btAddress: MAC, btChannel: 2, role: "rx" }] });
  assert.ok(await until(() => radio.sock && svc.statusPayload().connections[0].state === "connected"));
  const k = kiss.encode(frame("KA7XYZ-7", "!4000.00N/10500.00W-test"));
  radio.sock.write(k.subarray(0, 5)); // split mid-frame
  await wait(50);
  radio.sock.write(k.subarray(5));
  assert.ok(await until(() => out.some((m) => m.type === "aprs-packet")), "packet decoded");
  const st = svc.statusPayload().connections[0];
  assert.strictEqual(st.rx, 1);
  assert.strictEqual(st.rxBytes, k.length);
  assert.strictEqual(st.diag, "");
  assert.ok(logs.some((l) => /^APRS: KISS \[TH-D74\] first frame received from bluetooth 24:71:89:98:60:D5 ch 2/.test(l)), logs.join("\n"));
  radio.sock.write(kiss.encode(frame("KA7XYZ-8", ">second")));
  assert.ok(await until(() => svc.statusPayload().connections[0].rx === 2));
  assert.strictEqual(logs.filter((l) => /first frame/.test(l)).length, 1, "first frame logged once");
  svc.stop();
  await radio.close();
});

test("radio not in KISS mode: text bytes counted, no frames, one warning with a hex/ASCII preview", async () => {
  const radio = await fakeRadio();
  const logs = [];
  const svc = createService({
    broadcast: () => {},
    log: (m) => logs.push(m),
    getStation: () => ({ callsign: "K0TEST", grid: "DN40" }),
    getTxContext: () => ({ radioOn: false, sat: null }),
    createTransport: () => bridged(radio.port),
  });
  svc.configure({ enabled: true, connections: [{ id: "d74", name: "TH-D74", preset: "th-d74", transport: "bluetooth", btAddress: MAC, btChannel: 2, role: "rx" }] });
  assert.ok(await until(() => radio.sock && svc.statusPayload().connections[0].state === "connected"));
  radio.sock.write("\r\ncmd:KA7XYZ-7>APRS,ARISS:!4000.00N/10500.00W-test\r\ncmd:");
  assert.ok(await until(() => svc.statusPayload().connections[0].diag === "no-kiss"));
  const st = svc.statusPayload().connections[0];
  assert.strictEqual(st.rx, 0);
  assert.ok(st.rxBytes >= 48);
  const w = logs.filter((l) => /receiving data but no KISS frames/.test(l));
  assert.strictEqual(w.length, 1);
  assert.match(w[0], /is the radio in KISS mode \(KISS12\)\?/);
  const pv = logs.find((l) => /first bytes:/.test(l));
  assert.match(pv, /0d 0a 63 6d 64 3a/);
  assert.match(pv, /\|\.\.cmd:KA7XYZ-7>APRS/);
  radio.sock.write("more text cmd:\r\n".repeat(10));
  await wait(150);
  assert.strictEqual(logs.filter((l) => /receiving data but no KISS frames/.test(l)).length, 1, "not repeated");
  // once KISS12 is set, frames decode and the hint clears
  radio.sock.write(kiss.encode(frame("KA7XYZ-7", ">kiss now")));
  assert.ok(await until(() => svc.statusPayload().connections[0].rx === 1));
  assert.strictEqual(svc.statusPayload().connections[0].diag, "");
  svc.stop();
  await radio.close();
});

test("connected but silent for 2+ min: 'no-data' diag and one warning; preview() format", () => {
  const t = new EventEmitter();
  t.state = "connected";
  t.connectedSince = Date.now() - 121000;
  t.describe = () => "bluetooth " + MAC + " ch 2";
  t.open = t.close = () => {};
  const c = new KissClient(t, {});
  const ev = [];
  c.on("no-data", (x) => ev.push(x));
  assert.strictEqual(c.status().diag, "no-data");
  assert.strictEqual(c.status().diag, "no-data");
  assert.strictEqual(ev.length, 1);
  t.connectedSince = Date.now() - 5000;
  t.emit("open");
  assert.strictEqual(c.status().diag, "", "fresh connection: no hint yet");
  t.state = "waiting";
  assert.strictEqual(c.status().diag, "");
  assert.strictEqual(preview(Buffer.from([0xc0, 0x41, 0x0a])), "c0 41 0a  |.A.|");
});

test("TX over the real bridge: Send writes one KISS frame to the radio at once, logged with connection, target and size; no ack expected", async () => {
  const radio = await fakeRadio();
  const logs = [];
  const svc = createService({
    broadcast: () => {},
    log: (m) => logs.push(m),
    getStation: () => ({ callsign: "K0TEST", grid: "DN40" }),
    getTxContext: () => ({ radioOn: true, sat: { satKey: "ISS", satName: "ISS", mode: "APRS 1k2 AFSK", el: 40, norad: 25544 } }),
    createTransport: () => bridged(radio.port),
  });
  svc.configure({ enabled: true, txEnabled: true, logToFile: false, connections: [{ id: "d74", name: "TH-D74", preset: "th-d74", transport: "bluetooth", btAddress: MAC, btChannel: 2, role: "rxtx", speed: 1200 }] });
  assert.ok(await until(() => radio.sock && svc.statusPayload().connections[0].state === "connected"));
  const r = svc.send({ kind: "text", text: ">bt tx test", via: "ARISS" });
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
  assert.strictEqual(r.packet.conn, "TH-D74");
  assert.ok(await until(() => new kiss.Decoder().push(Buffer.concat(radio.rx)).length === 1, 1500), "frame reached the radio");
  const f = new kiss.Decoder().push(Buffer.concat(radio.rx))[0];
  assert.strictEqual(ax25.decode(f.data).info.toString(), ">bt tx test");
  const line = logs.find((l) => /^APRS: TX via \[TH-D74\]/.test(l));
  assert.match(line, /^APRS: TX via \[TH-D74\] bluetooth 24:71:89:98:60:D5 ch 2, \d+ bytes: K0TEST>/);
  assert.strictEqual(Number(line.match(/, (\d+) bytes/)[1]), Buffer.concat(radio.rx).length);
  await wait(200);
  assert.strictEqual(svc.statusPayload().connections[0].state, "connected", "no ack needed");
  assert.strictEqual(svc.statusPayload().lastTx.conn, "TH-D74");
  svc.stop();
  await radio.close();
});
