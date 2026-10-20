// Retry number on repeated sends: the same To + content within 30 s gets
// " #2", " #3", ... (past Graywolf's identical-frame drop and digi dupe
// filters). Positions and UI text only; messages unchanged.
// Run: node --test --test-force-exit test/aprs-retry.test.js
const test = require("node:test");
const assert = require("assert");
const net = require("net");
const os = require("os");
const fs = require("fs");
const path = require("path");

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pst-aprs-rt-"));

const kiss = require("../lib/kiss/kiss");
const ax25 = require("../lib/ax25");
const build = require("../lib/aprs/build");
const { TcpTransport } = require("../lib/kiss/tcp");
const { createService, normalizeConfig } = require("../lib/aprs/service");

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
const tnc2 = (f) => ax25.toTnc2(ax25.decode(f.data));
async function setup(more, opts) {
  const t = await fakeTnc();
  const out = [];
  const svc = createService(
    Object.assign(
      {
        broadcast: (m) => out.push(m),
        log: () => {},
        getStation: () => ({ callsign: "KA7KDX", grid: "DN40" }),
        getTxContext: () => ({ radioOn: true, sat: null }),
        createTransport: (c) => new TcpTransport({ host: c.host, port: c.port, reconnectInitialMs: 50, reconnectMaxMs: 200 }),
        digipeatFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pst-rt-")), "dg.jsonl"),
      },
      opts,
    ),
  );
  svc.configure(
    Object.assign(
      { enabled: true, txEnabled: true, logToFile: false, ssid: 3, comment: "Pi Sat Track", connections: [{ id: "gw", name: "FLEX ch1", preset: "graywolf", host: "127.0.0.1", port: t.port, role: "rxtx", speed: 1200 }] },
      more,
    ),
  );
  assert.ok(await until(() => svc.statusPayload().state === "connected" && t.open()));
  const send = async (m) => {
    const n = t.rx.length;
    const r = svc.send(Object.assign({ via: "WIDE1-1,WIDE2-1" }, m));
    assert.ok(r.ok, JSON.stringify(r.reasons));
    assert.ok(await until(() => t.rx.length === n + 1));
    return { r, line: tnc2(t.rx[n]), hex: t.rx[n].data.toString("hex") };
  };
  return { t, svc, out, send, done: async () => (svc.stop(), t.close()) };
}

test("build: retry tag is appended and never truncated; user comment / text gives way", () => {
  const p = (comment, tag) => build.positionInfo({ lat: 40.5, lon: -111, symbol: "/`", comment, messaging: true, tag });
  assert.ok(p("Pi Sat Track", " #2").endsWith("`Pi Sat Track #2"));
  const long = "x".repeat(43);
  const tagged = p(long, " #12");
  const c = tagged.slice(tagged.indexOf("`") + 1);
  assert.strictEqual(c.length, 43);
  assert.ok(c.endsWith("x #12"));
  assert.strictEqual(p("", " #2").slice(-3), " #2");
  const ui = build.uiTextInfo("y".repeat(80), 1, " #3");
  assert.strictEqual(ui.length, 80);
  assert.ok(ui.endsWith("y #3"));
  assert.strictEqual(build.uiTextInfo("hello", 1, ""), "hello");
  assert.strictEqual(normalizeConfig({}).retryTag, true, "default ON");
  assert.strictEqual(normalizeConfig({ retryTag: false }).retryTag, false);
});

