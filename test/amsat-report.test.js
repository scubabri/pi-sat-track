// Run: node test/amsat-report.test.js  (no network; fetch is mocked)
const assert = require("assert");
const os = require("os"), path = require("path"), fs = require("fs");
const a = require("../lib/amsat-report");
a._setCacheFile(path.join(os.tmpdir(), "amsat-test-" + process.pid + ".json"));
const NAMES = ["AO-7_[U/v]", "AO-7_[V/a]", "AO-91_[FM]", "ISS_[Crew]", "ISS_[FM]", "ISS_[UHF_Digi]", "ISS_[VHF_Digi]", "SO-50_[FM]", "RS-44_[V/u]", "QO-100_[NB]"];
// period
assert.strictEqual(a.satPeriod(0), 0); assert.strictEqual(a.satPeriod(14), 0);
assert.strictEqual(a.satPeriod(15), 1); assert.strictEqual(a.satPeriod(30), 2);
assert.strictEqual(a.satPeriod(45), 3); assert.strictEqual(a.satPeriod(59), 3);
// UTC (local-time-independent)
const u = a.utcParts(new Date("2026-10-14T23:47:10Z"));
assert.deepStrictEqual(u, { year: 2026, month: 10, day: 14, hour: 23, period: 3 });
const u2 = a.utcParts(new Date("2026-10-15T00:05:00-06:00"));
assert.deepStrictEqual(u2, { year: 2026, month: 10, day: 15, hour: 6, period: 0 });
// parse
const html = '<select name="SatName"><option value="">Select</option>\n<option value="AO-91_[FM]">AO-91 [FM]</option><option value="ISS_[Crew]">x</option></select>';
assert.deepStrictEqual(a.parseSatNames(html), ["AO-91_[FM]", "ISS_[Crew]"]);
// matching
const best = (ctx) => (a.matchSatNames(NAMES, ctx)[0] || {}).value;
assert.strictEqual(best({ satKey: "AO-91", satName: "AO-91", mode: "FM" }), "AO-91_[FM]");
assert.strictEqual(best({ satKey: "AO-7", satName: "AO-7", mode: "U/v Linear" }), "AO-7_[U/v]");
assert.strictEqual(best({ satKey: "AO-7", satName: "AO-7", mode: "V/a" }), "AO-7_[V/a]");
assert.strictEqual(best({ satKey: "ISS", satName: "ISS (ZARYA)", mode: "FM Voice" }), "ISS_[FM]");
assert.strictEqual(best({ satKey: "ISS", satName: "ISS", mode: "APRS" }), "ISS_[VHF_Digi]");
// Selected transmitter band must pick VHF vs UHF Digi (ISS 1200bd AFSK APRS)
assert.strictEqual(best({ satKey: "ISS", satName: "ISS", mode: "1k2 AFSK", uplink: "145.825", downlink: "145.825" }), "ISS_[VHF_Digi]");
assert.strictEqual(best({ satKey: "ISS", satName: "ISS", mode: "1k2 AFSK APRS", uplink: "437.825", downlink: "437.825" }), "ISS_[UHF_Digi]");
assert.strictEqual(best({ satKey: "ISS", satName: "ISS", mode: "1k2 AFSK APRS", ulHz: 437825000, dlHz: 437825000 }), "ISS_[UHF_Digi]");
assert.strictEqual(best({ satKey: "ISS", satName: "ISS", mode: "1k2 AFSK", ulHz: 145825000, dlHz: 145825000 }), "ISS_[VHF_Digi]");
assert.strictEqual(best({ satKey: "ISS", satName: "ISS", mode: "Voice(Reg 1)", uplink: "145.200", downlink: "145.800" }), "ISS_[FM]");
// ISS crossband FM repeater whose catalog label also names a data rate: FM, not VHF Digi
assert.strictEqual(best({ satKey: "ISS", satName: "ISS", mode: "9k6 GFSK FM", uplink: "145.990", downlink: "437.800" }), "ISS_[FM]");
assert.strictEqual(best({ satKey: "ISS", satName: "ISS", mode: "9k6 GFSK FM", ulHz: 145990000, dlHz: 437800000 }), "ISS_[FM]");
assert.strictEqual(best({ satKey: "AO-7", satName: "AO-7", mode: "A", uplink: "145.850-145.950", downlink: "29.400- 29.500" }), "AO-7_[V/a]");
assert.strictEqual(best({ satKey: "AO-7", satName: "AO-7", mode: "B C", uplink: "432.125-432.175", downlink: "145.975-145.925" }), "AO-7_[U/v]");
assert.strictEqual(best({ satKey: "RS-44", satName: "RS-44", mode: "SSB/CW" }), "RS-44_[V/u]");
assert.strictEqual(a.matchSatNames(NAMES, { satKey: "AO-91", mode: "FM" }).length, 1);
assert.strictEqual(best({ satKey: "XX-1", mode: "FM" }), undefined);
assert.strictEqual(a.matchSatNames(NAMES, { satKey: "ISS", mode: "" }).length, 4);
// encoding + validation
const req = { satName: "AO-7_[U/v]", report: "Telemetry Only", callsign: "n0call", grid: "DM79lqXX", year: 2026, month: 3, day: 5, hour: 7, period: 2 };
assert.throws(() => a.buildParams({ ...req, report: "Active" }), /report/);
assert.throws(() => a.buildParams({ ...req, period: 4 }), /quarter/);
assert.throws(() => a.buildParams({ ...req, hour: 24 }), /hour/);
const p = a.buildParams(req);
assert.strictEqual(p.get("SatGridSquare"), "DM79lq");
assert.strictEqual(p.toString(), "SatSubmit=yes&Confirm=yes&SatName=AO-7_%5BU%2Fv%5D&SatYear=2026&SatMonth=03&SatDay=05&SatHour=07&SatPeriod=2&SatCall=N0CALL&SatReport=Telemetry+Only&SatGridSquare=DM79lq&App=pi-sat-track");

