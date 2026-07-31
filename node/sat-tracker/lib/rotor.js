const net = require("net");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const { angularDistanceDeg } = require("./orbit");

const LOG_PATH = path.join(config.CACHE_DIR, "rotor_track.log");

let antennaOn = false;
let azSock = null;
let elSock = null;
let azConnected = false;
let elConnected = false;
let azBuf = "";
let elBuf = "";
let lastAz = null;
let lastEl = null;
let lastCmdAz = null;
let lastCmdEl = null;
let lastMoveAzAt = 0;
let lastMoveElAt = 0;
let reconnectTimer = null;
let pollTimer = null;
let nextAosAz = null;
let logging = false;

// Recent look samples for angular-rate estimation
let lookHistory = [];
const HISTORY_MS = 2500;

let broadcastFn = () => {};

function init(opts) {
  if (opts && opts.broadcast) broadcastFn = opts.broadcast;
}

function statusPayload() {
  return {
    type: "rotor",
    antennaOn,
    azConnected,
    elConnected,
    az: lastAz,
    el: lastEl,
    lastCmdAz,
    lastCmdEl,
    minEl: config.ROTOR_MIN_EL,
    hostAz: config.ROTOR_AZ_HOST + ":" + config.ROTOR_AZ_PORT,
    hostEl: config.ROTOR_EL_HOST + ":" + config.ROTOR_EL_PORT,
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
  if (!antennaOn) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (antennaOn) connect();
  }, 3000);
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPoll() {
  stopPoll();
  pollTimer = setInterval(() => {
    if (!antennaOn) return;
    pollPositions();
  }, 250);
}

function extractFirstNumber(buf) {
  const lines = buf.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || /^RPRT/i.test(t)) continue;
    const n = parseFloat(t);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function replyComplete(buf) {
  if (/RPRT\s+-?\d+/i.test(buf)) return true;
  const lines = buf.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.length >= 2;
}

function isAckOnly(buf) {
  const lines = buf
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every((l) => /^RPRT\s+-?\d+/i.test(l));
}

function onPosUpdate(kind, value) {
  if (value == null || !Number.isFinite(value)) return;
  let changed = false;
  if (kind === "az") {
    const a = ((value % 360) + 360) % 360;
    if (lastAz == null || Math.abs(a - lastAz) >= 0.05) {
      lastAz = a;
      changed = true;
    }
  } else {
    if (lastEl == null || Math.abs(value - lastEl) >= 0.05) {
      lastEl = value;
      changed = true;
    }
  }
  if (changed) {
    console.log(
      "Rotor pos",
      kind.toUpperCase(),
      kind === "az" ? lastAz.toFixed(1) : lastEl.toFixed(1),
    );
    broadcastStatus();
  }
}

function handleData(kind, chunk) {
  const isAz = kind === "az";
  if (isAz) {
    azBuf += chunk;
    if (azBuf.length > 8192) azBuf = azBuf.slice(-2048);
    if (!replyComplete(azBuf)) return;
    const buf = azBuf;
    azBuf = "";
    if (isAckOnly(buf)) return;
    const n = extractFirstNumber(buf);
    if (n != null) onPosUpdate("az", n);
  } else {
    elBuf += chunk;
    if (elBuf.length > 8192) elBuf = elBuf.slice(-2048);
    if (!replyComplete(elBuf)) return;
    const buf = elBuf;
    elBuf = "";
    if (isAckOnly(buf)) return;
    const n = extractFirstNumber(buf);
    if (n != null) onPosUpdate("el", n);
  }
}

function attachSocket(kind, sock) {
  sock.setEncoding("utf8");
  sock.on("data", (chunk) => handleData(kind, chunk));
  sock.on("close", () => {
    console.log("Rotor", kind.toUpperCase(), "closed");
    if (kind === "az") {
      azConnected = false;
      azSock = null;
      azBuf = "";
    } else {
      elConnected = false;
      elSock = null;
      elBuf = "";
    }
    broadcastStatus();
    if (antennaOn) scheduleReconnect();
  });
  sock.on("error", (err) => {
    console.warn("Rotor", kind.toUpperCase(), "error:", err.message);
  });
}

