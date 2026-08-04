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

const FREQ_THRESH_HZ = 50;

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
  const both =
    dl.connected && (!hasSeparateUl() || ul.connected);
  return {
    type: "rigctl",
    radioOn,
    locked,
    connected: both,
    tciConnected: both,
    connecting: dl.connecting || ul.connecting,
    host: (config.RIGCTL_HOST || "127.0.0.1"),
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

function sendCmd(link, cmd) {
  return new Promise((resolve) => {
    if (!link.socket || !link.connected) {
      resolve(null);
      return;
    }
    if (link.busy) {
      // simple serialize: wait briefly
      setTimeout(() => {
        sendCmd(link, cmd).then(resolve);
      }, 40);
      return;
    }
    link.busy = true;
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      link.busy = false;
      if (link.socket) link.socket.removeListener("data", onData);
      resolve(val);
    };
    const onData = (chunk) => {
      link.buf += chunk.toString("utf8");
      if (link.buf.indexOf("\n") >= 0) {
        const line = link.buf.split(/\r?\n/)[0].trim();
        link.buf = "";
        finish(line);
      }
    };
    const timer = setTimeout(() => finish(null), 1500);
    link.socket.on("data", onData);
    try {
      link.socket.write(cmd + "\n");
    } catch (e) {
      clearTimeout(timer);
      finish(null);
      return;
    }
    // most set commands reply with RPRT 0 or empty; get returns value
    // onData will clear the timer via finish
    const origFinish = finish;
    // re-bind so timer is cleared
    const finish2 = (v) => {
      clearTimeout(timer);
      origFinish(v);
    };
    link.socket.removeListener("data", onData);
    link.socket.on("data", (chunk) => {
      link.buf += chunk.toString("utf8");
      if (link.buf.indexOf("\n") >= 0 || link.buf.indexOf("RPRT") >= 0) {
        const line = link.buf.split(/\r?\n/)[0].trim();
        link.buf = "";
        finish2(line);
      }
    });
  });
}

function openLink(link, side) {
  if (link.connected || link.connecting) return Promise.resolve(link.connected);
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
      if (!ok) scheduleReconnect(link, side);
      broadcastStatus();
      resolve(ok);
    };

    const sock = net.connect({ host: ep.host, port: ep.port }, () => {
      link.socket = sock;
      link.connected = true;
      link.buf = "";
      console.log(
        "rigctl", link.name, "connected", ep.host + ":" + ep.port,
      );
      done(true);
    });

    sock.setTimeout(4000);
    sock.on("timeout", () => {
      sock.destroy();
      if (!settled) done(false);
    });
    sock.on("error", (e) => {
      console.warn("rigctl", link.name, "error:", e.message);
      link.connected = false;
      link.socket = null;
      if (!settled) done(false);
      else {
        broadcastStatus();
        if (radioOn && link.wanted) scheduleReconnect(link, side);
      }
    });
    sock.on("close", () => {
      link.connected = false;
      link.socket = null;
      link.busy = false;
      broadcastStatus();
      if (radioOn && link.wanted) scheduleReconnect(link, side);
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
  }, 3000);
}

function closeLink(link) {
  link.wanted = false;
  if (link.reconnectTimer) {
    clearTimeout(link.reconnectTimer);
    link.reconnectTimer = null;
  }
  if (link.socket) {
    try {
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

function modeForActive(active) {
  const modeStr = (active && active.mode) || "";
  if (isFmMode(modeStr)) return "FM";
  const m = String(modeStr).toUpperCase();
  if (/\bFM\b|NFM|CTCSS/.test(m)) return "FM";
  if (/\bCW\b/.test(m) && !/\bSSB\b/.test(m)) return "CW";
  if (/LSB/.test(m)) return "LSB";
  if (/USB/.test(m)) return "USB";
  // linear sats default: UL LSB, DL USB — caller may push twice
  return "USB";
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
  // Accept RPRT 0, empty, or numeric echo
  if (resp == null) return false;
  if (/^RPRT\s+-/.test(resp)) {
    console.warn("rigctl", link.name, "set_freq error:", resp);
    return false;
  }
  link.lastFreqHz = target;
  return true;
}

async function setMode(link, mode) {
  if (!link.connected || !mode) return false;
  if (link.lastMode === mode) return true;
  // Hamlib: M <mode> <passband>
  // passband 0 = default
  const resp = await sendCmd(link, "M " + mode + " 0");
  if (resp == null) return false;
  if (/^RPRT\s+-/.test(resp)) {
    console.warn("rigctl", link.name, "set_mode error:", resp);
    return false;
  }
  link.lastMode = mode;
  return true;
}

async function pushFrequencies(ulHz, dlHz) {
  if (!radioOn) return;
  if (!dl.connected) {
    await openAll();
    if (!dl.connected) return;
  }

  // DL (or single) endpoint
  if (dlHz != null && Number.isFinite(dlHz)) {
    await setFreq(dl, dlHz);
  }

  // UL
  if (ulHz != null && Number.isFinite(ulHz)) {
    if (hasSeparateUl()) {
      if (!ul.connected) await openLink(ul, "ul");
      if (ul.connected) await setFreq(ul, ulHz);
    } else {
      // single endpoint: also push UL (split / last-wins depending on server)
      // Prefer leaving DL as the "main" VFO; only set UL if no separate link
      // and caller wants both — many RX-only SDR++ setups only care about DL.
      // Still send UL so TX-capable rigctld radios stay in sync when possible.
      await setFreq(dl, ulHz);
      // immediately restore DL so RX stays on downlink
      if (dlHz != null && Number.isFinite(dlHz)) {
        await sleep(30);
        await setFreq(dl, dlHz);
      }
    }
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
  const both =
    dl.connected && (!hasSeparateUl() || ul.connected);
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
