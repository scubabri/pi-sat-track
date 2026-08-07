/**
 * Yaesu FT-847 binary CAT driver.
 *
 * 5-byte blocks, opcode last, 8N2. Baud menu #37 (4800 / 9600 / 57600).
 *
 * Satellite mode (preferred for dual UL+DL):
 *   SAT ON  0x4E / OFF 0x8E
 *   Set freq: MAIN 0x01, SAT RX 0x11, SAT TX 0x21
 *   Set mode: MAIN 0x07, SAT RX 0x17, SAT TX 0x27
 *   CTCSS:    SAT TX tone 0x2B, ENC 0x2A (P1=0x4A)
 *
 * Dual Doppler: SAT mode ON, RX VFO = DL, TX VFO = UL (both updated each tick).
 * UL-only / DL-only: SAT OFF, MAIN VFO.
 * CAT must be enabled (opcode 0x00) after open.
 */

const { SerialPort } = require("serialport");
const config = require("../config");
const { formatFreqDisplayFromMode, getCatalog } = require("../catalog");

const meta = {
  id: "ft847",
  label: "Yaesu FT-847 (binary CAT / SAT)",
  match(cfg) {
    if (typeof cfg.useFt847Serial === "function") return cfg.useFt847Serial();
    if (cfg.RADIO_TRANSPORT !== "serial") return false;
    const make = String(cfg.SERIAL_MAKE || "").toLowerCase();
    const model = String(cfg.SERIAL_MODEL || "").toLowerCase();
    if (make && make !== "yaesu") return false;
    return model === "ft-847" || model === "ft847" || model === "847";
  },
};

let getCtx = () => ({});
let broadcastFn = () => {};

const CMD = {
  CAT_ON: 0x00,
  CAT_OFF: 0x80,
  SAT_ON: 0x4e,
  SAT_OFF: 0x8e,
  SET_FREQ_MAIN: 0x01,
  SET_FREQ_SAT_RX: 0x11,
  SET_FREQ_SAT_TX: 0x21,
  SET_MODE_MAIN: 0x07,
  SET_MODE_SAT_RX: 0x17,
  SET_MODE_SAT_TX: 0x27,
  READ_MAIN: 0x03,
  READ_SAT_RX: 0x13,
  READ_SAT_TX: 0x23,
  CTCSS_MODE_SAT_TX: 0x2a,
  CTCSS_TONE_SAT_TX: 0x2b,
  CTCSS_MODE_MAIN: 0x0a,
  CTCSS_TONE_MAIN: 0x0b,
};

const CTCSS_ENC = 0x4a;
const CTCSS_OFF = 0x8a;

const MODE = { LSB: 0x00, USB: 0x01, CW: 0x02, CWR: 0x03, AM: 0x04, FM: 0x08 };

