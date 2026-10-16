/**
 * Kenwood TS-2000 ASCII CAT driver.
 *
 *   FAxxxxxxxxxxx; / FBxxxxxxxxxxx;  — VFO A / B frequency (11-digit Hz)
 *   MDn;                             — mode (1=LSB 2=USB 3=CW 4=FM …)
 *   FT0;/FT1;  FR0;/FR1;             — TX/RX VFO (split: A=DL RX, B=UL TX)
 *   TN01…TN38; TO0;/TO1; CT0;        — CTCSS encode (Hamlib 38-tone, 1-based)
 *   SA1010000; / SA0;                — SAT mode on / off. Kenwood PC ref: SA P1..P7 set
 *     (P1 sat, P2 ch 0-9, P3 1=MAIN DL/SUB UL, P4 ctrl 0=MAIN, P5 trace, P6 rev, P7 0=VFO)
 *   DCp1p2;                          — p1 TX band (0 main/1 sub), p2 CTRL band
 *
 * SAT (single radio, UL+DL cross-band): SA10100000 → full duplex.
 *   MAIN = downlink (FA), SUB = uplink (FB). No FR/FT while SATL is active.
 *   Control stays on MAIN: MD sets MAIN (DL) mode only. No DC / SA P4 switching
 *   (live test: it swaps bands). SUB mode + tone are set on the radio.
 * Simplex (same-band UL≈DL) / UL-only: SA0, both on VFO A (old split path).
 * TRACE must stay OFF (PC owns Doppler).
 * Debug: TS2000_CAT_DEBUG=1 (or true) logs every CAT tx/rx.
 * "Other (Kenwood CAT)" also routes here.
 */

const { SerialPort } = require("serialport");
const config = require("../config");
const { formatFreqDisplayFromMode, getCatalog } = require("../catalog");
const { rangeRateKmS } = require("../orbit");
const { isSimplex } = require("./simplex");

function catDebug() {
  const v = process.env.TS2000_CAT_DEBUG;
  return v === "1" || v === "true" || v === "yes";
}

function catLog(...args) {
  if (catDebug()) console.log("TS2000 CAT", ...args);
}

function makeLink(name) {
  return {
    name,
    port: null,
    connected: false,
    connecting: false,
    buf: "",
    lastHz: null,
    lastMode: null,
    lastHzB: null,
    lastModeB: null,
    recentFreqs: [],
    absorbBaseOffset: null,
    dialHold: null,
    logNextDlWrite: false,
    settleUntil: 0,
    reconnectTimer: null,
    wanted: false,
    /** @type {Promise<any>} */
    queue: Promise.resolve(),
  };
}

const dl = makeLink("dl");
const ul = makeLink("ul");

let radioOn = false;
let locked = false;
let splitOn = false;
let simplexActive = false;
let manualDlOffset = 0;
let ulFineOffset = 0;
let dlFineOffset = 0;
let digitStep = 100;
let vfoPollTimer = null;
let broadcastFn = () => {};
let ctcssMode = "off";
let ctcssAccessHz = null;
let ctcssActivationHz = null;
let lastCtcssApplied = null;
let toneError = null;
let syncNeeded = false;
let getCtx = () => ({});
let cwMode = false;
let satWarned = false;
let satOn = false;
/** Bumped on close/disable; in-flight work checks it after awaits. */
let epoch = 0;
/** SAT tried and not confirmed this session → use VFO split (no DC). */
let satFailed = false;
/** Per-VFO MD nak backoff: { A: code, B: code } — don't resend that code. */
let mdNak = {};
/**
 * Kenwood TS-2000 PC command ref (JP pdf) SA set = 7 digits:
 * P1=1 SAT on, P2=0 channel 0, P3=1 MAIN=downlink SUB=uplink, P4=0 CTRL=MAIN,
 * P5=0 TRACE off, P6=0 trace rev off, P7=0 VFO mode.  FA=DL, FB=UL in SATL.
 */
const SA_SAT_ON = "SA1010000";

const VFO_POLL_MS = 500;
const VFO_THRESH_HZ = 80; // > TS-2000 10 Hz readback rounding
const POST_WRITE_MS = 50; // Hamlib kenwood_set_freq delay
const CMD_WAIT_MS = 100;
const CMD_RETRIES = 2;
const CMD_HISTORY_MS = 4000;
const CMD_HISTORY_MAX = 12;
const SETTLE_AFTER_WRITE_MS = 400;
const DIAL_ABSORB_MAX_STEP_HZ = 5000;
const DIAL_BOGUS_HZ = 1000000;
const DIAL_CONFIRM_WINDOW_MS = 1500;
const DIAL_CONFIRM_TOL_HZ = 400;
const ABSORB_WINDOW_MS = 8000;
const ABSORB_TRIP_COUNT = 6;
const ABSORB_TRIP_FLIPS = 3;
const ABSORB_SUSPEND_MS = 60000;

/** Pending large dial jump: { freq, cmd, at } or null */
let pendingJumpDl = null;
let absorbLog = [];
let absorbSuspendedUntil = 0;

/**
 * Hamlib ts2000_ctcss_list (×0.1 Hz), no 69.3. TN code = index+1 (TN01=67.0).
 */
