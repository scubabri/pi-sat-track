/**
 * SDRplay SDRconnect WebSocket driver.
 *
 * Controls SDRconnect GUI (or Headless) over the official WebSocket API
 * (default port 5454). Used primarily as a downlink/RX path for linear
 * and FM satellites; can also drive dual-tuner RSPs (primary=DL,
 * secondary=UL).
 *
 * Protocol reference: SDRconnect WebSocket API 1.0.3
 *   set_property / get_property / property_changed
 *   Binary streams (IQ/audio/spectrum) are ignored — control only.
 *
 * Config:
 *   RADIO_TRANSPORT=tcp
 *   RADIO_TYPE=sdrconnect   (or sdrplay)
 *   SDRCONNECT_HOST / SDRCONNECT_PORT  (default 127.0.0.1:5454)
 *
 * CTCSS: SDRconnect has no documented tone property. State is kept for
 * UI consistency but is a no-op on the wire.
 */

const WebSocket = require("ws");
const net = require("net");
const config = require("../config");
const { isFmMode, getCatalog } = require("../catalog");

const meta = {
  id: "sdrconnect",
  label: "SDRplay SDRconnect (WebSocket)",
  match(cfg) {
    const t = String(cfg.RADIO_TYPE || "").toLowerCase();
    return (
      cfg.RADIO_TRANSPORT === "tcp" &&
      (t === "sdrconnect" || t === "sdrplay")
    );
  },
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 5454;
const FREQ_THRESH_HZ = 1;
const RECONNECT_MS = 3000;
const PROBE_MS = 1500;

let ws = null;
let connected = false;
let connecting = false;
let radioOn = false;
let locked = false;
let manualDlOffset = 0;
let ulFineOffset = 0;
let dlFineOffset = 0;
let digitStep = 100;
let reconnectTimer = null;
let ctcssMode = "off";
let ctcssAccessHz = null;
let ctcssActivationHz = null;

let lastCmdDl = 0;
let lastCmdUl = 0;
let lastModDl = "";
let lastModUl = "";

let getCtx = () => ({
  satrec: null,
  observer: null,
  currentSatKey: null,
  currentModeIndex: 0,
});
let broadcastFn = () => {};

function init(opts) {
  if (opts && opts.getContext) getCtx = opts.getContext;
  if (opts && opts.broadcast) broadcastFn = opts.broadcast;
}

function host() {
  const h = (config.SDRCONNECT_HOST || "").trim();
  return h || DEFAULT_HOST;
}

function port() {
  const p = parseInt(config.SDRCONNECT_PORT || DEFAULT_PORT, 10);
  return Number.isFinite(p) && p > 0 && p < 65536 ? p : DEFAULT_PORT;
}

function uri() {
  return "ws://" + host() + ":" + port();
}

function statusPayload() {
  return {
    type: "sdrconnect",
    radioOn,
    locked,
    connected,
    tciConnected: connected,
    connecting,
    host: host(),
    port: port(),
    uri: uri(),
    manualDlOffset,
    ulFineOffset,
    dlFineOffset,
    step: digitStep,
    lastCmdDl,
    lastCmdUl,
    lastModDl,
    lastModUl,
    ctcssMode,
    ctcssAccessHz,
    ctcssActivationHz,
  };
}

function broadcastStatus() {
  broadcastFn(statusPayload());
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  clearReconnect();
  if (!radioOn) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (radioOn && !connected && !connecting) connect();
  }, RECONNECT_MS);
}

function probePort(h, p, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok, err) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch (_) {}
      resolve({ ok, err: err || null });
    };
    socket.setTimeout(timeoutMs || PROBE_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", (e) => finish(false, e.message));
    socket.connect(p, h);
  });
}

/** Send one JSON control message. */
function sendJson(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch (e) {
    console.warn("SDRconnect send failed:", e.message);
    return false;
  }
}

function setProperty(property, value, device) {
  const msg = {
    event_type: "set_property",
    property: String(property),
    value: String(value),
  };
  if (device) msg.device = String(device);
  return sendJson(msg);
}

function disconnect() {
  clearReconnect();
  connecting = false;
  if (ws) {
    try {
      ws.removeAllListeners();
      ws.close();
    } catch (_) {}
    ws = null;
  }
  connected = false;
  radioOn = false;
  lastModDl = "";
  lastModUl = "";
  broadcastStatus();
  console.log("SDRconnect disconnected");
}

