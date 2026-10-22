// rigctl Data mode: PKTUSB / PKTLSB / PKTFM on both sides (M = RX/DL or the
// one VFO, X = split TX/UL, separate UL rigctld, dual-SAT Main/Sub), toggle
// mid-pass, no per-tick resend, RPRT fallback to the plain mode, CW, and the
// TS-2000-over-rigctl no-op. Mock rigctld only (127.0.0.1, ephemeral ports).
// Run: node --test --test-force-exit test/rigctl-data-mode.test.js
const test = require("node:test");
const assert = require("assert");
const net = require("net");
const path = require("path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Hamlib-net fake. opts.reject: Set of modes answered "RPRT -1" (M and X).
 * opts.sat: answer "U ?" with SATMODE (dual-VFO capable). opts.noW: RPRT -11 to `w`.
 */
function startFakeRigctld(opts) {
  opts = opts || {};
  const state = { cmds: [], conns: 0, rxHz: 0, txHz: 0, rxMode: null, txMode: null };
  const socks = [];
  const server = net.createServer((sock) => {
    state.conns += 1;
    socks.push(sock);
    sock.on("error", () => {});
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
        if (line === "U ?") reply = opts.sat ? "SATMODE" : "LOCK";
        else if (line === "f") reply = String(state.rxHz || 145900000);
        else if (/^F\s+(\d+)/.test(line)) state.rxHz = parseInt(RegExp.$1, 10);
        else if (/^I\s+(\d+)/.test(line)) state.txHz = parseInt(RegExp.$1, 10);
        else if (/^([MX])\s+(\S+)/.test(line)) {
          const which = RegExp.$1;
          const mode = RegExp.$2;
          if (opts.reject && opts.reject.has(mode)) reply = "RPRT -1";
          else if (which === "M") state.rxMode = mode;
          else state.txMode = mode;
        } else if (/^w\s/.test(line)) reply = opts.noW ? "RPRT -11" : "RPRT 0";
        sock.write(reply + "\n");
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        state,
        close: () =>
          new Promise((r) => {
            for (const s of socks) s.destroy();
            server.close(() => r());
          }),
      });
    }),
  );
}

const CATALOG = {
  "RS-44": { modes: [{ mode: "SSB", uplink: "145.965", downlink: "435.640" }] },
  "JO-97": { modes: [{ mode: "SSB", uplink: "435.110", downlink: "145.870" }] },
  "AO-91": { modes: [{ mode: "FM", uplink: "435.250", downlink: "145.960" }] },
  "CW-SAT": { modes: [{ mode: "CW", uplink: "", downlink: "145.840" }] },
  "EME": { modes: [{ mode: "EME USB 2m", uplink: "144.100", downlink: "144.100" }] },
};

function loadRigctl(cfg) {
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
    exports: Object.assign(
      {
        RADIO_TRANSPORT: "tcp",
        RADIO_PROTOCOL: "rigctl",
        RIGCTL_HOST: "127.0.0.1",
        RIGCTL_PORT: 0,
        RIGCTL_UL_HOST: "",
        RIGCTL_UL_PORT: 0,
        TX_SPLIT: true,
        SERIAL_MODEL: "ic-705",
        serialModel: "ic-705",
        RADIO_MODEL: "",
        CAT_MODEL: "",
        RIGCTL_SAT_DUAL: "",
      },
      cfg,
    ),
  };
  const realCat = require(catPath);
  realCat.getCatalog = () => CATALOG;
  return require(rigPath);
}

/** Capture console; returns { logs, warns, restore }. */
function capture() {
  const logs = [];
  const warns = [];
  const ol = console.log;
  const ow = console.warn;
  console.log = (...a) => logs.push(a.join(" "));
  console.warn = (...a) => warns.push(a.join(" "));
  return { logs, warns, restore: () => ((console.log = ol), (console.warn = ow)) };
}

const modeCmds = (st) => st.cmds.filter((c) => /^[MX] /.test(c));

async function start(rig, ctx) {
  rig.init({ getContext: () => ctx });
  rig.setLock(true); // no dial absorb reads
  rig.setRadio(true);
  await sleep(120);
}

