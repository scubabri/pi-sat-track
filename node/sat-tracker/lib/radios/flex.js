/**
 * FlexRadio SmartSDR CAT driver (Kenwood-style over TCP).
 * Dual connections: uplink (TX slice) + downlink (RX slice).
 *
 * VFO follow: polls FA; on DL. When unlocked, operator tunes update
 * manualDlOffset (UL tracks). When locked (FM default), tunes are ignored.
 */

const net = require("net");
const config = require("../config");
const {
  formatFreqDisplayFromMode,
  getCatalog,
} = require("../catalog");
const { rangeRateKmS } = require("../orbit");

function makeLink(name) {
  return {
    name,
    socket: null,
    connected: false,
    connecting: false,
    busy: false,
    buf: "",
    lastFreqHz: null,
    reconnectTimer: null,
    wanted: false,
  };
}

const ul = makeLink("ul");
const dl = makeLink("dl");

let radioOn = false;
let locked = false;
let manualDlOffset = 0;
let ulFineOffset = 0;
let digitStep = 100;
let broadcastFn = () => {};
let vfoPollTimer = null;
const VFO_POLL_MS = 400;
const VFO_THRESH_HZ = 80;

let getCtx = () => ({
  satrec: null,
  observer: null,
  currentSatKey: null,
  currentModeIndex: 0,
});

function init(opts) {
  if (opts && opts.broadcast) broadcastFn = opts.broadcast;
  if (opts && opts.getContext) getCtx = opts.getContext;
}

function anyConnected() {
  return ul.connected || dl.connected;
}

function statusPayload() {
  return {
    type: "flex",
    radioOn,
    locked,
    connected: anyConnected(),
    ulConnected: ul.connected,
    dlConnected: dl.connected,
    ulWanted: ul.wanted,
    dlWanted: dl.wanted,
    connecting: ul.connecting || dl.connecting,
    ulHost: config.FLEX_UL_HOST,
    ulPort: config.FLEX_UL_PORT,
    dlHost: config.FLEX_DL_HOST,
    dlPort: config.FLEX_DL_PORT,
    lastUlHz: ul.lastFreqHz,
    lastDlHz: dl.lastFreqHz,
    manualDlOffset,
    ulFineOffset,
    step: digitStep,
  };
}

function broadcastStatus() {
  broadcastFn(statusPayload());
  broadcastFn({
    type: "tci",
    radioOn,
    locked,
    connected: anyConnected(),
    connecting: ul.connecting || dl.connecting,
    host: config.FLEX_UL_HOST,
    port: config.FLEX_UL_PORT,
    manualDlOffset,
    ulFineOffset,
    step: digitStep,
    lastCmdDl: dl.lastFreqHz,
    lastCmdUl: ul.lastFreqHz,
  });
}

function freqToFa(freqHz) {
  return "FA" + String(Math.round(freqHz)).padStart(11, "0") + ";";
}

function parseFa(reply) {
  if (!reply) return null;
  const s = String(reply).trim();
  if (!s.startsWith("FA") || !s.endsWith(";")) return null;
  const digits = s.slice(2, -1);
  if (!/^\d+$/.test(digits)) return null;
  return parseInt(digits, 10);
}

function linkHostPort(link) {
  if (link.name === "ul") {
    return { host: config.FLEX_UL_HOST, port: config.FLEX_UL_PORT };
  }
  return { host: config.FLEX_DL_HOST, port: config.FLEX_DL_PORT };
}

function clearReconnect(link) {
  if (link.reconnectTimer) {
    clearTimeout(link.reconnectTimer);
    link.reconnectTimer = null;
  }
}

function scheduleReconnect(link) {
  clearReconnect(link);
  if (!radioOn || !link.wanted) return;
  link.reconnectTimer = setTimeout(() => {
    link.reconnectTimer = null;
    if (radioOn && link.wanted && !link.connected && !link.connecting) {
      console.log("Flex", link.name.toUpperCase(), "retry connect...");
      openLink(link).catch(() => {});
    }
  }, 3000);
}

