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
const {
  fetchTLE,
  cacheSatrec,
  getSatrecForNorad,
  getOrbitForNorad,
} = require("./tle");
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
const radios = require("./radios");
const rotor = require("./rotor");
const satOffsets = require("./sat-offsets");

let currentSatKey = null;
let currentModeIndex = 0;
let satrec = null;
let tleNote = "";
let currentNorad = null;
let currentOrbit = null;
let favoriteKeys = [];
let ulFixed = false;
let observer = {
  latitude: satellite.degreesToRadians(40.5),
  longitude: satellite.degreesToRadians(-111.9),
  height: 1.324,
};

let broadcastFn = () => {};
let lastAosAz = null;
let lastLosAz = null;

function init(opts) {
  if (opts.broadcast) broadcastFn = opts.broadcast;
  const ctx = () => ({
    satrec,
    observer,
    currentSatKey,
    currentModeIndex,
    ulFixed,
  });
  radios.init({ getContext: ctx, broadcast: broadcastFn });
  rotor.init({ broadcast: broadcastFn });
  satOffsets.load();
}

function radio() {
  return radios.active();
}

function applyLockDefaultForMode(modeStr) {
  const fm = isFmMode(modeStr);
  const r = radio();
  if (typeof r.applyDefaultLock === "function") r.applyDefaultLock(fm);
  else if (typeof r.setLock === "function") r.setLock(fm);
}

function applyUlFixedDefaultForMode(active) {
  const fm = isFmMode(active && active.mode);
  const ulMHz = centerFreqMHz(active && active.uplink);
  const ul = ulMHz != null ? parseFloat(ulMHz) : null;
  ulFixed = !!(fm && ul != null && Number.isFinite(ul) && ul < 200);
  console.log("UL fixed default", ulFixed, "(FM", fm, "UL", ul, "MHz)");
}

function setUlFixed(on) {
  ulFixed = !!on;
  console.log("UL fixed", ulFixed ? "ON (published)" : "OFF (Doppler)");
}

function applyCtcssDefaultForMode(info, active) {
  let access = active && active.ctcssAccess;
  let activation = active && active.ctcssActivation;
  if (access == null && activation == null) {
    const tones = parseCtcss(
      active && active.mode,
      currentSatKey,
      info && (info.display || info.name),
      info && info.norad,
    );
    access = tones.access;
    activation = tones.activation;
  }
  const r = radio();
  if (typeof r.applyDefaultCtcss === "function") {
    r.applyDefaultCtcss(access, activation);
  }
  console.log(
    "CTCSS defaults → access",
    access,
    "activation",
    activation,
    "(via",
    r.meta && r.meta.id,
    ")",
  );
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
  applyUlFixedDefaultForMode(active);
  // Remember last mode for this sat
  if (currentSatKey && typeof satOffsets.setModeIndex === "function") {
    satOffsets.setModeIndex(currentSatKey, currentModeIndex);
  }
  return currentModeIndex;
}

function applySavedOffsetsForSat(key) {
  const saved = satOffsets.get(key);
  if (!saved) return;
  const r = radio();
  if (typeof r.setOffsets === "function") {
    r.setOffsets(saved);
    console.log(
      "Restored offsets for",
      key,
      "UL",
      saved.ulFineOffset,
      "DL",
      saved.dlFineOffset,
      "manual",
      saved.manualDlOffset,
      "Hz",
    );
  } else {
    if (saved.ulFineOffset && typeof r.adjustFine === "function")
      r.adjustFine(saved.ulFineOffset, "ul");
    if (saved.dlFineOffset && typeof r.adjustFine === "function")
      r.adjustFine(saved.dlFineOffset, "dl");
  }
}

function persistCurrentOffsets() {
  if (!currentSatKey) return;
  const st = radio().getRadioState() || {};
  satOffsets.set(currentSatKey, {
    ulFineOffset: st.ulFineOffset || 0,
    dlFineOffset: st.dlFineOffset || 0,
    manualDlOffset: st.manualDlOffset || 0,
  });
}

function clearPersistedOffsets() {
  if (!currentSatKey) return;
  // Center clears frequency calibration only — keep last mode selection
  const mode =
    typeof satOffsets.getModeIndex === "function"
      ? satOffsets.getModeIndex(currentSatKey)
      : null;
  satOffsets.clear(currentSatKey);
  if (mode != null && typeof satOffsets.setModeIndex === "function") {
    satOffsets.setModeIndex(currentSatKey, mode);
  }
}

