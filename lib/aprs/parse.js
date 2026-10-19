/**
 * APRS info-field parser (APRS101 subset): positions (uncompressed /
 * compressed, with or without timestamp), Mic-E, objects, messages / acks,
 * status, raw NMEA ($GPRMC/$GPGGA) and a Maidenhead-grid fallback for the
 * free-text packets common via the ISS ("CQ K1ABC FN42").
 *
 * parseInfo(dst, info) -> {
 *   type: "position"|"mic-e"|"object"|"message"|"ack"|"rej"|"status"|"nmea"|"other",
 *   lat, lon, posSource: "aprs"|"grid"|undefined, ambiguity,
 *   symTable, symCode, comment, speedKn, course, altM,
 *   msg: {to, text, id},   // message / ack / rej
 *   object: {name, live},
 *   text,                  // status or free text
 * }
 */

// 4 or 6 char locator as its own token: "DN40", "DN40aq", "dn40AQ" (field letters A-R, subsquare A-X, any case).
const GRID_RE = /(?:^|[^A-Za-z0-9])([A-Ra-r]{2}[0-9]{2}(?:[A-Xa-x]{2})?)(?=$|[^A-Za-z0-9])/;
const NOT_GRID = new Set(["RR73"]);

function gridToLatLon(g) {
  const s = String(g || "").trim();
  if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/i.test(s)) return null;
  const u = s.toUpperCase();
  let lon = (u.charCodeAt(0) - 65) * 20 - 180 + Number(u[2]) * 2;
  let lat = (u.charCodeAt(1) - 65) * 10 - 90 + Number(u[3]);
  if (u.length >= 6) {
    lon += (u.charCodeAt(4) - 65) * (5 / 60) + 2.5 / 60;
    lat += (u.charCodeAt(5) - 65) * (2.5 / 60) + 1.25 / 60;
  } else {
    lon += 1;
    lat += 0.5;
  }
  return { lat, lon };
}

/** First grid locator in free text, normalised "DN40aq" ("RR73" ignored). */
function findGrid(text) {
  const t = String(text || "");
  let rest = t;
  for (let i = 0; i < 8; i++) {
    const m = GRID_RE.exec(rest);
    if (!m) return null;
    const g = m[1].slice(0, 2).toUpperCase() + m[1].slice(2, 4) + m[1].slice(4).toLowerCase();
    if (!NOT_GRID.has(g.toUpperCase())) return g;
    rest = rest.slice(m.index + m[0].length);
  }
  return null;
}

/* ---------- uncompressed / compressed position ---------- */

/** "4903.50N" -> {v, amb}; spaces = ambiguity (replaced by midpoints). */
function parseLatStr(s) {
  const m = /^(\d{2})([0-9 ]{2})\.([0-9 ]{2})([NS])$/.exec(s);
  if (!m) return null;
  const raw = m[1] + m[2] + m[3];
  const amb = (raw.match(/ /g) || []).length;
  const fix = (x) => x.replace(/ /g, "0");
  let deg = Number(m[1]);
  let min = Number(fix(m[2]) + "." + fix(m[3]));
  // Centre of the ambiguity box.
  const half = [0, 0.005, 0.05, 0.5, 5][Math.min(amb, 4)];
  min += half;
  if (deg > 90 || min >= 60.5) return null;
  let v = deg + min / 60;
  if (m[4] === "S") v = -v;
  return { v, amb };
}
function parseLonStr(s, amb) {
  const m = /^(\d{3})([0-9 ]{2})\.([0-9 ]{2})([EW])$/.exec(s);
  if (!m) return null;
  const fix = (x) => x.replace(/ /g, "0");
  // Lon ambiguity follows the latitude's (APRS101 ch. 6).
  const digits = (m[1] + fix(m[2]) + "." + fix(m[3])).split("");
  const deg = Number(m[1]);
  let min = Number(fix(m[2]) + "." + fix(m[3]));
  const a = amb != null ? amb : 0;
  if (a) {
    // zero the ambiguous digits then centre
    const mm = (Number(fix(m[2])) + Number(fix(m[3])) / 100).toFixed(2).padStart(5, "0").split("");
    const pos = [4, 3, 1, 0]; // hundredths, tenths, units, tens of minutes
    for (let i = 0; i < Math.min(a, 4); i++) mm[pos[i]] = "0";
    min = Number(mm.join("")) + [0, 0.005, 0.05, 0.5, 5][Math.min(a, 4)];
  }
  void digits;
  if (deg > 180 || min >= 60.5) return null;
  let v = deg + min / 60;
  if (m[4] === "W") v = -v;
  return v;
}

function base91(s) {
  let v = 0;
  for (const ch of s) {
    const c = ch.charCodeAt(0) - 33;
    if (c < 0 || c > 90) return NaN;
    v = v * 91 + c;
  }
  return v;
}

