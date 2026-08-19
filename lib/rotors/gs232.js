/**
 * Yaesu GS-232 rotor driver (K3NG, Fox Delta ST2, etc.)
 *
 * Single serial port. Protocol:
 *   C2          → +0xxx+0yyy (Fox Delta ST2) or AZ=nnnEL=nnn (Yaesu/K3NG)
 *   Wxxx yyy    → move to az xxx, el yyy (often NO serial ACK — write OK = issued)
 *   S           → stop
 *   Mxxx        → move azimuth only
 *
 * Fox Delta / many GS-232 clones never ACK W. We treat port write+drain as
 * "command issued", poll C2 for progress, and only re-issue W when position
 * feedback shows we are still outside the deadband (not when C2 is missing).
 *
 * 180° EL / N-stop or S-stop flip (when ROTOR_EL_MAX=180): same geometry as RT-21 —
 * FLIPPED commands (az+180, 180-el) so AZ never walks across the configured stop.
 *
 * Config:
 *   ROTOR_TYPE=gs232 | k3ng | foxdelta | gs-232
 *   ROTOR_AZ_DEVICE  (used as the single serial device)
 *   ROTOR_BAUD       (default 9600)
 *   ROTOR_AZ_STOP    north (default) | south — never command across this stop
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

function azOnly() {
  return config.ROTOR_AZ_ONLY === true;
}
let nextAosAz = null;
let nextLosAz = null;
let parkHold = false;
/** Below min EL: we have locked heldLosAz for this inter-pass gap. */
let postPassHeld = false;
/** AZ at min-EL LOS for current/last pass — hold here after pass. */
let heldLosAz = null;
/** Hardware EL to hold after LOS (0 normal, ~elMax if flipped). */
let heldHoldEl = 0;
/** True after we commanded preposition for upcoming AOS. */
let prepositioned = false;
/** Sat key for which heldLosAz applies — reset on sat change. */
let holdSatKey = null;
let parkCompleteTimer = null;
const PARK_POLL_MS = 500;
const PARK_MAX_MS = 60000;

/**
 * 180° EL support: when true, command (az+180, elMax-el) instead of (az, el).
 * Locked for the whole pass once chosen (modeLocked).
 */
let flipped = false;
let modeLocked = false;

function elMax() {
  const m = Number(config.ROTOR_EL_MAX);
  return m === 90 ? 90 : 180;
}
function flipEnabled() {
  return !azOnly() && elMax() >= 180;
}

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
    flipped: azOnly() ? false : flipped,
    elMax: elMax(),
  };
}

function broadcastStatus() {
  broadcastFn(statusPayload());
}

function getRotorState() {
  return {
    antennaOn,
    azConnected: connected,
    elConnected: azOnly() ? true : connected,
    az,
    el: azOnly() ? null : el,
    lastCmdAz,
    lastCmdEl: azOnly() ? null : lastCmdEl,
    azState,
    elState: azOnly() ? "N/A" : elState,
    minEl: config.ROTOR_MIN_EL,
    azOnly: azOnly(),
    flipped: azOnly() ? false : flipped,
    elMax: elMax(),
  };
}

