// TS-2000 ASCII CAT: mode map, TN codes, split/simplex, VFO-B cache, queue, dial lag.
// Run: node --test --test-force-exit test/ts2000.test.js
const test = require("node:test");
const assert = require("assert");
const path = require("path");

const cfgPath = require.resolve(path.join(__dirname, "../lib/config"));
require.cache[cfgPath] = {
  id: cfgPath,
  filename: cfgPath,
  loaded: true,
  exports: {
    CAT_DEVICE: "/dev/ttyUSB0",
    CAT_BAUD: 9600,
    CAT2_DEVICE: "",
    isDualCat: () => false,
    RADIO_TRANSPORT: "serial",
    SERIAL_MAKE: "kenwood",
    TX_SPLIT: true,
    C_MS: 299792458,
  },
};

/** Simulated TS-2000 */
const radio = {
  fa: 145000000,
  fb: 435000000,
  fr: 0, // 0=A 1=B
  ft: 0,
  mdA: "2",
  mdB: "1",
  tn: "01",
  to: "0",
  ct: "0",
  sa: "0",
  saFull: "00000000",
  dc: "00",
  cmds: [],
  inflight: 0,
  overlap: 0,
  replies: [],
};

class FakePort {
  constructor() {
    this.h = {};
    this.isOpen = false;
  }
  open(cb) {
    this.isOpen = true;
    setImmediate(() => cb(null));
  }
  on(ev, fn) {
    this.h[ev] = fn;
  }
  removeAllListeners() {
    this.h = {};
  }
  close(cb) {
    this.isOpen = false;
    if (cb) cb();
  }
  drain(cb) {
    cb();
  }
  set(_opts, cb) {
    if (cb) cb(null);
  }
  write(data, cb) {
    const s = data.toString("ascii");
    radio.inflight += 1;
    if (radio.inflight > 1) radio.overlap += 1;
    const parts = s.split(";").filter(Boolean);
    let reply = "";
    for (const cmd of parts) {
      radio.cmds.push(cmd);
      const up = cmd.toUpperCase();
      if (up === "FA") {
        reply += "FA" + String(radio.fa).padStart(11, "0") + ";";
      } else if (up.startsWith("FA") && up.length > 2) {
        radio.fa = parseInt(up.slice(2), 10);
        reply += ";"; // set ack empty-ish — kenwood often silent on set
      } else if (up === "FB") {
        reply += "FB" + String(radio.fb).padStart(11, "0") + ";";
      } else if (up.startsWith("FB") && up.length > 2) {
        radio.fb = parseInt(up.slice(2), 10);
      } else if (up.startsWith("FR")) {
        radio.fr = parseInt(up.slice(2), 10) || 0;
      } else if (up.startsWith("FT")) {
        radio.ft = parseInt(up.slice(2), 10) || 0;
      } else if (up === "DC") {
        reply += "DC" + radio.dc + ";";
      } else if (up.startsWith("DC") && up.length === 4 && radio.dcLocked) {
        // real radio in SAT: DC change ignored
      } else if (up.startsWith("DC") && up.length === 4) {
        // Kenwood: P1 change forces P2 = P1
        radio.dc = up[2] !== radio.dc[0] ? up[2] + up[2] : up.slice(2);
      } else if (up === "MD" && radio.sa === "1") {
        reply += "MD" + (radio.dc[1] === "1" || radio.saFull[3] === "1" ? radio.mdB : radio.mdA) + ";";
      } else if (up.startsWith("MD") && up.length === 3 && radio.sa === "1") {
        // SATL: MD acts on control band (DC P2 or SA P4)
        if (radio.dc[1] === "1" || radio.saFull[3] === "1") radio.mdB = up.slice(2);
        else radio.mdA = up.slice(2);
      } else if (up.startsWith("TN") && up.length === 4 && radio.sa === "1" && radio.dc[1] !== "1") {
        radio.tnMain = up.slice(2);
      } else if (false) {
        radio.tnMain = up.slice(2);
      } else if (up.startsWith("MD") && up.length === 3) {
        if (radio.fr === 1) radio.mdB = up.slice(2);
        else radio.mdA = up.slice(2);
      } else if (up === "MD") {
        reply += "MD" + (radio.fr === 1 ? radio.mdB : radio.mdA) + ";";
      } else if (up.startsWith("TN") && up.length === 4) {
        radio.tn = up.slice(2);
      } else if (up === "TN") {
        reply += "TN" + radio.tn + ";";
      } else if (up === "TO") {
        reply += "TO" + radio.to + ";";
      } else if (up.startsWith("TO") && up.length >= 3) {
        radio.to = up.slice(2);
      } else if (up.startsWith("CT")) {
        radio.ct = up.slice(2);
      } else if (up === "SA") {
        reply += "SA" + radio.saFull + ";";
      } else if (up.startsWith("SA") && up.length > 2 && (radio.rejectSa || (up.length !== 3 && up.length !== 9))) {
        reply += "?;"; // real TS-2000: SA set is SA + 7 digits (or SA0)
      } else if (up.startsWith("MD") && up.length === 3 && radio.rejectMd) {
        reply += "?;";
      } else if (up.startsWith("SA") && up.length > 2) {
        radio.sa = up.slice(2, 3);
        if (radio.sa === "1") radio.dc = "10";
        radio.saFull = up.slice(2).padEnd(8, "0").slice(0, 8);
      }
    }
    radio.replies.push(reply);
    cb(null);
    const LAT = 15;
    setTimeout(() => {
      radio.inflight -= 1;
      if (reply && this.h.data) this.h.data(Buffer.from(reply, "ascii"));
    }, LAT);
  }
}

