/**
 * Rotor driver registry.
 *
 * To add a rotor:
 *   1. Create lib/rotors/<name>.js (see INTERFACE.md)
 *   2. register(require("./name")) below
 *   3. Implement meta.match(config) — first match wins
 *
 * state.js / server.js only use rotors.active() — no per-rotor if/else.
 */

const config = require("../config");

const drivers = [];

let broadcastFn = () => {};

const nullDriver = {
  meta: { id: "none", label: "No rotor", match: () => false },
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
  drivers.push(driver);
  console.log("Rotor registered:", driver.meta.id, "—", driver.meta.label || "");
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

// ── Convenience wrappers (so callers can keep using rotor.setAntenna etc.) ──

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
// More specific first

register(require("./gs232"));
register(require("./rt21"));

module.exports = {
  register,
  resolve,
  active,
  all,
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
