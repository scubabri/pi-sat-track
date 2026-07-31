/**
 * FlexRadio SmartSDR CAT driver (Kenwood-style over TCP).
 * Dual connections: uplink (TX slice) + downlink (RX slice).
 *
 * Mode (SmartSDR CAT MD — PowerSDR numbering):
 *   MD1 LSB, MD2 USB, MD3 CW, MD4 FM
 * CTCSS: TN + TO on UL slice when supported.
 */

const net = require("net");
const config = require("../config");
const {
  formatFreqDisplayFromMode,
  isFmMode,
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
    lastMode: null,
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
let dlFineOffset = 0;
let digitStep = 100;
let broadcastFn = () => {};
let vfoPollTimer = null;
const VFO_POLL_MS = 400;
const VFO_THRESH_HZ = 80;

let ctcssMode = "off";
let ctcssAccessHz = null;
let ctcssActivationHz = null;
let lastCtcssApplied = null;

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
    lastUlMode: ul.lastMode,
    lastDlMode: dl.lastMode,
    manualDlOffset,
    ulFineOffset,
    dlFineOffset,
    step: digitStep,
    ctcssMode,
    ctcssAccessHz,
    ctcssActivationHz,
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
    dlFineOffset,
    step: digitStep,
    lastCmdDl: dl.lastFreqHz,
    lastCmdUl: ul.lastFreqHz,
    ctcssMode,
    ctcssAccessHz,
    ctcssActivationHz,
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

function modesForCatalogMode(modeStr) {
  const m = (modeStr || "").toUpperCase();
  if (isFmMode(modeStr) || /\bFM\b|NFM|GFSK|CTCSS|C4FM|DSTAR|DMR/.test(m)) {
    return { ul: "4", dl: "4", ulName: "FM", dlName: "FM" };
  }
  if (/\bCW\b/.test(m) && !/\bSSB\b/.test(m)) {
    return { ul: "3", dl: "3", ulName: "CW", dlName: "CW" };
  }
  return { ul: "1", dl: "2", ulName: "LSB", dlName: "USB" };
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
      link.lastMode = null;
      clearReconnect(link);
      console.log("Flex", link.name.toUpperCase(), "connected", host + ":" + port);
      broadcastStatus();
      if (link.name === "dl") startVfoPoll();
      if (link.name === "ul") applyCtcssToRadio().catch(() => {});
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
  link.lastMode = null;
}

function close() {
  radioOn = false;
  stopVfoPoll();
  closeLink(ul);
  closeLink(dl);
  lastCtcssApplied = null;
  broadcastStatus();
  console.log("Flex disconnected");
}

function setRadio(on) {
  console.log("Flex setRadio(" + on + ")");
  if (on) {
    radioOn = true;
    manualDlOffset = 0;
    ulFineOffset = 0;
    dlFineOffset = 0;
    lastCtcssApplied = null;
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

function applyDefaultLock(isFm) {
  locked = !!isFm;
  console.log("Flex default LOCK", locked ? "ON (FM)" : "OFF (linear)");
  broadcastStatus();
}

function activeCtcssHz() {
  if (ctcssMode === "access") return ctcssAccessHz;
  if (ctcssMode === "activation") return ctcssActivationHz;
  return null;
}

function setCtcss(which) {
  if (which === "access" && ctcssAccessHz != null) ctcssMode = "access";
  else if (which === "activation" && ctcssActivationHz != null)
    ctcssMode = "activation";
  else ctcssMode = "off";
  lastCtcssApplied = null;
  console.log("Flex CTCSS", ctcssMode, activeCtcssHz());
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
    "Flex CTCSS default",
    ctcssMode,
    "access",
    ctcssAccessHz,
    "act",
    ctcssActivationHz,
  );
  applyCtcssToRadio().catch(() => {});
  broadcastStatus();
}

/** Kenwood-style TN (tone Hz*10) + TO1/0 on UL */
async function applyCtcssToRadio() {
  if (!ul.connected) return;
  const hz = activeCtcssHz();
  const key = hz != null ? String(hz) : "off";
  if (key === lastCtcssApplied) return;
  try {
    if (hz != null) {
      const tn = Math.round(hz * 10);
      await sendCmd(ul, "TN" + String(tn).padStart(4, "0") + ";", false);
      await sendCmd(ul, "TO1;", false);
      console.log("Flex UL CTCSS", hz, "Hz ON");
    } else {
      await sendCmd(ul, "TO0;", false);
      console.log("Flex UL CTCSS OFF");
    }
    lastCtcssApplied = key;
  } catch (e) {
    console.warn("Flex CTCSS:", e.message);
  }
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

async function setLinkMode(link, mdCode, mdName) {
  if (!link.connected) return false;
  if (link.lastMode === mdCode) return true;
  try {
    await sendCmd(link, "MD" + mdCode + ";", false);
    link.lastMode = mdCode;
    console.log("Flex", link.name.toUpperCase(), "mode →", mdName, "(MD" + mdCode + ")");
    return true;
  } catch (e) {
    console.warn("Flex", link.name, "mode failed:", e.message);
    return false;
  }
}

async function pushModulation() {
  const { currentSatKey, currentModeIndex } = getCtx();
  const info = getCatalog()[currentSatKey] || {};
  const active = getActiveModeObj(info, currentModeIndex);
  const mods = modesForCatalogMode(active && active.mode);

  if (ul.connected && ul.wanted) {
    await setLinkMode(ul, mods.ul, mods.ulName);
  }
  if (dl.connected && dl.wanted) {
    await setLinkMode(dl, mods.dl, mods.dlName);
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
  await pushModulation();
  await applyCtcssToRadio();
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
  manualDlOffset = freq - f0 * df - dlFineOffset;
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

function adjustFine(delta, side) {
  if (typeof delta !== "number") return;
  if (side === "dl") {
    dlFineOffset += delta;
    dl.lastFreqHz = null;
    console.log("Flex DL fine", delta >= 0 ? "+" + delta : delta, "→", dlFineOffset, "Hz");
  } else {
    ulFineOffset += delta;
    ul.lastFreqHz = null;
    console.log("Flex UL fine", delta >= 0 ? "+" + delta : delta, "→", ulFineOffset, "Hz");
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
  ul.lastFreqHz = null;
  dl.lastFreqHz = null;
  console.log("Flex center offsets");
  broadcastStatus();
}

function resetOffsets() {
  manualDlOffset = 0;
  ulFineOffset = 0;
  dlFineOffset = 0;
  ul.lastFreqHz = null;
  dl.lastFreqHz = null;
  ul.lastMode = null;
  dl.lastMode = null;
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
    dlFineOffset,
    lastCmdDl: dl.lastFreqHz,
    lastCmdUl: ul.lastFreqHz,
    step: digitStep,
    ctcssMode,
    ctcssAccessHz,
    ctcssActivationHz,
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
  setCtcss,
  applyDefaultCtcss,
  getRadioState,
  statusPayload,
  broadcastStatus,
  applyEndpointChange,
};