const TONE_TABLE = [
  67.0, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4, 100.0,
  103.5, 107.2, 110.9, 114.8, 118.8, 123.0, 127.3, 131.8, 136.5, 141.3, 146.2,
  151.4, 156.7, 162.2, 167.9, 173.8, 179.9, 186.2, 192.8, 203.5, 210.7, 218.1,
  225.7, 233.6, 241.8, 250.3,
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function init(opts) {
  if (opts && opts.broadcast) broadcastFn = opts.broadcast;
  if (opts && opts.getContext) getCtx = opts.getContext;
}

function dualMode() {
  return typeof config.isDualCat === "function"
    ? config.isDualCat()
    : !!(config.CAT2_DEVICE && String(config.CAT2_DEVICE).trim());
}

function txSplitEnabled() {
  return config.TX_SPLIT !== false;
}

function deviceFor(link) {
  if (link.name === "ul" && dualMode()) {
    return {
      path: config.CAT2_DEVICE || config.CAT_DEVICE,
      baud: config.CAT2_BAUD || config.CAT_BAUD || 9600,
    };
  }
  return {
    path: config.CAT_DEVICE || "/dev/ttyUSB0",
    baud: config.CAT_BAUD || 9600,
  };
}

function markSyncNeeded(reason) {
  syncNeeded = true;
  clearFreqCaches();
  lastCtcssApplied = null;
  toneError = null;
  console.log(
    "Kenwood syncNeeded:",
    reason || "enable",
    dualMode() ? "(dual)" : "(sat)",
  );
}

function clearFreqCaches() {
  for (const link of [dl, ul]) {
    link.lastHz = null;
    link.lastMode = null;
    link.lastHzB = null;
    link.lastModeB = null;
    link.recentFreqs = [];
    link.absorbBaseOffset = null;
    link.dialHold = null;
  }
  pendingJumpDl = null;
  absorbLog = [];
  absorbSuspendedUntil = 0;
}

function clearSyncNeeded() {
  if (!syncNeeded) return;
  syncNeeded = false;
}

function maybeClearSync(ok) {
  if (!syncNeeded) return;
  if (ok) clearSyncNeeded();
}

function anyConnected() {
  return dl.connected || ul.connected;
}

function statusPayload() {
  return {
    type: "radio",
    driver: "kenwood",
    radioOn,
    locked,
    connected: anyConnected(),
    tciConnected: anyConnected(),
    connecting: dl.connecting || ul.connecting,
    dual: dualMode(),
    splitOn: dualMode() ? false : splitOn,
    simplexActive,
    manualDlOffset,
    ulFineOffset,
    dlFineOffset,
    step: digitStep,
    ctcssMode,
    ctcssAccessHz,
    ctcssActivationHz,
    toneError,
    syncNeeded,
    cwMode,
    supportsCwMode: true,
    dataMode: false,
    supportsDataMode: false,
    lastCmdDl: dl.lastHz,
    lastCmdUl: dualMode() ? ul.lastHz : dl.lastHzB,
  };
}

function broadcastStatus() {
  broadcastFn(statusPayload());
}

function modesForCatalogMode(modeStr) {
  // AMSAT mode text is often "SSB CW*" — treat as SSB unless CW-only.
  const s = String(modeStr || "").toUpperCase();
  if (/\bFM\b|NFM|GFSK|C4FM|DSTAR|DMR/.test(s))
    return { ul: "4", dl: "4", ulName: "FM", dlName: "FM" };
  if (/\bCW\b/.test(s) && !/\bSSB\b|\bLSB\b|\bUSB\b/.test(s))
    return { ul: "3", dl: "3", ulName: "CW", dlName: "CW" };
  // Linear transponder: UL LSB, DL USB
  return { ul: "1", dl: "2", ulName: "LSB", dlName: "USB" };
}

/** Apply CW toggle to linear (LSB/USB) modes only. */
function applyCwToMods(mods) {
  if (!cwMode) return mods;
  if (mods.ul !== "1" && mods.ul !== "2") return mods;
  if (mods.dl !== "1" && mods.dl !== "2") return mods;
  return { ul: "3", dl: "3", ulName: "CW", dlName: "CW" };
}

/** Hamlib 1-based TN code (1..38), or null. */
function toneCode(hz) {
  if (hz == null || !Number.isFinite(Number(hz))) return null;
  const target = Number(hz);
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < TONE_TABLE.length; i++) {
    const d = Math.abs(TONE_TABLE[i] - target);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (bestD > 1.0) return null;
  return best + 1; // TN01..TN38
}

function noteCommanded(link, hz, vfo) {
  const store = vfo === "B" ? "B" : "A";
  const target = Math.round(hz);
  if (store === "B") link.lastHzB = target;
  else {
    link.lastHz = target;
    const now = Date.now();
    link.recentFreqs = (link.recentFreqs || [])
      .filter((e) => now - e.t <= CMD_HISTORY_MS)
      .concat([{ hz: target, t: now }])
      .slice(-CMD_HISTORY_MAX);
    link.settleUntil = now + SETTLE_AFTER_WRITE_MS;
  }
}

function nearHz(a, b, tol) {
  return a != null && b != null && Math.abs(a - b) <= (tol != null ? tol : VFO_THRESH_HZ);
}

function inLagCorridor(link, reported) {
  if (reported == null) return false;
  const now = Date.now();
  if ((link.recentFreqs || []).some((e) => now - e.t <= CMD_HISTORY_MS && nearHz(e.hz, reported)))
    return true;
  if (nearHz(link.lastHz, reported)) return true;
  if (nearHz(link.lastHzB, reported)) return true;
  return false;
}

function absorbBreakerTrips(delta) {
  const now = Date.now();
  absorbLog = absorbLog.filter((e) => now - e.t <= ABSORB_WINDOW_MS);
  absorbLog.push({ delta, t: now });
  let flips = 0;
  for (let i = 1; i < absorbLog.length; i++) {
    if (Math.sign(absorbLog[i].delta) !== Math.sign(absorbLog[i - 1].delta))
      flips++;
  }
  if (flips >= ABSORB_TRIP_FLIPS && absorbLog.length >= ABSORB_TRIP_COUNT) {
    absorbSuspendedUntil = now + ABSORB_SUSPEND_MS;
    console.warn(
      "TS2000 WARN dial absorb suspended",
      ABSORB_SUSPEND_MS / 1000,
      "s — oscillating absorbs; leave TRACE/SAT off on the radio",
    );
    absorbLog = [];
    return true;
  }
  return false;
}

function writeRaw(link, data) {
  return new Promise((resolve) => {
    if (!link.port || !link.connected) {
      resolve(false);
      return;
    }
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      console.warn("Kenwood", link.name, "write timeout");
      resolve(false);
    }, 1500);
    link.port.write(data, (err) => {
      if (done) return;
      if (err) {
        done = true;
        clearTimeout(t);
        console.warn("Kenwood", link.name, "write failed:", err.message);
        resolve(false);
        return;
      }
      link.port.drain(() => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(true);
      });
    });
  });
}

/**
 * Serialize work on one link. Never drops — waits for prior cmds.
 */
function enqueue(link, fn) {
  const run = link.queue.then(() => fn());
  link.queue = run.catch((e) => {
    console.warn("Kenwood", link.name, "queue:", e && e.message ? e.message : e);
  });
  return run;
}

function replyLooksBad(raw) {
  const s = String(raw || "");
  return s.includes("?;") || /(^|[^A-Z])[EO];/.test(s) || s.trim() === "E;" || s.trim() === "O;";
}

/**
 * Send one Kenwood command; wait for reply / settle; retry on ?; E; O;.
 * Always goes through the per-link queue.
 */
function sendCmd(link, cmd, waitMs, retries) {
  const ep = epoch;
  return enqueue(link, async () => {
    if (ep !== epoch || !link.connected) return null;
    if (!radioOn && !/^SA0?;?$/i.test(cmd)) return null; // disabled: drop queued writes
    if ((satOn || satInflight) && /^F[RT]\d/i.test(cmd)) {
      catLog("skip (SAT mode)", cmd);
      return "";
    }
    const payload = cmd.endsWith(";") ? cmd : cmd + ";";
    const wait = waitMs != null ? waitMs : CMD_WAIT_MS;
    let lastRaw = "";
    const maxRetry = retries != null ? retries : CMD_RETRIES;
    for (let attempt = 0; attempt <= maxRetry; attempt++) {
      link.buf = "";
      catLog("TX", link.name, payload, attempt ? "retry " + attempt : "");
      const ok = await writeRaw(link, Buffer.from(payload, "ascii"));
      if (!ok) return null;
      await sleep(wait);
      if (ep !== epoch) return null;
      lastRaw = link.buf;
      link.buf = "";
      catLog("RX", link.name, JSON.stringify(lastRaw));
      if (replyLooksBad(lastRaw)) {
        if (ep !== epoch) return null;
        console.warn(
          "Kenwood",
          link.name,
          "nak",
          payload,
          "→",
          JSON.stringify(lastRaw),
          attempt < maxRetry ? "(retry)" : "(give up)",
        );
        if (attempt < maxRetry) await sleep(80);
        continue;
      }
      await sleep(POST_WRITE_MS);
      return lastRaw;
    }
    return lastRaw || null;
  });
}

function clearReconnect(link) {
  if (link.reconnectTimer) {
    clearTimeout(link.reconnectTimer);
    link.reconnectTimer = null;
  }
}

function scheduleReconnect(link) {
  if (link.reconnectTimer || !link.wanted) return;
  link.reconnectTimer = setTimeout(async () => {
    link.reconnectTimer = null;
    if (!radioOn || !link.wanted) return;
    if (!link.connected) await openLink(link);
    if (radioOn && link.wanted && !link.connected) scheduleReconnect(link);
  }, 3000);
}

