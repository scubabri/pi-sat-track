/**
 * FlexRadio SmartSDR driver.
 * - CAT TCP (UL/DL ports on SmartSDR PC): frequency + mode
 * - SmartSDR API (radio LAN IP:4992): FM CTCSS on UL/TX slice only
 *
 * CAT never supports TN/TO. 4992 is on the radio, not the Windows PC.
 *
 * On radio enable / link open we mark syncNeeded and force mode+freq
 * with read-back verification and retries until confirmed or window expires.
 */

const net = require("net");
const config = require("../config");
const {
  formatFreqDisplayFromMode,
  isFmMode,
  getCatalog,
  parseCtcss,
} = require("../catalog");
const { rangeRateKmS } = require("../orbit");
const { createApiClient } = require("./flex-api");

function makeLink(name) {
  return {
    name,
    socket: null,
    connected: false,
    connecting: false,
    busy: false,
    buf: "",
    lastFreqHz: null,
    lastMode: null,
    reconnectTimer: null,
    wanted: false,
  };
}

const ul = makeLink("ul");
const dl = makeLink("dl");
const api = createApiClient();

let radioOn = false;
let locked = false;
let manualDlOffset = 0;
let ulFineOffset = 0;
let dlFineOffset = 0;
let digitStep = 100;
let broadcastFn = () => {};
let vfoPollTimer = null;
const VFO_POLL_MS = 400;
const VFO_THRESH_HZ = 80;

let ctcssMode = "off";
let ctcssAccessHz = null;
let ctcssActivationHz = null;
let lastCtcssApplied = null;

// Force mode/freq until verified after enable or reconnect
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

function anyConnected() {
  return ul.connected || dl.connected;
}

function apiHost() {
  return (config.FLEX_API_HOST || "").trim();
}

function apiPort() {
  return config.FLEX_API_PORT || 4992;
}

function markSyncNeeded(reason) {
  syncNeeded = true;
  syncStartedAt = Date.now();
  syncOkStreak = 0;
  ul.lastMode = null;
  dl.lastMode = null;
  console.log("Flex syncNeeded:", reason || "enable");
}

function clearSyncNeeded(reason) {
  if (!syncNeeded) return;
  syncNeeded = false;
  syncOkStreak = 0;
  console.log("Flex sync clear:", reason || "ok");
}

function maybeClearSync(okThisTick) {
  if (!syncNeeded) return;
  if (okThisTick) syncOkStreak += 1;
  else syncOkStreak = 0;
  const elapsed = Date.now() - syncStartedAt;
  if (syncOkStreak >= SYNC_OK_STREAK) {
    clearSyncNeeded("verified streak " + syncOkStreak);
  } else if (elapsed >= SYNC_WINDOW_MS && syncOkStreak >= 1) {
    clearSyncNeeded("window " + elapsed + "ms with partial ok");
  } else if (elapsed >= SYNC_WINDOW_MS * 1.5) {
    clearSyncNeeded("window expired");
  }
}

function statusPayload() {
  return {
    type: "flex",
    radioOn,
    locked,
    connected: anyConnected(),
    ulConnected: ul.connected,
    dlConnected: dl.connected,
    ulWanted: ul.wanted,
    dlWanted: dl.wanted,
    connecting: ul.connecting || dl.connecting,
    apiConnected: api.isConnected(),
    apiHost: apiHost(),
    apiPort: apiPort(),
    ulHost: config.FLEX_UL_HOST,
    ulPort: config.FLEX_UL_PORT,
    dlHost: config.FLEX_DL_HOST,
    dlPort: config.FLEX_DL_PORT,
    lastUlHz: ul.lastFreqHz,
    lastDlHz: dl.lastFreqHz,
    lastUlMode: ul.lastMode,
    lastDlMode: dl.lastMode,
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
    connecting: ul.connecting || dl.connecting,
    host: config.FLEX_UL_HOST,
    port: config.FLEX_UL_PORT,
    manualDlOffset,
    ulFineOffset,
    dlFineOffset,
    step: digitStep,
    lastCmdDl: dl.lastFreqHz,
    lastCmdUl: ul.lastFreqHz,
    ctcssMode,
    ctcssAccessHz,
    ctcssActivationHz,
  });
}

function freqToFa(freqHz) {
  return "FA" + String(Math.round(freqHz)).padStart(11, "0") + ";";
}

function parseFa(reply) {
  if (!reply) return null;
  const s = String(reply).trim();
  if (!s.startsWith("FA") || !s.endsWith(";")) return null;
  const digits = s.slice(2, -1);
  if (!/^\d+$/.test(digits)) return null;
  return parseInt(digits, 10);
}

