// Hamlib rotor (rotctld) — additive to the native rotor drivers (RT-21, GS-232):
//   - rotctld args / spec: -m -r -s -T 127.0.0.1 -t 4537, only for Rotor = Hamlib serial;
//   - lib/hamlib supervises it (fake rotctld via an injected spawn), stops it on config change / stopAll;
//   - lib/rotors/hamlib-rot.js drives it (p / P / S) with fakes; no hardware;
//   - regression: native rotor and radio configs pick the same drivers and start no Hamlib daemons.
// Run: node --test --test-force-exit test/hamlib-rotor.test.js
const test = require("node:test");
const assert = require("assert");
const net = require("net");
const { EventEmitter } = require("events");

const config = require("../lib/config");
const hamlib = require("../lib/hamlib");
const models = require("../lib/hamlib/models");
const tools = require("../lib/hamlib/tools");
const rotors = require("../lib/rotors");
const hrot = require("../lib/rotors/hamlib-rot");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { log: () => {}, warn: () => {} };

/** Fake rotctld TCP server: p -> az/el, P az el -> RPRT 0, S -> RPRT 0. */
function fakeRotctld(port, host) {
  const st = { cmds: [], az: 10, el: 20, server: null };
  st.server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        st.cmds.push(l);
        if (l === "p") sock.write(st.az.toFixed(6) + "\n" + st.el.toFixed(6) + "\n");
        else if (/^P\s+(\S+)\s+(\S+)/.test(l)) {
          st.az = parseFloat(RegExp.$1);
          st.el = parseFloat(RegExp.$2);
          sock.write("RPRT 0\n");
        } else sock.write("RPRT 0\n");
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((res, rej) => {
    st.server.once("error", rej);
    st.server.listen(port, host || "127.0.0.1", () => res(st));
  });
}

test("buildRotctldArgs: localhost only, model required", () => {
  assert.deepStrictEqual(models.buildRotctldArgs({ model: 603, device: "/dev/ttyUSB0", baud: 9600, port: 4537 }), ["-m", "603", "-r", "/dev/ttyUSB0", "-s", "9600", "-T", "127.0.0.1", "-t", "4537"]);
  assert.throws(() => models.buildRotctldArgs({ port: 4537 }), /model/);
  assert.strictEqual(hamlib.ROT_PORT, 4537);
  assert.notStrictEqual(hamlib.ROT_PORT, 4533, "not Hamlib's rotctld default (user's own rotctld)");
  assert.ok(![4532, 4534, 4535].includes(hamlib.ROT_PORT));
});

test("rotSpec: only for Rotor = Hamlib serial with a model", () => {
  hamlib.configure(quiet);
  const base = { ROTOR_AZ_DEVICE: "COM9", ROTOR_BAUD: 9600 };
  for (const t of ["rt21", "gs232", "k3ng", ""]) assert.strictEqual(hamlib.rotSpec(Object.assign({ ROTOR_TYPE: t, ROTOR_HAMLIB_MODEL: 603 }, base)), null, t);
  assert.strictEqual(hamlib.rotSpec(Object.assign({ ROTOR_TYPE: "hamlib", ROTOR_HAMLIB_MODEL: null }, base)), null);
  const s = hamlib.rotSpec(Object.assign({ ROTOR_TYPE: "hamlib", ROTOR_HAMLIB_MODEL: 603 }, base));
  assert.deepStrictEqual(s.args, ["-m", "603", "-r", "COM9", "-s", "9600", "-T", "127.0.0.1", "-t", "4537"]);
});

test("config: rotorHamlibModel round-trips; native rotor fields unchanged", () => {
  const before = config.getEndpoints();
  config.applyEndpoints({ rotorType: "hamlib", rotorHamlibModel: 603, rotorAzDevice: "/dev/ttyUSB7", rotorBaud: 9600 });
  assert.strictEqual(config.ROTOR_HAMLIB_MODEL, 603);
  assert.strictEqual(config.getEndpoints().rotorHamlibModel, 603);
  assert.strictEqual(rotors.active().meta.id, "hamlib");
  config.applyEndpoints({ rotorHamlibModel: null });
  assert.strictEqual(config.ROTOR_HAMLIB_MODEL, null);
  config.applyEndpoints({ rotorType: before.rotorType, rotorAzDevice: before.rotorAzDevice, rotorBaud: before.rotorBaud });
});

test("regression: native rotor drivers still selected, RT-21 / GS-232 untouched, no rotctld", () => {
  const prev = config.ROTOR_TYPE;
  const cases = { rt21: "rt21", greenheron: "rt21", gs232: "gs232", k3ng: "gs232", foxdelta: "gs232", hamlib: "hamlib" };
  for (const [t, id] of Object.entries(cases)) {
    config.applyEndpoints({ rotorType: t });
    assert.strictEqual(rotors.active().meta.id, id, t);
    if (id !== "hamlib") assert.strictEqual(hamlib.rotSpec(), null, t + ": no rotctld");
  }
  assert.deepStrictEqual(rotors.catalog().map((d) => d.id), ["gs232", "rt21", "hamlib"], "registration order kept; Hamlib appended");
  assert.strictEqual(rotors.get("rt21").meta.ports, 2);
  assert.strictEqual(rotors.get("gs232").meta.ports, 1);
  config.applyEndpoints({ rotorType: prev });
});

