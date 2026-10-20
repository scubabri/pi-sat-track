/**
 * Moon / EME target: topocentric ephemeris, rise/set windows ("passes"),
 * sub-lunar point and EME figures. No TLE, no network: pure math.
 *
 * Ephemeris: Jean Meeus, "Astronomical Algorithms" (2nd ed., 1998)
 *   ch. 47  Moon position (ELP-2000/82 truncated: ~10" in longitude, ~4" in
 *           latitude, ~20 km distance)
 *   ch. 22  nutation (low-precision terms, ~0.5")
 *   ch. 12  sidereal time
 *   ch. 25  Sun (low precision; only used for phase / illumination)
 *   ch. 48  illuminated fraction
 * Topocentric parallax (~1 deg for the Moon) is rigorous: the geocentric Moon
 * vector is rotated into the Earth-fixed frame (GAST) and the observer's WGS-84
 * position is subtracted before az / el / range are taken.
 * The periodic-term tables (47.A / 47.B) are copied from the MIT-licensed
 * "astronomia" package (Sonia Keys, commenthol), a port of Meeus.
 * Elevation is geometric (no refraction), same as the satellite code.
 * Verified against astronomy-engine (test/moon.test.js): az/el within ~0.01 deg.
 *
 * The rest of the app treats the Moon like a satellite whose "satrec" is
 * MOON_REC: lib/orbit.js dispatches lookAngles / rangeRateKmS / groundPoint /
 * findPasses / passSkyPath here when it sees it.
 */
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const MOON_KEY = "MOON";
const MOON_REC = Object.freeze({ isMoon: true, key: MOON_KEY });
const C_KMS = 299792.458;
const AU_KM = 149597870.7;
const EARTH_R_KM = 6371.0; // mean radius (sub-point altitude / map footprint)
const WGS84_A = 6378.137;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const MOON_RADIUS_KM = 1737.4;
/**
 * TT - UTC (s). ~69.2 s through the 2020s (IERS); a few seconds of error move
 * the Moon by < 3", so a constant is plenty for tracking.
 */
const DELTA_T_SEC = 69.2;

const isMoonKey = (k) => k != null && String(k).toUpperCase() === MOON_KEY;
const isMoonRec = (r) => !!(r && r.isMoon === true);
const norm360 = (x) => ((x % 360) + 360) % 360;
const norm180 = (x) => ((((x + 180) % 360) + 360) % 360) - 180;


