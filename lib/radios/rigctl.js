/**
 * Generic Hamlib / rigctl TCP driver.
 *
 * Speaks the standard rigctl net protocol (same as rigctld / SDR++ RigCTL).
 * Not tied to any specific radio — any server that accepts `f` / `F` / `m` / `M`
 * over TCP can be controlled (SDR++, rigctld on a remote PC, flrig, etc.).
 *
 * Config:
 *   RADIO_TRANSPORT=tcp
 *   RADIO_PROTOCOL=rigctl
 *   RIGCTL_HOST / RIGCTL_PORT          — primary (DL or single VFO)
 *   RIGCTL_UL_HOST / RIGCTL_UL_PORT    — optional second endpoint for UL
 *
 * If only the primary is set and BOTH ul+dl are provided, the driver
 * runs dual-VFO satellite style (IC-9700 etc.):
 *   U SATMODE 1 → V Main + F/M (DL) → V Sub + F/M (UL)
 * Single frequency (e.g. SDR++ DL-only) stays on one VFO; SAT left alone.
 *
 * Dual-path: optional second rigctl endpoint for UL (RIGCTL_UL_*).
 */

const net = require("net");
const config = require("../config");
const { isFmMode, getCatalog } = require("../catalog");

const meta = {
  id: "rigctl",
  label: "Hamlib / rigctl (TCP)",
  match(cfg) {
    return (
      cfg.RADIO_TRANSPORT === "tcp" &&
      String(cfg.RADIO_PROTOCOL || "").toLowerCase() === "rigctl"
    );
  },
};

function makeLink(name) {
  return {
    name,
    socket: null,
    connected: false,
    connecting: false,
    busy: false,
    buf: "",
    lastFreqHz: null, // primary / Main / DL
    lastSubHz: null, // Sub / UL on single-endpoint dual-VFO
    lastMode: null,
    lastSubMode: null,
    currentVfo: null,
    satModeOn: null, // null unknown, true/false last commanded
    dualSat: false, // single endpoint driving Main+Sub
    satCaps: null, // null=unknown, true/false from config or U ?
    reconnectTimer: null,
    wanted: false,
    setCount: 0,
    justReset: false,
    lastPushAt: 0,
    dualPhase: 0,
  };
}

const dl = makeLink("dl");
const ul = makeLink("ul");

let radioOn = false;
let locked = false;
let pushInFlight = false;
let manualDlOffset = 0;
let ulFineOffset = 0;
let dlFineOffset = 0;
let digitStep = 100;
let broadcastFn = () => {};
let ctcssMode = "off";
let ctcssAccessHz = null;
let ctcssActivationHz = null;

/** Skip resend when commanded freq is within this of last successful set. */
const FREQ_THRESH_HZ = 1;  // match TCI — satellite Doppler needs fine steps
const CONNECT_TIMEOUT_MS = 4000;
const CMD_TIMEOUT_MS = 800;
/** Min ms between dual-SAT full pushes (IC-9700 can't keep up at 250ms). */
const DUAL_PUSH_MIN_MS = 400;
/** Hz deadband for dual-SAT freq sets (Doppler is slow; avoid 1 Hz spam). */
const DUAL_FREQ_THRESH_HZ = 10;
/** Single-VFO fire-and-forget still uses FREQ_THRESH_HZ. */

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

function hostPort(side) {
  if (side === "ul") {
    const h = (config.RIGCTL_UL_HOST || "").trim();
    const p = config.RIGCTL_UL_PORT || 0;
    if (h && p > 0) return { host: h, port: p };
    return null;
  }
  return {
    host: (config.RIGCTL_HOST || "127.0.0.1").trim(),
    port: config.RIGCTL_PORT || 4532,
  };
}


function hasSeparateUl() {
  return !!hostPort("ul");
}

