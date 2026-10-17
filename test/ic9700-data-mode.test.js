// IC-9700 data mode (-D): 0x06 mode write followed by 1A 06 <data> <fil>.
// Run: node --test --test-force-exit test/ic9700-data-mode.test.js
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
const radio = { main: 435600000, mainB: 435600000, sub: 145900000, sel: "main", vfo: "A", sat: true, split: false, cmds: [], writes: [] };
const setSel = (hz) => {
  if (radio.sel === "main" && radio.vfo === "B") { radio.mainB = hz; radio.writes.push({ vfo: "mainB", hz, t: Date.now() }); return; }
  const other = radio.sel === "main" ? "sub" : "main";
  // 9700: MAIN and SUB can't share a band → the other VFO is pushed off
  // (this is how SAT-on simplex ended up on UHF).
  if (band(hz) === band(radio[other])) radio[other] = band(hz) === "2m" ? 435600000 : 145900000;
  radio[radio.sel] = hz;
  radio.writes.push({ vfo: radio.sel, hz, t: Date.now() });
};
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
    else if (c === 0x07 && d[0] === 0x00) radio.vfo = "A";
    else if (c === 0x07 && d[0] === 0x01) radio.vfo = "B";
    else if (c === 0x07 && d[0] === 0xb0) [radio.main, radio.sub] = [radio.sub, radio.main];
    else if (c === 0x0f) radio.split = d[0] === 1;
    else if (c === 0x16 && d[0] === 0x5a) radio.sat = d[1] === 1;
    else if (c === 0x05) setSel(unbcd(d.slice(0, 5)));
    else if (c === 0x25 && d.length > 1) {
      // 0x25 0x01 = unselected VFO (VFO B while A selected)
      const hz = unbcd(d.slice(1, 6));
      if (d[0] === 1 && radio.sel === "main" && radio.vfo === "A") { radio.mainB = hz; radio.writes.push({ vfo: "mainB", hz, t: Date.now() }); }
      else setSel(hz);
    } else if (c === 0x03) rep = [0x03, ...bcd(radio.sel === "main" && radio.vfo === "B" ? radio.mainB : radio[radio.sel])];
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
  "RS-44": { modes: [{ mode: "SSB", uplink: "145.935-145.995", downlink: "435.610-435.670" }] },
  "SO-50": { modes: [{ mode: "FM", uplink: "145.850", downlink: "436.795" }] },
});
const ic = require("../lib/radios/ic9700");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let sel = "RS-44";
ic.init({ getContext: () => ({ currentSatKey: sel, currentModeIndex: 0 }) });

/** [mode, dataCmd] pairs: each "6,<md>,1" followed by its "1a,6,.." write. */
function modeWrites(cmds) {
  const out = [];
  cmds.forEach((c, i) => { if (/^6,[0-9a-f]+,1$/.test(c)) out.push([c, cmds[i + 1]]); });
  return out;
}
async function settle(ul, dl, n = 80) {
  for (let i = 0; i < n && ic.getRadioState().syncNeeded; i++) { await ic.pushFrequencies(ul, dl); await sleep(40); }
  await ic.pushFrequencies(ul, dl); await sleep(600);
  await ic.pushFrequencies(ul, dl); await sleep(50);
}
async function withLogs(fn) {
  const oL = console.log, oW = console.warn; console.log = () => {}; console.warn = () => {};
  try { await fn(); } finally { console.log = oL; console.warn = oW; }
}

test("status advertises supportsDataMode and dataMode; export exists", () => {
  assert.strictEqual(typeof ic.setDataMode, "function");
  assert.strictEqual(ic.getRadioState().supportsDataMode, true);
  assert.strictEqual(ic.getRadioState().dataMode, false);
  assert.strictEqual(ic.statusPayload().supportsDataMode, true);
  ic.setDataMode(true);
  assert.strictEqual(ic.getRadioState().dataMode, true);
  assert.strictEqual(ic.statusPayload().dataMode, true);
  ic.setDataMode(false);
});

