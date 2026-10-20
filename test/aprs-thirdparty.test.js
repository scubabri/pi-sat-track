// Third-party packets (APRS 1.01 ch. 17, data type '}'): decoded recursively,
// classified by the inner packet, attributed to the inner source, and the same
// inner packet gated by several iGates collapses into one group.
// Run: node --test --test-force-exit test/aprs-thirdparty.test.js
const test = require("node:test");
const assert = require("assert");
const net = require("net");
const os = require("os");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pst-aprs-3p-"));

const kiss = require("../lib/kiss/kiss");
const ax25 = require("../lib/ax25");
const { TcpTransport } = require("../lib/kiss/tcp");
const { parseInfo } = require("../lib/aprs/parse");
const describe = require("../lib/aprs/describe");
const { createService } = require("../lib/aprs/service");

const KU5R = "KU5R-6>APMI06,WIDE2-1:}OTA>APZ100,TCPIP,KU5R-6*::K7ETC-7 :DE K6BOY-5 QSL Thx for the chase! 73{6278";
const KB7COX = "KB7COX-10>APDW17,SHEPRD,WIDE1,KU5R-6,WIDE2*:}OTA>APRS,TCPIP,KB7COX-10*::K7ETC-7 :DE K6BOY-5 QSL Thx for the chase! 73{6278";
const POS3P = "KU5R-6>APMI06,WIDE2-1:}N7POS-9>APRS,TCPIP,KU5R-6*:!4045.00N/11152.00W>mobile via APRS-IS";
const info = (l) => l.slice(l.indexOf(":") + 1);
const dst = (l) => l.split(">")[1].split(/[,:]/)[0];

function frame(line) {
  const ci = line.indexOf(":");
  const [src, rest] = line.slice(0, ci).split(">");
  const parts = rest.split(",");
  const d = parts.shift();
  let last = -1;
  parts.forEach((p, i) => p.endsWith("*") && (last = i));
  const p = parts.map((x, i) => Object.assign(ax25.parseAddr(x.replace(/\*$/, "")), { h: i <= last }));
  return ax25.encodeUI({ src, dst: d, path: p, info: Buffer.from(line.slice(ci + 1), "utf8") });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 3000)) {
    if (fn()) return true;
    await wait(20);
  }
  return false;
}

test("parse: '}' decodes the inner packet and classifies by its type (message to K7ETC-7, id 6278)", () => {
  for (const l of [KU5R, KB7COX]) {
    const p = parseInfo(dst(l), info(l));
    assert.strictEqual(p.type, "message");
    assert.deepStrictEqual(p.msg, { to: "K7ETC-7", text: "DE K6BOY-5 QSL Thx for the chase! 73", id: "6278" });
    assert.strictEqual(p.thirdParty.src, "OTA");
    assert.strictEqual(describe.category(p, "rx"), "message");
    assert.strictEqual(describe.describe(p), "→ K7ETC-7: DE K6BOY-5 QSL Thx for the chase! 73");
  }
  const a = parseInfo("APMI06", info(KU5R)).thirdParty;
  assert.deepStrictEqual(a, { src: "OTA", dst: "APZ100", path: ["TCPIP", "KU5R-6*"], info: ":K7ETC-7 :DE K6BOY-5 QSL Thx for the chase! 73{6278" });
  assert.strictEqual(parseInfo("APDW17", info(KB7COX)).thirdParty.dst, "APRS");
  // inner position: decoded with lat/lon
  const pos = parseInfo("APMI06", info(POS3P));
  assert.strictEqual(pos.type, "position");
  assert.ok(Math.abs(pos.lat - 40.75) < 1e-6 && Math.abs(pos.lon + 111.8667) < 1e-3);
  // nested third-party: innermost header wins
  const nest = parseInfo("APRS", "}GATE2>APRS,TCPIP*:}OTA>APRS,TCPIP*:>hello");
  assert.strictEqual(nest.type, "status");
  assert.strictEqual(nest.thirdParty.src, "OTA");
  // malformed: stays "other"
  assert.strictEqual(parseInfo("APRS", "}garbage").type, "other");
});

