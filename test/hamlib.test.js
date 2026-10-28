// Hamlib support: `rigctl -l` parsing, manufacturer grouping, native-vs-Hamlib
// choice, caps defaults, rigctld argv, the rigctld supervisor (fake process),
// config mapping of a "Hamlib serial" side, the Windows update flow (fake
// downloads), and an integration run against the real dummy rig (rigctld -m 1)
// when Hamlib is installed.
// Run: node --test --test-force-exit test/hamlib.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const EventEmitter = require("events");
const cp = require("child_process");

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pst-hamlib-"));
process.env.USERPROFILE = process.env.HOME;

const models = require("../lib/hamlib/models");
const { Supervisor } = require("../lib/hamlib/supervisor");
const tools = require("../lib/hamlib/tools");
const update = require("../lib/hamlib/update");

const FIX = path.join(__dirname, "fixtures");
const LIST = fs.readFileSync(path.join(FIX, "rigctl-l.txt"), "utf8");

test("rigctl -l: fixed-width columns, multi-word mfg / model, empty model, status", () => {
  const l = models.parseList(LIST);
  assert.strictEqual(l.length, 14);
  assert.deepStrictEqual(l[0], { id: 1, mfg: "Hamlib", model: "Dummy", version: "20240709.0", status: "Stable", macro: "RIG_MODEL_DUMMY" });
  const by = (id) => l.find((x) => x.id === id);
  assert.strictEqual(by(2).model, "NET rigctl");
  assert.strictEqual(by(4).mfg, "FLRig");
  assert.strictEqual(by(4).model, "FLRig", "no model text -> mfg name");
  assert.strictEqual(by(3073).model, "IC-7300");
  assert.strictEqual(by(23005).model, "SmartSDR Slice A");
  assert.strictEqual(by(29001).mfg, "ADAT www.adat.ch");
  assert.strictEqual(by(29001).model, "ADT-200A");
  assert.ok(l.every((x) => /^(Stable|Beta|Alpha|Untested|New|Buggy)$/.test(x.status)));
  assert.deepStrictEqual(models.parseList("garbage\nno header"), []);
  // rotctl -l has the same layout ("Rot #")
  const rot = models.parseList(" Rot #  Mfg                    Model                   Version         Status        Macro\n   601  Yaesu                  GS-232A                 20220109.0      Beta          ROT_MODEL_GS232A\n");
  assert.deepStrictEqual(rot.map((r) => [r.id, r.mfg, r.model, r.status]), [[601, "Yaesu", "GS-232A", "Beta"]]);
});

test("manufacturer grouping: alphabetical, Hamlib virtual rigs last, models natural-sorted", () => {
  const g = models.groupByMfg(models.parseList(LIST));
  const names = g.map((x) => x.mfg);
  assert.strictEqual(names[names.length - 1], "Hamlib");
  assert.deepStrictEqual(names.slice(0, -1), names.slice(0, -1).slice().sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })));
  const icom = g.find((x) => x.mfg === "Icom").models.map((m) => m.model);
  assert.deepStrictEqual(icom, ["IC-705", "IC-7300", "IC-9700"]);
});

test("native hint vs Hamlib: a Hamlib-serial side always uses Hamlib", () => {
  const l = models.parseList(LIST);
  const by = (id) => l.find((x) => x.id === id);
  assert.deepStrictEqual(models.nativeFor(by(3081)), { transport: "serial", serialMake: "icom", serialModel: "ic-9700", label: "IC-9700 (built-in CI-V driver)" });
  assert.strictEqual(models.nativeFor(by(3085)).serialModel, "ic-705");
  assert.strictEqual(models.nativeFor(by(1041)).serialModel, "ft-817");
  assert.strictEqual(models.nativeFor(by(2014)).serialMake, "kenwood");
  assert.strictEqual(models.nativeFor(by(2036)).type, "smartsdr");
  assert.strictEqual(models.nativeFor(by(23005)).transport, "tcp", "Flex SmartSDR slices -> native SmartSDR CAT");
  assert.strictEqual(models.nativeFor(by(3073)), null);
  assert.strictEqual(models.chooseDriver(by(3081)), "hamlib", "IC-9700 picked under Hamlib serial stays Hamlib");
  assert.strictEqual(models.chooseDriver(by(3085)), "hamlib", "IC-705 too");
  assert.strictEqual(models.chooseDriver(by(3081), { preferHamlib: true }), "hamlib");
  assert.strictEqual(models.chooseDriver(by(3073)), "hamlib");
  assert.strictEqual(models.chooseDriver(1035), "hamlib", "plain model number works too");
});

