/**
 * One-shot connection tests for config UI (radio UL/DL + rotor).
 * Opens temporary links, probes, closes — does not enable tracking.
 */
const net = require("net");
const { SerialPort } = require("serialport");

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
          " (port busy? Turn Antenna OFF and close other apps using this device)",
      });
    }, 3000);
    port.on("error", (e) => {
      if (settled) return;
      // non-fatal until open callback
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
            ? " — port in use. Turn Antenna OFF in the UI, wait a second, retry."
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
      if (port.isOpen) {
        port.close(() => resolve());
      } else resolve();
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

/** Match RT-21 driver parseHeading */
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

async function probeYaesuBinary(device, baud) {
  const { port, error } = await openSerial(device, baud || 38400, {
    stopBits: 2,
  });
  if (error) return fail(error);
  try {
    const cmd = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x03]);
    const { error: werr, buf } = await serialTransact(port, cmd, 500);
    if (werr) return fail(werr);
    if (!buf || buf.length < 5)
      return fail("No frequency reply (check baud/CAT rate)");
    return ok("CAT reply " + buf.length + " bytes from " + device, {
      hex: buf.slice(0, 5).toString("hex"),
    });
  } finally {
    await closeSerial(port);
  }
}

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
    if (!/FA/i.test(text))
      return fail("No FA reply (check baud/CAT)", { reply: text.slice(0, 80) });
    return ok("CAT FA reply from " + device, {
      reply: text.trim().slice(0, 80),
    });
  } finally {
    await closeSerial(port);
  }
}

async function probeIcom(device, baud, civAddr) {
  const addr = civAddr != null ? civAddr : 0xa4;
  const { port, error } = await openSerial(device, baud || 19200);
  if (error) return fail(error);
  try {
    const cmd = Buffer.from([0xfe, 0xfe, addr & 0xff, 0xe0, 0x03, 0xfd]);
    const { error: werr, buf } = await serialTransact(port, cmd, 500);
    if (werr) return fail(werr);
    if (!buf || buf.length < 6)
      return fail("No CI-V reply (check baud/CI-V address)");
    return ok("CI-V reply " + buf.length + " bytes from " + device, {
      hex: buf.slice(0, 12).toString("hex"),
    });
  } finally {
    await closeSerial(port);
  }
}

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
    if (!text.includes("IF") && !text.includes("FA"))
      return fail("No IF reply (check baud)", { reply: text.slice(0, 80) });
    return ok("Kenwood reply from " + device, {
      reply: text.trim().slice(0, 80),
    });
  } finally {
    await closeSerial(port);
  }
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
    if (make === "icom" || model.indexOf("ic-") === 0)
      return probeIcom(device, baud, model.indexOf("9700") >= 0 ? 0xa2 : 0xa4);
    if (make === "kenwood" || model.indexOf("ts-") === 0)
      return probeKenwood(device, baud);
    const { port, error } = await openSerial(device, baud);
    if (error) return fail(error);
    await closeSerial(port);
    return ok("Serial port opened " + device + " @ " + baud);
  }

  if (type === "sdrconnect" || type === "sdrplay" || protocol === "websocket") {
    const ep = parseEndpoint(s.sdrconnectEndpoint, "127.0.0.1", 5454);
    return tcpConnect(ep.host, ep.port, 3000);
  }
  if (type === "rigctl" || protocol === "rigctl") {
    const ep = parseEndpoint(s.rigctlEndpoint, "127.0.0.1", 4532);
    return tcpExchange(ep.host, ep.port, Buffer.from("f\n"), 400, 4000);
  }
  if (protocol === "tci" || type === "aethersdr") {
    const ep = parseEndpoint(s.tciEndpoint, "127.0.0.1", 50001);
    return tcpConnect(ep.host, ep.port, 3000);
  }
  const cat = parseEndpoint(s.catEndpoint, "127.0.0.1", 60000);
  if (!s.catEndpoint || !String(s.catEndpoint).trim())
    return fail("No CAT/TCP endpoint set");
  return tcpConnect(cat.host, cat.port, 3000);
}

/**
 * RT-21 axis: AI1; read, AP1nnn move +delta, return.
 * deltaDeg applied to AZ-style 0-360; for EL keep within 0..elMax.
 */
