/**
 * KISS over a serial port: Bluetooth Classic SPP TNCs bound with
 * `rfcomm bind 0 <MAC>` (/dev/rfcomm0: Mobilinkd TNC3/TNC4 classic,
 * Kenwood TH-D74/D75), and USB serial TNCs (/dev/ttyACM0). Uses the
 * existing `serialport` dependency (loaded lazily).
 */
const { Transport } = require("./transport");

class SerialTransport extends Transport {
  constructor(opts) {
    super(opts);
    const o = opts || {};
    this.path = String(o.path || o.device || "/dev/rfcomm0");
    this.baudRate = parseInt(o.baudRate || o.baud, 10) || 9600;
    this.port = null;
    this._SerialPort = o.SerialPort || null; // injectable for tests
  }
  describe() {
    return "serial " + this.path + " @" + this.baudRate;
  }
  _open() {
    const SP = this._SerialPort || require("serialport").SerialPort;
    const p = new SP({ path: this.path, baudRate: this.baudRate, autoOpen: false });
    this.port = p;
    p.on("data", (b) => {
      if (this.port === p) this._data(b);
    });
    p.on("error", (e) => {
      if (this.port === p) this._failed(e);
    });
    p.on("close", () => {
      if (this.port === p) this._failed(new Error("serial port closed"));
    });
    p.open((err) => {
      if (this.port !== p) return;
      if (err) this._failed(err);
      else this._opened();
    });
  }
  _close() {
    const p = this.port;
    this.port = null;
    if (p) {
      p.removeAllListeners("data");
      p.on("error", () => {});
      try {
        if (p.isOpen) p.close(() => {});
      } catch (_) {}
    }
  }
  _write(buf) {
    if (!this.port) return false;
    this.port.write(buf);
    return true;
  }
}

module.exports = { SerialTransport };
