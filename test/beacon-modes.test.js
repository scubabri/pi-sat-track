// Satellite beacons as downlink-only "Beacon" / "Beacon CW" entries in the
// per-sat Mode dropdown (lib/catalog.js addBeaconModes / parseBeaconFreqs).
// Fixture rows are verbatim from palewire amsat-all-frequencies.json.
// Run: node --test --test-force-exit test/beacon-modes.test.js
const test = require("node:test");
const assert = require("assert");
const catalog = require("../lib/catalog");
const ROWS = require("./fixtures/amsat-beacon-rows.json");

const { parseAmsatJson, parseBeaconFreqs, addBeaconModes, centerFreqMHz } = catalog;
const cat = () => parseAmsatJson(JSON.parse(JSON.stringify(ROWS)));
const beacons = (s) => s.modes.filter((m) => m.synthetic === "beacon");
const key = (m) => [m.mode, m.uplink, m.downlink].join("|");

test("parseBeaconFreqs: plain, asterisk, a/b lists; junk skipped", () => {
  assert.deepStrictEqual(parseBeaconFreqs("145.900"), ["145.900"]);
  assert.deepStrictEqual(parseBeaconFreqs(" 437.375* "), ["437.375"]);
  assert.deepStrictEqual(parseBeaconFreqs("145.640/145.660"), ["145.640", "145.660"]);
  assert.deepStrictEqual(parseBeaconFreqs("145.960*/437.325"), ["145.960", "437.325"]);
  assert.deepStrictEqual(parseBeaconFreqs("29.3525/29.3987"), ["29.3525", "29.3987"]);
  for (const junk of ["IU0SIA", "2k4 GMSK_USP", "RS55S", "BN0IDA", "", null, undefined, "145", "145.8-145.9"]) {
    assert.deepStrictEqual(parseBeaconFreqs(junk), [], String(junk));
  }
});

test("LO-87: Beacon CW 145.900 appended after SSB and the 9k6 TLM mode", () => {
  const s = cat()["LO-87"];
  assert.deepStrictEqual(s.modes.map((m) => m.mode), ["SSB CW", "9k6/19k2/40k0* GFSK", "Beacon CW"]);
  const b = s.modes[2];
  assert.strictEqual(b.uplink, "");
  assert.strictEqual(b.downlink, "145.900");
  assert.strictEqual(centerFreqMHz(b.downlink), "145.900");
  assert.strictEqual(b.status, "unknown", "inherits source (SSB CW) row status");
  assert.strictEqual(b.ctcssAccess, null);
  assert.strictEqual(s.modes[1].downlink, "436.445", "TLM entry unchanged");
});

test("CO-55: Beacon CW 436.838 separate from TLM 437.470", () => {
  const s = cat()["CO-55"];
  assert.deepStrictEqual(s.modes.map(key), ["1k2 AFSK CW*||437.470", "Beacon CW||436.838"]);
  assert.strictEqual(s.modes[1].status, "active");
});

test("RS-44: Beacon CW 435.605 (outside the 435.610-435.670 passband)", () => {
  const s = cat()["RS-44"];
  assert.strictEqual(s.modes.length, 2);
  assert.deepStrictEqual(key(s.modes[1]), "Beacon CW||435.605");
  assert.strictEqual(s.modes[1].status, "active", "operational → active");
});

test("SO-50 and ISS: no beacon entries", () => {
  const c = cat();
  assert.strictEqual(beacons(c["SO-50"]).length, 0);
  assert.strictEqual(beacons(c.ISS).length, 0);
  assert.strictEqual(c["SO-50"].modes.length, 1);
});

test("plain 'Beacon' label when the source mode has no CW token (AO-7)", () => {
  const s = cat()["AO-7"];
  const b = beacons(s);
  assert.ok(b.length >= 2);
  for (const m of b) assert.strictEqual(m.mode, "Beacon");
  assert.ok(b.some((m) => m.downlink === "29.502"));
});

