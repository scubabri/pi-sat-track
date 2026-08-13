/**
 * Icom IC-9700 CI-V driver.
 *
 * IC-9700 CI-V. Default address 0xA2.
 *
 * Non-SAT single-radio (default — Radio 2 blank):
 *    MAIN (top)    = UL / TX   — set freq + mode directly
 *    SUB  (bottom) = DL / RX   — set freq + mode directly
 *    NOT using Icom SPLIT (0x0F 0x01) — we only ensure SPLIT stays OFF
 *    NOT using Satellite mode (0x16 0x5A) — forced OFF; optional later
 *    Dualwatch ON (0x16 0x59) so MAIN and SUB both receive/display
 *    Select MAIN/SUB (0x07 D0/D1), set freq (0x05), set mode (0x06)
 *    Cross-band: MAIN↔SUB exchange (0x07 B0) if VFO is on the wrong band
 *
 * Dual-radio (Radio 2 configured):
 *    Radio 1 = DL only, Radio 2 = UL only. No MAIN/SUB dualwatch layout.
 *
 * On enable/open: syncNeeded forces a full layout+freq+mode pass once.
 * Doppler uses deadband + min interval to avoid CI-V busy floods.
 */

const { SerialPort } = require("serialport");
const config = require("../config");
const {
  formatFreqDisplayFromMode,
  isFmMode,
  getCatalog,
} = require("../catalog");
const { rangeRateKmS } = require("../orbit");

// ── Per-link state ────────────────────────────────────────────
function makeLink(name) {
  return {
    name, // "dl" | "ul"
    port: null,
    connected: false,
    connecting: false,
    busy: false,
    buf: Buffer.alloc(0),
    lastHz: null,
    lastMode: null,
    reconnectTimer: null,
    wanted: false,
  };
}

const dl = makeLink("dl");
const ul = makeLink("ul");

let radioOn = false;
let locked = false;
let splitOn = false;
let dualWatchOn = false;
let satModeOffApplied = false; // non-SAT MAIN/SUB layout applied
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

const VFO_POLL_MS = 500;
const VFO_THRESH_HZ = 80;
const MODE_RETRIES = 3;
const FREQ_RETRIES = 3;
const SYNC_WINDOW_MS = 12000;
const SYNC_OK_STREAK = 2;

/** Min time between Doppler pushes once sync is done (ms). */
const PUSH_MIN_MS = 500;
/** After sync: only command radio when |Δf| exceeds this (Hz). */
const FREQ_DEADBAND_HZ = 10;
/** During sync / force: still skip sub-Hz chatter. */
const FREQ_SYNC_THRESH_HZ = 1;

let syncNeeded = false;
let syncStartedAt = 0;
let syncOkStreak = 0;

/** Collapse concurrent / too-fast Doppler ticks. */
let pushInFlight = false;
let lastPushAt = 0;
let pendingPush = null; // { ulHz, dlHz } | null
let pendingTimer = null;