async function connect() {
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }
  if (connecting) return;

  connecting = true;
  radioOn = true;
  broadcastStatus();

  const h = host();
  const p = port();
  const u = uri();

  console.log("SDRconnect: probing", h + ":" + p + " ...");
  const probe = await probePort(h, p, PROBE_MS);
  if (!probe.ok) {
    console.warn(
      "SDRconnect: nothing accepting TCP on",
      h + ":" + p,
      "(" + probe.err + ")",
    );
    connecting = false;
    connected = false;
    scheduleReconnect();
    broadcastStatus();
    return;
  }

  try {
    ws = new WebSocket(u, { handshakeTimeout: 5000 });
  } catch (e) {
    console.warn("SDRconnect WebSocket create failed:", e.message);
    connecting = false;
    connected = false;
    scheduleReconnect();
    broadcastStatus();
    return;
  }

  ws.on("open", () => {
    connecting = false;
    connected = true;
    radioOn = true;
    lastCmdDl = 0;
    lastCmdUl = 0;
    lastModDl = "";
    lastModUl = "";
    clearReconnect();
    console.log("SDRconnect connected to", u);
    broadcastStatus();

    // Optional: request API version
    sendJson({
      event_type: "get_property",
      property: "api_version",
      value: "",
    });
  });

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return; // ignore IQ/audio/spectrum
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }
    if (!msg || !msg.event_type) return;

    if (msg.event_type === "property_changed") {
      // Could track device_vfo_frequency for dial-absorb later if needed
      return;
    }
    if (msg.event_type === "get_property_response") {
      if (msg.property === "api_version") {
        console.log("SDRconnect API version:", msg.value);
      }
    }
  });

  ws.on("close", () => {
    connecting = false;
    connected = false;
    ws = null;
    lastModDl = "";
    lastModUl = "";
    broadcastStatus();
    if (radioOn) scheduleReconnect();
  });

  ws.on("error", (err) => {
    console.warn("SDRconnect error:", err.message);
    connecting = false;
    connected = false;
    broadcastStatus();
  });
}

function getActiveModeObj(info, modeIndex) {
  if (!info) return null;
  const modes = info.modes || [];
  if (!modes.length) {
    return {
      mode: info.mode || "",
      uplink: info.uplink || "",
      downlink: info.downlink || "",
      beacon: info.beacon || "",
    };
  }
  const idx = Math.max(0, Math.min(modeIndex || 0, modes.length - 1));
  return modes[idx];
}

/** Map catalog mode → SDRconnect demodulator enum. */
function modesForActive(active) {
  const modeStr = (active && active.mode) || "";
  if (isFmMode(modeStr)) return { ul: "NFM", dl: "NFM" };
  const m = modeStr.toUpperCase();
  if (/\bFM\b|NFM|GFSK|CTCSS|C4FM|DSTAR|DMR/.test(m)) {
    return { ul: "NFM", dl: "NFM" };
  }
  if (/\bWFM\b|WFM/.test(m)) return { ul: "WFM", dl: "WFM" };
  if (/\bCW\b/.test(m) && !/\bSSB\b/.test(m)) return { ul: "CW", dl: "CW" };
  if (/\bAM\b/.test(m)) return { ul: "AM", dl: "AM" };
  // Linear SSB invert: UL LSB, DL USB
  return { ul: "LSB", dl: "USB" };
}

function pushModulation(active, force) {
  if (!connected) return false;
  const mods = modesForActive(active);
  let ok = true;

  // Primary = DL
  if (force || mods.dl !== lastModDl) {
    if (setProperty("demodulator", mods.dl, "primary")) {
      lastModDl = mods.dl;
      console.log("SDRconnect mod primary (DL) →", mods.dl, force ? "(force)" : "");
    } else {
      ok = false;
    }
  }

  // Secondary = UL (best-effort; dual-tuner RSP only)
  if (force || mods.ul !== lastModUl) {
    if (setProperty("demodulator", mods.ul, "secondary")) {
      lastModUl = mods.ul;
      console.log("SDRconnect mod secondary (UL) →", mods.ul, force ? "(force)" : "");
    }
    // Do not fail the whole tick if secondary is absent
  }

  return ok;
}

function setRadio(on) {
  if (on) {
    radioOn = true;
    connect();
  } else {
    radioOn = false;
    disconnect();
  }
  broadcastStatus();
}

