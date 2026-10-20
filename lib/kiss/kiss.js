/**
 * KISS framing (http://www.ax25.net/kiss.aspx).
 *   FEND 0xC0 starts/ends a frame; inside, FEND -> FESC TFEND, FESC -> FESC TFESC.
 *   First byte = (port << 4) | command; command 0 = data frame (AX.25 without FCS).
 */
const FEND = 0xc0;
const FESC = 0xdb;
const TFEND = 0xdc;
const TFESC = 0xdd;

const CMD = {
  DATA: 0x00,
  TXDELAY: 0x01,
  PERSIST: 0x02,
  SLOTTIME: 0x03,
  TXTAIL: 0x04,
  FULLDUPLEX: 0x05,
  SETHARDWARE: 0x06,
  RETURN: 0x0f, // full byte 0xFF
};

/** Max decoded frame size; longer runs are discarded (garbage / no FEND). */
const MAX_FRAME = 2048;

function escape(buf) {
  const out = [];
  for (const b of buf) {
    if (b === FEND) out.push(FESC, TFEND);
    else if (b === FESC) out.push(FESC, TFESC);
    else out.push(b);
  }
  return Buffer.from(out);
}

/** Wrap payload in a KISS frame for port (0-15) and command (default data). */
function encode(payload, opts) {
  const o = opts || {};
  const port = Math.max(0, Math.min(15, (o.port | 0) || 0));
  const cmd = o.cmd != null ? o.cmd & 0x0f : CMD.DATA;
  const typ = o.raw != null ? o.raw & 0xff : ((port << 4) | cmd) & 0xff;
  return Buffer.concat([
    Buffer.from([FEND]),
    escape(Buffer.from([typ])),
    escape(Buffer.isBuffer(payload) ? payload : Buffer.from(payload || [])),
    Buffer.from([FEND]),
  ]);
}

/**
 * Streaming decoder: push() TCP/serial chunks, get back complete frames
 * [{port, cmd, data: Buffer}]. Back-to-back FENDs (empty frames) are skipped.
 */
class Decoder {
  constructor(opts) {
    this.max = (opts && opts.maxFrame) || MAX_FRAME;
    this.buf = [];
    this.inFrame = false;
    this.esc = false;
    this.overflow = false;
    this.errors = 0;
  }
  reset() {
    this.buf = [];
    this.esc = false;
    this.overflow = false;
  }
  push(chunk) {
    const out = [];
    for (const b of chunk) {
      if (b === FEND) {
        if (this.inFrame && this.buf.length && !this.overflow) {
          const typ = this.buf[0];
          out.push({
            port: (typ >> 4) & 0x0f,
            cmd: typ & 0x0f,
            type: typ,
            data: Buffer.from(this.buf.slice(1)),
          });
        } else if (this.overflow) this.errors++;
        this.inFrame = true;
        this.reset();
        continue;
      }
      if (!this.inFrame) continue; // bytes before the first FEND
      if (this.overflow) continue;
      let v = b;
      if (this.esc) {
        this.esc = false;
        if (b === TFEND) v = FEND;
        else if (b === TFESC) v = FESC;
        else this.errors++; // protocol error: keep the byte as-is
      } else if (b === FESC) {
        this.esc = true;
        continue;
      }
      this.buf.push(v);
      if (this.buf.length > this.max) this.overflow = true;
    }
    return out;
  }
}

module.exports = { FEND, FESC, TFEND, TFESC, CMD, MAX_FRAME, escape, encode, Decoder };