let getCtx = () => ({
  satrec: null,
  observer: null,
  currentSatKey: null,
  currentModeIndex: 0,
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function init(opts) {
  if (opts && opts.broadcast) broadcastFn = opts.broadcast;
  if (opts && opts.getContext) getCtx = opts.getContext;
}

/** True when Radio 2 is configured → dual-radio, never SPLIT on Radio 1. */
function dualMode() {
  return typeof config.isDualCat === "function"
    ? config.isDualCat()
    : !!(config.CAT2_DEVICE && String(config.CAT2_DEVICE).trim());
}

function deviceFor(link) {
  if (link.name === "ul" && dualMode()) {
    return {
      path: config.CAT2_DEVICE,
      baud: config.CAT2_BAUD || config.CAT_BAUD,
      civ:
        config.CAT2_CIV_ADDR != null
          ? config.CAT2_CIV_ADDR
          : config.CAT_CIV_ADDR,
    };
  }
  return {
    path: config.CAT_DEVICE,
    baud: config.CAT_BAUD,
    civ: config.CAT_CIV_ADDR,
  };
}

function markSyncNeeded(reason) {
  syncNeeded = true;
  syncStartedAt = Date.now();
  syncOkStreak = 0;
  dl.lastMode = null;
  ul.lastMode = null;
  dl.lastHz = null;
  ul.lastHz = null;
  // Re-apply SAT-off + Dualwatch on next push
  satModeOffApplied = false;
  dualWatchOn = false;
  // Force an immediate push on next tick
  lastPushAt = 0;
  console.log(
    "IC9700 syncNeeded:",
    reason || "enable",
    dualMode() ? "(dual)" : "(single)",
  );
}

function clearSyncNeeded(reason) {
  if (!syncNeeded) return;
  syncNeeded = false;
  syncOkStreak = 0;
  console.log("IC9700 sync clear:", reason || "ok");
}

function maybeClearSync(okThisTick) {
  if (!syncNeeded) return;
  if (okThisTick) syncOkStreak += 1;
  else syncOkStreak = 0;
  const elapsed = Date.now() - syncStartedAt;
  if (syncOkStreak >= SYNC_OK_STREAK) {
    clearSyncNeeded("verified streak " + syncOkStreak);
  } else if (elapsed >= SYNC_WINDOW_MS && syncOkStreak >= 1) {
    clearSyncNeeded("window " + elapsed + "ms");
  } else if (elapsed >= SYNC_WINDOW_MS * 1.5) {
    clearSyncNeeded("window expired");
  }
}

function anyConnected() {
  return dl.connected || ul.connected;
}

function statusPayload() {
  return {
    type: "icom",
    radioOn,
    locked,
    connected: anyConnected(),
    dlConnected: dl.connected,
    ulConnected: ul.connected,
    connecting: dl.connecting || ul.connecting,
    dual: dualMode(),
    splitOn: dualMode() ? false : splitOn,
    device: config.CAT_DEVICE,
    device2: dualMode() ? config.CAT2_DEVICE : "",
    baud: config.CAT_BAUD,
    civAddr: config.CAT_CIV_ADDR,
    lastDlHz: dl.lastHz,
    lastUlHz: ul.lastHz,
    manualDlOffset,
    ulFineOffset,
    dlFineOffset,
    step: digitStep,
    ctcssMode,
    ctcssAccessHz,
    ctcssActivationHz,
    syncNeeded,
  };
}

function broadcastStatus() {
  broadcastFn(statusPayload());
  broadcastFn({
    type: "tci",
    radioOn,
    locked,
    connected: anyConnected(),
    connecting: dl.connecting || ul.connecting,
    host: config.CAT_DEVICE,
    port: config.CAT_BAUD,
    manualDlOffset,
    ulFineOffset,
    dlFineOffset,
    step: digitStep,
    lastCmdDl: dl.lastHz,
    lastCmdUl: ul.lastHz,
    ctcssMode,
    ctcssAccessHz,
    ctcssActivationHz,
  });
}

function freqToBcd(freqHz) {
  const s = String(Math.round(freqHz)).padStart(10, "0");
  const bcd = [];
  for (let i = 0; i < 10; i += 2) {
    const high = parseInt(s[i], 10);
    const low = parseInt(s[i + 1], 10);
    bcd.push((high << 4) | low);
  }
  return Buffer.from(bcd.reverse());
}

function bcdToFreq(data) {
  if (!data || data.length !== 5) throw new Error("Expected 5 BCD bytes");
  let freq = 0;
  let mult = 1;
  for (const b of data) {
    const low = b & 0x0f;
    const high = (b >> 4) & 0x0f;
    freq += low * mult;
    mult *= 10;
    freq += high * mult;
    mult *= 10;
  }
  return freq;
}

function toneToBcd(hz) {
  const tenths = Math.round(hz * 10);
  const s = String(tenths).padStart(4, "0");
  const b0 = 0x00;
  const b1 = ((parseInt(s[0], 10) << 4) | parseInt(s[1], 10)) & 0xff;
  const b2 = ((parseInt(s[2], 10) << 4) | parseInt(s[3], 10)) & 0xff;
  return Buffer.from([b0, b1, b2]);
}

function modesForCatalogMode(modeStr) {
  const m = (modeStr || "").toUpperCase();
  if (isFmMode(modeStr) || /\bFM\b|NFM|GFSK|CTCSS|C4FM|DSTAR|DMR/.test(m)) {
    return { ul: 0x05, dl: 0x05, ulName: "FM", dlName: "FM" };
  }
  // Pure CW (not "SSB CW*" linear) — both sides CW
  if (/\bCW\b/.test(m) && !/\bSSB\b/.test(m)) {
    return { ul: 0x03, dl: 0x03, ulName: "CW", dlName: "CW" };
  }
  // Linear / inverting (RS-44, FO-29, AO-7, …): UL LSB, DL USB
  // Icom CI-V: 0x00 = LSB, 0x01 = USB
  return { ul: 0x00, dl: 0x01, ulName: "LSB", dlName: "USB" };
}

function writeRaw(link, data) {
  return new Promise((resolve) => {
    if (!link.port || !link.connected) {
      resolve(false);
      return;
    }
    link.port.write(data, (err) => {
      if (err) {
        console.warn("Icom", link.name, "write failed:", err.message);
        resolve(false);
        return;
      }
      link.port.drain(() => resolve(true));
    });
  });
}

async function sendCiv(link, command) {
  if (!link.port || !link.connected)
    throw new Error("Icom " + link.name + " not connected");
  if (link.busy) throw new Error("Icom " + link.name + " busy");
  link.busy = true;
  try {
    link.buf = Buffer.alloc(0);
    const { civ } = deviceFor(link);
    const frame = Buffer.concat([
      Buffer.from([0xfe, 0xfe, civ, 0xe0]),
      command,
      Buffer.from([0xfd]),
    ]);
    const ok = await writeRaw(link, frame);
    if (!ok) throw new Error("Icom " + link.name + " write failed");
    const tEnd = Date.now() + 250;
    while (Date.now() < tEnd) {
      if (link.buf.includes(0xfd)) break;
      await sleep(15);
    }
    await sleep(20);
    const reply = Buffer.from(link.buf);
    link.buf = Buffer.alloc(0);
    return reply;
  } finally {
    link.busy = false;
  }
}

function clearReconnect(link) {
  if (link.reconnectTimer) {
    clearTimeout(link.reconnectTimer);
    link.reconnectTimer = null;
  }
}

function scheduleReconnect(link) {
  clearReconnect(link);
  if (!radioOn || !link.wanted) return;
  link.reconnectTimer = setTimeout(() => {
    link.reconnectTimer = null;
    if (radioOn && link.wanted && !link.connected && !link.connecting) {
      openLink(link).catch(() => {});
    }
  }, 3000);
}

function openLink(link) {
  if (link.port && link.connected) return Promise.resolve(true);
  if (link.connecting) return Promise.resolve(false);
  const { path, baud, civ } = deviceFor(link);
  if (!path) {
    console.warn("Icom", link.name, "no device path");
    return Promise.resolve(false);
  }
  link.connecting = true;
  broadcastStatus();
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      link.connecting = false;
      if (!ok) scheduleReconnect(link);
      broadcastStatus();
      resolve(ok);
    };
    try {
      const p = new SerialPort({
        path,
        baudRate: baud,
        dataBits: 8,
        parity: "none",
        stopBits: 1,
        autoOpen: false,
      });
      const timer = setTimeout(() => {
        try {
          p.close();
        } catch (_) {}
        done(false);
      }, 3000);
      p.open((err) => {
        if (err) {
          clearTimeout(timer);
          console.warn("Icom", link.name, "open failed:", err.message);
          done(false);
          return;
        }
        clearTimeout(timer);
        link.port = p;
        link.connected = true;
        link.buf = Buffer.alloc(0);
        link.lastHz = null;
        link.lastMode = null;
        markSyncNeeded("open " + link.name);
        clearReconnect(link);
        p.on("data", (chunk) => {
          link.buf = Buffer.concat([link.buf, chunk]);
          if (link.buf.length > 4096) link.buf = link.buf.slice(-1024);
        });
        p.on("close", () => {
          link.connected = false;
          link.connecting = false;
          link.port = null;
          link.buf = Buffer.alloc(0);
          if (link.name === "dl") stopVfoPoll();
          broadcastStatus();
          if (radioOn && link.wanted) scheduleReconnect(link);
        });
        p.on("error", (e) =>
          console.warn("Icom", link.name, "error:", e.message),
        );
        console.log(
          "Icom",
          link.name.toUpperCase(),
          "open",
          path,
          baud,
          "addr 0x" + civ.toString(16).toUpperCase(),
          dualMode() ? "[dual]" : "[single]",
        );
        if (link.name === "dl") startVfoPoll();
        done(true);
      });
    } catch (e) {
      console.warn("Icom", link.name, "exception:", e.message);
      done(false);
    }
  });
}

