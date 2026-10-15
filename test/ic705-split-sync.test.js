// IC-705 native CI-V split (VFO A = DL, VFO B = UL): sync must settle.
// Reproduces field loop: endless "mode → USB/LSB attempt N" + "Icom dl busy".
// Run: node --test --test-force-exit test/ic705-split-sync.test.js
const test = require("node:test");
const assert = require("assert");
const path = require("path");

const cfgPath = require.resolve(path.join(__dirname, "../lib/config"));
require.cache[cfgPath] = {
  id: cfgPath, filename: cfgPath, loaded: true,
  exports: {
    CAT_DEVICE: "/dev/ttyACM0", CAT_BAUD: 19200, CAT_CIV_ADDR: 0xa4,
    CAT2_DEVICE: "", isDualCat: () => false, RADIO_TRANSPORT: "serial",
    TX_SPLIT: true, C_MS: 299792458,
  },
};

function unbcd(b) {
  let f = 0, m = 1;
  for (const x of b) { f += (x & 15) * m; m *= 10; f += (x >> 4) * m; m *= 10; }
  return f;
}
function bcd(hz) {
  const s = String(Math.round(hz)).padStart(10, "0");
  const out = [];
  for (let i = 0; i < 10; i += 2) out.push((+s[i] << 4) | +s[i + 1]);
  return out.reverse();
}
const radio = {
  A: { hz: 0, mode: null }, B: { hz: 0, mode: null }, sel: "A", split: false,
  cmds: [], writes: [], inflight: 0, overlap: 0,
};
const LAT = 12; // ms per CI-V reply (19200 baud-ish, slow enough to overlap ticks)
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
    radio.inflight += 1;
    if (radio.inflight > 1) radio.overlap += 1;
    let rep = [0xfb];
    const vfoOf = (s) => (s === 0x01 ? "B" : "A");
    if (c === 0x07 && (d[0] === 0x00 || d[0] === 0x01)) radio.sel = vfoOf(d[0]);
    else if (c === 0x0f) radio.split = d[0] === 0x01;
    else if (c === 0x25 && d.length === 1) rep = [0x25, d[0], ...bcd(radio[vfoOf(d[0])].hz)];
    else if (c === 0x25) {
      const v = vfoOf(d[0]);
      radio[v].hz = unbcd(d.slice(1, 6));
      radio.writes.push({ vfo: v, hz: radio[v].hz });
    } else if (c === 0x26) radio[vfoOf(d[0])].mode = d[1];
    else if (c === 0x05) radio[radio.sel].hz = unbcd(d.slice(0, 5));
    else if (c === 0x03) rep = [0x03, ...bcd(radio[radio.sel].hz)];
    const frame = Buffer.from([0xfe, 0xfe, 0xe0, 0xa4, ...rep, 0xfd]);
    cb(null);
    setTimeout(() => { radio.inflight -= 1; this.h.data && this.h.data(frame); }, LAT);
  }
}
const spPath = require.resolve("serialport");
require.cache[spPath] = { id: spPath, filename: spPath, loaded: true, exports: { SerialPort: FakePort } };