/** Models known to support dual-VFO satellite mode via Hamlib SATMODE. */
const SAT_DUAL_MODELS = [
  "ic-9700",
  "ic9700",
  "9700",
  "ic-9100",
  "ic9100",
  "9100",
  "ic-910",
  "ic910",
  "910",
  "ts-2000",
  "ts2000",
  "2000",
  "ft-847",
  "ft847",
  "847",
];

function configSuggestsSatDual() {
  const raw = [
    config.SERIAL_MODEL,
    config.serialModel,
    config.RADIO_MODEL,
    config.CAT_MODEL,
    config.RIGCTL_SAT_DUAL,
  ]
    .filter((x) => x != null && String(x).trim() !== "")
    .map((x) => String(x).toLowerCase().trim());
  for (const s of raw) {
    if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
    if (s === "0" || s === "false" || s === "no" || s === "off") return false;
    for (const m of SAT_DUAL_MODELS) {
      if (s === m || s.indexOf(m) >= 0) return true;
    }
  }
  return null; // unknown
}

/**
 * Decide whether this link should use SAT + Main/Sub dual VFO.
 * - Config model match → yes
 * - Else probe "U ?" once for SATMODE token (cached on link)
 * - IC-705 / SDR++ / unknown without SATMODE → no
 */
async function canUseDualSat(link) {
  if (!link || !link.connected) return false;
  if (link.satCaps === true) return true;
  if (link.satCaps === false) return false;

  const cfg = configSuggestsSatDual();
  if (cfg === true) {
    link.satCaps = true;
    console.log("rigctl", link.name, "dual-SAT enabled (config model)");
    return true;
  }
  if (cfg === false) {
    link.satCaps = false;
    return false;
  }

  // Probe once: list funcs; look for SATMODE
  try {
    const resp = await sendCmd(link, "U ?");
    const text = resp != null ? String(resp) : "";
    if (/SATMODE/i.test(text)) {
      link.satCaps = true;
      console.log("rigctl", link.name, "dual-SAT enabled (U ? has SATMODE)");
      return true;
    }
    // Empty / error / no token → not supported
    link.satCaps = false;
    console.log(
      "rigctl",
      link.name,
      "dual-SAT disabled (no SATMODE in caps)",
      text ? text.slice(0, 80) : "(empty)",
    );
    return false;
  } catch (_) {
    link.satCaps = false;
    return false;
  }
}


function statusPayload() {
  const both = dl.connected && (!hasSeparateUl() || ul.connected);
  return {
    type: "rigctl",
    radioOn,
    locked,
    connected: both,
    tciConnected: both,
    connecting: dl.connecting || ul.connecting,
    host: config.RIGCTL_HOST || "127.0.0.1",
    port: config.RIGCTL_PORT || 4532,
    ulHost: config.RIGCTL_UL_HOST || "",
    ulPort: config.RIGCTL_UL_PORT || 0,
    dual: hasSeparateUl(),
    manualDlOffset,
    ulFineOffset,
    dlFineOffset,
    step: digitStep,
    lastCmdDl: dl.lastFreqHz,
    lastCmdUl: ul.lastFreqHz || dl.lastFreqHz,
    ctcssMode,
    ctcssAccessHz,
    ctcssActivationHz,
  };
}

function broadcastStatus() {
  broadcastFn(statusPayload());
}

/**
 * Send one rigctl command and wait for a single-line reply.
 * Serializes per-link so commands do not interleave.
 */
