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
} = require("./catalog");
const { fetchTLE, cacheSatrec } = require("./tle");
const {
  lookAngles,
  rangeRateKmS,
  groundPoint,
  buildTrail,
  buildForwardTrack,
  findPasses,
  passSkyPath,
} = require("./orbit");
const tci = require("./tci");
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
  tci.init({
    getContext: () => ({ satrec, observer, currentSatKey, currentModeIndex }),
    broadcast: broadcastFn,
  });
  rotor.init({
    broadcast: broadcastFn,
  });
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
    };
  }
  const idx = Math.max(0, Math.min(currentModeIndex, modes.length - 1));
  return modes[idx];
}

function setModeIndex(index) {
  const info = getCatalog()[currentSatKey];
  const max = info && info.modes ? info.modes.length - 1 : 0;
  currentModeIndex = Math.max(0, Math.min(Math.floor(index), max));
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
}

function modesPayload(info) {
  let modes = (info.modes || []).map((m, i) => ({
    index: i,
    mode: m.mode || "Mode " + (i + 1),
    uplink: centerFreqMHz(m.uplink) || "-",
    downlink: centerFreqMHz(m.downlink) || "-",
    isFm: isFmMode(m.mode),
  }));
  if (!modes.length) {
    modes = [
      {
        index: 0,
        mode: info.mode || "Default",
        uplink: centerFreqMHz(info.uplink) || "-",
        downlink: centerFreqMHz(info.downlink) || "-",
        isFm: isFmMode(info.mode),
      },
    ];
  }
  return modes;
}

function computeTick() {
  if (!satrec) return null;
  const now = new Date();
  const look = lookAngles(satrec, observer, now);
  if (!look) return null;

  const rr = rangeRateKmS(satrec, observer, now);
  const info = getCatalog()[currentSatKey] || {};
  const activeMode = getActiveMode(info);
  const freqs = formatFreqDisplayFromMode(activeMode);
  const inverting = isInverting(activeMode && activeMode.mode);
  const radio = tci.getRadioState();
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
      const fRx = f0 * df + radio.manualDlOffset;
      dlDopplerHz = f0 * df - f0;
      dlHz = Math.round(fRx);
      downlink = (fRx / 1e6).toFixed(6);
    }
    if (freqs.ulMHz != null) {
      const f0 = freqs.ulMHz * 1e6;
      let fTx;
      if (inverting) {
        fTx = f0 * (2 - df) - radio.manualDlOffset + radio.ulFineOffset;
        ulDopplerHz = f0 * (2 - df) - f0;
      } else {
        fTx = f0 * df + radio.manualDlOffset + radio.ulFineOffset;
        ulDopplerHz = f0 * df - f0;
      }
      ulHz = Math.round(fTx);
      uplink = (fTx / 1e6).toFixed(6);
    }
  }

  tci.pushFrequencies();

  // Match Python: command the current satellite position (no lead)
  rotor.updateTracking(look, lastAosAz);

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
    tciConnected: radio.tciConnected,
    manualDlOffset: radio.manualDlOffset,
    ulFineOffset: radio.ulFineOffset,
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
  const radio = tci.getRadioState();
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
    tciConnected: radio.tciConnected,
    manualDlOffset: radio.manualDlOffset,
    ulFineOffset: radio.ulFineOffset,
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
