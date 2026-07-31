const satellite = require("satellite.js");
const config = require("./config");
const { C_MS } = config;
const {
  getCatalog,
  getCatalogNote,
  getStatusNote,
  formatFreqDisplayFromMode,
  isInverting,
  isFmMode,
  centerFreqMHz,
  listSatsPayload,
  parseCtcss,
} = require("./catalog");
const { fetchTLE, cacheSatrec } = require("./tle");
const {
  lookAngles,
  lookAnglesLead,
  rangeRateKmS,
  groundPoint,
  buildTrail,
  buildForwardTrack,
  findPasses,
  passSkyPath,
} = require("./orbit");
const tci = require("./tci");
const flex = require("./radios/flex");
const icom = require("./radios/icom");
const rotor = require("./rotor");

let currentSatKey = null;
let currentModeIndex = 0;
let satrec = null;
let tleNote = "";
let currentNorad = null;
let currentOrbit = null;
let observer = {
  latitude: satellite.degreesToRadians(40.5),
  longitude: satellite.degreesToRadians(-111.9),
  height: 1.324,
};

let broadcastFn = () => {};
let lastAosAz = null;

function init(opts) {
  if (opts.broadcast) broadcastFn = opts.broadcast;
  const ctx = () => ({ satrec, observer, currentSatKey, currentModeIndex });
  tci.init({
    getContext: ctx,
    broadcast: broadcastFn,
  });
  flex.init({
    getContext: ctx,
    broadcast: broadcastFn,
  });
  icom.init({
    getContext: ctx,
    broadcast: broadcastFn,
  });
  rotor.init({
    broadcast: broadcastFn,
  });
}

function applyLockDefaultForMode(modeStr) {
  const fm = isFmMode(modeStr);
  if (config.useSerialCat()) icom.applyDefaultLock(fm);
  else if (config.useFlexCat()) flex.applyDefaultLock(fm);
  else if (typeof tci.applyDefaultLock === "function") tci.applyDefaultLock(fm);
  else if (typeof tci.setLock === "function") tci.setLock(fm);
}

function applyCtcssDefaultForMode(info, active) {
  let access = active && active.ctcssAccess;
  let activation = active && active.ctcssActivation;
  if (access == null && activation == null) {
    const tones = parseCtcss(
      active && active.mode,
      currentSatKey,
      info && (info.display || info.name),
    );
    access = tones.access;
    activation = tones.activation;
  }
  const apply = (driver) => {
    if (typeof driver.applyDefaultCtcss === "function") {
      driver.applyDefaultCtcss(access, activation);
    }
  };
  if (config.useSerialCat()) apply(icom);
  else if (config.useFlexCat()) apply(flex);
  else apply(tci);
}

function setObserver(lat, lon, elevM) {
  observer = {
    latitude: satellite.degreesToRadians(lat),
    longitude: satellite.degreesToRadians(lon),
    height: (elevM || 0) / 1000,
  };
}

function getObserver() {
  return observer;
}

function getCurrentKey() {
  return currentSatKey;
}

function getActiveMode(info) {
  if (!info) return null;
  const modes = info.modes || [];
  if (!modes.length) {
    return {
      mode: info.mode || "",
      uplink: info.uplink || "",
      downlink: info.downlink || "",
      beacon: info.beacon || "",
      ctcssAccess: null,
      ctcssActivation: null,
    };
  }
  const idx = Math.max(0, Math.min(currentModeIndex, modes.length - 1));
  return modes[idx];
}

function setModeIndex(index) {
  const info = getCatalog()[currentSatKey];
  const max = info && info.modes ? info.modes.length - 1 : 0;
  currentModeIndex = Math.max(0, Math.min(Math.floor(index), max));
  const active = getActiveMode(info);
  applyLockDefaultForMode(active && active.mode);
  applyCtcssDefaultForMode(info, active);
  return currentModeIndex;
}

async function loadSatellite(key) {
  const info = getCatalog()[key];
  if (!info || !info.norad)
    throw new Error("Unknown or non-trackable sat: " + key);
  currentSatKey = key;
  currentModeIndex = 0;
  currentNorad = info.norad;
  lastAosAz = null;
  tci.resetOffsets();
  flex.resetOffsets();
  icom.resetOffsets();
  const modes = info.modes || [];
  console.log(
    "Catalog freqs for",
    key,
    ":",
    info.uplink,
    "/",
    info.downlink,
    "modes:",
    modes.length,
    modes.map((m) => m.mode || "(none)").join(" | "),
  );
  const tle = await fetchTLE(info.norad);
  satrec = satellite.twoline2satrec(tle.l1, tle.l2);
  cacheSatrec(info.norad, satrec);
  tleNote = tle.note;
  currentOrbit = tle.orbit != null ? tle.orbit : null;
  console.log(
    "Loaded " +
      (info.display || key) +
      " (" +
      info.norad +
      ") - " +
      tleNote +
      (currentOrbit != null ? " orbit " + currentOrbit : ""),
  );
  const active = getActiveMode(info);
  applyLockDefaultForMode(active && active.mode);
  applyCtcssDefaultForMode(info, active);
}

