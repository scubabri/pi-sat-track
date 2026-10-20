// APRS window: Digipeated badge age-out (heard expiry, LOS of its sat, Clear),
// Recent stations "Clear" (server heard store, every client), and the Via
// dropdown options (built-in satellite Vias with labels).
// Run: node --test --test-force-exit test/aprs-badge-clear.test.js
const test = require("node:test");
const assert = require("assert");
const net = require("net");
const os = require("os");
const fs = require("fs");
const path = require("path");

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pst-aprs-bc-"));

const kiss = require("../lib/kiss/kiss");
const ax25 = require("../lib/ax25");
const { TcpTransport } = require("../lib/kiss/tcp");
const { createService, viaOptions } = require("../lib/aprs/service");

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
        pushTnc2: (line) => socks.forEach((s) => !s.destroyed && s.write(kiss.encode(frame(line)))),
        close: () => new Promise((r) => (socks.forEach((s) => s.destroy()), srv.close(r))),
      }),
    );
  });
}
/** TNC2 -> AX.25 UI frame (hops up to the last * have the H bit). */
function frame(line) {
  const ci = line.indexOf(":");
  const [src, rest] = line.slice(0, ci).split(">");
  const parts = rest.split(",");
  const dst = parts.shift();
  let last = -1;
  parts.forEach((p, i) => p.endsWith("*") && (last = i));
  const p = parts.map((x, i) => Object.assign(ax25.parseAddr(x.replace(/\*$/, "")), { h: i <= last }));
  return ax25.encodeUI({ src, dst, path: p, info: Buffer.from(line.slice(ci + 1), "utf8") });
}
const ISS = { sat: { satKey: "ISS", satName: "ISS (ZARYA)", norad: 25544, mode: "APRS", el: 35, up: true } };
function makeSvc(file, extra) {
  const out = [];
  const svc = createService(
    Object.assign(
      {
        broadcast: (m) => out.push(m),
        log: () => {},
        getStation: () => ({ callsign: "KA7KDX", grid: "DN40" }),
        getTxContext: () => Object.assign({ radioOn: true, sat: null }, extra && extra.ctx),
        createTransport: (c) => new TcpTransport({ host: c.host, port: c.port, reconnectInitialMs: 50, reconnectMaxMs: 200 }),
        digipeatFile: file,
      },
      extra && extra.opts,
    ),
  );
  return { svc, out };
}
function cfgFor(t, more) {
  return Object.assign(
    {
      enabled: true,
      txEnabled: true,
      logToFile: false,
      ssid: 3,
      path: "WIDE1-1,WIDE2-1",
      connections: [{ id: "gw", name: "FLEX ch1", host: "127.0.0.1", port: t.port, role: "rxtx", speed: 1200 }],
    },
    more,
  );
}
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pst-dg-")), "digipeats.jsonl");
const txPkt = (svc) => svc.statusPayload().lastTx;

const { digiBadge, agoText } = require("../js/aprs-digi-badge");
const satSpeeds = require("../lib/aprs/sat-speeds");
const MIN = 60000;

test("digiBadge: shown until the heard expiry window, age from the first digipeat", () => {
  const t0 = 1_000_000_000;
  const last = { time: t0, digi: { state: "digipeated", by: ["KU5R-6"], firstMs: t0 + 5000 } };
  assert.deepStrictEqual(digiBadge(last, t0 + 5000 + 3 * MIN, 10 * MIN), { ageMs: 3 * MIN });
  assert.ok(digiBadge(last, t0 + 5000 + 10 * MIN, 10 * MIN), "still shown at exactly the window");
  assert.strictEqual(digiBadge(last, t0 + 5000 + 10 * MIN + 1, 10 * MIN), null, "gone after it");
  // waiting / no digipeat: aged from the send
  assert.strictEqual(digiBadge({ time: t0, digi: { state: "pending" } }, t0 + 61 * MIN, 60 * MIN), null);
  assert.ok(digiBadge({ time: t0, digi: { state: "none" } }, t0 + 59 * MIN, 60 * MIN));
  assert.strictEqual(digiBadge(null, t0, MIN), null);
});

test("digiBadge: LOS and Clear end it at once", () => {
  const t0 = 2_000_000_000;
  const base = { state: "digipeated", by: ["RS0ISS"], firstMs: t0 };
  assert.strictEqual(digiBadge({ time: t0, digi: Object.assign({}, base, { losMs: t0 + 1000 }) }, t0 + 2000, 60 * MIN), null);
  assert.strictEqual(digiBadge({ time: t0, digi: Object.assign({}, base, { clearedMs: t0 + 1000 }) }, t0 + 2000, 60 * MIN), null);
});

test("agoText", () => {
  assert.strictEqual(agoText(3000), "just now");
  assert.strictEqual(agoText(40000), "40 s ago");
  assert.strictEqual(agoText(3 * MIN + 20000), "3 min ago");
  assert.strictEqual(agoText(90 * MIN), "1.5 h ago");
});