async function loadSatellite(key) {
  const info = getCatalog()[key];
  if (!info || !info.norad)
    throw new Error("Unknown or non-trackable sat: " + key);
  currentSatKey = key;
  currentModeIndex = 0;
  currentNorad = info.norad;
  lastAosAz = null;
  lastLosAz = null;

  // Restore last mode for this sat (clamped to available modes)
  const modesList = info.modes || [];
  const savedMode =
    typeof satOffsets.getModeIndex === "function"
      ? satOffsets.getModeIndex(key)
      : null;
  if (
    savedMode != null &&
    modesList.length > 0 &&
    savedMode >= 0 &&
    savedMode < modesList.length
  ) {
    currentModeIndex = savedMode;
    console.log("Restored mode index", savedMode, "for", key);
  } else if (savedMode != null && !modesList.length && savedMode === 0) {
    currentModeIndex = 0;
  }

  radios.resetAllOffsets();
  const activeEarly = getActiveMode(info);
  applyLockDefaultForMode(activeEarly && activeEarly.mode);
  applyCtcssDefaultForMode(info, activeEarly);
  applyUlFixedDefaultForMode(activeEarly);

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

  radios.resetAllOffsets();
  const active = getActiveMode(info);
  applyLockDefaultForMode(active && active.mode);
  applyCtcssDefaultForMode(info, active);
  applyUlFixedDefaultForMode(active);

  applySavedOffsetsForSat(key);
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
    const tones = parseCtcss(
      info.mode,
      currentSatKey,
      info.display || info.name,
      info.norad,
    );
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
  for (const m of modes) {
    if (m.ctcssAccess == null && m.ctcssActivation == null && m.isFm) {
      const tones = parseCtcss(
        m.mode,
        currentSatKey,
        info.display || info.name,
        info.norad,
      );
      m.ctcssAccess = tones.access;
      m.ctcssActivation = tones.activation;
    }
  }
  return modes;
}

function setFavorites(keys) {
  if (!Array.isArray(keys)) keys = [];
  favoriteKeys = keys
    .filter((k) => typeof k === "string" && k)
    .filter((k, i, a) => a.indexOf(k) === i)
    .slice(0, 24);
  favoriteKeys.forEach((key) => {
    ensureSatrecForKey(key).catch(() => {});
  });
  console.log(
    "Favorites set:",
    favoriteKeys.length,
    favoriteKeys.join(", ") || "(none)",
  );
}

async function ensureSatrecForKey(key) {
  if (!key) return null;
  if (key === currentSatKey && satrec) return satrec;
  const info = getCatalog()[key] || {};
  const norad = info.norad != null ? String(info.norad) : null;
  if (!norad) return null;
  let rec = getSatrecForNorad(norad);
  if (rec) return rec;
  try {
    const tle = await fetchTLE(norad);
    if (!tle) return null;
    rec = satellite.twoline2satrec(tle.l1, tle.l2);
    cacheSatrec(norad, rec);
    return rec;
  } catch (e) {
    return null;
  }
}

function lookSnapshotForSatrec(rec, key) {
  if (!rec) return null;
  const now = new Date();
  const look = lookAngles(rec, observer, now);
  if (!look) return null;
  const pos = groundPoint(rec, now);
  const rr = rangeRateKmS(rec, observer, now);
  const info = getCatalog()[key] || {};
  let orbit = null;
  if (key === currentSatKey && currentOrbit != null) {
    orbit = currentOrbit;
  } else if (info.norad != null) {
    orbit = getOrbitForNorad(info.norad);
  }
  return {
    key: key,
    display: info.display || info.name || key,
    norad: info.norad != null ? info.norad : null,
    look: { az: look.az, el: look.el, rangeKm: look.rangeKm },
    position: pos
      ? { lat: pos.lat, lon: pos.lon, heightKm: pos.heightKm }
      : null,
    rangeRateKmS: rr,
    above: look.el >= 0,
    orbit: orbit,
  };
}