/** [D, M, M', F, Σl (1e-6 deg), Σr (1e-3 km)] — Meeus table 47.A */
const TA = [
  [0, 0, 1, 0, 6288774, -20905355], [2, 0, -1, 0, 1274027, -3699111], [2, 0, 0, 0, 658314, -2955968], [0, 0, 2, 0, 213618, -569925],
  [0, 1, 0, 0, -185116, 48888], [0, 0, 0, 2, -114332, -3149], [2, 0, -2, 0, 58793, 246158], [2, -1, -1, 0, 57066, -152138],
  [2, 0, 1, 0, 53322, -170733], [2, -1, 0, 0, 45758, -204586], [0, 1, -1, 0, -40923, -129620], [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755], [2, 0, 0, -2, 15327, 10321], [0, 0, 1, 2, -12528, 0], [0, 0, 1, -2, 10980, 79661],
  [4, 0, -1, 0, 10675, -34782], [0, 0, 3, 0, 10034, -23210], [4, 0, -2, 0, 8548, -21636], [2, 1, -1, 0, -7888, 24208],
  [2, 1, 0, 0, -6766, 30824], [1, 0, -1, 0, -5163, -8379], [1, 1, 0, 0, 4987, -16675], [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445], [4, 0, 0, 0, 3861, -11650], [2, 0, -3, 0, 3665, 14403], [0, 1, -2, 0, -2689, -7003],
  [2, 0, -1, 2, -2602, 0], [2, -1, -2, 0, 2390, 10056], [1, 0, 1, 0, -2348, 6322], [2, -2, 0, 0, 2236, -9884],
  [0, 1, 2, 0, -2120, 5751], [0, 2, 0, 0, -2069, 0], [2, -2, -1, 0, 2048, -4950], [2, 0, 1, -2, -1773, 4130],
  [2, 0, 0, 2, -1595, 0], [4, -1, -1, 0, 1215, -3958], [0, 0, 2, 2, -1110, 0], [3, 0, -1, 0, -892, 3258],
  [2, 1, 1, 0, -810, 2616], [4, -1, -2, 0, 759, -1897], [0, 2, -1, 0, -713, -2117], [2, 2, -1, 0, -700, 2354],
  [2, 1, -2, 0, 691, 0], [2, -1, 0, -2, 596, 0], [4, 0, 1, 0, 549, -1423], [0, 0, 4, 0, 537, -1117],
  [4, -1, 0, 0, 520, -1571], [1, 0, -2, 0, -487, -1739], [2, 1, 0, -2, -399, 0], [0, 0, 2, -2, -381, -4421],
  [1, 1, 1, 0, 351, 0], [3, 0, -2, 0, -340, 0], [4, 0, -3, 0, 330, 0], [2, -1, 2, 0, 327, 0],
  [0, 2, 1, 0, -323, 1165], [1, 1, -1, 0, 299, 0], [2, 0, 3, 0, 294, 0], [2, 0, -1, -2, 0, 8752],
];
/** [D, M, M', F, Σb (1e-6 deg)] — Meeus table 47.B */
const TB = [
  [0, 0, 0, 1, 5128122], [0, 0, 1, 1, 280602], [0, 0, 1, -1, 277693], [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413], [2, 0, -1, -1, 46271], [2, 0, 0, 1, 32573], [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266], [0, 0, 2, -1, 8822], [2, -1, 0, -1, 8216], [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200], [2, 1, 0, -1, -3359], [2, -1, -1, 1, 2463], [2, -1, 0, 1, 2211],
  [2, -1, -1, -1, 2065], [0, 1, -1, -1, -1870], [4, 0, -1, -1, 1828], [0, 1, 0, 1, -1794],
  [0, 0, 0, 3, -1749], [0, 1, -1, 1, -1565], [1, 0, 0, 1, -1491], [0, 1, 1, 1, -1475],
  [0, 1, 1, -1, -1410], [0, 1, 0, -1, -1344], [1, 0, 0, -1, -1335], [0, 0, 3, 1, 1107],
  [4, 0, 0, -1, 1021], [4, 0, -1, 1, 833], [0, 0, 1, -3, 777], [4, 0, -2, 1, 671],
  [2, 0, 0, -3, 607], [2, 0, 2, -1, 596], [2, -1, 1, -1, 491], [2, 0, -2, 1, -451],
  [0, 0, 3, -1, 439], [2, 0, 2, 1, 422], [2, 0, -3, -1, 421], [2, 1, -1, 1, -366],
  [2, 1, 0, 1, -351], [4, 0, 0, 1, 331], [2, -1, 1, 1, 315], [2, -2, 0, -1, 302],
  [0, 0, 1, 3, -283], [2, 1, 1, -1, -229], [1, 1, 0, -1, 223], [1, 1, 0, 1, 223],
  [0, 1, -2, -1, -220], [2, 1, -1, -1, -220], [1, 0, 1, 1, -185], [2, -1, -2, -1, 181],
  [0, 1, 2, 1, -177], [4, 0, -2, -1, 176], [4, -1, -1, -1, 166], [1, 0, 1, -1, -164],
  [4, 0, 1, -1, 132], [1, 0, -1, -1, -119], [4, -1, 0, -1, 115], [2, -2, 0, 1, 107],
];

function poly(T, c) {
  let r = 0;
  for (let i = c.length - 1; i >= 0; i--) r = r * T + c[i];
  return r;
}

/**
 * Geocentric ecliptic position of the Moon, mean equinox of date (no nutation).
 * jde: Julian Ephemeris Day (TT). Returns { lon, lat } (deg) and dist (km).
 */
