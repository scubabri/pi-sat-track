/**
 * Radio driver registry.
 *
 * To add a radio:
 *   1. Create lib/radios/<name>.js implementing the driver interface
 *      (see INTERFACE.md in this folder).
 *   2. require() it once below (or auto-load) and call register(driver).
 *   3. Implement meta.match(config) so the registry can pick it.
 *
 * state.js / server.js only talk to radios.active() — no per-radio if/else.
 */

const config = require("../config");

/** @type {import('./INTERFACE').RadioDriver[]} */
const drivers = [];

let getCtx = () => ({});
let broadcastFn = () => {};
let inited = false;

/** Null driver — safe no-ops when nothing matches. */
const nullDriver = {
  meta: {
    id: "none",
    label: "No radio",
    match: () => false,
  },
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
  const id = driver.meta.id;
  if (drivers.some((d) => d.meta.id === id)) {
    console.warn("Radio driver already registered:", id);
    return;
  }
  drivers.push(driver);
  console.log("Radio registered:", id, "—", driver.meta.label || id);
}

/** First driver whose meta.match(config) returns true. */
function resolve() {
  for (const d of drivers) {
    try {
      if (typeof d.meta.match === "function" && d.meta.match(config)) {
        return d;
      }
    } catch (e) {
      console.warn("Radio match error", d.meta && d.meta.id, e.message);
    }
  }
  return nullDriver;
}

function active() {
  return resolve();
}

function all() {
  return drivers.slice();
}

function get(id) {
  return drivers.find((d) => d.meta.id === id) || null;
}

/**
 * Init every registered driver once with shared context/broadcast.
 * Call from state.init().
 */
function init(opts) {
  if (opts && opts.getContext) getCtx = opts.getContext;
  if (opts && opts.broadcast) broadcastFn = opts.broadcast;
  for (const d of drivers) {
    if (typeof d.init === "function") {
      d.init({ getContext: getCtx, broadcast: broadcastFn });
    }
  }
  inited = true;
  console.log(
    "Radio active path:",
    active().meta.id,
    "(",
    active().meta.label || "",
    ")",
  );
}

function setRadio(on) {
  const want = !!on;
  // Turn all off first so only one path is live
  for (const d of drivers) {
    const st = d.getRadioState && d.getRadioState();
    if (st && st.radioOn) d.setRadio(false);
  }
  if (want) active().setRadio(true);
}

function setLock(on) {
  active().setLock(!!on);
}

function applyEndpointChange(flags) {
  flags = flags || {};
  // Notify every driver; each decides if its endpoints changed
  for (const d of drivers) {
    if (typeof d.applyEndpointChange === "function") {
      d.applyEndpointChange(flags);
    }
  }
  // If selection changed, bounce radio if it was on
  if (flags.radioSelChanged) {
    const anyOn = drivers.some((d) => {
      const st = d.getRadioState && d.getRadioState();
      return st && st.radioOn;
    });
    if (anyOn) {
      for (const d of drivers) d.setRadio(false);
      active().setRadio(true);
    }
  }
}

function broadcastAllStatus() {
  for (const d of drivers) {
    if (typeof d.broadcastStatus === "function") d.broadcastStatus();
  }
}

function resetAllOffsets() {
  for (const d of drivers) {
    if (typeof d.resetOffsets === "function") d.resetOffsets();
  }
}

// ── Built-in drivers ──────────────────────────────────────────
// Add new radios here with one line: register(require("./foo"));
register(require("./flex"));
register(require("./icom"));
register(require("./tci"));

module.exports = {
  register,
  resolve,
  active,
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
