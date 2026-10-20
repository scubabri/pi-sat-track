// Moon (EME) target: ephemeris accuracy, rise/set windows, echo Doppler,
// path loss, rotor stop-crossing, catalog row, EME frequencies and logging.
// Reference values: astronomy-engine 2.1 (geometric, no refraction) and
// Meeus "Astronomical Algorithms" 2nd ed. example 47.a.
// Run: node --test --test-force-exit test/moon.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pst-moon-"));

const moon = require("../lib/moon");
const D = Math.PI / 180;
const obs = (lat, lon, hM) => ({ latitude: lat * D, longitude: lon * D, height: hM / 1000 });
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, what + ": " + a + " vs " + b + " (tol " + tol + ")");
const angNear = (a, b, tol, what) => near(((a - b + 540) % 360) - 180, 0, tol, what);

test("Meeus example 47.a (1992-04-12 0h TD): lambda, beta, distance", () => {
  const r = moon.moonEcliptic(2448724.5);
  near(r.lon, 133.162655, 1e-5, "lambda");
  near(r.lat, -3.229126, 1e-5, "beta");
  near(r.dist, 368409.7, 0.1, "Delta");
});

const REF = [
  // when, lat, lon, height m, az, el, range km, geocentric dec, RA, illum
  ["2026-10-20T03:00:00Z", 40.5, -111.9, 1300, 186.7694, 30.1449, 395031.5, -18.2895, 315.5829, 0.6388],
  ["2026-03-15T12:00:00Z", -33.87, 151.21, 50, 168.1778, -36.1275, 393896.3, -19.879, 314.0848, 0.1413],
  ["2026-07-01T18:30:00Z", 51.48, 0, 10, 93.6242, -27.652, 405141.3, -22.862, 302.2363, 0.9709],
  ["2026-12-24T06:00:00Z", 64.84, -147.72, 150, 104.5359, 35.8335, 352888.0, 27.0535, 95.7448, 0.9984],
];

test("topocentric az / el / range, RA / Dec and illumination match astronomy-engine (both hemispheres)", () => {
  for (const [when, la, lo, h, az, el, rng, dec, ra, ill] of REF) {
    const t = new Date(when);
    const l = moon.lookAngles(obs(la, lo, h), t);
    angNear(l.az, az, 0.01, when + " az");
    near(l.el, el, 0.01, when + " el");
    near(l.rangeKm, rng, 40, when + " range");
    const g = moon.geocentric(t);
    near(g.decDeg, dec, 0.02, when + " dec");
    angNear(g.raDeg, ra, 0.02, when + " RA");
    near(moon.phase(t).illum, ill, 0.002, when + " illum");
  }
});

test("parallax: topocentric differs from geocentric by up to ~1 deg and range by ~Earth radius", () => {
  const t = new Date("2026-10-20T03:00:00Z");
  const g = moon.geocentric(t);
  const l = moon.lookAngles(obs(40.5, -111.9, 1300), t);
  assert.ok(g.distKm - l.rangeKm > 2000, "observer is closer than Earth's centre");
});

test("rise / set windows above min EL match astronomy-engine SearchAltitude", () => {
  moon._resetCache();
  const o = obs(40.5, -111.9, 1300);
  const p = moon.findPasses(o, new Date("2026-10-19T18:00:00Z"), 0);
  assert.ok(p.length >= 3 && p.length <= 5, "a few days of windows");
  near(Date.parse(p[0].aos), Date.parse("2026-10-19T21:40:34.749Z"), 5000, "rise");
  near(Date.parse(p[0].los), Date.parse("2026-10-20T07:36:30.655Z"), 5000, "set");
  near(Date.parse(p[1].aos), Date.parse("2026-10-20T22:06:14.525Z"), 5000, "next rise");
  for (const x of p) assert.ok(Date.parse(x.los) > Date.parse(x.aos) && x.maxEl > 0);
  // higher min EL -> shorter windows, inside the 0 deg ones
  const p10 = moon.findPasses(o, new Date("2026-10-19T18:00:00Z"), 10);
  assert.ok(Date.parse(p10[0].aos) > Date.parse(p[0].aos) && Date.parse(p10[0].los) < Date.parse(p[0].los));
});

test("long pass already in progress: walked back to its real AOS, listed first; findNextPass agrees", () => {
  moon._resetCache();
  const o = obs(40.5, -111.9, 1300);
  const now = new Date("2026-10-19T00:00:00Z");
  const p = moon.findPasses(o, now, 0);
  near(Date.parse(p[0].aos), Date.parse("2026-10-18T21:10:57Z"), 5000, "AOS of the current pass");
  assert.ok(Date.parse(p[0].los) > now.getTime());
  const n = moon.findNextPass(o, now, 0);
  assert.strictEqual(n.aos, Date.parse(p[0].aos));
  // passes are hours long, the sky path stays a bounded size
  const sky = moon.passSkyPath(o, p[0].aos, p[0].los, 30);
  assert.ok(sky.length > 100 && sky.length < 200, "sky path samples: " + sky.length);
});