test("caps: serial defaults, handshake, split, CI-V address", () => {
  const c = models.parseCaps(fs.readFileSync(path.join(FIX, "rigctl-dump-caps-1035.txt"), "utf8"), fs.readFileSync(path.join(FIX, "rigctl-L-3073.txt"), "utf8"));
  assert.strictEqual(c.model, "FT-991");
  assert.strictEqual(c.baudMin, 4800);
  assert.strictEqual(c.baudMax, 38400);
  assert.strictEqual(c.defaultBaud, 19200);
  assert.strictEqual(c.dataBits, 8);
  assert.strictEqual(c.stopBits, 2);
  assert.strictEqual(c.parity, "None");
  assert.strictEqual(c.handshake, "Hardware", "ctrl=CTS/RTS");
  assert.strictEqual(c.canSplit, true);
  assert.strictEqual(c.hasSatmode, false);
  assert.strictEqual(c.civAddr, 148);
  const sat = models.parseCaps("Serial speed: 4800..9600 baud, 8N1, ctrl=NONE\nSet functions: TONE SATMODE LOCK\nCan set Split VFO:\tN\n");
  assert.strictEqual(sat.hasSatmode, true);
  assert.strictEqual(sat.canSplit, false);
  assert.strictEqual(sat.defaultBaud, 9600);
  assert.strictEqual(sat.handshake, "None");
});

test("rigctld args: model, port, baud, CI-V, serial conf; blanks omitted; loopback only", () => {
  const a = models.buildRigctldArgs(models.sideToRigctld({ hamlibModel: 3073, serialDevice: "COM7", serialBaud: 19200, hamlibCivAddr: "94", hamlibDataBits: 8, hamlibStopBits: 1, hamlibHandshake: "None", hamlibDtr: "OFF", hamlibRts: "Unset" }, 4534));
  assert.deepStrictEqual(a, ["-m", "3073", "-r", "COM7", "-s", "19200", "-c", "0x94", "-C", "data_bits=8,stop_bits=1,serial_handshake=None,dtr_state=OFF", "-T", "127.0.0.1", "-t", "4534"]);
  assert.deepStrictEqual(models.buildRigctldArgs({ model: 1, port: 4600 }), ["-m", "1", "-T", "127.0.0.1", "-t", "4600"]);
  assert.throws(() => models.buildRigctldArgs({ port: 4534 }), /model/);
  assert.throws(() => models.buildRigctldArgs({ model: 1 }), /port/);
  assert.strictEqual(models.parseCiv("0xA2"), 0xa2);
  assert.strictEqual(models.parseCiv("A2h"), 0xa2);
  assert.strictEqual(models.parseCiv(148), 148);
  assert.strictEqual(models.parseCiv(""), null);
  assert.strictEqual(models.parseCiv("zz"), null);
  // junk handshake / line state values are not passed through
  assert.deepStrictEqual(models.buildRigctldArgs({ model: 1, port: 1, handshake: "rm -rf", dtr: "maybe" }), ["-m", "1", "-T", "127.0.0.1", "-t", "1"]);
});