test("regression: native radio configs start no rigctld", () => {
  const cases = [
    { transport: "serial", type: "icom", serialModel: "ic705", serialDevice: "/dev/ttyACM0", serialBaud: 115200 },
    { transport: "serial", type: "icom", serialModel: "ic9700", serialDevice: "/dev/ttyUSB0", serialBaud: 115200 },
    { transport: "serial", type: "kenwood", serialModel: "ts2000", serialDevice: "/dev/ttyUSB1", serialBaud: 9600 },
    { transport: "tcp", type: "smartsdr", protocol: "cat", catEndpoint: "127.0.0.9:5002" },
  ];
  for (const r of cases) {
    config.applyEndpoints({ singleRadio: true, radioUl: r, radioDl: r });
    assert.strictEqual(hamlib.wantedSpecs().size, 0, JSON.stringify(r));
    assert.strictEqual(hamlib.anyWanted(), false);
    assert.notStrictEqual(config.RADIO_UL.transport, "hamlib");
  }
});

test("supervisor: rotctld started via (fake) spawn, restarted on change, stopped by stopAll", async (t) => {
  if (!(await new Promise((r) => { const s = net.createServer().once("error", () => r(false)).listen(4537, "127.0.0.1", () => s.close(() => r(true))); }))) {
    t.skip("port 4537 busy");
    return;
  }
  const spawned = [];
  const fakeSpawn = (bin, args) => {
    const child = new EventEmitter();
    child.pid = 90000 + spawned.length;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    spawned.push({ bin, args, child });
    const port = parseInt(args[args.indexOf("-t") + 1], 10);
    fakeRotctld(port).then((st) => (child.st = st));
    child.kill = () => {
      if (child.st) child.st.server.close();
      setImmediate(() => child.emit("exit", 0, null));
      return true;
    };
    return child;
  };
  const origFind = tools.find;
  tools.find = (tool) => (tool === "rotctld" ? "/fake/rotctld" : null);
  hamlib.configure(Object.assign({ spawn: fakeSpawn, auto: false }, quiet));
  const prev = config.getEndpoints();
  try {
    config.applyEndpoints({ singleRadio: true, radioUl: { transport: "tcp", type: "smartsdr", protocol: "cat", catEndpoint: "127.0.0.9:5002" }, rotorType: "hamlib", rotorHamlibModel: 603, rotorAzDevice: "/dev/ttyUSB7", rotorBaud: 9600 });
    await hamlib.ensure();
    assert.strictEqual(spawned.length, 1);
    assert.strictEqual(spawned[0].bin, "/fake/rotctld");
    assert.deepStrictEqual(spawned[0].args, ["-m", "603", "-r", "/dev/ttyUSB7", "-s", "9600", "-T", "127.0.0.1", "-t", "4537"]);
    assert.strictEqual(hamlib._rot().sv.status().state, "running");
    assert.strictEqual(hamlib.wantedSpecs().size, 0, "no rigctld for a TCP radio");
    // same config: kept
    await hamlib.ensure();
    assert.strictEqual(spawned.length, 1);
    // model change: restarted with the new args
    config.applyEndpoints({ rotorHamlibModel: 902 });
    await hamlib.ensure();
    assert.strictEqual(spawned.length, 2);
    assert.strictEqual(spawned[1].args[1], "902");
    // back to a native rotor: rotctld stopped, nothing new spawned
    config.applyEndpoints({ rotorType: "rt21" });
    await hamlib.ensure();
    assert.strictEqual(hamlib._rot(), null);
    assert.strictEqual(spawned.length, 2);
    // Hamlib again, then stopAll (server exit)
    config.applyEndpoints({ rotorType: "hamlib" });
    await hamlib.ensure();
    assert.ok(hamlib._rot());
    await hamlib.stopAll();
    assert.strictEqual(hamlib._rot(), null);
  } finally {
    tools.find = origFind;
    await hamlib.stopAll();
    hamlib.configure({ spawn: null });
    config.applyEndpoints({ rotorType: prev.rotorType, rotorHamlibModel: null, rotorAzDevice: prev.rotorAzDevice, rotorBaud: prev.rotorBaud });
  }
});

