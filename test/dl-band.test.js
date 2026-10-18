// Downlink out-of-band check (js/dl-band.js): passband parsing + two-level compare
// (red: satellite-frame DL out; yellow: only the station/displayed DL out).
// Run: node test/dl-band.test.js
const assert = require("assert");
const { dlPassbandHz, dlOutOfBand, DL_SINGLE_TOL_HZ } = require("../js/dl-band");

// ---- passband parsing
assert.deepStrictEqual(dlPassbandHz("29.400-29.500"), { loHz: 29400000, hiHz: 29500000, single: false });
assert.deepStrictEqual(dlPassbandHz("145.875-145.855"), { loHz: 145855000, hiHz: 145875000, single: false }); // reversed
assert.deepStrictEqual(dlPassbandHz("435.150 \u2013 435.130"), { loHz: 435130000, hiHz: 435150000, single: false });
assert.deepStrictEqual(dlPassbandHz("145.960"), { loHz: 145960000 - DL_SINGLE_TOL_HZ, hiHz: 145960000 + DL_SINGLE_TOL_HZ, single: true });
assert.deepStrictEqual(dlPassbandHz("145.825/437.120"), { loHz: 145815000, hiHz: 145835000, single: true }); // primary only
assert.strictEqual(DL_SINGLE_TOL_HZ, 10000);
for (const bad of [null, undefined, "", "-", "  ", "abc"]) assert.strictEqual(dlPassbandHz(bad), null, String(bad));

const RED = (pb) => "Out of band at satellite: DL passband " + pb + " MHz";
const YEL = (pb) => "Station frequency outside DL passband " + pb + " MHz (satellite in band)";
const chk = (passbandDl, dlHz, dlDopplerHz) => dlOutOfBand({ passbandDl, dlHz, dlDopplerHz });
function expect(r, level, label) {
  assert.ok(r, label);
  assert.strictEqual(r.level, level, label + " level");
  assert.strictEqual(r.oob, level === "oob", label + " oob");
  assert.strictEqual(r.warn, level === "warn", label + " warn");
  if (!level) assert.strictEqual(r.text, "", label + " text");
}

// ---- linear transponder 435.130-435.150
const LIN = "435.130-435.150";
expect(chk(LIN, 435140000, 0), null, "centre");
expect(chk(LIN, 435130000, 0), null, "low edge inclusive");
expect(chk(LIN, 435150000, 0), null, "high edge inclusive");
expect(chk(LIN, 435150001, 0), "oob", "1 Hz above");
expect(chk(LIN, 435129999, 0), "oob", "1 Hz below");
assert.strictEqual(chk(LIN, 435129999, 0).text, RED("435.130\u2013435.150"));
// Doppler alone never turns it red: sat frame in band, station out -> yellow
expect(chk(LIN, 435159000, 9000), "warn", "+9 kHz Doppler at top edge");
expect(chk(LIN, 435121000, -9000), "warn", "-9 kHz Doppler at bottom edge");
assert.strictEqual(chk(LIN, 435159000, 9000).text, YEL("435.130\u2013435.150"));
// tuned offset outside the band -> red, whatever the Doppler (both out)
const both = chk(LIN, 435165000, 9000);
expect(both, "oob", "both out");
assert.ok(both.satOut && both.stationOut);
// sat out but station in (Doppler pulls the readout back in) -> still red
const satOnly = chk(LIN, 435145000, -9000);
expect(satOnly, "oob", "sat out, station in");
assert.ok(satOnly.satOut && !satOnly.stationOut);

// ---- FO-29: displayed 435.794229, Doppler -8.565 kHz -> sat ~435.802794 in
// 435.800-435.900, station below the band -> yellow
{
  const r = chk("435.800-435.900", 435794229, -8565);
  expect(r, "warn", "FO-29");
  assert.strictEqual(r.satHz, 435802794);
  assert.strictEqual(r.stationHz, 435794229);
  assert.ok(!r.satOut && r.stationOut);
  assert.strictEqual(r.text, YEL("435.800\u2013435.900"));
  expect(chk("435.800-435.900", 435850000, -8565), null, "FO-29 both in");
}

// ---- RS-44 (catalog DL descending "435.670-435.610"; either order works)
for (const pbDl of ["435.670-435.610", "435.610-435.670"]) {
  // displayed 435.614470, Doppler +5.705 kHz -> sat 435.608765, below the band -> red
  const r = chk(pbDl, 435614470, 5705);
  expect(r, "oob", "RS-44 sat out " + pbDl);
  assert.strictEqual(r.satHz, 435608765);
  assert.ok(r.satOut && !r.stationOut);
  assert.strictEqual(r.text, RED("435.610\u2013435.670"));
  // same readout with -5 kHz Doppler -> sat 435.619470: both in
  expect(chk(pbDl, 435614470, -5000), null, "RS-44 both in " + pbDl);
  // both out -> red
  expect(chk(pbDl, 435600000, 5705), "oob", "RS-44 both out " + pbDl);
}

// ---- single-frequency FM (145.960 +/- 10 kHz)
const fm = (dlHz, dop) => chk("145.960", dlHz, dop);
expect(fm(145960000 + 3300, 3300), null, "FM small Doppler");
expect(fm(145960000 - 3300, -3300), null, "FM small -Doppler");
expect(fm(145970000, 0), null, "FM edge");
expect(fm(145971000, 0), "oob", "FM +11 kHz offset");
expect(fm(145949000, null), "oob", "no Doppler info -> 0");
assert.strictEqual(fm(145960000, 0).level, null);
assert.strictEqual(fm(145971000, 0).text, RED("145.950\u2013145.970"));
// 70 cm FM: Doppler alone past the +/-10 kHz channel -> yellow, never red
expect(chk("435.350", 435350000 + 10200, 10200), "warn", "70cm FM Doppler 10.2 kHz");

// ---- unknown inputs -> null (no indicator)
assert.strictEqual(dlOutOfBand(null), null);
assert.strictEqual(dlOutOfBand({ passbandDl: "-", dlHz: 145960000 }), null);
assert.strictEqual(dlOutOfBand({ passbandDl: "145.960", dlHz: null }), null);
assert.strictEqual(dlOutOfBand({ passbandDl: "145.960", dlHz: NaN }), null);

console.log("dl-band tests OK");
