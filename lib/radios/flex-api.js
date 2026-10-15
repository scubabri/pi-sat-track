/**
 * Minimal FlexRadio SmartSDR TCP/IP API client.
 * Radio LAN IP port 4992 (not Windows SmartSDR CAT).
 *
 * FlexLib FMToneMode: Off | CTCSS_TX  (not "CTCSS")
 * CTCSS on UL slice only:
 *   slice set N fm_tone_mode=CTCSS_TX fm_tone_value=67.0
 */

const net = require("net");
const config = require("../config");

const CONNECT_TIMEOUT_MS = 4000;
const SLICE_WAIT_MS = 800;
const MAX_DEBUG_LINES = 50;
/** Match UL freq within this many Hz when selecting tone slice. */
const UL_FREQ_MATCH_HZ = 100000; // 100 kHz

/**
 * Parse SmartSDR profile status / response bodies.
 * Real radios use caret-separated names that CONTAIN SPACES, e.g.:
 *   S…|profile global list=KD0RC - 6 CW^KD0RC - 6 SSB^SO2RDefault^
 *   S…|profile global list=… current=My Profile
 *   R…|0|list=Name1^Name2^   (body of profile global info)
 * Returns { list?: string[], current?: string } or null if not profile data.
 */
function parseProfilePayload(body) {
  const s = String(body || "").trim();
  if (!s) return null;
  // Accept with or without leading "profile …"
  const hasList = /\blist\s*=/i.test(s);
  const hasCurrent = /\bcurrent\s*=/i.test(s);
  if (!hasList && !hasCurrent && !/^profile\b/i.test(s)) return null;
  const out = {};
  // Names have spaces — capture until " current=" or EOL (not [^\\s]*)
  const listM = s.match(/\blist\s*=\s*(.*?)(?=\s+current\s*=\s*|$)/i);
  if (listM) {
    out.list = String(listM[1] || "")
      .split("^")
      .map((x) => x.trim())
      .filter(Boolean);
  }
  const curM = s.match(
    /\bcurrent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\^]*?))\s*$/i,
  );
  if (curM) {
    out.current = (curM[1] || curM[2] || curM[3] || "").trim();
  }
  return out.list || out.current != null ? out : null;
}

