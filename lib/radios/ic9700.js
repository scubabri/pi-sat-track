/**
 * Icom IC-9700 CI-V driver.
 *
 * IC-9700 CI-V. Default address 0xA2.
 * Uses MAIN/SUB band select (0x07 D0/D1) + 0x03/0x05 for reliability
 * (0x25/0x26 can be unreliable on SUB with some firmware).
 * MAIN = DL, SUB = UL with SPLIT in single-radio mode.
 *
 * Two operating modes (from config.isDualCat()):
 *
 *  SPLIT (Radio 2 blank):
 *    One serial port. MAIN = DL, SUB = UL, SPLIT ON.
 *
 *  DUAL (Radio 2 defined and different device):
 *    Two serial ports. Radio 1 = DL only (never SPLIT).
 *    Radio 2 = UL only. CTCSS on Radio 2.
 *
 * On enable / open we mark syncNeeded and force mode+freq with retries.
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
let splitOn = false; // only meaningful in split mode
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

let syncNeeded = false;
let syncStartedAt = 0;
let syncOkStreak = 0;

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
  console.log(
    "IC9700 syncNeeded:",
    reason || "enable",
    dualMode() ? "(dual)" : "(split)",
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
  if (/\bCW\b/.test(m) && !/\bSSB\b/.test(m)) {
    return { ul: 0x03, dl: 0x03, ulName: "CW", dlName: "CW" };
  }
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
          dualMode() ? "[dual]" : "[split]",
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

/** CTCSS always on the UL side (Radio 2 in dual, single radio in split). */
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
  if (which === "B" || which === "sub" || which === "SUB") return selectSub(link);
  return selectMain(link);
}

/**
 * SPLIT ON only in single-radio mode.
 * Hard invariant: never enable SPLIT when dualMode().
 */
