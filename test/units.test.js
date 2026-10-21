// Display units (Configure → Station → Units, per station profile): the
// js/units.js helper, per-profile persistence / default / migration
// (lib/profiles.js), the server + Configure wiring, and the converted display
// spots in both modes. Run: node --test --test-force-exit test/units.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pst-units-"));
process.env.HOME = home;
const dir = path.join(home, ".rpitrack");
fs.mkdirSync(dir, { recursive: true });
// Legacy file: no units anywhere (one profile never configured).
fs.writeFileSync(path.join(dir, "profiles.json"), JSON.stringify({
  active: "Home",
  profiles: {
    Home: { favorites: ["ISS"], config: { callsign: "K0TEST", grid: "DN40AA", elevation: 1324 } },
    Portable: { favorites: ["SO-50"], config: { callsign: "K0TEST/P", grid: "DM79", units: "bogus" } },
    Blank: { favorites: [], config: {} },
  },
}));
const profiles = require("../lib/profiles");
profiles.load();

const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
function freshUnits() {
  delete require.cache[require.resolve("../js/units.js")];
  return require("../js/units.js");
}

/* ---------- helper ---------- */

test("helper: default Metric; normalize; set reports a change", () => {
  const U = freshUnits();
  assert.strictEqual(U.get(), "metric");
  assert.strictEqual(U.normalize(undefined), "metric");
  assert.strictEqual(U.normalize("Imperial"), "metric", "exact value only");
  assert.strictEqual(U.normalize("imperial"), "imperial");
  assert.strictEqual(U.set("metric"), false);
  assert.strictEqual(U.set("imperial"), true);
  assert.strictEqual(U.get(), "imperial");
  assert.strictEqual(U.set("nonsense"), true, "anything else is Metric");
  assert.strictEqual(U.get(), "metric");
});

test("helper: distances / altitudes (km in), rounding and labels", () => {
  const U = freshUnits();
  assert.strictEqual(U.dist(1234.56), "1235 km");
  assert.strictEqual(U.dist(1234.56, { digits: 1 }), "1234.6 km");
  assert.strictEqual(U.dist(384400, { sep: true }), "384,400 km");
  assert.strictEqual(U.dist(null), "-");
  assert.strictEqual(U.dist(NaN, { dash: "\u2014" }), "\u2014");
  assert.strictEqual(U.distUnit(), "km");
  U.set("imperial");
  assert.strictEqual(U.dist(1.609344), "1 mi");
  assert.strictEqual(U.dist(1234.56, { digits: 1 }), "767.1 mi");
  assert.strictEqual(U.dist(427), "265 mi");
  assert.strictEqual(U.dist(384400, { sep: true }), "238,855 mi");
  assert.strictEqual(U.distUnit(), "mi");
  assert.ok(Math.abs(U.distValue(100) - 62.1371) < 1e-3);
  assert.strictEqual(U.dist(100, { units: "metric" }), "100 km", "per-call override");
});

test("helper: range rate km/s -> m/s | mph, signed; speeds; heights; small distances", () => {
  const U = freshUnits();
  assert.strictEqual(U.rate(-1.234), "-1234 m/s");
  assert.strictEqual(U.rate(5.6789), "+5679 m/s");
  assert.strictEqual(U.rate(0.0001), "0 m/s");
  assert.strictEqual(U.rate(null, { dash: "\u2014" }), "\u2014");
  assert.strictEqual(U.speed(7660), "7660 m/s");
  assert.strictEqual(U.speedUnit(), "m/s");
  assert.strictEqual(U.height(1324), "1324 m");
  assert.deepStrictEqual([18, 185, 1800, 18000].map((m) => U.small(m)), ["18 m", "185 m", "1.8 km", "18 km"]);
  U.set("imperial");
  assert.strictEqual(U.rate(-1.234), "-2760 mph");
  assert.strictEqual(U.rate(1), "+2237 mph");
  assert.strictEqual(U.speed(7660), "17135 mph");
  assert.strictEqual(U.speedUnit(), "mph");
  assert.strictEqual(U.height(1324), "4344 ft");
  assert.deepStrictEqual([18, 185, 1800, 18000].map((m) => U.small(m)), ["59 ft", "607 ft", "1.1 mi", "11 mi"]);
});

