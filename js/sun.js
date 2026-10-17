/**
 * Sun position + day/night terminator, shared by the map (js/map.js) and the
 * globe (js/globe-view.js). No dependency: low-precision solar position from
 * the Astronomical Almanac (accurate to ~0.01 deg, plenty for a shaded night side).
 *   n      = days since J2000.0 (JD - 2451545.0)
 *   L, g   = mean longitude / mean anomaly of the Sun
 *   lambda = ecliptic longitude, eps = obliquity
 *   RA, dec from (lambda, eps); GMST from n.
 * Subsolar point: lat = dec, lon = RA - GMST (this implicitly includes the
 * equation of time).
 */
(function () {
  const D = Math.PI / 180;
  const norm180 = (x) => ((((x + 180) % 360) + 360) % 360) - 180;

  function subsolar(date) {
    const t = date instanceof Date ? date.getTime() : Number.isFinite(date) ? date : Date.now();
    const n = t / 86400000 + 2440587.5 - 2451545.0;
    const L = 280.46 + 0.9856474 * n;
    const g = (357.528 + 0.9856003 * n) * D;
    const lam = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D;
    const eps = (23.439 - 0.0000004 * n) * D;
    const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) / D;
    const dec = Math.asin(Math.sin(eps) * Math.sin(lam)) / D;
    const gmst = 280.46061837 + 360.98564736629 * n;
    return { lat: dec, lon: norm180(ra - gmst) };
  }

  /**
   * Terminator latitude at each longitude from lonFrom to lonTo (step deg):
   * points where the sun is on the horizon, tan(lat) = -cos(lon - lonS) / tan(dec).
   * Returns [[lat, lon], ...] with lon continuous (not wrapped), so callers can
   * draw extra world copies by passing e.g. -540..540.
   */
  function terminator(sun, lonFrom, lonTo, step) {
    let dec = sun.lat;
    if (Math.abs(dec) < 0.05) dec = dec < 0 ? -0.05 : 0.05; // equinox: avoid tan(0)
    const td = Math.tan(dec * D);
    const out = [];
    for (let lo = lonFrom; lo <= lonTo + 1e-9; lo += step) {
      const la = Math.atan(-Math.cos((lo - sun.lon) * D) / td) / D;
      out.push([la, lo]);
    }
    return out;
  }

  /** The pole that is in polar night: north when the sun is south of the equator. */
  function nightPoleLat(sun) { return sun.lat < 0 ? 90 : -90; }

  window.sunCalc = { subsolar, terminator, nightPoleLat };
})();
