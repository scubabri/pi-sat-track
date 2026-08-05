/**
 * Green Heron RT-21 direct serial driver (no hamlib/rotctld).
 *
 * Protocol (confirmed):
 *   Read:  AI1;
 *   Go-to: AP1nnn\r   (no semicolon)
 *
 * State machine per axis:
 *   IDLE → MOVING → SETTLING → IDLE
 *   Command only when IDLE; stall → re-CMD.
 *
 * Config:
 *   ROTOR_TYPE=rt21   (default)
 *   ROTOR_AZ_DEVICE / ROTOR_EL_DEVICE
 */

const fs = require("fs");
const path = require("path");
const { SerialPort } = require("serialport");
const config = require("../config");

const meta = {
  id: "rt21",
  label: "Green Heron RT-21",
  ports: 2,
  defaultBaud: 4800,
  defaultDevice: "/dev/ttyUSB0",
  hint: "Two serial ports — one for AZ, one for EL.",
  match(cfg) {
    const t = String(
      (cfg && cfg.ROTOR_TYPE) || process.env.ROTOR_TYPE || "rt21",
    ).toLowerCase();
    return t === "rt21" || t === "greenheron" || t === "gh" || t === "";
  },
};

const LOG_PATH = path.join(config.CACHE_DIR, "rotor_track.log");

let antennaOn = false;
let pollTimer = null;
let nextAosAz = null;
let logging = false;
let broadcastFn = () => {};

let desiredAz = null;
let desiredEl = null;
/** When true, updateTracking will not override desired az/el (manual Park). */
let parkHold = false;

function makeAxis(name) {
  return {
    name,
    port: null,
    connected: false,
    buf: "",
    pos: null,
    lastPos: null,
    lastCmd: null,
    state: "IDLE",
    stillCount: 0,
    settleUntil: 0,
    moveStartedAt: 0,
    stallRetries: 0,
    busy: false,
  };
}

const az = makeAxis("az");
const el = makeAxis("el");

function init(opts) {
  if (opts && opts.broadcast) broadcastFn = opts.broadcast;
}

function statusPayload() {
  return {
    type: "rotor",
    antennaOn,
    azConnected: az.connected,
    elConnected: el.connected,
    az: az.pos,
    el: el.pos,
    lastCmdAz: az.lastCmd,
    lastCmdEl: el.lastCmd,
    azState: az.state,
    elState: el.state,
    minEl: config.ROTOR_MIN_EL,
    azDevice: config.ROTOR_AZ_DEVICE,
    elDevice: config.ROTOR_EL_DEVICE,
    driver: meta.id,
  };
}

function broadcastStatus() {
  broadcastFn(statusPayload());
}

function shortestDelta(a, b) {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

function absErr(a, b) {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) {
    return Infinity;
  }
  return Math.abs(shortestDelta(a, b));
}

function parseHeading(text) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/[,;>\r\n]/g, " ")
    .trim();
  for (const tok of cleaned.split(/\s+/)) {
    const v = parseFloat(tok);
    if (Number.isFinite(v) && v >= -5 && v <= 360) return v;
  }
  return null;
}

function axisDevice(axis) {
  return axis.name === "az" ? config.ROTOR_AZ_DEVICE : config.ROTOR_EL_DEVICE;
}

function openAxis(axis) {
  return new Promise((resolve) => {
    if (axis.port && axis.connected) {
      resolve(true);
      return;
    }
    const device = axisDevice(axis);
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    try {
      const port = new SerialPort({
        path: device,
        baudRate: config.ROTOR_BAUD,
        dataBits: 8,
        parity: "none",
        stopBits: 1,
        autoOpen: false,
      });

      const timer = setTimeout(() => {
        try {
          port.close();
        } catch (_) {}
        console.warn("Rotor", axis.name.toUpperCase(), "open timeout", device);
        done(false);
      }, 3000);

      port.open((err) => {
        if (err) {
          clearTimeout(timer);
          console.warn(
            "Rotor",
            axis.name.toUpperCase(),
            "open failed:",
            err.message,
          );
          done(false);
          return;
        }
        clearTimeout(timer);
        axis.port = port;
        axis.connected = true;
        axis.buf = "";
        axis.state = "IDLE";
        axis.stillCount = 0;
        axis.stallRetries = 0;

        port.on("data", (chunk) => {
          axis.buf += chunk.toString("ascii");
          if (axis.buf.length > 4096) axis.buf = axis.buf.slice(-1024);
        });
        port.on("close", () => {
          console.log("Rotor", axis.name.toUpperCase(), "closed");
          axis.connected = false;
          axis.port = null;
          axis.buf = "";
          broadcastStatus();
          if (antennaOn) scheduleReconnect();
        });
        port.on("error", (e) => {
          console.warn("Rotor", axis.name.toUpperCase(), "error:", e.message);
        });

        console.log(
          "Rotor",
          axis.name.toUpperCase(),
          "open",
          device,
          config.ROTOR_BAUD,
        );
        done(true);
      });
    } catch (e) {
      console.warn("Rotor", axis.name.toUpperCase(), "exception:", e.message);
      done(false);
    }
  });
}