function computeFavoritesLooks() {
  const out = [];
  const seen = new Set();
  const keys = favoriteKeys.slice();
  if (currentSatKey && !keys.includes(currentSatKey)) {
    keys.unshift(currentSatKey);
  }
  for (const key of keys) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    let rec = null;
    if (key === currentSatKey && satrec) {
      rec = satrec;
    } else {
      const info = getCatalog()[key] || {};
      const norad = info.norad != null ? String(info.norad) : null;
      if (norad) rec = getSatrecForNorad(norad);
    }
    const snap = lookSnapshotForSatrec(rec, key);
    if (snap) out.push(snap);
    else {
      const info = getCatalog()[key] || {};
      out.push({
        key: key,
        display: info.display || info.name || key,
        norad: info.norad != null ? info.norad : null,
        look: null,
        position: null,
        rangeRateKmS: null,
        above: false,
        orbit: info.norad != null ? getOrbitForNorad(info.norad) : null,
      });
    }
  }
  return out;
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
  const rState = radio().getRadioState();
  const modes = modesPayload(info);

  let ctcssAccessHz =
    rState.ctcssAccessHz != null
      ? rState.ctcssAccessHz
      : modes[currentModeIndex] && modes[currentModeIndex].ctcssAccess != null
        ? modes[currentModeIndex].ctcssAccess
        : null;
  let ctcssActivationHz =
    rState.ctcssActivationHz != null
      ? rState.ctcssActivationHz
      : modes[currentModeIndex] &&
          modes[currentModeIndex].ctcssActivation != null
        ? modes[currentModeIndex].ctcssActivation
        : null;

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
        f0 * df + (rState.manualDlOffset || 0) + (rState.dlFineOffset || 0);
      dlDopplerHz = f0 * df - f0;
      dlHz = Math.round(fRx);
      downlink = (fRx / 1e6).toFixed(6);
    }
    if (freqs.ulMHz != null) {
      const f0 = freqs.ulMHz * 1e6;
      if (ulFixed) {
        const fTx = f0 + (rState.ulFineOffset || 0);
        ulDopplerHz = 0;
        ulHz = Math.round(fTx);
        uplink = (fTx / 1e6).toFixed(6);
      } else {
        let fTx;
        if (inverting) {
          fTx =
            f0 * (2 - df) -
            (rState.manualDlOffset || 0) +
            (rState.ulFineOffset || 0);
          ulDopplerHz = f0 * (2 - df) - f0;
        } else {
          fTx =
            f0 * df + (rState.manualDlOffset || 0) + (rState.ulFineOffset || 0);
          ulDopplerHz = f0 * df - f0;
        }
        ulHz = Math.round(fTx);
        uplink = (fTx / 1e6).toFixed(6);
      }
    }
  } else if (ulFixed && freqs.ulMHz != null) {
    const fTx = freqs.ulMHz * 1e6 + (rState.ulFineOffset || 0);
    ulHz = Math.round(fTx);
    uplink = (fTx / 1e6).toFixed(6);
    ulDopplerHz = 0;
  }

  try {
    const p = radio().pushFrequencies(ulHz, dlHz);
    if (p && typeof p.catch === "function") {
      p.catch((e) => console.warn("Radio push:", e.message));
    }
  } catch (e) {
    console.warn("Radio push:", e.message);
  }

  const trackLook = leadLook || look;
  const rotorMinEl =
    config.ROTOR_MIN_EL != null && Number.isFinite(config.ROTOR_MIN_EL)
      ? config.ROTOR_MIN_EL
      : 0;
  // Pass geometry relative to rotator min EL (AOS/LOS az = az at min EL).
  // While IN a pass: publish this pass aos/los + next pass AOS for preposition.
  // While BETWEEN passes: do NOT publish next pass losAz as "current los" —
  // that made the rotor slew to the wrong az immediately after LOS.
  let rotorAosAz = null;
  let rotorLosAz = null;
  let rotorNextAosMs = null;
  let rotorNextAosAz = null;
  let rotorNextLosAz = null;
  let inPass = false;
  try {
    const passesR = findPasses(satrec, observer, now, rotorMinEl);
    const tnow = now.getTime();
    for (let i = 0; i < passesR.length; i++) {
      const p = passesR[i];
      const aosMs = new Date(p.aos).getTime();
      const losMs = new Date(p.los).getTime();
      if (tnow >= aosMs && tnow <= losMs) {
        inPass = true;
        rotorAosAz = p.aosAz != null ? p.aosAz : null;
        rotorLosAz = p.losAz != null ? p.losAz : null;
        lastAosAz = rotorAosAz;
        lastLosAz = rotorLosAz;
        if (passesR[i + 1]) {
          rotorNextAosMs = new Date(passesR[i + 1].aos).getTime();
          rotorNextAosAz = passesR[i + 1].aosAz;
          rotorNextLosAz = passesR[i + 1].losAz;
        }
        break;
      }
    }
    if (!inPass) {
      for (let i = 0; i < passesR.length; i++) {
        const p = passesR[i];
        const aosMs = new Date(p.aos).getTime();
        if (aosMs > tnow) {
          rotorNextAosMs = aosMs;
          rotorNextAosAz = p.aosAz;
          rotorNextLosAz = p.losAz;
          break;
        }
      }
      // Keep lastAosAz/lastLosAz from the pass we were just in (for logging);
      // do not pass them as live los targets — driver holds its own heldLosAz.
    }
  } catch (e) {
    console.warn("Rotor pass meta:", e.message || e);
  }
  rotor.updateTracking(trackLook, rotorAosAz, rotorLosAz, {
    nextAosMs: rotorNextAosMs,
    nextAosAz: rotorNextAosAz,
    nextLosAz: rotorNextLosAz,
    minEl: rotorMinEl,
    satKey: currentSatKey,
    inPass: inPass,
  });

  const r = rotor.getRotorState();
  if (r.antennaOn) rotor.logSample(look.az, look.el);

  return {
    type: "tick",
    sat: currentSatKey,
    modeIndex: currentModeIndex,
    mode: freqs.mode,
    modes,
    isFm: !!freqs.isFm,
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
    radioOn: rState.radioOn,
    locked: !!rState.locked,
    ulFixed,
    tciConnected: rState.tciConnected || rState.connected,
    manualDlOffset: rState.manualDlOffset || 0,
    ulFineOffset: rState.ulFineOffset || 0,
    dlFineOffset: rState.dlFineOffset || 0,
    ctcssMode: rState.ctcssMode || "off",
    ctcssAccessHz,
    ctcssActivationHz,
    antennaOn: r.antennaOn,
    rotorAz: r.az,
    rotorEl: r.el,
    rotorAzConnected: r.azConnected,
    rotorElConnected: r.elConnected,
    flipped: !!r.flipped,
    favorites: computeFavoritesLooks(),
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
    losAz: p.losAz,
    sky: passSkyPath(satrec, observer, p.aos, p.los),
  }));

  // Only refresh last AOS/LOS from a pass that contains "now" — never from the
  // next future pass (that made post-LOS hold jump to the wrong azimuth).
  if (passes.length) {
    const tnow = now.getTime();
    for (const p of passes) {
      const aosMs = new Date(p.aos).getTime();
      const losMs = new Date(p.los).getTime();
      if (tnow >= aosMs && tnow <= losMs && p.aosAz != null) {
        lastAosAz = p.aosAz;
        lastLosAz = p.losAz != null ? p.losAz : null;
        break;
      }
    }
  }

  const info = getCatalog()[currentSatKey] || {};
  const tick = computeTick();
  const rState = radio().getRadioState();
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
    isFm: tick ? tick.isFm : false,
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
    radioOn: rState.radioOn,
    locked: !!rState.locked,
    ulFixed,
    tciConnected: rState.tciConnected || rState.connected,
    manualDlOffset: rState.manualDlOffset || 0,
    ulFineOffset: rState.ulFineOffset || 0,
    dlFineOffset: rState.dlFineOffset || 0,
    ctcssMode: rState.ctcssMode || "off",
    ctcssAccessHz: tick ? tick.ctcssAccessHz : null,
    ctcssActivationHz: tick ? tick.ctcssActivationHz : null,
    antennaOn: r.antennaOn,
    rotorAz: r.az,
    rotorEl: r.el,
    rotorAzConnected: r.azConnected,
    rotorElConnected: r.elConnected,
    flipped: !!r.flipped,
    favorites: computeFavoritesLooks(),
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
  setUlFixed,
  setFavorites,
  computeTick,
  computeState,
  satsPayload,
  persistCurrentOffsets,
  clearPersistedOffsets,
  applySavedOffsetsForSat,
};
