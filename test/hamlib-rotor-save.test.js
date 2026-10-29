// Hamlib rotor settings round-trip Configure Save -> server -> profile -> reload (Brian, alpha.52:
// "not saving the models"). Root cause: the client's endpoints send (js/config.js) is a hand-picked
// whitelist and omitted every rotorHamlib* field, so the model / separate AZ-EL / EL port never reached
// the server or the profile; and the form copied the AZ port into rotorElDevice for Hamlib (1-port).
// Run: node --test --test-force-exit test/hamlib-rotor-save.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pst-hlsave-"));
const config = require("../lib/config");
const { applyEndpointSave, endpointsFromMsg } = require("../lib/endpoint-apply");

const NAV = "/dev/cu.usbserial-AB0N5NAV";
const NB1 = "/dev/cu.usbserial-AB0N5NB1";
const HL = {
  rotorType: "hamlib", rotorAzDevice: NAV, rotorElDevice: NB1, rotorBaud: 4800,
  rotorHamlibModel: 1101, rotorHamlibSplit: true, rotorHamlibElDevice: NB1, rotorHamlibElBaud: 9600, rotorHamlibElModel: 1102,
};

/** js/config.js sendEndpointsToServer -> the WS message it sends. */
function clientSend(cfg) {
  const dir = path.join(__dirname, "../js");
  const sent = [];
  const sb = { localStorage: { getItem: () => null, setItem() {} }, WebSocket: { OPEN: 1 }, console };
  sb.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(dir, "config-defaults.js"), "utf8"), sb);
  const src = fs.readFileSync(path.join(dir, "config.js"), "utf8");
  const i = src.indexOf("function sendEndpointsToServer(");
  vm.runInContext(src.slice(i, src.indexOf("\nfunction sendProfileSelect", i)), sb);
  sb.cfg = JSON.parse(JSON.stringify(Object.assign(sb.defaultsEndpoints(), cfg)));
  vm.runInContext("sendEndpointsToServer(cfg)", sb);
  return sent[0];
}

test("Save sends every Hamlib rotor field; the server applies them and writes them to the profile", () => {
  const msg = clientSend(HL);
  for (const k of Object.keys(HL)) assert.deepStrictEqual(msg[k], HL[k], "client sends " + k);
  const ep = endpointsFromMsg(msg);
  const r = applyEndpointSave(ep, {
    config, radios: { applyEndpointChange() {} }, rotor: { applyEndpointChange() {} }, log() {},
  });
  assert.ok(r.changes.rotor.includes("rotorHamlibModel"));
  const after = config.getEndpoints();
  for (const k of Object.keys(HL)) assert.deepStrictEqual(after[k], HL[k], "server keeps " + k);
  // "restart": a fresh server process applies the saved profile config (= ep) and reads it back
  const out = execFileSync(process.execPath, ["-e",
    "const c=require('./lib/config');c.applyEndpoints(JSON.parse(process.argv[1]));process.stdout.write(JSON.stringify(c.getEndpoints()))",
    JSON.stringify(ep)], { cwd: path.join(__dirname, ".."), env: Object.assign({}, process.env, { LOG_AMSAT_HEARD: "0" }) });
  const re = JSON.parse(out);
  for (const k of Object.keys(HL)) assert.deepStrictEqual(re[k], HL[k], "after restart " + k);
});

test("Hamlib single controller saves split off and no EL port; model still kept", () => {
  const msg = clientSend(Object.assign({}, HL, { rotorHamlibSplit: false, rotorHamlibElDevice: "", rotorHamlibElBaud: null, rotorHamlibElModel: null }));
  assert.strictEqual(msg.rotorHamlibSplit, false);
  assert.strictEqual(msg.rotorHamlibModel, 1101);
  assert.strictEqual(msg.rotorHamlibElDevice, "");
});

test("Configure form: Hamlib never overwrites the native EL device with the AZ port", () => {
  const src = fs.readFileSync(path.join(__dirname, "../js/config-form.js"), "utf8");
  const i = src.indexOf("    rotorElDevice: (function () {");
  const fn = src.slice(i + "    rotorElDevice: ".length, src.indexOf("})(),", i) + 2);
  const els = { "cfg-rotor-type": "hamlib", "cfg-rotor-device": NAV, "cfg-rotor-el-device": NB1 };
  const sb = {
    val: (id) => els[id], readSerialDeviceField: (id) => els[id] || "", hostSerialDefault: (d) => d,
    findRotorDriver: (t) => ({ hamlib: { ports: 1 }, gs232: { ports: 1 }, rt21: { ports: 2 } })[t],
  };
  vm.createContext(sb);
  assert.strictEqual(vm.runInContext("(" + fn + ")()", sb), NB1);
  els["cfg-rotor-type"] = "gs232";
  assert.strictEqual(vm.runInContext("(" + fn + ")()", sb), NAV, "GS-232 unchanged");
});

test("'no rotor model chosen' warns once, not every supervisor pass", () => {
  const hl = require("../lib/hamlib");
  const src = fs.readFileSync(path.join(__dirname, "../lib/hamlib/index.js"), "utf8");
  assert.match(src, /if \(!rotSpecs\.warned\) opts\.warn\("Hamlib: no rotor model chosen/);
  assert.ok(hl);
});
