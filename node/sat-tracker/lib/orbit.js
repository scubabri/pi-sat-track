const satellite = require("satellite.js");
const {
  MIN_EL,
  TRAIL_MINUTES,
  TRAIL_STEP_SEC,
  PASS_HOURS,
  PASS_STEP_SEC,
} = require("./config");

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
  if (!pv.position) return null;
  const gmst = gmstFromDate(date);
  const positionEcf = satellite.eciToEcf(pv.position, gmst);
  const look = satellite.ecfToLookAngles(observer, positionEcf);
  return {
    az: satellite.radiansToDegrees(look.azimuth),
    el: satellite.radiansToDegrees(look.elevation),
    rangeKm: look.rangeSat,
  };
}

/**
 * Approximate angular separation (degrees) between two az/el points.
 * Uses mean elevation for the azimuth component.
 */
function angularDistanceDeg(a, b) {
  if (!a || !b) return 0;
  let daz = b.az - a.az;
  daz = ((daz + 540) % 360) - 180; // shortest angle
  const meanElRad = ((a.el + b.el) / 2) * (Math.PI / 180);
  const cosEl = Math.cos(meanElRad);
  return Math.sqrt((daz * cosEl) ** 2 + (b.el - a.el) ** 2);
}

/**
 * Return look angles approximately `leadDeg` ahead of `now` along the track.
 * Iteratively finds a future time that yields ~leadDeg of angular travel.
 */
function lookAnglesLead(satrec, observer, now, leadDeg) {
  if (!leadDeg || leadDeg <= 0) return lookAngles(satrec, observer, now);

  const current = lookAngles(satrec, observer, now);
  if (!current) return null;

  // Initial guess: assume ~0.3–0.5 °/s typical LEO near mid-pass
  let dtSec = leadDeg / 0.4;
  const maxDt = 90; // safety
  const minDt = 0.5;

  for (let i = 0; i < 12; i++) {
    dtSec = Math.max(minDt, Math.min(maxDt, dtSec));
    const future = lookAngles(
      satrec,
      observer,
      new Date(now.getTime() + dtSec * 1000),
    );
    if (!future) break;

    const dang = angularDistanceDeg(current, future);
    if (Math.abs(dang - leadDeg) < 0.3) return future; // close enough
    if (dang < 0.05) {
      // almost stationary – just return a modest fixed lead
      return lookAngles(
        satrec,
        observer,
        new Date(now.getTime() + Math.min(15, leadDeg / 0.2) * 1000),
      );
    }
    // scale time proportionally
    dtSec = dtSec * (leadDeg / dang);
  }

  return lookAngles(
    satrec,
    observer,
    new Date(now.getTime() + Math.max(minDt, Math.min(maxDt, dtSec)) * 1000),
  );
}

function rangeRateKmS(satrec, observer, date) {
  const pv = satellite.propagate(satrec, date);
  if (!pv.position || !pv.velocity) return null;
  const gmst = gmstFromDate(date);
  const posEcf = satellite.eciToEcf(pv.position, gmst);
  const velEcf = satellite.eciToEcf(pv.velocity, gmst);
  const obsEcf = satellite.geodeticToEcf(observer);
  const dx = posEcf.x - obsEcf.x;
  const dy = posEcf.y - obsEcf.y;
  const dz = posEcf.z - obsEcf.z;
  const range = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (range < 1e-6) return 0;
  return (dx * velEcf.x + dy * velEcf.y + dz * velEcf.z) / range;
}

function groundPoint(satrec, date) {
  const pv = satellite.propagate(satrec, date);
  if (!pv.position) return null;
  return eciToLatLon(pv.position, date);
}

function buildTrail(satrec, now, minutes, stepSec) {
  minutes = minutes != null ? minutes : TRAIL_MINUTES;
  stepSec = stepSec != null ? stepSec : TRAIL_STEP_SEC;
  const points = [];
  const start = new Date(now.getTime() - minutes * 60 * 1000);
  for (let t = start.getTime(); t <= now.getTime(); t += stepSec * 1000) {
    const p = groundPoint(satrec, new Date(t));
    if (p) points.push([p.lat, p.lon]);
  }
  return points;
}

function buildForwardTrack(satrec, now, orbits, stepSec) {
  orbits = orbits != null ? orbits : 2;
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

function findPasses(satrec, observer, now, minEl, hours, stepSec) {
  minEl = minEl != null ? minEl : MIN_EL;
  hours = hours != null ? hours : PASS_HOURS;
  stepSec = stepSec != null ? stepSec : PASS_STEP_SEC;

  const passes = [];
  const end = new Date(now.getTime() + hours * 3600 * 1000);
  const lookbackMs = 20 * 60 * 1000;
  const start = new Date(now.getTime() - lookbackMs);

  let prevEl = null;
  let aosTime = null;
  let aosAz = null;
  let maxEl = minEl;

  for (let t = start.getTime(); t <= end.getTime(); t += stepSec * 1000) {
    const date = new Date(t);
    const look = lookAngles(satrec, observer, date);
    if (!look) continue;
    const el = look.el;

    if (prevEl !== null) {
      if (prevEl < minEl && el >= minEl) {
        aosTime = date;
        aosAz = look.az;
        maxEl = el;
      } else if (prevEl >= minEl && el < minEl && aosTime) {
        if (date.getTime() >= now.getTime() - stepSec * 1000) {
          passes.push({
            aos: aosTime.toISOString(),
            los: date.toISOString(),
            maxEl,
            aosAz,
          });
          if (passes.length >= 2) break;
        }
        aosTime = null;
        maxEl = minEl;
      } else if (aosTime && el > maxEl) {
        maxEl = el;
      }
    }
    prevEl = el;
  }

  if (aosTime && passes.length < 2) {
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

  return passes.slice(0, 2);
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
};