(async () => {
  const calls = [];
  a._setFetch(async (url, opt) => {
    calls.push(url);
    if (url.startsWith(a.SUBMIT_URL)) return { ok: true, status: 200, text: async () => "ok" };
    if (url.startsWith(a.API_URL)) return { ok: true, status: 200, json: async () => [{ name: "AO-7_[U/v]", callsign: "N0CALL", report: "Telemetry Only" }] };
    if (url === a.STATUS_URL) return { ok: true, status: 200, text: async () => html };
    throw new Error("unexpected " + url);
  });
  const r = await a.submitReport(req);
  assert.ok(r.confirmed); assert.strictEqual(r.message, "Reported, confirmed on AMSAT");
  assert.ok(calls[0].startsWith("https://www.amsat.org/status/submit.php?SatSubmit=yes"));
  assert.ok(calls[1].includes("name=AO-7_%5BU%2Fv%5D&hours=1"));
  // non-200
  a._setFetch(async () => ({ ok: false, status: 503, statusText: "Service Unavailable" }));
  await assert.rejects(a.submitReport(req), /AMSAT returned HTTP 503/);
  // network
  a._setFetch(async () => { throw new TypeError("fetch failed"); });
  await assert.rejects(a.submitReport(req), /Network error contacting AMSAT/);
  // list fetch + cache fallback
  a._setFetch(async () => ({ ok: true, status: 200, text: async () => html }));
  const l = await a.getSatNames({ force: true }); assert.strictEqual(l.source, "live");
  a._setFetch(async () => { throw new Error("down"); });
  const l2 = await a.getSatNames({ force: true }); assert.ok(l2.source.startsWith("cache")); assert.strictEqual(l2.names.length, 2);
  console.log("amsat-report tests: OK");
})().catch((e) => { console.error(e); process.exit(1); });

// fillReport: minimal {report} filled server-side; overrides win
{
  const now = new Date("2026-10-14T23:47:10Z");
  const ctx = { satKey: "RS-44", satName: "RS-44", mode: "SSB/CW" };
  const f = a.fillReport({ report: "Heard" }, { names: NAMES, ctx, station: { callsign: "N0CALL", grid: "DM79" }, now });
  assert.deepStrictEqual(f, { report: "Heard", satName: "RS-44_[V/u]", callsign: "N0CALL", grid: "DM79", year: 2026, month: 10, day: 14, hour: 23, period: 3 });
  const o = a.fillReport({ report: "Not Heard", satName: "AO-91_[FM]", callsign: "K1ABC", hour: 5 }, { names: NAMES, ctx, station: { callsign: "N0CALL" }, now });
  assert.strictEqual(o.satName, "AO-91_[FM]"); assert.strictEqual(o.callsign, "K1ABC"); assert.strictEqual(o.hour, 5);
  assert.throws(() => a.fillReport({ report: "Heard" }, { names: NAMES, ctx: { satKey: "XX-1" }, station: { callsign: "N0CALL" }, now }), /match/);
  assert.throws(() => a.fillReport({ report: "Heard" }, { names: NAMES, ctx, station: {}, now }), /Callsign/);
  assert.throws(() => a.fillReport({ report: "Heard" }, { names: NAMES, ctx: null, station: { callsign: "N0CALL" }, now }), /match/);
  a.buildParams(f);
  console.log("fillReport ok");
}
