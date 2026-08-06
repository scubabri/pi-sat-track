/**
 * Yaesu FT-817 / FT-817ND / FT-818 binary CAT driver.
 *
 * Protocol: 5-byte blocks, opcode last.
 *   [D1][D2][D3][D4][CMD]
 * Serial: 8N2 (two stop bits). Baud from radio menu (default 9600).
 *
 * Key opcodes:
 *   0x01 set frequency (D1–D4 = 8 BCD digits, 10 Hz units → 100 MHz … 10 Hz)
 *   0x03 read frequency + mode (returns 5 bytes)
 *   0x07 set mode (D1 = mode code)
 *   0x02 / 0x82 split on / off
 *   0x81 toggle VFO A/B
 *
 * Single radio: VFO A = DL, VFO B = UL, SPLIT ON (when TX_SPLIT).
 * Dual serial: Radio 1 = DL, Radio 2 = UL (no split on R1).
 *
 * Classic FT-817 has no CTCSS CAT opcodes — setCtcss is a no-op.
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
    buf: Buffer.alloc(0),
    lastHz: null,
    lastMode: null,
    reconnectTimer: null,
    wanted: false,
    /** Track which VFO we believe is selected: "A" | "B" */
    vfo: "A",
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
let syncNeeded = false;
let getCtx = () => ({});

const VFO_POLL_MS = 600;
const VFO_THRESH_HZ = 100;

const CMD = {
  SET_FREQ: 0x01,
  SPLIT_ON: 0x02,
  READ_FREQ: 0x03,
  SET_MODE: 0x07,
  SPLIT_OFF: 0x82,
  TOGGLE_VFO: 0x81,
};

// Mode byte for opcode 0x07
const MODE = {
  LSB: 0x00,
  USB: 0x01,
  CW: 0x02,
  CWR: 0x03,
  AM: 0x04,
  FM: 0x08,
  DIG: 0x0a,
  PKT: 0x0c,
};

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
  dl.vfo = "A";
  ul.vfo = "A";
  // Drop any dial-offset from a bad prior CAT read so we don't command
  // garbage like 1.4 MHz / 580 MHz on the next push.
  manualDlOffset = 0;
  console.log(
    "FT817 syncNeeded:",
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
    driver: "ft817",
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

/** Pack Hz into 4 BCD bytes (10 Hz resolution, 8 digits). */
function freqToBcd(hz) {
  const n = Math.round(Number(hz) / 10); // 10 Hz units
  const s = String(Math.max(0, n)).padStart(8, "0").slice(-8);
  const bytes = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) {
    const hi = parseInt(s[i * 2], 10);
    const lo = parseInt(s[i * 2 + 1], 10);
    bytes[i] = ((hi & 0xf) << 4) | (lo & 0xf);
  }
  return bytes;
}

/** Decode 4 BCD bytes (10 Hz units) → Hz. Null if outside FT-817 range. */
function bcdToFreq(buf) {
  if (!buf || buf.length < 4) return null;
  let digits = "";
  for (let i = 0; i < 4; i++) {
    const b = buf[i];
    const hi = (b >> 4) & 0xf;
    const lo = b & 0xf;
    if (hi > 9 || lo > 9) return null; // not valid BCD
    digits += String(hi) + String(lo);
  }
  const units = parseInt(digits, 10);
  if (!Number.isFinite(units)) return null;
  const hz = units * 10;
  // FT-817 coverage ~100 kHz – 470 MHz
  if (hz < 1e5 || hz > 470e6) return null;
  return hz;
}

function modesForCatalogMode(modeStr) {
  // AMSAT mode text is often "SSB CW*" — treat as SSB unless CW-only.
  const s = String(modeStr || "").toUpperCase();
  if (/\bFM\b|NFM|GFSK|C4FM|DSTAR|DMR/.test(s))
    return { ul: MODE.FM, dl: MODE.FM, ulName: "FM", dlName: "FM" };
  if (/\bCW\b/.test(s) && !/\bSSB\b|\bLSB\b|\bUSB\b/.test(s))
    return { ul: MODE.CW, dl: MODE.CW, ulName: "CW", dlName: "CW" };
  // Linear transponder: UL LSB, DL USB
  return { ul: MODE.LSB, dl: MODE.USB, ulName: "LSB", dlName: "USB" };
}

function writeRaw(link, data) {
  return new Promise((resolve) => {
    if (!link.port || !link.connected) {
      resolve(false);
      return;
    }
    link.port.write(data, (err) => {
      if (err) {
        console.warn("FT817", link.name, "write failed:", err.message);
        resolve(false);
        return;
      }
      link.port.drain(() => resolve(true));
    });
  });
}

