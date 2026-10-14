/**
 * WSJT-X Decode (type 2) text parsing + a small expiring store of heard
 * stations (call -> grid/lat/lon/lastHeard/snr/mode) for the map overlay.
 */
const DECODE_EXPIRE_MS = 15 * 60 * 1000;
const BROADCAST_THROTTLE_MS = 1000;

const GRID_RE = /^[A-R]{2}[0-9]{2}$/;
const CALL_RE = /^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}(\/[A-Z0-9]{1,4})?$|^[A-Z0-9]{1,4}\/[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}$/;
const NOT_GRID = new Set(["RR73"]); // RR73 matches [A-R]{2}[0-9]{2} but is a sign-off

function isGrid(t) {
  return GRID_RE.test(t) && !NOT_GRID.has(t);
}
function cleanCall(t) {
  const c = String(t || "").replace(/^<|>$/g, "");
  if (!c || c === "..." || !/[0-9]/.test(c) || !/[A-Z]/.test(c)) return "";
  return CALL_RE.test(c) ? c : "";
}

/**
 * Parse decoded text. Returns {call, grid, to} when a sender + grid is
 * present, else null.
 *  "CQ K1ABC FN42" / "CQ SAT K1ABC FN42" / "CQ DX K1ABC FN42" -> K1ABC FN42
 *  "W9XYZ K1ABC FN42" -> K1ABC (2nd call is the sender)
 *  "<K1ABC> W9XYZ EN52" -> W9XYZ ; "W9XYZ <K1ABC> FN42" -> K1ABC
 */
function parseDecodeText(text) {
  const tok = String(text || "").toUpperCase().trim().split(/\s+/).filter(Boolean);
  // drop WSJT-X trailing markers like "a1", "?"
  while (tok.length && /^(\?|A\d)$/.test(tok[tok.length - 1])) tok.pop();
  if (tok.length < 3) return null;
  const last = tok[tok.length - 1];
  if (!isGrid(last)) return null; // only plot with a grid (R-15, RRR, 73, RR73 skipped)
  let callTok;
  let to = "";
  if (tok[0] === "CQ" || tok[0] === "QRZ" || tok[0] === "DE") {
    callTok = tok[tok.length - 2]; // any modifier(s) between CQ and call
  } else {
    if (tok.length !== 3) return null;
    to = cleanCall(tok[0]);
    callTok = tok[1];
  }
  const call = cleanCall(callTok);
  if (!call) return null;
  return { call, grid: last, to };
}

function gridCenter(g) {
  const lon = (g.charCodeAt(0) - 65) * 20 - 180 + Number(g[2]) * 2 + 1;
  const lat = (g.charCodeAt(1) - 65) * 10 - 90 + Number(g[3]) + 0.5;
  return { lat, lon };
}

function createStore(opts) {
  const o = opts || {};
  const expireMs = o.expireMs || DECODE_EXPIRE_MS;
  const onChange = o.onChange || (() => {});
  const map = new Map();
  let timer = null;
  let dirty = false;

  function schedule() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!dirty) return;
      dirty = false;
      try {
        onChange(list());
      } catch (_) {}
    }, o.throttleMs != null ? o.throttleMs : BROADCAST_THROTTLE_MS);
    if (timer.unref) timer.unref();
  }
  function purge(now) {
    const t = now || Date.now();
    let n = 0;
    for (const [k, v] of map) if (t - v.lastHeard > expireMs) (map.delete(k), n++);
    if (n) schedule();
    return n;
  }
  function add(decode, now) {
    if (!decode || decode.offAir) return false; // offAir = replayed .wav
    const p = parseDecodeText(decode.message);
    if (!p) return false;
    const c = gridCenter(p.grid);
    map.set(p.call, {
      call: p.call,
      grid: p.grid,
      lat: c.lat,
      lon: c.lon,
      lastHeard: now || Date.now(),
      snr: decode.snr,
      mode: decode.mode || "",
      to: p.to,
    });
    schedule();
    return true;
  }
  function list() {
    purge();
    return [...map.values()].sort((a, b) => b.lastHeard - a.lastHeard);
  }
  function payload() {
    return { type: "wsjtx-decodes", expireMs, now: Date.now(), stations: list() };
  }
  const iv = setInterval(() => purge(), 30000);
  if (iv.unref) iv.unref();
  return { add, list, purge, payload, clear: () => (map.clear(), schedule()) };
}

module.exports = { DECODE_EXPIRE_MS, parseDecodeText, gridCenter, createStore, isGrid };
