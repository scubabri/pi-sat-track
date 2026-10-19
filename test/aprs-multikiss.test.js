// Several KISS connections (Graywolf one channel per TCP port + Direwolf
// 9600): migration of the old single endpoint, one client per enabled
// connection, RX tagged + de-duplicated across connections, TX routed by
// role and speed, clear errors when no matching connection exists.
// Run: node --test --test-force-exit test/aprs-multikiss.test.js
const test = require("node:test");
const assert = require("assert");
const net = require("net");
const os = require("os");
const fs = require("fs");
const path = require("path");

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pst-aprs-mk-"));

const kiss = require("../lib/kiss/kiss");
const ax25 = require("../lib/ax25");
const { TcpTransport } = require("../lib/kiss/tcp");
const { createService, normalizeConfig, routeTx } = require("../lib/aprs/service");
const { speedForSat, catalogEntry } = require("../lib/aprs/sat-speeds");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 3000)) {
    if (fn()) return true;
    await wait(20);
  }
  return false;
}
function fakeTnc() {
  return new Promise((resolve) => {
    const socks = [];
    const rx = [];
    const srv = net.createServer((s) => {
      socks.push(s);
      const dec = new kiss.Decoder();
      s.on("data", (b) => dec.push(b).forEach((f) => rx.push(f)));
      s.on("error", () => {});
    });
    srv.listen(0, "127.0.0.1", () =>
      resolve({
        port: srv.address().port,
        rx,
        open: () => socks.filter((s) => !s.destroyed).length,
        push: (frame) => socks.forEach((s) => !s.destroyed && s.write(kiss.encode(frame))),
        close: () => new Promise((r) => (socks.forEach((s) => s.destroy()), srv.close(r))),
      }),
    );
  });
}
function makeSvc(ctx) {
  const out = [];
  const svc = createService({
    broadcast: (m) => out.push(m),
    log: () => {},
    getStation: () => ({ callsign: "K0TEST", grid: "DN40" }),
    getTxContext: () => ctx.v,
    createTransport: (c) => new TcpTransport({ host: c.host, port: c.port, reconnectInitialMs: 50, reconnectMaxMs: 200 }),
  });
  return { svc, out };
}
const ISS = { satKey: "ISS", satName: "ISS", mode: "APRS 1k2 AFSK", el: 40, norad: 25544 };
const CROCUBE = { satKey: "CROCUBE", satName: "CroCube", mode: "Digi 9k6 GFSK", el: 40, norad: 62394 };
const frame = (src, info, pathCalls) => ax25.encodeUI({ src, dst: "APRS", path: (pathCalls || []).map((c) => ax25.parseAddr(c)), info });

test("migration: the old single endpoint becomes row 1 (RX+TX, 1200), host/port/kissPort/transport kept", () => {
  const c = normalizeConfig({ enabled: true, preset: "graywolf", transport: "tcp", host: "192.168.1.50", port: 8002, kissPort: 3, txEnabled: true });
  assert.strictEqual(c.enabled, true);
  assert.strictEqual(c.connections.length, 1);
  const r = c.connections[0];
  assert.deepStrictEqual(
    { host: r.host, port: r.port, kissPort: r.kissPort, transport: r.transport, role: r.role, speed: r.speed, enabled: r.enabled, preset: r.preset },
    { host: "192.168.1.50", port: 8002, kissPort: 3, transport: "tcp", role: "rxtx", speed: 1200, enabled: true, preset: "graywolf" },
  );
  assert.strictEqual(r.name, "Graywolf");
  assert.ok(!("host" in c) && !("port" in c), "top-level endpoint fields are gone");
  // bluetooth (old "serial") migrates too
  const b = normalizeConfig({ transport: "serial", serialDevice: "/dev/rfcomm1", serialBaud: 19200 }).connections[0];
  assert.deepStrictEqual([b.transport, b.serialDevice, b.serialBaud], ["bluetooth", "/dev/rfcomm1", 19200]);
  // round-trip is stable
  assert.deepStrictEqual(normalizeConfig(c), c);
});

