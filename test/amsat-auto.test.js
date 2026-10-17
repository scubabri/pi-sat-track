// Auto AMSAT "Heard" when a QSO is logged (lib/amsat-auto.js) — same path as
// the sidebar Heard button, at most once per sat per pass, never throws.
// Run: node test/amsat-auto.test.js  (no network; fetch is mocked)
const assert = require("assert");
const os = require("os");
const path = require("path");
const fs = require("fs");
const amsat = require("../lib/amsat-report");
const { createAutoHeard, LOS_GRACE_MS, FALLBACK_MS } = require("../lib/amsat-auto");

const cacheFile = path.join(os.tmpdir(), "amsat-auto-test-" + process.pid + ".json");
amsat._setCacheFile(cacheFile);
const PAGE = '<select name="SatName"><option value="SO-50_[FM]">x</option><option value="AO-91_[FM]">x</option><option value="RS-44_[V/u]">x</option></select>';
const submits = [];
let failSubmit = null;
amsat._setFetch(async (url) => {
  url = String(url);
  if (url === amsat.STATUS_URL) return { ok: true, status: 200, text: async () => PAGE };
  if (url.startsWith(amsat.SUBMIT_URL)) {
    if (failSubmit) throw new Error(failSubmit);
    submits.push(new URL(url).searchParams);
    return { ok: true, status: 200, text: async () => "ok" };
  }
  if (url.startsWith(amsat.API_URL)) return { ok: true, status: 200, json: async () => [{ callsign: "N0CALL" }] };
  throw new Error("unexpected fetch " + url);
});

const M = 60 * 1000;
const T0 = Date.UTC(2026, 9, 17, 17, 40, 0); // 17:40 UTC → hour 17, period 2
// SO-50 passes: 17:30–17:42 and 19:10–19:22; RS-44 no pass info (→ fallback window)
const PASSES = {
  "SO-50": [
    { aos: T0 - 10 * M, los: T0 + 2 * M },
    { aos: T0 + 90 * M, los: T0 + 102 * M },
  ],
};
let now = T0;
const events = [];
const logs = [];
const auto = createAutoHeard({
  amsat,
  getPassWindow: (key, d) => {
    const t = d.getTime();
    return (PASSES[key] || []).find((p) => t >= p.aos && t <= p.los + LOS_GRACE_MS) || null;
  },
  notify: (e) => events.push(e),
  log: (m) => logs.push(m),
  now: () => now,
});
const ctx = (k, mode) => ({ satKey: k, satName: k, mode: mode || "FM" });
const station = { callsign: "n0call", grid: "DN40aa" };

