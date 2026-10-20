// KISS / APRS settings per station profile: one-time backfill into profiles
// saved before APRS existed, side-effect-free profile peek (Configure shows a
// picked profile without switching), and a switch reconnecting the KISS service.
// Run: node --test --test-force-exit test/aprs-profile.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pst-aprs-prof-"));
process.env.HOME = home;
const dir = path.join(home, ".rpitrack");
fs.mkdirSync(dir, { recursive: true });
const MAC_APRS = { enabled: true, connections: [{ id: "c1", name: "Graywolf", host: "10.0.0.5", port: 8001, role: "rxtx", speed: 1200 }], defaultTxConn: "c1" };
fs.writeFileSync(
  path.join(dir, "profiles.json"),
  JSON.stringify({
    active: "MacBook Pro",
    profiles: {
      "MacBook Pro": { favorites: [], config: { grid: "DN30SO", aprs: MAC_APRS } },
      Flex: { favorites: [], config: { grid: "DN40" } },
      Pi: { favorites: [] },
    },
  }),
);
const profiles = require("../lib/profiles");
const { createService } = require("../lib/aprs/service");
const { TcpTransport } = require("../lib/kiss/tcp");
profiles.load();

test("migration: profiles without KISS / APRS settings get a copy of the active one, once", () => {
  assert.strictEqual(profiles.backfillConfigKey("aprs"), 2);
  for (const n of ["Flex", "Pi"]) assert.deepStrictEqual(profiles.getProfile(n).config.aprs, MAC_APRS, n);
  assert.strictEqual(profiles.getProfile("Flex").config.grid, "DN40", "other settings untouched");
  const disk = JSON.parse(fs.readFileSync(profiles.PROFILES_FILE, "utf8"));
  assert.deepStrictEqual(disk.profiles.Pi.config.aprs, MAC_APRS, "persisted");
  // copies are independent, and a second run changes nothing
  profiles.setActive("Flex");
  profiles.updateActive({ config: { aprs: Object.assign({}, MAC_APRS, { enabled: false }) } });
  assert.strictEqual(profiles.getProfile("MacBook Pro").config.aprs.enabled, true);
  assert.strictEqual(profiles.backfillConfigKey("aprs"), 0);
  profiles.setActive("MacBook Pro");
});

test("peek: reading another profile does not switch or save", () => {
  const before = fs.readFileSync(profiles.PROFILES_FILE, "utf8");
  const p = profiles.getProfile("Flex");
  assert.strictEqual(p.config.grid, "DN40");
  p.config.grid = "XX00"; // a copy
  assert.strictEqual(profiles.getActiveName(), "MacBook Pro");
  assert.strictEqual(profiles.getProfile("Flex").config.grid, "DN40");
  assert.strictEqual(fs.readFileSync(profiles.PROFILES_FILE, "utf8"), before);
  assert.strictEqual(profiles.getProfile("nope"), null);
});

function fakeTnc() {
  return new Promise((resolve) => {
    const socks = [];
    const srv = net.createServer((s) => {
      socks.push(s);
      s.on("error", () => {});
    });
    srv.listen(0, "127.0.0.1", () =>
      resolve({
        port: srv.address().port,
        open: () => socks.filter((s) => !s.destroyed && !s.readableEnded).length,
        close: () => new Promise((r) => (socks.forEach((s) => s.destroy()), srv.close(r))),
      }),
    );
  });
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

test("switch: configuring the new profile's APRS closes the old sockets and opens its own", async () => {
  const a = await fakeTnc();
  const b = await fakeTnc();
  const svc = createService({
    broadcast: () => {},
    log: () => {},
    getStation: () => ({ callsign: "KA7KDX", grid: "DN40" }),
    getTxContext: () => ({ radioOn: true, sat: null }),
    createTransport: (c) => new TcpTransport({ host: c.host, port: c.port, reconnectInitialMs: 50, reconnectMaxMs: 200 }),
  });
  const mac = { enabled: true, logToFile: false, connections: [{ id: "c1", name: "Graywolf", host: "127.0.0.1", port: a.port, role: "rxtx" }] };
  const flex = { enabled: true, logToFile: false, connections: [{ id: "c1", name: "FLEX ch1", host: "127.0.0.1", port: b.port, role: "rxtx" }] };
  svc.configure(mac); // what applyProfileToRuntime does with profile.config.aprs
  assert.ok(await until(() => a.open() === 1 && svc.statusPayload().state === "connected"));
  svc.configure(flex);
  assert.ok(await until(() => a.open() === 0 && b.open() === 1), "old socket closed, new one open");
  assert.ok(await until(() => svc.statusPayload().state === "connected"));
  assert.deepStrictEqual(svc.statusPayload().connections.map((c) => c.name), ["FLEX ch1"]);
  svc.configure(Object.assign({}, flex, { enabled: false })); // a profile with KISS off
  assert.ok(await until(() => b.open() === 0));
  assert.strictEqual(svc.statusPayload().state, "off");
  svc.stop();
  await a.close();
  await b.close();
});
