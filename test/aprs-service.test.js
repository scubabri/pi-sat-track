// APRS service: KISS client lifecycle (disabled = no connect, reconnect),
// RX -> packets, TX gates + exact AX.25/KISS bytes, one-shot Test probe.
// Run: node --test --test-force-exit test/aprs-service.test.js
const test = require("node:test");
const assert = require("assert");
const net = require("net");
const os = require("os");
const fs = require("fs");
const path = require("path");

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pst-aprs-"));
process.env.HOME = TMP_HOME; // daily packet log lands here, never in the real ~/.rpitrack

const kiss = require("../lib/kiss/kiss");
const ax25 = require("../lib/ax25");
const { TcpTransport } = require("../lib/kiss/tcp");
const svcMod = require("../lib/aprs/service");
const { createService, normalizeConfig, checkGate, testKissTcp, isSatPath, viaForSat } = svcMod;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 3000)) {
    if (fn()) return true;
    await wait(20);
  }
  return false;
}

/** Fake KISS TNC: counts connections, records received bytes, can push frames. */
function fakeTnc() {
  return new Promise((resolve) => {
    const socks = [];
    const rx = [];
    let conns = 0;
    const srv = net.createServer((s) => {
      conns++;
      socks.push(s);
      const dec = new kiss.Decoder();
      s.on("data", (b) => dec.push(b).forEach((f) => rx.push(f)));
      s.on("error", () => {});
    });
    srv.listen(0, "127.0.0.1", () =>
      resolve({
        port: srv.address().port,
        conns: () => conns,
        open: () => socks.filter((s) => !s.destroyed).length,
        rx,
        push: (frame) => socks.forEach((s) => !s.destroyed && s.write(kiss.encode(frame))),
        dropAll: () => socks.forEach((s) => s.destroy()),
        close: () => new Promise((r) => (socks.forEach((s) => s.destroy()), srv.close(r))),
      }),
    );
  });
}

function makeSvc(tnc, ctx, extra) {
  const out = [];
  const svc = createService(
    Object.assign(
      {
        broadcast: (m) => out.push(m),
        log: () => {},
        getStation: () => ({ callsign: "K0TEST", grid: "DN40" }),
        getTxContext: () => ctx,
        createTransport: (c) => new TcpTransport({ host: c.host, port: c.port, reconnectInitialMs: 50, reconnectMaxMs: 200 }),
      },
      extra || {},
    ),
  );
  return { svc, out };
}
const ISS_UP = { radioOn: true, sat: { satKey: "ISS", satName: "ISS", mode: "1k2 AFSK", el: 35, norad: 25544 } };

test("config defaults: SSID none, path ARISS, Graywolf port 6700, TX off, disabled", () => {
  const c = normalizeConfig(null);
  assert.strictEqual(c.ssid, "");
  assert.strictEqual(c.path, "ARISS");
  assert.strictEqual(c.port, 6700);
  assert.strictEqual(c.enabled, false);
  assert.strictEqual(c.txEnabled, false);
  assert.strictEqual(c.host, "");
  assert.strictEqual(normalizeConfig({ preset: "direwolf" }).port, 8001);
  assert.strictEqual(normalizeConfig({ ssid: "-7" }).ssid, "7");
  assert.strictEqual(normalizeConfig({ ssid: "0" }).ssid, "");
  assert.strictEqual(normalizeConfig({ ssid: "22" }).ssid, "");
  assert.strictEqual(normalizeConfig({ path: "bad path!!" }).path, "ARISS");
});

test("disabled = no connection attempts; enabling connects; disabling closes and stops reconnects", async () => {
  const tnc = await fakeTnc();
  const { svc } = makeSvc(tnc, ISS_UP);
  svc.configure({ enabled: false, host: "127.0.0.1", port: tnc.port });
  await wait(400);
  assert.strictEqual(tnc.conns(), 0, "must not connect while disabled");
  assert.strictEqual(svc.statusPayload().state, "off");
  svc.configure({ enabled: true, host: "127.0.0.1", port: tnc.port });
  assert.ok(await until(() => svc.statusPayload().state === "connected"));
  assert.strictEqual(tnc.conns(), 1);
  svc.configure({ enabled: false, host: "127.0.0.1", port: tnc.port });
  assert.ok(await until(() => tnc.open() === 0), "socket closed on disable");
  await wait(500); // > reconnect backoff
  assert.strictEqual(tnc.conns(), 1, "no reconnect after disable");
  svc.stop();
  await tnc.close();
});

