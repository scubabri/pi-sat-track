/**
 * Radio driver registry — dual-path capable.
 *
 * Each side (UL TX / DL RX) is resolved independently. When both sides
 * map to the same driver, behaviour is unchanged (one connection, both
 * VFOs). When they differ (e.g. UL=TCI, DL=rigctl), both drivers run and
 * frequencies are dispatched per side.
 *
 * state.js / server.js continue to call radios.active() — that returns a
 * facade that merges dual state and routes push/set/lock/ctcss.
 *
 * To add a radio:
 *   1. Create lib/radios/<name>.js (see INTERFACE.md)
 *   2. register(require("./name")) below
 *   3. Implement meta.match(config) — first match wins per side
 *   4. For serial: add model to lib/serial-catalog.js
 */

const config = require("../config");

const drivers = [];

let getCtx = () => ({});
let broadcastFn = () => {};
/**
 * Uplink dial moved by the operator on a radio that only has the uplink
 * (two radios: the UL one; or TX split off). Drivers call onUlDial(deltaHz);
 * state.js turns it into a passband move (manual offset) so the downlink
 * radio follows, instead of the next Doppler write pulling the knob back.
 */
let ulDialFn = null;
function setUlDialHandler(fn) {
  ulDialFn = typeof fn === "function" ? fn : null;
}
function onUlDial(deltaHz, source) {
  if (!ulDialFn) return false;
  try {
    return ulDialFn(deltaHz, source) !== false;
  } catch (e) {
    console.warn("UL dial handler:", e.message);
    return false;
  }
}

const nullDriver = {
  meta: { id: "none", label: "No radio", match: () => false },
  init() {},
  setRadio() {},
  setLock() {},
  applyDefaultLock() {},
  setCtcss() {},
  applyDefaultCtcss() {},
  pushFrequencies() {},
  adjustFine() {},
  setStep() {},
  center() {},
  resetOffsets() {},
  setOffsets() {},
  getRadioState() {
    return {
      radioOn: false,
      locked: false,
      connected: false,
      tciConnected: false,
      connecting: false,
      manualDlOffset: 0,
      ulFineOffset: 0,
      dlFineOffset: 0,
      ctcssMode: "off",
      ctcssAccessHz: null,
      ctcssActivationHz: null,
    };
  },
  broadcastStatus() {},
  applyEndpointChange() {},
};

function register(driver) {
  if (!driver || !driver.meta || !driver.meta.id) {
    throw new Error("radio driver must export meta.id");
  }
  if (drivers.some((d) => d.meta.id === driver.meta.id)) {
    console.warn("Radio driver already registered:", driver.meta.id);
    return;
  }
  drivers.push(driver);
  console.log(
    "Radio registered:",
    driver.meta.id,
    "—",
    driver.meta.label || "",
  );
}

/** Normalize side type the same way lib/config does. */
function normalizeType(t) {
  if (!t) return "smartsdr";
  t = String(t).toLowerCase();
  if (t === "flex") return "smartsdr";
  return t;
}

/**
 * Build a synthetic config object from one side (radioUl / radioDl)
 * so existing meta.match(cfg) keeps working without changing every driver.
 */
