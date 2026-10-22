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

  function satUlRadio(satKey) {
    return satKey && typeof satOffsets.getUlRadio === "function" ? satOffsets.getUlRadio(satKey) : null;
  }

  /** Radio that should be on uplink for satKey under profile config cfg. */
  function target(cfg, satKey) {
    return roles.resolveUlRadio(cfg, satUlRadio(satKey));
  }

  /**
   * What to hand config.applyEndpoints for `toApply` (a profile config or an
   * endpoints patch). fullCfg (default: toApply) decides single / two radio
   * and the default; only patches that carry the radio sides are swapped.
   * Records the orientation as applied.
   */
  function effective(toApply, satKey, fullCfg) {
    const full = fullCfg || toApply;
    const t = target(full, satKey);
    if (!toApply || !toApply.radioUl || !toApply.radioDl) return toApply;
    applied = t;
    return roles.effectiveEndpoints(toApply, t);
  }

  /**
   * Put the right radio on uplink for satKey. Returns true when the roles
   * changed (caller re-sends the sat's offsets / tones to the drivers).
   */
  function applyForSat(satKey, why) {
    const cfg = getConfig() || {};
    if (!cfg.radioUl || !cfg.radioDl) return false;
    const t = target(cfg, satKey);
    if (t === applied) return false;
    const before = config.getEndpoints();
    const flags = config.applyEndpoints(roles.effectiveEndpoints(cfg, t));
    const after = config.getEndpoints();
    const changes = endpointChanges(before, after);
    const radioKeys = changes.radio.filter((k) => !NO_RECONNECT.has(k));
    const prev = applied;
    applied = t;
    if (radioKeys.length) radios.applyEndpointChange(flags);
    log(
      "Radio roles" + (satKey ? " for " + satKey : "") + (why ? " (" + why + ")" : "") +
        ": UL = Radio " + t + ", DL = Radio " + (t === 1 ? 2 : 1) +
        " (was UL = Radio " + prev + ")" + (radioKeys.length ? "; radio re-applied" : "; endpoints unchanged"),
    );
    return true;
  }

  /** Save the operator's pick for a sat (two-radio profiles only). */
  function setForSat(satKey, n) {
    const cfg = getConfig() || {};
    if (!satKey || !roles.isTwoRadio(cfg) || typeof satOffsets.setUlRadio !== "function") return false;
    const v = roles.normRadio(n);
    if (!v) return false;
    satOffsets.setUlRadio(satKey, v);
    return true;
  }

  function payload(satKey, profileName) {
    return roles.panelPayload(getConfig() || {}, satKey, satUlRadio(satKey), profileName);
  }

  return { applyForSat, setForSat, effective, target, payload, applied: () => applied };
}

module.exports = { createRouter };
