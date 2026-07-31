/**
 * Minimal FlexRadio SmartSDR TCP/IP API client.
 * Radio LAN IP port 4992 (not Windows SmartSDR CAT).
 *
 * CTCSS is applied only to the UL (TX) slice:
 *   slice set N fm_tone_mode=CTCSS
 *   slice set N fm_tone_value=67.0
 *
 * Slice selection order:
 *   1) slice with tx=1
 *   2) slice whose RF_frequency is closest to optional UL Hz (from CAT)
 *   3) first known slice
 */

const net = require("net");
const config = require("../config");

const CONNECT_TIMEOUT_MS = 4000;
const SLICE_WAIT_MS = 500;

function createApiClient() {
  let socket = null;
  let connected = false;
  let connecting = false;
  let seq = 1;
  let buf = "";
  let host = null;
  let port = 4992;
  /** @type {Map<number, {tx:boolean, mode:string, freqHz:number|null}>} */
  let slices = new Map();
  let pending = [];

  function nextSeq() {
    const n = seq++;
    if (seq > 999999) seq = 1;
    return n;
  }

  function send(cmd) {
    if (!socket || !connected) return false;
    const n = nextSeq();
    const line = "C" + n + "|" + cmd + "\n";
    try {
      socket.write(line, "utf8");
      return true;
    } catch (e) {
      console.warn("Flex API write:", e.message);
      return false;
    }
  }

  function parseLine(line) {
    line = line.trim();
    if (!line) return;
    if (!(line.startsWith("S") && line.includes("|slice "))) return;

    const body = line.slice(line.indexOf("|") + 1);
    const m = body.match(/^slice\s+(\d+)\s+(.*)$/);
    if (!m) return;

    const idx = parseInt(m[1], 10);
    const rest = m[2];
    const cur = slices.get(idx) || { tx: false, mode: "", freqHz: null };

    if (/\btx=1\b/i.test(rest)) cur.tx = true;
    if (/\btx=0\b/i.test(rest)) cur.tx = false;

    const mm = rest.match(/\bmode=([A-Za-z0-9]+)/i);
    if (mm) cur.mode = mm[1];

    // RF_frequency is in MHz (e.g. 0.435250000 or 435.250000 depending on firmware)
    const fm = rest.match(/\bRF_frequency=([0-9.]+)/i);
    if (fm) {
      let mhz = parseFloat(fm[1]);
      if (Number.isFinite(mhz)) {
        // normalize: values < 1000 treated as MHz
        if (mhz < 1000) mhz = mhz * 1e6;
        cur.freqHz = Math.round(mhz);
      }
    }

    slices.set(idx, cur);
  }

  function onData(chunk) {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      parseLine(line);
    }
  }

  function dumpSlices() {
    const parts = [];
    for (const [idx, s] of slices) {
      parts.push(
        "#" +
          idx +
          (s.tx ? " TX" : "") +
          (s.freqHz != null ? " " + (s.freqHz / 1e6).toFixed(3) + "MHz" : "") +
          (s.mode ? " " + s.mode : ""),
      );
    }
    return parts.length ? parts.join(", ") : "(none yet)";
  }

  /**
 * Prefer TX slice; else closest RF to ulHz; else first slice.
 * @param {number|null|undefined} ulHz
 */
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
      // accept match within 50 kHz (Doppler + tune)
      if (best != null && bestDiff < 50000) return best;
    }

    if (slices.has(0)) return 0;
    const first = slices.keys().next();
    if (!first.done) return first.value;
    return 0;
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
        console.log("Flex API connected", host + ":" + port);
        // gui client so we receive slice status
        send("client gui");
        send("sub slice all");
        setTimeout(() => {
          console.log("Flex API slices:", dumpSlices());
          for (const fn of pending.splice(0)) {
            try {
              fn();
            } catch (_) {}
          }
        }, SLICE_WAIT_MS);
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
    pending = [];
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
  }

  /**
   * Apply CTCSS on UL slice only.
   * @param {number|null} hz  tone Hz, or null/0 to turn off
   * @param {number|null} [ulHz] optional UL frequency from CAT to help pick slice
   */
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
      await new Promise((r) => setTimeout(r, SLICE_WAIT_MS));
    } else if (slices.size === 0) {
      send("sub slice all");
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
      // Ensure FM tone encode path on this slice only
      const ok1 = send("slice set " + sliceIdx + " fm_tone_mode=CTCSS");
      const ok2 = send("slice set " + sliceIdx + " fm_tone_value=" + val);
      console.log(
        "Flex API slice",
        sliceIdx,
        "CTCSS ON",
        val,
        "Hz",
        ok1 && ok2 ? "OK" : "SEND FAIL",
      );
      return ok1 && ok2;
    }

    const ok = send("slice set " + sliceIdx + " fm_tone_mode=OFF");
    console.log(
      "Flex API slice",
      sliceIdx,
      "CTCSS OFF",
      ok ? "OK" : "SEND FAIL",
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