test("connections: ids unique, role / speed validated, max 8, defaultTxConn must exist, satSpeeds 1200/9600 only", () => {
  const c = normalizeConfig({
    connections: [{ id: "a", name: "FLEX ch1", port: 8001, role: "tx" }, { id: "a", port: 8002, role: "bogus", speed: 4800 }, { name: "Direwolf 9k6", preset: "direwolf", port: 8003, speed: 9600 }],
    defaultTxConn: "nope",
    satSpeeds: { crocube: 9600, iss: "1200", foo: 4800 },
  });
  assert.deepStrictEqual(c.connections.map((x) => x.id), ["a", "c2", "c3"]);
  assert.strictEqual(c.connections[1].role, "rxtx");
  assert.strictEqual(c.connections[1].speed, 1200);
  assert.strictEqual(c.connections[2].speed, 9600);
  assert.strictEqual(c.defaultTxConn, "");
  assert.deepStrictEqual(c.satSpeeds, { CROCUBE: 9600, ISS: 1200 });
  assert.strictEqual(normalizeConfig({ connections: Array.from({ length: 12 }, () => ({})) }).connections.length, 8);
  assert.strictEqual(normalizeConfig({ connections: [] }).connections.length, 0);
});

test("sat speeds: AMSAT list (ISS 1200, CroCube 9600), mode text fallback, per-sat setting wins", () => {
  assert.deepStrictEqual(speedForSat({}, ISS), { speed: 1200, source: "amsat" });
  assert.deepStrictEqual(speedForSat({}, { satName: "ISS (ZARYA)" }), { speed: 1200, source: "amsat" });
  assert.deepStrictEqual(speedForSat({}, CROCUBE), { speed: 9600, source: "amsat" });
  assert.strictEqual(catalogEntry({ satName: "Marina" }).speed, 9600);
  assert.strictEqual(catalogEntry({ satName: "SONATE-2" }).speed, 1200);
  assert.deepStrictEqual(speedForSat({}, { satName: "NEWSAT", mode: "Digipeater 9k6 GMSK" }), { speed: 9600, source: "mode" });
  assert.deepStrictEqual(speedForSat({}, { satName: "NEWSAT", mode: "FM" }), { speed: 1200, source: "default" });
  assert.deepStrictEqual(speedForSat({ ISS: 9600 }, ISS), { speed: 9600, source: "setting" });
  assert.deepStrictEqual(speedForSat({ 62394: 1200 }, CROCUBE), { speed: 1200, source: "setting" });
});

const CFG = {
  enabled: true,
  connections: [
    { id: "gw1", name: "FLEX ch1", port: 8001, role: "rxtx", speed: 1200 },
    { id: "gw2", name: "VHF Dax 3", port: 8002, role: "rx", speed: 1200 },
    { id: "dw", name: "Direwolf 9600", preset: "direwolf", port: 8003, role: "rxtx", speed: 9600 },
  ],
};
const all = () => true;

test("TX routing by role and speed; terrestrial uses the Default TX connection", () => {
  const c = normalizeConfig(CFG);
  let r = routeTx(c, ISS, "ARISS", all);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.conn.id, "gw1");
  assert.strictEqual(r.speed, 1200);
  assert.strictEqual(r.satRoute, true);
  r = routeTx(c, CROCUBE, "9A0CC", all);
  assert.strictEqual(r.conn.id, "dw");
  assert.strictEqual(r.speed, 9600);
  // no sat -> default (auto = first TX-capable 1200 connection; never the RX-only one)
  r = routeTx(c, null, "WIDE1-1", all);
  assert.strictEqual(r.conn.id, "gw1");
  assert.strictEqual(r.satRoute, false);
  // sat selected but terrestrial Via -> default too
  assert.strictEqual(routeTx(c, CROCUBE, "WIDE2-1", all).conn.id, "gw1");
  // explicit default
  const c2 = normalizeConfig(Object.assign({}, CFG, { defaultTxConn: "dw" }));
  assert.strictEqual(routeTx(c2, null, "", all).conn.id, "dw");
  // RX-only / disabled default -> clear error
  const c3 = normalizeConfig(Object.assign({}, CFG, { defaultTxConn: "gw2" }));
  const e3 = routeTx(c3, null, "", all);
  assert.strictEqual(e3.ok, false);
  assert.match(e3.reason, /Default TX connection "VHF Dax 3" is RX-only/);
  // matching speed: prefers the connected one
  const two = normalizeConfig({ enabled: true, connections: [{ id: "x", port: 1, speed: 1200 }, { id: "y", port: 2, speed: 1200 }] });
  assert.strictEqual(routeTx(two, ISS, "ARISS", (id) => id === "y").conn.id, "y");
  assert.strictEqual(routeTx(two, ISS, "ARISS", (id) => id === "y").connected, true);
});

