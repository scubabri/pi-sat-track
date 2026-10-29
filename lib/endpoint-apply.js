/**
 * Configure Save → endpoints: apply and only re-open what changed.
 *
 * Configure's Save sends the whole endpoints form even when only APRS / KISS
 * (or station) settings were edited. Every radio / rotor driver closes and
 * reopens its links in applyEndpointChange(), so applying unconditionally
 * dropped the Flex API, CAT and rotor connections on every save. Here the
 * endpoints are compared before / after and each subsystem is touched only
 * when one of its own settings changed.
 */

const SKIP = new Set(["serialCatalog", "host"]);
/** Which subsystem an endpoints key belongs to. */
function groupOf(key) {
  if (/^rotor/.test(key)) return "rotor";
  if (/^log/.test(key)) return "log";
  if (/^wsjtx/.test(key)) return "wsjtx";
  return "radio";
}

/** Keys that differ between two getEndpoints() snapshots, by group. */
function endpointChanges(before, after) {
  const out = { radio: [], rotor: [], log: [], wsjtx: [], any: false };
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    if (SKIP.has(k)) continue;
    if (JSON.stringify((before || {})[k]) === JSON.stringify((after || {})[k])) continue;
    out[groupOf(k)].push(k);
    out.any = true;
  }
  return out;
}

/** One log line instead of the whole endpoints JSON. */
function summarize(ep, changes) {
  const side = (s) => (s ? [s.type || "", s.transport || "", s.host ? s.host + (s.port ? ":" + s.port : "") : s.device || ""].filter(Boolean).join(" ") : "-");
  const parts = [];
  parts.push(ep.singleRadio ? "radio " + side(ep.radioUl) : "UL " + side(ep.radioUl) + ", DL " + side(ep.radioDl));
  parts.push("rotor " + (ep.rotorType || "-"));
  parts.push("log " + (ep.logMethod || "-"));
  const ch = ["radio", "rotor", "log", "wsjtx"].filter((g) => changes[g].length).map((g) => g + " (" + changes[g].slice(0, 6).join(", ") + (changes[g].length > 6 ? ", …" : "") + ")");
  return "Endpoints " + (changes.any ? "updated: " + ch.join("; ") : "saved, unchanged") + " | " + parts.join(", ");
}

/**
 * deps: {config, radios, rotor, rotors, applyWsjtx, log, debug}
 * Returns {flags, changes}.
 */
function applyEndpointSave(ep, deps) {
  const { config, radios, rotor } = deps;
  const log = deps.log || ((m) => console.log(m));
  const before = config.getEndpoints();
  const flags = config.applyEndpoints(ep);
  const after = config.getEndpoints();
  const changes = endpointChanges(before, after);
  log(summarize(after, changes));
  if (deps.debug) deps.debug("Endpoints (full)", after);
  if (changes.radio.length) {
    if (radios && radios.active) log("Radio path: " + radios.active().meta.id);
    radios.applyEndpointChange(flags);
  }
  if (changes.rotor.length) {
    if (deps.rotors && deps.rotors.active) log("Rotor path: " + deps.rotors.active().meta.id);
    rotor.applyEndpointChange();
  }
  if (changes.wsjtx.length && deps.applyWsjtx) deps.applyWsjtx();
  return { flags, changes };
}

/** Configure's "endpoints" message -> config.applyEndpoints() input. */
function endpointsFromMsg(msg) {
  const ep = {
    singleRadio: !!msg.singleRadio,
    txSplit: msg.txSplit !== false,
    radioUl: msg.radioUl,
    radioDl: msg.radioDl,
    // Two radios: radioUl = Radio 1, radioDl = Radio 2; names / bands / default UL (lib/radio-roles.js)
    radioRoles: msg.radioRoles && typeof msg.radioRoles === "object" ? msg.radioRoles : undefined,
    radioTransport: msg.radioTransport,
    radioType: msg.radioType,
    radioProtocol: msg.radioProtocol,
    serialMake: msg.serialMake,
    serialModel: msg.serialModel,
    tciHost: msg.tciHost,
    tciPort: msg.tciPort,
    sdrconnectHost: msg.sdrconnectHost,
    sdrconnectPort: msg.sdrconnectPort,
    rigctlHost: msg.rigctlHost,
    rigctlPort: msg.rigctlPort,
    rigctlUlHost: msg.rigctlUlHost,
    rigctlUlPort: msg.rigctlUlPort,
    flexUlHost: msg.flexUlHost,
    flexUlPort: msg.flexUlPort,
    flexDlHost: msg.flexDlHost,
    flexDlPort: msg.flexDlPort,
    flexApiHost: msg.flexApiHost,
    flexApiPort: msg.flexApiPort,
    flexHost: msg.flexHost,
    flexPort: msg.flexPort,
    serialDevice: msg.serialDevice,
    serialBaud: msg.serialBaud,
    serialDevice2: msg.serialDevice2,
    serialBaud2: msg.serialBaud2,
    catDevice: msg.serialDevice,
    rotorHost: msg.rotorHost,
    rotorAzPort: msg.rotorAzPort,
    rotorElPort: msg.rotorElPort,
    rotorType: msg.rotorType,
    rotorAzDevice: msg.rotorAzDevice,
    rotorElDevice: msg.rotorElDevice,
    rotorBaud: msg.rotorBaud,
    rotorHamlibModel: msg.rotorHamlibModel,
    rotorHamlibSplit: typeof msg.rotorHamlibSplit === "boolean" ? msg.rotorHamlibSplit : undefined,
    rotorHamlibElDevice: msg.rotorHamlibElDevice,
    rotorHamlibElBaud: msg.rotorHamlibElBaud,
    rotorHamlibElModel: msg.rotorHamlibElModel,
    rotorParkAz: msg.rotorParkAz,
    rotorParkEl: msg.rotorParkEl,
    rotorElMax: msg.rotorElMax,
    rotorAzOnly: !!msg.rotorAzOnly,
    rotorMinEl: msg.rotorMinEl,
    rotorAfterLos: msg.rotorAfterLos,
    rotorAzStop: msg.rotorAzStop,
    logMethod: msg.logMethod,
    logAmsatHeard: typeof msg.logAmsatHeard === "boolean" ? msg.logAmsatHeard : undefined,
    logAdifPath: msg.logAdifPath,
    logUdpHost: msg.logUdpHost,
    logUdpPort: msg.logUdpPort,
    radioUpdateMs: msg.radioUpdateMs,
    logUdpFormat: msg.logUdpFormat,
    logUdpTtl: msg.logUdpTtl,
    logUdpIface: msg.logUdpIface,
    wsjtxListen: !!msg.wsjtxListen,
    wsjtxListenPort: msg.wsjtxListenPort,
    wsjtxListenBind: msg.wsjtxListenBind,
    hamlibNet: msg.hamlibNet && typeof msg.hamlibNet === "object" ? msg.hamlibNet : undefined,
  };
  if (!ep.hamlibNet) delete ep.hamlibNet;
  // Older clients send no radioRoles: keep the profile's (no undefined key).
  if (!ep.radioRoles) delete ep.radioRoles;
  return ep;
}

module.exports = { applyEndpointSave, endpointsFromMsg, endpointChanges, summarize, groupOf };
