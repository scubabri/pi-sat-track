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
 * If only the primary is set, both UL and DL frequencies are sent to it
 * (useful for split-capable radios or RX-only SDR++ monitoring DL).
 *
 * Dual-path: when only one side is assigned to this driver, the other
 * frequency arg is null and is ignored.
 */

const net = require("net");
const config = require("../config");
const { isFmMode } = require("../catalog");

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
    lastFreqHz: null,
    lastMode: null,
    reconnectTimer: null,
    wanted: false,
    setCount: 0,
  };
}

const dl = makeLink("dl");
const ul = makeLink("ul");

let radioOn = false;
let locked = false;
let manualDlOffset = 0;
let ulFineOffset = 0;
let dlFineOffset = 0;
let digitStep = 100;
let broadcastFn = () => {};
let ctcssMode = "off";
let ctcssAccessHz = null;
let ctcssActivationHz = null;

/** Skip resend when commanded freq is within this of last successful set. */
const FREQ_THRESH_HZ = 25;
const CONNECT_TIMEOUT_MS = 4000;
const CMD_TIMEOUT_MS = 1200;

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
      setTimeout(() => {
        sendCmd(link, cmd).then(resolve);
      }, 30);
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
  broadcastStatus();
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
  const resp = await sendCmd(link, "F " + target);
  if (resp == null) {
    // Timeout / no reply — do not update lastFreqHz so we retry next tick
    return false;
  }
  if (/^RPRT\s+-/.test(resp)) {
    console.warn("rigctl", link.name, "set_freq error:", resp);
    return false;
  }
  const prev = link.lastFreqHz;
  link.lastFreqHz = target;
  link.setCount = (link.setCount || 0) + 1;
  // Log first few sets and occasional updates so Doppler tracking is visible
  if (link.setCount <= 5 || link.setCount % 40 === 0 || prev == null) {
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

async function setMode(link, mode) {
  if (!link.connected || !mode) return false;
  if (link.lastMode === mode) return true;
  // Hamlib: M <mode> <passband>; passband 0 = default
  const resp = await sendCmd(link, "M " + mode + " 0");
  if (resp == null) return false;
  if (/^RPRT\s+-/.test(resp)) {
    console.warn("rigctl", link.name, "set_mode error:", resp);
    return false;
  }
  link.lastMode = mode;
  console.log("rigctl", link.name, "mode →", mode);
  return true;
}

async function pushFrequencies(ulHz, dlHz) {
  if (!radioOn) return;

  // Ensure DL link when we have a DL (or single-endpoint UL) target
  const needDl =
    (dlHz != null && Number.isFinite(dlHz)) ||
    (ulHz != null && Number.isFinite(ulHz) && !hasSeparateUl());
  if (needDl && !dl.connected && !dl.connecting) {
    await openLink(dl, "dl");
  }

  // DL (or single) endpoint
  if (dlHz != null && Number.isFinite(dlHz) && dl.connected) {
    await setFreq(dl, dlHz);
  }

  // UL
  if (ulHz != null && Number.isFinite(ulHz)) {
    if (hasSeparateUl()) {
      if (!ul.connected && !ul.connecting) await openLink(ul, "ul");
      if (ul.connected) await setFreq(ul, ulHz);
    } else if (dlHz == null || !Number.isFinite(dlHz)) {
      // Single endpoint, UL-only push (no DL this tick)
      if (dl.connected) await setFreq(dl, ulHz);
    }
    // When both present on one endpoint, DL is the active VFO — leave it.
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
  dl.lastMode = null;
  ul.lastMode = null;
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
  setCtcss,
  applyDefaultCtcss,
  getRadioState,
  broadcastStatus,
  applyEndpointChange,
};