test("missing connection: 'No 9600 TX connection configured', RX-only does not count, none enabled", () => {
  const c = normalizeConfig({ enabled: true, connections: [{ id: "a", name: "FLEX ch1", role: "rxtx" }, { id: "b", name: "DW", speed: 9600, role: "rx" }] });
  const r = routeTx(c, CROCUBE, "9A0CC", all);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /^No 9600 TX connection configured for CroCube/);
  assert.match(r.reason, /FLEX ch1 = 1200/);
  const off = normalizeConfig({ enabled: true, connections: [{ id: "a", enabled: false }] });
  assert.match(routeTx(off, ISS, "ARISS", all).reason, /No KISS connection enabled/);
  const rxOnly = normalizeConfig({ enabled: true, connections: [{ id: "a", role: "rx" }] });
  assert.match(routeTx(rxOnly, null, "", all).reason, /No TX connection configured/);
});

test("service: one client per enabled connection, RX from all RX-capable ones tagged, TX-only RX ignored, dedupe across connections", async () => {
  const t1 = await fakeTnc();
  const t2 = await fakeTnc();
  const t3 = await fakeTnc();
  const t4 = await fakeTnc(); // disabled row: must never be connected
  const ctx = { v: { radioOn: true, sat: ISS } };
  const { svc, out } = makeSvc(ctx);
  svc.configure({
    enabled: true,
    logToFile: false,
    connections: [
      { id: "a", name: "FLEX ch1", host: "127.0.0.1", port: t1.port, role: "rxtx" },
      { id: "b", name: "VHF Dax 3", host: "127.0.0.1", port: t2.port, role: "rx" },
      { id: "c", name: "TX only", host: "127.0.0.1", port: t3.port, role: "tx" },
      { id: "d", name: "Off", host: "127.0.0.1", port: t4.port, enabled: false },
    ],
  });
  assert.ok(await until(() => svc.statusPayload().state === "connected" && t1.open() && t2.open() && t3.open()));
  const st = svc.statusPayload();
  assert.strictEqual(st.connections.length, 4);
  assert.deepStrictEqual(st.connections.map((x) => x.state), ["connected", "connected", "connected", "off"]);
  assert.strictEqual(t4.open(), 0);
  const pkts = () => out.filter((m) => m.type === "aprs-packet").map((m) => m.packet);
  t1.push(frame("N0AAA", ">hello one"));
  t2.push(frame("N0BBB", ">hello two"));
  t3.push(frame("N0CCC", ">heard on TX-only"));
  assert.ok(await until(() => pkts().length >= 2));
  await wait(150);
  assert.deepStrictEqual(pkts().map((p) => [p.src, p.conn]).sort(), [["N0AAA", "FLEX ch1"], ["N0BBB", "VHF Dax 3"]]);
  // the same packet on two connections -> one packet, both names
  t1.push(frame("K7TX-10", "!4025.41NS11150.07W#PHG2160 APRS Digi & iGate", ["SHEPRD*"]));
  await wait(60);
  t2.push(frame("K7TX-10", "!4025.41NS11150.07W#PHG2160 APRS Digi & iGate", ["SHEPRD*"]));
  assert.ok(await until(() => out.some((m) => m.type === "aprs-packet-dup")));
  const k = pkts().filter((p) => p.src === "K7TX-10");
  assert.strictEqual(k.length, 1);
  assert.deepStrictEqual(k[0].conns, ["FLEX ch1", "VHF Dax 3"]);
  // a different path (digipeated copy) is a separate packet
  t2.push(frame("K7TX-10", "!4025.41NS11150.07W#PHG2160 APRS Digi & iGate", ["KF6RAL-1*", "SHEPRD*"]));
  assert.ok(await until(() => pkts().filter((p) => p.src === "K7TX-10").length === 2));
  // same connection twice is not de-duplicated (kept as before)
  t1.push(frame("N0AAA", ">again"));
  t1.push(frame("N0AAA", ">again"));
  assert.ok(await until(() => pkts().filter((p) => p.text && /again/.test(p.tnc2)).length === 2));
  // heard store keeps the connection name for the popup
  assert.strictEqual(svc._store.get("N0BBB").conn, "VHF Dax 3");
  // disabling a row stops just that client
  svc.configure(Object.assign({}, svc.getConfig(), { connections: svc.getConfig().connections.map((c) => (c.id === "b" ? Object.assign({}, c, { enabled: false }) : c)) }));
  assert.ok(await until(() => t2.open() === 0));
  assert.ok(t1.open() >= 1);
  svc.stop();
  await Promise.all([t1, t2, t3, t4].map((t) => t.close()));
});

