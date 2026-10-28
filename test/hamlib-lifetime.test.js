// rigctld lifetime vs the Radio button (feat/hamlib):
//  - our rigctld starts from the config (server start / config change) with Radio off,
//    survives Radio on/off, and stops when the config no longer has a Hamlib radio;
//  - the Radio button only connects our driver: no commands to rigctld while off.
// Run: node --test --test-force-exit test/hamlib-lifetime.test.js
const test = require("node:test");
const assert = require("assert");
const net = require("net");
const path = require("path");
const fs = require("fs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RIGCTLD = (() => {
  for (const d of (process.env.PATH || "").split(path.delimiter)) {
    const f = path.join(d, process.platform === "win32" ? "rigctld.exe" : "rigctld");
    if (fs.existsSync(f)) return f;
  }
  return null;
})();
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/** Minimal Hamlib-net fake: one line in → one line (or RPRT 0) out. */
function startFakeRigctld(opts) {
  const state = {
    cmds: [],
    splitOn: false,
    rxHz: 0,
    txHz: 0,
    rxMode: null,
    txMode: null,
    failSplit: !!(opts && opts.failSplit),
    failSplitFreq: !!(opts && opts.failSplitFreq),
  };
  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "").trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        state.cmds.push(line);
        let reply = "RPRT 0";
        if (line === "U ?") {
          // No SATMODE — forces single-VFO path
          reply = "LOCK\nNB\nCOMP\nRPRT 0";
        } else if (line === "f") {
          reply = String(state.rxHz || 145900000);
        } else if (/^F\s+(\d+)/.test(line)) {
          state.rxHz = parseInt(RegExp.$1, 10);
          reply = "RPRT 0";
        } else if (/^I\s+(\d+)/.test(line)) {
          if (state.failSplitFreq) reply = "RPRT -1";
          else {
            state.txHz = parseInt(RegExp.$1, 10);
            reply = "RPRT 0";
          }
        } else if (/^S\s+(\d+)\s+(\S+)/.test(line)) {
          if (state.failSplit && RegExp.$1 === "1") reply = "RPRT -11";
          else {
            state.splitOn = RegExp.$1 === "1";
            reply = "RPRT 0";
          }
        } else if (/^M\s+(\S+)/.test(line)) {
          state.rxMode = RegExp.$1;
          reply = "RPRT 0";
        } else if (/^X\s+(\S+)/.test(line)) {
          state.txMode = RegExp.$1;
          reply = "RPRT 0";
        } else if (/^V\s+/.test(line)) {
          reply = "RPRT 0";
        }
        // Multi-line U ? still needs a terminating feel; sendCmd takes first line.
        // For U ? send first token line then RPRT so parser gets something.
        if (line === "U ?") {
          sock.write("LOCK\n");
        } else if (opts && opts.delayAcks && /^[FI]\s/.test(line)) {
          // Late ack: lands in the socket after the next command is sent.
          setTimeout(() => sock.write(reply + "\n"), opts.delayAcks);
        } else {
          sock.write(reply + "\n");
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, state });
    });
  });
}

function loadRigctl(port, txSplit, hamSpy) {
  // Fresh module + mocked config/catalog each load
  const cfgPath = require.resolve(path.join(__dirname, "../lib/config"));
  const catPath = require.resolve(path.join(__dirname, "../lib/catalog"));
  const rigPath = require.resolve(path.join(__dirname, "../lib/radios/rigctl"));
  delete require.cache[cfgPath];
  delete require.cache[catPath];
  delete require.cache[rigPath];
  // lib/hamlib spy: the Radio button must not stop / restart our rigctld
  const hamPath = require.resolve(path.join(__dirname, "../lib/hamlib"));
  delete require.cache[hamPath];
  require.cache[hamPath] = { id: hamPath, filename: hamPath, loaded: true, exports: hamSpy };

  require.cache[cfgPath] = {
    id: cfgPath,
    filename: cfgPath,
    loaded: true,
    exports: {
      RADIO_TRANSPORT: "tcp",
      RADIO_PROTOCOL: "rigctl",
      RIGCTL_HOST: "127.0.0.1",
      RIGCTL_PORT: port,
      RIGCTL_UL_HOST: "",
      RIGCTL_UL_PORT: 0,
      TX_SPLIT: txSplit !== false,
      SERIAL_MODEL: "ic-705",
      serialModel: "ic-705",
      RADIO_MODEL: "",
      CAT_MODEL: "",
      RIGCTL_SAT_DUAL: "",
    },
  };

  // catalog is required by rigctl — provide isFmMode + getCatalog
  const realCat = require(catPath);
  realCat.getCatalog = () => ({
    "RS-44": {
      modes: [{ mode: "SSB", uplink: "145.965", downlink: "435.640" }],
    },
    "AO-91": {
      modes: [{ mode: "FM", uplink: "435.250", downlink: "145.960" }],
    },
  });

  return require(rigPath);
}