/** Fake child process + fake clock for the supervisor. */
function fakeWorld() {
  const w = { now: 0, timers: [], spawned: [], listening: false };
  w.setTimeout = (fn, ms) => {
    const t = { fn, at: w.now + ms };
    w.timers.push(t);
    return t;
  };
  w.clearTimeout = (t) => (w.timers = w.timers.filter((x) => x !== t));
  w.advance = async (ms) => {
    const end = w.now + ms;
    await new Promise((r) => setImmediate(r)); // let pending awaits create their timers
    for (;;) {
      w.timers.sort((a, b) => a.at - b.at);
      const t = w.timers[0];
      if (!t || t.at > end) break;
      w.timers.shift();
      w.now = t.at;
      t.fn();
      await new Promise((r) => setImmediate(r));
    }
    w.now = end;
    await new Promise((r) => setImmediate(r));
  };
  w.spawn = (bin, args) => {
    const c = new EventEmitter();
    c.pid = 1000 + w.spawned.length;
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.killed = [];
    c.kill = (sig) => {
      c.killed.push(sig || "SIGTERM");
      setImmediate(() => c.emit("exit", null, sig || "SIGTERM"));
    };
    c.crash = (code) => c.emit("exit", code == null ? 1 : code, null);
    w.spawned.push({ bin, args, c });
    return c;
  };
  w.probe = async () => w.listening;
  return w;
}
function sv(w, extra) {
  const logs = [];
  const s = new Supervisor(Object.assign({ name: "rigctld", bin: "/x/rigctld", args: ["-m", "1"], port: 4534, spawn: w.spawn, probe: w.probe, setTimeout: w.setTimeout, clearTimeout: w.clearTimeout, now: () => w.now, log: (m) => logs.push(m), warn: (m) => logs.push("W " + m) }, extra));
  s.logs = logs;
  return s;
}

test("supervisor: starts, ready when the port answers, stderr lines go to the log", async () => {
  const w = fakeWorld();
  w.listening = true;
  const s = sv(w);
  assert.strictEqual(await s.start(), true);
  assert.strictEqual(s.state, "running");
  assert.strictEqual(w.spawned.length, 1);
  assert.deepStrictEqual(w.spawned[0].args, ["-m", "1"]);
  w.spawned[0].c.stderr.emit("data", "rig_open: error = IO error\npartial");
  assert.ok(s.logs.some((l) => l === "W rigctld[4534]: rig_open: error = IO error"));
  assert.ok(!s.logs.some((l) => /partial/.test(l)), "incomplete line kept until newline");
  // start() again while running: no second process
  await s.start();
  assert.strictEqual(w.spawned.length, 1);
});

test("supervisor: crash -> restart with growing backoff; a long run resets it; stop() = no restart", async () => {
  const w = fakeWorld();
  w.listening = true;
  const s = sv(w);
  await s.start();
  w.spawned[0].c.crash(1);
  assert.strictEqual(s.state, "waiting");
  await w.advance(999);
  assert.strictEqual(w.spawned.length, 1, "not before 1 s");
  await w.advance(1);
  assert.strictEqual(w.spawned.length, 2, "restart after 1 s");
  w.spawned[1].c.crash(1);
  await w.advance(1999);
  assert.strictEqual(w.spawned.length, 2);
  await w.advance(1);
  assert.strictEqual(w.spawned.length, 3, "second restart after 2 s");
  w.spawned[2].c.crash(1);
  await w.advance(5000);
  assert.strictEqual(w.spawned.length, 4, "third after 5 s");
  // runs 60 s, then crashes: backoff back to 1 s
  await w.advance(60000);
  w.spawned[3].c.crash(1);
  await w.advance(1000);
  assert.strictEqual(w.spawned.length, 5);
  assert.strictEqual(s.status().restarts, 4);
  // stop: SIGTERM, no restart
  const p = s.stop();
  await new Promise((r) => setImmediate(r));
  await p;
  assert.deepStrictEqual(w.spawned[4].c.killed, ["SIGTERM"]);
  assert.strictEqual(s.state, "stopped");
  await w.advance(120000);
  assert.strictEqual(w.spawned.length, 5, "no restart after stop");
});