/** FT-847 tone list in 0.1 Hz (index = catalog position). */
const TONE_TENTHS = [
  670, 693, 719, 744, 770, 797, 825, 854, 885, 915, 948, 974, 1000, 1035, 1072,
  1109, 1148, 1188, 1230, 1273, 1318, 1365, 1413, 1462, 1514, 1567, 1622, 1679,
  1738, 1799, 1862, 1928, 2035, 2107, 2181, 2257, 2336, 2418, 2503,
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function freqToBcd(hz) {
  const n = Math.round(Number(hz) / 10);
  const s = String(Math.max(0, n)).padStart(8, "0").slice(-8);
  const out = [];
  for (let i = 0; i < 8; i += 2) {
    out.push((parseInt(s[i], 10) << 4) | parseInt(s[i + 1], 10));
  }
  return out;
}

function toneIndex(hz) {
  if (hz == null || !(Number(hz) > 0)) return null;
  const tenths = Math.round(Number(hz) * 10);
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < TONE_TENTHS.length; i++) {
    const d = Math.abs(TONE_TENTHS[i] - tenths);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return bestD <= 5 ? best : best; // nearest
}

function modesForCatalogMode(modeStr) {
  const s = String(modeStr || "").toUpperCase();
  const isFm = /\bFM\b/.test(s) || s.includes("GFSK") || s.includes("AFSK");
  if (isFm) return { dl: MODE.FM, ul: MODE.FM };
  // Prefer SSB over CW when "SSB CW*"
  if (s.includes("LSB") && !s.includes("USB"))
    return { dl: MODE.LSB, ul: MODE.USB };
  if (s.includes("USB") && !s.includes("LSB"))
    return { dl: MODE.USB, ul: MODE.LSB };
  if (/\bCW\b/.test(s) && !s.includes("SSB"))
    return { dl: MODE.CW, ul: MODE.CW };
  // Linear inverting default: DL USB, UL LSB
  return { dl: MODE.USB, ul: MODE.LSB };
}

function txSplitEnabled() {
  return config.TX_SPLIT !== false;
}

function dualMode() {
  try {
    return !!(config.CAT_DEVICE && config.CAT2_DEVICE);
  } catch (_) {
    return false;
  }
}

const link = {
  name: "main",
  port: null,
  connected: false,
  connecting: false,
  ready: false,
  wanted: false,
  buf: Buffer.alloc(0),
  lastHz: null,
  lastUlHz: null,
  lastMode: null,
  lastUlMode: null,
  _catQueue: null,
  _catChain: null,
  _catChainRunning: false,
  reconnectTimer: null,
};

let radioOn = false;
let locked = false;
let satMode = false;
let syncNeeded = false;
let ctcssMode = "off";
let ctcssAccessHz = null;
let ctcssActivationHz = null;
let pushInFlight = false;
let pendingPush = null;

function markSyncNeeded(why) {
  syncNeeded = true;
  console.log("FT847 syncNeeded:", why || "");
}

function clearSyncNeeded() {
  syncNeeded = false;
}

function maybeClearSync(ok) {
  if (syncNeeded && ok) clearSyncNeeded();
}

function devicePath() {
  try {
    return config.CAT_DEVICE || config.SERIAL_DEVICE || "";
  } catch (_) {
    return "";
  }
}

function baudRate() {
  try {
    const b = Number(config.SERIAL_BAUD || config.CAT_BAUD || 9600);
    return b > 0 ? b : 9600;
  } catch (_) {
    return 9600;
  }
}

function enqueue(fn) {
  const run = () => {
    link._catChainRunning = true;
    return Promise.resolve()
      .then(fn)
      .then(
        (v) => {
          link._catChainRunning = false;
          const next = link._catQueue && link._catQueue.shift();
          if (next) next();
          else link._catChain = null;
          return v;
        },
        (err) => {
          link._catChainRunning = false;
          const next = link._catQueue && link._catQueue.shift();
          if (next) next();
          else link._catChain = null;
          throw err;
        },
      );
  };
  if (!link._catQueue) link._catQueue = [];
  if (link._catChainRunning || link._catChain) {
    return new Promise((resolve, reject) => {
      link._catQueue.push(() => {
        link._catChain = run().then(resolve, reject);
      });
    });
  }
  link._catChain = run();
  return link._catChain;
}

function writeRaw(data) {
  return new Promise((resolve) => {
    if (!link.port || !link.connected) {
      resolve(false);
      return;
    }
    try {
      link.port.write(data, (err) => {
        if (err) {
          console.warn("FT847 write failed:", err.message);
          resolve(false);
        } else {
          link.port.drain(() => resolve(true));
        }
      });
    } catch (e) {
      resolve(false);
    }
  });
}

function sendCmd(data4, opcode, expect, waitMs) {
  return enqueue(async () => {
    if (!link.port || !link.connected) return null;
    const d = Buffer.isBuffer(data4)
      ? data4
      : Buffer.from(data4 || [0, 0, 0, 0]);
    const frame = Buffer.alloc(5);
    frame[0] = d[0] || 0;
    frame[1] = d[1] || 0;
    frame[2] = d[2] || 0;
    frame[3] = d[3] || 0;
    frame[4] = opcode & 0xff;
    link.buf = Buffer.alloc(0);
    const ok = await writeRaw(frame);
    if (!ok) return null;
    const need = expect != null ? expect : 0;
    const timeout = waitMs != null ? waitMs : need > 0 ? 300 : 50;
    if (need <= 0) {
      await sleep(timeout);
      return Buffer.alloc(0);
    }
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (link.buf.length >= need) {
        const out = Buffer.from(link.buf.slice(0, need));
        link.buf = link.buf.slice(need);
        return out;
      }
      await sleep(10);
    }
    return link.buf.length ? Buffer.from(link.buf) : null;
  });
}

