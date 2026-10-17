// Downlink out-of-band check (js/dl-band.js): passband parsing + satellite-frame compare.
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

// ---- linear transponder
const lin = (dlHz, dop) => dlOutOfBand({ passbandDl: "435.130-435.150", dlHz, dlDopplerHz: dop });
assert.strictEqual(lin(435140000, 0).oob, false);
assert.strictEqual(lin(435130000, 0).oob, false); // edges inclusive
assert.strictEqual(lin(435150000, 0).oob, false);
assert.strictEqual(lin(435150001, 0).oob, true);
assert.strictEqual(lin(435129999, 0).oob, true);
// Doppler-shifted readout of an in-band sat-frame freq is NOT flagged (+9 kHz Doppler at band edge)
assert.strictEqual(lin(435159000, 9000).oob, false);
assert.strictEqual(lin(435121000, -9000).oob, false);
// but a tuned offset outside the band is, whatever the Doppler
assert.strictEqual(lin(435165000, 9000).oob, true);
assert.strictEqual(lin(435140000, 0).text, "Out of band: DL passband 435.130\u2013435.150 MHz");

// ---- single-frequency FM: Doppler alone never flags (up to ~10 kHz at 70 cm)
const fm = (dlHz, dop) => dlOutOfBand({ passbandDl: "145.960", dlHz, dlDopplerHz: dop });
assert.strictEqual(fm(145960000 + 3300, 3300).oob, false);
assert.strictEqual(fm(145960000 - 3300, -3300).oob, false);
assert.strictEqual(fm(145969000, 0).oob, false);
assert.strictEqual(fm(145971000, 0).oob, true); // manual offset +11 kHz
assert.strictEqual(fm(145949000, null).oob, true); // no Doppler info -> treated as 0
assert.strictEqual(fm(145960000, 0).text, "Out of band: DL passband 145.950\u2013145.970 MHz");
const fm70 = dlOutOfBand({ passbandDl: "435.350", dlHz: 435350000 + 10200, dlDopplerHz: 10200 });
assert.strictEqual(fm70.oob, false);

// ---- unknown inputs -> null (no indicator)
assert.strictEqual(dlOutOfBand(null), null);
assert.strictEqual(dlOutOfBand({ passbandDl: "-", dlHz: 145960000 }), null);
assert.strictEqual(dlOutOfBand({ passbandDl: "145.960", dlHz: null }), null);
assert.strictEqual(dlOutOfBand({ passbandDl: "145.960", dlHz: NaN }), null);

console.log("dl-band tests OK");
