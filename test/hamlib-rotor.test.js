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

// ---- separate AZ / EL controllers (Green Heron RT-21 az + el = two controllers) ----
test("rotSpecs: RT-21 split = one rotctld with -R (Hamlib native); other models = two rotctld 4537 / 4538", () => {
  hamlib.configure(quiet);
  const base = { ROTOR_TYPE: "hamlib", ROTOR_AZ_DEVICE: "COM9", ROTOR_BAUD: 4800, ROTOR_HAMLIB_SPLIT: true, ROTOR_HAMLIB_EL_DEVICE: "COM10" };
  const rt = hamlib.rotSpecs(Object.assign({ ROTOR_HAMLIB_MODEL: 405 }, base));
  assert.strictEqual(rt.length, 1);
  assert.deepStrictEqual(rt[0].args, ["-m", "405", "-r", "COM9", "-R", "COM10", "-s", "4800", "-T", "127.0.0.1", "-t", "4537"]);
  assert.strictEqual(hamlib.rotEndpoints(Object.assign({ ROTOR_HAMLIB_MODEL: 405 }, base)).el, null);
  const two = hamlib.rotSpecs(Object.assign({ ROTOR_HAMLIB_MODEL: 603, ROTOR_HAMLIB_EL_BAUD: 9600, ROTOR_HAMLIB_EL_MODEL: 601 }, base));
  assert.deepStrictEqual(two.map((w) => [w.key, w.role, w.port]), [["rot", "az", 4537], ["rotEl", "el", 4538]]);
  assert.deepStrictEqual(two[0].args, ["-m", "603", "-r", "COM9", "-s", "4800", "-T", "127.0.0.1", "-t", "4537"]);
  assert.deepStrictEqual(two[1].args, ["-m", "601", "-r", "COM10", "-s", "9600", "-T", "127.0.0.1", "-t", "4538"]);
  assert.deepStrictEqual(hamlib.rotEndpoints(Object.assign({ ROTOR_HAMLIB_MODEL: 603 }, base)).el, { host: "127.0.0.1", port: 4538 });
  // EL model / baud default to the AZ unit's
  const same = hamlib.rotSpecs(Object.assign({ ROTOR_HAMLIB_MODEL: 603 }, base));
  assert.deepStrictEqual(same[1].args, ["-m", "603", "-r", "COM10", "-s", "4800", "-T", "127.0.0.1", "-t", "4538"]);
  // split off / no EL device / AZ only: single controller unchanged
  for (const x of [{ ROTOR_HAMLIB_SPLIT: false }, { ROTOR_HAMLIB_EL_DEVICE: "" }, { ROTOR_AZ_ONLY: true }]) {
    const one = hamlib.rotSpecs(Object.assign({ ROTOR_HAMLIB_MODEL: 603 }, base, x));
    assert.deepStrictEqual(one.map((w) => [w.role, w.port]), [["azel", 4537]], JSON.stringify(x));
    assert.ok(one[0].args.indexOf("-R") < 0);
  }
  assert.strictEqual(hamlib.ROT_EL_PORT, 4538);
});

test("config: split fields round-trip", () => {
  config.applyEndpoints({ rotorHamlibSplit: true, rotorHamlibElDevice: " /dev/ttyUSB8 ", rotorHamlibElBaud: 9600, rotorHamlibElModel: 601 });
  const e = config.getEndpoints();
  assert.deepStrictEqual([e.rotorHamlibSplit, e.rotorHamlibElDevice, e.rotorHamlibElBaud, e.rotorHamlibElModel], [true, "/dev/ttyUSB8", 9600, 601]);
  config.applyEndpoints({ rotorHamlibSplit: false, rotorHamlibElDevice: "", rotorHamlibElBaud: null, rotorHamlibElModel: null });
  assert.strictEqual(config.ROTOR_HAMLIB_SPLIT, false);
  assert.strictEqual(config.ROTOR_HAMLIB_EL_MODEL, null);
});

