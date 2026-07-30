const WebSocket = require("ws"); // constructor (do not destructure — older ws versions break)
const net = require("net");
const { TCI_URI, TCI_HOST, TCI_PORT, C_MS } = require("./config");
const {
  formatFreqDisplayFromMode,
  isInverting,
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
    host: TCI_HOST,
    port: TCI_PORT,
    uri: TCI_URI,
    manualDlOffset,
    ulFineOffset,
    step: digitStep,
    lastCmdDl,
    lastCmdUl,
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

/** Quick TCP probe so we can log "nothing listening" vs WS handshake failure */
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
  broadcastStatus();
  console.log("TCI disconnected");
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

  console.log("TCI: probing", TCI_HOST + ":" + TCI_PORT + " ...");
  const probe = await probePort(TCI_HOST, TCI_PORT, 1500);
  if (!probe.ok) {
    console.warn(
      "TCI: nothing accepting TCP on",
      TCI_HOST + ":" + TCI_PORT,
      "(" + probe.err + "). Is AetherSDR running with TCI enabled?",
    );
    connecting = false;
    tciConnected = false;
    // keep radioOn true so UI shows intent; retry
    scheduleReconnect();
    broadcastStatus();
    return;
  }
  console.log("TCI: TCP port open, opening WebSocket", TCI_URI);

  try {
    tciWs = new WebSocket(TCI_URI, {
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
    clearReconnect();
    console.log("TCI connected to", TCI_URI);
    broadcastStatus();
  });

  tciWs.on("message", (raw) => {
    const msg = raw.toString().trim();
    // Uncomment for protocol debug:
    // if (msg.length < 200) console.log('TCI <<', msg);

    if (!msg.startsWith("vfo:")) return;
    try {
      const body = msg.replace(/;$/, "");
      const parts = body.split(":")[1].split(",");
      const rx = parseInt(parts[0], 10);
      const ch = parseInt(parts[1], 10);
      const freq = parseInt(parts[2], 10);
      // rx=0 channel=0 = downlink VFO (Python convention)
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
              const df = 1 - rr / C_MS;
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
}

function pushFrequencies() {
  if (!radioOn || !tciConnected) return;

  const { satrec, observer, currentSatKey, currentModeIndex } = getCtx();
  if (!satrec) return;

  const info = getCatalog()[currentSatKey] || {};
  const active = getActiveModeObj(info, currentModeIndex);
  const freqs = formatFreqDisplayFromMode(active);
  if (freqs.ulMHz == null && freqs.dlMHz == null) return;

  const rr = rangeRateKmS(satrec, observer, new Date());
  if (rr == null || !Number.isFinite(rr)) return;

  const df = 1 - rr / C_MS;
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
};