test("helper: set() fires units-change once per change", () => {
  const events = [];
  const sb = { CustomEvent: function (t, i) { this.type = t; this.detail = i.detail; }, document: { addEventListener() {}, querySelectorAll: () => [], dispatchEvent: (e) => events.push(e.detail.units) } };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(rd("js/units.js"), sb);
  sb.Units.set("imperial");
  sb.Units.set("imperial");
  sb.Units.set("metric");
  assert.deepStrictEqual(events, ["imperial", "metric"]);
});

/* ---------- per-profile persistence, default, migration ---------- */

test("migration: existing profiles without units load as Metric; invalid -> Metric; empty config stays empty", () => {
  assert.strictEqual(profiles.getActive().config.units, "metric");
  assert.strictEqual(profiles.publicPayload().config.units, "metric");
  assert.strictEqual(profiles.getProfile("Portable").config.units, "metric");
  assert.deepStrictEqual(profiles.getProfile("Blank").config, {}, "never-configured profile keeps {} (client local migration)");
  assert.strictEqual(profiles.getActive().config.elevation, 1324, "other fields untouched");
});

test("persistence: Save stores units in the active profile only; survives a reload; switching follows it", () => {
  profiles.updateActive({ config: { units: profiles.normalizeUnits("imperial") } });
  assert.strictEqual(profiles.publicPayload().config.units, "imperial");
  const disk = JSON.parse(fs.readFileSync(profiles.PROFILES_FILE, "utf8"));
  assert.strictEqual(disk.profiles.Home.config.units, "imperial");
  assert.notStrictEqual(disk.profiles.Portable.config.units, "imperial");
  profiles.load(); // server restart
  assert.strictEqual(profiles.getActive().config.units, "imperial");
  assert(profiles.setActive("Portable"));
  assert.strictEqual(profiles.publicPayload().config.units, "metric");
  assert(profiles.setActive("Home"));
  assert.strictEqual(profiles.publicPayload().config.units, "imperial");
});

test("new profile: copy of the active one keeps its units; a new blank one is Metric once configured", () => {
  assert(profiles.createProfile("Copy", true));
  assert.strictEqual(profiles.getActive().config.units, "imperial");
  assert(profiles.createProfile("Fresh", false));
  assert.strictEqual(profiles.getActive().config.units, undefined, "blank until first Save");
  profiles.updateActive({ config: { callsign: "N0NEW" } });
  profiles.load();
  assert.strictEqual(profiles.getActive().config.units, "metric", "default Metric");
});

test("server wiring: the endpoints (Save) message stores normalized units in the profile", () => {
  const src = rd("server.js");
  assert.match(src, /if \(msg\.units !== undefined\) cfgPatch\.units = profiles\.normalizeUnits\(msg\.units\);\s*profiles\.updateActive\(\{ config: cfgPatch \}\);/);
});

test("Configure wiring: Station select, fill / read / send, applied only from the active profile", () => {
  const html = rd("index.html");
  assert.match(html, /<select id="cfg-units" class="cfg-select">\s*<option value="metric">Metric \(km, m\/s\)<\/option>\s*<option value="imperial">Imperial \(mi, mph\)<\/option>/);
  const stationPane = html.slice(html.indexOf('id="cfg-callsign"'), html.indexOf('<section class="cfg-tab-pane" data-tab="radio"'));
  assert.ok(stationPane.indexOf('id="cfg-units"') > 0, "in the Station section");
  assert.ok(html.indexOf("js/units.js") < html.indexOf("js/map.js"), "loaded first");
  const form = rd("js/config-form.js");
  assert.match(form, /units: val\("cfg-units"\) === "imperial" \? "imperial" : "metric",/);
  assert.match(form, /setVal\("cfg-units", d\.units === "imperial" \? "imperial" : "metric"\);/);
  const cfg = rd("js/config.js");
  assert.match(cfg, /units: cfg\.units === "imperial" \? "imperial" : "metric",/);
  // applyProfilesMessage (active profile: saved / switched) sets it; profile-peek only fills the form.
  assert.match(cfg, /function applyProfilesMessage[\s\S]*?if \(typeof Units !== "undefined"\) Units\.set\(hasServerCfg \? cfg\.units : "metric"\);/);
  const peek = cfg.slice(cfg.indexOf("/** Server reply to profile-peek"), cfg.indexOf("function applyProfilesMessage"));
  assert.ok(peek.length > 50);
  assert.doesNotMatch(peek, /Units\.set/, "an unsaved Configure pick doesn't change the units");
  assert.match(rd("js/config-defaults.js"), /units: "metric"/);
});

/* ---------- display spots ---------- */

