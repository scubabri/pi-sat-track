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
 *
 * 180° elevation / N-stop:
 *   If remaining path (current→LOS) crosses north, use FLIPPED so AZ
 *   walks the south side and never hits the hard north stop.
 *   Mid-pass acquire past the crossing stays NORMAL.
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
let nextLosAz = null;
let logging = false;
let broadcastFn = () => {};

let desiredAz = null;
let desiredEl = null;
/** When true, updateTracking will not override desired az/el (manual Park). */
let parkHold = false;
/** Below min EL: we have locked heldLosAz for this inter-pass gap. */
let postPassHeld = false;
/** AZ at min-EL LOS for current/last pass — hold here after pass. */
let heldLosAz = null;
/** Hardware EL to hold after LOS (0 normal, ~elMax if flipped). */
let heldHoldEl = 0;
/** True after we commanded preposition for upcoming AOS. */
let prepositioned = false;
/** Engage or sat-switch while on → preposition now (not only T-5). */
let forceImmediatePrep = false;
/** Sat key for which heldLosAz applies — reset on sat change. */
let holdSatKey = null;
let parkCompleteTimer = null;
const PARK_POLL_MS = 500;
const PARK_MAX_MS = 60000;
/** Suppress scheduleReconnect while we are intentionally closing ports. */
let intentionalClose = false;
/** Monotonic id so park-complete watches from old sessions cannot fire. */
let parkSession = 0;
/**
 * 180° EL support: when true, command (az+180, 180-el) instead of (az, el).
 * Locked for the whole pass once chosen (modeLocked).
 */
let flipped = false;
/** Once true, keep normal/flipped for the whole pass (until below min el). */
let modeLocked = false;
/** Hardware EL range from profile (90 or 180). */
function elMax() {
  const m = Number(config.ROTOR_EL_MAX);
  return m === 90 ? 90 : 180;
}
function flipEnabled() {
  return !azOnly() && elMax() >= 180;
}

/** Fixed-elevation / AZ-only rotator — never open or command EL. */
function azOnly() {
  return config.ROTOR_AZ_ONLY === true;
}
/** USB serial needs a beat after close before reopen (avoids false open timeouts). */
let portsReadyUntil = 0;
const PORT_REOPEN_COOLDOWN_MS = 1200;
/** Small gap between AZ and EL open — dual USB-serial adapters often need it. */
const PORT_OPEN_STAGGER_MS = 400;

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
    elConnected: azOnly() ? true : el.connected,
    azOnly: azOnly(),
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
    flipped,
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
  return new Promise(async (resolve) => {
    if (axis.port && axis.connected) {
      resolve(true);
      return;
    }
    const wait = portsReadyUntil - Date.now();
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
    if (!antennaOn) {
      resolve(false);
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

      port.on("error", (e) => {
        console.warn("Rotor", axis.name.toUpperCase(), "error:", e.message);
      });

      const timer = setTimeout(() => {
        try {
          port.removeAllListeners("data");
          port.removeAllListeners("close");
          if (port.isOpen) {
            intentionalClose = true;
            port.close(() => {
              intentionalClose = false;
            });
          }
        } catch (_) {
          intentionalClose = false;
        }
        console.warn("Rotor", axis.name.toUpperCase(), "open timeout", device);
        done(false);
      }, 5000);

      port.open((err) => {
        if (settled) {
          if (!err && port.isOpen) {
            try {
              intentionalClose = true;
              port.close(() => {
                intentionalClose = false;
              });
            } catch (_) {
              intentionalClose = false;
            }
          }
          return;
        }
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
        axis.pos = null;
        axis.lastPos = null;
        axis.lastCmd = null;

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
          if (antennaOn && !intentionalClose) scheduleReconnect();
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
      if (axis.port.isOpen) {
        intentionalClose = true;
        axis.port.close(() => {
          intentionalClose = false;
        });
      }
    } catch (_) {
      intentionalClose = false;
    }
    axis.port = null;
  }
  axis.connected = false;
  axis.buf = "";
  axis.state = "IDLE";
  axis.busy = false;
  axis.pos = null;
  axis.lastPos = null;
  axis.lastCmd = null;
  axis.stillCount = 0;
  axis.stallRetries = 0;
}

let reconnectTimer = null;
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (!antennaOn) return;
    if (!az.connected) await openAxis(az);
    if (!azOnly() && !el.connected) await openAxis(el);
    broadcastStatus();
    const needEl = !azOnly() && !el.connected;
    if (antennaOn && (!az.connected || needEl)) scheduleReconnect();
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
  if (axis.name === "el") {
    if (nnn > elMax()) nnn = elMax();
  } else if (nnn > 360) {
    nnn = 360;
  }

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
    axis.lastPos != null
      ? axis.name === "el"
        ? Math.abs(axis.lastPos - pos)
        : Math.abs(shortestDelta(axis.lastPos, pos))
      : 0;
  const still = dpos < config.ROTOR_STILL_DEG;
  if (still) axis.stillCount += 1;
  else axis.stillCount = 0;

  const now = Date.now();
  const toCmd =
    axis.lastCmd != null
      ? axis.name === "el"
        ? Math.abs(pos - axis.lastCmd)
        : absErr(pos, axis.lastCmd)
      : Infinity;

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
    const err = (a, b) => {
      if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b))
        return Infinity;
      return axis.name === "el" ? Math.abs(a - b) : absErr(a, b);
    };
    const need =
      axis.lastCmd == null
        ? err(desired, pos) >= config.ROTOR_DEADBAND_DEG
        : err(desired, axis.lastCmd) >= config.ROTOR_DEADBAND_DEG;
    if (need) {
      axis.stallRetries = 0;
      await commandPos(axis, desired);
    }
  }
}