test("SAT linear RS-44: data OFF → 1A 06 00 00; data ON → LSB-D/USB-D (1A 06 01 01) resent promptly", () => withLogs(async () => {
  sel = "RS-44"; ic.setDataMode(false); ic.setLock(false); ic.setRadio(true);
  radio.cmds.length = 0;
  await settle(145965000, 435640000);
  let mw = modeWrites(radio.cmds);
  assert.ok(mw.some(([m]) => m === "6,0,1") && mw.some(([m]) => m === "6,1,1"), JSON.stringify(mw));
  assert.ok(mw.every(([, d]) => d === "1a,6,0,0"), "data off: " + JSON.stringify(mw));
  // Toggle ON while engaged: both UL (LSB) and DL (USB) resent with data bit.
  radio.cmds.length = 0;
  ic.setDataMode(true);
  await ic.pushFrequencies(145965100, 435639980); await sleep(50);
  mw = modeWrites(radio.cmds);
  assert.ok(mw.some(([m, d]) => m === "6,0,1" && d === "1a,6,1,1"), "UL LSB-D: " + JSON.stringify(radio.cmds));
  assert.ok(mw.some(([m, d]) => m === "6,1,1" && d === "1a,6,1,1"), "DL USB-D: " + JSON.stringify(radio.cmds));
  assert.ok(mw.every(([, d]) => d === "1a,6,1,1"));
  // No re-send loop on the next tick
  radio.cmds.length = 0;
  await sleep(600); await ic.pushFrequencies(145965200, 435639960); await sleep(50);
  assert.strictEqual(modeWrites(radio.cmds).length, 0, JSON.stringify(radio.cmds));
  // Toggle OFF → resent with data off
  radio.cmds.length = 0;
  ic.setDataMode(false);
  await ic.pushFrequencies(145965300, 435639940); await sleep(50);
  mw = modeWrites(radio.cmds);
  assert.ok(mw.length >= 2 && mw.every(([, d]) => d === "1a,6,0,0"), JSON.stringify(radio.cmds));
  ic.close();
}));

test("FM sat SO-50 with data ON → FM-D on UL and DL", () => withLogs(async () => {
  sel = "SO-50"; ic.setDataMode(true); ic.setLock(false); ic.setRadio(true);
  radio.cmds.length = 0;
  await settle(145850000, 436795000);
  const mw = modeWrites(radio.cmds);
  assert.ok(mw.filter(([m]) => m === "6,5,1").length >= 2, JSON.stringify(mw));
  assert.ok(mw.every(([, d]) => d === "1a,6,1,1"), JSON.stringify(mw));
  ic.setDataMode(false); ic.close();
}));

test("simplex split ISS with data ON → VFO A and VFO B (07 01 … 06 05 01, 1A 06 01 01)", () => withLogs(async () => {
  sel = "ISS"; ic.setDataMode(true); ic.setLock(false); ic.setRadio(true);
  radio.cmds.length = 0;
  await settle(145822000, 145828000);
  const i = radio.cmds.indexOf("7,1");
  assert.ok(i >= 0, JSON.stringify(radio.cmds));
  assert.deepStrictEqual(radio.cmds.slice(i + 1, i + 3), ["6,5,1", "1a,6,1,1"], JSON.stringify(radio.cmds));
  const mw = modeWrites(radio.cmds);
  assert.ok(mw.length >= 2 && mw.every(([, d]) => d === "1a,6,1,1"), JSON.stringify(mw));
  // Data OFF in simplex → VFO B data off
  radio.cmds.length = 0;
  ic.setDataMode(false);
  await ic.pushFrequencies(145822100, 145827900); await sleep(50);
  const j = radio.cmds.indexOf("7,1");
  assert.ok(j >= 0 && radio.cmds.slice(j + 1, j + 3).join(" ") === "6,5,1 1a,6,0,0", JSON.stringify(radio.cmds));
  ic.close();
}));