test("supervisor: stop() while waiting cancels the restart; ENOENT reported", async () => {
  const w = fakeWorld();
  w.listening = true;
  const s = sv(w);
  await s.start();
  w.spawned[0].c.crash(2);
  await s.stop();
  await w.advance(60000);
  assert.strictEqual(w.spawned.length, 1);
  const w2 = fakeWorld();
  const s2 = sv(w2, {
    spawn: () => {
      const c = new EventEmitter();
      c.kill = () => {};
      setImmediate(() => c.emit("error", Object.assign(new Error("spawn"), { code: "ENOENT" })));
      return c;
    },
  });
  const ok = await s2.start();
  assert.strictEqual(ok, false);
  assert.match(s2.lastError, /not found/);
  await s2.stop();
});

test("supervisor: never listening -> killed after the ready timeout, then restarted", async () => {
  const w = fakeWorld();
  w.listening = false;
  const s = sv(w, { readyTimeoutMs: 1000 });
  const p = s.start();
  await w.advance(1200);
  assert.strictEqual(await p, false);
  assert.deepStrictEqual(w.spawned[0].c.killed, ["SIGTERM"]);
  await w.advance(1000);
  assert.strictEqual(w.spawned.length, 2, "restarted after backoff");
  await s.stop();
});

test("config: a Hamlib-serial side is rigctl over 127.0.0.1:<hamlibPort> for the drivers", () => {
  const config = require("../lib/config");
  const radios = require("../lib/radios");
  const hamlib = require("../lib/hamlib");
  const side = { transport: "hamlib", hamlibModel: 3073, serialDevice: "/dev/ttyUSB0", serialBaud: 19200 };
  config.applyEndpoints({ singleRadio: true, radioUl: side, radioDl: side });
  assert.strictEqual(config.RADIO_UL.transport, "hamlib", "stored transport stays hamlib (UI)");
  assert.strictEqual(config.RADIO_UL.rigctlEndpoint, "127.0.0.1:4534");
  assert.strictEqual(config.RADIO_TRANSPORT, "tcp");
  assert.strictEqual(config.RIGCTL_HOST, "127.0.0.1");
  assert.strictEqual(config.RIGCTL_PORT, 4534);
  assert.strictEqual(radios.activeDl().meta.id, "rigctl");
  assert.strictEqual(radios.activeUl().meta.id, "rigctl");
  const specs = Array.from(hamlib.wantedSpecs().values());
  assert.strictEqual(specs.length, 1);
  assert.deepStrictEqual(specs[0].args, ["-m", "3073", "-r", "/dev/ttyUSB0", "-s", "19200", "-T", "127.0.0.1", "-t", "4534"]);
  // two radios on two serial ports: two rigctld, UL on 4535
  config.applyEndpoints({ singleRadio: false, radioUl: { transport: "hamlib", hamlibModel: 1035, serialDevice: "/dev/ttyUSB1", serialBaud: 38400 }, radioDl: side });
  const two = Array.from(hamlib.wantedSpecs().values());
  assert.deepStrictEqual(two.map((x) => [x.sides.join(), x.port]), [["dl", 4534], ["ul", 4535]]);
  assert.strictEqual(config.RIGCTL_UL_PORT, 4535);
  // both Hamlib on the SAME port: one rigctld, one link
  config.applyEndpoints({ singleRadio: false, radioUl: Object.assign({}, side, { hamlibPort: 4535 }), radioDl: side });
  assert.strictEqual(hamlib.wantedSpecs().size, 1);
  assert.strictEqual(config.RIGCTL_UL_PORT, 0);
  // native serial side: nothing for Hamlib to start
  config.applyEndpoints({ singleRadio: true, radioUl: { transport: "serial", serialMake: "icom", serialModel: "ic-9700", serialDevice: "/dev/ttyUSB0" } });
  assert.strictEqual(hamlib.wantedSpecs().size, 0);
  assert.strictEqual(hamlib.anyWanted(), false);
});

