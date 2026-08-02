/**
 * Icom CI-V driver (IC-705).
 * Cross-band split: VFO A = DL, VFO B = UL, SPLIT ON.
 * Dual fine offsets + CTCSS TX encode (1B 00 + 16 42).
 *
 * On radio enable / open we mark syncNeeded and force mode+freq with
 * retries until a short confirmed window completes.
 */

const { SerialPort } = require("serialport");
const config = require("../config");
const {
  formatFreqDisplayFromMode,
  isFmMode,
  getCatalog,
} = require("../catalog");
const { rangeRateKmS } = require("../orbit");

let port = null;
let connected = false;
let connecting = false;
let radioOn = false;
let locked = false;
let busy = false;
let buf = Buffer.alloc(0);
let lastDlHz = null;
let lastUlHz = null;
let lastDlMode = null;
let lastUlMode = null;
let splitOn = false;
let manualDlOffset = 0;
let ulFineOffset = 0;
let dlFineOffset = 0;
let digitStep = 100;
let reconnectTimer = null;
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

function markSyncNeeded(reason) {
  syncNeeded = true;
  syncStartedAt = Date.now();
  syncOkStreak = 0;
  lastDlMode = null;
  lastUlMode = null;
  lastDlHz = null;
  lastUlHz = null;
  console.log("Icom syncNeeded:", reason || "enable");
}

function clearSyncNeeded(reason) {
  if (!syncNeeded) return;
  syncNeeded = false;
  syncOkStreak = 0;
  console.log("Icom sync clear:", reason || "ok");
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

function statusPayload() {
  return {
    type: "icom",
    radioOn,
    locked,
    connected,
    connecting,
    device: config.CAT_DEVICE,
    baud: config.CAT_BAUD,
    civAddr: config.CAT_CIV_ADDR,
    lastDlHz,
    lastUlHz,
    splitOn,
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
    connected,
    connecting,
    host: config.CAT_DEVICE,
    port: config.CAT_BAUD,
    manualDlOffset,
    ulFineOffset,
    dlFineOffset,
    step: digitStep,
    lastCmdDl: lastDlHz,
    lastCmdUl: lastUlHz,
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

function writeRaw(data) {
  return new Promise((resolve) => {
    if (!port || !connected) {
      resolve(false);
      return;
    }
    port.write(data, (err) => {
      if (err) {
        console.warn("Icom write failed:", err.message);
        resolve(false);
        return;
      }
      port.drain(() => resolve(true));
    });
  });
}

async function sendCiv(command) {
  if (!port || !connected) throw new Error("Icom not connected");
  if (busy) throw new Error("Icom busy");
  busy = true;
  try {
    buf = Buffer.alloc(0);
    const frame = Buffer.concat([
      Buffer.from([0xfe, 0xfe, config.CAT_CIV_ADDR, 0xe0]),
      command,
      Buffer.from([0xfd]),
    ]);
    const ok = await writeRaw(frame);
    if (!ok) throw new Error("Icom write failed");
    const tEnd = Date.now() + 250;
    while (Date.now() < tEnd) {
      if (buf.includes(0xfd)) break;
      await sleep(15);
    }
    await sleep(20);
    const reply = Buffer.from(buf);
    buf = Buffer.alloc(0);
    return reply;
  } finally {
    busy = false;
  }
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  clearReconnect();
  if (!radioOn) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (radioOn && !connected && !connecting) open().catch(() => {});
  }, 3000);
}

async function open() {
  if (port && connected) return true;
  if (connecting) return false;
  connecting = true;
  broadcastStatus();
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      connecting = false;
      if (!ok) scheduleReconnect();
      broadcastStatus();
      resolve(ok);
    };
    try {
      const p = new SerialPort({
        path: config.CAT_DEVICE,
        baudRate: config.CAT_BAUD,
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
          console.warn("Icom open failed:", err.message);
          done(false);
          return;
        }
        clearTimeout(timer);
        port = p;
        connected = true;
        buf = Buffer.alloc(0);
        lastDlHz = null;
        lastUlHz = null;
        lastDlMode = null;
        lastUlMode = null;
        splitOn = false;
        lastCtcssApplied = null;
        markSyncNeeded("open");
        clearReconnect();
        p.on("data", (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          if (buf.length > 4096) buf = buf.slice(-1024);
        });
        p.on("close", () => {
          connected = false;
          connecting = false;
          port = null;
          buf = Buffer.alloc(0);
          stopVfoPoll();
          broadcastStatus();
          if (radioOn) scheduleReconnect();
        });
        p.on("error", (e) => console.warn("Icom error:", e.message));
        console.log(
          "Icom open",
          config.CAT_DEVICE,
          config.CAT_BAUD,
          "addr 0x" + config.CAT_CIV_ADDR.toString(16).toUpperCase(),
        );
        startVfoPoll();
        done(true);
      });
    } catch (e) {
      console.warn("Icom exception:", e.message);
      done(false);
    }
  });
}

