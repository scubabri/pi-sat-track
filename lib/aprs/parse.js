/**
 * APRS info-field parser (APRS101 subset): positions (uncompressed /
 * compressed, with or without timestamp), Mic-E, objects, messages / acks,
 * status, raw NMEA ($GPRMC/$GPGGA) and a Maidenhead-grid fallback for the
 * free-text packets common via the ISS ("CQ K1ABC FN42").
 *
 * parseInfo(dst, info) -> {
 *   type: "position"|"mic-e"|"object"|"item"|"message"|"ack"|"rej"|"status"|
 *         "weather"|"telemetry"|"nmea"|"other",
 *   lat, lon, posSource: "aprs"|"grid"|undefined, ambiguity,
 *   symTable, symCode, comment, speedKn, course, altM, phg, wx, device,
 *   msg: {to, text, id},   // message / ack / rej
 *   object: {name, live},
 *   text,                  // status or free text
 * }
 */

const { MICE_SUFFIX, MICE_LEGACY } = require("./mice-devices");

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
  if (alt != null) {
    out.altM = alt;
    out.comment = out.comment.replace(/\/A=-?\d{6}/, "").replace(/^\s+/, "");
  }
  // PHG data extension "PHGphgd" (APRS101 ch. 7)
  const ph = /^PHG(\d)(\d)(\d)(\d)/.exec(out.comment);
  if (ph) {
    out.phg = parsePhg(ph[0]);
    out.comment = out.comment.slice(7).replace(/^\s+/, "");
  }
  // Weather report riding on a position with the weather symbol "_" (APRS101 ch. 12)
  if (out.symCode === "_") {
    const wx = parseWeather(out.comment, !!cs || out.course != null);
    if (wx) {
      out.wx = wx.wx;
      out.comment = wx.rest;
      // on a weather station "ccc/sss" is wind direction / speed (mph), not course
      if (out.course != null) {
        out.wx.windDir = out.course;
        out.wx.windMph = out.speedKn;
        delete out.course;
        delete out.speedKn;
      }
    }
  }
  return out;
}

const PHG_DIR = ["omni", "NE", "E", "SE", "S", "SW", "W", "NW", "N"];
/** "PHG2160" -> {powerW: 4, heightFt: 20, gainDb: 6, dir: "omni"} */
function parsePhg(s) {
  const m = /^PHG(\d)(\d)(\d)(\d)/.exec(s || "");
  if (!m) return null;
  return {
    powerW: Number(m[1]) * Number(m[1]),
    heightFt: Math.round(10 * Math.pow(2, Number(m[2]))),
    gainDb: Number(m[3]),
    dir: PHG_DIR[Number(m[4])] || "",
  };
}

/**
 * Weather data (APRS101 ch. 12): "ccc/sss" (wind dir/speed, already split off
 * as course/speed on positions) or "cccsss" positionless, then gGGG tTTT rRRR
 * pPPP PPPP hHH bBBBBB. Returns {wx: {...}, rest} or null.
 */
function parseWeather(s, windInCourse) {
  let t = String(s || "");
  const wx = {};
  let any = false;
  if (!windInCourse) {
    const w = /^(\d{3}|\.{3}|\s{3})\/(\d{3}|\.{3}|\s{3})/.exec(t) || /^c(\d{3}|\.{3})s(\d{3}|\.{3})/.exec(t);
    if (w) {
      if (/^\d+$/.test(w[1])) wx.windDir = Number(w[1]);
      if (/^\d+$/.test(w[2])) wx.windMph = Number(w[2]);
      t = t.slice(w[0].length);
      any = true;
    }
  }
  const F = { g: ["gustMph", 3], t: ["tempF", 3], r: ["rain1hIn", 3], p: ["rain24hIn", 3], P: ["rainMidIn", 3], h: ["humidity", 2], b: ["pressureMbar", 5], L: ["lum", 3], l: ["lum", 3], s: ["snowIn", 3] };
  for (;;) {
    const k = t[0];
    if (!F[k]) break;
    const [name, n] = F[k];
    const v = t.slice(1, 1 + n);
    if (v.length !== n || !/^(-?\d+|\.+|\s+)$/.test(v)) break;
    if (/\d/.test(v)) {
      let num = Number(v);
      if (name.startsWith("rain")) num /= 100;
      if (name === "pressureMbar") num /= 10;
      if (name === "humidity" && num === 0) num = 100;
      if (k === "l") num += 1000;
      wx[name] = num;
    }
    t = t.slice(1 + n);
    any = true;
  }
  return any ? { wx, rest: t.trim() } : null;
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

  // Copied logs (aprs.fi, Graywolf/Direwolf console, chat) drop the
  // non-printable speed/course bytes 0x1c-0x1f, leaving the symbol one byte
  // early. If byte 8 is not a symbol table but byte 7 is, read the symbol
  // from bytes 6-7 and treat speed/course as unknown.
  const isTable = (c) => /^[/\\0-9A-Z]$/.test(c || "");
  const short = !isTable(info[8]) && isTable(info[7]);
  const cl = cleanMicEComment(info.slice(short ? 8 : 9));
  const comment = cl.comment;
  const altM = cl.altM;
  const out = {
    type: "mic-e",
    lat,
    lon,
    posSource: "aprs",
    symCode: short ? info[6] : info[7],
    symTable: short ? info[7] : info[8],
    speedKn: short ? null : speed,
    course: short ? null : course,
    comment: comment,
    status: custom ? "Custom-" + (7 - msgBits) : MICE_STD[msgBits],
    ambiguity: 0,
  };
  if (Number.isFinite(altM)) out.altM = altM;
  if (cl.device) out.device = cl.device;
  if (cl.messaging != null) out.messaging = cl.messaging;
  if (short) out.truncated = true;
  return out;
}