function parseC2(text) {
  if (!text) return null;
  // Strip NULs / non-printables Fox Delta sometimes prepends
  const s = String(text)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .trim();
  if (!s) return null;

  // Yaesu-style: AZ=090EL=030 or AZ=90 EL=30
  let m = s.match(
    /AZ\s*=?\s*([+-]?\d+(?:\.\d+)?)\s*EL\s*=?\s*([+-]?\d+(?:\.\d+)?)/i,
  );
  if (m) {
    const a = parseFloat(m[1]);
    const e = parseFloat(m[2]);
    if (Number.isFinite(a) && Number.isFinite(e)) return { az: a, el: e };
  }

  // Fox Delta ST2 / LVBTracker C2: "+0163+0176" (sign + 3–4 digits each)
  // Must run before a naive digit split or "+0163" is read as 16.
  m = s.match(/([+-]\d{3,4})\s*([+-]\d{3,4})/);
  if (m) {
    const a = parseFloat(m[1]);
    const e = parseFloat(m[2]);
    if (
      Number.isFinite(a) &&
      Number.isFinite(e) &&
      a >= -5 &&
      a <= 450 &&
      e >= -5 &&
      e <= 180
    ) {
      return { az: a, el: e };
    }
  }

  // Spaced / plain numbers: "163 176", "090,030"
  let nums = s.match(/([+-]?\d+(?:\.\d+)?)/g);
  if (nums && nums.length >= 2) {
    const a = parseFloat(nums[0]);
    const e = parseFloat(nums[1]);
    if (
      Number.isFinite(a) &&
      Number.isFinite(e) &&
      a >= -5 &&
      a <= 450 &&
      e >= -5 &&
      e <= 180
    ) {
      return { az: a, el: e };
    }
  }
  return null;
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

let c2ParseFailLogged = 0;

async function sendCmd(cmd, waitMs = 300) {
  if (!connected) return { ok: false, raw: null, busy: false };
  if (busy) return { ok: false, raw: null, busy: true }; // overlap — not a serial error
  busy = true;
  try {
    buf = "";
    const payload = cmd.endsWith("\r") ? cmd : cmd + "\r";
    const wrote = await writeRaw(Buffer.from(payload, "ascii"));
    if (!wrote) return { ok: false, raw: null, busy: false };
    await sleep(waitMs);
    const raw = buf;
    buf = "";
    // ok = serial write succeeded. Reply may be empty (Fox Delta W has no ACK).
    return { ok: true, raw, busy: false };
  } finally {
    busy = false;
  }
}

async function queryPosition() {
  const res = await sendCmd("C2", 400);
  if (!res.ok) return null;
  const raw = res.raw;
  const pos = parseC2(raw);
  if (pos) {
    az = pos.az;
    el = pos.el;
    lastFbAz = pos.az;
    lastFbEl = pos.el;
    lastFbAt = Date.now();
    c2ParseFailLogged = 0;
  } else if (
    raw &&
    String(raw)
      .replace(/[\x00-\x1f]/g, "")
      .trim()
  ) {
    // Throttle: log a few times then stay quiet
    if (c2ParseFailLogged < 5) {
      c2ParseFailLogged += 1;
      console.warn(
        "GS-232 C2 parse fail raw:",
        JSON.stringify(String(raw).slice(0, 100)),
      );
    }
  }
  return pos;
}

/**
 * Issue W command. Success = serial write+drain OK.
 * Fox Delta typically returns no ACK; empty raw is normal.
 */
async function commandGoto(azDeg, elDeg) {
  if (!connected) return false;
  let a = Math.round(Number(azDeg));
  let e = Math.round(Number(elDeg));
  if (!Number.isFinite(a)) return false;
  if (!Number.isFinite(e)) e = 0;
  // Never command past mechanical AZ ends (0 / 360). No 361 or -1.
  if (a < 0) a = 0;
  if (a > 360) a = 360;
  if (e < 0) e = 0;
  const eHi = elMax();
  if (e > eHi) e = eHi;

  const cmd =
    "W" + String(a).padStart(3, "0") + " " + String(e).padStart(3, "0");
  const res = await sendCmd(cmd, 150);
  if (!res.ok) {
    if (res.busy) {
      // Another C2/W in flight — skip; next poll will retry
      return false;
    }
    console.warn("GS-232 CMD write failed", cmd);
    return false;
  }
  lastCmdAz = a;
  lastCmdEl = e;
  lastGotoAt = Date.now();
  azState = "MOVING";
  elState = "MOVING";
  const reply =
    res.raw &&
    String(res.raw)
      .replace(/[\x00-\x1f]/g, "")
      .trim();
  // Log once per distinct target (relay spam is the W reissue, not the log)
  if (lastLoggedCmd !== cmd) {
    lastLoggedCmd = cmd;
    if (reply) {
      console.log("GS-232 CMD", cmd, "reply:", reply.slice(0, 60));
    } else {
      console.log(
        "GS-232 CMD",
        cmd,
        "(no ACK — normal for Fox Delta; polling C2)",
      );
    }
  }
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

function normalizeAz(a) {
  return ((Number(a) % 360) + 360) % 360;
}

function shortestDelta(a, b) {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

/** "north" (0°) or "south" (180°) mechanical AZ stop. */
function azStop() {
  const s = String(
    (config && config.ROTOR_AZ_STOP) || process.env.ROTOR_AZ_STOP || "north",
  ).toLowerCase();
  return s === "south" || s === "s" ? "south" : "north";
}

/**
 * True if the shortest path from→to would cross the configured AZ stop.
 * N-stop @ 0/360: e.g. 10°→350° short path crosses north → must go long way.
 * S-stop @ 180: e.g. 170°→190° short path crosses south → long way.
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
  // north stop
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

function passCrossesNorthStop(aosAz, losAz) {
  if (aosAz == null || losAz == null) return false;
  if (!Number.isFinite(aosAz) || !Number.isFinite(losAz)) return false;
  return shortestPathCrossesStop(aosAz, losAz);
}

/**
 * Choose NORMAL vs FLIPPED when antenna engages for a pass.
 * Prefer remaining path (current→LOS); if that crosses N → FLIPPED.
 */
function chooseInitialMode(satAz, satEl) {
  if (!flipEnabled()) {
    flipped = false;
    return;
  }
  if (nextLosAz != null && Number.isFinite(nextLosAz)) {
    if (passCrossesNorthStop(satAz, nextLosAz)) {
      flipped = true;
      return;
    }
    if (el != null && Number.isFinite(el) && el > 100) {
      const cands = pointingCandidates(satAz, satEl);
      const costN = motionCost(az, el, cands[0].az, cands[0].el);
      const costF = motionCost(az, el, cands[1].az, cands[1].el);
      flipped = costF + 15 < costN;
      return;
    }
    flipped = false;
    return;
  }
  const aos =
    nextAosAz != null && Number.isFinite(nextAosAz) ? nextAosAz : satAz;
  if (passCrossesNorthStop(aos, satAz)) {
    flipped = true;
    return;
  }
  if (el != null && Number.isFinite(el) && el > 100) {
    const cands = pointingCandidates(satAz, satEl);
    const costN = motionCost(az, el, cands[0].az, cands[0].el);
    const costF = motionCost(az, el, cands[1].az, cands[1].el);
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

function absErr(a, b) {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b))
    return Infinity;
  return Math.abs(shortestDelta(a, b));
}

let lastGotoAt = 0;
let pollInFlight = false;
let lastFbAt = 0;
let lastFbAz = null;
let lastFbEl = null;
let lastLoggedCmd = null;
/** Re-issue W only when C2 feedback shows we are still off target. */
const GOTO_REISSUE_MS = 4000;
/**
 * With no C2 feedback: do not spam W. One issue per target is enough
 * (Fox Delta moves without ACK). Rare retry only after this long.
 */
const GOTO_NO_FEEDBACK_REISSUE_MS = 20000;
/** After a no-feedback W, mark IDLE so UI stops looking stuck. */
const GOTO_NO_FEEDBACK_IDLE_MS = 6000;

function sameGotoTarget(wantAz, wantEl) {
  if (lastCmdAz == null) return false;
  if (Math.abs(lastCmdAz - Math.round(wantAz)) >= 1) return false;
  if (azOnly()) return true;
  if (wantEl == null || !Number.isFinite(wantEl)) return true;
  if (lastCmdEl == null) return false;
  return Math.abs(lastCmdEl - Math.round(wantEl)) < 1;
}

async function pollLoop() {
  if (!antennaOn || !connected) return;
  if (pollInFlight) return; // prevent overlap → false "write failed"
  pollInFlight = true;
  try {
    // Always poll position — independent of whether W returned an ACK
    await queryPosition();

    if (desiredAz != null && Number.isFinite(desiredAz)) {
      const dead = config.ROTOR_DEADBAND_DEG || 2.5;
      const targetEl = azOnly()
        ? 0
        : desiredEl != null && Number.isFinite(desiredEl)
          ? desiredEl
          : el != null
            ? el
            : 0;

      const hasAzFb = az != null && Number.isFinite(az);
      const hasElFb = azOnly() || (el != null && Number.isFinite(el));
      const hasFeedback = hasAzFb && hasElFb;

      const now = Date.now();
      const same = sameGotoTarget(desiredAz, targetEl);

      // Live C2 only if a parse succeeded *after* the last W.
      // Stale/echo feedback must not re-fire W every 4s (relay click).
      const fbLive = hasFeedback && lastFbAt > lastGotoAt;

      if (fbLive) {
        const needAz = absErr(desiredAz, az) >= dead;
        const needEl =
          !azOnly() &&
          desiredEl != null &&
          Number.isFinite(desiredEl) &&
          Math.abs(desiredEl - el) >= dead;

        if (!needAz && !needEl) {
          azState = "IDLE";
          elState = azOnly() ? "N/A" : "IDLE";
        } else if (!(same && now - lastGotoAt < GOTO_REISSUE_MS)) {
          await commandGoto(desiredAz, targetEl);
        }
      } else {
        // Fox Delta typical: no usable live C2 — one W per target change
        if (!same) {
          await commandGoto(desiredAz, targetEl);
        } else if (now - lastGotoAt >= GOTO_NO_FEEDBACK_IDLE_MS) {
          azState = "IDLE";
          elState = azOnly() ? "N/A" : "IDLE";
        }
        // Never timer-reissue the same W without live feedback
      }
    }

    broadcastStatus();
  } finally {
    pollInFlight = false;
  }
}

function startPoll() {
  stopPoll();
  // Default 1000ms: C2 wait is ~400ms; 500ms poll overlaps and trips busy
  const ms = config.ROTOR_POLL_MS || 1000;
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
  flipped = false;
  modeLocked = false;
  broadcastStatus();
  console.log("GS-232 disconnected");
}

function setAntenna(on) {
  console.log("GS-232 setAntenna(" + on + ")");
  if (!on) {
    parkHold = false;
    postPassHeld = false;
    prepositioned = false;
    heldLosAz = null;
    heldHoldEl = 0;
    holdSatKey = null;
  }
  if (on) {
    antennaOn = true;
    lastCmdAz = null;
    lastCmdEl = null;
    azState = "IDLE";
    elState = "IDLE";
    flipped = false;
    modeLocked = false;
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
    // New satellite — drop previous pass hold / preposition state
    postPassHeld = false;
    prepositioned = false;
    heldLosAz = null;
    heldHoldEl = 0;
    modeLocked = false;
    flipped = false;
  }
  if (satKey) holdSatKey = satKey;

  if (look.el >= minEl) {
    postPassHeld = false;
    prepositioned = false;
    if (!modeLocked) {
      chooseInitialMode(look.az, look.el);
      modeLocked = true;
      console.log(
        "GS-232 mode",
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
  // Freeze *hardware* aim at LOS (may be FLIPPED: az+180, el≈180).
  // Do NOT convert back to sky LOS @ el 0 — that slews through the stop.
  if (!postPassHeld) {
    if (desiredAz != null && Number.isFinite(desiredAz)) {
      heldLosAz = normalizeAz(desiredAz);
    } else if (flipped && nextLosAz != null && Number.isFinite(nextLosAz)) {
      heldLosAz = normalizeAz(Number(nextLosAz) + 180);
    } else if (nextLosAz != null && Number.isFinite(nextLosAz)) {
      heldLosAz = normalizeAz(nextLosAz);
    } else if (look.az != null && Number.isFinite(look.az)) {
      heldLosAz = normalizeAz(look.az);
    }
    if (desiredEl != null && Number.isFinite(desiredEl)) {
      heldHoldEl = Math.max(0, Math.min(elMax(), Number(desiredEl)));
    } else if (flipped) {
      heldHoldEl = elMax();
    } else {
      heldHoldEl = 0;
    }
    postPassHeld = true;
    console.log(
      "GS-232 below min EL — hold hardware az",
      heldLosAz != null ? Number(heldLosAz).toFixed(1) : "-",
      "el",
      Number(heldHoldEl).toFixed(1),
      flipped ? "(was FLIPPED)" : "(NORMAL)",
      "— no slew to next AOS until T-5 min",
    );
  }
  modeLocked = false;

  // Only within 5 minutes of the *next* AOS: preposition.
  // If AOS→LOS crosses the AZ mechanical stop and 180° EL is available, start
  // already FLIPPED (az+180, el≈180) so we never drive through the stop.
  const PREP_MS = 5 * 60 * 1000;
  const nowMs = Date.now();
  if (
    nextAosMs != null &&
    nextAosAzMeta != null &&
    nextAosMs > nowMs &&
    nextAosMs - nowMs <= PREP_MS
  ) {
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
    modeLocked = true; // keep flip decision for the coming pass
    const azN = useFlip ? normalizeAz(aosN + 180) : aosN;
    const elN = useFlip ? elMax() : 0;
    if (
      !prepositioned ||
      desiredAz == null ||
      Math.abs(shortestDelta(desiredAz, azN)) >= 1 ||
      (desiredEl != null && Math.abs(desiredEl - elN) >= 1)
    ) {
      console.log(
        "GS-232 preposition for next AOS in",
        Math.round((nextAosMs - nowMs) / 1000) + "s → az",
        azN.toFixed(1),
        "el",
        elN,
        useFlip ? "FLIPPED (AOS→LOS crosses AZ stop)" : "NORMAL",
      );
    }
    prepositioned = true;
    desiredAz = azN;
    desiredEl = elN;
    return;
  }

  // Between passes (or next AOS further than 5 min): stay on last hardware aim.
  prepositioned = false;
  if (heldLosAz != null && Number.isFinite(heldLosAz)) {
    desiredAz = heldLosAz;
  }
  desiredEl =
    heldHoldEl != null && Number.isFinite(heldHoldEl) ? heldHoldEl : 0;
}

/** Slew to park, then disconnect. Re-enable Antenna to track sat again. */
function park() {
  postPassHeld = false;
  prepositioned = false;
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
  flipped = false;
  modeLocked = false;
  const pelClamped = azOnly()
    ? 0
    : Math.max(0, Math.min(elMax(), Number(pel) || 0));
  console.log(
    "GS-232 park → az",
    paz,
    azOnly() ? "(AZ only)" : "el " + pelClamped,
  );
  parkHold = true;
  desiredAz = normalizeAz(paz);
  desiredEl = pelClamped;
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
  // If C2 never parses, still stop after command + grace so relays quiet down
  const noFeedbackGraceMs = 12000;
  const tick = () => {
    parkCompleteTimer = null;
    if (!antennaOn || !parkHold) return;
    const azOk =
      az != null &&
      Number.isFinite(az) &&
      Math.abs(shortestDelta(az, paz)) <= settle;
    const elOk = azOnly()
      ? true
      : el != null && Number.isFinite(el) && Math.abs(el - pel) <= settle;
    const commandedPark =
      lastCmdAz != null &&
      Math.abs(lastCmdAz - Math.round(paz)) < 1 &&
      (azOnly() ||
        (lastCmdEl != null && Math.abs(lastCmdEl - Math.round(pel)) < 1));
    const noFeedbackOk =
      commandedPark && Date.now() - started >= noFeedbackGraceMs && az == null;
    const timedOut = Date.now() - started >= PARK_MAX_MS;
    if ((azOk && elOk) || noFeedbackOk || timedOut) {
      console.log(
        "GS-232 park complete — disconnecting",
        timedOut
          ? "(timeout)"
          : noFeedbackOk
            ? "(no C2 feedback, assumed ok)"
            : "",
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
