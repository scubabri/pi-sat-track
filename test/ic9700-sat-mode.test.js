// IC-9700 Satellite mode: MAIN=DL every Doppler tick; SUB=UL only on
// open/resync and when ulFine changes. Dial absorb on MAIN.
// Run: node --test test/
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
const radio = {
  main: 144000000, sub: 435000000, sel: "main",
  writes: [], // { vfo, hz, t }
  cmds: [], // raw CI-V command first bytes e.g. "16,5a,1"
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
    radio.cmds.push([c, ...d].map((x) => x.toString(16)).join(","));
    if (c === 0x07 && d[0] === 0xd0) radio.sel = "main";
    else if (c === 0x07 && d[0] === 0xd1) radio.sel = "sub";
    else if (c === 0x07 && d[0] === 0xb0) [radio.main, radio.sub] = [radio.sub, radio.main];
    else if (c === 0x05) {
      const hz = unbcd(d.slice(0, 5));
      // SAT tracking: writing MAIN moves SUB by the same delta (NOR).
      // We do not simulate REV; tests only care which VFO we write.
      if (radio.sel === "main" && radio._track) {
        const dlt = hz - radio.main;
        radio.sub += dlt;
      }
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
  "JO-97": { modes: [{ mode: "SSB" }] },
});
const ic = require("../lib/radios/ic9700");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("SAT ON: MAIN every tick, SUB only on open and ulFine", async () => {
  const origWarn = console.warn;
  const warns = [];
  console.warn = (...a) => warns.push(a.join(" "));
  console.log = () => {};
  try {
    ic.init({
      getContext: () => ({ currentSatKey: "JO-97", currentModeIndex: 0 }),
    });
    ic.setLock(false);
    ic.setRadio(true);
    let t = 0;
    const dopDl = () => 145870000 - t * 50;
    const dopUl = () => 435100000 + t * 150;
    // Open / sync: both written
    for (let i = 0; i < 80 && ic.getRadioState().syncNeeded; i++) {
      await ic.pushFrequencies(dopUl(), dopDl());
      await sleep(50);
    }
    await sleep(200);
    assert.ok(radio.cmds.some((c) => c === "16,5a,1"), "SAT ON sent");
    assert.ok(
      warns.some((w) => /TRACKING to REV/.test(w)),
      "NOR/REV warning for inverting: " + warns.join("|"),
    );
    const afterOpen = radio.writes.slice();
    assert.ok(afterOpen.some((w) => w.vfo === "main"), "MAIN written on open");
    assert.ok(afterOpen.some((w) => w.vfo === "sub"), "SUB written on open");
    const subOpenCount = afterOpen.filter((w) => w.vfo === "sub").length;

    // Steady Doppler ticks: only MAIN
    radio.writes.length = 0;
    for (let i = 0; i < 8; i++) {
      t += 1;
      await ic.pushFrequencies(dopUl(), dopDl());
      await sleep(280);
    }
    const steady = radio.writes.slice();
    assert.ok(steady.some((w) => w.vfo === "main"), "MAIN Doppler writes");
    assert.strictEqual(
      steady.filter((w) => w.vfo === "sub").length,
      0,
      "no SUB during steady Doppler: " + JSON.stringify(steady),
    );

    // UL fine → one SUB write
    radio.writes.length = 0;
    ic.adjustFine(100, "ul");
    await ic.pushFrequencies(dopUl() + 100, dopDl());
    await sleep(400);
    await ic.pushFrequencies(dopUl() + 100, dopDl());
    await sleep(280);
    const afterFine = radio.writes.slice();
    const subAfter = afterFine.filter((w) => w.vfo === "sub");
    assert.ok(subAfter.length >= 1, "SUB rewritten on ulFine");
    // Further ticks: no more SUB
    radio.writes.length = 0;
    for (let i = 0; i < 4; i++) {
      t += 1;
      await ic.pushFrequencies(dopUl() + 100, dopDl());
      await sleep(280);
    }
    assert.strictEqual(
      radio.writes.filter((w) => w.vfo === "sub").length,
      0,
      "no further SUB after ulFine absorbed",
    );
    void subOpenCount;
  } finally {
    console.warn = origWarn;
    ic.close();
  }
});

test("SAT MAIN dial settle: no snap-back, single absorb", async () => {
  console.log = () => {};
  console.warn = () => {};
  try {
    // Fresh driver state via close/reopen
    ic.init({
      getContext: () => ({ currentSatKey: "JO-97", currentModeIndex: 0 }),
    });
    ic.setLock(false);
    ic.resetOffsets();
    ic.setRadio(true);
    let ticking = true;
    const t0 = Date.now();
    const dopDl = () => 145870000 + Math.round((Date.now() - t0) * -0.5);
    const loop = (async () => {
      while (ticking) {
        const m = ic.getRadioState().manualDlOffset || 0;
        // UL Doppler ignored on tick (SUB not rewritten); still pass a value
        await ic.pushFrequencies(435100000 - m, dopDl() + m);
        await sleep(250);
      }
    })();
    for (let i = 0; i < 80 && ic.getRadioState().syncNeeded; i++) await sleep(50);
    await sleep(800);
    assert.ok(!ic.getRadioState().syncNeeded);

    const startDial = radio.main;
    const tStart = Date.now();
    let dial = startDial;
    for (let i = 0; i < 10; i++) {
      dial += 2000;
      radio.main = dial;
      await sleep(150);
    }
    const tStop = Date.now();
    await sleep(2200);

    const during = radio.writes.filter(
      (w) => w.t > tStart + 300 && w.t < tStop + 900 && w.vfo === "main",
    );
    assert.deepStrictEqual(during, [], "MAIN snap-back during tuning: " + JSON.stringify(during));
    const m = ic.getRadioState().manualDlOffset || 0;
    assert.ok(m > 19000 && m < 24000, "full delta absorbed: " + m);

    await sleep(1000);
    const after = radio.writes.filter((w) => w.t > tStop + 900 && w.vfo === "main");
    assert.ok(after.length > 0, "MAIN Doppler resumed");
    assert.ok(Math.abs(radio.main - (dopDl() + m)) < 800, "MAIN tracks Doppler+manual");
    ticking = false;
    await loop;
  } finally {
    ic.close();
  }
});