async function setSatMode(on) {
  await sendCmd([0, 0, 0, 0], on ? CMD.SAT_ON : CMD.SAT_OFF, 0, 80);
  satMode = !!on;
  console.log("FT847 SAT mode", on ? "ON" : "OFF");
  await sleep(100);
}

async function setFreq(hz, which) {
  const target = Math.round(Number(hz));
  if (!Number.isFinite(target) || target < 1e5 || target > 470e6) return false;
  const op =
    which === "sat_rx"
      ? CMD.SET_FREQ_SAT_RX
      : which === "sat_tx"
        ? CMD.SET_FREQ_SAT_TX
        : CMD.SET_FREQ_MAIN;
  const bcd = freqToBcd(target);
  const ok = await sendCmd(bcd, op, 0, 80);
  if (ok == null) return false;
  await sleep(40);
  if (which === "sat_tx") link.lastUlHz = target;
  else link.lastHz = target;
  return true;
}

async function setMode(modeCode, which) {
  const op =
    which === "sat_rx"
      ? CMD.SET_MODE_SAT_RX
      : which === "sat_tx"
        ? CMD.SET_MODE_SAT_TX
        : CMD.SET_MODE_MAIN;
  const ok = await sendCmd([modeCode, 0, 0, 0], op, 0, 80);
  if (ok == null) return false;
  await sleep(40);
  if (which === "sat_tx") link.lastUlMode = modeCode;
  else link.lastMode = modeCode;
  return true;
}

async function applyCtcssTx(hz) {
  if (hz == null || !(Number(hz) > 0)) {
    const op = satMode ? CMD.CTCSS_MODE_SAT_TX : CMD.CTCSS_MODE_MAIN;
    await sendCmd([CTCSS_OFF, 0, 0, 0], op, 0, 80);
    console.log("FT847 CTCSS OFF");
    return;
  }
  const idx = toneIndex(hz);
  const toneOp = satMode ? CMD.CTCSS_TONE_SAT_TX : CMD.CTCSS_TONE_MAIN;
  const modeOp = satMode ? CMD.CTCSS_MODE_SAT_TX : CMD.CTCSS_MODE_MAIN;
  await sendCmd([idx & 0xff, 0, 0, 0], toneOp, 0, 80);
  await sleep(60);
  await sendCmd([CTCSS_ENC, 0, 0, 0], modeOp, 0, 80);
  console.log("FT847 CTCSS ENC", Number(hz).toFixed(1), "Hz idx", idx);
}

