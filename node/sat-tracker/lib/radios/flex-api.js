/**
 * Minimal FlexRadio SmartSDR TCP/IP API client.
 * Listens on the *radio* (not the Windows SmartSDR CAT PC), default port 4992.
 *
 * CTCSS:
 *   slice set N fm_tone_mode=CTCSS
 *   slice set N fm_tone_value=67.0
 */

const net = require("net");
const config = require("../config");

const CONNECT_TIMEOUT_MS = 4000;

function createApiClient() {
  let socket = null;
  let connected = false;
  let connecting = false;
  let seq = 1;
  let buf = "";
  let host = null;
  let port = 4992;
  /** @type {Map<number, {tx:boolean, mode:string}>} */
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
    if (line.startsWith("S") && line.includes("|slice ")) {
      const body = line.slice(line.indexOf("|") + 1);
      const m = body.match(/^slice\s+(\d+)\s+(.*)$/);
      if (!m) return;
      const idx = parseInt(m[1], 10);
      const rest = m[2];
      const cur = slices.get(idx) || { tx: false, mode: "" };
      if (/\btx=1\b/.test(rest)) cur.tx = true;
      if (/\btx=0\b/.test(rest)) cur.tx = false;
      const mm = rest.match(/\bmode=([A-Za-z0-9]+)/);
      if (mm) cur.mode = mm[1];
      slices.set(idx, cur);
    }
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

  function findTxSlice() {
    for (const [idx, s] of slices) {
      if (s.tx) return idx;
    }
    if (slices.has(1)) return 1;
    if (slices.has(0)) return 0;
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
        send("client gui 0");
        send("sub slice all");
        setTimeout(() => {
          for (const fn of pending.splice(0)) {
            try {
              fn();
            } catch (_) {}
          }
        }, 300);
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

  async function setCtcss(hz) {
    if (!host) {
      console.warn("Flex API: CTCSS skipped — set radio API host (radio LAN IP:4992)");
      return false;
    }
    if (!connected) {
      const ok = await connect(host, port);
      if (!ok) return false;
      await new Promise((r) => setTimeout(r, 400));
    }

    const sliceIdx = findTxSlice();
    if (hz != null && Number.isFinite(hz) && hz > 0) {
      const val = Number(hz).toFixed(1);
      const ok1 = send("slice set " + sliceIdx + " fm_tone_mode=CTCSS");
      const ok2 = send("slice set " + sliceIdx + " fm_tone_value=" + val);
      console.log(
        "Flex API slice",
        sliceIdx,
        "CTCSS",
        val,
        "Hz",
        ok1 && ok2 ? "OK" : "SEND FAIL",
      );
      return ok1 && ok2;
    }
    const ok = send("slice set " + sliceIdx + " fm_tone_mode=OFF");
    console.log("Flex API slice", sliceIdx, "CTCSS OFF", ok ? "OK" : "SEND FAIL");
    return ok;
  }

  return {
    connect,
    close,
    setCtcss,
    isConnected: () => connected,
  };
}

module.exports = { createApiClient };
