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
      (t === "aethersdr" || t === "expertsdr") &&
      String(cfg.RADIO_PROTOCOL || "").toLowerCase() === "tci"
    );
  },
};

let tciWs = null;
let tciConnected = false;
let tciConnecting = false;
let reconnectTimer = null;
let radioOn = false;
let locked = false;
let manualDlOffset = 0;
let ulFineOffset = 0;
let dlFineOffset = 0;
let digitStep = 100;
let lastCmdDl = null;
let lastCmdUl = null;
let lastModDl = "";
let lastModUl = "";
let vfoPollTimer = null;
let broadcastFn = () => {};
let ctcssMode = "off";
let ctcssAccessHz = null;
let ctcssActivationHz = null;
let lastCtcssApplied = null;

const VFO_POLL_MS = 500;
const VFO_THRESH_HZ = 80;
const SYNC_WINDOW_MS = 12000;
const SYNC_OK_STREAK = 2;

let syncNeeded = false;
let syncStartedAt = 0;
let syncOkStreak = 0;

let getCtx = () => ({
  satrec: null,
  observer: null,
  currentSatKey: null,
  currentModeIndex: 0,
});

const api = createApiClient({
  getHost: () => config.FLEX_API_HOST || "",
  getPort: () => config.FLEX_API_PORT || 4992,
  label: "TCI/API",
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function init(opts) {
  if (opts && opts.broadcast) broadcastFn = opts.broadcast;
  if (opts && opts.getContext) getCtx = opts.getContext;
}

function markSyncNeeded(reason) {
  syncNeeded = true;
  syncStartedAt = Date.now();
  syncOkStreak = 0;
  lastModDl = "";
  lastModUl = "";
  lastCmdDl = null;
  lastCmdUl = null;
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
    clearSyncNeeded("verified streak " + syncOkStreak);
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
    connecting: tciConnecting,
    host: config.TCI_HOST,
    port: config.TCI_PORT,
    manualDlOffset,
    ulFineOffset,
    dlFineOffset,
    step: digitStep,
    lastCmdDl,
    lastCmdUl,
    ctcssMode,
    ctcssAccessHz,
    ctcssActivationHz,
    syncNeeded,
    apiConnected: api.connected,
  };
}

function broadcastStatus() {
  broadcastFn(statusPayload());
}

function tciSend(cmd) {
  if (!tciWs || tciWs.readyState !== WebSocket.OPEN) return false;
  try {
    tciWs.send(cmd);
    return true;
  } catch (e) {
    console.warn("TCI send failed:", e.message);
    return false;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  if (!radioOn) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (radioOn && !tciConnected && !tciConnecting) open().catch(() => {});
  }, 3000);
}

function open() {
  if (tciWs && tciConnected) return Promise.resolve(true);
  if (tciConnecting) return Promise.resolve(false);
  const host = config.TCI_HOST || "127.0.0.1";
  const port = config.TCI_PORT || 50001;
  const url = "ws://" + host + ":" + port;
  tciConnecting = true;
  broadcastStatus();
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      tciConnecting = false;
      if (!ok) scheduleReconnect();
      broadcastStatus();
      resolve(ok);
    };
    try {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch (_) {}
        done(false);
      }, 4000);
      ws.on("open", () => {
        clearTimeout(timer);
        tciWs = ws;
        tciConnected = true;
        markSyncNeeded("open");
        console.log("TCI connected", url);
        startVfoPoll();
        done(true);
      });
      ws.on("close", () => {
        tciConnected = false;
        tciConnecting = false;
        tciWs = null;
        stopVfoPoll();
        broadcastStatus();
        if (radioOn) scheduleReconnect();
      });
      ws.on("error", (e) => {
        console.warn("TCI error:", e.message);
        if (!settled) {
          clearTimeout(timer);
          done(false);
        }
      });
      ws.on("message", () => {});
    } catch (e) {
      console.warn("TCI open exception:", e.message);
      done(false);
    }
  });
}