/**
 * Mic-E comment ("status text") cleanup, APRS 1.01 ch. 10 + mic-e-types:
 *   - leading type char: ` (messaging capable) / ' (tracker), or legacy
 *     Kenwood ">" (HT) / "]" (mobile)
 *   - base-91 altitude "xxx}" (metres + 10000) right after it
 *   - trailing device id: 2-char suffix after ` / ' (Yaesu "_1", Byonics
 *     "|3", ...), or Kenwood 1-char suffix ("=", "^", "&")
 * Mic-E telemetry (old 1.01 hex channels) is not decoded.
 * Returns {comment, altM, device, messaging}.
 */
function cleanMicEComment(raw) {
  let c = String(raw || "");
  let prefix = "";
  let messaging;
  let altM;
  let device = "";
  if (c[0] === "`" || c[0] === "'" || c[0] === ">" || c[0] === "]") {
    prefix = c[0];
    messaging = prefix !== "'";
    c = c.slice(1);
  }
  const am = /^([!-{]{3})\}/.exec(c);
  if (am) {
    altM = base91(am[1]) - 10000;
    c = c.slice(4);
  }
  if (prefix === "`" || prefix === "'") {
    // Exact tail first ("_ " = VX-8 and " X" = AP510 contain a space), then
    // with trailing whitespace / CR-LF removed (some gateways pad the frame).
    for (const s of [c, c.replace(/\s+$/, "")]) {
      const tail = s.slice(-2);
      if (s.length >= 2 && MICE_SUFFIX.has(tail)) {
        device = MICE_SUFFIX.get(tail);
        c = s.slice(0, -2);
        break;
      }
    }
  } else if (prefix) {
    for (const l of MICE_LEGACY) {
      const s = c.replace(/\s+$/, "");
      if (l.prefix === prefix && (!l.suffix || s.endsWith(l.suffix))) {
        device = l.name;
        if (l.suffix) c = s.slice(0, -l.suffix.length);
        break;
      }
    }
  }
  const out = { comment: c.trim() };
  if (Number.isFinite(altM)) out.altM = altM;
  if (device) out.device = device;
  if (messaging != null) out.messaging = messaging;
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

function parseInfo(dst, info, depth) {
  const s = String(info == null ? "" : info);
  const dstCall = typeof dst === "string" ? dst.split("-")[0] : dst && dst.call;
  const dti = s[0];
  try {
    // Third-party traffic (APRS 1.01 ch. 17): "}SRC>DEST,PATH:info" gated to RF
    // by an iGate. Decode the encapsulated packet recursively and classify it
    // by the inner type; thirdParty = the innermost header.
    if (dti === "}" && (depth || 0) < 4) {
      const m = /^\}([A-Za-z0-9-]{1,9})>([A-Za-z0-9-]{1,9})((?:,[A-Za-z0-9-]{1,10}\*?)*):([\s\S]*)$/.exec(s);
      if (m) {
        const inner = parseInfo(m[2], m[4], (depth || 0) + 1);
        const tp = { src: m[1].toUpperCase(), dst: m[2].toUpperCase(), path: m[3] ? m[3].slice(1).toUpperCase().split(",") : [], info: m[4] };
        return Object.assign({}, inner, { thirdParty: inner.thirdParty || tp });
      }
    }
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
    if (dti === ")") {
      // Item: ")NAME!" or ")NAME_" (3-9 chars) then position
      const im = /^\)([\x20-\x7e]{3,9}?)([!_])/.exec(s);
      if (im) {
        const p = parsePositionBody(s.slice(im[0].length));
        const out = { type: "item", object: { name: im[1].trim(), live: im[2] === "!" } };
        if (p) return withPos(out, p);
        out.text = s;
        return out;
      }
    }
    if (dti === "_" && /^_\d{8}/.test(s)) {
      // Positionless weather report: _MMDDHHMM + data
      const wx = parseWeather(s.slice(9), false);
      return { type: "weather", wx: wx ? wx.wx : {}, text: wx ? wx.rest : s.slice(9) };
    }
    if (dti === "T" && s[1] === "#") {
      return { type: "telemetry", text: s.slice(2) };
    }
    // Message ":ADDRESSEE:text". The addressee field should be 9 chars padded,
    // but some gateways send it short (":K7ETC-7 :..."), so accept 1-9.
    const am = dti === ":" ? /^:([^:]{1,9}):/.exec(s) : null;
    if (am && am[1].trim()) {
      const to = am[1].trim().toUpperCase();
      const body = s.slice(am[0].length);
      const ar = /^(ack|rej)([A-Za-z0-9]{1,5})\s*$/.exec(body);
      if (ar) return { type: ar[1], msg: { to, text: "", id: ar[2] } };
      // Telemetry definitions travel as messages to the station itself.
      if (/^(PARM|UNIT|EQNS|BITS)\./.test(body)) return { type: "telemetry", msg: { to, text: body, id: "" }, text: body };
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

module.exports = { parseInfo, parseMicE, cleanMicEComment, parsePhg, parseWeather, parsePositionBody, gridToLatLon, findGrid, base91 };