async function ensureSplit() {
  if (dualMode()) {
    // Dual: Radio 1 must never be in split
    if (splitOn && dl.connected) {
      try {
        await sendCiv(dl, Buffer.from([0x0f, 0x00])); // SPLIT OFF
        splitOn = false;
        console.log("IC9700 SPLIT OFF (dual mode — Radio 1 is DL only)");
      } catch (_) {}
    }
    return false;
  }
  if (splitOn) return true;
  if (!dl.connected) return false;
  try {
    const reply = await sendCiv(dl, Buffer.from([0x0f, 0x01]));
    if (reply.includes(0xfa)) return false;
    splitOn = true;
    console.log("IC9700 SPLIT ON (TX = SUB)");
    return true;
  } catch (e) {
    return false;
  }
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
  if (
    !force &&
    !syncNeeded &&
    link.lastHz != null &&
    Math.abs(target - link.lastHz) < 1
  ) {
    return true;
  }

  // Dual: always MAIN. Split on single radio: MAIN=DL ("A"), SUB=UL ("B")
  const useSub = !dualMode() && (vfo === "B" || vfo === "sub");
  const band = useSub ? "SUB" : "MAIN";
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
            "freq NAK attempt",
            attempt,
          );
          await sleep(80 * attempt);
          continue;
        }
      }
      link.lastHz = target;
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
  if (!force && !syncNeeded && link.lastMode === mdCode) return true;

  const useSub = !dualMode() && (vfo === "B" || vfo === "sub");
  const band = useSub ? "SUB" : "MAIN";

  for (let attempt = 1; attempt <= MODE_RETRIES; attempt++) {
    try {
      await selectMainOrSub(link, useSub ? "B" : "A");
      let reply = await sendCiv(link, Buffer.from([0x06, mdCode, 0x01]));
      if (reply.includes(0xfa)) {
        const sub = useSub ? 0x01 : 0x00;
        reply = await sendCiv(link, Buffer.from([0x26, sub, mdCode, 0x01]));
        if (reply.includes(0xfa)) {
          console.warn("Icom", link.name, band, "mode NAK attempt", attempt);
          await sleep(100 * attempt);
          continue;
        }
      }
      link.lastMode = mdCode;
      console.log(
        "Icom",
        link.name.toUpperCase(),
        band,
        "mode →",
        modeName,
        "attempt",
        attempt,
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

async function getSelectedFrequency(link) {
  if (!link || !link.connected) return null;
  try {
    // Ensure MAIN is selected, then read with classic 0x03
    await selectMain(link);
    let reply = await sendCiv(link, Buffer.from([0x03]));
    let idx = reply.indexOf(0x03);
    if (idx >= 0 && reply.length >= idx + 6) {
      try {
        return bcdToFreq(reply.slice(idx + 1, idx + 6));
      } catch (_) {}
    }
    // Fallback 0x25 MAIN
    reply = await sendCiv(link, Buffer.from([0x25, 0x00]));
    idx = reply.indexOf(0x25);
    if (idx >= 0 && reply.length >= idx + 7) {
      try {
        return bcdToFreq(reply.slice(idx + 2, idx + 7));
      } catch (_) {}
    }
    return null;
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

async function pushFrequencies(ulHz, dlHz) {
  if (!radioOn) return;

  const dual = dualMode();
  const force = syncNeeded;
  const hasUl = ulHz != null && Number.isFinite(ulHz);
  const hasDl = dlHz != null && Number.isFinite(dlHz);

  const { currentSatKey, currentModeIndex } = getCtx();
  const info = getCatalog()[currentSatKey] || {};
  const active = getActiveModeObj(info, currentModeIndex);
  const mods = modesForCatalogMode(active && active.mode);

  // Ensure DL link open
  if (hasDl || !dual) {
    dl.wanted = true;
    if (!dl.connected) {
      const ok = await openLink(dl);
      if (!ok && hasDl) {
        maybeClearSync(false);
        return;
      }
    }
  }

  // Dual: open UL link on Radio 2. Split: UL is SUB on same port.
  if (dual && hasUl) {
    ul.wanted = true;
    if (!ul.connected) {
      await openLink(ul);
    }
  } else if (!dual) {
    // Split mode — UL lives on same physical radio
    ul.wanted = false;
    if (ul.connected) closeLink(ul);
  }

  let ok = true;

  if (dual) {
    // ── DUAL: Radio 1 = DL only (no split), Radio 2 = UL only ──
    // Hard invariant: never enable SPLIT on Radio 1
    await ensureSplit(); // will force SPLIT OFF if somehow on

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
    // ── SPLIT: single radio, MAIN = DL, SUB = UL, SPLIT ON ──
    if (!dl.connected) {
      maybeClearSync(false);
      return;
    }
    await selectMain(dl);
    if (hasUl && hasDl) await ensureSplit();

    if (hasDl) {
      const m = await setLinkMode(dl, mods.dl, mods.dlName, force, "A");
      const f = await setLinkFrequency(dl, Math.round(dlHz), force, "A");
      if (!m || !f) ok = false;
      else if (force || syncNeeded) {
        console.log(
          "IC9700 MAIN (DL)",
          (Math.round(dlHz) / 1e6).toFixed(6),
          "MHz [split]",
        );
      }
    }
    if (hasUl) {
      const m = await setLinkMode(dl, mods.ul, mods.ulName, force, "B");
      const f = await setLinkFrequency(dl, Math.round(ulHz), force, "B");
      // Track UL freq on the logical ul link for status
      if (f) ul.lastHz = Math.round(ulHz);
      if (!m || !f) ok = false;
      else if (force || syncNeeded) {
        console.log(
          "IC9700 SUB (UL)",
          (Math.round(ulHz) / 1e6).toFixed(6),
          "MHz [split]",
        );
      }
    }
    await selectMain(dl);
  }

  await applyCtcssToRadio();
  maybeClearSync(ok && anyConnected());
}

async function pollVfo() {
  if (!radioOn || !dl.connected || dl.busy || locked) return;
  if (dl.lastHz == null || dl.lastHz <= 0) return;
  const freq = await getSelectedFrequency(dl);
  if (freq == null) return;
  if (Math.abs(freq - dl.lastHz) <= VFO_THRESH_HZ) return;
  const { satrec, observer, currentSatKey, currentModeIndex } = getCtx();
  if (!satrec) return;
  const info = getCatalog()[currentSatKey] || {};
  const active = getActiveModeObj(info, currentModeIndex);
  const freqs = formatFreqDisplayFromMode(active);
  if (freqs.dlMHz == null) return;
  const rr = rangeRateKmS(satrec, observer, new Date());
  if (rr == null || !Number.isFinite(rr)) return;
  const f0 = freqs.dlMHz * 1e6;
  const df = 1 - rr / config.C_MS;
  const prev = manualDlOffset;
  manualDlOffset = freq - f0 * df - dlFineOffset;
  dl.lastHz = freq;
  if (Math.abs(manualDlOffset - prev) >= 1) broadcastStatus();
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
  if (typeof o.ulFineOffset === "number" && Number.isFinite(o.ulFineOffset))
    ulFineOffset = Math.round(o.ulFineOffset);
  if (typeof o.dlFineOffset === "number" && Number.isFinite(o.dlFineOffset))
    dlFineOffset = Math.round(o.dlFineOffset);
  if (typeof o.manualDlOffset === "number" && Number.isFinite(o.manualDlOffset))
    manualDlOffset = Math.round(o.manualDlOffset);
  dl.lastHz = null;
  ul.lastHz = null;
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
};
