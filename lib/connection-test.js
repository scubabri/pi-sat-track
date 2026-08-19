/**
 * One-shot connection tests for config UI (radio UL/DL + rotor).
 * Rotor steps use a held serial session per device so open/close
 * races between read → nudge → goto do not lock the USB adapter.
 */
const net = require("net");
const { SerialPort } = require("serialport");
const WebSocket = require("ws");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ok(message, detail) {
  return { ok: true, message: message || "OK", detail: detail || null };
}
function fail(message, detail) {
  return { ok: false, message: message || "Failed", detail: detail || null };
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(fail((label || "Test") + " timed out after " + ms + "ms"));
    }, ms);
    promise.then(
      (r) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(r);
      },
      (e) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(fail(e.message || String(e)));
      },
    );
  });
}

function parseEndpoint(str, defaultHost, defaultPort) {
  const s = (str || "").trim();
  if (!s) return { host: defaultHost, port: defaultPort };
  const idx = s.lastIndexOf(":");
  if (idx > 0) {
    const host = s.slice(0, idx).trim();
    const p = parseInt(s.slice(idx + 1).trim(), 10);
    if (host && Number.isFinite(p) && p > 0 && p < 65536)
      return { host, port: p };
  }
  return { host: s || defaultHost, port: defaultPort };
}

function tcpConnect(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (success, errMsg) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch (_) {}
      resolve(
        success
          ? ok("TCP connect " + host + ":" + port)
          : fail(errMsg || "TCP connect failed"),
      );
    };
    socket.setTimeout(timeoutMs || 3000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, "Timeout " + host + ":" + port));
    socket.once("error", (e) => finish(false, e.message || "TCP error"));
    try {
      socket.connect(port, host);
    } catch (e) {
      finish(false, e.message);
    }
  });
}

function tcpExchange(host, port, writeBuf, waitMs, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch (_) {}
      resolve(result);
    };
    socket.setTimeout(timeoutMs || 4000);
    socket.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
    });
    socket.once("timeout", () => finish(fail("Timeout " + host + ":" + port)));
    socket.once("error", (e) => finish(fail(e.message || "TCP error")));
    socket.connect(port, host, async () => {
      try {
        if (writeBuf) {
          socket.write(writeBuf);
          await sleep(waitMs || 400);
        } else {
          await sleep(100);
        }
        const text = buf.toString("utf8").trim();
        finish(
          ok(
            "Connected " + host + ":" + port,
            text ? { reply: text.slice(0, 120) } : null,
          ),
        );
      } catch (e) {
        finish(fail(e.message));
      }
    });
  });
}

function openSerial(path, baud, opts) {
  return new Promise((resolve) => {
    let settled = false;
    let port;
    try {
      port = new SerialPort({
        path,
        baudRate: baud || 9600,
        dataBits: (opts && opts.dataBits) || 8,
        parity: (opts && opts.parity) || "none",
        stopBits: (opts && opts.stopBits) || 1,
        autoOpen: false,
      });
    } catch (e) {
      resolve({ port: null, error: e.message || String(e) });
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        if (port.isOpen) port.close(() => {});
      } catch (_) {}
      resolve({
        port: null,
        error:
          "Open timeout " +
          path +
          " (port busy? Turn Antenna OFF, wait 2s, retry)",
      });
    }, 4000);
    port.on("error", (e) => {
      console.warn("Serial test error", path, e.message);
    });
    port.open((err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        const msg = err.message || String(err);
        const hint =
          /resource temporarily|cannot lock|access denied|ebusy|eacces/i.test(
            msg,
          )
            ? " — port in use. Turn Antenna OFF, wait 2s, retry."
            : "";
        resolve({ port: null, error: msg + hint });
      } else {
        resolve({ port, error: null });
      }
    });
  });
}

function closeSerial(port) {
  return new Promise((resolve) => {
    if (!port) return resolve();
    try {
      if (port.isOpen) port.close(() => resolve());
      else resolve();
    } catch (_) {
      resolve();
    }
  });
}

function serialTransact(port, writeBuf, waitMs) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const onData = (c) => {
      buf = Buffer.concat([buf, c]);
    };
    port.on("data", onData);
    port.write(writeBuf, async (err) => {
      if (err) {
        port.removeListener("data", onData);
        resolve({ error: err.message, buf: null });
        return;
      }
      await sleep(waitMs || 400);
      port.removeListener("data", onData);
      resolve({ error: null, buf });
    });
  });
}

function parseHeading(text) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/[,;>\r\n]/g, " ")
    .trim();
  for (const tok of cleaned.split(/\s+/)) {
    const v = parseFloat(tok);
    if (Number.isFinite(v) && v >= -5 && v <= 360) return v;
  }
  return null;
}

/** FT-817/847 mode byte → name */
function yaesuBinaryModeName(b) {
  const map = {
    0x00: "LSB",
    0x01: "USB",
    0x02: "CW",
    0x03: "CWR",
    0x04: "AM",
    0x06: "WFM",
    0x08: "FM",
    0x0a: "DIG",
    0x0c: "PKT",
  };
  return map[b & 0xff] || "mode 0x" + (b & 0xff).toString(16);
}