const spPath = require.resolve("serialport");
require.cache[spPath] = {
  id: spPath,
  filename: spPath,
  loaded: true,
  exports: { SerialPort: FakePort },
};

const catalog = require("../lib/catalog");
catalog.getCatalog = () => ({
  "SO-50": {
    modes: [{ mode: "FM", uplink: "145.850", downlink: "436.795" }],
  },
  "RS-44": {
    modes: [
      {
        mode: "SSB",
        uplink: "145.935-145.995",
        downlink: "435.610-435.670",
      },
    ],
  },
  ISS: {
    modes: [{ mode: "FM", uplink: "145.825", downlink: "145.825" }],
  },
});

// Fresh module load
const tsPath = require.resolve("../lib/radios/ts2000");
delete require.cache[tsPath];
const ts = require("../lib/radios/ts2000");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resetRadio() {
  radio.fa = 145000000;
  radio.fb = 435000000;
  radio.fr = 0;
  radio.ft = 0;
  radio.mdA = "2";
  radio.mdB = "1";
  radio.tn = "01";
  radio.to = "0";
  radio.ct = "0";
  radio.sa = "0";
  radio.saFull = "00000000";
  radio.dc = "00";
  radio.tnMain = null;
  radio.rejectSa = false;
  radio.dcLocked = false;
  radio.rejectMd = false;
  radio.cmds = [];
  radio.overlap = 0;
  radio.replies = [];
}

test("modesForCatalogMode: FM / CW / SSB word boundaries", () => {
  const { modesForCatalogMode } = ts._test;
  assert.strictEqual(modesForCatalogMode("FM").ul, "4");
  assert.strictEqual(modesForCatalogMode("FM Voice").dlName, "FM");
  assert.strictEqual(modesForCatalogMode("CW").ul, "3");
  // SSB CW* linear stays SSB (LSB/USB)
  const lin = modesForCatalogMode("SSB CW*");
  assert.strictEqual(lin.ul, "1");
  assert.strictEqual(lin.dl, "2");
  assert.strictEqual(modesForCatalogMode("USB").ulName, "LSB"); // default linear pair
});

test("toneCode: Hamlib 38-tone 1-based, no 69.3", () => {
  const { toneCode, TONE_TABLE } = ts._test;
  assert.strictEqual(TONE_TABLE.length, 38);
  assert.ok(!TONE_TABLE.includes(69.3));
  assert.strictEqual(toneCode(67.0), 1);
  assert.strictEqual(toneCode(71.9), 2);
  assert.strictEqual(toneCode(88.5), 8);
  assert.strictEqual(toneCode(250.3), 38);
  // 69.3 is not in table — nearest is 67.0 or 71.9; within 1 Hz? 2.3 > 1 → null
  assert.strictEqual(toneCode(69.3), null);
});

test("replyLooksBad detects ?; E; O;", () => {
  const { replyLooksBad } = ts._test;
  assert.strictEqual(replyLooksBad("?;"), true);
  assert.strictEqual(replyLooksBad("E;"), true);
  assert.strictEqual(replyLooksBad("O;"), true);
  assert.strictEqual(replyLooksBad("FA00014500000;"), false);
});