function moonEcliptic(jde) {
  const T = (jde - 2451545.0) / 36525;
  const Lp = poly(T, [218.3164477, 481267.88123421, -0.0015786, 1 / 538841, -1 / 65194000]);
  const D = poly(T, [297.8501921, 445267.1114034, -0.0018819, 1 / 545868, -1 / 113065000]) * D2R;
  const M = poly(T, [357.5291092, 35999.0502909, -0.0001536, 1 / 24490000]) * D2R;
  const Mp = poly(T, [134.9633964, 477198.8675055, 0.0087414, 1 / 69699, -1 / 14712000]) * D2R;
  const F = poly(T, [93.272095, 483202.0175233, -0.0036539, -1 / 3526000, 1 / 863310000]) * D2R;
  const A1 = (119.75 + 131.849 * T) * D2R;
  const A2 = (53.09 + 479264.29 * T) * D2R;
  const A3 = (313.45 + 481266.484 * T) * D2R;
  const E = poly(T, [1, -0.002516, -0.0000074]);
  const L = Lp * D2R;
  const eFac = (m) => (m === 0 ? 1 : Math.abs(m) === 1 ? E : E * E);
  let sl = 3958 * Math.sin(A1) + 1962 * Math.sin(L - F) + 318 * Math.sin(A2);
  let sr = 0;
  let sb =
    -2235 * Math.sin(L) + 382 * Math.sin(A3) + 175 * Math.sin(A1 - F) +
    175 * Math.sin(A1 + F) + 127 * Math.sin(L - Mp) - 115 * Math.sin(L + Mp);
  for (const r of TA) {
    const arg = r[0] * D + r[1] * M + r[2] * Mp + r[3] * F;
    const e = eFac(r[1]);
    sl += r[4] * e * Math.sin(arg);
    sr += r[5] * e * Math.cos(arg);
  }
  for (const r of TB) {
    sb += r[4] * eFac(r[1]) * Math.sin(r[0] * D + r[1] * M + r[2] * Mp + r[3] * F);
  }
  return { lon: norm360(Lp + sl / 1e6), lat: sb / 1e6, dist: 385000.56 + sr / 1000 };
}

/** Nutation in longitude / obliquity (deg), Meeus ch. 22 low-precision terms. */
function nutation(jde) {
  const T = (jde - 2451545.0) / 36525;
  const om = (125.04452 - 1934.136261 * T) * D2R;
  const Ls = (280.4665 + 36000.7698 * T) * D2R;
  const Lm = (218.3165 + 481267.8813 * T) * D2R;
  const dpsi = -17.2 * Math.sin(om) - 1.32 * Math.sin(2 * Ls) - 0.23 * Math.sin(2 * Lm) + 0.21 * Math.sin(2 * om);
  const deps = 9.2 * Math.cos(om) + 0.57 * Math.cos(2 * Ls) + 0.1 * Math.cos(2 * Lm) - 0.09 * Math.cos(2 * om);
  return { dpsi: dpsi / 3600, deps: deps / 3600 };
}

/** Mean obliquity of the ecliptic (deg), Meeus 22.2. */
function meanObliquity(jde) {
  const T = (jde - 2451545.0) / 36525;
  return 23 + 26 / 60 + (21.448 - 46.815 * T - 0.00059 * T * T + 0.001813 * T * T * T) / 3600;
}

/** Greenwich mean sidereal time (deg), Meeus 12.4; jdUt = Julian Day (UT). */
function gmstDeg(jdUt) {
  const T = (jdUt - 2451545.0) / 36525;
  return norm360(280.46061837 + 360.98564736629 * (jdUt - 2451545.0) + 0.000387933 * T * T - (T * T * T) / 38710000);
}

/** Sun apparent ecliptic longitude (deg) and distance (km), Meeus ch. 25 (low precision). */
function sunApparent(jde) {
  const T = (jde - 2451545.0) / 36525;
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * D2R;
  const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;
  const C =
    (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M) +
    (0.019993 - 0.000101 * T) * Math.sin(2 * M) + 0.000289 * Math.sin(3 * M);
  const nu = M + C * D2R;
  const R = (1.000001018 * (1 - e * e)) / (1 + e * Math.cos(nu));
  const om = (125.04 - 1934.136 * T) * D2R;
  return { lon: norm360(L0 + C - 0.00569 - 0.00478 * Math.sin(om)), dist: R * AU_KM };
}

function toDate(d) {
  return d instanceof Date ? d.getTime() : Number.isFinite(d) ? d : Date.now();
}

/**
 * Geocentric apparent Moon at a time (Date or ms, UTC):
 * { raDeg, decDeg, distKm, lonDeg, latDeg (apparent ecliptic), gastDeg, jde }.
 */