function setLock(on) {
  locked = !!on;
  broadcastStatus();
}

function applyDefaultLock(isFm) {
  locked = !!isFm;
  lastModDl = "";
  lastModUl = "";
  broadcastStatus();
}

function setCtcss(which) {
  // No tone property in SDRconnect API — keep state for UI only
  if (which === "access" && ctcssAccessHz != null) ctcssMode = "access";
  else if (which === "activation" && ctcssActivationHz != null)
    ctcssMode = "activation";
  else ctcssMode = "off";
  broadcastStatus();
}

function applyDefaultCtcss(accessHz, activationHz) {
  ctcssAccessHz = accessHz != null ? accessHz : null;
  ctcssActivationHz = activationHz != null ? activationHz : null;
  ctcssMode = ctcssAccessHz != null ? "access" : "off";
  broadcastStatus();
}

function pushFrequencies(ulHz, dlHz) {
  if (!radioOn || !connected) return;

  const { currentSatKey, currentModeIndex } = getCtx();
  const info = getCatalog()[currentSatKey] || {};
  const active = getActiveModeObj(info, currentModeIndex);
  pushModulation(active, false);

  // Primary device = downlink
  if (dlHz != null && Number.isFinite(dlHz)) {
    const target = Math.round(dlHz);
    if (Math.abs(target - lastCmdDl) >= FREQ_THRESH_HZ) {
      if (setProperty("device_vfo_frequency", String(target), "primary")) {
        lastCmdDl = target;
      }
    }
  }

  // Secondary device = uplink (dual-tuner)
  if (ulHz != null && Number.isFinite(ulHz)) {
    const target = Math.round(ulHz);
    if (Math.abs(target - lastCmdUl) >= FREQ_THRESH_HZ) {
      if (setProperty("device_vfo_frequency", String(target), "secondary")) {
        lastCmdUl = target;
      } else if (dlHz == null) {
        // Single-device fallback: only UL was requested this tick
        if (setProperty("device_vfo_frequency", String(target), "primary")) {
          lastCmdUl = target;
          lastCmdDl = target;
        }
      }
    }
  }
}

function adjustFine(delta, side) {
  if (typeof delta !== "number") return;
  if (side === "dl") dlFineOffset += delta;
  else ulFineOffset += delta;
  broadcastStatus();
}

function setStep(step) {
  if (typeof step === "number" && step > 0) digitStep = Math.round(step);
  broadcastStatus();
}

function center() {
  manualDlOffset = 0;
  ulFineOffset = 0;
  dlFineOffset = 0;
  broadcastStatus();
}

function resetOffsets() {
  manualDlOffset = 0;
  ulFineOffset = 0;
  dlFineOffset = 0;
  lastCmdDl = 0;
  lastCmdUl = 0;
  lastModDl = "";
  lastModUl = "";
}

function setOffsets(o) {
  if (!o || typeof o !== "object") return;
  if (typeof o.ulFineOffset === "number" && Number.isFinite(o.ulFineOffset))
    ulFineOffset = Math.round(o.ulFineOffset);
  if (typeof o.dlFineOffset === "number" && Number.isFinite(o.dlFineOffset))
    dlFineOffset = Math.round(o.dlFineOffset);
  if (typeof o.manualDlOffset === "number" && Number.isFinite(o.manualDlOffset))
    manualDlOffset = Math.round(o.manualDlOffset);
  lastCmdDl = 0;
  lastCmdUl = 0;
  broadcastStatus();
}

function getRadioState() {
  return {
    radioOn,
    locked,
    connected,
    tciConnected: connected,
    connecting,
    manualDlOffset,
    ulFineOffset,
    dlFineOffset,
    lastCmdDl,
    lastCmdUl,
    lastModDl,
    lastModUl,
    step: digitStep,
    ctcssMode,
    ctcssAccessHz,
    ctcssActivationHz,
  };
}

function applyEndpointChange() {
  const wasOn = radioOn;
  disconnect();
  if (wasOn) {
    radioOn = true;
    connect();
  } else {
    broadcastStatus();
  }
}

module.exports = {
  meta,
  init,
  setRadio,
  setLock,
  applyDefaultLock,
  pushFrequencies,
  adjustFine,
  setStep,
  center,
  resetOffsets,
  setOffsets,
  setCtcss,
  applyDefaultCtcss,
  getRadioState,
  broadcastStatus,
  applyEndpointChange,
};