test("SAT mode: SA1010000, MAIN=DL FA, SUB=UL FB, MAIN MD only, cached", async () => {
  resetRadio();
  ts.init({
    getContext: () => ({
      currentSatKey: "RS-44",
      currentModeIndex: 0,
      satrec: null,
      observer: null,
    }),
    broadcast: () => {},
  });
  ts.setRadio(true);
  await sleep(80);
  radio.cmds = [];

  const ul = 145950000;
  const dlHz = 435640000;
  await ts.pushFrequencies(ul, dlHz);
  await sleep(200);
  const mdFirst = radio.cmds.filter((c) => /^MD/i.test(c) && c.length === 3).length;
  assert.strictEqual(radio.sa, "1", "SAT on");
  assert.ok(radio.cmds.includes("SA1010000"), "7-digit SA set");
  assert.ok(ts._test.getSatOn());
  assert.strictEqual(radio.fa, dlHz, "MAIN = DL via FA");
  assert.strictEqual(radio.fb, ul, "SUB = UL via FB");
  assert.strictEqual(radio.mdA, "2", "DL USB on MAIN");
  assert.ok(!radio.cmds.some((c) => /^DC\d/i.test(c) || /^SA1011/i.test(c)), "no control switching");
  assert.strictEqual(radio.dc[1], "0", "CTRL restored to MAIN");
  assert.ok(!radio.cmds.some((c) => /^F[RT]\d/i.test(c)), "no FR/FT in SATL");
  assert.strictEqual(mdFirst, 1, "MD for MAIN only");

  radio.cmds = [];
  // Same freqs again — caches should skip FR1/MD for B and FA/FB
  await ts.pushFrequencies(ul, dlHz);
  await sleep(200);
  const fr1Second = radio.cmds.filter((c) => c.toUpperCase() === "FR1").length;
  const mdSecond = radio.cmds.filter((c) => /^MD[0-9]/i.test(c)).length;
  assert.strictEqual(fr1Second, 0, "no FR1 on unchanged tick");
  assert.strictEqual(mdSecond, 0, "no MD on unchanged tick");
  // Slight UL change → FB only, still no mode churn
  radio.cmds = [];
  await ts.pushFrequencies(ul + 50, dlHz);
  await sleep(200);
  assert.strictEqual(
    radio.cmds.filter((c) => c.toUpperCase() === "FR1").length,
    0,
  );
  assert.ok(radio.cmds.some((c) => /^FB/i.test(c)), "FB for UL delta");
});

test("simplex ISS: split off, VFO A only", async () => {
  resetRadio();
  ts.close();
  ts.init({
    getContext: () => ({
      currentSatKey: "ISS",
      currentModeIndex: 0,
      satrec: null,
      observer: null,
    }),
    broadcast: () => {},
  });
  ts.setRadio(true);
  await sleep(80);
  radio.cmds = [];
  const f = 145825000;
  await ts.pushFrequencies(f, f);
  await sleep(250);
  assert.strictEqual(ts._test.getSimplexActive(), true);
  assert.strictEqual(radio.ft, 0, "FT0 simplex");
  assert.ok(radio.cmds.some((c) => /^FA/i.test(c) && c.length > 2));
  // No FB set for simplex
  const fbSets = radio.cmds.filter((c) => /^FB\d/i.test(c));
  assert.strictEqual(fbSets.length, 0, "no VFO B write in simplex");
});

test("queue: overlapping push+poll does not drop (no overlap writes)", async () => {
  resetRadio();
  ts.close();
  ts.init({
    getContext: () => ({
      currentSatKey: "SO-50",
      currentModeIndex: 0,
      satrec: null,
      observer: null,
    }),
    broadcast: () => {},
  });
  ts.setRadio(true);
  await sleep(80);
  radio.overlap = 0;
  const p1 = ts.pushFrequencies(145850000, 436795000);
  const p2 = ts.pushFrequencies(145850100, 436795100);
  await Promise.all([p1, p2]);
  await sleep(300);
  assert.strictEqual(radio.overlap, 0, "serialized — never two writes at once");
});

test("CTCSS 67.0 → TN01 TO1 CT0 + readback clears toneError", async () => {
  resetRadio();
  ts.close();
  ts.init({
    getContext: () => ({
      currentSatKey: "SO-50",
      currentModeIndex: 0,
      satrec: null,
      observer: null,
    }),
    broadcast: () => {},
  });
  ts.setRadio(true);
  await sleep(80);
  ts.applyDefaultCtcss(67.0, null);
  ts.setCtcss("access");
  await sleep(1500);
  assert.ok(radio.cmds.some((c) => c.toUpperCase() === "CT0"));
  assert.ok(radio.cmds.some((c) => c.toUpperCase() === "TN01"));
  assert.ok(radio.cmds.some((c) => c.toUpperCase() === "TO1"));
  assert.strictEqual(radio.tn, "01");
  assert.strictEqual(radio.to, "1");
  assert.strictEqual(ts._test.getToneError(), null);
});

