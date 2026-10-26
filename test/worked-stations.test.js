// Worked stations list (lib/worked.js) + the map / globe layer wiring.
// Run: node --test --test-force-exit test/worked-stations.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { createWorked, fromRecord, normalize } = require("../lib/worked");
const logbook = require("../lib/logbook");

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pst-worked-")), "worked.json");
}

test("add / persist / reload / dedupe / clear", () => {
  const file = tmpFile();
  const events = [];
  const w = createWorked({ file, onChange: (p) => events.push(p) });
  const rec = { call: "K1ABC", satName: "SO-50", mode: "FM", band: "2m", bandRx: "70cm", date: "20261026", time: "221400", propMode: "SAT" };
  assert.ok(w.add(fromRecord(rec, "FN42", "log", new Date(), logbook.adifDateTime)));
  assert.strictEqual(w.add(fromRecord(rec, "FN42", "wsjtx", new Date(), logbook.adifDateTime)), null, "same call + minute = duplicate");
  const it = w.list()[0];
  assert.strictEqual(it.call, "K1ABC");
  assert.strictEqual(it.grid, "FN42");
  assert.strictEqual(it.sat, "SO-50");
  assert.strictEqual(it.band, "2m/70cm");
  assert.strictEqual(it.time, Date.UTC(2026, 9, 26, 22, 14, 0));
  assert.ok(Math.abs(it.lat - 42.5) < 1e-9 && Math.abs(it.lon + 71) < 1e-9);
  assert.strictEqual(events.at(-1).type, "worked");
  const w2 = createWorked({ file });
  assert.strictEqual(w2.list().length, 1, "survives a restart");
  w2.clear();
  assert.strictEqual(createWorked({ file }).list().length, 0);
});

test("size-safe: capped to the newest N, strings clipped, bad grid kept without position", () => {
  const w = createWorked({ file: tmpFile(), max: 5 });
  for (let i = 0; i < 12; i++) w.add({ call: "K" + i + "AA", grid: "EM12", time: Date.UTC(2026, 0, 1, 0, i) });
  const l = w.list();
  assert.strictEqual(l.length, 5);
  assert.strictEqual(l[0].call, "K7AA");
  const n = normalize({ call: "x".repeat(99), grid: "ZZ99", sat: "y".repeat(99), time: 1 });
  assert.strictEqual(n.call.length, 20);
  assert.strictEqual(n.sat.length, 40);
  assert.strictEqual(n.grid, "");
  assert.strictEqual(n.lat, undefined);
  assert.strictEqual(normalize({ call: "" }), null);
  // corrupt file -> empty list, no throw
  const f = tmpFile();
  fs.writeFileSync(f, "{not json");
  assert.deepStrictEqual(createWorked({ file: f }).list(), []);
});

test("server: logging still goes to logbook first; worked list only after a successful log", () => {
  const src = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  assert.match(src, /if \(r\.ok\) noteWorked\(r\.record, dxGrid, "log", qsoTime\);/);
  assert.match(src, /if \(r\.ok\) noteWorked\(r\.record, e\.fields\.GRIDSQUARE \|\| "", "wsjtx", rec\.time\);/);
  assert.match(src, /msg\.type === "worked-clear"/);
});

test("client layer: one marker per call, tooltip has call / UTC time / sat / band; toggle hides; globe draws it", () => {
  const ls = {};
  const ctx = {
    console, Date, Math, Number, JSON, Map, Set, String, Array, Object,
    Event: class { constructor(t) { this.type = t; } },
    localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); } },
    document: { readyState: "complete", dispatchEvent() {}, addEventListener() {}, querySelector: () => null },
    setInterval: () => 0, clearInterval() {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/worked-layer.js"), "utf8"), ctx);
  ctx.applyWorkedLayer({ type: "worked", items: [
    { call: "K1ABC", grid: "FN42", lat: 42.5, lon: -71, time: Date.UTC(2026, 9, 25, 20, 0), sat: "SO-50", band: "2m/70cm", mode: "FM" },
    { call: "K1ABC", grid: "FN42", lat: 42.5, lon: -71, time: Date.UTC(2026, 9, 26, 22, 14), sat: "RS-44", band: "2m/70cm", mode: "SSB" },
    { call: "W2NOG", grid: "", time: Date.UTC(2026, 9, 26, 1, 0) },
  ] });
  const it = ctx.workedLayer.items();
  assert.strictEqual(it.length, 1, "grouped per call; gridless skipped");
  assert.match(it[0].tip, /^K1ABC FN42\n2026-10-26 22:14 UTC · RS-44 · 2m\/70cm · SSB\n2026-10-25 20:00 UTC · SO-50/);
  ctx.workedLayer.setOn(false);
  assert.strictEqual(ctx.workedLayer.items().length, 0);
  assert.strictEqual(ls.workedLayerOn, "0");
  const g = fs.readFileSync(path.join(__dirname, "../js/globe-view.js"), "utf8");
  assert.match(g, /window\.workedLayer/);
  assert.match(g, /addEventListener\("worked-layer-change"/);
});