test("config: a model with a built-in driver stays Hamlib under Hamlib serial; native saves stay native", () => {
  const config = require("../lib/config");
  const radios = require("../lib/radios");
  const hamlib = require("../lib/hamlib");
  // IC-705 (3085) selected under Hamlib serial, incl. an old save carrying hamlibPreferHamlib
  for (const extra of [{}, { hamlibPreferHamlib: false }, { hamlibPreferHamlib: true }]) {
    const side = Object.assign({ transport: "hamlib", hamlibModel: 3085, serialDevice: "/dev/ttyACM0", serialBaud: 19200 }, extra);
    config.applyEndpoints({ singleRadio: true, radioUl: side, radioDl: side });
    assert.strictEqual(config.RADIO_UL.transport, "hamlib");
    assert.strictEqual(radios.activeUl().meta.id, "rigctl", "rigctld, not the native IC-705 driver");
    assert.deepStrictEqual(Array.from(hamlib.wantedSpecs().values())[0].args.slice(0, 2), ["-m", "3085"]);
  }
  // old forced-native save (transport serial, ic-705) loads as the native driver
  config.applyEndpoints({ singleRadio: true, radioUl: { transport: "serial", serialMake: "icom", serialModel: "ic-705", serialDevice: "/dev/ttyACM0" } });
  assert.strictEqual(config.RADIO_UL.transport, "serial");
  assert.strictEqual(hamlib.wantedSpecs().size, 0);
});

test("update helpers: versions, sums file, per-OS plan, source build is labelled manual", () => {
  assert.strictEqual(tools.parseVersion("rigctld Hamlib 4.6.2 2025-02-09T21:03:50Z SHA=870364 64-bit"), "4.6.2");
  assert.ok(tools.cmpVersion("4.7.2", "4.6.2") > 0);
  assert.ok(tools.cmpVersion("4.6.10", "4.6.9") > 0);
  assert.strictEqual(tools.cmpVersion("v4.6", "4.6.0"), 0);
  const h = "a".repeat(64);
  assert.strictEqual(update.sumFor(h + "  hamlib-w64-4.7.2.zip\n" + "b".repeat(64) + "  x.exe", "hamlib-w64-4.7.2.zip"), h);
  assert.strictEqual(update.sumFor("", "x"), null);
  assert.strictEqual(update.planFor("win32").method, "windows-zip");
  assert.strictEqual(update.planFor("darwin").method, "brew");
  assert.strictEqual(update.planFor("linux").method, "apt");
  const sb = update.sourceBuildPlan("4.7.2");
  assert.strictEqual(sb.automated, false);
  assert.ok(sb.commands.some((c) => /hamlib-4\.7\.2\.tar\.gz/.test(c)));
});

test("Windows update: download, SHA-256 check (sums file + digest), extract, current pointer, rollback; mismatch refused", async () => {
  const zipBuf = Buffer.from("fake zip bytes");
  const good = update.sha256(zipBuf);
  const mkRel = (ver, sum) => ({
    tag_name: ver,
    html_url: "https://github.com/Hamlib/Hamlib/releases/tag/" + ver,
    assets: [
      { name: "hamlib-w64-" + ver + ".zip", browser_download_url: "https://dl/" + ver + ".zip", size: zipBuf.length, digest: "sha256:" + good },
      { name: "SHA256SUM-w64-" + ver, browser_download_url: "https://dl/" + ver + ".sums", size: 100 },
    ],
    _sum: sum,
  });
  let rel = mkRel("4.7.1", good);
  const get = async (url) => {
    if (/releases\/latest/.test(url)) return Buffer.from(JSON.stringify(rel));
    if (/\.zip$/.test(url)) return zipBuf;
    if (/\.sums$/.test(url)) return Buffer.from(rel._sum + "  hamlib-w64-" + rel.tag_name + ".zip\n");
    throw new Error("unexpected " + url);
  };
  const extract = async (zip, dest) => {
    const bin = path.join(dest, "hamlib-w64-" + rel.tag_name, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "rigctld.exe"), "");
    return true;
  };
  const calls = [];
  const o = { get, extract, stopDaemons: async () => calls.push("stop"), restartDaemons: async () => calls.push("restart") };
  update._resetCache();
  let r = await update.updateWindows(o);
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.verified, true);
  let cur = tools.readCurrent();
  assert.strictEqual(cur.version, "4.7.1");
  assert.strictEqual(cur.bin, path.join(process.env.HOME, ".rpitrack", "hamlib", "4.7.1", "hamlib-w64-4.7.1", "bin"));
  assert.deepStrictEqual(calls, ["stop", "restart"]);
  assert.strictEqual((await update.updateWindows(o)).unchanged, true, "same version: nothing to do");
  rel = mkRel("4.7.2", good);
  update._resetCache();
  r = await update.updateWindows(o);
  assert.strictEqual(r.ok, true);
  cur = tools.readCurrent();
  assert.strictEqual(cur.version, "4.7.2");
  assert.strictEqual(cur.previous.version, "4.7.1", "previous kept for rollback");
  assert.ok(fs.existsSync(path.join(cur.previous.bin, "rigctld.exe")));
  const rb = await update.rollback(o);
  assert.strictEqual(rb.ok, true);
  assert.strictEqual(tools.readCurrent().version, "4.7.1");
  assert.strictEqual(tools.readCurrent().previous.version, "4.7.2");
  // published checksum does not match the download: refused, pointer unchanged
  rel = mkRel("4.7.3", "c".repeat(64));
  update._resetCache();
  r = await update.updateWindows(o);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /disagree|mismatch/);
  assert.strictEqual(tools.readCurrent().version, "4.7.1");
});