async function ticks(rig, n, ul, dl) {
  for (let i = 0; i < n; i++) {
    await rig.pushFrequencies(ul == null ? null : ul + i * 10, dl == null ? null : dl - i * 10);
    await sleep(30);
  }
}

test("split (one rigctld): data ON → M PKTUSB / X PKTLSB; FM sat → PKTFM; OFF → plain", async () => {
  const fake = await startFakeRigctld();
  const cap = capture();
  const ctx = { currentSatKey: "RS-44", currentModeIndex: 0 };
  let rig;
  try {
    rig = loadRigctl({ RIGCTL_PORT: fake.port });
    assert.strictEqual(rig.getRadioState().supportsDataMode, true);
    rig.setDataMode(true);
    await start(rig, ctx);
    await ticks(rig, 4, 145965000, 435640000);
    assert.deepStrictEqual(modeCmds(fake.state), ["M PKTUSB 0", "X PKTLSB 0"]);
    assert.strictEqual(rig.getRadioState().dataMode, true);

    // FM sat (sat change → applyDefaultLock clears the mode cache)
    fake.state.cmds.length = 0;
    ctx.currentSatKey = "AO-91";
    rig.applyDefaultLock(true);
    await ticks(rig, 4, 435250000, 145960000);
    assert.deepStrictEqual(modeCmds(fake.state), ["M PKTFM 0", "X PKTFM 0"]);

    // OFF → plain FM, then linear USB/LSB
    fake.state.cmds.length = 0;
    rig.setDataMode(false);
    await ticks(rig, 3, 435250000, 145960000);
    assert.deepStrictEqual(modeCmds(fake.state), ["M FM 0", "X FM 0"]);
    fake.state.cmds.length = 0;
    ctx.currentSatKey = "RS-44";
    rig.applyDefaultLock(false);
    rig.setLock(true);
    await ticks(rig, 3, 145965000, 435640000);
    assert.deepStrictEqual(modeCmds(fake.state), ["M USB 0", "X LSB 0"]);
    assert.ok(cap.logs.some((l) => /^rigctl data ON \(PKTUSB\/PKTLSB\/PKTFM\)/.test(l)));
  } finally {
    cap.restore();
    if (rig) rig.setRadio(false);
    await fake.close();
  }
});

test("mid-pass toggle: one mode write per toggle, no per-tick resend", async () => {
  const fake = await startFakeRigctld();
  const cap = capture();
  let rig;
  try {
    rig = loadRigctl({ RIGCTL_PORT: fake.port });
    await start(rig, { currentSatKey: "JO-97", currentModeIndex: 0 });
    await ticks(rig, 3, 435110000, 145870000);
    assert.deepStrictEqual(modeCmds(fake.state), ["M USB 0", "X LSB 0"]);

    fake.state.cmds.length = 0;
    rig.setDataMode(true);
    await ticks(rig, 10, 435110100, 145869900);
    assert.deepStrictEqual(modeCmds(fake.state), ["M PKTUSB 0", "X PKTLSB 0"], "once, not per tick");
    assert.ok(fake.state.cmds.filter((c) => /^F /.test(c)).length >= 5, "Doppler continued");

    // Same value again: no resend
    fake.state.cmds.length = 0;
    rig.setDataMode(true);
    await ticks(rig, 5, 435110200, 145869800);
    assert.deepStrictEqual(modeCmds(fake.state), []);

    fake.state.cmds.length = 0;
    rig.setDataMode(false);
    await ticks(rig, 6, 435110300, 145869700);
    assert.deepStrictEqual(modeCmds(fake.state), ["M USB 0", "X LSB 0"]);
  } finally {
    cap.restore();
    if (rig) rig.setRadio(false);
    await fake.close();
  }
});

test("UL-only rigctl (TX split off, DL on another radio): data mode on the UL VFO", async () => {
  const fake = await startFakeRigctld();
  const cap = capture();
  let rig;
  try {
    rig = loadRigctl({ RIGCTL_PORT: fake.port, TX_SPLIT: false });
    await start(rig, { currentSatKey: "JO-97", currentModeIndex: 0 });
    // Facade with TX split off hands the UL driver (ulHz, null)
    await ticks(rig, 3, 435110000, null);
    assert.deepStrictEqual(modeCmds(fake.state), ["M LSB 0"]);
    fake.state.cmds.length = 0;
    rig.setDataMode(true);
    await ticks(rig, 6, 435110100, null);
    assert.deepStrictEqual(modeCmds(fake.state), ["M PKTLSB 0"]);
    assert.ok(cap.logs.some((l) => /mode → PKTLSB/.test(l)), "mode change logged");
  } finally {
    cap.restore();
    if (rig) rig.setRadio(false);
    await fake.close();
  }
});

