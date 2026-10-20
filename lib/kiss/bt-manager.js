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
const nodeFs = require("fs");
const nodePath = require("path");
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

const SOFT_CMD = "sudo rfkill unblock bluetooth";
const SOFT_MSG = "Bluetooth is soft-blocked by the system. Run: " + SOFT_CMD;
const HARD_MSG = "Bluetooth is hard-blocked: a hardware / firmware switch (or BIOS setting) disables it; software cannot unblock it";
const BUSY_CMD = "sudo systemctl restart bluetooth";

/**
 * rfkill state of the Bluetooth radios without root: /sys/class/rfkill/<n>/
 * {type, soft, hard, name} (world-readable). env: {fs, rfkillDir}.
 * -> {known, soft, hard, devices:[{name, soft, hard}]}
 */
function rfkillState(env) {
  const fs = (env && env.fs) || nodeFs;
  const dir = (env && env.rfkillDir) || "/sys/class/rfkill";
  const rd = (f) => {
    try {
      return String(fs.readFileSync(nodePath.join(dir, f), "utf8")).trim();
    } catch (_) {
      return "";
    }
  };
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return { known: false, soft: false, hard: false, devices: [] };
  }
  const devices = [];
  for (const n of names) {
    if (rd(n + "/type") !== "bluetooth") continue;
    devices.push({ name: rd(n + "/name") || n, soft: rd(n + "/soft") === "1", hard: rd(n + "/hard") === "1" });
  }
  return { known: devices.length > 0, soft: devices.some((d) => d.soft), hard: devices.some((d) => d.hard), devices };
}
const rfkillText = (rf) => (!rf.known ? "rfkill: no Bluetooth entry" : "rfkill " + rf.devices.map((d) => d.name + " soft " + (d.soft ? "blocked" : "no") + ", hard " + (d.hard ? "blocked" : "no")).join("; "));

/**
 * Raspberry Pi: dtoverlay=disable-bt / pi3-disable-bt in config.txt turns the
 * built-in Bluetooth off at boot. env: {fs, configFiles}. -> {file, line} | null
 */