function geocentric(date) {
  const ms = toDate(date);
  const jdUt = ms / 86400000 + 2440587.5;
  const jde = jdUt + DELTA_T_SEC / 86400;
  const m = moonEcliptic(jde);
  const n = nutation(jde);
  const eps = (meanObliquity(jde) + n.deps) * D2R;
  const lam = (m.lon + n.dpsi) * D2R;
  const bet = m.lat * D2R;
  const ra = Math.atan2(Math.sin(lam) * Math.cos(eps) - Math.tan(bet) * Math.sin(eps), Math.cos(lam));
  const dec = Math.asin(Math.sin(bet) * Math.cos(eps) + Math.cos(bet) * Math.sin(eps) * Math.sin(lam));
  const gast = norm360(gmstDeg(jdUt) + n.dpsi * Math.cos(eps));
  return { raDeg: norm360(ra * R2D), decDeg: dec * R2D, distKm: m.dist, lonDeg: norm360(lam * R2D), latDeg: m.lat, gastDeg: gast, jde };
}

/**
 * Observer in satellite.js form: { latitude (rad), longitude (rad, east +),
 * height (km) } → WGS-84 Earth-fixed vector (km).
 */
function observerEcef(obs) {
  const lat = obs.latitude;
  const lon = obs.longitude;
  const h = obs.height || 0;
  const s = Math.sin(lat);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * s * s);
  return {
    x: (N + h) * Math.cos(lat) * Math.cos(lon),
    y: (N + h) * Math.cos(lat) * Math.sin(lon),
    z: (N * (1 - WGS84_E2) + h) * s,
  };
}

/** Earth-fixed geocentric Moon vector (km) from geocentric(). */
function moonEcef(g) {
  const ha = (g.raDeg - g.gastDeg) * D2R; // RA - GAST = east longitude of the sub-lunar point
  const dec = g.decDeg * D2R;
  return {
    x: g.distKm * Math.cos(dec) * Math.cos(ha),
    y: g.distKm * Math.cos(dec) * Math.sin(ha),
    z: g.distKm * Math.sin(dec),
  };
}

/** Topocentric look angles { az, el, rangeKm } (deg / km), same shape as lib/orbit.js. */
function lookAngles(observer, date) {
  if (!observer) return null;
  const m = moonEcef(geocentric(date));
  const o = observerEcef(observer);
  const dx = m.x - o.x;
  const dy = m.y - o.y;
  const dz = m.z - o.z;
  const lat = observer.latitude;
  const lon = observer.longitude;
  const sl = Math.sin(lat);
  const cl = Math.cos(lat);
  const so = Math.sin(lon);
  const co = Math.cos(lon);
  const e = -so * dx + co * dy;
  const n = -sl * co * dx - sl * so * dy + cl * dz;
  const u = cl * co * dx + cl * so * dy + sl * dz;
  const range = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return { az: norm360(Math.atan2(e, n) * R2D), el: Math.asin(u / range) * R2D, rangeKm: range };
}

/** Topocentric range rate (km/s, + = receding): central difference over ±5 s. */
function rangeRateKmS(observer, date) {
  if (!observer) return null;
  const t = toDate(date);
  const a = lookAngles(observer, t - 5000);
  const b = lookAngles(observer, t + 5000);
  return (b.rangeKm - a.rangeKm) / 10;
}

/** Sub-lunar point { lat, lon, heightKm } (geocentric dec / RA - GAST; height above mean Earth radius). */
function subPoint(date) {
  const g = geocentric(date);
  return { lat: g.decDeg, lon: norm180(g.raDeg - g.gastDeg), heightKm: g.distKm - EARTH_R_KM };
}

/**
 * Phase / illumination (Meeus ch. 48, 48.2-48.3 with the low-precision Sun):
 * { illum (0..1), phaseAngleDeg, elongationDeg (Moon - Sun longitude, 0..360,
 * 0 = new, 180 = full), phaseName, waxing }.
 */