function send(kind, cmd) {
  const sock = kind === "az" ? azSock : elSock;
  const ok = kind === "az" ? azConnected : elConnected;
  if (!sock || !ok) return false;
  try {
    sock.write(cmd.endsWith("\n") ? cmd : cmd + "\n");
    return true;
  } catch (e) {
    console.warn("Rotor", kind, "send failed:", e.message);
    return false;
  }
}

function connectOne(kind) {
  return new Promise((resolve) => {
    const host = kind === "az" ? config.ROTOR_AZ_HOST : config.ROTOR_EL_HOST;
    const port = kind === "az" ? config.ROTOR_AZ_PORT : config.ROTOR_EL_PORT;
    const sock = net.connect({ host, port });

    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, 2500);

    sock.once("connect", () => {
      clearTimeout(timer);
      attachSocket(kind, sock);
      if (kind === "az") {
        azSock = sock;
        azConnected = true;
      } else {
        elSock = sock;
        elConnected = true;
      }
      console.log("Rotor", kind.toUpperCase(), "connected", host + ":" + port);
      send(kind, "p");
      resolve(true);
    });

    sock.once("error", (err) => {
      clearTimeout(timer);
      console.warn("Rotor", kind.toUpperCase(), "connect failed:", err.message);
      resolve(false);
    });
  });
}

async function connect() {
  if (!antennaOn) return;
  clearReconnect();

  if (!azConnected) await connectOne("az");
  if (!elConnected) await connectOne("el");

  broadcastStatus();
  startPoll();

  if (antennaOn && (!azConnected || !elConnected)) {
    scheduleReconnect();
  }
}

function disconnect() {
  clearReconnect();
  stopPoll();
  antennaOn = false;
  logging = false;
  lookHistory = [];

  if (azSock) {
    try {
      azSock.destroy();
    } catch (_) {}
    azSock = null;
  }
  if (elSock) {
    try {
      elSock.destroy();
    } catch (_) {}
    elSock = null;
  }
  azConnected = false;
  elConnected = false;
  azBuf = "";
  elBuf = "";
  broadcastStatus();
  console.log("Rotor disconnected");
}

function startLog() {
  try {
    if (!fs.existsSync(config.CACHE_DIR)) {
      fs.mkdirSync(config.CACHE_DIR, { recursive: true });
    }
    fs.writeFileSync(
      LOG_PATH,
      "timestamp,sat_az,sat_el,rotor_az,rotor_el,cmd_az,cmd_el,rate_deg_s,interval_ms\n",
    );
    logging = true;
    console.log("Rotor log started →", LOG_PATH);
  } catch (e) {
    console.warn("Rotor log open failed:", e.message);
    logging = false;
  }
}

function logSample(satAz, satEl, rate, intervalMs) {
  if (!logging || !antennaOn) return;
  try {
    const ts = new Date().toISOString();
    const line =
      [
        ts,
        satAz != null && Number.isFinite(satAz) ? satAz.toFixed(2) : "",
        satEl != null && Number.isFinite(satEl) ? satEl.toFixed(2) : "",
        lastAz != null ? lastAz.toFixed(2) : "",
        lastEl != null ? lastEl.toFixed(2) : "",
        lastCmdAz != null ? lastCmdAz.toFixed(2) : "",
        lastCmdEl != null ? lastCmdEl.toFixed(2) : "",
        rate != null && Number.isFinite(rate) ? rate.toFixed(3) : "",
        intervalMs != null && Number.isFinite(intervalMs)
          ? Math.round(intervalMs)
          : "",
      ].join(",") + "\n";
    fs.appendFileSync(LOG_PATH, line);
  } catch (e) {
    console.warn("Rotor log write failed:", e.message);
  }
}

function setAntenna(on) {
  console.log("Rotor setAntenna(" + on + ")");
  if (on) {
    antennaOn = true;
    lookHistory = [];
    startLog();
    connect();
  } else {
    disconnect();
  }
  broadcastStatus();
}

function applyEndpointChange() {
  console.log(
    "Rotor endpoints →",
    config.ROTOR_AZ_HOST + ":" + config.ROTOR_AZ_PORT,
    config.ROTOR_EL_HOST + ":" + config.ROTOR_EL_PORT,
  );
  if (antennaOn) {
    disconnect();
    antennaOn = true;
    lookHistory = [];
    startLog();
    connect();
  } else {
    broadcastStatus();
  }
}

