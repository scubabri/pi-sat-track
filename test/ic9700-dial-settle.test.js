// IC-9700 linear (SAT OFF, dualwatch) dial follow: operator turns the DL
// (SUB) knob while 250 ms Doppler ticks run. Must not snap the dial back,
// must absorb the full delta once after the dial settles, then resume
// Doppler (DL and inverting UL) from the new point.
// Run: node --test test/
const test = require("node:test");
const assert = require("assert");
const path = require("path");

// ── Fake config (single radio, no CAT2) ──
const cfgPath = require.resolve(path.join(__dirname, "../lib/config"));
require.cache[cfgPath] = {
  id: cfgPath, filename: cfgPath, loaded: true,
  exports: {
    CAT_DEVICE: "/dev/fake9700", CAT_BAUD: 19200, CAT_CIV_ADDR: 0xa2,
    CAT2_DEVICE: "", isDualCat: () => false, RADIO_TRANSPORT: "serial",
  },
};

// ── Simulated IC-9700 on a fake serial port ──
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
const radio = {
  main: 144000000, sub: 435000000, sel: "main",
  writes: [], // { vfo, hz, t }
};
class FakePort {
  constructor() { this.h = {}; }
  open(cb) { setImmediate(() => cb(null)); }
  on(ev, fn) { this.h[ev] = fn; }
  removeAllListeners() { this.h = {}; }
  close() {}
  drain(cb) { cb(); }
  write(data, cb) {
    const body = [...data.slice(4, data.length - 1)];
    const ok = [0xfb];
    let rep = ok;
    const [c, ...d] = body;
    if (c === 0x07 && d[0] === 0xd0) radio.sel = "main";
    else if (c === 0x07 && d[0] === 0xd1) radio.sel = "sub";
    else if (c === 0x07 && d[0] === 0xb0) [radio.main, radio.sub] = [radio.sub, radio.main];
    else if (c === 0x05) {
      const hz = unbcd(d.slice(0, 5));
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
const ic = require("../lib/radios/ic9700");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// JO-97-ish inverting linear: UL 435.1 LSB, DL 145.87 USB.
// state.js: DL = dopDl + manual; inverting UL = dopUl - manual.
const t0 = Date.now();
const dopDl = () => 145870000 + Math.round((Date.now() - t0) * -0.5); // −500 Hz/s
const dopUl = () => 435100000 + Math.round((Date.now() - t0) * 1.5);
const manual = () => ic.getRadioState().manualDlOffset || 0;
let ticking = true;
async function tickLoop() {
  while (ticking) {
    await ic.pushFrequencies(dopUl() - manual(), dopDl() + manual());
    await sleep(250);
  }
}

test("knob turn during Doppler: no snap-back, single full absorb, Doppler resumes", async () => {
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => { logs.push(a.join(" ")); };
  try {
    ic.init({ getContext: () => ({ currentSatKey: null, currentModeIndex: 0 }) });
    ic.setLock(false);
    ic.setRadio(true);
    const loop = tickLoop();
    // Let sync finish and Doppler settle in the linear layout
    for (let i = 0; i < 60 && ic.getRadioState().syncNeeded; i++) await sleep(100);
    await sleep(1500);
    assert.ok(!ic.getRadioState().syncNeeded, "sync cleared");
    assert.ok(Math.abs(radio.sub - dopDl()) < 1000, "SUB carries DL " + radio.sub);
    assert.ok(Math.abs(radio.main - dopUl()) < 1000, "MAIN carries UL " + radio.main);
    assert.strictEqual(manual(), 0);

    // Operator turns SUB knob +20 kHz in 2 kHz steps every 150 ms
    const startDial = radio.sub;
    const tStart = Date.now();
    let dial = startDial;
    for (let i = 0; i < 10; i++) {
      dial += 2000;
      radio.sub = dial;
      await sleep(150);
    }
    const tStop = Date.now();
    // Knob released. Wait past settle window
    await sleep(2200);

    // No tracker writes to SUB (snap-back) and no UL writes while knob moving
    // or within the settle window (allow one write already in flight at start)
    const during = radio.writes.filter((w) => w.t > tStart + 300 && w.t < tStop + 900);
    assert.deepStrictEqual(during, [], "writes during tuning: " + JSON.stringify(during));

    const absorbs = logs.filter((l) => /VFO DL .*→ manual/.test(l));
    assert.strictEqual(absorbs.length, 1, "exactly one absorb: " + absorbs.join(" | "));
    const m = manual();
    // Full delta = dial − Doppler DL at absorb (Doppler drifts −500 Hz/s
    // during the ~2.5 s turn+settle, so a bit over +20 kHz)
    assert.ok(m > 19000 && m < 24000, "full delta absorbed: " + m);

    // Doppler resumed from the new point: SUB near Doppler+manual (≈ dial),
    // no snap back to the pre-turn frequency; UL moved opposite (inverting)
    await sleep(1000);
    const after = radio.writes.filter((w) => w.t > tStop + 900);
    assert.ok(after.some((w) => w.vfo === "sub"), "DL Doppler resumed");
    assert.ok(after.some((w) => w.vfo === "main"), "UL Doppler resumed");
    assert.ok(Math.abs(radio.sub - (dopDl() + m)) < 600, "SUB tracks Doppler+manual");
    assert.ok(Math.abs(radio.sub - dial) < 3000, "no snap back: " + radio.sub + " vs dial " + dial);
    assert.ok(Math.abs(radio.main - (dopUl() - m)) < 2000, "UL inverted by manual");
    ticking = false;
    await loop;
  } finally {
    ticking = false;
    console.log = origLog;
    ic.close();
  }
});
