// Configure rotor test: each axis uses its own port (Brian, alpha.51: the EL step ran on the AZ port).
// Root cause: Rotor = Hamlib serial is a 1-port driver, so the test used the AZ port for EL too, ignoring
// "Separate AZ / EL controllers" + EL device.
// Run: node --test --test-force-exit test/rotor-test-ports.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function formConfig(type, fields, catalog) {
  const src = fs.readFileSync(path.join(__dirname, "../js/config-test-ui.js"), "utf8");
  const i = src.indexOf("function rotorConfigFromForm(");
  const body = src.slice(i, src.indexOf("\nconst pendingRotorTests", i));
  const els = {};
  for (const [k, v] of Object.entries(fields)) els[k] = typeof v === "boolean" ? { checked: v } : { value: v };
  const sb = {
    document: { getElementById: (id) => els[id] || null },
    val: (id) => (id === "cfg-rotor-type" ? type : (els[id] || {}).value),
    findRotorDriver: (t) => catalog.find((d) => d.id === t) || null,
    isRotorAzOnlyChecked: () => !!(els["cfg-rotor-az-only"] || {}).checked,
    readSerialDeviceField: (id) => String((els[id] || {}).value || "").trim(),
  };
  vm.createContext(sb);
  vm.runInContext(body + "\nthis.out = rotorConfigFromForm();", sb);
  return sb.out;
}
const CAT = [{ id: "gs232", ports: 1 }, { id: "rt21", ports: 2 }, { id: "hamlib", ports: 1 }];
const NAV = "/dev/cu.usbserial-AB0N5NAV";
const NB1 = "/dev/cu.usbserial-AB0N5NB1";

test("native RT-21: AZ and EL use their own ports", () => {
  const c = formConfig("rt21", { "cfg-rotor-az-device": NAV, "cfg-rotor-el-device": NB1, "cfg-rotor-baud": "4800" }, CAT);
  assert.strictEqual(c.rotorAzDevice, NAV);
  assert.strictEqual(c.rotorElDevice, NB1);
});

test("Hamlib serial + separate AZ / EL: EL uses the EL device, not the AZ port", () => {
  const c = formConfig("hamlib", { "cfg-rotor-device": NAV, "cfg-rotor-hamlib-split": true, "cfg-rotor-hamlib-el-device": NB1 }, CAT);
  assert.strictEqual(c.rotorAzDevice, NAV);
  assert.strictEqual(c.rotorElDevice, NB1);
});

test("Hamlib serial single controller: no EL port (EL step skipped, never on the AZ port)", () => {
  const c = formConfig("hamlib", { "cfg-rotor-device": NAV, "cfg-rotor-hamlib-split": false, "cfg-rotor-hamlib-el-device": NB1 }, CAT);
  assert.strictEqual(c.rotorAzDevice, NAV);
  assert.strictEqual(c.rotorElDevice, "");
});

test("GS-232 (one controller, AZ + EL on one port): unchanged", () => {
  const c = formConfig("gs232", { "cfg-rotor-device": NAV }, CAT);
  assert.strictEqual(c.rotorAzDevice, NAV);
  assert.strictEqual(c.rotorElDevice, NAV);
});

test("guided test runs EL only when there is an EL port", () => {
  const src = fs.readFileSync(path.join(__dirname, "../js/config-test-ui.js"), "utf8");
  assert.match(src, /if \(!base\.rotorAzOnly && base\.rotorElDevice\) \{\s*await axisSequence\("el"\);/);
});

test("server: EL step on the AZ port is refused; AZ / EL labels follow the axis", async () => {
  const ct = require("../lib/connection-test");
  const r = await ct.testRotorStep({ action: "read", axis: "el", rotorType: "rt21", rotorAzDevice: NAV, rotorElDevice: NAV });
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /EL device is the AZ port/);
  assert.strictEqual(ct.rotorTestDevice({ axis: "el", rotorType: "rt21", rotorAzDevice: NAV, rotorElDevice: NB1 }), NB1);
  assert.strictEqual(ct.rotorTestDevice({ axis: "az", rotorType: "rt21", rotorAzDevice: NAV, rotorElDevice: NB1 }), NAV);
  const none = await ct.testRotorStep({ action: "read", axis: "el", rotorType: "hamlib", rotorAzDevice: NAV, rotorElDevice: "" });
  assert.strictEqual(none.ok, false);
  assert.match(none.message, /No EL serial device/);
});
