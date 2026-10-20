// Configure Save re-applies only what changed. Regression (Pi, 7ade4a1):
// saving only APRS / KISS settings also sent the full endpoints form, every
// radio / rotor driver was re-applied and the Flex API reconnected, and the
// log got the whole endpoints JSON. Run: node --test --test-force-exit test/endpoint-save.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pst-epsave-"));

const config = require("../lib/config");
const { applyEndpointSave, endpointsFromMsg, endpointChanges, summarize } = require("../lib/endpoint-apply");

function spies() {
  const calls = { radio: 0, rotor: 0, wsjtx: 0, logs: [] };
  return {
    calls,
    deps: {
      config,
      radios: { applyEndpointChange: () => calls.radio++, active: () => ({ meta: { id: "flex" } }) },
      rotor: { applyEndpointChange: () => calls.rotor++ },
      rotors: { active: () => ({ meta: { id: "gs232" } }) },
      applyWsjtx: () => calls.wsjtx++,
      log: (m) => calls.logs.push(m),
    },
  };
}
/** What Configure sends on Save: the current endpoints form, unchanged. */
const formMsg = (over) => Object.assign({ type: "endpoints" }, JSON.parse(JSON.stringify(config.getEndpoints())), over || {});

test("APRS-only save: the endpoints form unchanged -> no radio / rotor / WSJT-X re-apply, one short log line", () => {
  // a realistic Flex setup first (this one may re-apply: it is a change)
  const setup = spies();
  applyEndpointSave(endpointsFromMsg(formMsg({ radioType: "smartsdr", flexApiHost: "172.17.18.46", flexApiPort: 4992, rotorType: "gs232", rotorHost: "10.0.0.5", rotorAzPort: 4533 })), setup.deps);
  assert.ok(setup.calls.radio >= 1);
  // now the APRS tab Save: same form again
  const s = spies();
  const r = applyEndpointSave(endpointsFromMsg(formMsg()), s.deps);
  assert.strictEqual(r.changes.any, false, JSON.stringify(r.changes));
  assert.strictEqual(s.calls.radio, 0, "radio not re-applied (Flex API stays connected)");
  assert.strictEqual(s.calls.rotor, 0, "rotor not re-applied");
  assert.strictEqual(s.calls.wsjtx, 0);
  assert.strictEqual(s.calls.logs.length, 1);
  assert.match(s.calls.logs[0], /^Endpoints saved, unchanged \| /);
  assert.ok(s.calls.logs[0].length < 300, "summary, not the full JSON");
  assert.ok(!/serialCatalog|"radioUl"/.test(s.calls.logs[0]));
});

test("only the changed subsystem is re-applied", () => {
  let s = spies();
  applyEndpointSave(endpointsFromMsg(formMsg({ rotorParkAz: 123 })), s.deps);
  assert.deepStrictEqual([s.calls.radio, s.calls.rotor, s.calls.wsjtx], [0, 1, 0]);
  assert.match(s.calls.logs[0], /^Endpoints updated: rotor \(rotorParkAz\)/);
  s = spies();
  applyEndpointSave(endpointsFromMsg(formMsg({ flexApiPort: 4993 })), s.deps);
  assert.deepStrictEqual([s.calls.radio, s.calls.rotor, s.calls.wsjtx], [1, 0, 0]);
  assert.match(s.calls.logs[0], /radio \(.*flexApiPort/);
  s = spies();
  applyEndpointSave(endpointsFromMsg(formMsg({ logMethod: config.getEndpoints().logMethod === "adif" ? "none" : "adif" })), s.deps);
  assert.deepStrictEqual([s.calls.radio, s.calls.rotor, s.calls.wsjtx], [0, 0, 0], "logging settings need no reconnect");
  s = spies();
  applyEndpointSave(endpointsFromMsg(formMsg({ wsjtxListen: !config.getEndpoints().wsjtxListen })), s.deps);
  assert.deepStrictEqual([s.calls.radio, s.calls.rotor, s.calls.wsjtx], [0, 0, 1]);
});

test("endpointChanges / summarize", () => {
  const c = endpointChanges({ a: 1, rotorX: 1, logY: 1, host: 1 }, { a: 2, rotorX: 1, logY: 2, host: 2 });
  assert.deepStrictEqual([c.radio, c.rotor, c.log, c.any], [["a"], [], ["logY"], true]);
  const line = summarize({ singleRadio: true, radioUl: { type: "smartsdr", transport: "tcp", host: "172.17.18.46", port: 4992 }, rotorType: "gs232", logMethod: "none" }, endpointChanges({}, {}));
  assert.strictEqual(line, "Endpoints saved, unchanged | radio smartsdr tcp 172.17.18.46:4992, rotor gs232, log none");
});
