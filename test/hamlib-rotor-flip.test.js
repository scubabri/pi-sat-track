// Hamlib rotor over-the-top flip (Brian, alpha.20: "why didn't it do the initial flip?").
// Same rules as the native RT-21 driver; rotctld gets -C max_el=180 so Hamlib accepts EL > 90.
// Run: node --test --test-force-exit test/hamlib-rotor-flip.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pst-hlflip-"));
const config = require("../lib/config");
const hrot = require("../lib/rotors/hamlib-rot");
const models = require("../lib/hamlib/models");
const hamlib = require("../lib/hamlib");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fake() {
  const st = { cmds: [] };
  st.server = net.createServer((s) => {
    let b = "";
    s.on("error", () => {});
    s.on("data", (d) => {
      b += d;
      let i;
      while ((i = b.indexOf("\n")) >= 0) {
        const c = b.slice(0, i).trim();
        b = b.slice(i + 1);
        st.cmds.push(c);
        s.write(c === "p" ? "0.0\n0.0\n" : "RPRT 0\n");
      }
    });
  });
  await new Promise((r) => st.server.listen(0, "127.0.0.1", r));
  return st;
}
const lastP = (st) => st.cmds.filter((c) => c[0] === "P").pop();

async function run(cfg, fn) {
  const st = await fake();
  const prev = { type: config.ROTOR_TYPE, elMax: config.ROTOR_EL_MAX, azOnly: config.ROTOR_AZ_ONLY, stop: config.ROTOR_AZ_STOP, minEl: config.ROTOR_MIN_EL };
  config.applyEndpoints(Object.assign({ rotorType: "hamlib", rotorElMax: 180, rotorAzOnly: false, rotorAzStop: "north", rotorMinEl: 0 }, cfg));
  hrot._setDeps({ endpoint: () => ({ host: "127.0.0.1", port: st.server.address().port }) });
  try {
    hrot.setAntenna(true);
    await sleep(100);
    await fn(st);
  } finally {
    hrot._setDeps({ endpoint: null });
    st.server.close();
    config.applyEndpoints({ rotorType: prev.type, rotorElMax: prev.elMax, rotorAzOnly: prev.azOnly, rotorAzStop: prev.stop, rotorMinEl: prev.minEl });
  }
}
// pass crossing north: AOS az 300 -> LOS az 60 (short path through 0)
const meta = (extra) => Object.assign({ minEl: 0, satKey: "AO-7", nextAosMs: Date.now() + 60000, nextAosAz: 300, nextLosAz: 60 }, extra || {});

test("stop-crossing pass: flipped pre-position (AZ+180, EL 180), then flipped track (AZ+180, EL 180-el)", async () => {
  await run({}, async (st) => {
    await hrot.updateTracking({ az: 290, el: -5 }, 300, null, meta());
    await sleep(50);
    assert.strictEqual(lastP(st), "P 120.0 180.0");
    assert.strictEqual(hrot.getRotorState().flipped, true);
    await hrot.updateTracking({ az: 300, el: 10 }, 300, 60, meta({ inPass: true }));
    await sleep(50);
    assert.strictEqual(lastP(st), "P 120.0 170.0");
    await hrot.updateTracking({ az: 10, el: 80 }, 300, 60, meta({ inPass: true }));
    await sleep(50);
    assert.strictEqual(lastP(st), "P 190.0 100.0");
    // below Min EL: pass over, mode released
    await hrot.updateTracking({ az: 60, el: -2 }, 300, 60, meta({ nextAosMs: Date.now() + 3600000 }));
    assert.strictEqual(hrot.getRotorState().flipped, false);
  });
});

test("mid-pass engage: flips only if the remaining path crosses the stop", async () => {
  await run({}, async (st) => {
    await hrot.updateTracking({ az: 330, el: 40 }, 300, 60, meta({ inPass: true }));
    await sleep(50);
    assert.strictEqual(lastP(st), "P 150.0 140.0");
  });
  await run({}, async (st) => {
    await hrot.updateTracking({ az: 20, el: 40 }, 300, 60, meta({ inPass: true })); // past the crossing
    await sleep(50);
    assert.strictEqual(lastP(st), "P 20.0 40.0");
  });
});

