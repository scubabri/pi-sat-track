// Sat menu: the Moon (EME, key MOON) gets no special placement. Starred it is
// a normal sorted favorite chip; unstarred it is not in the menu's Favorites
// view and is reached via "Browse full catalog..." (sats.html). Not pinned in
// Heard on AMSAT either. Pure satMenuLists() from js/sat-menu.js.
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

test("unstarred Moon: absent from the menu's Favorites view (no extra section)", () => {
  const c = load("alpha");
  const r = c.satMenuLists(SATS, ["SO-50", "ISS", "AO-7"], "favorites", "ISS");
  assert.deepStrictEqual(keys(r), ["AO-7", "ISS", "SO-50"]);
  assert.deepStrictEqual(keys(c.satMenuLists(SATS, [], "favorites", null)), []);
  assert.strictEqual(typeof c.pinMoonFirst, "undefined", "no Moon pinning helper left");
  const src = fs.readFileSync(path.join(__dirname, "../js/sat-menu.js"), "utf8");
  assert.ok(!/sat-menu-section-moon|not a favorite/.test(src), "extra Moon section removed");
  const css = fs.readFileSync(path.join(__dirname, "../css/style.css"), "utf8");
  assert.ok(!/sat-menu-section-moon/.test(css), "its CSS removed");
});

test("starred Moon: a normal favorite chip, sorted with the others (A–Z and AOS)", () => {
  const a = load("alpha").satMenuLists(SATS, ["SO-50", "MOON", "ISS", "AO-7"], "favorites", null);
  assert.deepStrictEqual(keys(a), ["AO-7", "ISS", "MOON", "SO-50"]); // "Moon (EME)" between ISS and SO-50
  const b = load("aos").satMenuLists(SATS, ["SO-50", "MOON", "ISS", "AO-7", "RS-44"], "favorites", null);
  assert.deepStrictEqual(keys(b), ["ISS", "SO-50", "AO-7", "MOON", "RS-44"]);
});

test("Heard on AMSAT view: Moon not pinned; like any non-heard object it shows only as the selected sat", () => {
  const c = load("alpha");
  for (const favs of [[], ["MOON", "ISS"]]) {
    assert.deepStrictEqual(keys(c.satMenuLists(SATS, favs, "heard", "AO-7")), ["AO-7", "SO-50"]);
    assert.deepStrictEqual(keys(c.satMenuLists(SATS, favs, "heard", null)), ["AO-7", "SO-50"]);
  }
  // selected (like the non-heard ISS would be): listed once, sorted, not pinned
  assert.deepStrictEqual(keys(c.satMenuLists(SATS, [], "heard", "MOON")), ["AO-7", "MOON", "SO-50"]);
  assert.deepStrictEqual(keys(c.satMenuLists(SATS, [], "heard", "ISS")), ["AO-7", "ISS", "SO-50"]);
});

test("catalog (Browse full catalog...) lists the Moon, selectable and starrable", () => {
  const catalog = require("../lib/catalog");
  const rows = catalog.listSatsPayload("trackable", { latitude: 40.6, longitude: -112.46, height: 1300 }).satellites;
  const m = rows.filter((s) => s.key === "MOON");
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].isMoon, true);
  assert.ok(!m[0].heard, "never heard on AMSAT");
  const html = fs.readFileSync(path.join(__dirname, "../sats.html"), "utf8");
  assert.ok(/favTd\.appendChild\(favBtn\)/.test(html) && !/if \(!s\.isMoon\) favTd/.test(html), "star on every row incl. the Moon");
  // row click → main page selects it (server is the source of truth for the sat)
  assert.ok(/location\.href = "\/index\.html\?sat=" \+ encodeURIComponent\(s\.key\)/.test(html), "row click passes ?sat=KEY");
  const tr = fs.readFileSync(path.join(__dirname, "../js/tracker.js"), "utf8");
  assert.ok(/function applyCatalogPick\(\)/.test(tr) && /applyCatalogPick\(\);/.test(tr), "main page applies ?sat= on connect");
  // star → server profile (else the main page's server favorites overwrite it)
  assert.ok(/type: "favorites", keys: keys/.test(html), "catalog star is sent to the server");
});
