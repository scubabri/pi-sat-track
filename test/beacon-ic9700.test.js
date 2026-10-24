// IC-9700 single radio, catalog "Beacon CW" entry (DL-only, lib/catalog.js
// addBeaconModes): MAIN = beacon DL in CW, SUB (UL/TX) never written —
// same as the existing DL-only (TLM/SSTV) path.
// Run: node --test --test-force-exit test/beacon-ic9700.test.js
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
  "RS-44": {
    modes: [
      { mode: "SSB CW*", uplink: "145.935-145.995", downlink: "435.670-435.610" },
      { mode: "Beacon CW", uplink: "", downlink: "435.605" },
    ],
  },
});
const ic = require("../lib/radios/ic9700");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("Beacon CW: MAIN = DL in CW, no SUB / TX writes", async () => {
  const ol = console.log, ow = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    ic.init({ getContext: () => ({ currentSatKey: "RS-44", currentModeIndex: 1 }) });
    ic.setLock(true);
    ic.setRadio(true);
    for (let i = 0; i < 80 && ic.getRadioState().syncNeeded; i++) {
      await ic.pushFrequencies(null, 435606000);
      await sleep(50);
    }
    for (let i = 0; i < 6; i++) {
      await ic.pushFrequencies(null, 435606000 - i * 20);
      await sleep(250);
    }
    const main = radio.writes.filter((w) => w.vfo === "main");
    assert.ok(main.length >= 1, "MAIN written");
    assert.ok(Math.abs(main[main.length - 1].hz - 435605900) < 50, "MAIN at beacon DL");
    assert.strictEqual(radio.writes.filter((w) => w.vfo === "sub").length, 0, "SUB (UL/TX) never written");
    // CI-V 0x06 (mode) 0x03 = CW
    assert.ok(radio.cmds.some((c) => /^6,3\b/.test(c)), "CW mode set: " + radio.cmds.filter((c) => c.startsWith("6,")).join("|"));
    assert.ok(!radio.cmds.some((c) => /^6,0\b/.test(c)), "never LSB (no UL mode)");
  } finally {
    console.log = ol;
    console.warn = ow;
    ic.close();
  }
});