test("separate UL rigctld: DL M PKTUSB on DL, M PKTLSB on UL", async () => {
  const fdl = await startFakeRigctld();
  const ful = await startFakeRigctld();
  const cap = capture();
  let rig;
  try {
    rig = loadRigctl({ RIGCTL_PORT: fdl.port, RIGCTL_UL_HOST: "127.0.0.1", RIGCTL_UL_PORT: ful.port });
    rig.setDataMode(true);
    await start(rig, { currentSatKey: "RS-44", currentModeIndex: 0 });
    await ticks(rig, 5, 145965000, 435640000);
    assert.deepStrictEqual(modeCmds(fdl.state), ["M PKTUSB 0"]);
    assert.deepStrictEqual(modeCmds(ful.state), ["M PKTLSB 0"]);
    fdl.state.cmds.length = 0;
    ful.state.cmds.length = 0;
    rig.setDataMode(false);
    await ticks(rig, 5, 145965100, 435639900);
    assert.deepStrictEqual(modeCmds(fdl.state), ["M USB 0"]);
    assert.deepStrictEqual(modeCmds(ful.state), ["M LSB 0"]);
  } finally {
    cap.restore();
    if (rig) rig.setRadio(false);
    await fdl.close();
    await ful.close();
  }
});

test("dual-SAT (Main/Sub): data on both VFOs, toggle re-syncs once", async () => {
  const fake = await startFakeRigctld({ sat: true });
  const cap = capture();
  let rig;
  try {
    rig = loadRigctl({ RIGCTL_PORT: fake.port, SERIAL_MODEL: "ic-9700", serialModel: "ic-9700" });
    await start(rig, { currentSatKey: "RS-44", currentModeIndex: 0 });
    await ticks(rig, 3, 145965000, 435640000);
    fake.state.cmds.length = 0;
    rig.setDataMode(true);
    for (let i = 0; i < 6; i++) {
      await rig.pushFrequencies(145965000 + i * 50, 435640000 - i * 50);
      await sleep(400); // > DUAL_PUSH_MIN_MS
    }
    assert.deepStrictEqual(modeCmds(fake.state), ["M PKTUSB 0", "M PKTLSB 0"]);
    const iMain = fake.state.cmds.indexOf("M PKTUSB 0");
    assert.ok(fake.state.cmds.slice(0, iMain).includes("V Main"), "PKTUSB on Main");
  } finally {
    cap.restore();
    if (rig) rig.setRadio(false);
    await fake.close();
  }
});

test("RPRT on PKT mode: logged once, falls back to plain, no flood", async () => {
  const fake = await startFakeRigctld({ reject: new Set(["PKTUSB", "PKTLSB"]) });
  const cap = capture();
  let rig;
  try {
    rig = loadRigctl({ RIGCTL_PORT: fake.port });
    rig.setDataMode(true);
    await start(rig, { currentSatKey: "RS-44", currentModeIndex: 0 });
    await ticks(rig, 10, 145965000, 435640000);
    assert.deepStrictEqual(modeCmds(fake.state), ["M PKTUSB 0", "M USB 0", "X PKTLSB 0", "X LSB 0"]);
    assert.strictEqual(fake.state.rxMode, "USB");
    assert.strictEqual(fake.state.txMode, "LSB");
    assert.strictEqual(cap.warns.filter((w) => /PKTUSB rejected/.test(w)).length, 1, cap.warns.join("\n"));
    assert.strictEqual(cap.warns.filter((w) => /PKTLSB rejected/.test(w)).length, 1);
    // Toggle off/on: plain already on the radio after fallback; no PKT retry
    fake.state.cmds.length = 0;
    rig.setDataMode(false);
    await ticks(rig, 3, 145965100, 435639900);
    rig.setDataMode(true);
    await ticks(rig, 3, 145965200, 435639800);
    assert.ok(!modeCmds(fake.state).some((c) => /PKT/.test(c)), modeCmds(fake.state).join(","));
    assert.strictEqual(cap.warns.filter((w) => /rejected/.test(w)).length, 2, "still only one warn per mode");
  } finally {
    cap.restore();
    if (rig) rig.setRadio(false);
    await fake.close();
  }
});

