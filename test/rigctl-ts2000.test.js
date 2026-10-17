// rigctl → rigctld (Hamlib 2014) Kenwood TS-2000: raw `w` SAT path, TF-SET swap,
// FM dial lock + SUB tone, same-band simplex split, DL-only, restore, fallbacks.
// Run: node --test --test-force-exit test/rigctl-ts2000.test.js
const test = require("node:test");
const assert = require("assert");
const net = require("net");
const path = require("path");
const kw = require("../lib/radios/ts2000-cat");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const band = (hz) => (hz >= 300e6 ? "70cm" : "2m");

/**
 * Fake rigctld fronting a TS-2000. `w` behaves like Hamlib send_cmd for Kenwood:
 * sets get no reply, each query reply is printed followed by '\0', nak = "?;".
 * MAIN/SUB bands are fixed per layout: FA writes on the wrong band nak; TS1 swaps.
 */
function startFake(opts) {
  const o = opts || {};
  const st = {
    cmds: [],
    w: [],
    sa: o.sa || "0000000",
    fa: o.fa != null ? o.fa : 435000000,
    fb: o.fb != null ? o.fb : 145000000,
    mdMain: "2",
    mdSub: "1",
    tn: "08",
    to: "0",
    hamlibF: [],
  };
  const satOn = () => st.sa[0] === "1";
  const p4 = () => st.sa[3];
  function kenwood(c) {
    if (/^SA$/.test(c)) return "SA" + st.sa + ";";
    let m;
    if ((m = c.match(/^SA(\d{7})$/))) {
      st.sa = m[1];
      return null;
    }
    if ((m = c.match(/^F([AB])(\d{11})$/))) {
      const hz = parseInt(m[2], 10);
      const cur = m[1] === "A" ? st.fa : st.fb;
      if (satOn() && band(hz) !== band(cur)) return "?;";
      if (m[1] === "A") st.fa = hz;
      else st.fb = hz;
      return null;
    }
    if (c === "FA") return "FA" + String(st.fa).padStart(11, "0") + ";";
    if (c === "FB") return "FB" + String(st.fb).padStart(11, "0") + ";";
    if (c === "TS1") {
      const t = st.fa;
      st.fa = st.fb;
      st.fb = t;
      return null;
    }
    if (c === "TS0") return null;
    if ((m = c.match(/^MD(\d)$/))) {
      if (satOn() && p4() === "1") st.mdSub = m[1];
      else st.mdMain = m[1];
      return null;
    }
    if (c === "MD") return "MD" + (satOn() && p4() === "1" ? st.mdSub : st.mdMain) + ";";
    if ((m = c.match(/^TN(\d\d)$/))) {
      st.tn = m[1];
      st.tnOnSub = satOn() && p4() === "1";
      return null;
    }
    if (c === "TN") return "TN" + st.tn + ";";
    if ((m = c.match(/^TO(\d)$/))) {
      st.to = m[1];
      return null;
    }
    if (c === "TO") return "TO" + st.to + ";";
    return "?;";
  }
  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "").trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        st.cmds.push(line);
        let reply = "RPRT 0\n";
        let m;
        if ((m = line.match(/^w\s+(.*)$/))) {
          st.w.push(m[1]);
          if (o.noW) reply = "RPRT -11\n";
          else {
            let out = "";
            for (const c of m[1].split(";").map((x) => x.trim()).filter(Boolean)) {
              const r = kenwood(c);
              if (r) out += r + "\0";
            }
            reply = out; // nothing at all when no reply (Hamlib timeout)
          }
        } else if (/^U SATMODE/.test(line)) reply = "RPRT -11\n";
        else if (line === "U ?") reply = "LOCK\n";
        else if (line === "f") reply = String(st.fa) + "\n";
        else if ((m = line.match(/^F\s+(\d+)/))) {
          st.hamlibF.push(parseInt(m[1], 10));
          st.fa = parseInt(m[1], 10);
        }
        if (reply) setTimeout(() => sock.write(reply), 5);
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, st })),
  );
}

