// Configure Bluetooth Scan / Pair / Remove / Power on (lib/kiss/bt-manager.js)
// against a mocked bluetoothctl: discovery parsing, one scan at a time,
// pairing (just works, passkey confirm, PIN), failures, unpair, power on.
// Run: node --test --test-force-exit test/aprs-bt-manager.test.js
const test = require("node:test");
const assert = require("assert");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const { BtManager, cleanLine, pairError } = require("../lib/kiss/bt-manager");

const D74 = "24:71:89:98:63:B9";
const PHONE = "AC:DE:48:00:11:22";
const UVPRO = "38:D2:00:11:22:33";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 2000)) {
    if (fn()) return true;
    await wait(5);
  }
  return false;
}

/** Fake interactive bluetoothctl: onCmd(cmd, out) answers each command line. */
function fakeCtl(onCmd) {
  const sessions = [];
  const spawn = (cmd) => {
    assert.strictEqual(cmd, "bluetoothctl");
    const cp = new EventEmitter();
    cp.stdin = new PassThrough();
    cp.stdout = new PassThrough();
    cp.stderr = new PassThrough();
    cp.cmds = [];
    cp.kill = () => setImmediate(() => cp.emit("exit", 0));
    const out = (s) => cp.stdout.write(s);
    let buf = "";
    cp.stdin.on("data", (b) => {
      buf += b.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const c = buf.slice(0, i);
        buf = buf.slice(i + 1);
        cp.cmds.push(c);
        if (c === "quit") setImmediate(() => cp.emit("exit", 0));
        else onCmd(c, out, cp);
      }
    });
    sessions.push(cp);
    return cp;
  };
  return { spawn, sessions };
}
/** Fake one-shot bluetoothctl / rfkill: map "cmd args" -> stdout | Error. */
const fakeExec = (map, calls) => (cmd, args, o, cb) => {
  const k = (cmd === "bluetoothctl" ? "" : cmd + " ") + args.join(" ");
  if (calls) calls.push(k);
  let v = map[k];
  if (typeof v === "function") v = v();
  if (v instanceof Error) return cb(v, "", "");
  cb(null, v || "", "");
};
const SHOW_OK = "Controller B8:27:EB:00:00:01 (public)\n\tName: bs-pitrack\n\tPowered: yes\n\tDiscovering: no\n";
const updates = (m) => {
  const u = [];
  m.on("update", (x) => u.push(x));
  return u;
};

test("cleanLine strips colours and prompts", () => {
  assert.strictEqual(cleanLine("\x1b[0;94m[bluetooth]\x1b[0m# [\x1b[0;92mNEW\x1b[0m] Device 24:71:89:98:63:B9 TH-D74\r"), "[NEW] Device 24:71:89:98:63:B9 TH-D74");
  assert.strictEqual(cleanLine("[TH-D74]# Pairing successful"), "Pairing successful");
});

test("scan: discovered devices with name / RSSI / paired / trusted, radios first; one scan at a time; Stop", async () => {
  const ctl = fakeCtl((c, out) => {
    if (c === "scan on") {
      out("Discovery started\n[CHG] Controller B8:27:EB:00:00:01 Discovering: yes\n");
      out("[NEW] Device " + PHONE + " Brian's iPhone\n");
      out("[NEW] Device " + D74 + " TH-D74\n");
      out("[CHG] Device " + D74 + " RSSI: 0xffffffc4 (-60)\n");
      out("[NEW] Device " + UVPRO + " 38-D2-00-11-22-33\n");
      out("[CHG] Device " + UVPRO + " Name: UV-PRO\n");
      out("[CHG] Device " + PHONE + " RSSI: -48\n");
    }
  });
  const m = new BtManager({ spawn: ctl.spawn, exec: fakeExec({ show: SHOW_OK, "devices Paired": "Device " + UVPRO + " UV-PRO\n", "devices Trusted": "Device " + UVPRO + " UV-PRO\n" }), scanMs: 5000 });
  const u = updates(m);
  const p = await m.startScan({ id: "c4", owner: "ws1" });
  assert.strictEqual(p.state, "scanning");
  assert.deepStrictEqual(ctl.sessions[0].cmds, ["scan on"]);
  assert.ok(await until(() => u.some((x) => x.devices && x.devices.length === 3 && x.devices.some((d) => d.name === "UV-PRO"))));
  const last = u.filter((x) => x.op === "scan").pop();
  assert.deepStrictEqual(
    last.devices.map((d) => [d.name, d.likely, d.paired, d.trusted, d.rssi]),
    [
      ["TH-D74", true, false, false, -60],
      ["UV-PRO", true, true, true, null],
      ["Brian's iPhone", false, false, false, -48],
    ],
  );
  assert.strictEqual(last.id, "c4");
  const again = await m.startScan({ id: "c5" });
  assert.strictEqual(again.note, "already scanning");
  assert.strictEqual(ctl.sessions.length, 1, "only one discovery session");
  const done = m.stopScan();
  assert.strictEqual(done.state, "done");
  assert.ok(ctl.sessions[0].cmds.includes("scan off") && ctl.sessions[0].cmds.includes("quit"));
});

