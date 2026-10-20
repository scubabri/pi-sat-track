// Real packets from Brian's Graywolf (KISS TCP 8002, channel 2 "VHF Dax 3",
// 144.390, northern Utah, 2026-10) plus Mic-E comment cleanup, PHG, weather,
// items, telemetry and the traffic-window categories / decoded text.
// Run: node --test --test-force-exit test/aprs-graywolf.test.js
const test = require("node:test");
const assert = require("assert");
const { parseInfo, cleanMicEComment, parsePhg, parseWeather } = require("../lib/aprs/parse");
const { category, describe } = require("../lib/aprs/describe");
const { createStore } = require("../lib/aprs/store");
const { MICE_SUFFIX } = require("../lib/aprs/mice-devices");

const near = (a, b, eps) => assert.ok(Math.abs(a - b) < (eps || 1e-3), a + " !~ " + b);

// MAVRIK-9>EBAYVY,SHEPRD*,WIDE1*,WIDE2-1:`(YTmF?j/`"C1}W5SAT_1
// Byte 7 of the info (Mic-E course low byte "DC+28") was 0x1c..0x1f, a
// control character that the log copy dropped; 0x1c (course 200) is used here.
const MAVRIK_INFO = "`(YTmF\x1cj/`\"C1}W5SAT_1 ";

test("MAVRIK-9 Mic-E (Yaesu FTM-300D): byte-by-byte decode and cleaned comment", () => {
  const p = parseInfo("EBAYVY", MAVRIK_INFO);
  assert.strictEqual(p.type, "mic-e");
  // dest E B A Y V Y -> lat digits 4 1 0 9 6 9 = 41 09.69, Y(4th)=North, V(5th)=+0 lon offset, Y(6th)=West
  near(p.lat, 41 + 9.69 / 60);
  // lon: '('-28 = 12 (+100 offset? no: 5th dest char V = offset 100) -> 112; 'Y'-28 = 61 -> 61-60 = 1 min; 'T'-28 = 56 hundredths -> 112 01.56 W
  near(p.lon, -(112 + 1.56 / 60));
  assert.strictEqual(p.speedKn, 14); // 'm' 'F'
  assert.strictEqual(p.course, 200);
  assert.strictEqual(p.symTable + p.symCode, "/j"); // Jeep
  assert.strictEqual(p.altM, 1391); // "C1} base-91 - 10000 m
  assert.strictEqual(p.comment, "W5SAT");
  assert.strictEqual(p.device, "Yaesu FTM-300D");
  assert.strictEqual(p.messaging, true);
});

test("cleanMicEComment: type char, altitude, new-style and legacy device suffixes", () => {
  assert.deepStrictEqual(cleanMicEComment('`"C1}W5SAT_1 '), { comment: "W5SAT", altM: 1391, device: "Yaesu FTM-300D", messaging: true });
  assert.strictEqual(cleanMicEComment("'Tracker|3").device, "Byonics TinyTrak3");
  assert.strictEqual(cleanMicEComment("'Tracker|3").messaging, false);
  assert.strictEqual(cleanMicEComment("'Tracker|3").comment, "Tracker");
  assert.strictEqual(cleanMicEComment(">Hiking=").device, "Kenwood TH-D72");
  assert.strictEqual(cleanMicEComment(">Hiking=").comment, "Hiking");
  assert.strictEqual(cleanMicEComment(">Hiking").device, "Kenwood TH-D7A");
  assert.strictEqual(cleanMicEComment("]Mobile=").device, "Kenwood TM-D710");
  assert.strictEqual(cleanMicEComment("]Mobile").device, "Kenwood TM-D700");
  assert.strictEqual(cleanMicEComment('`_"').device, "Yaesu FTM-350");
  // unknown suffix stays in the comment
  const u = cleanMicEComment("`hello world");
  assert.strictEqual(u.comment, "hello world");
  assert.strictEqual(u.device, undefined);
  assert.ok(MICE_SUFFIX.size >= 20);
});

test("VIC status beacon", () => {
  const p = parseInfo("APNX02", ">BEACON: N7ELY-2  Info enarsclub@gmail.com ENARS");
  assert.strictEqual(p.type, "status");
  assert.strictEqual(category(p, "rx"), "status");
  assert.strictEqual(describe(p), "BEACON: N7ELY-2  Info enarsclub@gmail.com ENARS");
});

test("K7TX-10 digi: overlay S# symbol and PHG, plots", () => {
  const p = parseInfo("APDW17", "!4025.41NS11150.07W#PHG2160 APRS Digi & iGate");
  assert.strictEqual(p.type, "position");
  assert.strictEqual(p.symTable + p.symCode, "S#");
  near(p.lat, 40 + 25.41 / 60);
  near(p.lon, -(111 + 50.07 / 60));
  assert.deepStrictEqual(parsePhg("PHG2160"), p.phg);
  assert.strictEqual(p.phg.powerW, 4);
  assert.strictEqual(p.phg.heightFt, 20);
  assert.strictEqual(p.phg.gainDb, 6);
  assert.strictEqual(p.comment, "APRS Digi & iGate");
  assert.match(describe(p), /40\.4235 N 111\.8345 W · PHG 4 W, 20 ft, 6 dBi, omni · APRS Digi & iGate/);
});

test("HRSHDE digi: /# position, plots", () => {
  const p = parseInfo("APOT30", "!3920.05N/11127.01W# 13.3V 44F SANPETE SAR KB7K");
  assert.strictEqual(p.type, "position");
  assert.strictEqual(p.symTable + p.symCode, "/#");
  near(p.lat, 39 + 20.05 / 60);
  near(p.lon, -(111 + 27.01 / 60));
  assert.strictEqual(p.comment.trim(), "13.3V 44F SANPETE SAR KB7K");
});

