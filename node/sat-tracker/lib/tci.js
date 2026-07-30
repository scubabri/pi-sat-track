const WebSocket = require("ws");
const net = require("net");
const config = require("./config");
const {
  formatFreqDisplayFromMode,
  isInverting,
  isFmMode,
  getCatalog,
} = require("./catalog");
const { rangeRateKmS } = require("./orbit");

let tciWs = null;
let tciConnected = false;
let radioOn = false;
let connecting = false;
let manualDlOffset = 0;
let ulFineOffset = 0;
let lastCmdDl = 0;
let lastCmdUl = 0;
let lastModDl = "";
let lastModUl = "";
let digitStep = 100;
let reconnectTimer = null;

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

function statusPayload() {
  return {
    type: "tci",
    radioOn,
    connected: tciConnected,
    connecting,
    host: config.TCI_HOST,
    port: config.TCI_PORT,
    uri: config.TCI_URI,
    manualDlOffset,
    ulFineOffset,
    step: digitStep,
    lastCmdDl,
    lastCmdUl,
    lastModDl,
    lastModUl,
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
  broadcastStatus();
  console.log("TCI disconnected");
}

/**
 * Map catalog mode → ExpertSDR / AetherSDR TCI modulation name.
 * Channels: 0 = downlink (RX), 1 = uplink (TX/other VFO)
 * Linear inverting sats: UL LSB, DL USB
 * FM sats: NFM both ways
 */
function modesForActive(active) {
  const modeStr = (active && active.mode) || "";
  if (isFmMode(modeStr)) {
    return { ul: "NFM", dl: "NFM" };
  }
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

async function connect() {
  if (
    tciWs &&
    (tciWs.readyState === WebSocket.OPEN ||
      tciWs.readyState === WebSocket.CONNECTING)
  ) {
    console.log("TCI already open/connecting, state=", tciWs.readyState);
    return;
  }
  if (connecting) {
    console.log("TCI connect already in progress");
    return;
  }

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
      "(" + probe.err + "). Is AetherSDR running with TCI enabled?",
    );
    connecting = false;
    tciConnected = false;
    scheduleReconnect();
    broadcastStatus();
    return;
  }
  console.log("TCI: TCP port open, opening WebSocket", uri);

  try {
    tciWs = new WebSocket(uri, {
      handshakeTimeout: 5000,
    });
  } catch (e) {
    console.warn("TCI: WebSocket construct failed:", e.message);
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
    lastCmdDl = 0;
    lastCmdUl = 0;
    lastModDl = "";
    lastModUl = "";
    clearReconnect();
    console.log("TCI connected to", uri);
    broadcastStatus();

    const { currentSatKey, currentModeIndex } = getCtx();
    const info = getCatalog()[currentSatKey] || {};
    const active = getActiveModeObj(info, currentModeIndex);
    pushModulation(active, true);
  });

  tciWs.on("message", (raw) => {
    const msg = raw.toString().trim();

    if (!msg.startsWith("vfo:")) return;
    try {
      const body = msg.replace(/;$/, "");
      const parts = body.split(":")[1].split(",");
      const rx = parseInt(parts[0], 10);
      const ch = parseInt(parts[1], 10);
      const freq = parseInt(parts[2], 10);
      if (rx === 0 && ch === 0 && Number.isFinite(freq) && lastCmdDl > 0) {
        if (Math.abs(freq - lastCmdDl) > 80) {
          const { satrec, observer, currentSatKey, currentModeIndex } =
            getCtx();
          const info = getCatalog()[currentSatKey] || {};
          const active = getActiveModeObj(info, currentModeIndex);
          const freqs = formatFreqDisplayFromMode(active);
          if (freqs.dlMHz != null && satrec) {
            const rr = rangeRateKmS(satrec, observer, new Date());
            if (rr != null) {
              const f0 = freqs.dlMHz * 1e6;
              const df = 1 - rr / config.C_MS;
              manualDlOffset = freq - f0 * df;
            }
          }
        }
      }
    } catch (_) {}
  });

  tciWs.on("close", (code, reason) => {
    console.log(
      "TCI closed code=" +
        code +
        (reason && reason.length ? " reason=" + reason.toString() : ""),
    );
    connecting = false;
    tciConnected = false;
    tciWs = null;
    lastModDl = "";
    lastModUl = "";
    broadcastStatus();
    if (radioOn) scheduleReconnect();
  });

  tciWs.on("error", (err) => {
    console.warn("TCI error:", err.message);
    connecting = false;
    tciConnected = false;
    broadcastStatus();
  });

  tciWs.on("unexpected-response", (req, res) => {
    console.warn("TCI unexpected HTTP response", res.statusCode);
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
    if (radioOn && !tciConnected) {
      console.log("TCI: retry connect...");
      connect();
    }
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
  console.log("TCI setRadio(" + on + ")");
  if (on) {
    radioOn = true;
    connect();
  } else {
    radioOn = false;
    disconnect();
  }
  broadcastStatus();
}

/** Host/port changed from Station Configuration — reconnect if radio is on */
function applyEndpointChange() {
  console.log("TCI endpoint changed →", config.TCI_URI);
  if (radioOn) {
    const wasOn = true;
    disconnect();
    radioOn = wasOn;
    connect();
  } else {
    broadcastStatus();
  }
}

function adjustFine(delta) {
  if (typeof delta === "number") ulFineOffset += delta;
  broadcastStatus();
}

function setStep(step) {
  if (typeof step === "number" && step > 0) digitStep = Math.round(step);
  broadcastStatus();
}

function center() {
  manualDlOffset = 0;
  ulFineOffset = 0;
  broadcastStatus();
}

function resetOffsets() {
  manualDlOffset = 0;
  ulFineOffset = 0;
  lastCmdDl = 0;
  lastCmdUl = 0;
  lastModDl = "";
  lastModUl = "";
}

function pushFrequencies() {
  if (!radioOn || !tciConnected) return;

  const { satrec, observer, currentSatKey, currentModeIndex } = getCtx();
  if (!satrec) return;

  const info = getCatalog()[currentSatKey] || {};
  const active = getActiveModeObj(info, currentModeIndex);
  const freqs = formatFreqDisplayFromMode(active);
  if (freqs.ulMHz == null && freqs.dlMHz == null) return;

  pushModulation(active, false);

  const rr = rangeRateKmS(satrec, observer, new Date());
  if (rr == null || !Number.isFinite(rr)) return;

  const df = 1 - rr / config.C_MS;
  const inverting = isInverting(active && active.mode);

  let desiredDl = null;
  let desiredUl = null;

  if (freqs.dlMHz != null) {
    desiredDl = Math.round(freqs.dlMHz * 1e6 * df + manualDlOffset);
  }
  if (freqs.ulMHz != null) {
    const f0 = freqs.ulMHz * 1e6;
    if (inverting) {
      desiredUl = Math.round(f0 * (2 - df) - manualDlOffset + ulFineOffset);
    } else {
      desiredUl = Math.round(f0 * df + manualDlOffset + ulFineOffset);
    }
  }

  if (desiredDl != null && Math.abs(desiredDl - lastCmdDl) >= 1) {
    if (tciSend(`vfo:0,0,${desiredDl};`)) lastCmdDl = desiredDl;
  }
  if (desiredUl != null && Math.abs(desiredUl - lastCmdUl) >= 1) {
    if (tciSend(`vfo:1,0,${desiredUl};`)) lastCmdUl = desiredUl;
  }
}

function getRadioState() {
  return {
    radioOn,
    tciConnected,
    connecting,
    manualDlOffset,
    ulFineOffset,
    lastCmdDl,
    lastCmdUl,
    lastModDl,
    lastModUl,
    step: digitStep,
  };
}

module.exports = {
  init,
  setRadio,
  adjustFine,
  setStep,
  center,
  resetOffsets,
  pushFrequencies,
  getRadioState,
  statusPayload,
  broadcastStatus,
  applyEndpointChange,
};
