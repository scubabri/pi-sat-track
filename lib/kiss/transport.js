/**
 * Byte-stream transport contract used by the KISS client, plus a reconnect
 * helper shared by all transports.
 *
 *   class X extends Transport {
 *     _open()  -> start connecting; call this._opened() / this._failed(err)
 *     _close() -> tear down the underlying handle
 *     _write(buf) -> bool
 *   }
 * Events: "open", "data"(Buffer), "close"(reason), "error"(err), "state"(state)
 * States: idle | connecting | connected | waiting (backoff) | closed
 *
 * The Transport itself owns reconnect (exponential backoff with jitter) so a
 * TCP, serial (/dev/rfcomm0 Bluetooth SPP, USB) or future BLE transport only
 * implements one connection attempt.
 */
const { EventEmitter } = require("events");

class Transport extends EventEmitter {
  constructor(opts) {
    super();
    const o = opts || {};
    this.initialMs = o.reconnectInitialMs || 1000;
    this.maxMs = o.reconnectMaxMs || 30000;
    this.jitter = o.jitter != null ? o.jitter : 0.25;
    this.autoReconnect = o.autoReconnect !== false;
    this.state = "idle";
    this.lastError = "";
    this.connectedSince = 0;
    this.attempts = 0;
    this.nextRetryAt = 0;
    this._backoff = this.initialMs;
    this._timer = null;
    this._wanted = false;
  }
  describe() {
    return "transport";
  }
  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit("state", s);
  }
  open() {
    this._wanted = true;
    if (this.state === "connecting" || this.state === "connected") return;
    this._attempt();
  }
  close() {
    this._wanted = false;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this.nextRetryAt = 0;
    try {
      this._close();
    } catch (_) {}
    const was = this.state;
    this._setState("closed");
    if (was === "connected") this.emit("close", "closed");
  }
  write(buf) {
    if (this.state !== "connected") return false;
    try {
      return this._write(buf) !== false;
    } catch (e) {
      this._failed(e);
      return false;
    }
  }
  _attempt() {
    this._timer = null;
    if (!this._wanted) return;
    this.attempts++;
    this.nextRetryAt = 0;
    this._setState("connecting");
    try {
      this._open();
    } catch (e) {
      this._failed(e);
    }
  }
  _opened() {
    this._backoff = this.initialMs;
    this.lastError = "";
    this.connectedSince = Date.now();
    this._setState("connected");
    this.emit("open");
  }
  _data(buf) {
    this.emit("data", buf);
  }
  /** Connection attempt failed or an open connection dropped. */
  _failed(err) {
    const was = this.state;
    if (was === "closed" || was === "waiting") return;
    this.lastError = (err && (err.code || err.message)) || String(err || "closed");
    try {
      this._close();
    } catch (_) {}
    this.connectedSince = 0;
    if (was === "connected") this.emit("close", this.lastError);
    if (err && err instanceof Error) this.emit("error", err);
    if (!this._wanted || !this.autoReconnect) {
      this._setState("closed");
      return;
    }
    const j = 1 + (Math.random() * 2 - 1) * this.jitter;
    const delay = Math.max(50, Math.round(this._backoff * j));
    this._backoff = Math.min(this.maxMs, this._backoff * 2);
    this.nextRetryAt = Date.now() + delay;
    this._setState("waiting");
    this._timer = setTimeout(() => this._attempt(), delay);
    if (this._timer.unref) this._timer.unref();
  }
}

module.exports = { Transport };
