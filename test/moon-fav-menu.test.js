// Sat menu: the Moon (EME) is in the FAVORITES section only when starred
// (key MOON); unstarred it stays selectable (own section in Favorites mode,
// pinned first in Heard mode). Pure satMenuLists() from js/sat-menu.js.
// Run: node --test --test-force-exit test/moon-fav-menu.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function load(sort) {
  const store = { satTrackerSort: sort };
  const ctx = {
    console,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => (store[k] = String(v)) },
    document: { getElementById: () => null, addEventListener() {}, querySelectorAll: () => [] },
    window: {},
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/sat-menu.js"), "utf8"), ctx);
  return ctx;
}
const SATS = [
  { key: "MOON", name: "Moon (EME)", isMoon: true, norad: null, secToAos: 9000 },
  { key: "SO-50", name: "SO-50", norad: 27607, heard: true, secToAos: 600 },
  { key: "AO-7", name: "AO-7", norad: 7530, heard: true, secToAos: 3000 },
  { key: "ISS", name: "ISS", norad: 25544, heard: false, secToAos: 100 },
  { key: "RS-44", name: "RS-44", norad: 44909, heard: false, secToAos: 20000 },
];
const keys = (l) => JSON.parse(JSON.stringify(l.map((s) => s.key))); // vm realm → plain array

test("unstarred Moon: not in the Favorites section, still offered (own section) and selectable", () => {
  const c = load("alpha");
  const r = c.satMenuLists(SATS, ["SO-50", "ISS", "AO-7"], "favorites", "ISS");
  assert.deepStrictEqual(keys(r.quick), ["AO-7", "ISS", "SO-50"]);
  assert.deepStrictEqual(keys(r.extra), ["MOON"]);
  // no favorites at all: the Moon is still reachable
  const e = c.satMenuLists(SATS, [], "favorites", null);
  assert.deepStrictEqual(keys(e.quick), []);
  assert.deepStrictEqual(keys(e.extra), ["MOON"]);
});

test("starred Moon: in Favorites, sorted like any favorite (A–Z and AOS), no extra row", () => {
  const a = load("alpha").satMenuLists(SATS, ["SO-50", "MOON", "ISS", "AO-7"], "favorites", null);
  assert.deepStrictEqual(keys(a.quick), ["AO-7", "ISS", "MOON", "SO-50"]); // "Moon (EME)" between ISS and SO-50
  assert.strictEqual(a.extra.length, 0);
  const b = load("aos").satMenuLists(SATS, ["SO-50", "MOON", "ISS", "AO-7", "RS-44"], "favorites", null);
  assert.deepStrictEqual(keys(b.quick), ["ISS", "SO-50", "AO-7", "MOON", "RS-44"]);
  assert.strictEqual(b.quick.filter((s) => s.key === "MOON").length, 1);
});

test("Heard mode: Moon pinned first whether starred or not, never duplicated", () => {
  const c = load("alpha");
  for (const favs of [[], ["MOON", "ISS"]]) {
    const r = c.satMenuLists(SATS, favs, "heard", "MOON");
    assert.deepStrictEqual(keys(r.quick), ["MOON", "AO-7", "SO-50"]);
    assert.strictEqual(r.extra.length, 0);
  }
});
