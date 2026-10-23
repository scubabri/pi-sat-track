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
const { isUsbBothMode } = require("../catalog");
const { createApiClient } = require("./flex-api");

function makeLink(name) {
  return {
    name,
    socket: null,
    connected: false,
    connecting: false,
    busy: false,
    buf: "",
    // lastCommandedHz: last FA we enqueued/wrote.
    // lastFreqHz: last radio-confirmed (verify / absorb / poll).
    // Write-only Doppler must not set lastFreqHz or absorb treats CAT lag as dial.
    lastCommandedHz: null,
    lastFreqHz: null,
    lastMode: null,
    reconnectTimer: null,
    wanted: false,
  };
}

const ul = makeLink("ul");
const dl = makeLink("dl");
const api = createApiClient();
api.onProfilesChanged(() => {
  broadcastStatus();
});

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
/**
 * Largest single DL dial move absorbed immediately. A bigger jump may be a
 * fast knob spin OR a spurious stale readback (radio briefly reports an old
 * freq). Such jumps are held as "pending" and only absorbed if the next
 * report(s) confirm the new frequency within DIAL_CONFIRM_WINDOW_MS; if the
 * radio returns near the commanded freq (or nothing confirms) it's discarded.
 * While pending we do NOT re-command DL (that fights the operator).
 */
const DIAL_ABSORB_MAX_STEP_HZ = 5000;
const DIAL_CONFIRM_WINDOW_MS = 1500;
/** Confirm tolerance vs pending freq (Doppler drift + slow tuning). */
const DIAL_CONFIRM_TOL_HZ = 400;
/** Extra travel allowed when continuing to tune in the same direction. */
const DIAL_CONFIRM_SAME_DIR_HZ = 20000;
const SKIPPED_STALE = "__skipped_stale__";

/** Offsets the tracker used to compute a push target. */
/** Bumped on every uplink dial absorb: pushes computed before it are stale. */
let ulDialSeq = 0;
function offsetsSnap() {
  return manualDlOffset + "|" + dlFineOffset + "|" + ulFineOffset + "|" + ulDialSeq;
}

// Pending large-jump candidate (per link): { freq, cmd, at }
const pendingJump = { ul: null, dl: null };

function pendingActive(link) {
  const p = pendingJump[link.name];
  if (!p) return false;
  if (Date.now() - p.at > DIAL_CONFIRM_WINDOW_MS) {
    discardPending(link, "no confirm in " + DIAL_CONFIRM_WINDOW_MS + " ms");
    return false;
  }
  return true;
}

function discardPending(link, why) {
  const p = pendingJump[link.name];
  if (!p) return;
  pendingJump[link.name] = null;
  console.log(
    "Flex dial jump discarded (did not persist)",
    link.name.toUpperCase(),
    Math.round(p.freq - p.cmd),
    "Hz —",
    why,
  );
  // Re-command only if the radio is actually off the tracked freq: the next
  // report (or this one) tells us; forcing a rewrite is cheap and safe here
  // because no candidate is outstanding anymore.
  link.lastCommandedHz = null;
}

/**
 * Evaluate a report that is > DIAL_ABSORB_MAX_STEP_HZ from commanded.
 * Returns "pending" (hold, don't absorb, don't re-command) or "confirmed"
 * (caller absorbs normally).
 */
function checkLargeJump(link, where, reported, cmd) {
  const now = Date.now();
  const p = pendingJump[link.name];
  if (p && now - p.at <= DIAL_CONFIRM_WINDOW_MS) {
    const d = reported - p.freq;
    const dir = Math.sign(p.freq - p.cmd);
    const ok =
      Math.abs(d) <= DIAL_CONFIRM_TOL_HZ ||
      (Math.sign(d) === dir && Math.abs(d) <= DIAL_CONFIRM_SAME_DIR_HZ);
    if (ok) {
      pendingJump[link.name] = null;
      console.log(
        "Flex dial jump confirmed (" + where + ")",
        link.name.toUpperCase(),
        Math.round(reported - cmd),
        "Hz → manualDl",
      );
      return "confirmed";
    }
    // Different big jump: restart candidate with this report
  } else if (p) {
    discardPending(link, "no confirm in " + DIAL_CONFIRM_WINDOW_MS + " ms");
  }
  pendingJump[link.name] = { freq: reported, cmd, at: now };
  console.log(
    "Flex dial jump pending (" + where + ")",
    link.name.toUpperCase(),
    Math.round(reported - cmd),
    "Hz",
  );
  return "pending";
}


