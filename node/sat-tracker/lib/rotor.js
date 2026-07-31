const net = require("net");
const fs = require("fs");
const path = require("path");
const config = require("./config");

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
let lastRotorAt = 0; // single timer, matches Python last_rotor
let reconnectTimer = null;
let pollTimer = null;
let nextAosAz = null;
let logging = false;

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
  if (kind === "az") {
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
      "timestamp,sat_az,sat_el,rotor_az,rotor_el,cmd_az,cmd_el\n",
    );
    logging = true;
    console.log("Rotor log started →", LOG_PATH);
  } catch (e) {
    console.warn("Rotor log open failed:", e.message);
    logging = false;
  }
}

function logSample(satAz, satEl) {
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
    lastRotorAt = 0; // force immediate command on enable (matches Python)
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
    lastRotorAt = 0;
    startLog();
    connect();
  } else {
    broadcastStatus();
  }
}

/**
 * Match Python set_rotor:
 *   - single shared 30 s timer
 *   - always send both axes when timer fires (no deadband)
 *   - command is absolute P <val> 0.0 on each axis
 */
function setRotor(az, el) {
  if (!antennaOn) return;

  const now = Date.now();
  if (now - lastRotorAt < config.ROTOR_MOVE_INTERVAL_MS) return;

  let sent = false;

  if (az != null && Number.isFinite(az) && azConnected) {
    const a = ((az % 360) + 360) % 360;
    if (send("az", "P " + a.toFixed(1) + " 0.0")) {
      lastCmdAz = a;
      sent = true;
      console.log("Rotor CMD AZ", a.toFixed(1));
    }
  }

  if (el != null && Number.isFinite(el) && elConnected) {
    const e = Math.max(-5, Math.min(90, el));
    if (send("el", "P " + e.toFixed(1) + " 0.0")) {
      lastCmdEl = e;
      sent = true;
      console.log("Rotor CMD EL", e.toFixed(1));
    }
  }

  // Advance timer only if at least one axis accepted the command
  if (sent) {
    lastRotorAt = now;
  }
}

/**
 * Match Python tracking branch:
 *   el >= MIN_EL  → current sat az/el
 *   el <  MIN_EL  → park at next AOS az, elevation = PARK_EL (default = MIN_EL)
 */
function updateTracking(look, aosAz) {
  if (aosAz != null && Number.isFinite(aosAz)) nextAosAz = aosAz;

  if (!antennaOn) return;
  if (!azConnected && !elConnected) return;
  if (!look || typeof look.el !== "number" || typeof look.az !== "number") {
    return;
  }

  if (look.el >= config.ROTOR_MIN_EL) {
    setRotor(look.az, look.el);
  } else {
    const parkAz =
      nextAosAz != null && Number.isFinite(nextAosAz) ? nextAosAz : look.az;
    setRotor(parkAz, config.ROTOR_PARK_EL);
  }
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