function loadRigctl(port, model) {
  const cfgPath = require.resolve(path.join(__dirname, "../lib/config"));
  const catPath = require.resolve(path.join(__dirname, "../lib/catalog"));
  const rigPath = require.resolve(path.join(__dirname, "../lib/radios/rigctl"));
  delete require.cache[cfgPath];
  delete require.cache[catPath];
  delete require.cache[rigPath];
  require.cache[cfgPath] = {
    id: cfgPath,
    filename: cfgPath,
    loaded: true,
    exports: {
      RADIO_TRANSPORT: "tcp",
      RADIO_PROTOCOL: "rigctl",
      RIGCTL_HOST: "127.0.0.1",
      RIGCTL_PORT: port,
      RIGCTL_UL_HOST: "",
      RIGCTL_UL_PORT: 0,
      TX_SPLIT: true,
      SERIAL_MODEL: model == null ? "TS-2000" : model,
      RADIO_MODEL: "",
      CAT_MODEL: "",
      RIGCTL_SAT_DUAL: "",
    },
  };
  const realCat = require(catPath);
  realCat.getCatalog = () => ({
    "RS-44": { modes: [{ mode: "SSB", uplink: "145.935-145.995", downlink: "435.610-435.670" }] },
    "AO-91": { modes: [{ mode: "FM", uplink: "435.250", downlink: "145.960" }] },
    ISS: { modes: [{ mode: "FM APRS", uplink: "145.825", downlink: "145.825" }] },
    "GMSK-SAT": { modes: [{ mode: "GMSK", uplink: "", downlink: "436.500" }] },
  });
  return require(rigPath);
}

async function withRig(fakeOpts, sat, fn, model) {
  const fake = await startFake(fakeOpts);
  const logs = [];
  const ol = console.log;
  const ow = console.warn;
  console.log = (...a) => logs.push(a.join(" "));
  console.warn = (...a) => logs.push("WARN " + a.join(" "));
  let rig;
  try {
    rig = loadRigctl(fake.port, model);
    rig.init({ getContext: () => ({ currentSatKey: sat, currentModeIndex: 0 }) });
    await fn(rig, fake, logs);
  } catch (e) {
    ol(logs.join("\n"));
    throw e;
  } finally {
    console.log = ol;
    console.warn = ow;
    if (rig) rig.setRadio(false);
    await sleep(50);
    fake.server.close();
  }
}

async function ticks(rig, n, ul, dl, step) {
  for (let i = 0; i < n; i++) {
    await rig.pushFrequencies(ul == null ? null : ul + (step || 0) * i, dl == null ? null : dl - (step || 0) * i);
    await sleep(380);
  }
}

test("ts2000-cat helpers: tokens / matchReply / builders", () => {
  assert.strictEqual(kw.freqCmd("A", 435616000), "FA00435616000");
  assert.strictEqual(kw.freqCmd("B", 145980000), "FB00145980000");
  assert.strictEqual(kw.mdCode("USB"), "2");
  assert.strictEqual(kw.mdCode("FM"), "4");
  assert.strictEqual(kw.toneCode(67.0), 1);
  assert.strictEqual(kw.toneCode(88.5), 8);
  const m = kw.matchReply("FA00435616000;FA;", "?;\0FA00145000000;\0");
  assert.ok(m.done);
  assert.strictEqual(m.naks, 1);
  assert.strictEqual(m.byQuery.FA, "FA00145000000");
  assert.ok(!kw.matchReply("TN08;TO1;TN;TO;", "TN08;\0").done);
  assert.deepStrictEqual(kw.parseSa("SA1010000").on, true);
});

test("isTs2000 match: names + Hamlib 2014, not bare 2000", () => {
  const rig = loadRigctl(1, "ts-2000");
  for (const m of ["TS-2000", "ts2000", "Kenwood TS-2000", "2014"])
    assert.ok(rig.isTs2000({ SERIAL_MODEL: m }), m);
  for (const m of ["2000", "FT-2000", "IC-9700", "20140"])
    assert.ok(!rig.isTs2000({ SERIAL_MODEL: m }), m);
  assert.ok(rig.isTs2000({ RIGCTL_MODEL: 2014 }));
});