function cfgFromSide(side) {
  if (!side || typeof side !== "object") return null;
  const transport = String(side.transport || "tcp").toLowerCase();
  const type = normalizeType(side.type || "smartsdr");
  let protocol = String(side.protocol || "cat").toLowerCase();
  if (type === "rigctl") protocol = "rigctl";
  if (type === "smartsdr" && protocol === "tci") protocol = "cat";

  const isFlexCat =
    transport === "tcp" &&
    protocol === "cat" &&
    (type === "smartsdr" || type === "aethersdr");
  const isTci =
    transport === "tcp" && protocol === "tci" && type === "aethersdr";
  const isRigctl =
    transport === "tcp" && (protocol === "rigctl" || type === "rigctl");
  const isSerial = transport === "serial";
  const isSdrconnect =
    transport === "tcp" && (type === "sdrconnect" || type === "sdrplay");

  return {
    RADIO_TRANSPORT: transport,
    RADIO_TYPE: type,
    RADIO_PROTOCOL: protocol,
    useFlexCat: () => isFlexCat,
    useTci: () => isTci,
    useRigctl: () => isRigctl,
    useSerialCat: () => isSerial,
    useSdrconnect: () => isSdrconnect,
    useIc705Serial: () => {
      if (!isSerial) return false;
      const make = String(side.serialMake || "icom").toLowerCase();
      if (make && make !== "icom") return false;
      const model = String(side.serialModel || "").toLowerCase();
      if (model === "ic-9700" || model === "ic9700" || model === "9700")
        return false;
      return true;
    },
    useIc9700Serial: () => {
      if (!isSerial) return false;
      const make = String(side.serialMake || "icom").toLowerCase();
      if (make && make !== "icom") return false;
      const model = String(side.serialModel || "").toLowerCase();
      return model === "ic-9700" || model === "ic9700" || model === "9700";
    },
    useFt991Serial: () => {
      if (!isSerial) return false;
      const make = String(side.serialMake || "").toLowerCase();
      if (make !== "yaesu") return false;
      const model = String(side.serialModel || "").toLowerCase();
      // Binary Yaesu (817/847) — not ASCII FT-991 driver
      if (
        model === "ft-817" ||
        model === "ft817" ||
        model === "ft-818" ||
        model === "ft818" ||
        model === "ft-817nd" ||
        model === "ft-847" ||
        model === "ft847"
      )
        return false;
      return true;
    },
    useFt817Serial: () => {
      if (!isSerial) return false;
      const make = String(side.serialMake || "").toLowerCase();
      const model = String(side.serialModel || "").toLowerCase();
      if (make && make !== "yaesu") return false;
      return (
        model === "ft-817" ||
        model === "ft817" ||
        model === "ft-818" ||
        model === "ft818" ||
        model === "ft-817nd"
      );
    },
    useFt847Serial: () => {
      if (!isSerial) return false;
      const make = String(side.serialMake || "").toLowerCase();
      const model = String(side.serialModel || "").toLowerCase();
      if (make && make !== "yaesu") return false;
      return model === "ft-847" || model === "ft847" || model === "847";
    },
    useTs2000Serial: () => {
      if (!isSerial) return false;
      const make = String(side.serialMake || "").toLowerCase();
      return make === "kenwood";
    },
  };
}

/** Match a driver against a side config object. */
function matchSide(side) {
  const cfg = cfgFromSide(side);
  if (!cfg) return nullDriver;
  for (const d of drivers) {
    try {
      if (typeof d.meta.match === "function" && d.meta.match(cfg)) return d;
    } catch (e) {
      console.warn("Radio match error", d.meta.id, e.message);
    }
  }
  return nullDriver;
}

/** Legacy single-path resolve (globals only). */
function resolve() {
  for (const d of drivers) {
    try {
      if (typeof d.meta.match === "function" && d.meta.match(config)) return d;
    } catch (e) {
      console.warn("Radio match error", d.meta.id, e.message);
    }
  }
  return nullDriver;
}

function sideConfig(which) {
  try {
    if (which === "ul" && config.RADIO_UL) return config.RADIO_UL;
    if (which === "dl" && config.RADIO_DL) return config.RADIO_DL;
  } catch (_) {}
  return null;
}

function activeUl() {
  const s = sideConfig("ul");
  if (s) return matchSide(s);
  return resolve();
}

function activeDl() {
  const s = sideConfig("dl");
  if (s) return matchSide(s);
  return resolve();
}

function uniqueActiveDrivers() {
  const set = new Set();
  const ul = activeUl();
  const dl = activeDl();
  if (ul && ul !== nullDriver) set.add(ul);
  if (dl && dl !== nullDriver) set.add(dl);
  if (set.size === 0) set.add(resolve());
  return Array.from(set);
}

function isDualPath() {
  const ul = activeUl();
  const dl = activeDl();
  return ul !== dl && ul !== nullDriver && dl !== nullDriver;
}

