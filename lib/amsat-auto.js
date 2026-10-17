"use strict";
/**
 * Auto AMSAT "Heard" report when a QSO is logged (Configure → Logging →
 * "Also send AMSAT 'Heard' report when logging a QSO", config.logAmsatHeard,
 * default on, per profile).
 *
 * Uses the same path as the sidebar Heard button: lib/amsat-report.js
 * getSatNames → fillReport (sat-name match from the log context, profile
 * callsign/grid, UTC time) → submitReport. Runs after the QSO is logged and is
 * never awaited by the logging path, so AMSAT problems cannot block/delay it.
 *
 * At most one Heard per sat per pass: a Heard already sent this pass (by the
 * button or an earlier logged QSO) suppresses the auto report. A pass is the
 * horizon pass containing the report time (plus LOS_GRACE_MS, so logging just
 * after LOS still counts); with no pass info (e.g. GEO) a FALLBACK_MS window.
 */
const LOS_GRACE_MS = 10 * 60 * 1000;
const FALLBACK_MS = 30 * 60 * 1000;

/**
 * deps: {
 *   amsat:          lib/amsat-report (getSatNames, fillReport, submitReport)
 *   getPassWindow:  (satKey, date) → {aos, los} ms | null
 *   notify(evt), log(msg), now() → ms
 * }
 */
function createAutoHeard(deps) {
  const amsat = deps.amsat;
  const log = deps.log || (() => {});
  const notify = deps.notify || (() => {});
  const nowFn = deps.now || Date.now;
  const sent = new Map(); // satKey → { at, passAos, passLos, satName, source, pending }

  function passOf(satKey, t) {
    let w = null;
    try {
      w = deps.getPassWindow ? deps.getPassWindow(satKey, new Date(t)) : null;
    } catch (_) {
      w = null;
    }
    if (w && Number.isFinite(w.aos) && Number.isFinite(w.los)) return w;
    return null;
  }

  /** Heard entry for satKey that covers time t (same pass), else null. */
  function heardThisPass(satKey, t) {
    if (!satKey) return null;
    t = t != null ? t : nowFn();
    const e = sent.get(satKey);
    if (!e) return null;
    if (e.passAos != null) {
      // Same pass: t still within that pass (+grace).
      if (t >= e.passAos && t <= e.passLos + LOS_GRACE_MS) return e;
      return null;
    }
    return t - e.at <= FALLBACK_MS ? e : null;
  }

  /** Record a Heard report (button or auto) for dedup. */
  function noteSent(satKey, info) {
    if (!satKey) return null;
    info = info || {};
    const at = info.at != null ? info.at : nowFn();
    const w = passOf(satKey, at);
    const e = {
      at,
      passAos: w ? w.aos : null,
      passLos: w ? w.los : null,
      satName: info.satName || null,
      source: info.source || "button",
      pending: !!info.pending,
    };
    sent.set(satKey, e);
    return e;
  }

  /**
   * Called after a QSO was logged OK. opts: { ctx, station, time: Date, source }
   * Resolves to { status: "sent"|"duplicate"|"error"|"no-sat", ... }; never rejects.
   */
  async function fromQso(opts) {
    opts = opts || {};
    const ctx = opts.ctx;
    const source = opts.source || "log";
    const when = opts.time instanceof Date ? opts.time : new Date(nowFn());
    if (!ctx || !ctx.satKey) return { status: "no-sat" };
    const satKey = ctx.satKey;
    const display = ctx.satName || satKey;
    const dup = heardThisPass(satKey, when.getTime());
    if (dup) {
      log(
        "AMSAT auto Heard: skip " + display + " — already reported this pass (" +
          dup.source + (dup.pending ? ", in progress" : "") + ")",
      );
      return { status: "duplicate", satKey, display, previous: dup };
    }
    // Claim the pass before going async so two quick logs send only one.
    const claim = noteSent(satKey, { at: when.getTime(), source, pending: true });
    try {
      const list = await amsat.getSatNames();
      const full = amsat.fillReport(
        { report: "Heard" },
        { names: list.names, ctx, station: opts.station || {}, now: when },
      );
      log("AMSAT report: auto (" + source + ") " + full.satName + " Heard " + full.callsign);
      const out = await amsat.submitReport(full);
      claim.pending = false;
      claim.satName = full.satName;
      log("AMSAT report: " + out.message);
      const evt = {
        status: "sent",
        source,
        satKey,
        display,
        satName: full.satName,
        confirmed: !!out.confirmed,
        message: out.message,
      };
      notify(evt);
      return evt;
    } catch (e) {
      if (sent.get(satKey) === claim) sent.delete(satKey); // allow a retry on the next log
      const msg = (e && e.message) || String(e);
      log("AMSAT auto Heard failed (" + display + "): " + msg);
      const evt = { status: "error", source, satKey, display, error: msg };
      notify(evt);
      return evt;
    }
  }

  return { fromQso, noteSent, heardThisPass, _sent: sent };
}

module.exports = { createAutoHeard, LOS_GRACE_MS, FALLBACK_MS };
