/**
 * Radio 1 / Radio 2 roles (two-radio setups).
 *
 * Storage (per station profile, config): the two radio cards stay in the
 * legacy fields, so existing profiles migrate with no rewrite:
 *   radioUl = Radio 1, radioDl = Radio 2,
 *   radioRoles = { defaultUl: 1|2, names: [r1, r2], bands: [r1, r2] }.
 * A profile without radioRoles is Radio 1 = its old UL radio, Radio 2 = its
 * old DL radio, default uplink = Radio 1, i.e. it behaves exactly as before.
 *
 * Per satellite (lib/sat-offsets.js, per profile) ulRadio: 1|2 picks which
 * radio is on uplink; the other one is on downlink. No saved choice = the
 * profile default. Fine offsets stay with the UL / DL role, not the radio.
 *
 * Per satellite roleOff: "ul" | "dl" | null (lib/sat-offsets.js) disables one
 * leg, e.g. a simplex digipeater (UL = DL) worked on one radio. The disabled
 * side is handed to config.applyEndpoints marked { disabled: true }: it maps
 * to no driver (lib/radios/index.js), no endpoint globals (lib/config.js), so
 * that radio gets no CAT writes, dial absorb, connection or Flex profile load
 * unless it is also the other leg's radio. Never both legs; single-radio
 * profiles ignore it. No saved value = both legs, exactly as before.
 *
 * effectiveEndpoints() turns the stored config into what config.applyEndpoints
 * gets: unchanged when Radio 1 is on uplink (byte-for-byte the old behaviour),
 * otherwise the two sides swapped and the flat legacy radio fields (which the
 * Configure form derives from the stored, unswapped sides) dropped, so the
 * per-side mapping in lib/config.js derives every driver endpoint.
 */

/** Flat radio fields the Configure form derives from radioUl / radioDl. */
const FLAT_RADIO_KEYS = [
  "radioTransport", "radioType", "radioProtocol",
  "tciHost", "tciPort", "sdrconnectHost", "sdrconnectPort",
  "rigctlHost", "rigctlPort", "rigctlUlHost", "rigctlUlPort",
  "flexUlHost", "flexUlPort", "flexDlHost", "flexDlPort", "flexHost", "flexPort",
  "flexApiHost", "flexApiPort",
  "serialDevice", "serialBaud", "serialDevice2", "serialBaud2", "catDevice",
  "serialMake", "serialModel",
];

const BANDS = ["2m", "70cm", "23cm", "any"];

function normRadio(n) {
  const v = Number(n);
  return v === 1 || v === 2 ? v : null;
}

/** Disabled leg: "ul" | "dl" | null. */
function normOff(v) {
  return v === "ul" || v === "dl" ? v : null;
}

/** A side config handed over with its leg disabled (see header). */
function isSideOff(side) {
  return !!(side && typeof side === "object" && side.disabled === true);
}

/** Disabled leg for a sat: its saved value on two-radio profiles, else null. */
function resolveRoleOff(cfg, satOff) {
  return isTwoRadio(cfg) ? normOff(satOff) : null;
}

function cleanText(s, max) {
  return typeof s === "string" ? s.trim().slice(0, max) : "";
}

/** { defaultUl, names, bands } with safe defaults (Radio 1 on uplink). */
function normalizeRoles(r) {
  const o = r && typeof r === "object" ? r : {};
  const names = Array.isArray(o.names) ? o.names : [];
  const bands = Array.isArray(o.bands) ? o.bands : [];
  // Band(s) / antenna note per radio: subset of BANDS ("any" alone).
  const band = (b) => {
    const list = (Array.isArray(b) ? b : typeof b === "string" && b ? [b] : [])
      .map((x) => cleanText(x, 12).toLowerCase())
      .filter((x, i, a) => BANDS.includes(x) && a.indexOf(x) === i);
    return list.includes("any") ? ["any"] : BANDS.filter((x) => list.includes(x));
  };
  return {
    defaultUl: normRadio(o.defaultUl) || 1,
    names: [cleanText(names[0], 32), cleanText(names[1], 32)],
    bands: [band(bands[0]), band(bands[1])],
  };
}

/** Two separate radios configured (Single radio off)? */
function isTwoRadio(cfg) {
  return !!(cfg && typeof cfg === "object" && !cfg.singleRadio && cfg.radioUl && cfg.radioDl);
}

/** Radio on uplink for a sat: its saved choice, else the profile default. Single radio: 1. */
function resolveUlRadio(cfg, satUlRadio) {
  if (!isTwoRadio(cfg)) return 1;
  return normRadio(satUlRadio) || normalizeRoles(cfg.radioRoles).defaultUl;
}

/**
 * Config for config.applyEndpoints with `ulRadio` on uplink and leg `off`
 * ("ul" | "dl") disabled (see header). Radio 1 on uplink, both legs on: the
 * same object (byte-for-byte the old behaviour).
 */
function effectiveEndpoints(cfg, ulRadio, off) {
  if (!cfg || typeof cfg !== "object") return cfg;
  if (!isTwoRadio(cfg)) return cfg;
  const swap = normRadio(ulRadio) === 2;
  const o = normOff(off);
  if (!swap && !o) return cfg;
  const out = Object.assign({}, cfg);
  for (const k of FLAT_RADIO_KEYS) delete out[k];
  // radioSlot: which configured radio (1 / 2) this leg is — lib/hamlib pins each
  // radio's rigctld port to it, so a per-sat role swap never moves / restarts it.
  out.radioUl = Object.assign({}, swap ? cfg.radioDl : cfg.radioUl, { radioSlot: swap ? 2 : 1 });
  out.radioDl = Object.assign({}, swap ? cfg.radioUl : cfg.radioDl, { radioSlot: swap ? 1 : 2 });
  if (o === "ul") out.radioUl = Object.assign({}, out.radioUl, { disabled: true });
  if (o === "dl") out.radioDl = Object.assign({}, out.radioDl, { disabled: true });
  return out;
}

/** Panel label for a radio: "Radio 1 · IC-705" (name optional). */
function radioLabel(roles, n) {
  const r = normalizeRoles(roles);
  const name = r.names[n - 1];
  return "Radio " + n + (name ? " \u00b7 " + name : "");
}

/** Payload for the Frequencies panel dropdowns. */
function panelPayload(cfg, satKey, satUlRadio, profileName, satOff) {
  const two = isTwoRadio(cfg);
  const roles = normalizeRoles(cfg && cfg.radioRoles);
  return {
    type: "radio-roles",
    twoRadio: two,
    sat: satKey || null,
    profile: profileName || "",
    ulRadio: two ? resolveUlRadio(cfg, satUlRadio) : 1,
    saved: two && (normRadio(satUlRadio) != null || normOff(satOff) != null),
    // Disabled leg for this sat ("ul" | "dl" | null): its readout is greyed.
    off: two ? normOff(satOff) : null,
    defaultUl: roles.defaultUl,
    radios: [1, 2].map((n) => ({ n, name: roles.names[n - 1], band: roles.bands[n - 1], label: radioLabel(roles, n) })),
  };
}

module.exports = { FLAT_RADIO_KEYS, BANDS, normRadio, normOff, isSideOff, normalizeRoles, isTwoRadio, resolveUlRadio, resolveRoleOff, effectiveEndpoints, radioLabel, panelPayload };
