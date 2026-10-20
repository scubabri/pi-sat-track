// Bluetooth RFCOMM KISS transport (lib/kiss/bluetooth.js) with a fake helper
// process: KISS framing both ways, reconnect after the radio drops, error
// states, paired-device listing, config migration and service routing.
// Run: node --test --test-force-exit test/aprs-bluetooth.test.js
const test = require("node:test");
const assert = require("assert");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const { execFile } = require("child_process");

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pst-aprs-bt-"));

const kiss = require("../lib/kiss/kiss");
const ax25 = require("../lib/ax25");
const { KissClient } = require("../lib/kiss/client");
const { BluetoothTransport, normalizeMac, listPaired, testBluetooth, HELPER } = require("../lib/kiss/bluetooth");
const { createService, normalizeConfig } = require("../lib/aprs/service");

const MAC = "24:71:89:98:63:B9";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 3000)) {
    if (fn()) return true;
    await wait(10);
  }
  return false;
}

/** Fake rfcomm-bridge.py: script(cp, n) decides what each spawned helper does. */
function fakeSpawner(script) {
  const spawned = [];
  const spawn = (cmd, args) => {
    const cp = new EventEmitter();
    cp.cmd = cmd;
    cp.args = args;
    cp.stdin = new PassThrough();
    cp.stdout = new PassThrough();
    cp.stderr = new PassThrough();
    cp.written = [];
    cp.stdin.on("data", (b) => cp.written.push(b));
    cp.killed = false;
    cp.kill = () => {
      if (cp.killed) return;
      cp.killed = true;
      setImmediate(() => cp.emit("exit", null, "SIGTERM"));
    };
    cp.ok = () => cp.stderr.write("OK connected\n");
    cp.fail = (code, name, msg) => {
      cp.stderr.write("ERR " + code + " " + name + " " + msg + "\n");
      setImmediate(() => cp.emit("exit", 4));
    };
    spawned.push(cp);
    setImmediate(() => script(cp, spawned.length));
    return cp;
  };
  return { spawn, spawned };
}
function frameBuf(line) {
  const ci = line.indexOf(":");
  const [src, rest] = line.slice(0, ci).split(">");
  const parts = rest.split(",");
  const dst = parts.shift();
  return ax25.encodeUI({ src, dst, path: parts.map((x) => ax25.parseAddr(x)), info: Buffer.from(line.slice(ci + 1)) });
}
const opts = (spawn, more) => Object.assign({ address: MAC, channel: 2, spawn, diagnose: false, reconnectInitialMs: 30, reconnectMaxMs: 60, jitter: 0 }, more);

test("normalizeMac accepts common forms", () => {
  assert.strictEqual(normalizeMac("24:71:89:98:63:b9"), MAC);
  assert.strictEqual(normalizeMac("24-71-89-98-63-B9"), MAC);
  assert.strictEqual(normalizeMac("247189 9863b9"), MAC);
  assert.strictEqual(normalizeMac("24:71:89"), "");
});

test("KISS over RFCOMM: helper args, RX frames decoded, TX frames written as KISS", async () => {
  const f = fakeSpawner((cp) => cp.ok());
  const t = new BluetoothTransport(opts(f.spawn));
  const k = new KissClient(t, { kissPort: 0 });
  const rx = [];
  k.on("frame", (fr) => rx.push(fr));
  k.open();
  assert.ok(await until(() => t.state === "connected"));
  const cp = f.spawned[0];
  assert.strictEqual(cp.cmd, "python3");
  assert.deepStrictEqual(cp.args, [HELPER, MAC, "2", "15"]);
  assert.strictEqual(t.describe(), "bluetooth " + MAC + " ch 2");
  // a frame split across two reads
  const enc = kiss.encode(frameBuf("N0CALL-7>APRS,WIDE2-1:>hello"), { port: 0 });
  cp.stdout.write(enc.subarray(0, 5));
  cp.stdout.write(enc.subarray(5));
  assert.ok(await until(() => rx.length === 1));
  assert.strictEqual(ax25.toTnc2(rx[0].ax25), "N0CALL-7>APRS,WIDE2-1:>hello");
  const out = frameBuf("KA7KDX-3>APRS,DP0SNX:>test");
  assert.strictEqual(k.sendFrame(out), true);
  assert.ok(await until(() => cp.written.length === 1));
  assert.deepStrictEqual(Buffer.concat(cp.written), kiss.encode(out, { port: 0 }));
  k.close();
  assert.ok(await until(() => cp.killed));
  assert.strictEqual(t.state, "closed");
});