function close() {
  radioOn = false;
  syncNeeded = false;
  clearReconnect();
  stopVfoPoll();
  if (port) {
    try {
      port.removeAllListeners();
      port.close();
    } catch (_) {}
    port = null;
  }
  connected = false;
  connecting = false;
  busy = false;
  buf = Buffer.alloc(0);
  lastDlHz = null;
  lastUlHz = null;
  lastDlMode = null;
  lastUlMode = null;
  splitOn = false;
  lastCtcssApplied = null;
  broadcastStatus();
}

function setRadio(on) {
  if (on) {
    radioOn = true;
    manualDlOffset = 0;
    ulFineOffset = 0;
    dlFineOffset = 0;
    markSyncNeeded("setRadio");
    broadcastStatus();
    open().catch(() => {});
  } else close();
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
  console.log("Icom CTCSS", ctcssMode, activeCtcssHz());
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
    "Icom CTCSS default",
    ctcssMode,
    "access",
    ctcssAccessHz,
    "act",
    ctcssActivationHz,
  );
  broadcastStatus();
}

async function applyCtcssToRadio() {
  if (!connected) return;
  const hz = activeCtcssHz();
  const key = hz != null ? String(hz) : "off";
  if (key === lastCtcssApplied) return;
  try {
    if (hz != null) {
      await sendCiv(Buffer.concat([Buffer.from([0x1b, 0x00]), toneToBcd(hz)]));
      await sendCiv(Buffer.from([0x16, 0x42, 0x01]));
      console.log("Icom CTCSS", hz, "Hz ON");
    } else {
      await sendCiv(Buffer.from([0x16, 0x42, 0x00]));
      console.log("Icom CTCSS OFF");
    }
    lastCtcssApplied = key;
  } catch (e) {
    console.warn("Icom CTCSS:", e.message);
  }
}

async function selectVfoA() {
  try {
    await sendCiv(Buffer.from([0x07, 0x00]));
    return true;
  } catch (e) {
    return false;
  }
}

async function ensureSplit() {
  if (splitOn) return true;
  try {
    const reply = await sendCiv(Buffer.from([0x0f, 0x01]));
    if (reply.includes(0xfa)) return false;
    splitOn = true;
    console.log("Icom SPLIT ON (TX = VFO B)");
    return true;
  } catch (e) {
    return false;
  }
}

async function setVfoFrequency(which, freqHz, force) {
  if (!Number.isFinite(freqHz) || freqHz < 1e5 || freqHz > 5e8) return false;
  if (!connected) return false;
  const target = Math.round(freqHz);
  const prev = which === "B" ? lastUlHz : lastDlHz;
  if (!force && !syncNeeded && prev != null && Math.abs(target - prev) < 1) {
    return true;
  }
  const bcd = freqToBcd(target);
  const sub = which === "B" ? 0x01 : 0x00;

  for (let attempt = 1; attempt <= FREQ_RETRIES; attempt++) {
    try {
      const reply = await sendCiv(
        Buffer.concat([Buffer.from([0x25, sub]), bcd]),
      );
      if (reply.includes(0xfa)) {
        await sendCiv(Buffer.from([0x07, sub]));
        const r2 = await sendCiv(Buffer.concat([Buffer.from([0x05]), bcd]));
        if (r2.includes(0xfa)) {
          console.warn("Icom VFO", which, "freq NAK attempt", attempt);
          await sleep(80 * attempt);
          continue;
        }
        if (which === "B") await selectVfoA();
      }
      if (which === "B") lastUlHz = target;
      else lastDlHz = target;
      if (attempt > 1 || force || syncNeeded) {
        console.log(
          "Icom VFO",
          which,
          "freq OK",
          (target / 1e6).toFixed(6),
          "MHz attempt",
          attempt,
        );
      }
      return true;
    } catch (e) {
      console.warn("Icom VFO", which, "freq:", e.message);
      await sleep(80 * attempt);
    }
  }
  return false;
}

