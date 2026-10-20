// KISS log lines: profile apply summary (once per change), disabled profile,
// reconnect errors rate-limited, disconnect / reconnect.
// Run: node --test --test-force-exit test/aprs-logging.test.js
const test = require("node:test");
const assert = require("assert");
const net = require("net");
const os = require("os");
const fs = require("fs");
const path = require("path");

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pst-aprs-log-"));
const { TcpTransport } = require("../lib/kiss/tcp");
const { createService } = require("../lib/aprs/service");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 3000)) {
    if (fn()) return true;
    await wait(10);
  }
  return false;
}
function svcWithLogs() {
  const logs = [];
  const svc = createService({
    broadcast: () => {},
    log: (m) => logs.push(m),
    getStation: () => ({ callsign: "K0TEST", grid: "DN40" }),
    getTxContext: () => ({ radioOn: false, sat: null }),
    createTransport: (c) => new TcpTransport({ host: c.host, port: c.port, reconnectInitialMs: 20, reconnectMaxMs: 40, jitter: 0 }),
  });
  return { svc, logs };
}

test("profile apply: one summary line per change; disabled profile says so", () => {
  const { svc, logs } = svcWithLogs();
  const cfg = { enabled: true, logToFile: false, connections: [{ id: "a", name: "FLEX ch1", host: "127.0.0.1", port: 1, role: "rxtx" }, { id: "b", name: "Spare", host: "127.0.0.1", port: 2, enabled: false }] };
  svc.configure(cfg, { profile: "Home" });
  svc.configure(cfg, { profile: "Home" });
  const s = logs.filter((l) => /^APRS: KISS for profile Home: /.test(l));
  assert.deepStrictEqual(s, ["APRS: KISS for profile Home: 2 connections, 1 enabled (FLEX ch1 tcp 127.0.0.1:1 rxtx)"]);
  svc.configure(Object.assign({}, cfg, { enabled: false }), { profile: "Portable" });
  assert.ok(logs.includes("APRS: KISS disabled for profile Portable (2 connections configured, none started)"));
  assert.ok(logs.some((l) => /^APRS: KISS \[FLEX ch1\] stopped \(disabled \/ removed\) tcp 127\.0\.0\.1:1/.test(l)));
  svc.stop();
});

test("reconnect errors are logged once per new error, not every retry; disconnect and reconnect logged", async () => {
  const srv = net.createServer((s) => s.on("error", () => {}));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r)); // nothing listening: refused
  const { svc, logs } = svcWithLogs();
  svc.configure({ enabled: true, logToFile: false, connections: [{ id: "a", name: "GW", host: "127.0.0.1", port, role: "rx" }] });
  await wait(400); // ~10+ retries at 20-40 ms
  const errs = logs.filter((l) => /^APRS: KISS \[GW\] tcp 127\.0\.0\.1:\d+: .*retrying in/.test(l));
  assert.strictEqual(errs.length, 1, logs.join("\n"));
  // the TNC comes up: connected (after N retries), then drops: disconnected
  const socks = [];
  const srv2 = net.createServer((s) => (socks.push(s), s.on("error", () => {})));
  await new Promise((r) => srv2.listen(port, "127.0.0.1", r));
  assert.ok(await until(() => logs.some((l) => /^APRS: KISS \[GW\] connected tcp 127\.0\.0\.1:\d+ \(after \d+ retries\)/.test(l))), logs.join("\n"));
  socks.forEach((s) => s.destroy());
  assert.ok(await until(() => logs.some((l) => /^APRS: KISS \[GW\] disconnected tcp .*; reconnecting/.test(l))));
  svc.stop();
  await new Promise((r) => srv2.close(r));
});