test("RS-44 linear: SAT via w, FA=DL FB=UL, modes, no SATMODE spam, restore SA", async () => {
  await withRig({ sa: "0000000", fa: 435000000, fb: 145000000 }, "RS-44", async (rig, fake, logs) => {
    rig.applyDefaultLock(false);
    rig.setRadio(true);
    await sleep(150);
    await ticks(rig, 6, 145980000, 435616000, 10);
    assert.ok(!fake.st.cmds.some((c) => /^U SATMODE/.test(c)), "no U SATMODE for TS-2000");
    assert.ok(fake.st.w.includes("SA;"), "SA read once at engage");
    assert.ok(fake.st.w.includes("SA1010000;SA;"), "SAT on: " + fake.st.w.join(" | "));
    assert.strictEqual(fake.st.sa, "1010000");
    assert.strictEqual(fake.st.mdSub, "1", "SUB LSB");
    assert.strictEqual(fake.st.mdMain, "2", "MAIN USB");
    assert.strictEqual(band(fake.st.fa), "70cm");
    assert.ok(Math.abs(fake.st.fa - 435616000) < 100, "FA=DL " + fake.st.fa);
    assert.ok(Math.abs(fake.st.fb - 145980000) < 100, "FB=UL " + fake.st.fb);
    assert.ok(!fake.st.cmds.some((c) => /^(F|V|M) /.test(c)), "no Hamlib F/V/M in SAT");
    assert.ok(!fake.st.w.some((c) => /TS1/.test(c)), "no swap needed");
    assert.ok(!logs.some((l) => /RPRT -11/.test(l)), "no -11 spam");
    // Dial absorb (linear, unlocked): move MAIN by +1 kHz
    fake.st.fa += 1000;
    const fa = fake.st.fa;
    await ticks(rig, 1, 145980000, 435616000);
    assert.ok(logs.some((l) => /dial absorb MAIN 1000/.test(l)), "absorbed");
    assert.strictEqual(fake.st.fa, fa, "dial offset kept");
    rig.setRadio(false);
    await sleep(800);
    assert.strictEqual(fake.st.sa, "0000000", "SA restored on disconnect: " + fake.st.w.slice(-3).join(" | "));
  });
});

test("U/V band mismatch: FA nak → TF-SET TS1/TS0 swap, then TS0 on restore", async () => {
  // MAIN starts on 2m, but RS-44 DL is 70cm
  await withRig({ sa: "0000000", fa: 145000000, fb: 435000000 }, "RS-44", async (rig, fake, logs) => {
    rig.applyDefaultLock(false);
    rig.setRadio(true);
    await sleep(150);
    await ticks(rig, 5, 145980000, 435616000);
    assert.ok(fake.st.w.includes("TS1;TS0;FA;FB;"), "TF-SET pressed: " + fake.st.w.join(" | "));
    assert.ok(Math.abs(fake.st.fa - 435616000) < 100, "FA=DL after swap " + fake.st.fa);
    assert.ok(Math.abs(fake.st.fb - 145980000) < 100, "FB=UL after swap " + fake.st.fb);
    assert.ok(logs.some((l) => /TF-SET swap.*OK/.test(l)));
    rig.setRadio(false);
    await sleep(800);
    assert.ok(fake.st.w.includes("TS0;SA;"), "TS0 on restore");
  });
});

test("AO-91 FM: dial locked snaps back, SUB tone via SA P4 cycle", async () => {
  await withRig({ sa: "0000000", fa: 145000000, fb: 435000000 }, "AO-91", async (rig, fake) => {
    rig.applyDefaultLock(true);
    rig.applyDefaultCtcss(67.0, null);
    rig.setRadio(true);
    await sleep(150);
    await ticks(rig, 5, 435250000, 145960000);
    assert.strictEqual(fake.st.mdMain, "4");
    assert.strictEqual(fake.st.mdSub, "4");
    assert.strictEqual(fake.st.tn, "01");
    assert.strictEqual(fake.st.to, "1");
    assert.ok(fake.st.tnOnSub, "TN set with CTRL=SUB");
    assert.strictEqual(fake.st.sa, "1010000", "CTRL back to MAIN");
    fake.st.fa += 2500; // operator turns the dial
    await ticks(rig, 2, 435250000, 145960000);
    assert.ok(Math.abs(fake.st.fa - 145960000) < 10, "snapped back to Doppler DL " + fake.st.fa);
    assert.strictEqual(rig.getRadioState().toneVerified, true);
  });
});

