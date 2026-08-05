/**
 * Yaesu GS-232 rotor driver (K3NG, Fox Delta ST2, etc.)
 *
 * Single serial port. Protocol:
 *   C2          → AZ=nnnEL=nnn
 *   Wxxx yyy    → move to az xxx, el yyy
 *   S           → stop
 *   Mxxx        → move azimuth only
 *
 * Config:
 *   ROTOR_TYPE=gs232 | k3ng | foxdelta | gs-232
 *   ROTOR_AZ_DEVICE  (used as the single serial device)
 *   ROTOR_BAUD       (default 9600)
 */

const { SerialPort } = require("serialport");
const config = require("../config");

const meta = {
  id: "gs232",
  label: "GS-232 (K3NG / Fox Delta)",
  ports: 1,
  defaultBaud: 9600,
  defaultDevice: "/dev/ttyACM0",
  hint: "Single USB serial. AZ and EL on one controller.",
  match(cfg) {
    const t = String(
      (cfg && cfg.ROTOR_TYPE) || process.env.ROTOR_TYPE || "rt21",
    ).toLowerCase();
    return (
      t === "gs232" ||
      t === "k3ng" ||
      t === "foxdelta" ||
      t === "gs-232" ||
      t === "gs232a" ||
      t === "gs232b"
    );
  },
};

let antennaOn = false;
let port = null;
let connected = false;
let buf = "";
let busy = false;
let pollTimer = null;
let broadcastFn = () => {};

let az = null;
let el = null;
let lastCmdAz = null;
let lastCmdEl = null;
let azState = "IDLE";
let elState = "IDLE";

let desiredAz = null;
let desiredEl = null;
let nextAosAz = null;
let parkHold = false;
let parkCompleteTimer = null;
const PARK_POLL_MS = 500;
const PARK_MAX_MS = 60000;

function init(opts) {
  if (opts && opts.broadcast) broadcastFn = opts.broadcast;
}

function devicePath() {
  return config.ROTOR_AZ_DEVICE || process.env.ROTOR_DEVICE || "/dev/ttyACM0";
}

function baudRate() {
  const b = parseInt(process.env.ROTOR_BAUD || config.ROTOR_BAUD || "9600", 10);
  return b > 0 ? b : 9600;
}

function statusPayload() {
  return {
    type: "rotor",
    antennaOn,
    azConnected: connected,
    elConnected: connected,
    az,
    el,
    lastCmdAz,
    lastCmdEl,
    azState,
    elState,
    minEl: config.ROTOR_MIN_EL,
    azDevice: devicePath(),
    elDevice: devicePath(),
    driver: meta.id,
  };
}

function broadcastStatus() {
  broadcastFn(statusPayload());
}

function getRotorState() {
  return {
    antennaOn,
    azConnected: connected,
    elConnected: connected,
    az,
    el,
    lastCmdAz,
    lastCmdEl,
    azState,
    elState,
    minEl: config.ROTOR_MIN_EL,
  };
}

function parseC2(text) {
  if (!text) return null;
  const m = String(text).match(
    /AZ\s*=\s*(-?\d+(?:\.\d+)?)\s*EL\s*=\s*(-?\d+(?:\.\d+)?)/i,
  );
  if (!m) return null;
  const a = parseFloat(m[1]);
  const e = parseFloat(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(e)) return null;
  return { az: a, el: e };
}

