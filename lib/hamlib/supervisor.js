/**
 * Supervise one long-running Hamlib daemon (rigctld / rotctld).
 *
 *   const sv = new Supervisor({ name, bin, args, port, spawn, log, warn })
 *   await sv.start()   spawn; resolves when the TCP port accepts (or the
 *                      process died / timed out: resolves false, restarts)
 *   await sv.stop()    SIGTERM, then kill after 3 s; no restart
 *
 * Crash -> restart after a backoff (1, 2, 5, 10, 30 s …); the backoff resets
 * once a run lasted 60 s. stderr / stdout lines go to the log, prefixed.
 * spawn / connect / timers are injectable for tests (fake process).
 */
const EventEmitter = require("events");
const net = require("net");

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const STABLE_MS = 60000;

function tcpProbe(host, port, ms) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => {
      s.removeAllListeners();
      s.on("error", () => {});
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(ms || 500, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

class Supervisor extends EventEmitter {
  constructor(o) {
    super();
    this.name = o.name || "rigctld";
    this.bin = o.bin;
    this.args = (o.args || []).slice();
    this.host = o.host || "127.0.0.1"; // where the ready probe dials
    this.bindHost = o.bindHost || this.host; // what rigctld listens on (-T), for the log
    this.port = o.port;
    this.spawnFn = o.spawn || require("child_process").spawn;
    this.probe = o.probe || tcpProbe;
    this.log = o.log || ((m) => console.log(m));
    this.warn = o.warn || ((m) => console.warn(m));
    this.setTimer = o.setTimeout || setTimeout;
    this.clearTimer = o.clearTimeout || clearTimeout;
    this.now = o.now || Date.now;
    this.readyTimeoutMs = o.readyTimeoutMs || 8000;
    this.backoff = o.backoff || BACKOFF_MS;
    this.stableMs = o.stableMs || STABLE_MS;
    this.child = null;
    this.wanted = false;
    this.restarts = 0; // consecutive failures (backoff index)
    this.totalRestarts = 0;
    this.timer = null;
    this.state = "stopped"; // stopped | starting | running | waiting | failed
    this.lastError = "";
    this.startedAt = 0;
    this.pid = null;
  }

  status() {
    return {
      name: this.name,
      state: this.state,
      pid: this.pid,
      port: this.port,
      args: this.args.slice(),
      restarts: this.totalRestarts,
      error: this.lastError,
    };
  }

  _set(state, err) {
    this.state = state;
    if (err !== undefined) this.lastError = err;
    this.emit("state", this.status());
  }

  start() {
    this.wanted = true;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.child) return this.readyPromise || Promise.resolve(this.state === "running");
    return this._spawn();
  }

  _spawn() {
    const cmd = this.bin + " " + this.args.join(" ");
    this.log(this.name + ": starting " + cmd);
    this._set("starting", "");
    let child;
    try {
      child = this.spawnFn(this.bin, this.args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      this._exited(null, e.message);
      return Promise.resolve(false);
    }
    this.child = child;
    this.pid = child.pid || null;
    this.startedAt = this.now();
    const lines = (stream, warnIt) => {
      if (!stream) return;
      let buf = "";
      stream.on("data", (d) => {
        buf += String(d);
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const l = buf.slice(0, i).replace(/\r$/, "");
          buf = buf.slice(i + 1);
          if (l.trim()) {
            this.lastLine = l.trim();
            (warnIt ? this.warn : this.log)(this.name + "[" + this.port + "]: " + l);
          }
        }
      });
    };
    lines(child.stdout, false);
    lines(child.stderr, true);
    child.once("error", (e) => {
      if (this.child === child) this._exited(child, e.code === "ENOENT" ? this.bin + " not found" : e.message);
    });
    child.once("exit", (code, sig) => {
      if (this.child === child) this._exited(child, "exited (" + (sig || "code " + code) + ")" + (this.lastLine ? ": " + this.lastLine : ""));
    });
    this.readyPromise = this._waitReady(child);
    return this.readyPromise;
  }

  async _waitReady(child) {
    const t0 = this.now();
    // Ends the wait at once when the process exits (no sleeping on a dead child).
    const gone = new Promise((r) => (this._wakeReady = r));
    while (this.child === child && this.now() - t0 < this.readyTimeoutMs) {
      if (await Promise.race([this.probe(this.host, this.port, 400), gone])) {
        if (this.child !== child) return false;
        this.log(this.name + ": listening on " + this.bindHost + ":" + this.port + " (pid " + this.pid + ")");
        this._set("running", "");
        return true;
      }
      let t;
      await Promise.race([new Promise((r) => (t = this.setTimer(r, 150))), gone]);
      this.clearTimer(t);
    }
    if (this.child === child) {
      this.warn(this.name + ": not listening on " + this.host + ":" + this.port + " after " + this.readyTimeoutMs + " ms — restarting");
      this._kill(child);
    }
    return false;
  }

  _exited(child, why) {
    if (child && this.child !== child) return;
    this.child = null;
    this.pid = null;
    this.readyPromise = null;
    if (this._wakeReady) this._wakeReady(false);
    if (!this.wanted) {
      this._set("stopped");
      this.emit("stopped");
      return;
    }
    const ran = this.startedAt ? this.now() - this.startedAt : 0;
    if (ran >= this.stableMs) this.restarts = 0;
    const delay = this.backoff[Math.min(this.restarts, this.backoff.length - 1)];
    this.restarts++;
    this.totalRestarts++;
    this.warn(this.name + ": " + why + " — restart in " + Math.round(delay / 1000) + " s");
    this._set("waiting", why);
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.wanted && !this.child) this._spawn();
    }, delay);
  }

  _kill(child, sig) {
    try {
      child.kill(sig || "SIGTERM");
    } catch (_) {}
  }

  stop() {
    this.wanted = false;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    const child = this.child;
    if (!child) {
      this._set("stopped");
      return Promise.resolve();
    }
    this.log(this.name + ": stopping (pid " + this.pid + ")");
    return new Promise((resolve) => {
      const hard = this.setTimer(() => this._kill(child, "SIGKILL"), 3000);
      const fin = () => {
        this.clearTimer(hard);
        resolve();
      };
      if (this.child !== child) return fin();
      this.once("stopped", fin);
      this._kill(child);
    });
  }
}

module.exports = { Supervisor, tcpProbe, BACKOFF_MS };