function modesPayload(info) {
  let modes = (info.modes || []).map((m, i) => ({
    index: i,
    mode: m.mode || "Mode " + (i + 1),
    uplink: centerFreqMHz(m.uplink) || "-",
    downlink: centerFreqMHz(m.downlink) || "-",
    isFm: isFmMode(m.mode),
    ctcssAccess: m.ctcssAccess != null ? m.ctcssAccess : null,
    ctcssActivation: m.ctcssActivation != null ? m.ctcssActivation : null,
  }));
  if (!modes.length) {
    const tones = parseCtcss(info.mode, currentSatKey, info.display || info.name);
    modes = [
      {
        index: 0,
        mode: info.mode || "Default",
        uplink: centerFreqMHz(info.uplink) || "-",
        downlink: centerFreqMHz(info.downlink) || "-",
        isFm: isFmMode(info.mode),
        ctcssAccess: tones.access,
        ctcssActivation: tones.activation,
      },
    ];
  }
  return modes;
}

function activeRadioState() {
  if (config.useSerialCat()) return icom.getRadioState();
  if (config.useFlexCat()) return flex.getRadioState();
  return tci.getRadioState();
}

function computeTick() {
  if (!satrec) return null;
  const now = new Date();
  const look = lookAngles(satrec, observer, now);
  if (!look) return null;

  const leadDeg = config.ROTOR_LEAD_DEG || 0;
  const leadLook =
    leadDeg > 0 ? lookAnglesLead(satrec, observer, now, leadDeg) : look;

  const rr = rangeRateKmS(satrec, observer, now);
  const info = getCatalog()[currentSatKey] || {};
  const activeMode = getActiveMode(info);
  const freqs = formatFreqDisplayFromMode(activeMode);
  const inverting = isInverting(activeMode && activeMode.mode);
  const radio = activeRadioState();
  const modes = modesPayload(info);

  let ulDopplerHz = null;
  let dlDopplerHz = null;
  let uplink = freqs.uplink;
  let downlink = freqs.downlink;
  let ulHz = freqs.ulMHz != null ? Math.round(freqs.ulMHz * 1e6) : null;
  let dlHz = freqs.dlMHz != null ? Math.round(freqs.dlMHz * 1e6) : null;

  if (rr != null && Number.isFinite(rr)) {
    const df = 1 - rr / C_MS;
    if (freqs.dlMHz != null) {
      const f0 = freqs.dlMHz * 1e6;
      const fRx =
        f0 * df +
        (radio.manualDlOffset || 0) +
        (radio.dlFineOffset || 0);
      dlDopplerHz = f0 * df - f0;
      dlHz = Math.round(fRx);
      downlink = (fRx / 1e6).toFixed(6);
    }
    if (freqs.ulMHz != null) {
      const f0 = freqs.ulMHz * 1e6;
      let fTx;
      if (inverting) {
        fTx =
          f0 * (2 - df) -
          (radio.manualDlOffset || 0) +
          (radio.ulFineOffset || 0);
        ulDopplerHz = f0 * (2 - df) - f0;
      } else {
        fTx =
          f0 * df + (radio.manualDlOffset || 0) + (radio.ulFineOffset || 0);
        ulDopplerHz = f0 * df - f0;
      }
      ulHz = Math.round(fTx);
      uplink = (fTx / 1e6).toFixed(6);
    }
  }

  if (config.useSerialCat()) {
    icom.pushFrequencies(ulHz, dlHz).catch((e) =>
      console.warn("Icom push:", e.message),
    );
  } else if (config.useFlexCat()) {
    flex.pushFrequencies(ulHz, dlHz).catch((e) =>
      console.warn("Flex push:", e.message),
    );
  } else {
    tci.pushFrequencies();
  }

  const trackLook = leadLook || look;
  rotor.updateTracking(trackLook, lastAosAz);

  const r = rotor.getRotorState();

  if (r.antennaOn) {
    rotor.logSample(look.az, look.el);
  }

  return {
    type: "tick",
    sat: currentSatKey,
    modeIndex: currentModeIndex,
    mode: freqs.mode,
    modes,
    time: now.toISOString(),
    look: { az: look.az, el: look.el, rangeKm: look.rangeKm },
    leadLook: leadLook ? { az: leadLook.az, el: leadLook.el } : null,
    rangeRateKmS: rr,
    uplink,
    downlink,
    ulHz,
    dlHz,
    ulLabel: freqs.ulLabel,
    dlLabel: freqs.dlLabel,
    ulDopplerHz,
    dlDopplerHz,
    ulBase: freqs.uplink,
    dlBase: freqs.downlink,
    passbandUl:
      activeMode && activeMode.uplink ? String(activeMode.uplink) : "-",
    passbandDl:
      activeMode && activeMode.downlink ? String(activeMode.downlink) : "-",
    radioOn: radio.radioOn,
    locked: !!radio.locked,
    tciConnected: radio.tciConnected || radio.connected,
    manualDlOffset: radio.manualDlOffset || 0,
    ulFineOffset: radio.ulFineOffset || 0,
    dlFineOffset: radio.dlFineOffset || 0,
    ctcssMode: radio.ctcssMode || "off",
    ctcssAccessHz: radio.ctcssAccessHz != null ? radio.ctcssAccessHz : null,
    ctcssActivationHz:
      radio.ctcssActivationHz != null ? radio.ctcssActivationHz : null,
    antennaOn: r.antennaOn,
    rotorAz: r.az,
    rotorEl: r.el,
    rotorAzConnected: r.azConnected,
    rotorElConnected: r.elConnected,
  };
}

