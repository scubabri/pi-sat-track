/**
 * Minimal FlexRadio SmartSDR TCP/IP API client.
 * Radio LAN IP port 4992 (not Windows SmartSDR CAT).
 *
 * Status examples:
 *   S3E53ED3B|slice 0 ... RF_frequency=14.188000 ... tx=1 mode=USB ...
 *
 * CTCSS on UL slice only (single command preferred):
 *   slice set N fm_tone_mode=CTCSS fm_tone_value=67.0
 */

const net = require("net");
const config = require("../config");

const CONNECT_TIMEOUT_MS = 4000;
const SLICE_WAIT_MS = 800;
const MAX_DEBUG_LINES = 50;

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
  /** @type {Map<number, string>} seq -> last command (for matching R replies) */
  let pendingCmd = new Map();
  /** @type {Map<number, {tx:boolean, mode:string, freqHz:number|null, letter:string}>} */
  let slices = new Map();

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

    // R<seq>|<status>|<message>
    if (line.startsWith("R")) {
      const rm = line.match(/^R(\d+)\|(\d+)\|(.*)$/);
      if (rm) {
        const s = parseInt(rm[1], 10);
        const status = parseInt(rm[2], 10);
        const msg = rm[3] || "";
        const cmd = pendingCmd.get(s) || "?";
        pendingCmd.delete(s);
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
        } else if (/fm_tone/i.test(cmd)) {
          console.log("Flex API CMD OK:", cmd);
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

  function findUlSlice(ulHz) {
    for (const [idx, s] of slices) {
      if (s.tx) return idx;
    }

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
      if (best != null && bestDiff < 50000) return best;
    }

    if (slices.has(0)) return 0;
    const first = slices.keys().next();
    if (!first.done) return first.value;
    return 0;
  }

  function subscribeSlices() {
    // Do NOT send "client program …" — radio replies unknown client program.
    // Plain connection + sub is enough alongside SmartSDR GUI.
    send("sub slice all");
  }

  function connect(apiHost, apiPort) {
    host = (apiHost || host || "").trim();
    port = apiPort || config.FLEX_API_PORT || 4992;
    if (!host) {
      console.log("Flex API: no radio IP configured (set API host in config)");
      return Promise.resolve(false);
    }
    if (socket && connected) return Promise.resolve(true);
    if (connecting) return Promise.resolve(false);

    connecting = true;
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
        console.log("Flex API connected", host + ":" + port);

        setTimeout(() => {
          subscribeSlices();
          setTimeout(() => {
            console.log("Flex API slices:", dumpSlices());
            if (slices.size === 0) {
              console.warn("Flex API: no slice status yet — re-subscribing");
              subscribeSlices();
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
    pendingCmd = new Map();
    buf = "";
  }

  async function setCtcss(hz, ulHz) {
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
    console.log(
      "Flex API UL slice →",
      sliceIdx,
      "among",
      dumpSlices(),
      ulHz != null ? "(CAT UL " + (ulHz / 1e6).toFixed(3) + " MHz)" : "",
    );

    if (hz != null && Number.isFinite(hz) && hz > 0) {
      const val = Number(hz).toFixed(1);
      // Single command — both params together (avoids partial apply / odd errors)
      const cmd =
        "slice set " +
        sliceIdx +
        " fm_tone_mode=CTCSS fm_tone_value=" +
        val;
      const ok = send(cmd);
      console.log(
        "Flex API slice",
        sliceIdx,
        "CTCSS ON",
        val,
        "Hz",
        ok ? "sent" : "SEND FAIL",
      );
      return ok;
    }

    const ok = send("slice set " + sliceIdx + " fm_tone_mode=OFF");
    console.log(
      "Flex API slice",
      sliceIdx,
      "CTCSS OFF",
      ok ? "sent" : "SEND FAIL",
    );
    return ok;
  }

  return {
    connect,
    close,
    setCtcss,
    isConnected: () => connected,
    findUlSlice,
    dumpSlices,
  };
}

module.exports = { createApiClient };
