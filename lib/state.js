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
const favPasses = require("./fav-passes");
const { computePassSeries } = require("./pass-series");
const tleMod = require("./tle");

let currentSatKey = null;
/** Key whose TLE is still loading (satrec not yet switched), else null. */
let satLoadingKey = null;
/** Bumped on every loadSatellite(); a slower, older load must not commit. */
let satLoadGen = 0;
let currentModeIndex = 0;
let satrec = null;
let tleNote = "";
let currentNorad = null;
let currentOrbit = null;
let favoriteKeys = [];
let ulFixed = false;
/** FM sat with 2m downlink: hold DL at nominal (no Doppler). */
let dlFixed = false;
/** Radio push throttle (UI tick still runs every TICK_MS). */
let lastRadioPushAt = 0;
let lastRadioPushKey = "";
let forceRadioNext = true;
function forceRadioPush() {
  forceRadioNext = true;
}
/** Last computeTick() result (for QSO logging). */
let lastTick = null;
let lastTickMs = 0;
/** Last time the selected sat was above the horizon (for WSJT-X enrich grace). */
let lastAboveMs = 0;
let lastAboveSat = null;
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
    dlFixed,
  });
  radios.init({ getContext: ctx, broadcast: broadcastFn });
  rotor.init({ broadcast: broadcastFn });
  satOffsets.load();
  favPasses.init({
    getCatalog: () => getCatalog(),
    getObserver: () => observer,
    getMinEl: () =>
      config.ROTOR_MIN_EL != null && Number.isFinite(config.ROTOR_MIN_EL)
        ? config.ROTOR_MIN_EL
        : 0,
    onUpdate: () => {},
  });
}

function favPassKeys() {
  const k = favoriteKeys.slice();
  if (currentSatKey && !k.includes(currentSatKey)) k.unshift(currentSatKey);
  return k;
}

function radio() {
  return radios.active();
}

/** Throttle rule for radio CAT writes (pure; exported for tests). */
function shouldPushRadio({ nowMs, lastAt, intervalMs, force, syncNeeded, keyChanged }) {
  if (force || syncNeeded || keyChanged) return true;
  return nowMs - lastAt >= intervalMs;
}

const is2m = (mhz) => mhz != null && Number.isFinite(mhz) && mhz >= 144 && mhz <= 148;

/**
 * FM default: the 2m side is held at its nominal frequency, only the 70cm
 * side gets Doppler. UL 2m → UL fixed; DL 2m → DL fixed. If both/neither are
 * 2m keep the legacy rule (FM and UL < 200 MHz → UL fixed). Linear: none.
 */
function fixedDefaults(fm, ul, dl) {
  if (!fm) return { ulFixed: false, dlFixed: false };
  const u2 = is2m(ul);
  const d2 = is2m(dl);
  if (u2 && !d2) return { ulFixed: true, dlFixed: false };
  if (d2 && !u2) return { ulFixed: false, dlFixed: true };
  return { ulFixed: !!(ul != null && Number.isFinite(ul) && ul < 200), dlFixed: false };
}

/** Per sat+mode Fix UL choice: ~/.rpitrack/ul-fixed.json { "AO-91|1": true } */
const UL_FIXED_FILE = require("path").join(require("os").homedir(), ".rpitrack", "ul-fixed.json");
let ulFixedSaved = null;
function ulFixedStore() {
  if (ulFixedSaved) return ulFixedSaved;
  try { ulFixedSaved = JSON.parse(require("fs").readFileSync(UL_FIXED_FILE, "utf8")) || {}; }
  catch (_) { ulFixedSaved = {}; }
  return ulFixedSaved;
}
function ulFixedKey() {
  return currentSatKey ? currentSatKey + "|" + currentModeIndex : null;
}