test("reconnects after the TNC drops the connection", async () => {
  const tnc = await fakeTnc();
  const { svc } = makeSvc(tnc, ISS_UP);
  svc.configure({ enabled: true, host: "127.0.0.1", port: tnc.port });
  assert.ok(await until(() => tnc.conns() === 1 && svc.statusPayload().state === "connected"));
  tnc.dropAll();
  assert.ok(await until(() => tnc.conns() === 2 && svc.statusPayload().state === "connected"), "reconnected");
  svc.stop();
  await tnc.close();
});

test("RX frames become packets (via-sat flag, own echo) and heard stations", async () => {
  const tnc = await fakeTnc();
  const { svc, out } = makeSvc(tnc, ISS_UP);
  svc.configure({ enabled: true, host: "127.0.0.1", port: tnc.port, logToFile: true });
  assert.ok(await until(() => svc.statusPayload().state === "connected"));
  tnc.push(ax25.encodeUI({ src: "N0SAT", dst: "APRS", path: [{ call: "RS0ISS", ssid: 0, h: true }], info: "!3944.50N/10459.00W`Denver" }));
  tnc.push(ax25.encodeUI({ src: "N0SAT", dst: "APRS", path: [{ call: "RS0ISS", ssid: 0, h: true }], info: ">thanks" }));
  tnc.push(ax25.encodeUI({ src: "K0TEST", dst: "APZPST", path: [{ call: "RS0ISS", ssid: 0, h: true }], info: ">echo" }));
  assert.ok(await until(() => out.filter((m) => m.type === "aprs-packet").length === 3));
  const pk = out.filter((m) => m.type === "aprs-packet").map((m) => m.packet);
  assert.strictEqual(pk[0].type, "position");
  assert.strictEqual(pk[0].viaSat, "RS0ISS");
  assert.strictEqual(pk[0].tnc2, "N0SAT>APRS,RS0ISS*:!3944.50N/10459.00W`Denver");
  assert.strictEqual(pk[1].plotSource, "last", "status plotted at the last known position");
  assert.strictEqual(pk[2].ownEcho, true);
  const heard = svc.heardPayload().stations;
  assert.ok(heard.find((s) => s.call === "N0SAT" && s.viaSat));
  // daily log under the (temp) HOME
  assert.ok(await until(() => fs.existsSync(svcMod.logFileFor(new Date()))));
  await until(() => fs.readFileSync(svcMod.logFileFor(new Date()), "utf8").split("\n").length > 3);
  const log = fs.readFileSync(svcMod.logFileFor(new Date()), "utf8");
  assert.match(log, /\tRX\tISS el=35\.0\tN0SAT>APRS,RS0ISS\*:!3944\.50N/);
  svc.stop();
  await tnc.close();
});

test("TX gates: disabled TX, radio off, sat below min el, non-APRS mode, rate limits", () => {
  const cfg = normalizeConfig({ enabled: true, txEnabled: true });
  const st = { callsign: "K0TEST", grid: "DN40" };
  const ok = Object.assign({ connected: true }, ISS_UP);
  assert.deepStrictEqual(checkGate(cfg, "beacon", "ARISS", ok, st), { ok: true, reasons: [] });
  const r1 = checkGate(normalizeConfig({ enabled: true }), "beacon", "ARISS", ok, st);
  assert.match(r1.reasons.join(), /Transmit is off/);
  assert.match(checkGate(cfg, "beacon", "ARISS", Object.assign({}, ok, { radioOn: false }), st).reasons.join(), /Radio is off/);
  const low = Object.assign({}, ok, { sat: Object.assign({}, ok.sat, { el: -3 }) });
  assert.match(checkGate(cfg, "beacon", "ARISS", low, st).reasons.join(), /below 0°/);
  assert.ok(checkGate(cfg, "message", "WIDE2-1", low, st).ok, "terrestrial path ignores sat elevation");
  const fm = Object.assign({}, ok, { sat: Object.assign({}, ok.sat, { mode: "FM" }) });
  assert.match(checkGate(cfg, "beacon", "ARISS", fm, st).reasons.join(), /not APRS/);
  assert.ok(checkGate(normalizeConfig({ enabled: true, txEnabled: true, txRequireAprsMode: false }), "beacon", "ARISS", fm, st).ok);
  assert.match(checkGate(cfg, "beacon", "ARISS", Object.assign({}, ok, { lastBeaconMs: Date.now() - 30000 }), st).reasons.join(), /min 60 s between beacons/);
  assert.match(checkGate(cfg, "message", "ARISS", Object.assign({}, ok, { lastMsgMs: Date.now() - 3000 }), st).reasons.join(), /min 10 s between messages/);
  assert.match(checkGate(cfg, "beacon", "ARISS", Object.assign({}, ok, { connected: false }), st).reasons.join(), /not connected/);
  assert.match(checkGate(cfg, "beacon", "ARISS", ok, { callsign: "" }).reasons.join(), /callsign/);
  assert.strictEqual(isSatPath("ARISS"), true);
  assert.strictEqual(isSatPath("WIDE1-1,WIDE2-1"), false);
  assert.strictEqual(isSatPath(""), false);
});