function mergeRadioState(ulSt, dlSt) {
  const ulOn = !!(ulSt && ulSt.radioOn);
  const dlOn = !!(dlSt && dlSt.radioOn);
  const ulConn = !!(ulSt && (ulSt.connected || ulSt.tciConnected));
  const dlConn = !!(dlSt && (dlSt.connected || dlSt.tciConnected));
  return {
    radioOn: ulOn || dlOn,
    locked: !!(dlSt && dlSt.locked) || !!(ulSt && ulSt.locked),
    connected: ulConn && dlConn,
    tciConnected: ulConn && dlConn,
    connecting: !!(ulSt && ulSt.connecting) || !!(dlSt && dlSt.connecting),
    manualDlOffset: (dlSt && dlSt.manualDlOffset) || 0,
    ulFineOffset: (ulSt && ulSt.ulFineOffset) || 0,
    dlFineOffset: (dlSt && dlSt.dlFineOffset) || 0,
    ctcssMode: (ulSt && ulSt.ctcssMode) || "off",
    supportsDataMode:
      !!(ulSt && ulSt.supportsDataMode) || !!(dlSt && dlSt.supportsDataMode),
    dataMode: !!(ulSt && ulSt.dataMode) || !!(dlSt && dlSt.dataMode),
    supportsCwMode:
      !!(ulSt && ulSt.supportsCwMode) || !!(dlSt && dlSt.supportsCwMode),
    cwMode: !!(ulSt && ulSt.cwMode) || !!(dlSt && dlSt.cwMode),
    supportsFlexProfiles:
      !!(ulSt && ulSt.supportsFlexProfiles) ||
      !!(dlSt && dlSt.supportsFlexProfiles),
    flexProfiles:
      (ulSt && ulSt.supportsFlexProfiles && ulSt.flexProfiles) ||
      (dlSt && dlSt.supportsFlexProfiles && dlSt.flexProfiles) ||
      [],
    flexProfile:
      (ulSt && ulSt.supportsFlexProfiles && ulSt.flexProfile) ||
      (dlSt && dlSt.supportsFlexProfiles && dlSt.flexProfile) ||
      "",
    flexProfileCurrent:
      (ulSt && ulSt.supportsFlexProfiles && ulSt.flexProfileCurrent) ||
      (dlSt && dlSt.supportsFlexProfiles && dlSt.flexProfileCurrent) ||
      "",
    apiConnected:
      !!(ulSt && ulSt.apiConnected) || !!(dlSt && dlSt.apiConnected),
    ctcssAccessHz: ulSt ? ulSt.ctcssAccessHz : null,
    ctcssActivationHz: ulSt ? ulSt.ctcssActivationHz : null,
    dual: true,
    ulDriver: activeUl().meta.id,
    dlDriver: activeDl().meta.id,
    ulConnected: ulConn,
    dlConnected: dlConn,
  };
}

/**
 * Facade returned by active() so state.js / server.js need no dual-awareness.
 * Same-driver → real driver. Mixed → routes per side and merges state.
 */