test("position: first send untagged, quick resends #2 / #3; To / comment change resets; no Graywolf note", async () => {
  const s = await setup();
  const a = await s.send({ kind: "beacon", to: "APRS" });
  assert.match(a.line, /`Pi Sat Track$/);
  assert.strictEqual(a.r.packet.retry, undefined);
  const b = await s.send({ kind: "beacon", to: "APRS" });
  assert.match(b.line, /`Pi Sat Track #2$/);
  assert.strictEqual(b.r.packet.retry, 2);
  assert.strictEqual(b.r.note, undefined, "no 'Graywolf may drop it' note with the tag on");
  const c = await s.send({ kind: "beacon", to: "APRS", via: "ARISS" });
  assert.match(c.line, /^KA7KDX-3>APRS,ARISS:.*`Pi Sat Track #3$/, "path is not part of the content");
  assert.strictEqual(s.svc.statusPayload().lastTx.retry, 3);
  // other To: new counter
  const d = await s.send({ kind: "beacon", to: "CQ" });
  assert.match(d.line, /`Pi Sat Track$/);
  // comment change: new counter; the old content still counts on its own
  const e = await s.send({ kind: "beacon", to: "APRS", comment: "QRV DN40" });
  assert.match(e.line, /`QRV DN40$/);
  const f = await s.send({ kind: "beacon", to: "APRS", comment: "QRV DN40" });
  assert.match(f.line, /`QRV DN40 #2$/);
  await s.done();
});

test("UI text tagged, messages unchanged, header only untouched", async () => {
  const s = await setup();
  const a = await s.send({ kind: "text", to: "CQ", text: ">hello" });
  const b = await s.send({ kind: "text", to: "CQ", text: ">hello" });
  assert.match(a.line, /:>hello$/);
  assert.match(b.line, /:>hello #2$/);
  const max = await s.send({ kind: "text", to: "CQ", via: "ARISS", text: "z".repeat(80) });
  const max2 = await s.send({ kind: "text", to: "CQ", via: "ARISS", text: "z".repeat(80) });
  assert.strictEqual(max.line.split(":").pop().length, 80);
  const info2 = max2.line.split(":").pop();
  assert.strictEqual(info2.length, 80, "stays within the UISS length limit");
  assert.ok(info2.endsWith("z #2"), "tag kept, user text truncated");
  const m1 = await s.send({ kind: "message", for: "K7ETC-7", text: "QSL 73" });
  const m2 = await s.send({ kind: "message", for: "K7ETC-7", text: "QSL 73" });
  assert.strictEqual(m1.hex, m2.hex, "message resend is identical");
  const h1 = await s.send({ kind: "header", to: "BEACON" });
  const h2 = await s.send({ kind: "header", to: "BEACON" });
  assert.strictEqual(h1.hex, h2.hex);
  await s.done();
});

test("counter resets after the window with no resend", async () => {
  const s = await setup({}, { retryMs: 300 });
  await s.send({ kind: "beacon", to: "APRS" });
  const b = await s.send({ kind: "beacon", to: "APRS" });
  assert.match(b.line, / #2$/);
  await wait(400);
  const c = await s.send({ kind: "beacon", to: "APRS" });
  assert.match(c.line, /`Pi Sat Track$/, "untagged again after 30 s quiet");
  // each resend restarts the window
  await wait(200);
  const d = await s.send({ kind: "beacon", to: "APRS" });
  await wait(200);
  const e = await s.send({ kind: "beacon", to: "APRS" });
  assert.match(d.line, / #2$/);
  assert.match(e.line, / #3$/, "window counts from the last resend");
  await s.done();
});

test("option off: identical bytes on resend, Graywolf note kept, retry still counted", async () => {
  const s = await setup({ retryTag: false });
  const a = await s.send({ kind: "beacon", to: "APRS" });
  const b = await s.send({ kind: "beacon", to: "APRS" });
  assert.strictEqual(a.hex, b.hex);
  assert.match(b.r.note || "", /Graywolf drops identical frames within 30 s/);
  assert.strictEqual(b.r.packet.retry, 2);
  assert.strictEqual(b.r.packet.retryTagged, false);
  await s.done();
});

test("digipeat confirmation matches the tagged packet; log + CSV record the retry number", async () => {
  const s = await setup();
  await s.send({ kind: "beacon", to: "APRS" });
  const b = await s.send({ kind: "beacon", to: "APRS" });
  // echo of #2 via SHEPRD*
  const info = b.line.slice(b.line.indexOf(":") + 1);
  s.t.push(ax25.encodeUI({ src: "KA7KDX-3", dst: "APRS", path: [Object.assign(ax25.parseAddr("SHEPRD"), { h: true }), ax25.parseAddr("WIDE2-1")], info: Buffer.from(info) }));
  assert.ok(await until(() => s.svc.statusPayload().lastTx.digi.state === "digipeated"));
  const lt = s.svc.statusPayload().lastTx;
  assert.strictEqual(lt.retry, 2);
  assert.strictEqual(lt.id, b.r.packet.id, "the #2 send is the one confirmed");
  const e = s.svc.digipeatsPayload().entries[0];
  assert.strictEqual(e.retry, 2);
  assert.match(e.info, / #2$/);
  const csv = s.svc.digipeatsCsv().trim().split(/\r?\n/);
  assert.match(csv[0], /,retry,/);
  const splitCsv = (l) => (l.match(/("([^"]|"")*"|[^,]*)(,|$)/g) || []).map((x) => x.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'));
  const cols = splitCsv(csv[0]);
  assert.strictEqual(splitCsv(csv[1])[cols.indexOf("retry")], "2");
  await s.done();
});
