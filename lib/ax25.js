/**
 * AX.25 UI frame decode/encode (no FCS: KISS carries frames without it).
 * Address field: 7 bytes per address, chars shifted left 1, SSID byte
 *   bit7 = C (dest/src) or H "has been repeated" (digis), bits6-5 reserved (1),
 *   bits4-1 = SSID, bit0 = address-extension (1 on the last address).
 */
const CTL_UI = 0x03;
const PID_NO_L3 = 0xf0;
const MAX_DIGIS = 8;
const CALL_RE = /^[A-Z0-9]{1,6}$/;

/** "RS0ISS-3*" -> {call:"RS0ISS", ssid:3, h:true}; null if invalid. */
function parseAddr(s) {
  let t = String(s == null ? "" : s).trim().toUpperCase();
  let h = false;
  if (t.endsWith("*")) {
    h = true;
    t = t.slice(0, -1);
  }
  const m = /^([A-Z0-9]{1,6})(?:-(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const ssid = m[2] != null ? parseInt(m[2], 10) : 0;
  if (ssid > 15) return null;
  return { call: m[1], ssid, h };
}

function formatAddr(a, withH) {
  if (!a) return "";
  return a.call + (a.ssid ? "-" + a.ssid : "") + (withH && a.h ? "*" : "");
}

/** Parse "ARISS" / "RS0ISS,WIDE2-1" / "" into an address list (throws on bad entry). */
function parsePath(str) {
  const parts = String(str || "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length > MAX_DIGIS) throw new Error("path has more than " + MAX_DIGIS + " digipeaters");
  return parts.map((p) => {
    const a = parseAddr(p);
    if (!a) throw new Error("invalid path entry: " + p);
    a.h = false; // never send pre-marked as repeated
    return a;
  });
}

function encodeAddr(a, opts) {
  const o = opts || {};
  const call = (a.call + "      ").slice(0, 6);
  const out = Buffer.alloc(7);
  for (let i = 0; i < 6; i++) out[i] = call.charCodeAt(i) << 1;
  out[6] = 0x60 | ((a.ssid & 0x0f) << 1) | (o.high ? 0x80 : 0) | (o.last ? 0x01 : 0);
  return out;
}

function decodeAddr(buf, off) {
  let call = "";
  for (let i = 0; i < 6; i++) {
    const b = buf[off + i];
    if (b & 0x01) return null; // extension bit inside call chars = malformed
    const c = String.fromCharCode(b >> 1);
    call += c;
  }
  call = call.replace(/ +$/, "");
  if (!CALL_RE.test(call)) return null;
  const s = buf[off + 6];
  return { call, ssid: (s >> 1) & 0x0f, high: !!(s & 0x80), last: !!(s & 0x01) };
}

/**
 * Decode an AX.25 frame. Returns
 *   {dst, src, path:[{call,ssid,h}], ctl, pid, isUI, info: Buffer}
 * or null when the address field is malformed.
 */
function decode(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 15) return null;
  const addrs = [];
  let off = 0;
  for (;;) {
    if (off + 7 > buf.length) return null;
    const a = decodeAddr(buf, off);
    if (!a) return null;
    addrs.push(a);
    off += 7;
    if (a.last) break;
    if (addrs.length >= 2 + MAX_DIGIS) return null;
  }
  if (addrs.length < 2 || off >= buf.length) return null;
  const ctl = buf[off++];
  const isUI = (ctl & 0xef) === CTL_UI;
  let pid = null;
  if (isUI) {
    if (off >= buf.length) return null;
    pid = buf[off++];
  }
  const [d, s, ...digis] = addrs;
  return {
    dst: { call: d.call, ssid: d.ssid },
    src: { call: s.call, ssid: s.ssid },
    path: digis.map((x) => ({ call: x.call, ssid: x.ssid, h: x.high })),
    ctl,
    pid,
    isUI,
    info: buf.slice(off),
  };
}

/** Encode a UI frame (command, dst C=1 / src C=0, PID 0xF0). */
function encodeUI(f) {
  const src = typeof f.src === "string" ? parseAddr(f.src) : f.src;
  const dst = typeof f.dst === "string" ? parseAddr(f.dst) : f.dst;
  if (!src) throw new Error("invalid source callsign");
  if (!dst) throw new Error("invalid destination");
  const path = Array.isArray(f.path) ? f.path : parsePath(f.path);
  if (path.length > MAX_DIGIS) throw new Error("too many digipeaters");
  const parts = [encodeAddr(dst, { high: true }), encodeAddr(src, { last: path.length === 0 })];
  path.forEach((p, i) => parts.push(encodeAddr(p, { high: !!p.h, last: i === path.length - 1 })));
  const info = Buffer.isBuffer(f.info) ? f.info : Buffer.from(String(f.info || ""), "latin1");
  parts.push(Buffer.from([CTL_UI, f.pid != null ? f.pid : PID_NO_L3]), info);
  return Buffer.concat(parts);
}

/** TNC2 monitor text: SRC>DST,DIGI1,DIGI2*:info  (* on the last repeated digi). */
function toTnc2(fr) {
  let lastH = -1;
  fr.path.forEach((p, i) => {
    if (p.h) lastH = i;
  });
  const path = fr.path.map((p, i) => formatAddr(p) + (i === lastH ? "*" : ""));
  const info = fr.info ? infoText(fr.info) : "";
  return formatAddr(fr.src) + ">" + [formatAddr(fr.dst)].concat(path).join(",") + ":" + info;
}

/** Info field as text: UTF-8 when valid (Mic-E / emoji senders), else latin1. */
function infoText(buf) {
  const u = buf.toString("utf8");
  return u.includes("\ufffd") ? buf.toString("latin1") : u;
}

module.exports = {
  CTL_UI,
  PID_NO_L3,
  MAX_DIGIS,
  parseAddr,
  formatAddr,
  parsePath,
  decode,
  encodeUI,
  toTnc2,
  infoText,
};
