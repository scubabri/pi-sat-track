/**
 * Icom CI-V driver (IC-705 and similar).
 * Single VFO: tracks downlink when available, else uplink.
 * Same radio API surface as flex.js / tci.js for state + server routing.
 *
 * Frame: FE FE <to> <from> <cmd> [data...] FD
 *   03 read freq · 05 set freq (5 BCD LSB-first) · 06 set mode
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
let lastFreqHz = null;
let lastMode = null;
let manualDlOffset = 0;
let ulFineOffset = 0;
let digitStep = 100;
let reconnectTimer = null;
let vfoPollTimer = null;
let broadcastFn = () => {};

const VFO_POLL_MS = 500;
const VFO_THRESH_HZ = 80;

let getCtx = () => ({
  satrec: null,
  observer: null,
  currentSatKey: null,
  currentModeIndex: 0,
});

function init(opts) {
  if (opts && opts.broadcast) broadcastFn = opts.broadcast;
  if (opts && opts.getContext) getCtx = opts.getContext;
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
    lastFreqHz,
    lastMode,
    manualDlOffset,
    ulFineOffset,
    step: digitStep,
  };
}

function broadcastStatus() {
  broadcastFn(statusPayload());
  // Same shape as TCI status so the UI radio indicator works
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
    step: digitStep,
    lastCmdDl: lastFreqHz,
    lastCmdUl: lastFreqHz,
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** CI-V mode: 00 LSB, 01 USB, 03 CW, 05 FM */
function modesForCatalogMode(modeStr) {
  const m = (modeStr || "").toUpperCase();
  if (isFmMode(modeStr) || /\bFM\b|NFM|GFSK|CTCSS|C4FM|DSTAR|DMR/.test(m)) {
    return { code: 0x05, name: "FM" };
  }
  if (/\bCW\b/.test(m) && !/\bSSB\b/.test(m)) {
    return { code: 0x03, name: "CW" };
  }
  // Single VFO: USB for RX-oriented linear (DL usually USB)
  return { code: 0x01, name: "USB" };
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
    if (radioOn && !connected && !connecting) {
      console.log("Icom retry connect...");
      open().catch(() => {});
    }
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
        console.warn("Icom open timeout", config.CAT_DEVICE);
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
        lastMode = null;
        clearReconnect();

        p.on("data", (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          if (buf.length > 4096) buf = buf.slice(-1024);
        });
        p.on("close", () => {
          console.log("Icom closed");
          connected = false;
          connecting = false;
          port = null;
          buf = Buffer.alloc(0);
          stopVfoPoll();
          broadcastStatus();
          if (radioOn) scheduleReconnect();
        });
        p.on("error", (e) => {
          console.warn("Icom error:", e.message);
        });

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
  lastFreqHz = null;
  lastMode = null;
  broadcastStatus();
  console.log("Icom disconnected");
}

function setRadio(on) {
  console.log("Icom setRadio(" + on + ")");
  if (on) {
    radioOn = true;
    manualDlOffset = 0;
    ulFineOffset = 0;
    broadcastStatus();
    open().catch(() => {});
  } else {
    close();
  }
}

function setLock(on) {
  locked = !!on;
  console.log("Icom LOCK", locked ? "ON" : "OFF");
  broadcastStatus();
}

function applyDefaultLock(isFm) {
  locked = !!isFm;
  console.log("Icom default LOCK", locked ? "ON (FM)" : "OFF (linear)");
  broadcastStatus();
}

async function setFrequency(freqHz) {
  if (!Number.isFinite(freqHz) || freqHz < 1e5 || freqHz > 5e8) return false;
  if (!connected) return false;
  const bcd = freqToBcd(freqHz);
  try {
    const reply = await sendCiv(Buffer.concat([Buffer.from([0x05]), bcd]));
    if (reply.includes(0xfb) || reply.includes(0x05)) {
      lastFreqHz = Math.round(freqHz);
      return true;
    }
    if (reply.includes(0xfa)) {
      console.warn("Icom NG on setFrequency");
      return false;
    }
    lastFreqHz = Math.round(freqHz);
    return true;
  } catch (e) {
    console.warn("Icom setFrequency:", e.message);
    return false;
  }
}

async function getFrequency() {
  if (!connected) return null;
  try {
    const reply = await sendCiv(Buffer.from([0x03]));
    const idx = reply.indexOf(0x03);
    if (idx < 0 || reply.length < idx + 6) return null;
    const freq = bcdToFreq(reply.slice(idx + 1, idx + 6));
    return freq;
  } catch (e) {
    console.warn("Icom getFrequency:", e.message);
    return null;
  }
}