function closeLink(link) {
  clearReconnect(link);
  link.wanted = false;
  link.connecting = false;
  if (link.name === "dl") stopVfoPoll();
  if (link.port) {
    try {
      link.port.removeAllListeners();
      link.port.close();
    } catch (_) {}
    link.port = null;
  }
  link.connected = false;
  link.busy = false;
  link.buf = Buffer.alloc(0);
  link.lastHz = null;
  link.lastMode = null;
}

function close() {
  radioOn = false;
  syncNeeded = false;
  splitOn = false;
  pushInFlight = false;
  pendingPush = null;
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  closeLink(dl);
  closeLink(ul);
  lastCtcssApplied = null;
  broadcastStatus();
}

function setRadio(on) {
  if (on) {
    radioOn = true;
    manualDlOffset = 0;
    ulFineOffset = 0;
    dlFineOffset = 0;
    lastCtcssApplied = null;
    splitOn = false;
    markSyncNeeded("setRadio");
    broadcastStatus();
    // Open primary (DL / split host) immediately; UL opens on first push if dual
    dl.wanted = true;
    openLink(dl).catch(() => {});
  } else {
    close();
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
  console.log("IC9700 CTCSS", ctcssMode, activeCtcssHz());
  applyCtcssToRadio().catch(() => {});
  broadcastStatus();
}

function applyDefaultCtcss(accessHz, activationHz) {
  ctcssAccessHz = accessHz != null ? accessHz : null;
  ctcssActivationHz = activationHz != null ? activationHz : null;
  if (ctcssAccessHz != null) ctcssMode = "access";
  else ctcssMode = "off";
  lastCtcssApplied = null;
  console.log(
    "IC9700 CTCSS default",
    ctcssMode,
    "access",
    ctcssAccessHz,
    "act",
    ctcssActivationHz,
  );
  broadcastStatus();
}

/** CTCSS on the UL radio: Radio 2 in dual, MAIN (top) port in single-radio. */
async function applyCtcssToRadio() {
  const link = dualMode() ? ul : dl;
  if (!link.connected) return;
  const hz = activeCtcssHz();
  const key = hz != null ? String(hz) : "off";
  if (key === lastCtcssApplied) return;
  try {
    if (hz != null) {
      await sendCiv(
        link,
        Buffer.concat([Buffer.from([0x1b, 0x00]), toneToBcd(hz)]),
      );
      await sendCiv(link, Buffer.from([0x16, 0x42, 0x01]));
      console.log("IC9700 CTCSS", hz, "Hz ON on", link.name);
    } else {
      await sendCiv(link, Buffer.from([0x16, 0x42, 0x00]));
      console.log("IC9700 CTCSS OFF on", link.name);
    }
    lastCtcssApplied = key;
  } catch (e) {
    console.warn("IC9700 CTCSS:", e.message);
  }
}

async function selectMain(link) {
  try {
    await sendCiv(link, Buffer.from([0x07, 0xd0]));
    return true;
  } catch (e) {
    return false;
  }
}

async function selectSub(link) {
  try {
    await sendCiv(link, Buffer.from([0x07, 0xd1]));
    return true;
  } catch (e) {
    return false;
  }
}

async function selectMainOrSub(link, which) {
  if (which === "B" || which === "sub" || which === "SUB")
    return selectSub(link);
  return selectMain(link);
}

/** Coarse band group for MAIN/SUB cross-band detection. */
function bandGroup(hz) {
  if (!Number.isFinite(hz)) return "other";
  if (hz >= 1.0e9) return "23cm";
  if (hz >= 220e6) return "70cm";
  if (hz >= 100e6) return "2m";
  return "other";
}

/**
 * Single-radio: TX on MAIN (top). SPLIT must be OFF.
 * Dual-radio: Radio 1 never in SPLIT.
 */
async function ensureSplitOff(force) {
  if (!dl.connected) return false;
  // Do not re-send on every Doppler tick — that saturates CI-V and stalls updates
  if (!force && !splitOn && !syncNeeded && satModeOffApplied) return true;
  try {
    const reply = await sendCiv(dl, Buffer.from([0x0f, 0x00]));
    if (reply.includes(0xfa)) {
      console.warn("IC9700 SPLIT OFF NAK");
      return false;
    }
    if (force || splitOn || syncNeeded) {
      console.log("IC9700 SPLIT OFF (TX = MAIN / top VFO)");
    }
    splitOn = false;
    return true;
  } catch (e) {
    console.warn("IC9700 SPLIT OFF:", e.message);
    return false;
  }
}

/**
 * IC-9700 CI-V Reference:
 *   0x16 0x5A = Satellite mode (00=OFF, 01=ON)
 * In SAT mode many freq/mode ops return FA (NAK) and TX is forced to SUB.
 * We operate non-SAT dualwatch: MAIN=UL/TX, SUB=DL/RX.
 */
/**
 * Force Satellite mode OFF. Call with force=true on every full sync so a
 * front-panel SAT enable cannot stick across pushes.
 */
async function ensureSatModeOff(force) {
  if (!dl.connected) return false;
  if (!force && satModeOffApplied && !syncNeeded) return true;
  try {
    // Select MAIN first — some firmware ignores mode cmds on SUB focus
    await selectMain(dl);
    const reply = await sendCiv(dl, Buffer.from([0x16, 0x5a, 0x00]));
    if (reply.includes(0xfa)) {
      console.warn("IC9700 SAT mode OFF NAK");
      satModeOffApplied = false;
      return false;
    }
    satModeOffApplied = true;
    console.log("IC9700 Satellite mode OFF (0x16 0x5A 0x00)");
    return true;
  } catch (e) {
    console.warn("IC9700 SAT mode OFF:", e.message);
    satModeOffApplied = false;
    return false;
  }
}

/**
 * Dualwatch = SUB audible while MAIN selected for TX.
 * CI-V: 0x16 0x59 (NOT 0x5A — that is satellite mode).
 * Apply once per open/sync; do not re-send every Doppler tick.
 */
async function ensureDualWatch(on) {
  if (dualMode() || !dl.connected) return false;
  if (on && dualWatchOn && !syncNeeded) return true;
  if (!on && !dualWatchOn && !syncNeeded) return true;
  try {
    const reply = await sendCiv(
      dl,
      Buffer.from([0x16, 0x59, on ? 0x01 : 0x00]),
    );
    if (reply.includes(0xfa)) {
      console.warn("IC9700 Dualwatch", on ? "ON" : "OFF", "NAK");
      return false;
    }
    dualWatchOn = !!on;
    console.log("IC9700 Dualwatch", on ? "ON" : "OFF", "(0x16 0x59)");
    return true;
  } catch (e) {
    console.warn("IC9700 Dualwatch:", e.message);
    return false;
  }
}

/**
 * Exchange MAIN ↔ SUB contents (IC-9700 / dualwatch Icoms).
 * Useful when bands are inverted (MAIN on 2m, SUB on 70cm but we need the opposite).
 */
async function exchangeMainSub() {
  if (!dl.connected) return false;
  try {
    const reply = await sendCiv(dl, Buffer.from([0x07, 0xb0]));
    if (reply.includes(0xfa)) {
      console.warn("IC9700 MAIN↔SUB exchange NAK");
      return false;
    }
    // Swap our cached state to match radio
    const hz = dl.lastHz;
    const md = dl.lastMode;
    dl.lastHz = ul.lastHz;
    dl.lastMode = ul.lastMode;
    ul.lastHz = hz;
    ul.lastMode = md;
    console.log("IC9700 MAIN↔SUB exchange");
    return true;
  } catch (e) {
    console.warn("IC9700 exchange:", e.message);
    return false;
  }
}

/**
 * Which lastHz / lastMode store to use for this VFO.
 * Single-radio: MAIN → ul store (TX), SUB → dl store (RX) via callers.
 * Physical select: vfo "A"/MAIN vs "B"/SUB.
 * Dual: always the physical link's own store.
 */
function bandState(link, vfo) {
  const useSub = !dualMode() && (vfo === "B" || vfo === "sub");
  if (dualMode()) {
    return { store: link, useSub: false, band: "MAIN" };
  }
  // Single-radio: MAIN tracks UL, SUB tracks DL
  if (useSub) return { store: dl, useSub: true, band: "SUB" };
  return { store: ul, useSub: false, band: "MAIN" };
}

/**
 * Set frequency on a link.
 * In split mode on DL link: which "A"|"B" selects MAIN/SUB.
 * In dual mode: always MAIN on that radio.
 */
async function setLinkFrequency(link, freqHz, force, vfo) {
  if (!Number.isFinite(freqHz) || freqHz < 1e5 || freqHz > 5e8) return false;
  if (!link.connected) return false;
  const target = Math.round(freqHz);
  const { store, useSub, band } = bandState(link, vfo);

  // Always retune when crossing 2m/70cm/23cm — deadband must not skip band changes
  const bandChange =
    store.lastHz != null && bandGroup(store.lastHz) !== bandGroup(target);
  const thresh =
    force || syncNeeded || bandChange ? FREQ_SYNC_THRESH_HZ : FREQ_DEADBAND_HZ;
  if (
    !force &&
    !bandChange &&
    store.lastHz != null &&
    Math.abs(target - store.lastHz) < thresh
  ) {
    return true;
  }

  const bcd = freqToBcd(target);

  for (let attempt = 1; attempt <= FREQ_RETRIES; attempt++) {
    try {
      // Prefer select band + classic 0x05 (most reliable on 9700)
      await selectMainOrSub(link, useSub ? "B" : "A");
      let reply = await sendCiv(
        link,
        Buffer.concat([Buffer.from([0x05]), bcd]),
      );
      if (reply.includes(0xfa)) {
        // Fallback: try 0x25 with sub-code
        const sub = useSub ? 0x01 : 0x00;
        reply = await sendCiv(
          link,
          Buffer.concat([Buffer.from([0x25, sub]), bcd]),
        );
        if (reply.includes(0xfa)) {
          console.warn(
            "Icom",
            link.name,
            band,
            "freq NAK",
            (target / 1e6).toFixed(6),
            "MHz attempt",
            attempt,
          );
          await sleep(80 * attempt);
          continue;
        }
      }
      store.lastHz = target;
      if (attempt > 1 || force || syncNeeded) {
        console.log(
          "Icom",
          link.name.toUpperCase(),
          band,
          "freq OK",
          (target / 1e6).toFixed(6),
          "MHz attempt",
          attempt,
        );
      }
      // Leave MAIN selected after SUB ops in split
      if (useSub) await selectMain(link);
      return true;
    } catch (e) {
      console.warn("Icom", link.name, "freq:", e.message);
      await sleep(80 * attempt);
    }
  }
  return false;
}

async function setLinkMode(link, mdCode, modeName, force, vfo) {
  if (!link.connected) return false;
  const { store, useSub, band } = bandState(link, vfo);

  if (!force && !syncNeeded && store.lastMode === mdCode) return true;

  // Probe (IC-9700): 0x06 after select MAIN/SUB → ACK; 0x26 → NAK.
  for (let attempt = 1; attempt <= MODE_RETRIES; attempt++) {
    try {
      await selectMainOrSub(link, useSub ? "B" : "A");
      let reply = await sendCiv(link, Buffer.from([0x06, mdCode, 0x01]));
      if (reply.includes(0xfa)) {
        reply = await sendCiv(link, Buffer.from([0x06, mdCode]));
      }
      if (reply.includes(0xfa)) {
        // Last resort (usually NAKs on this radio)
        const vfoCode = useSub ? 0x01 : 0x00;
        reply = await sendCiv(link, Buffer.from([0x26, vfoCode, mdCode, 0x01]));
      }
      if (reply.includes(0xfa)) {
        console.warn(
          "Icom",
          link.name,
          band,
          "mode NAK",
          modeName,
          "code",
          mdCode,
          "attempt",
          attempt,
        );
        await sleep(100 * attempt);
        continue;
      }
      store.lastMode = mdCode;
      console.log(
        "Icom",
        link.name.toUpperCase(),
        band,
        "mode →",
        modeName,
        "(0x" + mdCode.toString(16) + ")",
        useSub ? "SUB" : "MAIN",
      );
      if (useSub) await selectMain(link);
      return true;
    } catch (e) {
      console.warn("Icom", link.name, "mode:", e.message);
      await sleep(100 * attempt);
    }
  }
  return false;
}

/**
 * Extract frequency from a CI-V reply buffer by walking FE FE … FD frames
 * (avoids indexOf(0x03) matching a BCD digit).
 */
function parseFreqFromCivReply(reply, cmdByte, dataOffset) {
  if (!reply || !reply.length) return null;
  let i = 0;
  while (i < reply.length - 5) {
    if (reply[i] !== 0xfe || reply[i + 1] !== 0xfe) {
      i += 1;
      continue;
    }
    let end = -1;
    for (let j = i + 2; j < reply.length; j++) {
      if (reply[j] === 0xfd) {
        end = j;
        break;
      }
    }
    if (end < 0) break;
    // body: to, from, cmd, data…
    const body = reply.slice(i + 2, end);
    if (body.length >= 3 + dataOffset + 5 && body[2] === cmdByte) {
      try {
        const hz = bcdToFreq(body.slice(3 + dataOffset, 3 + dataOffset + 5));
        // IC-9700 valid bands only
        if (hz >= 1e6 && hz <= 2e9) return hz;
      } catch (_) {}
    }
    i = end + 1;
  }
  return null;
}

async function getSelectedFrequency(link, which) {
  if (!link || !link.connected) return null;
  const sub = which === "B" || which === "sub" || which === "SUB";
  try {
    await selectMainOrSub(link, sub ? "B" : "A");
    let reply = await sendCiv(link, Buffer.from([0x03]));
    let hz = parseFreqFromCivReply(reply, 0x03, 0);
    if (hz != null) return hz;
    // Fallback 0x25 with MAIN/SUB subcode (data: subcode + 5 BCD)
    const sc = sub ? 0x01 : 0x00;
    reply = await sendCiv(link, Buffer.from([0x25, sc]));
    hz = parseFreqFromCivReply(reply, 0x25, 1);
    return hz;
  } catch (e) {
    return null;
  }
}

function getActiveModeObj(info, modeIndex) {
  if (!info) return null;
  const modes = info.modes || [];
  if (!modes.length) {
    return {
      mode: info.mode || "",
      uplink: info.uplink || "",
      downlink: info.downlink || "",
      beacon: info.beacon || "",
    };
  }
  const idx = Math.max(0, Math.min(modeIndex || 0, modes.length - 1));
  return modes[idx];
}

function schedulePendingFlush() {
  if (pendingTimer) return;
  const wait = Math.max(50, PUSH_MIN_MS - (Date.now() - lastPushAt));
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    if (!pendingPush || !radioOn) return;
    const p = pendingPush;
    pendingPush = null;
    pushFrequencies(p.ulHz, p.dlHz).catch(() => {});
  }, wait);
}

