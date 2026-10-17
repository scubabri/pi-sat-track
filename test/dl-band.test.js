// Downlink out-of-band check (js/dl-band.js): passband parsing + displayed-DL compare (Doppler included).
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

// ---- linear transponder: displayed DL (Doppler included) vs passband
const lin = (dlHz, dop) => dlOutOfBand({ passbandDl: "435.130-435.150", dlHz, dlDopplerHz: dop });
assert.strictEqual(lin(435140000, 0).oob, false);
assert.strictEqual(lin(435130000, 0).oob, false); // edges inclusive
assert.strictEqual(lin(435150000, 0).oob, false);
assert.strictEqual(lin(435150001, 0).oob, true);
assert.strictEqual(lin(435129999, 0).oob, true);
// Doppler is NOT removed: the displayed frequency itself is compared
assert.strictEqual(lin(435159000, 9000).oob, true);
assert.strictEqual(lin(435121000, -9000).oob, true);
assert.strictEqual(lin(435145000, 9000).oob, false); // sat-frame 435.136 would also be in, displayed is in
assert.strictEqual(lin(435135000, -20000).oob, false); // sat-frame would be out; displayed is in
assert.strictEqual(lin(435140000, 0).hz, 435140000);
assert.strictEqual(lin(435140000, 0).text, "Out of band: DL passband 435.130\u2013435.150 MHz");

// ---- RS-44 (catalog DL descending "435.670-435.610"): displayed 435.614470 is in band
for (const pbDl of ["435.670-435.610", "435.610-435.670"]) {
  const r = dlOutOfBand({ passbandDl: pbDl, dlHz: 435614470, dlDopplerHz: 9530 });
  assert.strictEqual(r.oob, false, pbDl);
  assert.strictEqual(r.text, "Out of band: DL passband 435.610\u2013435.670 MHz");
  assert.strictEqual(dlOutOfBand({ passbandDl: pbDl, dlHz: 435609000, dlDopplerHz: -2000 }).oob, true);
  assert.strictEqual(dlOutOfBand({ passbandDl: pbDl, dlHz: 435671000, dlDopplerHz: 2000 }).oob, true);
}

// ---- single-frequency FM: displayed DL within +/- 10 kHz of the channel
const fm = (dlHz, dop) => dlOutOfBand({ passbandDl: "145.960", dlHz, dlDopplerHz: dop });
assert.strictEqual(fm(145960000 + 3300, 3300).oob, false);
assert.strictEqual(fm(145960000 - 3300, -3300).oob, false);
assert.strictEqual(fm(145970000, 0).oob, false); // edge inclusive
assert.strictEqual(fm(145971000, 0).oob, true);
assert.strictEqual(fm(145949000, null).oob, true);
assert.strictEqual(fm(145971000, 11000).oob, true); // Doppler not subtracted
assert.strictEqual(fm(145960000, 0).text, "Out of band: DL passband 145.950\u2013145.970 MHz");
assert.strictEqual(dlOutOfBand({ passbandDl: "435.350", dlHz: 435350000 + 10200, dlDopplerHz: 10200 }).oob, true);
assert.strictEqual(dlOutOfBand({ passbandDl: "435.350", dlHz: 435350000 + 9800, dlDopplerHz: 9800 }).oob, false);

// ---- unknown inputs -> null (no indicator)
assert.strictEqual(dlOutOfBand(null), null);
assert.strictEqual(dlOutOfBand({ passbandDl: "-", dlHz: 145960000 }), null);
assert.strictEqual(dlOutOfBand({ passbandDl: "145.960", dlHz: null }), null);
assert.strictEqual(dlOutOfBand({ passbandDl: "145.960", dlHz: NaN }), null);

console.log("dl-band tests OK");
