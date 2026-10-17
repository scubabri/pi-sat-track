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
 * Without SATMODE (IC-705, etc.) and TX_SPLIT: S 1 VFOB + F/M (DL on A)
 *   + I/X (UL on TX VFO) without switching the selected VFO.
 * Single frequency / TX_SPLIT off (e.g. SDR++ DL-only) stays on one VFO.
 *
 * Dual-path: optional second rigctl endpoint for UL (RIGCTL_UL_*).
 */

const net = require("net");
const config = require("../config");
const { isFmMode, getCatalog, formatFreqDisplayFromMode } = require("../catalog");
const { isSimplex } = require("./simplex");
const kw = require("./ts2000-cat");

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
    lastToneKey: null, // last CTCSS state applied ("FM:670:B" / "off"); null = resend
    dualSynced: false, // completed initial Main+Sub handshake this connection
    splitOn: false, // TX_SPLIT single-VFO: S 1 VFOB active
    splitFailed: false, // S/I returned RPRT-; fall back to DL-only
    satModeFailed: false, // U SATMODE 1 returned RPRT- (e.g. -11 on TS-2000) — never retry
    ts: null, // TS-2000 raw-`w` state (see tsState)
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
/** Last tone readback result: null = not verified yet / off; true = matched. */
let toneVerified = null;
/** Human-readable reason when the radio didn't report the commanded tone. */
let toneError = null;

/** Skip resend when commanded freq is within this of last successful set. */
const FREQ_THRESH_HZ = 1;  // match TCI — satellite Doppler needs fine steps
const CONNECT_TIMEOUT_MS = 4000;
const CMD_TIMEOUT_MS = 800;
/** Min ms between dual-SAT full pushes (IC-9700 can't keep up at 250ms). */
const DUAL_PUSH_MIN_MS = 350;
/** Hz deadband for dual-SAT freq sets (Doppler is slow; avoid 1 Hz spam). */
const DUAL_FREQ_THRESH_HZ = 5;
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

function txSplitEnabled() {
  return config.TX_SPLIT !== false;
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
  "ft-847",
  "ft847",
  "847",
];

/**
 * Kenwood TS-2000 behind rigctld (Hamlib model 2014). Hamlib can't drive its SAT
 * mode (no RIG_FUNC_SATMODE), so it gets its own raw-`w` path (pushTs2000).
 */
function isTs2000(cfg) {
  const c = cfg || config;
  const raw = [c.SERIAL_MODEL, c.serialModel, c.RADIO_MODEL, c.CAT_MODEL, c.RIGCTL_MODEL, c.HAMLIB_MODEL]
    .filter((x) => x != null && String(x).trim() !== "")
    .map((x) => String(x).toLowerCase().trim());
  return raw.some((s) => /\bts-?2000\b/.test(s) || s === "2014");
}

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
    lastCmdUl: ul.lastFreqHz || dl.lastSubHz || dl.lastFreqHz,
    ctcssMode,
    ctcssAccessHz,
    ctcssActivationHz,
    cwMode,
    supportsCwMode: true,
    toneVerified,
    toneError,
  };
}

function broadcastStatus() {
  broadcastFn(statusPayload());
}

/**
 * Send one rigctl command and wait for a single-line reply.
 * Serializes per-link so commands do not interleave.
 */
function sendCmd(link, cmd, opts) {
  const skip = opts && opts.skip;
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
          sendCmd(link, cmd, opts).then(resolve);
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
      // rigctld `w` replies are '\0'-separated Kenwood tokens with no newline;
      // late ones must never be mistaken for a normal rigctl reply.
      let text = chunk.toString("utf8");
      if (opts && opts.raw) {
        // Late "RPRT 0" acks from earlier fire-and-forget writes are not ours.
        link.buf = (link.buf + text).replace(/RPRT\s+0\s*\n?/g, "");
        const rprt = link.buf.match(/RPRT\s+-\d+/);
        if (rprt) {
          link.buf = "";
          finish(rprt[0]);
          return;
        }
        if (kw.matchReply(opts.raw, link.buf).done) {
          const out = link.buf;
          link.buf = "";
          finish(out);
        }
        return;
      }
      text = text.replace(/\0/g, "").replace(/(?:[A-Z?][A-Z0-9]{0,40};)+/g, "");
      link.buf += text;
      // Reply is one line (value or "RPRT n")
      if (skip) {
        // Line-matching mode: discard stale replies (e.g. RPRT 0 from
        // fire-and-forget F / I writes) until a line not matching `skip`.
        let nl;
        while ((nl = link.buf.indexOf("\n")) >= 0) {
          const line = link.buf.slice(0, nl).trim();
          link.buf = link.buf.slice(nl + 1);
          if (!line || skip.test(line)) continue;
          link.buf = "";
          finish(line);
          return;
        }
        return;
      }
      if (link.buf.indexOf("\n") >= 0 || /RPRT\s+-?\d+/.test(link.buf)) {
        const line = link.buf.split(/\r?\n/)[0].trim();
        link.buf = "";
        finish(line);
      }
    };

    const timer = setTimeout(
      () => finish(null),
      (opts && opts.timeoutMs) || CMD_TIMEOUT_MS,
    );

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
  if (on && link.satModeFailed) return false; // cached: backend has no SATMODE
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
      if (on) {
        link.satModeFailed = true; // log once, stop retrying every tick
        console.warn("rigctl", link.name, "SATMODE ON :", resp, "— not supported by backend; not retrying");
      } else {
        console.warn("rigctl", link.name, "SATMODE OFF :", resp);
      }
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
      link.dualSynced = false;
      link.satCaps = null;
      link.currentVfo = null;
      link.lastSubHz = null;
      link.lastSubMode = null;
      link.splitOn = false;
      link.splitFailed = false;
      link.satModeFailed = false;
      link.ts = null;
      link.lastToneKey = null;
      link.toneWasOn = false; // set true once we turn tone ON; OFF in split then clears VFOA+VFOB

      link.dualPhase = 0;
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
  link.lastSubHz = null;
  link.lastSubMode = null;
  link.splitOn = false;
  link.satModeFailed = false;
  link.ts = null;
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

async function disableRadio() {
  if (dl.connected && dl.ts) await tsRestore(dl);
  if (dl.connected && dl.splitOn && !dl.splitFailed) {
    await ensureSplitOff(dl);
  }
  closeAll();
}

