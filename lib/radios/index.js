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
  console.log("Radio registered:", driver.meta.id, "—", driver.meta.label || "");
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

  return {
    RADIO_TRANSPORT: transport,
    RADIO_TYPE: type,
    RADIO_PROTOCOL: protocol,
    useFlexCat: () => isFlexCat,
    useTci: () => isTci,
    useRigctl: () => isRigctl,
    useSerialCat: () => isSerial,
    useIcomSerial: () => {
      if (!isSerial) return false;
      const make = String(side.serialMake || "icom").toLowerCase();
      return !make || make === "icom";
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
    connecting:
      !!(ulSt && ulSt.connecting) || !!(dlSt && dlSt.connecting),
    manualDlOffset: (dlSt && dlSt.manualDlOffset) || 0,
    ulFineOffset: (ulSt && ulSt.ulFineOffset) || 0,
    dlFineOffset: (dlSt && dlSt.dlFineOffset) || 0,
    ctcssMode: (ulSt && ulSt.ctcssMode) || "off",
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
    label: "UL " + (ulD.meta.label || ulD.meta.id) + " / DL " + (dlD.meta.label || dlD.meta.id),
  };

  return {
    meta,
    setRadio(on) {
      ulD.setRadio(!!on);
      dlD.setRadio(!!on);
    },
    setLock(on) {
      // Lock is primarily a Doppler / VFO-follow concept → both sides
      if (typeof ulD.setLock === "function") ulD.setLock(!!on);
      if (typeof dlD.setLock === "function") dlD.setLock(!!on);
    },
    applyDefaultLock(isFm) {
      if (typeof ulD.applyDefaultLock === "function") ulD.applyDefaultLock(isFm);
      else if (typeof ulD.setLock === "function") ulD.setLock(!!isFm);
      if (typeof dlD.applyDefaultLock === "function") dlD.applyDefaultLock(isFm);
      else if (typeof dlD.setLock === "function") dlD.setLock(!!isFm);
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
      // UL driver only gets uplink; DL driver only gets downlink
      const a =
        typeof ulD.pushFrequencies === "function"
          ? ulD.pushFrequencies(ulHz, null)
          : null;
      const b =
        typeof dlD.pushFrequencies === "function"
          ? dlD.pushFrequencies(null, dlHz)
          : null;
      const promises = [a, b].filter(
        (p) => p && typeof p.then === "function",
      );
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
  return resolve();
}

function all() {
  return drivers.slice();
}

function get(id) {
  return drivers.find((d) => d.meta.id === id) || null;
}

function init(opts) {
  if (opts && opts.getContext) getCtx = opts.getContext;
  if (opts && opts.broadcast) broadcastFn = opts.broadcast;
  for (const d of drivers) {
    if (typeof d.init === "function") {
      d.init({ getContext: getCtx, broadcast: broadcastFn });
    }
  }
  const a = active();
  console.log(
    "Radio active path:",
    a.meta.id,
    "(",
    a.meta.label || "",
    ")",
  );
  if (isDualPath()) {
    console.log(
      "  dual-path: UL=",
      activeUl().meta.id,
      "DL=",
      activeDl().meta.id,
    );
  }
}

function setRadio(on) {
  const want = !!on;
  const targets = new Set(uniqueActiveDrivers());
  // Turn off anything that should not be running
  for (const d of drivers) {
    const st = d.getRadioState && d.getRadioState();
    if (st && st.radioOn && !targets.has(d)) d.setRadio(false);
  }
  if (want) {
    for (const d of targets) d.setRadio(true);
  } else {
    for (const d of targets) d.setRadio(false);
  }
}

function setLock(on) {
  active().setLock(!!on);
}

function applyEndpointChange(flags) {
  flags = flags || {};
  // Notify every registered driver so stale connections close
  for (const d of drivers) {
    if (typeof d.applyEndpointChange === "function") d.applyEndpointChange(flags);
  }
  if (flags.radioSelChanged) {
    const anyOn = drivers.some((d) => {
      const st = d.getRadioState && d.getRadioState();
      return st && st.radioOn;
    });
    if (anyOn) {
      for (const d of drivers) d.setRadio(false);
      setRadio(true);
    }
  }
  const a = active();
  console.log("Radio path:", a.meta.id, a.meta.label || "");
  if (isDualPath()) {
    console.log(
      "  dual-path: UL=",
      activeUl().meta.id,
      "DL=",
      activeDl().meta.id,
    );
  }
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

const icom = require("./icom");
if (!icom.meta) {
  icom.meta = {
    id: "icom",
    label: "Icom CI-V (IC-705)",
    match(cfg) {
      if (typeof cfg.useIcomSerial === "function") return cfg.useIcomSerial();
      return cfg.RADIO_TRANSPORT === "serial";
    },
  };
}
register(icom);

register(require("./tci"));

// Generic Hamlib/rigctl over TCP (SDR++, remote rigctld, etc.)
register(require("./rigctl"));

// register(require("./kenwood"));
// register(require("./yaesu"));

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
  setRadio,
  setLock,
  applyEndpointChange,
  broadcastAllStatus,
  resetAllOffsets,
  nullDriver,
};