test("dial absorb ignores CAT lag (readback equals last commanded)", async () => {
  resetRadio();
  ts.close();
  let lastStatus = null;
  ts.init({
    getContext: () => ({
      currentSatKey: "RS-44",
      currentModeIndex: 0,
      satrec: {
        // minimal stub — poll path needs satrec; push absorb uses corridor
      },
      observer: {},
    }),
    broadcast: (s) => {
      lastStatus = s;
    },
  });
  ts.setRadio(true);
  await sleep(80);
  ts.setLock(false);
  const dl0 = 435640000;
  await ts.pushFrequencies(145950000, dl0);
  await sleep(200);
  const off0 = ts._test.getManualDlOffset();
  // Radio still reports commanded FA — must NOT absorb
  radio.fa = dl0;
  await ts.pushFrequencies(145950000, dl0 + 20); // tiny doppler step
  await sleep(200);
  // Offset should stay ~same (lag corridor / near commanded)
  assert.ok(
    Math.abs(ts._test.getManualDlOffset() - off0) < 50,
    "lag must not move manualDlOffset much",
  );
});

test("SA already on → kept on", async () => {
  resetRadio();
  radio.sa = "1";
  radio.saFull = "10100000";
  ts.close();
  ts.init({
    getContext: () => ({
      currentSatKey: "RS-44",
      currentModeIndex: 0,
      satrec: null,
      observer: null,
    }),
    broadcast: () => {},
  });
  ts.setRadio(true);
  await sleep(100);
  await ts.pushFrequencies(145950000, 435640000);
  await sleep(300);
  assert.strictEqual(radio.sa, "1", "SAT kept on");
  assert.ok(!radio.cmds.some((c) => /^SA1/i.test(c)), "already SA1 P2=0 → no resend");
});

test("SO-50 FM in SAT: no SUB/tone cmds, disable leaves SAT on", async () => {
  resetRadio();
  ts.close();
  ts.init({
    getContext: () => ({ currentSatKey: "SO-50", currentModeIndex: 0, satrec: null, observer: null }),
    broadcast: () => {},
  });
  ts.applyDefaultCtcss(67.0, null);
  ts.setRadio(true);
  await sleep(100);
  radio.cmds = [];
  await ts.pushFrequencies(145850000, 436795000);
  await sleep(300);
  assert.strictEqual(radio.fa, 436795000, "MAIN DL 70cm");
  assert.strictEqual(radio.fb, 145850000, "SUB UL 2m");
  assert.strictEqual(radio.mdA, "4");
  assert.ok(!radio.cmds.some((c) => /^(TN\d|TO\d|CT\d|DC\d)/i.test(c)), "no tone/DC cmds in SAT");
  assert.strictEqual(radio.dc[1], "0");
  ts.setRadio(false);
  await sleep(500);
  assert.strictEqual(radio.sa, "1", "SAT left on at disable");
  ts.applyDefaultCtcss(null, null);
});

test("setCwMode maps linear to MD3; supportsDataMode false", async () => {
  resetRadio();
  ts.close();
  ts.init({
    getContext: () => ({
      currentSatKey: "RS-44",
      currentModeIndex: 0,
      satrec: null,
      observer: null,
    }),
    broadcast: () => {},
  });
  ts.setRadio(true);
  await sleep(80);
  ts.setCwMode(true);
  await sleep(50);
  radio.cmds = [];
  await ts.pushFrequencies(145950000, 435640000);
  await sleep(250);
  const mds = radio.cmds.filter((c) => /^MD3$/i.test(c));
  assert.ok(mds.length >= 1, "CW → MD3");
  const st = ts.getRadioState();
  assert.strictEqual(st.supportsCwMode, true);
  assert.strictEqual(st.supportsDataMode, false);
  assert.strictEqual(st.cwMode, true);
});

test("cleanup close", async () => {
  ts.close();
  ts.setRadio(false);
  await sleep(30);
  assert.strictEqual(ts.getRadioState().radioOn, false);
});