function applyUlFixedDefaultForMode(active) {
  const fm = isFmMode(active && active.mode);
  const ulMHz = centerFreqMHz(active && active.uplink);
  const dlMHz = centerFreqMHz(active && active.downlink);
  const ul = ulMHz != null ? parseFloat(ulMHz) : null;
  const dl = dlMHz != null ? parseFloat(dlMHz) : null;
  const d = fixedDefaults(fm, ul, dl);
  dlFixed = d.dlFixed;
  const k = ulFixedKey();
  const saved = k ? ulFixedStore()[k] : undefined;
  if (typeof saved === "boolean") {
    ulFixed = saved;
    console.log("UL fixed (saved for", k + ")", ulFixed, "DL fixed default", dlFixed);
    return;
  }
  ulFixed = d.ulFixed;
  console.log(
    "UL fixed default", ulFixed, "DL fixed default", dlFixed,
    "(FM", fm, "UL", ul, "MHz DL", dl, "MHz)",
  );
}

function setUlFixed(on) {
  ulFixed = !!on;
  console.log("UL fixed", ulFixed ? "ON (published)" : "OFF (Doppler)");
  const k = ulFixedKey();
  if (!k) return;
  const st = ulFixedStore();
  st[k] = ulFixed;
  try {
    const fs = require("fs");
    fs.mkdirSync(require("path").dirname(UL_FIXED_FILE), { recursive: true });
    fs.writeFileSync(UL_FIXED_FILE, JSON.stringify(st, null, 2));
    console.log("UL fixed saved", k, ulFixed);
  } catch (e) {
    console.warn("UL fixed save failed:", e.message);
  }
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

/** Stable per-mode key for Flex profile memory (mode|uplink|downlink). */
function flexModeKey(info) {
  const m = getActiveMode(info);
  if (!m) return "";
  return [m.mode || "", m.uplink || "", m.downlink || ""].join("|");
}

function lookupFlexProfile(key) {
  if (typeof satOffsets.getFlexProfile !== "function") return "";
  const mk = flexModeKey(getCatalog()[key]);
  let name = satOffsets.getFlexProfile(key, mk) || "";
  if (!name && typeof satOffsets.find === "function") {
    const f = satOffsets.find(key);
    if (f) {
      const byMode = f.flexProfileByMode || {};
      if (mk && typeof byMode[mk] === "string" && byMode[mk].trim())
        name = byMode[mk].trim();
      else if (typeof f.flexProfile === "string") name = f.flexProfile.trim();
    }
  }
  return name;
}

function setModeIndex(index) {
  const info = getCatalog()[currentSatKey];
  const max = info && info.modes ? info.modes.length - 1 : 0;
  currentModeIndex = Math.max(0, Math.min(Math.floor(index), max));
  const active = getActiveMode(info);
  applyCtcssDefaultForMode(info, active);
  applyUlFixedDefaultForMode(active);
  // Remember last mode for this sat
  if (currentSatKey && typeof satOffsets.setModeIndex === "function") {
    satOffsets.setModeIndex(currentSatKey, currentModeIndex);
  }
  // Flex profile per sat+mode (blank = no change); flex.js loads on change.
  const r = radio();
  if (currentSatKey && r && typeof r.setFlexProfile === "function") {
    const name = lookupFlexProfile(currentSatKey);
    if (name) r.setFlexProfile(name);
  }
  return currentModeIndex;
}

/** Restore the per-sat Data (USB-D/LSB-D) flag; default OFF. */
function applySavedDataModeForSat(key) {
  const r = radio();
  if (typeof r.setDataMode !== "function") return;
  let on = false;
  if (typeof satOffsets.getDataMode === "function") {
    on = satOffsets.getDataMode(key);
    if (!on && typeof satOffsets.find === "function") {
      const f = satOffsets.find(key);
      on = !!(f && f.dataMode);
    }
  }
  r.setDataMode(on);
  // CW flag (linear sats); default OFF. Data wins nothing: they're exclusive.
  if (typeof r.setCwMode === "function") {
    let cw = false;
    if (typeof satOffsets.getCwMode === "function") {
      cw = satOffsets.getCwMode(key);
      if (!cw && typeof satOffsets.find === "function") {
        const f = satOffsets.find(key);
        cw = !!(f && f.cwMode);
      }
    }
    if (cw && on) cw = false; // never both
    r.setCwMode(cw);
  }
  // Flex SmartSDR global profile (per-sat); blank = no change
  if (typeof r.setFlexProfile === "function") {
    r.setFlexProfile(lookupFlexProfile(key));
  }
}

function dataModeFields() {
  let st = {};
  try {
    st = radio().getRadioState() || {};
  } catch (_) {}
  return {
    dataModeSupported: !!st.supportsDataMode,
    dataMode: !!st.dataMode,
    cwModeSupported: !!st.supportsCwMode,
    cwMode: !!st.cwMode,
    flexProfilesSupported: !!st.supportsFlexProfiles,
    flexProfiles: Array.isArray(st.flexProfiles) ? st.flexProfiles : [],
    flexProfile: typeof st.flexProfile === "string" ? st.flexProfile : "",
    flexProfileCurrent:
      typeof st.flexProfileCurrent === "string" ? st.flexProfileCurrent : "",
    apiConnected: !!st.apiConnected,
  };
}

function setDataMode(on) {
  const r = radio();
  const st = r.getRadioState() || {};
  if (!st.supportsDataMode || typeof r.setDataMode !== "function") return false;
  r.setDataMode(!!on);
  if (currentSatKey && typeof satOffsets.setDataMode === "function")
    satOffsets.setDataMode(currentSatKey, !!on);
  // Mutually exclusive with CW
  if (on && st.cwMode && typeof r.setCwMode === "function") {
    r.setCwMode(false);
    if (currentSatKey && typeof satOffsets.setCwMode === "function")
      satOffsets.setCwMode(currentSatKey, false);
  }
  return true;
}

function setCwMode(on) {
  const r = radio();
  const st = r.getRadioState() || {};
  if (!st.supportsCwMode || typeof r.setCwMode !== "function") return false;
  if (on && st.dataMode && typeof r.setDataMode === "function") {
    r.setDataMode(false);
    if (currentSatKey && typeof satOffsets.setDataMode === "function")
      satOffsets.setDataMode(currentSatKey, false);
  }
  r.setCwMode(!!on);
  if (currentSatKey && typeof satOffsets.setCwMode === "function")
    satOffsets.setCwMode(currentSatKey, !!on);
  return true;
}

function setFlexProfile(name) {
  const r = radio();
  if (typeof r.setFlexProfile !== "function") return false;
  const next = name == null ? "" : String(name).trim();
  r.setFlexProfile(next);
  if (currentSatKey && typeof satOffsets.setFlexProfile === "function")
    satOffsets.setFlexProfile(
      currentSatKey,
      next,
      flexModeKey(getCatalog()[currentSatKey]) || undefined,
    );
  return true;
}

function applySavedOffsetsForSat(key, quiet) {
  applySavedDataModeForSat(key);
  const saved =
    typeof satOffsets.find === "function"
      ? satOffsets.find(key)
      : satOffsets.get(key);
  if (!saved) {
    if (!quiet) console.log("No saved offsets for", key);
    return;
  }
  const r = radio();
  if (typeof r.setOffsets === "function") {
    r.setOffsets(saved);
    if (!quiet) console.log(
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
  // and the Data flag
  const mode =
    typeof satOffsets.getModeIndex === "function"
      ? satOffsets.getModeIndex(currentSatKey)
      : null;
  const data =
    typeof satOffsets.getDataMode === "function"
      ? satOffsets.getDataMode(currentSatKey)
      : false;
  const cw =
    typeof satOffsets.getCwMode === "function"
      ? satOffsets.getCwMode(currentSatKey)
      : false;
  const flexProf =
    typeof satOffsets.getFlexProfile === "function"
      ? satOffsets.getFlexProfile(currentSatKey)
      : "";
  const flexByMode =
    typeof satOffsets.getFlexProfileByMode === "function"
      ? satOffsets.getFlexProfileByMode(currentSatKey)
      : {};
  satOffsets.clear(currentSatKey);
  if (mode != null && typeof satOffsets.setModeIndex === "function") {
    satOffsets.setModeIndex(currentSatKey, mode);
  }
  if (data && typeof satOffsets.setDataMode === "function") {
    satOffsets.setDataMode(currentSatKey, true);
  }
  if (cw && typeof satOffsets.setCwMode === "function") {
    satOffsets.setCwMode(currentSatKey, true);
  }
  if (flexProf && typeof satOffsets.setFlexProfile === "function") {
    satOffsets.setFlexProfile(currentSatKey, flexProf);
  }
  if (typeof satOffsets.setFlexProfile === "function") {
    for (const mk of Object.keys(flexByMode))
      satOffsets.setFlexProfile(currentSatKey, flexByMode[mk], mk);
  }
}

/**
 * Active profile changed: switch the offsets store and re-apply the current
 * sat's offsets for that profile live (no sat reload needed).
 */
function setOffsetsProfile(name) {
  if (typeof satOffsets.setProfile !== "function") return;
  const changed = satOffsets.setProfile(name);
  if (!changed || !currentSatKey) return;
  radios.resetAllOffsets();
  applySavedOffsetsForSat(currentSatKey);
  const r = radio();
  if (r && typeof r.broadcastStatus === "function") r.broadcastStatus();
}

async function loadSatellite(key) {
  const info = getCatalog()[key];
  if (!info || !info.norad)
    throw new Error("Unknown or non-trackable sat: " + key);
  // Write any debounced offset changes for the previous sat before switching.
  if (typeof satOffsets.flush === "function") satOffsets.flush();
  const gen = ++satLoadGen;
  const prevKey = currentSatKey;
  const prevSatrec = satrec;
  currentSatKey = key;
  // Never keep computing the PREVIOUS sat's position under the new key: use a
  // cached TLE for the new sat if we have one, else stop state/tick output
  // until the fetch lands (was: old satrec + new name → stale marker/label).
  const cachedRec = getSatrecForNorad(String(info.norad));
  satrec = cachedRec || null;
  // Until the new TLE is loaded, satrec is still the PREVIOUS sat: ticks in
  // this window would hand the rotor the old sat's look/next-AOS tagged with
  // the new satKey (→ bogus "engage/switch" preposition mid-pass).
  // A cached TLE for the NEW sat is safe to track immediately; only hold
  // the rotor when we have nothing (or a stale TLE) for it.
  const cachedFresh =
    cachedRec &&
    typeof tleMod.getTleAgeMs === "function" &&
    tleMod.getTleAgeMs(String(info.norad)) < favPasses.TLE_MAX_AGE_MS;
  satLoadingKey = cachedFresh ? null : key;
  favPasses.setKeys(favPassKeys());
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
  applyCtcssDefaultForMode(info, activeEarly);
  applyUlFixedDefaultForMode(activeEarly);
  // Restore saved calibration right away (not only after the TLE fetch): a
  // fine/step message arriving during the fetch would otherwise persist the
  // zeroed offsets under the new key and wipe its saved entry.
  applySavedOffsetsForSat(key, true);

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
  let tle;
  try {
    tle = await fetchTLE(info.norad);
  } catch (e) {
    if (gen === satLoadGen) {
      satLoadingKey = null;
      if (!cachedRec) {
        // Failed with nothing to show: fall back to the previous sat.
        currentSatKey = prevKey;
        satrec = prevSatrec;
      }
    }
    throw e;
  }
  if (gen !== satLoadGen) {
    // A newer selection superseded this one while the TLE was in flight.
    cacheSatrec(info.norad, satellite.twoline2satrec(tle.l1, tle.l2));
    return;
  }
  satrec = satellite.twoline2satrec(tle.l1, tle.l2);
  if (satLoadingKey === key) satLoadingKey = null;
  cacheSatrec(info.norad, satrec);
  favPasses.noteTle(info.norad);
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
  // TLE fetch (missing/stale only, sequential) + next-pass calc for all favorites
  favPasses.setKeys(favPassKeys());
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
    if (snap) {
      snap.nextPass = favPasses.get(key);
      out.push(snap);
    }
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
        nextPass: favPasses.get(key),
      });
    }
  }
  return out;
}

