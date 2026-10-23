// Knob turns on either radio, both orientations (Brian, Flex705, TX split
// OFF): Radio 1 = IC-705 behind rigctld, Radio 2 = Flex SmartSDR CAT.
// Full sequence: unswapped → swap → Radio off/on ×3 → Data toggle → swap
// back → Radio on, with a dial turn on each radio in each orientation.
// A turn must stick (the radio stays where the knob put it, plus Doppler)
// and move the passband so the other radio follows; no turn = no absorb.
// The rigctld mock emulates Hamlib's 500 ms frequency cache (get_freq
// returns the last set_freq until it expires) unless "\set_cache 0" is sent.
// 127.0.0.1 ephemeral ports only.
// Run: node --test --test-force-exit test/radio-roles-knob.test.js
const test = require("node:test");
const assert = require("assert");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pst-roles-knob-"));
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

/** rigctld with VFO A and Hamlib's get_freq cache (default 500 ms). */
function fakeRig() {
  const st = { conns: 0, open: 0, cmds: [], socks: [], vfoA: 145990000, cacheMs: 500, cache: null, mode: "LSB" };
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
        const now = Date.now();
        if (p[0] === "F") { st.vfoA = parseInt(p[1], 10); st.cache = { hz: st.vfoA, at: now }; }
        else if (p[0] === "M") st.mode = p[1];
        else if (p[0] === "\\set_cache") st.cacheMs = parseInt(p[1], 10);
        if (line === "f") {
          if (st.cacheMs > 0 && st.cache && now - st.cache.at < st.cacheMs) reply = String(st.cache.hz);
          else { reply = String(st.vfoA); st.cache = { hz: st.vfoA, at: now }; }
        } else if (line === "m") reply = st.mode + "\n2400";
        else if (line === "U ?") reply = "LOCK";
        sock.write(reply + "\n");
      }
    });
  });
  return listen(server, st);
}

/** SmartSDR CAT port: one slice, FA / MD / ZZMD state. */
function fakeFlexCat() {
  const st = { conns: 0, open: 0, cmds: [], socks: [], fa: 435810000, md: "2", zz: "01" };
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
        if ((m = cmd.match(/^FA(\d{11})$/))) st.fa = parseInt(m[1], 10);
        else if ((m = cmd.match(/^MD(\d)$/))) st.md = m[1];
        else if ((m = cmd.match(/^ZZMD(\d\d)$/))) st.zz = m[1];
        else if (cmd === "FA") sock.write("FA" + String(st.fa).padStart(11, "0") + ";");
        else if (cmd === "MD") sock.write("MD" + st.md + ";");
        else if (cmd === "ZZMD") sock.write("ZZMD" + st.zz + ";");
      }
    });
  });
  return listen(server, st);
}

// FO-29 (inverting): f0 UL 145.990, DL 435.810.
const UL0 = 145990000, DL0 = 435810000;
let rig, flex, cfg, router, k = 0;
let absorbs = [];
const origLog = console.log;
const role = () => ({ ul: radios.activeUl().meta.id, dl: radios.activeDl().meta.id });

/** state.js applyUlDial for an inverting linear sat. */
function ulDial(d) {
  const r = radios.active();
  const st = r.getRadioState();
  r.setOffsets({ ulFineOffset: st.ulFineOffset || 0, dlFineOffset: st.dlFineOffset || 0, manualDlOffset: (st.manualDlOffset || 0) - d });
  return true;
}

/** state.js tick: inverting Doppler + offsets from the merged radio state. */
function freqs() {
  const st = radios.active().getRadioState();
  const man = st.manualDlOffset || 0;
  return { ul: UL0 - k * 3 - man + (st.ulFineOffset || 0), dl: DL0 + k * 9 + man + (st.dlFineOffset || 0), man };
}
async function ticks(n) {
  for (let i = 0; i < n; i++, k++) {
    const f = freqs();
    await Promise.resolve(radios.active().pushFrequencies(f.ul, f.dl)).catch(() => {});
    await sleep(200);
  }
}
const ulRadio = () => (role().ul === "flex" ? () => flex.fa : () => rig.vfoA);
const dlRadio = () => (role().dl === "flex" ? () => flex.fa : () => rig.vfoA);
function onTarget(msg) {
  const f = freqs();
  assert.ok(Math.abs(ulRadio()() - f.ul) < 150, msg + ": UL radio " + ulRadio()() + " vs computed " + f.ul);
  assert.ok(Math.abs(dlRadio()() - f.dl) < 150, msg + ": DL radio " + dlRadio()() + " vs computed " + f.dl);
}

/** Turn a radio's dial by hz (all at once), let the driver see it. */
async function turn(which, hz) {
  const before = freqs().man;
  if (which === "flex") flex.fa += hz;
  else rig.vfoA += hz;
  const atKnob = which === "flex" ? flex.fa : rig.vfoA;
  await ticks(10);
  const now = which === "flex" ? flex.fa : rig.vfoA;
  // Stays where the knob put it (+ a few ticks of Doppler), not pulled back.
  assert.ok(Math.abs(now - atKnob) < 200, which + " knob " + hz + " Hz snapped back: at knob " + atKnob + ", now " + now);
  onTarget("after " + which + " knob");
  return freqs().man - before;
}