function openLink(link) {
  return new Promise((resolve) => {
    if (link.port && link.connected) {
      resolve(true);
      return;
    }
    if (link.connecting) {
      resolve(false);
      return;
    }
    const { path, baud } = deviceFor(link);
    if (!path) {
      resolve(false);
      return;
    }
    link.connecting = true;
    link.wanted = true;
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      link.connecting = false;
      resolve(ok);
    };

    try {
      const p = new SerialPort({
        path,
        baudRate: baud > 0 ? baud : 9600,
        dataBits: 8,
        parity: "none",
        stopBits: 1,
        autoOpen: false,
        // TS-2000 often needs RTS asserted for CAT (OscarWatch / field reports).
        rtscts: false,
      });
      p.on("error", (e) =>
        console.warn("Kenwood", link.name, "error:", e.message),
      );

      const timer = setTimeout(() => {
        try {
          p.removeAllListeners("data");
          p.removeAllListeners("close");
          if (p.isOpen) p.close(() => {});
        } catch (_) {}
        console.warn("Kenwood", link.name, "open timeout", path);
        done(false);
      }, 3000);

      p.open((err) => {
        if (err) {
          clearTimeout(timer);
          console.warn("Kenwood", link.name, "open failed:", err.message);
          done(false);
          return;
        }
        clearTimeout(timer);
        link.port = p;
        link.connected = true;
        link.buf = "";
        link.queue = Promise.resolve();
        try {
          if (typeof p.set === "function") {
            p.set({ rts: true, dtr: true }, (e) => {
              if (e)
                console.warn("Kenwood", link.name, "RTS/DTR:", e.message);
              else catLog("RTS/DTR asserted on", link.name, path);
            });
          }
        } catch (e) {
          console.warn("Kenwood", link.name, "RTS/DTR:", e.message);
        }
        p.on("data", (chunk) => {
          link.buf += chunk.toString("ascii");
          if (link.buf.length > 4096) link.buf = link.buf.slice(-1024);
        });
        p.on("close", () => {
          console.log("Kenwood", link.name, "closed");
          link.connected = false;
          link.port = null;
          link.buf = "";
          broadcastStatus();
          if (radioOn && link.wanted) scheduleReconnect(link);
        });
        console.log(
          "Kenwood",
          link.name,
          "open",
          path,
          baud,
          dualMode() ? "[dual]" : "[sat]",
          "(RTS on)",
        );
        setTimeout(() => done(true), 200);
      });
    } catch (e) {
      link.connecting = false;
      console.warn("Kenwood", link.name, "exception:", e.message);
      done(false);
    }
  });
}

function closeLink(link) {
  clearReconnect(link);
  link.wanted = false;
  if (link.port) {
    try {
      if (link.port.isOpen) link.port.close(() => {});
    } catch (_) {}
    link.port = null;
  }
  link.connected = false;
  link.connecting = false;
  link.buf = "";
  link.queue = Promise.resolve();
}

function close() {
  epoch++;
  modeCycleRunning = false;
  modeCycleFailKey = null;
  satModesKey = null;
  skipReason = "";
  lastWriteAt = 0;
  satOn = false;
  subWarned = false;
  pushBusy = false;
  pushPending = null;
  dcPtt = null;
  closeLink(dl);
  closeLink(ul);
  splitOn = false;
  simplexActive = false;
  stopVfoPoll();
}

function setRadio(on) {
  console.log("TS2000 setRadio(" + on + ")");
  if (on) {
    radioOn = true;
    markSyncNeeded("enable");
    satWarned = false;
    satFailed = false;
    mdNak = {};
    dl.wanted = true;
    openLink(dl).then(async () => {
      await ensureSatMode(dl, true);
      startVfoPoll();
      broadcastStatus();
    });
  } else {
    radioOn = false;
    splitOn = false;
    simplexActive = false;
    // Leave radio in SAT mode; stop all writes and close now.
    close();
    console.log("TS2000 disabled — queue dropped, port closed");
    broadcastStatus();
    broadcastStatus();
  }
}

function setLock(on) {
  locked = !!on;
  broadcastStatus();
}

function applyDefaultLock(isFm) {
  locked = !!isFm;
  broadcastStatus();
}

function activeCtcssHz() {
  if (ctcssMode === "access") return ctcssAccessHz;
  if (ctcssMode === "activation") return ctcssActivationHz;
  return null;
}

function setCtcss(which) {
  if (which === "access" && ctcssAccessHz != null) ctcssMode = "access";
  else if (which === "activation" && ctcssActivationHz != null)
    ctcssMode = "activation";
  else ctcssMode = "off";
  lastCtcssApplied = null;
  toneError = null;
  console.log("TS2000 CTCSS", ctcssMode, activeCtcssHz());
  applyCtcssToRadio().catch(() => {});
  broadcastStatus();
}

function applyDefaultCtcss(accessHz, activationHz) {
  ctcssAccessHz = accessHz != null ? accessHz : null;
  ctcssActivationHz = activationHz != null ? activationHz : null;
  if (ctcssAccessHz != null) ctcssMode = "access";
  else ctcssMode = "off";
  lastCtcssApplied = null;
  toneError = null;
  console.log(
    "TS2000 CTCSS default",
    ctcssMode,
    "access",
    ctcssAccessHz,
    "act",
    ctcssActivationHz,
  );
  broadcastStatus();
}

function setCwMode(on) {
  const next = !!on;
  if (next === cwMode) return;
  cwMode = next;
  clearFreqCaches();
  markSyncNeeded("cw " + (cwMode ? "on" : "off"));
  console.log("TS2000 CW", cwMode ? "ON (UL CW / DL CW, MD3)" : "OFF");
  broadcastStatus();
}

/** Data mode N/A on TS-2000 (no DA like TS-590). Kept for API symmetry. */
function setDataMode(_on) {
  console.log("TS2000 data mode N/A — ignored");
}

/** Parse SA reply → "1" | "0" | null (P1). */
function parseSa(raw) {
  const m = String(raw || "").match(/SA(\d{1,8})/i);
  if (!m) return null;
  const d = m[1];
  return { on: d[0] === "1", p3: d.length > 2 ? d[2] : null, raw: d };
}

/**
 * SAT mode on/off. on=true: SA10100000 (MAIN=DL, SUB=UL, TRACE off), readback SA;.
 * on=false: SA0 if radio reports SAT on.
 */
let satInflight = null;
function ensureSatMode(link, on) {
  if (satInflight) return satInflight.then(() => satOn === on);
  satInflight = ensureSatModeInner(link, on).finally(() => {
    satInflight = null;
  });
  return satInflight;
}

