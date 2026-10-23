// Radio 1 / Radio 2 swap "snap-back" (Brian's split profile Flex705: Radio 1 =
// IC-705 behind rigctld, Radio 2 = Flex via SmartSDR CAT, TX split ON).
// Mock radios on 127.0.0.1 ephemeral ports keep real VFO state: the rigctld
// fake has VFO A + split VFO, the Flex CAT fake has ONE slice per port shared
// by every connection to that port (like a SmartSDR CAT port).
// After swapping (Flex on UL / 2m, IC-705 on DL / 70cm):
//  - the Flex slice must stay on the uplink (no second link writing the
//    downlink to the same CAT port and dragging it back);
//  - the IC-705 must not absorb its own Doppler writes, and a real knob turn
//    must stick (absorbed into the DL offset, not pulled back).
// Run: node --test --test-force-exit test/radio-roles-snapback.test.js
const test = require("node:test");
const assert = require("assert");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pst-roles-snap-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const config = require("../lib/config");
const catalog = require("../lib/catalog");
const radios = require("../lib/radios");
const satOffsets = require("../lib/sat-offsets");
const { createRouter } = require("../lib/radio-role-router");

function listen(server, st) {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      st.port = server.address().port;
      st.close = () => new Promise((r) => { for (const s of st.socks) s.destroy(); server.close(() => r()); });
      resolve(st);
    }),
  );
}

/** Stateful rigctld: VFO A (F / f) + split TX VFO (I / i). */
function fakeRig() {
  const st = { conns: 0, open: 0, cmds: [], socks: [], vfoA: 435800000, vfoTx: 145950000, split: 0 };
  const server = net.createServer((sock) => {
    st.conns += 1; st.open += 1; st.socks.push(sock);
    sock.on("error", () => {});
    sock.on("close", () => (st.open -= 1));
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
        const p = line.split(/\s+/);
        if (p[0] === "F") st.vfoA = parseInt(p[1], 10);
        else if (p[0] === "I") st.vfoTx = parseInt(p[1], 10);
        else if (p[0] === "S") st.split = parseInt(p[1], 10);
        if (line === "f") reply = String(st.vfoA);
        else if (line === "i") reply = String(st.vfoTx);
        else if (line === "m") reply = "LSB\n2400";
        else if (line === "x") reply = "USB\n2400";
        else if (line === "s") reply = st.split + "\nVFOB";
        else if (line === "U ?") reply = "LOCK";
        sock.write(reply + "\n");
      }
    });
  });
  return listen(server, st);
}

/** SmartSDR CAT port: one slice per port, shared by all connections. */
function fakeFlexCat() {
  const st = { conns: 0, open: 0, cmds: [], socks: [], fa: 435800000, writes: [] };
  const server = net.createServer((sock) => {
    st.conns += 1; st.open += 1; st.socks.push(sock);
    sock.on("error", () => {});
    sock.on("close", () => (st.open -= 1));
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString("ascii");
      let i;
      while ((i = buf.indexOf(";")) >= 0) {
        const cmd = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!cmd) continue;
        st.cmds.push(cmd);
        let m;
        if ((m = cmd.match(/^FA(\d{11})$/))) { st.fa = parseInt(m[1], 10); st.writes.push(st.fa); }
        else if (cmd === "FA") sock.write("FA" + String(st.fa).padStart(11, "0") + ";");
        else if (cmd === "MD") sock.write("MD2;");
        else if (cmd === "ZZMD") sock.write("ZZMD01;");
      }
    });
  });
  return listen(server, st);
}

// FO-29: uplink 145.9-146.0 LSB, downlink 435.8-435.9 USB (inverting).
const UL = 145992000, DL = 435806000;
let rig, flex, hidden, profileCfg, router;
let absorbLog = [];
let connectLog = [];
const origLog = console.log;

test("setup: Radio 1 = IC-705 rigctld (UL), Radio 2 = Flex CAT (DL), TX split on", async () => {
  rig = await fakeRig();
  flex = await fakeFlexCat();
  hidden = await fakeFlexCat(); // IC-705 card's hidden (unused) CAT field: never dialled
  catalog.getCatalog = () => ({ "FO-29": { modes: [{ mode: "SSB", uplink: "145.900-146.000", downlink: "435.800-435.900" }] } });
  const r1 = { transport: "tcp", type: "rigctl", protocol: "rigctl", rigctlEndpoint: "127.0.0.1:" + rig.port, catEndpoint: "127.0.0.1:" + hidden.port };
  const r2 = { transport: "tcp", type: "smartsdr", protocol: "cat", catEndpoint: "127.0.0.1:" + flex.port, apiEndpoint: "", rigctlEndpoint: "127.0.0.9:4532" };
  profileCfg = {
    singleRadio: false, txSplit: true, radioUl: r1, radioDl: r2,
    radioRoles: { defaultUl: 1, names: ["IC-705", "Flex"], bands: [["2m"], ["70cm"]] },
    // flat fields js/config.js derives from this (unswapped) form
    radioTransport: "tcp", radioType: "smartsdr", radioProtocol: "cat",
    rigctlHost: "127.0.0.9", rigctlPort: 4532, rigctlUlHost: "127.0.0.1", rigctlUlPort: rig.port,
    flexUlHost: "127.0.0.1", flexUlPort: hidden.port, flexDlHost: "127.0.0.1", flexDlPort: flex.port,
    flexHost: "127.0.0.1", flexPort: hidden.port, flexApiHost: "", flexApiPort: 4992,
  };
  satOffsets.setProfile("Flex705");
  router = createRouter({ config, radios, satOffsets, getConfig: () => profileCfg, log: () => {} });
  radios.init({ getContext: () => ({ currentSatKey: "FO-29", currentModeIndex: 0 }), broadcast: () => {} });
  config.applyEndpoints(router.effective(profileCfg, "FO-29"));
  radios.start();
  radios.setRadio(true, "test");
  console.log = (...a) => {
    const s = a.join(" ");
    if (/dial absorb/.test(s)) absorbLog.push(s);
    if (/connecting/.test(s)) connectLog.push(s);
    origLog(...a);
  };
});