function makeFacade() {
  const ulD = activeUl();
  const dlD = activeDl();
  const same = ulD === dlD;

  if (same) {
    // Single path — return the real driver (legacy behaviour)
    return ulD !== nullDriver ? ulD : resolve();
  }

  const meta = {
    id: ulD.meta.id + "+" + dlD.meta.id,
    label:
      "UL " +
      (ulD.meta.label || ulD.meta.id) +
      " / DL " +
      (dlD.meta.label || dlD.meta.id),
  };

  return {
    meta,
    setRadio(on, source) {
      ulD.setRadio(!!on, source);
      dlD.setRadio(!!on, source);
    },
    setLock(on) {
      // Lock is primarily a Doppler / VFO-follow concept → both sides
      if (typeof ulD.setLock === "function") ulD.setLock(!!on);
      if (typeof dlD.setLock === "function") dlD.setLock(!!on);
    },
    applyDefaultLock(isFm) {
      if (typeof ulD.applyDefaultLock === "function")
        ulD.applyDefaultLock(isFm);
      else if (typeof ulD.setLock === "function") ulD.setLock(!!isFm);
      if (typeof dlD.applyDefaultLock === "function")
        dlD.applyDefaultLock(isFm);
      else if (typeof dlD.setLock === "function") dlD.setLock(!!isFm);
    },
    setDataMode(on) {
      if (typeof ulD.setDataMode === "function") ulD.setDataMode(!!on);
      if (typeof dlD.setDataMode === "function") dlD.setDataMode(!!on);
    },
    setCwMode(on) {
      if (typeof ulD.setCwMode === "function") ulD.setCwMode(!!on);
      if (typeof dlD.setCwMode === "function") dlD.setCwMode(!!on);
    },
    setFlexProfile(name) {
      // Profile load is on the Flex API — prefer UL (TX) side driver
      if (typeof ulD.setFlexProfile === "function") ulD.setFlexProfile(name);
      else if (typeof dlD.setFlexProfile === "function")
        dlD.setFlexProfile(name);
    },
    setCtcss(which) {
      // CTCSS is a TX/UL concern
      if (typeof ulD.setCtcss === "function") ulD.setCtcss(which);
    },
    applyDefaultCtcss(accessHz, activationHz) {
      if (typeof ulD.applyDefaultCtcss === "function") {
        ulD.applyDefaultCtcss(accessHz, activationHz);
      }
    },
    pushFrequencies(ulHz, dlHz) {
      // TX split: when enabled, UL (TX) driver also gets DL on VFO B / Sub.
      // DL (RX) driver always gets downlink only.
      // Not a Flex on UL: its DL link is a second SmartSDR CAT port (another
      // slice) that a mixed setup never configures. It fell back to a stale
      // FLEX_DL endpoint (after a Radio 1 / Radio 2 swap: the Flex's own CAT
      // port), so every tick wrote the uplink then the downlink to the same
      // slice and the Flex snapped back to the downlink. The DL radio has the
      // downlink; the Flex on UL gets the uplink only.
      const txSplit = config.TX_SPLIT !== false && ulD.meta.id !== "flex";
      const a =
        typeof ulD.pushFrequencies === "function"
          ? ulD.pushFrequencies(ulHz, txSplit ? dlHz : null)
          : null;
      const b =
        typeof dlD.pushFrequencies === "function"
          ? dlD.pushFrequencies(null, dlHz)
          : null;
      const promises = [a, b].filter((p) => p && typeof p.then === "function");
      if (promises.length) return Promise.all(promises);
    },
    adjustFine(delta, side) {
      if (side === "dl") {
        if (typeof dlD.adjustFine === "function") dlD.adjustFine(delta, "dl");
      } else {
        if (typeof ulD.adjustFine === "function") ulD.adjustFine(delta, "ul");
      }
    },
    setStep(step) {
      if (typeof ulD.setStep === "function") ulD.setStep(step);
      if (typeof dlD.setStep === "function") dlD.setStep(step);
    },
    center() {
      if (typeof ulD.center === "function") ulD.center();
      if (typeof dlD.center === "function") dlD.center();
    },
    resetOffsets() {
      if (typeof ulD.resetOffsets === "function") ulD.resetOffsets();
      if (typeof dlD.resetOffsets === "function") dlD.resetOffsets();
    },
    setOffsets(o) {
      if (!o || typeof o !== "object") return;
      // UL driver owns uplink fine; DL driver owns downlink fine + dial absorb
      if (typeof ulD.setOffsets === "function") {
        ulD.setOffsets({
          ulFineOffset: o.ulFineOffset || 0,
          dlFineOffset: 0,
          manualDlOffset: 0,
        });
      }
      if (typeof dlD.setOffsets === "function") {
        dlD.setOffsets({
          ulFineOffset: 0,
          dlFineOffset: o.dlFineOffset || 0,
          manualDlOffset: o.manualDlOffset || 0,
        });
      }
      // Same-driver path is handled by active() returning the real driver
      // (this block only runs for mixed UL/DL drivers).
    },
    getRadioState() {
      const ulSt =
        typeof ulD.getRadioState === "function"
          ? ulD.getRadioState()
          : nullDriver.getRadioState();
      const dlSt =
        typeof dlD.getRadioState === "function"
          ? dlD.getRadioState()
          : nullDriver.getRadioState();
      return mergeRadioState(ulSt, dlSt);
    },
    broadcastStatus() {
      if (typeof ulD.broadcastStatus === "function") ulD.broadcastStatus();
      if (typeof dlD.broadcastStatus === "function") dlD.broadcastStatus();
    },
    applyEndpointChange(flags) {
      if (typeof ulD.applyEndpointChange === "function")
        ulD.applyEndpointChange(flags);
      if (typeof dlD.applyEndpointChange === "function")
        dlD.applyEndpointChange(flags);
    },
  };
}