/**
 * Serialize all CAT traffic on a link. Concurrent Doppler ticks were
 * stomping read-freq probes and each other (busy → null → false "no response").
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

/**
 * Send a 5-byte command. Optionally wait for `expect` reply bytes.
 * FT-817 SET ops return no data; only READ_FREQ (0x03) returns 5 bytes.
 */
function sendCmd(link, data4, opcode, expect, waitMs) {
  return enqueue(link, async () => {
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
    const ok = await writeRaw(link, frame);
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
    return link.buf.length >= need
      ? Buffer.from(link.buf.slice(0, need))
      : link.buf.length
        ? Buffer.from(link.buf)
        : null;
  });
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
      // Yaesu manual: 8N2. Many USB–serial adapters only do 8N1 reliably;
      // override with FT817_STOP_BITS=1 if read-back fails at 8N2.
      const stopBits = process.env.FT817_STOP_BITS === "1" ? 1 : 2;
      const p = new SerialPort({
        path,
        baudRate: baud > 0 ? baud : 9600,
        dataBits: 8,
        parity: "none",
        stopBits,
        autoOpen: false,
      });
      p.on("error", (e) =>
        console.warn("FT817", link.name, "error:", e.message),
      );

      const timer = setTimeout(() => {
        try {
          p.removeAllListeners("data");
          p.removeAllListeners("close");
          if (p.isOpen) p.close(() => {});
        } catch (_) {}
        console.warn("FT817", link.name, "open timeout", path);
        done(false);
      }, 3000);

      p.open((err) => {
        if (err) {
          clearTimeout(timer);
          console.warn("FT817", link.name, "open failed:", err.message);
          done(false);
          return;
        }
        clearTimeout(timer);
        link.port = p;
        link.connected = true;
        link.ready = false;
        link.buf = Buffer.alloc(0);
        link.vfo = "A";
        link._catQueue = [];
        link._catChain = null;
        link._catChainRunning = false;
        p.on("data", (chunk) => {
          link.buf = Buffer.concat([link.buf, chunk]);
          if (link.buf.length > 256) link.buf = link.buf.slice(-128);
        });
        p.on("close", () => {
          console.log("FT817", link.name, "closed");
          link.connected = false;
          link.ready = false;
          link.port = null;
          link.buf = Buffer.alloc(0);
          broadcastStatus();
          if (radioOn && link.wanted) scheduleReconnect(link);
        });
        try {
          if (typeof p.set === "function") {
            p.set({ dtr: true, rts: true }, () => {});
          }
        } catch (_) {}
        const stopBits = process.env.FT817_STOP_BITS === "1" ? 1 : 2;
        console.log(
          "FT817",
          link.name,
          "open",
          path,
          baud,
          "8N" + stopBits,
          dualMode() ? "[dual]" : "[split]",
        );
        // Probe before ready — blocks Doppler until CAT path is checked
        setTimeout(async () => {
          try {
            const probe = await readFreq(link);
            if (probe != null) {
              console.log(
                "FT817",
                link.name,
                "CAT OK — radio VFO",
                (probe / 1e6).toFixed(5),
                "MHz",
              );
              link.ready = true;
            } else {
              console.warn(
                "FT817",
                link.name,
                "CAT read probe failed — still enabling TX path (SET may work; check baud if LCD never moves)",
              );
              // Still allow commands: earlier sessions DID change mode on the radio.
              // Read can fail with some cables while writes still work.
              link.ready = true;
            }
          } catch (e) {
            console.warn("FT817 probe:", e.message);
            link.ready = true;
          }
          done(true);
        }, 400);
      });
    } catch (e) {
      link.connecting = false;
      console.warn("FT817", link.name, "exception:", e.message);
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
  link.buf = Buffer.alloc(0);
  link.busy = false;
}

function close() {
  closeLink(dl);
  closeLink(ul);
  splitOn = false;
  stopVfoPoll();
}