/** BCD freq in 10 Hz units (4 bytes) → Hz */
function yaesuBinaryFreqHz(buf) {
  // Each nibble is a decimal digit; 4 bytes → 8 digits of 10 Hz units
  let n = 0;
  for (let i = 0; i < 4; i++) {
    const b = buf[i];
    n = n * 100 + ((b >> 4) & 0xf) * 10 + (b & 0xf);
  }
  return n * 10; // 10 Hz units → Hz
}

function formatMHz(hz) {
  if (hz == null || !Number.isFinite(hz)) return null;
  return (hz / 1e6).toFixed(6);
}

async function probeYaesuBinary(device, baud) {
  const { port, error } = await openSerial(device, baud || 38400, {
    stopBits: 2,
  });
  if (error) return fail(error);
  try {
    // 0x03 = read frequency & mode status → 5 bytes (4 BCD freq + mode)
    const cmd = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x03]);
    const { error: werr, buf } = await serialTransact(port, cmd, 500);
    if (werr) return fail(werr);
    if (!buf || buf.length < 5)
      return fail("No frequency reply (check baud/CAT rate)");
    const hz = yaesuBinaryFreqHz(buf);
    const mode = yaesuBinaryModeName(buf[4]);
    const mhz = formatMHz(hz);
    return ok("CAT " + device + " — " + mhz + " MHz " + mode, {
      device,
      freqHz: hz,
      freqMHz: mhz,
      mode,
      hex: buf.slice(0, 5).toString("hex"),
    });
  } finally {
    await closeSerial(port);
  }
}

const YAESU_TEXT_MD = {
  1: "LSB",
  2: "USB",
  3: "CW",
  4: "FM",
  5: "AM",
  6: "RTTY-L",
  7: "CW-R",
  8: "DATA-L",
  9: "RTTY-U",
  A: "DATA-FM",
  B: "FM-N",
  C: "DATA-U",
  D: "AM-N",
  E: "C4FM",
};

async function probeYaesuText(device, baud) {
  const { port, error } = await openSerial(device, baud || 38400);
  if (error) return fail(error);
  try {
    const { error: werr, buf } = await serialTransact(
      port,
      Buffer.from("FA;", "ascii"),
      500,
    );
    if (werr) return fail(werr);
    const text = buf ? buf.toString("ascii") : "";
    const m = text.match(/FA(\d{8,11})/i);
    if (!m)
      return fail("No FA reply (check baud/CAT)", { reply: text.slice(0, 80) });
    // FA is in Hz (often 8–11 digits)
    const hz = parseInt(m[1], 10);
    let mode = null;
    const md = await serialTransact(port, Buffer.from("MD0;", "ascii"), 400);
    if (!md.error && md.buf) {
      const mt = md.buf.toString("ascii");
      const mm = mt.match(/MD0([0-9A-Ea-e])/);
      if (mm) mode = YAESU_TEXT_MD[mm[1].toUpperCase()] || mm[1];
    }
    const mhz = formatMHz(hz);
    return ok(
      "CAT " + device + " — " + mhz + " MHz" + (mode ? " " + mode : ""),
      {
        device,
        freqHz: hz,
        freqMHz: mhz,
        mode,
        reply: text.trim().slice(0, 80),
      },
    );
  } finally {
    await closeSerial(port);
  }
}