test("a/b beacon field → one entry each (XW-2A 145.640/145.660)", () => {
  const b = beacons(cat()["XW-2A"]);
  assert.deepStrictEqual(b.map((m) => m.downlink), ["145.640", "145.660"]);
  assert.ok(b.every((m) => m.mode === "Beacon CW"));
});

test("duplicate suppression: beacon equal to (or within 1.5 kHz of) a mode downlink", () => {
  // AO-91: beacon 145.960 == FM downlink → no Beacon entry
  assert.strictEqual(beacons(cat()["AO-91"]).length, 0);
  const rows = [
    { name: "TEST-1", norad_id: "90001", uplink: null, downlink: "437.025", beacon: "437.025", mode: "TLM 9k6 GMSK", status: "active" },
    { name: "TEST-1", norad_id: "90001", uplink: null, downlink: "435.500", beacon: "435.5010", mode: "CW", status: "active" },
    { name: "TEST-1", norad_id: "90001", uplink: null, downlink: "145.900", beacon: "435.700/435.700*", mode: "CW", status: "active" },
    { name: "TEST-1", norad_id: "90001", uplink: null, downlink: "145.950", beacon: "435.701", mode: "SSB", status: "inactive" },
  ];
  const s = parseAmsatJson(rows)["TEST-1"];
  const b = beacons(s);
  // 437.025 dup of TLM, 435.501 within 1.5 kHz of 435.500, 435.700 once, 435.701 within 1.5 kHz of the 435.700 Beacon
  assert.deepStrictEqual(b.map((m) => m.downlink), ["435.700"]);
  assert.strictEqual(b[0].mode, "Beacon CW");
});

test("junk beacon values (callsigns, mode text) add nothing", () => {
  const rows = [
    { name: "JUNK-1", norad_id: "90002", uplink: null, downlink: "437.000", beacon: "IU0SIA", mode: "1k2 AFSK", status: "active" },
    { name: "JUNK-1", norad_id: "90002", uplink: null, downlink: "436.000", beacon: "2k4 GMSK_USP", mode: "CW", status: "active" },
  ];
  const s = parseAmsatJson(rows)["JUNK-1"];
  assert.strictEqual(beacons(s).length, 0);
  assert.strictEqual(s.modes.length, 2);
});

test("existing modes keep their index and mode|uplink|downlink keys", () => {
  const withB = cat();
  const noB = parseAmsatJson(ROWS.map((r) => ({ ...r, beacon: null })));
  for (const k of Object.keys(noB)) {
    const before = noB[k].modes.map(key);
    const after = withB[k].modes.map(key);
    assert.deepStrictEqual(after.slice(0, before.length), before, k);
    assert.ok(withB[k].modes.slice(before.length).every((m) => m.synthetic === "beacon"), k);
    // sat-level fields (first mode) unchanged
    assert.strictEqual(withB[k].mode, noB[k].mode, k);
    assert.strictEqual(withB[k].downlink, noB[k].downlink, k);
  }
});

test("MODE_OVERRIDES sat (SONATE-2): TLM beacon == TLM downlink → no extra entry", () => {
  const rows = [
    { name: "SONATE-2", norad_id: "59112", uplink: "145.825", downlink: "145.880/437.025", beacon: "437.025", mode: "APRS", status: "active" },
  ];
  const s = parseAmsatJson(rows)["N59112"] || Object.values(parseAmsatJson(rows))[0];
  assert.deepStrictEqual(s.modes.map((m) => m.mode), ["APRS 1k2 AFSK", "SSTV FM", "TLM 9k6 GMSK"]);
});

test("addBeaconModes is idempotent (cached catalogs re-run on load)", () => {
  const s = cat()["LO-87"];
  const n = s.modes.length;
  addBeaconModes(s);
  addBeaconModes(s);
  assert.strictEqual(s.modes.length, n);
});

test("beacon modes are downlink-only for the drivers (no uplink → ulMHz null)", () => {
  const b = beacons(cat()["RS-44"])[0];
  const f = catalog.formatFreqDisplayFromMode(b);
  assert.strictEqual(f.ulMHz, null);
  assert.strictEqual(f.dlMHz, 435.605);
  assert.strictEqual(f.isFm, false);
});
