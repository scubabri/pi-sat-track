// Run: node test/station-callsign.test.js
const assert = require("assert");
const fs = require("fs"), path = require("path");
const lb = require("../lib/logbook");
assert.deepStrictEqual(lb.normalizeStationFields({ callsign: "  k0abc/p ", grid: " dn40ab " }), { callsign: "K0ABC/P", grid: "DN40ab" });
assert.deepStrictEqual(lb.normalizeStationFields({}), {});
assert.deepStrictEqual(lb.normalizeStationFields({ grid: "dn40" }), { grid: "DN40" });
const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
// Save paths must carry callsign (past bug: hand-picked lists dropped fields)
assert.ok(/callsign:\s*cfg\.callsign/.test(rd("js/config.js")), "config.js sends callsign");
assert.ok(/callsign:\s*val\("cfg-callsign"\)/.test(rd("js/config-form.js")), "form reads callsign");
assert.ok(/normalizeStationFields\(msg\)/.test(rd("server.js")), "server persists callsign to profile");
const html = rd("index.html");
assert.ok(/My callsign/.test(html) && /id="station-call"/.test(html));
// QSO worked-station entry must not be persisted
assert.ok(!/localStorage[^\n]*qso/i.test(rd("js/qso-log.js")), "QSO call box not persisted");
console.log("station-callsign tests OK");