function splitCivFrames(buf) {
  // Split a buffer into complete FE FE ... FD frames
  const frames = [];
  if (!buf || !buf.length) return frames;
  let i = 0;
  while (i < buf.length - 1) {
    if (buf[i] === 0xfe && buf[i + 1] === 0xfe) {
      let j = i + 2;
      while (j < buf.length && buf[j] !== 0xfd) j++;
      if (j < buf.length) {
        frames.push(buf.slice(i, j + 1));
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return frames;
}

function civReplyData(frame, expectCmd) {
  // Parse a single frame: FE FE to from [cmd...] FD
  // Prefer radio reply: to === 0xE0
  if (!frame || frame.length < 6) return null;
  if (frame[0] !== 0xfe || frame[1] !== 0xfe) return null;
  const to = frame[2];
  const from = frame[3];
  const cmd = frame[4];
  if (expectCmd != null && cmd !== expectCmd) return null;
  const data = frame.slice(5, frame.length - 1); // before FD
  return { to, from, cmd, data, frame };
}

function icomBcdFreqHz(data) {
  // CI-V freq is 5 BCD bytes, little-endian, 1 Hz resolution
  // Validate each nibble is 0-9
  if (!data || data.length < 5) return null;
  let hz = 0;
  let mul = 1;
  for (let i = 0; i < 5; i++) {
    const b = data[i];
    const lo = b & 0x0f;
    const hi = (b >> 4) & 0x0f;
    if (lo > 9 || hi > 9) return null;
    hz += lo * mul + hi * mul * 10;
    mul *= 100;
  }
  return hz;
}

const ICOM_MODE = {
  0x00: "LSB",
  0x01: "USB",
  0x02: "AM",
  0x03: "CW",
  0x04: "RTTY",
  0x05: "FM",
  0x07: "CW-R",
  0x08: "RTTY-R",
  0x17: "DV",
};

async function probeIcom(device, baud, civAddr) {
  const addr = civAddr != null ? civAddr : 0xa2;
  const { port, error } = await openSerial(device, baud || 19200);
  if (error) return fail(error);
  try {
    // Helper: send cmd and collect frames, prefer radio reply (to=E0)
    async function civTxn(cmdBytes, waitMs) {
      const frame = Buffer.concat([
        Buffer.from([0xfe, 0xfe, addr & 0xff, 0xe0]),
        Buffer.from(cmdBytes),
        Buffer.from([0xfd]),
      ]);
      const { error: werr, buf } = await serialTransact(
        port,
        frame,
        waitMs || 450,
      );
      if (werr) return { error: werr, frames: [] };
      const frames = splitCivFrames(buf || Buffer.alloc(0));
      return { error: null, frames, raw: buf };
    }

    // Prefer frame where to==0xE0 and from==addr
    function pickReply(frames, expectCmd) {
      let best = null;
      for (const f of frames) {
        const p = civReplyData(f, expectCmd);
        if (!p) continue;
        if (p.to === 0xe0 && p.from === (addr & 0xff)) return p;
        if (!best) best = p;
      }
      return best;
    }

    // Read selected frequency (after optional MAIN/SUB select)
    async function readSelected() {
      const r = await civTxn([0x03], 450);
      if (r.error) return null;
      const p = pickReply(r.frames, 0x03);
      if (!p || !p.data || p.data.length < 5) return null;
      return icomBcdFreqHz(p.data.slice(0, 5));
    }

    // Try MAIN then SUB
    let mainHz = null;
    let subHz = null;
    // Select MAIN (0x07 D0)
    await civTxn([0x07, 0xd0], 200);
    mainHz = await readSelected();
    // Select SUB (0x07 D1)
    await civTxn([0x07, 0xd1], 200);
    subHz = await readSelected();
    // Restore MAIN
    await civTxn([0x07, 0xd0], 150);

    // Mode on selected (MAIN)
    let mode = null;
    const mr = await civTxn([0x04], 400);
    if (!mr.error) {
      const p = pickReply(mr.frames, 0x04);
      if (p && p.data && p.data.length >= 1) {
        mode = ICOM_MODE[p.data[0]] || "0x" + p.data[0].toString(16);
      }
    }

    const mhzMain = formatMHz(mainHz);
    const mhzSub = formatMHz(subHz);
    let msg = "CI-V " + device;
    if (mhzMain) msg += " MAIN " + mhzMain + " MHz";
    if (mhzSub) msg += " / SUB " + mhzSub + " MHz";
    if (mode) msg += " " + mode;
    if (!mhzMain && !mhzSub) {
      return fail(
        "No CI-V frequency reply (port busy with tracker? turn Radio OFF in UI, or check baud/CI-V 0x" +
          (addr & 0xff).toString(16).toUpperCase() +
          ")",
        {
          device,
          hex: (mr.raw || Buffer.alloc(0)).slice(0, 24).toString("hex"),
        },
      );
    }
    return ok(msg, {
      device,
      freqHz: mainHz,
      freqMHz: mhzMain,
      subHz,
      subMHz: mhzSub,
      mode,
      civAddr: "0x" + (addr & 0xff).toString(16).toUpperCase(),
    });
  } finally {
    await closeSerial(port);
  }
}

const KENWOOD_MODE = {
  1: "LSB",
  2: "USB",
  3: "CW",
  4: "FM",
  5: "AM",
  6: "FSK",
  7: "CW-R",
  8: "FSK-R",
  9: "FM",
};

async function probeKenwood(device, baud) {
  const { port, error } = await openSerial(device, baud || 9600);
  if (error) return fail(error);
  try {
    const { error: werr, buf } = await serialTransact(
      port,
      Buffer.from("IF;", "ascii"),
      500,
    );
    if (werr) return fail(werr);
    const text = buf ? buf.toString("ascii") : "";
    // IF format: IF + 11-digit freq + ... + mode digit around offset 29
    const m = text.match(/IF(\d{11})/);
    if (!m && !text.includes("IF") && !text.includes("FA"))
      return fail("No IF reply (check baud)", { reply: text.slice(0, 80) });
    let hz = null;
    let mode = null;
    if (m) {
      hz = parseInt(m[1], 10);
      // Mode often at fixed position in IF string after freq
      const ifFull = text.match(/IF[^;]{20,};/);
      if (ifFull) {
        const body = ifFull[0];
        // TS-2000: mode is character at index 29 of IF response (0-based within IF...)
        if (body.length > 29) {
          const md = body.charAt(29);
          mode = KENWOOD_MODE[md] || md;
        }
      }
    }
    if (hz == null) {
      const fa = text.match(/FA(\d{11})/);
      if (fa) hz = parseInt(fa[1], 10);
    }
    const mhz = formatMHz(hz);
    return ok(
      "Kenwood " +
        device +
        (mhz ? " — " + mhz + " MHz" : "") +
        (mode ? " " + mode : ""),
      {
        device,
        freqHz: hz,
        freqMHz: mhz,
        mode,
        reply: text.trim().slice(0, 80),
      },
    );
  } finally {
    await closeSerial(port);
  }
}

/**
 * Open TCI WebSocket briefly, collect vfo:/modulation: broadcasts.
 * side: "ul" → prefer rx1, "dl" → prefer rx0
 */
function probeTci(host, port, side) {
  return new Promise((resolve) => {
    const uri = "ws://" + host + ":" + port;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        if (ws) {
          ws.removeAllListeners();
          ws.close();
        }
      } catch (_) {}
      resolve(result);
    };

    let ws;
    try {
      ws = new WebSocket(uri, { handshakeTimeout: 4000 });
    } catch (e) {
      finish(fail("TCI WS open failed: " + (e.message || e)));
      return;
    }

    // rx → { freqHz, mode }
    const state = {
      0: { freqHz: null, mode: null },
      1: { freqHz: null, mode: null },
    };

    const timer = setTimeout(() => {
      const prefer = side === "ul" ? 1 : 0;
      const other = prefer === 0 ? 1 : 0;
      const primary = state[prefer];
      const secondary = state[other];
      const hz = primary.freqHz != null ? primary.freqHz : secondary.freqHz;
      const mode = primary.mode || secondary.mode;
      const mhz = formatMHz(hz);
      if (hz == null && !primary.mode && !secondary.mode) {
        // Connected but no VFO traffic — still a useful connectivity check
        finish(
          ok("TCI connected " + host + ":" + port + " (no VFO data yet)", {
            endpoint: host + ":" + port,
            transport: "tcp",
            protocol: "tci",
            note: "WebSocket up; SDR may not be streaming VFO until radio is active",
          }),
        );
        return;
      }
      const label = side === "ul" ? "UL rx1" : "DL rx0";
      finish(
        ok(
          "TCI " +
            label +
            (mhz ? " — " + mhz + " MHz" : "") +
            (mode ? " " + mode : ""),
          {
            endpoint: host + ":" + port,
            transport: "tcp",
            protocol: "tci",
            side,
            rx: prefer,
            freqHz: hz,
            freqMHz: mhz,
            mode: mode || null,
            rx0: state[0],
            rx1: state[1],
          },
        ),
      );
    }, 2500);

    ws.on("open", () => {
      // Some TCI stacks only stream after a poke; harmless if ignored
      try {
        ws.send("vfo:0,0;");
        ws.send("vfo:1,0;");
        ws.send("modulation:0;");
        ws.send("modulation:1;");
      } catch (_) {}
    });

    ws.on("message", (raw) => {
      const msg = String(raw).trim().replace(/;$/, "");
      if (!msg) return;
      try {
        if (msg.startsWith("vfo:")) {
          const parts = msg.slice(4).split(",");
          const rx = parseInt(parts[0], 10);
          const ch = parseInt(parts[1], 10);
          const freq = parseInt(parts[2], 10);
          if (
            (rx === 0 || rx === 1) &&
            ch === 0 &&
            Number.isFinite(freq) &&
            freq > 0
          ) {
            state[rx].freqHz = freq;
          }
        } else if (msg.toLowerCase().startsWith("modulation:")) {
          // modulation:rx,MODE
          const body = msg.split(":").slice(1).join(":");
          const parts = body.split(",");
          const rx = parseInt(parts[0], 10);
          const mode = (parts[1] || "").trim();
          if ((rx === 0 || rx === 1) && mode) {
            state[rx].mode = mode;
          }
        }
      } catch (_) {}
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      finish(
        fail("TCI WS error: " + (err.message || String(err)), {
          endpoint: host + ":" + port,
        }),
      );
    });

    ws.on("close", () => {
      // if we already finished via timer, ignore
    });
  });
}

/**
 * Probe Hamlib rigctld: force SATMODE off (IC-9700), then read frequency.
 * Net protocol: one command per line; replies are "Hz", "RPRT n", or mode lines.
 */
function probeRigctl(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let buf = "";
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch (_) {}
      resolve(result);
    };

    function takeLine() {
      const i = buf.indexOf("\n");
      if (i < 0) return null;
      const line = buf.slice(0, i).replace(/\r$/, "").trim();
      buf = buf.slice(i + 1);
      return line;
    }

    function waitLine(ms) {
      return new Promise((res) => {
        const start = Date.now();
        const tick = () => {
          const line = takeLine();
          if (line != null) return res(line);
          // Some builds reply without trailing newline until next cmd — accept bare number
          const bare = buf.trim();
          if (/^\d{6,12}$/.test(bare) && Date.now() - start > 150) {
            buf = "";
            return res(bare);
          }
          if (Date.now() - start >= ms) return res(null);
          setTimeout(tick, 30);
        };
        tick();
      });
    }

    async function send(cmd) {
      buf = ""; // discard leftovers between commands
      return new Promise((res, rej) => {
        try {
          socket.write(cmd.endsWith("\n") ? cmd : cmd + "\n", (err) => {
            if (err) rej(err);
            else res();
          });
        } catch (e) {
          rej(e);
        }
      });
    }

    socket.setTimeout(8000);
    socket.on("data", (c) => {
      buf += c.toString("utf8");
    });
    socket.once("timeout", () => finish(fail("Timeout " + host + ":" + port)));
    socket.once("error", (e) => finish(fail(e.message || "TCP error")));

    socket.connect(port, host, async () => {
      try {
        // 1) Clear SAT mode — IC-9700 rejects get_freq (0x25) while SAT is on
        await send("U SATMODE 0");
        const satReply = await waitLine(1200);
        // 2) Read frequency
        await send("f");
        let freqLine = await waitLine(1500);
        // Retry once after SAT clear if rejected
        if (
          freqLine &&
          (/^RPRT\s+-9\b/.test(freqLine) || /rejected/i.test(freqLine))
        ) {
          await send("U SATMODE 0");
          await waitLine(800);
          await send("f");
          freqLine = await waitLine(1500);
        }

        let hz = null;
        if (freqLine) {
          if (!/^RPRT\s+-/.test(freqLine)) {
            const n = parseInt(freqLine.replace(/[^\d].*$/, ""), 10);
            if (Number.isFinite(n) && n > 100000) hz = n; // at least 100 kHz
          }
        }

        // 3) Optional mode (best-effort)
        let mode = null;
        try {
          await send("m");
          const modeLine = await waitLine(800);
          if (modeLine && !/^RPRT\s+-/.test(modeLine)) {
            mode = modeLine.split(/\s+/)[0] || null;
          }
        } catch (_) {}

        const mhz = formatMHz(hz);
        const endpoint = host + ":" + port;
        if (hz == null) {
          finish(
            ok(
              "rigctl " +
                endpoint +
                " (connected; no frequency — is rigctld on the radio? SATMODE?)",
              {
                endpoint,
                transport: "tcp",
                protocol: "rigctl",
                satReply: satReply || null,
                freqReply: freqLine || null,
                freqHz: null,
                freqMHz: null,
              },
            ),
          );
          return;
        }

        finish(
          ok(
            "rigctl " +
              endpoint +
              " — " +
              mhz +
              " MHz" +
              (mode ? " " + mode : ""),
            {
              endpoint,
              transport: "tcp",
              protocol: "rigctl",
              freqHz: hz,
              freqMHz: mhz,
              mode,
              satReply: satReply || null,
            },
          ),
        );
      } catch (e) {
        finish(fail(e.message || String(e)));
      }
    });
  });
}