/**
 * Actual CI-V work for one push. Caller holds pushInFlight.
 */
async function pushFrequenciesBody(ulHz, dlHz) {
  const dual = dualMode();
  const force = syncNeeded;
  // Reject garbage Doppler/offset results (e.g. ±10 GHz from poisoned manualDlOffset)
  if (ulHz != null && Number.isFinite(ulHz) && !isPlausibleRigHz(ulHz)) {
    console.warn(
      "IC9700 skip UL — implausible",
      (ulHz / 1e6).toFixed(6),
      "MHz (manualDl",
      Math.round(manualDlOffset),
      "ulFine",
      Math.round(ulFineOffset),
      ")",
    );
    ulHz = null;
  }
  if (dlHz != null && Number.isFinite(dlHz) && !isPlausibleRigHz(dlHz)) {
    console.warn(
      "IC9700 skip DL — implausible",
      (dlHz / 1e6).toFixed(6),
      "MHz (manualDl",
      Math.round(manualDlOffset),
      ")",
    );
    dlHz = null;
  }
  const hasUl = ulHz != null && Number.isFinite(ulHz);
  const hasDl = dlHz != null && Number.isFinite(dlHz);

  const { currentSatKey, currentModeIndex } = getCtx();
  const info = getCatalog()[currentSatKey] || {};
  const active = getActiveModeObj(info, currentModeIndex);
  const mods = modesForCatalogMode(active && active.mode);

  // Ensure primary port open
  if (hasDl || hasUl || !dual) {
    dl.wanted = true;
    if (!dl.connected) {
      const okOpen = await openLink(dl);
      if (!okOpen) {
        maybeClearSync(false);
        return;
      }
    }
  }

  if (dual && hasUl) {
    ul.wanted = true;
    if (!ul.connected) {
      await openLink(ul);
    }
  } else if (!dual) {
    ul.wanted = false;
    if (ul.connected) closeLink(ul);
  }

  let ok = true;

  if (dual) {
    // ── DUAL: Radio 1 = DL only, Radio 2 = UL only ──
    await ensureSatModeOff(force || syncNeeded);
    await ensureSplitOff(force || syncNeeded);

    if (hasDl && dl.connected) {
      await selectMain(dl);
      const m = await setLinkMode(dl, mods.dl, mods.dlName, force, "A");
      const f = await setLinkFrequency(dl, Math.round(dlHz), force, "A");
      if (!m || !f) ok = false;
      else if (force || syncNeeded) {
        console.log(
          "IC9700 DL (R1)",
          (Math.round(dlHz) / 1e6).toFixed(6),
          "MHz [dual]",
        );
      }
    }
    if (hasUl && ul.connected) {
      await selectMain(ul);
      const m = await setLinkMode(ul, mods.ul, mods.ulName, force, "A");
      const f = await setLinkFrequency(ul, Math.round(ulHz), force, "A");
      if (!m || !f) ok = false;
      else if (force || syncNeeded) {
        console.log(
          "IC9700 UL (R2)",
          (Math.round(ulHz) / 1e6).toFixed(6),
          "MHz [dual]",
        );
      }
    }
  } else {
    // ── SINGLE: MAIN (top) = UL/TX, SUB (bottom) = DL/RX ──
    // Non-SAT: MAIN=UL/TX (e.g. 145 LSB), SUB=DL/RX (e.g. 435 USB). No SPLIT.
    if (!dl.connected) {
      maybeClearSync(false);
      return;
    }

    // Force full retune when UL band changed (e.g. ISS mode3 70cm → RS-44 2m)
    // without a setRadio cycle — otherwise modes update but freqs stay stale.
    let forceTune = force || syncNeeded;
    if (
      !forceTune &&
      hasUl &&
      ul.lastHz != null &&
      Number.isFinite(ulHz) &&
      bandGroup(ul.lastHz) !== "other" &&
      bandGroup(ulHz) !== "other" &&
      bandGroup(ul.lastHz) !== bandGroup(ulHz)
    ) {
      const was = bandGroup(ul.lastHz);
      forceTune = true;
      ul.lastHz = null;
      dl.lastHz = null;
      ul.lastMode = null;
      dl.lastMode = null;
      console.log(
        "IC9700 force retune (UL band",
        bandGroup(ulHz),
        "was",
        was + ")",
      );
    }
    // SAT OFF on full sync (and Test); skip once applied during Doppler ticks
    await ensureSatModeOff(forceTune);
    await ensureSplitOff(forceTune);
    await ensureDualWatch(true);

    const ulTarget = hasUl ? Math.round(ulHz) : null;
    const dlTarget = hasDl ? Math.round(dlHz) : null;

    // Cross-band: IC-9700 NAKs 0x05 when the selected VFO is on the wrong
    // band stack. Exchange MAIN↔SUB *before* set when MAIN is not on UL band.
    // On full sync lastHz is often null — read MAIN from the radio instead.
    if (
      ulTarget != null &&
      dlTarget != null &&
      bandGroup(ulTarget) !== "other" &&
      bandGroup(dlTarget) !== "other" &&
      bandGroup(ulTarget) !== bandGroup(dlTarget)
    ) {
      let haveMain = bandGroup(ul.lastHz);
      if (haveMain === "other" && forceTune) {
        const mainHz = await getSelectedFrequency(dl, "A");
        if (mainHz != null) {
          haveMain = bandGroup(mainHz);
          ul.lastHz = mainHz; // cache for later ticks
        }
      }
      if (haveMain !== "other" && haveMain !== bandGroup(ulTarget)) {
        console.log(
          "IC9700 MAIN↔SUB exchange before set (MAIN on",
          haveMain,
          "need",
          bandGroup(ulTarget) + ")",
        );
        await exchangeMainSub();
      }
    }

    if (forceTune) {
      ul.lastMode = null;
      dl.lastMode = null;
    }

    // Frequency first (band stack), then mode — MAIN = UL (LSB for RS-44)
    if (ulTarget != null) {
      const f = await setLinkFrequency(dl, ulTarget, forceTune, "A");
      const m = await setLinkMode(dl, mods.ul, mods.ulName, forceTune, "A");
      if (!m || !f) ok = false;
      if (forceTune || !f) {
        console.log(
          "IC9700 MAIN (UL/TX)",
          (ulTarget / 1e6).toFixed(6),
          "MHz",
          mods.ulName,
          "[top]",
          f ? "OK" : "FAIL",
        );
      }
    }
    // SUB = DL (USB for RS-44)
    if (dlTarget != null) {
      const f = await setLinkFrequency(dl, dlTarget, forceTune, "B");
      const m = await setLinkMode(dl, mods.dl, mods.dlName, forceTune, "B");
      if (!m || !f) ok = false;
      if (forceTune || !f) {
        console.log(
          "IC9700 SUB (DL/RX)",
          (dlTarget / 1e6).toFixed(6),
          "MHz",
          mods.dlName,
          "[bottom]",
          f ? "OK" : "FAIL",
        );
      }
    }

    // Verify MAIN is on UL band; if still inverted, exchange + re-apply once
    if (ulTarget != null && dlTarget != null && (force || syncNeeded)) {
      const mainHz = await getSelectedFrequency(dl, "A");
      if (
        mainHz != null &&
        bandGroup(mainHz) === bandGroup(dlTarget) &&
        bandGroup(ulTarget) !== bandGroup(dlTarget)
      ) {
        console.warn(
          "IC9700 MAIN still on DL band after set — exchanging MAIN↔SUB",
        );
        await exchangeMainSub();
        await setLinkFrequency(dl, ulTarget, true, "A");
        await setLinkMode(dl, mods.ul, mods.ulName, true, "A");
        await setLinkFrequency(dl, dlTarget, true, "B");
        await setLinkMode(dl, mods.dl, mods.dlName, true, "B");
      }
    }

    // TX focus on MAIN (top). Avoid CI-V spam on Doppler ticks.
    if (forceTune) {
      await selectMain(dl);
      await ensureSplitOff(true);
    }
  }

  await applyCtcssToRadio();
  maybeClearSync(ok && anyConnected());
}