/**
 * Ground tracks for favorites (excluding the selected sat, which has its own
 * bright track). Same span as the selected sat: past TRAIL_MINUTES + 2 orbits
 * ahead; 30 s step like the selected sat (client great-circle densifies). Sats without TLE skipped.
 */
const favTleTried = new Set();
/** Favorites overlay subset (active profile's favOverlay.shown); null = all. */
let favOverlayShown = null;
function setFavOverlayShown(shown) {
  favOverlayShown = Array.isArray(shown) ? shown.filter((k) => typeof k === "string") : null;
}
function favShownKeys() {
  if (!favOverlayShown) return favoriteKeys.slice();
  const want = new Set(favOverlayShown);
  return favoriteKeys.filter((k) => want.has(k));
}
/** 3 decimals (~100 m) is plenty for map lines and roughly halves the JSON. */
function compactPath(pts) {
  return pts.map((p) => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000]);
}
function computeFavoriteTracks() {
  const now = new Date();
  const tracks = [];
  for (const key of favShownKeys()) {
    if (!key || key === currentSatKey) continue;
    const info = getCatalog()[key] || {};
    const norad = info.norad != null ? String(info.norad) : null;
    const rec = norad ? getSatrecForNorad(norad) : null;
    if (!rec) {
      // Favorites restored before the catalog loaded never got a TLE; fetch once in background.
      if (norad && !favTleTried.has(norad)) {
        favTleTried.add(norad);
        ensureSatrecForKey(key).catch(() => {});
      }
      continue;
    }
    try {
      tracks.push({
        key,
        display: info.display || info.name || key,
        trail: compactPath(buildTrail(rec, now, undefined, 30)),
        forward: compactPath(buildForwardTrack(rec, now, 2, 30)),
      });
    } catch (_) {}
  }
  return { type: "fav-tracks", time: now.toISOString(), current: currentSatKey, tracks };
}