function configTxtBt(env) {
  const fs = (env && env.fs) || nodeFs;
  const files = (env && env.configFiles) || ["/boot/firmware/config.txt", "/boot/config.txt"];
  for (const f of files) {
    let t;
    try {
      t = String(fs.readFileSync(f, "utf8"));
    } catch (_) {
      continue;
    }
    for (const raw of t.split(/\r?\n/)) {
      const l = raw.replace(/#.*$/, "").trim();
      if (/^dtoverlay\s*=\s*(pi3-)?disable-bt(-pi5)?\s*(,|$)/i.test(l)) return { file: f, line: l };
    }
  }
  return null;
}
const configMsg = (c) => "Bluetooth disabled in config.txt (" + c.line + " in " + c.file + "): remove or comment out that line and reboot";

/** Run rfkill (often /usr/sbin, not on a normal user's PATH). */
async function runRfkill(args, exec) {
  let r = await run("rfkill", args, 4000, exec);
  if (r.err && r.err.code === "ENOENT") r = await run("/usr/sbin/rfkill", args, 4000, exec);
  return r;
}

/** Adapter check via `bluetoothctl show`: {ok, error, canPowerOn}. env: rfkill / config.txt readers. */
async function adapterState(exec, env) {
  const r = await run("bluetoothctl", ["show"], 4000, exec);
  if (r.err && r.err.code === "ENOENT") return { ok: false, error: "BlueZ (bluetoothctl) not installed: sudo apt install bluez" };
  const t = cleanAll(r.out + r.errOut);
  if (/No default controller/i.test(t)) {
    const c = configTxtBt(env);
    return c ? { ok: false, error: configMsg(c), configTxt: c } : { ok: false, error: "no Bluetooth adapter found" };
  }
  if (/Access denied|not authorized|Permission/i.test(t)) return { ok: false, error: "not allowed to talk to BlueZ (add the user to the bluetooth group, then log in again)" };
  if (/PowerState:\s*off-blocked/i.test(t) || /Powered:\s*no/i.test(t)) {
    const rf = rfkillState(env);
    if (rf.hard) return { ok: false, error: HARD_MSG, hard: true };
    if (rf.soft || /off-blocked/i.test(t)) return { ok: false, error: SOFT_MSG, copy: SOFT_CMD, retry: true, canPowerOn: true, blocked: true };
    return { ok: false, error: "Bluetooth adapter is powered off", canPowerOn: true };
  }
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
    this._env = { fs: o.fs, rfkillDir: o.rfkillDir, configFiles: o.configFiles };
    /** Busy / NotReady after an unblock: retry power on after these delays (~10 s). */
    this.powerRetryMs = o.powerRetryMs || [500, 1000, 2000, 4000, 2500];
    this._sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this._logFn = o.log === false ? null : o.log || { log: (m) => console.log(m), warn: (m) => console.warn(m) };
    this.scan = null; // {cp, devices: Map, endsAt, timer, owner, id}
    this.pairing = null; // {cp, mac, timer, prompt, owner, id}
  }
  _log(level, m) {
    const l = this._logFn;
    if (!l) return;
    if (typeof l === "function") return l(m, level);
    (l[level] || l.log)(m);
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
    const ad = await adapterState(this._exec, this._env);
    if (!ad.ok) {
      const p = Object.assign({ op: "scan", state: "error", devices: [], error: ad.error, canPowerOn: !!ad.canPowerOn, id: o.id || "" }, ad.copy ? { copy: ad.copy, retry: true } : {});
      this._log("warn", "Bluetooth: scan not started: " + ad.error);
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
    this._log("log", "Bluetooth: scan started (" + Math.round(this.scanMs / 1000) + " s)");
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
    const likely = p.devices.filter((d) => d.likely).map((d) => d.name || d.mac);
    if (p.state === "error") this._log("warn", "Bluetooth: scan stopped: " + p.error);
    else this._log("log", "Bluetooth: scan stopped, " + p.devices.length + " device(s) found" + (likely.length ? " (likely radios: " + likely.slice(0, 5).join(", ") + ")" : ""));
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
      this._log("log", "Bluetooth: pairing " + mac + "…");
      p.timer = setTimeout(() => this._pairDone(p, { state: "error", error: "pairing timed out: is the radio still in pairing mode (TH-D74/D75: Menu 934, 60 s)?" }), this.pairTimeoutMs);
      const prompt = (kind, code) => {
        p.prompt = { kind, code: code || "" };
        this._log("log", "Bluetooth: pairing " + mac + " asks for " + (kind === "pin" ? "a PIN" : kind === "passkey" ? "a passkey" : kind === "confirm" ? "passkey confirmation" : "a code shown on the radio") + " (answer in Configure)");
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
    this._log("log", "Bluetooth: pairing " + p.mac + " " + (k === "confirm" ? (p.sess && /^(y|yes|true)$/i.test(String(answer)) || answer === true ? "confirmed" : "rejected") : k + " entered") + " in Configure");
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
    if (out.state === "done") this._log("log", "Bluetooth: paired " + out.mac + (out.trusted ? " and trusted" : out.warning ? " (" + out.warning + ")" : ""));
    else this._log("warn", "Bluetooth: pairing " + (out.mac || "?") + " failed: " + out.error);
    this.emit("update", out);
    return out;
  }

  /* ---------- one-shot ---------- */
  async unpair(macIn) {
    const r = await this._unpair(macIn);
    this._log(r.ok ? "log" : "warn", "Bluetooth: remove " + (r.mac || macIn) + (r.ok ? " ok" + (r.note ? " (" + r.note + ")" : "") : " failed: " + r.error));
    return r;
  }
  async _unpair(macIn) {
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
  /**
   * Power the adapter on. rfkill is read from sysfs before and after; a soft
   * block is unblocked when this user may (else the exact sudo command is
   * returned to copy), a hard block is reported as such. After an unblock
   * BlueZ answers Busy / NotReady while the adapter initializes: retried
   * with backoff (~10 s) before giving up.
   * -> {op:"power", ok, error, copy, retry, hard, unblocked, rfkill}
   */
  async powerOn() {
    const res = await this._powerOn();
    this._log(res.ok ? "log" : "warn", "Bluetooth: power on " + (res.ok ? "ok" + (res.unblocked ? " (unblocked)" : "") + (res.attempts > 1 ? " after " + res.attempts + " tries" : "") : "failed: " + res.error) + " [" + res.rfkill + "]");
    return res;
  }
  async _powerOn() {
    const env = this._env;
    let rf = rfkillState(env);
    const out = (o) => Object.assign({ op: "power", rfkill: rfkillText(rf) }, o);
    const cfg = configTxtBt(env);
    if (cfg && !rf.known) return out({ ok: false, error: configMsg(cfg), configTxt: cfg });
    if (rf.hard) return out({ ok: false, error: HARD_MSG, hard: true });
    let unblocked = false;
    if (rf.soft) {
      const u = await runRfkill(["unblock", "bluetooth"], this._exec);
      rf = rfkillState(env); // trust the state, not rfkill's exit code
      if (rf.soft) return out({ ok: false, error: SOFT_MSG, copy: SOFT_CMD, retry: true, detail: u.err ? cleanAll(u.errOut || u.err.message).trim().slice(0, 80) : "" });
      unblocked = true;
    }
    let attempts = 0;
    let t = "";
    for (;;) {
      attempts++;
      const r = await run("bluetoothctl", ["power", "on"], 6000, this._exec);
      if (r.err && r.err.code === "ENOENT") return out({ ok: false, error: "BlueZ (bluetoothctl) not installed: sudo apt install bluez" });
      t = cleanAll(r.out + r.errOut);
      if (/power on succeeded/i.test(t)) return out({ ok: true, unblocked, attempts });
      if (/org\.bluez\.Error\.(Busy|NotReady)|\bBusy\b/i.test(t) && attempts <= this.powerRetryMs.length) {
        await this._sleep(this.powerRetryMs[attempts - 1]);
        continue;
      }
      break;
    }
    if (/Busy|NotReady/i.test(t)) return out({ ok: false, error: "Bluetooth adapter still busy after unblocking (" + attempts + " tries). Run: " + BUSY_CMD + ", then Retry", copy: BUSY_CMD, retry: true, attempts });
    if (/No default controller/i.test(t)) return out({ ok: false, error: cfg ? configMsg(cfg) : "no Bluetooth adapter found", configTxt: cfg || undefined });
    if (/Access denied|NotAuthorized|Permission/i.test(t)) return out({ ok: false, error: "not allowed to talk to BlueZ (bluetooth group)" });
    if (/Blocked|Failed|rfkill/i.test(t)) {
      // org.bluez.Error.Failed while rfkill-blocked: say what it is, not the raw BlueZ text
      rf = rfkillState(env);
      if (rf.hard) return out({ ok: false, error: HARD_MSG, hard: true });
      if (rf.soft || /Blocked/i.test(t)) return out({ ok: false, error: SOFT_MSG, copy: SOFT_CMD, retry: true });
      if (cfg) return out({ ok: false, error: configMsg(cfg), configTxt: cfg });
      return out({ ok: false, error: "could not power on (" + (t.match(/org\.bluez\.Error\.\w+/) || ["failed"])[0] + "). Run: " + BUSY_CMD + ", then Retry", copy: BUSY_CMD, retry: true });
    }
    return out({ ok: false, error: "could not power on (" + t.trim().split("\n").pop().slice(0, 80) + ")" });
  }
}

module.exports = { BtManager, cleanLine, pairError, adapterState, rfkillState, configTxtBt, LIKELY, SOFT_MSG, SOFT_CMD };