test("high pass that does not cross the stop stays normal (AO-7 86° at az 239)", async () => {
  await run({}, async (st) => {
    const m = meta({ nextAosAz: 160, nextLosAz: 320 });
    await hrot.updateTracking({ az: 150, el: -3 }, 160, null, m);
    await sleep(50);
    assert.strictEqual(lastP(st), "P 160.0 0.0");
    await hrot.updateTracking({ az: 239, el: 85.8 }, 160, 320, Object.assign(m, { inPass: true }));
    await sleep(50);
    assert.strictEqual(lastP(st), "P 239.0 85.8");
    assert.strictEqual(hrot.getRotorState().flipped, false);
  });
});

test("south stop: a pass crossing 180 flips; Max EL 90 or AZ-only never flips", async () => {
  await run({ rotorAzStop: "south" }, async (st) => {
    await hrot.updateTracking({ az: 150, el: 30 }, 150, 210, meta({ inPass: true, nextAosAz: 150, nextLosAz: 210 }));
    await sleep(50);
    assert.strictEqual(lastP(st), "P 330.0 150.0");
  });
  await run({ rotorElMax: 90 }, async (st) => {
    await hrot.updateTracking({ az: 290, el: -5 }, 300, null, meta());
    await hrot.updateTracking({ az: 330, el: 40 }, 300, 60, meta({ inPass: true }));
    await sleep(50);
    assert.ok(st.cmds.filter((c) => c[0] === "P").every((c) => parseFloat(c.split(" ")[2]) <= 90), st.cmds.join("|"));
    assert.strictEqual(hrot.getRotorState().flipped, false);
  });
  await run({ rotorAzOnly: true }, async (st) => {
    await hrot.updateTracking({ az: 330, el: 40 }, 300, 60, meta({ inPass: true }));
    await sleep(50);
    assert.strictEqual(lastP(st), "P 330.0 0.0");
    assert.strictEqual(hrot.getRotorState().flipped, false);
  });
});

test("rotctld args: -C max_el=180 only with Max EL 180 (single, RT-21 -R and separate EL daemon)", () => {
  const base = { model: 405, device: "COM5", baud: 4800, port: 4537 };
  assert.deepStrictEqual(models.buildRotctldArgs(Object.assign({ maxEl: 180 }, base)).slice(-6), ["-C", "max_el=180", "-T", "127.0.0.1", "-t", "4537"]);
  assert.ok(!models.buildRotctldArgs(Object.assign({ maxEl: 90 }, base)).includes("max_el=180"));
  assert.ok(!models.buildRotctldArgs(base).includes("-C"));
  const c = { ROTOR_TYPE: "hamlib", ROTOR_HAMLIB_MODEL: 405, ROTOR_AZ_DEVICE: "COM5", ROTOR_BAUD: 4800, ROTOR_HAMLIB_SPLIT: true, ROTOR_HAMLIB_EL_DEVICE: "COM3", ROTOR_EL_MAX: 180 };
  const has = (specs) => specs.map((s) => s.args.join(" ").includes("-C max_el=180"));
  assert.deepStrictEqual(has(hamlib.rotSpecs(c)), [true]);
  assert.deepStrictEqual(has(hamlib.rotSpecs(Object.assign({}, c, { ROTOR_HAMLIB_MODEL: 601 }))), [true, true]);
  assert.deepStrictEqual(has(hamlib.rotSpecs(Object.assign({}, c, { ROTOR_EL_MAX: 90 }))), [false]);
  assert.deepStrictEqual(has(hamlib.rotSpecs(Object.assign({}, c, { ROTOR_AZ_ONLY: true }))), [false]);
  // a Max EL change changes the args -> rotctld restarts (doEnsureRot compares argsKey)
  assert.notStrictEqual(hamlib.rotSpecs(c)[0].argsKey, hamlib.rotSpecs(Object.assign({}, c, { ROTOR_EL_MAX: 90 }))[0].argsKey);
});