test("service: attributed to the inner source, iGate kept, plotted only with an inner position, two iGates = one group", async () => {
  const socks = [];
  const srv = net.createServer((s) => {
    socks.push(s);
    s.on("error", () => {});
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const out = [];
  const svc = createService({
    broadcast: (m) => out.push(m),
    log: () => {},
    getStation: () => ({ callsign: "KA7KDX", grid: "DN40" }),
    getTxContext: () => ({ radioOn: true, sat: null }),
    createTransport: (c) => new TcpTransport({ host: c.host, port: c.port, reconnectInitialMs: 50, reconnectMaxMs: 200 }),
    digipeatFile: path.join(process.env.HOME, "dg.jsonl"),
  });
  svc.configure({ enabled: true, logToFile: false, connections: [{ id: "gw", name: "VHF Dax 3", host: "127.0.0.1", port: srv.address().port, role: "rx" }] });
  assert.ok(await until(() => svc.statusPayload().state === "connected" && socks.length));
  const push = (l) => socks.forEach((s) => s.write(kiss.encode(frame(l))));
  push(KU5R);
  await wait(100);
  push(KB7COX);
  const pk = () => out.filter((m) => m.type === "aprs-packet").map((m) => m.packet);
  assert.ok(await until(() => pk().length === 2));
  const [a, b] = pk();
  assert.strictEqual(a.src, "OTA");
  assert.strictEqual(a.gateway, "KU5R-6");
  assert.strictEqual(b.gateway, "KB7COX-10");
  assert.strictEqual(a.type, "message");
  assert.strictEqual(a.category, "message");
  assert.strictEqual(a.to, "K7ETC-7");
  assert.strictEqual(a.msgId, "6278");
  assert.strictEqual(a.innerTnc2, "OTA>APZ100,TCPIP,KU5R-6*::K7ETC-7 :DE K6BOY-5 QSL Thx for the chase! 73{6278");
  assert.strictEqual(b.dupOf, a.id, "same inner packet via another iGate / inner dest = same group");
  assert.strictEqual(svc._store.get("KU5R-6"), null, "the iGate is not the station");
  assert.strictEqual(svc._store.get("KB7COX-10"), null);
  const ota = svc._store.get("OTA");
  assert.ok(ota && ota.recent.length === 1);
  assert.ok(!Number.isFinite(ota.lat), "message has no position: not plotted");
  assert.ok(!svc.heardPayload().stations.some((s) => s.call === "OTA" || s.call === "KU5R-6"), "nothing plotted for a positionless third-party message");
  push(POS3P);
  assert.ok(await until(() => svc._store.get("N7POS-9")));
  const n7 = svc._store.get("N7POS-9");
  assert.ok(Math.abs(n7.lat - 40.75) < 1e-6);
  assert.ok(svc.heardPayload().stations.some((s) => s.call === "N7POS-9"), "inner position plotted under the inner source");
  assert.strictEqual(pk().pop().gateway, "KU5R-6");
  svc.stop();
  socks.forEach((s) => s.destroy());
  await new Promise((r) => srv.close(r));
});

test("Messages window grouping: both iGates' copies collapse into one ×2 group", () => {
  const sb = { console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, localStorage: { getItem: () => null, setItem() {} }, document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} } };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/aprs-config.js"), "utf8"), sb);
  const A = sb.APRS;
  const mk = (id, t, l, gw) => {
    const tp = parseInfo(dst(l), info(l)).thirdParty;
    return { id, dir: "rx", time: 1e6 + t * 1000, src: "OTA", gateway: gw, thirdParty: tp, tnc2: l, via: [] };
  };
  const g = JSON.parse(JSON.stringify(A.groupPackets([mk(2, 4, KB7COX, "KB7COX-10"), mk(1, 0, KU5R, "KU5R-6")], 30)));
  assert.strictEqual(g.length, 1);
  assert.deepStrictEqual(g[0].copies.map((c) => c.gateway), ["KU5R-6", "KB7COX-10"]);
});