test("setup: unswapped (UL = Radio 1 IC-705 rigctl, DL = Radio 2 Flex), TX split off", async () => {
  rig = await fakeRig();
  flex = await fakeFlexCat();
  catalog.getCatalog = () => ({ "FO-29": { modes: [{ mode: "SSB", uplink: "145.900-146.000", downlink: "435.800-435.900" }] } });
  const r1 = { transport: "tcp", type: "rigctl", protocol: "rigctl", rigctlEndpoint: "127.0.0.1:" + rig.port };
  const r2 = { transport: "tcp", type: "smartsdr", protocol: "cat", catEndpoint: "127.0.0.1:" + flex.port, apiEndpoint: "" };
  cfg = {
    singleRadio: false, txSplit: false, radioUl: r1, radioDl: r2, radioRoles: { defaultUl: 1 },
    radioTransport: "tcp", radioType: "smartsdr", radioProtocol: "cat",
    rigctlHost: "127.0.0.1", rigctlPort: rig.port, rigctlUlHost: "", rigctlUlPort: 0,
    flexDlHost: "127.0.0.1", flexDlPort: flex.port, flexApiHost: "",
  };
  satOffsets.setProfile("Flex705");
  router = createRouter({ config, radios, satOffsets, getConfig: () => cfg, log: () => {} });
  radios.init({ getContext: () => ({ currentSatKey: "FO-29", currentModeIndex: 0 }), broadcast: () => {} });
  radios.setUlDialHandler(ulDial);
  config.applyEndpoints(router.effective(cfg, "FO-29"));
  radios.start();
  radios.setRadio(true, "test");
  console.log = (...a) => {
    const s = a.join(" ");
    if (/dial absorb/.test(s)) absorbs.push(s);
    origLog(...a);
  };
  await ticks(8);
  assert.deepStrictEqual(role(), { ul: "rigctl", dl: "flex" });
  onTarget("unswapped start");
});

test("unswapped: Flex (DL) knob sticks, IC-705 (UL) follows", async () => {
  const dm = await turn("flex", 1000);
  assert.ok(Math.abs(dm - 1000) < 150, "passband +1000: " + dm);
});

test("unswapped: IC-705 (UL) knob sticks (was written back), Flex (DL) follows", async () => {
  const dm = await turn("rig", 700);
  assert.ok(Math.abs(dm + 700) < 150, "inverting passband -700: " + dm);
});

async function swapTo(n) {
  const st = radios.active().getRadioState();
  const saved = { ulFineOffset: st.ulFineOffset || 0, dlFineOffset: st.dlFineOffset || 0, manualDlOffset: st.manualDlOffset || 0 };
  router.setForSat("FO-29", n);
  assert.strictEqual(router.applyForSat("FO-29", "panel"), true);
  // state.reapplyRadioForCurrentSat(): reset, restore saved offsets
  radios.resetAllOffsets();
  radios.active().setOffsets(saved);
  await sleep(300);
  await ticks(6);
  assert.strictEqual(radios.active().getRadioState().manualDlOffset, saved.manualDlOffset, "swap keeps the manual offset");
}

test("swap (Flex UL, IC-705 DL), Radio off/on ×3, Data toggle: still on target", async () => {
  await swapTo(2);
  assert.deepStrictEqual(role(), { ul: "flex", dl: "rigctl" });
  for (let i = 0; i < 3; i++) {
    radios.setRadio(false, "test");
    await sleep(250);
    radios.setRadio(true, "test");
    await sleep(250);
    await ticks(5);
  }
  radios.active().setDataMode(true);
  await ticks(5);
  radios.active().setDataMode(false);
  await ticks(6);
  onTarget("swapped after off/on");
});

test("swapped: no knob turn = no absorb", async () => {
  absorbs = [];
  await ticks(12);
  assert.deepStrictEqual(absorbs, []);
});

test("swapped: IC-705 (DL) knob sticks despite Hamlib's cache, Flex (UL) follows", async () => {
  const dm = await turn("rig", 1500);
  assert.ok(Math.abs(dm - 1500) < 150, "passband +1500: " + dm);
  assert.ok(rig.cmds.includes("\\set_cache 0"), "Hamlib cache disabled");
});

test("swapped: Flex (UL) knob sticks, IC-705 (DL) follows", async () => {
  const dm = await turn("flex", 800);
  assert.ok(Math.abs(dm + 800) < 150, "inverting passband -800: " + dm);
});

test("swap back, Radio off/on: manual kept, IC-705 (UL) and Flex (DL) knobs stick", async () => {
  await swapTo(1);
  assert.deepStrictEqual(role(), { ul: "rigctl", dl: "flex" });
  radios.setRadio(false, "test");
  await sleep(250);
  radios.setRadio(true, "test");
  await ticks(6);
  onTarget("swapped back");
  absorbs = [];
  await ticks(8);
  assert.deepStrictEqual(absorbs, [], "no absorb without a turn");
  let dm = await turn("rig", 600);
  assert.ok(Math.abs(dm + 600) < 150, "IC-705 UL: passband -600: " + dm);
  dm = await turn("flex", -900);
  assert.ok(Math.abs(dm + 900) < 150, "Flex DL: passband -900: " + dm);
});

test("teardown", async () => {
  console.log = origLog;
  radios.setRadio(false, "test");
  await sleep(200);
  await rig.close();
  await flex.close();
});