test("rigctld starts from the config with Radio off, survives re-applies, stops on non-Hamlib config", { skip: !RIGCTLD && "Hamlib not installed", timeout: 30000 }, async () => {
  const config = require("../lib/config");
  const hamlib = require("../lib/hamlib");
  const port = await freePort();
  hamlib.configure({ auto: true, log: () => {}, warn: () => {} });
  try {
    const side = { transport: "hamlib", hamlibModel: 1, serialDevice: "/dev/null-test", serialBaud: 19200 };
    config.applyEndpoints({ singleRadio: true, radioUl: side, radioDl: side, hamlibNet: { share: false, portUl: port, portDl: port + 1 } });
    await hamlib.ensure(); // wait for the autoSync started by applyEndpoints
    const d = Array.from(hamlib._daemons.values());
    assert.strictEqual(d.length, 1, "rigctld started without Radio on");
    assert.strictEqual(d[0].sv.state, "running");
    const pid = d[0].sv.pid;
    // same config again (what Radio on/off and per-sat role applies do): no restart
    config.applyEndpoints({ singleRadio: true, radioUl: side, radioDl: side });
    await hamlib.ensure();
    assert.strictEqual(Array.from(hamlib._daemons.values())[0].sv.pid, pid, "same rigctld process");
    // config to a native serial radio: rigctld stops
    config.applyEndpoints({ singleRadio: true, radioUl: { transport: "serial", serialMake: "icom", serialModel: "ic-705", serialDevice: "/dev/null-test" } });
    await hamlib.ensure();
    assert.strictEqual(hamlib._daemons.size, 0, "stopped when no Hamlib radio is configured");
  } finally {
    hamlib.configure({ auto: false });
    await hamlib.stopAll();
    config.applyEndpoints({ hamlibNet: { share: false, portUl: 4534, portDl: 4535 } });
  }
});

test("Radio button: Doppler / set commands only while on; off neither stops nor restarts rigctld", async () => {
  const fake = await startFakeRigctld();
  const hamSpy = { ensureCalls: 0, stopCalls: 0, anyWanted: () => true, capsHint: () => null };
  hamSpy.ensure = async () => { hamSpy.ensureCalls++; };
  hamSpy.stopAll = async () => { hamSpy.stopCalls++; };
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  let rig;
  try {
    rig = loadRigctl(fake.port, true, hamSpy);
    rig.init({ getContext: () => ({ currentSatKey: "RS-44", currentModeIndex: 0, ulFixed: false }) });
    rig.setLock(true);
    // Radio off: Doppler ticks send nothing (no connection at all)
    for (let i = 0; i < 3; i++) await rig.pushFrequencies(145965000 + i * 100, 435640000 - i * 50);
    await sleep(100);
    assert.strictEqual(fake.state.cmds.length, 0, "no commands while Radio is off: " + fake.state.cmds.join("|"));
    // Radio on: set-up + Doppler sets
    rig.setRadio(true);
    await sleep(150);
    for (let i = 0; i < 4; i++) {
      await rig.pushFrequencies(145965000 + i * 100, 435640000 - i * 50);
      await sleep(40);
    }
    assert.ok(fake.state.cmds.some((c) => /^F\s+\d+/.test(c)), "F sent while on");
    // Radio off: our link closes, rigctld is left alone
    rig.setRadio(false);
    await sleep(250);
    assert.strictEqual(hamSpy.stopCalls, 0, "Radio off does not stop rigctld");
    const n = fake.state.cmds.length;
    for (let i = 0; i < 3; i++) await rig.pushFrequencies(145966000, 435630000);
    await sleep(100);
    assert.strictEqual(fake.state.cmds.length, n, "no commands after Radio off: " + fake.state.cmds.slice(n).join("|"));
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    fake.server.close();
    for (const k of ["../lib/config", "../lib/catalog", "../lib/radios/rigctl", "../lib/hamlib"]) delete require.cache[require.resolve(path.join(__dirname, k))];
  }
});