test("scan stops by itself after the timeout and when its client goes away", async () => {
  const ctl = fakeCtl(() => {});
  const m = new BtManager({ spawn: ctl.spawn, exec: fakeExec({ show: SHOW_OK }), scanMs: 40 });
  const u = updates(m);
  await m.startScan({ owner: "a" });
  assert.ok(await until(() => u.some((x) => x.op === "scan" && x.state === "done")));
  assert.ok(ctl.sessions[0].cmds.includes("scan off"));
  const m2 = new BtManager({ spawn: ctl.spawn, exec: fakeExec({ show: SHOW_OK }), scanMs: 60000 });
  await m2.startScan({ owner: "ws9" });
  m2.release("other");
  assert.strictEqual(m2.scan.running, true);
  m2.release("ws9");
  assert.strictEqual(m2.scan.running, false);
});

test("scan errors: adapter off (Power on offered), blocked, no adapter, BlueZ missing, permission", async () => {
  const err = async (show) => (await new BtManager({ spawn: fakeCtl(() => {}).spawn, exec: fakeExec({ show }) }).startScan({ id: "x" }));
  let r = await err("Controller X\n\tPowered: no\n");
  assert.strictEqual(r.state, "error");
  assert.match(r.error, /powered off/);
  assert.strictEqual(r.canPowerOn, true);
  r = await err("Controller X\n\tPowered: no\n\tPowerState: off-blocked\n");
  assert.match(r.error, /soft-blocked by the system\. Run: sudo rfkill unblock bluetooth/);
  assert.strictEqual(r.copy, "sudo rfkill unblock bluetooth");
  assert.strictEqual(r.canPowerOn, true);
  r = await err("No default controller available\n");
  assert.match(r.error, /no Bluetooth adapter/);
  r = await err(Object.assign(new Error("spawn bluetoothctl ENOENT"), { code: "ENOENT" }));
  assert.match(r.error, /not installed/);
  r = await err("Access denied\n");
  assert.match(r.error, /bluetooth group/);
});

/** bluetoothctl pairing script: mode decides how the radio answers. */
function pairCtl(mode) {
  return fakeCtl((c, out) => {
    if (c === "agent KeyboardDisplay") out("Agent registered\n");
    else if (c === "default-agent") out("Default agent request successful\n");
    else if (c.startsWith("pair ")) {
      out("Attempting to pair with " + D74 + "\n");
      if (mode === "justworks") out("[CHG] Device " + D74 + " Paired: yes\nPairing successful\n");
      else if (mode === "confirm") out("[agent] Confirm passkey 482913 (yes/no): ");
      else if (mode === "pin") out("[agent] Enter PIN code: ");
      else if (mode === "fail") out("Failed to pair: org.bluez.Error.AuthenticationFailed\n");
      else if (mode === "notfound") out("Device " + D74 + " not available\n");
      else if (mode === "already") out("Failed to pair: org.bluez.Error.AlreadyExists\n");
    } else if (c === "yes" || c === "0000") out("[CHG] Device " + D74 + " Paired: yes\nPairing successful\n");
    else if (c === "no") out("Failed to pair: org.bluez.Error.AuthenticationRejected\n");
    else if (c.startsWith("trust ")) out("[CHG] Device " + D74 + " Trusted: yes\nChanging " + D74 + " trust succeeded\n");
  });
}