test("service: TX goes out on the routed connection only; 9600 sat without a 9600 TX connection is blocked", async () => {
  const gw = await fakeTnc();
  const dw = await fakeTnc();
  const ctx = { v: { radioOn: true, sat: ISS } };
  const { svc } = makeSvc(ctx);
  const base = {
    enabled: true,
    txEnabled: true,
    logToFile: false,
    connections: [
      { id: "gw", name: "FLEX ch1", host: "127.0.0.1", port: gw.port, role: "rxtx", speed: 1200 },
      { id: "dw", name: "Direwolf 9600", host: "127.0.0.1", port: dw.port, role: "tx", speed: 9600 },
    ],
  };
  svc.configure(base);
  assert.ok(await until(() => svc.statusPayload().state === "connected"));
  assert.strictEqual(svc.statusPayload().txRoute.conn.name, "FLEX ch1");
  let r = svc.send({ kind: "text", text: ">via ISS", via: "ARISS" });
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
  assert.strictEqual(r.packet.conn, "FLEX ch1");
  assert.ok(await until(() => gw.rx.length === 1));
  assert.strictEqual(dw.rx.length, 0);
  ctx.v = { radioOn: true, sat: CROCUBE };
  const st = svc.statusPayload();
  assert.strictEqual(st.sat.speed, 9600);
  assert.strictEqual(st.txRoute.conn.name, "Direwolf 9600");
  // configured path terrestrial: the sat route for a typed sat Via is still published
  svc.configure(Object.assign({}, base, { path: "WIDE1-1,WIDE2-1" }));
  assert.strictEqual(svc.statusPayload().txRoute.satRoute, false);
  assert.strictEqual(svc.statusPayload().txRouteSat.conn.name, "Direwolf 9600");
  assert.ok(!/No 9600/.test(svc.statusPayload().gateMessageSat.reasons.join()));
  svc.configure(base);
  assert.ok(await until(() => svc.statusPayload().state === "connected"));
  r = svc.send({ kind: "text", text: ">via CroCube", via: "9A0CC" });
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
  assert.ok(await until(() => dw.rx.length === 1));
  assert.strictEqual(gw.rx.length, 1);
  // drop the 9600 row: blocked with a clear reason, nothing written
  svc.configure(Object.assign({}, base, { connections: [base.connections[0]] }));
  const g = svc.statusPayload().gateMessage;
  assert.strictEqual(g.ok, false);
  assert.match(g.reasons[0], /No 9600 TX connection configured/);
  r = svc.send({ kind: "text", text: ">nope", via: "9A0CC" });
  assert.strictEqual(r.ok, false);
  assert.match(r.reasons.join(), /No 9600 TX connection configured/);
  // routed connection down -> named in the reason
  ctx.v = { radioOn: true, sat: ISS };
  await gw.close();
  assert.ok(await until(() => /not connected/.test(svc.statusPayload().gateMessage.reasons.join())));
  assert.match(svc.statusPayload().gateMessage.reasons.join(), /KISS connection "FLEX ch1" not connected/);
  svc.stop();
  await dw.close();
});

test("known 9600 digipeater: no 'not an APRS mode' hint for mode text 9k6_GFSK; mode never blocks", () => {
  const { checkGate } = require("../lib/aprs/service");
  const cfg = normalizeConfig({ enabled: true, txEnabled: true });
  const st = { callsign: "K0TEST", grid: "DN40" };
  const knack = { satKey: "HS-0K", satName: "HS-0K", satFullName: "KNACKSAT-2", norad: 67683, mode: "9k6_GFSK", el: 30 };
  assert.deepStrictEqual(speedForSat({}, knack), { speed: 9600, source: "amsat" });
  assert.ok(checkGate(cfg, "message", "WIDE2-1", { connected: true, radioOn: true, sat: knack }, st).ok);
  assert.ok(checkGate(cfg, "message", "HS0K", { connected: true, radioOn: true, sat: knack }, st).ok);
  const unknown = Object.assign({}, knack, { satKey: "X", satName: "X", satFullName: "", norad: 1 });
  assert.deepStrictEqual(checkGate(cfg, "message", "HS0K", { connected: true, radioOn: true, sat: knack }, st).hints, []);
  const g = checkGate(cfg, "message", "HS0K", { connected: true, radioOn: true, sat: unknown }, st);
  assert.ok(g.ok, "mode is only a hint");
  assert.match(g.hints.join(), /not an APRS/);
});