(async () => {
  // no sat → nothing
  assert.deepStrictEqual(await auto.fromQso({ ctx: null, station }), { status: "no-sat" });

  // first logged QSO → Heard sent (same fields as the button: SatName match, call, grid, QSO time)
  let r = await auto.fromQso({ ctx: ctx("SO-50"), station, time: new Date(T0), source: "log" });
  assert.strictEqual(r.status, "sent");
  assert.strictEqual(submits.length, 1);
  const p = submits[0];
  assert.strictEqual(p.get("SatName"), "SO-50_[FM]");
  assert.strictEqual(p.get("SatReport"), "Heard");
  assert.strictEqual(p.get("SatCall"), "N0CALL");
  assert.strictEqual(p.get("SatGridSquare"), "DN40aa");
  assert.strictEqual(p.get("SatHour"), "17");
  assert.strictEqual(p.get("SatPeriod"), "2");
  assert.strictEqual(events.pop().status, "sent");
  assert(auto.heardThisPass("SO-50", T0 + M), "visible for the Heard button state");

  // second QSO same pass (even shortly after LOS) → duplicate, no submit
  now = T0 + 5 * M;
  r = await auto.fromQso({ ctx: ctx("SO-50"), station, time: new Date(now), source: "wsjtx" });
  assert.strictEqual(r.status, "duplicate");
  assert.strictEqual(submits.length, 1);
  assert.strictEqual(events.length, 0, "duplicates are silent (log line only)");

  // next pass → sends again
  now = T0 + 95 * M;
  r = await auto.fromQso({ ctx: ctx("SO-50"), station, time: new Date(now) });
  assert.strictEqual(r.status, "sent");
  assert.strictEqual(submits.length, 2);
  assert.strictEqual(auto.heardThisPass("SO-50", T0 + 200 * M), null, "expires after the pass");

  // Heard via button first → logged QSO in same pass does not send
  submits.length = 0;
  PASSES["AO-91"] = [{ aos: T0 + 300 * M, los: T0 + 312 * M }];
  now = T0 + 302 * M;
  auto.noteSent("AO-91", { satName: "AO-91_[FM]", source: "button" });
  r = await auto.fromQso({ ctx: ctx("AO-91"), station, time: new Date(T0 + 305 * M) });
  assert.strictEqual(r.status, "duplicate");
  assert.strictEqual(r.previous.source, "button");
  assert.strictEqual(submits.length, 0);

  // two quick logs at once → one submit (pass claimed before going async)
  PASSES["SO-50"].push({ aos: T0 + 400 * M, los: T0 + 412 * M });
  now = T0 + 405 * M;
  const [a1, a2] = await Promise.all([
    auto.fromQso({ ctx: ctx("SO-50"), station, time: new Date(now) }),
    auto.fromQso({ ctx: ctx("SO-50"), station, time: new Date(now) }),
  ]);
  assert.deepStrictEqual([a1.status, a2.status].sort(), ["duplicate", "sent"]);
  assert.strictEqual(submits.length, 1);

  // AMSAT failure → error event, never throws, claim released so the next log retries
  submits.length = 0;
  events.length = 0;
  PASSES["SO-50"].push({ aos: T0 + 500 * M, los: T0 + 512 * M });
  now = T0 + 505 * M;
  failSubmit = "ECONNRESET";
  r = await auto.fromQso({ ctx: ctx("SO-50"), station, time: new Date(now) });
  assert.strictEqual(r.status, "error");
  assert(/Network error/.test(r.error));
  assert.strictEqual(events.pop().status, "error");
  assert.strictEqual(auto.heardThisPass("SO-50", now), null);
  failSubmit = null;
  r = await auto.fromQso({ ctx: ctx("SO-50"), station, time: new Date(now + M) });
  assert.strictEqual(r.status, "sent", "retry on next log after a failure");

  // missing callsign / no AMSAT match → error, not thrown
  now = T0 + 600 * M;
  r = await auto.fromQso({ ctx: ctx("ZZ-1"), station, time: new Date(now) });
  assert.strictEqual(r.status, "error");
  assert(/No AMSAT satellite match/.test(r.error));
  r = await auto.fromQso({ ctx: ctx("AO-91"), station: {}, time: new Date(now) });
  assert.strictEqual(r.status, "error");
  assert(/Callsign/.test(r.error));

  // no pass info (GEO etc.) → FALLBACK_MS window
  submits.length = 0;
  now = T0 + 700 * M;
  assert.strictEqual((await auto.fromQso({ ctx: ctx("RS-44", "SSB"), station, time: new Date(now) })).status, "sent");
  now += FALLBACK_MS - M;
  assert.strictEqual((await auto.fromQso({ ctx: ctx("RS-44", "SSB"), station, time: new Date(now) })).status, "duplicate");
  now += 2 * M;
  assert.strictEqual((await auto.fromQso({ ctx: ctx("RS-44", "SSB"), station, time: new Date(now) })).status, "sent");
  assert.strictEqual(submits.length, 2);

  // config: default on, boolean only, per-profile via applyEndpoints
  const config = require("../lib/config");
  assert.strictEqual(config.LOG_AMSAT_HEARD, true, "default on");
  assert.strictEqual(config.getEndpoints().logAmsatHeard, true);
  config.applyEndpoints({ logAmsatHeard: false });
  assert.strictEqual(config.LOG_AMSAT_HEARD, false);
  config.applyEndpoints({ logAmsatHeard: undefined, logMethod: "adif" });
  assert.strictEqual(config.LOG_AMSAT_HEARD, false, "missing field keeps the setting");
  config.applyEndpoints({ logAmsatHeard: true });
  assert.strictEqual(config.LOG_AMSAT_HEARD, true);

  try { fs.unlinkSync(cacheFile); } catch (_) {}
  console.log("amsat-auto test OK");
})().catch((e) => {
  try { fs.unlinkSync(cacheFile); } catch (_) {}
  console.error(e);
  process.exit(1);
});