/**
 * 24 h elevation series for the selected sat + favorites (elevation chart,
 * Favorites view). Heavy-ish (1440 propagations per sat @ 60 s), so the
 * server caches it behind favProfileSig() and a 10 min roll; never per tick.
 */
function favProfileKeys() {
  const k = favShownKeys();
  if (currentSatKey && !k.includes(currentSatKey)) k.unshift(currentSatKey);
  return k;
}
function favProfileSig() {
  const o = observer || {};
  const tles = favProfileKeys().map((k) => {
    const n = (getCatalog()[k] || {}).norad;
    const r = n != null ? getSatrecForNorad(String(n)) : null;
    return r ? r.epochyr + ":" + r.epochdays : "-";
  });
  return [currentSatKey || "", favProfileKeys().join(","), tles.join(","), o.latitude, o.longitude, o.height].join("|");
}
function computeFavProfile(now, hours, stepSec) {
  now = now || new Date();
  hours = hours || 25.5;
  const t0 = now.getTime() - 140 * 60000; // 2 h lead on the chart + 10 min cache roll
  const sats = [];
  for (const key of favProfileKeys()) {
    const info = getCatalog()[key] || {};
    const norad = info.norad != null ? String(info.norad) : null;
    const rec = norad ? getSatrecForNorad(norad) : null;
    if (!rec) continue;
    try {
      sats.push({
        key,
        display: info.display || info.name || key,
        selected: key === currentSatKey,
        passes: computePassSeries(rec, observer, t0, hours, stepSec || 60),
      });
    } catch (_) {}
  }
  return { type: "fav-profile", start: t0, end: t0 + hours * 3600000, current: currentSatKey, sats };
}

