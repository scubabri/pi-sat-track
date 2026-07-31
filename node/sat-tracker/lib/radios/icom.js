/**
 * Icom CI-V driver (IC-705 and similar).
 *
 * Cross-band split for satellite work:
 *   VFO A (main / selected)  = downlink (RX)
 *   VFO B (unselected)       = uplink (TX)
 *   Split ON so PTT transmits on B
 *
 * Modern Icom (705/7300/9700):
 *   0x25 00 + BCD  = set selected VFO frequency
 *   0x25 01 + BCD  = set unselected VFO frequency
 *   0x26 00 + mode + fil = mode on selected
 *   0x26 01 + mode + fil = mode on unselected
 *   0x07 00 / 01   = select VFO A / B (ensure A is main)
 *   0x0F 01        = split ON
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
    lastDlHz,
    lastUlHz,
    lastDlMode,
    lastUlMode,
    splitOn,
    manualDlOffset,
    ulFineOffset,
    step: digitStep,
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
    step: digitStep,
    lastCmdDl: lastDlHz,
    lastCmdUl: lastUlHz,
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

/** CI-V mode codes: 00 LSB, 01 USB, 03 CW, 05 FM */
function modesForCatalogMode(modeStr) {
  const m = (modeStr || "").toUpperCase();
  if (isFmMode(modeStr) || /\bFM\b|NFM|GFSK|CTCSS|C4FM|DSTAR|DMR/.test(m)) {
    return { ul: 0x05, dl: 0x05, ulName: "FM", dlName: "FM" };
  }
  if (/\bCW\b/.test(m) && !/\bSSB\b/.test(m)) {
    return { ul: 0x03, dl: 0x03, ulName: "CW", dlName: "CW" };
  }
  // Linear: UL LSB (TX), DL USB (RX)
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
        lastDlHz = null;
        lastUlHz = null;
        lastDlMode = null;
        lastUlMode = null;
        splitOn = false;
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
  lastDlHz = null;
  lastUlHz = null;
  lastDlMode = null;
  lastUlMode = null;
  splitOn = false;
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

/** Ensure main display is VFO A */
async function selectVfoA() {
  try {
    await sendCiv(Buffer.from([0x07, 0x00]));
    return true;
  } catch (e) {
    console.warn("Icom select VFO A:", e.message);
    return false;
  }
}

/** Enable split (TX on VFO B) */
async function ensureSplit() {
  if (splitOn) return true;
  try {
    const reply = await sendCiv(Buffer.from([0x0f, 0x01]));
    if (reply.includes(0xfa)) {
      console.warn("Icom NG on split ON");
      return false;
    }
    splitOn = true;
    console.log("Icom SPLIT ON (TX = VFO B)");
    return true;
  } catch (e) {
    console.warn("Icom split:", e.message);
    return false;
  }
}

/**
 * Set frequency on selected (0x00) or unselected (0x01) VFO via cmd 0x25.
 * Falls back to classic 0x05 on the currently selected VFO.
 */
async function setVfoFrequency(which, freqHz) {
  if (!Number.isFinite(freqHz) || freqHz < 1e5 || freqHz > 5e8) return false;
  if (!connected) return false;
  const bcd = freqToBcd(freqHz);
  const sub = which === "B" ? 0x01 : 0x00;
  try {
    const reply = await sendCiv(
      Buffer.concat([Buffer.from([0x25, sub]), bcd]),
    );
    if (reply.includes(0xfa)) {
      // Fallback: select VFO then classic 0x05
      await sendCiv(Buffer.from([0x07, sub]));
      const r2 = await sendCiv(Buffer.concat([Buffer.from([0x05]), bcd]));
      if (r2.includes(0xfa)) {
        console.warn("Icom NG set freq", which);
        return false;
      }
      // Return to VFO A as main
      if (which === "B") await selectVfoA();
    }
    return true;
  } catch (e) {
    console.warn("Icom setVfoFrequency", which, e.message);
    return false;
  }
}

/** Mode on selected/unselected VFO via 0x26 */
async function setVfoMode(which, modeCode, modeName) {
  if (!connected) return false;
  const sub = which === "B" ? 0x01 : 0x00;
  const prev = which === "B" ? lastUlMode : lastDlMode;
  if (prev === modeCode) return true;
  try {
    const reply = await sendCiv(
      Buffer.from([0x26, sub, modeCode, 0x01]),
    );
    if (reply.includes(0xfa)) {
      // Fallback classic 0x06 on selected VFO
      await sendCiv(Buffer.from([0x07, sub]));
      await sendCiv(Buffer.from([0x06, modeCode, 0x01]));
      if (which === "B") await selectVfoA();
    }
    if (which === "B") lastUlMode = modeCode;
    else lastDlMode = modeCode;
    console.log("Icom VFO", which, "mode →", modeName);
    return true;
  } catch (e) {
    console.warn("Icom setVfoMode", which, e.message);
    return false;
  }
}

async function getSelectedFrequency() {
  if (!connected) return null;
  try {
    // 0x25 00 with no data = read selected VFO freq (modern)
    let reply = await sendCiv(Buffer.from([0x25, 0x00]));
    let idx = reply.indexOf(0x25);
    if (idx >= 0 && reply.length >= idx + 7) {
      return bcdToFreq(reply.slice(idx + 2, idx + 7));
    }
    // Classic 0x03
    reply = await sendCiv(Buffer.from([0x03]));
    idx = reply.indexOf(0x03);
    if (idx >= 0 && reply.length >= idx + 6) {
      return bcdToFreq(reply.slice(idx + 1, idx + 6));
    }
    return null;
  } catch (e) {
    console.warn("Icom getSelectedFrequency:", e.message);
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

/**
 * Push Doppler freqs:
 *   VFO A = downlink (RX)
 *   VFO B = uplink (TX) + fine offset
 *   Split ON
 */
async function pushFrequencies(ulHz, dlHz) {
  if (!radioOn) return;

  if (!connected) {
    const ok = await open();
    if (!ok) return;
  }

  await selectVfoA();

  const { currentSatKey, currentModeIndex } = getCtx();
  const info = getCatalog()[currentSatKey] || {};
  const active = getActiveModeObj(info, currentModeIndex);
  const mods = modesForCatalogMode(active && active.mode);

  const hasUl = ulHz != null && Number.isFinite(ulHz);
  const hasDl = dlHz != null && Number.isFinite(dlHz);

  if (hasUl && hasDl) {
    await ensureSplit();
  }

  // --- VFO A = downlink ---
  if (hasDl) {
    const target = Math.round(dlHz);
    await setVfoMode("A", mods.dl, mods.dlName);
    if (lastDlHz == null || Math.abs(target - lastDlHz) >= 1) {
      if (await setVfoFrequency("A", target)) {
        lastDlHz = target;
        console.log("Icom VFO A (DL)", (target / 1e6).toFixed(6), "MHz");
      }
    }
  }

  // --- VFO B = uplink ---
  if (hasUl) {
    const target = Math.round(ulHz);
    await setVfoMode("B", mods.ul, mods.ulName);
    if (lastUlHz == null || Math.abs(target - lastUlHz) >= 1) {
      if (await setVfoFrequency("B", target)) {
        lastUlHz = target;
        console.log("Icom VFO B (UL)", (target / 1e6).toFixed(6), "MHz");
      }
    }
  }

  // Keep main display on A (RX)
  await selectVfoA();
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
  manualDlOffset = freq - f0 * df;
  lastDlHz = freq;

  if (Math.abs(manualDlOffset - prev) >= 1) {
    console.log(
      "Icom VFO A tune",
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
    lastUlHz = null; // force VFO B re-push
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
  lastDlHz = null;
  lastUlHz = null;
  console.log("Icom center offsets");
  broadcastStatus();
}

function resetOffsets() {
  manualDlOffset = 0;
  ulFineOffset = 0;
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
    lastCmdDl: lastDlHz,
    lastCmdUl: lastUlHz,
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
  statusPayload,
  broadcastStatus,
  applyEndpointChange,
};