async function ensureSatModeInner(link, on) {
  if (!link || !link.connected) return false;
  if (on && satFailed) return false;
  if (satOn === on && !syncNeeded) return true;
  try {
    if (on && splitOn) {
      await sendCmd(link, "FT0", 60, 0);
      await sendCmd(link, "FR0", 60, 0);
      splitOn = false;
    }
    const rawBefore = await sendCmd(link, "SA", 150, 0);
    const before = parseSa(rawBefore);
    if (on) {
      const was = satOn;
      if (!was) console.log("TS2000 [sat] SA; read →", JSON.stringify(rawBefore));
      if (!before || !before.on || before.p3 !== "1" || before.raw.slice(3, 7) !== "0000") {
        const setRaw = await sendCmd(link, SA_SAT_ON, 250, 0);
        console.log("TS2000 [sat] set", SA_SAT_ON + ";", "→", JSON.stringify(setRaw));
        const rawAfter = await sendCmd(link, "SA", 150, 0);
        console.log("TS2000 [sat] SA; readback →", JSON.stringify(rawAfter));
        const after = parseSa(rawAfter);
        satOn = !!(after && after.on);
        if (satOn && after.p3 !== "1")
          console.warn("TS2000 [sat] WARN P3=" + after.p3 + " (want 1: MAIN=DL SUB=UL)");
      } else {
        satOn = true;
      }
      if (!satOn) {
        satFailed = true;
        console.warn(
          "TS2000 [sat] SAT mode NOT confirmed — falling back to VFO split (A=DL, B=UL) for this session",
        );
      } else if (!was) {
        console.log("TS2000 [sat] SAT mode ON MAIN=DL SUB=UL — keep TRACE OFF (PC owns Doppler)");
        satWarned = true;
        dcPtt = null;
        const dc = await readDc(link);
        console.log("TS2000 [sat] DC; →", dc ? "DC" + dc.ptt + dc.ctrl : "none");
      }
      return satOn;
    }
    if (before && before.on) {
      const okOff = await exitSat(link);
      console.log("TS2000 [sat] SAT mode OFF", okOff ? "OK" : "FAILED");
    }
    satOn = false;
    return true;
  } catch (e) {
    console.warn("TS2000 SA:", e.message);
    return false;
  }
}

/**
 * Kenwood ref: DC P1 = PTT band (0 MAIN / 1 SUB), P2 = operation/control band.
 * "When P1 changes, P2 is set to the same value." So we keep P1 as read and only
 * change P2. MD/TN/TO act on the control band.
 */
let dcPtt = null;
async function readDc(link) {
  const raw = await sendCmd(link, "DC", 100, 0);
  const m = String(raw || "").match(/DC(\d)(\d)/i);
  if (m) dcPtt = m[1];
  return m ? { ptt: m[1], ctrl: m[2] } : null;
}

async function readSaRaw(link) {
  return parseSa(await sendCmd(link, "SA", 150, 0));
}

/**
 * Live TS-2000 test: any CAT control-band switch in SAT mode (DC01/DC11/SA P4=1)
 * swaps MAIN/SUB bands on the display — destructive. Control stays on MAIN always.
 * SUB mode and tones are left to the operator; FB still sets SUB (uplink) freq.
 */
let subWarned = false;
function warnSubOnce() {
  if (subWarned) return;
  subWarned = true;
  console.warn("TS2000 [sat] SUB mode: set on radio (CAT can't address SUB in SAT mode)");
}

/** In SAT mode, SUB-targeted commands are skipped (logged once). */
async function withCtrlSub(link, fn) {
  if (!satOn) return fn();
  warnSubOnce();
  return undefined;
}

async function applyCtcssToRadio() {
  const link = dualMode() ? ul : dl;
  if (!radioOn || !link.connected) return;
  const hz = activeCtcssHz();
  const key = hz != null ? String(hz) : "off";
  if (key === lastCtcssApplied && !toneError) return;
  if (satOn) {
    warnSubOnce();
    lastCtcssApplied = key;
    toneError = null;
    return;
  }
  try {
   await withCtrlSub(link, async () => {
    // Clear TSQL (CT) whenever we touch encode — encode-only for sats.
    // SAT mode: TS-2000 naks CT (TSQL) — skip; encode follows uplink band.
    if (!satOn && (await sendCmd(link, "CT0", 60, 0)) == null) return;
    if (hz != null) {
      const code = toneCode(hz);
      if (code == null) {
        toneError = "no TN match for " + hz + " Hz";
        console.warn("TS2000 CTCSS", toneError);
        broadcastStatus();
        return;
      }
      const tnSet = await sendCmd(link, "TN" + String(code).padStart(2, "0"), 60, 0);
      const toSet = await sendCmd(link, "TO1", 60, 0);
      if (tnSet == null || !link.connected) return;
      if (replyLooksBad(tnSet) || replyLooksBad(toSet)) {
        toneError = "TN/TO nak" + (satOn ? " in SAT mode — set tone on radio" : "");
        console.warn("TS2000 CTCSS", toneError, "(not retrying)");
        lastCtcssApplied = key; // cache nak: stop resending
        return;
      }
      // Readback verify
      const tnRaw = await sendCmd(link, "TN", 100, 0);
      const toRaw = await sendCmd(link, "TO", 80, 0);
      const tnM = tnRaw && String(tnRaw).match(/TN(\d{2})/i);
      const toM = toRaw && String(toRaw).match(/TO(\d)/i);
      const tnOk = tnM && parseInt(tnM[1], 10) === code;
      const toOk = toM && toM[1] === "1";
      if (!tnOk || !toOk) {
        toneError =
          "readback TN=" +
          (tnM ? tnM[1] : "?") +
          " TO=" +
          (toM ? toM[1] : "?") +
          " want TN" +
          String(code).padStart(2, "0") +
          " TO1";
        console.warn("TS2000 CTCSS FAIL", toneError);
      } else {
        toneError = null;
        console.log("TS2000 CTCSS", hz, "Hz TN" + String(code).padStart(2, "0"), "OK on", link.name + (satOn ? " SUB (UL)" : ""));
      }
    } else {
      const toSet = await sendCmd(link, "TO0", 60, 0);
      if (toSet == null || !link.connected) return;
      if (replyLooksBad(toSet)) {
        toneError = null;
        lastCtcssApplied = key; // nak (SAT mode) — treat as off, don't retry
        console.warn("TS2000 CTCSS TO0 nak" + (satOn ? " in SAT mode" : "") + " — not retrying");
        return;
      }
      const toRaw = await sendCmd(link, "TO", 80, 0);
      if (toRaw == null || !link.connected) return; // port closed mid-apply
      const toM = toRaw && String(toRaw).match(/TO(\d)/i);
      if (toM && toM[1] !== "0") {
        toneError = "TO off readback=" + toM[1];
        console.warn("TS2000 CTCSS FAIL", toneError);
      } else {
        toneError = null;
        console.log("TS2000 CTCSS OFF on", link.name + (satOn ? " SUB (UL)" : ""));
      }
    }
   });
    if (!toneError) lastCtcssApplied = key;
    broadcastStatus();
  } catch (e) {
    toneError = e.message || "CTCSS error";
    console.warn("TS2000 CTCSS:", toneError);
    broadcastStatus();
  }
}

async function ensureSplit(wantOn) {
  if (dualMode()) {
    if (splitOn && dl.connected) {
      await sendCmd(dl, "FT0", 60);
      splitOn = false;
      console.log("TS2000 SPLIT OFF (dual — Radio 1 DL only)");
    }
    return false;
  }
  if (!dl.connected) return false;
  if (!wantOn || !txSplitEnabled()) {
    if (splitOn) {
      await sendCmd(dl, "FT0", 60);
      await sendCmd(dl, "FR0", 60);
      splitOn = false;
      console.log("TS2000 SPLIT OFF");
    }
    return false;
  }
  if (splitOn) return true;
  await sendCmd(dl, "FT1", 60);
  await sendCmd(dl, "FR0", 60);
  splitOn = true;
  console.log("TS2000 SPLIT ON (TX = VFO B / UL)");
  return true;
}

