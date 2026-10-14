#!/usr/bin/env node
/**
 * Minimal SmartSDR CAT TCP simulator (FA/MD only) + dial-absorb scenario test.
 * Usage: node tools/flex-cat-sim.js            (runs scenarios)
 *        node tools/flex-cat-sim.js serve UL DL (just serve on ports)
 */
const net = require("net");

function makeSim(port) {
  const sim = { freq: 145900000, mode: "3", override: [], port };
  sim.server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf(";")) >= 0) {
        const c = buf.slice(0, i); buf = buf.slice(i + 1);
        if (c === "FA") {
          const f = sim.override.length ? sim.override.shift() : sim.freq;
          sock.write("FA" + String(f).padStart(11, "0") + ";");
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
  let dlBase = 145900000, ulBase = 435000000;
  const tick = () => {
    const m = flex.getRadioState().manualDlOffset;
    return flex.pushFrequencies(ulBase, dlBase + m);
  };
  flex.setRadio(true);
  for (let i = 0; i < 40 && flex.getRadioState().syncNeeded; i++) { await tick(); await sleep(250); }
  const st = () => flex.getRadioState();
  const results = [];
  const check = (name, ok, info) => { results.push([name, ok]); console.log((ok ? "PASS " : "FAIL ") + name, info || ""); };
  console.log("synced:", !st().syncNeeded, "dl sim", dlS.freq);
  // Settle (lets poll confirm lastFreqHz)
  for (let i = 0; i < 4; i++) { await tick(); await sleep(250); }

  // (c) small step absorbed
  dlS.freq += 2000;
  for (let i = 0; i < 4; i++) { await tick(); await sleep(250); }
  check("(c) small 2 kHz step absorbed", Math.abs(st().manualDlOffset - 2000) < 100, "manualDl=" + st().manualDlOffset);
  dlS.freq += 9000; // 9 kHz legit spin → pending then confirmed
  for (let i = 0; i < 6; i++) { await tick(); await sleep(250); }
  check("(c2) 9 kHz spin confirmed", Math.abs(st().manualDlOffset - 11000) < 100, "manualDl=" + st().manualDlOffset);

  // (b) single spurious 45 kHz report that reverts
  const before = st().manualDlOffset; const freqBefore = dlS.freq;
  dlS.override.push(dlS.freq + 45000);
  for (let i = 0; i < 8; i++) { await tick(); await sleep(250); }
  check("(b) spurious 45 kHz discarded", Math.abs(st().manualDlOffset - before) < 1 && Math.abs(dlS.freq - freqBefore) < 5,
    "manualDl=" + st().manualDlOffset + " radio=" + dlS.freq);

  // (a) fast spin 36 kHz that persists (with continued tuning)
  const b2 = st().manualDlOffset;
  dlS.freq += 36338;
  await tick(); await sleep(200);
  dlS.freq += 373; // keeps turning
  for (let i = 0; i < 6; i++) { await tick(); await sleep(250); }
  check("(a) 36 kHz persistent spin accepted", Math.abs(st().manualDlOffset - (b2 + 36711)) < 100 && Math.abs(dlS.freq - (dlBase + st().manualDlOffset)) < 100,
    "manualDl=" + st().manualDlOffset + " radio=" + dlS.freq);

  flex.setRadio(false); ul.server.close(); dlS.server.close();
  const fails = results.filter((r) => !r[1]).length;
  console.log(fails ? fails + " FAILED" : "ALL PASS");
  process.exit(fails ? 1 : 0);
}

if (process.argv[2] === "serve") {
  makeSim(+process.argv[3] || 5002).then((s) => console.log("UL sim", s.port));
  makeSim(+process.argv[4] || 5003).then((s) => console.log("DL sim", s.port));
} else runTests();