/**
 * 3D globe orbits: one orbital period from now, ~`points` samples of
 * [lat, lon, heightKm], for the selected sat + shown favorites. Cheap
 * (~100 propagations per sat); the server caches it behind favProfileSig().
 */
function computeGlobeOrbits(now, points) {
  now = now || new Date();
  points = points || 100;
  const t0 = now.getTime();
  const sats = [];
  for (const key of favProfileKeys()) {
    const info = getCatalog()[key] || {};
    const norad = info.norad != null ? String(info.norad) : null;
    const rec = norad ? getSatrecForNorad(norad) : null;
    if (!rec || !(rec.no > 0)) continue;
    const periodMs = ((2 * Math.PI) / rec.no) * 60000; // rec.no: rad/min
    const pts = [];
    for (let i = 0; i <= points; i++) {
      let g = null;
      try { g = groundPoint(rec, new Date(t0 + (periodMs * i) / points)); } catch (_) {}
      if (g && Number.isFinite(g.lat) && Number.isFinite(g.lon) && Number.isFinite(g.heightKm))
        pts.push([Math.round(g.lat * 1000) / 1000, Math.round(g.lon * 1000) / 1000, Math.round(g.heightKm)]);
    }
    if (pts.length < 2) continue;
    sats.push({ key, display: info.display || info.name || key, selected: key === currentSatKey, periodMin: Math.round(periodMs / 6000) / 10, pts });
  }
  return { type: "globe-orbits", time: t0, current: currentSatKey, sats };
}

