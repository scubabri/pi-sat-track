/**
 * Radio driver registry.
 *
 * To add a radio:
 *   1. Create lib/radios/<name>.js (see INTERFACE.md)
 *   2. register(require("./name")) below
 *   3. Implement meta.match(config) — first match wins
 *   4. For serial: add model to lib/serial-catalog.js
 *
 * state.js / server.js only use radios.active() — no per-radio if/else.
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

function active() {
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
      // Prefer explicit IC-705 selection; fall back to any serial if unset
      if (typeof cfg.useIcomSerial === "function") return cfg.useIcomSerial();
      return cfg.RADIO_TRANSPORT === "serial";
    },
  };
}
register(icom);

register(require("./tci"));

// register(require("./kenwood"));
// register(require("./yaesu"));

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
