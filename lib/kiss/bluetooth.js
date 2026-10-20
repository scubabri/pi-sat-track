/**
 * KISS over Bluetooth Classic RFCOMM (SPP) by MAC address, no `rfcomm bind`:
 * a tiny stdlib-only Python helper (rfcomm-bridge.py) owns the RFCOMM socket
 * and bridges it to stdin/stdout. The Transport base class does the
 * reconnect with backoff, so a radio turned off / on reconnects by itself.
 *
 * Why a helper: Node has no AF_BLUETOOTH sockets and the npm RFCOMM modules
 * need native builds against libbluetooth; Linux CPython ships RFCOMM sockets
 * in the standard library (Raspberry Pi OS / Debian / Ubuntu python3).
 *
 * Target radios: Kenwood TH-D74 / TH-D75 (SPP on RFCOMM channel 2). Any SPP
 * KISS TNC works (Mobilinkd classic, BTECH UV-Pro, ...): set its channel.
 */
const path = require("path");
const { spawn: nodeSpawn, execFile } = require("child_process");
const { Transport } = require("./transport");

const HELPER = path.join(__dirname, "rfcomm-bridge.py");
const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;

/** "aa-bb-cc-dd-ee-ff" / "AABBCCDDEEFF" / "aa:bb:…" -> "AA:BB:CC:DD:EE:FF" or "". */
function normalizeMac(s) {
  const h = String(s || "").toUpperCase().replace(/[^0-9A-F]/g, "");
  if (h.length !== 12) return "";
  const m = h.match(/../g).join(":");
  return MAC_RE.test(m) ? m : "";
}

/** errno name from the helper -> message for the status line / Test result. */
function friendlyError(name, ch, detail) {
  switch (name) {
    case "EHOSTDOWN":
    case "EHOSTUNREACH":
    case "ETIMEDOUT":
      return "radio not reachable (off, out of range, or Bluetooth off on the radio)";
    case "ECONNREFUSED":
      return "refused on RFCOMM channel " + ch + " (wrong channel, or the radio's KISS interface is not set to Bluetooth)";
    case "EACCES":
    case "EPERM":
      return "permission denied / authentication failed (pair and trust the radio with bluetoothctl)";
    case "EBUSY":
      return "busy (the radio's serial port is in use: another computer / phone, or an rfcomm bind/connect)";
    case "ENODEV":
    case "EADDRNOTAVAIL":
    case "ENETDOWN":
      return "no Bluetooth adapter available (BlueZ not running, or blocked: sudo rfkill unblock bluetooth)";
    case "EAFNOSUPPORT":
    case "EPROTONOSUPPORT":
    case "ENOBTSOCK":
      return "this system has no Bluetooth socket support (no BlueZ kernel stack / Python without Bluetooth)";
    case "EOF":
    case "ECONNRESET":
    case "ECONNABORTED":
    case "ENOTCONN":
      return "link lost (radio turned off or out of range)";
    case "EINVAL":
      return "invalid Bluetooth address or channel";
    case "ENOENT":
      return "python3 not found (needed for Bluetooth)";
    default:
      return (detail || name || "failed").trim();
  }
}

function btError(name, ch, detail) {
  const e = new Error("Bluetooth: " + friendlyError(name, ch, detail));
  e.btCode = name;
  return e;
}

class BluetoothTransport extends Transport {
  /**
   * opts: address (MAC), channel (RFCOMM, default 2 = TH-D74/D75 SPP),
   * python ("python3"), connectTimeoutS (15), spawn (injectable for tests),
   * diagnose (fn(mac) -> Promise<string|null>, or false; default bluetoothctl info).
   */
  constructor(opts) {
    super(Object.assign({ reconnectInitialMs: 2000, reconnectMaxMs: 60000 }, opts));
    const o = opts || {};
    this.address = normalizeMac(o.address || o.mac);
    this.channel = parseInt(o.channel, 10) || 2;
    this.python = o.python || "python3";
    this.connectTimeoutS = o.connectTimeoutS || 15;
    this._spawn = o.spawn || nodeSpawn;
    this._diagnose = o.diagnose === false ? null : o.diagnose || diagnosePairing;
    this.cp = null;
  }
  describe() {
    return "bluetooth " + (this.address || "(no address)") + " ch " + this.channel;
  }
  _open() {
    if (!this.address) {
      this._failed(btError("EINVAL", this.channel));
      return;
    }
    const cp = this._spawn(this.python, [HELPER, this.address, String(this.channel), String(this.connectTimeoutS)], { stdio: ["pipe", "pipe", "pipe"] });
    this.cp = cp;
    let errLine = "";
    let lastErr = null;
    const mine = () => this.cp === cp;
    cp.stdout.on("data", (b) => {
      if (mine()) this._data(b);
    });
    cp.stderr.on("data", (b) => {
      errLine += b.toString("utf8");
      let i;
      while ((i = errLine.indexOf("\n")) >= 0) {
        const line = errLine.slice(0, i).trim();
        errLine = errLine.slice(i + 1);
        if (!mine()) continue;
        if (line === "OK connected") this._opened();
        else {
          const m = line.match(/^ERR (\S+) (\S+) ?(.*)$/);
          if (m) lastErr = btError(m[2], this.channel, m[3]);
        }
      }
    });
    cp.stdin.on("error", () => {});
    cp.on("error", (e) => {
      if (mine()) this._failed(btError(e && e.code === "ENOENT" ? "ENOENT" : (e && e.code) || "", this.channel, e && e.message));
    });
    cp.on("exit", (code) => {
      if (!mine()) return;
      const e = lastErr || btError("", this.channel, "helper exited (" + code + ")");
      const was = this.state;
      this._failed(e);
      // "not paired" is clearer than the errno for a never-paired radio
      if (was === "connecting" && this._diagnose && ["EACCES", "EPERM", "EHOSTDOWN", "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH"].includes(e.btCode)) {
        Promise.resolve(this._diagnose(this.address))
          .then((msg) => {
            if (msg && this.state === "waiting" && this.lastError === e.message) this.lastError = "Bluetooth: " + msg;
          })
          .catch(() => {});
      }
    });
  }
  _close() {
    const cp = this.cp;
    this.cp = null;
    if (!cp) return;
    try {
      cp.stdin.end();
    } catch (_) {}
    try {
      cp.kill("SIGTERM");
    } catch (_) {}
  }
  _write(buf) {
    if (!this.cp) return false;
    this.cp.stdin.write(buf);
    return true;
  }
}

