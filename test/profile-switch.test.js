// Profile switch re-applies only the subsystems whose settings differ.
// Regression: switching between profiles with the same radio / rotor still
// closed and reopened every driver (Flex API dropped), because
// config.applyEndpoints() flags radioSelChanged whenever a profile config
// contains radioUl / radioDl (all saved profiles do) and applyProfileToRuntime
// re-applied the radio unconditionally.
// Run: node --test --test-force-exit test/profile-switch.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pst-profsw-"));

const config = require("../lib/config");
const { applyProfileEndpoints } = require("../lib/profile-apply");
const { endpointsFromMsg } = require("../lib/endpoint-apply");

function spies() {
  const calls = { radio: 0, rotor: 0, logs: [] };
  return {
    calls,
    deps: {
      config,
      radios: { applyEndpointChange: () => calls.radio++ },
      rotor: { applyEndpointChange: () => calls.rotor++ },
      log: (m) => calls.logs.push(m),
    },
  };
}
/** A profile's saved config, as Configure Save stores it (the full endpoints form). */
function profileCfg(over) {
  const form = Object.assign({ type: "endpoints" }, JSON.parse(JSON.stringify(config.getEndpoints())), over || {});
  return Object.assign(endpointsFromMsg(form), { callsign: "N0CALL", grid: "JO01aa" });
}

const FLEX = { singleRadio: true, radioType: "smartsdr", radioTransport: "tcp", flexApiHost: "192.0.2.10", flexApiPort: 4992, rotorType: "gs232", rotorHost: "192.0.2.20", rotorAzPort: 4533, rotorMinEl: 0 };

test("startup: the first apply runs the radio apply as before", () => {
  const s = spies();
  const r = applyProfileEndpoints("Flex", profileCfg(FLEX), s.deps, { startup: true });
  assert.strictEqual(s.calls.radio, 1);
  assert.strictEqual(r.radio, true);
  assert.match(s.calls.logs[0], /^Profile \u2192 Flex \(startup\): radio applied/);
});

test("root cause: config.applyEndpoints flags radioSelChanged even for identical settings", () => {
  const flags = config.applyEndpoints(profileCfg(FLEX));
  assert.strictEqual(flags.radioSelChanged, true, "the flag alone cannot decide a re-apply");
});

test("switch to a profile with identical radio / rotor settings: no radio or rotor apply", () => {
  applyProfileEndpoints("Flex", profileCfg(FLEX), spies().deps, {});
  const s = spies();
  const r = applyProfileEndpoints("Flex portable", profileCfg(Object.assign({}, FLEX)), s.deps, {});
  assert.deepStrictEqual([s.calls.radio, s.calls.rotor], [0, 0], JSON.stringify(r.changes));
  assert.strictEqual(s.calls.logs.length, 1, "one line per switch");
  assert.strictEqual(s.calls.logs[0], "Profile \u2192 Flex portable: radio unchanged, rotor unchanged, WSJT-X listener unchanged");
});

test("only the radio update rate differs: read live, no reconnect", () => {
  applyProfileEndpoints("Flex", profileCfg(FLEX), spies().deps, {});
  const s = spies();
  applyProfileEndpoints("Fast", profileCfg(Object.assign({}, FLEX, { radioUpdateMs: 250 })), s.deps, {});
  assert.deepStrictEqual([s.calls.radio, s.calls.rotor], [0, 0]);
});

test("differing radio settings re-apply the radio only; differing rotor settings the rotor only", () => {
  applyProfileEndpoints("Flex", profileCfg(FLEX), spies().deps, {});
  let s = spies();
  applyProfileEndpoints("Other Flex", profileCfg(Object.assign({}, FLEX, { flexApiHost: "192.0.2.11" })), s.deps, {});
  assert.deepStrictEqual([s.calls.radio, s.calls.rotor], [1, 0]);
  assert.match(s.calls.logs[0], /^Profile \u2192 Other Flex: radio re-applied \(.*flexApiHost.*\), rotor unchanged/);

  applyProfileEndpoints("Flex", profileCfg(FLEX), spies().deps, {});
  s = spies();
  applyProfileEndpoints("Park west", profileCfg(Object.assign({}, FLEX, { rotorParkAz: 270 })), s.deps, {});
  assert.deepStrictEqual([s.calls.radio, s.calls.rotor], [0, 1]);
  assert.match(s.calls.logs[0], /radio unchanged, rotor re-applied \(rotorParkAz\)/);

  applyProfileEndpoints("Flex", profileCfg(FLEX), spies().deps, {});
  s = spies();
  applyProfileEndpoints("IC-9700", profileCfg(Object.assign({}, FLEX, { radioType: "icom", radioTransport: "serial", rotorType: "rt21" })), s.deps, {});
  assert.deepStrictEqual([s.calls.radio, s.calls.rotor], [1, 1]);
});

test("server.js: applyProfileToRuntime goes through applyProfileEndpoints (startup forced once)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const i = src.indexOf("function applyProfileToRuntime(");
  const body = src.slice(i, src.indexOf("\n}\n", i));
  assert.ok(/applyProfileEndpoints\(/.test(body));
  assert.ok(!/radios\.applyEndpointChange\(/.test(body), "no unconditional radio apply");
  assert.ok(/startup: !profileAppliedOnce/.test(body));
});