test("radio off then on: link lost -> waiting with a clear error -> reconnects", async () => {
  // 1st: connects then the radio drops; 2nd: radio still off; 3rd: back
  const f = fakeSpawner((cp, n) => {
    if (n === 1) {
      cp.ok();
      setTimeout(() => cp.fail(0, "EOF", "the radio closed the link"), 20);
    } else if (n === 2) cp.fail(112, "EHOSTDOWN", "Host is down");
    else cp.ok();
  });
  const t = new BluetoothTransport(opts(f.spawn));
  const errs = [];
  t.on("state", (s) => s === "waiting" && errs.push(t.lastError));
  t.on("error", () => {});
  t.open();
  assert.ok(await until(() => f.spawned.length >= 3 && t.state === "connected", 3000));
  assert.match(errs[0], /link lost \(radio turned off or out of range\)/);
  assert.match(errs[1], /radio not reachable/);
  assert.strictEqual(t.lastError, "");
  t.close();
});

test("error states: refused channel, not paired (diagnosed), python3 missing, bad address", async () => {
  let f = fakeSpawner((cp) => cp.fail(111, "ECONNREFUSED", "Connection refused"));
  let t = new BluetoothTransport(opts(f.spawn, { channel: 5, reconnectInitialMs: 5000 }));
  t.on("error", () => {});
  t.open();
  assert.ok(await until(() => t.state === "waiting"));
  assert.match(t.lastError, /refused on RFCOMM channel 5 \(wrong channel, or the radio's KISS interface is not set to Bluetooth\)/);
  t.close();

  f = fakeSpawner((cp) => cp.fail(13, "EACCES", "Permission denied"));
  t = new BluetoothTransport(opts(f.spawn, { reconnectInitialMs: 5000, diagnose: async (mac) => "radio " + mac + " is not paired: bluetoothctl pair " + mac }));
  t.on("error", () => {});
  t.open();
  assert.ok(await until(() => /not paired/.test(t.lastError)), t.lastError);
  t.close();

  const enoent = () => {
    const cp = new EventEmitter();
    cp.stdin = new PassThrough();
    cp.stdout = new PassThrough();
    cp.stderr = new PassThrough();
    cp.kill = () => {};
    setImmediate(() => cp.emit("error", Object.assign(new Error("spawn python3 ENOENT"), { code: "ENOENT" })));
    return cp;
  };
  t = new BluetoothTransport(opts(enoent, { reconnectInitialMs: 5000 }));
  t.on("error", () => {});
  t.open();
  assert.ok(await until(() => t.state === "waiting"));
  assert.match(t.lastError, /python3 not found/);
  t.close();

  f = fakeSpawner((cp) => cp.ok());
  t = new BluetoothTransport(opts(f.spawn, { address: "nope", reconnectInitialMs: 5000 }));
  t.on("error", () => {});
  t.open();
  assert.ok(await until(() => t.state === "waiting"));
  assert.strictEqual(f.spawned.length, 0, "no helper for an invalid address");
  assert.match(t.lastError, /invalid Bluetooth address/);
  t.close();
});

test("real helper: rejects a bad address / channel without touching Bluetooth", async () => {
  const run = (args) => new Promise((r) => execFile("python3", [HELPER].concat(args), (err, so, se) => r({ code: err ? err.code : 0, se })));
  let r = await run(["bad", "2"]);
  assert.strictEqual(r.code, 2);
  assert.match(r.se, /^ERR 22 EINVAL /);
  r = await run([MAC, "0"]);
  assert.strictEqual(r.code, 2);
  assert.match(r.se, /channel must be 1-30/);
});

test("Test button probe: connects, counts KISS frames, closes, never writes", async () => {
  const f = fakeSpawner((cp) => {
    cp.ok();
    setTimeout(() => cp.stdout.write(kiss.encode(frameBuf("N0CALL>APRS:>hi"), { port: 0 })), 10);
  });
  const r = await testBluetooth(MAC, 2, { spawn: f.spawn, diagnose: false, listenMs: 80 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.frames, 1);
  assert.strictEqual(r.sample, "N0CALL>APRS:>hi");
  assert.strictEqual(r.target, "Bluetooth " + MAC + " ch 2");
  assert.strictEqual(f.spawned[0].written.length, 0);
  assert.ok(f.spawned[0].killed);
  const f2 = fakeSpawner((cp) => cp.fail(112, "EHOSTDOWN", "Host is down"));
  const r2 = await testBluetooth(MAC, 2, { spawn: f2.spawn, diagnose: false });
  assert.strictEqual(r2.ok, false);
  assert.match(r2.error, /radio not reachable/);
});

test("paired devices via bluetoothctl (new and old BlueZ syntax, errors)", async () => {
  const fakeExec = (map) => (cmd, args, o, cb) => {
    const k = args.join(" ");
    const v = map[k];
    if (v instanceof Error) return cb(v, "", "");
    cb(null, v || "", "");
  };
  let r = await listPaired({ exec: fakeExec({ show: "Controller B8:27:EB:00:00:01 bs-pitrack [default]\n\tPowered: yes\n", "devices Paired": "Device 24:71:89:98:63:B9 TH-D74\nDevice 38:D2:00:11:22:33 UV-PRO\n" }) });
  assert.deepStrictEqual(r.devices, [{ mac: MAC, name: "TH-D74" }, { mac: "38:D2:00:11:22:33", name: "UV-PRO" }]);
  assert.strictEqual(r.ok, true);
  r = await listPaired({ exec: fakeExec({ show: "\tPowered: yes\n", "devices Paired": "Invalid command\n", "paired-devices": "Device 24:71:89:98:63:b9 TH-D74\n" }) });
  assert.deepStrictEqual(r.devices, [{ mac: MAC, name: "TH-D74" }]);
  r = await listPaired({ exec: fakeExec({ show: Object.assign(new Error("spawn bluetoothctl ENOENT"), { code: "ENOENT" }) }) });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not installed/);
  r = await listPaired({ exec: fakeExec({ show: "No default controller available\n" }) });
  assert.match(r.error, /no Bluetooth adapter/);
  r = await listPaired({ exec: fakeExec({ show: "\tPowered: no\n", "devices Paired": "" }) });
  assert.match(r.error, /powered off/);
});

test("config: Bluetooth by MAC, TH-D74 preset, older /dev/rfcomm0 rows become 'serial'", () => {
  const c = normalizeConfig({
    connections: [
      { id: "a", name: "D74", preset: "th-d74", transport: "bluetooth", btAddress: "24-71-89-98-63-b9", btChannel: 2, speed: 1200 },
      { id: "b", name: "Old BT", transport: "bluetooth", serialDevice: "/dev/rfcomm0", serialBaud: 9600 },
      { id: "c", name: "USB", transport: "serial", serialDevice: "/dev/ttyACM0" },
      { id: "d", name: "Bad ch", transport: "bluetooth", btAddress: MAC, btChannel: 99 },
    ],
  });
  const [a, b, cc, d] = c.connections;
  assert.strictEqual(a.transport, "bluetooth");
  assert.strictEqual(a.btAddress, MAC);
  assert.strictEqual(a.preset, "th-d74");
  assert.strictEqual(a.btChannel, 2);
  assert.strictEqual(b.transport, "serial");
  assert.strictEqual(b.serialDevice, "/dev/rfcomm0");
  assert.strictEqual(cc.transport, "serial");
  assert.strictEqual(d.btChannel, 2, "out of range -> default");
});

test("service: a Bluetooth connection merges RX and gets routed TX like TCP", async () => {
  const f = fakeSpawner((cp) => cp.ok());
  const out = [];
  const svc = createService({
    broadcast: (m) => out.push(m),
    log: () => {},
    getStation: () => ({ callsign: "KA7KDX", grid: "DN40" }),
    getTxContext: () => ({ radioOn: true, sat: null }),
    createTransport: (c) => new BluetoothTransport({ address: c.btAddress, channel: c.btChannel, spawn: f.spawn, diagnose: false, reconnectInitialMs: 30 }),
  });
  svc.configure({
    enabled: true,
    txEnabled: true,
    logToFile: false,
    ssid: 3,
    connections: [{ id: "d74", name: "TH-D74", preset: "th-d74", transport: "bluetooth", btAddress: MAC, btChannel: 2, role: "rxtx", speed: 1200 }],
  });
  assert.ok(await until(() => svc.statusPayload().state === "connected"));
  const st = svc.statusPayload().connections[0];
  assert.strictEqual(st.target, "bluetooth " + MAC + " ch 2");
  f.spawned[0].stdout.write(kiss.encode(frameBuf("N0CALL-9>APRS,WIDE2-1:!4000.00N/10500.00W>bt rx"), { port: 0 }));
  assert.ok(await until(() => out.some((m) => m.type === "aprs-packet" && m.packet.conn === "TH-D74" && /bt rx/.test(m.packet.tnc2))));
  const r = svc.send({ kind: "text", text: ">via BT", via: "WIDE2-1" });
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
  assert.strictEqual(r.packet.conn, "TH-D74");
  assert.ok(await until(() => f.spawned[0].written.length === 1));
  // radio switched off: status shows the error, then it comes back
  f.spawned[0].fail(0, "EOF", "the radio closed the link");
  assert.ok(await until(() => /link lost/.test(svc.statusPayload().connections[0].error || "") || f.spawned.length > 1));
  assert.ok(await until(() => f.spawned.length >= 2 && svc.statusPayload().state === "connected"));
  svc.stop();
});
