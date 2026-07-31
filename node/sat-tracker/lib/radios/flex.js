/**
 * FlexRadio SmartSDR CAT driver (Kenwood-style over TCP).
 * Standalone — not yet wired into state/server.
 *
 * Protocol:
 *   ASCII commands terminated by ';'
 *   FA;              → read VFO A frequency
 *   FA00014250000;   → set VFO A (11-digit Hz)
 *   MD; / MD2;       → mode (future)
 *
 * Set commands usually produce no reply; read commands return data.
 */

const net = require("net");
const config = require("../config");

let socket = null;
let connected = false;
let connecting = false;
let busy = false;
let lastFreqHz = null;
let buf = "";
let broadcastFn = () => {};
let reconnectTimer = null;

function init(opts) {
  if (opts && opts.broadcast) broadcastFn = opts.broadcast;
}

function statusPayload() {
  return {
    type: "flex",
    connected,
    connecting,
    host: config.FLEX_HOST,
    port: config.FLEX_PORT,
    lastFreqHz,
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
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!connected && !connecting) {
      console.log("Flex: retry connect...");
      open().catch(() => {});
    }
  }, 3000);
}

function freqToFa(freqHz) {
  return "FA" + String(Math.round(freqHz)).padStart(11, "0") + ";";
}

function parseFa(reply) {
  if (!reply) return null;
  const s = String(reply).trim();
  if (!s.startsWith("FA") || !s.endsWith(";")) return null;
  const digits = s.slice(2, -1);
  if (!/^\d{11}$/.test(digits)) return null;
  return parseInt(digits, 10);
}

/**
 * Send a command. If expectReply is false, just fire-and-forget.
 * Returns the reply string (or "" when no reply expected / timeout).
 */
function sendCmd(cmd, expectReply) {
  return new Promise((resolve, reject) => {
    if (!socket || !connected) {
      reject(new Error("Flex not connected"));
      return;
    }
    if (busy) {
      reject(new Error("Flex busy"));
      return;
    }

    if (!cmd.endsWith(";")) cmd += ";";

    busy = true;
    buf = "";

    const onData = (chunk) => {
      buf += chunk.toString("ascii");
      if (buf.includes(";")) {
        cleanup();
        const reply = buf.trim();
        buf = "";
        resolve(reply);
      }
    };

    const onError = (err) => {
      cleanup();
      reject(err);
    };

    let timer = null;
    const cleanup = () => {
      busy = false;
      if (timer) clearTimeout(timer);
      if (socket) {
        socket.removeListener("data", onData);
        socket.removeListener("error", onError);
      }
    };

    if (expectReply) {
      socket.on("data", onData);
      socket.on("error", onError);
      timer = setTimeout(() => {
        cleanup();
        resolve(buf.trim() || "");
      }, 1500);
    }

    try {
      socket.write(cmd, "ascii", (err) => {
        if (err) {
          cleanup();
          reject(err);
          return;
        }
        if (!expectReply) {
          setTimeout(() => {
            busy = false;
            resolve("");
          }, 50);
        }
      });
    } catch (e) {
      cleanup();
      reject(e);
    }
  });
}

function open() {
  if (socket && connected) return Promise.resolve(true);
  if (connecting) return Promise.resolve(false);

  connecting = true;
  broadcastStatus();

  return new Promise((resolve) => {
    const host = config.FLEX_HOST;
    const port = config.FLEX_PORT;
    console.log("Flex: connecting to", host + ":" + port);

    const s = new net.Socket();
    let settled = false;

    const done = (ok) => {
      if (settled) return;
      settled = true;
      connecting = false;
      if (!ok) {
        try {
          s.destroy();
        } catch (_) {}
        connected = false;
        socket = null;
        broadcastStatus();
        scheduleReconnect();
      }
      resolve(ok);
    };

    s.setTimeout(4000);

    s.once("connect", () => {
      s.setTimeout(0);
      socket = s;
      connected = true;
      buf = "";
      clearReconnect();
      console.log("Flex connected", host + ":" + port);
      broadcastStatus();
      done(true);
    });

    s.once("timeout", () => {
      console.warn("Flex connect timeout");
      done(false);
    });

    s.once("error", (err) => {
      console.warn("Flex connect error:", err.message);
      done(false);
    });

    s.on("close", () => {
      console.log("Flex closed");
      connected = false;
      connecting = false;
      socket = null;
      buf = "";
      busy = false;
      broadcastStatus();
      scheduleReconnect();
    });

    s.on("error", (err) => {
      console.warn("Flex error:", err.message);
    });

    try {
      s.connect(port, host);
    } catch (e) {
      console.warn("Flex connect exception:", e.message);
      done(false);
    }
  });
}

function close() {
  clearReconnect();
  connecting = false;
  if (socket) {
    try {
      socket.removeAllListeners();
      socket.destroy();
    } catch (_) {}
    socket = null;
  }
  connected = false;
  busy = false;
  buf = "";
  lastFreqHz = null;
  broadcastStatus();
  console.log("Flex disconnected");
}

/**
 * Set VFO A frequency (Hz).
 * Returns true on success (command sent).
 */
async function setFrequency(freqHz) {
  if (!Number.isFinite(freqHz) || freqHz < 1e5 || freqHz > 6e8) {
    throw new Error("Frequency out of range: " + freqHz);
  }
  if (!connected) {
    const ok = await open();
    if (!ok) throw new Error("Flex not connected");
  }

  const cmd = freqToFa(freqHz);
  console.log("Flex set", (freqHz / 1e6).toFixed(6), "MHz →", cmd);
  await sendCmd(cmd, false);
  lastFreqHz = Math.round(freqHz);
  broadcastStatus();
  return true;
}

/**
 * Read VFO A frequency (Hz).
 * Returns frequency in Hz or null on failure.
 */
async function getFrequency() {
  if (!connected) {
    const ok = await open();
    if (!ok) return null;
  }

  const reply = await sendCmd("FA;", true);
  console.log("Flex get →", reply || "(empty)");

  const freq = parseFa(reply);
  if (freq != null) {
    lastFreqHz = freq;
    broadcastStatus();
    return freq;
  }
  return null;
}

function getFlexState() {
  return {
    connected,
    connecting,
    host: config.FLEX_HOST,
    port: config.FLEX_PORT,
    lastFreqHz,
  };
}

/** Host/port changed — reconnect if we were connected */
function applyEndpointChange() {
  console.log("Flex endpoint →", config.FLEX_HOST + ":" + config.FLEX_PORT);
  const wasConnected = connected;
  close();
  if (wasConnected) {
    open().catch(() => {});
  } else {
    broadcastStatus();
  }
}

module.exports = {
  init,
  open,
  close,
  setFrequency,
  getFrequency,
  getFlexState,
  statusPayload,
  broadcastStatus,
  applyEndpointChange,
};