let ctcssMode = "off";
let ctcssAccessHz = null;
let ctcssActivationHz = null;
let lastCtcssApplied = null;
/** Last SmartSDR global profile name loaded on this API connection (dedupe). */
let lastProfileLoaded = null;
/** API host:port lastProfileLoaded was loaded through (same radio = still loaded). */
let lastProfileApiKey = null;
/** Serialize profile loads so concurrent pushes don't double-fire. */
let profileLoadInflight = null;
/** Names we already logged a one-line skip for (no API host / connect fail). */
let profileSkipLogged = new Set();
/**
 * Per-sat remembered SmartSDR global profile ("" = no change / do not load).
 * Restored from sat-offsets; user dropdown updates it.
 */
let selectedFlexProfile = "";

// Force mode/freq until verified after enable or reconnect
const MODE_RETRIES = 3;
const FREQ_RETRIES = 3;
const SYNC_WINDOW_MS = 12000;
const SYNC_OK_STREAK = 2;
let syncNeeded = false;
let syncStartedAt = 0;
let syncOkStreak = 0;
let pushInFlight = false;
let pendingPush = null;

let getCtx = () => ({
  satrec: null,
  observer: null,
  currentSatKey: null,
  currentModeIndex: 0,
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * May this driver open connections? Set by the radio registry: true only
 * when Flex is the radio selected by the active profile (and profiles have
 * been applied). Standalone use (tests) defaults to allowed.
 */
let isActive = () => true;

function init(opts) {
  if (opts && opts.broadcast) broadcastFn = opts.broadcast;
  if (opts && opts.getContext) getCtx = opts.getContext;
  if (opts && typeof opts.isActive === "function") isActive = opts.isActive;
  if (opts && typeof opts.onUlDial === "function") onUlDial = opts.onUlDial;
  // No connection here: the registry calls activate() once the active
  // profile is applied and Flex is actually the selected radio.
}

/** Flex became the selected radio — fetch profile list (radio may be off). */
function activate() {
  ensureApiConnection().catch(() => {});
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
    dataMode,
    supportsDataMode: true,
    cwMode,
    supportsCwMode: true,
    connected: anyConnected(),
    ulConnected: ul.connected,
    dlConnected: dl.connected,
    ulWanted: ul.wanted,
    dlWanted: dl.wanted,
    connecting: ul.connecting || dl.connecting,
    apiConnected: api.isConnected(),
    apiHost: apiHost(),
    apiPort: apiPort(),
    supportsFlexProfiles: true,
    flexProfiles: api.getGlobalProfiles(),
    flexProfile: selectedFlexProfile,
    flexProfileCurrent: api.getCurrentGlobalProfile(),
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
    lastCmdDl: dl.lastCommandedHz,
    lastCmdUl: ul.lastCommandedHz,
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

/**
 * Data mode (default OFF). ON maps via SmartSDR CAT ZZMD:
 * USB→DIGU (07), LSB→DIGL (09), FM→DFM (12). OFF uses plain MD1/2/4.
 */
let dataMode = false;
const DATA_ZZMD = { "2": "07", "1": "09", "4": "12" };
const DATA_NAME = { "2": "DIGU", "1": "DIGL", "4": "DFM" };

function setDataMode(on) {
  const next = !!on;
  if (next === dataMode) return;
  dataMode = next;
  if (dataMode) cwMode = false;
  // Resend mode once on both links (cache key changes → one write, no loop)
  ul.lastMode = null;
  dl.lastMode = null;
  console.log("Flex data", dataMode ? "ON (DIGU/DIGL/DFM)" : "OFF (USB/LSB/FM)");
  broadcastStatus();
}

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
  if (next === cwMode && !(next && dataMode)) return;
  cwMode = next;
  if (cwMode) dataMode = false;
  ul.lastMode = null;
  dl.lastMode = null;
  console.log("Flex CW", cwMode ? "ON (UL CW / DL CW, MD3)" : "OFF");
  broadcastStatus();
}

/** Linear LSB/USB → CW (MD3) on both links. SmartSDR has a single CW mode. */
function applyCwToMods(mods) {
  if (!cwMode || !/^[12]$/.test(mods.ul) || !/^[12]$/.test(mods.dl)) return mods;
  return { ul: "3", dl: "3", ulName: "CW", dlName: "CW" };
}

function applyDataToMods(mods) {
  if (!dataMode) return mods;
  const out = { ...mods };
  for (const side of ["ul", "dl"]) {
    const c = mods[side];
    if (DATA_ZZMD[c]) {
      out[side] = "ZZ" + DATA_ZZMD[c];
      out[side + "Name"] = DATA_NAME[c];
    }
  }
  return out;
}

function modeSetCmd(code) {
  return code.startsWith("ZZ") ? "ZZMD" + code.slice(2) + ";" : "MD" + code + ";";
}

function modesForCatalogMode(modeStr) {
  if (isUsbBothMode(modeStr)) return { ul: "2", dl: "2", ulName: "USB", dlName: "USB" }; // EME (Moon)
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


/**
 * Serialize CAT traffic per link. Doppler ticks every 250ms were
 * hitting single-flight busy → "Flex ul/dl busy" / null verify spam.
 */
function enqueue(link, fn) {
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

function sendCmd(link, cmd, expectReply, guard) {
  return enqueue(link, () =>
    new Promise((resolve, reject) => {
      // Guard is evaluated when the command reaches the head of the CAT queue:
      // a frequency computed before a dial absorb must not overwrite the knob.
      if (typeof guard === "function" && !guard()) {
        resolve(SKIPPED_STALE);
        return;
      }
      if (!link.socket || !link.connected) {
        reject(new Error("Flex " + link.name + " not connected"));
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
    }),
  );
}

async function readLinkMode(link, zz) {
  if (!link.connected) return null;
  try {
    if (zz) {
      const r = await sendCmd(link, "ZZMD;", true);
      const m = String(r || "").match(/ZZMD(\d\d)/i);
      return m ? "ZZ" + m[1] : null;
    }
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
  // Radio off: never open sockets (in-flight push / poll / timers after close)
  if (!radioOn) return Promise.resolve(false);
  if (link.socket && link.connected) return Promise.resolve(true);
  if (link.connecting) return Promise.resolve(false);
  link.connecting = true;
  broadcastStatus();
  return new Promise((resolve) => {
    const { host, port } = linkHostPort(link);
    link.epKey = host + ":" + port;
    console.log("Flex", link.name.toUpperCase(), "connecting", host + ":" + port);
    const s = new net.Socket();
    // closeLink() while this connect is pending (profile apply / UL-DL radio
    // swap: endpoint re-apply, then radio off / on) supersedes it; it must not
    // connect later next to the fresh socket (stray link) or clear its state.
    const gen = (link.gen = (link.gen || 0) + 1);
    link.pendingSock = s;
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      if (link.pendingSock === s) link.pendingSock = null;
      if (link.gen !== gen) {
        try { s.removeAllListeners(); s.destroy(); } catch (_) {}
        resolve(false);
        return;
      }
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
      if (link.gen !== gen) {
        done(false); // superseded: dropped, link untouched
        return;
      }
      if (!radioOn) {
        console.log("Flex", link.name.toUpperCase(), "connected after Radio off — closing");
        try { s.removeAllListeners(); s.destroy(); } catch (_) {}
        link.connecting = false;
        if (!settled) { settled = true; resolve(false); }
        return;
      }
      link.socket = s;
      link.connected = true;
      link.buf = "";
      link.lastMode = null;
      link._catQueue = [];
      link._catChain = null;
      link._catChainRunning = false;
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
      if (link.gen !== gen) return; // superseded socket: not this link's any more
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
  link.gen = (link.gen || 0) + 1; // a pending connect is superseded
  if (link.pendingSock) {
    try {
      link.pendingSock.removeAllListeners();
      link.pendingSock.on("error", () => {});
      link.pendingSock.destroy();
    } catch (_) {}
    link.pendingSock = null;
  }
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
  link.lastCommandedHz = null;
  link.lastFreqHz = null;
  link.lastMode = null;
  link._catQueue = [];
  link._catChain = null;
  link._catChainRunning = false;
}

function close() {
  radioOn = false;
  syncNeeded = false;
  pendingPush = null;
  pushInFlight = false;
  stopVfoPoll();
  closeLink(ul);
  closeLink(dl);
  api.close();
  lastCtcssApplied = null;
  lastProfileLoaded = null;
  profileSkipLogged = new Set();
  broadcastStatus();
  console.log("Flex disconnected");
}

/**
 * Connect Flex API (port 4992) when host is configured — for profile list
 * and CTCSS. Safe to call with radio off; only profile LOAD requires radioOn.
 */
async function ensureApiConnection() {
  if (!isActive()) {
    // Not the profile's radio — never probe the Flex API.
    if (api.isConnected()) api.close();
    return false;
  }
  const h = apiHost();
  if (!h) {
    console.log(
      "Flex API: skip — no API host configured (set Radio API host in config)",
    );
    return false;
  }
  if (api.isConnected()) return true;
  const ok = await api.connect(h, apiPort());
  if (ok) broadcastStatus();
  return ok;
}

function setRadio(on, source) {
  console.log("Flex setRadio(" + on + ") from " + (source || "internal"));
  if (on) {
    radioOn = true;
    pendingPush = null;
    // Keep manual/fine offsets: they were restored per-sat (setOffsets) on
    // sat load and must survive engage. Only center/resetOffsets clear them.
    pendingJump.ul = null;
    pendingJump.dl = null;
    lastCtcssApplied = null;
    markSyncNeeded("setRadio");
    syncTonesFromCatalog();
    // API for profile list + CTCSS; connect even if we already did for list
    ensureApiConnection()
      .then((ok) => {
        if (!ok) return;
        return ensureFlexProfile().then(() => applyCtcssToRadio(true));
      })
      .catch(() => {});
    broadcastStatus();
  } else {
    // Radio off: drop CAT links but KEEP API so profile dropdown stays live
    radioOn = false;
    syncNeeded = false;
    pendingPush = null;
    pushInFlight = false;
    stopVfoPoll();
    closeLink(ul);
    closeLink(dl);
    lastCtcssApplied = null;
    lastProfileLoaded = null;
    broadcastStatus();
    if (isActive()) {
      console.log("Flex radio off (API kept for profile list)");
      // Still ensure API is up for the list if host is set
      ensureApiConnection().catch(() => {});
    } else {
      // Flex is no longer the profile's radio: drop the API link too.
      api.close();
      console.log("Flex radio off (not selected — API closed)");
    }
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
  lastProfileLoaded = null;
  profileSkipLogged = new Set();
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
  // CTCSS hardware writes only while radio is on. Never close the Flex API
  // here — the profile dropdown needs it while radio is off.
  if (radioOn) {
    applyCtcssToRadio(true).catch(() => {});
  }
  broadcastStatus();
}

async function applyCtcssToRadio(force) {
  // CTCSS is FM-only and requires radio on. Do NOT close the API when radio
  // is off — profile list stays available for the dropdown.
  if (!radioOn) return;
  // Profile load before any slice tone writes (global profiles reset slices).
  await ensureFlexProfile();
  if (!radioOn) return;
  if (!currentModeIsFm()) {
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

  if (!isActive()) return;
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

async function setLinkFrequency(link, freqHz, force, snap) {
  if (!Number.isFinite(freqHz) || freqHz < 1e5 || freqHz > 6e8) return false;
  if (!link.connected) return false;
  const target = Math.round(freqHz);
  // Skip rewrite when we already commanded this freq (not lastFreqHz —
  // write-only must not pretend the radio already moved).
  if (
    !force &&
    !syncNeeded &&
    link.lastCommandedHz != null &&
    Math.abs(target - link.lastCommandedHz) < 1
  ) {
    return true;
  }

  // Doppler path: write only (enqueue serializes). Verify only while syncing.
  // Model: lastCommandedHz on write; lastFreqHz only on verify/absorb/poll.
  if (!force && !syncNeeded) {
    try {
      const guard =
        snap != null ? () => snap === offsetsSnap() : undefined;
      const r = await sendCmd(link, freqToFa(target), false, guard);
      if (r === SKIPPED_STALE) return true; // offsets changed; next tick recomputes
      link.lastCommandedHz = target;
      return true;
    } catch (e) {
      console.warn("Flex", link.name, "set freq failed:", e.message);
      return false;
    }
  }

  for (let attempt = 1; attempt <= FREQ_RETRIES; attempt++) {
    try {
      await sendCmd(link, freqToFa(target), false);
      link.lastCommandedHz = target;
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
  // Commanded but unverified — do not mark lastFreqHz or absorb will see lag as dial.
  link.lastCommandedHz = target;
  return false;
}

async function setLinkMode(link, mdCode, mdName, force) {
  if (!link.connected) return false;
  if (!force && !syncNeeded && link.lastMode === mdCode) return true;

  if (!force && !syncNeeded) {
    try {
      await sendCmd(link, modeSetCmd(mdCode), false);
      link.lastMode = mdCode;
      console.log("Flex", link.name.toUpperCase(), "mode →", mdName);
      return true;
    } catch (e) {
      console.warn("Flex", link.name, "set mode failed:", e.message);
      return false;
    }
  }

  for (let attempt = 1; attempt <= MODE_RETRIES; attempt++) {
    try {
      await sendCmd(link, modeSetCmd(mdCode), false);
      await sleep(80);
      const got = await readLinkMode(link, mdCode.startsWith("ZZ"));
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
  const mods = applyDataToMods(applyCwToMods(modesForCatalogMode(active && active.mode)));
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

async function pushSide(link, freqHz, force, snap) {
  const hasFreq = freqHz != null && Number.isFinite(freqHz);
  if (!hasFreq) {
    if (link.wanted || link.connected || link.connecting) {
      closeLink(link);
      broadcastStatus();
    }
    return true;
  }
  if (!radioOn) return false;
  link.wanted = true;
  if (!link.connected) {
    const ok = await openLink(link);
    if (!ok) return false;
  }
  return setLinkFrequency(link, freqHz, force, snap);
}

async function pushFrequencies(ulHz, dlHz, snapIn) {
  if (!radioOn) return;
  // state.js computes ulHz/dlHz synchronously from getRadioState() right
  // before calling us, so the current offsets are the ones baked in.
  const snap = snapIn != null ? snapIn : offsetsSnap();
  // Coalesce: Doppler is 250ms; sync verify can take seconds — keep latest only.
  if (pushInFlight) {
    pendingPush = { ulHz, dlHz, snap };
    return;
  }
  pushInFlight = true;
  try {
    await runPush(ulHz, dlHz, snap);
  } finally {
    pushInFlight = false;
    if (pendingPush && radioOn) {
      const next = pendingPush;
      pendingPush = null;
      await pushFrequencies(next.ulHz, next.dlHz, next.snap);
    }
  }
}

/**
 * Doppler-only DL (no manual / fine) from the most recent state tick.
 * Single baseline for every absorb, push or poll, so
 *   manualDlOffset = dialFreq - lastDopplerDl - dlFineOffset
 * no matter which path saw the knob move.
 */
let lastDopplerDl = null;

/** Registry callback: uplink dial moved (see lib/radios/index.js). */
let onUlDial = () => false;

/**
 * Flex on uplink only (two radios, the other one on downlink): the operator
 * turning the TX slice's knob moves the passband. Without this the next
 * Doppler write put the slice straight back (no UL dial handling existed;
 * only the DL slice was watched). Returns true when absorbed.
 */
function handleUlReport(reported) {
  if (locked || syncNeeded) return false;
  if (reported == null || !Number.isFinite(reported)) return false;
  const cmd = ul.lastCommandedHz;
  if (cmd == null || cmd <= 0) return false;
  const delta = reported - cmd;
  if (Math.abs(delta) <= VFO_THRESH_HZ) {
    ul.lastFreqHz = reported;
    return false;
  }
  // > 100 kHz: band change / profile load, not a knob turn.
  if (Math.abs(delta) > 100000) return false;
  // Lag corridor: an older write still being reported.
  if (ul.lastFreqHz != null && Math.abs(cmd - ul.lastFreqHz) > VFO_THRESH_HZ) {
    const lo = Math.min(ul.lastFreqHz, cmd) - VFO_THRESH_HZ;
    const hi = Math.max(ul.lastFreqHz, cmd) + VFO_THRESH_HZ;
    if (reported >= lo && reported <= hi) return false;
  }
  console.log("Flex dial absorb UL", Math.round(delta), "Hz vs cmd → passband");
  ulDialSeq += 1;
  onUlDial(delta, "flex");
  // The handler re-applies offsets (which clears the baseline): the slice is
  // where the operator put it.
  ul.lastCommandedHz = reported;
  ul.lastFreqHz = reported;
  broadcastStatus();
  return true;
}

/**
 * Unified DL dial handler for both push (pre-write FA read) and poll reports.
 * Returns "none" | "hold" (large jump pending) | "absorbed".
 *
 * Compare against lastCommandedHz (what we wrote), read AFTER the FA reply
 * so a concurrent absorb's updated baseline is used. On absorb the baseline
 * (lastCommandedHz / lastFreqHz) is moved to the dial position atomically,
 * so later reports at the same position read ~0 delta and never re-absorb.
 */
function handleDlReport(reported, where) {
  if (locked || syncNeeded) return "none";
  if (reported == null || !Number.isFinite(reported)) return "none";
  const cmd = dl.lastCommandedHz;
  if (cmd == null || cmd <= 0) return "none";
  const vsCmd = reported - cmd;
  if (Math.abs(vsCmd) <= VFO_THRESH_HZ) {
    dl.lastFreqHz = reported;
    if (pendingJump.dl) discardPending(dl, "report back near commanded");
    return "none";
  }
  if (Math.abs(vsCmd) > DIAL_ABSORB_MAX_STEP_HZ) {
    if (checkLargeJump(dl, where, reported, cmd) === "pending") return "hold";
  } else {
    if (pendingJump.dl) discardPending(dl, "report back near commanded");
    // No confirmed baseline yet: never invent dial from CAT lag
    if (dl.lastFreqHz == null || dl.lastFreqHz <= 0) return "none";
    // Lag corridor: reported between last confirmed and commanded
    if (Math.abs(cmd - dl.lastFreqHz) > VFO_THRESH_HZ) {
      const lo = Math.min(dl.lastFreqHz, cmd) - VFO_THRESH_HZ;
      const hi = Math.max(dl.lastFreqHz, cmd) + VFO_THRESH_HZ;
      if (reported >= lo && reported <= hi) return "none";
    }
  }
  if (lastDopplerDl == null) return "none";
  const next = reported - lastDopplerDl - dlFineOffset;
  if (Math.abs(next) > 100000) return "none";
  manualDlOffset = next;
  dl.lastCommandedHz = reported;
  dl.lastFreqHz = reported;
  console.log(
    "Flex dial absorb DL (" + where + ")",
    Math.round(vsCmd),
    "Hz vs cmd → manualDl",
    Math.round(manualDlOffset),
    "Hz",
  );
  broadcastStatus();
  return "absorbed";
}

/**
 * Auto-load the remembered SmartSDR global profile (per-sat) if non-blank.
 * Runs once per connection per profile name, BEFORE CAT freq/mode/tone writes,
 * because loading a global profile resets slices.
 */
async function ensureFlexProfile() {
  if (!radioOn) return;
  const name = String(selectedFlexProfile || "").trim();
  if (!name) return;

  if (lastProfileLoaded === name) return;
  if (profileLoadInflight) {
    await profileLoadInflight;
    if (lastProfileLoaded === name) return;
  }

  const h = apiHost();
  if (!h) {
    if (!profileSkipLogged.has(name)) {
      profileSkipLogged.add(name);
      console.log(
        'Flex profile: skip "' + name + '" — no API host configured',
      );
    }
    return;
  }

  let settle;
  const doLoad = new Promise((resolve) => {
    settle = resolve;
  });
  profileLoadInflight = doLoad;
  try {
    if (!isActive()) return;
    if (!api.isConnected()) {
      const ok = await api.connect(h, apiPort());
      if (!ok) {
        const key = "connect:" + name;
        if (!profileSkipLogged.has(key)) {
          profileSkipLogged.add(key);
          console.warn(
            "Flex profile: cannot reach API",
            h + ":" + apiPort(),
            "— skip load",
          );
        }
        return;
      }
      await sleep(400);
    }
    if (lastProfileLoaded === name) return;
    console.log('Flex profile: loading "' + name + '"');
    const ok = await api.loadGlobalProfile(name);
    if (ok) {
      lastProfileLoaded = name;
      lastProfileApiKey = h + ":" + apiPort();
      lastCtcssApplied = null; // slices reset — re-apply tone after
      markSyncNeeded("profile load");
      ul.lastMode = null;
      dl.lastMode = null;
      ul.lastCommandedHz = null;
      dl.lastCommandedHz = null;
      ul.lastFreqHz = null;
      dl.lastFreqHz = null;
    }
  } finally {
    profileLoadInflight = null;
    settle();
  }
}

/**
 * Set the selected SmartSDR global profile for the current sat.
 * Blank / falsy = "(no change)" — do not auto-load.
 * When radio is on and name is non-blank, load immediately (with resync).
 */
function setFlexProfile(name) {
  const next = name == null ? "" : String(name).trim();
  if (next === selectedFlexProfile) {
    // Still force a load if radio is on and we have not loaded this name yet
    if (radioOn && next && lastProfileLoaded !== next) {
      ensureFlexProfile().catch(() => {});
    }
    broadcastStatus();
    return;
  }
  selectedFlexProfile = next;
  if (!next) {
    // "(no change)" — do not unload; just stop auto-loading a name
    console.log("Flex profile: selection cleared (no change)");
    broadcastStatus();
    return;
  }
  // Different name → allow re-load even if previously loaded another
  if (lastProfileLoaded !== next) {
    // keep lastProfileLoaded until successful load of the new one
  }
  console.log('Flex profile: selected "' + next + '"');
  if (radioOn) {
    ensureFlexProfile().catch(() => {});
  } else {
    console.log(
      'Flex profile: "' + next + '" saved — will load when Radio is enabled',
    );
    ensureApiConnection().catch(() => {});
  }
  broadcastStatus();
}

async function runPush(ulHz, dlHz, snap) {
  if (!radioOn) return;
  // Profile load first — global profiles reset slices, so CAT/mode/tone
  // must apply after the new profile is active.
  await ensureFlexProfile();
  if (!radioOn) return;
  const force = syncNeeded;
  // Stale target: offsets changed (poll absorb / fine step / restore) after
  // this tick was computed. Writing it would snap the dial back — drop it.
  if (!force && snap != null && snap !== offsetsSnap()) return;
  const dlTarget = dlHz;
  if (dlHz != null && Number.isFinite(dlHz)) {
    lastDopplerDl = dlHz - manualDlOffset - dlFineOffset;
  }
  if (!force && dlHz == null && ulHz != null && !locked && ul.connected && ul.wanted && ul.lastCommandedHz != null) {
    // Uplink-only role: watch the TX slice's dial before writing over it.
    if (handleUlReport(await readLinkFreq(ul))) return;
    if (snap != null && snap !== offsetsSnap()) return;
  }
  if (!force) {
    const before = offsetsSnap();
    let res = "none";
    if (
      !locked && dl.connected && dl.wanted &&
      dl.lastCommandedHz != null && dlHz != null
    ) {
      res = handleDlReport(await readLinkFreq(dl), "push");
    }
    if (res === "hold" || (res === "none" && pendingActive(dl))) {
      // Large jump pending confirmation: don't fight the knob on DL.
      await pushSide(ul, ulHz, force, snap);
      return;
    }
    // Absorbed (here or by a concurrent poll): targets are stale, next
    // tick recomputes UL/DL from the new manualDlOffset.
    if (res === "absorbed" || offsetsSnap() !== before) return;
  }
  if (!radioOn) return; // Radio turned off during dial read
  const ulOk = await pushSide(ul, ulHz, force, force ? null : snap);
  const dlOk = await pushSide(dl, dlTarget, force, force ? null : snap);
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
  // Skip only while sync verify owns the link. Do not gate on pushInFlight /
  // catQueue — that starved absorb after 4a1211f and caused dial snap-back.
  if (syncNeeded) return;
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
  handleDlReport(freq, "poll");
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
    dl.lastCommandedHz = null;
    dl.lastFreqHz = null;
  } else {
    ulFineOffset += delta;
    ul.lastCommandedHz = null;
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
  ul.lastCommandedHz = null;
  dl.lastCommandedHz = null;
  ul.lastFreqHz = null;
  dl.lastFreqHz = null;
  broadcastStatus();
}

function resetOffsets() {
  manualDlOffset = 0;
  ulFineOffset = 0;
  dlFineOffset = 0;
  ul.lastCommandedHz = null;
  dl.lastCommandedHz = null;
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
  ul.lastCommandedHz = null;
  dl.lastCommandedHz = null;
  ul.lastFreqHz = null;
  dl.lastFreqHz = null;
  broadcastStatus();
}

function getRadioState() {
  return {
    radioOn,
    locked,
    dataMode,
    supportsDataMode: true,
    cwMode,
    supportsCwMode: true,
    tciConnected: anyConnected(),
    connected: anyConnected(),
    ulConnected: ul.connected,
    dlConnected: dl.connected,
    connecting: ul.connecting || dl.connecting,
    manualDlOffset,
    ulFineOffset,
    dlFineOffset,
    lastCmdDl: dl.lastCommandedHz,
    lastCmdUl: ul.lastCommandedHz,
    step: digitStep,
    ctcssMode,
    ctcssAccessHz,
    ctcssActivationHz,
    syncNeeded,
    supportsFlexProfiles: true,
    flexProfiles: api.getGlobalProfiles(),
    flexProfile: selectedFlexProfile,
    flexProfileCurrent: api.getCurrentGlobalProfile(),
    apiConnected: api.isConnected(),
  };
}

function applyEndpointChange() {
  const wasOn = radioOn;
  // Re-open only links whose endpoint is unchanged. A link whose endpoint
  // moved (profile switch, Radio 1 / Radio 2 swap: the Flex changes role) is
  // opened by the next push if that role still needs it; re-opening it here
  // dialled the other role's stale endpoint (e.g. the IC-705 card's hidden
  // CAT field) for one tick.
  const keep = (link) => {
    const ep = linkHostPort(link);
    return link.wanted && link.epKey != null && link.epKey === ep.host + ":" + ep.port;
  };
  const ulWanted = keep(ul);
  const dlWanted = keep(dl);
  // Same radio API: its loaded global profile is still loaded. Re-loading it
  // resets every slice to the profile's saved frequencies (a visible snap
  // back) — only reload when the API endpoint (i.e. the radio) changed.
  const apiKey = apiHost() + ":" + apiPort();
  const keepProfile = lastProfileLoaded != null && lastProfileApiKey === apiKey;
  closeLink(ul);
  closeLink(dl);
  api.close();
  if (!keepProfile) lastProfileLoaded = null;
  lastCtcssApplied = null;
  profileSkipLogged = new Set();
  radioOn = wasOn;
  // Always (re)connect API for profile list when host is set — radio may be off
  ensureApiConnection()
    .then((ok) => {
      if (ok && wasOn) ensureFlexProfile().catch(() => {});
    })
    .catch(() => {});
  if (wasOn) {
    markSyncNeeded("endpoint change");
    ul.wanted = ulWanted;
    dl.wanted = dlWanted;
    if (ulWanted) openLink(ul).catch(() => {});
    if (dlWanted) openLink(dl).catch(() => {});
  }
  broadcastStatus();
}

module.exports = {
  init,
  activate,
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
  setDataMode,
  setCwMode,
  setFlexProfile,
  applyDefaultCtcss,
  getRadioState,
  statusPayload,
  broadcastStatus,
  applyEndpointChange,
};