async function testRadioSide(sideCfg) {
  const s = sideCfg || {};
  const transport = String(s.transport || "tcp").toLowerCase();
  const type = String(s.type || "").toLowerCase();
  const protocol = String(s.protocol || "").toLowerCase();
  const make = String(s.serialMake || "").toLowerCase();
  const model = String(s.serialModel || "").toLowerCase();

  if (transport === "serial") {
    const device = (s.serialDevice || "").trim();
    const baud = parseInt(s.serialBaud, 10) || 9600;
    if (!device) return fail("No serial device selected");
    if (make === "yaesu" || model.indexOf("ft-") === 0) {
      if (
        model.indexOf("817") >= 0 ||
        model.indexOf("818") >= 0 ||
        model.indexOf("847") >= 0
      )
        return probeYaesuBinary(device, baud);
      return probeYaesuText(device, baud);
    }
    if (make === "icom" || model.indexOf("ic-") === 0) {
      // Prefer active IC-9700 driver (already holds the serial port)
      if (model.indexOf("9700") >= 0) {
        try {
          const radios = require("./radios");
          const active =
            typeof radios.active === "function" ? radios.active() : null;
          if (
            active &&
            active.meta &&
            active.meta.id === "ic9700" &&
            typeof active.runConnectionTest === "function"
          ) {
            const st =
              typeof active.getRadioState === "function"
                ? active.getRadioState()
                : null;
            if (st && (st.connected || st.dlConnected)) {
              return active.runConnectionTest();
            }
          }
        } catch (_) {}
      }
      return probeIcom(device, baud, model.indexOf("9700") >= 0 ? 0xa2 : 0xa4);
    }
    if (make === "kenwood" || model.indexOf("ts-") === 0)
      return probeKenwood(device, baud);
    const { port, error } = await openSerial(device, baud);
    if (error) return fail(error);
    await closeSerial(port);
    return ok("Serial port opened " + device + " @ " + baud);
  }

  if (type === "sdrconnect" || type === "sdrplay" || protocol === "websocket") {
    const ep = parseEndpoint(s.sdrconnectEndpoint, "127.0.0.1", 5454);
    const r = await tcpConnect(ep.host, ep.port, 3000);
    if (r.ok) {
      r.detail = Object.assign({}, r.detail || {}, {
        endpoint: ep.host + ":" + ep.port,
        transport: "tcp",
        protocol: "sdrconnect",
      });
      r.message = "SDRconnect TCP " + ep.host + ":" + ep.port;
    }
    return r;
  }
  if (type === "rigctl" || protocol === "rigctl") {
    const ep = parseEndpoint(s.rigctlEndpoint, "127.0.0.1", 4532);
    return probeRigctl(ep.host, ep.port);
  }
  if (protocol === "tci" || type === "aethersdr") {
    const ep = parseEndpoint(s.tciEndpoint, "127.0.0.1", 50001);
    const side =
      String(s._testSide || "dl").toLowerCase() === "ul" ? "ul" : "dl";
    return probeTci(ep.host, ep.port, side);
  }
  const cat = parseEndpoint(s.catEndpoint, "127.0.0.1", 60000);
  if (!s.catEndpoint || !String(s.catEndpoint).trim())
    return fail("No CAT/TCP endpoint set");
  {
    const r = await tcpConnect(cat.host, cat.port, 3000);
    if (r.ok) {
      r.detail = Object.assign({}, r.detail || {}, {
        endpoint: cat.host + ":" + cat.port,
        transport: "tcp",
        protocol: "cat",
      });
      r.message = "CAT TCP " + cat.host + ":" + cat.port;
    }
    return r;
  }
}