/** Position body (after DTI/timestamp). Returns {lat, lon, symTable, symCode, rest, amb} or null. */
function parsePositionBody(s) {
  if (/^\d/.test(s)) {
    if (s.length < 19) return null;
    const lat = parseLatStr(s.slice(0, 8));
    if (!lat) return null;
    const lon = parseLonStr(s.slice(9, 18), lat.amb);
    if (lon == null) return null;
    return { lat: lat.v, lon, symTable: s[8], symCode: s[18], rest: s.slice(19), amb: lat.amb };
  }
  // compressed: T YYYY XXXX $ cs T
  if (s.length < 13) return null;
  const table = s[0];
  if (!/[\/\\A-Za-j]/.test(table)) return null;
  const y = base91(s.slice(1, 5));
  const x = base91(s.slice(5, 9));
  if (!Number.isFinite(y) || !Number.isFinite(x)) return null;
  const lat = 90 - y / 380926;
  const lon = -180 + x / 190463;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const out = { lat, lon, symTable: table, symCode: s[9], rest: s.slice(13), amb: 0, compressed: true };
  const c = s.charCodeAt(10) - 33;
  const sp = s.charCodeAt(11) - 33;
  if (s[10] !== " " && c >= 0 && c <= 89) {
    out.course = c * 4;
    out.speedKn = Math.round((Math.pow(1.08, sp) - 1) * 10) / 10;
  }
  return out;
}

/** "/A=001234" altitude (feet) in a comment -> metres. */
function altFromComment(c) {
  const m = /\/A=(-?\d{6})/.exec(c || "");
  return m ? Math.round(Number(m[1]) * 0.3048) : undefined;
}

function withPos(out, p) {
  out.lat = p.lat;
  out.lon = p.lon;
  out.posSource = "aprs";
  out.symTable = p.symTable;
  out.symCode = p.symCode;
  out.ambiguity = p.amb || 0;
  if (p.course != null) out.course = p.course;
  if (p.speedKn != null) out.speedKn = p.speedKn;
  out.comment = p.rest || "";
  // course/speed extension "ccc/sss"
  const cs = /^(\d{3})\/(\d{3})/.exec(out.comment);
  if (cs && !p.compressed) {
    out.course = Number(cs[1]);
    out.speedKn = Number(cs[2]);
    out.comment = out.comment.slice(7);
  }
  const alt = altFromComment(out.comment);
  if (alt != null) out.altM = alt;
  return out;
}

/* ---------- Mic-E ---------- */

const MICE_STD = ["Emergency", "Priority", "Special", "Committed", "Returning", "In Service", "En Route", "Off Duty"];

/** Decode a Mic-E packet: dst = 6-char destination call, info starts with ` or '. */
function parseMicE(dst, info) {
  const d = String(dst || "").toUpperCase();
  if (d.length !== 6 || info.length < 9) return null;
  const digits = [];
  let msgBits = 0;
  let custom = false;
  for (let i = 0; i < 6; i++) {
    const c = d[i];
    let dig;
    let bit = 0;
    if (c >= "0" && c <= "9") dig = c;
    else if (c >= "A" && c <= "J") { dig = String(c.charCodeAt(0) - 65); bit = 1; custom = true; }
    else if (c === "K") { dig = "0"; bit = 1; custom = true; }
    else if (c === "L") dig = "0";
    else if (c >= "P" && c <= "Y") { dig = String(c.charCodeAt(0) - 80); bit = 1; }
    else if (c === "Z") { dig = "0"; bit = 1; }
    else return null;
    if (i < 3) msgBits = (msgBits << 1) | bit;
    digits.push(dig);
  }
  const north = d[3] >= "P";
  const lonOff = d[4] >= "P" ? 100 : 0;
  const west = d[5] >= "P";
  const latDeg = Number(digits[0] + digits[1]);
  const latMin = Number(digits[2] + digits[3] + "." + digits[4] + digits[5]);
  if (latDeg > 89 || latMin >= 60) return null;
  let lat = latDeg + latMin / 60;
  if (!north) lat = -lat;

  const b = (i) => info.charCodeAt(i) - 28;
  let lonDeg = b(1) + lonOff;
  if (lonDeg >= 180 && lonDeg <= 189) lonDeg -= 80;
  else if (lonDeg >= 190 && lonDeg <= 199) lonDeg -= 190;
  let lonMin = b(2);
  if (lonMin >= 60) lonMin -= 60;
  const lonHun = b(3);
  if (lonDeg < 0 || lonDeg > 179 || lonMin < 0 || lonHun < 0 || lonHun > 99) return null;
  let lon = lonDeg + (lonMin + lonHun / 100) / 60;
  if (west) lon = -lon;

  const sp = b(4);
  const dc = b(5);
  const se = b(6);
  let speed = sp * 10 + Math.floor(dc / 10);
  let course = (dc % 10) * 100 + se;
  if (speed >= 800) speed -= 800;
  if (course >= 400) course -= 400;

  let comment = info.slice(9);
  let altM;
  const am = /^(.?)([!-{]{3})\}/.exec(comment);
  if (am && (am[1] === "" || am[1] === ">" || am[1] === "]" || am[1] === "`" || am[1] === "'")) {
    altM = base91(am[2]) - 10000;
    comment = am[1] + comment.slice(am[0].length);
  }
  const out = {
    type: "mic-e",
    lat,
    lon,
    posSource: "aprs",
    symCode: info[7],
    symTable: info[8],
    speedKn: speed,
    course,
    comment: comment,
    status: custom ? "Custom-" + (7 - msgBits) : MICE_STD[msgBits],
    ambiguity: 0,
  };
  if (Number.isFinite(altM)) out.altM = altM;
  return out;
}