/**
 * Pass preview: positions + look angles at an arbitrary time T for the
 * selected sat and the shown favorites. Map/globe draw these instead of the
 * live positions while a preview is active; radio/rotor/Doppler are untouched.
 */
function computePreview(tMs) {
  const date = new Date(tMs);
  const sats = [];
  for (const key of favProfileKeys()) {
    const info = getCatalog()[key] || {};
    const norad = info.norad != null ? String(info.norad) : null;
    const rec = norad ? getSatrecForNorad(norad) : null;
    if (!rec) continue;
    let g = null, l = null;
    try { g = groundPoint(rec, date); l = lookAngles(rec, observer, date); } catch (_) {}
    if (!g || !Number.isFinite(g.lat)) continue;
    sats.push({ key, display: info.display || info.name || key, selected: key === currentSatKey,
      position: { lat: g.lat, lon: g.lon, heightKm: g.heightKm }, look: l ? { az: l.az, el: l.el } : null });
  }
  return { type: "preview", t: tMs, current: currentSatKey, sats };
}

function favoritesSig() {
  // include which favorites have a TLE so newly fetched ones get drawn promptly
  const have = favoriteKeys.map((k) => {
    const n = (getCatalog()[k] || {}).norad;
    return n != null && getSatrecForNorad(String(n)) ? "1" : "0";
  });
  return (currentSatKey || "") + "|" + favoriteKeys.join(",") + "|" + have.join("") + "|" + (favOverlayShown ? favOverlayShown.join(",") : "*");
}

