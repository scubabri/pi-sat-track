/**
 * AetherSDR / ExpertSDR TCI driver (WebSocket).
 * UL = rx1, DL = rx0 for VFO + mode over TCI.
 *
 * CTCSS: AetherSDR is a Flex client — tone must be set on the radio via
 * SmartSDR API (LAN IP:4992), not TCI. ExpertSDR CTCSS_* TCI cmds are
 * still sent as a best-effort; Flex API is authoritative when configured.
 */

const WebSocket = require("ws");
const net = require("net");
const config = require("../config");
const {
  formatFreqDisplayFromMode,
  isFmMode,
  getCatalog,
} = require("../catalog");
const { rangeRateKmS } = require("../orbit");
const { createApiClient } = require("./flex-api");

const meta = {
  id: "tci",
  label: "AetherSDR TCI",
  match(cfg) {
    const t = String(cfg.RADIO_TYPE || "").toLowerCase();
    return (
      cfg.RADIO_TRANSPORT === "tcp" &&
      cfg.RADIO_PROTOCOL === "tci" &&
      (t === "aethersdr" || t === "expertsdr")
    );
  },
};

let tciWs = null;
let tciConnected = false;
let radioOn = false;
let connecting = false;
let locked = false;
let manualDlOffset = 0;
let ulFineOffset = 0;
let dlFineOffset = 0;
let lastCmdDl = 0;
let lastCmdUl = 0;
let lastModDl = "";
let lastModUl = "";
let digitStep = 100;
let reconnectTimer = null;
let ctcssMode = "off";
let ctcssAccessHz = null;
let ctcssActivationHz = null;
let lastCtcssApplied = null;

const UL_RX = 1;
const CTCSS_MODE_TX = 2;

const api = createApiClient();

let getCtx = () => ({
  satrec: null,
  observer: null,
  currentSatKey: null,
  currentModeIndex: 0,
});
let broadcastFn = () => {};

function init(opts) {
  if (opts.getContext) getCtx = opts.getContext;
  if (opts.broadcast) broadcastFn = opts.broadcast;
}

function apiHost() {
  return (config.FLEX_API_HOST || "").trim();
}

function apiPort() {
  return config.FLEX_API_PORT || 4992;
}

