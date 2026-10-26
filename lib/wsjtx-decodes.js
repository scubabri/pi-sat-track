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

/** Base callsign for comparisons: "<KA7KDX/P>" -> "KA7KDX" (part with a digit, longest). */
function baseCall(c) {
  const t = String(c || "").toUpperCase().replace(/^<|>$/g, "").trim();
  if (!t) return "";
  const parts = t.split("/").filter((x) => /[0-9]/.test(x) && /[A-Z]/.test(x));
  return parts.length ? parts.sort((a, b) => b.length - a.length)[0] : t;
}
function sameCall(a, b) {
  const x = baseCall(a), y = baseCall(b);
  return !!x && x === y;
}
const SIGNOFF = new Set(["73", "RR73"]);

/**
 * Classify decoded text for the map / station list.
 * Returns {call, grid, to, kind} (grid "" when the message has none) or null.
 *  kind "me"    addressed to myCall (someone calling / answering us)
 *       "cq"    CQ / QRZ, or a 73 / RR73 sign-off to someone else
 *       "other" anything else (QSOs between other stations)
 *  "CQ K1ABC FN42" / "CQ SAT K1ABC FN42" / "CQ K1ABC" -> K1ABC, cq
 *  "W9XYZ K1ABC FN42" / "W9XYZ K1ABC -12" / "W9XYZ K1ABC RR73" -> K1ABC (2nd call is the sender)
 * Our own transmissions (sender = myCall) return null.
 */
function classifyDecode(text, myCall) {
  const tok = String(text || "").toUpperCase().trim().split(/\s+/).filter(Boolean);
  // drop WSJT-X trailing markers like "a1", "?"
  while (tok.length && /^(\?|A\d)$/.test(tok[tok.length - 1])) tok.pop();
  if (tok.length < 2) return null;
  const last = tok[tok.length - 1];
  const grid = tok.length >= 3 && isGrid(last) ? last : "";
  let call;
  let to = "";
  let kind;
  if (tok[0] === "CQ" || tok[0] === "QRZ" || tok[0] === "DE") {
    call = cleanCall(grid ? tok[tok.length - 2] : last); // any modifier(s) between CQ and call
    kind = tok[0] === "DE" ? "other" : "cq";
  } else {
    if (tok.length > 3) return null;
    to = cleanCall(tok[0]);
    call = cleanCall(tok[1]);
    kind = to && myCall && sameCall(to, myCall) ? "me" : tok.length === 3 && SIGNOFF.has(last) ? "cq" : "other";
  }
  if (!call) return null;
  if (myCall && sameCall(call, myCall)) return null;
  return { call, grid, to, kind };
}

/**
 * Parse decoded text. Returns {call, grid, to} when a sender + grid is
 * present, else null (see classifyDecode).
 *  "<K1ABC> W9XYZ EN52" -> W9XYZ ; "W9XYZ <K1ABC> FN42" -> K1ABC
 */
function parseDecodeText(text) {
  const c = classifyDecode(text, "");
  if (!c || !c.grid) return null; // only plot with a grid (R-15, RRR, 73, RR73 skipped)
  return { call: c.call, grid: c.grid, to: c.to };
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
  const getMyCall = o.getMyCall || (() => "");
  const map = new Map();
  /** call -> last grid seen (bounded), so "K1ABC -12" still plots after "CQ K1ABC FN42". */
  const gridOf = new Map();
  const GRID_CACHE_MAX = 3000;
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
    let myCall = "";
    try { myCall = getMyCall() || ""; } catch (_) {}
    const p = classifyDecode(decode.message, myCall);
    if (!p) return false;
    if (p.grid) {
      gridOf.delete(p.call);
      gridOf.set(p.call, p.grid);
      if (gridOf.size > GRID_CACHE_MAX) gridOf.delete(gridOf.keys().next().value);
    }
    const grid = p.grid || gridOf.get(p.call) || "";
    if (!grid) return false;
    const c = gridCenter(grid);
    map.set(p.call, {
      call: p.call,
      grid,
      lat: c.lat,
      lon: c.lon,
      lastHeard: now || Date.now(),
      snr: decode.snr,
      mode: decode.mode || "",
      to: p.to,
      kind: p.kind,
      message: String(decode.message || "").trim(),
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

module.exports = { DECODE_EXPIRE_MS, parseDecodeText, classifyDecode, sameCall, gridCenter, createStore, isGrid };