async function pushFrequencies(ulHz, dlHz) {
  if (!radioOn) return;

  // Always keep the latest desired frequencies
  if (pushInFlight) {
    pendingPush = { ulHz, dlHz };
    return;
  }

  const now = Date.now();
  if (!syncNeeded && lastPushAt && now - lastPushAt < PUSH_MIN_MS) {
    pendingPush = { ulHz, dlHz };
    schedulePendingFlush();
    return;
  }

  pushInFlight = true;
  lastPushAt = now;
  try {
    await pushFrequenciesBody(ulHz, dlHz);
  } finally {
    pushInFlight = false;
    if (pendingPush && radioOn) {
      const p = pendingPush;
      pendingPush = null;
      const elapsed = Date.now() - lastPushAt;
      if (syncNeeded || elapsed >= PUSH_MIN_MS) {
        // Run soon on next microtask so we don't nest deeply
        setImmediate(() => {
          pushFrequencies(p.ulHz, p.dlHz).catch(() => {});
        });
      } else {
        pendingPush = p;
        schedulePendingFlush();
      }
    }
  }
}

/** Max |manual/fine offset| we will ever apply (Hz). Beyond this is parse/corrupt data. */
const MAX_OFFSET_HZ = 100000; // ±100 kHz

function clampOffset(hz) {
  if (!Number.isFinite(hz)) return 0;
  if (hz > MAX_OFFSET_HZ) return MAX_OFFSET_HZ;
  if (hz < -MAX_OFFSET_HZ) return -MAX_OFFSET_HZ;
  return hz;
}