/** Held RT-21 sessions: device path → { port, buf, write, readPos } */
const sessions = new Map();

async function sessionClose(device) {
  const s = sessions.get(device);
  if (!s) return;
  sessions.delete(device);
  try {
    if (s.port) {
      s.port.removeAllListeners("data");
      await closeSerial(s.port);
    }
  } catch (_) {}
  // USB-serial adapters need a beat before reopen by live driver
  await sleep(1200);
}

async function sessionOpen(device, baud) {
  if (sessions.has(device)) {
    const existing = sessions.get(device);
    if (existing.port && existing.port.isOpen)
      return ok("session already open", { device });
    await sessionClose(device);
  }
  const { port, error } = await openSerial(device, baud || 4800);
  if (error) return fail(device + ": " + error);

  const state = {
    port,
    device,
    buf: Buffer.alloc(0),
  };
  port.on("data", (c) => {
    state.buf = Buffer.concat([state.buf, c]);
    if (state.buf.length > 4096) state.buf = state.buf.slice(-1024);
  });
  state.write = (str) =>
    new Promise((resolve) => {
      port.write(Buffer.from(str, "ascii"), (err) => {
        if (err) console.warn("Rotor session write", device, err.message);
        resolve(!err);
      });
    });
  state.readPos = async () => {
    state.buf = Buffer.alloc(0);
    await state.write("AI1;");
    await sleep(100);
    const tEnd = Date.now() + 600;
    while (Date.now() < tEnd) {
      if (state.buf.length) break;
      await sleep(30);
    }
    await sleep(50);
    const raw = state.buf.toString("ascii");
    return { pos: parseHeading(raw), raw: raw.slice(0, 60) };
  };

  /** Poll AI1 until near target; call onProgress(pos) each sample for live UI. */
  state.readPosAfterMove = async (target, opts) => {
    const timeoutMs = (opts && opts.timeoutMs) || 8000;
    const settleDeg = (opts && opts.settleDeg) != null ? opts.settleDeg : 2.5;
    const minWait = (opts && opts.minWaitMs) != null ? opts.minWaitMs : 400;
    const onProgress =
      opts && typeof opts.onProgress === "function" ? opts.onProgress : null;
    const useEl = !!(opts && opts.isEl);
    await sleep(minWait);
    const deadline = Date.now() + timeoutMs;
    let last = { pos: null, raw: "" };
    let stable = 0;
    let prev = null;
    while (Date.now() < deadline) {
      last = await state.readPos();
      if (last.pos == null) {
        await sleep(200);
        continue;
      }
      if (onProgress) {
        try {
          onProgress(last.pos, target);
        } catch (_) {}
      }
      const err = useEl
        ? Math.abs(last.pos - target)
        : Math.abs(((last.pos - target + 540) % 360) - 180);
      const close = Number.isFinite(target) ? err <= settleDeg : false;
      if (prev != null && Math.abs(last.pos - prev) < 0.5) stable += 1;
      else stable = 0;
      prev = last.pos;
      if (close && stable >= 1) return last;
      if (stable >= 3) return last;
      await sleep(250);
    }
    return last;
  };

  sessions.set(device, state);
  // wake
  await state.write("AI1;");
  await sleep(150);
  console.log("Rotor test session open", device, baud || 4800);
  return ok("session open " + device, { device });
}