async function setFreq(link, hz, vfo) {
  const target = Math.round(Number(hz));
  if (!Number.isFinite(target) || target <= 0) return false;
  const prev =
    vfo === "B" ? link.lastHzB : link.lastHz;
  if (prev != null && Math.abs(target - prev) < 1) {
    return true;
  }
  const digits = String(target).padStart(11, "0").slice(-11);
  const cmd = (vfo === "B" ? "FB" : "FA") + digits;
  const raw = await sendCmd(link, cmd, 60);
  lastWriteAt = Date.now();
  ticksSinceWrite = 0;
  if (vfo === "B" && satOn && (!link._fbLogged || replyLooksBad(raw))) {
    link._fbLogged = true;
    if (radioOn) console.log("TS2000 [sat] SUB (UL)", cmd + ";", "→", JSON.stringify(raw));
  }
  if (raw == null) return false;
  if (replyLooksBad(raw)) return false;
  noteCommanded(link, target, vfo);
  return true;
}

async function setMode(link, mdCode, name, vfo) {
  const prev = vfo === "B" ? link.lastModeB : link.lastMode;
  if (prev === mdCode) {
    return true;
  }
  const nk = (satOn ? "S" : "V") + vfo;
  if (mdNak[nk] === mdCode) return true; // nak'd before — don't spam
  let raw;
  const satNow = satOn;
  if (satNow) {
    // SATL: MD acts on control band (DC P2). Keep PTT (P1), switch CTRL, set, verify, CTRL→MAIN.
    const sub = vfo === "B";
    if (sub) {
      warnSubOnce();
      link.lastModeB = mdCode;
      return true;
    }
    raw = await sendCmd(link, "MD" + mdCode, 60, 0);
    const rb = await sendCmd(link, "MD", 100, 0);
    const mm = String(rb || "").match(/MD(\d)/i);
    if (!radioOn) return false;
    if (raw != null && !replyLooksBad(raw) && (!mm || mm[1] !== mdCode)) {
      console.warn("TS2000 [sat]", sub ? "SUB (UL)" : "MAIN (DL)", "MD readback", mm ? mm[1] : "?", "want", mdCode);
      raw = "?;"; // treat as nak → cached, not spammed
    }
  } else {
    // MD applies to the current RX VFO — select, set, restore FR0 for dial on A.
    if (vfo === "B") await sendCmd(link, "FR1", 40, 0);
    else await sendCmd(link, "FR0", 40, 0);
    raw = await sendCmd(link, "MD" + mdCode, 60, 0);
    if (vfo === "B") await sendCmd(link, "FR0", 40, 0);
  }
  if (raw == null) return false;
  if (replyLooksBad(raw)) {
    mdNak[nk] = mdCode;
    if (vfo === "B") link.lastModeB = mdCode;
    else link.lastMode = mdCode;
    console.warn(
      "TS2000 MD" + mdCode,
      "nak on",
      satOn ? (vfo === "B" ? "SUB (UL)" : "MAIN (DL)") : "VFO " + vfo,
      "— not resending until mode/SAT changes; set mode on radio if needed",
    );
    return true;
  }
  delete mdNak[nk];
  if (!radioOn) return false;
  if (vfo === "B") link.lastModeB = mdCode;
  else link.lastMode = mdCode;
  console.log(
    "Kenwood",
    link.name,
    satNow ? "MAIN (DL)" : "VFO " + vfo,
    "mode",
    name || mdCode,
  );
  return true;
}

function getActiveModeObj(info, modeIndex) {
  const modes = info && Array.isArray(info.modes) ? info.modes : [];
  if (!modes.length) return null;
  const i = modeIndex >= 0 && modeIndex < modes.length ? modeIndex : 0;
  return modes[i];
}

/**
 * Dial absorb + settle hold (ic705/rigctl pattern).
 * Returns { holdDl, target }.
 */
async function dialAbsorbDl(dlHz, hasDl) {
  let holdDl = false;
  const now = Date.now();
  if (modeCycleRunning || now < absorbSuspendedUntil) return { holdDl: false, target: dlHz };

  const absorbTo = (reported) => {
    const delta = reported - dl.lastHz;
    if (Math.abs(delta) > DIAL_BOGUS_HZ) {
      console.warn("TS2000 dial delta", Math.round(delta), "Hz bogus (>1 MHz) — ignored");
      return;
    }
    if (Math.abs(delta) > DIAL_ABSORB_MAX_STEP_HZ) {
      // Large jump: pending confirm
      if (
        pendingJumpDl &&
        now - pendingJumpDl.at <= DIAL_CONFIRM_WINDOW_MS &&
        Math.abs(reported - pendingJumpDl.freq) <= DIAL_CONFIRM_TOL_HZ
      ) {
        pendingJumpDl = null;
        console.log("TS2000 dial jump confirmed", Math.round(delta), "Hz");
      } else {
        pendingJumpDl = { freq: reported, cmd: dl.lastHz, at: now };
        console.log("TS2000 dial jump pending", Math.round(delta), "Hz");
        holdDl = true;
        return;
      }
    }
    if (absorbBreakerTrips(delta)) {
      // Undo: don't apply
      return;
    }
    if (dl.absorbBaseOffset == null) {
      dl.absorbBaseOffset = manualDlOffset;
      if (hasDl) {
        const dopplerOnly = dlHz - manualDlOffset - dlFineOffset;
        manualDlOffset = reported - dopplerOnly - dlFineOffset;
      }
    } else if (hasDl) {
      manualDlOffset += delta;
    }
    console.log(
      "TS2000 dial absorb DL",
      Math.round(delta),
      "Hz → manualDl",
      Math.round(manualDlOffset),
    );
    dl.lastHz = reported;
    dl.recentFreqs = [{ hz: reported, t: Date.now() }];
    dl.logNextDlWrite = true;
    broadcastStatus();
  };

  if (!locked && !syncNeeded && dl.lastHz != null && now >= dl.settleUntil) {
    const reported = await readVfoA(dl);
    if (dl.dialHold) {
      if (reported == null) dl.dialHold = null; // no readback — don't stall tracking
      else if (nearHz(reported, dl.dialHold.lastHz)) {
        console.log(
          "TS2000 dial settled DL",
          (reported / 1e6).toFixed(6),
          "MHz",
        );
        dl.dialHold = null;
      } else {
        absorbTo(reported);
        if (!holdDl) {
          dl.dialHold = { lastHz: reported };
          holdDl = true;
        }
      }
    } else {
      const ownWrite = inLagCorridor(dl, reported);
      if (
        reported != null &&
        !ownWrite &&
        Math.abs(reported - dl.lastHz) > VFO_THRESH_HZ
      ) {
        absorbTo(reported);
        if (!holdDl && pendingJumpDl && pendingJumpDl.freq === reported) {
          // still pending
          holdDl = true;
        } else if (!holdDl) {
          dl.dialHold = { lastHz: reported };
          holdDl = true;
          console.log("TS2000 dial hold engaged: FA read", reported, "vs sent", dl.lastHz);
        }
      }
    }
  }

  let target = dlHz;
  if (!holdDl && hasDl && dl.absorbBaseOffset != null && dl.lastHz != null) {
    const d = manualDlOffset - dl.absorbBaseOffset;
    if (Math.abs(target + d - dl.lastHz) < Math.abs(target - dl.lastHz))
      target += d;
    else dl.absorbBaseOffset = null;
  }
  if (!holdDl && dl.logNextDlWrite) {
    dl.logNextDlWrite = false;
    console.log(
      "TS2000 dl write after absorb",
      (Math.round(target) / 1e6).toFixed(6),
      "MHz",
    );
  }
  return { holdDl, target };
}

