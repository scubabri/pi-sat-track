// Run: node test/amsat-status.test.js
const assert = require("assert");
const catalog = require("../lib/catalog");

const sample = {
  data: [
    {
      name: "SO-50_[FM]",
      report: "Heard",
      report_count: 10,
      latest_reported_time: "2026-10-15T16:30:00Z",
    },
    {
      name: "AO-91_[FM]",
      report: "Not Heard",
      report_count: 5,
      latest_reported_time: "2026-10-14T20:30:00Z",
    },
    {
      name: "CO-128_[TLM]",
      report: "Telemetry Only",
      report_count: 3,
      latest_reported_time: "2026-10-15T10:30:00Z",
    },
    {
      name: "CO-128_[TLM]",
      report: "Not Heard",
      report_count: 2,
      latest_reported_time: "2026-10-15T12:00:00Z",
    },
    {
      name: "AO-123_[FM]",
      report: "Telemetry Only",
      report_count: 8,
      latest_reported_time: "2026-10-15T07:30:00Z",
    },
    {
      name: "AO-123_[FM]",
      report: "Heard",
      report_count: 3,
      latest_reported_time: "2026-10-15T00:30:00Z",
    },
    {
      name: "ISS_[Crew]",
      report: "Heard",
      report_count: 1,
      latest_reported_time: "2026-10-15T15:30:00Z",
    },
    {
      name: "ISS_[FM]",
      report: "Heard",
      report_count: 20,
      latest_reported_time: "2026-10-15T17:00:00Z",
    },
    {
      name: "ISS_[FM]",
      report: "Crew Active",
      report_count: 1,
      latest_reported_time: "2026-10-15T18:00:00Z",
    },
  ],
};

const parsed = catalog.parseAmsatSummary(sample);
assert.ok(parsed.active.has("SO50"), "SO-50 Heard included");
assert.strictEqual(parsed.kinds.get("SO50"), "heard");
assert.ok(!parsed.active.has("AO91"), "AO-91 Not Heard only excluded");
assert.ok(parsed.active.has("CO128"), "CO-128 TLM included despite Not Heard");
assert.strictEqual(parsed.kinds.get("CO128"), "tlm");
assert.ok(parsed.active.has("AO123"), "AO-123 has positive reports");
assert.strictEqual(
  parsed.kinds.get("AO123"),
  "tlm",
  "AO-123 latest positive is TLM",
);
assert.ok(!parsed.active.has("ISS") || parsed.kinds.get("ISS") === "heard");
// Crew mode reports must not create a standalone crew entry; ISS_[FM] Heard stays
assert.ok(parsed.active.has("ISS"), "ISS FM Heard included");
assert.strictEqual(parsed.kinds.get("ISS"), "heard");
assert.ok(parsed.tags.get("SO50").has("FM"));
assert.ok(parsed.tags.get("CO128").has("TLM"));

assert.strictEqual(catalog.AMSAT_COLOR_HEARD, "#648fff");
assert.strictEqual(catalog.AMSAT_COLOR_TLM, "#ffb000");

// Empty / junk
const empty = catalog.parseAmsatSummary({ data: [] });
assert.strictEqual(empty.active.size, 0);

console.log("amsat-status tests: OK");
