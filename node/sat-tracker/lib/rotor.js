const net = require("net");
const config = require("./config");

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
let lastMoveAt = 0;
let reconnectTimer = null;
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
    az: lastCmdAz != null ? lastCmdAz : lastAz,
    el: lastCmdEl != null ? lastCmdEl : lastEl,
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

function attachSocket(kind, sock) {
  const isAz = kind === "az";
  sock.setEncoding("utf8");

  sock.on("data", (chunk) => {
    if (isAz) {
      azBuf += chunk;
      if (azBuf.length > 4096) azBuf = azBuf.slice(-1024);
      const m = azBuf.match(/([0-9.+-]+)\s*\n\s*([0-9.+-]+)/);
      if (m) lastAz = parseFloat(m[1]);
    } else {
      elBuf += chunk;
      if (elBuf.length > 4096) elBuf = elBuf.slice(-1024);
      const m = elBuf.match(/([0-9.+-]+)\s*\n\s*([0-9.+-]+)/);
      if (m) {
        const a = parseFloat(m[1]);
        const b = parseFloat(m[2]);
        lastEl = Math.abs(b) > Math.abs(a) ? b : a;
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

  if (antennaOn && (!azConnected || !elConnected)) {
    scheduleReconnect();
  }
}

function disconnect() {
  clearReconnect();
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
      }
    }
  }

  if (el != null && Number.isFinite(el) && elConnected) {
    let e = Math.max(-5, Math.min(90, el));
    if (lastCmdEl == null || Math.abs(e - lastCmdEl) >= 0.3) {
      if (send("el", "P 0 " + e.toFixed(1))) {
        lastCmdEl = e;
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
  if (azConnected) send("az", "p");
  if (elConnected) send("el", "p");
}

function getRotorState() {
  return {
    antennaOn,
    azConnected,
    elConnected,
    az: lastCmdAz != null ? lastCmdAz : lastAz,
    el: lastCmdEl != null ? lastCmdEl : lastEl,
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