function close() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stopVfoPoll();
  if (tciWs) {
    try {
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
  // AetherSDR expects FM (not NFM) for amateur FM sats / ISS
  if (isFmMode(modeStr)) return { ul: "FM", dl: "FM" };
  const m = modeStr.toUpperCase();
  if (/\bFM\b|NFM|CTCSS/.test(m)) return { ul: "FM", dl: "FM" };
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

function resolveUlHzForCtcss() {
  if (lastCmdUl != null && Number.isFinite(lastCmdUl)) return lastCmdUl;
  const { currentSatKey, currentModeIndex } = getCtx();
  const info = getCatalog()[currentSatKey] || {};
  const modes = info.modes || [];
  const active =
    modes.length > 0
      ? modes[Math.max(0, Math.min(currentModeIndex || 0, modes.length - 1))]
      : {
          mode: info.mode || "",
          uplink: info.uplink || "",
          downlink: info.downlink || "",
        };
  const freqs = formatFreqDisplayFromMode(active);
  if (freqs.ulMHz != null) return Math.round(freqs.ulMHz * 1e6);
  return null;
}

async function applyCtcssToRadio() {
  const hz = activeCtcssHz();
  const key = hz != null ? String(hz) : "off";
  if (key === lastCtcssApplied) return;

  // Best-effort ExpertSDR TCI CTCSS (ignored by Aether)
  if (tciConnected) {
    if (hz != null) {
      tciSend(`CTCSS_ENABLE:1,true;`);
      tciSend(`CTCSS_MODE:1,tenc;`);
      tciSend(`CTCSS:1,${hz};`);
    } else {
      tciSend(`CTCSS_ENABLE:1,false;`);
    }
  }

  // Authoritative path for Aether: Flex API on radio LAN
  try {
    if (hz != null) {
      const ulHz = resolveUlHzForCtcss();
      await api.setCtcssTone(hz, { ulHz });
      console.log("TCI/API CTCSS", hz, "Hz ON (UL slice)");
    } else {
      await api.setCtcssOff();
      console.log("TCI/API CTCSS OFF");
    }
    lastCtcssApplied = key;
  } catch (e) {
    console.warn("TCI/API CTCSS:", e.message);
  }
}

function setRadio(on) {
  if (on) {
    radioOn = true;
    manualDlOffset = 0;
    ulFineOffset = 0;
    dlFineOffset = 0;
    lastCtcssApplied = null;
    markSyncNeeded("setRadio");
    broadcastStatus();
    open().catch(() => {});
  } else {
    close();
  }
}

function setLock(on) {
  locked = !!on;
  broadcastStatus();
}

function applyDefaultLock(isFm) {
  locked = !!isFm;
  broadcastStatus();
}

function setCtcss(which) {
  if (which === "access" && ctcssAccessHz != null) ctcssMode = "access";
  else if (which === "activation" && ctcssActivationHz != null)
    ctcssMode = "activation";
  else ctcssMode = "off";
  lastCtcssApplied = null;
  console.log("TCI CTCSS", ctcssMode, activeCtcssHz());
  applyCtcssToRadio().catch(() => {});
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
  broadcastStatus();
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

async function pushFrequencies(ulHz, dlHz) {
  if (!radioOn) return;
  if (!tciConnected) {
    await open();
    if (!tciConnected) {
      maybeClearSync(false);
      return;
    }
  }

  const force = syncNeeded;
  const { currentSatKey, currentModeIndex } = getCtx();
  const info = getCatalog()[currentSatKey] || {};
  const active = getActiveModeObj(info, currentModeIndex);

  const modOk = pushModulation(active, force);

  let ok = modOk;
  if (dlHz != null && Number.isFinite(dlHz)) {
    const target = Math.round(dlHz);
    if (force || lastCmdDl == null || Math.abs(target - lastCmdDl) >= 1) {
      if (tciSend(`vfo:0,0,${target};`)) {
        lastCmdDl = target;
        if (force || syncNeeded) {
          console.log("TCI VFO DL", (target / 1e6).toFixed(6), "MHz");
        }
      } else {
        ok = false;
      }
    }
  }
  if (ulHz != null && Number.isFinite(ulHz)) {
    const target = Math.round(ulHz);
    if (force || lastCmdUl == null || Math.abs(target - lastCmdUl) >= 1) {
      if (tciSend(`vfo:1,0,${target};`)) {
        lastCmdUl = target;
        if (force || syncNeeded) {
          console.log("TCI VFO UL", (target / 1e6).toFixed(6), "MHz");
        }
      } else {
        ok = false;
      }
    }
  }

  await applyCtcssToRadio();
  maybeClearSync(ok && tciConnected);
}

async function pollVfo() {
  if (!radioOn || !tciConnected || locked) return;
  if (lastCmdDl == null || lastCmdDl <= 0) return;
  // TCI has no reliable VFO read-back; skip for now
}

function startVfoPoll() {
  if (vfoPollTimer) return;
  vfoPollTimer = setInterval(() => {
    pollVfo().catch(() => {});
  }, VFO_POLL_MS);
}

function stopVfoPoll() {
  if (vfoPollTimer) {
    clearInterval(vfoPollTimer);
    vfoPollTimer = null;
  }
}

function adjustFine(delta, side) {
  if (typeof delta !== "number") return;
  if (side === "dl") {
    dlFineOffset += delta;
    lastCmdDl = null;
    console.log("TCI DL fine", delta, "→", dlFineOffset);
  } else {
    ulFineOffset += delta;
    lastCmdUl = null;
    console.log("TCI UL fine", delta, "→", ulFineOffset);
  }
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
  lastCmdDl = null;
  lastCmdUl = null;
  broadcastStatus();
}

function resetOffsets() {
  manualDlOffset = 0;
  ulFineOffset = 0;
  dlFineOffset = 0;
  lastCmdDl = null;
  lastCmdUl = null;
  lastModDl = "";
  lastModUl = "";
}

function getRadioState() {
  return {
    radioOn,
    locked,
    tciConnected,
    connected: tciConnected,
    connecting: tciConnecting,
    manualDlOffset,
    ulFineOffset,
    dlFineOffset,
    lastCmdDl,
    lastCmdUl,
    step: digitStep,
    ctcssMode,
    ctcssAccessHz,
    ctcssActivationHz,
    syncNeeded,
  };
}

function applyEndpointChange() {
  const wasOn = radioOn;
  close();
  if (wasOn) {
    radioOn = true;
    markSyncNeeded("endpoint change");
    open().catch(() => {});
  }
  broadcastStatus();
}

module.exports = {
  meta,
  init,
  open,
  close,
  setRadio,
  setLock,
  applyDefaultLock,
  pushFrequencies,
  adjustFine,
  setStep,
  center,
  resetOffsets,
  setCtcss,
  applyDefaultCtcss,
  getRadioState,
  statusPayload,
  broadcastStatus,
  applyEndpointChange,
};