function sendCmd(link, cmd, expectReply) {
  return new Promise((resolve, reject) => {
    if (!link.socket || !link.connected) {
      reject(new Error("Flex " + link.name + " not connected"));
      return;
    }
    if (link.busy) {
      reject(new Error("Flex " + link.name + " busy"));
      return;
    }
    if (!cmd.endsWith(";")) cmd += ";";

    link.busy = true;
    link.buf = "";

    const onData = (chunk) => {
      link.buf += chunk.toString("ascii");
      if (link.buf.includes(";")) {
        cleanup();
        const reply = link.buf.trim();
        link.buf = "";
        resolve(reply);
      }
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    let timer = null;
    const cleanup = () => {
      link.busy = false;
      if (timer) clearTimeout(timer);
      if (link.socket) {
        link.socket.removeListener("data", onData);
        link.socket.removeListener("error", onError);
      }
    };

    if (expectReply) {
      link.socket.on("data", onData);
      link.socket.on("error", onError);
      timer = setTimeout(() => {
        cleanup();
        resolve(link.buf.trim() || "");
      }, 1200);
    }

    try {
      link.socket.write(cmd, "ascii", (err) => {
        if (err) {
          cleanup();
          reject(err);
          return;
        }
        if (!expectReply) {
          setTimeout(() => {
            link.busy = false;
            resolve("");
          }, 40);
        }
      });
    } catch (e) {
      cleanup();
      reject(e);
    }
  });
}

function openLink(link) {
  if (link.socket && link.connected) return Promise.resolve(true);
  if (link.connecting) return Promise.resolve(false);

  link.connecting = true;
  broadcastStatus();

  return new Promise((resolve) => {
    const { host, port } = linkHostPort(link);
    console.log("Flex", link.name.toUpperCase(), "connecting", host + ":" + port);

    const s = new net.Socket();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      link.connecting = false;
      if (!ok) {
        try {
          s.destroy();
        } catch (_) {}
        link.connected = false;
        link.socket = null;
        broadcastStatus();
        scheduleReconnect(link);
      }
      resolve(ok);
    };

    s.setTimeout(4000);
    s.once("connect", () => {
      s.setTimeout(0);
      link.socket = s;
      link.connected = true;
      link.buf = "";
      clearReconnect(link);
      console.log("Flex", link.name.toUpperCase(), "connected", host + ":" + port);
      broadcastStatus();
      if (link.name === "dl") startVfoPoll();
      done(true);
    });
    s.once("timeout", () => {
      console.warn("Flex", link.name.toUpperCase(), "connect timeout");
      done(false);
    });
    s.once("error", (err) => {
      console.warn("Flex", link.name.toUpperCase(), "connect error:", err.message);
      done(false);
    });
    s.on("close", () => {
      console.log("Flex", link.name.toUpperCase(), "closed");
      link.connected = false;
      link.connecting = false;
      link.socket = null;
      link.buf = "";
      link.busy = false;
      if (link.name === "dl") stopVfoPoll();
      broadcastStatus();
      if (radioOn && link.wanted) scheduleReconnect(link);
    });
    s.on("error", (err) => {
      console.warn("Flex", link.name.toUpperCase(), "error:", err.message);
    });

    try {
      s.connect(port, host);
    } catch (e) {
      console.warn("Flex", link.name.toUpperCase(), "exception:", e.message);
      done(false);
    }
  });
}

function closeLink(link) {
  clearReconnect(link);
  link.wanted = false;
  link.connecting = false;
  if (link.name === "dl") stopVfoPoll();
  if (link.socket) {
    try {
      link.socket.removeAllListeners();
      link.socket.destroy();
    } catch (_) {}
    link.socket = null;
  }
  link.connected = false;
  link.busy = false;
  link.buf = "";
  link.lastFreqHz = null;
}

function close() {
  radioOn = false;
  stopVfoPoll();
  closeLink(ul);
  closeLink(dl);
  broadcastStatus();
  console.log("Flex disconnected");
}

function setRadio(on) {
  console.log("Flex setRadio(" + on + ")");
  if (on) {
    radioOn = true;
    manualDlOffset = 0;
    ulFineOffset = 0;
    broadcastStatus();
  } else {
    close();
  }
}

function setLock(on) {
  locked = !!on;
  console.log("Flex LOCK", locked ? "ON" : "OFF");
  broadcastStatus();
}

/** FM → locked true, linear → locked false */
function applyDefaultLock(isFm) {
  locked = !!isFm;
  console.log("Flex default LOCK", locked ? "ON (FM)" : "OFF (linear)");
  broadcastStatus();
}

async function setLinkFrequency(link, freqHz) {
  if (!Number.isFinite(freqHz) || freqHz < 1e5 || freqHz > 6e8) return false;
  if (!link.connected) return false;
  const cmd = freqToFa(freqHz);
  try {
    await sendCmd(link, cmd, false);
    link.lastFreqHz = Math.round(freqHz);
    return true;
  } catch (e) {
    console.warn("Flex", link.name, "set failed:", e.message);
    return false;
  }
}

