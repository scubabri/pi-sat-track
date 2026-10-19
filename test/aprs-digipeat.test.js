// Digipeat confirmation, the persistent digipeat log, and collapsing
// duplicate copies (same source + info) of a received packet.
// Run: node --test --test-force-exit test/aprs-digipeat.test.js
const test = require("node:test");
const assert = require("assert");
const net = require("net");
const os = require("os");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pst-aprs-dg-"));

const kiss = require("../lib/kiss/kiss");
const ax25 = require("../lib/ax25");
const { TcpTransport } = require("../lib/kiss/tcp");
const { createService, usedDigis, digipeatsCsv, normalizeConfig } = require("../lib/aprs/service");

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
      msgIntervalS: 5,
      connections: [{ id: "gw", name: "FLEX ch1", host: "127.0.0.1", port: t.port, role: "rxtx", speed: 1200 }],
    },
    more,
  );
}
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pst-dg-")), "digipeats.jsonl");
const txPkt = (svc) => svc.statusPayload().lastTx;

test("usedDigis: only H-bit hops; aliases dropped when a real call is present", () => {
  const d = (line) => usedDigis(ax25.decode(frame(line)));
  assert.deepStrictEqual(d("KA7KDX-3>APRS,SHEPRD*,WIDE1*,WIDE2-1:>hi"), ["SHEPRD"]);
  assert.deepStrictEqual(d("KA7KDX-3>APRS,SHEPRD,WIDE2-1:>hi"), []);
  assert.deepStrictEqual(d("KA7KDX-3>APRS,WIDE1-1,WIDE2-1:>hi"), []);
  assert.deepStrictEqual(d("KA7KDX-3>APRS,SHEPRD*,KF6RAL-1*,WIDE2*:>hi"), ["SHEPRD", "KF6RAL-1"]);
});

test("match: echo via SHEPRD* then KF6RAL-1* -> digipeated by both, logged, not a separate station", async () => {
  const t = await fakeTnc();
  const file = tmpFile();
  const { svc, out } = makeSvc(file);
  svc.configure(cfgFor(t));
  assert.ok(await until(() => svc.statusPayload().state === "connected" && t.open()));
  const r = svc.send({ kind: "text", text: ">test digi", via: "WIDE1-1,WIDE2-1" });
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
  assert.ok(await until(() => t.rx.length === 1));
  assert.strictEqual(txPkt(svc).digi.state, "pending");
  // a direct echo (no used digipeater) is NOT a digipeat
  t.pushTnc2("KA7KDX-3>APRS,WIDE1-1,WIDE2-1:>test digi");
  await wait(150);
  assert.strictEqual(txPkt(svc).digi.state, "pending");
  t.pushTnc2("KA7KDX-3>APRS,SHEPRD*,WIDE1*,WIDE2-1:>test digi");
  assert.ok(await until(() => txPkt(svc).digi.state === "digipeated"));
  t.pushTnc2("KA7KDX-3>APRS,KF6RAL-1*,WIDE1*,WIDE2-1:>test digi");
  assert.ok(await until(() => txPkt(svc).digi.by.length === 2));
  assert.deepStrictEqual(txPkt(svc).digi.by, ["SHEPRD", "KF6RAL-1"]);
  assert.strictEqual(txPkt(svc).digi.viaSat, false);
  const upd = out.filter((m) => m.type === "aprs-tx-update");
  assert.ok(upd.length >= 2 && upd.every((m) => m.id === r.packet.id));
  // echoes are linked to the TX, not another station
  const echoes = out.filter((m) => m.type === "aprs-packet" && m.packet.ownEcho);
  assert.ok(echoes.length >= 2);
  assert.ok(echoes.every((m) => m.packet.echoOf === r.packet.id));
  const me = svc._store.get("KA7KDX-3"); // our own TX may be listed once, echoes add nothing
  assert.ok(!me || me.count === 1, "echoes are not counted as heard copies");
  // persistent log: one entry per digipeated echo
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual(lines[0].digis, ["SHEPRD"]);
  assert.deepStrictEqual(lines[1].digis, ["KF6RAL-1"]);
  assert.strictEqual(lines[0].src, "KA7KDX-3");
  assert.strictEqual(lines[0].path, "WIDE1-1,WIDE2-1");
  assert.strictEqual(lines[0].conn, "FLEX ch1");
  assert.strictEqual(lines[0].info, ">test digi");
  assert.match(lines[0].raw, /SHEPRD,WIDE1\*/); // TNC2: * on the last used hop
  assert.ok(!isNaN(Date.parse(lines[0].time)) && /Z$/.test(lines[0].time));
  assert.strictEqual(svc.digipeatsPayload().count, 2);
  svc.stop();
  await t.close();
});

