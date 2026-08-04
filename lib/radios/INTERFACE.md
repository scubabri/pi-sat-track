# Radio driver interface

Drop a new file in `lib/radios/`, implement the methods below, then
`register(require("./yourradio"))` in `index.js`.

**Do not** edit `state.js` or `server.js` for a new radio — the registry
picks the active driver(s) via `meta.match(config)`.

## Dual-path UL / DL

Config may set independent `radioUl` and `radioDl` sides. The registry:

1. Matches a driver **per side** (`activeUl()` / `activeDl()`).
2. If both sides resolve to the **same** driver → that driver is used once
   (classic behaviour: one connection, both VFOs).
3. If they differ (e.g. UL=TCI, DL=rigctl) → **both** drivers run.
   `pushFrequencies(ulHz, null)` goes to the UL driver and
   `pushFrequencies(null, dlHz)` to the DL driver.
4. `radios.active()` returns a facade that merges state and routes
   setRadio / lock / CTCSS / fine so `state.js` stays dual-unaware.

Drivers should treat a `null` frequency as "do not touch that side".

## Required exports

```js
module.exports = {
  meta: {
    id: "myradio",           // unique string
    label: "My Radio CAT",   // log / debug
    /**
     * Return true when this driver should handle the current config.
     * Checked in registration order — first match wins.
     * `config` may be the live module or a synthetic object built from
     * one side (radioUl / radioDl) with RADIO_TRANSPORT / TYPE / PROTOCOL
     * and useFlexCat / useTci / useRigctl helpers.
     */
    match(config) {
      return config.RADIO_TRANSPORT === "tcp" && /* ... */;
    },
  },

  // Lifecycle
  init({ getContext, broadcast }) {},
  setRadio(on /* boolean */) {},
  applyEndpointChange(/* optional flags */) {},

  // Doppler / VFO
  // ulHz or dlHz may be null when this driver only owns one side.
  pushFrequencies(ulHz, dlHz) {},  // async ok; called every tick when radioOn

  // Operator controls
  setLock(on) {},
  applyDefaultLock(isFm) {},
  setCtcss(which /* 'off'|'access'|'activation' */) {},
  applyDefaultCtcss(accessHz, activationHz) {},
  adjustFine(deltaHz, side /* 'ul'|'dl' */) {},
  setStep(stepHz) {},
  center() {},
  resetOffsets() {},

  // State for UI / Doppler engine
  getRadioState() {
    return {
      radioOn: false,
      locked: false,
      connected: false,      // or tciConnected
      tciConnected: false,   // alias used by legacy UI
      connecting: false,
      manualDlOffset: 0,     // Hz — VFO follow
      ulFineOffset: 0,
      dlFineOffset: 0,
      ctcssMode: "off",
      ctcssAccessHz: null,
      ctcssActivationHz: null,
    };
  },

  broadcastStatus() {},      // push status over WebSocket
};
```

## Selection order

Drivers are matched in registration order in `index.js`:

1. `flex` — TCP + CAT + SmartSDR/AetherSDR
2. `icom` — serial transport
3. `tci` — TCP + TCI + AetherSDR
4. `rigctl` — TCP + RADIO_PROTOCOL=rigctl (SDR++, remote rigctld, any Hamlib net server)

Put more specific matchers first.

## Config helpers

Prefer reading live values from `require("../config")` getters
(`FLEX_UL_HOST`, `CAT_DEVICE`, `RIGCTL_HOST`, `TCI_HOST`, …) rather than
caching at init time. Dual-side endpoints are mapped into those globals by
`lib/config.mapSidesToGlobals()`.

## Optional

- `open()` / `close()` — used by some drivers internally
- Dual-port TCP, serial, WebSocket — all fine; registry is transport-agnostic
