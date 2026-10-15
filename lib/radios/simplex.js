/**
 * Simplex satellite detection (APRS digipeaters etc.: ISS 145.825,
 * SONATE-2, IO-117 class). UL and DL on the same band within ~10 kHz.
 * Prefer catalog nominal freqs (Doppler/offsets can't push them apart);
 * fall back to the commanded Hz.
 */
const SIMPLEX_MAX_DIFF_HZ = 10000;

function band(hz) {
  if (!Number.isFinite(hz)) return "other";
  if (hz >= 1.0e9) return "23cm";
  if (hz >= 220e6) return "70cm";
  if (hz >= 100e6) return "2m";
  return "other";
}

function isSimplexHz(ulHz, dlHz) {
  if (!Number.isFinite(ulHz) || !Number.isFinite(dlHz)) return false;
  return band(ulHz) === band(dlHz) && band(ulHz) !== "other" &&
    Math.abs(ulHz - dlHz) <= SIMPLEX_MAX_DIFF_HZ;
}

/** nominal: { ulMHz, dlMHz } from catalog.formatFreqDisplayFromMode */
function isSimplex(nominal, ulHz, dlHz) {
  if (nominal && nominal.ulMHz != null && nominal.dlMHz != null)
    return isSimplexHz(nominal.ulMHz * 1e6, nominal.dlMHz * 1e6);
  return isSimplexHz(ulHz, dlHz);
}

module.exports = { isSimplex, isSimplexHz, SIMPLEX_MAX_DIFF_HZ };