function computeTick(tickOpts) {
  if (!satrec) return null;
  const now = new Date();
  const look = lookAngles(satrec, observer, now);
  if (!look) return null;
  if (look.el > 0) {
    lastAboveMs = now.getTime();
    lastAboveSat = currentSatKey;
  }

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
      const dlDf = dlFixed ? 1 : df;
      const fRx =
        f0 * dlDf + (rState.manualDlOffset || 0) + (rState.dlFineOffset || 0);
      dlDopplerHz = f0 * dlDf - f0;
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
  } else {
    if (ulFixed && freqs.ulMHz != null) {
      const fTx = freqs.ulMHz * 1e6 + (rState.ulFineOffset || 0);
      ulHz = Math.round(fTx);
      uplink = (fTx / 1e6).toFixed(6);
      ulDopplerHz = 0;
    }
    if (dlFixed && freqs.dlMHz != null) {
      const fRx =
        freqs.dlMHz * 1e6 + (rState.manualDlOffset || 0) + (rState.dlFineOffset || 0);
      dlHz = Math.round(fRx);
      downlink = (fRx / 1e6).toFixed(6);
      dlDopplerHz = 0;
    }
  }

  const pushKey = currentSatKey + "|" + currentModeIndex;
  const nowMs = Date.now();
  if (
    shouldPushRadio({
      nowMs,
      lastAt: lastRadioPushAt,
      intervalMs: config.RADIO_UPDATE_MS || 250,
      force: forceRadioNext || !!(tickOpts && tickOpts.forceRadio),
      syncNeeded: !!rState.syncNeeded,
      keyChanged: pushKey !== lastRadioPushKey,
    })
  ) {
    lastRadioPushAt = nowMs;
    lastRadioPushKey = pushKey;
    forceRadioNext = false;
    try {
      const p = radio().pushFrequencies(ulHz, dlHz);
      if (p && typeof p.catch === "function") {
        p.catch((e) => console.warn("Radio push:", e.message));
      }
    } catch (e) {
      console.warn("Radio push:", e.message);
    }
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
  if (!satLoadingKey) rotor.updateTracking(trackLook, rotorAosAz, rotorLosAz, {
    nextAosMs: rotorNextAosMs,
    nextAosAz: rotorNextAosAz,
    nextLosAz: rotorNextLosAz,
    minEl: rotorMinEl,
    satKey: currentSatKey,
    inPass: inPass,
  });

  const r = rotor.getRotorState();
  if (r.antennaOn) rotor.logSample(look.az, look.el);

  lastTick = {
    type: "tick",
    sat: currentSatKey,
    modeIndex: currentModeIndex,
    mode: freqs.mode,
    modes,
    isFm: !!freqs.isFm,
    ...dataModeFields(),
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
    dlFixed,
    tciConnected: rState.tciConnected || rState.connected,
    manualDlOffset: rState.manualDlOffset || 0,
    ulFineOffset: rState.ulFineOffset || 0,
    dlFineOffset: rState.dlFineOffset || 0,
    ctcssMode: rState.ctcssMode || "off",
    toneVerified: rState.toneVerified != null ? rState.toneVerified : null,
    toneError: rState.toneError || null,
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
  lastTickMs = Date.now();
  return lastTick;
}

/**
 * Snapshot for QSO logging: current sat, active catalog mode, and the
 * Doppler-corrected UL/DL Hz most recently pushed to the radio.
 */
/** Rotor position at log time (only axes that are connected and reporting). */
function rotorPointing() {
  const out = { antAz: null, antEl: null };
  try {
    const r = rotor.getRotorState() || {};
    if (r.azConnected && Number.isFinite(r.az)) out.antAz = r.az;
    if (r.elConnected && Number.isFinite(r.el)) out.antEl = r.el;
  } catch (_) {}
  return out;
}

function getLogContext() {
  if (!currentSatKey) return null;
  let tk = lastTick;
  if (!tk || tk.sat !== currentSatKey || Date.now() - lastTickMs > 5000) {
    tk = computeTick();
  }
  const info = getCatalog()[currentSatKey] || {};
  const active = getActiveMode(info);
  const modeStr = (active && active.mode) || (tk && tk.mode) || "";
  return {
    satKey: currentSatKey,
    satName: info.display || info.name || currentSatKey,
    satFullName: info.name || "",
    norad: info.norad || currentNorad || null,
    mode: modeStr,
    // Catalog transmitter freqs — AMSAT Digi/linear matching uses band when Hz missing
    uplink: (active && active.uplink) || "",
    downlink: (active && active.downlink) || "",
    isFm: isFmMode(modeStr),
    ulHz: tk && Number.isFinite(tk.ulHz) ? tk.ulHz : null,
    dlHz: tk && Number.isFinite(tk.dlHz) ? tk.dlHz : null,
    el: tk && tk.look && Number.isFinite(tk.look.el) ? tk.look.el : null,
    lastAboveMs: lastAboveSat === currentSatKey ? lastAboveMs : 0,
    ...rotorPointing(),
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
  // Honor the configured min elevation so the pass list matches what the
  // rotor will actually track (default 0 kept when unset).
  const listMinEl =
    config.ROTOR_MIN_EL != null && Number.isFinite(config.ROTOR_MIN_EL)
      ? config.ROTOR_MIN_EL
      : undefined;
  const passesRaw = findPasses(satrec, observer, now, listMinEl);
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
    ...dataModeFields(),
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
    dlFixed,
    tciConnected: rState.tciConnected || rState.connected,
    manualDlOffset: rState.manualDlOffset || 0,
    ulFineOffset: rState.ulFineOffset || 0,
    dlFineOffset: rState.dlFineOffset || 0,
    ctcssMode: rState.ctcssMode || "off",
    toneVerified: rState.toneVerified != null ? rState.toneVerified : null,
    toneError: rState.toneError || null,
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
  setDataMode,
  setCwMode,
  setFlexProfile,
  setObserver,
  getObserver,
  getCurrentKey,
  setModeIndex,
  loadSatellite,
  setUlFixed,
  forceRadioPush,
  shouldPushRadio,
  fixedDefaults,
  setFavorites,
  computeTick,
  computeState,
  computeFavoriteTracks,
  favoritesSig,
  computeFavProfile,
  favProfileSig,
  setFavOverlayShown,
  computeGlobeOrbits,
  computePreview,
  getLogContext,
  satsPayload,
  persistCurrentOffsets,
  clearPersistedOffsets,
  setOffsetsProfile,
  applySavedOffsetsForSat,
};
