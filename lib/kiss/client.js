/**
 * KISS client: transport + KISS framing + AX.25 decode.
 * Emits "frame" {port, raw: Buffer, ax25: decoded|null}, "state", "open", "close".
 */
const { EventEmitter } = require("events");
const kiss = require("./kiss");
const ax25 = require("../ax25");
const { TcpTransport } = require("./tcp");
const { SerialTransport } = require("./serial");

function createTransport(cfg) {
  const c = cfg || {};
  if (c.transport === "serial") {
    return new SerialTransport({ path: c.serialDevice, baudRate: c.serialBaud, ...c.transportOpts });
  }
  return new TcpTransport({ host: c.host, port: c.port, ...c.transportOpts });
}

class KissClient extends EventEmitter {
  constructor(transport, opts) {
    super();
    this.t = transport;
    this.kissPort = (opts && opts.kissPort) | 0;
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
  _onData(b) {
    for (const f of this.dec.push(b)) {
      if (f.cmd !== kiss.CMD.DATA) continue;
      const fr = ax25.decode(f.data);
      if (!fr) this.badFrames++;
      this.rxFrames++;
      this.lastRxMs = Date.now();
      this.emit("frame", { port: f.port, raw: f.data, ax25: fr });
    }
  }
  /** Send an AX.25 frame (Buffer) as a KISS data frame. */
  sendFrame(buf) {
    const ok = this.t.write(kiss.encode(buf, { port: this.kissPort }));
    if (ok) {
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
      tx: this.txFrames,
      bad: this.badFrames,
      lastRxMs: this.lastRxMs,
      lastTxMs: this.lastTxMs,
    };
  }
}

module.exports = { KissClient, createTransport };