test("RPRT fallback in dual-SAT does not re-handshake every tick", async () => {
  const fake = await startFakeRigctld({ sat: true, reject: new Set(["PKTUSB", "PKTLSB"]) });
  const cap = capture();
  let rig;
  try {
    rig = loadRigctl({ RIGCTL_PORT: fake.port, SERIAL_MODEL: "ic-9700", serialModel: "ic-9700" });
    rig.setDataMode(true);
    await start(rig, { currentSatKey: "RS-44", currentModeIndex: 0 });
    for (let i = 0; i < 6; i++) {
      await rig.pushFrequencies(145965000 + i * 50, 435640000 - i * 50);
      await sleep(400);
    }
    assert.deepStrictEqual(modeCmds(fake.state), ["M PKTUSB 0", "M USB 0", "M PKTLSB 0", "M LSB 0"]);
  } finally {
    cap.restore();
    if (rig) rig.setRadio(false);
    await fake.close();
  }
});

test("CW: CW sat → M CW; data never turns CW into a PKT mode; CW toggle wins over data", async () => {
  const fake = await startFakeRigctld();
  const cap = capture();
  const ctx = { currentSatKey: "CW-SAT", currentModeIndex: 0 };
  let rig;
  try {
    rig = loadRigctl({ RIGCTL_PORT: fake.port });
    rig.setDataMode(true);
    await start(rig, ctx);
    await ticks(rig, 3, null, 145840000); // DL-only beacon
    assert.deepStrictEqual(modeCmds(fake.state), ["M CW 0"]);

    // Linear sat with data ON, then CW toggle → CW on both sides, data OFF
    fake.state.cmds.length = 0;
    ctx.currentSatKey = "RS-44";
    rig.applyDefaultLock(false);
    rig.setLock(true);
    await ticks(rig, 3, 145965000, 435640000);
    assert.deepStrictEqual(modeCmds(fake.state), ["M PKTUSB 0", "X PKTLSB 0"]);
    fake.state.cmds.length = 0;
    rig.setCwMode(true);
    assert.strictEqual(rig.getRadioState().dataMode, false, "exclusive");
    await ticks(rig, 4, 145965100, 435639900);
    assert.deepStrictEqual(modeCmds(fake.state), ["M CW 0", "X CW 0"]);
    assert.ok(!fake.state.cmds.some((c) => /CWR/.test(c)), "no CWR");
    // Data ON again clears CW
    fake.state.cmds.length = 0;
    rig.setDataMode(true);
    assert.strictEqual(rig.getRadioState().cwMode, false);
    await ticks(rig, 3, 145965200, 435639800);
    assert.deepStrictEqual(modeCmds(fake.state), ["M PKTUSB 0", "X PKTLSB 0"]);
  } finally {
    cap.restore();
    if (rig) rig.setRadio(false);
    await fake.close();
  }
});

test("TS-2000 over rigctl: data mode unsupported (no-op), modes stay plain", async () => {
  const fake = await startFakeRigctld({ noW: true });
  const cap = capture();
  let rig;
  try {
    rig = loadRigctl({ RIGCTL_PORT: fake.port, SERIAL_MODEL: "ts-2000", serialModel: "ts-2000" });
    assert.strictEqual(rig.getRadioState().supportsDataMode, false);
    rig.setDataMode(true);
    assert.strictEqual(rig.getRadioState().dataMode, false);
    await start(rig, { currentSatKey: "RS-44", currentModeIndex: 0 });
    await ticks(rig, 4, 145965000, 435640000);
    const m = modeCmds(fake.state);
    assert.ok(m.length >= 1, "plain modes still set: " + fake.state.cmds.join("|"));
    assert.ok(!m.some((c) => /PKT/.test(c)), m.join(","));
  } finally {
    cap.restore();
    if (rig) rig.setRadio(false);
    await fake.close();
  }
});