test("SA rejected → clean VFO split fallback (FT1, no DC)", async () => {
  resetRadio();
  radio.rejectSa = true;
  ts.close();
  ts.init({
    getContext: () => ({ currentSatKey: "RS-44", currentModeIndex: 0, satrec: null, observer: null }),
    broadcast: () => {},
  });
  ts.setRadio(true);
  await sleep(1500);
  assert.strictEqual(ts._test.getSatOn(), false);
  assert.ok(radio.cmds.includes("SA1010000"), "tried SA1010000");
  assert.strictEqual(ts._test.getSatFailed(), true);
  radio.cmds = [];
  await ts.pushFrequencies(145950000, 435640000);
  await sleep(200);
  assert.strictEqual(radio.ft, 1, "split TX on B");
  assert.ok(!radio.cmds.some((c) => /^DC/i.test(c)), "no DC in fallback");
  radio.cmds = [];
  await ts.pushFrequencies(145950000, 435640000);
  await ts.pushFrequencies(145950000, 435640000);
  await sleep(200);
  assert.ok(!radio.cmds.some((c) => /^SA/i.test(c)), "no SA retries per tick");
  assert.ok(!radio.cmds.some((c) => /^FR1/i.test(c)), "no FR1 churn per tick");
  ts.setRadio(false);
  await sleep(300);
});

test("MD nak → not resent every tick", async () => {
  resetRadio();
  radio.rejectMd = true;
  ts.close();
  ts.init({
    getContext: () => ({ currentSatKey: "RS-44", currentModeIndex: 0, satrec: null, observer: null }),
    broadcast: () => {},
  });
  ts.setRadio(true);
  await sleep(1200);
  await ts.pushFrequencies(145950000, 435640000);
  await sleep(200);
  radio.cmds = [];
  for (let i = 0; i < 3; i++) await ts.pushFrequencies(145950000 + i * 10, 435640000 - i * 10);
  await sleep(200);
  assert.strictEqual(radio.cmds.filter((c) => /^MD\d/i.test(c)).length, 0, "no MD spam");
  ts.setRadio(false);
  await sleep(300);
  ts.close();
});

test("disable stops writes immediately and closes port", async () => {
  resetRadio();
  ts.close();
  ts.init({
    getContext: () => ({ currentSatKey: "RS-44", currentModeIndex: 0, satrec: null, observer: null }),
    broadcast: () => {},
  });
  ts.setRadio(true);
  await sleep(1500);
  const p = [];
  for (let i = 0; i < 5; i++) p.push(ts.pushFrequencies(145950000 + i * 7, 435640000 - i * 7));
  ts.setRadio(false);
  radio.cmds = [];
  await Promise.all(p).catch(() => {});
  await sleep(300);
  assert.strictEqual(radio.cmds.length, 0, "no writes after disable: " + radio.cmds.join(","));
  assert.strictEqual(ts._test.getLinks().dl.connected, false);
});

test("SAT: unchanged mode/freq not resent; no FR/FT/CT", async () => {
  resetRadio();
  ts.close();
  ts.init({
    getContext: () => ({ currentSatKey: "RS-44", currentModeIndex: 0, satrec: null, observer: null }),
    broadcast: () => {},
  });
  ts.setRadio(true);
  await sleep(1500);
  await ts.pushFrequencies(145950000, 435640000);
  await sleep(100);
  radio.cmds = [];
  await ts.pushFrequencies(145950000, 435640000);
  await ts.pushFrequencies(145950000, 435640000);
  await sleep(100);
  assert.ok(!radio.cmds.some((c) => /^(MD\d|FA\d|FB\d|F[RT]\d|CT)/i.test(c)), radio.cmds.join(","));
  ts.setRadio(false);
  await sleep(100);
});

test("concurrent ticks coalesce (no duplicate FA writes)", async () => {
  resetRadio();
  ts.close();
  ts.init({
    getContext: () => ({ currentSatKey: "RS-44", currentModeIndex: 0, satrec: null, observer: null }),
    broadcast: () => {},
  });
  ts.setRadio(true);
  await sleep(1500);
  await ts.pushFrequencies(145950000, 435640000);
  await sleep(100);
  radio.cmds = [];
  await Promise.all([1, 2, 3].map(() => ts.pushFrequencies(145950000, 435640100)));
  await sleep(500);
  assert.strictEqual(radio.cmds.filter((c) => c === "FA00435640100").length, 1, radio.cmds.join(","));
  ts.setRadio(false);
  await sleep(100);
  ts.close();
});