function getSession(device) {
  const s = sessions.get(device);
  if (!s || !s.port || !s.port.isOpen) return null;
  return s;
}

/**
 * Step API:
 *  action: open | read | nudge | goto | close
 *  axis: az | el
 */
async function testRotorStep(msg, hooks) {
  const r = msg || {};
  const onProgress =
    hooks && typeof hooks.onProgress === "function" ? hooks.onProgress : null;
  const action = String(r.action || "read").toLowerCase();
  const axis = String(r.axis || "az").toLowerCase() === "el" ? "el" : "az";
  const type = String(r.rotorType || "rt21").toLowerCase();
  const baud = parseInt(r.rotorBaud, 10) || 4800;
  const azOnly = !!r.rotorAzOnly;

  if (axis === "el" && azOnly) return fail("AZ-only mode — EL test skipped");

  if (type === "gs232") {
    return withTimeout(gs232Step(r, action, axis), 25000, "GS-232 step");
  }

  const device =
    axis === "el"
      ? String(r.rotorElDevice || "").trim()
      : String(r.rotorAzDevice || "").trim();
  if (!device) return fail("No " + axis.toUpperCase() + " serial device");

  return withTimeout(
    (async () => {
      if (action === "open" || action === "session-start") {
        return sessionOpen(device, baud);
      }
      if (action === "close" || action === "session-end") {
        await sessionClose(device);
        return ok("session closed " + device, { device });
      }

      let state = getSession(device);
      if (!state) {
        const opened = await sessionOpen(device, baud);
        if (!opened.ok) return opened;
        state = getSession(device);
        if (!state) return fail("session open failed for " + device);
      }

      if (action === "read") {
        let { pos, raw } = await state.readPos();
        if (pos == null) {
          await sleep(200);
          ({ pos, raw } = await state.readPos());
        }
        if (pos == null)
          return fail(device + ": no AI1 reply", { reply: raw || "(empty)" });
        return ok(
          axis.toUpperCase() + " reads " + Math.round(pos) + "° on " + device,
          { axis, pos, device },
        );
      }

      if (action === "nudge") {
        let from = Number(r.from);
        if (!Number.isFinite(from)) {
          const rd = await state.readPos();
          if (rd.pos == null)
            return fail(device + ": cannot read before nudge");
          from = rd.pos;
        }
        let d = Number.isFinite(Number(r.delta)) ? Number(r.delta) : 10;
        let target;
        // Near stops: reverse delta — respects N-stop or S-stop from form.
        if (axis === "el") {
          if (from + d > 180) d = -Math.abs(d);
          if (from + d < 0) d = Math.abs(d);
          target = Math.max(0, Math.min(180, from + d));
        } else {
          target = safeNudgeAz(from, d, azStopFromCfg(r));
        }
        target = Math.round(target);
        console.log("Rotor test nudge", axis, from, "→", target, device);
        await state.write("AP1" + String(target).padStart(3, "0") + "\r");
        const after = await state.readPosAfterMove(target, {
          isEl: axis === "el",
          minWaitMs: 400,
          timeoutMs: 12000,
          settleDeg: 3,
          onProgress: onProgress
            ? (pos, tgt) =>
                onProgress({ axis, pos, target: tgt, phase: "nudge" })
            : null,
        });
        const pos = after.pos;
        const raw = after.raw;
        if (pos == null) {
          return fail(
            axis.toUpperCase() +
              " commanded " +
              target +
              "° but no position read-back after move",
            { axis, from, target, device, reply: raw },
          );
        }
        console.log(
          "Rotor test nudge read-back",
          axis,
          "target",
          target,
          "actual",
          pos,
        );
        return ok(
          axis.toUpperCase() +
            " moved " +
            Math.round(from) +
            "° → cmd " +
            target +
            "° (reads " +
            Math.round(pos) +
            "°)",
          { axis, from, target, pos, device, reply: raw },
        );
      }

      if (action === "goto") {
        let degrees = Number(r.degrees);
        if (!Number.isFinite(degrees)) return fail("goto requires degrees");
        degrees = Math.round(degrees);
        if (axis === "el") {
          if (degrees < 0) degrees = 0;
          if (degrees > 180) degrees = 180;
        } else {
          degrees = ((degrees % 360) + 360) % 360;
        }
        console.log("Rotor test goto", axis, degrees, device);
        await state.write("AP1" + String(degrees).padStart(3, "0") + "\r");
        const after = await state.readPosAfterMove(degrees, {
          isEl: axis === "el",
          minWaitMs: 400,
          timeoutMs: 12000,
          settleDeg: 3,
          onProgress: onProgress
            ? (pos, tgt) =>
                onProgress({ axis, pos, target: tgt, phase: "goto" })
            : null,
        });
        const pos = after.pos;
        const raw = after.raw;
        if (pos == null) {
          return fail(
            axis.toUpperCase() +
              " commanded " +
              degrees +
              "° but no position read-back",
            { axis, degrees, device, reply: raw },
          );
        }
        console.log(
          "Rotor test goto read-back",
          axis,
          "cmd",
          degrees,
          "actual",
          pos,
        );
        return ok(
          axis.toUpperCase() +
            " returned to cmd " +
            degrees +
            "° (reads " +
            Math.round(pos) +
            "°)",
          { axis, degrees, pos, device, reply: raw },
        );
      }

      return fail("Unknown action " + action);
    })(),
    25000,
    "RT-21 step",
  );
}