test("pair (just works): agent, pair, trust; result fills in the MAC", async () => {
  const ctl = pairCtl("justworks");
  const m = new BtManager({ spawn: ctl.spawn });
  const u = updates(m);
  const r = await m.pair(D74.toLowerCase(), { id: "c4" });
  assert.strictEqual(r.state, "done");
  assert.strictEqual(r.trusted, true);
  assert.strictEqual(r.mac, D74);
  assert.strictEqual(r.id, "c4");
  assert.deepStrictEqual(ctl.sessions[0].cmds.slice(0, 4), ["agent KeyboardDisplay", "default-agent", "pair " + D74, "trust " + D74]);
  assert.ok(u.some((x) => x.op === "pair" && x.step === "trust"));
  assert.strictEqual(m.pairing, null);
  // already paired counts as success (then trusted)
  const r2 = await new BtManager({ spawn: pairCtl("already").spawn }).pair(D74);
  assert.strictEqual(r2.state, "done");
});

test("pair: passkey confirmation and PIN prompts are relayed to the UI and answered", async () => {
  let ctl = pairCtl("confirm");
  let m = new BtManager({ spawn: ctl.spawn });
  let u = updates(m);
  let pr = m.pair(D74);
  assert.ok(await until(() => u.some((x) => x.state === "prompt")));
  const p = u.find((x) => x.state === "prompt");
  assert.deepStrictEqual(p.prompt, { kind: "confirm", code: "482913" });
  assert.strictEqual(m.pairReply(true), true);
  assert.strictEqual((await pr).state, "done");
  assert.ok(ctl.sessions[0].cmds.includes("yes"));

  ctl = pairCtl("confirm");
  m = new BtManager({ spawn: ctl.spawn });
  u = updates(m);
  pr = m.pair(D74);
  assert.ok(await until(() => u.some((x) => x.state === "prompt")));
  m.pairReply(false);
  const rej = await pr;
  assert.strictEqual(rej.state, "error");
  assert.match(rej.error, /rejected/);

  ctl = pairCtl("pin");
  m = new BtManager({ spawn: ctl.spawn });
  u = updates(m);
  pr = m.pair(D74);
  assert.ok(await until(() => u.some((x) => x.state === "prompt" && x.prompt.kind === "pin")));
  assert.strictEqual(m.pairReply(""), false, "empty PIN not sent");
  assert.strictEqual(m.pairReply("0000"), true);
  assert.strictEqual((await pr).state, "done");
  assert.ok(ctl.sessions[0].cmds.includes("0000"));
});

