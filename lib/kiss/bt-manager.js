/**
 * Bluetooth scan / pair / unpair / power for Configure → KISS / APRS, so
 * nobody needs a terminal. Drives BlueZ through `bluetoothctl` (ships with
 * bluez on every distro; works for a user in the "bluetooth" group, no
 * root): an interactive session for discovery and for pairing (its built-in
 * agent prints PIN / passkey prompts that we relay to the browser), one-shot
 * commands for the rest. D-Bus would need a native-ish npm dependency
 * (dbus-next) and its own agent object; bluetoothctl is the stable, widely
 * documented CLI over the same D-Bus API.
 *
 * Kenwood TH-D74 (manual, "Pairing the transceiver with a PC"): Menu 934
 * pairing mode (60 s); with Secure Simple Pairing a passkey shows on the PC
 * and the radio, confirm on the PC and press [A/B] on the radio; with
 * Bluetooth 2.0 or older adapters the PC asks for a PIN: 0000.
 *
 * Events ("update", payload) for the UI:
 *   {op:"scan", state:"scanning"|"done"|"error", devices:[{mac,name,rssi,paired,trusted,likely}], endsAt, error, canPowerOn}
 *   {op:"pair", state:"pairing"|"prompt"|"done"|"error", mac, prompt:{kind:"pin"|"passkey"|"confirm"|"display", code}, error}
 */
const { EventEmitter } = require("events");
const { spawn: nodeSpawn } = require("child_process");
const { run, normalizeMac, listPaired } = require("./bluetooth");

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x01|\x02/g;
const LIKELY = /TH-?D7[45]|UV-?PRO|VR-?N7[56]|GA-?5WB|BTECH|Mobilinkd|TNC|KISS|Kenwood|APRS|Radioddity/i;
const MAC = "([0-9A-F]{2}(?::[0-9A-F]{2}){5})";

