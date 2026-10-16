// IC-9700 simplex sats (UL≈DL same band: ISS APRS, SONATE-2): SAT OFF, MAIN
// only on VHF, no SUB writes, Doppler on MAIN; leaving simplex restores SAT.
// Run: node --test --test-force-exit test/ic9700-simplex.test.js
const test = require("node:test");
const assert = require("assert");
const path = require("path");

const cfgPath = require.resolve(path.join(__dirname, "../lib/config"));
require.cache[cfgPath] = {
  id: cfgPath, filename: cfgPath, loaded: true,
  exports: {
    CAT_DEVICE: "/dev/fake9700", CAT_BAUD: 19200, CAT_CIV_ADDR: 0xa2,
    CAT2_DEVICE: "", isDualCat: () => false, RADIO_TRANSPORT: "serial",
  },
};
function bcd(hz) {
  const s = String(Math.round(hz)).padStart(10, "0");
  const out = [];
  for (let i = 0; i < 10; i += 2) out.push((+s[i] << 4) | +s[i + 1]);
  return out.reverse();
}
function unbcd(b) {
  let f = 0, m = 1;
  for (const x of b) { f += (x & 15) * m; m *= 10; f += (x >> 4) * m; m *= 10; }
  return f;
}
const band = (hz) => (hz >= 220e6 ? "70cm" : "2m");
// Start the way the field radio was: MAIN on UHF, SUB on VHF, SAT ON.
const radio = { main: 435600000, sub: 145900000, sel: "main", sat: true, cmds: [], writes: [] };
class FakePort {
  constructor() { this.h = {}; }
  open(cb) { setImmediate(() => cb(null)); }
  on(ev, fn) { this.h[ev] = fn; }
  removeAllListeners() { this.h = {}; }
  close() {}
  drain(cb) { cb(); }
  write(data, cb) {
    const [c, ...d] = [...data.slice(4, data.length - 1)];
    radio.cmds.push([c, ...d].map((x) => x.toString(16)).join(","));
    let rep = [0xfb];
    if (c === 0x07 && d[0] === 0xd0) radio.sel = "main";
    else if (c === 0x07 && d[0] === 0xd1) radio.sel = "sub";
    else if (c === 0x07 && d[0] === 0xb0) [radio.main, radio.sub] = [radio.sub, radio.main];
    else if (c === 0x16 && d[0] === 0x5a) radio.sat = d[1] === 1;
    else if (c === 0x05) {
      const hz = unbcd(d.slice(0, 5));
      const other = radio.sel === "main" ? "sub" : "main";
      // 9700: MAIN and SUB can't share a band → the other VFO is pushed off
      // (this is how SAT-on simplex ended up on UHF).
      if (band(hz) === band(radio[other])) radio[other] = band(hz) === "2m" ? 435600000 : 145900000;
      radio[radio.sel] = hz;
      radio.writes.push({ vfo: radio.sel, hz, t: Date.now() });
    } else if (c === 0x03) rep = [0x03, ...bcd(radio[radio.sel])];
    const frame = Buffer.from([0xfe, 0xfe, 0xe0, 0xa2, ...rep, 0xfd]);
    cb(null);
    setImmediate(() => this.h.data && this.h.data(frame));
  }
}
const spPath = require.resolve("serialport");
require.cache[spPath] = { id: spPath, filename: spPath, loaded: true, exports: { SerialPort: FakePort } };

