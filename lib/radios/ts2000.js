/**
 * Kenwood TS-2000 ASCII CAT driver.
 *
 *   FAxxxxxxxxxxx; / FBxxxxxxxxxxx;  — VFO A / B frequency (11-digit Hz)
 *   MDn;                             — mode
 *   FT0; / FT1;                      — TX on VFO A / B (split)
 *   FR0; / FR1;                      — RX on VFO A / B
 *   TN00…TN39;                       — CTCSS tone code
 *
 * SPLIT (single radio): VFO A = DL, VFO B = UL, FT1 when TX_SPLIT.
 * Satellite mode left OFF — normal split like most CAT sat setups.
 * "Other (Kenwood CAT)" also routes here.
 */

const { SerialPort } = require("serialport");
const config = require("../config");
const { formatFreqDisplayFromMode, getCatalog } = require("../catalog");
const { rangeRateKmS } = require("../orbit");

function makeLink(name) {
  return {
    name,
    port: null,
    connected: false,
    connecting: false,
    busy: false,
    buf: "",
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
let syncNeeded = false;
let getCtx = () => ({});

const VFO_POLL_MS = 500;
const VFO_THRESH_HZ = 80;

/** Kenwood TN tone table (subset of standard CTCSS, Hz). */
const TONE_TABLE = [
  67.0, 69.3, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4, 100.0,
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
  dl.lastHz = null;
  ul.lastHz = null;
  dl.lastMode = null;
  ul.lastMode = null;
  lastCtcssApplied = null;
  console.log(
    "Kenwood syncNeeded:",
    reason || "enable",
    dualMode() ? "(dual)" : "(split)",
  );
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
    manualDlOffset,
    ulFineOffset,
    dlFineOffset,
    step: digitStep,
    ctcssMode,
    ctcssAccessHz,
    ctcssActivationHz,
    syncNeeded,
    lastCmdDl: dl.lastHz,
    lastCmdUl: ul.lastHz,
  };
}

function broadcastStatus() {
  broadcastFn(statusPayload());
}

function modesForCatalogMode(modeStr) {
  // AMSAT mode text is often "SSB CW*" — treat as SSB unless CW-only.
  const s = String(modeStr || "").toUpperCase();
  if (/FM|NFM|GFSK|C4FM|DSTAR|DMR/.test(s))
    return { ul: "4", dl: "4", ulName: "FM", dlName: "FM" };
  if (/CW/.test(s) && !/SSB|LSB|USB/.test(s))
    return { ul: "3", dl: "3", ulName: "CW", dlName: "CW" };
  // Linear transponder: UL LSB, DL USB
  return { ul: "1", dl: "2", ulName: "LSB", dlName: "USB" };
}

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
  return best;
}

function writeRaw(link, data) {
  return new Promise((resolve) => {
    if (!link.port || !link.connected) {
      resolve(false);
      return;
    }
    link.port.write(data, (err) => {
      if (err) {
        console.warn("Kenwood", link.name, "write failed:", err.message);
        resolve(false);
        return;
      }
      link.port.drain(() => resolve(true));
    });
  });
}

