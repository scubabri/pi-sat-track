// rigctl single-VFO + TX_SPLIT: S 1 VFOB and I <hz> each Doppler tick.
// Run: node --test --test-force-exit test/rigctl-tx-split.test.js
const test = require("node:test");
const assert = require("assert");
const net = require("net");
const path = require("path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function loadRigctl(port, txSplit) {
  // Fresh module + mocked config/catalog each load
  const cfgPath = require.resolve(path.join(__dirname, "../lib/config"));
  const catPath = require.resolve(path.join(__dirname, "../lib/catalog"));
  const rigPath = require.resolve(path.join(__dirname, "../lib/radios/rigctl"));
  delete require.cache[cfgPath];
  delete require.cache[catPath];
  delete require.cache[rigPath];

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

test("TX_SPLIT single-VFO: S 1 VFOB then I each tick", async () => {
  const fake = await startFakeRigctld();
  const logs = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a) => logs.push(a.join(" "));
  console.warn = (...a) => logs.push("WARN " + a.join(" "));
  let rig;
  try {
    rig = loadRigctl(fake.port, true);
    rig.init({
      getContext: () => ({
        currentSatKey: "RS-44",
        currentModeIndex: 0,
        ulFixed: false,
      }),
    });
    rig.setLock(true); // skip dial absorb
    rig.setRadio(true);
    await sleep(150);

    let ul = 145965000;
    let dl = 435640000;
    // Open / sync
    for (let i = 0; i < 6; i++) {
      await rig.pushFrequencies(ul, dl);
      await sleep(40);
    }

    assert.ok(
      fake.state.cmds.some((c) => c === "S 1 VFOB"),
      "S 1 VFOB sent: " + fake.state.cmds.join("|"),
    );
    assert.ok(fake.state.splitOn, "split enabled on fake");
    assert.ok(
      fake.state.cmds.some((c) => /^I\s+/.test(c)),
      "I sent on sync",
    );
    assert.ok(
      fake.state.cmds.some((c) => c === "X LSB 0"),
      "X LSB for inverting linear: " + fake.state.cmds.filter((c) => c[0] === "X").join(","),
    );
    assert.ok(
      !fake.state.cmds.some((c) => /^V\s+/.test(c)),
      "must not switch VFO with V",
    );
    assert.ok(
      logs.some((l) => /split ON/.test(l)),
      "logged split enable once",
    );
    assert.ok(
      logs.some((l) => /ul\(split\)\s+freq/.test(l)),
      "logged ul(split) freq",
    );

    // Steady Doppler ticks — I should track changing UL
    const before = fake.state.cmds.filter((c) => /^I\s+/.test(c)).length;
    for (let i = 0; i < 5; i++) {
      ul += 200;
      dl -= 80;
      await rig.pushFrequencies(ul, dl);
      await sleep(50);
    }
    const afterI = fake.state.cmds.filter((c) => /^I\s+/.test(c));
    assert.ok(
      afterI.length >= before + 4,
      "I each tick: " + afterI.length + " (before " + before + ")",
    );
    assert.strictEqual(fake.state.txHz, ul, "TX freq = latest UL");
    assert.strictEqual(fake.state.rxHz, dl, "RX freq = latest DL");

    // Disable: S 0 VFOA
    rig.setRadio(false);
    await sleep(200);
    assert.ok(
      fake.state.cmds.some((c) => c === "S 0 VFOA"),
      "S 0 VFOA on disable: " + fake.state.cmds.slice(-8).join("|"),
    );
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    if (rig) try { rig.setRadio(false); } catch (_) {}
    await new Promise((r) => fake.server.close(r));
  }
});

test("TX_SPLIT off: no S / I (legacy DL-only)", async () => {
  const fake = await startFakeRigctld();
  console.log = () => {};
  console.warn = () => {};
  let rig;
  try {
    rig = loadRigctl(fake.port, false);
    rig.init({
      getContext: () => ({
        currentSatKey: "RS-44",
        currentModeIndex: 0,
      }),
    });
    rig.setLock(true);
    rig.setRadio(true);
    await sleep(150);
    for (let i = 0; i < 4; i++) {
      await rig.pushFrequencies(145965000 + i * 100, 435640000 - i * 50);
      await sleep(40);
    }
    assert.ok(!fake.state.cmds.some((c) => /^S\s+/.test(c)), "no S");
    assert.ok(!fake.state.cmds.some((c) => /^I\s+/.test(c)), "no I");
    assert.ok(fake.state.cmds.some((c) => /^F\s+/.test(c)), "still sets F");
  } finally {
    if (rig) try { rig.setRadio(false); } catch (_) {}
    await new Promise((r) => fake.server.close(r));
  }
});

