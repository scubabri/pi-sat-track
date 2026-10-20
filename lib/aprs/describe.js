/**
 * Human-readable packet descriptions + filter categories for the APRS
 * traffic window (js/aprs-window.js).
 *
 * category(parsed, dir, kind) -> "message" | "position" | "status" |
 *   "object" | "weather" | "telemetry" | "other"
 *   - messages incl. our own UI text / header sends
 *   - positions incl. Mic-E and NMEA
 *   - status / beacons: ">" status and plain-text beacons ("CQ ...")
 * describe(parsed) -> one line, e.g.
 *   "41.1615 N 112.0260 W · 14 kn 200° · 1391 m · W5SAT"
 */
function fmtLatLon(lat, lon) {
  return Math.abs(lat).toFixed(4) + (lat < 0 ? " S " : " N ") + Math.abs(lon).toFixed(4) + (lon < 0 ? " W" : " E");
}

function category(p, dir, kind) {
  const t = (p && p.type) || "other";
  if (dir === "tx" && (kind === "text" || kind === "header" || kind === "message")) return "message";
  switch (t) {
    case "message":
    case "ack":
    case "rej":
      return "message";
    case "position":
    case "mic-e":
    case "nmea":
      return p.wx ? "weather" : "position";
    case "object":
    case "item":
      return "object";
    case "weather":
      return "weather";
    case "telemetry":
      return "telemetry";
    case "status":
      return "status";
    default:
      // Plain-text UI beacons ("CQ BH2VSQ OL79", "BEACON ...") count as beacons.
      return p && p.text && String(p.text).trim() ? "status" : "other";
  }
}

function wxText(w) {
  if (!w) return "";
  const a = [];
  if (w.windDir != null || w.windMph != null) a.push("wind " + (w.windDir != null ? w.windDir + "°" : "?") + " " + (w.windMph != null ? w.windMph + " mph" : ""));
  if (w.gustMph != null) a.push("gust " + w.gustMph + " mph");
  if (w.tempF != null) a.push(w.tempF + "°F (" + Math.round(((w.tempF - 32) * 5) / 9) + "°C)");
  if (w.humidity != null) a.push(w.humidity + "% RH");
  if (w.pressureMbar != null) a.push(w.pressureMbar.toFixed(1) + " hPa");
  if (w.rain1hIn != null) a.push("rain 1h " + w.rain1hIn.toFixed(2) + " in");
  if (w.rain24hIn != null && w.rain24hIn > 0) a.push("24h " + w.rain24hIn.toFixed(2) + " in");
  return a.join(", ");
}

function posText(p) {
  const a = [];
  if (Number.isFinite(p.lat) && p.posSource !== "grid") a.push(fmtLatLon(p.lat, p.lon));
  else if (p.grid) a.push("grid " + p.grid);
  if (p.speedKn != null && (p.speedKn > 0 || p.course > 0)) a.push(Math.round(p.speedKn) + " kn " + (p.course != null ? p.course + "°" : ""));
  if (p.altM != null) a.push(p.altM + " m");
  if (p.phg) a.push("PHG " + p.phg.powerW + " W, " + p.phg.heightFt + " ft, " + p.phg.gainDb + " dBi, " + p.phg.dir);
  if (p.wx) a.push(wxText(p.wx));
  const c = String(p.comment || "").trim();
  if (c) a.push(c);
  return a.join(" · ");
}

function describe(p) {
  if (!p) return "";
  switch (p.type) {
    case "position":
    case "mic-e":
    case "nmea":
      return posText(p) + (p.type === "mic-e" && p.status && !/^Custom/.test(p.status) && p.status !== "Off Duty" ? " · " + p.status : "");
    case "object":
    case "item":
      return (p.type === "item" ? "Item " : "Object ") + ((p.object && p.object.name) || "") + (p.object && !p.object.live ? " (killed)" : "") + (Number.isFinite(p.lat) ? " · " + posText(p) : "");
    case "message":
      return "→ " + (p.msg ? p.msg.to : "") + ": " + (p.msg ? p.msg.text : "");
    case "ack":
    case "rej":
      return p.type + " " + (p.msg ? p.msg.id : "") + " → " + (p.msg ? p.msg.to : "");
    case "weather":
      return wxText(p.wx) + (p.text ? " · " + p.text : "");
    case "telemetry":
      return p.msg ? "→ " + p.msg.to + ": " + p.msg.text : "T#" + (p.text || "");
    case "status":
      return String(p.text || "").trim();
    default:
      return p.text != null ? String(p.text).trim() : "";
  }
}

module.exports = { category, describe, wxText, fmtLatLon };