/** One bluetoothctl output line without colours and prompt prefixes. */
function cleanLine(s) {
  return String(s)
    .replace(ANSI, "")
    .replace(/\r/g, "")
    .replace(/^(\[[^\]]*\][#>]\s*)+/, "") // "[bluetooth]# " / "[TH-D74]# "
    .trim();
}

/** BlueZ error -> message. */
function pairError(text, mac) {
  const t = String(text || "");
  if (/AlreadyExists/i.test(t)) return null; // already paired: fine
  if (/not available|DoesNotExist|not found/i.test(t)) return "device " + mac + " not found: scan again with the radio in pairing mode (TH-D74/D75: Menu 934)";
  if (/AuthenticationTimeout|ConnectionAttemptFailed|Page Timeout|timed? ?out/i.test(t)) return "pairing timed out: is the radio still in pairing mode (TH-D74/D75: Menu 934, 60 s)?";
  if (/AuthenticationRejected|AuthenticationCanceled|Canceled/i.test(t)) return "pairing rejected or cancelled on the radio";
  if (/AuthenticationFailed/i.test(t)) return "pairing failed (wrong PIN / code not confirmed on the radio)";
  if (/NotReady|Blocked|powered/i.test(t)) return "Bluetooth adapter is off or blocked";
  if (/Access denied|NotAuthorized|not authorized|Permission/i.test(t)) return "not allowed to talk to BlueZ (add the user to the bluetooth group, then log in again)";
  return "pairing failed (" + t.replace(/^.*?(org\.bluez\.Error\.\w+).*$/, "$1").slice(0, 80) + ")";
}

/** Adapter check via `bluetoothctl show`: {ok, error, canPowerOn}. */
async function adapterState(exec) {
  const r = await run("bluetoothctl", ["show"], 4000, exec);
  if (r.err && r.err.code === "ENOENT") return { ok: false, error: "BlueZ (bluetoothctl) not installed: sudo apt install bluez" };
  const t = cleanAll(r.out + r.errOut);
  if (/No default controller/i.test(t)) return { ok: false, error: "no Bluetooth adapter found" };
  if (/Access denied|not authorized|Permission/i.test(t)) return { ok: false, error: "not allowed to talk to BlueZ (add the user to the bluetooth group, then log in again)" };
  if (/PowerState:\s*off-blocked/i.test(t)) return { ok: false, error: "Bluetooth is blocked (rfkill)", canPowerOn: true, blocked: true };
  if (/Powered:\s*no/i.test(t)) return { ok: false, error: "Bluetooth adapter is powered off", canPowerOn: true };
  if (r.err && !/Controller/i.test(t)) return { ok: false, error: "BlueZ not answering (is the bluetooth service running? sudo systemctl enable --now bluetooth)" };
  return { ok: true };
}
const cleanAll = (s) => String(s || "").split("\n").map(cleanLine).join("\n");

class BtManager extends EventEmitter {
  /** opts: spawn / exec (injectable), scanMs (18000), pairTimeoutMs (60000) */
  constructor(opts) {
    super();
    const o = opts || {};
    this._spawn = o.spawn || nodeSpawn;
    this._exec = o.exec || null;
    this.scanMs = o.scanMs || 18000;
    this.pairTimeoutMs = o.pairTimeoutMs || 60000;
    this.scan = null; // {cp, devices: Map, endsAt, timer, owner, id}
    this.pairing = null; // {cp, mac, timer, prompt, owner, id}
  }
  _session() {
    const cp = this._spawn("bluetoothctl", [], { stdio: ["pipe", "pipe", "pipe"] });
    cp.stdin.on("error", () => {});
    const lines = new EventEmitter();
    let buf = "";
    const feed = (b) => {
      buf += b.toString("utf8");
      // prompts ("Enter PIN code:", "(yes/no):") end without a newline
      const parts = buf.split(/\n/);
      buf = parts.pop();
      for (const p of parts) lines.emit("line", cleanLine(p));
      if (/(:|\(yes\/no\):)\s*$/.test(cleanLine(buf)) && /\[agent\]|PIN|passkey|yes\/no/i.test(buf)) {
        lines.emit("line", cleanLine(buf));
        buf = "";
      }
    };
    cp.stdout.on("data", feed);
    cp.stderr.on("data", feed);
    const send = (cmd) => {
      try {
        cp.stdin.write(cmd + "\n");
      } catch (_) {}
    };
    return { cp, lines, send };
  }
  _end(s) {
    if (!s) return;
    try {
      s.send("quit");
      s.cp.stdin.end();
    } catch (_) {}
    const cp = s.cp;
    const t = setTimeout(() => {
      try {
        cp.kill("SIGTERM");
      } catch (_) {}
    }, 1500);
    if (t.unref) t.unref();
  }

  /* ---------- scan ---------- */
  scanPayload(extra) {
    const s = this.scan;
    const devices = s ? [...s.devices.values()].sort((a, b) => b.likely - a.likely || (b.rssi || -999) - (a.rssi || -999) || a.mac.localeCompare(b.mac)) : [];
    return Object.assign({ op: "scan", state: s && s.running ? "scanning" : "done", devices, endsAt: s ? s.endsAt : 0, id: s ? s.id : "" }, extra);
  }
  _emitScan(extra) {
    const s = this.scan;
    if (!s) return;
    if (extra) return this.emit("update", this.scanPayload(extra));
    if (s.emitTimer) return;
    s.emitTimer = setTimeout(() => {
      s.emitTimer = null;
      this.emit("update", this.scanPayload());
    }, 300);
  }
  async startScan(opts) {
    const o = opts || {};
    if (this.scan && this.scan.running) return this.scanPayload({ note: "already scanning" });
    const ad = await adapterState(this._exec);
    if (!ad.ok) {
      const p = { op: "scan", state: "error", devices: [], error: ad.error, canPowerOn: !!ad.canPowerOn, id: o.id || "" };
      this.emit("update", p);
      return p;
    }
    if (this.scan && this.scan.running) return this.scanPayload({ note: "already scanning" });
    const paired = await listPaired({ exec: this._exec });
    const trusted = await run("bluetoothctl", ["devices", "Trusted"], 4000, this._exec);
    const trustedSet = new Set((trusted.out.match(new RegExp("Device " + MAC, "gi")) || []).map((x) => x.slice(7).toUpperCase()));
    const sess = this._session();
    const s = { sess, devices: new Map(), endsAt: Date.now() + this.scanMs, running: true, owner: o.owner || null, id: o.id || "", emitTimer: null };
    this.scan = s;
    const dev = (mac) => {
      mac = mac.toUpperCase();
      let d = s.devices.get(mac);
      if (!d) {
        d = { mac, name: "", rssi: null, paired: false, trusted: trustedSet.has(mac), likely: false };
        s.devices.set(mac, d);
      }
      return d;
    };
    for (const p of paired.devices || []) Object.assign(dev(p.mac), { name: p.name, paired: true });
    sess.lines.on("line", (l) => {
      let m;
      if ((m = l.match(new RegExp("^\\[NEW\\] Device " + MAC + "\\s*(.*)$", "i")))) {
        const d = dev(m[1]);
        if (m[2] && !/^([0-9A-F]{2}-){5}[0-9A-F]{2}$/i.test(m[2])) d.name = d.name || m[2];
      } else if ((m = l.match(new RegExp("^\\[CHG\\] Device " + MAC + " (\\w+): (.*)$", "i")))) {
        const d = dev(m[1]);
        const k = m[2];
        const v = m[3].trim();
        if (k === "Name" || (k === "Alias" && !d.name)) d.name = v;
        else if (k === "RSSI") {
          const n = v.match(/\((-?\d+)\)|^(-?\d+)$/);
          d.rssi = n ? Number(n[1] || n[2]) : d.rssi;
        } else if (k === "Paired") d.paired = /yes/i.test(v);
        else if (k === "Trusted") d.trusted = /yes/i.test(v);
      } else if ((m = l.match(new RegExp("^\\[DEL\\] Device " + MAC, "i")))) {
        const d = s.devices.get(m[1].toUpperCase());
        if (d && !d.paired) s.devices.delete(d.mac);
      } else if (/Failed to start discovery|org\.bluez\.Error\.(NotReady|Failed)/i.test(l) && !/InProgress/i.test(l)) {
        this.stopScan({ state: "error", error: /NotReady/i.test(l) ? "Bluetooth adapter is not ready (powered off?)" : "could not start discovery (" + l.slice(0, 80) + ")", canPowerOn: /NotReady/i.test(l) });
        return;
      } else return;
      for (const d of s.devices.values()) d.likely = LIKELY.test(d.name);
      this._emitScan();
    });
    sess.cp.on("exit", () => {
      if (this.scan === s && s.running) this.stopScan();
    });
    sess.cp.on("error", (e) => {
      if (this.scan === s) this.stopScan({ state: "error", error: e && e.code === "ENOENT" ? "BlueZ (bluetoothctl) not installed: sudo apt install bluez" : String(e && e.message) });
    });
    sess.send("scan on");
    s.timer = setTimeout(() => this.stopScan(), this.scanMs);
    for (const d of s.devices.values()) d.likely = LIKELY.test(d.name);
    const p = this.scanPayload();
    this.emit("update", p);
    return p;
  }
  stopScan(extra) {
    const s = this.scan;
    if (!s || !s.running) return this.scanPayload();
    s.running = false;
    clearTimeout(s.timer);
    if (s.emitTimer) clearTimeout(s.emitTimer);
    s.emitTimer = null;
    s.sess.send("scan off");
    this._end(s.sess);
    const p = this.scanPayload(Object.assign({ state: "done" }, extra));
    this.emit("update", p);
    return p;
  }
  /** A client went away (Configure closed / socket closed): stop its scan. */
  release(owner) {
    if (this.scan && this.scan.running && this.scan.owner === owner) this.stopScan();
    if (this.pairing && this.pairing.owner === owner) this.cancelPair();
  }

  /* ---------- pair ---------- */
  pair(macIn, opts) {
    const o = opts || {};
    const mac = normalizeMac(macIn);
    if (!mac) return Promise.resolve(this._pairDone(null, { state: "error", mac: String(macIn || ""), error: "invalid Bluetooth address", id: o.id || "" }));
    if (this.pairing) return Promise.resolve({ op: "pair", state: "error", mac, error: "another pairing is in progress", id: o.id || "" });
    if (this.scan && this.scan.running) this.stopScan();
    return new Promise((resolve) => {
      const sess = this._session();
      const p = { sess, mac, owner: o.owner || null, id: o.id || "", prompt: null, resolve, phase: "pair" };
      this.pairing = p;
      p.timer = setTimeout(() => this._pairDone(p, { state: "error", error: "pairing timed out: is the radio still in pairing mode (TH-D74/D75: Menu 934, 60 s)?" }), this.pairTimeoutMs);
      const prompt = (kind, code) => {
        p.prompt = { kind, code: code || "" };
        this.emit("update", { op: "pair", state: "prompt", mac, prompt: p.prompt, id: p.id });
      };
      sess.lines.on("line", (l) => {
        if (this.pairing !== p) return;
        let m;
        if (/^\[agent\] Enter PIN code/i.test(l)) prompt("pin");
        else if (/^\[agent\] Enter passkey/i.test(l)) prompt("passkey");
        else if ((m = l.match(/^\[agent\] (?:Confirm passkey|Request confirmation)\D*(\d{6})/i))) prompt("confirm", m[1]);
        else if ((m = l.match(/^\[agent\] (?:Passkey|PIN code):\s*(\d+)/i))) prompt("display", m[1]);
        else if (/^\[agent\] Authorize service/i.test(l)) sess.send("yes");
        else if (/Pairing successful/i.test(l) || (p.phase === "pair" && /AlreadyExists/i.test(l))) {
          p.phase = "trust";
          p.prompt = null;
          this.emit("update", { op: "pair", state: "pairing", mac, step: "trust", id: p.id });
          sess.send("trust " + mac);
        } else if (p.phase === "trust" && /trust succeeded/i.test(l)) this._pairDone(p, { state: "done", trusted: true });
        else if (p.phase === "trust" && /Failed to set trusted|trust failed/i.test(l)) this._pairDone(p, { state: "done", trusted: false, warning: "paired, but could not mark it trusted" });
        else if (p.phase === "pair" && (/^Failed to pair/i.test(l) || /Device \S+ not available/i.test(l) || /org\.bluez\.Error\.(Authentication\w+|ConnectionAttemptFailed|Failed|DoesNotExist|NotReady)/i.test(l))) {
          const err = pairError(l, mac);
          if (err) this._pairDone(p, { state: "error", error: err });
        }
      });
      sess.cp.on("error", (e) => this._pairDone(p, { state: "error", error: e && e.code === "ENOENT" ? "BlueZ (bluetoothctl) not installed: sudo apt install bluez" : String(e && e.message) }));
      sess.cp.on("exit", () => {
        if (this.pairing === p) this._pairDone(p, { state: "error", error: "bluetoothctl exited during pairing" });
      });
      sess.send("agent KeyboardDisplay");
      sess.send("default-agent");
      sess.send("pair " + mac);
      this.emit("update", { op: "pair", state: "pairing", mac, step: "pair", id: p.id });
    });
  }
  /** Answer the current prompt: PIN / passkey digits, or true/false for a confirm. */
  pairReply(answer) {
    const p = this.pairing;
    if (!p || !p.prompt) return false;
    const k = p.prompt.kind;
    if (k === "confirm") p.sess.send(answer === true || /^(y|yes|true)$/i.test(String(answer)) ? "yes" : "no");
    else if (k === "pin") {
      const pin = String(answer == null ? "" : answer).replace(/[^0-9A-Za-z]/g, "").slice(0, 16);
      if (!pin) return false;
      p.sess.send(pin);
    } else if (k === "passkey") {
      const n = String(answer == null ? "" : answer).replace(/\D/g, "").slice(0, 6);
      if (!n) return false;
      p.sess.send(n);
    } else return false;
    p.prompt = null;
    this.emit("update", { op: "pair", state: "pairing", mac: p.mac, step: "pair", id: p.id });
    return true;
  }
  cancelPair() {
    const p = this.pairing;
    if (!p) return false;
    p.sess.send("cancel-pairing " + p.mac);
    this._pairDone(p, { state: "error", error: "pairing cancelled" });
    return true;
  }
  _pairDone(p, r) {
    const out = Object.assign({ op: "pair", mac: p ? p.mac : r.mac, id: p ? p.id : r.id || "" }, r);
    if (p) {
      if (this.pairing !== p) return out;
      this.pairing = null;
      clearTimeout(p.timer);
      this._end(p.sess);
      p.resolve(out);
    }
    this.emit("update", out);
    return out;
  }

  /* ---------- one-shot ---------- */
  async unpair(macIn) {
    const mac = normalizeMac(macIn);
    if (!mac) return { op: "unpair", ok: false, error: "invalid Bluetooth address" };
    const r = await run("bluetoothctl", ["remove", mac], 6000, this._exec);
    if (r.err && r.err.code === "ENOENT") return { op: "unpair", ok: false, mac, error: "BlueZ (bluetoothctl) not installed" };
    const t = cleanAll(r.out + r.errOut);
    if (/Device has been removed/i.test(t)) return { op: "unpair", ok: true, mac };
    if (/not available|DoesNotExist/i.test(t)) return { op: "unpair", ok: true, mac, note: "was not paired" };
    if (/Access denied|NotAuthorized|Permission/i.test(t)) return { op: "unpair", ok: false, mac, error: "not allowed to talk to BlueZ (bluetooth group)" };
    return { op: "unpair", ok: false, mac, error: "could not remove (" + t.trim().split("\n").pop().slice(0, 80) + ")" };
  }
  /** Power the adapter on; if rfkill blocks it, try `rfkill unblock bluetooth` (works when permitted). */
  async powerOn() {
    let r = await run("bluetoothctl", ["power", "on"], 6000, this._exec);
    if (r.err && r.err.code === "ENOENT") return { op: "power", ok: false, error: "BlueZ (bluetoothctl) not installed" };
    let t = cleanAll(r.out + r.errOut);
    if (/power on succeeded/i.test(t)) return { op: "power", ok: true };
    if (/Blocked|rfkill/i.test(t)) {
      const u = await run("rfkill", ["unblock", "bluetooth"], 4000, this._exec);
      if (!u.err) {
        r = await run("bluetoothctl", ["power", "on"], 6000, this._exec);
        t = cleanAll(r.out + r.errOut);
        if (/power on succeeded/i.test(t)) return { op: "power", ok: true, unblocked: true };
      }
      return { op: "power", ok: false, error: "Bluetooth is blocked by rfkill and this user may not unblock it: run sudo rfkill unblock bluetooth (install-pi.sh --update does this)" };
    }
    if (/No default controller/i.test(t)) return { op: "power", ok: false, error: "no Bluetooth adapter found" };
    if (/Access denied|NotAuthorized|Permission/i.test(t)) return { op: "power", ok: false, error: "not allowed to talk to BlueZ (bluetooth group)" };
    return { op: "power", ok: false, error: "could not power on (" + t.trim().split("\n").pop().slice(0, 80) + ")" };
  }
}

module.exports = { BtManager, cleanLine, pairError, adapterState, LIKELY };