function writeRaw(data) {
  return new Promise((resolve) => {
    if (!port || !connected) {
      resolve(false);
      return;
    }
    port.write(data, (err) => {
      if (err) {
        console.warn("GS-232 write failed:", err.message);
        resolve(false);
        return;
      }
      port.drain(() => resolve(true));
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendCmd(cmd, waitMs = 300) {
  if (!connected || busy) return null;
  busy = true;
  try {
    buf = "";
    const payload = cmd.endsWith("\r") ? cmd : cmd + "\r";
    const ok = await writeRaw(Buffer.from(payload, "ascii"));
    if (!ok) return null;
    await sleep(waitMs);
    const raw = buf;
    buf = "";
    return raw;
  } finally {
    busy = false;
  }
}

async function queryPosition() {
  const raw = await sendCmd("C2", 350);
  const pos = parseC2(raw);
  if (pos) {
    az = pos.az;
    el = pos.el;
  }
  return pos;
}

async function commandGoto(azDeg, elDeg) {
  if (!connected) return false;
  let a = Math.round(Number(azDeg));
  let e = Math.round(Number(elDeg));
  if (!Number.isFinite(a)) return false;
  if (!Number.isFinite(e)) e = 0;
  if (a < 0) a = 0;
  if (a > 360) a = 360;
  if (e < 0) e = 0;
  if (e > 90) e = 90;

  const cmd =
    "W" + String(a).padStart(3, "0") + " " + String(e).padStart(3, "0");
  const raw = await sendCmd(cmd, 200);
  lastCmdAz = a;
  lastCmdEl = e;
  azState = "MOVING";
  elState = "MOVING";
  console.log("GS-232 CMD", cmd, raw ? raw.trim() : "");
  return true;
}

async function stop() {
  await sendCmd("S", 150);
  azState = "IDLE";
  elState = "IDLE";
}

function openPort() {
  return new Promise((resolve) => {
    if (port && connected) {
      resolve(true);
      return;
    }
    const device = devicePath();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    try {
      const p = new SerialPort({
        path: device,
        baudRate: baudRate(),
        dataBits: 8,
        parity: "none",
        stopBits: 1,
        autoOpen: false,
      });

      p.on("error", (e) => {
        console.warn("GS-232 error:", e.message);
      });

      const timer = setTimeout(() => {
        try {
          p.removeAllListeners("data");
          p.removeAllListeners("close");
          if (p.isOpen) p.close(() => {});
        } catch (_) {}
        console.warn("GS-232 open timeout", device);
        done(false);
      }, 3000);

      p.open((err) => {
        if (err) {
          clearTimeout(timer);
          console.warn("GS-232 open failed:", err.message);
          done(false);
          return;
        }
        clearTimeout(timer);
        port = p;
        connected = true;
        buf = "";

        p.on("data", (chunk) => {
          buf += chunk.toString("ascii");
          if (buf.length > 4096) buf = buf.slice(-1024);
        });
        p.on("close", () => {
          console.log("GS-232 closed");
          connected = false;
          port = null;
          buf = "";
          broadcastStatus();
          if (antennaOn) scheduleReconnect();
        });

        console.log("GS-232 open", device, baudRate());
        setTimeout(() => done(true), 1800);
      });
    } catch (e) {
      console.warn("GS-232 exception:", e.message);
      done(false);
    }
  });
}

function closePort() {
  if (port) {
    try {
      if (port.isOpen) port.close(() => {});
    } catch (_) {}
    port = null;
  }
  connected = false;
  buf = "";
  busy = false;
}

let reconnectTimer = null;
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (!antennaOn) return;
    if (!connected) await openPort();
    broadcastStatus();
    if (antennaOn && !connected) scheduleReconnect();
  }, 3000);
}

function shortestDelta(a, b) {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

function absErr(a, b) {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b))
    return Infinity;
  return Math.abs(shortestDelta(a, b));
}

async function pollLoop() {
  if (!antennaOn || !connected) return;

  await queryPosition();

  if (desiredAz != null && Number.isFinite(desiredAz)) {
    const needAz =
      az == null || absErr(desiredAz, az) >= (config.ROTOR_DEADBAND_DEG || 2.5);
    const needEl =
      desiredEl != null &&
      Number.isFinite(desiredEl) &&
      (el == null ||
        Math.abs(desiredEl - el) >= (config.ROTOR_DEADBAND_DEG || 2.5));

    if (needAz || needEl) {
      const targetEl =
        desiredEl != null && Number.isFinite(desiredEl) ? desiredEl : el || 0;
      await commandGoto(desiredAz, targetEl);
    } else {
      azState = "IDLE";
      elState = "IDLE";
    }
  }

  broadcastStatus();
}

function startPoll() {
  stopPoll();
  const ms = config.ROTOR_POLL_MS || 500;
  pollTimer = setInterval(() => {
    pollLoop().catch((e) => console.warn("GS-232 poll:", e.message));
  }, ms);
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function connect() {
  if (!antennaOn) return;
  await openPort();
  broadcastStatus();
  startPoll();
  if (antennaOn && !connected) scheduleReconnect();
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (parkCompleteTimer) {
    clearTimeout(parkCompleteTimer);
    parkCompleteTimer = null;
  }
  stopPoll();
  antennaOn = false;
  parkHold = false;
  stop().catch(() => {});
  closePort();
  desiredAz = null;
  desiredEl = null;
  broadcastStatus();
  console.log("GS-232 disconnected");
}

function setAntenna(on) {
  console.log("GS-232 setAntenna(" + on + ")");
  if (!on) parkHold = false;
  if (on) {
    antennaOn = true;
    lastCmdAz = null;
    lastCmdEl = null;
    azState = "IDLE";
    elState = "IDLE";
    connect();
  } else {
    disconnect();
  }
  broadcastStatus();
}

function applyEndpointChange() {
  console.log("GS-232 device →", devicePath(), baudRate());
  if (antennaOn) {
    disconnect();
    antennaOn = true;
    connect();
  } else {
    broadcastStatus();
  }
}

function updateTracking(look, aosAz) {
  if (aosAz != null && Number.isFinite(aosAz)) nextAosAz = aosAz;
  if (!antennaOn) return;
  if (parkHold) return;
  if (!look || typeof look.el !== "number" || typeof look.az !== "number")
    return;

  if (look.el >= (config.ROTOR_MIN_EL || 0)) {
    desiredAz = look.az;
    desiredEl = look.el;
  } else {
    desiredAz =
      config.ROTOR_PARK_AZ != null && Number.isFinite(config.ROTOR_PARK_AZ)
        ? config.ROTOR_PARK_AZ
        : nextAosAz != null && Number.isFinite(nextAosAz)
          ? nextAosAz
          : look.az;
    desiredEl =
      config.ROTOR_PARK_EL != null && Number.isFinite(config.ROTOR_PARK_EL)
        ? config.ROTOR_PARK_EL
        : 0;
  }
}

/** Slew to park, then disconnect. Re-enable Antenna to track sat again. */
function park() {
  const paz =
    config.ROTOR_PARK_AZ != null && Number.isFinite(config.ROTOR_PARK_AZ)
      ? config.ROTOR_PARK_AZ
      : 0;
  const pel =
    config.ROTOR_PARK_EL != null && Number.isFinite(config.ROTOR_PARK_EL)
      ? config.ROTOR_PARK_EL
      : 0;
  console.log("GS-232 park → az", paz, "el", pel);
  parkHold = true;
  desiredAz = paz;
  desiredEl = pel;
  if (!antennaOn) setAntenna(true);
  else broadcastStatus();
  watchParkComplete(paz, pel);
}

function watchParkComplete(paz, pel) {
  if (parkCompleteTimer) {
    clearTimeout(parkCompleteTimer);
    parkCompleteTimer = null;
  }
  const started = Date.now();
  const settle = config.ROTOR_SETTLE_DEG != null ? config.ROTOR_SETTLE_DEG : 3;
  const tick = () => {
    parkCompleteTimer = null;
    if (!antennaOn || !parkHold) return;
    const azOk =
      az != null &&
      Number.isFinite(az) &&
      Math.abs(shortestDelta(az, paz)) <= settle;
    const elOk =
      el != null && Number.isFinite(el) && Math.abs(el - pel) <= settle;
    const timedOut = Date.now() - started >= PARK_MAX_MS;
    if ((azOk && elOk) || timedOut) {
      console.log(
        "GS-232 park complete — disconnecting",
        timedOut ? "(timeout)" : "",
        "az",
        az,
        "el",
        el,
      );
      setAntenna(false);
      return;
    }
    parkCompleteTimer = setTimeout(tick, PARK_POLL_MS);
  };
  parkCompleteTimer = setTimeout(tick, 800);
}

function logSample(/* satAz, satEl */) {
  // GS-232 driver does not write a track log (optional later)
}

module.exports = {
  meta,
  init,
  setAntenna,
  updateTracking,
  park,
  getRotorState,
  statusPayload,
  broadcastStatus,
  applyEndpointChange,
  logSample,
};
