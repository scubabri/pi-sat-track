const satellite = require("satellite.js");
const {
  MIN_EL,
  TRAIL_MINUTES,
  TRAIL_STEP_SEC,
  PASS_HOURS,
  PASS_STEP_SEC,
} = require("./config");

/** How many upcoming passes to compute for the UI drawer / state. */
const MAX_PASSES = 5;

function gmstFromDate(date) {
  return satellite.gstime(date);
}

function eciToLatLon(positionEci, date) {
  const gmst = gmstFromDate(date);
  const geodetic = satellite.eciToGeodetic(positionEci, gmst);
  let lon = satellite.radiansToDegrees(geodetic.longitude);
  lon = ((lon + 180) % 360) - 180;
  return {
    lat: satellite.radiansToDegrees(geodetic.latitude),
    lon,
    heightKm: geodetic.height,
  };
}

function lookAngles(satrec, observer, date) {
  const pv = satellite.propagate(satrec, date);
  if (!pv.position || typeof pv.position === "boolean") return null;
  const gmst = gmstFromDate(date);
  const positionEcf = satellite.eciToEcf(pv.position, gmst);
  const look = satellite.ecfToLookAngles(observer, positionEcf);
  return {
    az: satellite.radiansToDegrees(look.azimuth),
    el: satellite.radiansToDegrees(look.elevation),
    rangeKm: look.rangeSat,
  };
}

function lookAnglesLead(satrec, observer, date, leadSec) {
  return lookAngles(
    satrec,
    observer,
    new Date(date.getTime() + (leadSec || 0) * 1000),
  );
}

function angularDistanceDeg(az1, el1, az2, el2) {
  const a1 = (az1 * Math.PI) / 180;
  const e1 = (el1 * Math.PI) / 180;
  const a2 = (az2 * Math.PI) / 180;
  const e2 = (el2 * Math.PI) / 180;
  const cosD =
    Math.sin(e1) * Math.sin(e2) +
    Math.cos(e1) * Math.cos(e2) * Math.cos(a1 - a2);
  return (Math.acos(Math.max(-1, Math.min(1, cosD))) * 180) / Math.PI;
}

function rangeRateKmS(satrec, observer, date) {
  const look0 = lookAngles(satrec, observer, date);
  const look1 = lookAngles(
    satrec,
    observer,
    new Date(date.getTime() + 1000),
  );
  if (!look0 || !look1) return null;
  return look1.rangeKm - look0.rangeKm;
}

function groundPoint(satrec, date) {
  const pv = satellite.propagate(satrec, date);
  if (!pv.position || typeof pv.position === "boolean") return null;
  return eciToLatLon(pv.position, date);
}

function buildTrail(satrec, now, minutes, stepSec) {
  minutes = minutes != null ? minutes : TRAIL_MINUTES;
  stepSec = stepSec != null ? stepSec : TRAIL_STEP_SEC;
  const points = [];
  const start = now.getTime() - minutes * 60 * 1000;
  for (let t = start; t <= now.getTime(); t += stepSec * 1000) {
    const p = groundPoint(satrec, new Date(t));
    if (p) points.push([p.lat, p.lon]);
  }
  return points;
}

function buildForwardTrack(satrec, now, orbits, stepSec) {
  orbits = orbits != null ? orbits : 1;
  stepSec = stepSec != null ? stepSec : TRAIL_STEP_SEC;
  const periodMin = (2 * Math.PI) / satrec.no;
  const totalSec = periodMin * orbits * 60;
  const points = [];
  const end = now.getTime() + totalSec * 1000;
  for (let t = now.getTime(); t <= end; t += stepSec * 1000) {
    const p = groundPoint(satrec, new Date(t));
    if (p) points.push([p.lat, p.lon]);
  }
  return points;
}

