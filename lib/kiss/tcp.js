/** KISS over TCP (Direwolf 8001, Graywolf 6700, LoRa/remote TNCs). Local or remote host. */
const net = require("net");
const { Transport } = require("./transport");

class TcpTransport extends Transport {
  constructor(opts) {
    super(opts);
    const o = opts || {};
    this.host = String(o.host || "").trim() || "127.0.0.1";
    this.port = parseInt(o.port, 10) || 8001;
    this.connectTimeoutMs = o.connectTimeoutMs || 5000;
    this.sock = null;
  }
  describe() {
    return "tcp " + (this.host.includes(":") ? "[" + this.host + "]" : this.host) + ":" + this.port;
  }
  _open() {
    const s = new net.Socket();
    this.sock = s;
    let opened = false;
    s.setNoDelay(true);
    s.setTimeout(this.connectTimeoutMs);
    s.on("timeout", () => {
      if (!opened) {
        const e = new Error("connect timeout");
        e.code = "ETIMEDOUT";
        if (this.sock === s) this._failed(e);
      }
    });
    s.on("connect", () => {
      opened = true;
      s.setTimeout(0);
      s.setKeepAlive(true, 15000);
      if (this.sock === s) this._opened();
    });
    s.on("data", (b) => {
      if (this.sock === s) this._data(b);
    });
    s.on("error", (e) => {
      if (this.sock === s) this._failed(e);
    });
    s.on("close", () => {
      if (this.sock === s) this._failed(new Error("connection closed by peer"));
    });
    s.connect(this.port, this.host);
  }
  _close() {
    const s = this.sock;
    this.sock = null;
    if (s) {
      s.removeAllListeners("data");
      s.on("error", () => {});
      s.destroy();
    }
  }
  _write(buf) {
    return this.sock ? this.sock.write(buf) || true : false;
  }
}

module.exports = { TcpTransport };