test("per-satellite Via override falls back to the default path, then ARISS", () => {
  const c = normalizeConfig({ path: "ARISS", satPaths: { "sonate-2": "dp0snx", "25544": "RS0ISS" } });
  assert.strictEqual(viaForSat(c, { satKey: "SONATE-2" }), "DP0SNX");
  assert.strictEqual(viaForSat(c, { satKey: "ISS", norad: 25544 }), "RS0ISS");
  assert.strictEqual(viaForSat(c, { satKey: "AO-91" }), "ARISS");
  assert.strictEqual(viaForSat(normalizeConfig({ path: "" }), null), "ARISS");
});

test("UISS model: To = AX.25 destination (default CQ), Via = path; message / position / UI text / header frames", async () => {
  const tnc = await fakeTnc();
  const { svc } = makeSvc(tnc, ISS_UP);
  svc.configure({ enabled: true, txEnabled: true, host: "127.0.0.1", port: tnc.port, logToFile: false, comment: "Pi Sat Track", msgIntervalS: 5 });
  assert.ok(await until(() => svc.statusPayload().state === "connected"));
  assert.strictEqual(svc.statusPayload().defaultTo, "CQ");
  // APRS message: For = addressee, To defaults to CQ (UISS "Fm ON6MU To CQ Via PCSAT-1 :EMAIL ...")
  const r = svc.send({ kind: "message", for: "rs0iss", via: "ARISS", text: "hello from DN40" });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(await until(() => tnc.rx.length === 1));
  const expect = ax25.encodeUI({ src: "K0TEST", dst: "CQ", path: "ARISS", info: ":RS0ISS   :hello from DN40" });
  assert.strictEqual(tnc.rx[0].port, 0);
  assert.strictEqual(tnc.rx[0].cmd, 0);
  assert.strictEqual(tnc.rx[0].data.toString("hex"), expect.toString("hex"));
  assert.strictEqual(r.packet.dst, "CQ");
  assert.strictEqual(r.packet.to, "RS0ISS");
  // rate limit applies to every non-beacon send
  const r2 = svc.send({ kind: "text", via: "ARISS", text: "again" });
  assert.strictEqual(r2.ok, false);
  assert.match(r2.reasons.join(), /between messages/);
  // position beacon uses the same To / Via header; "=" (messaging capable) like UISS
  const b = svc.send({ kind: "beacon", to: "aprs" });
  assert.ok(b.ok, JSON.stringify(b));
  assert.ok(await until(() => tnc.rx.length === 2));
  assert.strictEqual(ax25.toTnc2(ax25.decode(tnc.rx[1].data)), "K0TEST>APRS,ARISS:=4030.00N/11100.00W`Pi Sat Track");
  const r3 = svc.send({ kind: "beacon" });
  assert.strictEqual(r3.ok, false, "beacon rate limit");
  svc.stop();
  await tnc.close();
});