const catalog = require("../lib/catalog");
catalog.getCatalog = () => ({
  "ISS": { modes: [{ mode: "APRS", uplink: "145.825", downlink: "145.825" }] },
  "SONATE-2": { modes: [{ mode: "APRS AFSK 1200", uplink: "145.825", downlink: "145.825" }] },
  "RS-44": { modes: [{ mode: "SSB", uplink: "145.935-145.995", downlink: "435.610-435.670" }] },
});
const ic = require("../lib/radios/ic9700");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runSimplex(sat, logs) {
  let sel = sat;
  ic.init({ getContext: () => ({ currentSatKey: sel, currentModeIndex: 0 }) });
  ic.setLock(false);
  ic.setRadio(true);
  let t = 0;
  // Simplex: tracker gives UL (inverse Doppler) and DL a few kHz apart
  const dlD = () => 145825000 + 3000 - t * 40;
  const ulD = () => 145825000 - 3000 + t * 40;
  for (let i = 0; i < 80 && ic.getRadioState().syncNeeded; i++) {
    await ic.pushFrequencies(ulD(), dlD()); await sleep(40);
  }
  assert.ok(!ic.getRadioState().syncNeeded, "sync cleared");
  assert.strictEqual(radio.sat, false, "SAT OFF");
  assert.strictEqual(band(radio.main), "2m", "MAIN on VHF: " + radio.main);
  assert.ok(logs.some((l) => /^IC9700 simplex: SAT OFF, MAIN VHF 145\.82/.test(l)), logs.join("\n"));
  radio.writes.length = 0;
  for (let i = 0; i < 6; i++) { t += 3; await ic.pushFrequencies(ulD(), dlD()); await sleep(550); }
  assert.ok(radio.writes.every((w) => w.vfo === "main"), "no SUB writes: " + JSON.stringify(radio.writes));
  assert.ok(radio.writes.length >= 4, "Doppler on MAIN each tick");
  assert.strictEqual(radio.main, dlD(), "MAIN = DL-corrected");
  assert.strictEqual(radio.sat, false, "SAT stays OFF");
  assert.strictEqual(radio.cmds.filter((c) => c === "16,5a,1").length, 0, "never SAT ON in simplex");
  return { setSat: (k) => { sel = k; } };
}

test("ISS APRS simplex: SAT OFF, MAIN VHF, no SUB, Doppler on MAIN", async () => {
  const logs = []; const oL = console.log, oW = console.warn;
  console.log = (...a) => logs.push(a.join(" ")); console.warn = (...a) => logs.push("WARN " + a.join(" "));
  try { await runSimplex("ISS", logs); }
  finally { console.log = oL; console.warn = oW; ic.close(); }
});

test("SONATE-2 simplex → RS-44: SAT restored once, MAIN UHF / SUB VHF", async () => {
  const logs = []; const oL = console.log, oW = console.warn;
  console.log = (...a) => logs.push(a.join(" ")); console.warn = (...a) => logs.push("WARN " + a.join(" "));
  try {
    radio.main = 435600000; radio.sub = 145900000; radio.sat = true; radio.cmds.length = 0;
    const h = await runSimplex("SONATE-2", logs);
    // Simplex dial absorb on MAIN still works
    const m0 = ic.getRadioState().manualDlOffset || 0;
    radio.main += 1500;
    for (let i = 0; i < 12; i++) { await ic.pushFrequencies(145822000, 145828000 + (ic.getRadioState().manualDlOffset || 0)); await sleep(550); }
    const m1 = ic.getRadioState().manualDlOffset || 0;
    assert.ok(Math.abs(m1 - m0) > 500, "MAIN dial absorbed in simplex: " + m0 + "→" + m1);
    // Switch to RS-44 (sat change resets offsets → sync)
    radio.cmds.length = 0;
    h.setSat("RS-44");
    ic.resetOffsets();
    for (let i = 0; i < 80 && ic.getRadioState().syncNeeded; i++) {
      await ic.pushFrequencies(145965000, 435640000); await sleep(40);
    }
    for (let i = 0; i < 4; i++) { await ic.pushFrequencies(145965000 + i * 50, 435640000 - i * 20); await sleep(550); }
    assert.strictEqual(radio.sat, true, "SAT ON for RS-44");
    assert.strictEqual(radio.cmds.filter((c) => c === "16,5a,1").length, 1, "SAT ON once: " + radio.cmds.filter((c) => c.startsWith("16,5a")).join("|"));
    assert.strictEqual(band(radio.main), "70cm", "MAIN UHF (DL)");
    assert.strictEqual(band(radio.sub), "2m", "SUB VHF (UL)");
  } finally { console.log = oL; console.warn = oW; ic.close(); }
});
