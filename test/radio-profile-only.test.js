// Only the radio selected in the active profile may connect / be probed.
// Regression: with a rigctl (TS-2000 Remote) profile, the Flex driver still
// opened the SmartSDR API (:4992) — at boot (driver init before profiles
// were applied, default type = smartsdr) and on every endpoint change
// (registry notified every driver, Flex always re-connected its API) — and
// a previously-selected driver was not fully stopped on a profile switch.
// Run: node --test --test-force-exit test/radio-profile-only.test.js
const test = require("node:test");
const assert = require("assert");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "radio-only-"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** TCP listener that just counts connections (fake Flex API / CAT). */
function startCounter() {
  const st = { conns: 0, open: 0, socks: [] };
  const server = net.createServer((sock) => {
    st.conns += 1;
    st.open += 1;
    st.socks.push(sock);
    sock.on("error", () => {});
    sock.on("data", () => {}); // drain so the peer's FIN is seen
    sock.on("close", () => {
      st.open -= 1;
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

/** Minimal rigctld: RPRT 0 / numeric answers to anything. */
function startFakeRigctld() {
  const st = { conns: 0, socks: [] };
  const server = net.createServer((sock) => {
    st.conns += 1;
    st.socks.push(sock);
    sock.on("error", () => {});
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let reply = "RPRT 0";
        if (line === "f" || line === "i") reply = "145900000";
        else if (line === "m" || line === "x") reply = "USB\n2400";
        else if (line === "s") reply = "0\nVFOA";
        else if (line === "v") reply = "VFOA";
        else if (line === "U ?") reply = "RPRT 0";
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
const radios = require("../lib/radios");
const flex = require("../lib/radios/flex");

function side(type, extra) {
  return Object.assign(
    { transport: "tcp", type, protocol: type === "rigctl" ? "rigctl" : "cat" },
    extra || {},
  );
}

/** Wrap every driver so we can see which ones get asked to connect. */
const calls = [];
for (const d of radios.all()) {
  for (const fn of ["setRadio", "applyEndpointChange", "activate"]) {
    if (typeof d[fn] !== "function") continue;
    const orig = d[fn];
    d[fn] = function (...a) {
      calls.push({ id: d.meta.id, fn, on: a[0] });
      return orig.apply(this, a);
    };
  }
}

function liveDrivers() {
  return radios
    .all()
    .filter((d) => {
      const st = d.getRadioState && d.getRadioState();
      return (
        st &&
        (st.radioOn ||
          st.connected ||
          st.connecting ||
          st.ulConnected ||
          st.dlConnected ||
          st.apiConnected)
      );
    })
    .map((d) => d.meta.id);
}

let flexApi, flexCat, rigctld;

test("setup fakes", async () => {
  flexApi = await startCounter();
  flexCat = await startCounter();
  rigctld = await startFakeRigctld();
});

test("rigctl profile: Flex API never contacted (boot + endpoint change), only rigctl connects", async () => {
  // Global default before profiles load is smartsdr (Flex) — with an API
  // host present, as on Brian's Pi.
  config.applyEndpoints({ flexApiHost: "127.0.0.1", flexApiPort: flexApi.port });
  radios.init({ getContext: () => ({}), broadcast: () => {} });
  await sleep(250);
  assert.strictEqual(flexApi.conns, 0, "no connect before profile applied");

  // Active profile = rigctl (TS-2000 Remote) but still carries a Flex API ep
  const apiEp = "127.0.0.1:" + flexApi.port;
  const prof = {
    singleRadio: true,
    radioUl: side("rigctl", {
      rigctlEndpoint: "127.0.0.1:" + rigctld.port,
      apiEndpoint: apiEp,
    }),
    radioDl: side("rigctl", {
      rigctlEndpoint: "127.0.0.1:" + rigctld.port,
      apiEndpoint: apiEp,
    }),
  };
  const flags = config.applyEndpoints(prof);
  radios.applyEndpointChange(flags);
  radios.start();
  await sleep(400);
  assert.strictEqual(radios.active().meta.id, "rigctl");
  assert.strictEqual(flexApi.conns, 0, "Flex API must not be probed");
  assert.strictEqual(rigctld.conns, 0, "radio off → nothing connects yet");

  radios.setRadio(true, "test");
  await sleep(600);
  assert.ok(rigctld.conns >= 1, "selected rigctl radio connects");
  assert.strictEqual(flexApi.conns, 0);
  assert.strictEqual(flexCat.conns, 0);
  assert.deepStrictEqual(
    liveDrivers().filter((id) => id !== "rigctl"),
    [],
    "no other driver live",
  );
  const asked = calls.filter(
    (c) =>
      c.id !== "rigctl" &&
      (c.fn === "applyEndpointChange" ||
        c.fn === "activate" ||
        (c.fn === "setRadio" && c.on === true)),
  );
  assert.deepStrictEqual(asked, [], "unselected drivers never asked to connect");

  radios.setRadio(false, "test");
  await sleep(300);
  assert.strictEqual(flexApi.conns, 0);
});

test("switch rigctl → Flex → rigctl: Flex connects only while selected, then fully closed", async () => {
  const apiEp = "127.0.0.1:" + flexApi.port;
  const catEp = "127.0.0.1:" + flexCat.port;
  let flags = config.applyEndpoints({
    singleRadio: true,
    radioUl: side("smartsdr", { catEndpoint: catEp, apiEndpoint: apiEp }),
    radioDl: side("smartsdr", { catEndpoint: catEp, apiEndpoint: apiEp }),
  });
  radios.applyEndpointChange(flags);
  await sleep(400);
  assert.strictEqual(radios.active().meta.id, "flex");
  assert.strictEqual(flexApi.conns, 1, "Flex API for profile list once selected");
  assert.strictEqual(flex.getRadioState().apiConnected, true);

  radios.setRadio(true, "test");
  try {
    radios.active().pushFrequencies(435000000, 145900000);
  } catch (_) {}
  await sleep(600);
  assert.ok(flexCat.conns >= 1, "Flex CAT opens when radio on");

  // Profile switch back to rigctl while radio is on
  flags = config.applyEndpoints({
    singleRadio: true,
    radioUl: side("rigctl", { rigctlEndpoint: "127.0.0.1:" + rigctld.port, apiEndpoint: apiEp }),
    radioDl: side("rigctl", { rigctlEndpoint: "127.0.0.1:" + rigctld.port, apiEndpoint: apiEp }),
  });
  const rigBefore = rigctld.conns;
  const apiBefore = flexApi.conns;
  const catBefore = flexCat.conns;
  radios.applyEndpointChange(flags);
  await sleep(700);
  assert.strictEqual(radios.active().meta.id, "rigctl");
  const fs_ = flex.getRadioState();
  assert.strictEqual(fs_.radioOn, false, "old Flex driver off");
  assert.strictEqual(fs_.apiConnected, false, "Flex API closed");
  assert.strictEqual(!!fs_.connected, false, "Flex CAT closed");
  assert.strictEqual(flexApi.open, 0, "Flex API socket closed on server side");
  assert.strictEqual(flexCat.open, 0, "Flex CAT sockets closed");
  assert.strictEqual(flexApi.conns, apiBefore, "no Flex reconnect");
  assert.ok(rigctld.conns > rigBefore, "new profile's radio connected");

  // Nothing reconnects later (no background loops of the old driver)
  await sleep(1500);
  assert.strictEqual(flexApi.conns, apiBefore);
  assert.strictEqual(flexCat.conns, catBefore);
  assert.deepStrictEqual(liveDrivers().filter((id) => id !== "rigctl"), []);

  radios.setRadio(false, "test");
  await sleep(300);
});

test("teardown", async () => {
  await flexApi.close();
  await flexCat.close();
  await rigctld.close();
});
