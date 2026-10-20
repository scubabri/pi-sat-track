/**
 * KISS client: transport + KISS framing + AX.25 decode.
 * Emits "frame" {port, raw: Buffer, ax25: decoded|null}, "state", "open", "close".
 */
const { EventEmitter } = require("events");
const kiss = require("./kiss");
const ax25 = require("../ax25");
const { TcpTransport } = require("./tcp");
const { SerialTransport } = require("./serial");
const { BluetoothTransport } = require("./bluetooth");

function createTransport(cfg) {
  const c = cfg || {};
  // Bluetooth by MAC: RFCOMM socket (no rfcomm bind). Without a MAC (older
  // configs) "bluetooth" is a serial device path such as /dev/rfcomm0.
  if (c.transport === "bluetooth" && c.btAddress) {
    return new BluetoothTransport({ address: c.btAddress, channel: c.btChannel, ...c.transportOpts });
  }
  if (c.transport === "bluetooth" || c.transport === "serial") {
    return new SerialTransport({ path: c.serialDevice, baudRate: c.serialBaud, ...c.transportOpts });
  }
  return new TcpTransport({ host: c.host, port: c.port, ...c.transportOpts });
}

/** Bytes that are not KISS -> "aa bb 63 6d 64 3a  |..cmd:|" (first 64). */
function preview(buf) {
  const b = buf.subarray(0, 64);
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");
  const asc = [...b].map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : ".")).join("");
  return hex + "  |" + asc + "|";
}

/** Connected this long with zero bytes from the radio -> "no data" hint. */
const NO_DATA_MS = 120000;
/** Bytes without one KISS frame before the "not in KISS mode" warning. */
const NO_KISS_BYTES = 48;
const NO_KISS_MS = 10000;

class KissClient extends EventEmitter {
  /**
   * Besides "frame" / "state", emits diagnostics once per connection:
   *   "first-frame" {port}            first decoded KISS data frame
   *   "no-kiss" {bytes, preview}      bytes arrive but none decode as KISS
   *                                   (radio in its text TNC / APRS mode)
   */
  constructor(transport, opts) {
    super();
    this.t = transport;
    this.kissPort = (opts && opts.kissPort) | 0;
    this.noDataMs = (opts && opts.noDataMs) || NO_DATA_MS;
    this.rxBytes = 0; // raw bytes from the transport (all sessions)
    this.lastByteMs = 0;
    this._sess = this._newSession();
    this._noKissAt = -Infinity;
    this.dec = new kiss.Decoder();
    this.rxFrames = 0;
    this.txFrames = 0;
    this.badFrames = 0;
    this.lastRxMs = 0;
    this.lastTxMs = 0;
    this.t.on("data", (b) => this._onData(b));
    this.t.on("state", (s) => this.emit("state", s));
    this.t.on("open", () => {
      this.dec = new kiss.Decoder();
      this._sess = this._newSession();
      this.emit("open");
    });
    this.t.on("close", (r) => this.emit("close", r));
    this.t.on("error", () => {}); // reported via state / lastError
  }
  open() {
    this.t.open();
  }
  close() {
    this.t.close();
  }
  get state() {
    return this.t.state;
  }
  _newSession() {
    return { bytes: 0, frames: 0, firstByteMs: 0, head: [], headLen: 0, noKiss: false, warned: false };
  }
  _onData(b) {
    const now = Date.now();
    const s = this._sess;
    this.rxBytes += b.length;
    this.lastByteMs = now;
    s.bytes += b.length;
    if (!s.firstByteMs) s.firstByteMs = now;
    if (!s.frames && s.headLen < 64) {
      s.head.push(Buffer.from(b.subarray(0, 64 - s.headLen)));
      s.headLen += Math.min(b.length, 64 - s.headLen);
    }
    for (const f of this.dec.push(b)) {
      if (f.cmd !== kiss.CMD.DATA) continue;
      const fr = ax25.decode(f.data);
      if (!fr) this.badFrames++;
      this.rxFrames++;
      this.lastRxMs = now;
      if (!s.frames++) {
        s.noKiss = false;
        this.emit("first-frame", { port: f.port, bytes: s.bytes });
      }
      this.emit("frame", { port: f.port, raw: f.data, ax25: fr });
    }
    if (!s.frames && !s.warned && (s.bytes >= NO_KISS_BYTES || (s.bytes && now - s.firstByteMs >= NO_KISS_MS))) {
      s.warned = true;
      s.noKiss = true;
      // once per connection, and at most every 10 min across reconnects
      if (now - this._noKissAt >= 600000) {
        this._noKissAt = now;
        this.emit("no-kiss", { bytes: s.bytes, preview: preview(Buffer.concat(s.head)) });
      }
    }
  }
  /** "" | "no-kiss" (bytes but no frames) | "no-data" (connected, silent 2+ min). */
  diag() {
    if (this.t.state !== "connected") return "";
    const s = this._sess;
    if (s.noKiss && !s.frames) return "no-kiss";
    if (!s.bytes && this.t.connectedSince && Date.now() - this.t.connectedSince >= this.noDataMs) {
      if (!s.noDataLogged) {
        s.noDataLogged = true;
        this.emit("no-data", { ms: Date.now() - this.t.connectedSince });
      }
      return "no-data";
    }
    return "";
  }
  /** Send an AX.25 frame (Buffer) as a KISS data frame. */
  sendFrame(buf) {
    const k = kiss.encode(buf, { port: this.kissPort });
    const ok = this.t.write(k);
    if (ok) {
      this.lastTxBytes = k.length;
      this.txFrames++;
      this.lastTxMs = Date.now();
    }
    return ok;
  }
  status() {
    return {
      state: this.t.state,
      target: this.t.describe(),
      error: this.t.lastError || "",
      connectedSince: this.t.connectedSince || 0,
      nextRetryAt: this.t.nextRetryAt || 0,
      rx: this.rxFrames,
      rxBytes: this.rxBytes,
      lastByteMs: this.lastByteMs,
      diag: this.diag(),
      tx: this.txFrames,
      bad: this.badFrames,
      lastRxMs: this.lastRxMs,
      lastTxMs: this.lastTxMs,
    };
  }
}

module.exports = { KissClient, createTransport, preview, NO_DATA_MS };