function setRadio(on) {
  console.log("FT817 setRadio(" + on + ")");
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

function setCtcss(/* which */) {
  // FT-817 has no CTCSS CAT opcodes in the standard 5-byte set
  broadcastStatus();
}

function applyDefaultCtcss(accessHz, activationHz) {
  ctcssAccessHz = accessHz != null ? accessHz : null;
  ctcssActivationHz = activationHz != null ? activationHz : null;
  if (ctcssAccessHz != null) ctcssMode = "access";
  else ctcssMode = "off";
  broadcastStatus();
}

async function toggleVfo(link) {
  await sendCmd(link, [0, 0, 0, 0], CMD.TOGGLE_VFO, 0, 100);
  await sleep(80);
  link.vfo = link.vfo === "A" ? "B" : "A";
}

/**
 * FT-817 has no absolute VFO A/B select — only toggle (0x81).
 * We therefore do not try to "find A". Split ops use a fixed relative
 * sequence: current VFO = RX/DL, other VFO = TX/UL.
 */
async function ensureVfo(link, want, force) {
  if (!force && link.vfo === want) return;
  if (link.vfo !== want) await toggleVfo(link);
}

async function setSplit(on) {
  if (!dl.connected) return false;
  if (on) {
    await sendCmd(dl, [0, 0, 0, 0], CMD.SPLIT_ON, 0, 100);
    await sleep(60);
    splitOn = true;
  } else {
    await sendCmd(dl, [0, 0, 0, 0], CMD.SPLIT_OFF, 0, 100);
    await sleep(60);
    splitOn = false;
  }
  return true;
}

async function ensureSplit() {
  if (dualMode()) {
    if (splitOn && dl.connected) {
      await setSplit(false);
      console.log("FT817 SPLIT OFF (dual — R1 DL only)");
    }
    return false;
  }
  if (!txSplitEnabled()) {
    if (splitOn && dl.connected) await setSplit(false);
    return false;
  }
  if (splitOn) return true;
  await setSplit(true);
  console.log("FT817 SPLIT ON");
  return true;
}

/**
 * Deterministic single-radio split program for FT-817.
 * Does not assume which VFO is A or B:
 *   1. SPLIT OFF (so SET_FREQ always hits the displayed RX VFO)
 *   2. Set DL on current VFO
 *   3. Toggle → set UL on the other VFO
 *   4. SPLIT ON (TX = the other VFO)
 *   5. Toggle back → RX on DL VFO
 * Operationally: RX VFO = DL, TX VFO = UL (satellite convention).
 */
async function programSplitVfOs(dlHz, ulHz, mods, force) {
  await setSplit(false);

  let f = await setFreqMode(dl, dlHz, mods.dl, force);
  if (!f) return false;
  if (force)
    console.log(
      "FT817 RX VFO (DL)",
      (Math.round(dlHz) / 1e6).toFixed(6),
      "MHz",
    );

  await toggleVfo(dl);

  f = await setFreqMode(dl, ulHz, mods.ul, force);
  if (f) ul.lastHz = Math.round(ulHz);
  if (!f) return false;
  if (force)
    console.log(
      "FT817 TX VFO (UL)",
      (Math.round(ulHz) / 1e6).toFixed(6),
      "MHz",
    );

  await setSplit(true);
  console.log("FT817 SPLIT ON (TX = other VFO)");

  await toggleVfo(dl); // back to RX / DL VFO
  dl.lastHz = Math.round(dlHz);
  return true;
}

async function setFreqMode(link, hz, modeCode, force) {
  const target = Math.round(Number(hz));
  if (!Number.isFinite(target) || target <= 0) return false;
  // Reject nonsense (poisoned manual offset / bad upstream)
  if (target < 1e5 || target > 470e6) {
    console.warn(
      "FT817 skip out-of-range freq",
      (target / 1e6).toFixed(6),
      "MHz",
    );
    return false;
  }
  if (
    !force &&
    !syncNeeded &&
    link.lastHz != null &&
    Math.abs(target - link.lastHz) < 1 &&
    link.lastMode === modeCode
  ) {
    return true;
  }
  if (modeCode != null && (force || syncNeeded || link.lastMode !== modeCode)) {
    await sendCmd(link, [modeCode, 0, 0, 0], CMD.SET_MODE, 0, 80);
    await sleep(40);
    link.lastMode = modeCode;
  }
  const bcd = freqToBcd(target);
  if (force || syncNeeded) {
    const frame = Buffer.concat([
      Buffer.from(bcd),
      Buffer.from([CMD.SET_FREQ]),
    ]);
    console.log(
      "FT817 SET_FREQ",
      (target / 1e6).toFixed(6),
      "MHz  frame",
      frame.toString("hex"),
    );
  }
  const ok = await sendCmd(link, bcd, CMD.SET_FREQ, 0, 80);
  if (ok == null) return false;
  // Optional verify (FT-817 SET returns no data; separate READ may fail on some cables)
  if (force || syncNeeded) {
    const got = await readFreq(link);
    if (got != null) {
      console.log(
        "FT817 read-back",
        (got / 1e6).toFixed(6),
        "MHz",
        Math.abs(got - target) < 1000
          ? "OK"
          : "MISMATCH vs " + (target / 1e6).toFixed(6),
      );
    }
  }
  link.lastHz = target;
  return true;
}

async function readFreq(link) {
  link.buf = Buffer.alloc(0);
  const reply = await sendCmd(link, [0, 0, 0, 0], CMD.READ_FREQ, 5, 350);
  if (!reply || reply.length < 5) return null;
  const hz = bcdToFreq(reply.slice(0, 4));
  return hz;
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
  if (dl.connected && !dl.ready) return; // still probing
  if (dualMode() && hasUl && !ul.connected) {
    ul.wanted = true;
    await openLink(ul);
  }

  const { currentSatKey, currentModeIndex } = getCtx();
  const info = getCatalog()[currentSatKey] || {};
  const active = getActiveModeObj(info, currentModeIndex);
  const freqs = formatFreqDisplayFromMode(active);
  const mods = modesForCatalogMode(freqs.mode || (freqs.isFm ? "FM" : "SSB"));
  const force = syncNeeded;
  let ok = true;

  if (dualMode()) {
    if (hasDl && dl.connected) {
      await ensureVfo(dl, "A");
      const f = await setFreqMode(dl, dlHz, mods.dl, force);
      if (!f) ok = false;
      else if (force)
        console.log(
          "FT817 DL (R1)",
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
        await ensureVfo(ul, "A");
        const f = await setFreqMode(ul, ulHz, mods.ul, force);
        if (!f) ok = false;
        else if (force)
          console.log(
            "FT817 UL (R2)",
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

    // UL-only (mixed path: this driver owns TX only)
    if (hasUl && !hasDl) {
      const f = await setFreqMode(dl, ulHz, mods.ul, force);
      if (!f) ok = false;
      else if (force)
        console.log(
          "FT817 (UL-only)",
          (Math.round(ulHz) / 1e6).toFixed(6),
          "MHz",
        );
    } else if (hasDl && hasUl && txSplitEnabled()) {
      // Full sequence only on enable/sat change. Tracking = small updates.
      if (force || syncNeeded) {
        ok = (await programSplitVfOs(dlHz, ulHz, mods, true)) && ok;
      } else if (!splitOn) {
        ok = (await programSplitVfOs(dlHz, ulHz, mods, false)) && ok;
      } else {
        // Tracking: RX VFO (DL), toggle, TX VFO (UL), toggle back
        let f = await setFreqMode(dl, dlHz, mods.dl, false);
        if (!f) ok = false;
        await toggleVfo(dl);
        f = await setFreqMode(dl, ulHz, mods.ul, false);
        if (f) ul.lastHz = Math.round(ulHz);
        if (!f) ok = false;
        await toggleVfo(dl);
        dl.lastHz = Math.round(dlHz);
      }
    } else if (hasDl) {
      // Single VFO RX (e.g. NOAA) — no split
      if (splitOn) await setSplit(false);
      const f = await setFreqMode(dl, dlHz, mods.dl, force);
      if (!f) ok = false;
      else if (force)
        console.log(
          "FT817 (DL only)",
          (Math.round(dlHz) / 1e6).toFixed(6),
          "MHz",
        );
    } else if (hasUl) {
      const f = await setFreqMode(dl, ulHz, mods.ul, force);
      if (!f) ok = false;
    }
  }

  maybeClearSync(ok && anyConnected());
}

async function pollVfo() {
  if (!radioOn || !dl.connected || dl.busy || locked || syncNeeded) return;
  if (dl.lastHz == null || dl.lastHz <= 0) return;
  // Only poll when we believe we are on VFO A
  if (dl.vfo !== "A") return;
  const freq = await readFreq(dl);
  if (freq == null) return;
  // Ignore reads far from last commanded DL (bad frame / wrong VFO)
  if (Math.abs(freq - dl.lastHz) > 100000) return; // 100 kHz
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
  const next = freq - f0 * df - dlFineOffset;
  // Guard: dial offset should be small; large values poison UL/DL math
  if (Math.abs(next) > 100000) return;
  manualDlOffset = next;
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
    id: "ft817",
    label: "Yaesu FT-817/818 (binary CAT)",
    match(cfg) {
      if (typeof cfg.useFt817Serial === "function") return cfg.useFt817Serial();
      if (cfg.RADIO_TRANSPORT !== "serial") return false;
      const make = String(cfg.SERIAL_MAKE || "").toLowerCase();
      const model = String(cfg.SERIAL_MODEL || "").toLowerCase();
      if (make && make !== "yaesu") return false;
      return (
        model === "ft-817" ||
        model === "ft817" ||
        model === "ft-818" ||
        model === "ft818" ||
        model === "ft-817nd"
      );
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
