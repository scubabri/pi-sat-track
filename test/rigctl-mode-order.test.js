// rigctl: frequency first, then mode, with one mode readback (m / x).
// Field report (IC-705 behind rigctld as JO-97 UL, Flex DL, data ON): first
// connect left the radio in USB-D, reconnects in LSB-D, although both logged
// "mode → PKTLSB" then "freq … (initial)". The mode was sent BEFORE the
// initial frequency; the cross-band F (radio parked on 2 m) made the radio
// restore the 70 cm band-stack mode. The mock below is such a radio.
// Run: node --test --test-force-exit test/rigctl-mode-order.test.js
const test = require("node:test");
const assert = require("assert");
const net = require("net");
const path = require("path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bandOf(hz) {
  if (hz >= 144e6 && hz <= 148e6) return "2m";
  if (hz >= 420e6 && hz <= 450e6) return "70cm";
  return "other";
}

/**
 * Radio with band-stack registers per VFO: an F / I that changes band saves
 * the current mode for the old band and RESTORES the stacked mode of the new
 * band (what Icom radios do). M / X set the mode (and the stack entry).
 * opts.vfoA / vfoB: { hz, mode }; opts.stack: { "70cm": "PKTUSB", … }.
 * opts.dropM: number of M writes acked but ignored. opts.refuse: Set of modes
 * the radio acks but never applies. "V Main"/"V Sub" select A/B.
 */
function startRadio(opts) {
  opts = opts || {};
  const st = {
    cmds: [],
    conns: 0,
    socks: [],
    vfo: {
      A: Object.assign({ hz: 145900000, mode: "PKTUSB" }, opts.vfoA),
      B: Object.assign({ hz: 145900000, mode: "PKTUSB" }, opts.vfoB),
    },
    stack: { A: Object.assign({}, opts.stack), B: Object.assign({}, opts.stack) },
    cur: "A",
    dropM: opts.dropM || 0,
  };
  const setHz = (v, hz) => {
    const o = st.vfo[v];
    const from = bandOf(o.hz);
    const to = bandOf(hz);
    if (from !== to) {
      st.stack[v][from] = o.mode;
      if (st.stack[v][to]) o.mode = st.stack[v][to];
    }
    o.hz = hz;
  };
  const setMode = (v, mode) => {
    if (opts.refuse && opts.refuse.has(mode)) return;
    st.vfo[v].mode = mode;
    st.stack[v][bandOf(st.vfo[v].hz)] = mode;
  };
  const server = net.createServer((sock) => {
    st.conns += 1;
    st.socks.push(sock);
    sock.on("error", () => {});
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        st.cmds.push(line);
        let reply = "RPRT 0";
        let m;
        if (line === "U ?") reply = opts.sat ? "SATMODE" : "LOCK";
        else if (line === "f") reply = String(st.vfo[st.cur].hz);
        else if (line === "m") reply = st.vfo[st.cur].mode + "\n0";
        else if (line === "x") reply = st.vfo.B.mode + "\n0";
        else if (/^u\s/.test(line) || line === "c") reply = "0";
        else if ((m = line.match(/^F\s+(\d+)/))) setHz(st.cur, +m[1]);
        else if ((m = line.match(/^I\s+(\d+)/))) setHz("B", +m[1]);
        else if ((m = line.match(/^M\s+(\S+)/))) {
          if (st.dropM > 0) st.dropM -= 1;
          else setMode(st.cur, m[1]);
        } else if ((m = line.match(/^X\s+(\S+)/))) setMode("B", m[1]);
        else if ((m = line.match(/^V\s+(\S+)/))) st.cur = /Sub|VFOB/.test(m[1]) ? "B" : "A";
        sock.write(reply + "\n");
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      st.port = server.address().port;
      st.kick = () => {
        for (const s of st.socks) s.destroy();
        st.socks = [];
      };
      st.close = () => new Promise((r) => {
        st.kick();
        server.close(() => r());
      });
      resolve(st);
    }),
  );
}