test("supervisor: two rotctld (AZ 4537, EL 4538) started, both stopped on split off / stopAll", async (t) => {
  for (const p of [4537, 4538]) {
    if (!(await new Promise((r) => { const s = net.createServer().once("error", () => r(false)).listen(p, "127.0.0.1", () => s.close(() => r(true))); }))) {
      t.skip("port " + p + " busy");
      return;
    }
  }
  const spawned = [];
  const live = new Set();
  const fakeSpawn = (bin, args) => {
    const child = new EventEmitter();
    child.pid = 91000 + spawned.length;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    spawned.push({ bin, args, child });
    live.add(child);
    fakeRotctld(parseInt(args[args.indexOf("-t") + 1], 10)).then((st) => (child.st = st));
    child.kill = () => {
      live.delete(child);
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
    config.applyEndpoints({ singleRadio: true, radioUl: { transport: "tcp", type: "smartsdr", protocol: "cat", catEndpoint: "127.0.0.9:5002" }, rotorType: "hamlib", rotorAzOnly: false, rotorHamlibModel: 603, rotorAzDevice: "/dev/ttyUSB7", rotorBaud: 9600, rotorHamlibSplit: true, rotorHamlibElDevice: "/dev/ttyUSB8" });
    await hamlib.ensure();
    assert.deepStrictEqual(spawned.map((x) => x.args.slice(-1)[0]), ["4537", "4538"]);
    assert.strictEqual(hamlib._rot().sv.status().state, "running");
    assert.strictEqual(hamlib._rotEl().sv.status().state, "running");
    const st = await hamlib.status();
    assert.deepStrictEqual(st.rotors.map((r) => [r.role, r.port]), [["az", 4537], ["el", 4538]]);
    // split off: EL daemon stopped, AZ restarted as a single controller (args unchanged -> kept)
    config.applyEndpoints({ rotorHamlibSplit: false });
    await hamlib.ensure();
    assert.strictEqual(hamlib._rotEl(), null);
    assert.ok(hamlib._rot());
    assert.strictEqual(live.size, 1);
    config.applyEndpoints({ rotorHamlibSplit: true });
    await hamlib.ensure();
    assert.strictEqual(live.size, 2);
    await hamlib.stopAll();
    assert.strictEqual(live.size, 0);
    assert.strictEqual(hamlib._rot(), null);
    assert.strictEqual(hamlib._rotEl(), null);
  } finally {
    tools.find = origFind;
    await hamlib.stopAll();
    hamlib.configure({ spawn: null });
    config.applyEndpoints({ rotorType: prev.rotorType, rotorHamlibModel: null, rotorHamlibSplit: false, rotorHamlibElDevice: "", rotorAzDevice: prev.rotorAzDevice, rotorBaud: prev.rotorBaud });
  }
});

test("driver: separate controllers — AZ to the AZ daemon, EL to the EL daemon, position from each", async () => {
  const azd = await fakeRotctld(0);
  const eld = await fakeRotctld(0);
  azd.az = 100; azd.el = 0;
  eld.az = 25; eld.el = 0; // EL unit reports elevation on its first axis
  hrot._setDeps({ endpoint: () => ({ az: { host: "127.0.0.1", port: azd.server.address().port }, el: { host: "127.0.0.1", port: eld.server.address().port } }) });
  const prev = { type: config.ROTOR_TYPE, azOnly: config.ROTOR_AZ_ONLY, parkAz: config.ROTOR_PARK_AZ, parkEl: config.ROTOR_PARK_EL };
  config.applyEndpoints({ rotorType: "hamlib", rotorAzOnly: false, rotorParkAz: 180, rotorParkEl: 10 });
  try {
    hrot.setAntenna(true);
    await sleep(150);
    let s = hrot.getRotorState();
    assert.strictEqual(s.azConnected, true);
    assert.strictEqual(s.elConnected, true);
    assert.strictEqual(s.az, 100);
    assert.strictEqual(s.el, 25);
    await hrot.updateTracking({ az: 200, el: 40 }, null, null, { minEl: 0 });
    assert.ok(azd.cmds.includes("P 200.0 0.0"), azd.cmds.join("|"));
    assert.ok(eld.cmds.includes("P 40.0 0.0"), eld.cmds.join("|"));
    assert.ok(!azd.cmds.some((c) => c === "P 200.0 40.0"), "az daemon never gets the elevation");
    hrot.park();
    await sleep(80);
    assert.ok(azd.cmds.includes("P 180.0 0.0"));
    assert.ok(eld.cmds.includes("P 10.0 0.0"));
    hrot.setAntenna(false);
    await sleep(80);
    assert.ok(azd.cmds.includes("S") && eld.cmds.includes("S"), "stop sent to both");
    s = hrot.getRotorState();
    assert.strictEqual(s.azConnected, false);
  } finally {
    hrot._setDeps({ endpoint: null });
    azd.server.close();
    eld.server.close();
    config.applyEndpoints({ rotorType: prev.type, rotorAzOnly: prev.azOnly, rotorParkAz: prev.parkAz, rotorParkEl: prev.parkEl });
  }
});

test("status role label follows the spec when a kept daemon gains a separate EL controller", async (t) => {
  for (const p of [4537, 4538]) {
    if (!(await new Promise((r) => { const s = net.createServer().once("error", () => r(false)).listen(p, "127.0.0.1", () => s.close(() => r(true))); }))) {
      t.skip("port " + p + " busy");
      return;
    }
  }
  const fakeSpawn = (bin, args) => {
    const child = new EventEmitter();
    child.pid = 92000;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    fakeRotctld(parseInt(args[args.indexOf("-t") + 1], 10)).then((st) => (child.st = st));
    child.kill = () => { if (child.st) child.st.server.close(); setImmediate(() => child.emit("exit", 0, null)); return true; };
    return child;
  };
  const origFind = tools.find;
  tools.find = (tool) => (tool === "rotctld" ? "/fake/rotctld" : null);
  hamlib.configure(Object.assign({ spawn: fakeSpawn, auto: false }, quiet));
  const prev = config.getEndpoints();
  try {
    config.applyEndpoints({ rotorType: "hamlib", rotorAzOnly: false, rotorHamlibModel: 603, rotorAzDevice: "/dev/ttyUSB7", rotorBaud: 9600, rotorHamlibSplit: false, rotorHamlibElDevice: "/dev/ttyUSB8" });
    await hamlib.ensure();
    assert.strictEqual(hamlib._rot().role, "azel");
    config.applyEndpoints({ rotorHamlibSplit: true });
    await hamlib.ensure();
    assert.strictEqual(hamlib._rot().role, "az");
    assert.deepStrictEqual((await hamlib.status()).rotors.map((r) => r.role), ["az", "el"]);
  } finally {
    tools.find = origFind;
    await hamlib.stopAll();
    hamlib.configure({ spawn: null });
    config.applyEndpoints({ rotorType: prev.rotorType, rotorHamlibModel: null, rotorHamlibSplit: false, rotorHamlibElDevice: "", rotorAzDevice: prev.rotorAzDevice, rotorBaud: prev.rotorBaud });
  }
});

test("driver: slow rotctld (RT-21 -R, p > 1 s): one poll at a time, Park is not queued behind polls", async () => {
  // Brian, alpha.18 (Windows, RT-21 -R): Park took seconds to start. rotctld's RT-21 backend sleeps
  // 500 ms after every write, so "p" with -R takes > 1 s; a 1 s poll interval used to pile up "p".
  const net = require("net");
  let queued = 0, maxQueued = 0, pDone = null;
  const cmds = [];
  let lock = Promise.resolve();
  const server = net.createServer((s) => {
    let b = "";
    s.on("error", () => {});
    s.on("data", (d) => {
      b += d;
      let i;
      while ((i = b.indexOf("\n")) >= 0) {
        const c = b.slice(0, i).trim();
        b = b.slice(i + 1);
        if (c === "p") maxQueued = Math.max(maxQueued, ++queued);
        lock = lock.then(() => new Promise((r) => setTimeout(() => {
          cmds.push(c);
          if (c === "p") { queued--; s.write("10.0\n20.0\n"); } else { if (c[0] === "P" && !pDone) pDone = Date.now(); s.write("RPRT 0\n"); }
          r();
        }, c === "p" ? 1100 : 300)));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  hrot._setDeps({ endpoint: () => ({ host: "127.0.0.1", port: server.address().port }) });
  const prev = { type: config.ROTOR_TYPE, parkAz: config.ROTOR_PARK_AZ, parkEl: config.ROTOR_PARK_EL };
  config.applyEndpoints({ rotorType: "hamlib", rotorParkAz: 90, rotorParkEl: 10 });
  try {
    hrot.setAntenna(true);
    await sleep(5500);
    const t = Date.now();
    hrot.park();
    while (!pDone && Date.now() - t < 10000) await sleep(20);
    assert.ok(pDone, "P sent");
    // at most the in-flight "p" (1.1 s) + P (0.3 s) ahead; old code waited ~1.5 s more and grew
    assert.ok(pDone - t < 1700, "Park reached rotctld after " + (pDone - t) + " ms");
    assert.ok(maxQueued <= 1, "polls outstanding at once: " + maxQueued);
    assert.ok(cmds.includes("P 90.0 10.0"), cmds.join("|"));
  } finally {
    hrot._setDeps({ endpoint: null });
    server.close();
    config.applyEndpoints({ rotorType: prev.type, rotorParkAz: prev.parkAz, rotorParkEl: prev.parkEl });
  }
});

test("driver: moves coalesce (no stale backlog) and a move cut off by a reconnect is resent, not failed", async () => {
  // Brian, alpha.18: 6x "move failed: rotctld disconnected" — a backlog of queued P dropped on reconnect.
  const net = require("net");
  const cmds = [];
  let lock = Promise.resolve();
  const server = net.createServer((s) => {
    let b = "";
    s.on("error", () => {});
    s.on("data", (d) => {
      b += d;
      let i;
      while ((i = b.indexOf("\n")) >= 0) {
        const c = b.slice(0, i).trim();
        b = b.slice(i + 1);
        lock = lock.then(() => new Promise((r) => setTimeout(() => {
          cmds.push(c);
          if (!s.destroyed) s.write(c === "p" ? "10.0\n20.0\n" : "RPRT 0\n");
          r();
        }, c === "p" ? 600 : 100)));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  hrot._setDeps({ endpoint: () => ({ host: "127.0.0.1", port: server.address().port }) });
  const prev = { type: config.ROTOR_TYPE, minEl: config.ROTOR_MIN_EL };
  config.applyEndpoints({ rotorType: "hamlib", rotorMinEl: 0 });
  const warns = [];
  const ow = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    hrot.setAntenna(true);
    await sleep(100);
    // several tracking ticks while a poll is in flight: only the newest move is sent
    for (let k = 0; k < 6; k++) hrot.updateTracking({ az: 100 + k * 5, el: 30 }, null, null, { minEl: 0 });
    await sleep(1000);
    const P = cmds.filter((c) => c[0] === "P");
    assert.ok(P.length <= 2, "moves sent: " + P.join("|"));
    assert.strictEqual(P[P.length - 1], "P 125.0 30.0");
    // a move queued behind a poll, then our own reconnect (endpoint re-apply): resent after connect
    await sleep(50);
    hrot.updateTracking({ az: 200, el: 40 }, null, null, { minEl: 0 });
    hrot.applyEndpointChange();
    for (let t = 0; t < 60 && !cmds.includes("P 200.0 40.0"); t++) await sleep(50);
    assert.ok(cmds.includes("P 200.0 40.0"), cmds.join("|"));
    assert.ok(!warns.some((w) => /move failed/.test(w)), warns.join("|"));
  } finally {
    console.warn = ow;
    hrot._setDeps({ endpoint: null });
    server.close();
    config.applyEndpoints({ rotorType: prev.type, rotorMinEl: prev.minEl });
  }
});

test("driver: Park during contention (2nd client polling, slow reads) is the next P and is not overridden; Stop reaches rotctld", async () => {
  // Brian, alpha.18: PSTRotator also on 4537; Park pressed twice, rotor kept tracking (stale P backlog).
  const net = require("net");
  const cmds = [];
  let lock = Promise.resolve();
  const server = net.createServer((s) => {
    let b = "";
    s.on("error", () => {});
    s.on("data", (d) => {
      b += d;
      let i;
      while ((i = b.indexOf("\n")) >= 0) {
        const c = b.slice(0, i).trim();
        b = b.slice(i + 1);
        lock = lock.then(() => new Promise((r) => setTimeout(() => {
          if (!s.other) cmds.push(c);
          if (!s.destroyed) s.write(c === "p" ? "10.0\n20.0\n" : "RPRT 0\n");
          r();
        }, c === "p" ? 400 : 150)));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  // "PSTRotator": a second client polling all the time (rotctld runs one command at a time)
  const other = net.connect(port, "127.0.0.1");
  other.on("error", () => {});
  let otherOn = true;
  server.once("connection", (s) => (s.other = true));
  other.on("data", () => otherOn && setTimeout(() => otherOn && other.write("p\n"), 50));
  other.on("connect", () => other.write("p\n"));
  await sleep(100);
  hrot._setDeps({ endpoint: () => ({ host: "127.0.0.1", port }) });
  const prev = { type: config.ROTOR_TYPE, minEl: config.ROTOR_MIN_EL, parkAz: config.ROTOR_PARK_AZ, parkEl: config.ROTOR_PARK_EL };
  config.applyEndpoints({ rotorType: "hamlib", rotorMinEl: 0, rotorParkAz: 90, rotorParkEl: 10 });
  try {
    hrot.setAntenna(true);
    await sleep(200);
    // tracking ticks every 100 ms for 3 s: moves keep landing, no backlog
    for (let k = 0; k < 30; k++) {
      hrot.updateTracking({ az: 100 + k * 3, el: 20 + k }, null, null, { minEl: 0 });
      await sleep(100);
    }
    const tracked = cmds.filter((c) => c[0] === "P").length;
    assert.ok(tracked >= 3, "tracking moves landed: " + tracked);
    const n = cmds.length;
    hrot.updateTracking({ az: 250, el: 60 }, null, null, { minEl: 0 }); // queued behind a poll
    hrot.park();
    for (let k = 0; k < 10; k++) {
      hrot.updateTracking({ az: 260 + k, el: 61 + k }, null, null, { minEl: 0 }); // tracker ticks keep coming
      await sleep(100);
    }
    const after = cmds.slice(n).filter((c) => c[0] === "P");
    assert.ok(after.length >= 1, cmds.slice(n).join("|"));
    // at most the move already on the wire, then Park; nothing after Park
    assert.strictEqual(after[after.length - 1], "P 90.0 10.0", after.join("|"));
    assert.ok(after.length <= 2, after.join("|"));
    // Antenna off: S is sent before the socket closes
    hrot.setAntenna(false);
    for (let k = 0; k < 40 && !cmds.includes("S"); k++) await sleep(50);
    assert.ok(cmds.includes("S"), cmds.slice(-5).join("|"));
  } finally {
    otherOn = false;
    other.destroy();
    hrot._setDeps({ endpoint: null });
    server.close();
    config.applyEndpoints({ rotorType: prev.type, rotorMinEl: prev.minEl, rotorParkAz: prev.parkAz, rotorParkEl: prev.parkEl });
  }
});

test("driver: Park like native RT-21 — at the park position, Antenna turns off (tracking released)", async () => {
  const st = await fakeRotctld(0);
  hrot._setDeps({ endpoint: () => ({ host: "127.0.0.1", port: st.server.address().port }) });
  const prev = { type: config.ROTOR_TYPE, parkAz: config.ROTOR_PARK_AZ, parkEl: config.ROTOR_PARK_EL };
  config.applyEndpoints({ rotorType: "hamlib", rotorParkAz: 10, rotorParkEl: 20 }); // the fake reads 10 / 20
  try {
    hrot.setAntenna(true);
    await sleep(150);
    hrot.park();
    for (let k = 0; k < 40 && hrot.getRotorState().antennaOn; k++) await sleep(100);
    assert.strictEqual(hrot.getRotorState().antennaOn, false);
    assert.ok(st.cmds.includes("P 10.0 20.0"), st.cmds.join("|"));
    // Antenna off after park: our client goes quiet (no P, no polls) so PSTRotator etc. can drive
    await sleep(300);
    const n = st.cmds.length;
    hrot.updateTracking({ az: 200, el: 45 }, null, null, { minEl: 0 });
    await sleep(2500);
    assert.deepStrictEqual(st.cmds.slice(n), [], "commands after park complete");
    assert.strictEqual(hrot.getRotorState().azConnected, false);
  } finally {
    hrot._setDeps({ endpoint: null });
    st.server.close();
    config.applyEndpoints({ rotorType: prev.type, rotorParkAz: prev.parkAz, rotorParkEl: prev.parkEl });
  }
});