function displaySandbox(mode) {
  const sb = { console, Math, Date, JSON, Number, String, Array, Object, isFinite };
  sb.window = sb;
  sb.document = { addEventListener() {}, querySelectorAll: () => [], dispatchEvent() {} };
  sb.CustomEvent = function () {};
  sb.formatPassTime = (t) => new Date(t).toISOString().slice(11, 19) + " UTC";
  sb.formatCountdownClock = (s) => String(Math.round(s));
  vm.createContext(sb);
  vm.runInContext(rd("js/units.js"), sb);
  sb.Units.set(mode);
  const fn = (src, name) => src.match(new RegExp("function " + name + "\\([\\s\\S]*?\\n\\}"))[0];
  vm.runInContext([fn(rd("js/pass-ui.js"), "satDotLabelLines"), fn(rd("js/fav-panel.js"), "fmtKm"), fn(rd("js/fav-panel.js"), "fmtRate")].join("\n"), sb);
  vm.runInContext(rd("js/moon-panel.js"), sb);
  return sb;
}
const st = { display: "ISS", position: { lat: 1, lon: 2, heightKm: 427 }, look: { el: 12, rangeKm: 1500 } };

test("display: sat dot labels (map / globe / hover), Favorites panel, Moon panel — Metric", () => {
  const sb = displaySandbox("metric");
  const L = sb.satDotLabelLines(st);
  assert.deepStrictEqual([...L.lines], ["ISS", "El 12\u00B0", "Rng 1500 km", "Alt 427 km"]);
  assert.strictEqual(sb.fmtKm(1500.04, 1), "1500.0 km");
  assert.strictEqual(sb.fmtRate(-3.21), "-3210 m/s");
  assert.strictEqual(sb.moonPanelRows({ isMoon: true, moon: { geoDistKm: 384400.4 } }).dist, "384,400 km");
});

test("display: the same spots — Imperial", () => {
  const sb = displaySandbox("imperial");
  const L = sb.satDotLabelLines(st);
  assert.deepStrictEqual([...L.lines], ["ISS", "El 12\u00B0", "Rng 932 mi", "Alt 265 mi"]);
  assert.strictEqual(sb.fmtKm(1500, 1), "932.1 mi");
  assert.strictEqual(sb.fmtKm(null, 1), "\u2014");
  assert.strictEqual(sb.fmtRate(-3.21), "-7181 mph");
  assert.strictEqual(sb.fmtRate(null), "\u2014");
  assert.strictEqual(sb.moonPanelRows({ isMoon: true, moon: { geoDistKm: 384400 } }).dist, "238,855 mi");
});

test("display wiring: status range, station elevation, globe preview label, DX distance, ambiguity hints; live repaint", () => {
  const tr = rd("js/tracker.js");
  assert.strictEqual((tr.match(/Units\.dist\((?:msg\.look\.rangeKm|km), \{ digits: 1 \}\)/g) || []).length, 2, "both sat-range writers");
  assert.match(tr, /Units\.height\(cfg\.elevation\)/);
  assert.match(tr, /addEventListener\("units-change", \(\) => \{ try \{ updateStationStatus\(\); \} catch \(_\) \{\} \}\);/);
  const gv = rd("js/globe-view.js");
  assert.match(gv, /if \(pT\) return \(st\.display \|\| st\.sat\) \+ " \\u00B7 " \+ D\(st\.position\.heightKm\) \+ " @ "/);
  assert.doesNotMatch(gv, /Math\.round\(st\.position\.heightKm \|\| 0\) \+ " km"/);
  assert.match(gv, /addEventListener\("units-change"/);
  assert.match(rd("js/map.js"), /document\.addEventListener\("units-change", refreshSelSatLabel\);/);
  assert.match(rd("js/qso-call-grid.js"), /Units\.dist\(km\)[\s\S]*addEventListener\("units-change", showDist\)/);
  assert.match(rd("js/fav-panel.js"), /addEventListener\("units-change"/);
  const html = rd("index.html");
  for (const m of [18, 185, 1800, 18000]) assert.ok(html.indexOf('data-m="' + m + '"') > 0, "ambiguity option " + m);
});

test("not converted: logging / ADIF / Doppler / server math stay in standard units", () => {
  for (const f of ["lib/logbook.js", "lib/state.js", "lib/moon.js", "lib/orbit.js"]) {
    if (!fs.existsSync(path.join(__dirname, "..", f))) continue;
    assert.doesNotMatch(rd(f), /Units\.|units\.js|normalizeUnits/, f);
  }
});