function computeState() {
  if (!satrec) return null;
  const now = new Date();
  const pos = groundPoint(satrec, now);
  const look = lookAngles(satrec, observer, now);
  if (!pos || !look) return null;

  const trail = buildTrail(satrec, now);
  const forward = buildForwardTrack(satrec, now, 2);
  const passesRaw = findPasses(satrec, observer, now);
  const passes = passesRaw.map((p) => ({
    aos: p.aos,
    los: p.los,
    maxEl: p.maxEl,
    aosAz: p.aosAz,
    sky: passSkyPath(satrec, observer, p.aos, p.los),
  }));

  if (passes.length && passes[0].aosAz != null) {
    lastAosAz = passes[0].aosAz;
  }

  const info = getCatalog()[currentSatKey] || {};
  const tick = computeTick();
  const radio = activeRadioState();
  const r = rotor.getRotorState();

  return {
    type: "state",
    sat: currentSatKey,
    display: info.display || info.name || currentSatKey,
    norad: currentNorad || info.norad || null,
    orbit: currentOrbit,
    modeIndex: tick ? tick.modeIndex : 0,
    mode: tick ? tick.mode : "",
    modes: tick ? tick.modes : [],
    uplink: tick ? tick.uplink : "-",
    downlink: tick ? tick.downlink : "-",
    ulHz: tick ? tick.ulHz : null,
    dlHz: tick ? tick.dlHz : null,
    ulLabel: tick ? tick.ulLabel : "Uplink",
    dlLabel: tick ? tick.dlLabel : "Downlink",
    passbandUl: tick ? tick.passbandUl : "-",
    passbandDl: tick ? tick.passbandDl : "-",
    tleNote,
    catalogNote: getCatalogNote(),
    statusNote: getStatusNote(),
    time: now.toISOString(),
    position: { lat: pos.lat, lon: pos.lon, heightKm: pos.heightKm },
    look: { az: look.az, el: look.el, rangeKm: look.rangeKm },
    rangeRateKmS: tick ? tick.rangeRateKmS : null,
    ulDopplerHz: tick ? tick.ulDopplerHz : null,
    dlDopplerHz: tick ? tick.dlDopplerHz : null,
    trail,
    forward,
    passes,
    radioOn: radio.radioOn,
    locked: !!radio.locked,
    tciConnected: radio.tciConnected || radio.connected,
    manualDlOffset: radio.manualDlOffset || 0,
    ulFineOffset: radio.ulFineOffset || 0,
    dlFineOffset: radio.dlFineOffset || 0,
    ctcssMode: radio.ctcssMode || "off",
    ctcssAccessHz: radio.ctcssAccessHz != null ? radio.ctcssAccessHz : null,
    ctcssActivationHz:
      radio.ctcssActivationHz != null ? radio.ctcssActivationHz : null,
    antennaOn: r.antennaOn,
    rotorAz: r.az,
    rotorEl: r.el,
    rotorAzConnected: r.azConnected,
    rotorElConnected: r.elConnected,
  };
}

function satsPayload(filter) {
  return listSatsPayload(filter || "trackable", observer);
}

module.exports = {
  init,
  setObserver,
  getObserver,
  getCurrentKey,
  setModeIndex,
  loadSatellite,
  computeTick,
  computeState,
  satsPayload,
};