const CATALOG = {
  "JO-97": { modes: [{ mode: "SSB", uplink: "435.110", downlink: "145.870" }] },
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
        TX_SPLIT: false,
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

function capture() {
  const logs = [];
  const warns = [];
  const ol = console.log;
  const ow = console.warn;
  console.log = (...a) => logs.push(a.join(" "));
  console.warn = (...a) => warns.push(a.join(" "));
  return { logs, warns, restore: () => ((console.log = ol), (console.warn = ow)) };
}

const count = (st, re) => st.cmds.filter((c) => re.test(c)).length;

/** UL-only role, TX split off: the facade passes (ulHz, null). */
async function ulTicks(rig, n, ul) {
  for (let i = 0; i < n; i++) {
    await rig.pushFrequencies(ul + i * 10, null);
    await sleep(30);
  }
}

async function startRig(rig) {
  rig.init({ getContext: () => ({ currentSatKey: "JO-97", currentModeIndex: 0 }) });
  rig.setLock(true);
  rig.setDataMode(true);
  rig.setRadio(true);
  await sleep(120);
}

test("first connect, radio parked on 2 m USB-D: F then M → PKTLSB sticks; one readback", async () => {
  const radio = await startRadio({ vfoA: { hz: 145900000, mode: "PKTUSB" }, stack: { "70cm": "PKTUSB" } });
  const cap = capture();
  let rig;
  try {
    rig = loadRigctl({ RIGCTL_PORT: radio.port });
    await startRig(rig);
    await ulTicks(rig, 8, 435106191);
    const iF = radio.cmds.findIndex((c) => /^F /.test(c));
    const iM = radio.cmds.findIndex((c) => /^M /.test(c));
    assert.ok(iF >= 0 && iM > iF, "F before M: " + radio.cmds.join("|"));
    assert.strictEqual(radio.vfo.A.mode, "PKTLSB", "radio ends in LSB-D");
    assert.strictEqual(count(radio, /^M /), 1, "no resend needed");
    assert.strictEqual(count(radio, /^m$/), 1, "exactly one readback, no per-tick polling");
    assert.strictEqual(cap.warns.filter((w) => /radio reports|still reports/.test(w)).length, 0, cap.warns.join("\n"));
  } finally {
    cap.restore();
    if (rig) rig.setRadio(false);
    await radio.close();
  }
});

test("reconnect after the radio was moved back to 2 m: PKTLSB again", async () => {
  const radio = await startRadio({ vfoA: { hz: 145900000, mode: "PKTUSB" }, stack: { "70cm": "PKTUSB" } });
  const cap = capture();
  let rig;
  try {
    rig = loadRigctl({ RIGCTL_PORT: radio.port });
    await startRig(rig);
    await ulTicks(rig, 5, 435106191);
    assert.strictEqual(radio.vfo.A.mode, "PKTLSB");
    // Link drops; meanwhile the operator goes to 2 m (70 cm stack now PKTLSB→ set USB-D)
    radio.kick();
    radio.vfo.A.hz = 145900000;
    radio.vfo.A.mode = "PKTUSB";
    radio.stack.A["70cm"] = "PKTUSB";
    await sleep(3000); // reconnect period 2.5 s
    assert.strictEqual(radio.conns, 2, "reconnected");
    radio.cmds.length = 0;
    await ulTicks(rig, 6, 435106391);
    const iF = radio.cmds.findIndex((c) => /^F /.test(c));
    const iM = radio.cmds.findIndex((c) => /^M /.test(c));
    assert.ok(iF >= 0 && iM > iF, "F before M on reconnect: " + radio.cmds.join("|"));
    assert.strictEqual(radio.vfo.A.mode, "PKTLSB");
    assert.strictEqual(count(radio, /^m$/), 1);
  } finally {
    cap.restore();
    if (rig) rig.setRadio(false);
    await radio.close();
  }
});

test("readback mismatch → exactly one resend, clear warning, then quiet", async () => {
  const radio = await startRadio({ vfoA: { hz: 435100000, mode: "LSB" }, dropM: 1 });
  const cap = capture();
  let rig;
  try {
    rig = loadRigctl({ RIGCTL_PORT: radio.port });
    await startRig(rig);
    await ulTicks(rig, 10, 435106191);
    assert.deepStrictEqual(radio.cmds.filter((c) => /^M /.test(c)), ["M PKTLSB 0", "M PKTLSB 0"]);
    assert.strictEqual(count(radio, /^m$/), 2, "readback, resend, readback");
    assert.strictEqual(radio.vfo.A.mode, "PKTLSB");
    const w = cap.warns.filter((x) => /radio reports|still reports/.test(x));
    assert.strictEqual(w.length, 1, cap.warns.join("\n"));
    assert.match(w[0], /radio reports LSB but we set PKTLSB .*resending once/);
    assert.ok(cap.logs.some((l) => /PKTLSB confirmed after resend/.test(l)));
    radio.cmds.length = 0;
    await ulTicks(rig, 10, 435106300);
    assert.strictEqual(count(radio, /^[mM]\b/), 0, "no per-tick mode traffic");
  } finally {
    cap.restore();
    if (rig) rig.setRadio(false);
    await radio.close();
  }
});

test("radio never takes the mode: one resend, two warnings, no flood", async () => {
  const radio = await startRadio({ vfoA: { hz: 435100000, mode: "LSB" }, refuse: new Set(["PKTLSB"]) });
  const cap = capture();
  let rig;
  try {
    rig = loadRigctl({ RIGCTL_PORT: radio.port });
    await startRig(rig);
    await ulTicks(rig, 12, 435106191);
    assert.strictEqual(count(radio, /^M /), 2);
    assert.strictEqual(count(radio, /^m$/), 2);
    assert.strictEqual(cap.warns.filter((w) => /radio reports|still reports/.test(w)).length, 2);
    assert.ok(cap.warns.some((w) => /still reports LSB after resend/.test(w)));
  } finally {
    cap.restore();
    if (rig) rig.setRadio(false);
    await radio.close();
  }
});

test("cross-band jump with an unchanged mode: one readback catches the band-stack restore", async () => {
  const radio = await startRadio({ vfoA: { hz: 435100000, mode: "LSB" }, stack: { "2m": "PKTUSB" } });
  const cap = capture();
  let rig;
  try {
    rig = loadRigctl({ RIGCTL_PORT: radio.port });
    await startRig(rig);
    await ulTicks(rig, 4, 435106191);
    assert.strictEqual(radio.vfo.A.mode, "PKTLSB");
    radio.cmds.length = 0;
    await ulTicks(rig, 5, 145900000); // UL now on 2 m, same PKTLSB wanted
    assert.strictEqual(radio.vfo.A.mode, "PKTLSB", radio.cmds.join("|"));
    assert.deepStrictEqual(radio.cmds.filter((c) => /^M /.test(c)), ["M PKTLSB 0"], "exactly one resend");
    assert.strictEqual(count(radio, /^m$/), 2);
    assert.ok(cap.warns.some((w) => /radio reports PKTUSB but we set PKTLSB \(after band change\)/.test(w)), cap.warns.join("\n"));
    // Doppler steps inside the band: no readbacks
    radio.cmds.length = 0;
    await ulTicks(rig, 8, 145900400);
    assert.strictEqual(count(radio, /^[mM]\b/), 0);
  } finally {
    cap.restore();
    if (rig) rig.setRadio(false);
    await radio.close();
  }
});

test("TX split: F then M on VFOA, I then X on VFOB, x readback; both end right", async () => {
  // VFOA (DL 2 m) parked on 70 cm, VFOB (UL 70 cm) parked on 2 m
  const radio = await startRadio({
    vfoA: { hz: 435000000, mode: "PKTLSB" },
    vfoB: { hz: 145900000, mode: "PKTUSB" },
    stack: { "2m": "FM", "70cm": "FM" },
  });
  const cap = capture();
  let rig;
  try {
    rig = loadRigctl({ RIGCTL_PORT: radio.port, TX_SPLIT: true });
    await startRig(rig);
    for (let i = 0; i < 6; i++) {
      await rig.pushFrequencies(435106191 + i * 10, 145870000 - i * 3);
      await sleep(30);
    }
    const c = radio.cmds;
    const idx = (re) => c.findIndex((x) => re.test(x));
    assert.ok(idx(/^F /) < idx(/^M /), "F before M: " + c.join("|"));
    assert.ok(idx(/^I /) < idx(/^X /), "I before X: " + c.join("|"));
    assert.strictEqual(radio.vfo.A.mode, "PKTUSB", "DL VFOA USB-D");
    assert.strictEqual(radio.vfo.B.mode, "PKTLSB", "UL VFOB LSB-D");
    assert.strictEqual(count(radio, /^m$/), 1);
    assert.strictEqual(count(radio, /^x$/), 1);
    assert.strictEqual(count(radio, /^[MX] /), 2, "no resends");
  } finally {
    cap.restore();
    if (rig) rig.setRadio(false);
    await radio.close();
  }
});

test("separate UL rigctld + dual-SAT handshake: frequency before mode on every VFO", async () => {
  const dlR = await startRadio({ vfoA: { hz: 435000000, mode: "LSB" }, stack: { "2m": "FM" } });
  const ulR = await startRadio({ vfoA: { hz: 145900000, mode: "USB" }, stack: { "70cm": "FM" } });
  const cap = capture();
  let rig;
  try {
    rig = loadRigctl({ RIGCTL_PORT: dlR.port, RIGCTL_UL_HOST: "127.0.0.1", RIGCTL_UL_PORT: ulR.port });
    await startRig(rig);
    for (let i = 0; i < 5; i++) {
      await rig.pushFrequencies(435106191 + i * 10, 145870000 - i * 3);
      await sleep(30);
    }
    assert.strictEqual(dlR.vfo.A.mode, "PKTUSB");
    assert.strictEqual(ulR.vfo.A.mode, "PKTLSB");
    for (const r of [dlR, ulR]) {
      const iF = r.cmds.findIndex((x) => /^F /.test(x));
      const iM = r.cmds.findIndex((x) => /^M /.test(x));
      assert.ok(iF >= 0 && iM > iF, r.cmds.join("|"));
    }
  } finally {
    cap.restore();
    if (rig) rig.setRadio(false);
    await dlR.close();
    await ulR.close();
  }

  const sat = await startRadio({
    sat: true,
    vfoA: { hz: 435000000, mode: "LSB" }, // Main parked on 70 cm
    vfoB: { hz: 145900000, mode: "USB" }, // Sub parked on 2 m
    stack: { "2m": "FM", "70cm": "FM" },
  });
  const cap2 = capture();
  try {
    rig = loadRigctl({ RIGCTL_PORT: sat.port, SERIAL_MODEL: "ic-9700", serialModel: "ic-9700" });
    await startRig(rig);
    await rig.pushFrequencies(435106191, 145870000);
    await sleep(50);
    const c = sat.cmds;
    const at = (re, from) => c.findIndex((x, i) => i >= (from || 0) && re.test(x));
    const vMain = at(/^V Main$/);
    const vSub = at(/^V Sub$/, vMain + 1);
    assert.ok(vMain >= 0 && vSub > vMain, c.join("|"));
    assert.ok(at(/^F /, vMain) < at(/^M /, vMain), "Main: F before M " + c.join("|"));
    assert.ok(at(/^F /, vSub) < at(/^M /, vSub), "Sub: F before M " + c.join("|"));
    assert.strictEqual(sat.vfo.A.mode, "PKTUSB", "Main DL");
    assert.strictEqual(sat.vfo.B.mode, "PKTLSB", "Sub UL");
  } finally {
    cap2.restore();
    if (rig) rig.setRadio(false);
    await sat.close();
  }
});