test("all four Graywolf stations land in the store; three plot", () => {
  const s = createStore({ throttleMs: 0 });
  const add = (src, dst, info) => s.add({ src, dir: "rx", time: Date.now(), parsed: parseInfo(dst, info) });
  add("MAVRIK-9", "EBAYVY", MAVRIK_INFO);
  add("VIC", "APNX02", ">BEACON: N7ELY-2  Info enarsclub@gmail.com ENARS");
  add("K7TX-10", "APDW17", "!4025.41NS11150.07W#PHG2160 APRS Digi & iGate");
  add("HRSHDE", "APOT30", "!3920.05N/11127.01W# 13.3V 44F SANPETE SAR KB7K");
  const st = s.payload().stations;
  const calls = st.map((x) => x.call).sort();
  assert.deepStrictEqual(calls, ["HRSHDE", "K7TX-10", "MAVRIK-9"]);
  const m = st.find((x) => x.call === "MAVRIK-9");
  assert.strictEqual(m.symbol, "/j");
  assert.strictEqual(m.comment, "W5SAT");
  assert.strictEqual(m.device, "Yaesu FTM-300D");
  assert.strictEqual(st.find((x) => x.call === "K7TX-10").symbol, "S#");
  assert.strictEqual(st.find((x) => x.call === "K7TX-10").comment, "APRS Digi & iGate");
  s.stop();
});

test("weather: position with _ symbol, positionless, wind from course/speed", () => {
  const p = parseInfo("APRS", "!4903.50N/07201.75W_220/004g005t077r000p000P000h50b09900wRSW");
  assert.strictEqual(category(p, "rx"), "weather");
  assert.strictEqual(p.wx.windDir, 220);
  assert.strictEqual(p.wx.windMph, 4);
  assert.strictEqual(p.wx.tempF, 77);
  assert.strictEqual(p.wx.humidity, 50);
  near(p.wx.pressureMbar, 990);
  assert.match(describe(p), /wind 220° 4 mph.*77°F \(25°C\).*50% RH.*990\.0 hPa/);
  const q = parseInfo("APRS", "_10090556c220s004g005t077r000p000P000h50b09900");
  assert.strictEqual(q.type, "weather");
  assert.strictEqual(q.wx.windDir, 220);
  assert.strictEqual(category(q, "rx"), "weather");
  assert.ok(parseWeather("t-05h00", false).wx.humidity === 100);
});

test("items, objects, telemetry categories", () => {
  const it = parseInfo("APRS", ")AID #2!4903.50N/07201.75WA");
  assert.strictEqual(it.type, "item");
  assert.strictEqual(it.object.name, "AID #2");
  assert.strictEqual(category(it, "rx"), "object");
  assert.match(describe(it), /^Item AID #2 · 49\.0583 N 72\.0292 W/);
  const tl = parseInfo("APRS", "T#005,199,000,255,073,123,01101001");
  assert.strictEqual(tl.type, "telemetry");
  assert.strictEqual(category(tl, "rx"), "telemetry");
  const parm = parseInfo("APRS", ":N0QBF-11 :PARM.Battery,Btemp,ATemp,Pres,Alt,Camra");
  assert.strictEqual(parm.type, "telemetry");
  assert.strictEqual(category(parm, "rx"), "telemetry");
});

test("categories: messages (incl. sent UI text / header), positions (incl. Mic-E), other", () => {
  assert.strictEqual(category(parseInfo("APRS", ":W1AW     :hello{12"), "rx"), "message");
  assert.strictEqual(category(parseInfo("APRS", ":W1AW     :ack12"), "rx"), "message");
  assert.strictEqual(category(parseInfo("EBAYVY", MAVRIK_INFO), "rx"), "position");
  assert.strictEqual(category(parseInfo("CQ", ">hi"), "tx", "text"), "message");
  assert.strictEqual(category(parseInfo("CQ", ""), "tx", "header"), "message");
  assert.strictEqual(category(parseInfo("CQ", ""), "rx"), "other");
  assert.strictEqual(category(parseInfo("CQ", "CQ BH2VSQ OL79"), "rx"), "status");
  assert.strictEqual(describe(parseInfo("APRS", ":W1AW     :hello{12")), "→ W1AW: hello");
  const m = describe(parseInfo("EBAYVY", MAVRIK_INFO));
  assert.match(m, /^41\.1615 N 112\.0260 W · 14 kn 200° · 1391 m · W5SAT/);
});

test("MAVRIK-9 as copied from the log (control byte lost): still Jeep / W5SAT / FTM-300D, speed+course unknown", () => {
  const p = parseInfo("EBAYVY", '`(YTmFj/`"C1}W5SAT_1');
  assert.strictEqual(p.truncated, true);
  assert.strictEqual(p.symTable + p.symCode, "/j");
  assert.strictEqual(p.comment, "W5SAT");
  assert.strictEqual(p.device, "Yaesu FTM-300D");
  assert.strictEqual(p.altM, 1391);
  assert.strictEqual(p.speedKn, null);
  assert.strictEqual(p.course, null);
  near(p.lat, 41.1615);
  near(p.lon, -112.026);
  // a complete 9-byte header with a valid table is never treated as short
  assert.strictEqual(parseInfo("EBAYVY", MAVRIK_INFO).truncated, undefined);
});