function phase(date) {
  const g = geocentric(date);
  const s = sunApparent(g.jde);
  const bet = g.latDeg * D2R;
  const dlon = (g.lonDeg - s.lon) * D2R;
  const psi = Math.acos(Math.cos(bet) * Math.cos(dlon)); // geocentric elongation
  const i = Math.atan2(s.dist * Math.sin(psi), g.distKm - s.dist * Math.cos(psi));
  const illum = (1 + Math.cos(i)) / 2;
  const elong = norm360(g.lonDeg - s.lon);
  // Named from the illuminated fraction (quarter = 47-53 %), waxing from elongation.
  const waxing = elong < 180;
  const phaseName =
    illum < 0.03 ? "New Moon"
      : illum > 0.97 ? "Full Moon"
        : illum >= 0.47 && illum <= 0.53 ? (waxing ? "First quarter" : "Last quarter")
          : (waxing ? "Waxing " : "Waning ") + (illum < 0.5 ? "crescent" : "gibbous");
  return { illum, phaseAngleDeg: i * R2D, elongationDeg: elong, phaseName, waxing };
}

/**
 * Approximate EME path loss (dB), isotropic antennas, from the radar equation
 *   L = (4π)³ d⁴ / (σ λ²),  σ = η π r²  (r = lunar radius 1737.4 km, η ≈ 0.065
 * mean lunar reflectivity).
 * Source: standard radar-equation form used for EME, e.g. the ARRL Handbook /
 * "EME" chapter and K1JT's and VK3UM's EME calculators. This form gives
 * 252.1 / 261.6 / 271.2 dB at 144 / 432 / 1296 MHz at 384 400 km; published
 * tables quote ~252-253 / 261-262 / 271-272 dB (they differ in the assumed
 * reflectivity and distance; perigee-apogee swings it by ~2 dB). APPROXIMATE:
 * ignores libration fading, Faraday rotation, sky temperature and ground gain.
 */
function emePathLossDb(freqHz, distKm) {
  if (!(freqHz > 0) || !(distKm > 0)) return null;
  const lam = (C_KMS * 1000) / freqHz;
  const d = distKm * 1000;
  const sigma = 0.065 * Math.PI * Math.pow(MOON_RADIUS_KM * 1000, 2);
  return 10 * Math.log10((Math.pow(4 * Math.PI, 3) * Math.pow(d, 4)) / (sigma * lam * lam));
}

/** Own-echo Doppler (Hz) on freqHz for a topocentric range rate (km/s): -2·ṙ·f/c. */
function echoDopplerHz(rangeRateKmS, freqHz) {
  if (!Number.isFinite(rangeRateKmS) || !Number.isFinite(freqHz)) return null;
  return (-2 * rangeRateKmS * freqHz) / C_KMS;
}

/** Round-trip (Earth-Moon-Earth) delay in seconds for a topocentric range. */
function echoDelaySec(rangeKm) {
  return Number.isFinite(rangeKm) ? (2 * rangeKm) / C_KMS : null;
}

/**
 * Everything the panels show for the Moon at `date` (observer optional):
 * look, distance, RA / Dec (geocentric apparent), sub-lunar point, phase,
 * range rate, echo delay; with freqHz also echo Doppler and path loss.
 */
function info(observer, date, freqHz) {
  const t = toDate(date);
  const g = geocentric(t);
  const ph = phase(t);
  const look = observer ? lookAngles(observer, t) : null;
  const rr = observer ? rangeRateKmS(observer, t) : null;
  const out = {
    raDeg: g.raDeg,
    decDeg: g.decDeg,
    geoDistKm: g.distKm,
    rangeKm: look ? look.rangeKm : g.distKm,
    rangeRateKmS: rr,
    subPoint: { lat: g.decDeg, lon: norm180(g.raDeg - g.gastDeg) },
    illum: ph.illum,
    phaseName: ph.phaseName,
    phaseAngleDeg: ph.phaseAngleDeg,
    elongationDeg: ph.elongationDeg,
    echoDelaySec: echoDelaySec(look ? look.rangeKm : g.distKm),
    semiDiameterDeg: Math.asin(MOON_RADIUS_KM / g.distKm) * R2D,
  };
  if (freqHz > 0) {
    out.freqHz = freqHz;
    out.echoDopplerHz = rr != null ? echoDopplerHz(rr, freqHz) : null;
    out.pathLossDb = emePathLossDb(freqHz, look ? look.rangeKm : g.distKm);
  }
  return out;
}