/* ---------- BlueZ helpers (bluetoothctl) ---------- */

function run(cmd, args, timeoutMs, exec) {
  const ex = exec || execFile;
  return new Promise((resolve) => {
    ex(cmd, args, { timeout: timeoutMs || 5000, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({ err, out: String(stdout || ""), errOut: String(stderr || "") });
    });
  });
}

/** "not paired" / "unknown to BlueZ" for a failed connect, else null. */
async function diagnosePairing(mac, exec) {
  const r = await run("bluetoothctl", ["info", mac], 4000, exec);
  if (r.err && r.err.code === "ENOENT") return "BlueZ (bluetoothctl) not installed";
  const t = r.out + r.errOut;
  if (/not available|not found/i.test(t)) return "radio " + mac + " is not known to this computer: pair it first (bluetoothctl pair " + mac + ")";
  if (/Paired:\s*no/i.test(t)) return "radio " + mac + " is not paired: bluetoothctl pair " + mac + " && bluetoothctl trust " + mac;
  return null;
}

/** Paired devices via bluetoothctl: {ok, devices:[{mac,name}], error}. */
async function listPaired(opts) {
  const exec = opts && opts.exec;
  const show = await run("bluetoothctl", ["show"], 4000, exec);
  if (show.err && show.err.code === "ENOENT") return { ok: false, devices: [], error: "BlueZ (bluetoothctl) not installed: sudo apt install bluez" };
  const st = show.out + show.errOut;
  if (/No default controller/i.test(st)) return { ok: false, devices: [], error: "no Bluetooth adapter (or blocked: sudo rfkill unblock bluetooth)" };
  if (/Access denied|not authorized|Permission/i.test(st)) return { ok: false, devices: [], error: "not allowed to talk to BlueZ (add the user to the bluetooth group, then log in again)" };
  const powered = /Powered:\s*yes/i.test(st) ? true : /Powered:\s*no/i.test(st) ? false : null;
  // BlueZ >= 5.66: "devices Paired"; older: "paired-devices"
  let r = await run("bluetoothctl", ["devices", "Paired"], 4000, exec);
  if (r.err || /Invalid|Too many/i.test(r.out + r.errOut) || !/Device /.test(r.out)) {
    const r2 = await run("bluetoothctl", ["paired-devices"], 4000, exec);
    if (/Device /.test(r2.out)) r = r2;
  }
  const devices = [];
  for (const line of r.out.split(/\r?\n/)) {
    const m = line.match(/Device\s+(([0-9A-F]{2}:){5}[0-9A-F]{2})\s*(.*)$/i);
    if (m && !devices.some((d) => d.mac === m[1].toUpperCase())) devices.push({ mac: m[1].toUpperCase(), name: m[3].trim() });
  }
  return { ok: true, devices, powered, error: powered === false ? "Bluetooth adapter is powered off (bluetoothctl power on)" : "" };
}

/**
 * One-shot connect for Configure → Test: open the RFCOMM link, count KISS
 * frames for listenMs, close. Never writes. Resolves like testKissTcp.
 */
function testBluetooth(mac, channel, opts) {
  const o = opts || {};
  const kissLib = require("./kiss");
  const t = new BluetoothTransport(Object.assign({ address: mac, channel, autoReconnect: false }, o));
  const target = "Bluetooth " + (t.address || mac || "?") + " ch " + t.channel;
  return new Promise((resolve) => {
    const t0 = Date.now();
    let ms = 0;
    let frames = 0;
    let sample = "";
    let finished = false;
    let timer = null;
    const dec = new kissLib.Decoder();
    const done = (r) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      t.removeAllListeners();
      t.on("error", () => {});
      t.close();
      resolve(Object.assign({ target, ms: ms || Date.now() - t0, frames, sample }, r));
    };
    t.on("error", () => {});
    t.on("data", (b) => {
      for (const f of dec.push(b)) {
        if (f.cmd !== kissLib.CMD.DATA) continue;
        frames++;
        if (!sample) {
          try {
            const fr = require("../ax25").decode(f.data);
            if (fr) sample = require("../ax25").toTnc2(fr).slice(0, 120);
          } catch (_) {}
        }
      }
    });
    t.on("open", () => {
      ms = Date.now() - t0;
      timer = setTimeout(() => done({ ok: true }), o.listenMs != null ? o.listenMs : 3000);
    });
    t.on("state", (s) => {
      if (s === "closed" && !finished) done(ms ? { ok: true, closedByPeer: true } : { ok: false, error: (t.lastError || "failed").replace(/^Bluetooth: /, ""), code: "EBT" });
    });
    t.open();
  });
}

module.exports = { BluetoothTransport, normalizeMac, friendlyError, listPaired, diagnosePairing, testBluetooth, run, HELPER };
