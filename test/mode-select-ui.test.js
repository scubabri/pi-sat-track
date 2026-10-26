// Mode dropdown (js/tracker.js updateModeSelect): full mode text as the hover
// tooltip, and a single mode is not greyed out (disabled).
// Run: node --test --test-force-exit test/mode-select-ui.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function load() {
  const src = fs.readFileSync(path.join(__dirname, "../js/tracker.js"), "utf8");
  const pick = (name) => {
    const i = src.indexOf("function " + name + "(");
    assert.ok(i >= 0, name);
    return src.slice(i, src.indexOf("\nfunction ", i + 10));
  };
  const sel = {
    options: [], disabled: true, title: "", _value: "",
    get innerHTML() { return ""; }, set innerHTML(_) { this.options = []; },
    appendChild(o) { this.options.push(o); },
    get value() { return this._value; }, set value(v) { this._value = v; },
    get selectedIndex() { return this.options.findIndex((o) => o.value === this._value); },
  };
  const sb = { document: { getElementById: (id) => (id === "mode-select" ? sel : null), createElement: () => ({}) }, lastModesKey: "" };
  vm.createContext(sb);
  vm.runInContext("var lastModesKey = '';\n" + pick("updateModeSelect") + "\n" + pick("syncModeSelectTitle"), sb);
  return { sb, sel };
}

test("one mode: dropdown stays enabled, tooltip = full mode text", () => {
  const { sb, sel } = load();
  sb.updateModeSelect([{ mode: "Mode V/U FM voice repeater", uplink: "145.990", downlink: "436.795" }], 0);
  assert.strictEqual(sel.disabled, false);
  assert.match(sel.title, /Mode V\/U FM voice repeater  ·  UL 145\.990 \/ DL 436\.795/);
  assert.strictEqual(sel.options[0].title, sel.options[0].textContent);
});

test("several modes: tooltip follows the selected mode; no modes stays disabled", () => {
  const { sb, sel } = load();
  const modes = [{ mode: "FM", uplink: "1", downlink: "2" }, { mode: "Linear USB/LSB inverting", uplink: "3", downlink: "4" }];
  sb.updateModeSelect(modes, 1);
  assert.strictEqual(sel.disabled, false);
  assert.match(sel.title, /Linear USB\/LSB inverting/);
  sb.updateModeSelect([], null);
  assert.strictEqual(sel.disabled, true);
  assert.strictEqual(sel.title, "Transponder / mode");
});
