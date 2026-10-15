// rigctl CTCSS encode for FM uplink (single-VFO split → VFOA+VFOB).
// Run: node --test --test-force-exit test/rigctl-ctcss.test.js
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
    "SO-50": {
      modes: [{ mode: "FM", uplink: "145.850", downlink: "436.795" }],
    },
    "AO-91": {
      modes: [{ mode: "FM", uplink: "435.250", downlink: "145.960" }],
    },
  });

  return require(rigPath);
}


function capture() {
  const logs = [];
  const o = console.log, w = console.warn;
  console.log = (...a) => logs.push(a.join(" "));
  console.warn = (...a) => logs.push("WARN " + a.join(" "));
  return { logs, restore: () => { console.log = o; console.warn = w; } };
}

const toneCmds = (cmds) => cmds.filter((c) => /^(C\s|U TONE|U TSQL|V\s)/.test(c));

test("SO-50 FM split: CTCSS 67.0 on VFOA+VFOB, UI change to 74.4, then linear clears", async () => {
  const fake = await startFakeRigctld();
  const cap = capture();
  let rig;
  let satKey = "SO-50";
  try {
    rig = loadRigctl(fake.port, true);
    rig.init({ getContext: () => ({ currentSatKey: satKey, currentModeIndex: 0 }) });
    rig.applyDefaultCtcss(67.0, 74.4);
    rig.setLock(true);
    rig.setRadio(true);
    await sleep(150);
    for (let i = 0; i < 4; i++) { await rig.pushFrequencies(145850000, 436795000); await sleep(40); }
    assert.deepStrictEqual(toneCmds(fake.state.cmds), [
      "C 670", "U TONE 1", "U TSQL 0", "V VFOB", "C 670", "U TONE 1", "U TSQL 0", "V VFOA",
    ], fake.state.cmds.join("|"));
    // Tone after split + X/I
    const iS = fake.state.cmds.indexOf("S 1 VFOB"), iC = fake.state.cmds.indexOf("C 670");
    assert.ok(iS >= 0 && iC > iS, "tone after split ON");
    assert.ok(cap.logs.some((l) => /rigctl dl tone → 67\.0 Hz ON/.test(l)), cap.logs.join("\n"));

    // UI: activation tone
    fake.state.cmds.length = 0;
    rig.setCtcss("activation");
    for (let i = 0; i < 3; i++) { await rig.pushFrequencies(145850000, 436795000); await sleep(40); }
    assert.deepStrictEqual(toneCmds(fake.state.cmds).filter((c) => c[0] === "C"), ["C 744", "C 744"]);
    // UI: off
    fake.state.cmds.length = 0;
    rig.setCtcss("off");
    for (let i = 0; i < 2; i++) { await rig.pushFrequencies(145850000, 436795000); await sleep(40); }
    assert.deepStrictEqual(toneCmds(fake.state.cmds), ["U TONE 0"]);

    // Sat change to linear: clear, no V
    fake.state.cmds.length = 0;
    satKey = "RS-44";
    rig.applyDefaultCtcss(null, null);
    for (let i = 0; i < 3; i++) { await rig.pushFrequencies(145965000, 435640000); await sleep(40); }
    assert.deepStrictEqual(toneCmds(fake.state.cmds), ["U TONE 0"]);
    assert.ok(cap.logs.some((l) => /tone → OFF/.test(l)));
  } finally {
    cap.restore();
    if (rig) try { rig.setRadio(false); } catch (_) {}
    await new Promise((r) => fake.server.close(r));
  }
});

test("FM with TX_SPLIT off: tone on current VFO only, sent once", async () => {
  const fake = await startFakeRigctld();
  const cap = capture();
  let rig;
  try {
    rig = loadRigctl(fake.port, false);
    rig.init({ getContext: () => ({ currentSatKey: "SO-50", currentModeIndex: 0 }) });
    rig.applyDefaultCtcss(67.0, 74.4);
    rig.setLock(true);
    rig.setRadio(true);
    await sleep(150);
    for (let i = 0; i < 4; i++) { await rig.pushFrequencies(145850000, 436795000); await sleep(40); }
    assert.deepStrictEqual(toneCmds(fake.state.cmds), ["C 670", "U TONE 1", "U TSQL 0"]);
  } finally {
    cap.restore();
    if (rig) try { rig.setRadio(false); } catch (_) {}
    await new Promise((r) => fake.server.close(r));
  }
});
