/**
 * Station profile switch → re-apply only the subsystems whose settings differ.
 *
 * Root cause (before): applyProfileToRuntime() called radios.applyEndpointChange()
 * on every switch, and config.applyEndpoints() reports radioSelChanged whenever
 * the profile config merely CONTAINS radioUl / radioDl (every saved profile
 * does), so the radio — and via flags.rotorChanged often the rotor — was closed
 * and reopened even between profiles with identical radio / rotor settings
 * (Flex API dropped, CAT reopened, rotor reconnected).
 *
 * Now the endpoints are snapshotted before / after (the same diff as Configure
 * Save, lib/endpoint-apply.js) and each subsystem is re-applied only when one
 * of its own keys changed. The WSJT-X listener needs no call here: its
 * configure() already reopens only on a change of enabled / port / bind.
 *
 * Startup is different: the first apply always runs the radio apply (and the
 * rotor apply when the rotor flags say so) exactly as before. Note the radio
 * does not actually connect from that call — radios.start() (after the profile
 * is applied) is what opens the selected driver; drivers refuse to connect
 * before it — but keeping the startup path unchanged is the safe choice.
 */
const { endpointChanges } = require("./endpoint-apply");

/** Endpoint keys that are read live (no reconnect needed when they change). */
const NO_RECONNECT = new Set(["radioUpdateMs"]);

function list(keys) {
  return keys.length ? " (" + keys.slice(0, 4).join(", ") + (keys.length > 4 ? ", …" : "") + ")" : "";
}

/**
 * name: profile name (log only); cfg: the profile's saved config object.
 * deps: { config, radios, rotor, log }
 * opts: { startup: true } on the first apply after boot.
 * Returns { flags, changes, radio, rotor, wsjtx, line }.
 */
function applyProfileEndpoints(name, cfg, deps, opts) {
  const { config, radios, rotor } = deps;
  const log = deps.log || ((m) => console.log(m));
  const startup = !!(opts && opts.startup);
  const before = config.getEndpoints();
  const flags = config.applyEndpoints(cfg || {});
  const after = config.getEndpoints();
  const changes = endpointChanges(before, after);
  const radioKeys = changes.radio.filter((k) => !NO_RECONNECT.has(k));
  const doRadio = startup || radioKeys.length > 0;
  const doRotor = startup ? !!flags.rotorChanged || changes.rotor.length > 0 : changes.rotor.length > 0;
  if (doRadio) radios.applyEndpointChange(flags);
  if (doRotor) rotor.applyEndpointChange();
  const verb = startup ? "applied" : "re-applied";
  const parts = [
    "radio " + (doRadio ? verb + (startup ? "" : list(radioKeys)) : "unchanged"),
    "rotor " + (doRotor ? verb + (startup ? "" : list(changes.rotor)) : "unchanged"),
    "WSJT-X listener " + (changes.wsjtx.length ? "updated" : "unchanged"),
  ];
  const line = "Profile \u2192 " + name + (startup ? " (startup)" : "") + ": " + parts.join(", ");
  log(line);
  return { flags, changes, radio: doRadio, rotor: doRotor, wsjtx: changes.wsjtx.length > 0, line };
}

module.exports = { applyProfileEndpoints, NO_RECONNECT };
