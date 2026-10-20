/**
 * Build transmit frames the way UISS (ON6MU) does: one AX.25 header
 * (To = destination, Via = digipeater path) shared by every send type, and
 * the info field from one of:
 *   - UI text / data: sent as typed (unproto), e.g. ">JO20AW Hello all"
 *   - APRS position: uncompressed "=DDMM.mmN/DDDMM.mmW" + comment
 *   - APRS message: ":ADDRESSEE:text" (addressee = UISS "For:" box)
 *   - header only: empty info
 */
const { gridToLatLon } = require("./parse");
const ax25 = require("../ax25");

/** UISS-style To presets (AX.25 destination). CQ is UISS's documented example. */
const DEST_PRESETS = ["CQ", "APRS", "APRSAT", "BEACON", "APZPST"];
/** UISS-style Via presets. */
const VIA_PRESETS = ["ARISS", "RS0ISS", "APRSAT", "WIDE2-1", "WIDE1-1,WIDE2-1"];

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
  // retry tag (" #2") is never truncated; the user comment gives way (43 max)
  const tag = String(o.tag || "");
  const comment = cleanText(o.comment, Math.max(0, 43 - tag.length)) + tag;
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

/** AX.25 destination ("To"): callsign 1-6 letters/digits, optional -SSID 0-15. */
function normDest(to) {
  const a = ax25.parseAddr(to);
  if (!a || a.h) return null;
  return ax25.formatAddr(a);
}

/**
 * UISS max TX-data length: 80 chars with no or one digipeater, 10 fewer for
 * each extra digipeater, 255 when no digipeater is used.
 */
function maxUiText(nDigis) {
  const n = Math.max(0, nDigis | 0);
  if (n === 0) return 255;
  return Math.max(10, 80 - 10 * (n - 1));
}

/** UI text / data box: printable ASCII sent as typed (one line, trailing blanks dropped). */
function uiTextInfo(text, nDigis, tag) {
  const t = String(text == null ? "" : text)
    .normalize("NFKD")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\s+$/, "");
  if (!t.trim()) throw new Error("text is empty");
  const max = maxUiText(nDigis);
  if (t.length > max) throw new Error("text is " + t.length + " chars; max " + max + " with " + (nDigis | 0) + " digipeater(s)");
  const g = String(tag || "");
  // retry tag (" #2") is never truncated; the user text gives way
  return g ? t.slice(0, Math.max(0, max - g.length)) + g : t;
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
  DEST_PRESETS,
  VIA_PRESETS,
  normDest,
  maxUiText,
  uiTextInfo,
  fmtCoord,
  cleanText,
  positionInfo,
  messageInfo,
  statusInfo,
  normAddressee,
  stationPosition,
};