function closeAxis(axis) {
  if (axis.port) {
    try {
      axis.port.close();
    } catch (_) {}
    axis.port = null;
  }
  axis.connected = false;
  axis.buf = "";
  axis.state = "IDLE";
  axis.busy = false;
}

let reconnectTimer = null;
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (!antennaOn) return;
    if (!az.connected) await openAxis(az);
    if (!el.connected) await openAxis(el);
    broadcastStatus();
    if (antennaOn && (!az.connected || !el.connected)) scheduleReconnect();
  }, 3000);
}

function writeRaw(axis, data) {
  return new Promise((resolve) => {
    if (!axis.port || !axis.connected) {
      resolve(false);
      return;
    }
    axis.port.write(data, (err) => {
      if (err) {
        console.warn("Rotor", axis.name, "write failed:", err.message);
        resolve(false);
        return;
      }
      axis.port.drain(() => resolve(true));
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function queryPos(axis) {
  if (!axis.connected || axis.busy) return axis.pos;
  axis.busy = true;
  try {
    axis.buf = "";
    const ok = await writeRaw(axis, Buffer.from("AI1;", "ascii"));
    if (!ok) return axis.pos;
    await sleep(80);
    const tEnd = Date.now() + 350;
    while (Date.now() < tEnd) {
      if (axis.buf.length) break;
      await sleep(20);
    }
    await sleep(40);
    const raw = axis.buf;
    axis.buf = "";
    const pos = parseHeading(raw);
    if (pos != null) {
      axis.lastPos = axis.pos;
      axis.pos = pos;
    }
    return axis.pos;
  } finally {
    axis.busy = false;
  }
}

async function commandPos(axis, degrees) {
  if (!axis.connected || axis.busy) return false;
  let nnn = Math.round(Number(degrees));
  if (!Number.isFinite(nnn)) return false;
  if (nnn < 0) nnn = 0;
  if (nnn > 360) nnn = 360;

  axis.busy = true;
  try {
    axis.buf = "";
    const cmd = "AP1" + String(nnn).padStart(3, "0") + "\r";
    const ok = await writeRaw(axis, Buffer.from(cmd, "ascii"));
    if (!ok) return false;
    axis.lastCmd = nnn;
    axis.state = "MOVING";
    axis.stillCount = 0;
    axis.settleUntil = 0;
    axis.moveStartedAt = Date.now();
    axis.stallRetries = axis.stallRetries || 0;
    console.log("Rotor CMD", axis.name.toUpperCase(), nnn);
    await sleep(60);
    return true;
  } finally {
    axis.busy = false;
  }
}

async function tickAxis(axis, desired) {
  if (!axis.connected || desired == null || !Number.isFinite(desired)) return;

  const pos = await queryPos(axis);
  if (pos == null) return;

  const dpos =
    axis.lastPos != null ? Math.abs(shortestDelta(axis.lastPos, pos)) : 0;
  const still = dpos < config.ROTOR_STILL_DEG;
  if (still) axis.stillCount += 1;
  else axis.stillCount = 0;

  const now = Date.now();
  const toCmd = axis.lastCmd != null ? absErr(pos, axis.lastCmd) : Infinity;

  if (axis.state === "MOVING") {
    if (
      still &&
      axis.stillCount * config.ROTOR_POLL_MS >= config.ROTOR_STALL_MS &&
      toCmd > config.ROTOR_SETTLE_DEG
    ) {
      if (axis.stallRetries < config.ROTOR_STALL_RETRIES) {
        axis.stallRetries += 1;
        console.warn(
          "Rotor",
          axis.name.toUpperCase(),
          "STALL → re-CMD",
          desired.toFixed(1),
          "retry",
          axis.stallRetries,
        );
        await commandPos(axis, desired);
        return;
      }
      console.warn(
        "Rotor",
        axis.name.toUpperCase(),
        "STALL retries exhausted at",
        pos,
      );
      axis.state = "IDLE";
      axis.stallRetries = 0;
      return;
    }

    if (
      toCmd <= config.ROTOR_SETTLE_DEG &&
      axis.stillCount >= config.ROTOR_STILL_COUNT
    ) {
      axis.state = "SETTLING";
      axis.settleUntil = now + config.ROTOR_SETTLE_BUFFER_MS;
    }
    return;
  }

  if (axis.state === "SETTLING") {
    if (!still) {
      axis.state = "MOVING";
      axis.settleUntil = 0;
      return;
    }
    if (now >= axis.settleUntil) {
      axis.state = "IDLE";
      axis.stallRetries = 0;
      console.log(
        "Rotor",
        axis.name.toUpperCase(),
        "IDLE at",
        pos.toFixed(1),
        "cmd was",
        axis.lastCmd,
      );
    }
    return;
  }

  if (axis.state === "IDLE") {
    const need =
      axis.lastCmd == null
        ? absErr(desired, pos) >= config.ROTOR_DEADBAND_DEG
        : absErr(desired, axis.lastCmd) >= config.ROTOR_DEADBAND_DEG;
    if (need) {
      axis.stallRetries = 0;
      await commandPos(axis, desired);
    }
  }
}

async function pollLoop() {
  if (!antennaOn) return;
  if (az.connected) await tickAxis(az, desiredAz);
  if (el.connected) await tickAxis(el, desiredEl);
  broadcastStatus();
}

function startPoll() {
  stopPoll();
  pollTimer = setInterval(() => {
    pollLoop().catch((e) => console.warn("Rotor poll:", e.message));
  }, config.ROTOR_POLL_MS);
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function connect() {
  if (!antennaOn) return;
  await openAxis(az);
  await openAxis(el);
  broadcastStatus();
  startPoll();
  if (antennaOn && (!az.connected || !el.connected)) scheduleReconnect();
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stopPoll();
  antennaOn = false;
  logging = false;
  closeAxis(az);
  closeAxis(el);
  desiredAz = null;
  desiredEl = null;
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
      "timestamp,sat_az,sat_el,rotor_az,rotor_el,cmd_az,cmd_el,az_state,el_state\n",
    );
    logging = true;
    console.log("Rotor log →", LOG_PATH);
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
        az.pos != null ? az.pos.toFixed(2) : "",
        el.pos != null ? el.pos.toFixed(2) : "",
        az.lastCmd != null ? az.lastCmd.toFixed(2) : "",
        el.lastCmd != null ? el.lastCmd.toFixed(2) : "",
        az.state,
        el.state,
      ].join(",") + "\n";
    fs.appendFileSync(LOG_PATH, line);
  } catch (e) {
    console.warn("Rotor log write failed:", e.message);
  }
}

function setAntenna(on) {
  console.log("Rotor setAntenna(" + on + ")");
  if (!on) parkHold = false;
  if (on) {
    antennaOn = true;
    az.lastCmd = null;
    el.lastCmd = null;
    az.state = "IDLE";
    el.state = "IDLE";
    startLog();
    connect();
  } else {
    disconnect();
  }
  broadcastStatus();
}

function applyEndpointChange() {
  console.log(
    "Rotor devices →",
    config.ROTOR_AZ_DEVICE,
    config.ROTOR_EL_DEVICE,
  );
  if (antennaOn) {
    disconnect();
    antennaOn = true;
    startLog();
    connect();
  } else {
    broadcastStatus();
  }
}

function updateTracking(look, aosAz) {
  if (aosAz != null && Number.isFinite(aosAz)) nextAosAz = aosAz;
  if (!antennaOn) return;
  if (parkHold) return;
  if (!look || typeof look.el !== "number" || typeof look.az !== "number") {
    return;
  }

  if (look.el >= config.ROTOR_MIN_EL) {
    desiredAz = look.az;
    desiredEl = look.el;
  } else {
    // Below horizon: hold profile park position
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

/** Move to profile park AZ/EL and hold until antenna off. */
function park() {
  const paz =
    config.ROTOR_PARK_AZ != null && Number.isFinite(config.ROTOR_PARK_AZ)
      ? config.ROTOR_PARK_AZ
      : 0;
  const pel =
    config.ROTOR_PARK_EL != null && Number.isFinite(config.ROTOR_PARK_EL)
      ? config.ROTOR_PARK_EL
      : 0;
  console.log("Rotor park → az", paz, "el", pel);
  parkHold = true;
  if (!antennaOn) {
    setAntenna(true);
  }
  desiredAz = paz;
  desiredEl = pel;
  broadcastStatus();
}

function getRotorState() {
  return {
    antennaOn,
    azConnected: az.connected,
    elConnected: el.connected,
    az: az.pos,
    el: el.pos,
    lastCmdAz: az.lastCmd,
    lastCmdEl: el.lastCmd,
    azState: az.state,
    elState: el.state,
    minEl: config.ROTOR_MIN_EL,
  };
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
