/**
 * Rotor driver registry.
 *
 * To add a rotor:
 *   1. Create lib/rotors/<name>.js (see INTERFACE.md)
 *   2. register(require("./name")) below
 *   3. Implement meta.match(config) — first match wins
 *   4. Set meta.ports = 1 (single USB) or 2 (AZ+EL)
 *
 * state.js / server.js only use rotors.active() — no per-rotor if/else.
 * UI dropdown is built from catalog() so new drivers appear automatically.
 */

const config = require("../config");

const drivers = [];

let broadcastFn = () => {};

const nullDriver = {
  meta: {
    id: "none",
    label: "No rotor",
    ports: 0,
    defaultBaud: 9600,
    match: () => false,
  },
  init() {},
  setAntenna() {},
  updateTracking() {},
  getRotorState() {
    return {
      antennaOn: false,
      azConnected: false,
      elConnected: false,
      az: null,
      el: null,
      lastCmdAz: null,
      lastCmdEl: null,
      azState: "IDLE",
      elState: "IDLE",
      minEl: 10,
    };
  },
  statusPayload() {
    return { type: "rotor", ...this.getRotorState() };
  },
  broadcastStatus() {},
  applyEndpointChange() {},
};

function register(driver) {
  if (!driver || !driver.meta || !driver.meta.id) {
    throw new Error("rotor driver must export meta.id");
  }
  if (drivers.some((d) => d.meta.id === driver.meta.id)) {
    console.warn("Rotor driver already registered:", driver.meta.id);
    return;
  }
  // Defaults for older drivers
  if (driver.meta.ports == null) driver.meta.ports = 1;
  if (driver.meta.defaultBaud == null) driver.meta.defaultBaud = 9600;
  drivers.push(driver);
  console.log(
    "Rotor registered:",
    driver.meta.id,
    "—",
    driver.meta.label || "",
    "(ports=" + driver.meta.ports + ")",
  );
}

function resolve() {
  for (const d of drivers) {
    try {
      if (typeof d.meta.match === "function" && d.meta.match(config)) return d;
    } catch (e) {
      console.warn("Rotor match error", d.meta.id, e.message);
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

/** UI-friendly list derived from registered drivers. */
function catalog() {
  return drivers.map((d) => ({
    id: d.meta.id,
    label: d.meta.label || d.meta.id,
    ports: d.meta.ports != null ? d.meta.ports : 1,
    defaultBaud: d.meta.defaultBaud != null ? d.meta.defaultBaud : 9600,
    defaultDevice: d.meta.defaultDevice || "/dev/ttyACM0",
    hint: d.meta.hint || "",
  }));
}

function get(id) {
  return drivers.find((d) => d.meta.id === id) || null;
}

function init(opts) {
  if (opts && opts.broadcast) broadcastFn = opts.broadcast;
  for (const d of drivers) {
    if (typeof d.init === "function") {
      d.init({ broadcast: broadcastFn });
    }
  }
  console.log(
    "Rotor active path:",
    active().meta.id,
    "(",
    active().meta.label || "",
    ")",
  );
}

function setAntenna(on) {
  active().setAntenna(!!on);
}

function updateTracking(look, aosAz) {
  active().updateTracking(look, aosAz);
}

function getRotorState() {
  return active().getRotorState();
}

function statusPayload() {
  return active().statusPayload();
}

function broadcastStatus() {
  active().broadcastStatus();
}

function applyEndpointChange() {
  for (const d of drivers) {
    if (typeof d.applyEndpointChange === "function") d.applyEndpointChange();
  }
}

// ── Built-in drivers (order = match priority) ─────────────────
register(require("./gs232"));
register(require("./rt21"));

module.exports = {
  register,
  resolve,
  active,
  all,
  catalog,
  get,
  init,
  setAntenna,
  updateTracking,
  getRotorState,
  statusPayload,
  broadcastStatus,
  applyEndpointChange,
  nullDriver,
};