async function pushSide(link, freqHz) {
  const hasFreq = freqHz != null && Number.isFinite(freqHz);

  if (!hasFreq) {
    if (link.wanted || link.connected || link.connecting) {
      console.log("Flex", link.name.toUpperCase(), "not needed — closing");
      closeLink(link);
      broadcastStatus();
    }
    return;
  }

  link.wanted = true;

  if (!link.connected) {
    const ok = await openLink(link);
    if (!ok) return;
  }

  if (link.lastFreqHz == null || Math.abs(freqHz - link.lastFreqHz) >= 1) {
    await setLinkFrequency(link, freqHz);
  }
}

async function pushFrequencies(ulHz, dlHz) {
  if (!radioOn) return;
  await pushSide(ul, ulHz);
  await pushSide(dl, dlHz);
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

async function pollDlVfo() {
  if (!radioOn || !dl.connected || !dl.wanted || dl.busy) return;
  if (dl.lastFreqHz == null || dl.lastFreqHz <= 0) return;
  // Locked: ignore operator tunes (FM default)
  if (locked) return;

  let reply;
  try {
    reply = await sendCmd(dl, "FA;", true);
  } catch (_) {
    return;
  }

  const freq = parseFa(reply);
  if (freq == null) return;
  if (Math.abs(freq - dl.lastFreqHz) <= VFO_THRESH_HZ) return;

  const { satrec, observer, currentSatKey, currentModeIndex } = getCtx();
  if (!satrec) return;

  const info = getCatalog()[currentSatKey] || {};
  const active = getActiveModeObj(info, currentModeIndex);
  const freqs = formatFreqDisplayFromMode(active);
  if (freqs.dlMHz == null) return;

  const rr = rangeRateKmS(satrec, observer, new Date());
  if (rr == null || !Number.isFinite(rr)) return;

  const f0 = freqs.dlMHz * 1e6;
  const df = 1 - rr / config.C_MS;
  const prev = manualDlOffset;
  manualDlOffset = freq - f0 * df;
  dl.lastFreqHz = freq;

  if (Math.abs(manualDlOffset - prev) >= 1) {
    console.log(
      "Flex VFO DL",
      (freq / 1e6).toFixed(6),
      "MHz → manualDlOffset",
      Math.round(manualDlOffset),
      "Hz",
    );
    broadcastStatus();
  }
}

function startVfoPoll() {
  if (vfoPollTimer) return;
  vfoPollTimer = setInterval(() => {
    pollDlVfo().catch(() => {});
  }, VFO_POLL_MS);
}

function stopVfoPoll() {
  if (vfoPollTimer) {
    clearInterval(vfoPollTimer);
    vfoPollTimer = null;
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
  ul.lastFreqHz = null;
  dl.lastFreqHz = null;
}

function getRadioState() {
  return {
    radioOn,
    locked,
    tciConnected: anyConnected(),
    connected: anyConnected(),
    ulConnected: ul.connected,
    dlConnected: dl.connected,
    connecting: ul.connecting || dl.connecting,
    manualDlOffset,
    ulFineOffset,
    lastCmdDl: dl.lastFreqHz,
    lastCmdUl: ul.lastFreqHz,
    step: digitStep,
  };
}

function applyEndpointChange() {
  console.log(
    "Flex endpoints → UL",
    config.FLEX_UL_HOST + ":" + config.FLEX_UL_PORT,
    "DL",
    config.FLEX_DL_HOST + ":" + config.FLEX_DL_PORT,
  );
  const wasOn = radioOn;
  const ulWanted = ul.wanted;
  const dlWanted = dl.wanted;
  closeLink(ul);
  closeLink(dl);
  radioOn = wasOn;
  if (wasOn) {
    ul.wanted = ulWanted;
    dl.wanted = dlWanted;
    if (ulWanted) openLink(ul).catch(() => {});
    if (dlWanted) openLink(dl).catch(() => {});
  }
  broadcastStatus();
}

module.exports = {
  init,
  open: async () => true,
  close,
  setRadio,
  setLock,
  applyDefaultLock,
  pushFrequencies,
  adjustFine,
  setStep,
  center,
  resetOffsets,
  getRadioState,
  statusPayload,
  broadcastStatus,
  applyEndpointChange,
};