function sendCmd(link, cmd) {
  return new Promise((resolve) => {
    if (!link.socket || !link.connected) {
      resolve(null);
      return;
    }

    if (link.busy) {
      // Retry a limited time then give up (avoid infinite queue → stuck session)
      const started = Date.now();
      const tryLater = () => {
        if (!link.connected) {
          resolve(null);
          return;
        }
        if (!link.busy) {
          sendCmd(link, cmd).then(resolve);
          return;
        }
        if (Date.now() - started > 1200) {
          resolve(null);
          return;
        }
        setTimeout(tryLater, 40);
      };
      setTimeout(tryLater, 40);
      return;
    }

    link.busy = true;
    let settled = false;

    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      link.busy = false;
      if (link.socket) {
        try {
          link.socket.removeListener("data", onData);
        } catch (_) {}
      }
      resolve(val);
    };

    const onData = (chunk) => {
      link.buf += chunk.toString("utf8");
      // Reply is one line (value or "RPRT n")
      if (link.buf.indexOf("\n") >= 0 || /RPRT\s+-?\d+/.test(link.buf)) {
        const line = link.buf.split(/\r?\n/)[0].trim();
        link.buf = "";
        finish(line);
      }
    };

    const timer = setTimeout(() => finish(null), CMD_TIMEOUT_MS);

    link.socket.on("data", onData);
    try {
      link.socket.write(cmd + "\n", (err) => {
        if (err) finish(null);
      });
    } catch (e) {
      finish(null);
    }
  });
}


/**
 * Hamlib set_func SATMODE. IC-9700: ON enables Main=DL / Sub=UL dual-VFO.
 * get_freq (0x25) often fails while SAT is on — avoid relying on f in dual-sat.
 */
async function setSatMode(link, on) {
  if (!link || !link.connected) return false;
  if (link.satModeOn === !!on) return true;
  try {
    const resp = await sendCmd(link, "U SATMODE " + (on ? "1" : "0"));
    if (resp == null) {
      console.warn(
        "rigctl",
        link.name,
        "SATMODE",
        on ? "ON" : "OFF",
        ": no reply",
      );
      return false;
    }
    if (/^RPRT\s+-/.test(resp)) {
      console.warn(
        "rigctl",
        link.name,
        "SATMODE",
        on ? "ON" : "OFF",
        ":",
        resp,
      );
      return false;
    }
    link.satModeOn = !!on;
    link.currentVfo = null; // VFO context may change with SAT
    console.log(
      "rigctl",
      link.name,
      "SATMODE",
      on ? "ON" : "OFF",
      resp.trim ? resp.trim() : resp,
    );
    return true;
  } catch (e) {
    console.warn("rigctl", link.name, "SATMODE error:", e.message || e);
    return false;
  }
}

async function ensureSatModeOn(link) {
  return setSatMode(link, true);
}
async function ensureSatModeOff(link) {
  return setSatMode(link, false);
}

/** Hamlib set_vfo — Main/Sub for IC-9700 SAT, VFOA/VFOB for others. */
async function setVfo(link, vfo) {
  if (!link || !link.connected || !vfo) return false;
  if (link.currentVfo === vfo) return true;
  const resp = await sendCmd(link, "V " + vfo);
  if (resp != null && /^RPRT\s+-/.test(resp)) {
    console.warn("rigctl", link.name, "set_vfo", vfo, resp);
    return false;
  }
  link.currentVfo = vfo;
  // Keep lastMode / lastSubMode — re-sending M every VFO hop floods the radio
  return true;
}