async function setVfoMode(which, modeCode, modeName, force) {
  if (!connected) return false;
  const prev = which === "B" ? lastUlMode : lastDlMode;
  if (!force && !syncNeeded && prev === modeCode) return true;
  const sub = which === "B" ? 0x01 : 0x00;

  for (let attempt = 1; attempt <= MODE_RETRIES; attempt++) {
    try {
      const reply = await sendCiv(Buffer.from([0x26, sub, modeCode, 0x01]));
      if (reply.includes(0xfa)) {
        await sendCiv(Buffer.from([0x07, sub]));
        await sendCiv(Buffer.from([0x06, modeCode, 0x01]));
        if (which === "B") await selectVfoA();
      }
      if (which === "B") lastUlMode = modeCode;
      else lastDlMode = modeCode;
      console.log(
        "Icom VFO",
        which,
        "mode →",
        modeName,
        "attempt",
        attempt,
      );
      return true;
    } catch (e) {
      console.warn("Icom VFO", which, "mode:", e.message);
      await sleep(100 * attempt);
    }
  }
  return false;
}

async function getSelectedFrequency() {
  if (!connected) return null;
  try {
    let reply = await sendCiv(Buffer.from([0x25, 0x00]));
    let idx = reply.indexOf(0x25);
    if (idx >= 0 && reply.length >= idx + 7) {
      return bcdToFreq(reply.slice(idx + 2, idx + 7));
    }
    reply = await sendCiv(Buffer.from([0x03]));
    idx = reply.indexOf(0x03);
    if (idx >= 0 && reply.length >= idx + 6) {
      return bcdToFreq(reply.slice(idx + 1, idx + 6));
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
  if (!connected) {
    const ok = await open();
    if (!ok) return;
  }
  const force = syncNeeded;
  await selectVfoA();
  const { currentSatKey, currentModeIndex } = getCtx();
  const info = getCatalog()[currentSatKey] || {};
  const active = getActiveModeObj(info, currentModeIndex);
  const mods = modesForCatalogMode(active && active.mode);
  const hasUl = ulHz != null && Number.isFinite(ulHz);
  const hasDl = dlHz != null && Number.isFinite(dlHz);
  if (hasUl && hasDl) await ensureSplit();

  let ok = true;
  if (hasDl) {
    const target = Math.round(dlHz);
    const m = await setVfoMode("A", mods.dl, mods.dlName, force);
    const f = await setVfoFrequency("A", target, force);
    if (!m || !f) ok = false;
    else if (force || syncNeeded) {
      console.log("Icom VFO A (DL)", (target / 1e6).toFixed(6), "MHz");
    }
  }
  if (hasUl) {
    const target = Math.round(ulHz);
    const m = await setVfoMode("B", mods.ul, mods.ulName, force);
    const f = await setVfoFrequency("B", target, force);
    if (!m || !f) ok = false;
    else if (force || syncNeeded) {
      console.log("Icom VFO B (UL)", (target / 1e6).toFixed(6), "MHz");
    }
  }
  await applyCtcssToRadio();
  await selectVfoA();
  maybeClearSync(ok && connected);
}

async function pollVfo() {
  if (!radioOn || !connected || busy || locked) return;
  if (lastDlHz == null || lastDlHz <= 0) return;
  const freq = await getSelectedFrequency();
  if (freq == null) return;
  if (Math.abs(freq - lastDlHz) <= VFO_THRESH_HZ) return;
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
  lastDlHz = freq;
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
    lastDlHz = null;
    console.log("Icom DL fine", delta, "→", dlFineOffset);
  } else {
    ulFineOffset += delta;
    lastUlHz = null;
    console.log("Icom UL fine", delta, "→", ulFineOffset);
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
  lastDlHz = null;
  lastUlHz = null;
  broadcastStatus();
}

function resetOffsets() {
  manualDlOffset = 0;
  ulFineOffset = 0;
  dlFineOffset = 0;
  lastDlHz = null;
  lastUlHz = null;
  lastDlMode = null;
  lastUlMode = null;
}

function getRadioState() {
  return {
    radioOn,
    locked,
    tciConnected: connected,
    connected,
    connecting,
    manualDlOffset,
    ulFineOffset,
    dlFineOffset,
    lastCmdDl: lastDlHz,
    lastCmdUl: lastUlHz,
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
    open().catch(() => {});
  }
  broadcastStatus();
}

module.exports = {
  init,
  open,
  close,
  setRadio,
  setLock,
  applyDefaultLock,
  pushFrequencies,
  adjustFine,
  setStep,
  center,
  resetOffsets,
  setCtcss,
  applyDefaultCtcss,
  getRadioState,
  statusPayload,
  broadcastStatus,
  applyEndpointChange,
};