test("circumpolar Moon (high latitude): an open window instead of a hang", () => {
  moon._resetCache();
  const o = obs(78.2, 15.6, 10); // Svalbard
  const t0 = Date.now();
  const p = moon.findPasses(o, new Date("2026-12-24T06:00:00Z"), 0);
  assert.ok(Date.now() - t0 < 3000, "fast");
  assert.ok(p.length >= 1);
  for (const x of p) assert.ok(Date.parse(x.los) > Date.parse(x.aos));
});

test("echo Doppler = -2 rdot f / c, delay = 2R/c", () => {
  near(moon.echoDopplerHz(0.1, 144e6), (-2 * 0.1 * 144e6) / 299792.458, 1e-9, "formula");
  assert.ok(moon.echoDopplerHz(0.1, 144e6) < 0, "receding -> echo low");
  near(moon.echoDelaySec(384400), 2.5645, 0.001, "delay");
  // central-difference range rate agrees with the range change over a minute
  const o = obs(40.5, -111.9, 1300);
  const t = Date.parse("2026-10-20T03:00:00Z");
  const rr = moon.rangeRateKmS(o, t);
  const slope = (moon.lookAngles(o, t + 30000).rangeKm - moon.lookAngles(o, t - 30000).rangeKm) / 60;
  near(rr, slope, 1e-4, "range rate");
  // Moon rising: approaching (echo high); setting: receding
  assert.ok(moon.rangeRateKmS(o, Date.parse("2026-10-19T22:30:00Z")) < 0);
  assert.ok(moon.rangeRateKmS(o, Date.parse("2026-10-20T07:00:00Z")) > 0);
});

test("EME path loss (approximate radar equation)", () => {
  near(moon.emePathLossDb(144e6, 384400), 252.1, 0.2, "2 m");
  near(moon.emePathLossDb(432e6, 384400) - moon.emePathLossDb(144e6, 384400), 20 * Math.log10(3), 1e-9, "f^2");
  near(moon.emePathLossDb(144e6, 2 * 384400) - moon.emePathLossDb(144e6, 384400), 40 * Math.log10(2), 1e-9, "d^4");
  assert.strictEqual(moon.emePathLossDb(0, 384400), null);
});

test("info(): panel fields", () => {
  const i = moon.info(obs(40.5, -111.9, 1300), new Date("2026-10-20T03:00:00Z"), 144.12e6);
  for (const k of ["raDeg", "decDeg", "geoDistKm", "rangeKm", "rangeRateKmS", "illum", "echoDelaySec", "echoDopplerHz", "pathLossDb"])
    assert.ok(Number.isFinite(i[k]), k);
  assert.strictEqual(i.phaseName, "Waxing gibbous"); // 64 % lit, waxing
  assert.strictEqual(moon.phase(new Date("2026-12-24T06:00:00Z")).phaseName, "Full Moon"); // 99.8 %
  near(i.subPoint.lat, i.decDeg, 1e-9, "sub-lunar lat = dec");
});

test("azPathCrossesStop follows the real path, not the AOS->LOS shortest arc", () => {
  // east -> south -> west (northern hemisphere Moon): crosses south stop, not north
  const ew = [100, 130, 160, 180, 200, 230, 260];
  assert.strictEqual(moon.azPathCrossesStop(ew, "north"), false);
  assert.strictEqual(moon.azPathCrossesStop(ew, "south"), true);
  // east -> north -> west (southern hemisphere Moon): crosses north
  const viaN = [80, 50, 20, 355, 330, 300];
  assert.strictEqual(moon.azPathCrossesStop(viaN, "north"), true);
  assert.strictEqual(moon.azPathCrossesStop(viaN, "south"), false);
  assert.strictEqual(moon.azPathCrossesStop([], "north"), false);
  // Sydney: the Moon culminates in the north -> its pass crosses the north stop
  moon._resetCache();
  const o = obs(-33.87, 151.21, 50);
  const p = moon.findPasses(o, new Date("2026-03-15T12:00:00Z"), 0)[0];
  const azs = moon.azTrack(o, Date.parse(p.aos), Date.parse(p.los), 120);
  assert.strictEqual(moon.azPathCrossesStop(azs, "north"), true);
});