function openLink(link, side) {
  if (link.connected || link.connecting) return Promise.resolve(!!link.connected);
  const ep = hostPort(side);
  if (!ep) return Promise.resolve(false);

  link.connecting = true;
  link.wanted = true;
  broadcastStatus();

  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      link.connecting = false;
      if (!ok) {
        link.connected = false;
        link.socket = null;
        scheduleReconnect(link, side);
      }
      broadcastStatus();
      resolve(ok);
    };

    let sock;
    try {
      sock = net.connect({ host: ep.host, port: ep.port });
    } catch (e) {
      console.warn("rigctl", link.name, "connect exception:", e.message);
      done(false);
      return;
    }

    // Connect-phase timeout only — cleared on successful connect.
    // Leaving setTimeout active after connect was killing idle sockets
    // every 4s (no unsolicited data from SDR++/rigctld) → reconnect loop.
    sock.setTimeout(CONNECT_TIMEOUT_MS);

    sock.once("connect", () => {
      sock.setTimeout(0); // disable idle timeout permanently
      link.socket = sock;
      link.connected = true;
      link.buf = "";
      link.busy = false;
      // Force a fresh freq set after (re)connect
      link.lastFreqHz = null;
      link.lastMode = null;
      console.log("rigctl", link.name, "connected", ep.host + ":" + ep.port);
      link.satModeOn = null;
      link.dualSat = false;
      link.satCaps = null;
      link.currentVfo = null;
      link.lastSubHz = null;
      done(true);
    });

    sock.once("timeout", () => {
      console.warn("rigctl", link.name, "connect timeout", ep.host + ":" + ep.port);
      try {
        sock.destroy();
      } catch (_) {}
      if (!settled) done(false);
    });

    sock.on("error", (e) => {
      console.warn("rigctl", link.name, "error:", e.message);
      link.connected = false;
      if (link.socket === sock) link.socket = null;
      if (!settled) {
        done(false);
      } else {
        broadcastStatus();
        if (radioOn && link.wanted) scheduleReconnect(link, side);
      }
    });

    sock.on("close", () => {
      const wasConnected = link.connected || link.socket === sock;
      if (link.socket === sock) {
        link.socket = null;
        link.connected = false;
        link.busy = false;
        link.lastFreqHz = null; // force re-set after reconnect
      }
      if (!settled) {
        done(false);
      } else if (wasConnected) {
        broadcastStatus();
        if (radioOn && link.wanted) scheduleReconnect(link, side);
      }
    });
  });
}

function scheduleReconnect(link, side) {
  if (link.reconnectTimer) return;
  if (!radioOn || !link.wanted) return;
  link.reconnectTimer = setTimeout(() => {
    link.reconnectTimer = null;
    if (radioOn && link.wanted && !link.connected && !link.connecting) {
      openLink(link, side).catch(() => {});
    }
  }, 2500);
}

function closeLink(link) {
  link.wanted = false;
  if (link.reconnectTimer) {
    clearTimeout(link.reconnectTimer);
    link.reconnectTimer = null;
  }
  if (link.socket) {
    try {
      link.socket.removeAllListeners();
      link.socket.destroy();
    } catch (_) {}
    link.socket = null;
  }
  link.connected = false;
  link.connecting = false;
  link.busy = false;
  link.buf = "";
  link.lastFreqHz = null;
  link.lastMode = null;
}

async function openAll() {
  const okDl = await openLink(dl, "dl");
  let okUl = true;
  if (hasSeparateUl()) okUl = await openLink(ul, "ul");
  return okDl && okUl;
}

function closeAll() {
  closeLink(dl);
  closeLink(ul);
  radioOn = false;
  pushInFlight = false;
  broadcastStatus();
  console.log("rigctl disconnected");
}

function setRadio(on) {
  if (on) {
    radioOn = true;
    manualDlOffset = 0;
    ulFineOffset = 0;
    dlFineOffset = 0;
    dl.lastFreqHz = null;
    ul.lastFreqHz = null;
    broadcastStatus();
    openAll().catch(() => {});
  } else {
    closeAll();
  }
}

function setLock(on) {
  locked = !!on;
  broadcastStatus();
}

function applyDefaultLock(isFm) {
  locked = !!isFm;
  // Force mode re-send after sat/mode change (SSB → FM etc.)
  dl.lastMode = null;
  ul.lastMode = null;
  broadcastStatus();
}

function setCtcss(which) {
  // rigctl has no universal CTCSS; keep state for UI only
  if (which === "access" && ctcssAccessHz != null) ctcssMode = "access";
  else if (which === "activation" && ctcssActivationHz != null)
    ctcssMode = "activation";
  else ctcssMode = "off";
  broadcastStatus();
}

function applyDefaultCtcss(accessHz, activationHz) {
  ctcssAccessHz = accessHz != null ? accessHz : null;
  ctcssActivationHz = activationHz != null ? activationHz : null;
  ctcssMode = ctcssAccessHz != null ? "access" : "off";
  dl.lastMode = null;
  ul.lastMode = null;
  broadcastStatus();
}

