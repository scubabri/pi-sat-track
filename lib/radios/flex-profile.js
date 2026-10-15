/**
 * FlexRadio SmartSDR global profile selection from satellite UL/DL bands.
 *
 * Band ranges (amateur satellite):
 *   2m  = 144–148 MHz
 *   70cm = 420–450 MHz
 *
 * Combos:
 *   V/U = 2m up, 70cm down
 *   U/V = 70cm up, 2m down
 *   V/V = 2m same-band (simplex / APRS)
 * Other combos (e.g. 23cm, U/U) → null (do nothing).
 */

function bandOfHz(hz) {
  if (!Number.isFinite(hz)) return null;
  if (hz >= 144e6 && hz <= 148e6) return "2m";
  if (hz >= 420e6 && hz <= 450e6) return "70cm";
  return null;
}

/**
 * @returns {"VU"|"UV"|"VV"|null}
 */
function bandCombo(ulHz, dlHz) {
  const ul = bandOfHz(ulHz);
  const dl = bandOfHz(dlHz);
  if (!ul || !dl) return null;
  if (ul === "2m" && dl === "70cm") return "VU";
  if (ul === "70cm" && dl === "2m") return "UV";
  if (ul === "2m" && dl === "2m") return "VV";
  return null;
}

/**
 * Pick the configured profile name for this UL/DL pair.
 * @param {number} ulHz
 * @param {number} dlHz
 * @param {{ vu?: string, uv?: string, vv?: string }} names
 * @returns {{ combo: string|null, name: string, label: string }}
 *   name is trimmed; empty string means do nothing.
 */
function selectProfile(ulHz, dlHz, names) {
  const combo = bandCombo(ulHz, dlHz);
  const n = names || {};
  let name = "";
  let label = "";
  if (combo === "VU") {
    name = String(n.vu || "").trim();
    label = "V/U";
  } else if (combo === "UV") {
    name = String(n.uv || "").trim();
    label = "U/V";
  } else if (combo === "VV") {
    name = String(n.vv || "").trim();
    label = "V/V";
  }
  return { combo, name, label };
}

module.exports = { bandOfHz, bandCombo, selectProfile };
