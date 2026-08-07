/**
 * One-shot connection tests for config UI (radio UL/DL + rotor).
 * Rotor steps use a held serial session per device so open/close
 * races between read → nudge → goto do not lock the USB adapter.
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
        const d = Number.isFinite(Number(r.delta)) ? Number(r.delta) : 10;
        let target;
        if (axis === "el") {
          target = from + d;
          if (target > 180) target = Math.max(0, from - d);
          if (target < 0) target = 0;
        } else {
          target = (from + d) % 360;
          if (target < 0) target += 360;
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
      await sleep(400);
      const raw = state.buf.toString("ascii");
      const nums = raw.match(/(\d{3})/g);
      const az = nums && nums[0] ? parseInt(nums[0], 10) : null;
      const el = nums && nums[1] ? parseInt(nums[1], 10) : 0;
      return { az, el, raw: raw.slice(0, 40) };
    };
    sessions.set(device, state);
    if (action === "open" || action === "session-start")
      return ok("session open " + device, { device });
  }

  const pos = await state.readC2();
  if (pos.az == null) return fail(device + ": no C2 position", pos);

  if (action === "read") {
    const v = axis === "el" ? pos.el : pos.az;
    return ok(axis.toUpperCase() + " reads " + v + "° on " + device, {
      axis,
      pos: v,
      az: pos.az,
      el: pos.el,
      device,
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
    const d = Number.isFinite(Number(r.delta)) ? Number(r.delta) : 10;
    let az = pos.az;
    let el = pos.el;
    if (axis === "el") el = Math.max(0, Math.min(90, from + d));
    else az = (from + d) % 360;
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