let skipReason = "";
let ticksSinceWrite = 0;
let satModesKey = null;

async function readbackDiag(link, tag) {
  const fa = await sendCmd(link, "FA", 60, 0);
  const fb = await sendCmd(link, "FB", 60, 0);
  const md = await sendCmd(link, "MD", 60, 0);
  if (radioOn) console.log("TS2000 [sat] modes", tag, JSON.stringify({ fa, fb, md }));
}

/**
 * Set UL (SUB) + DL modes outside SAT (CAT can't address SUB in SATL):
 * SA0 → VFO A MD(dl), VFO B MD(ul) via FR → FR0 → SA1010000 → SA; readback.
 * Once per sat/mode change, never per tick.
 */
/** Exit SAT: SA0000000; then SA0010000; (7-digit set). Verify SA; P1=0. */
async function exitSat(link) {
  for (const c of ["SA0000000", "SA0010000"]) {
    const setRaw = await sendCmd(link, c, 120, 0);
    const rb = parseSa(await sendCmd(link, "SA", 80, 0));
    const ok = !!(rb && !rb.on);
    if (radioOn) console.log("TS2000 [sat] exit", c + ";", "→", JSON.stringify(setRaw), "SA", rb ? rb.raw : "none", ok ? "OK" : "no");
    if (ok) return true;
  }
  return false;
}

let modeCycleFailKey = null;

/**
 * Preferred: stay in SAT, SA1011000 (P4=1 CTRL→SUB) → MD<ul> + MD; → SA1010000 → verify.
 * SAT keeps its own per-band modes; split-mode setting doesn't carry into SAT.
 * Returns true if done, false if P4 toggle failed (caller falls back to split cycle).
 */
async function applyModesViaSaP4(link, mods) {
  const set1 = await sendCmd(link, "SA1011000", 120, 0);
  const rb1 = parseSa(await sendCmd(link, "SA", 80, 0));
  const ok1 = !!(rb1 && rb1.on && rb1.raw[3] === "1");
  if (radioOn) console.log("TS2000 [sat] SA1011000; →", JSON.stringify(set1), "SA", rb1 ? rb1.raw : "none", ok1 ? "CTRL=SUB OK" : "no");
  if (!ok1) {
    if (rb1 && rb1.on && rb1.raw[3] !== "0") await sendCmd(link, SA_SAT_ON, 120, 0);
    return false;
  }
  const mdSet = await sendCmd(link, "MD" + mods.ul, 60, 0);
  const mdRb = await sendCmd(link, "MD", 80, 0);
  if (radioOn) console.log("TS2000 [sat] SUB MD" + mods.ul + "; →", JSON.stringify(mdSet), "rb", JSON.stringify(mdRb));
  const set0 = await sendCmd(link, SA_SAT_ON, 120, 0);
  const rb0 = parseSa(await sendCmd(link, "SA", 80, 0));
  const ok0 = !!(rb0 && rb0.on && rb0.raw[3] === "0");
  if (radioOn) console.log("TS2000 [sat] SA1010000; →", JSON.stringify(set0), "SA", rb0 ? rb0.raw : "none", ok0 ? "CTRL=MAIN OK" : "WARN");
  const mainRb = await sendCmd(link, "MD", 80, 0);
  const mm = String(mainRb || "").match(/MD(\d)/i);
  if (!mm || mm[1] !== mods.dl) {
    const r = await sendCmd(link, "MD" + mods.dl, 60, 0);
    if (radioOn) console.log("TS2000 [sat] MAIN MD rb", JSON.stringify(mainRb), "→ MD" + mods.dl + ";", JSON.stringify(r));
  } else if (radioOn) console.log("TS2000 [sat] MAIN MD rb", JSON.stringify(mainRb), "OK");
  satOn = !!(rb0 && rb0.on);
  dl.lastMode = mods.dl;
  dl.lastModeB = mods.ul;
  return true;
}

async function applyModesViaSplit(link, mods, key) {
  modeCycleRunning = true;
  absorbSuspendedUntil = Infinity;
  pendingJumpDl = null;
  dl.dialHold = null;
  const t0 = Date.now();
  try {
    console.log("TS2000 [sat] setting SUB mode via SA P4: UL", mods.ulName, "DL", mods.dlName);
    if (await applyModesViaSaP4(link, mods)) return;
    console.warn("TS2000 [sat] SA P4 toggle failed — fallback SA0 split cycle");
    console.log("TS2000 [sat] setting modes via split: DL", mods.dlName, "UL", mods.ulName);
    if (!(await exitSat(link))) {
      if (modeCycleFailKey !== key)
        console.warn("TS2000 [sat] can't exit SAT via CAT — mode cycle aborted; set SUB mode on radio");
      modeCycleFailKey = key;
      return; // still in SAT; no MD sent
    }
    satOn = false;
    const fr0 = await sendCmd(link, "FR0", 50, 0);
    const mdA = (await sendCmd(link, "MD" + mods.dl, 50, 0)) || "";
    const fr1 = await sendCmd(link, "FR1", 50, 0);
    let mdB = "";
    if (!replyLooksBad(fr1)) {
      mdB = (await sendCmd(link, "MD" + mods.ul, 50, 0)) || "";
      mdB += " rb " + ((await sendCmd(link, "MD", 80, 0)) || "");
    }
    const fr0b = await sendCmd(link, "FR0", 50, 0);
    if (radioOn)
      console.log("TS2000 [sat] split modes", JSON.stringify({ fr0, mdA, fr1, mdB, fr0b }));
    await sendCmd(link, SA_SAT_ON, 150, 0);
    const rb = parseSa(await sendCmd(link, "SA", 80, 0));
    satOn = !!(rb && rb.on);
    if (radioOn) console.log("TS2000 [sat] re-enter", SA_SAT_ON + ";", "→ SA", rb ? rb.raw : "none", satOn ? "OK" : "FAILED");
    if (!satOn) satFailed = true;
    await readbackDiag(link, "after re-enter");
    clearFreqCaches();
    dl.lastMode = mods.dl;
    dl.lastModeB = mods.ul;
  } finally {
    // Reset dial baseline to last-sent; suspend absorb/jump detection 1 s after.
    const keepA = dl.lastHz, keepB = dl.lastHzB, mA = dl.lastMode, mB = dl.lastModeB;
    clearFreqCaches();
    dl.lastHz = keepA; dl.lastHzB = keepB; dl.lastMode = mA; dl.lastModeB = mB;
    dl.settleUntil = Date.now() + 1000;
    absorbSuspendedUntil = Date.now() + 1000;
    modeCycleRunning = false;
    pushBusySince = Date.now();
    if (radioOn) console.log("TS2000 [sat] mode cycle", Date.now() - t0, "ms");
  }
}

