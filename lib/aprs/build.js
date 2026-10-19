/**
 * Build APRS info fields for transmit: position (uncompressed, optional
 * ambiguity), message (":ADDRESSEE:text"), status (">text").
 */
const { gridToLatLon } = require("./parse");

const MAX_MSG = 67;
const MAX_STATUS = 62;

function pad(n, w) {
  return String(n).padStart(w, "0");
}

/** Degrees -> "DDMM.mmN" (lat) / "DDDMM.mmW" (lon) with ambiguity 0-4 (trailing digits -> spaces). */
function fmtCoord(v, isLat, ambiguity) {
  const hemi = isLat ? (v < 0 ? "S" : "N") : v < 0 ? "W" : "E";
  const a = Math.abs(v);
  let deg = Math.floor(a);
  let min = Math.round((a - deg) * 60 * 100) / 100;
  if (min >= 60) {
    deg += 1;
    min = 0;
  }
  const mm = min.toFixed(2).padStart(5, "0").split(""); // "MM.mm"
  const amb = Math.max(0, Math.min(4, ambiguity | 0));
  const pos = [4, 3, 1, 0];
  for (let i = 0; i < amb; i++) mm[pos[i]] = " ";
  return pad(deg, isLat ? 2 : 3) + mm.join("") + hemi;
}

/** Printable ASCII only; APRS reserves | ~ and { (message id) in message text. */
function cleanText(s, max) {
  const t = String(s == null ? "" : s)
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[|~{]/g, "")
    .trim();
  return t.slice(0, max);
}

function positionInfo(o) {
  const lat = Number(o.lat);
  const lon = Number(o.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    throw new Error("no valid position");
  const sym = String(o.symbol || "/`");
  const table = sym[0] || "/";
  const code = sym[1] || "`";
  const comment = cleanText(o.comment, 43);
  return (
    (o.messaging ? "=" : "!") +
    fmtCoord(lat, true, o.ambiguity) +
    table +
    fmtCoord(lon, false, o.ambiguity) +
    code +
    comment
  );
}

/** Addressee: callsign-SSID or tactical, up to 9 chars, space padded. */
function normAddressee(to) {
  const t = String(to || "").trim().toUpperCase();
  if (!/^[A-Z0-9-]{1,9}$/.test(t)) return null;
  return t;
}

function messageInfo(to, text, id) {
  const a = normAddressee(to);
  if (!a) throw new Error("invalid addressee (1-9 letters, digits or -)");
  const body = cleanText(text, MAX_MSG);
  if (!body) throw new Error("message text is empty");
  return ":" + a.padEnd(9, " ") + ":" + body + (id ? "{" + String(id).slice(0, 5) : "");
}

function statusInfo(text) {
  const body = cleanText(text, MAX_STATUS);
  if (!body) throw new Error("status text is empty");
  return ">" + body;
}

/** Beacon position from config: grid centre (default) or exact lat/lon. */
function stationPosition(aprsCfg, station) {
  const c = aprsCfg || {};
  if (c.posSource === "latlon") {
    const lat = Number(c.lat);
    const lon = Number(c.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon) && (lat || lon)) return { lat, lon, source: "latlon" };
    return null;
  }
  const g = station && station.grid;
  const p = gridToLatLon(g);
  return p ? { lat: p.lat, lon: p.lon, source: "grid", grid: String(g).toUpperCase() } : null;
}

module.exports = {
  MAX_MSG,
  MAX_STATUS,
  fmtCoord,
  cleanText,
  positionInfo,
  messageInfo,
  statusInfo,
  normAddressee,
  stationPosition,
};
