const net = require("net");
const config = require("./config");

let antennaOn = false;
let azSock = null;
let elSock = null;
let azConnected = false;
let elConnected = false;
let azBuf = "";
let elBuf = "";
let lastAz = null; // last reported / commanded az for UI
let lastEl = null;
let lastCmdAz = null;
let lastCmdEl = null;
let lastMoveAt = 0;
let reconnectTimer = null;
let pollTimer = null;
let nextAosAz = null;

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
  // Live position while moving — ~4 Hz is fine for gauges
  pollTimer = setInterval(() => {
    if (!antennaOn) return;
    pollPositions();
  }, 250);
}

function parsePosReply(buf, kind) {
  // rotctld "p" reply is typically:
  //   <azimuth>\n
  //   <elevation>\n
  //   RPRT 0\n
  // Single-axis AZ: az meaningful, el often 0
  // Single-axis EL: el often in first field or second
  const lines = buf
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length && !/^RPRT/i.test(s));

  const nums = [];
  for (const line of lines) {
    const n = parseFloat(line);
    if (Number.isFinite(n)) nums.push(n);
  }
  if (!nums.length) return null;

  if (kind === "az") {
    return { az: nums[0], el: nums.length > 1 ? nums[1] : null };
  }
  // EL instance: prefer the non-zero / larger-magnitude elev-like value
  if (nums.length === 1) return { az: null, el: nums[0] };
  const a = nums[0];
  const b = nums[1];
  // If first looks like elev (0..90) and second is 0, use first
  if (Math.abs(a) <= 95 && Math.abs(b) < 1) return { az: null, el: a };
  if (Math.abs(b) <= 95) return { az: null, el: b };
  return { az: null, el: a };
}

function onPosUpdate(kind, pos) {
  let changed = false;
  if (kind === "az" && pos.az != null && Number.isFinite(pos.az)) {
    const a = ((pos.az % 360) + 360) % 360;
    if (lastAz == null || Math.abs(a - lastAz) >= 0.05) {
      lastAz = a;
      changed = true;
    }
  }
  if (kind === "el" && pos.el != null && Number.isFinite(pos.el)) {
    const e = pos.el;
    if (lastEl == null || Math.abs(e - lastEl) >= 0.05) {
      lastEl = e;
      changed = true;
    }
  }
  if (changed) broadcastStatus();
}

function attachSocket(kind, sock) {
  const isAz = kind === "az";
  sock.setEncoding("utf8");

  sock.on("data", (chunk) => {
    if (isAz) {
      azBuf += chunk;
      if (azBuf.length > 8192) azBuf = azBuf.slice(-2048);
      // Process complete replies ending with RPRT or two numeric lines
      if (
        /RPRT\s+-?\d+/i.test(azBuf) ||
        (azBuf.match(/\n/g) || []).length >= 2
      ) {
        const pos = parsePosReply(azBuf, "az");
        azBuf = "";
        if (pos) onPosUpdate("az", pos);
      }
    } else {
      elBuf += chunk;
      if (elBuf.length > 8192) elBuf = elBuf.slice(-2048);
      if (
        /RPRT\s+-?\d+/i.test(elBuf) ||
        (elBuf.match(/\n/g) || []).length >= 2
      ) {
        const pos = parsePosReply(elBuf, "el");
        elBuf = "";
        if (pos) onPosUpdate("el", pos);
      }
    }
  });

  sock.on("close", () => {
    console.log("Rotor", kind.toUpperCase(), "closed");
    if (isAz) {
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

function setAntenna(on) {
  console.log("Rotor setAntenna(" + on + ")");
  if (on) {
    antennaOn = true;
    connect();
  } else {
    disconnect();
  }
  broadcastStatus();
}

/**
 * Dual single-axis rotctld:
 *   AZ: P <az> 0
 *   EL: P 0 <el>
 */
function commandPosition(az, el) {
  if (!antennaOn) return;

  const now = Date.now();
  if (now - lastMoveAt < config.ROTOR_MOVE_INTERVAL_MS) return;
  lastMoveAt = now;

  if (az != null && Number.isFinite(az) && azConnected) {
    let a = ((az % 360) + 360) % 360;
    if (lastCmdAz == null || Math.abs(a - lastCmdAz) >= 0.3) {
      if (send("az", "P " + a.toFixed(1) + " 0")) {
        lastCmdAz = a;
        // Optimistic until poll catches up
        lastAz = a;
        broadcastStatus();
      }
    }
  }

  if (el != null && Number.isFinite(el) && elConnected) {
    let e = Math.max(-5, Math.min(90, el));
    if (lastCmdEl == null || Math.abs(e - lastCmdEl) >= 0.3) {
      if (send("el", "P 0 " + e.toFixed(1))) {
        lastCmdEl = e;
        lastEl = e;
        broadcastStatus();
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

  if (look.el >= config.ROTOR_MIN_EL) {
    commandPosition(look.az, look.el);
  } else {
    const parkAz =
      nextAosAz != null && Number.isFinite(nextAosAz) ? nextAosAz : look.az;
    commandPosition(parkAz, config.ROTOR_PARK_EL);
  }
}

function pollPositions() {
  if (azConnected) {
    azBuf = "";
    send("az", "p");
  }
  if (elConnected) {
    elBuf = "";
    send("el", "p");
  }
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
  connect,
  disconnect,
};