let modeCycleRunning = false;
let pushBusy = false;
let pushBusySince = 0;
let lastWriteAt = 0;
let stallWarnAt = 0;
function stallCheck() {
  const now = Date.now();
  if (!radioOn || !lastWriteAt || now - lastWriteAt < 3000 || now - stallWarnAt < 3000) return;
  stallWarnAt = now;
  console.warn(
    "TS2000 WARN no FA/FB write for", Math.round((now - lastWriteAt) / 1000) + "s",
    JSON.stringify({ busy: pushBusy, busyMs: pushBusy ? now - pushBusySince : 0, satOn, satFailed,
      dialHold: !!dl.dialHold, pendingJump: !!pendingJumpDl, locked, connected: dl.connected, syncNeeded,
      ticks: ticksSinceWrite, skip: skipReason, lastHz: dl.lastHz, lastHzB: dl.lastHzB }),
  );
}
let pushPending = null;
/** Latest-wins: one tick in flight; newer ticks replace the pending one (no dup writes). */
async function pushFrequencies(ulHz, dlHz) {
  if (!radioOn) return;
  ticksSinceWrite++;
  stallCheck();
  if (pushBusy) {
    pushPending = [ulHz, dlHz];
    skipReason = "busy (coalesced)";
    if (!modeCycleRunning && Date.now() - pushBusySince > 4000) {
      console.warn("TS2000 tick stuck >4s — resetting tick lock");
      pushBusy = false;
    } else return;
  }
  pushBusySince = Date.now();
  pushBusy = true;
  const ep = epoch;
  try {
    let args = [ulHz, dlHz];
    while (args && ep === epoch && radioOn) {
      pushPending = null;
      await pushInner(args[0], args[1], ep);
      args = pushPending;
    }
  } finally {
    if (ep === epoch) pushBusy = false;
  }
}

async function pushInner(ulHz, dlHz, ep) {
  const dead = () => ep !== epoch || !radioOn;
  if (dead()) return;
  const hasUl = ulHz != null && Number.isFinite(Number(ulHz));
  const hasDl = dlHz != null && Number.isFinite(Number(dlHz));
  if (!hasUl && !hasDl) return;

  if (!dl.connected && dl.wanted) await openLink(dl);
  if (dualMode() && hasUl && !ul.connected) {
    ul.wanted = true;
    await openLink(ul);
  }

  const { currentSatKey, currentModeIndex } = getCtx();
  const info = getCatalog()[currentSatKey] || {};
  const active = getActiveModeObj(info, currentModeIndex);
  const freqs = formatFreqDisplayFromMode(active);
  let mods = applyCwToMods(
    modesForCatalogMode(freqs.mode || (freqs.isFm ? "FM" : "SSB")),
  );

  let ok = true;
  const force = syncNeeded;

  if (dualMode()) {
    if (hasDl && dl.connected) {
      const abs = await dialAbsorbDl(dlHz, true);
      if (abs.holdDl) {
        maybeClearSync(false);
        return;
      }
      const m = await setMode(dl, mods.dl, mods.dlName, "A");
      const f = await setFreq(dl, abs.target, "A");
      if (!m || !f) ok = false;
      else if (force)
        console.log(
          "Kenwood DL (R1)",
          (Math.round(abs.target) / 1e6).toFixed(6),
          "MHz [dual]",
        );
    }
    if (hasUl) {
      if (!ul.connected) {
        ul.wanted = true;
        await openLink(ul);
      }
      if (ul.connected) {
        const m = await setMode(ul, mods.ul, mods.ulName, "A");
        const f = await setFreq(ul, ulHz, "A");
        if (!m || !f) ok = false;
        else if (force)
          console.log(
            "Kenwood UL (R2)",
            (Math.round(ulHz) / 1e6).toFixed(6),
            "MHz [dual]",
          );
      }
    }
  } else {
    if (!dl.connected) {
      maybeClearSync(false);
      return;
    }
    // UL-only mixed path: this driver owns TX only — put UL on VFO A
    if (hasUl && !hasDl) {
      if (simplexActive) {
        simplexActive = false;
      }
      await ensureSatMode(dl, false);
      await ensureSplit(false);
      const m = await setMode(dl, mods.ul, mods.ulName, "A");
      const f = await setFreq(dl, ulHz, "A");
      if (!m || !f) ok = false;
      else if (force)
        console.log(
          "Kenwood VFO A (UL-only)",
          (Math.round(ulHz) / 1e6).toFixed(6),
          "MHz",
        );
    } else {
      const simplex =
        hasUl &&
        hasDl &&
        isSimplex(freqs, Number(ulHz), Number(dlHz));

      if (simplex) {
        if (!simplexActive) {
          console.log(
            "TS2000 simplex: SPLIT OFF, VFO A",
            (Math.round(dlHz) / 1e6).toFixed(6),
            "MHz",
            mods.dlName,
          );
          await ensureSatMode(dl, false);
          await ensureSplit(false);
          clearFreqCaches();
          lastCtcssApplied = null;
          simplexActive = true;
          markSyncNeeded("simplex enter");
        }
        const abs = await dialAbsorbDl(dlHz, true);
        if (abs.holdDl) {
          maybeClearSync(false);
          return;
        }
        const m = await setMode(dl, mods.dl, mods.dlName, "A");
        const f = await setFreq(dl, abs.target, "A");
        if (!m || !f) ok = false;
      } else {
        if (simplexActive) {
          console.log("TS2000 leaving simplex → split layout");
          simplexActive = false;
          clearFreqCaches();
          markSyncNeeded("simplex leave");
        }
        if (hasDl && txSplitEnabled() && !satFailed && !satOn) {
          // SA detection first — no FR/FT/MD/FA/FB until SAT is confirmed or failed.
          await ensureSatMode(dl, true);
          if (dead()) return;
          if (!satOn && !satFailed) {
            skipReason = "sat undetermined";
            return; // undetermined (link not ready) — next tick
          }
          if (satOn) {
            clearFreqCaches();
            mdNak = {};
          }
        }
        if (satOn && hasUl) {
          const key = mods.ul + "/" + mods.dl;
          if (satModesKey !== key) {
            satModesKey = key; // mark first: never re-run for same pair
            await applyModesViaSplit(dl, mods, key);
            if (dead()) return;
            if (!satOn) {
              skipReason = "sat re-entry failed";
              return;
            }
          }
        }
        if (!satOn) {
          if (hasUl && hasDl) await ensureSplit(true);
        }
        const abs = hasDl ? await dialAbsorbDl(dlHz, true) : { holdDl: false, target: dlHz };
        if (abs.holdDl) {
          skipReason = "dial hold";
          maybeClearSync(false);
          return;
        }
        if (dead()) return;
        if (hasDl) {
          const m = await setMode(dl, mods.dl, mods.dlName, "A");
          const f = await setFreq(dl, abs.target, "A");
          if (dead()) return;
          if (!m || !f) ok = false;
          else if (force)
            console.log(
              satOn ? "Kenwood MAIN (DL)" : "Kenwood VFO A (DL)",
              (Math.round(abs.target) / 1e6).toFixed(6),
              satOn ? "MHz [sat]" : "MHz [split]",
            );
        }
        if (hasUl) {
          // FB sets SUB freq directly in SAT mode — independent of control band.
          const f = await setFreq(dl, ulHz, "B");
          const m = await setMode(dl, mods.ul, mods.ulName, "B");
          if (dead()) return;
          if (!m || !f) ok = false;
          else if (force)
            console.log(
              satOn ? "Kenwood SUB (UL)" : "Kenwood VFO B (UL)",
              (Math.round(ulHz) / 1e6).toFixed(6),
              satOn ? "MHz [sat]" : "MHz [split]",
            );
        }
      }
    }
  }

  if (dead()) return;
  await applyCtcssToRadio();
  if (dead()) return;
  maybeClearSync(ok && anyConnected());
}