test("pair failures: auth failed, not found, timed out, one at a time, invalid MAC, cancel", async () => {
  let r = await new BtManager({ spawn: pairCtl("fail").spawn }).pair(D74);
  assert.strictEqual(r.state, "error");
  assert.match(r.error, /pairing failed \(wrong PIN/);
  r = await new BtManager({ spawn: pairCtl("notfound").spawn }).pair(D74);
  assert.match(r.error, /not found: scan again with the radio in pairing mode/);
  const slow = new BtManager({ spawn: pairCtl("silent").spawn, pairTimeoutMs: 50 });
  const pr = slow.pair(D74);
  const busy = await slow.pair(UVPRO);
  assert.match(busy.error, /another pairing/);
  r = await pr;
  assert.match(r.error, /timed out/);
  r = await new BtManager({ spawn: pairCtl("silent").spawn }).pair("nope");
  assert.match(r.error, /invalid Bluetooth address/);
  const ctl = pairCtl("silent");
  const m = new BtManager({ spawn: ctl.spawn });
  const pc = m.pair(D74);
  await wait(10);
  assert.strictEqual(m.cancelPair(), true);
  assert.match((await pc).error, /cancelled/);
  assert.ok(ctl.sessions[0].cmds.includes("cancel-pairing " + D74));
  assert.strictEqual(pairError("org.bluez.Error.AuthenticationTimeout", D74).includes("timed out"), true);
});

test("unpair", async () => {
  let m = new BtManager({ exec: fakeExec({ ["remove " + D74]: "[DEL] Device " + D74 + " TH-D74\nDevice has been removed\n" }) });
  assert.deepStrictEqual(await m.unpair(D74), { op: "unpair", ok: true, mac: D74 });
  m = new BtManager({ exec: fakeExec({ ["remove " + D74]: "Device " + D74 + " not available\n" }) });
  assert.strictEqual((await m.unpair(D74)).note, "was not paired");
  assert.strictEqual((await m.unpair("x")).ok, false);
});

/* ---------- Power on: rfkill (sysfs), Busy retry, hard block, config.txt ---------- */
const os = require("os");
const fs = require("fs");
const path = require("path");
/** Fake /sys/class/rfkill with one hci0 entry, plus a config.txt. */
function fakeSys(o) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pst-rfkill-"));
  const rk = path.join(dir, "rfkill");
  fs.mkdirSync(path.join(rk, "rfkill1"), { recursive: true });
  fs.mkdirSync(path.join(rk, "rfkill0"), { recursive: true });
  fs.writeFileSync(path.join(rk, "rfkill0", "type"), "wlan\n");
  fs.writeFileSync(path.join(rk, "rfkill0", "soft"), "1\n");
  fs.writeFileSync(path.join(rk, "rfkill1", "type"), "bluetooth\n");
  fs.writeFileSync(path.join(rk, "rfkill1", "name"), "hci0\n");
  fs.writeFileSync(path.join(rk, "rfkill1", "soft"), (o.soft ? "1" : "0") + "\n");
  fs.writeFileSync(path.join(rk, "rfkill1", "hard"), (o.hard ? "1" : "0") + "\n");
  const cfg = path.join(dir, "config.txt");
  fs.writeFileSync(cfg, o.config || "[all]\ndtparam=audio=on\n#dtoverlay=disable-bt\n");
  return { rfkillDir: rk, configFiles: [cfg], unblock: () => fs.writeFileSync(path.join(rk, "rfkill1", "soft"), "0\n") };
}
const slept = [];
const noSleep = (ms) => (slept.push(ms), Promise.resolve());
const quiet = { log: () => {}, warn: () => {} };

test("power on, soft-blocked and this user may not unblock: org.bluez.Error.Failed becomes the soft-block message + copyable sudo command", async () => {
  const sys = fakeSys({ soft: true });
  const calls = [];
  const logs = [];
  const m = new BtManager({
    ...sys,
    sleep: noSleep,
    log: (l) => logs.push(l),
    exec: fakeExec({ "power on": "Failed to set power on: org.bluez.Error.Failed\n", "rfkill unblock bluetooth": "" /* exit 0 but nothing changes: the Pi case */ }, calls),
  });
  const r = await m.powerOn();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, "Bluetooth is soft-blocked by the system. Run: sudo rfkill unblock bluetooth");
  assert.strictEqual(r.copy, "sudo rfkill unblock bluetooth");
  assert.strictEqual(r.retry, true);
  assert.deepStrictEqual(calls, ["rfkill unblock bluetooth"], "no blind power on while blocked");
  assert.match(r.rfkill, /hci0 soft blocked, hard no/);
  assert.match(logs[0], /^Bluetooth: power on failed: Bluetooth is soft-blocked.*\[rfkill hci0 soft blocked, hard no\]$/);
  // not soft-blocked per sysfs, but BlueZ still says Failed while something blocks: same mapping
  const sys2 = fakeSys({ soft: false });
  let flip = 0;
  const m2 = new BtManager({ ...sys2, sleep: noSleep, log: false, exec: fakeExec({ "power on": () => (flip++ === 0 ? (fs.writeFileSync(path.join(sys2.rfkillDir, "rfkill1", "soft"), "1"), "Failed to set power on: org.bluez.Error.Failed\n") : "") }) });
  assert.strictEqual((await m2.powerOn()).error, "Bluetooth is soft-blocked by the system. Run: sudo rfkill unblock bluetooth");
});

