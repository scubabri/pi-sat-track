/**
 * Routes the two radios of a two-radio profile to the UL / DL roles for the
 * selected sat (Radio 1 / Radio 2, lib/radio-roles.js).
 *
 * The stored profile config never changes here: the router applies
 * roles.effectiveEndpoints(cfg, ulRadio) and, exactly like a profile switch
 * (lib/profile-apply.js), re-applies the radio drivers only when a radio
 * endpoint actually differs. Same orientation as before = nothing is touched;
 * a swap = radios.applyEndpointChange(), which stops drivers that are no
 * longer selected and re-opens the selected ones in their new role (so the
 * uplink Doppler goes to the radio now on UL, downlink to the other one).
 * A disabled leg (per sat roleOff "ul" | "dl", e.g. a simplex digipeater on
 * one radio) is part of the same orientation: changing it re-applies through
 * the same path; the disabled side maps to no driver.
 *
 * deps: { config, radios, satOffsets, getConfig() → active profile config, log }
 */
const roles = require("./radio-roles");
const { endpointChanges } = require("./endpoint-apply");
const { NO_RECONNECT } = require("./profile-apply");

function createRouter(deps) {
  const { config, radios, satOffsets } = deps;
  const log = deps.log || ((m) => console.log(m));
  const getConfig = deps.getConfig || (() => ({}));
  let applied = 1; // radio currently on uplink (as applied to config / drivers)
  let appliedOff = null; // leg currently disabled ("ul" | "dl" | null)

  function satUlRadio(satKey) {
    return satKey && typeof satOffsets.getUlRadio === "function" ? satOffsets.getUlRadio(satKey) : null;
  }
  function satRoleOff(satKey) {
    return satKey && typeof satOffsets.getRoleOff === "function" ? satOffsets.getRoleOff(satKey) : null;
  }

  /** Radio that should be on uplink for satKey under profile config cfg. */
  function target(cfg, satKey) {
    return roles.resolveUlRadio(cfg, satUlRadio(satKey));
  }
  /** Leg that should be disabled for satKey ("ul" | "dl" | null). */
  function targetOff(cfg, satKey) {
    return roles.resolveRoleOff(cfg, satRoleOff(satKey));
  }
  const key = (t, off) => t + (off ? "|" + off + "-off" : "");

  /**
   * What to hand config.applyEndpoints for `toApply` (a profile config or an
   * endpoints patch). fullCfg (default: toApply) decides single / two radio
   * and the default; only patches that carry the radio sides are swapped.
   * Records the orientation as applied.
   */
  function effective(toApply, satKey, fullCfg) {
    const full = fullCfg || toApply;
    const t = target(full, satKey);
    const off = targetOff(full, satKey);
    if (!toApply || !toApply.radioUl || !toApply.radioDl) return toApply;
    applied = t;
    appliedOff = roles.isTwoRadio(toApply) ? off : null;
    return roles.effectiveEndpoints(toApply, t, appliedOff);
  }

  /**
   * Put the right radio on uplink for satKey. Returns true when the roles
   * changed (caller re-sends the sat's offsets / tones to the drivers).
   */
  function applyForSat(satKey, why) {
    const cfg = getConfig() || {};
    if (!cfg.radioUl || !cfg.radioDl) return false;
    const t = target(cfg, satKey);
    const off = targetOff(cfg, satKey);
    if (t === applied && off === appliedOff) return false;
    const before = config.getEndpoints();
    const flags = config.applyEndpoints(roles.effectiveEndpoints(cfg, t, off));
    const after = config.getEndpoints();
    const changes = endpointChanges(before, after);
    const radioKeys = changes.radio.filter((k) => !NO_RECONNECT.has(k));
    const prev = describe(applied, appliedOff);
    applied = t;
    appliedOff = off;
    if (radioKeys.length) radios.applyEndpointChange(flags);
    log(
      "Radio roles" + (satKey ? " for " + satKey : "") + (why ? " (" + why + ")" : "") +
        ": " + describe(t, off) + " (was " + prev + ")" + (radioKeys.length ? "; radio re-applied" : "; endpoints unchanged"),
    );
    return true;
  }
  function describe(t, off) {
    const o = t === 1 ? 2 : 1;
    return (off === "ul" ? "UL disabled" : "UL = Radio " + t) + ", " + (off === "dl" ? "DL disabled" : "DL = Radio " + o);
  }

  /**
   * Save the operator's pick for a sat (two-radio profiles only): n = radio
   * on uplink (orientation; with a disabled leg, the other leg's radio
   * follows from it), off = "ul" | "dl" | null (undefined: unchanged).
   */
  function setForSat(satKey, n, off) {
    const cfg = getConfig() || {};
    if (!satKey || !roles.isTwoRadio(cfg) || typeof satOffsets.setUlRadio !== "function") return false;
    const v = roles.normRadio(n);
    if (!v) return false;
    if (off !== undefined && off !== null && !roles.normOff(off)) return false;
    satOffsets.setUlRadio(satKey, v);
    if (off !== undefined && typeof satOffsets.setRoleOff === "function") satOffsets.setRoleOff(satKey, roles.normOff(off));
    return true;
  }

  function payload(satKey, profileName) {
    return roles.panelPayload(getConfig() || {}, satKey, satUlRadio(satKey), profileName, satRoleOff(satKey));
  }

  /**
   * Two different drivers with a Flex on one side: { role: "ul"|"dl",
   * legacy } where legacy = Radio 1 is on uplink (the orientation every Flex
   * profile saved before Radio 1 / Radio 2 existed was picked under).
   * null = no Flex, or one driver for both sides (no role split).
   */
  function flexRole() {
    if (typeof radios.activeUl !== "function" || typeof radios.activeDl !== "function") return null;
    const u = radios.activeUl(), d = radios.activeDl();
    const uid = u && u.meta && u.meta.id, did = d && d.meta && d.meta.id;
    if (!uid || !did || uid === did) return null;
    const role = uid === "flex" ? "ul" : did === "flex" ? "dl" : null;
    return role ? { role, legacy: applied === 1 } : null;
  }

  return {
    applyForSat, setForSat, effective, target, targetOff, payload, flexRole,
    applied: () => applied,
    appliedOff: () => appliedOff,
    /** Orientation + disabled leg as one comparable value (server re-apply checks). */
    appliedKey: () => key(applied, appliedOff),
  };
}

module.exports = { createRouter };
