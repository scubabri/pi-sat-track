// Saved Hamlib model round-trip (js/hamlib-ui.js): fill 3085 -> read -> reload models ->
// rebuild list -> read again stays 3085; no silent fallback to the first model of a manufacturer
// (alpha.10 saved IC ID-1 #3054 for an IC-705).
// Run: node --test --test-force-exit test/hamlib-model-roundtrip.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const MODELS = {
  ok: true,
  groups: [
    { mfg: "Elecraft", models: [{ id: 2029, mfg: "Elecraft", model: "K3", status: "Stable" }] },
    {
      mfg: "Icom",
      models: [
        { id: 3054, mfg: "Icom", model: "IC ID-1", status: "Untested" },
        { id: 3070, mfg: "Icom", model: "IC-7100", status: "Stable" },
        { id: 3085, mfg: "Icom", model: "IC-705", status: "Stable", native: { serialModel: "ic705", label: "IC-705", transport: "serial" } },
      ],
    },
  ],
};

function el() {
  const e = {
    _v: "", _opts: null, hidden: false, textContent: "", checked: false, style: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, insertAdjacentHTML() {}, appendChild() {}, setAttribute() {}, closest: () => null,
    querySelector: () => el(), querySelectorAll: () => [],
    get innerHTML() { return this._h || ""; },
    set innerHTML(h) {
      this._h = h;
      const vals = [...String(h).matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
      this._opts = vals.length || /<option/.test(h) ? vals : this._opts;
      if (this._opts) this._v = this._opts[0] || "";
    },
    get value() { return this._v; },
    set value(v) { v = String(v); this._v = !this._opts || this._opts.includes(v) ? v : ""; },
  };
  return e;
}

async function load() {
  const els = new Map();
  let fetches = 0;
  const document = {
    getElementById: (id) => { if (!els.has(id)) els.set(id, el()); return els.get(id); },
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => el(), body: el(),
  };
  const sb = {
    document, console, Map, Promise, setTimeout, clearTimeout, setInterval: () => 0, location: { host: "x", protocol: "http:" },
    WebSocket: function () { return { addEventListener() {} }; },
    fetch: (url) => { if (/models/.test(url)) fetches++; return Promise.resolve({ json: () => Promise.resolve(/models/.test(url) ? MODELS : { ok: false }) }); },
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/hamlib-ui.js"), "utf8"), sb);
  return { ui: sb.window.hamlibUI, $: document.getElementById, fetches: () => fetches };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

test("saved 3085 survives fill -> read -> reload models -> rebuild -> read", async () => {
  const { ui, $ } = await load();
  ui.fill("ul", { transport: "hamlib", hamlibModel: 3085, serialDevice: "COM17" });
  await tick();
  assert.strictEqual($("cfg-ul-hamlib-mfg").value, "Icom");
  assert.strictEqual($("cfg-ul-hamlib-model").value, "3085");
  const saved = ui.read("ul", {});
  assert.strictEqual(saved.hamlibModel, 3085);
  assert.strictEqual(saved.hamlibModelName, "IC-705");
  // reload page / rebuild the list from the saved config
  const r2 = await load();
  r2.ui.fill("ul", saved);
  await tick();
  await r2.ui.loadModels(true);
  await tick();
  assert.strictEqual(r2.$("cfg-ul-hamlib-model").value, "3085");
  assert.strictEqual(r2.ui.read("ul", {}).hamlibModel, 3085);
});

test("no saved model: list shows the placeholder, read() saves null (never 3054)", async () => {
  const { ui, $ } = await load();
  ui.fill("dl", { transport: "hamlib", hamlibModel: null });
  await tick();
  assert.strictEqual($("cfg-dl-hamlib-mfg").value, "Icom");
  assert.strictEqual($("cfg-dl-hamlib-model").value, "");
  const out = ui.read("dl", {});
  assert.strictEqual(out.hamlibModel, null);
  assert.notStrictEqual(out.hamlibModel, 3054);
});

test("unknown saved model is not replaced by the first Icom entry", async () => {
  const { ui, $ } = await load();
  ui.fill("ul", { transport: "hamlib", hamlibModel: 99999 });
  await tick();
  assert.strictEqual($("cfg-ul-hamlib-model").value, "");
  assert.notStrictEqual(ui.read("ul", {}).hamlibModel, 3054);
});