test("mismatch: other source or other info does not confirm; timeout -> 'none'", async () => {
  const t = await fakeTnc();
  const { svc, out } = makeSvc(tmpFile(), { opts: { digiTimeoutMs: 400 } });
  svc.configure(cfgFor(t));
  assert.ok(await until(() => svc.statusPayload().state === "connected" && t.open()));
  const r = svc.send({ kind: "text", text: ">only once", via: "WIDE1-1,WIDE2-1" });
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
  t.pushTnc2("KA7KDX-3>APRS,SHEPRD*,WIDE2-1:>something else"); // other info
  t.pushTnc2("KA7KDX-5>APRS,SHEPRD*,WIDE2-1:>only once"); // other SSID
  await wait(150);
  assert.strictEqual(txPkt(svc).digi.state, "pending");
  assert.ok(await until(() => txPkt(svc).digi.state === "none", 2000));
  assert.ok(out.some((m) => m.type === "aprs-tx-update" && m.digi.state === "none"));
  assert.strictEqual(svc.digipeatsPayload().count, 0);
  // a late echo still upgrades it
  t.pushTnc2("KA7KDX-3>APRS,SHEPRD*,WIDE2-1:>only once");
  assert.ok(await until(() => txPkt(svc).digi.state === "digipeated"));
  svc.stop();
  await t.close();
});

test("satellite: echo via RS0ISS* -> 'Heard via RS0ISS', viaSat + sat name / above horizon logged", async () => {
  const t = await fakeTnc();
  const file = tmpFile();
  const { svc } = makeSvc(file, { ctx: ISS });
  svc.configure(cfgFor(t, { path: "ARISS" }));
  assert.ok(await until(() => svc.statusPayload().state === "connected" && t.open()));
  const r = svc.send({ kind: "text", text: ">hello ISS", via: "ARISS" });
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
  t.pushTnc2("KA7KDX-3>APRS,RS0ISS*:>hello ISS");
  assert.ok(await until(() => txPkt(svc).digi.state === "digipeated"));
  assert.strictEqual(txPkt(svc).digi.viaSat, true);
  assert.deepStrictEqual(txPkt(svc).digi.by, ["RS0ISS"]);
  const e = svc.digipeatsPayload().entries[0];
  assert.strictEqual(e.viaSat, true);
  assert.match(e.sat, /ISS/);
  assert.strictEqual(e.satAboveHorizon, true);
  svc.stop();
  await t.close();
});

test("persistence: the log survives a restart (reload newest first) and exports CSV", async () => {
  const file = tmpFile();
  const a = { time: "2026-10-19T22:35:10.000Z", src: "KA7KDX-3", dst: "APRS", path: "WIDE1-1", digis: ["SHEPRD"], viaSat: false, sat: "", conn: "FLEX ch1", info: ">a", raw: "KA7KDX-3>APRS,SHEPRD*:>a" };
  const b = Object.assign({}, a, { time: "2026-10-19T22:40:00.000Z", digis: ["RS0ISS"], viaSat: true, sat: "ISS", satAboveHorizon: true, info: ">b, \"quoted\"" });
  fs.writeFileSync(file, JSON.stringify(a) + "\n" + "garbage line\n" + JSON.stringify(b) + "\n");
  const { svc } = makeSvc(file);
  const p = svc.digipeatsPayload();
  assert.strictEqual(p.type, "aprs-digipeats");
  assert.strictEqual(p.count, 2);
  assert.strictEqual(p.entries[0].info, b.info, "newest first");
  const csv = svc.digipeatsCsv();
  const rows = csv.trim().split(/\r?\n/);
  assert.match(rows[0], /^time,src,dst,path,digis,viaSat,sat,satAboveHorizon,satEl,conn,txConn,lat,lon,info,raw$/);
  assert.strictEqual(rows.length, 3);
  assert.ok(rows.some((r) => r.includes('">b, ""quoted"""')), "CSV quoting");
  assert.strictEqual(digipeatsCsv([]).trim().split(/\r?\n/).length, 1);
  svc.stop();
});