test("same-band simplex (ISS): SAT off, VFOA=DL, split S 1 VFOB + I, dial locked", async () => {
  await withRig({ sa: "1010000", fa: 435000000, fb: 145000000 }, "ISS", async (rig, fake) => {
    rig.applyDefaultLock(false); // forced lock regardless
    rig.setRadio(true);
    await sleep(150);
    await ticks(rig, 4, 145825000, 145825000);
    assert.ok(!fake.st.w.includes("SA1010000;SA;"), "SAT not enabled");
    assert.strictEqual(fake.st.sa[0], "0", "SAT turned off");
    assert.ok(fake.st.cmds.includes("V VFOA"));
    assert.ok(fake.st.cmds.includes("S 1 VFOB"));
    assert.ok(fake.st.cmds.some((c) => /^I 145825000/.test(c)));
    assert.ok(fake.st.cmds.includes("M FM 0"), "GMSK/APRS→FM");
    assert.ok(!fake.st.cmds.slice(-12).includes("f"), "no dial readback (locked)");
    rig.setRadio(false);
    await sleep(800);
    assert.ok(fake.st.cmds.includes("S 0 VFOA"));
    assert.strictEqual(fake.st.sa, "1010000", "original SA restored");
  });
});

test("DL-only (GMSK): no SAT, plain VFOA + F, mode FM", async () => {
  await withRig({ sa: "0000000" }, "GMSK-SAT", async (rig, fake) => {
    rig.setRadio(true);
    await sleep(150);
    await ticks(rig, 3, null, 436500000);
    assert.ok(!fake.st.w.some((c) => /SA1/.test(c)), "no SAT on");
    assert.ok(fake.st.cmds.includes("V VFOA"));
    assert.ok(fake.st.cmds.includes("M FM 0"));
    assert.ok(fake.st.hamlibF.includes(436500000));
    assert.ok(!fake.st.cmds.some((c) => /^S 1/.test(c)));
  });
});

test("`w` unsupported (RPRT -11): log once, fall back to Hamlib split", async () => {
  await withRig({ noW: true }, "RS-44", async (rig, fake, logs) => {
    rig.setLock(true);
    rig.setRadio(true);
    await sleep(150);
    await ticks(rig, 4, 145980000, 435616000);
    assert.strictEqual(fake.st.w.length, 1, "w tried once: " + fake.st.w.join("|"));
    assert.ok(fake.st.cmds.includes("S 1 VFOB"));
    assert.ok(fake.st.cmds.some((c) => /^I /.test(c)));
    assert.strictEqual(logs.filter((l) => /passthrough unavailable/.test(l)).length, 1);
  });
});

test("SATMODE failure cached (non-TS model in SAT list): sent once", async () => {
  await withRig({}, "RS-44", async (rig, fake, logs) => {
    rig.setLock(true);
    rig.setRadio(true);
    await sleep(150);
    await ticks(rig, 4, 145980000, 435616000);
    const n = fake.st.cmds.filter((c) => c === "U SATMODE 1").length;
    assert.strictEqual(n, 1, "U SATMODE 1 sent once");
    assert.strictEqual(logs.filter((l) => /SATMODE ON/.test(l)).length, 1);
  }, "IC-9700");
});

test("bare '2000' model no longer matches TS-2000 / dual-SAT", async () => {
  await withRig({}, "RS-44", async (rig, fake) => {
    rig.setLock(true);
    rig.setRadio(true);
    await sleep(150);
    await ticks(rig, 2, 145980000, 435616000);
    assert.ok(!fake.st.cmds.some((c) => /^w |^U SATMODE/.test(c)));
    // 2014 (Hamlib model id) does match
  }, "FT-2000");
});
