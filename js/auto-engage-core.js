/**
 * Auto Engage — pure helpers shared by the browser (js/auto-engage-ui.js),
 * the server (lib/profiles.js normalize/prune, lib/auto-engage.js) and node
 * tests. No DOM, no clock: callers pass `now`.
 *
 * Auto Engage turns Radio + Antenna on at T-5 before AOS and back off after
 * LOS (only what it turned on). Two independent sources, both per station
 * profile (profiles.json → profiles[name]):
 *   autoEngage: true|false                 // top-bar button: every pass of the selected sat
 *   autoEngagePasses: [{ key, aosMs, losMs }] // per-pass marks (top bar / Next Passes / Preview icon)
 *   autoEngageSkips:  [{ key, aosMs, losMs }] // passes skipped under the button (exceptions)
 * Completely separate from the pass alert bells (js/pass-alerts-core.js).
 * A pass is identified by sat key + AOS; AOS jitters by up to ~30 s between
 * server recomputes, so passes match within PASS_MATCH_TOL_MS (same as bells).
 */
(function (root) {
  const PASS_MATCH_TOL_MS = 5 * 60 * 1000;
  const PRE_MS = 5 * 60 * 1000; // engage at AOS−5:00 (same moment as the rotor preposition)
  const PRUNE_GRACE_MS = 60 * 1000; // after LOS
  const DEFAULT_PASS_MS = 30 * 60 * 1000; // LOS unknown → assume AOS + 30 min
  const MAX_PASSES = 200;

  function isMoonKey(k) {
    return k != null && String(k).toUpperCase() === "MOON";
  }

  function samePass(a, b) {
    return (
      !!a && !!b && a.key === b.key &&
      Number.isFinite(Number(a.aosMs)) && Number.isFinite(Number(b.aosMs)) &&
      Math.abs(Number(a.aosMs) - Number(b.aosMs)) < PASS_MATCH_TOL_MS
    );
  }

  /** Coerce anything into [{ key, aosMs, losMs? }] (deduped; Moon never marked). */
  function normalizeMarks(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const p of list) {
      if (!p || typeof p.key !== "string" || !p.key || isMoonKey(p.key)) continue;
      const aosMs = Number(p.aosMs);
      if (!Number.isFinite(aosMs)) continue;
      const e = { key: p.key, aosMs: Math.round(aosMs) };
      const losMs = Number(p.losMs);
      if (p.losMs != null && Number.isFinite(losMs) && losMs >= aosMs) e.losMs = Math.round(losMs);
      if (out.some((o) => samePass(o, e))) continue;
      out.push(e);
      if (out.length >= MAX_PASSES) break;
    }
    return out;
  }

  function findMark(marks, key, aosMs) {
    const p = { key, aosMs: Number(aosMs) };
    return (Array.isArray(marks) ? marks : []).find((m) => samePass(m, p)) || null;
  }

  function isMarked(marks, key, aosMs) {
    return !!findMark(marks, key, aosMs);
  }

  /** Mark / unmark one pass → new list. */
  function toggleMark(marks, pass) {
    const list = normalizeMarks(marks);
    if (!pass || !pass.key || isMoonKey(pass.key) || !Number.isFinite(Number(pass.aosMs))) return list;
    const p = { key: pass.key, aosMs: Math.round(Number(pass.aosMs)) };
    if (pass.losMs != null && Number.isFinite(Number(pass.losMs))) p.losMs = Math.round(Number(pass.losMs));
    const had = list.some((m) => samePass(m, p));
    const next = list.filter((m) => !samePass(m, p));
    if (!had) next.push(p);
    return next;
  }

  function passEndMs(p) {
    return p.losMs != null ? p.losMs : p.aosMs + DEFAULT_PASS_MS;
  }

  /** Drop marks whose LOS is over. */
  function pruneMarks(marks, now) {
    const list = normalizeMarks(marks);
    const kept = list.filter((p) => passEndMs(p) + PRUNE_GRACE_MS > now);
    return { marks: kept, changed: kept.length !== list.length };
  }

  function removePass(list, p) {
    return normalizeMarks(list).filter((m) => !samePass(m, p));
  }
  function addPass(list, p) {
    const l = removePass(list, p);
    l.push(p);
    return l;
  }

  /**
   * Icon state for one pass (top bar, Next Passes row, Preview banner).
   * o: { marks, skips, toggleOn, selectedKey, key, aosMs, engaged: {sat, aosMs} | null }
   *   covered: the Auto Engage button covers it (button on, pass of the selected sat)
   *   look: "active" (green, engaged now) | "on" (bright yellow, this pass marked)
   *       | "inherited" (dim yellow, covered by the button) | "skipped" (grey,
   *         button on but this pass skipped) | "off"
   */
  function passEngageState(o) {
    o = o || {};
    const key = o.key;
    const aosMs = Number(o.aosMs);
    const off = { look: "off", marked: false, covered: false, skipped: false, armed: false, active: false };
    if (!key || isMoonKey(key) || !Number.isFinite(aosMs)) return off;
    const p = { key, aosMs };
    const marked = isMarked(o.marks, key, aosMs);
    const covered = !!o.toggleOn && key === o.selectedKey;
    const skipped = covered && normalizeMarks(o.skips).some((m) => samePass(m, p));
    const e = o.engaged;
    const active = !!e && samePass({ key: e.sat != null ? e.sat : e.key, aosMs: Number(e.aosMs) }, p);
    const look = active ? "active" : marked ? "on" : covered ? (skipped ? "skipped" : "inherited") : "off";
    return { look, marked, covered, skipped, armed: marked || (covered && !skipped), active };
  }

  /**
   * Icon click → new { marks, skips }:
   *   skipped → un-skip; covered by the button → skip this pass (and drop a
   *   mark); marked → unmark; else mark.
   */
  function clickPass(o, pass) {
    const st = passEngageState(Object.assign({}, o, { key: pass && pass.key, aosMs: pass && pass.aosMs }));
    let marks = normalizeMarks(o && o.marks);
    let skips = normalizeMarks(o && o.skips);
    if (!pass || !pass.key || isMoonKey(pass.key) || !Number.isFinite(Number(pass.aosMs))) return { marks, skips };
    const p = { key: pass.key, aosMs: Math.round(Number(pass.aosMs)) };
    if (pass.losMs != null && Number.isFinite(Number(pass.losMs))) p.losMs = Math.round(Number(pass.losMs));
    if (st.skipped) skips = removePass(skips, p);
    else if (st.covered) {
      skips = addPass(skips, p);
      marks = removePass(marks, p);
    } else if (st.marked) marks = removePass(marks, p);
    else marks = addPass(marks, p);
    return { marks, skips };
  }

  const api = {
    PASS_MATCH_TOL_MS,
    PRE_MS,
    PRUNE_GRACE_MS,
    DEFAULT_PASS_MS,
    isMoonKey,
    samePass,
    normalizeMarks,
    findMark,
    isMarked,
    toggleMark,
    passEndMs,
    pruneMarks,
    passEngageState,
    clickPass,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AutoEngageCore = api;
})(typeof window !== "undefined" ? window : this);