function setRadio(on) {
  if (on) {
    radioOn = true;
    // Keep restored per-sat manual/fine offsets (only center/resetOffsets clear)
    dl.lastFreqHz = null;
    ul.lastFreqHz = null;
    dl.lastSubHz = null;
    dl.lastSubMode = null;
    broadcastStatus();
    openAll().catch(() => {});
  } else {
    disableRadio().catch(() => closeAll());
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
  dl.lastSubMode = null;
  broadcastStatus();
}

function activeCtcssHz() {
  if (ctcssMode === "access") return ctcssAccessHz;
  if (ctcssMode === "activation") return ctcssActivationHz;
  return null;
}

/** Force CTCSS resend on next push (applied inside the serialized push). */
function markToneDirty() {
  toneVerified = null;
  toneError = null;
  dl.lastToneKey = null;
  ul.lastToneKey = null;
  dl.dualSynced = false; // dual-SAT: redo handshake so Sub tone is resent
}

function setCtcss(which) {
  if (which === "access" && ctcssAccessHz != null) ctcssMode = "access";
  else if (which === "activation" && ctcssActivationHz != null)
    ctcssMode = "activation";
  else ctcssMode = "off";
  console.log("rigctl CTCSS", ctcssMode, activeCtcssHz());
  markToneDirty();
  broadcastStatus();
}

function applyDefaultCtcss(accessHz, activationHz) {
  ctcssAccessHz = accessHz != null ? accessHz : null;
  ctcssActivationHz = activationHz != null ? activationHz : null;
  ctcssMode = ctcssAccessHz != null ? "access" : "off";
  markToneDirty();
  dl.lastMode = null;
  ul.lastMode = null;
  dl.lastSubMode = null;
  broadcastStatus();
}

/** Send one tone-related command; true on RPRT 0 (stale RPRT lines skipped). */
async function toneCmd(link, cmd) {
  // Awaited: skip non-RPRT lines; stale RPRT 0 from fire-and-forget writes is
  // indistinguishable but harmless (all our writes ack with RPRT 0).
  const resp = await sendCmd(link, cmd, { skip: /^(?!RPRT\s)/ });
  if (resp == null || /^RPRT\s+-/.test(String(resp))) {
    console.warn("rigctl", link.name, "tone cmd failed:", cmd, "→", resp == null ? "no reply" : resp);
    return false;
  }
  return true;
}

/**
 * Awaited readback query (c / u TONE). Skips stale RPRT 0 acks from earlier
 * fire-and-forget writes. Returns { val } or { err } (NAK / no reply).
 * Unsupported/NAK is warned once per link+cmd.
 */
async function toneQuery(link, cmd) {
  const resp = await sendCmd(link, cmd, { skip: /^RPRT\s+0\b/ });
  let err = null;
  if (resp == null) err = "no reply";
  else if (/^RPRT\s+-/.test(String(resp))) err = String(resp);
  if (err) {
    link.toneReadWarned = link.toneReadWarned || {};
    if (!link.toneReadWarned[cmd]) {
      link.toneReadWarned[cmd] = true;
      console.warn("rigctl", link.name, "tone readback", JSON.stringify(cmd), "unsupported/failed:", err, "(logged once)");
    }
    return { err };
  }
  return { val: String(resp).trim() };
}

/** Read c + u TONE on the currently selected VFO; compare with commanded tenths. */
async function readbackCurrentVfo(link, label, tenths) {
  if (tenths == null) {
    const u0 = await toneQuery(link, "u TONE");
    const on = u0.err ? null : u0.val === "1" ? 1 : u0.val === "0" ? 0 : null;
    const t = u0.err ? "TONE " + u0.err : "TONE=" + (on == null ? "'" + u0.val + "'" : on);
    const problem = u0.err ? "read failed (u TONE: " + u0.err + ")" : on !== 0 ? "MISMATCH" : null;
    return { text: label + " " + t + (problem === "MISMATCH" ? " MISMATCH" : ""), problem, report: label + " " + t };
  }
  const c = await toneQuery(link, "c");
  const u = await toneQuery(link, "u TONE");
  const gotTenths = c.err ? null : parseInt(c.val, 10);
  const gotOn = u.err ? null : u.val === "1" ? 1 : u.val === "0" ? 0 : null;
  const hzTxt = c.err ? "c " + c.err : Number.isFinite(gotTenths) ? (gotTenths / 10).toFixed(1) + " Hz" : "c '" + c.val + "'";
  const onTxt = u.err ? "TONE " + u.err : "TONE=" + (gotOn == null ? "'" + u.val + "'" : gotOn);
  let problem = null;
  if (c.err || u.err) problem = "read failed (" + [c.err && "c: " + c.err, u.err && "u TONE: " + u.err].filter(Boolean).join(", ") + ")";
  else if (gotTenths !== tenths || gotOn !== 1) problem = "MISMATCH";
  return { text: label + " " + hzTxt + " " + onTxt + (problem === "MISMATCH" ? " MISMATCH" : ""), problem, report: label + " " + hzTxt + " " + onTxt };
}

async function writeToneCurrentVfo(link, tenths) {
  if (tenths == null) {
    const a = await toneCmd(link, "U TONE 0");
    const b = await toneCmd(link, "U TSQL 0");
    return a && b;
  }
  const a = await toneCmd(link, "C " + tenths);
  const b = await toneCmd(link, "U TONE 1");
  // Encode only: make sure tone squelch is off.
  const c = await toneCmd(link, "U TSQL 0");
  return a && b && c;
}

/**
 * CTCSS encode for the uplink. Hamlib/Icom set_ctcss_tone + set_func TONE act
 * on the *currently selected* VFO (icom.c ignores the vfo arg), and Icom keeps
 * tone per-VFO, so with single-VFO split (TX=VFOB) we set it on VFOA (current)
 * and then on VFOB via V VFOB … V VFOA. Non-FM: clear (U TONE 0) on current
 * VFO only (no V switch — VFOB tone is irrelevant outside FM).
 * opts.where: "current" | "split" | "sub" (dual-SAT: Sub = UL)
 */
async function applyTone(link, ulMode, opts) {
  if (!link || !link.connected) return;
  const where = (opts && opts.where) || "current";
  const isFm = /FM/.test(String(ulMode || ""));
  const hz = isFm ? activeCtcssHz() : null;
  const tenths = hz != null && Number.isFinite(+hz) ? Math.round(+hz * 10) : null;
  const key = tenths != null ? "FM:" + tenths + ":" + where : "off";
  if (link.lastToneKey === key) return;
  let ok;
  const rb = []; // readback results, one per VFO touched
  const want = tenths != null ? (tenths / 10).toFixed(1) + " Hz TONE=1" : "";
  if (tenths == null && where === "split" && link.toneWasOn) {
    // TX tone lives on VFOB in split: clear both VFOs in one VFOB window.
    ok = await writeToneCurrentVfo(link, null);
    rb.push(await readbackCurrentVfo(link, "VFOA", null));
    const vb = await toneCmd(link, "V VFOB");
    ok = vb && ok;
    if (vb) {
      ok = (await writeToneCurrentVfo(link, null)) && ok;
      rb.push(await readbackCurrentVfo(link, "VFOB", null));
    } else {
      rb.push({ text: "VFOB not selected", problem: "V VFOB failed", report: "VFOB could not be selected" });
    }
    ok = (await toneCmd(link, "V VFOA")) && ok;
    if (ok) console.log("rigctl", link.name, "tone → OFF [VFOA+VFOB/TX]");
  } else if (tenths == null) {
    // Never set ON this connection (e.g. linear sat at connect): current VFO only, no V flicker.
    ok = await writeToneCurrentVfo(link, null);
    rb.push(await readbackCurrentVfo(link, where === "sub" ? "Sub" : "VFO", null));
    if (ok) console.log("rigctl", link.name, "tone → OFF");
  } else if (where === "split") {
    ok = await writeToneCurrentVfo(link, tenths); // VFOA (RX; harmless)
    rb.push(await readbackCurrentVfo(link, "VFOA", tenths));
    const vb = await toneCmd(link, "V VFOB");
    ok = vb && ok;
    if (vb) {
      // Set + readback inside one VFOB selection window (no extra flicker).
      ok = (await writeToneCurrentVfo(link, tenths)) && ok; // VFOB = TX
      rb.push(await readbackCurrentVfo(link, "VFOB", tenths));
    } else {
      rb.push({ text: "VFOB not selected", problem: "V VFOB failed", report: "VFOB could not be selected" });
    }
    ok = (await toneCmd(link, "V VFOA")) && ok;
    if (ok) console.log("rigctl", link.name, "tone →", (tenths / 10).toFixed(1), "Hz ON [VFOA+VFOB/TX]");
  } else if (where === "sub") {
    ok = (await toneCmd(link, "V Sub")) && (await writeToneCurrentVfo(link, tenths));
    rb.push(await readbackCurrentVfo(link, "Sub", tenths));
    if (ok) console.log("rigctl", link.name, "tone →", (tenths / 10).toFixed(1), "Hz ON [Sub/UL]");
  } else {
    ok = await writeToneCurrentVfo(link, tenths);
    rb.push(await readbackCurrentVfo(link, "VFO", tenths));
    if (ok) console.log("rigctl", link.name, "tone →", (tenths / 10).toFixed(1), "Hz ON");
  }
  if (tenths != null) link.toneWasOn = true;
  const bad = rb.filter((r) => r.problem);
  const line = rb.map((r) => r.text).join(" | ");
  if (line) {
    if (bad.length) console.warn("rigctl", link.name, "tone readback", line);
    else console.log("rigctl", link.name, "tone readback", line);
  }
  if (!ok || bad.length) {
    toneVerified = false;
    toneError =
      "Tone " + (tenths == null ? "OFF" : "ON") + " not confirmed (wanted " +
      (tenths == null ? "TONE=0" : want) + "). Radio reported: " +
      rb.map((r) => r.report + (r.problem ? " [" + r.problem + "]" : "")).join("; ") +
      (ok ? "" : " — a set command was NAK'd");
  } else {
    toneVerified = tenths == null ? null : true;
    toneError = null;
  }
  if (tenths == null && !toneError) link.toneWasOn = false;
  broadcastStatus();
  // Mark applied even on failure to avoid spamming every tick; UI change / reconnect retries.
  link.lastToneKey = key;
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
  link.recentFreqs = (link.recentFreqs || []).concat(target).slice(-8);
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

async function readFreq(link, opts) {
  if (!link.connected) return null;
  const allowSat = opts && opts.allowSat;
  // Default: skip in dual-SAT (0x25 often NAKs). allowSat=true tries anyway after VFO select.
  if (!allowSat && (link.dualSat || link.satModeOn)) return null;
  link.buf = "";
  // Skip pending "RPRT 0" acks from fire-and-forget writes so they are not
  // mistaken for the get_freq reply (root cause of dial absorb never firing).
  let resp = await sendCmd(link, "f", { skip: /^RPRT\s+0\b/ });
  if (resp == null) return null;
  if (/^RPRT\s+-9\b/.test(resp) || /rejected/i.test(resp)) {
    if (allowSat) return null; // don't kill SAT mode during dual-sat absorb attempt
    console.warn("rigctl", link.name, "get_freq rejected — SATMODE OFF retry");
    await ensureSatModeOff(link);
    link.buf = "";
    resp = await sendCmd(link, "f", { skip: /^RPRT\s+0\b/ });
    if (resp == null) return null;
  }
  if (/^RPRT\s+-/.test(resp)) return null;
  if (!/^\d+(\.\d+)?$/.test(String(resp).trim())) return null;
  const hz = Math.round(parseFloat(String(resp).trim()));
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
/**
 * CW toggle (linear SSB sats only; default OFF). UL and DL both CW. The
 * Doppler-corrected dial frequency is sent unchanged: in CW the displayed
 * frequency is the carrier (Icom/Flex/Hamlib), so no BFO/pitch offset is
 * added — zero-beat on the downlink and you transmit on the carrier.
 * Mutually exclusive with Data.
 */
let cwMode = false;

function setCwMode(on) {
  const next = !!on;
  if (next === cwMode) return;
  cwMode = next;
  dl.lastMode = null;
  dl.lastSubMode = null;
  ul.lastMode = null;
  ul.lastSubMode = null;
  dl.dualSynced = false;
  console.log("rigctl CW", cwMode ? "ON (UL CW / DL CW)" : "OFF");
  broadcastStatus();
}

function modesForActive(active) {
  const m0 = modesForActiveBase(active);
  if (cwMode && m0.ul === "LSB" && m0.dl === "USB") return { ul: "CW", dl: "CW" };
  return m0;
}

function modesForActiveBase(active) {
  const modeStr = (active && active.mode) || "";
  if (isFmMode(modeStr)) return { ul: "FM", dl: "FM" };
  const m = modeStr.toUpperCase();
  if (/\bFM\b|NFM|GFSK|GMSK|AFSK|APRS|PACKET|CTCSS|C4FM|DSTAR|DMR/.test(m))
    return { ul: "FM", dl: "FM" };
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
 * TX_SPLIT single-VFO: enable Hamlib split (TX = VFOB) without switching RX VFO.
 * On RPRT failure, log once and mark splitFailed so we fall back to DL-only.
 */
async function ensureSplitOn(link) {
  if (!link || !link.connected) return false;
  if (link.splitFailed) return false;
  if (link.splitOn) return true;
  const resp = await sendCmd(link, "S 1 VFOB");
  if (resp == null || /^RPRT\s+-/.test(String(resp))) {
    link.splitFailed = true;
    link.splitOn = false;
    console.warn(
      "rigctl",
      link.name,
      "set_split_vfo failed:",
      resp == null ? "no reply" : resp,
      "— falling back to DL-only",
    );
    return false;
  }
  link.splitOn = true;
  console.log("rigctl", link.name, "split ON (TX=VFOB)");
  return true;
}

/** Best-effort split off before disconnect (S 0 VFOA). */
async function ensureSplitOff(link) {
  if (!link || !link.connected || !link.splitOn) return;
  try {
    const resp = await sendCmd(link, "S 0 VFOA");
    if (resp != null && /^RPRT\s+-/.test(String(resp))) {
      console.warn("rigctl", link.name, "set_split_vfo OFF:", resp);
    } else {
      console.log("rigctl", link.name, "split OFF");
    }
  } catch (_) {}
  link.splitOn = false;
}

/**
 * set_split_mode — TX VFO mode without selecting it (mirrors setMode for DL).
 */
async function setSplitMode(link, mode) {
  if (!link.connected || !mode || link.splitFailed) return false;
  if (link.lastSubMode === mode) return true;
  const resp = await sendCmd(link, "X " + mode + " 0");
  if (resp == null) return false;
  if (/^RPRT\s+-/.test(String(resp))) {
    console.warn("rigctl", link.name, "set_split_mode error:", resp);
    // Mode failure alone does not kill split freq tracking
    return false;
  }
  link.lastSubMode = mode;
  console.log("rigctl", link.name, "ul(split) mode →", mode);
  return true;
}

/**
 * set_split_freq (I) — TX/UL without switching selected VFO.
 * Same deadband as single-VFO DL (FREQ_THRESH_HZ); await first write for RPRT.
 */
async function setSplitFreq(link, hz) {
  if (!link.connected || hz == null || !Number.isFinite(hz) || link.splitFailed)
    return false;
  const target = Math.round(hz);
  if (
    link.lastSubHz != null &&
    Math.abs(target - link.lastSubHz) < FREQ_THRESH_HZ
  ) {
    return true;
  }

  const isInitial = link.lastSubHz == null;
  if (isInitial) {
    const resp = await sendCmd(link, "I " + target);
    if (resp == null) return false;
    if (/^RPRT\s+-/.test(String(resp))) {
      link.splitFailed = true;
      console.warn(
        "rigctl",
        link.name,
        "set_split_freq failed:",
        resp,
        "— falling back to DL-only",
      );
      return false;
    }
  } else {
    if (link.busy) return false;
    if (!writeCmd(link, "I " + target)) return false;
  }

  const prev = link.lastSubHz;
  link.lastSubHz = target;
  link.setCount = (link.setCount || 0) + 1;
  if (link.setCount <= 8 || link.setCount % 20 === 0 || prev == null) {
    console.log(
      "rigctl",
      "ul(split)",
      "freq",
      (target / 1e6).toFixed(6),
      "MHz",
      prev == null ? "(initial)" : "",
    );
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// Kenwood TS-2000 via rigctld raw passthrough (`w`). Mirrors lib/radios/ts2000.js:
//   SAT (cross-band): SA1010000 → MAIN=DL (FA), SUB=UL (FB); TF-SET (TS1/TS0) when
//   MAIN is on the wrong band; SUB mode/tone via SA P4=1 cycle; FM = dial locked.
//   Same-band simplex: SAT off → Hamlib split (VFOA=DL, S 1 VFOB, I=UL), locked.
//   DL-only: SAT off → plain VFOA. Restore SA (+ TS0 if swapped) on disconnect.
// ─────────────────────────────────────────────────────────────────────────────

const TS_W_TIMEOUT_MS = 1500; // Hamlib waits its 200 ms rig timeout per `w`
/**
 * Largest MAIN readback move treated as an operator dial turn in one tick.
 * Anything bigger (other band, SAT memory recalled on SA1, TF-SET swap, our own
 * write to the other layout) is NOT a dial turn — it would poison manualDl
 * (live ISS mode 0 → 3: -21596 Hz "absorb" was the 70cm SAT memory).
 */
const TS_DIAL_MAX_HZ = 10000;
/** No dial absorb for this long after SAT entry / sat / mode / band change. */
const TS_SETTLE_MS = 3000;
/** TF-SET band-swap attempts per layout before giving up (operator must press it). */
const TS_BAND_MAX_TRIES = 2;
/** While FA/FB keep nak'ing: one warning, then a summary at most this often. */
const TS_NAK_REPEAT_MS = 30000;

function tsState(link) {
  if (!link.ts) {
    link.ts = {
      w: "unknown", // "unknown" | "ok" | "unsupported"
      saOriginal: null, // 7-digit SA as found at engage (restored on disconnect)
      satOn: false, // we put the radio in SAT
      satFailed: false, // SA set not confirmed → split path this session
      offDone: false, // SAT confirmed off for split / DL-only
      swapped: false, // TF-SET pressed this session
      bandKey: null, // layout key (sat|mode|DL band/UL band) whose MAIN/SUB bands were verified
      bandTries: 0, // TF-SET attempts for the current layout
      bandTriesKey: null,
      bandBad: false, // bands still wrong after TF-SET → no Doppler writes (they'd nak)
      ctxKey: null, // sat|modeIndex last seen (mode change → settle + clear manualDl)
      settleUntil: 0, // no dial absorb before this (ms epoch)
      modeKey: null,
      toneKey: null,
      toneOn: false,
      faNak: 0,
      faNakSince: 0,
      faNakWarnAt: 0,
      lastPushAt: 0,
      logged: {},
    };
  }
  return link.ts;
}

function tsLogOnce(ts, key, ...args) {
  if (ts.logged[key]) return;
  ts.logged[key] = true;
  console.warn(...args);
}

/**
 * One rigctld `w` transaction. Always ends with at least one query so a reply
 * arrives. Returns { ok, naks, q: { FA: "FA…", … }, rprt } — ok=false on
 * RPRT- / no reply. First failure (RPRT -11/-4/… or silence) marks `w` unsupported.
 */
async function tsW(link, cmd) {
  const ts = tsState(link);
  if (ts.w === "unsupported") return { ok: false, naks: 0, q: {} };
  const resp = await sendCmd(link, "w " + cmd, { raw: cmd, timeoutMs: TS_W_TIMEOUT_MS });
  if (resp == null || /^RPRT\s+-/.test(String(resp))) {
    if (ts.w === "unknown") {
      ts.w = "unsupported";
      console.warn(
        "rigctl",
        link.name,
        "TS-2000 raw `w` passthrough unavailable (",
        resp == null ? "no reply" : resp,
        ") — falling back to Hamlib split (SAT mode not used)",
      );
    }
    return { ok: false, naks: 0, q: {}, rprt: resp };
  }
  ts.w = "ok";
  const m = kw.matchReply(cmd, resp);
  return { ok: true, naks: m.naks, q: m.byQuery };
}

/** Put / keep the radio in SAT. Reads SA once to save the original. */
async function tsEnsureSat(link) {
  const ts = tsState(link);
  if (ts.satOn) return true;
  if (ts.satFailed || ts.w === "unsupported") return false;
  const r0 = await tsW(link, "SA;");
  if (!r0.ok) return false;
  const before = kw.parseSa(r0.q.SA);
  if (ts.saOriginal == null && before) ts.saOriginal = before.raw.slice(0, 7).padEnd(7, "0");
  console.log("rigctl TS-2000 SA; →", r0.q.SA || "?", "(saved for restore)");
  let after = before;
  if (!before || !before.on || before.p3 !== "1" || before.raw.slice(3, 7) !== "0000") {
    const r1 = await tsW(link, kw.SA_ON + ";SA;");
    after = r1.ok ? kw.parseSa(r1.q.SA) : null;
  }
  if (!(after && after.on)) {
    ts.satFailed = true;
    console.warn("rigctl TS-2000 SAT mode NOT confirmed — using VFO split (A=DL, B=UL) this session");
    return false;
  }
  ts.satOn = true;
  ts.offDone = false;
  ts.modeKey = null;
  ts.toneKey = null;
  // SA1 recalls the radio's own SAT MAIN/SUB frequencies (whatever the last SAT
  // session left, e.g. 70cm MAIN from an earlier U/V mode). Nothing we wrote in
  // split / DL-only applies here: re-verify the bands and don't compare the
  // first FA readback against a split-mode VFO A write.
  ts.bandKey = null;
  ts.bandBad = false;
  ts.settleUntil = Date.now() + TS_SETTLE_MS;
  link.lastFreqHz = null;
  link.lastSubHz = null;
  link.justReset = true;
  console.log("rigctl TS-2000 SAT ON (MAIN=DL FA, SUB=UL FB) — keep TRACE OFF");
  return true;
}

/** SAT off (simplex / DL-only). Saves the original SA the first time. */
async function tsEnsureSatOff(link) {
  const ts = tsState(link);
  if (ts.offDone || ts.w === "unsupported") return;
  const r0 = await tsW(link, "SA;");
  if (!r0.ok) return;
  const before = kw.parseSa(r0.q.SA);
  if (ts.saOriginal == null && before) ts.saOriginal = before.raw.slice(0, 7).padEnd(7, "0");
  if (before && before.on) {
    let ok = false;
    for (const c of ["SA0000000", "SA0010000"]) {
      const r = await tsW(link, c + ";SA;");
      const rb = r.ok ? kw.parseSa(r.q.SA) : null;
      if (rb && !rb.on) {
        ok = true;
        break;
      }
    }
    console.log("rigctl TS-2000 SAT OFF", ok ? "OK" : "FAILED");
  }
  ts.satOn = false;
  ts.offDone = true;
  link.currentVfo = null; // Hamlib FR works again
  link.lastFreqHz = null;
  link.lastMode = null;
  link.lastSubHz = null;
  link.lastSubMode = null;
}

/** SUB (UL) mode and tone need CTRL→SUB (SA P4=1); MD/TN/TO act on the control band. */
async function tsWithCtrlSub(link, fn) {
  const ts = tsState(link);
  const r1 = await tsW(link, kw.SA_CTRL_SUB + ";SA;");
  const rb1 = r1.ok ? kw.parseSa(r1.q.SA) : null;
  if (!(rb1 && rb1.on && rb1.p4 === "1")) {
    if (rb1 && rb1.on && rb1.p4 !== "0") await tsW(link, kw.SA_ON + ";SA;");
    tsLogOnce(ts, "ctrlsub", "rigctl TS-2000 can't select SUB (SA P4) — set SUB mode/tone on the radio");
    return false;
  }
  try {
    await fn();
  } finally {
    const r0 = await tsW(link, kw.SA_ON + ";SA;");
    const rb0 = r0.ok ? kw.parseSa(r0.q.SA) : null;
    if (!(rb0 && rb0.on && rb0.p4 === "0")) console.warn("rigctl TS-2000 CTRL back to MAIN not confirmed", rb0 ? rb0.raw : "none");
  }
  return true;
}

async function tsApplyModes(link, mods, key) {
  const ts = tsState(link);
  if (ts.modeKey === key) return;
  ts.modeKey = key; // one attempt per sat/mode change — never per tick
  const ulMd = kw.mdCode(mods.ul);
  const dlMd = kw.mdCode(mods.dl);
  if (ulMd) {
    await tsWithCtrlSub(link, async () => {
      const r = await tsW(link, "MD" + ulMd + ";MD;");
      console.log("rigctl TS-2000 SUB (UL) MD" + ulMd, mods.ul, "→", r.q.MD || "?", r.naks ? "NAK" : "");
    });
  }
  if (dlMd) {
    const r = await tsW(link, "MD" + dlMd + ";MD;");
    console.log("rigctl TS-2000 MAIN (DL) MD" + dlMd, mods.dl, "→", r.q.MD || "?", r.naks ? "NAK" : "");
  }
  link.lastMode = mods.dl;
  link.lastSubMode = mods.ul;
}

/** CTCSS encode on SUB (UL/TX) in SAT: SA P4=1 → TNxx;TO1; → verify → SA P4=0. */
async function tsApplyTone(link, mods) {
  const ts = tsState(link);
  const hz = mods.ul === "FM" ? activeCtcssHz() : null;
  const key = hz != null ? String(hz) : "off";
  if (ts.toneKey === key) return;
  ts.toneKey = key;
  if (hz == null && !ts.toneOn) {
    toneVerified = null;
    toneError = null;
    return;
  }
  const code = hz != null ? kw.toneCode(hz) : null;
  if (hz != null && code == null) {
    toneVerified = false;
    toneError = "no TN match for " + hz + " Hz";
    broadcastStatus();
    return;
  }
  const done = await tsWithCtrlSub(link, async () => {
    if (hz != null) {
      const tc = String(code).padStart(2, "0");
      const r = await tsW(link, "TN" + tc + ";TO1;TN;TO;");
      const ok = r.ok && new RegExp("^TN" + tc).test(r.q.TN || "") && /^TO1/.test(r.q.TO || "");
      ts.toneOn = ok || ts.toneOn;
      toneVerified = ok;
      toneError = ok ? null : "SUB tone readback " + (r.q.TN || "?") + " " + (r.q.TO || "?") + " want TN" + tc + " TO1";
      console.log("rigctl TS-2000 CTCSS SUB (UL)", hz, "Hz TN" + tc, ok ? "OK" : "FAIL");
    } else {
      const r = await tsW(link, "TO0;TO;");
      const ok = r.ok && /^TO0/.test(r.q.TO || "");
      if (ok) ts.toneOn = false;
      toneVerified = null;
      toneError = ok ? null : "SUB tone off readback " + (r.q.TO || "?");
      console.log("rigctl TS-2000 CTCSS SUB (UL) OFF", ok ? "OK" : "FAIL");
    }
  });
  if (!done) {
    toneVerified = false;
    toneError = "can't select SUB for tone — set tone on radio";
  }
  broadcastStatus();
}

/** Read FA + FB once; { fa, fb } (null when garbled). */
async function tsReadBands(link) {
  const r = await tsW(link, "FA;FB;");
  return {
    fa: r.ok ? kw.parseFreq(r.q.FA, "A") : null,
    fb: r.ok ? kw.parseFreq(r.q.FB, "B") : null,
  };
}

/**
 * MAIN must be on the DL band and SUB on the UL band before any Doppler write:
 * in SAT the TS-2000 naks an FA/FB write to the band the other receiver holds,
 * and CAT can't move them (SA has no band parameter — P3 only says which side
 * is TX). Checked per layout (sat|mode|DL band/UL band), not per sat: one sat
 * can be V/U on one mode and U/V on another (ISS 9k6 437.8 DL vs FM 145.8 DL).
 * Wrong band → FA write (radio may move MAIN itself) → TF-SET (TS1/TS0) swap →
 * FA/FB readback. Returns true when MAIN/SUB are on the right bands.
 */
async function tsCheckBands(link, ulHz, dlHz, layoutKey) {
  const ts = tsState(link);
  if (ts.bandKey === layoutKey) return !ts.bandBad;
  const dlBand = kw.bandOf(dlHz);
  const ulBand = kw.bandOf(ulHz);
  const okBands = (b) =>
    b.fa != null && kw.bandOf(b.fa) === dlBand && (b.fb == null || ulBand === dlBand || kw.bandOf(b.fb) === ulBand);
  const b0 = await tsReadBands(link);
  if (b0.fa == null) return false; // garbled — try again next tick (no writes this tick)
  if (okBands(b0)) {
    ts.bandKey = layoutKey;
    ts.bandBad = false;
    return true;
  }
  if (ts.bandTriesKey !== layoutKey) {
    ts.bandTriesKey = layoutKey;
    ts.bandTries = 0;
  }
  console.log(
    "rigctl TS-2000 band check: MAIN",
    kw.bandOf(b0.fa),
    "SUB",
    b0.fb != null ? kw.bandOf(b0.fb) : "?",
    "— want MAIN(DL)",
    dlBand,
    "SUB(UL)",
    ulBand,
  );
  const w = await tsW(link, kw.freqCmd("A", dlHz) + ";FA;FB;");
  const b1 = { fa: w.ok ? kw.parseFreq(w.q.FA, "A") : null, fb: w.ok ? kw.parseFreq(w.q.FB, "B") : null };
  if (w.ok && !w.naks && okBands(b1)) {
    ts.bandKey = layoutKey; // radio moved MAIN itself
    ts.bandBad = false;
    link.lastFreqHz = null;
    link.lastSubHz = null;
    console.log("rigctl TS-2000 MAIN moved to", dlBand, "by FA write");
    return true;
  }
  if (ts.bandTries >= TS_BAND_MAX_TRIES) {
    ts.bandKey = layoutKey; // give up for this layout — don't flood TS1/TS0
    ts.bandBad = true;
    toneError = "Press TF-SET: MAIN must be " + dlBand + " (DL), SUB " + ulBand + " (UL/TX)";
    console.warn(
      "rigctl TS-2000 WARN MAIN still on",
      kw.bandOf(b1.fa != null ? b1.fa : b0.fa),
      "after",
      ts.bandTries,
      "TF-SET swaps — press TF-SET on the radio (Doppler paused until MAIN is",
      dlBand + ")",
    );
    broadcastStatus();
    return false;
  }
  ts.bandTries++;
  const s = await tsW(link, "TS1;TS0;FA;FB;");
  const b2 = { fa: s.ok ? kw.parseFreq(s.q.FA, "A") : null, fb: s.ok ? kw.parseFreq(s.q.FB, "B") : null };
  const swapped = okBands(b2);
  ts.swapped = true;
  ts.modeKey = null; // re-apply modes / tone on the new layout
  ts.toneKey = null;
  ts.settleUntil = Date.now() + TS_SETTLE_MS;
  link.lastFreqHz = null;
  link.lastSubHz = null;
  console.log("rigctl TS-2000 TF-SET swap (TS1/TS0) →", s.q.FA || "?", s.q.FB || "?", swapped ? "OK" : "NOT swapped");
  if (swapped) {
    ts.bandKey = layoutKey;
    ts.bandBad = false;
    if (/^Press TF-SET/.test(toneError || "")) toneError = null;
    return true;
  }
  return false; // re-check (and maybe swap again) next tick
}

/**
 * Returns "done" (SAT handled), "split" / "split-locked" (use the generic
 * single-VFO split path, SAT off) or "dl-only".
 */
async function pushTs2000(ulHz, dlHz, active, mods) {
  const link = dl;
  const ts = tsState(link);
  const hasUl = ulHz != null && Number.isFinite(ulHz);
  const hasDl = dlHz != null && Number.isFinite(dlHz);
  const { currentSatKey, currentModeIndex } = getCtx();
  const now0 = Date.now();

  // Sat or mode change: settle window (no dial absorb), re-verify bands, fresh
  // nak count. Same sat, other mode → manualDl from the old mode is meaningless
  // (other transponder / band) — clear it.
  const ctxKey = (currentSatKey || "") + "|" + (currentModeIndex || 0);
  if (ts.ctxKey !== ctxKey) {
    const prev = ts.ctxKey;
    ts.ctxKey = ctxKey;
    ts.settleUntil = now0 + TS_SETTLE_MS;
    ts.bandKey = null;
    ts.bandBad = false;
    ts.faNak = 0;
    ts.faNakSince = 0;
    link.lastFreqHz = null;
    link.lastSubHz = null;
    link.justReset = true;
    const prevSat = prev != null ? prev.slice(0, prev.lastIndexOf("|")) : null;
    if (prev != null && prevSat === (currentSatKey || "") && manualDlOffset !== 0) {
      console.log("rigctl TS-2000 mode change", prev, "→", ctxKey, "— manualDl", Math.round(manualDlOffset), "→ 0");
      manualDlOffset = 0;
      broadcastStatus();
    }
  }

  const toVfoA = async (kind) => {
    await tsEnsureSatOff(link);
    if (link.currentVfo !== "VFOA") await setVfo(link, "VFOA");
    return kind;
  };

  if (!hasUl || !hasDl) return toVfoA("dl-only");
  let nominal = null;
  try {
    nominal = formatFreqDisplayFromMode(active);
  } catch (_) {}
  if (isSimplex(nominal, ulHz, dlHz)) {
    if (!ts.logged.simplex) {
      ts.logged.simplex = true;
      console.log("rigctl TS-2000 same-band UL/DL — SAT off, split VFOA=DL / VFOB=UL, dial locked");
    }
    return toVfoA("split-locked");
  }
  ts.logged.simplex = false;
  if (link.splitOn) await ensureSplitOff(link);
  if (!(await tsEnsureSat(link))) {
    // `w` unsupported or SA failed → Hamlib split (cross-band works on VFO A/B too)
    return ts.w === "unsupported" ? "split" : toVfoA("split");
  }

  const layoutKey = ctxKey + "|" + kw.bandOf(dlHz) + "/" + kw.bandOf(ulHz);
  if (!(await tsCheckBands(link, ulHz, dlHz, layoutKey))) return "done"; // FA/FB would nak
  const modeKey = layoutKey + ":" + mods.dl + "/" + mods.ul + (ts.swapped ? ":sw" : "");
  await tsApplyModes(link, mods, modeKey);
  await tsApplyTone(link, mods);

  const now = Date.now();
  if (now - (ts.lastPushAt || 0) < DUAL_PUSH_MIN_MS) return "done";
  ts.lastPushAt = now;

  const dlT = Math.round(dlHz);
  const ulT = Math.round(ulHz);
  // FM sats default locked (applyDefaultLock); FM DL is implied-locked anyway
  // (as in the native driver): no SSB-style dial offset on an FM downlink.
  const fmLock = locked || mods.dl === "FM";

  // Linear + unlocked: dial moved MAIN → keep the operator's offset.
  if (!fmLock && link.lastFreqHz != null && !link.justReset && now >= (ts.settleUntil || 0)) {
    const r = await tsW(link, "FA;");
    const fa = r.ok ? kw.parseFreq(r.q.FA, "A") : null;
    if (fa != null) {
      const delta = fa - link.lastFreqHz;
      if (kw.bandOf(fa) !== kw.bandOf(dlT)) {
        // MAIN is on the other band: not a dial turn — re-verify the layout.
        console.warn("rigctl TS-2000 MAIN readback", fa, "on", kw.bandOf(fa), "(want", kw.bandOf(dlT) + ") — band re-check, no absorb");
        ts.bandKey = null;
        link.lastFreqHz = null;
        link.lastSubHz = null;
        return "done";
      }
      if (Math.abs(delta) > TS_DIAL_MAX_HZ) {
        console.warn("rigctl TS-2000 MAIN readback jump", Math.round(delta), "Hz — not a dial turn, rewriting DL");
        link.lastFreqHz = null;
      } else if (Math.abs(delta) > 80) {
        manualDlOffset += delta;
        link.lastFreqHz = fa;
        console.log("rigctl TS-2000 dial absorb MAIN", Math.round(delta), "Hz → manualDl", Math.round(manualDlOffset));
        broadcastStatus();
        const u = await tsW(link, kw.freqCmd("B", ulT) + ";FB;");
        if (u.ok && !u.naks) link.lastSubHz = ulT;
        return "done";
      }
    }
  }

  const parts = [];
  // FM lock: always rewrite FA so a dial move snaps back to Doppler DL.
  const dlNeed = fmLock || link.lastFreqHz == null || Math.abs(dlT - link.lastFreqHz) >= DUAL_FREQ_THRESH_HZ;
  const ulNeed = link.lastSubHz == null || Math.abs(ulT - link.lastSubHz) >= DUAL_FREQ_THRESH_HZ;
  if (dlNeed) parts.push(kw.freqCmd("A", dlT));
  if (ulNeed) parts.push(kw.freqCmd("B", ulT));
  if (!parts.length) return "done";
  const r = await tsW(link, parts.join(";") + ";FA;FB;");
  if (!r.ok) return "done";
  if (r.naks) {
    ts.faNak++;
    link.lastFreqHz = null;
    link.lastSubHz = null;
    const fa = kw.parseFreq(r.q.FA, "A");
    const fb = kw.parseFreq(r.q.FB, "B");
    const where = "MAIN " + (fa != null ? fa : "?") + " SUB " + (fb != null ? fb : "?");
    if (ts.faNak === 1) {
      ts.faNakSince = now;
      ts.faNakWarnAt = now;
      console.warn("rigctl TS-2000 WARN FA/FB write rejected (" + parts.join(";") + ") — radio has " + where + "; re-checking bands");
      ts.bandKey = null; // a nak after a good band check = layout changed under us
    } else if (now - (ts.faNakWarnAt || 0) >= TS_NAK_REPEAT_MS) {
      ts.faNakWarnAt = now;
      console.warn(
        "rigctl TS-2000 WARN FA/FB still rejected: " + ts.faNak + " naks in " + Math.round((now - ts.faNakSince) / 1000) + " s — " + where,
      );
      toneError = "Radio rejects FA/FB (" + where + ") — check MAIN=" + kw.bandOf(dlT) + " SUB=" + kw.bandOf(ulT) + " / TF-SET";
      broadcastStatus();
    }
    return "done";
  }
  if (ts.faNak) {
    console.log("rigctl TS-2000 FA/FB accepted again after", ts.faNak, "naks");
    if (/^Radio rejects FA\/FB/.test(toneError || "")) {
      toneError = null;
      broadcastStatus();
    }
  }
  ts.faNak = 0;
  if (dlNeed) link.lastFreqHz = dlT;
  if (ulNeed) link.lastSubHz = ulT;
  link.justReset = false;
  link.setCount = (link.setCount || 0) + 1;
  if (link.setCount <= 5 || link.setCount % 20 === 0)
    console.log("rigctl TS-2000 Doppler MAIN/DL", (dlT / 1e6).toFixed(6), "SUB/UL", (ulT / 1e6).toFixed(6));
  return "done";
}

/** Disconnect: restore the SA found at engage, TS0 if TF-SET was pressed. */
async function tsRestore(link) {
  const ts = link.ts;
  if (!ts || ts.w !== "ok") return;
  try {
    if (ts.swapped) await tsW(link, "TS0;SA;");
    if (ts.saOriginal != null || ts.satOn) {
      const orig = ts.saOriginal || kw.SA_OFF;
      const target = orig[0] === "1" ? orig : kw.SA_OFF;
      const r = await tsW(link, "SA" + target.replace(/^SA/, "") + ";SA;");
      const rb = r.ok ? kw.parseSa(r.q.SA) : null;
      console.log("rigctl TS-2000 restore SA" + target.replace(/^SA/, ""), "→", rb ? "SA" + rb.raw : "none");
    }
  } catch (_) {}
  ts.satOn = false;
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
        await applyTone(ul, mods.ul);
        await setFreq(ul, ulHz);
      }
    }
    return;
  }

  // ── Kenwood TS-2000 (Hamlib 2014): raw `w` SAT / simplex split / DL-only ──
  let forceLock = false;
  if (dl.connected && isTs2000()) {
    const r = await pushTs2000(ulHz, dlHz, active, mods);
    if (r === "done") return;
    if (r === "split-locked") forceLock = true;
    // "split" / "split-locked" / "dl-only" → generic single-VFO path below (SAT off)
  } else if (dl.connected && dl.ts) {
    dl.ts = null;
  }

  // ── Single endpoint + both UL/DL + sat-capable backend → dual-VFO SAT ──
  // Always write Main (DL) + Sub (UL). Dial absorb needs native CI-V (0x03), not Hamlib.
  if (hasUl && hasDl && dl.connected && !isTs2000() && (await canUseDualSat(dl))) {
    dl.dualSat = true;
    if (dl.satModeOn !== true) {
      await ensureSatModeOn(dl);
    }

    const now = Date.now();
    const dlT = Math.round(dlHz);
    const ulT = Math.round(ulHz);

    // ── One full handshake per TCP connection (or mode change) ──
    const needMode =
      dl.lastMode !== mods.dl || dl.lastSubMode !== mods.ul;
    if (!dl.dualSynced || needMode) {
      if (!(await setVfo(dl, "Main"))) return;
      await setMode(dl, mods.dl, "main");
      await setFreqSideDual(dl, dlT, "main");
      if (!(await setVfo(dl, "Sub"))) return;
      await setMode(dl, mods.ul, "sub");
      await setFreqSideDual(dl, ulT, "sub");
      dl.lastToneKey = null;
      await applyTone(dl, mods.ul, { where: "sub" });
      dl.dualSynced = true;
      dl.lastPushAt = now;
      console.log(
        "rigctl dual-SAT Main/DL",
        (dlT / 1e6).toFixed(6),
        "Sub/UL",
        (ulT / 1e6).toFixed(6),
        "MHz",
      );
      return;
    }

    // ── Rate limit steady updates ──
    if (now - (dl.lastPushAt || 0) < DUAL_PUSH_MIN_MS) return;
    dl.lastPushAt = now;

    const thresh = DUAL_FREQ_THRESH_HZ;
    const dlMoved =
      dl.lastFreqHz == null || Math.abs(dlT - dl.lastFreqHz) >= thresh;
    const ulMoved =
      dl.lastSubHz == null || Math.abs(ulT - dl.lastSubHz) >= thresh;

    // Unlocked: try to read Main before overwriting (dial absorb).
    // Hamlib f uses 0x25 — often fails in SAT; if so we still Doppler both.
    let skipMainWrite = false;
    if (!locked && dl.lastFreqHz != null && !dl.justReset) {
      await setVfo(dl, "Main");
      const reported = await readFreq(dl, { allowSat: true });
      if (reported != null) {
        const delta = reported - dl.lastFreqHz;
        // Real dial move (not 1–2 Hz Doppler noise)
        if (Math.abs(delta) > 80 && Math.abs(delta) < 50000) {
          manualDlOffset += delta;
          dl.lastFreqHz = reported;
          console.log(
            "rigctl dial absorb Main",
            Math.round(delta),
            "Hz → manualDl",
            Math.round(manualDlOffset),
            "Hz",
          );
          broadcastStatus();
          skipMainWrite = true; // leave Main where operator put it this tick
          // Still push UL (inverse handled next tick via updated offset in state)
          writeCmd(dl, "V Sub");
          writeCmd(dl, "F " + ulT);
          dl.lastSubHz = ulT;
          return;
        }
      }
    }

    if (!dlMoved && !ulMoved && !skipMainWrite) return;

    // Doppler both VFOs (fire-and-forget)
    if (!skipMainWrite) {
      writeCmd(dl, "V Main");
      writeCmd(dl, "F " + dlT);
      dl.lastFreqHz = dlT;
    }
    writeCmd(dl, "V Sub");
    writeCmd(dl, "F " + ulT);
    dl.lastSubHz = ulT;
    dl.setCount = (dl.setCount || 0) + 1;
    if (dl.setCount <= 5 || dl.setCount % 8 === 0) {
      console.log(
        "rigctl Doppler Main",
        (dlT / 1e6).toFixed(6),
        "Sub",
        (ulT / 1e6).toFixed(6),
      );
    }
    return;
  }

  // ── Single endpoint, single VFO (IC-705, SDR++, or no SATMODE) ──
  // TX_SPLIT + UL present: DL on VFO A (F/M) + UL via split (I/X), no V switch.
  // Otherwise legacy DL-only (SDR++ / TX_SPLIT off).
  if (dl.connected) {
    if (dl.dualSat) {
      dl.dualSat = false;
    }
    const hz = hasDl ? dlHz : hasUl ? ulHz : null;
    const mode = hasDl ? mods.dl : mods.ul;
    if (hz == null) return;

    const useSplit =
      txSplitEnabled() && hasUl && hasDl && !dl.splitFailed;
    if (useSplit) {
      await ensureSplitOn(dl);
    }

    await setMode(dl, mode, "main");
    // Dial absorb + settle hold (mirrors ic9700 dial-settle): when VFO A
    // readback moves off our last write, absorb into manualDlOffset and HOLD
    // DL writes until two consecutive reads are stable. A fire-and-forget F
    // landing mid-spin (or computed by state.js from the pre-absorb offset)
    // would otherwise yank the dial back.
    let holdDl = false;
    const near = (a, b) => a != null && b != null && Math.abs(a - b) <= 80;
    const absorbTo = (reported) => {
      const delta = reported - dl.lastFreqHz;
      if (dl.absorbBaseOffset == null) {
        // First absorb of a spin: dlHz was built from the current offset, so
        // re-derive exactly (includes this tick's Doppler step).
        dl.absorbBaseOffset = manualDlOffset;
        if (hasDl) {
          const dopplerOnly = dlHz - manualDlOffset - dlFineOffset;
          manualDlOffset = reported - dopplerOnly - dlFineOffset;
        }
      } else if (hasDl) {
        // Mid-spin: caller's dlHz may be stale; add the incremental move.
        manualDlOffset += delta;
      }
      console.log(
        "rigctl dial absorb DL",
        Math.round(delta),
        "Hz → manualDl",
        Math.round(manualDlOffset),
      );
      dl.lastFreqHz = reported;
      dl.recentFreqs = [reported];
      dl.logNextDlWrite = true;
      broadcastStatus();
    };
    if (!locked && !forceLock && !dl.dualSat && dl.lastFreqHz != null && !dl.justReset) {
      const reported = await readFreq(dl);
      if (dl.dialHold) {
        if (reported == null) {
          holdDl = true;
        } else if (near(reported, dl.dialHold.lastHz)) {
          // Stable across two reads → settled; release and write below.
          console.log("rigctl dial settled DL", (reported / 1e6).toFixed(6), "MHz");
          dl.dialHold = null;
        } else {
          absorbTo(reported);
          dl.dialHold = { lastHz: reported };
          holdDl = true;
        }
      } else {
        // Ignore readbacks that are our own (lagged) DL writes, or VFO B (UL split).
        const ownWrite =
          reported != null &&
          ((dl.recentFreqs || []).some((f) => near(f, reported)) ||
            near(dl.lastSubHz, reported));
        if (reported != null && !ownWrite && Math.abs(reported - dl.lastFreqHz) > 80) {
          absorbTo(reported);
          dl.dialHold = { lastHz: reported };
          holdDl = true;
        }
      }
    }
    if (holdDl) {
      // Skip DL write while the dial is moving; still push UL if split.
      if (!(useSplit && dl.splitOn)) return;
    } else {
      let target = hz;
      if (hasDl && dl.absorbBaseOffset != null && dl.lastFreqHz != null) {
        // state.js may have computed dlHz from the pre-absorb manualDlOffset
        // (tick queued before the absorb). Re-base it onto the new offset.
        const d = manualDlOffset - dl.absorbBaseOffset;
        if (Math.abs(target + d - dl.lastFreqHz) < Math.abs(target - dl.lastFreqHz)) {
          target += d;
        } else {
          dl.absorbBaseOffset = null; // caller caught up
        }
      }
      if (dl.logNextDlWrite) {
        dl.logNextDlWrite = false;
        console.log("rigctl dl write after absorb", (target / 1e6).toFixed(6), "MHz");
      }
      await setFreq(dl, target);
    }

    if (useSplit && dl.splitOn) {
      await setSplitMode(dl, mods.ul);
      await setSplitFreq(dl, ulHz);
      await applyTone(dl, mods.ul, { where: "split" });
    } else {
      await applyTone(dl, mode);
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
    dl.lastSubHz = null; // force UL split rewrite
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
  dl.dialHold = null;
  dl.absorbBaseOffset = null;
  ul.lastFreqHz = null;
  dl.lastSubHz = null; // force UL split rewrite on next push
  broadcastStatus();
}

function resetOffsets() {
  manualDlOffset = 0;
  ulFineOffset = 0;
  dlFineOffset = 0;
  dl.lastFreqHz = null;
  dl.dialHold = null;
  dl.absorbBaseOffset = null;
  ul.lastFreqHz = null;
  dl.lastSubHz = null;
  dl.lastSubMode = null;
  // Keep dualSynced / satModeOn / modes — avoids full SAT re-handshake + disconnect churn
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
    lastCmdUl: ul.lastFreqHz || dl.lastSubHz || dl.lastFreqHz,
    step: digitStep,
    ctcssMode,
    ctcssAccessHz,
    ctcssActivationHz,
    cwMode,
    supportsCwMode: true,
    toneVerified,
    toneError,
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
  setCwMode,
  applyDefaultCtcss,
  getRadioState,
  broadcastStatus,
  applyEndpointChange,
  isTs2000,
};