const RIGCTLD = (() => {
  try {
    return tools.find("rigctld");
  } catch (_) {
    return null;
  }
})();

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
function rigctlClient(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => {
      let buf = "";
      const waiters = [];
      sock.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0 && waiters.length) {
          const l = buf.slice(0, i);
          buf = buf.slice(i + 1);
          waiters.shift()(l);
        }
      });
      resolve({
        cmd: (c) =>
          new Promise((r, j) => {
            const t = setTimeout(() => j(new Error("no reply to " + c)), 3000);
            waiters.push((l) => (clearTimeout(t), r(l)));
            sock.write(c + "\n");
          }),
        close: () => sock.destroy(),
      });
    });
    sock.on("error", reject);
  });
}

test("integration: real rigctld -m 1 (dummy) supervised, set / get freq through it, crash -> restart", { skip: !RIGCTLD && "Hamlib not installed", timeout: 30000 }, async () => {
  const port = await freePort();
  const s = new Supervisor({ name: "rigctld", bin: RIGCTLD, args: models.buildRigctldArgs({ model: 1, port }), port, log: () => {}, warn: () => {}, backoff: [200] });
  assert.strictEqual(await s.start(), true);
  let c = await rigctlClient(port);
  assert.strictEqual(await c.cmd("F 145800000"), "RPRT 0");
  assert.strictEqual(await c.cmd("f"), "145800000");
  c.close();
  const pid = s.pid;
  s.child.kill("SIGKILL"); // crash
  for (let i = 0; i < 50 && !(s.state === "running" && s.pid !== pid); i++) await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(s.state, "running");
  assert.notStrictEqual(s.pid, pid);
  c = await rigctlClient(port);
  assert.match(await c.cmd("f"), /^\d+$/);
  c.close();
  await s.stop();
  assert.strictEqual(s.state, "stopped");
});

test("integration: model list + caps from the installed Hamlib", { skip: !RIGCTLD && "Hamlib not installed", timeout: 60000 }, async () => {
  const hamlib = require("../lib/hamlib");
  const r = await hamlib.listModels();
  assert.strictEqual(r.ok, true);
  assert.ok(r.count > 100);
  const icom = r.groups.find((g) => g.mfg === "Icom");
  assert.ok(icom.models.find((m) => m.id === 3081).native, "IC-9700 marked native");
  const caps = await hamlib.caps(3073);
  assert.strictEqual(caps.civAddr, 0x94);
  assert.ok(caps.canSplit);
  const st = await hamlib.status();
  assert.strictEqual(st.installed, true);
  assert.match(st.version, /^\d+\.\d+/);
});