async function setMode(modeCode, modeName) {
  if (!connected) return false;
  if (lastMode === modeCode) return true;
  try {
    // 06 <mode> <filter> — filter 0x01 = FIL1
    const reply = await sendCiv(Buffer.from([0x06, modeCode, 0x01]));
    if (reply.includes(0xfa)) {
      console.warn("Icom NG on setMode");
      return false;
    }
    lastMode = modeCode;
    console.log("Icom mode →", modeName, "(0x" + modeCode.toString(16) + ")");
    return true;
  } catch (e) {
    console.warn("Icom setMode:", e.message);
    return false;
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

/**
 * Single VFO: prefer downlink (RX track), else uplink.
 * Fine offset applies to the commanded frequency.
 */
async function pushFrequencies(ulHz, dlHz) {
  if (!radioOn) return;

  if (!connected) {
    const ok = await open();
    if (!ok) return;
  }

  const { currentSatKey, currentModeIndex } = getCtx();
  const info = getCatalog()[currentSatKey] || {};
  const active = getActiveModeObj(info, currentModeIndex);
  const mod = modesForCatalogMode(active && active.mode);
  await setMode(mod.code, mod.name);

  // Prefer DL for single-VFO sat tracking; fall back to UL
  let target = null;
  if (dlHz != null && Number.isFinite(dlHz)) {
    target = Math.round(dlHz);
  } else if (ulHz != null && Number.isFinite(ulHz)) {
    target = Math.round(ulHz);
  }
  if (target == null) return;

  if (lastFreqHz == null || Math.abs(target - lastFreqHz) >= 1) {
    const ok = await setFrequency(target);
    if (ok) {
      console.log("Icom VFO", (target / 1e6).toFixed(6), "MHz");
    }
  }
}

async function pollVfo() {
  if (!radioOn || !connected || busy || locked) return;
  if (lastFreqHz == null || lastFreqHz <= 0) return;

  const freq = await getFrequency();
  if (freq == null) return;
  if (Math.abs(freq - lastFreqHz) <= VFO_THRESH_HZ) return;

  const { satrec, observer, currentSatKey, currentModeIndex } = getCtx();
  if (!satrec) return;

  const info = getCatalog()[currentSatKey] || {};
  const active = getActiveModeObj(info, currentModeIndex);
  const freqs = formatFreqDisplayFromMode(active);
  // Offset relative to DL if we have one, else UL
  const baseMHz = freqs.dlMHz != null ? freqs.dlMHz : freqs.ulMHz;
  if (baseMHz == null) return;

  const rr = rangeRateKmS(satrec, observer, new Date());
  if (rr == null || !Number.isFinite(rr)) return;

  const f0 = baseMHz * 1e6;
  const df = 1 - rr / config.C_MS;
  const prev = manualDlOffset;
  manualDlOffset = freq - f0 * df;
  lastFreqHz = freq;

  if (Math.abs(manualDlOffset - prev) >= 1) {
    console.log(
      "Icom VFO",
      (freq / 1e6).toFixed(6),
      "MHz → manualDlOffset",
      Math.round(manualDlOffset),
      "Hz",
    );
    broadcastStatus();
  }
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

function adjustFine(delta) {
  if (typeof delta === "number") {
    ulFineOffset += delta;
    lastFreqHz = null; // force re-push
    console.log("Icom fine", delta >= 0 ? "+" + delta : delta, "→", ulFineOffset, "Hz");
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
  lastFreqHz = null;
  console.log("Icom center offsets");
  broadcastStatus();
}

function resetOffsets() {
  manualDlOffset = 0;
  ulFineOffset = 0;
  lastFreqHz = null;
  lastMode = null;
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
    lastCmdDl: lastFreqHz,
    lastCmdUl: lastFreqHz,
    step: digitStep,
  };
}

function applyEndpointChange() {
  console.log(
    "Icom endpoint →",
    config.CAT_DEVICE,
    config.CAT_BAUD,
    "addr 0x" + config.CAT_CIV_ADDR.toString(16).toUpperCase(),
  );
  const wasOn = radioOn;
  close();
  if (wasOn) {
    radioOn = true;
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
  getRadioState,
  setFrequency,
  getFrequency,
  statusPayload,
  broadcastStatus,
  applyEndpointChange,
};