test("lib/orbit dispatches the Moon pseudo-satrec", () => {
  const orbit = require("../lib/orbit");
  const o = obs(40.5, -111.9, 1300);
  const t = new Date("2026-10-20T03:00:00Z");
  const l = orbit.lookAngles(moon.MOON_REC, o, t);
  near(l.el, 30.1449, 0.01, "el via orbit");
  const g = orbit.groundPoint(moon.MOON_REC, t);
  assert.ok(g.heightKm > 340000);
  const ps = orbit.findPasses(moon.MOON_REC, o, t, 0);
  assert.ok(ps.length >= 1);
});

test("catalog: Moon row first, no NORAD, EME USB on both sides, not inverting", () => {
  const catalog = require("../lib/catalog");
  const cat = catalog.getCatalog();
  assert.ok(cat.MOON, "Moon in the catalog");
  assert.strictEqual(cat.MOON.norad, null);
  assert.ok(catalog.isUsbBothMode("EME USB 2m"));
  assert.ok(!catalog.isUsbBothMode("Mode U/V (B) Lin"));
  const pay = catalog.listSatsPayload("active", obs(40.5, -111.9, 1300));
  assert.strictEqual(typeof pay.satellites[0].above, "boolean");
  assert.strictEqual(pay.satellites[0].key, "MOON");
  assert.strictEqual(pay.satellites[0].norad, null);
  assert.strictEqual(pay.satellites.filter((s) => s.isMoon).length, 1);
});

test("EME frequencies: TX on the dial, RX corrected for the own echo", () => {
  const state = require("../lib/state");
  const rr = 0.1; // km/s receding
  const r = state.emeFrequencies({ ulMHz: 144.12, dlMHz: 144.12 }, rr, { manualDlOffset: 500, ulFineOffset: 0, dlFineOffset: 0 });
  assert.strictEqual(r.ulHz, 144120500, "TX = dial (+ knob offset), no Doppler");
  const echo = moon.echoDopplerHz(rr, 144.12e6);
  assert.strictEqual(r.dlHz, Math.round(144.12e6 + echo + 500));
  assert.ok(r.dlHz < r.ulHz, "receding Moon: echo comes back low");
});

test("logging: PROP_MODE=EME, no SAT_NAME (manual log and WSJT-X enrich)", () => {
  const logbook = require("../lib/logbook");
  const ctx = { satKey: "MOON", satName: "Moon (EME)", isMoon: true, mode: "EME USB 2m", ulHz: 144120000, dlHz: 144119950, el: 30 };
  const r = logbook.buildRecord({ call: "W1AW", ctx, station: { callsign: "N0CALL", grid: "JO01" }, now: new Date("2026-10-20T03:00:00Z") });
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.fields.PROP_MODE, "EME");
  assert.ok(!("SAT_NAME" in r.fields));
  assert.match(r.fields.FREQ, /^144\.12/, "FREQ = TX dial");
  const wl = require("../lib/wsjtx-listener");
  const e = wl.enrichRecord({ CALL: "W1AW", QSO_DATE: "20261020", TIME_ON: "030000", FREQ: "144.120", MODE: "FT8", SAT_NAME: "XX", SAT_MODE: "U" }, ctx, { callsign: "N0CALL", grid: "JO01" }, { now: new Date("2026-10-20T03:00:00Z") });
  assert.ok(e.enriched, e.note);
  assert.strictEqual(e.fields.PROP_MODE, "EME");
  assert.ok(!("SAT_NAME" in e.fields) && !("SAT_MODE" in e.fields));
  // a satellite still logs PROP_MODE=SAT
  const s = logbook.buildRecord({ call: "W1AW", ctx: { satKey: "SO-50", satName: "SO-50", norad: 27607, mode: "FM", ulHz: 145850000, dlHz: 436795000 }, station: { callsign: "N0CALL" } });
  assert.ok(s.ok, s.error);
  assert.strictEqual(s.fields.PROP_MODE, "SAT");
});

test("moon panel rows (front end, pure)", () => {
  const { moonPanelRows } = require("../js/moon-panel.js");
  assert.strictEqual(moonPanelRows({ isMoon: false }), null);
  const r = moonPanelRows({ isMoon: true, moon: { rangeKm: 395031.5, geoDistKm: 399000, decDeg: -18.29, raDeg: 315.58, illum: 0.6388, phaseName: "Waxing gibbous", subPoint: { lat: -18.3, lon: -120.5 } }, eme: { freqHz: 144.12e6, echoDopplerHz: -59.2, delaySec: 2.6356, pathLossDb: 252.6 } });
  assert.strictEqual(r.dist, "399,000 km", "geocentric (topocentric is the Range row)");
  assert.strictEqual(r.illum, "64% \u00B7 Waxing gibbous");
  assert.strictEqual(r.echo, "\u221259 Hz @ 144.120 MHz");
  assert.strictEqual(r.delay, "2.636 s");
  assert.match(r.loss, /approx/);
  assert.strictEqual(r.sub, "18.3\u00B0S 120.5\u00B0W");
});