function isPlausibleRigHz(hz) {
  if (!Number.isFinite(hz)) return false;
  // IC-9700: 144–148, 430–450, 1240–1300 MHz (with margin)
  if (hz >= 140e6 && hz <= 150e6) return true;
  if (hz >= 420e6 && hz <= 460e6) return true;
  if (hz >= 1200e6 && hz <= 1320e6) return true;
  return false;
}

async function pollVfo() {
  // VFO knob tracking disabled: mis-parsed CI-V reads were poisoning
  // manualDlOffset (~10 GHz) and producing -9760/10341 MHz commands.
  // Doppler still comes from TLE + catalog; operator fine-tune uses adjustFine.
  return;
}

function startVfoPoll() {
  if (vfoPollTimer) return;
  vfoPollTimer = setInterval(() => {
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
  if (typeof delta !== "number") return;
  if (side === "dl") {
    dlFineOffset += delta;
    dl.lastHz = null;
    console.log("IC9700 DL fine", delta, "→", dlFineOffset);
  } else {
    ulFineOffset += delta;
    ul.lastHz = null;
    console.log("IC9700 UL fine", delta, "→", ulFineOffset);
  }
  // Allow immediate retune after fine adjust
  lastPushAt = 0;
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
  dl.lastHz = null;
  ul.lastHz = null;
  lastPushAt = 0;
  broadcastStatus();
}

function resetOffsets() {
  manualDlOffset = 0;
  ulFineOffset = 0;
  dlFineOffset = 0;
  dl.lastHz = null;
  ul.lastHz = null;
  dl.lastMode = null;
  ul.lastMode = null;
}

/** Absolute restore of saved per-sat calibration (after resetOffsets). */
function setOffsets(o) {
  if (!o || typeof o !== "object") return;
  // Only accept small calibration values. Anything beyond ±50 kHz is treated
  // as corrupt (e.g. UL 347000) and zeroed — not required for normal Doppler.
  const lim = 50000;
  function take(v, name) {
    if (typeof v !== "number" || !Number.isFinite(v)) return 0;
    const r = Math.round(v);
    if (Math.abs(r) > lim) {
      console.warn(
        "IC9700 ignoring corrupt",
        name,
        r,
        "Hz (limit ±" + lim + ") — using 0",
      );
      return 0;
    }
    return r;
  }
  ulFineOffset = take(o.ulFineOffset, "ulFineOffset");
  dlFineOffset = take(o.dlFineOffset, "dlFineOffset");
  manualDlOffset = take(o.manualDlOffset, "manualDlOffset");
  dl.lastHz = null;
  ul.lastHz = null;
  lastPushAt = 0;
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
    manualDlOffset,
    ulFineOffset,
    dlFineOffset,
    lastCmdDl: dl.lastHz,
    lastCmdUl: ul.lastHz,
    step: digitStep,
    ctcssMode,
    ctcssAccessHz,
    ctcssActivationHz,
    syncNeeded,
  };
}

function applyEndpointChange() {
  const wasOn = radioOn;
  close();
  if (wasOn) {
    radioOn = true;
    markSyncNeeded("endpoint change");
    dl.wanted = true;
    openLink(dl).catch(() => {});
  }
  broadcastStatus();
}

/**
 * Connection-test without reopening the serial port (Test button while radio ON).
 * Also re-asserts SAT OFF + Dualwatch + SPLIT OFF.
 */
async function runConnectionTest() {
  if (!dl.connected) {
    return {
      ok: false,
      message:
        "IC9700 serial not open — turn Radio ON first, or Test while OFF with free port",
    };
  }
  try {
    await ensureSatModeOff(true);
    await ensureSplitOff();
    await ensureDualWatch(true);
    await selectMain(dl);
    const mainHz = await getSelectedFrequency(dl, "A");
    const subHz = await getSelectedFrequency(dl, "B");
    await selectMain(dl);
    const fmt = (hz) =>
      hz != null && Number.isFinite(hz) ? (hz / 1e6).toFixed(6) : null;
    const m = fmt(mainHz);
    const s = fmt(subHz);
    if (!m && !s) {
      return {
        ok: false,
        message: "CI-V open but no MAIN/SUB frequency reply (addr 0xA2?)",
      };
    }
    let msg = "CI-V (active) MAIN " + (m || "?") + " MHz";
    if (s) msg += " / SUB " + s + " MHz";
    msg += " | SAT OFF, Dualwatch ON, SPLIT OFF";
    return {
      ok: true,
      message: msg,
      detail: { mainHz, subHz, satModeOff: true, dualWatch: dualWatchOn },
    };
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
}

module.exports = {
  meta: {
    id: "ic9700",
    label: "Icom IC-9700 (CI-V)",
    match(cfg) {
      if (typeof cfg.useIc9700Serial === "function")
        return cfg.useIc9700Serial();
      if (cfg.RADIO_TRANSPORT !== "serial") return false;
      const make = String(cfg.SERIAL_MAKE || "").toLowerCase();
      const model = String(cfg.SERIAL_MODEL || "").toLowerCase();
      if (make && make !== "icom") return false;
      return model === "ic-9700" || model === "ic9700" || model === "9700";
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
  getRadioState,
  statusPayload,
  broadcastStatus,
  applyEndpointChange,
  runConnectionTest,
};