function writeCmd(link, cmd) {
  if (!link.socket || !link.connected) return false;
  try {
    if (!cmd.endsWith("\n")) cmd += "\n";
    link.socket.write(cmd);
    return true;
  } catch (e) {
    return false;
  }
}

async function setFreq(link, hz) {
  if (!link.connected || hz == null || !Number.isFinite(hz)) return false;
  const target = Math.round(hz);
  if (
    link.lastFreqHz != null &&
    Math.abs(target - link.lastFreqHz) < FREQ_THRESH_HZ
  ) {
    return true;
  }

  // Continuous Doppler: fire-and-forget (same idea as TCI vfo:).
  // Awaiting RPRT every 250ms tick serializes behind network RTT and lags.
  // First set after connect still uses request/response as a sanity check.
  const isInitial = link.lastFreqHz == null;
  if (isInitial) {
    let resp = await sendCmd(link, "F " + target);
    if (resp != null && /^RPRT\s+-9\b/.test(resp) && !link.dualSat) {
      console.warn("rigctl", link.name, "set_freq rejected — SATMODE OFF retry");
      await ensureSatModeOff(link);
      resp = await sendCmd(link, "F " + target);
    }
    if (resp == null) return false;
    if (/^RPRT\s+-/.test(resp)) {
      console.warn("rigctl", link.name, "set_freq error:", resp);
      return false;
    }
  } else {
    if (link.busy) return false;
    if (!writeCmd(link, "F " + target)) return false;
  }

  const prev = link.lastFreqHz;
  link.lastFreqHz = target;
  link.justReset = false;
  link.setCount = (link.setCount || 0) + 1;
  if (link.setCount <= 8 || link.setCount % 20 === 0 || prev == null) {
    console.log(
      "rigctl",
      link.name,
      "freq",
      (target / 1e6).toFixed(6),
      "MHz",
      prev == null ? "(initial)" : "",
    );
  }
  return true;
}