function statusPayload() {
  return {
    type: "tci",
    radioOn,
    locked,
    connected: tciConnected,
    connecting,
    host: config.TCI_HOST,
    port: config.TCI_PORT,
    uri: config.TCI_URI,
    apiConnected: api.isConnected(),
    apiHost: apiHost(),
    apiPort: apiPort(),
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

function tciSend(cmd) {
  if (!tciWs || tciWs.readyState !== WebSocket.OPEN) return false;
  try {
    if (!cmd.endsWith(";")) cmd += ";";
    tciWs.send(cmd);
    return true;
  } catch (e) {
    console.warn("TCI send failed:", e.message);
    return false;
  }
}

function probePort(host, port, timeoutMs) {
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
    socket.setTimeout(timeoutMs || 1500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", (e) => finish(false, e.message));
    socket.connect(port, host);
  });
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function disconnect() {
  clearReconnect();
  connecting = false;
  if (tciWs) {
    try {
      tciWs.removeAllListeners();
      tciWs.close();
    } catch (_) {}
    tciWs = null;
  }
  tciConnected = false;
  radioOn = false;
  lastModDl = "";
  lastModUl = "";
  lastCtcssApplied = null;
  api.close();
  broadcastStatus();
  console.log("TCI disconnected");
}

function modesForActive(active) {
  const modeStr = (active && active.mode) || "";
  if (isFmMode(modeStr)) return { ul: "NFM", dl: "NFM" };
  const m = modeStr.toUpperCase();
  if (/\bFM\b|NFM|CTCSS/.test(m)) return { ul: "NFM", dl: "NFM" };
  if (/\bCW\b/.test(m) && !/\bSSB\b/.test(m)) return { ul: "CW", dl: "CW" };
  return { ul: "LSB", dl: "USB" };
}

function pushModulation(active, force) {
  if (!tciConnected) return;
  const mods = modesForActive(active);
  if (force || mods.dl !== lastModDl) {
    if (tciSend(`modulation:0,${mods.dl};`)) {
      lastModDl = mods.dl;
      console.log("TCI mod DL (rx0) ->", mods.dl);
    }
  }
  if (force || mods.ul !== lastModUl) {
    if (tciSend(`modulation:1,${mods.ul};`)) {
      lastModUl = mods.ul;
      console.log("TCI mod UL (rx1) ->", mods.ul);
    }
  }
}

function activeCtcssHz() {
  if (ctcssMode === "access") return ctcssAccessHz;
  if (ctcssMode === "activation") return ctcssActivationHz;
  return null;
}

function resolveUlHzForCtcss() {
  if (lastCmdUl > 0) return lastCmdUl;
  try {
    const { currentSatKey, currentModeIndex } = getCtx();
    const info = getCatalog()[currentSatKey] || {};
    const active = getActiveModeObj(info, currentModeIndex);
    const freqs = formatFreqDisplayFromMode(active);
    if (freqs.ulMHz != null) return Math.round(freqs.ulMHz * 1e6);
  } catch (_) {}
  return null;
}

/**
 * Prefer Flex radio API for CTCSS (works with AetherSDR + Flex hardware).
 * Also emit ExpertSDR-style TCI CTCSS_* as best-effort.
 */
async function applyCtcssToRadio(force) {
  const hz = activeCtcssHz();
  const key = hz != null ? String(hz) : "off";
  if (!force && key === lastCtcssApplied) return;

  if (tciConnected) {
    if (hz != null && Number.isFinite(hz) && hz > 0) {
      const tone = Number(hz).toFixed(1);
      tciSend(`CTCSS_TX_TONE:${UL_RX},${tone};`);
      tciSend(`CTCSS_MODE:${UL_RX},${CTCSS_MODE_TX};`);
      tciSend(`CTCSS_ENABLE:${UL_RX},true;`);
    } else {
      tciSend(`CTCSS_ENABLE:${UL_RX},false;`);
    }
  }

  const h = apiHost();
  if (!h) {
    if (force) {
      console.warn(
        "TCI CTCSS: set Radio API host (Flex radio LAN IP:4992) in config — " +
          "AetherSDR TCI does not apply tone on the radio by itself",
      );
    }
    lastCtcssApplied = key;
    return;
  }

  if (!api.isConnected()) {
    const ok = await api.connect(h, apiPort());
    if (!ok) {
      console.warn("TCI CTCSS: Flex API unreachable", h + ":" + apiPort());
      return;
    }
  }

  try {
    const ulHz = resolveUlHzForCtcss();
    await api.setCtcss(hz, ulHz);
    lastCtcssApplied = key;
  } catch (e) {
    console.warn("TCI CTCSS Flex API:", e.message);
  }
}

async function connect() {
  if (
    tciWs &&
    (tciWs.readyState === WebSocket.OPEN ||
      tciWs.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }
  if (connecting) return;

  connecting = true;
  radioOn = true;
  broadcastStatus();

  const host = config.TCI_HOST;
  const port = config.TCI_PORT;
  const uri = config.TCI_URI;

  console.log("TCI: probing", host + ":" + port + " ...");
  const probe = await probePort(host, port, 1500);
  if (!probe.ok) {
    console.warn(
      "TCI: nothing accepting TCP on",
      host + ":" + port,
      "(" + probe.err + ")",
    );
    connecting = false;
    tciConnected = false;
    scheduleReconnect();
    broadcastStatus();
    return;
  }

  try {
    tciWs = new WebSocket(uri, { handshakeTimeout: 5000 });
  } catch (e) {
    connecting = false;
    tciConnected = false;
    scheduleReconnect();
    broadcastStatus();
    return;
  }

  tciWs.on("open", () => {
    connecting = false;
    tciConnected = true;
    radioOn = true;
    manualDlOffset = 0;
    ulFineOffset = 0;
    dlFineOffset = 0;
    lastCmdDl = 0;
    lastCmdUl = 0;
    lastModDl = "";
    lastModUl = "";
    lastCtcssApplied = null;
    clearReconnect();
    console.log("TCI connected to", uri);
    broadcastStatus();
    const { currentSatKey, currentModeIndex } = getCtx();
    const info = getCatalog()[currentSatKey] || {};
    const active = getActiveModeObj(info, currentModeIndex);
    pushModulation(active, true);

    const h = apiHost();
    if (h) {
      api.connect(h, apiPort()).then(() => {
        setTimeout(() => applyCtcssToRadio(true).catch(() => {}), 400);
      });
    } else {
      setTimeout(() => applyCtcssToRadio(true).catch(() => {}), 300);
    }
  });

  tciWs.on("message", (raw) => {
    const msg = raw.toString().trim();
    if (/^ctcss_/i.test(msg)) {
      console.log("TCI <<", msg);
    }
    if (!msg.startsWith("vfo:")) return;
    if (locked) return;
    try {
      const body = msg.replace(/;$/, "");
      const parts = body.split(":")[1].split(",");
      const rx = parseInt(parts[0], 10);
      const ch = parseInt(parts[1], 10);
      const freq = parseInt(parts[2], 10);
      if (rx === 0 && ch === 0 && Number.isFinite(freq) && lastCmdDl > 0) {
        if (Math.abs(freq - lastCmdDl) > 80) {
          const { satrec, observer, currentSatKey, currentModeIndex } = getCtx();
          const info = getCatalog()[currentSatKey] || {};
          const active = getActiveModeObj(info, currentModeIndex);
          const freqs = formatFreqDisplayFromMode(active);
          if (freqs.dlMHz != null && satrec) {
            const rr = rangeRateKmS(satrec, observer, new Date());
            if (rr != null) {
              const f0 = freqs.dlMHz * 1e6;
              const df = 1 - rr / config.C_MS;
              manualDlOffset = freq - f0 * df - dlFineOffset;
              broadcastStatus();
            }
          }
        }
      }
    } catch (_) {}
  });

  tciWs.on("close", () => {
    connecting = false;
    tciConnected = false;
    tciWs = null;
    lastModDl = "";
    lastModUl = "";
    lastCtcssApplied = null;
    broadcastStatus();
    if (radioOn) scheduleReconnect();
  });

  tciWs.on("error", (err) => {
    console.warn("TCI error:", err.message);
    connecting = false;
    tciConnected = false;
    broadcastStatus();
  });
}

function scheduleReconnect() {
  clearReconnect();
  if (!radioOn) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (radioOn && !tciConnected) connect();
  }, 3000);
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
  broadcastStatus();
}

function applyEndpointChange() {
  api.close();
  if (radioOn) {
    disconnect();
    radioOn = true;
    connect();
  } else broadcastStatus();
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
  lastCtcssApplied = null;
}

function setCtcss(which) {
  if (which === "access" && ctcssAccessHz != null) ctcssMode = "access";
  else if (which === "activation" && ctcssActivationHz != null)
    ctcssMode = "activation";
  else ctcssMode = "off";
  lastCtcssApplied = null;
  console.log("TCI setCtcss", ctcssMode, activeCtcssHz());
  applyCtcssToRadio(true).catch(() => {});
  broadcastStatus();
}

function applyDefaultCtcss(accessHz, activationHz) {
  ctcssAccessHz = accessHz != null ? accessHz : null;
  ctcssActivationHz = activationHz != null ? activationHz : null;
  if (ctcssAccessHz != null) ctcssMode = "access";
  else ctcssMode = "off";
  lastCtcssApplied = null;
  console.log(
    "TCI CTCSS default",
    ctcssMode,
    "access",
    ctcssAccessHz,
    "act",
    ctcssActivationHz,
  );
  applyCtcssToRadio(true).catch(() => {});
  broadcastStatus();
}

function pushFrequencies(ulHz, dlHz) {
  if (!radioOn || !tciConnected) return;

  const { currentSatKey, currentModeIndex } = getCtx();
  const info = getCatalog()[currentSatKey] || {};
  const active = getActiveModeObj(info, currentModeIndex);
  pushModulation(active, false);
  applyCtcssToRadio(false).catch(() => {});

  if (dlHz != null && Number.isFinite(dlHz) && Math.abs(dlHz - lastCmdDl) >= 1) {
    if (tciSend(`vfo:0,0,${Math.round(dlHz)};`)) lastCmdDl = Math.round(dlHz);
  }
  if (ulHz != null && Number.isFinite(ulHz) && Math.abs(ulHz - lastCmdUl) >= 1) {
    if (tciSend(`vfo:1,0,${Math.round(ulHz)};`)) lastCmdUl = Math.round(ulHz);
  }
}

function getRadioState() {
  return {
    radioOn,
    locked,
    tciConnected,
    connected: tciConnected,
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

module.exports = {
  meta,
  init,
  setRadio,
  setLock,
  applyDefaultLock,
  adjustFine,
  setStep,
  center,
  resetOffsets,
  setCtcss,
  applyDefaultCtcss,
  pushFrequencies,
  getRadioState,
  statusPayload,
  broadcastStatus,
  applyEndpointChange,
};