test("power on: our unblock works, then Busy while the adapter initializes -> retried with backoff -> on", async () => {
  const sys = fakeSys({ soft: true });
  slept.length = 0;
  let n = 0;
  const calls = [];
  const m = new BtManager({
    ...sys,
    sleep: noSleep,
    log: false,
    exec: fakeExec({ "rfkill unblock bluetooth": () => (sys.unblock(), ""), "power on": () => (++n < 3 ? "Failed to set power on: org.bluez.Error.Busy\n" : "Changing power on succeeded\n") }, calls),
  });
  const r = await m.powerOn();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.unblocked, true);
  assert.strictEqual(r.attempts, 3);
  assert.deepStrictEqual(slept, [500, 1000]);
  assert.deepStrictEqual(calls, ["rfkill unblock bluetooth", "power on", "power on", "power on"]);
  // user ran sudo rfkill unblock themselves, then Retry: NotReady once, then on
  slept.length = 0;
  let k = 0;
  const m2 = new BtManager({ ...fakeSys({ soft: false }), sleep: noSleep, log: false, exec: fakeExec({ "power on": () => (k++ ? "Changing power on succeeded\n" : "Failed to set power on: org.bluez.Error.NotReady\n") }) });
  assert.strictEqual((await m2.powerOn()).ok, true);
  assert.deepStrictEqual(slept, [500]);
});

test("power on: Busy for ~10 s -> gives up and suggests restarting the bluetooth service", async () => {
  slept.length = 0;
  const m = new BtManager({ ...fakeSys({ soft: false }), sleep: noSleep, log: false, exec: fakeExec({ "power on": "Failed to set power on: org.bluez.Error.Busy\n" }) });
  const r = await m.powerOn();
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(slept, [500, 1000, 2000, 4000, 2500]);
  assert.strictEqual(slept.reduce((a, b) => a + b, 0), 10000);
  assert.match(r.error, /still busy after unblocking \(6 tries\)\. Run: sudo systemctl restart bluetooth, then Retry/);
  assert.strictEqual(r.copy, "sudo systemctl restart bluetooth");
});

test("power on / scan: hard block is a hardware / firmware switch; nothing is run", async () => {
  const calls = [];
  const sys = fakeSys({ hard: true });
  const m = new BtManager({ ...sys, sleep: noSleep, log: false, exec: fakeExec({ show: "Controller X\n\tPowered: no\n\tPowerState: off-blocked\n" }, calls) });
  const r = await m.powerOn();
  assert.strictEqual(r.hard, true);
  assert.match(r.error, /hard-blocked: a hardware \/ firmware switch/);
  assert.deepStrictEqual(calls, []);
  const sc = await m.startScan({ id: "x" });
  assert.match(sc.error, /hard-blocked/);
  assert.strictEqual(sc.canPowerOn, false);
});

test("dtoverlay=disable-bt in config.txt is reported (scan and power on); commented lines ignored", async () => {
  const { configTxtBt } = require("../lib/kiss/bt-manager");
  const sys = fakeSys({ config: "# dtoverlay=disable-bt\n[all]\ndtoverlay=disable-bt\n" });
  assert.deepStrictEqual(configTxtBt(sys), { file: sys.configFiles[0], line: "dtoverlay=disable-bt" });
  assert.strictEqual(configTxtBt(fakeSys({})), null);
  assert.strictEqual(configTxtBt(fakeSys({ config: "dtoverlay=pi3-disable-bt\n" })).line, "dtoverlay=pi3-disable-bt");
  assert.strictEqual(configTxtBt({ configFiles: ["/nonexistent/config.txt"] }), null);
  // overlay -> no hci0 at all
  const none = { configFiles: sys.configFiles, rfkillDir: path.join(os.tmpdir(), "pst-no-rfkill-" + process.pid) };
  const m = new BtManager({ ...none, sleep: noSleep, log: false, exec: fakeExec({ show: "No default controller available\n", "power on": "No default controller available\n" }) });
  const sc = await m.startScan({ id: "x" });
  assert.match(sc.error, /^Bluetooth disabled in config\.txt \(dtoverlay=disable-bt in .*config\.txt\): remove or comment out that line and reboot$/);
  assert.match((await m.powerOn()).error, /^Bluetooth disabled in config\.txt/);
});
