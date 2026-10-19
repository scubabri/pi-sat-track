// UISS-style shared To / Via / For header + history in the client hub
// (js/aprs-config.js window.APRS). Run: node --test test/aprs-hub.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function load(lsInit) {
  const ls = Object.assign({}, lsInit || {});
  const opened = [];
  const ctx = {
    console, Date, Math, Number, JSON, Set, Map, String, Array, Object,
    localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); } },
    document: { readyState: "complete", body: null, getElementById: () => null, addEventListener() {} },
    setInterval: () => 0,
    clearInterval() {},
    aprsWindow: { open: (o) => opened.push(o) },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/aprs-config.js"), "utf8"), ctx);
  return { A: ctx.APRS, ls, opened, ctx };
}

function status(extra) {
  return Object.assign({ type: "aprs-status", enabled: true, defaultTo: "CQ", defaultVia: "ARISS", sat: { key: "ISS" }, presets: { to: ["CQ", "APRS", "APRSAT", "BEACON", "APZPST"], via: ["ARISS", "RS0ISS"] } }, extra || {});
}

test("To defaults to the server default (CQ), Via to the per-sat default; edits are shared and persisted", () => {
  const { A, ls } = load();
  assert.strictEqual(A.getTo(), "CQ");
  assert.strictEqual(A.getVia(), "ARISS");
  A.__feed(status({ defaultTo: "APRS", defaultVia: "RS0ISS" }));
  assert.strictEqual(A.getTo(), "APRS");
  assert.strictEqual(A.getVia(), "RS0ISS");
  const seen = [];
  A.on("hdr", (e) => seen.push(e.origin));
  A.setHdr({ to: "beacon", via: "" }, "box");
  assert.strictEqual(A.getTo(), "BEACON");
  assert.strictEqual(A.getVia(), "", "empty Via = direct");
  assert.deepStrictEqual(seen, ["box"]);
  assert.strictEqual(JSON.parse(ls.aprsTxHdr).to, "BEACON");
  // reload keeps it
  const again = load(ls);
  assert.strictEqual(again.A.getTo(), "BEACON");
});

test("changing satellite re-defaults Via (To is kept)", () => {
  const { A } = load();
  A.__feed(status());
  A.setHdr({ to: "APRS", via: "WIDE2-1" });
  A.__feed(status({ sat: { key: "SONATE-2" }, defaultVia: "DP0SNX" }));
  assert.strictEqual(A.getVia(), "DP0SNX");
  assert.strictEqual(A.getTo(), "APRS");
});

test("history like UISS: newest first, deduplicated, To/Via 15, For 10; choices = history then presets", () => {
  const { A, ls } = load();
  A.__feed(status());
  for (let i = 0; i < 20; i++) A.remember("to", "T" + i);
  assert.strictEqual(A.hist.to.length, 15);
  assert.strictEqual(A.hist.to[0], "T19");
  A.remember("to", "t5");
  assert.strictEqual(A.hist.to[0], "T5");
  assert.strictEqual(A.hist.to.filter((x) => x === "T5").length, 1);
  for (let i = 0; i < 12; i++) A.remember("for", "F" + i);
  assert.strictEqual(A.hist.for.length, 10);
  const ch = A.choices("to");
  assert.strictEqual(ch[0], "T5");
  assert.ok(ch.indexOf("CQ") > ch.indexOf("T19"), "presets after history");
  assert.ok(JSON.parse(ls.aprsHistory).to.length === 15);
});

test("successful send remembers To / Via / For; heard call pastes into For / To / Via", () => {
  const { A, opened } = load();
  A.__feed(status());
  A.__feed({ type: "aprs-send-result", ok: true, kind: "message", packet: { type: "message", dst: "CQ", via: ["ARISS"], to: "N0SAT" } });
  assert.strictEqual(A.hist.to[0], "CQ");
  assert.strictEqual(A.hist.via[0], "ARISS");
  assert.strictEqual(A.hist.for[0], "N0SAT");
  A.pasteCall("dl7ndr", "for");
  assert.strictEqual(A.hdr.for, "DL7NDR");
  assert.strictEqual(opened[0].for, "DL7NDR", "opens the Messages window in message mode");
  A.pasteCall("w3ado-1", "via");
  assert.strictEqual(A.getVia(), "W3ADO-1");
  A.pasteCall("ka0abc", "to");
  assert.strictEqual(A.getTo(), "KA0ABC");
});

test("APRS times follow the app's UTC | local toggle (isUtcTimeMode)", () => {
  const { A, ctx } = load();
  const t = Date.UTC(2026, 9, 19, 21, 48, 52);
  ctx.isUtcTimeMode = () => true;
  assert.strictEqual(A.fmtTime(t), "21:48:52 UTC");
  assert.strictEqual(A.fmtTimeShort(t), "21:48 UTC");
  assert.strictEqual(A.fmtClock(t), "21:48:52");
  assert.strictEqual(A.zoneLabel(), "UTC");
  ctx.isUtcTimeMode = () => false;
  const d = new Date(t);
  const two = (n) => String(n).padStart(2, "0");
  assert.strictEqual(A.fmtTime(t), two(d.getHours()) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds()) + " MT");
  assert.strictEqual(A.zoneLabel(), "MT");
});

test("without pass-ui.js the stored satTrackerTimeMode is used", () => {
  const { A } = load({ satTrackerTimeMode: "local" });
  assert.strictEqual(A.zoneLabel(), "MT");
  assert.strictEqual(load({}).A.zoneLabel(), "UTC");
});

test("multi-KISS: status text, route per typed Via, per-sat speed text parsing", () => {
  const { A } = load();
  const conns = [
    { id: "a", name: "FLEX ch1", enabled: true, state: "connected", rx: 3, tx: 1, target: "pc:8001" },
    { id: "b", name: "VHF Dax 3", enabled: true, state: "waiting", error: "refused", target: "pc:8002" },
  ];
  const satR = { ok: true, satRoute: true, connected: true, speed: 9600, speedSource: "amsat", conn: { id: "d", name: "Direwolf 9600", speed: 9600 } };
  const dirR = { ok: true, satRoute: false, connected: true, speed: 1200, conn: { id: "a", name: "FLEX ch1", speed: 1200 } };
  A.__feed(status({ state: "partial", connections: conns, rx: 3, tx: 1, error: "VHF Dax 3: refused", sat: { key: "CROCUBE", name: "CroCube", speed: 9600 }, txRoute: satR, txRouteDirect: dirR }));
  assert.match(A.statusText(A.status), /^KISS 1\/2 connected · RX 3 · TX 1 · VHF Dax 3: refused/);
  assert.strictEqual(A.routeFor("9A0CC"), satR);
  assert.strictEqual(A.routeFor("WIDE2-1"), dirR);
  assert.strictEqual(A.routeFor(""), dirR);
  assert.match(A.routeHtml(satR), /TX via <b>Direwolf 9600<\/b>.*CroCube 9600 \(AMSAT digipeater list\)/);
  assert.match(A.routeHtml({ ok: false, reason: "No 9600 TX connection configured for CroCube" }), /No 9600 TX connection configured/);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(A.textToSatSpeeds("crocube=9600\nISS = 1200\nfoo=4800\nmarina=9k6"))), { CROCUBE: 9600, ISS: 1200, MARINA: 9600 });
  assert.match(A.statusText({ enabled: true, connections: [conns[0]] }), /^KISS FLEX ch1 pc:8001: connected · RX 3 · TX 1/);
});