// ---- Rise / set windows ("passes") ----------------------------------------
// A Moon pass is many hours long (often 10-16 h, circumpolar at high
// latitudes), so unlike LEO findPasses() a pass already in progress is walked
// back up to 30 h for its real AOS, and the scan runs for days, not hours.
const PASS_STEP_MS = 5 * 60 * 1000; // Moon el changes < 0.25 deg/min
const PASS_BACK_MS = 30 * 3600 * 1000;
const PASS_DAYS = 10;
const MAX_PASSES = 5;
const CACHE_MS = 60 * 1000;
const passCache = new Map(); // sig -> { at, passes } (a few observer / min-EL combos)

function refine(observer, lo, hi, minEl, rising) {
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    const el = lookAngles(observer, mid).el;
    if (rising ? el >= minEl : el < minEl) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * Raw windows above minEl from `nowMs`: [{ aos, los (ms), maxEl, aosAz, losAz,
 * openStart?, openEnd? }]. The first entry is the pass in progress, if any.
 */
function computePasses(observer, nowMs, minEl, maxPasses) {
  minEl = Number.isFinite(minEl) ? minEl : 0;
  maxPasses = maxPasses || MAX_PASSES;
  const elAt = (t) => lookAngles(observer, t).el;
  const out = [];
  let cur = null;
  const el0 = elAt(nowMs);
  if (el0 >= minEl) {
    let t = nowMs;
    let el = el0;
    let maxEl = el0;
    while (el >= minEl && nowMs - t < PASS_BACK_MS) {
      t -= PASS_STEP_MS;
      el = elAt(t);
      if (el > maxEl) maxEl = el;
    }
    const open = el >= minEl;
    const aos = open ? t : refine(observer, t, t + PASS_STEP_MS, minEl, true);
    cur = { aos, maxEl: Math.max(maxEl, el0), openStart: open };
  }
  const end = nowMs + PASS_DAYS * 86400000;
  let prevT = nowMs;
  let prevEl = el0;
  for (let t = nowMs + PASS_STEP_MS; t <= end && out.length < maxPasses; t += PASS_STEP_MS) {
    const el = elAt(t);
    if (!cur && prevEl < minEl && el >= minEl) {
      cur = { aos: refine(observer, prevT, t, minEl, true), maxEl: el };
    } else if (cur && el < minEl) {
      cur.los = refine(observer, prevT, t, minEl, false);
      out.push(cur);
      cur = null;
    } else if (cur && el > cur.maxEl) {
      cur.maxEl = el;
    }
    prevT = t;
    prevEl = el;
  }
  if (cur && out.length < maxPasses) {
    cur.los = end;
    cur.openEnd = true;
    out.push(cur);
  }
  for (const p of out) {
    p.aosAz = lookAngles(observer, p.aos).az;
    p.losAz = lookAngles(observer, p.los).az;
    p.maxEl = Math.round(p.maxEl * 10) / 10;
    p.aos = Math.round(p.aos);
    p.los = Math.round(p.los);
  }
  return out;
}

/** computePasses() cached for 60 s per observer / min EL (state + tick both ask often). */
function passesCached(observer, nowMs, minEl) {
  const sig = [observer.latitude, observer.longitude, observer.height, minEl].join("|");
  let c = passCache.get(sig);
  if (!c || nowMs - c.at > CACHE_MS || nowMs < c.at) {
    c = { at: nowMs, passes: computePasses(observer, nowMs, minEl) };
    passCache.set(sig, c);
    if (passCache.size > 6) passCache.delete(passCache.keys().next().value);
  }
  return c.passes.filter((p) => p.los > nowMs - 1000);
}

/** lib/orbit.findPasses() shape: ISO aos / los, current pass first. */
function findPasses(observer, now, minEl) {
  const t = toDate(now);
  return passesCached(observer, t, Number.isFinite(minEl) ? minEl : 0).map((p) => ({
    aos: new Date(p.aos).toISOString(),
    los: new Date(p.los).toISOString(),
    maxEl: p.maxEl,
    aosAz: p.aosAz,
    losAz: p.losAz,
  }));
}

/** lib/orbit.findNextPass() shape: { aos, los (ms), maxEl } or null. */
function findNextPass(observer, now, minEl) {
  const t = toDate(now);
  const p = passesCached(observer, t, Number.isFinite(minEl) ? minEl : 0)[0];
  return p ? { aos: p.aos, los: p.los, maxEl: p.maxEl } : null;
}

/** Sky path for the radar / profile chart: ~180 samples per pass whatever its length. */
function passSkyPath(observer, aosIso, losIso, stepSec) {
  const a = new Date(aosIso).getTime();
  const b = new Date(losIso).getTime();
  const step = Math.max((stepSec || 30) * 1000, (b - a) / 180);
  const pts = [];
  for (let t = a; t <= b; t += step) {
    const l = lookAngles(observer, t);
    if (l.el >= 0) pts.push({ az: l.az, el: l.el });
  }
  const l = lookAngles(observer, b);
  if (l.el >= 0) pts.push({ az: l.az, el: l.el });
  return pts;
}

/** Sub-point track (map / globe): every stepSec from t0 to t1 (ms) as [[lat, lon], ...]. */
function subTrack(t0, t1, stepSec) {
  const pts = [];
  for (let t = t0; t <= t1; t += stepSec * 1000) {
    const p = subPoint(t);
    pts.push([p.lat, p.lon]);
  }
  return pts;
}

/**
 * True when an azimuth track (consecutive samples, small steps) crosses the
 * rotor's mechanical stop ("north" = 0/360, "south" = 180). Unlike the
 * AOS→LOS shortest-path test the drivers use for short LEO passes, this
 * follows the real path: a Moon pass sweeps east→south→west (or via north in
 * the southern hemisphere), often more than 180 deg.
 */
function azPathCrossesStop(azs, stop) {
  const south = String(stop || "north").toLowerCase().startsWith("s");
  const ref = south ? 180 : 0;
  for (let i = 1; i < (azs || []).length; i++) {
    const a = azs[i - 1];
    const b = azs[i];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    // Step expressed relative to the stop: crossing = the signed angle
    // from the stop changes sign across a small step.
    const ra = norm180(a - ref);
    const rb = norm180(b - ref);
    const step = norm180(b - a);
    if (Math.abs(step) >= 90) continue; // not a small step; ignore
    if ((ra < 0 && rb >= 0 && step > 0) || (ra >= 0 && rb < 0 && step < 0)) {
      if (Math.abs(ra) < 90 && Math.abs(rb) < 90) return true;
    }
  }
  return false;
}

/** Az samples (deg) of the Moon between two times (for azPathCrossesStop). */
function azTrack(observer, t0, t1, n) {
  n = n || 120;
  const out = [];
  if (!(t1 > t0)) return out;
  for (let i = 0; i <= n; i++) out.push(lookAngles(observer, t0 + ((t1 - t0) * i) / n).az);
  return out;
}

/**
 * Catalog entry so the Moon can be selected like a satellite. Modes are the
 * usual worldwide digital-EME activity frequencies (2 m / 70 cm / 23 cm);
 * TX = RX = the dial frequency (fine offsets / knob move it). "EME USB" maps
 * to USB on both sides in every radio driver (catalog.isUsbBothMode).
 */
function catalogEntry() {
  return {
    key: MOON_KEY,
    name: "Moon",
    display: "Moon (EME)",
    norad: null,
    callsign: "",
    trackable: true,
    status: "active",
    isMoon: true,
    mode: "EME USB",
    uplink: "144.120",
    downlink: "144.120",
    modes: [
      { mode: "EME USB 2m", uplink: "144.120", downlink: "144.120", ctcssAccess: null, ctcssActivation: null },
      { mode: "EME USB 70cm", uplink: "432.065", downlink: "432.065", ctcssAccess: null, ctcssActivation: null },
      { mode: "EME USB 23cm", uplink: "1296.065", downlink: "1296.065", ctcssAccess: null, ctcssActivation: null },
    ],
  };
}

module.exports = {
  MOON_KEY,
  MOON_REC,
  C_KMS,
  isMoonKey,
  isMoonRec,
  moonEcliptic,
  nutation,
  meanObliquity,
  gmstDeg,
  sunApparent,
  geocentric,
  lookAngles,
  rangeRateKmS,
  subPoint,
  phase,
  info,
  emePathLossDb,
  echoDopplerHz,
  echoDelaySec,
  computePasses,
  findPasses,
  findNextPass,
  passSkyPath,
  subTrack,
  azPathCrossesStop,
  azTrack,
  catalogEntry,
  _resetCache: () => passCache.clear(),
};