/**
 * Estimate satellite angular rate (°/s) from recent look samples.
 */
function estimateAngularRate(look) {
  const now = Date.now();
  if (!look || !Number.isFinite(look.az) || !Number.isFinite(look.el)) {
    return 0.3;
  }

  lookHistory.push({ t: now, az: look.az, el: look.el });
  lookHistory = lookHistory.filter((h) => now - h.t <= HISTORY_MS);

  if (lookHistory.length < 2) return 0.3;

  const a = lookHistory[0];
  const b = lookHistory[lookHistory.length - 1];
  const dt = (b.t - a.t) / 1000;
  if (dt < 0.3) return 0.3;

  const dang = angularDistanceDeg(a, b);
  const rate = dang / dt;
  return Number.isFinite(rate) && rate > 0 ? rate : 0.3;
}

/**
 * Adaptive interval from angular rate and desired step size.
 */
function adaptiveIntervalMs(rate) {
  const step = config.ROTOR_STEP_DEG || 1.5;
  const r = Math.max(rate || 0.05, 0.05);
  let ms = (step / r) * 1000;
  ms = Math.max(
    config.ROTOR_MIN_INTERVAL_MS,
    Math.min(config.ROTOR_MAX_INTERVAL_MS, ms),
  );
  return ms;
}

function commandPosition(az, el, intervalMs) {
  if (!antennaOn) return;
  const now = Date.now();
  const interval =
    intervalMs != null ? intervalMs : config.ROTOR_MIN_INTERVAL_MS;

  if (az != null && Number.isFinite(az) && azConnected) {
    if (now - lastMoveAzAt >= interval) {
      let a = ((az % 360) + 360) % 360;
      if (lastCmdAz == null || Math.abs(a - lastCmdAz) >= 0.3) {
        if (send("az", "P " + a.toFixed(1) + " 0.0")) {
          lastCmdAz = a;
          lastMoveAzAt = now;
          console.log(
            "Rotor CMD AZ",
            a.toFixed(1),
            "interval",
            Math.round(interval) + "ms",
          );
        }
      }
    }
  }

  if (el != null && Number.isFinite(el) && elConnected) {
    if (now - lastMoveElAt >= interval) {
      let e = Math.max(-5, Math.min(90, el));
      if (lastCmdEl == null || Math.abs(e - lastCmdEl) >= 0.3) {
        if (send("el", "P " + e.toFixed(1) + " 0.0")) {
          lastCmdEl = e;
          lastMoveElAt = now;
          console.log(
            "Rotor CMD EL",
            e.toFixed(1),
            "interval",
            Math.round(interval) + "ms",
          );
        }
      }
    }
  }
}

function updateTracking(look, aosAz) {
  if (aosAz != null && Number.isFinite(aosAz)) nextAosAz = aosAz;

  if (!antennaOn) return;
  if (!azConnected && !elConnected) return;
  if (!look || typeof look.el !== "number" || typeof look.az !== "number") {
    return;
  }

  const rate = estimateAngularRate(look);
  const intervalMs = adaptiveIntervalMs(rate);

  if (look.el >= config.ROTOR_MIN_EL) {
    commandPosition(look.az, look.el, intervalMs);
  } else {
    const parkAz =
      nextAosAz != null && Number.isFinite(nextAosAz) ? nextAosAz : look.az;
    commandPosition(parkAz, config.ROTOR_PARK_EL, intervalMs);
  }

  // Stash for logging (state.js will call logSample with sat position)
  updateTracking._lastRate = rate;
  updateTracking._lastInterval = intervalMs;
}

function pollPositions() {
  if (azConnected) send("az", "p");
  if (elConnected) send("el", "p");
}

function getRotorState() {
  return {
    antennaOn,
    azConnected,
    elConnected,
    az: lastAz,
    el: lastEl,
    lastCmdAz,
    lastCmdEl,
    minEl: config.ROTOR_MIN_EL,
    rate: updateTracking._lastRate,
    intervalMs: updateTracking._lastInterval,
  };
}

module.exports = {
  init,
  setAntenna,
  updateTracking,
  pollPositions,
  getRotorState,
  statusPayload,
  broadcastStatus,
  applyEndpointChange,
  connect,
  disconnect,
  logSample,
};