async function pollLoop() {
  if (!antennaOn) return;
  if (az.connected) await tickAxis(az, desiredAz);
  if (!azOnly() && el.connected) await tickAxis(el, desiredEl);
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
  if (!antennaOn) return;
  if (!azOnly()) {
    if (PORT_OPEN_STAGGER_MS > 0) {
      await new Promise((r) => setTimeout(r, PORT_OPEN_STAGGER_MS));
    }
    if (!antennaOn) return;
    await openAxis(el);
  } else {
    // Ensure EL stays closed in AZ-only mode
    if (el.connected) closeAxis(el);
    console.log("Rotor AZ-only — elevation not commanded");
  }
  broadcastStatus();
  startPoll();
  const needEl = !azOnly() && !el.connected;
  if (antennaOn && (!az.connected || needEl)) scheduleReconnect();
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
  parkSession += 1;
  stopPoll();
  antennaOn = false;
  parkHold = false;
  logging = false;
  intentionalClose = true;
  closeAxis(az);
  closeAxis(el);
  portsReadyUntil = Date.now() + PORT_REOPEN_COOLDOWN_MS;
  setTimeout(() => {
    intentionalClose = false;
  }, 150);
  desiredAz = null;
  desiredEl = null;
  flipped = false;
  modeLocked = false;
  // keep nextAosAz / nextLosAz for next preposition
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
  if (on) {
    // Always preposition for the selected sat when antenna is engaged.
    forceImmediatePrep = true;
    postPassHeld = false;
    prepositioned = false;
  } else {
    parkHold = false;
    postPassHeld = false;
    prepositioned = false;
    forceImmediatePrep = false;
    heldLosAz = null;
    heldHoldEl = 0;
    holdSatKey = null;
  }
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

function normalizeAz(a) {
  return ((Number(a) % 360) + 360) % 360;
}

/** "north" (0°) or "south" (180°) mechanical AZ stop — from config. */
function azStop() {
  const s = String(
    (config && config.ROTOR_AZ_STOP) || process.env.ROTOR_AZ_STOP || "north",
  ).toLowerCase();
  return s === "south" || s === "s" ? "south" : "north";
}

/**
 * True if the shortest path from→to would cross the configured AZ stop.
 * N-stop: 10°→350° short path crosses north → must go long way / flip.
 * S-stop: 170°→190° short path crosses south → long way / flip.
 */
function shortestPathCrossesStop(fromAz, toAz) {
  const a = normalizeAz(fromAz);
  const b = normalizeAz(toAz);
  const cw = (b - a + 360) % 360;
  const ccw = (a - b + 360) % 360;
  if (Math.min(cw, ccw) < 0.5) return false;
  if (azStop() === "south") {
    if (cw <= ccw) return a < 180 && a + cw > 180;
    return a > 180 && a - ccw < 180;
  }
  // north stop @ 0/360
  if (cw <= ccw) return a + cw >= 360;
  return a - ccw <= 0;
}

/** @deprecated name — use shortestPathCrossesStop */
function shortestPathCrossesNorth(fromAz, toAz) {
  return shortestPathCrossesStop(fromAz, toAz);
}

function pointingCandidates(satAz, satEl) {
  const e = Math.max(0, Math.min(90, Number(satEl)));
  return [
    { az: normalizeAz(satAz), el: e, flipped: false },
    { az: normalizeAz(Number(satAz) + 180), el: elMax() - e, flipped: true },
  ];
}

function motionCost(fromAz, fromEl, toAz, toEl) {
  const dAz =
    fromAz != null && Number.isFinite(fromAz)
      ? Math.abs(shortestDelta(fromAz, toAz))
      : 0;
  const dEl =
    fromEl != null && Number.isFinite(fromEl) ? Math.abs(fromEl - toEl) : 0;
  return dAz * 1.5 + dEl;
}

/**
 * True when the pass geometry forces an AZ path across the configured stop
 * (N @ 0° or S @ 180°, from ROTOR_AZ_STOP). With a hard-stop RT-21 we start
 * FLIPPED so AZ walks the long way and never hits the stop.
 */
function passCrossesNorthStop(aosAz, losAz) {
  if (aosAz == null || losAz == null) return false;
  if (!Number.isFinite(aosAz) || !Number.isFinite(losAz)) return false;
  return shortestPathCrossesStop(aosAz, losAz);
}

/**
 * Choose mode when antenna is engaged mid-pass or at AOS:
 *   1. Prefer remaining path (current sat AZ → LOS). If that does NOT
 *      cross the AZ stop, stay NORMAL even if the full AOS→LOS pass did —
 *      the sat is already past the stop crossing.
 *   2. If remaining path crosses the stop → FLIPPED.
 *   3. If no LOS yet, fall back to AOS→current.
 *   4. If rotor is already over-top (EL>100), pick cheaper candidate.
 */
function chooseInitialMode(satAz, satEl) {
  if (!flipEnabled()) {
    flipped = false;
    return;
  }
  // Mid-pass / current→LOS: only flip if the REMAINING track crosses N
  if (nextLosAz != null && Number.isFinite(nextLosAz)) {
    if (passCrossesNorthStop(satAz, nextLosAz)) {
      flipped = true;
      return;
    }
    // Remaining path is clear of AZ stop → NORMAL (past the crossing)
    if (el.pos != null && Number.isFinite(el.pos) && el.pos > 100) {
      const cands = pointingCandidates(satAz, satEl);
      const costN = motionCost(az.pos, el.pos, cands[0].az, cands[0].el);
      const costF = motionCost(az.pos, el.pos, cands[1].az, cands[1].el);
      flipped = costF + 15 < costN;
      return;
    }
    flipped = false;
    return;
  }

  // No LOS yet — use AOS→current as a stand-in
  const aos =
    nextAosAz != null && Number.isFinite(nextAosAz) ? nextAosAz : satAz;
  if (passCrossesNorthStop(aos, satAz)) {
    flipped = true;
    return;
  }
  if (el.pos != null && Number.isFinite(el.pos) && el.pos > 100) {
    const cands = pointingCandidates(satAz, satEl);
    const costN = motionCost(az.pos, el.pos, cands[0].az, cands[0].el);
    const costF = motionCost(az.pos, el.pos, cands[1].az, cands[1].el);
    flipped = costF + 15 < costN;
    return;
  }
  flipped = false;
}

function applyMode(satAz, satEl) {
  const e = Math.max(0, Math.min(90, Number(satEl)));
  if (flipped) {
    desiredAz = normalizeAz(Number(satAz) + 180);
    desiredEl = elMax() - e;
  } else {
    desiredAz = normalizeAz(satAz);
    desiredEl = e;
  }
}

/**
 * AZ-stop over-the-top (N or S per ROTOR_AZ_STOP):
 *   Mode is chosen from the remaining path (current→LOS) so mid-pass
 *   acquires past the stop crossing stay NORMAL.
 *   Below-horizon preposition still uses full AOS→LOS.
 */
function updateTracking(look, aosAz, losAz, meta) {
  meta = meta || {};
  if (aosAz != null && Number.isFinite(aosAz)) nextAosAz = aosAz;
  if (losAz != null && Number.isFinite(losAz)) nextLosAz = losAz;
  if (!antennaOn) return;
  if (parkHold) return;
  if (!look || typeof look.el !== "number" || typeof look.az !== "number") {
    return;
  }

  const minEl =
    meta.minEl != null && Number.isFinite(meta.minEl)
      ? meta.minEl
      : config.ROTOR_MIN_EL != null
        ? config.ROTOR_MIN_EL
        : 0;
  const nextAosMs =
    meta.nextAosMs != null && Number.isFinite(meta.nextAosMs)
      ? meta.nextAosMs
      : null;
  const nextAosAzMeta =
    meta.nextAosAz != null && Number.isFinite(meta.nextAosAz)
      ? meta.nextAosAz
      : null;
  const nextLosAzMeta =
    meta.nextLosAz != null && Number.isFinite(meta.nextLosAz)
      ? meta.nextLosAz
      : null;
  const satKey = meta.satKey != null ? String(meta.satKey) : null;
  if (satKey && holdSatKey && satKey !== holdSatKey) {
    // Sat switched while engaged → preposition for the new sat immediately
    postPassHeld = false;
    prepositioned = false;
    forceImmediatePrep = true;
    heldLosAz = null;
    heldHoldEl = 0;
    modeLocked = false;
    flipped = false;
  }
  if (satKey) holdSatKey = satKey;

  if (look.el >= minEl) {
    postPassHeld = false;
    prepositioned = false;
    forceImmediatePrep = false;
    if (!modeLocked) {
      chooseInitialMode(look.az, look.el);
      modeLocked = true;
      console.log(
        "Rotor mode",
        flipped ? "FLIPPED (stop over-top)" : "NORMAL",
        "sat az",
        look.az.toFixed(1),
        "el",
        look.el.toFixed(1),
        "aos",
        nextAosAz != null ? Number(nextAosAz).toFixed(1) : "-",
        "los",
        nextLosAz != null ? Number(nextLosAz).toFixed(1) : "-",
        "elMax",
        elMax(),
      );
    }
    applyMode(look.az, look.el);
    return;
  }

  // ----- Below min EL -----
  // Freeze hardware aim. Priority:
  //  1) Last commanded point from this pass (includes FLIPPED az/el)
  //  2) Current encoder position if antenna was just enabled mid-gap
  // Never slew to below-horizon sky look.az — that yanked AZ to random az.
  if (!postPassHeld) {
    if (desiredAz != null && Number.isFinite(desiredAz)) {
      heldLosAz = normalizeAz(desiredAz);
      heldHoldEl =
        desiredEl != null && Number.isFinite(desiredEl)
          ? Math.max(0, Math.min(elMax(), Number(desiredEl)))
          : flipped
            ? elMax()
            : 0;
    } else if (az.pos != null && Number.isFinite(az.pos)) {
      heldLosAz = normalizeAz(az.pos);
      heldHoldEl =
        el.pos != null && Number.isFinite(el.pos)
          ? Math.max(0, Math.min(elMax(), Number(el.pos)))
          : 0;
    } else if (flipped && nextLosAz != null && Number.isFinite(nextLosAz)) {
      heldLosAz = normalizeAz(Number(nextLosAz) + 180);
      heldHoldEl = elMax();
    } else {
      // No command, no encoder yet — do not invent a target from sky az.
      heldLosAz = null;
      heldHoldEl = 0;
    }
    postPassHeld = true;
    console.log(
      "Rotor below min EL — hold hardware az",
      heldLosAz != null ? Number(heldLosAz).toFixed(1) : "(stay)",
      "el",
      heldLosAz != null ? Number(heldHoldEl).toFixed(1) : "-",
      flipped ? "(was FLIPPED)" : "(NORMAL)",
      "— no slew to next AOS until T-5 min",
    );
  }
  modeLocked = false;

  // Preposition to next AOS (with flip if AOS→LOS crosses AZ stop) when:
  //  • antenna just engaged, or sat switched while engaged (forceImmediatePrep)
  //  • same sat left engaged after LOS and we are within T-5 of next AOS
  const PREP_MS = 5 * 60 * 1000;
  const nowMs = Date.now();
  const haveNext =
    nextAosMs != null &&
    nextAosAzMeta != null &&
    Number.isFinite(nextAosMs) &&
    Number.isFinite(nextAosAzMeta) &&
    nextAosMs > nowMs;
  const withinT5 = haveNext && nextAosMs - nowMs <= PREP_MS;
  const doPrep = haveNext && (forceImmediatePrep || withinT5);

  if (doPrep) {
    const aosN = normalizeAz(nextAosAzMeta);
    let useFlip = false;
    if (
      flipEnabled() &&
      nextLosAzMeta != null &&
      Number.isFinite(nextLosAzMeta) &&
      passCrossesNorthStop(aosN, nextLosAzMeta)
    ) {
      useFlip = true;
    }
    flipped = useFlip;
    modeLocked = true;
    const azN = useFlip ? normalizeAz(aosN + 180) : aosN;
    const elN = useFlip ? elMax() : 0;
    const secs = Math.round((nextAosMs - nowMs) / 1000);
    const why = forceImmediatePrep
      ? withinT5
        ? "engage/switch (also ≤T-5)"
        : "engage/switch"
      : "T-5";
    if (
      !prepositioned ||
      desiredAz == null ||
      Math.abs(shortestDelta(desiredAz, azN)) >= 1 ||
      (desiredEl != null && Math.abs(desiredEl - elN) >= 1)
    ) {
      console.log(
        "Rotor preposition",
        why,
        "next AOS in",
        secs + "s → az",
        azN.toFixed(1),
        "el",
        elN,
        useFlip ? "FLIPPED (AOS→LOS crosses AZ stop)" : "NORMAL",
      );
    }
    forceImmediatePrep = false;
    prepositioned = true;
    postPassHeld = true;
    heldLosAz = azN;
    heldHoldEl = elN;
    desiredAz = azN;
    desiredEl = elN;
    return;
  }

  // Waiting for pass meta after engage/switch — do not freeze a bad sky az.
  if (forceImmediatePrep) {
    return;
  }

  // Same sat, engaged, after LOS, next AOS further than T-5: hold last hardware.
  if (heldLosAz != null && Number.isFinite(heldLosAz)) {
    desiredAz = heldLosAz;
    desiredEl =
      heldHoldEl != null && Number.isFinite(heldHoldEl) ? heldHoldEl : 0;
  }
}

function park() {
  postPassHeld = false;
  prepositioned = false;
  forceImmediatePrep = false;
  heldLosAz = null;
  heldHoldEl = 0;
  holdSatKey = null;
  const paz =
    config.ROTOR_PARK_AZ != null && Number.isFinite(config.ROTOR_PARK_AZ)
      ? config.ROTOR_PARK_AZ
      : 0;
  const pel =
    config.ROTOR_PARK_EL != null && Number.isFinite(config.ROTOR_PARK_EL)
      ? config.ROTOR_PARK_EL
      : 0;
  console.log("Rotor park → az", paz, "el", pel);

  parkSession += 1;
  const session = parkSession;

  parkHold = true;
  flipped = false;
  modeLocked = false;
  desiredAz = paz;
  desiredEl = Math.max(0, Math.min(elMax(), pel));

  az.lastCmd = null;
  el.lastCmd = null;
  az.state = "IDLE";
  el.state = "IDLE";

  if (!antennaOn) {
    setAntenna(true);
  } else {
    broadcastStatus();
  }
  watchParkComplete(session, paz, pel);
}

function watchParkComplete(session, paz, pel) {
  if (parkCompleteTimer) {
    clearTimeout(parkCompleteTimer);
    parkCompleteTimer = null;
  }
  const started = Date.now();
  const settle = config.ROTOR_SETTLE_DEG != null ? config.ROTOR_SETTLE_DEG : 3;

  const tick = () => {
    parkCompleteTimer = null;
    if (session !== parkSession) return;
    if (!antennaOn || !parkHold) return;

    const live = az.connected && (azOnly() || el.connected);
    const azOk =
      live &&
      az.pos != null &&
      Number.isFinite(az.pos) &&
      Math.abs(shortestDelta(az.pos, paz)) <= settle;
    const elOk = azOnly()
      ? true
      : live &&
        el.pos != null &&
        Number.isFinite(el.pos) &&
        Math.abs(el.pos - pel) <= settle;
    const idle = az.state === "IDLE" && (azOnly() || el.state === "IDLE");
    const timedOut = Date.now() - started >= PARK_MAX_MS;

    if ((azOk && elOk && idle) || timedOut) {
      console.log(
        "Rotor park complete — disconnecting",
        timedOut ? "(timeout)" : "",
        "az",
        az.pos,
        "el",
        el.pos,
      );
      setAntenna(false);
      return;
    }
    parkCompleteTimer = setTimeout(tick, PARK_POLL_MS);
  };

  parkCompleteTimer = setTimeout(tick, 1500);
}

function getRotorState() {
  return {
    antennaOn,
    azConnected: az.connected,
    elConnected: azOnly() ? true : el.connected,
    az: az.pos,
    el: azOnly() ? null : el.pos,
    lastCmdAz: az.lastCmd,
    lastCmdEl: azOnly() ? null : el.lastCmd,
    azState: az.state,
    elState: azOnly() ? "N/A" : el.state,
    minEl: config.ROTOR_MIN_EL,
    flipped: azOnly() ? false : flipped,
    azOnly: azOnly(),
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