test("collapse: same source + info within the window updates the heard store once; dupOf links copies", async () => {
  const t = await fakeTnc();
  const { svc, out } = makeSvc(tmpFile());
  svc.configure(cfgFor(t, { dupeWindowS: 30 }));
  assert.strictEqual(normalizeConfig({}).dupeWindowS, 30);
  assert.ok(await until(() => svc.statusPayload().state === "connected" && t.open()));
  t.pushTnc2("W7DUP-9>APRS,SHEPRD*,WIDE2-1:!4036.12N/11153.48W>dup test");
  await wait(120);
  t.pushTnc2("W7DUP-9>APRS:!4036.12N/11153.48W>dup test");
  await wait(120);
  t.pushTnc2("W7DUP-9>APRS,KF6RAL-1*,WIDE2*:!4036.12N/11153.48W>dup test");
  const pk = () => out.filter((m) => m.type === "aprs-packet" && m.packet.src === "W7DUP-9").map((m) => m.packet);
  assert.ok(await until(() => pk().length === 3));
  const [p1, p2, p3] = pk();
  assert.strictEqual(p1.dupOf, undefined);
  assert.strictEqual(p2.dupOf, p1.id);
  assert.strictEqual(p3.dupOf, p1.id);
  const st = svc._store.get("W7DUP-9");
  assert.strictEqual(st.recent.length, 1, "one heard entry per group");
  assert.strictEqual(st.recent[0].copies, 3);
  assert.ok(st.lastHeard >= p3.time);
  svc.stop();
  await t.close();
});

// --- browser helpers (grouping for the Messages window) ---
function hub() {
  const sb = { window: {}, document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} }, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, localStorage: { getItem: () => null, setItem() {} } };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/aprs-config.js"), "utf8"), sb);
  return sb.APRS || sb.window.APRS;
}
test("groupPackets: ×N copies within the window, new group after it, echoes attach to the TX, newest first", () => {
  const A = hub();
  const T = 1_000_000;
  const rx = (id, t, via, extra) => Object.assign({ id, dir: "rx", time: T + t * 1000, src: "W7DUP-9", dst: "APRS", via, tnc2: "W7DUP-9>APRS" + (via.length ? "," + via.join(",") : "") + ":>hi" }, extra);
  const tx = { id: 10, dir: "tx", time: T + 5000, src: "KA7KDX-3", dst: "APRS", via: ["WIDE1-1"], tnc2: "KA7KDX-3>APRS,WIDE1-1:>me", digi: { state: "digipeated", by: ["SHEPRD"] } };
  const echo = { id: 11, dir: "rx", time: T + 6000, src: "KA7KDX-3", dst: "APRS", via: ["SHEPRD*", "WIDE1*"], tnc2: "KA7KDX-3>APRS,SHEPRD*,WIDE1*:>me", ownEcho: true, echoOf: 10 };
  const pk = [rx(1, 0, []), rx(2, 3, ["SHEPRD*", "WIDE2*"]), tx, echo, rx(3, 20, ["KF6RAL-1*"]), rx(4, 45, [])];
  const g = JSON.parse(JSON.stringify(A.groupPackets(pk.slice().reverse(), 30))); // other realm
  assert.strictEqual(g.length, 3, "W7DUP x3, TX, W7DUP again after the window");
  assert.strictEqual(g[0].first.id, 4);
  assert.strictEqual(g[0].copies.length, 1);
  assert.strictEqual(g[1].first.id, 10);
  assert.deepStrictEqual(g[1].echoes.map((e) => e.id), [11]);
  assert.strictEqual(g[2].first.id, 1);
  assert.deepStrictEqual(g[2].copies.map((p) => p.id), [1, 2, 3]);
  assert.strictEqual(g[2].last.id, 3);
  assert.strictEqual(A.pathText(rx(1, 0, [])), "direct");
  assert.strictEqual(A.pathText(rx(2, 0, ["SHEPRD*", "WIDE2*"])), "via SHEPRD*,WIDE2*");
  // shorter window splits the group
  assert.strictEqual(A.groupPackets(pk, 10).length, 4);
  const d = A.digiText({ state: "digipeated", by: ["SHEPRD", "KF6RAL-1"], viaSat: false });
  assert.deepStrictEqual([d.cls, d.text], ["ok", "Digipeated by SHEPRD, KF6RAL-1"]);
  assert.strictEqual(A.digiText({ state: "digipeated", by: ["RS0ISS"], viaSat: true }).text, "Heard via RS0ISS");
  assert.strictEqual(A.digiText({ state: "none", timeoutS: 30 }).cls, "none");
});
