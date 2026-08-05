/**
 * AetherSDR / ExpertSDR TCI driver (WebSocket).
 * UL = rx1, DL = rx0 for VFO + mode over TCI.
 *
 * CTCSS: AetherSDR is a Flex client — tone must be set on the radio via
 * SmartSDR API (LAN IP:4992), not TCI. ExpertSDR CTCSS_* TCI cmds are
 * still sent as a best-effort; Flex API is authoritative when configured.
 *
 * On radio enable / WS open we mark syncNeeded and force modulation + VFO
 * for a short window (TCI has no reliable read-back).
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

const SYNC_WINDOW_MS = 10000;
const SYNC_OK_STREAK = 3;
let syncNeeded = false;
let syncStartedAt = 0;
let syncOkStreak = 0;

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

function markSyncNeeded(reason) {
  syncNeeded = true;
  syncStartedAt = Date.now();
  syncOkStreak = 0;
  lastModDl = "";
  lastModUl = "";
  lastCmdDl = 0;
  lastCmdUl = 0;
  console.log("TCI syncNeeded:", reason || "enable");
}

function clearSyncNeeded(reason) {
  if (!syncNeeded) return;
  syncNeeded = false;
  syncOkStreak = 0;
  console.log("TCI sync clear:", reason || "ok");
}

function maybeClearSync(okThisTick) {
  if (!syncNeeded) return;
  if (okThisTick) syncOkStreak += 1;
  else syncOkStreak = 0;
  const elapsed = Date.now() - syncStartedAt;
  if (syncOkStreak >= SYNC_OK_STREAK) {
    clearSyncNeeded("streak " + syncOkStreak);
  } else if (elapsed >= SYNC_WINDOW_MS && syncOkStreak >= 1) {
    clearSyncNeeded("window " + elapsed + "ms");
  } else if (elapsed >= SYNC_WINDOW_MS * 1.5) {
    clearSyncNeeded("window expired");
  }
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
    syncNeeded,
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
  syncNeeded = false;
  lastModDl = "";
  lastModUl = "";
  lastCtcssApplied = null;
  api.close();
  broadcastStatus();
  console.log("TCI disconnected");
}

function modesForActive(active) {
  const modeStr = (active && active.mode) || "";
  if (isFmMode(modeStr)) return { ul: "FM", dl: "FM" };
  const m = modeStr.toUpperCase();
  if (/\bFM\b|NFM|CTCSS|GFSK|AFSK|C4FM/.test(m)) return { ul: "FM", dl: "FM" };
  if (/\bCW\b/.test(m) && !/\bSSB\b/.test(m)) return { ul: "CW", dl: "CW" };
  return { ul: "LSB", dl: "USB" };
}

function pushModulation(active, force) {
  if (!tciConnected) return false;
  const mods = modesForActive(active);
  let ok = true;
  if (force || mods.dl !== lastModDl) {
    if (tciSend(`modulation:0,${mods.dl};`)) {
      lastModDl = mods.dl;
      console.log("TCI mod DL (rx0) ->", mods.dl, force ? "(force)" : "");
    } else {
      ok = false;
    }
  }
  if (force || mods.ul !== lastModUl) {
    if (tciSend(`modulation:1,${mods.ul};`)) {
      lastModUl = mods.ul;
      console.log("TCI mod UL (rx1) ->", mods.ul, force ? "(force)" : "");
    } else {
      ok = false;
    }
  }
  return ok;
}

function activeCtcssHz() {
  if (ctcssMode === "access") return ctcssAccessHz;
  if (ctcssMode === "activation") return ctcssActivationHz;
  return null;
}

/** Flex API (:4992) is only for FM CTCSS. */
function currentModeIsFm() {
  try {
    const { currentSatKey, currentModeIndex } = getCtx();
    const info = getCatalog()[currentSatKey] || {};
    const active = getActiveModeObj(info, currentModeIndex);
    const modeStr = (active && active.mode) || info.mode || "";
    return isFmMode(modeStr);
  } catch (_) {
    return false;
  }
}

function disconnectApi(reason) {
  if (!api.isConnected()) return;
  try {
    api.close();
  } catch (_) {}
  lastCtcssApplied = null;
  console.log("TCI Flex API closed:", reason || "disconnect");
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

async function applyCtcssToRadio(force) {
  if (!radioOn) {
    disconnectApi("radio off");
    return;
  }
  if (!currentModeIsFm()) {
    disconnectApi("non-FM mode");
    return;
  }

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
    lastCtcssApplied = null;
    markSyncNeeded("ws open");
    clearReconnect();
    console.log("TCI connected to", uri);
    broadcastStatus();
    const { currentSatKey, currentModeIndex } = getCtx();
    const info = getCatalog()[currentSatKey] || {};
    const active = getActiveModeObj(info, currentModeIndex);
    pushModulation(active, true);

    if (currentModeIsFm()) {
      const h = apiHost();
      if (h) {
        api.connect(h, apiPort()).then(() => {
          setTimeout(() => applyCtcssToRadio(true).catch(() => {}), 400);
        });
      } else {
        setTimeout(() => applyCtcssToRadio(true).catch(() => {}), 300);
      }
    } else {
      disconnectApi("non-FM on tci open");
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
    markSyncNeeded("setRadio");
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
  if (tciConnected) markSyncNeeded("mode/lock default");
  broadcastStatus();
}

function applyEndpointChange() {
  api.close();
  if (radioOn) {
    disconnect();
    radioOn = true;
    markSyncNeeded("endpoint change");
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

/** Absolute restore of saved per-sat calibration (after resetOffsets). */
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
  if (!radioOn) {
    disconnectApi("radio off");
  } else if (!currentModeIsFm()) {
    disconnectApi("non-FM sat");
  } else {
    applyCtcssToRadio(true).catch(() => {});
  }
  broadcastStatus();
}

function pushFrequencies(ulHz, dlHz) {
  if (!radioOn || !tciConnected) return;

  const force = syncNeeded;
  const { currentSatKey, currentModeIndex } = getCtx();
  const info = getCatalog()[currentSatKey] || {};
  const active = getActiveModeObj(info, currentModeIndex);
  const modOk = pushModulation(active, force);
  applyCtcssToRadio(false).catch(() => {});

  let freqOk = true;
  if (dlHz != null && Number.isFinite(dlHz)) {
    const target = Math.round(dlHz);
    if (force || Math.abs(target - lastCmdDl) >= 1) {
      if (tciSend(`vfo:0,0,${target};`)) {
        lastCmdDl = target;
      } else {
        freqOk = false;
      }
    }
  }
  if (ulHz != null && Number.isFinite(ulHz)) {
    const target = Math.round(ulHz);
    if (force || Math.abs(target - lastCmdUl) >= 1) {
      if (tciSend(`vfo:1,0,${target};`)) {
        lastCmdUl = target;
      } else {
        freqOk = false;
      }
    }
  }

  maybeClearSync(modOk && freqOk);
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
    syncNeeded,
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
  setOffsets,
  setCtcss,
  applyDefaultCtcss,
  pushFrequencies,
  getRadioState,
  statusPayload,
  broadcastStatus,
  applyEndpointChange,
};
