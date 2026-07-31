/**
 * Icom CI-V radio driver (IC-705 and other Icom models).
 * Standalone — not yet wired into state/server.
 *
 * Protocol: Icom CI-V over USB CDC ACM (or serial)
 *   Default address : 0xA4  (IC-705)
 *   Baud            : 19200
 *   Frame           : FE FE <to> <from> <cmd> [data...] FD
 *
 * Commands used:
 *   03  – Read operating frequency
 *   05  – Set operating frequency (5 BCD bytes, LSB first)
 *
 * Future: mode, split, PTT, additional Icom models (IC-7300, IC-9700, …)
 */

const { SerialPort } = require("serialport");
const config = require("../config");

let port = null;
let connected = false;
let busy = false;
let lastFreqHz = null;
let buf = "";
let broadcastFn = () => {};

function init(opts) {
  if (opts && opts.broadcast) broadcastFn = opts.broadcast;
}

function statusPayload() {
  return {
    type: "icom",
    connected,
    device: config.CAT_DEVICE,
    baud: config.CAT_BAUD,
    civAddr: config.CAT_CIV_ADDR,
    lastFreqHz,
  };
}

function broadcastStatus() {
  broadcastFn(statusPayload());
}

function freqToBcd(freqHz) {
  const s = String(Math.round(freqHz)).padStart(10, "0");
  const bcd = [];
  for (let i = 0; i < 10; i += 2) {
    const high = parseInt(s[i], 10);
    const low = parseInt(s[i + 1], 10);
    bcd.push((high << 4) | low);
  }
  return Buffer.from(bcd.reverse());
}

function bcdToFreq(data) {
  if (!data || data.length !== 5) {
    throw new Error("Expected 5 BCD frequency bytes");
  }
  let freq = 0;
  let mult = 1;
  for (const b of data) {
    const low = b & 0x0f;
    const high = (b >> 4) & 0x0f;
    freq += low * mult;
    mult *= 10;
    freq += high * mult;
    mult *= 10;
  }
  return freq;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function writeRaw(data) {
  return new Promise((resolve) => {
    if (!port || !connected) {
      resolve(false);
      return;
    }
    port.write(data, (err) => {
      if (err) {
        console.warn("Icom write failed:", err.message);
        resolve(false);
        return;
      }
      port.drain(() => resolve(true));
    });
  });
}

/**
 * Send a CI-V command and collect the reply.
 * command = Buffer of cmd + optional data (no FE/FE/addr/FD)
 */
async function sendCiv(command) {
  if (!port || !connected) throw new Error("Icom not connected");
  if (busy) throw new Error("Icom busy");

  busy = true;
  try {
    buf = "";
    const frame = Buffer.concat([
      Buffer.from([0xfe, 0xfe, config.CAT_CIV_ADDR, 0xe0]),
      command,
      Buffer.from([0xfd]),
    ]);
    const ok = await writeRaw(frame);
    if (!ok) throw new Error("Icom write failed");

    // Collect reply (up to ~200 ms)
    const tEnd = Date.now() + 200;
    while (Date.now() < tEnd) {
      if (buf.includes(String.fromCharCode(0xfd))) break;
      await sleep(15);
    }
    await sleep(30);

    const reply = Buffer.from(buf, "binary");
    buf = "";
    return reply;
  } finally {
    busy = false;
  }
}

async function open() {
  if (port && connected) return true;

  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    try {
      const p = new SerialPort({
        path: config.CAT_DEVICE,
        baudRate: config.CAT_BAUD,
        dataBits: 8,
        parity: "none",
        stopBits: 1,
        autoOpen: false,
      });

      const timer = setTimeout(() => {
        try {
          p.close();
        } catch (_) {}
        console.warn("Icom open timeout", config.CAT_DEVICE);
        done(false);
      }, 3000);

      p.open((err) => {
        if (err) {
          clearTimeout(timer);
          console.warn("Icom open failed:", err.message);
          done(false);
          return;
        }
        clearTimeout(timer);
        port = p;
        connected = true;
        buf = "";

        p.on("data", (chunk) => {
          buf += chunk.toString("binary");
          if (buf.length > 4096) buf = buf.slice(-1024);
        });
        p.on("close", () => {
          console.log("Icom closed");
          connected = false;
          port = null;
          buf = "";
          broadcastStatus();
        });
        p.on("error", (e) => {
          console.warn("Icom error:", e.message);
        });

        console.log(
          "Icom open",
          config.CAT_DEVICE,
          config.CAT_BAUD,
          "addr 0x" + config.CAT_CIV_ADDR.toString(16).toUpperCase(),
        );
        broadcastStatus();
        done(true);
      });
    } catch (e) {
      console.warn("Icom exception:", e.message);
      done(false);
    }
  });
}

function close() {
  if (port) {
    try {
      port.close();
    } catch (_) {}
    port = null;
  }
  connected = false;
  busy = false;
  buf = "";
  lastFreqHz = null;
  broadcastStatus();
  console.log("Icom disconnected");
}

/**
 * Set operating frequency (Hz).
 * Returns true on FB (OK), false on FA (NG) or error.
 */
async function setFrequency(freqHz) {
  if (!Number.isFinite(freqHz) || freqHz < 1e5 || freqHz > 5e8) {
    throw new Error("Frequency out of range: " + freqHz);
  }
  const bcd = freqToBcd(freqHz);
  const reply = await sendCiv(Buffer.concat([Buffer.from([0x05]), bcd]));

  console.log(
    "Icom set",
    (freqHz / 1e6).toFixed(6),
    "MHz →",
    reply.toString("hex"),
  );

  if (reply.includes(0xfb)) {
    lastFreqHz = Math.round(freqHz);
    broadcastStatus();
    return true;
  }
  if (reply.includes(0xfa)) {
    console.warn("Icom NG (FA) on setFrequency");
    return false;
  }
  // Some firmwares echo the frequency instead of FB
  try {
    const idx = reply.indexOf(0x05);
    if (idx >= 0 && reply.length >= idx + 6) {
      lastFreqHz = bcdToFreq(reply.slice(idx + 1, idx + 6));
      broadcastStatus();
      return true;
    }
  } catch (_) {}
  return false;
}

/**
 * Read current operating frequency (Hz).
 * Returns frequency in Hz or null on failure.
 */
async function getFrequency() {
  const reply = await sendCiv(Buffer.from([0x03]));
  console.log("Icom get →", reply.toString("hex"));

  try {
    const idx = reply.indexOf(0x03);
    if (idx < 0 || reply.length < idx + 6) {
      throw new Error("No frequency data in reply");
    }
    const freq = bcdToFreq(reply.slice(idx + 1, idx + 6));
    lastFreqHz = freq;
    broadcastStatus();
    return freq;
  } catch (e) {
    console.warn("Icom getFrequency parse failed:", e.message);
    return null;
  }
}

function getIcomState() {
  return {
    connected,
    device: config.CAT_DEVICE,
    baud: config.CAT_BAUD,
    civAddr: config.CAT_CIV_ADDR,
    lastFreqHz,
  };
}

module.exports = {
  init,
  open,
  close,
  setFrequency,
  getFrequency,
  getIcomState,
  getCatState: getIcomState, // alias for older callers
  statusPayload,
  broadcastStatus,
};
