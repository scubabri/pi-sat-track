# Rotor driver interface

Drop a new file in `lib/rotors/`, implement the methods below, then
`register(require("./yourrotor"))` in `index.js`.

**Do not** edit `state.js` or `server.js` for a new rotor — the registry
picks the active driver via `meta.match(config)`.

## Required exports

```js
module.exports = {
  meta: {
    id: "myrotor",            // unique string
    label: "My Rotor",        // log / debug
    /**
     * Return true when this driver should handle the current config.
     * Checked in registration order — first match wins.
     */
    match(config) {
      return config.ROTOR_TYPE === "myrotor";
    },
  },

  // Lifecycle
  init({ broadcast }) {},
  setAntenna(on /* boolean */) {},
  applyEndpointChange() {},

  // Tracking (called every computeTick)
  updateTracking(look /* {az, el} */, aosAz /* number|null */) {},

  // State for UI
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
};
```

## Selection order

Drivers are matched in registration order in `index.js`.
Put more specific matchers first.

## Config

- `ROTOR_TYPE` — `"rt21"` | `"gs232"` (default `"rt21"`)
  - Aliases for gs232: `k3ng`, `foxdelta`, `gs-232`
- Device / baud settings remain in `lib/config.js` (`ROTOR_AZ_DEVICE`, etc.)

## Current drivers

1. `gs232` — Yaesu GS-232 (K3NG, Fox Delta, etc.)
2. `rt21`  — Green Heron RT-21 direct serial (AI1; / AP1nnn)