function active() {
  // Prefer dual-side resolution when RADIO_UL / RADIO_DL are present
  try {
    if (config.RADIO_UL || config.RADIO_DL) return makeFacade();
  } catch (_) {}
  // Single-path: wrap so TX_SPLIT can suppress DL on the one radio
  const d = resolve();
  if (d === nullDriver) return d;
  return {
    meta: d.meta,
    setRadio: (...a) => d.setRadio(...a),
    setLock: (...a) => d.setLock(...a),
    applyDefaultLock: (...a) =>
      typeof d.applyDefaultLock === "function"
        ? d.applyDefaultLock(...a)
        : undefined,
    setCtcss: (...a) =>
      typeof d.setCtcss === "function" ? d.setCtcss(...a) : undefined,
    // Data mode (USB-D/LSB-D): capability-gated, no-op on other radios
    setDataMode: (...a) =>
      typeof d.setDataMode === "function" ? d.setDataMode(...a) : undefined,
    setCwMode: (...a) =>
      typeof d.setCwMode === "function" ? d.setCwMode(...a) : undefined,
    setFlexProfile: (...a) =>
      typeof d.setFlexProfile === "function"
        ? d.setFlexProfile(...a)
        : undefined,
    applyDefaultCtcss: (...a) =>
      typeof d.applyDefaultCtcss === "function"
        ? d.applyDefaultCtcss(...a)
        : undefined,
    pushFrequencies(ulHz, dlHz) {
      const txSplit = config.TX_SPLIT !== false;
      if (typeof d.pushFrequencies === "function") {
        // DL-only sats (no UL): always pass DL even when TX_SPLIT is off.
        // Otherwise gate DL on TX_SPLIT (split / dual-VFO TX radio).
        const dl = ulHz == null || txSplit ? dlHz : null;
        return d.pushFrequencies(ulHz, dl);
      }
    },
    adjustFine: (...a) =>
      typeof d.adjustFine === "function" ? d.adjustFine(...a) : undefined,
    setStep: (...a) =>
      typeof d.setStep === "function" ? d.setStep(...a) : undefined,
    center: (...a) =>
      typeof d.center === "function" ? d.center(...a) : undefined,
    resetOffsets: (...a) =>
      typeof d.resetOffsets === "function" ? d.resetOffsets(...a) : undefined,
    setOffsets: (...a) =>
      typeof d.setOffsets === "function" ? d.setOffsets(...a) : undefined,
    getRadioState: () =>
      typeof d.getRadioState === "function"
        ? d.getRadioState()
        : nullDriver.getRadioState(),
    broadcastStatus: (...a) =>
      typeof d.broadcastStatus === "function"
        ? d.broadcastStatus(...a)
        : undefined,
    applyEndpointChange: (...a) =>
      typeof d.applyEndpointChange === "function"
        ? d.applyEndpointChange(...a)
        : undefined,
  };
}

function all() {
  return drivers.slice();
}

function get(id) {
  return drivers.find((d) => d.meta.id === id) || null;
}

/**
 * Connection gate. Drivers are all registered (UI listing / match), but only
 * the driver(s) selected by the ACTIVE PROFILE may open sockets / serial
 * ports / API links. Until server.js has loaded profiles and applied the
 * active one (start()), nothing is allowed to connect — the global/default
 * config (often Flex) must never be probed at boot.
 */
let started = false;

function isSelected(d) {
  if (!d || d === nullDriver) return false;
  return uniqueActiveDrivers().indexOf(d) >= 0;
}

/** May driver d open connections right now? (passed to drivers as isActive) */
function mayConnect(d) {
  return started && isSelected(d);
}

/** True if the driver holds (or is trying to hold) any connection. */
function isLive(d) {
  let st = null;
  try {
    st = d.getRadioState && d.getRadioState();
  } catch (_) {}
  if (!st) return false;
  return !!(
    st.radioOn ||
    st.connected ||
    st.tciConnected ||
    st.connecting ||
    st.ulConnected ||
    st.dlConnected ||
    st.apiConnected
  );
}

/**
 * Fully stop a driver that is no longer selected: radio off (graceful
 * restore where the driver supports it), then close every link / timer /
 * API socket. No-op for drivers that never connected.
 */
function deactivate(d, reason) {
  if (!d || d === nullDriver || !isLive(d)) return;
  console.log("Radio: stopping unselected driver " + d.meta.id + " (" + reason + ")");
  let st = null;
  try {
    st = d.getRadioState && d.getRadioState();
  } catch (_) {}
  try {
    if (st && st.radioOn) {
      // Graceful off (drivers restore radio state, then close their links;
      // TS-2000 closes asynchronously after SA restore — don't cut it short).
      // Unselected drivers must not keep any API link after this.
      d.setRadio(false, reason);
    } else if (typeof d.close === "function") {
      // Not "on" but still holding a link (e.g. Flex API for the profile
      // list, or a pending reconnect) — close everything.
      d.close();
    } else {
      d.setRadio(false, reason);
    }
  } catch (e) {
    console.warn("Radio deactivate", d.meta.id, e.message);
  }
}