test("driver: connects to rotctld, polls position, tracks with deadband, prepositions, parks, stops", async () => {
  const st = await fakeRotctld(0);
  const port = st.server.address().port;
  const broadcasts = [];
  hrot._setDeps({ endpoint: () => ({ host: "127.0.0.1", port }) });
  hrot.init({ broadcast: (m) => broadcasts.push(m) });
  const prev = { type: config.ROTOR_TYPE, azOnly: config.ROTOR_AZ_ONLY, parkAz: config.ROTOR_PARK_AZ, parkEl: config.ROTOR_PARK_EL, minEl: config.ROTOR_MIN_EL };
  config.applyEndpoints({ rotorType: "hamlib", rotorAzOnly: false, rotorParkAz: 180, rotorParkEl: 0, rotorMinEl: 0 });
  try {
    hrot.setAntenna(true);
    await sleep(150);
    let s = hrot.getRotorState();
    assert.strictEqual(s.azConnected, true);
    assert.strictEqual(s.az, 10);
    assert.strictEqual(s.el, 20);
    // in view: P az el
    await hrot.updateTracking({ az: 123.4, el: 30 }, null, null, { minEl: 0, satKey: "X" });
    assert.ok(st.cmds.includes("P 123.4 30.0"), st.cmds.join("|"));
    // within the deadband: no new P
    const nP = st.cmds.filter((c) => c[0] === "P").length;
    await hrot.updateTracking({ az: 124.0, el: 30.5 }, null, null, { minEl: 0 });
    assert.strictEqual(st.cmds.filter((c) => c[0] === "P").length, nP);
    // below Min EL, AOS in 2 min: preposition to the AOS azimuth at EL 0
    await hrot.updateTracking({ az: 300, el: -10 }, 45, null, { minEl: 0, nextAosMs: Date.now() + 120000, nextAosAz: 45 });
    assert.ok(st.cmds.includes("P 45.0 0.0"), st.cmds.join("|"));
    // far from AOS: hold
    const nP2 = st.cmds.filter((c) => c[0] === "P").length;
    await hrot.updateTracking({ az: 200, el: -20 }, 90, null, { minEl: 0, nextAosMs: Date.now() + 3600000, nextAosAz: 90 });
    assert.strictEqual(st.cmds.filter((c) => c[0] === "P").length, nP2);
    // park -> Park AZ / EL; tracking ignored while parked
    hrot.park();
    await sleep(80);
    assert.ok(st.cmds.includes("P 180.0 0.0"), st.cmds.join("|"));
    const nP3 = st.cmds.filter((c) => c[0] === "P").length;
    await hrot.updateTracking({ az: 10, el: 40 }, null, null, { minEl: 0 });
    assert.strictEqual(st.cmds.filter((c) => c[0] === "P").length, nP3);
    // Antenna off: stop + disconnect
    hrot.setAntenna(false);
    await sleep(80);
    assert.ok(st.cmds.includes("S"));
    s = hrot.getRotorState();
    assert.strictEqual(s.antennaOn, false);
    assert.strictEqual(s.azConnected, false);
    assert.ok(broadcasts.every((b) => b.type === "rotor" && b.driver === "hamlib"));
  } finally {
    hrot._setDeps({ endpoint: null });
    st.server.close();
    config.applyEndpoints({ rotorType: prev.type, rotorAzOnly: prev.azOnly, rotorParkAz: prev.parkAz, rotorParkEl: prev.parkEl, rotorMinEl: prev.minEl });
  }
});

test("driver: AZ only sends EL 0; reconnects with back-off when rotctld restarts", async () => {
  let st = await fakeRotctld(0);
  const port = st.server.address().port;
  const timers = [];
  hrot._setDeps({ endpoint: () => ({ host: "127.0.0.1", port }), setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length), clearTimeout: () => {} });
  const prev = { type: config.ROTOR_TYPE, azOnly: config.ROTOR_AZ_ONLY };
  config.applyEndpoints({ rotorType: "hamlib", rotorAzOnly: true });
  const socks = new Set();
  st.server.on("connection", (s) => socks.add(s));
  try {
    hrot.setAntenna(true);
    await sleep(120);
    await hrot.updateTracking({ az: 90, el: 45 }, null, null, { minEl: 0 });
    assert.ok(st.cmds.includes("P 90.0 0.0"), st.cmds.join("|"));
    // rotctld goes away (restart by the supervisor): the driver schedules a reconnect
    st.server.close();
    socks.forEach((s) => s.destroy());
    await sleep(80);
    assert.strictEqual(hrot.getRotorState().azConnected, false);
    assert.strictEqual(timers.length, 1);
    assert.strictEqual(timers[0].ms, 1000);
    st = await fakeRotctld(port);
    timers[0].fn();
    await sleep(120);
    assert.strictEqual(hrot.getRotorState().azConnected, true);
  } finally {
    hrot.setAntenna(false);
    hrot._setDeps({ endpoint: null, setTimeout, clearTimeout });
    st.server.close();
    config.applyEndpoints({ rotorType: prev.type, rotorAzOnly: prev.azOnly });
  }
});