function parseMd(reply) {
  if (!reply) return null;
  const s = String(reply).trim();
  const m = s.match(/MD([0-9])/i);
  return m ? m[1] : null;
}

function modesForCatalogMode(modeStr) {
  const m = (modeStr || "").toUpperCase();
  if (isFmMode(modeStr) || /\bFM\b|NFM|GFSK|CTCSS|C4FM|DSTAR|DMR/.test(m)) {
    return { ul: "4", dl: "4", ulName: "FM", dlName: "FM" };
  }
  if (/\bCW\b/.test(m) && !/\bSSB\b/.test(m)) {
    return { ul: "3", dl: "3", ulName: "CW", dlName: "CW" };
  }
  return { ul: "1", dl: "2", ulName: "LSB", dlName: "USB" };
}

function linkHostPort(link) {
  if (link.name === "ul") {
    return { host: config.FLEX_UL_HOST, port: config.FLEX_UL_PORT };
  }
  return { host: config.FLEX_DL_HOST, port: config.FLEX_DL_PORT };
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

function sendCmd(link, cmd, expectReply) {
  return new Promise((resolve, reject) => {
    if (!link.socket || !link.connected) {
      reject(new Error("Flex " + link.name + " not connected"));
      return;
    }
    if (link.busy) {
      reject(new Error("Flex " + link.name + " busy"));
      return;
    }
    if (!cmd.endsWith(";")) cmd += ";";
    link.busy = true;
    link.buf = "";
    const onData = (chunk) => {
      link.buf += chunk.toString("ascii");
      if (link.buf.includes(";")) {
        cleanup();
        const reply = link.buf.trim();
        link.buf = "";
        resolve(reply);
      }
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    let timer = null;
    const cleanup = () => {
      link.busy = false;
      if (timer) clearTimeout(timer);
      if (link.socket) {
        link.socket.removeListener("data", onData);
        link.socket.removeListener("error", onError);
      }
    };
    if (expectReply) {
      link.socket.on("data", onData);
      link.socket.on("error", onError);
      timer = setTimeout(() => {
        cleanup();
        resolve(link.buf.trim() || "");
      }, 1200);
    }
    try {
      link.socket.write(cmd, "ascii", (err) => {
        if (err) {
          cleanup();
          reject(err);
          return;
        }
        if (!expectReply) {
          setTimeout(() => {
            link.busy = false;
            resolve("");
          }, 50);
        }
      });
    } catch (e) {
      cleanup();
      reject(e);
    }
  });
}

async function readLinkMode(link) {
  if (!link.connected) return null;
  try {
    const reply = await sendCmd(link, "MD;", true);
    return parseMd(reply);
  } catch (_) {
    return null;
  }
}

async function readLinkFreq(link) {
  if (!link.connected) return null;
  try {
    const reply = await sendCmd(link, "FA;", true);
    return parseFa(reply);
  } catch (_) {
    return null;
  }
}

function openLink(link) {
  if (link.socket && link.connected) return Promise.resolve(true);
  if (link.connecting) return Promise.resolve(false);
  link.connecting = true;
  broadcastStatus();
  return new Promise((resolve) => {
    const { host, port } = linkHostPort(link);
    console.log("Flex", link.name.toUpperCase(), "connecting", host + ":" + port);
    const s = new net.Socket();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      link.connecting = false;
      if (!ok) {
        try {
          s.destroy();
        } catch (_) {}
        link.connected = false;
        link.socket = null;
        broadcastStatus();
        scheduleReconnect(link);
      }
      resolve(ok);
    };
    s.setTimeout(4000);
    s.once("connect", () => {
      s.setTimeout(0);
      link.socket = s;
      link.connected = true;
      link.buf = "";
      link.lastMode = null;
      clearReconnect(link);
      console.log("Flex", link.name.toUpperCase(), "connected", host + ":" + port);
      markSyncNeeded("open " + link.name);
      broadcastStatus();
      if (link.name === "dl") startVfoPoll();
      if (link.name === "ul" && currentModeIsFm()) {
        lastCtcssApplied = null;
        applyCtcssToRadio(true).catch(() => {});
      }
      done(true);
    });
    s.once("timeout", () => {
      console.warn("Flex", link.name.toUpperCase(), "connect timeout");
      done(false);
    });
    s.once("error", (err) => {
      console.warn("Flex", link.name.toUpperCase(), "connect error:", err.message);
      done(false);
    });
    s.on("close", () => {
      console.log("Flex", link.name.toUpperCase(), "closed");
      link.connected = false;
      link.connecting = false;
      link.socket = null;
      link.buf = "";
      link.busy = false;
      if (link.name === "dl") stopVfoPoll();
      broadcastStatus();
      if (radioOn && link.wanted) scheduleReconnect(link);
    });
    s.on("error", (err) => {
      console.warn("Flex", link.name.toUpperCase(), "error:", err.message);
    });
    try {
      s.connect(port, host);
    } catch (e) {
      console.warn("Flex", link.name.toUpperCase(), "exception:", e.message);
      done(false);
    }
  });
}

function closeLink(link) {
  clearReconnect(link);
  link.wanted = false;
  link.connecting = false;
  if (link.name === "dl") stopVfoPoll();
  if (link.socket) {
    try {
      link.socket.removeAllListeners();
      link.socket.destroy();
    } catch (_) {}
    link.socket = null;
  }
  link.connected = false;
  link.busy = false;
  link.buf = "";
  link.lastFreqHz = null;
  link.lastMode = null;
}

function close() {
  radioOn = false;
  syncNeeded = false;
  stopVfoPoll();
  closeLink(ul);
  closeLink(dl);
  api.close();
  lastCtcssApplied = null;
  broadcastStatus();
  console.log("Flex disconnected");
}

function setRadio(on) {
  console.log("Flex setRadio(" + on + ")");
  if (on) {
    radioOn = true;
    manualDlOffset = 0;
    ulFineOffset = 0;
    dlFineOffset = 0;
    lastCtcssApplied = null;
    markSyncNeeded("setRadio");
    syncTonesFromCatalog();
    // Flex API is CTCSS-only — connect only for FM sats
    if (currentModeIsFm()) {
      const h = apiHost();
      if (h) {
        api.connect(h, apiPort()).then((ok) => {
          if (ok) applyCtcssToRadio(true).catch(() => {});
        });
      } else {
        console.log(
          "Flex CTCSS: set radio API host (radio LAN IP, port 4992) in config to enable tones",
        );
      }
    } else {
      disconnectApi("non-FM on enable");
    }
    broadcastStatus();
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

/** Flex API (:4992) is only used for FM CTCSS — never for SSB/CW. */
function currentModeIsFm() {
  try {
    const { currentSatKey, currentModeIndex } = getCtx();
    const info = getCatalog()[currentSatKey] || {};
    const active = getActiveModeObj(info, currentModeIndex);
    const modeStr = (active && active.mode) || info.mode || "";
    return isFmMode(modeStr);
  } catch (_) {
    return false;
  }
}

function disconnectApi(reason) {
  if (!api.isConnected()) return;
  try {
    api.close();
  } catch (_) {}
  lastCtcssApplied = null;
  console.log("Flex API closed:", reason || "disconnect");
}

function syncTonesFromCatalog() {
  try {
    const { currentSatKey, currentModeIndex } = getCtx();
    const info = getCatalog()[currentSatKey] || {};
    const active = getActiveModeObj(info, currentModeIndex);
    if (!active) return;
    let access = active.ctcssAccess;
    let activation = active.ctcssActivation;
    if (access == null && activation == null) {
      const tones = parseCtcss(
        active.mode,
        currentSatKey,
        info.display || info.name,
        info.norad,
      );
      access = tones.access;
      activation = tones.activation;
    }
    if (access != null) ctcssAccessHz = access;
    if (activation != null) ctcssActivationHz = activation;
  } catch (e) {
    console.warn("Flex syncTones:", e.message);
  }
}

function setCtcss(which) {
  syncTonesFromCatalog();
  if (which === "access") {
    ctcssMode = ctcssAccessHz != null ? "access" : "off";
  } else if (which === "activation") {
    ctcssMode = ctcssActivationHz != null ? "activation" : "off";
  } else {
    ctcssMode = "off";
  }
  lastCtcssApplied = null;
  console.log("Flex CTCSS", ctcssMode, activeCtcssHz());
  applyCtcssToRadio(true).catch(() => {});
  broadcastStatus();
}

function applyDefaultCtcss(accessHz, activationHz) {
  ctcssAccessHz = accessHz != null ? accessHz : null;
  ctcssActivationHz = activationHz != null ? activationHz : null;
  if (ctcssAccessHz != null) ctcssMode = "access";
  else ctcssMode = "off";
  lastCtcssApplied = null;
  console.log(
    "Flex CTCSS default",
    ctcssMode,
    "access",
    ctcssAccessHz,
    "act",
    ctcssActivationHz,
  );
  // Never touch radio hardware when radio is off.
  // Flex API only for FM; drop API on SSB/CW sat switch.
  if (!radioOn) {
    disconnectApi("radio off");
  } else if (!currentModeIsFm()) {
    disconnectApi("non-FM sat");
  } else {
    applyCtcssToRadio(true).catch(() => {});
  }
  broadcastStatus();
}

async function applyCtcssToRadio(force) {
  // CTCSS / Flex API are FM-only and only while radio is enabled
  if (!radioOn) {
    disconnectApi("radio off");
    return;
  }
  if (!currentModeIsFm()) {
    disconnectApi("non-FM mode");
    return;
  }

  const hz = activeCtcssHz();
  const key = hz != null ? String(hz) : "off";
  if (!force && key === lastCtcssApplied) return;

  // Only force FM when actually applying a CTCSS tone.
  if (ul.connected && hz != null && Number.isFinite(hz) && hz > 0) {
    try {
      await sendCmd(ul, "MD4;", false);
      ul.lastMode = "4";
    } catch (_) {}
  }

  const h = apiHost();
  if (!h) {
    if (force) {
      console.warn(
        "Flex CTCSS: no radio API host set. " +
          "CAT ports are on the Windows PC; API is on the radio IP:4992.",
      );
    }
    return;
  }

  if (!api.isConnected()) {
    const ok = await api.connect(h, apiPort());
    if (!ok) {
      console.warn(
        "Flex CTCSS: cannot reach radio API",
        h + ":" + apiPort(),
        "— check radio LAN IP (not SmartSDR CAT host)",
      );
      return;
    }
  }

  try {
    await api.setCtcss(hz, ul.lastFreqHz);
    lastCtcssApplied = key;
  } catch (e) {
    console.warn("Flex CTCSS API:", e.message);
  }
}

async function setLinkFrequency(link, freqHz, force) {
  if (!Number.isFinite(freqHz) || freqHz < 1e5 || freqHz > 6e8) return false;
  if (!link.connected) return false;
  const target = Math.round(freqHz);
  if (
    !force &&
    !syncNeeded &&
    link.lastFreqHz != null &&
    Math.abs(target - link.lastFreqHz) < 1
  ) {
    return true;
  }

  for (let attempt = 1; attempt <= FREQ_RETRIES; attempt++) {
    try {
      await sendCmd(link, freqToFa(target), false);
      await sleep(60);
      const got = await readLinkFreq(link);
      if (got != null && Math.abs(got - target) <= 5) {
        link.lastFreqHz = target;
        if (attempt > 1 || force || syncNeeded) {
          console.log(
            "Flex",
            link.name.toUpperCase(),
            "freq OK",
            (target / 1e6).toFixed(6),
            "MHz attempt",
            attempt,
          );
        }
        return true;
      }
      console.warn(
        "Flex",
        link.name,
        "freq verify fail got",
        got,
        "want",
        target,
        "attempt",
        attempt,
      );
    } catch (e) {
      console.warn("Flex", link.name, "set freq failed:", e.message);
    }
    await sleep(100 * attempt);
  }
  link.lastFreqHz = target;
  return false;
}

async function setLinkMode(link, mdCode, mdName, force) {
  if (!link.connected) return false;
  if (!force && !syncNeeded && link.lastMode === mdCode) return true;

  for (let attempt = 1; attempt <= MODE_RETRIES; attempt++) {
    try {
      await sendCmd(link, "MD" + mdCode + ";", false);
      await sleep(80);
      const got = await readLinkMode(link);
      if (got === mdCode) {
        link.lastMode = mdCode;
        console.log(
          "Flex",
          link.name.toUpperCase(),
          "mode →",
          mdName,
          "OK attempt",
          attempt,
        );
        return true;
      }
      console.warn(
        "Flex",
        link.name,
        "mode verify fail got",
        got,
        "want",
        mdCode,
        "attempt",
        attempt,
      );
    } catch (e) {
      console.warn("Flex", link.name, "set mode failed:", e.message);
    }
    await sleep(120 * attempt);
  }
  return false;
}

async function pushModulation(force) {
  const { currentSatKey, currentModeIndex } = getCtx();
  const info = getCatalog()[currentSatKey] || {};
  const active = getActiveModeObj(info, currentModeIndex);
  const mods = modesForCatalogMode(active && active.mode);
  let ok = true;
  if (ul.connected && ul.wanted) {
    const u = await setLinkMode(ul, mods.ul, mods.ulName, force);
    if (!u) ok = false;
  }
  if (dl.connected && dl.wanted) {
    const d = await setLinkMode(dl, mods.dl, mods.dlName, force);
    if (!d) ok = false;
  }
  return ok;
}

async function pushSide(link, freqHz, force) {
  const hasFreq = freqHz != null && Number.isFinite(freqHz);
  if (!hasFreq) {
    if (link.wanted || link.connected || link.connecting) {
      closeLink(link);
      broadcastStatus();
    }
    return true;
  }
  link.wanted = true;
  if (!link.connected) {
    const ok = await openLink(link);
    if (!ok) return false;
  }
  return setLinkFrequency(link, freqHz, force);
}

async function pushFrequencies(ulHz, dlHz) {
  if (!radioOn) return;
  const force = syncNeeded;
  const ulOk = await pushSide(ul, ulHz, force);
  const dlOk = await pushSide(dl, dlHz, force);
  const modOk = await pushModulation(force);
  await applyCtcssToRadio(false);

  const anyWanted = ul.wanted || dl.wanted;
  const anyConnectedNow = anyConnected();
  const okThisTick =
    anyWanted &&
    anyConnectedNow &&
    (ul.wanted ? ulOk : true) &&
    (dl.wanted ? dlOk : true) &&
    modOk;

  maybeClearSync(okThisTick);
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
      ctcssAccess: null,
      ctcssActivation: null,
    };
  }
  const idx = Math.max(0, Math.min(modeIndex || 0, modes.length - 1));
  return modes[idx];
}

async function pollDlVfo() {
  if (!radioOn || !dl.connected || !dl.wanted || dl.busy) return;
  if (dl.lastFreqHz == null || dl.lastFreqHz <= 0) return;
  if (locked) return;
  let reply;
  try {
    reply = await sendCmd(dl, "FA;", true);
  } catch (_) {
    return;
  }
  const freq = parseFa(reply);
  if (freq == null) return;
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
  dl.lastFreqHz = freq;
  if (Math.abs(manualDlOffset - prev) >= 1) broadcastStatus();
}

function startVfoPoll() {
  if (vfoPollTimer) return;
  vfoPollTimer = setInterval(() => {
    pollDlVfo().catch(() => {});
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
    dl.lastFreqHz = null;
  } else {
    ulFineOffset += delta;
    ul.lastFreqHz = null;
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
  ul.lastFreqHz = null;
  dl.lastFreqHz = null;
  broadcastStatus();
}

function resetOffsets() {
  manualDlOffset = 0;
  ulFineOffset = 0;
  dlFineOffset = 0;
  ul.lastFreqHz = null;
  dl.lastFreqHz = null;
  ul.lastMode = null;
  dl.lastMode = null;
  lastCtcssApplied = null;
  // Sat switch / mode change: force mode+freq on next push
  if (radioOn) markSyncNeeded("sat/offsets reset");
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
  ul.lastFreqHz = null;
  dl.lastFreqHz = null;
  broadcastStatus();
}

function getRadioState() {
  return {
    radioOn,
    locked,
    tciConnected: anyConnected(),
    connected: anyConnected(),
    ulConnected: ul.connected,
    dlConnected: dl.connected,
    connecting: ul.connecting || dl.connecting,
    manualDlOffset,
    ulFineOffset,
    dlFineOffset,
    lastCmdDl: dl.lastFreqHz,
    lastCmdUl: ul.lastFreqHz,
    step: digitStep,
    ctcssMode,
    ctcssAccessHz,
    ctcssActivationHz,
    syncNeeded,
  };
}

function applyEndpointChange() {
  const wasOn = radioOn;
  const ulWanted = ul.wanted;
  const dlWanted = dl.wanted;
  closeLink(ul);
  closeLink(dl);
  api.close();
  radioOn = wasOn;
  if (wasOn) {
    markSyncNeeded("endpoint change");
    ul.wanted = ulWanted;
    dl.wanted = dlWanted;
    if (currentModeIsFm()) {
      const h = apiHost();
      if (h) api.connect(h, apiPort()).catch(() => {});
    } else {
      disconnectApi("endpoint change non-FM");
    }
    if (ulWanted) openLink(ul).catch(() => {});
    if (dlWanted) openLink(dl).catch(() => {});
  }
  broadcastStatus();
}

module.exports = {
  init,
  open: async () => true,
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