function azStopFromCfg(r) {
  const s = String((r && r.rotorAzStop) || "north").toLowerCase();
  return s === "south" || s === "s" ? "south" : "north";
}

/** Nudge AZ without crossing the configured mechanical stop. */
function safeNudgeAz(from, delta, stop) {
  let d = Number(delta) || 0;
  if (stop === "south") {
    // Crossing 180° is forbidden
    if (from < 180 && from + d > 180) d = -Math.abs(d);
    if (from > 180 && from + d < 180) d = Math.abs(d);
  } else {
    // Crossing 0/360 is forbidden
    if (from + d > 360) d = -Math.abs(d);
    if (from + d < 0) d = Math.abs(d);
  }
  let target = from + d;
  if (stop === "north") {
    if (target > 360) target = 360;
    if (target < 0) target = 0;
  }
  return target;
}

async function gs232Step(r, action, axis) {
  const device = String(r.rotorAzDevice || r.rotorDevice || "").trim();
  if (!device) return fail("No GS-232 serial device");
  const baud = parseInt(r.rotorBaud, 10) || 9600;

  // GS-232: also use held session under same key
  if (action === "close" || action === "session-end") {
    await sessionClose(device);
    return ok("session closed " + device);
  }

  let state = getSession(device);
  if (!state || action === "open" || action === "session-start") {
    if (state) await sessionClose(device);
    const { port, error } = await openSerial(device, baud);
    if (error) return fail(device + ": " + error);
    state = {
      port,
      device,
      buf: Buffer.alloc(0),
      kind: "gs232",
    };
    port.on("data", (c) => {
      state.buf = Buffer.concat([state.buf, c]);
    });
    state.write = (s) =>
      new Promise((resolve) => {
        const payload = s.endsWith("\r") ? s : s + "\r";
        port.write(Buffer.from(payload, "ascii"), (err) => resolve(!err));
      });
    state.readC2 = async () => {
      state.buf = Buffer.alloc(0);
      await state.write("C2");
      await sleep(500);
      const raw = state.buf.toString("binary");
      // Fox Delta ST2 returns "+0089+0028". NEVER match /(\d{3})/ alone —
      // that turns "+0089" into 8 (and "+0090" into 9).
      const s = String(raw)
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
        .replace(/\r/g, " ")
        .replace(/\n/g, " ")
        .trim();
      console.log("GS-232 test C2 raw:", JSON.stringify(s.slice(0, 80)));
      let az = null;
      let el = 0;
      let m = s.match(
        /AZ\s*=?\s*([+-]?\d+(?:\.\d+)?)\s*EL\s*=?\s*([+-]?\d+(?:\.\d+)?)/i,
      );
      if (m) {
        az = parseFloat(m[1]);
        el = parseFloat(m[2]);
      }
      if (az == null) {
        m = s.match(/([+-]\d{3,5})\s*([+-]\d{3,5})/);
        if (m) {
          az = parseFloat(m[1]);
          el = parseFloat(m[2]);
        }
      }
      if (az == null) {
        const runs = s.match(/\d{2,4}/g) || [];
        const decode = (t) => {
          if (/^0\d{3}$/.test(t)) return parseInt(t.slice(1), 10);
          return parseInt(t, 10);
        };
        if (runs.length >= 1) az = decode(runs[0]);
        if (runs.length >= 2) el = decode(runs[1]);
      }
      if (!Number.isFinite(az)) az = null;
      if (!Number.isFinite(el)) el = 0;
      return { az, el, raw: s.slice(0, 80) };
    };
    sessions.set(device, state);
    if (action === "open" || action === "session-start")
      return ok("session open " + device, { device });
  }

  const pos = await state.readC2();
  if (pos.az == null) return fail(device + ": no C2 position", pos);

  if (action === "read") {
    const v = axis === "el" ? pos.el : pos.az;
    const rawHint = pos.raw ? " raw=" + JSON.stringify(pos.raw) : "";
    return ok(axis.toUpperCase() + " reads " + v + "° on " + device + rawHint, {
      axis,
      pos: v,
      az: pos.az,
      el: pos.el,
      device,
      raw: pos.raw,
    });
  }

  const wcmd = (a, e) =>
    "W" +
    String(Math.round(a)).padStart(3, "0") +
    " " +
    String(Math.round(e)).padStart(3, "0");

  if (action === "nudge") {
    let from = Number(r.from);
    if (!Number.isFinite(from)) from = axis === "el" ? pos.el : pos.az;
    let d = Number.isFinite(Number(r.delta)) ? Number(r.delta) : 10;
    let az = pos.az;
    let el = pos.el;
    // Near stops: reverse delta instead of commanding past the limit.
    if (axis === "el") {
      const elMax = 180;
      if (from + d > elMax) d = -Math.abs(d);
      if (from + d < 0) d = Math.abs(d);
      el = Math.max(0, Math.min(elMax, from + d));
    } else {
      az = safeNudgeAz(from, d, azStopFromCfg(r));
    }
    await state.write(wcmd(az, el));
    await sleep(2500);
    const after = await state.readC2();
    const v = axis === "el" ? after.el : after.az;
    return ok(axis.toUpperCase() + " nudged → " + (v != null ? v + "°" : "?"), {
      axis,
      from,
      pos: v,
      target: axis === "el" ? el : az,
      az: after.az,
      el: after.el,
      device,
    });
  }

  if (action === "goto") {
    let degrees = Number(r.degrees);
    if (!Number.isFinite(degrees)) return fail("goto requires degrees");
    let az = pos.az;
    let el = pos.el;
    if (axis === "el") el = Math.max(0, Math.min(90, Math.round(degrees)));
    else az = Math.round(degrees) % 360;
    await state.write(wcmd(az, el));
    await sleep(2500);
    const after = await state.readC2();
    return ok(
      axis.toUpperCase() + " returned to " + Math.round(degrees) + "°",
      { axis, degrees, az: after.az, el: after.el, device },
    );
  }

  return fail("Unknown action " + action);
}

async function testRotor(rotorCfg) {
  // legacy: full auto path still available
  const r = rotorCfg || {};
  const open = await testRotorStep(
    Object.assign({}, r, { action: "open", axis: "az" }),
  );
  if (!open.ok) return open;
  try {
    const read = await testRotorStep(
      Object.assign({}, r, { action: "read", axis: "az" }),
    );
    if (!read.ok) return read;
    const from = read.detail.pos;
    const nudge = await testRotorStep(
      Object.assign({}, r, { action: "nudge", axis: "az", from, delta: 10 }),
    );
    if (!nudge.ok) return nudge;
    await testRotorStep(
      Object.assign({}, r, { action: "goto", axis: "az", degrees: from }),
    );
    return ok("AZ OK", { az: from });
  } finally {
    await testRotorStep(Object.assign({}, r, { action: "close", axis: "az" }));
  }
}

module.exports = {
  testRadioSide,
  testRotor,
  testRotorStep,
};