/** Binary-search the horizon crossing to ~0.1 s (same idea as catalog horizonFlags). */
function refineCrossing(satrec, observer, tLo, tHi, minEl, rising) {
  let lo = tLo;
  let hi = tHi;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    const look = lookAngles(satrec, observer, new Date(mid));
    const el = look ? look.el : -90;
    if (rising) {
      if (el >= minEl) hi = mid;
      else lo = mid;
    } else {
      if (el < minEl) hi = mid;
      else lo = mid;
    }
  }
  return hi;
}

function findPasses(satrec, observer, now, minEl, hours, stepSec) {
  minEl = minEl != null ? minEl : MIN_EL;
  hours = hours != null ? hours : PASS_HOURS;
  // LEO passes are sparse in geometry; 12h often yields only 1–2. Use at least 48h for MAX_PASSES.
  if (hours < 48) hours = 48;
  stepSec = stepSec != null ? stepSec : PASS_STEP_SEC;

  const passes = [];
  const end = new Date(now.getTime() + hours * 3600 * 1000);
  const lookbackMs = 20 * 60 * 1000;
  const start = new Date(now.getTime() - lookbackMs);

  let prevEl = null;
  let prevT = null;
  let aosTime = null;
  let aosAz = null;
  let maxEl = minEl;

  for (let t = start.getTime(); t <= end.getTime(); t += stepSec * 1000) {
    const date = new Date(t);
    const look = lookAngles(satrec, observer, date);
    if (!look) continue;
    const el = look.el;

    if (prevEl !== null && prevT != null) {
      if (prevEl < minEl && el >= minEl) {
        // Refine AOS within [prevT, t]
        const aosMs = refineCrossing(satrec, observer, prevT, t, minEl, true);
        aosTime = new Date(aosMs);
        const lookAos = lookAngles(satrec, observer, aosTime);
        aosAz = lookAos ? lookAos.az : look.az;
        maxEl = el;
      } else if (prevEl >= minEl && el < minEl && aosTime) {
        // Refine LOS within [prevT, t]
        const losMs = refineCrossing(satrec, observer, prevT, t, minEl, false);
        const losTime = new Date(losMs);
        if (losMs >= now.getTime() - stepSec * 1000) {
          passes.push({
            aos: aosTime.toISOString(),
            los: losTime.toISOString(),
            maxEl,
            aosAz,
          });
          if (passes.length >= MAX_PASSES) break;
        }
        aosTime = null;
        maxEl = minEl;
      } else if (aosTime && el > maxEl) {
        maxEl = el;
      }
    }
    prevEl = el;
    prevT = t;
  }

  if (aosTime && passes.length < MAX_PASSES) {
    const lookEnd = lookAngles(satrec, observer, end);
    if (lookEnd && lookEnd.el >= minEl) {
      passes.push({
        aos: aosTime.toISOString(),
        los: end.toISOString(),
        maxEl: Math.max(maxEl, lookEnd.el),
        aosAz,
      });
    }
  }

  passes.sort((a, b) => new Date(a.aos) - new Date(b.aos));

  const currentIdx = passes.findIndex((p) => {
    const aos = new Date(p.aos).getTime();
    const los = new Date(p.los).getTime();
    return aos <= now.getTime() && los >= now.getTime();
  });
  if (currentIdx > 0) {
    const cur = passes.splice(currentIdx, 1)[0];
    passes.unshift(cur);
  }

  return passes.slice(0, MAX_PASSES);
}

function passSkyPath(satrec, observer, aosIso, losIso, stepSec) {
  stepSec = stepSec != null ? stepSec : PASS_STEP_SEC;
  const points = [];
  const start = new Date(aosIso).getTime();
  const end = new Date(losIso).getTime();
  for (let t = start; t <= end; t += stepSec * 1000) {
    const look = lookAngles(satrec, observer, new Date(t));
    if (look && look.el >= 0) points.push({ az: look.az, el: look.el });
  }
  return points;
}

module.exports = {
  lookAngles,
  lookAnglesLead,
  angularDistanceDeg,
  rangeRateKmS,
  groundPoint,
  buildTrail,
  buildForwardTrack,
  findPasses,
  passSkyPath,
  MAX_PASSES,
};