async function probeRt21Axis(device, baud, deltaDeg, isEl) {
  console.log("Rotor probe open", device, baud);
  const { port, error } = await openSerial(device, baud || 4800);
  if (error) return fail(device + ": " + error);

  let buf = Buffer.alloc(0);
  const onData = (c) => {
    buf = Buffer.concat([buf, c]);
  };
  port.on("data", onData);

  const write = (s) =>
    new Promise((resolve) => {
      port.write(Buffer.from(s, "ascii"), (err) => {
        if (err) console.warn("Rotor write", device, err.message);
        resolve(!err);
      });
    });

  const readPos = async () => {
    buf = Buffer.alloc(0);
    await write("AI1;");
    await sleep(100);
    const tEnd = Date.now() + 500;
    while (Date.now() < tEnd) {
      if (buf.length) break;
      await sleep(30);
    }
    await sleep(50);
    const raw = buf.toString("ascii");
    const pos = parseHeading(raw);
    return { pos, raw: raw.slice(0, 60) };
  };

  try {
    // wake / clear
    await write("AI1;");
    await sleep(200);

    let { pos: pos0, raw: raw0 } = await readPos();
    if (pos0 == null) {
      // one retry
      await sleep(200);
      const second = await readPos();
      pos0 = second.pos;
      raw0 = second.raw;
    }
    if (pos0 == null) {
      return fail(device + ": no position reply (AI1)", {
        reply: raw0 || "(empty)",
      });
    }

    const delta = deltaDeg != null ? deltaDeg : 10;
    let target;
    if (isEl) {
      const maxEl = 180;
      target = pos0 + delta;
      if (target > maxEl) target = Math.max(0, pos0 - delta);
      if (target < 0) target = 0;
    } else {
      target = (pos0 + delta) % 360;
      if (target < 0) target += 360;
    }
    target = Math.round(target);

    console.log("Rotor probe", device, "pos", pos0, "→", target);
    await write("AP1" + String(target).padStart(3, "0") + "\r");
    await sleep(2000);

    await readPos(); // optional mid-check

    await write("AP1" + String(Math.round(pos0)).padStart(3, "0") + "\r");
    await sleep(2000);

    const { pos: pos1, raw: raw1 } = await readPos();

    return ok(
      device +
        ": " +
        Math.round(pos0) +
        "° → " +
        target +
        "° → back" +
        (pos1 != null ? " (now " + Math.round(pos1) + "°)" : ""),
      { start: pos0, target, end: pos1, reply: raw1 },
    );
  } finally {
    port.removeListener("data", onData);
    await closeSerial(port);
    // USB-serial cooldown so the live driver can reopen
    await sleep(400);
  }
}

async function probeGs232(device, baud, azOnly, deltaDeg) {
  console.log("GS-232 probe open", device, baud);
  const { port, error } = await openSerial(device, baud || 9600);
  if (error) return fail(device + ": " + error);
  let buf = Buffer.alloc(0);
  const onData = (c) => {
    buf = Buffer.concat([buf, c]);
  };
  port.on("data", onData);
  try {
    const write = (s) =>
      new Promise((resolve) => {
        const payload = s.endsWith("\r") ? s : s + "\r";
        port.write(Buffer.from(payload, "ascii"), (err) => resolve(!err));
      });

    buf = Buffer.alloc(0);
    await write("C2");
    await sleep(400);
    const raw = buf.toString("ascii");
    const nums = raw.match(/(\d{3})/g);
    if (!nums || nums.length < 1)
      return fail(device + ": no C2 position", { reply: raw.slice(0, 40) });
    const az0 = parseInt(nums[0], 10);
    const el0 = nums.length > 1 ? parseInt(nums[1], 10) : 0;
    let az1 = (az0 + (deltaDeg || 10)) % 360;

    const wcmd = (a, e) =>
      "W" +
      String(Math.round(a)).padStart(3, "0") +
      " " +
      String(Math.round(e)).padStart(3, "0");

    await write(wcmd(az1, el0));
    await sleep(2000);
    await write(wcmd(az0, el0));
    await sleep(2000);

    return ok(
      device + ": AZ " + az0 + "° → +" + (deltaDeg || 10) + "° → back",
      { az: az0, el: el0 },
    );
  } finally {
    port.removeListener("data", onData);
    await closeSerial(port);
    await sleep(400);
  }
}

let rotorTestRunning = false;

async function testRotor(rotorCfg) {
  if (rotorTestRunning) {
    return fail("Rotor test already in progress — wait for it to finish");
  }
  rotorTestRunning = true;
  try {
    return await withTimeout(testRotorInner(rotorCfg), 45000, "Rotor test");
  } finally {
    rotorTestRunning = false;
  }
}

async function testRotorInner(rotorCfg) {
  const r = rotorCfg || {};
  const type = String(r.rotorType || "rt21").toLowerCase();
  const baud = parseInt(r.rotorBaud, 10) || 4800;
  const azOnly = !!r.rotorAzOnly;
  const delta = 10;

  if (type === "gs232") {
    const dev = (r.rotorAzDevice || r.rotorDevice || "").trim();
    if (!dev) return fail("No GS-232 serial device");
    return probeGs232(dev, baud || 9600, azOnly, delta);
  }

  const azDev = (r.rotorAzDevice || "").trim();
  const elDev = (r.rotorElDevice || "").trim();
  if (!azDev) return fail("No AZ serial device");

  const azResult = await probeRt21Axis(azDev, baud, delta, false);
  if (!azResult.ok) return azResult;

  if (azOnly || !elDev) {
    return ok("AZ OK — " + azResult.message, azResult.detail);
  }
  if (elDev === azDev) {
    return fail("AZ and EL devices are the same port — check config");
  }

  const elResult = await probeRt21Axis(elDev, baud, delta, true);
  if (!elResult.ok) {
    return fail("AZ OK; EL failed — " + elResult.message, {
      az: azResult.detail,
      el: elResult.detail,
    });
  }

  return ok("AZ + EL OK — " + azResult.message + "; " + elResult.message, {
    az: azResult.detail,
    el: elResult.detail,
  });
}

module.exports = {
  testRadioSide,
  testRotor,
};