test("UL fixed: I written once when UL unchanged", async () => {
  const fake = await startFakeRigctld();
  console.log = () => {};
  console.warn = () => {};
  let rig;
  try {
    rig = loadRigctl(fake.port, true);
    rig.init({
      getContext: () => ({
        currentSatKey: "AO-91",
        currentModeIndex: 0,
        ulFixed: true,
      }),
    });
    rig.setLock(true);
    rig.setRadio(true);
    await sleep(150);
    const ulFixed = 435250000;
    let dl = 145960000;
    for (let i = 0; i < 4; i++) {
      await rig.pushFrequencies(ulFixed, dl);
      await sleep(40);
    }
    const afterSync = fake.state.cmds.filter((c) => /^I\s+/.test(c)).length;
    assert.ok(afterSync >= 1, "I on sync");
    fake.state.cmds.length = 0;
    for (let i = 0; i < 5; i++) {
      dl -= 300;
      await rig.pushFrequencies(ulFixed, dl);
      await sleep(50);
    }
    const iSteady = fake.state.cmds.filter((c) => /^I\s+/.test(c));
    assert.strictEqual(
      iSteady.length,
      0,
      "no further I when UL fixed/unchanged: " + iSteady.join(","),
    );
    assert.ok(
      fake.state.cmds.filter((c) => /^F\s+/.test(c)).length >= 1,
      "DL still Doppler'd",
    );
    assert.strictEqual(fake.state.txHz, ulFixed);
  } finally {
    if (rig) try { rig.setRadio(false); } catch (_) {}
    await new Promise((r) => fake.server.close(r));
  }
});

test("S failure: fall back to DL-only, no spam", async () => {
  const fake = await startFakeRigctld({ failSplit: true });
  const warns = [];
  console.log = () => {};
  console.warn = (...a) => warns.push(a.join(" "));
  let rig;
  try {
    rig = loadRigctl(fake.port, true);
    rig.init({
      getContext: () => ({
        currentSatKey: "RS-44",
        currentModeIndex: 0,
      }),
    });
    rig.setLock(true);
    rig.setRadio(true);
    await sleep(150);
    for (let i = 0; i < 5; i++) {
      await rig.pushFrequencies(145965000 + i * 50, 435640000);
      await sleep(40);
    }
    const sFails = fake.state.cmds.filter((c) => c === "S 1 VFOB");
    assert.ok(sFails.length >= 1, "tried S once");
    assert.ok(sFails.length <= 2, "did not spam S: " + sFails.length);
    assert.ok(!fake.state.cmds.some((c) => /^I\s+/.test(c)), "no I after S fail");
    assert.ok(
      warns.filter((w) => /set_split_vfo failed/.test(w)).length === 1,
      "logged failure once",
    );
    assert.ok(fake.state.cmds.some((c) => /^F\s+/.test(c)), "DL still works");
  } finally {
    if (rig) try { rig.setRadio(false); } catch (_) {}
    await new Promise((r) => fake.server.close(r));
  }
});

test("dial absorb: stale RPRT 0 from F/I skipped, absorb fires, UL follows", async () => {
  const fake = await startFakeRigctld({ delayAcks: 5 });
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  let rig;
  try {
    rig = loadRigctl(fake.port, true);
    rig.init({
      getContext: () => ({ currentSatKey: "RS-44", currentModeIndex: 0, ulFixed: false }),
    });
    rig.setLock(false);
    rig.setRadio(true);
    await sleep(150);
    let ul = 145965000;
    let dl = 435640000;
    // Steady Doppler ticks with no dial movement: absorb must NOT fire.
    for (let i = 0; i < 8; i++) {
      ul += 150; dl -= 60;
      await rig.pushFrequencies(ul, dl);
      await sleep(50);
    }
    assert.ok(!logs.some((l) => /dial absorb/.test(l)), "no misfire: " + logs.join("\n"));
    assert.strictEqual(rig.getRadioState().manualDlOffset, 0);

    // User turns VFO A dial +3000 Hz.
    fake.state.rxHz += 3000;
    ul += 150; dl -= 60;
    await rig.pushFrequencies(ul, dl);
    await sleep(50);
    const line = logs.find((l) => /rigctl dial absorb DL/.test(l));
    assert.ok(line, "absorb logged: " + logs.slice(-10).join("\n"));
    assert.match(line, /absorb DL 3000 Hz → manualDl 3060/);
    assert.strictEqual(rig.getRadioState().manualDlOffset, 3060);
    // Radio was not snapped back to the old DL on the absorb tick.
    assert.strictEqual(fake.state.rxHz, dl + 3060);
    // Next tick: state.js applies manualDl to DL and mirrors it (inverted) to UL.
    ul += 150; dl -= 60;
    await rig.pushFrequencies(ul - 3060, dl + 3060);
    await sleep(50);
    assert.strictEqual(fake.state.rxHz, dl + 3060, "DL keeps dialed offset");
    assert.strictEqual(fake.state.txHz, ul - 3060, "UL split follows offset");
    assert.strictEqual(logs.filter((l) => /dial absorb/.test(l)).length, 1, "no re-absorb of own write");
  } finally {
    console.log = origLog;
    if (rig) try { rig.setRadio(false); } catch (_) {}
    await new Promise((r) => fake.server.close(r));
  }
});