/* ---------- NMEA ---------- */

function nmeaCoord(v, h) {
  const m = /^(\d+)(\d{2}\.\d+)$/.exec(v || "");
  if (!m) return null;
  let x = Number(m[1]) + Number(m[2]) / 60;
  if (h === "S" || h === "W") x = -x;
  return x;
}
function parseNmea(info) {
  const f = info.split("*")[0].split(",");
  let lat;
  let lon;
  if (/^\$G[PN]RMC$/.test(f[0])) {
    lat = nmeaCoord(f[3], f[4]);
    lon = nmeaCoord(f[5], f[6]);
  } else if (/^\$G[PN]GGA$/.test(f[0])) {
    lat = nmeaCoord(f[2], f[3]);
    lon = nmeaCoord(f[4], f[5]);
  } else if (/^\$G[PN]GLL$/.test(f[0])) {
    lat = nmeaCoord(f[1], f[2]);
    lon = nmeaCoord(f[3], f[4]);
  }
  const out = { type: "nmea", text: info };
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    out.lat = lat;
    out.lon = lon;
    out.posSource = "aprs";
  }
  return out;
}

/* ---------- main ---------- */

function gridFallback(out, text) {
  if (Number.isFinite(out.lat)) return out;
  const g = findGrid(text);
  if (g) {
    const c = gridToLatLon(g);
    out.grid = g;
    out.lat = c.lat;
    out.lon = c.lon;
    out.posSource = "grid";
  }
  return out;
}

function parseInfo(dst, info) {
  const s = String(info == null ? "" : info);
  const dstCall = typeof dst === "string" ? dst.split("-")[0] : dst && dst.call;
  const dti = s[0];
  try {
    if (dti === "!" || dti === "=" || dti === "/" || dti === "@") {
      const ts = dti === "/" || dti === "@";
      const body = s.slice(ts ? 8 : 1);
      const p = parsePositionBody(body);
      const out = { type: "position", messaging: dti === "=" || dti === "@" };
      if (p) return withPos(out, p);
      // '!' may also be a weather station without position; fall through
      out.type = "other";
      out.text = s;
      return gridFallback(out, s);
    }
    if (dti === "`" || dti === "'" || dti === "\x1c" || dti === "\x1d") {
      const m = parseMicE(dstCall, s);
      if (m) return m;
    }
    if (dti === ";" && s.length >= 18) {
      const name = s.slice(1, 10).trim();
      const live = s[10] === "*";
      const p = parsePositionBody(s.slice(18));
      const out = { type: "object", object: { name, live } };
      if (p) return withPos(out, p);
      out.text = s;
      return out;
    }
    if (dti === ":" && s.length >= 11 && s[10] === ":") {
      const to = s.slice(1, 10).trim().toUpperCase();
      const body = s.slice(11);
      const ar = /^(ack|rej)([A-Za-z0-9]{1,5})\s*$/.exec(body);
      if (ar) return { type: ar[1], msg: { to, text: "", id: ar[2] } };
      const im = /^(.*?)\{([A-Za-z0-9]{1,5})(\}.*)?$/.exec(body);
      const text = im ? im[1] : body;
      return gridFallback({ type: "message", msg: { to, text, id: im ? im[2] : "" } }, text);
    }
    if (dti === ">") {
      const text = s.slice(1);
      return gridFallback({ type: "status", text }, text);
    }
    if (dti === "$") return gridFallback(parseNmea(s), "");
  } catch (_) {
    /* fall through to "other" */
  }
  return gridFallback({ type: "other", text: s }, s);
}

module.exports = { parseInfo, parseMicE, parsePositionBody, gridToLatLon, findGrid, base91 };
