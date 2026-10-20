// APRS info parsing (positions, Mic-E, messages, status) + building, and the
// Maidenhead-grid-from-text fallback used to plot messages without a position.
// Run: node --test --test-force-exit test/aprs-parse.test.js
const test = require("node:test");
const assert = require("assert");
const { parseInfo, findGrid, gridToLatLon } = require("../lib/aprs/parse");
const build = require("../lib/aprs/build");

const near = (a, b, eps) => assert.ok(Math.abs(a - b) < (eps || 1e-3), a + " !~ " + b);

test("uncompressed position with course/speed/altitude", () => {
  const p = parseInfo("APDR16", "=4036.12N/11153.48W>073/045/A=004500 mobile via ISS");
  assert.strictEqual(p.type, "position");
  assert.strictEqual(p.posSource, "aprs");
  near(p.lat, 40 + 36.12 / 60);
  near(p.lon, -(111 + 53.48 / 60));
  assert.strictEqual(p.symTable + p.symCode, "/>");
  assert.strictEqual(p.course, 73);
  assert.strictEqual(p.speedKn, 45);
  assert.strictEqual(p.altM, Math.round(4500 * 0.3048));
  assert.ok(p.comment.includes("mobile via ISS"));
});

test("timestamped and compressed positions", () => {
  const t = parseInfo("APRS", "@092345z4903.50N/07201.75W>Test");
  near(t.lat, 49.0583);
  near(t.lon, -72.0292);
  const c = parseInfo("APRS", "=/5L!!<*e7>7P[");
  near(c.lat, 49.5, 1e-3);
  near(c.lon, -72.75, 1e-3);
});

test("Mic-E (VK5RK via ISS from the ARISS status page)", () => {
  const p = parseInfo("S4T9P0", "`BDzl -/`Hi Geoff VK5RK_%");
  assert.strictEqual(p.type, "mic-e");
  near(p.lat, -34.8167, 1e-3);
  near(p.lon, 138.6823, 1e-3);
});

test("messages, acks, status", () => {
  const m = parseInfo("APRS", ":KF0ABC   :Hi from EL98{12");
  assert.strictEqual(m.type, "message");
  assert.deepStrictEqual(m.msg, { to: "KF0ABC", text: "Hi from EL98", id: "12" });
  // grid in message text -> fallback position
  assert.strictEqual(m.posSource, "grid");
  assert.strictEqual(m.grid, "EL98");
  const a = parseInfo("APRS", ":KF0ABC   :ack12");
  assert.strictEqual(a.type, "ack");
  const s = parseInfo("APRS", ">QRV via ISS");
  assert.strictEqual(s.type, "status");
  assert.strictEqual(s.lat, undefined);
});

test("grid from text: 4 and 6 char, any subsquare case, not inside words", () => {
  assert.strictEqual(findGrid("CQ BH2VSQ OL79"), "OL79");
  assert.strictEqual(findGrid("QRV DN40aq 73"), "DN40aq");
  assert.strictEqual(findGrid("QRV DN40AQ"), "DN40aq");
  assert.strictEqual(findGrid("grid:EM12ab."), "EM12ab");
  assert.strictEqual(findGrid("RR73 thanks"), null);
  assert.strictEqual(findGrid("RR73 FN42"), "FN42");
  assert.strictEqual(findGrid("KK4YEL-7 hello"), null);
  assert.strictEqual(findGrid("DN40AQ1"), null);
  assert.strictEqual(findGrid("no locator here"), null);
  const g4 = gridToLatLon("DN40");
  near(g4.lat, 40.5);
  near(g4.lon, -111);
  const g6 = gridToLatLon("DN40aq");
  near(g6.lat, 40 + 16 * (2.5 / 60) + 1.25 / 60);
  near(g6.lon, -112 + 0 * (5 / 60) + 2.5 / 60);
  const st = parseInfo("JN48AP", ">QRV via ISS DN40aq");
  assert.strictEqual(st.posSource, "grid");
  assert.strictEqual(st.grid, "DN40aq");
});

test("raw NMEA position", () => {
  const p = parseInfo("JS1YCP", "$GPGGA,191426.000,3542.9954,N,13946.5044,E,1,10,0.9,20.5,M,39.3,M,,0000*6E");
  near(p.lat, 35.7166, 1e-3);
  near(p.lon, 139.7751, 1e-3);
});

test("build: position (ambiguity), message, status round-trip through parse", () => {
  const info = build.positionInfo({ lat: 39.7392, lon: -104.9903, symbol: "/`", comment: "Pi Sat Track" });
  assert.strictEqual(info, "!3944.35N/10459.42W`Pi Sat Track");
  const p = parseInfo("APZPST", info);
  near(p.lat, 39.7392, 1e-3);
  near(p.lon, -104.9903, 1e-3);
  assert.strictEqual(build.positionInfo({ lat: 39.7392, lon: -104.9903, ambiguity: 2 }), "!3944.  N/10459.  W`");
  assert.strictEqual(build.messageInfo("rs0iss", "hello {x}|"), ":RS0ISS   :hello x}");
  assert.throws(() => build.messageInfo("", "x"));
  assert.throws(() => build.messageInfo("N0CALL", "   "));
  assert.strictEqual(build.messageInfo("N0CALL", "x".repeat(80)).length, 11 + 67);
  assert.strictEqual(build.statusInfo("QRV via ISS"), ">QRV via ISS");
});

test("station position from grid (default) or exact lat/lon", () => {
  const g = build.stationPosition({ posSource: "grid" }, { grid: "DN40" });
  assert.strictEqual(g.source, "grid");
  near(g.lat, 40.5);
  const ll = build.stationPosition({ posSource: "latlon", lat: 39.7, lon: -104.9 }, { grid: "DN40" });
  assert.deepStrictEqual(ll, { lat: 39.7, lon: -104.9, source: "latlon" });
  assert.strictEqual(build.stationPosition({ posSource: "grid" }, { grid: "" }), null);
});
