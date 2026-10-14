#!/usr/bin/env node
/**
 * Minimal SmartSDR CAT TCP simulator (FA/MD only) + dial-absorb scenario test.
 * Usage: node tools/flex-cat-sim.js            (runs scenarios)
 *        node tools/flex-cat-sim.js serve UL DL (just serve on ports)
 */
const net = require("net");

function makeSim(port) {
  const sim = { freq: 145900000, mode: "3", override: [], port, conns: 0, faDelayMs: 0 };
  sim.server = net.createServer((sock) => {
    sim.conns++;
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf(";")) >= 0) {
        const c = buf.slice(0, i); buf = buf.slice(i + 1);
        if (c === "FA") {
          const f = sim.override.length ? sim.override.shift() : sim.freq;
          const out = "FA" + String(f).padStart(11, "0") + ";";
          if (sim.faDelayMs) setTimeout(() => { try { sock.write(out); } catch (_) {} }, sim.faDelayMs);
          else sock.write(out);
        } else if (c.startsWith("FA")) sim.freq = parseInt(c.slice(2), 10);
        else if (c === "MD") sock.write("MD" + sim.mode + ";");
        else if (c.startsWith("MD")) sim.mode = c.slice(2);
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((r) => sim.server.listen(port, "127.0.0.1", () => r(sim)));
}

async function runTests() {
  // Isolate sat-offsets.json from the real ~/.rpitrack
  process.env.HOME = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "flexsim-"));
  const config = require("../lib/config");
  const ul = await makeSim(46001), dlS = await makeSim(46002);
  const fake = Object.create(config);
  const ov = { FLEX_UL_HOST: "127.0.0.1", FLEX_UL_PORT: 46001,
    FLEX_DL_HOST: "127.0.0.1", FLEX_DL_PORT: 46002 };
  for (const k in ov) Object.defineProperty(fake, k, { value: ov[k] });
  require.cache[require.resolve("../lib/config")].exports = fake;
  const flex = require("../lib/radios/flex");
  flex.init({ broadcast() {}, getContext: () => ({}) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Sat data: real SGP4 Doppler (ISS TLE), sim time runs 30x so the tracked
  // DL moves ~tens of Hz per tick like a mid-pass LEO.
  const satellite = require("satellite.js");
  const { rangeRateKmS } = require("../lib/orbit");
  const satrec = satellite.twoline2satrec(
    "1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9005",
    "2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49815315432597");
  const observer = { latitude: 39.74 * Math.PI / 180, longitude: -104.99 * Math.PI / 180, height: 1.6 };
  const t0 = Date.now(), simT0 = new Date(Date.UTC(2024, 0, 1, 12, 5)).getTime();
  const F0 = 145800000, ulBase = 435000000;
  const dopplerDl = () => {
    const rr = rangeRateKmS(satrec, observer, new Date(simT0 + (Date.now() - t0) * 30));
    return Math.round(F0 * (1 - rr / 299792.458));
  };
  let knobStep = 0; const absorbs = [];
  const origLog = console.log;
  console.log = (...a) => { if (String(a[0]).startsWith("Flex dial absorb DL")) absorbs.push({ step: knobStep, vs: a[1] }); origLog(...a); };
  const tick = () => {
    // Mirror state.js: DL = doppler + manual + dlFine; UL gets ulFine
    const r = flex.getRadioState();
    return flex.pushFrequencies(ulBase + (r.ulFineOffset || 0),
      dopplerDl() + r.manualDlOffset + (r.dlFineOffset || 0));
  };
  // State tick at 250 ms like state.js (driver poll runs its own 400 ms timer)
  const ticker = setInterval(() => tick().catch(() => {}), 250);
  const knob = (hz) => { knobStep++; dlS.freq += hz; };
  // Restored per-sat calibration (as state.applySavedOffsetsForSat does on
  // sat load, BEFORE the user engages the radio).
  const RESTORED = { ulFineOffset: 0, dlFineOffset: -1500, manualDlOffset: -1515 };
  flex.setOffsets(RESTORED);
  flex.setRadio(true);
  for (let i = 0; i < 60 && flex.getRadioState().syncNeeded; i++) await sleep(250);
  const st = () => flex.getRadioState();
  const results = [];
  const check = (name, ok, info) => { results.push([name, ok]); console.log((ok ? "PASS " : "FAIL ") + name, info || ""); };
  const trueOff = () => dlS.freq - dopplerDl() - st().dlFineOffset; // = manualDl expected
  const offOk = () => Math.abs(st().manualDlOffset - trueOff()) < 150;
  const noDouble = (from) => {
    const seen = {}; for (const a of absorbs.slice(from)) { if (seen[a.step]) return false; seen[a.step] = 1; } return true;
  };
  console.log("synced:", !st().syncNeeded);
  await sleep(1500);
  check("(e) restored fine/manual survive engage",
    st().dlFineOffset === -1500 && st().ulFineOffset === 0 && st().manualDlOffset === -1515 && offOk(),
    "UL " + st().ulFineOffset + " DL " + st().dlFineOffset + " manual " + st().manualDlOffset +
    " radio-doppler=" + (dlS.freq - dopplerDl()));
  {
    const n = absorbs.length;
    for (const hz of [1000, -2500, 700, 3000, -1200]) { knob(hz); await sleep(1200); }
    const expectManual = -1515 + 1000 - 2500 + 700 + 3000 - 1200;
    check("(e) 5 absorbs: DL fine kept, manual continues from restored", st().dlFineOffset === -1500 &&
      st().ulFineOffset === 0 && Math.abs(st().manualDlOffset - expectManual) < 150 && offOk() &&
      absorbs.length - n === 5 && noDouble(n),
      "DL " + st().dlFineOffset + " manual " + Math.round(st().manualDlOffset) + " expect " + expectManual);
    // Save through the real sat-offsets store (HOME redirected to a tmp dir)
    const satOffsets = require("../lib/sat-offsets");
    const s0 = flex.getRadioState();
    satOffsets.set("JO-97", { ulFineOffset: s0.ulFineOffset, dlFineOffset: s0.dlFineOffset, manualDlOffset: s0.manualDlOffset });
    if (satOffsets.flush) satOffsets.flush();
    await sleep(1500);
    const saved = JSON.parse(require("fs").readFileSync(require("path").join(process.env.HOME, ".rpitrack", "sat-offsets.json"), "utf8"))["JO-97"] || {};
    check("(e) saved file keeps DL fine -1500 + manual", saved.dlFineOffset === -1500 && Math.abs(saved.manualDlOffset - expectManual) < 150,
      JSON.stringify(saved));
  }
  // Remaining scenarios run relative to the restored calibration
  const M0 = st().manualDlOffset;

  // (c) small step absorbed
  let n0 = absorbs.length; knob(2000); await sleep(1500);
  check("(c) small 2 kHz step absorbed", offOk() && Math.abs(st().manualDlOffset - M0 - 2000) < 150 && noDouble(n0), "manualDl=" + Math.round(st().manualDlOffset));
  n0 = absorbs.length; knob(9000); await sleep(2000);
  check("(c2) 9 kHz spin confirmed once", offOk() && Math.abs(st().manualDlOffset - M0 - 11000) < 150 && noDouble(n0), "manualDl=" + Math.round(st().manualDlOffset) + " absorbs=" + (absorbs.length - n0));

  // (b) single spurious 45 kHz report that reverts
  let before = st().manualDlOffset; n0 = absorbs.length;
  dlS.override.push(dlS.freq + 45000); await sleep(2000);
  check("(b) spurious 45 kHz discarded", Math.abs(st().manualDlOffset - before) < 150 && absorbs.length === n0 && offOk(),
    "manualDl=" + Math.round(st().manualDlOffset));

  // (a) fast spin 36 kHz that persists (with continued tuning)
  n0 = absorbs.length; knob(36338); await sleep(200); knob(373); await sleep(2500);
  check("(a) 36 kHz persistent spin accepted", offOk() && noDouble(n0), "manualDl=" + Math.round(st().manualDlOffset) + " true=" + Math.round(trueOff()));

  // (d) replay of field log: rapid multi-step spins, push+poll interleaved, Doppler moving
  n0 = absorbs.length;
  const seq = [[8369, 150], [800, 1200], [-16896 - 9169 + 9169 - 8369 - 800 + 9169, 300], [-9300, 150], [-13300, 1500],
    [7203, 200], [12700, 1500], [9300, 120], [2000, 300], [2500, 400], [700, 1500], [9804, 100], [500, 2000]];
  for (const [hz, wait] of seq) { knob(hz); await sleep(wait); }
  await sleep(1500);
  check("(d) field replay: final manualDl == true dial offset", offOk(),
    "manualDl=" + Math.round(st().manualDlOffset) + " true=" + Math.round(trueOff()));
  check("(d) field replay: no double absorb", noDouble(n0), "absorbs=" + absorbs.length + " steps=" + seq.length);
  // Settled: radio follows Doppler at the new offset (no snap-back)
  await sleep(1000);
  check("(d) radio tracks tracked+manual after replay", Math.abs(dlS.freq - (dopplerDl() + st().manualDlOffset + st().dlFineOffset)) < 150 && offOk(),
    "radio=" + dlS.freq);
  // (f) Radio off while a push is mid dial-read: nothing may reopen sockets
  {
    dlS.faDelayMs = 300; // keep FA reads in flight
    await sleep(600);
    const c0 = ul.conns + dlS.conns;
    flex.setRadio(false, "sim user click");
    for (let i = 0; i < 16; i++) { await tick().catch(() => {}); await sleep(250); } // state ticks keep coming
    const c1 = ul.conns + dlS.conns;
    const r = flex.getRadioState();
    check("(f) no Flex reconnect after Radio off", c1 === c0 && !r.dlConnected && !r.ulConnected && !r.connecting,
      "new conns=" + (c1 - c0) + " dl=" + r.dlConnected + " ul=" + r.ulConnected);
    dlS.faDelayMs = 0;
  }
  clearInterval(ticker);
  flex.setRadio(false); ul.server.close(); dlS.server.close();
  const fails = results.filter((r) => !r[1]).length;
  console.log(fails ? fails + " FAILED" : "ALL PASS");
  process.exit(fails ? 1 : 0);
}

if (process.argv[2] === "serve") {
  makeSim(+process.argv[3] || 5002).then((s) => console.log("UL sim", s.port));
  makeSim(+process.argv[4] || 5003).then((s) => console.log("DL sim", s.port));
} else runTests();