async function readVfoA(link) {
  const raw = await sendCmd(link, "FA", 100);
  if (!raw) return null;
  const m = String(raw).match(/FA(\d{9,11})/i);
  if (!m) return null;
  const hz = parseInt(m[1], 10);
  return Number.isFinite(hz) ? hz : null;
}

/**
 * Background dial poll — goes through the same CAT queue as writes (no race).
 * When pushFrequencies already does dialAbsorbDl each tick, this is a backup
 * while locked=false between ticks.
 */
async function pollVfo() {
  if (!radioOn || !dl.connected || locked) return;
  if (dl.lastHz == null || dl.lastHz <= 0) return;
  if (Date.now() < dl.settleUntil) return;
  if (Date.now() < absorbSuspendedUntil) return;
  if (modeCycleRunning) return;

  const freq = await readVfoA(dl);
  if (freq == null) return;
  if (modeCycleRunning || Date.now() < absorbSuspendedUntil) return;
  if (Math.abs(freq - dl.lastHz) > DIAL_BOGUS_HZ) return; // bogus read (e.g. during SAT toggle)
  if (inLagCorridor(dl, freq)) return;
  if (Math.abs(freq - dl.lastHz) <= VFO_THRESH_HZ) return;

  // Large jump → pending
  const delta = freq - dl.lastHz;
  const now = Date.now();
  if (Math.abs(delta) > DIAL_ABSORB_MAX_STEP_HZ) {
    if (
      pendingJumpDl &&
      now - pendingJumpDl.at <= DIAL_CONFIRM_WINDOW_MS &&
      Math.abs(freq - pendingJumpDl.freq) <= DIAL_CONFIRM_TOL_HZ
    ) {
      pendingJumpDl = null;
    } else {
      pendingJumpDl = { freq, cmd: dl.lastHz, at: now };
      console.log("TS2000 dial jump pending (poll)", Math.round(delta), "Hz");
      return;
    }
  }

  const { satrec, observer, currentSatKey, currentModeIndex } = getCtx();
  if (!satrec) return;
  const info = getCatalog()[currentSatKey] || {};
  const active = getActiveModeObj(info, currentModeIndex);
  const freqs = formatFreqDisplayFromMode(active);
  if (freqs.dlMHz == null) return;
  const rr = rangeRateKmS(satrec, observer, new Date());
  if (rr == null || !Number.isFinite(rr)) return;
  if (absorbBreakerTrips(delta)) return;

  const f0 = freqs.dlMHz * 1e6;
  const df = 1 - rr / config.C_MS;
  const prev = manualDlOffset;
  if (dl.absorbBaseOffset == null) dl.absorbBaseOffset = manualDlOffset;
  manualDlOffset = freq - f0 * df - dlFineOffset;
  dl.lastHz = freq;
  dl.recentFreqs = [{ hz: freq, t: now }];
  if (Math.abs(manualDlOffset - prev) >= 1) {
    console.log(
      "TS2000 dial absorb DL (poll)",
      Math.round(manualDlOffset - prev),
      "Hz → manualDl",
      Math.round(manualDlOffset),
    );
    broadcastStatus();
  }
}

function startVfoPoll() {
  if (vfoPollTimer) return;
  vfoPollTimer = setInterval(() => {
    stallCheck();
    pollVfo().catch(() => {});
  }, VFO_POLL_MS);
}

function stopVfoPoll() {
  if (vfoPollTimer) {
    clearInterval(vfoPollTimer);
    vfoPollTimer = null;
  }
}

function adjustFine(delta, side) {
  const d = Math.round(Number(delta) || 0);
  if (side === "ul") ulFineOffset += d;
  else dlFineOffset += d;
  if (side === "ul") {
    ul.lastHz = null;
    dl.lastHzB = null;
  } else {
    dl.lastHz = null;
  }
  broadcastStatus();
}

function setStep(step) {
  if (typeof step === "number" && step > 0) digitStep = Math.round(step);
  broadcastStatus();
}

function center() {
  manualDlOffset = 0;
  ulFineOffset = 0;
  dlFineOffset = 0;
  clearFreqCaches();
  broadcastStatus();
}

function resetOffsets() {
  manualDlOffset = 0;
  ulFineOffset = 0;
  dlFineOffset = 0;
  clearFreqCaches();
}

function setOffsets(o) {
  if (!o || typeof o !== "object") return;
  if (typeof o.ulFineOffset === "number" && Number.isFinite(o.ulFineOffset))
    ulFineOffset = Math.round(o.ulFineOffset);
  if (typeof o.dlFineOffset === "number" && Number.isFinite(o.dlFineOffset))
    dlFineOffset = Math.round(o.dlFineOffset);
  if (typeof o.manualDlOffset === "number" && Number.isFinite(o.manualDlOffset))
    manualDlOffset = Math.round(o.manualDlOffset);
  clearFreqCaches();
  broadcastStatus();
}

function getRadioState() {
  return {
    radioOn,
    locked,
    tciConnected: anyConnected(),
    connected: anyConnected(),
    dlConnected: dl.connected,
    ulConnected: ul.connected,
    connecting: dl.connecting || ul.connecting,
    dual: dualMode(),
    simplexActive,
    manualDlOffset,
    ulFineOffset,
    dlFineOffset,
    lastCmdDl: dl.lastHz,
    lastCmdUl: dualMode() ? ul.lastHz : dl.lastHzB,
    step: digitStep,
    ctcssMode,
    ctcssAccessHz,
    ctcssActivationHz,
    toneError,
    syncNeeded,
    cwMode,
    supportsCwMode: true,
    dataMode: false,
    supportsDataMode: false,
  };
}

function applyEndpointChange() {
  const wasOn = radioOn;
  close();
  if (wasOn) {
    radioOn = true;
    markSyncNeeded("endpoint change");
    satWarned = false;
    satFailed = false;
    mdNak = {};
    dl.wanted = true;
    openLink(dl)
      .then(() => ensureSatMode(dl, true))
      .catch(() => {});
    startVfoPoll();
  }
  broadcastStatus();
}

module.exports = {
  meta: {
    id: "ts2000",
    label: "Kenwood TS-2000 (ASCII CAT)",
    match(cfg) {
      if (typeof cfg.useTs2000Serial === "function")
        return cfg.useTs2000Serial();
      if (cfg.RADIO_TRANSPORT !== "serial") return false;
      const make = String(cfg.SERIAL_MAKE || "").toLowerCase();
      return make === "kenwood";
    },
  },
  init,
  open: () => openLink(dl),
  close,
  setRadio,
  setLock,
  applyDefaultLock,
  pushFrequencies,
  adjustFine,
  setStep,
  center,
  resetOffsets,
  setOffsets,
  setCtcss,
  applyDefaultCtcss,
  setCwMode,
  setDataMode,
  getRadioState,
  statusPayload,
  broadcastStatus,
  applyEndpointChange,
  // Test hooks (mock serial / unit checks)
  _test: {
    modesForCatalogMode,
    applyCwToMods,
    toneCode,
    TONE_TABLE,
    replyLooksBad,
    getLinks: () => ({ dl, ul }),
    getSplitOn: () => splitOn,
    getSatOn: () => satOn,
    getSatFailed: () => satFailed,
    SA_SAT_ON,
    getSimplexActive: () => simplexActive,
    getCwMode: () => cwMode,
    setCwModeFlag: (v) => {
      cwMode = !!v;
    },
    getToneError: () => toneError,
    getManualDlOffset: () => manualDlOffset,
    setManualDlOffset: (v) => {
      manualDlOffset = v;
    },
    catDebug,
  },
};