test("server: digipeat records its sat; LOS of that sat latches losMs (other sat: no)", async () => {
  const t = await fakeTnc();
  const ctx = { radioOn: true, sat: { satKey: "ISS", satName: "ISS", mode: "APRS", el: 30 } };
  const { svc } = makeSvc(tmpFile(), { opts: { getTxContext: () => ctx } });
  svc.configure(cfgFor(t));
  assert.ok(await until(() => svc.statusPayload().state === "connected" && t.open()));
  const r = svc.send({ kind: "beacon", via: "ARISS" });
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
  assert.ok(await until(() => t.rx.length === 1));
  const info = r.packet.tnc2.slice(r.packet.tnc2.indexOf(":") + 1);
  t.pushTnc2("KA7KDX-3>CQ,RS0ISS*:" + info);
  assert.ok(await until(() => txPkt(svc).digi.state === "digipeated"));
  assert.strictEqual(txPkt(svc).digi.sat, "ISS");
  assert.strictEqual(txPkt(svc).digi.satUp, true);
  // another sat selected and below the horizon: not this TX's LOS
  ctx.sat = { satKey: "SONATE-2", el: -20 };
  assert.strictEqual(svc.checkDigiLos(), false);
  assert.ok(!txPkt(svc).digi.losMs);
  // ISS still up
  ctx.sat = { satKey: "ISS", el: 2 };
  assert.strictEqual(svc.checkDigiLos(), false);
  // ISS sets
  ctx.sat = { satKey: "ISS", el: -0.5 };
  assert.strictEqual(svc.checkDigiLos(1234), true);
  assert.strictEqual(txPkt(svc).digi.losMs, 1234);
  assert.strictEqual(svc.checkDigiLos(9999), false, "latched once");
  svc.stop();
  await t.close();
});

test("server: Clear recents empties the heard store for every client and dismisses the badge; packets / digipeats kept", async () => {
  const t = await fakeTnc();
  const { svc, out } = makeSvc(tmpFile());
  svc.configure(cfgFor(t));
  assert.ok(await until(() => svc.statusPayload().state === "connected" && t.open()));
  const r = svc.send({ kind: "beacon", via: "WIDE2-1" });
  assert.ok(await until(() => t.rx.length === 1));
  const info = r.packet.tnc2.slice(r.packet.tnc2.indexOf(":") + 1);
  t.pushTnc2("KA7KDX-3>APRS,KU5R-6*,WIDE2*:" + info);
  t.pushTnc2("N0CALL-9>APRS,WIDE2-1:!4000.00N/10500.00W>other");
  assert.ok(await until(() => svc.heardPayload().stations.length === 1 && txPkt(svc).digi.state === "digipeated"));
  const nPackets = svc.packetsPayload().packets.length;
  const nDigi = svc.digipeatsPayload().count;
  out.length = 0;
  svc.clearHeard();
  assert.strictEqual(svc.heardPayload().stations.length, 0);
  const heard = out.filter((m) => m.type === "aprs-heard");
  assert.ok(heard.length >= 1 && heard[0].stations.length === 0, "broadcast to every client at once");
  const st = out.find((m) => m.type === "aprs-status");
  assert.ok(st && st.lastTx.digi.clearedMs > 0, "badge dismissed in the pushed status");
  assert.strictEqual(digiBadge(st.lastTx, Date.now(), 60 * MIN), null);
  assert.strictEqual(svc.packetsPayload().packets.length, nPackets, "packet / Messages list kept");
  assert.strictEqual(svc.digipeatsPayload().count, nDigi, "session digipeat count kept");
  // a new digipeater of the same TX shows the badge again
  t.pushTnc2("KA7KDX-3>APRS,SHEPRD*,WIDE2*:" + info);
  assert.ok(await until(() => txPkt(svc).digi.by.includes("SHEPRD")));
  assert.ok(!txPkt(svc).digi.clearedMs);
  svc.stop();
  await t.close();
});

test("Via options: every catalog sat with a published Via, labelled; per-sat settings first", () => {
  const vals = satSpeeds.viaOptions().map((o) => o.value);
  for (const v of ["ARISS", "RS0ISS", "DP0SNX", "9A0CC", "HA2GRB", "OK0KST", "OK0LSR", "OM9MAR"]) assert.ok(vals.includes(v), v);
  const lab = Object.fromEntries(satSpeeds.viaOptions().map((o) => [o.value, o.label]));
  assert.strictEqual(lab.DP0SNX, "SONATE-2");
  assert.strictEqual(lab["9A0CC"], "CroCube · 9k6");
  const all = viaOptions({ satPaths: { "SONATE-2": "DP0SNX,WIDE2-1" }, path: "ARISS" });
  assert.deepStrictEqual(all[0], { value: "DP0SNX,WIDE2-1", label: "SONATE-2 · your setting" });
  assert.ok(all.some((o) => o.value === "WIDE2-1" && o.label === "terrestrial"));
  assert.strictEqual(new Set(all.map((o) => o.value)).size, all.length, "no duplicates");
});
