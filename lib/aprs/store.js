/**
 * APRS heard-station store for the map / globe "APRS Heard" layer.
 *
 * Position reports are the main thing plotted. Packets without a position
 * (messages, status, free text) are placed:
 *   1. at the sender's last known position from an earlier position packet,
 *   2. else at the centre of a Maidenhead grid found in the text (4/6 char),
 *   3. else not plotted (they still appear in the packet list).
 * Our own sent packets are placed at our station position.
 *
 * Each station keeps its last few packets for the map popup.
 */
const DEFAULT_EXPIRE_MS = 60 * 60 * 1000;
const THROTTLE_MS = 1000;
const RECENT_PER_STATION = 8;

/**
 * Where to plot a packet. `prev` = the station's existing entry (or null),
 * `parsed` = parseInfo() result. Returns {lat, lon, posSource} or null.
 *   posSource: "aprs" (position in this packet), "last" (earlier position),
 *              "grid" (locator in text), "self" (our own TX at station pos).
 */
/** 0°N 0°E placeholder positions (e.g. the ISS's own Mic-E beacon) are not real fixes. */
function isNullIsland(lat, lon) {
  return Math.abs(lat) < 0.5 && Math.abs(lon) < 0.5;
}

function resolvePosition(prev, parsed, opts) {
  const p = parsed || {};
  const o = opts || {};
  if (p.posSource === "aprs" && Number.isFinite(p.lat) && Number.isFinite(p.lon) && !isNullIsland(p.lat, p.lon)) {
    return { lat: p.lat, lon: p.lon, posSource: "aprs" };
  }
  if (prev && prev.lastPos && Number.isFinite(prev.lastPos.lat)) {
    return { lat: prev.lastPos.lat, lon: prev.lastPos.lon, posSource: "last" };
  }
  if (p.posSource === "grid" && Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
    return { lat: p.lat, lon: p.lon, posSource: "grid", grid: p.grid };
  }
  if (o.selfPos && Number.isFinite(o.selfPos.lat) && Number.isFinite(o.selfPos.lon)) {
    return { lat: o.selfPos.lat, lon: o.selfPos.lon, posSource: "self" };
  }
  return null;
}

/** Short one-line summary of a packet for lists / popups. */
function summarize(pkt) {
  const p = pkt.parsed || {};
  switch (p.type) {
    case "position":
    case "mic-e":
      return (p.comment || "").trim() || (p.type === "mic-e" ? "Mic-E position" : "position");
    case "object":
      return "object " + ((p.object && p.object.name) || "") + (p.comment ? " " + p.comment : "");
    case "message":
      return "→" + (p.msg ? p.msg.to : "") + ": " + (p.msg ? p.msg.text : "");
    case "ack":
    case "rej":
      return p.type + " " + (p.msg ? p.msg.id : "") + " → " + (p.msg ? p.msg.to : "");
    case "status":
      return p.text || "";
    default:
      return p.text != null ? String(p.text) : pkt.info || "";
  }
}

function createStore(opts) {
  const o = opts || {};
  let expireMs = o.expireMs || DEFAULT_EXPIRE_MS;
  const onChange = o.onChange || (() => {});
  const map = new Map();
  let timer = null;

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        onChange();
      } catch (_) {}
    }, o.throttleMs != null ? o.throttleMs : THROTTLE_MS);
    if (timer.unref) timer.unref();
  }
  function purge(now) {
    const t = now || Date.now();
    let n = 0;
    for (const [k, v] of map) if (t - v.lastHeard > expireMs) (map.delete(k), n++);
    if (n) schedule();
    return n;
  }
  /**
   * pkt: {time(ms), dir:"rx"|"tx", src, to, via[], viaSat, parsed, text}
   * opts.selfPos: station position for our own TX packets.
   */
  function add(pkt, addOpts) {
    if (!pkt || !pkt.src) return null;
    const call = String(pkt.src).toUpperCase();
    const now = pkt.time || Date.now();
    const prev = map.get(call) || null;
    const ao = addOpts || {};
    const pos = resolvePosition(prev, pkt.parsed, { selfPos: pkt.dir === "tx" ? ao.selfPos : null });
    const e = prev || { call, recent: [], count: 0, lastPos: null };
    e.lastHeard = now;
    e.count++;
    e.dir = pkt.dir || "rx";
    e.viaSat = !!pkt.viaSat || (!!prev && prev.viaSat && pkt.dir !== "tx");
    if (pos) {
      e.lat = pos.lat;
      e.lon = pos.lon;
      e.posSource = pos.posSource;
      if (pos.grid) e.grid = pos.grid;
      if (pos.posSource === "aprs" || pos.posSource === "self") {
        e.lastPos = { lat: pos.lat, lon: pos.lon, time: now };
      }
    }
    const p = pkt.parsed || {};
    if (p.symTable && p.symCode) e.symbol = p.symTable + p.symCode;
    if (p.posSource === "aprs" && p.comment != null) e.comment = String(p.comment).trim();
    e.lastType = p.type || "other";
    e.recent.unshift({
      time: now,
      dir: pkt.dir || "rx",
      type: p.type || "other",
      text: summarize(pkt),
      to: (p.msg && p.msg.to) || "",
      via: Array.isArray(pkt.via) ? pkt.via.join(",") : pkt.via || "",
      viaSat: !!pkt.viaSat,
    });
    if (e.recent.length > RECENT_PER_STATION) e.recent.length = RECENT_PER_STATION;
    map.set(call, e);
    schedule();
    return e;
  }
  function get(call) {
    return map.get(String(call || "").toUpperCase()) || null;
  }
  function list() {
    purge();
    return [...map.values()].sort((a, b) => b.lastHeard - a.lastHeard);
  }
  /** Plottable stations only (with a position). */
  function payload() {
    const stations = list()
      .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))
      .map((s) => ({
        call: s.call,
        lat: s.lat,
        lon: s.lon,
        posSource: s.posSource,
        grid: s.grid || "",
        symbol: s.symbol || "",
        comment: s.comment || "",
        lastHeard: s.lastHeard,
        viaSat: !!s.viaSat,
        dir: s.dir,
        count: s.count,
        lastType: s.lastType,
        recent: s.recent.slice(0, 5),
      }));
    return { type: "aprs-heard", expireMs, now: Date.now(), stations };
  }
  function setExpireMs(ms) {
    if (ms > 0) expireMs = ms;
  }
  const iv = setInterval(() => purge(), 30000);
  if (iv.unref) iv.unref();
  return {
    add,
    get,
    list,
    purge,
    payload,
    setExpireMs,
    clear: () => (map.clear(), schedule()),
    stop: () => clearInterval(iv),
  };
}

module.exports = { createStore, resolvePosition, isNullIsland, summarize, DEFAULT_EXPIRE_MS };
