/**
 * FlexRadio SmartSDR CAT driver (Kenwood-style over TCP).
 * Dual connections: uplink (TX slice) + downlink (RX slice).
 *
 * Protocol:
 *   FA;              → read VFO A frequency
 *   FA00014250000;   → set VFO A (11-digit Hz)
 *
 * Set commands usually produce no reply.
 */

const net = require("net");
const config = require("../config");

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
  };
}

const ul = makeLink("ul");
const dl = makeLink("dl");

let radioOn = false;
let ulFineOffset = 0;
let digitStep = 100;
let broadcastFn = () => {};

function init(opts) {
  if (opts && opts.broadcast) broadcastFn = opts.broadcast;
}

function statusPayload() {
  return {
    type: "flex",
    radioOn,
    connected: ul.connected && dl.connected,
    ulConnected: ul.connected,
    dlConnected: dl.connected,
    connecting: ul.connecting || dl.connecting,
    ulHost: config.FLEX_UL_HOST,
    ulPort: config.FLEX_UL_PORT,
    dlHost: config.FLEX_DL_HOST,
    dlPort: config.FLEX_DL_PORT,
    lastUlHz: ul.lastFreqHz,
    lastDlHz: dl.lastFreqHz,
    ulFineOffset,
    step: digitStep,
  };
}

function broadcastStatus() {
  broadcastFn(statusPayload());
  // Also emit tci-shaped status so existing UI Radio indicator works
  broadcastFn({
    type: "tci",
    radioOn,
    connected: ul.connected && dl.connected,
    connecting: ul.connecting || dl.connecting,
    host: config.FLEX_UL_HOST,
    port: config.FLEX_UL_PORT,
    manualDlOffset: 0,
    ulFineOffset,
    step: digitStep,
    lastCmdDl: dl.lastFreqHz,
    lastCmdUl: ul.lastFreqHz,
  });
}

function freqToFa(freqHz) {
  return "FA" + String(Math.round(freqHz)).padStart(11, "0") + ";";
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
  if (!radioOn) return;
  link.reconnectTimer = setTimeout(() => {
    link.reconnectTimer = null;
    if (radioOn && !link.connected && !link.connecting) {
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
      broadcastStatus();
      if (radioOn) scheduleReconnect(link);
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
  link.connecting = false;
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

async function open() {
  const a = await openLink(ul);
  const b = await openLink(dl);
  return a && b;
}

function close() {
  radioOn = false;
  closeLink(ul);
  closeLink(dl);
  broadcastStatus();
  console.log("Flex disconnected");
}

function setRadio(on) {
  console.log("Flex setRadio(" + on + ")");
  if (on) {
    radioOn = true;
    ulFineOffset = 0;
    open().catch(() => {});
  } else {
    close();
  }
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

/**
 * Push Doppler-corrected frequencies to both slices.
 * ulHz / dlHz are absolute Hz (already include Doppler + fine offset).
 */
async function pushFrequencies(ulHz, dlHz) {
  if (!radioOn) return;
  if (ulHz != null && Number.isFinite(ulHz)) {
    if (!ul.connected || ul.lastFreqHz == null || Math.abs(ulHz - ul.lastFreqHz) >= 1) {
      await setLinkFrequency(ul, ulHz);
    }
  }
  if (dlHz != null && Number.isFinite(dlHz)) {
    if (!dl.connected || dl.lastFreqHz == null || Math.abs(dlHz - dl.lastFreqHz) >= 1) {
      await setLinkFrequency(dl, dlHz);
    }
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
  ulFineOffset = 0;
  broadcastStatus();
}

function resetOffsets() {
  ulFineOffset = 0;
  ul.lastFreqHz = null;
  dl.lastFreqHz = null;
}

function getRadioState() {
  return {
    radioOn,
    tciConnected: ul.connected && dl.connected, // UI reuse
    connected: ul.connected && dl.connected,
    ulConnected: ul.connected,
    dlConnected: dl.connected,
    connecting: ul.connecting || dl.connecting,
    manualDlOffset: 0,
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
  closeLink(ul);
  closeLink(dl);
  radioOn = wasOn;
  if (wasOn) open().catch(() => {});
  else broadcastStatus();
}

module.exports = {
  init,
  open,
  close,
  setRadio,
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