function createApiClient() {
  let socket = null;
  let connected = false;
  let connecting = false;
  let seq = 1;
  let buf = "";
  let host = null;
  let port = 4992;
  let clientHandle = null;
  let debugLines = 0;
  /** @type {Map<number, string>} */
  let pendingCmd = new Map();
  /** @type {Map<number, {resolve:Function, timer:NodeJS.Timeout, cmd:string}>} */
  let pendingWait = new Map();
  /** @type {Map<number, {tx:boolean, mode:string, freqHz:number|null, letter:string}>} */
  let slices = new Map();
  /**
   * Last tone state we successfully sent on this connection:
   * { slice, val } where val is "67.0" or "OFF". Cleared on (re)connect/close
   * and when slice status shows the radio diverged (mode/tone changed).
   */
  let lastTone = null;
  /** In-flight setCtcss promise + its request key (coalesce concurrent syncs). */
  let toneInflight = null;
  /** Global profile names from radio status (list=a^b^c). */
  let globalProfiles = [];
  /** Radio-reported current global profile name (may be ""). */
  let currentGlobalProfile = "";
  /** Optional callback when list/current changes. */
  let profilesListener = null;

  function nextSeq() {
    const n = seq++;
    if (seq > 999999) seq = 1;
    return n;
  }

  function send(cmd) {
    if (!socket || !connected) return false;
    const n = nextSeq();
    const line = "C" + n + "|" + cmd + "\n";
    pendingCmd.set(n, cmd);
    try {
      socket.write(line, "utf8");
      return true;
    } catch (e) {
      console.warn("Flex API write:", e.message);
      pendingCmd.delete(n);
      return false;
    }
  }

  /**
   * Send a command and wait for the matching R response (or timeout).
   * @returns {Promise<{ok:boolean, status:number, msg:string, timeout?:boolean}>}
   */
  function sendAndWait(cmd, timeoutMs) {
    const ms = timeoutMs != null ? timeoutMs : 4000;
    return new Promise((resolve) => {
      if (!socket || !connected) {
        resolve({ ok: false, status: -1, msg: "not connected" });
        return;
      }
      const n = nextSeq();
      const line = "C" + n + "|" + cmd + "\n";
      pendingCmd.set(n, cmd);
      const timer = setTimeout(() => {
        pendingWait.delete(n);
        pendingCmd.delete(n);
        resolve({ ok: false, status: -1, msg: "timeout", timeout: true });
      }, ms);
      pendingWait.set(n, { resolve, timer, cmd });
      try {
        socket.write(line, "utf8");
      } catch (e) {
        clearTimeout(timer);
        pendingWait.delete(n);
        pendingCmd.delete(n);
        console.warn("Flex API write:", e.message);
        resolve({ ok: false, status: -1, msg: e.message });
      }
    });
  }

  function parseSliceStatus(body) {
    const m = body.match(/^slice\s+(\d+)\b(.*)$/i);
    if (!m) return;
    const idx = parseInt(m[1], 10);
    const rest = m[2] || "";
    const cur = slices.get(idx) || {
      tx: false,
      mode: "",
      freqHz: null,
      letter: "",
    };

    if (/\btx\s*=\s*1\b/i.test(rest)) cur.tx = true;
    if (/\btx\s*=\s*0\b/i.test(rest)) cur.tx = false;

    const mm = rest.match(/\bmode\s*=\s*([A-Za-z0-9]+)/i);
    if (mm) cur.mode = mm[1];

    const tm = rest.match(/\bfm_tone_mode\s*=\s*([A-Za-z_]+)/i);
    if (tm) cur.toneMode = tm[1];
    const tv = rest.match(/\bfm_tone_value\s*=\s*([0-9.]+)/i);
    if (tv) cur.toneValue = parseFloat(tv[1]);

    // Radio-side change on the slice we toned (mode left FM, tone turned
    // off / changed elsewhere) → allow the next sync to re-send.
    if (lastTone && lastTone.slice === idx) {
      if (mm && !/^FM$/i.test(cur.mode)) lastTone = null;
      else if (tm && lastTone.val !== "OFF" && !/CTCSS/i.test(cur.toneMode))
        lastTone = null;
      else if (
        tv && lastTone.val !== "OFF" &&
        Math.abs(cur.toneValue - parseFloat(lastTone.val)) > 0.05
      )
        lastTone = null;
    }

    const ll = rest.match(/\bindex_letter\s*=\s*([A-Za-z])/i);
    if (ll) cur.letter = ll[1];

    const fm = rest.match(/\bRF_frequency\s*=\s*([0-9.]+)/i);
    if (fm) {
      let mhz = parseFloat(fm[1]);
      if (Number.isFinite(mhz)) {
        if (mhz > 0 && mhz < 1000) mhz = mhz * 1e6;
        cur.freqHz = Math.round(mhz);
      }
    }

    slices.set(idx, cur);
  }

  function notifyProfiles() {
    if (typeof profilesListener === "function") {
      try {
        profilesListener({
          list: globalProfiles.slice(),
          current: currentGlobalProfile,
        });
      } catch (_) {}
    }
  }

  function parseProfileStatus(body) {
    const parsed = parseProfilePayload(body);
    if (!parsed) return false;
    let changed = false;
    if (parsed.list) {
      const prev = globalProfiles.join("^");
      const next = parsed.list.join("^");
      if (next !== prev) {
        globalProfiles = parsed.list.slice();
        changed = true;
        console.log(
          "Flex API: " +
            globalProfiles.length +
            " global profiles" +
            (globalProfiles.length
              ? " (" + globalProfiles.join(", ") + ")"
              : ""),
        );
      }
    }
    if (parsed.current != null && parsed.current !== currentGlobalProfile) {
      currentGlobalProfile = parsed.current;
      changed = true;
    }
    if (changed) notifyProfiles();
    return true;
  }

  function parseLine(line) {
    line = String(line).replace(/\r/g, "").trim();
    if (!line) return;

    if (debugLines < MAX_DEBUG_LINES) {
      debugLines += 1;
      const show = line.length > 220 ? line.slice(0, 220) + "…" : line;
      console.log("Flex API <<", show);
    }

    if (line.startsWith("V")) return;

    if (line.startsWith("H") && line.length > 1) {
      clientHandle = line.slice(1);
      return;
    }

    if (line.startsWith("R")) {
      const rm = line.match(/^R(\d+)\|(\d+)\|(.*)$/);
      if (rm) {
        const s = parseInt(rm[1], 10);
        const status = parseInt(rm[2], 10);
        const msg = rm[3] || "";
        const cmd = pendingCmd.get(s) || "?";
        pendingCmd.delete(s);
        const waiter = pendingWait.get(s);
        if (waiter) {
          pendingWait.delete(s);
          clearTimeout(waiter.timer);
          waiter.resolve({ ok: status === 0, status, msg });
        }
        if (status !== 0) {
          console.warn(
            "Flex API CMD FAIL seq",
            s,
            "status",
            status,
            msg,
            "cmd:",
            cmd,
          );
        } else if (/fm_tone/i.test(cmd) || /profile\s+global\s+load/i.test(cmd)) {
          console.log("Flex API CMD OK:", cmd);
        }
        // profile global info may put list=/current= in the R body
        if (
          msg &&
          /profile/i.test(cmd) &&
          (/\blist\s*=/i.test(msg) || /\bcurrent\s*=/i.test(msg))
        ) {
          parseProfileStatus(
            /^profile\b/i.test(msg) ? msg : "profile global " + msg,
          );
        }
      }
      return;
    }

    if (line.startsWith("M")) return;

    if (line.startsWith("S") && line.includes("|")) {
      const bar = line.indexOf("|");
      const body = line.slice(bar + 1);
      if (/^slice\s+\d+/i.test(body)) {
        parseSliceStatus(body);
      } else if (/^profile\b/i.test(body)) {
        parseProfileStatus(body);
      }
    }
  }

  function onData(chunk) {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.search(/\r?\n/)) >= 0) {
      const nl = buf[idx] === "\r" && buf[idx + 1] === "\n" ? 2 : 1;
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + nl);
      parseLine(line);
    }
  }

  function dumpSlices() {
    const parts = [];
    for (const [idx, s] of slices) {
      parts.push(
        "#" +
          idx +
          (s.letter ? "(" + s.letter + ")" : "") +
          (s.tx ? " TX" : "") +
          (s.freqHz != null ? " " + (s.freqHz / 1e6).toFixed(3) + "MHz" : "") +
          (s.mode ? " " + s.mode : ""),
      );
    }
    return parts.length ? parts.join(", ") : "(none yet)";
  }

  /**
   * Choose the uplink / tone slice.
   * Prefer frequency match to commanded UL (AetherSDR often marks the DL
   * slice as tx=1 while UL sits on the other VFO at 2m).
   */
  function findUlSlice(ulHz) {
    if (ulHz != null && Number.isFinite(ulHz) && ulHz > 0 && slices.size) {
      let best = null;
      let bestDiff = Infinity;
      for (const [idx, s] of slices) {
        if (s.freqHz == null) continue;
        const d = Math.abs(s.freqHz - ulHz);
        if (d < bestDiff) {
          bestDiff = d;
          best = idx;
        }
      }
      if (best != null && bestDiff <= UL_FREQ_MATCH_HZ) {
        return best;
      }
    }

    for (const [idx, s] of slices) {
      if (s.tx) return idx;
    }

    if (slices.has(0)) return 0;
    const first = slices.keys().next();
    if (!first.done) return first.value;
    return 0;
  }

  function subscribeSlices() {
    send("sub slice all");
  }

  function connect(apiHost, apiPort) {
    host = (apiHost || host || "").trim();
    port = apiPort || config.FLEX_API_PORT || 4992;
    if (!host) {
      console.log(
        "Flex API: skip — no API host configured (set Radio API host in config)",
      );
      return Promise.resolve(false);
    }
    if (socket && connected) return Promise.resolve(true);
    if (connecting) return Promise.resolve(false);

    connecting = true;
    console.log("Flex API: connecting " + host + ":" + port);
    return new Promise((resolve) => {
      const s = new net.Socket();
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        connecting = false;
        if (!ok) {
          try {
            s.destroy();
          } catch (_) {}
          connected = false;
          socket = null;
        }
        resolve(ok);
      };

      s.setTimeout(CONNECT_TIMEOUT_MS);
      s.once("connect", () => {
        s.setTimeout(0);
        socket = s;
        connected = true;
        buf = "";
        slices = new Map();
        clientHandle = null;
        debugLines = 0;
        pendingCmd = new Map();
        for (const w of pendingWait.values()) {
          try { clearTimeout(w.timer); } catch (_) {}
          try { w.resolve({ ok: false, status: -1, msg: "reconnect" }); } catch (_) {}
        }
        pendingWait = new Map();
        lastTone = null;
        globalProfiles = [];
        currentGlobalProfile = "";
        console.log("Flex API connected", host + ":" + port);

        setTimeout(() => {
          subscribeSlices();
          // Profile list: sub profile all + profile global info (FlexAPI /
          // community). Status: S...|profile global list=a^b^c
          send("sub profile all");
          send("profile global info");
          setTimeout(() => {
            console.log("Flex API slices:", dumpSlices());
            if (slices.size === 0) {
              console.warn("Flex API: no slice status yet — re-subscribing");
              subscribeSlices();
            }
            if (globalProfiles.length === 0) {
              send("profile global info");
            }
          }, SLICE_WAIT_MS);
        }, 200);

        done(true);
      });
      s.once("timeout", () => {
        console.warn("Flex API connect timeout", host + ":" + port);
        done(false);
      });
      s.once("error", (err) => {
        console.warn("Flex API connect error:", err.message);
        done(false);
      });
      s.on("data", onData);
      s.on("close", () => {
        connected = false;
        connecting = false;
        socket = null;
        lastTone = null;
        console.log("Flex API closed");
      });

      try {
        s.connect(port, host);
      } catch (e) {
        console.warn("Flex API exception:", e.message);
        done(false);
      }
    });
  }

  function close() {
    if (socket) {
      try {
        socket.removeAllListeners();
        socket.destroy();
      } catch (_) {}
    }
    socket = null;
    connected = false;
    connecting = false;
    slices = new Map();
    clientHandle = null;
    for (const w of pendingWait.values()) {
      try { clearTimeout(w.timer); } catch (_) {}
      try { w.resolve({ ok: false, status: -1, msg: "closed" }); } catch (_) {}
    }
    pendingWait = new Map();
    pendingCmd = new Map();
    buf = "";
    lastTone = null;
    globalProfiles = [];
    currentGlobalProfile = "";
  }

  /**
   * Set CTCSS on the UL slice — deduped: only sends when the target slice or
   * tone differs from what was last sent on this connection. Concurrent calls
   * for the same request share one in-flight attempt.
   */
  function setCtcss(hz, ulHz) {
    const want =
      hz != null && Number.isFinite(Number(hz)) && Number(hz) > 0
        ? Number(hz).toFixed(1)
        : "OFF";
    if (toneInflight && toneInflight.want === want) return toneInflight.p;
    const p = setCtcssInner(hz, ulHz, want).finally(() => {
      if (toneInflight && toneInflight.p === p) toneInflight = null;
    });
    toneInflight = { want, p };
    return p;
  }

  async function setCtcssInner(hz, ulHz, want) {
    if (!host) {
      console.warn(
        "Flex API: CTCSS skipped — set radio API host (radio LAN IP:4992)",
      );
      return false;
    }
    if (!connected) {
      const ok = await connect(host, port);
      if (!ok) return false;
      await new Promise((r) => setTimeout(r, SLICE_WAIT_MS + 300));
    }

    if (slices.size === 0) {
      subscribeSlices();
      await new Promise((r) => setTimeout(r, SLICE_WAIT_MS));
    }

    const sliceIdx = findUlSlice(ulHz);
    if (
      lastTone &&
      lastTone.slice === sliceIdx &&
      lastTone.val === want
    ) {
      return true; // unchanged — no resend
    }
    console.log(
      "Flex API UL slice →",
      sliceIdx,
      "among",
      dumpSlices(),
      ulHz != null ? "(UL " + (ulHz / 1e6).toFixed(3) + " MHz)" : "",
    );

    // CTCSS only valid in FM — force slice mode first (was failing with
    // status 50000061 when the UL slice was still USB/LSB from a linear sat).
    const cur = slices.get(sliceIdx);
    const modeNow = (cur && cur.mode) || "";
    if (!/^D?FM$/i.test(modeNow)) { // DFM (data) is FM for tone purposes
      send("slice set " + sliceIdx + " mode=FM");
      console.log("Flex API slice", sliceIdx, "mode → FM (was", modeNow || "?", ")");
    }

    if (hz != null && Number.isFinite(hz) && hz > 0) {
      const val = Number(hz).toFixed(1);
      // FlexLib FMToneMode: Off | CTCSS_TX ("CTCSS" alone returns 50000033)
      const cmd =
        "slice set " +
        sliceIdx +
        " fm_tone_mode=CTCSS_TX fm_tone_value=" +
        val;
      const ok = send(cmd);
      console.log(
        "Flex API slice",
        sliceIdx,
        "CTCSS_TX ON",
        val,
        "Hz",
        ok ? "sent" : "SEND FAIL",
      );
      lastTone = ok ? { slice: sliceIdx, val } : null;
      return ok;
    }

    const ok = send("slice set " + sliceIdx + " fm_tone_mode=OFF");
    console.log(
      "Flex API slice",
      sliceIdx,
      "CTCSS OFF",
      ok ? "sent" : "SEND FAIL",
    );
    lastTone = ok ? { slice: sliceIdx, val: "OFF" } : null;
    return ok;
  }

  /**
   * Load a SmartSDR global profile: profile global load "name"
   * (FlexRadio SmartSDR TCP/IP API wiki — TCPIP-profile).
   * Waits for the command response, clears slice cache, re-subscribes,
   * and pauses briefly so subsequent slice/CAT setup applies to the new profile.
   */
  async function loadGlobalProfile(name) {
    const n = String(name || "").trim();
    if (!n) return false;
    if (!connected) {
      console.warn("Flex API: profile load skipped — not connected");
      return false;
    }
    // Escape embedded quotes in the profile name
    const escaped = n.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const cmd = 'profile global load "' + escaped + '"';
    const res = await sendAndWait(cmd, 5000);
    if (!res.ok) {
      console.warn(
        "Flex API profile load failed:",
        n,
        res.timeout ? "timeout" : "status " + res.status,
        res.msg || "",
      );
      return false;
    }
    // Profile load rebuilds slices — drop cached state and re-sync
    slices = new Map();
    lastTone = null;
    currentGlobalProfile = n;
    notifyProfiles();
    subscribeSlices();
    send("profile global info"); // refresh list/current
    await new Promise((r) => setTimeout(r, SLICE_WAIT_MS + 200));
    console.log("Flex API slices after profile:", dumpSlices());
    return true;
  }

  return {
    connect,
    close,
    setCtcss,
    loadGlobalProfile,
    sendAndWait,
    isConnected: () => connected,
    findUlSlice,
    dumpSlices,
    getGlobalProfiles: () => globalProfiles.slice(),
    getCurrentGlobalProfile: () => currentGlobalProfile,
    onProfilesChanged: (fn) => {
      profilesListener = typeof fn === "function" ? fn : null;
    },
    refreshProfiles: () => {
      if (!connected) return false;
      send("sub profile all");
      return send("profile global info");
    },
  };
}

module.exports = { createApiClient, parseProfilePayload };