/** Doppler ticks the way state.js computes them (offsets from merged state). */
async function ticks(n, t0) {
  for (let i = 0; i < n; i++) {
    const r = radios.active();
    const st = r.getRadioState();
    const k = (t0 || 0) + i;
    const ul = UL + k * 3; // Doppler drift
    const dl = DL - k * 9 + (st.manualDlOffset || 0) + (st.dlFineOffset || 0);
    await Promise.resolve(r.pushFrequencies(ul, dl)).catch(() => {});
    await sleep(120);
  }
}

test("swap on FO-29: Flex (Radio 2) on UL stays on 2m; one link to its CAT port", async () => {
  await ticks(6);
  router.setForSat("FO-29", 2);
  assert.strictEqual(router.applyForSat("FO-29", "panel"), true);
  radios.resetAllOffsets();
  radios.active().setOffsets({ ulFineOffset: 0, dlFineOffset: 0, manualDlOffset: 0 });
  assert.strictEqual(radios.activeUl().meta.id, "flex");
  assert.strictEqual(radios.activeDl().meta.id, "rigctl");
  await sleep(300);
  flex.writes.length = 0;
  absorbLog = [];
  await ticks(14);
  await sleep(300);
  const bad = flex.writes.filter((f) => Math.abs(f - DL) < 1e6);
  assert.deepStrictEqual(bad, [], "Flex (UL) slice never dragged back to the 70cm downlink: " + flex.writes.join(","));
  assert.ok(Math.abs(flex.fa - UL) < 2000, "Flex slice on the uplink: " + flex.fa);
  assert.ok(flex.open <= 1, "one Flex CAT connection, got " + flex.open);
  assert.ok(Math.abs(rig.vfoA - DL) < 2000, "IC-705 VFO A on the downlink: " + rig.vfoA);
  assert.deepStrictEqual(absorbLog, [], "no self-generated dial absorbs on the IC-705");
  assert.strictEqual(rig.split, 0, "IC-705 (DL) no longer left in split from its UL role");
});

test("after swap: a knob turn on the IC-705 (DL) sticks; no absorbs without one", async () => {
  absorbLog = [];
  rig.vfoA += 1500; // operator turns the dial
  await ticks(10, 20);
  const st = radios.active().getRadioState();
  assert.ok(Math.abs(st.manualDlOffset - 1500) < 200, "knob absorbed into DL offset: " + st.manualDlOffset);
  const want = DL - 29 * 9 + st.manualDlOffset;
  assert.ok(Math.abs(rig.vfoA - want) < 200, "IC-705 stays where the knob put it (+Doppler): " + rig.vfoA + " vs " + want);
  const n = absorbLog.length;
  assert.ok(n >= 1, "absorbed");
  await ticks(10, 30);
  assert.strictEqual(absorbLog.length, n, "no further absorbs without a knob turn: " + absorbLog.slice(n).join(" | "));
});

test("swap back to Radio 1 on UL: Flex never dials the IC-705 card's CAT field; rigctl split back on", async () => {
  connectLog = [];
  router.setForSat("FO-29", 1);
  assert.strictEqual(router.applyForSat("FO-29", "panel"), true);
  radios.resetAllOffsets();
  await sleep(300);
  flex.writes.length = 0;
  await ticks(8, 40);
  await sleep(2800); // > one reconnect period
  assert.strictEqual(hidden.conns, 0, "stale UL CAT endpoint never dialled");
  assert.deepStrictEqual(connectLog.filter((l) => l.includes(":" + hidden.port)), [], "no connect attempt to the stale endpoint");
  assert.ok(flex.writes.length && flex.writes.every((f) => Math.abs(f - DL) < 2e6), "Flex (DL) on the downlink: " + flex.writes.join(","));
  assert.ok(Math.abs(rig.vfoTx - UL) < 5000 && rig.split === 1, "IC-705 split TX on the uplink");
  assert.ok(flex.open <= 1 && rig.open <= 1, "one socket per radio");
});

test("teardown", async () => {
  console.log = origLog;
  radios.setRadio(false, "test");
  await sleep(200);
  await rig.close();
  await flex.close();
  await hidden.close();
});