async function readFreq(link) {
  if (!link.connected) return null;
  // In dual-SAT mode get_freq (0x25) is unreliable — skip
  if (link.dualSat || link.satModeOn) return null;
  link.buf = "";
  let resp = await sendCmd(link, "f");
  if (resp == null) return null;
  if (/^RPRT\s+-9\b/.test(resp) || /rejected/i.test(resp)) {
    // Single-VFO path: clear SAT and retry
    console.warn("rigctl", link.name, "get_freq rejected — SATMODE OFF retry");
    await ensureSatModeOff(link);
    link.buf = "";
    resp = await sendCmd(link, "f");
    if (resp == null) return null;
  }
  if (/^RPRT\s+-/.test(resp)) return null;
  const hz = parseInt(String(resp).trim(), 10);
  return Number.isFinite(hz) && hz > 0 ? hz : null;
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

/** Map catalog mode string → Hamlib mode names for UL / DL. */
function modesForActive(active) {
  const modeStr = (active && active.mode) || "";
  if (isFmMode(modeStr)) return { ul: "FM", dl: "FM" };
  const m = modeStr.toUpperCase();
  if (/\bFM\b|NFM|GFSK|CTCSS|C4FM|DSTAR|DMR/.test(m)) return { ul: "FM", dl: "FM" };
  if (/\bCW\b/.test(m) && !/\bSSB\b/.test(m)) return { ul: "CW", dl: "CW" };
  // Linear SSB invert: UL LSB, DL USB (same as TCI / Flex)
  return { ul: "LSB", dl: "USB" };
}

async function setMode(link, mode, which) {
  if (!link.connected || !mode) return false;
  const sub = which === "sub" || which === "ul";
  if (sub) {
    if (link.lastSubMode === mode) return true;
  } else if (link.lastMode === mode) {
    return true;
  }
  const resp = await sendCmd(link, "M " + mode + " 0");
  if (resp == null) return false;
  if (/^RPRT\s+-/.test(resp)) {
    console.warn("rigctl", link.name, "set_mode error:", resp);
    return false;
  }
  if (sub) link.lastSubMode = mode;
  else link.lastMode = mode;
  console.log("rigctl", link.name, "mode →", mode, sub ? "[Sub/UL]" : "[Main/DL]");
  return true;
}

/**
 * Set frequency on current VFO; track Main vs Sub last-Hz separately.
 */

/** Dual-SAT freq set with wider deadband; always request/response (VFO just selected). */
async function setFreqSideDual(link, hz, side) {
  if (!link.connected || hz == null || !Number.isFinite(hz)) return false;
  const target = Math.round(hz);
  const isSub = side === "sub" || side === "ul";
  const last = isSub ? link.lastSubHz : link.lastFreqHz;
  if (last != null && Math.abs(target - last) < DUAL_FREQ_THRESH_HZ) return true;

  const resp = await sendCmd(link, "F " + target);
  if (resp != null && /^RPRT\s+-/.test(resp)) {
    console.warn(
      "rigctl",
      link.name,
      "set_freq error:",
      resp,
      isSub ? "[Sub]" : "[Main]",
    );
    return false;
  }
  if (isSub) link.lastSubHz = target;
  else link.lastFreqHz = target;
  link.justReset = false;
  link.setCount = (link.setCount || 0) + 1;
  if (link.setCount <= 6 || link.setCount % 15 === 0 || last == null) {
    console.log(
      "rigctl",
      link.name,
      isSub ? "UL/Sub" : "DL/Main",
      (target / 1e6).toFixed(6),
      "MHz",
      last == null ? "(initial)" : "",
    );
  }
  return true;
}

async function setFreqSide(link, hz, side) {
  if (!link.connected || hz == null || !Number.isFinite(hz)) return false;
  const target = Math.round(hz);
  const isSub = side === "sub" || side === "ul";
  const last = isSub ? link.lastSubHz : link.lastFreqHz;
  if (last != null && Math.abs(target - last) < FREQ_THRESH_HZ) return true;

  const isInitial = last == null;
  if (isInitial || link.dualSat) {
    // Await first sets and dual-sat (need VFO already selected)
    let resp = await sendCmd(link, "F " + target);
    if (resp != null && /^RPRT\s+-9\b/.test(resp) && !link.dualSat) {
      await ensureSatModeOff(link);
      resp = await sendCmd(link, "F " + target);
    }
    if (resp == null) return false;
    if (/^RPRT\s+-/.test(resp)) {
      console.warn("rigctl", link.name, "set_freq error:", resp, isSub ? "[Sub]" : "[Main]");
      return false;
    }
  } else {
    if (link.busy) return false;
    if (!writeCmd(link, "F " + target)) return false;
  }

  if (isSub) link.lastSubHz = target;
  else link.lastFreqHz = target;
  link.justReset = false;
  link.setCount = (link.setCount || 0) + 1;
  if (link.setCount <= 8 || link.setCount % 20 === 0 || isInitial) {
    console.log(
      "rigctl",
      link.name,
      isSub ? "UL/Sub" : "DL/Main",
      (target / 1e6).toFixed(6),
      "MHz",
      isInitial ? "(initial)" : "",
    );
  }
  return true;
}

async function pushFrequencies(ulHz, dlHz) {
  if (!radioOn) return;
  if (pushInFlight) return; // prevent stacked dual-SAT sequences on one socket
  pushInFlight = true;
  const wd = setTimeout(() => {
    if (pushInFlight) {
      console.warn("rigctl push watchdog — clearing in-flight");
      pushInFlight = false;
    }
  }, 4000);
  try {
    await pushFrequenciesBody(ulHz, dlHz);
  } finally {
    clearTimeout(wd);
    pushInFlight = false;
  }
}

async function pushFrequenciesBody(ulHz, dlHz) {
  const { currentSatKey, currentModeIndex } = getCtx();
  const info = getCatalog()[currentSatKey] || {};
  const active = getActiveModeObj(info, currentModeIndex);
  const mods = modesForActive(active);

  const hasUl = ulHz != null && Number.isFinite(ulHz);
  const hasDl = dlHz != null && Number.isFinite(dlHz);

  const needDl = hasDl || (hasUl && !hasSeparateUl());
  if (needDl && !dl.connected && !dl.connecting) {
    await openLink(dl, "dl");
  }
  if (!dl.connected && !hasSeparateUl()) return;

  // ── Dual endpoint: separate rigctld for UL ──
  if (hasSeparateUl()) {
    dl.dualSat = false;
    if (hasDl && dl.connected) {
      await setMode(dl, mods.dl);
      if (!locked && dl.lastFreqHz != null && !dl.justReset) {
        const reported = await readFreq(dl);
        if (reported != null && Math.abs(reported - dl.lastFreqHz) > 80) {
          const dopplerOnly = dlHz - manualDlOffset - dlFineOffset;
          manualDlOffset = reported - dopplerOnly - dlFineOffset;
          dl.lastFreqHz = reported;
          broadcastStatus();
          return;
        }
      }
      await setFreq(dl, dlHz);
    }
    if (hasUl) {
      if (!ul.connected && !ul.connecting) await openLink(ul, "ul");
      if (ul.connected) {
        await setMode(ul, mods.ul);
        await setFreq(ul, ulHz);
      }
    }
    return;
  }

  // ── Single endpoint + both UL/DL + sat-capable backend → dual-VFO SAT ──
  if (hasUl && hasDl && dl.connected && (await canUseDualSat(dl))) {
    const firstDual = !dl.dualSat || dl.lastFreqHz == null || dl.lastSubHz == null;
    dl.dualSat = true;
    if (dl.satModeOn !== true) {
      await ensureSatModeOn(dl);
    }

    const now = Date.now();
    const dlT = Math.round(dlHz);
    const ulT = Math.round(ulHz);
    const dlDelta =
      dl.lastFreqHz == null ? 1e9 : Math.abs(dlT - dl.lastFreqHz);
    const ulDelta =
      dl.lastSubHz == null ? 1e9 : Math.abs(ulT - dl.lastSubHz);
    const needDl = dlDelta >= DUAL_FREQ_THRESH_HZ;
    const needUl = ulDelta >= DUAL_FREQ_THRESH_HZ;
    const needMode =
      dl.lastMode !== mods.dl || dl.lastSubMode !== mods.ul;
    const due = now - (dl.lastPushAt || 0) >= DUAL_PUSH_MIN_MS;

    if (!firstDual) {
      if (!needDl && !needUl && !needMode) return;
      if (!due && dlDelta < 150 && ulDelta < 150) return;
    }

    dl.lastPushAt = now;

    // ── Initial: full handshake (await) so we know SAT/VFO/mode work ──
    if (firstDual || needMode) {
      if (!(await setVfo(dl, "Main"))) return;
      await setMode(dl, mods.dl, "main");
      await setFreqSideDual(dl, dlT, "main");
      if (!(await setVfo(dl, "Sub"))) return;
      await setMode(dl, mods.ul, "sub");
      await setFreqSideDual(dl, ulT, "sub");
      console.log(
        "rigctl dual-SAT Main/DL",
        (dlT / 1e6).toFixed(6),
        "Sub/UL",
        (ulT / 1e6).toFixed(6),
        "MHz",
      );
      return;
    }

    // ── Steady Doppler: alternate Main / Sub, fire-and-forget (no await RPRT) ──
    // Avoids stacking 6 sequential CI-V round-trips every tick → stuck session.
    dl.dualPhase = (dl.dualPhase || 0) + 1;
    const doMain = needDl && (!needUl || dl.dualPhase % 2 === 1);
    const doSub = needUl && (!needDl || dl.dualPhase % 2 === 0);
    // If only one side needs update, do that side
    if (needDl && !needUl) {
      writeCmd(dl, "V Main");
      writeCmd(dl, "F " + dlT);
      dl.lastFreqHz = dlT;
      dl.currentVfo = "Main";
      if (dl.setCount++ % 10 === 0) {
        console.log("rigctl dl DL/Main", (dlT / 1e6).toFixed(6), "MHz");
      }
    } else if (needUl && !needDl) {
      writeCmd(dl, "V Sub");
      writeCmd(dl, "F " + ulT);
      dl.lastSubHz = ulT;
      dl.currentVfo = "Sub";
      if (dl.setCount++ % 10 === 0) {
        console.log("rigctl dl UL/Sub", (ulT / 1e6).toFixed(6), "MHz");
      }
    } else if (doMain) {
      writeCmd(dl, "V Main");
      writeCmd(dl, "F " + dlT);
      dl.lastFreqHz = dlT;
      dl.currentVfo = "Main";
      if (dl.setCount++ % 10 === 0) {
        console.log("rigctl dl DL/Main", (dlT / 1e6).toFixed(6), "MHz");
      }
    } else if (doSub) {
      writeCmd(dl, "V Sub");
      writeCmd(dl, "F " + ulT);
      dl.lastSubHz = ulT;
      dl.currentVfo = "Sub";
      if (dl.setCount++ % 10 === 0) {
        console.log("rigctl dl UL/Sub", (ulT / 1e6).toFixed(6), "MHz");
      }
    }
    return;
  }

  // ── Single endpoint, single VFO (IC-705, SDR++, or no SATMODE) ──
  // If both freqs present but no dual-SAT, drive DL only (legacy behavior).
  if (dl.connected) {
    if (dl.dualSat) {
      dl.dualSat = false;
    }
    const hz = hasDl ? dlHz : hasUl ? ulHz : null;
    const mode = hasDl ? mods.dl : mods.ul;
    if (hz == null) return;

    await setMode(dl, mode, "main");
    if (!locked && !dl.dualSat && dl.lastFreqHz != null && !dl.justReset) {
      const reported = await readFreq(dl);
      if (reported != null && Math.abs(reported - dl.lastFreqHz) > 80) {
        if (hasDl) {
          const dopplerOnly = dlHz - manualDlOffset - dlFineOffset;
          manualDlOffset = reported - dopplerOnly - dlFineOffset;
        }
        dl.lastFreqHz = reported;
        broadcastStatus();
        return;
      }
    }
    await setFreq(dl, hz);
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
    dl.lastFreqHz = null;
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
  dl.lastFreqHz = null;
  ul.lastFreqHz = null;
  broadcastStatus();
}

function resetOffsets() {
  manualDlOffset = 0;
  ulFineOffset = 0;
  dlFineOffset = 0;
  dl.lastFreqHz = null;
  ul.lastFreqHz = null;
  dl.lastSubHz = null;
  dl.lastMode = null;
  dl.lastSubMode = null;
  ul.lastMode = null;
  dl.currentVfo = null;
  dl.lastPushAt = 0;
  dl.justReset = true;
  ul.justReset = true;
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
  dl.lastFreqHz = null;
  ul.lastFreqHz = null;
  broadcastStatus();
}

function getRadioState() {
  const both = dl.connected && (!hasSeparateUl() || ul.connected);
  return {
    radioOn,
    locked,
    connected: both,
    tciConnected: both,
    connecting: dl.connecting || ul.connecting,
    manualDlOffset,
    ulFineOffset,
    dlFineOffset,
    lastCmdDl: dl.lastFreqHz,
    lastCmdUl: ul.lastFreqHz || dl.lastFreqHz,
    step: digitStep,
    ctcssMode,
    ctcssAccessHz,
    ctcssActivationHz,
  };
}

function applyEndpointChange() {
  const wasOn = radioOn;
  closeAll();
  if (wasOn) {
    radioOn = true;
    openAll().catch(() => {});
  }
  broadcastStatus();
}

module.exports = {
  meta,
  init,
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
  broadcastStatus,
  applyEndpointChange,
};