function openLink() {
  return new Promise((resolve) => {
    if (link.port && link.connected) {
      resolve(true);
      return;
    }
    if (link.connecting) {
      const start = Date.now();
      const wait = setInterval(() => {
        if (!link.connecting) {
          clearInterval(wait);
          resolve(!!(link.port && link.connected));
        } else if (Date.now() - start > 5000) {
          clearInterval(wait);
          resolve(false);
        }
      }, 50);
      return;
    }
    const path = devicePath();
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
      const stopBits = process.env.FT847_STOP_BITS === "1" ? 1 : 2;
      const p = new SerialPort({
        path,
        baudRate: baudRate(),
        dataBits: 8,
        parity: "none",
        stopBits,
        autoOpen: false,
      });
      p.on("error", (e) => console.warn("FT847 error:", e.message));
      const timer = setTimeout(() => {
        try {
          if (p.isOpen) p.close(() => {});
        } catch (_) {}
        console.warn("FT847 open timeout", path);
        done(false);
      }, 3000);
      p.open(async (err) => {
        if (err) {
          clearTimeout(timer);
          console.warn("FT847 open failed:", err.message);
          done(false);
          return;
        }
        clearTimeout(timer);
        link.port = p;
        link.connected = true;
        link.ready = false;
        link.buf = Buffer.alloc(0);
        link._catQueue = [];
        link._catChain = null;
        link._catChainRunning = false;
        p.on("data", (chunk) => {
          link.buf = Buffer.concat([link.buf, chunk]);
          if (link.buf.length > 256) link.buf = link.buf.slice(-128);
        });
        p.on("close", () => {
          console.log("FT847 closed");
          link.connected = false;
          link.ready = false;
          link.port = null;
          broadcastStatus();
        });
        console.log("FT847 open", path, baudRate(), "8N" + stopBits);
        // Enable CAT
        await sendCmd([0, 0, 0, 0], CMD.CAT_ON, 0, 100);
        console.log("FT847 CAT ON");
        link.ready = true;
        done(true);
      });
    } catch (e) {
      link.connecting = false;
      console.warn("FT847 exception:", e.message);
      done(false);
    }
  });
}

function close() {
  link.wanted = false;
  satMode = false;
  if (link.port) {
    try {
      if (link.port.isOpen) link.port.close(() => {});
    } catch (_) {}
    link.port = null;
  }
  link.connected = false;
  link.ready = false;
}