async function sendCmd(link, cmd, waitMs) {
  if (!link.connected || link.busy) return null;
  link.busy = true;
  try {
    link.buf = "";
    const payload = cmd.endsWith(";") ? cmd : cmd + ";";
    const ok = await writeRaw(link, Buffer.from(payload, "ascii"));
    if (!ok) return null;
    await sleep(waitMs != null ? waitMs : 80);
    const raw = link.buf;
    link.buf = "";
    return raw;
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
          dualMode() ? "[dual]" : "[split]",
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
  link.busy = false;
}

function close() {
  closeLink(dl);
  closeLink(ul);
  splitOn = false;
  stopVfoPoll();
}

function setRadio(on) {
  console.log("TS2000 setRadio(" + on + ")");
  if (on) {
    radioOn = true;
    markSyncNeeded("enable");
    dl.wanted = true;
    openLink(dl).then(() => {
      startVfoPoll();
      broadcastStatus();
    });
  } else {
    radioOn = false;
    splitOn = false;
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

async function applyCtcssToRadio() {
  const link = dualMode() ? ul : dl;
  if (!link.connected) return;
  const hz = activeCtcssHz();
  const key = hz != null ? String(hz) : "off";
  if (key === lastCtcssApplied) return;
  try {
    if (hz != null) {
      const code = toneCode(hz);
      if (code != null) {
        await sendCmd(link, "TN" + String(code).padStart(2, "0"), 60);
      }
      await sendCmd(link, "TO1", 60);
      console.log("TS2000 CTCSS", hz, "Hz ON on", link.name);
    } else {
      await sendCmd(link, "TO0", 60);
      console.log("TS2000 CTCSS OFF on", link.name);
    }
    lastCtcssApplied = key;
  } catch (e) {
    console.warn("TS2000 CTCSS:", e.message);
  }
}

async function ensureSplit() {
  if (dualMode()) {
    if (splitOn && dl.connected) {
      await sendCmd(dl, "FT0", 60);
      splitOn = false;
      console.log("TS2000 SPLIT OFF (dual — Radio 1 DL only)");
    }
    return false;
  }
  if (!txSplitEnabled()) {
    if (splitOn && dl.connected) {
      await sendCmd(dl, "FT0", 60);
      splitOn = false;
    }
    return false;
  }
  if (splitOn) return true;
  if (!dl.connected) return false;
  await sendCmd(dl, "FT1", 60);
  await sendCmd(dl, "FR0", 60);
  splitOn = true;
  console.log("TS2000 SPLIT ON (TX = VFO B)");
  return true;
}

async function setFreq(link, hz, vfo) {
  const target = Math.round(Number(hz));
  if (!Number.isFinite(target) || target <= 0) return false;
  if (
    !syncNeeded &&
    link.lastHz != null &&
    Math.abs(target - link.lastHz) < 1 &&
    (vfo === "A" || dualMode())
  ) {
    return true;
  }
  // Kenwood uses 11-digit Hz
  const digits = String(target).padStart(11, "0").slice(-11);
  const cmd = (vfo === "B" ? "FB" : "FA") + digits;
  const raw = await sendCmd(link, cmd, 60);
  if (raw == null) return false;
  if (vfo === "A" || dualMode()) link.lastHz = target;
  return true;
}

async function setMode(link, mdCode, name, vfo) {
  if (!syncNeeded && link.lastMode === mdCode && (vfo === "A" || dualMode())) {
    return true;
  }
  if (vfo === "B") await sendCmd(link, "FR1", 40);
  else await sendCmd(link, "FR0", 40);
  const raw = await sendCmd(link, "MD" + mdCode, 60);
  if (vfo === "B") await sendCmd(link, "FR0", 40);
  if (raw == null) return false;
  if (vfo === "A" || dualMode()) link.lastMode = mdCode;
  return true;
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

  if (!dl.connected && dl.wanted) await openLink(dl);
  if (dualMode() && hasUl && !ul.connected) {
    ul.wanted = true;
    await openLink(ul);
  }

  const { currentSatKey, currentModeIndex } = getCtx();
  const info = getCatalog()[currentSatKey] || {};
  const active = getActiveModeObj(info, currentModeIndex);
  const freqs = formatFreqDisplayFromMode(active);
  const mods = modesForCatalogMode(freqs.mode || (freqs.isFm ? "FM" : "SSB"));

  let ok = true;
  const force = syncNeeded;

  if (dualMode()) {
    if (hasDl && dl.connected) {
      const m = await setMode(dl, mods.dl, mods.dlName, "A");
      const f = await setFreq(dl, dlHz, "A");
      if (!m || !f) ok = false;
      else if (force)
        console.log(
          "Kenwood DL (R1)",
          (Math.round(dlHz) / 1e6).toFixed(6),
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
      if (hasUl && hasDl) await ensureSplit();
      if (hasDl) {
        const m = await setMode(dl, mods.dl, mods.dlName, "A");
        const f = await setFreq(dl, dlHz, "A");
        if (!m || !f) ok = false;
        else if (force)
          console.log(
            "Kenwood VFO A (DL)",
            (Math.round(dlHz) / 1e6).toFixed(6),
            "MHz [split]",
          );
      }
      if (hasUl) {
        const m = await setMode(dl, mods.ul, mods.ulName, "B");
        const f = await setFreq(dl, ulHz, "B");
        if (f) ul.lastHz = Math.round(ulHz);
        if (!m || !f) ok = false;
        else if (force)
          console.log(
            "Kenwood VFO B (UL)",
            (Math.round(ulHz) / 1e6).toFixed(6),
            "MHz [split]",
          );
      }
    }
  }

  await applyCtcssToRadio();
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

async function pollVfo() {
  if (!radioOn || !dl.connected || dl.busy || locked) return;
  if (dl.lastHz == null || dl.lastHz <= 0) return;
  const freq = await readVfoA(dl);
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
  const d = Math.round(Number(delta) || 0);
  if (side === "ul") ulFineOffset += d;
  else dlFineOffset += d;
  if (side === "ul") ul.lastHz = null;
  else dl.lastHz = null;
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
  getRadioState,
  statusPayload,
  broadcastStatus,
  applyEndpointChange,
};