test("UI text is sent as typed (UISS Send UI Data); header only; invalid To / missing For rejected", async () => {
  const tnc = await fakeTnc();
  const { svc } = makeSvc(tnc, ISS_UP);
  svc.configure({ enabled: true, txEnabled: true, host: "127.0.0.1", port: tnc.port, logToFile: false, msgIntervalS: 5, defaultTo: "beacon" });
  assert.ok(await until(() => svc.statusPayload().state === "connected"));
  assert.match(svc.send({ kind: "text", to: "TOOLONGCALL", text: "x" }).reasons.join(), /Invalid To/);
  assert.match(svc.send({ kind: "text", to: "CQ-16", text: "x" }).reasons.join(), /Invalid To/);
  assert.match(svc.send({ kind: "message", to: "CQ", text: "x" }).reasons.join(), /addressee/);
  assert.match(svc.send({ kind: "text", to: "CQ", via: "ARISS", text: "x".repeat(81) }).reasons.join(), /max 80/);
  assert.strictEqual(tnc.rx.length, 0, "rejected sends write nothing");
  const r = svc.send({ kind: "text", to: "cq", via: "RS0ISS", text: ">JO20AW Hello all {UISS} | ~" });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(await until(() => tnc.rx.length === 1));
  assert.strictEqual(ax25.toTnc2(ax25.decode(tnc.rx[0].data)), "K0TEST>CQ,RS0ISS:>JO20AW Hello all {UISS} | ~");
  assert.strictEqual(r.packet.type, "status");
  await wait(5100);
  // header only: empty info, To defaults to the configured default (BEACON)
  const h = svc.send({ kind: "header", via: "RS0ISS" });
  assert.ok(h.ok, JSON.stringify(h));
  assert.ok(await until(() => tnc.rx.length === 2));
  const fr = ax25.decode(tnc.rx[1].data);
  assert.strictEqual(ax25.toTnc2(fr), "K0TEST>BEACON,RS0ISS:");
  assert.strictEqual(fr.info.length, 0);
  svc.stop();
  await tnc.close();
});

test("optional SSID is used when set", async () => {
  const tnc = await fakeTnc();
  const { svc } = makeSvc(tnc, ISS_UP);
  svc.configure({ enabled: true, txEnabled: true, host: "127.0.0.1", port: tnc.port, logToFile: false, ssid: "9" });
  assert.ok(await until(() => svc.statusPayload().state === "connected"));
  assert.ok(svc.send({ kind: "text", to: "CQ", via: "ARISS", text: ">QRV" }).ok);
  assert.ok(await until(() => tnc.rx.length === 1));
  assert.strictEqual(ax25.toTnc2(ax25.decode(tnc.rx[0].data)), "K0TEST-9>CQ,ARISS:>QRV");
  svc.stop();
  await tnc.close();
});

test("config: default To CQ (UISS), Connection TCP / Bluetooth (old 'serial' maps to Bluetooth)", () => {
  const d = normalizeConfig(null);
  assert.strictEqual(d.defaultTo, "CQ");
  assert.strictEqual(d.transport, "tcp");
  assert.strictEqual(normalizeConfig({ defaultTo: "aprsat" }).defaultTo, "APRSAT");
  assert.strictEqual(normalizeConfig({ defaultTo: "not a call" }).defaultTo, "CQ");
  assert.strictEqual(normalizeConfig({ transport: "serial" }).transport, "bluetooth");
  assert.strictEqual(normalizeConfig({ transport: "bluetooth" }).transport, "bluetooth");
  assert.strictEqual(normalizeConfig({ transport: "bogus" }).transport, "tcp");
  assert.strictEqual(normalizeConfig({ transport: "bluetooth" }).serialDevice, "/dev/rfcomm0");
  const { createTransport } = require("../lib/kiss/client");
  for (const t of ["bluetooth", "serial"]) {
    const tr = createTransport(normalizeConfig({ transport: t }));
    assert.match(tr.describe(), /rfcomm0/);
  }
});

test("one-shot Test: connects, counts KISS frames, sends nothing, closes; refused reported", async () => {
  const tnc = await fakeTnc();
  const srv = net.createServer();
  const got = [];
  srv.on("connection", (s) => {
    s.on("data", (b) => got.push(b));
    s.on("error", () => {});
    s.write(kiss.encode(ax25.encodeUI({ src: "N0SAT", dst: "APRS", info: ">hello" })));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const r = await testKissTcp("127.0.0.1", port, { listenMs: 300 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.frames, 1);
  assert.strictEqual(r.sample, "N0SAT>APRS:>hello");
  assert.strictEqual(got.length, 0, "test must not send anything");
  await new Promise((r2) => srv.close(r2));
  const bad = await testKissTcp("127.0.0.1", port, { listenMs: 100 });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.code, "ECONNREFUSED");
  assert.match(bad.error, /refused/);
  const inv = await testKissTcp("127.0.0.1", "0");
  assert.strictEqual(inv.ok, false);
  // works while the service is disabled and does not start the client
  const { svc } = makeSvc(tnc, ISS_UP);
  svc.configure({ enabled: false, host: "127.0.0.1", port: tnc.port });
  const t = await svc.testTcp("127.0.0.1", tnc.port, { listenMs: 100 });
  assert.strictEqual(t.ok, true);
  await wait(100);
  assert.strictEqual(svc.statusPayload().state, "off");
  assert.strictEqual(tnc.rx.length, 0);
  svc.stop();
  await tnc.close();
});
