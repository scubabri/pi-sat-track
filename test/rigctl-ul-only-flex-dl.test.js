// Regression: split profile UL = rigctl (IC-705 behind rigctld), DL = Flex
// (SmartSDR CAT), Single radio off, TX split off. The server logged
// "rigctl dl error: connect ECONNREFUSED 127.0.0.1:4532" every 2.5 s: the
// Configure form / saved profile carry legacy flat fields (rigctlHost = the
// DL side's unused default rigctlEndpoint, rigctlUlHost = the UL side's),
// which config.applyEndpoints applied AFTER the per-side mapping, turning the
// one rigctl UL into a "two rigctld" setup whose primary link dialled the DL
// default. Here the DL side's (unused) rigctlEndpoint points at a counting
// listener that must never see a connection. All endpoints are 127.0.0.1.
// Run: node --test --test-force-exit test/rigctl-ul-only-flex-dl.test.js
const test = require("node:test");
const assert = require("assert");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rigctl-ul-only-"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fake rigctld: logs commands, counts connections / open sockets. */
function startFake() {
  const st = { conns: 0, open: 0, cmds: [], socks: [] };
  const server = net.createServer((sock) => {
    st.conns += 1;
    st.open += 1;
    st.socks.push(sock);
    sock.on("error", () => {});
    sock.on("close", () => (st.open -= 1));
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        st.cmds.push(line);
        let reply = "RPRT 0";
        if (line === "f") reply = "435110000";
        else if (line === "U ?") reply = "LOCK";
        sock.write(reply + "\n");
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      st.port = server.address().port;
      st.close = () =>
        new Promise((r) => {
          for (const s of st.socks) s.destroy();
          server.close(() => r());
        });
      resolve(st);
    }),
  );
}

const config = require("../lib/config");
const catalog = require("../lib/catalog");
const radios = require("../lib/radios");
const rigctl = require("../lib/radios/rigctl");

catalog.getCatalog = () => ({
  "JO-97": { modes: [{ mode: "SSB", uplink: "435.110", downlink: "145.870" }] },
});

let ulRig, dlDefault, flexCat;

/** The "endpoints" message js/config.js sends for Brian's split profile. */
function brianMsg() {
  const ul = {
    transport: "tcp",
    type: "rigctl",
    protocol: "rigctl",
    rigctlEndpoint: "127.0.0.1:" + ulRig.port,
  };
  const dl = {
    transport: "tcp",
    type: "smartsdr",
    protocol: "cat",
    catEndpoint: "127.0.0.1:" + flexCat.port,
    apiEndpoint: "",
    rigctlEndpoint: "127.0.0.1:" + dlDefault.port, // unused DL default
  };
  return {
    singleRadio: false,
    txSplit: false,
    radioUl: ul,
    radioDl: dl,
    radioTransport: "tcp",
    radioType: "smartsdr",
    radioProtocol: "cat",
    rigctlHost: "127.0.0.1",
    rigctlPort: dlDefault.port, // = DL side's rigctlEndpoint
    rigctlUlHost: "127.0.0.1",
    rigctlUlPort: ulRig.port, // = UL side's rigctlEndpoint
    flexDlHost: "127.0.0.1",
    flexDlPort: flexCat.port,
    flexApiHost: "",
  };
}

test("setup", async () => {
  ulRig = await startFake();
  dlDefault = await startFake();
  flexCat = await startFake();
  radios.init({
    getContext: () => ({ currentSatKey: "JO-97", currentModeIndex: 0 }),
    broadcast: () => {},
  });
});

test("config: side configs own the rigctl endpoints (flat legacy fields ignored)", () => {
  config.applyEndpoints(brianMsg());
  assert.strictEqual(config.RIGCTL_HOST, "127.0.0.1");
  assert.strictEqual(config.RIGCTL_PORT, ulRig.port, "UL-only rigctl uses the primary slot");
  assert.strictEqual(config.RIGCTL_UL_HOST, "", "no second rigctl endpoint");
  assert.strictEqual(config.RIGCTL_UL_PORT, 0);
  assert.strictEqual(radios.activeUl().meta.id, "rigctl");
  assert.notStrictEqual(radios.activeDl().meta.id, "rigctl");
});

test("UL rigctl / DL Flex: only the UL rigctld is dialled, data mode reaches it", async () => {
  radios.start();
  radios.setRadio(true, "test");
  const r = radios.active();
  for (let i = 0; i < 6; i++) {
    await r.pushFrequencies(435110000 + i * 20, 145870000 - i * 5);
    await sleep(60);
  }
  r.setDataMode(true);
  for (let i = 0; i < 6; i++) {
    await r.pushFrequencies(435110200 + i * 20, 145869900 - i * 5);
    await sleep(60);
  }
  await sleep(2800); // > one 2.5 s reconnect period
  assert.strictEqual(dlDefault.conns, 0, "no rigctl DL connection to the DL side's default endpoint");
  assert.strictEqual(ulRig.conns, 1, "one rigctl connection, to the UL endpoint");
  const modes = ulRig.cmds.filter((c) => /^[MX] /.test(c));
  assert.deepStrictEqual(modes, ["M LSB 0", "M PKTLSB 0"]);
  assert.ok(!ulRig.cmds.some((c) => /^[SIX] /.test(c)), "TX split off: no split commands");
  const st = rigctl.getRadioState();
  assert.strictEqual(st.connected, true);
  assert.strictEqual(r.getRadioState().supportsDataMode, true);
});

test("stale legacy globals (no sides in message) still never dial the DL default", async () => {
  // A legacy flat-only message sets a second rigctl endpoint; the profile's
  // sides (UL rigctl / DL Flex) remain authoritative in the driver.
  const before = dlDefault.conns;
  config.applyEndpoints({ rigctlHost: "127.0.0.1", rigctlPort: dlDefault.port, rigctlUlHost: "127.0.0.1", rigctlUlPort: ulRig.port });
  radios.applyEndpointChange({});
  await sleep(600);
  await radios.active().pushFrequencies(435110500, null);
  await sleep(2800);
  assert.strictEqual(dlDefault.conns, before, "DL default never dialled");
  assert.ok(ulRig.open >= 1, "UL link reopened");
});

test("profile switch to Flex-only tears the rigctl link down; nothing reconnects", async () => {
  const m = brianMsg();
  m.radioUl = Object.assign({}, m.radioDl);
  config.applyEndpoints(m);
  radios.applyEndpointChange({ radioSelChanged: true });
  await sleep(3000);
  assert.strictEqual(ulRig.open, 0, "rigctl UL socket closed");
  const n = ulRig.conns;
  await sleep(2800);
  assert.strictEqual(ulRig.conns, n, "no rigctl reconnect after switch");
  assert.strictEqual(dlDefault.conns, 0);
  const st = rigctl.getRadioState();
  assert.strictEqual(st.connected || st.connecting || st.radioOn, false);
});

test("teardown", async () => {
  radios.setRadio(false, "test");
  await sleep(100);
  await ulRig.close();
  await dlDefault.close();
  await flexCat.close();
});