function deactivateUnselected(reason) {
  const targets = new Set(uniqueActiveDrivers());
  for (const d of drivers) if (!targets.has(d)) deactivate(d, reason);
  return targets;
}

function logPath(prefix) {
  const a = active();
  console.log(prefix, a.meta.id, "(", a.meta.label || "", ")");
  if (isDualPath()) {
    console.log(
      "  dual-path: UL=",
      activeUl().meta.id,
      "DL=",
      activeDl().meta.id,
    );
  }
}

function init(opts) {
  if (opts && opts.getContext) getCtx = opts.getContext;
  if (opts && opts.broadcast) broadcastFn = opts.broadcast;
  for (const d of drivers) {
    if (typeof d.init === "function") {
      d.init({
        getContext: getCtx,
        broadcast: broadcastFn,
        isActive: () => mayConnect(d),
        onUlDial,
      });
    }
  }
  console.log(
    "Radio drivers initialized — no connections until the active profile is applied",
  );
}

/**
 * Called by server.js once profiles are loaded and the active profile's
 * radio config is applied. Only now may the selected driver connect.
 */
function start() {
  started = true;
  deactivateUnselected("start");
  logPath("Radio active path:");
  for (const d of uniqueActiveDrivers()) {
    if (typeof d.activate === "function") {
      try {
        d.activate();
      } catch (e) {
        console.warn("Radio activate", d.meta.id, e.message);
      }
    }
  }
}

function isStarted() {
  return started;
}

function setRadio(on, source) {
  const want = !!on;
  source = source || "internal";
  console.log("Radio setRadio(" + want + ") from " + source);
  // An explicit enable is permission to connect (profile is applied by then).
  if (want) started = true;
  const targets = deactivateUnselected(source + "/inactive driver");
  if (want) {
    for (const d of targets) d.setRadio(true, source);
  } else {
    for (const d of targets) d.setRadio(false, source);
  }
}

function setLock(on) {
  active().setLock(!!on);
}

function applyEndpointChange(flags) {
  flags = flags || {};
  const anyOn = drivers.some((d) => {
    const st = d.getRadioState && d.getRadioState();
    return st && st.radioOn;
  });
  // Previously-selected drivers are fully stopped (links, timers, API,
  // reconnect loops). Unselected drivers are NOT notified otherwise —
  // their applyEndpointChange would reopen links / Flex API.
  const targets = deactivateUnselected("radio selection changed");
  for (const d of targets) {
    if (typeof d.applyEndpointChange === "function")
      d.applyEndpointChange(flags);
  }
  if (flags.radioSelChanged && anyOn) {
    for (const d of targets) d.setRadio(false, "radio selection changed");
    setRadio(true, "radio selection changed");
  }
  logPath("Radio path:");
}

function broadcastAllStatus() {
  for (const d of uniqueActiveDrivers()) {
    if (typeof d.broadcastStatus === "function") d.broadcastStatus();
  }
}

function resetAllOffsets() {
  for (const d of uniqueActiveDrivers()) {
    if (typeof d.resetOffsets === "function") d.resetOffsets();
  }
}

// ── Built-in drivers (order = match priority) ─────────────────
const flex = require("./flex");
if (!flex.meta) {
  flex.meta = {
    id: "flex",
    label: "Flex / SmartSDR CAT (TCP)",
    match(cfg) {
      return typeof cfg.useFlexCat === "function"
        ? cfg.useFlexCat()
        : cfg.RADIO_TRANSPORT === "tcp" && cfg.RADIO_PROTOCOL === "cat";
    },
  };
}
register(flex);

register(require("./ic705"));
register(require("./ic9700"));

// Binary Yaesu before ASCII FT-991 so model match wins
register(require("./ft817"));
register(require("./ft847"));
register(require("./ft991"));
register(require("./ts2000"));

register(require("./tci"));

// SDRplay SDRconnect WebSocket (GUI or Headless)
register(require("./sdrconnect"));

// Generic Hamlib/rigctl over TCP (SDR++, remote rigctld, etc.)
register(require("./rigctl"));

module.exports = {
  register,
  resolve,
  active,
  activeUl,
  activeDl,
  isDualPath,
  all,
  get,
  init,
  start,
  isStarted,
  isSelected,
  setRadio,
  setLock,
  applyEndpointChange,
  broadcastAllStatus,
  resetAllOffsets,
  setUlDialHandler,
  nullDriver,
};