const catalog = require("../lib/catalog");
catalog.getCatalog = () => ({
  "RS-44": { modes: [{ mode: "SSB", uplink: "145.935-145.995", downlink: "435.610-435.670" }] },
});
const ic = require("../lib/radios/ic705");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("split sync settles: modes once per VFO, no busy, steady writes A each tick / B on change", async () => {
  const logs = [];
  const origLog = console.log, origWarn = console.warn;
  console.log = (...a) => logs.push(a.join(" "));
  console.warn = (...a) => logs.push("WARN " + a.join(" "));
  try {
    ic.init({ getContext: () => ({ currentSatKey: "RS-44", currentModeIndex: 0 }) });
    ic.setLock(true); // keep dial-poll out of the count
    ic.applyDefaultCtcss(null, null);
    ic.setRadio(true);
    let dlHz = 435633000, ulHz = 145967000;
    // Timer-style ticks (fire-and-forget, 100 ms) like state.js → overlaps.
    const tick = () => { ic.pushFrequencies(ulHz, dlHz); };
    for (let i = 0; i < 30; i++) { tick(); await sleep(100); }
    assert.strictEqual(ic.getRadioState().syncNeeded, false, "sync cleared: " + logs.join("\n"));
    assert.ok(logs.some((l) => /sync clear: verified streak 2/.test(l)));
    const busy = logs.filter((l) => /busy/.test(l) && /WARN/.test(l));
    assert.strictEqual(busy.length, 0, "no busy warns: " + busy.slice(0, 5).join("|"));
    assert.strictEqual(radio.overlap, 0, "no overlapping CI-V frames");
    const modeLines = logs.filter((l) => /mode →/.test(l));
    assert.deepStrictEqual(modeLines, ["Icom DL VFO A mode → USB attempt 1", "Icom DL VFO B mode → LSB attempt 1"]);
    assert.strictEqual(radio.A.mode, 0x01); // USB
    assert.strictEqual(radio.B.mode, 0x00); // LSB
    assert.ok(radio.split, "SPLIT ON");

    // Steady: DL moves each tick, UL changes every 3rd tick
    radio.writes.length = 0;
    radio.cmds.length = 0;
    let ulChanges = 0;
    for (let i = 0; i < 9; i++) {
      dlHz -= 40;
      if (i % 3 === 0) { ulHz += 120; ulChanges++; }
      await ic.pushFrequencies(ulHz, dlHz);
      await sleep(30);
    }
    const aW = radio.writes.filter((w) => w.vfo === "A").length;
    const bW = radio.writes.filter((w) => w.vfo === "B").length;
    assert.strictEqual(aW, 9, "VFO A each tick");
    assert.strictEqual(bW, ulChanges, "VFO B only on change");
    assert.ok(!radio.cmds.some((c) => c.startsWith("26,")), "no mode resend in steady state");
    assert.ok(!radio.cmds.some((c) => c.startsWith("7,")), "no VFO swaps in steady state");
    assert.strictEqual(radio.A.hz, dlHz);
    assert.strictEqual(radio.B.hz, ulHz);
  } finally {
    console.log = origLog; console.warn = origWarn;
    ic.close();
  }
});

test("split dial turn on VFO A: absorbed, held while moving, no snap-back", async () => {
  const logs = [];
  const origLog = console.log, origWarn = console.warn;
  console.log = (...a) => logs.push(a.join(" "));
  console.warn = (...a) => logs.push("WARN " + a.join(" "));
  try {
    ic.init({ getContext: () => ({ currentSatKey: "RS-44", currentModeIndex: 0 }) });
    ic.resetOffsets();
    ic.setLock(false); // linear default: unlocked
    ic.setRadio(true);
    let dlD = 435633000, ulD = 145967000; // Doppler-only
    // state.js race: freq computed from offset as of end of previous tick.
    const tick = async () => {
      const m = ic.getRadioState().manualDlOffset || 0;
      dlD -= 40; ulD += 120;
      await ic.pushFrequencies(ulD - m, dlD + m);
      await sleep(30);
    };
    for (let i = 0; i < 40 && ic.getRadioState().syncNeeded; i++) await tick();
    for (let i = 0; i < 5; i++) await tick();
    assert.ok(!logs.some((l) => /dial absorb/.test(l)), "no misfire on own writes/VFO B: " + logs.join("\n"));
    assert.strictEqual(radio.sel, "A", "VFO A selected for 0x03 readback");
    const preSpin = radio.A.hz;
    const wIdx = radio.writes.length;
    for (let i = 0; i < 4; i++) { radio.A.hz += 1500; await tick(); }
    const dialAtStop = radio.A.hz;
    for (let i = 0; i < 5; i++) await tick();
    const aWrites = radio.writes.slice(wIdx).filter((w) => w.vfo === "A").map((w) => w.hz);
    for (const hz of aWrites) {
      assert.ok(hz > dialAtStop - 1000, "VFO A snapped back toward " + preSpin + ": " + aWrites.join(","));
    }
    assert.ok(aWrites.length >= 1, "DL written after settle");
    const m = ic.getRadioState().manualDlOffset;
    assert.ok(Math.abs(m - 6000) <= 500, "offset ~ +6000: " + m);
    assert.strictEqual(radio.A.hz, dlD + m, "VFO A holds absorbed offset");
    assert.ok(logs.some((l) => /^IC705 dial absorb DL/.test(l)));
    assert.ok(logs.some((l) => /^IC705 dial settled DL/.test(l)));
    assert.ok(logs.some((l) => /^IC705 dl write after absorb/.test(l)));
    assert.strictEqual(radio.B.hz, ulD - m, "VFO B follows offset (inverted)");
  } finally {
    console.log = origLog; console.warn = origWarn;
    ic.close();
  }
});