function setRadio(on) {
  console.log("FT847 setRadio(" + on + ")");
  if (on) {
    radioOn = true;
    markSyncNeeded("enable");
    link.wanted = true;
    openLink().then(() => broadcastStatus());
  } else {
    radioOn = false;
    pendingPush = null;
    if (link.connected) {
      setSatMode(false).catch(() => {});
    }
    close();
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

function setCtcss(which) {
  if (which === "off") ctcssMode = "off";
  else if (which === "access" || which === "activation") ctcssMode = which;
  else {
    if (ctcssMode === "off") ctcssMode = "access";
    else if (ctcssMode === "access") ctcssMode = "activation";
    else ctcssMode = "off";
  }
  if (!link.connected) return;
  const hz =
    ctcssMode === "off"
      ? null
      : ctcssMode === "activation" && ctcssActivationHz != null
        ? ctcssActivationHz
        : ctcssAccessHz;
  applyCtcssTx(hz).catch(() => {});
}

function applyDefaultCtcss(accessHz, activationHz) {
  ctcssAccessHz = accessHz != null ? accessHz : null;
  ctcssActivationHz = activationHz != null ? activationHz : null;
  ctcssMode = ctcssAccessHz != null ? "access" : "off";
}

function getActiveModeObj(info, modeIndex) {
  const modes = info && Array.isArray(info.modes) ? info.modes : [];
  if (!modes.length) return null;
  const i = modeIndex >= 0 && modeIndex < modes.length ? modeIndex : 0;
  return modes[i];
}

async function pushFrequencies(ulHz, dlHz) {
  if (!radioOn) return;
  const hasUl = ulHz != null && Number.isFinite(Number(ulHz));
  const hasDl = dlHz != null && Number.isFinite(Number(dlHz));
  if (!hasUl && !hasDl) return;

  if (pushInFlight) {
    pendingPush = { ulHz, dlHz };
    return;
  }
  pushInFlight = true;
  try {
    await runPush(ulHz, dlHz);
  } finally {
    pushInFlight = false;
    if (pendingPush && radioOn) {
      const n = pendingPush;
      pendingPush = null;
      await pushFrequencies(n.ulHz, n.dlHz);
    }
  }
}

async function runPush(ulHz, dlHz) {
  if (!radioOn) return;
  const hasUl = ulHz != null && Number.isFinite(Number(ulHz));
  const hasDl = dlHz != null && Number.isFinite(Number(dlHz));
  if (!hasUl && !hasDl) return;

  if (!link.connected && link.wanted) await openLink();
  if (!link.connected || !link.ready) return;

  const { currentSatKey, currentModeIndex } = getCtx();
  const info = getCatalog()[currentSatKey] || {};
  const active = getActiveModeObj(info, currentModeIndex);
  const freqs = formatFreqDisplayFromMode(active);
  const mods = modesForCatalogMode(freqs.mode || (freqs.isFm ? "FM" : "SSB"));
  const force = syncNeeded;
  let ok = true;

  // Dual path on one 847: satellite mode when both UL+DL and TX_SPLIT
  const useSat = hasUl && hasDl && txSplitEnabled();

  if (useSat) {
    if (!satMode || force) {
      await setSatMode(true);
    }
    if (hasDl) {
      if (force || link.lastMode !== mods.dl) {
        ok = (await setMode(mods.dl, "sat_rx")) && ok;
      }
      const f = await setFreq(dlHz, "sat_rx");
      if (!f) ok = false;
      else if (force)
        console.log(
          "FT847 SAT RX (DL)",
          (Math.round(dlHz) / 1e6).toFixed(6),
          "MHz",
        );
    }
    if (hasUl) {
      if (force || link.lastUlMode !== mods.ul) {
        ok = (await setMode(mods.ul, "sat_tx")) && ok;
      }
      // FM fixed UL: still write (cheap); could skip if locked + same
      const f = await setFreq(ulHz, "sat_tx");
      if (!f) ok = false;
      else if (force)
        console.log(
          "FT847 SAT TX (UL)",
          (Math.round(ulHz) / 1e6).toFixed(6),
          "MHz",
        );
      if (force && ctcssAccessHz != null) {
        await applyCtcssTx(ctcssAccessHz);
      }
    }
  } else {
    if (satMode) await setSatMode(false);
    if (hasDl && !hasUl) {
      if (force || link.lastMode !== mods.dl) {
        ok = (await setMode(mods.dl, "main")) && ok;
      }
      const f = await setFreq(dlHz, "main");
      if (!f) ok = false;
      else if (force)
        console.log(
          "FT847 MAIN (DL)",
          (Math.round(dlHz) / 1e6).toFixed(6),
          "MHz",
        );
    } else if (hasUl) {
      if (force || link.lastMode !== mods.ul) {
        ok = (await setMode(mods.ul, "main")) && ok;
      }
      const f = await setFreq(ulHz, "main");
      if (!f) ok = false;
      else if (force) {
        console.log(
          "FT847 MAIN (UL)",
          (Math.round(ulHz) / 1e6).toFixed(6),
          "MHz",
        );
        if (ctcssAccessHz != null) await applyCtcssTx(ctcssAccessHz);
      }
    } else if (hasDl) {
      if (force || link.lastMode !== mods.dl) {
        ok = (await setMode(mods.dl, "main")) && ok;
      }
      ok = (await setFreq(dlHz, "main")) && ok;
    }
  }

  maybeClearSync(ok && link.connected);
}

function adjustFine() {}
function setStep() {}
function center() {
  markSyncNeeded("center");
}
function resetOffsets() {
  link.lastHz = null;
  link.lastUlHz = null;
  markSyncNeeded("reset offsets");
}
function setOffsets() {}

function getRadioState() {
  return {
    radioOn,
    locked,
    splitOn: satMode,
    connected: link.connected,
    path: meta.id,
    lastCmdDl: link.lastHz,
    lastCmdUl: link.lastUlHz,
    ctcssMode,
    ctcssAccessHz,
    ctcssActivationHz,
  };
}

function statusPayload() {
  return getRadioState();
}

function broadcastStatus() {
  try {
    broadcastFn({ type: "radio", ...getRadioState() });
  } catch (_) {}
}

function applyEndpointChange() {
  markSyncNeeded("endpoint change");
  if (radioOn) {
    close();
    openLink().then(() => broadcastStatus());
  }
}

function init(opts) {
  if (opts && opts.getContext) getCtx = opts.getContext;
  if (opts && opts.broadcast) broadcastFn = opts.broadcast;
}

module.exports = {
  meta,
  init,
  open: openLink,
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
