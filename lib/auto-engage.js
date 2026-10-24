/**
 * Auto Engage — turn Radio + Antenna on for a pass and back off afterwards,
 * server-side (real time only; the client pass preview never triggers it, and
 * it works with no browser open). Separate from the pass alert bells.
 *
 * Sources (per station profile, see js/auto-engage-core.js):
 *   - top-bar "Auto Engage" button (profile.autoEngage): every pass of the
 *     SELECTED sat;
 *   - per-pass marks (profile.autoEngagePasses, Next Passes / Preview icon):
 *     that pass, even when another sat is selected — at T-5 the marked sat is
 *     selected (once; a manual selection made afterwards is not fought).
 * Passes are cut at the rotor min elevation (state "passes" / the Next Passes
 * list), like the rotor's own T-5 preposition.
 *
 * Rules:
 *   - At AOS−5:00 (or immediately if already inside that window / the pass):
 *     Radio on and Antenna on, each only if available in the active profile
 *     and not already on. Only what it turned on is "owned".
 *   - After LOS: turn off only what it owns. If the After-LOS park is running
 *     the antenna is left to the park (it ends with the antenna off) and the
 *     park's own re-engage at the next T-5 is cancelled.
 *   - A Radio / Antenna the user turns off during the pass stays off (no
 *     re-enable for that pass); an owned one turned off manually is no
 *     longer owned.
 *   - Selected sat changed during an engaged pass: re-evaluate — hand the
 *     owned Radio / Antenna to the new sat's pass if it is within T-5 / up,
 *     else turn them off.
 *   - Auto Select (lib/after-los.js) at LOS: when its target is already
 *     within T-5, Radio / Antenna stay on across the switch (no off/on blip).
 *   - A pass skipped under the button (profile.autoEngageSkips, icon click on
 *     a dim-yellow icon) is not engaged by the button (a mark still would).
 *   - Button turned off / pass unmarked / skipped mid-pass: Auto Engage stops managing
 *     that pass and leaves Radio / Antenna as they are.
 *   - Two candidate passes at once (marks, or a mark and the selected sat's
 *     pass): the earlier AOS wins; the other mark is skipped (logged).
 *   - Moon (EME) is never auto engaged.
 *
 * check(ctx) is called with every "state" (server.js, STATE_MS):
 *   ctx: { sat, isMoon, passes: [{aos, los}], toggle, marks: [{key, aosMs, losMs}], skips: [...],
 *          afterLos: state.afterLos, afterLosDone: watcher result (["park", "auto"] | null) }
 * deps: { now(), log(msg), notify(evt),
 *         radioAvailable(), radioOn(), setRadio(on),
 *         antennaAvailable(), antennaOn(), setAntenna(on),
 *         selectSat(key) → Promise, parkPending(), cancelParkResume() }
 */
const core = require("../js/auto-engage-core");

const { PRE_MS, samePass, isMoonKey, passEndMs } = core;
const SELECT_TIMEOUT_MS = 60 * 1000; // marked sat never became selected → give up
const HANDOFF_MS = 30 * 1000; // wait this long for an After-LOS Auto Select switch to land
const AUTO_SELECT_HOLD_MS = 15 * 1000; // don't race an Auto Select switch with a mark's select
const PARK_WAIT_MS = 15 * 60 * 1000;
const FORGET_MS = 60 * 60 * 1000;

function ms(v) {
  if (v == null) return null;
  const t = typeof v === "number" ? v : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

function hhmm(t) {
  try {
    return new Date(t).toTimeString().slice(0, 5);
  } catch (_) {
    return String(t);
  }
}

function createEngine(deps) {
  deps = deps || {};
  const nowFn = deps.now || Date.now;
  const log = deps.log || (() => {});
  const notify = deps.notify || (() => {});
  const call = (fn, ...a) => {
    try {
      return typeof deps[fn] === "function" ? deps[fn](...a) : undefined;
    } catch (e) {
      log("Auto Engage: " + fn + " failed: " + (e && e.message ? e.message : e));
      return undefined;
    }
  };

  let session = null; // { key, aosMs, losMs, toggle, mark, owned:{radio,antenna}, pending, selectAt, autoTarget }
  let linger = null; // { fromKey, owned, until } — waiting for an Auto Select switch at LOS
  let parkWait = null; // { until } — owned antenna left to the After-LOS park
  let autoSelectHoldUntil = 0;
  const suppressed = []; // [{ key, aosMs, losMs, radio, antenna }] manual off this pass
  const consumed = []; // marks already started (never re-selected)
  const ended = []; // passes already disengaged at LOS
  const skipped = []; // marks skipped (overlap), logged once

  const has = (list, p) => list.some((x) => samePass(x, p));
  function remember(list, p) {
    if (!has(list, p)) list.push({ key: p.key, aosMs: p.aosMs, losMs: p.losMs });
  }
  function forget(t) {
    for (const list of [suppressed, consumed, ended, skipped]) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (passEndMs(list[i]) + FORGET_MS < t) list.splice(i, 1);
      }
    }
  }
  const label = (p) => p.key + " pass AOS " + hhmm(p.aosMs);

  /** Selected sat's pass that is up or within T-5 now (Moon never). */
  function selectedPass(ctx, t) {
    if (!ctx.sat || ctx.isMoon || isMoonKey(ctx.sat)) return null;
    for (const p of ctx.passes || []) {
      const a = ms(p.aos);
      const l = ms(p.los);
      if (a == null || l == null || l <= t) continue;
      return a - PRE_MS <= t ? { key: ctx.sat, aosMs: a, losMs: l } : null;
    }
    return null;
  }

  /** Every pass that wants engaging now, earliest AOS first. */
  function candidates(ctx, t) {
    const sel = selectedPass(ctx, t);
    const out = [];
    for (const m of core.normalizeMarks(ctx.marks)) {
      let c = { key: m.key, aosMs: m.aosMs, losMs: m.losMs != null ? m.losMs : passEndMs(m) };
      if (sel && samePass(sel, c)) c = Object.assign({}, sel); // live AOS/LOS of the selected sat
      if (!(c.aosMs - PRE_MS <= t && t < c.losMs)) continue;
      if (has(ended, c) || has(skipped, c)) continue;
      if (c.key !== ctx.sat && has(consumed, c)) continue; // don't fight a later manual selection
      out.push(Object.assign(c, { mark: true, toggle: false }));
    }
    if (ctx.toggle && sel && !has(ended, sel) && !isSkipped(ctx, sel)) {
      const m = out.find((c) => samePass(c, sel));
      if (m) m.toggle = true;
      else out.push(Object.assign({}, sel, { mark: false, toggle: true }));
    }
    out.sort((a, b) => a.aosMs - b.aosMs || (a.key === ctx.sat ? -1 : b.key === ctx.sat ? 1 : 0));
    return out;
  }

  function skip(c, winner) {
    if (!c.mark || has(skipped, c)) return;
    remember(skipped, c);
    log("Auto Engage: skipped marked " + label(c) + " — overlaps " + label(winner) + " (earlier AOS wins)");
    notify({ event: "skip", sat: c.key, aosMs: c.aosMs, winner: winner.key });
  }

  /** Best candidate now (the others in their window are skipped). */
  function pick(ctx, t, exclude) {
    let list = candidates(ctx, t);
    if (exclude) list = list.filter((c) => !samePass(c, exclude));
    if (!list.length) return null;
    const best = list[0];
    // Right after an After-LOS Auto Select switch, let it land before selecting another sat.
    if (best.key !== ctx.sat && t < autoSelectHoldUntil) return null;
    list.slice(1).forEach((c) => skip(c, best));
    return best;
  }

  function engage(s, ctx) {
    parkWait = null;
    const sup = suppressed.find((x) => samePass(x, s)) || {};
    const did = [];
    const notes = [];
    const one = (kind, Name, avail, isOn, set) => {
      if (sup[kind]) { notes.push(Name + " left off (turned off manually this pass)"); return; }
      if (!call(avail)) { notes.push(Name + " not configured"); return; }
      if (call(isOn)) {
        if (!s.owned[kind]) notes.push(Name + " already on (left as is)");
        return;
      }
      call(set, true);
      s.owned[kind] = true;
      did.push(Name);
    };
    one("radio", "Radio", "radioAvailable", "radioOn", "setRadio");
    one("antenna", "Antenna", "antennaAvailable", "antennaOn", "setAntenna");
    const src = s.toggle && s.mark ? "button + marked pass" : s.mark ? "marked pass" : "Auto Engage button";
    log(
      "Auto Engage: engage " + label(s) + " (" + src + ")" +
        (did.length ? " — turned on " + did.join(" + ") : " — nothing to turn on") +
        (notes.length ? "; " + notes.join("; ") : ""),
    );
    notify({ event: "engage", sat: s.key, aosMs: s.aosMs, losMs: s.losMs, radio: s.owned.radio, antenna: s.owned.antenna });
  }

  function disengage(owned, key, why) {
    const t = nowFn();
    const parts = [];
    if (owned.radio) {
      if (call("radioOn")) {
        call("setRadio", false);
        parts.push("Radio off");
      }
    }
    if (owned.antenna) {
      if (call("parkPending")) {
        parkWait = { until: t + PARK_WAIT_MS };
        parts.push("Antenna off when the After-LOS park completes");
      } else if (call("antennaOn")) {
        call("setAntenna", false);
        parts.push("Antenna off");
      }
    }
    log("Auto Engage: disengage " + key + " (" + why + ") — " + (parts.length ? parts.join(", ") : "nothing it turned on is still on"));
    notify({ event: "disengage", sat: key, why, radio: !!owned.radio, antenna: !!owned.antenna });
  }

  function startSession(c, ctx, t, inherited) {
    if (c.mark) remember(consumed, c);
    session = {
      key: c.key,
      aosMs: c.aosMs,
      losMs: c.losMs,
      toggle: !!c.toggle,
      mark: !!c.mark,
      owned: { radio: !!(inherited && inherited.radio), antenna: !!(inherited && inherited.antenna) },
      pending: false,
      selectAt: 0,
      autoTarget: null,
    };
    if (inherited && (inherited.radio || inherited.antenna)) log("Auto Engage: handing Radio / Antenna over to " + label(c));
    if (c.key !== ctx.sat) {
      session.pending = true;
      session.selectAt = t;
      log("Auto Engage: selecting " + c.key + " for its marked pass (AOS " + hhmm(c.aosMs) + ")");
      Promise.resolve()
        .then(() => deps.selectSat(c.key))
        .catch((e) => log("Auto Engage: select " + c.key + " failed: " + (e && e.message ? e.message : e)));
      return;
    }
    engage(session, ctx);
  }

  /** Session over (LOS / sat change): hand over, wait for Auto Select, or turn off. */
  function endSession(s, ctx, t, reason) {
    session = null;
    if (reason === "los") remember(ended, s);
    const owns = s.owned.radio || s.owned.antenna;
    const tgt = s.autoTarget;
    if (
      reason === "los" && owns && ctx.sat === s.key && tgt && tgt.key !== s.key &&
      (t < autoSelectHoldUntil || (ctx.afterLos && ctx.afterLos.autoSelect)) &&
      ms(tgt.aos) != null && ms(tgt.aos) - PRE_MS <= t + HANDOFF_MS
    ) {
      linger = { fromKey: s.key, owned: s.owned, until: t + HANDOFF_MS };
      log("Auto Engage: LOS " + s.key + " — keeping Radio / Antenna for Auto Select → " + tgt.key);
      return;
    }
    const c = pick(ctx, t, s);
    if (c) {
      startSession(c, ctx, t, s.owned);
      return;
    }
    if (owns) disengage(s.owned, s.key, reason === "los" ? "LOS" : "selected sat changed to " + (ctx.sat || "none"));
    else log("Auto Engage: done " + label(s) + " (" + (reason === "los" ? "LOS" : "sat changed") + ") — nothing to turn off");
  }

  function stepParkWait(t) {
    if (!parkWait) return;
    if (!call("parkPending")) { parkWait = null; return; }
    if (!call("antennaOn")) {
      call("cancelParkResume");
      parkWait = null;
      log("Auto Engage: park complete — antenna stays off (Auto Engage had turned it on)");
    } else if (t > parkWait.until) parkWait = null;
  }

  /** Pass skipped under the button (icon click; profile.autoEngageSkips). */
  function isSkipped(ctx, p) {
    return core.normalizeMarks(ctx.skips).some((m) => samePass(m, p));
  }

  function wanted(ctx, s) {
    if (ctx.toggle && !ctx.isMoon && !isMoonKey(s.key) && !isSkipped(ctx, s)) return true;
    return core.normalizeMarks(ctx.marks).some((m) => samePass(m, s));
  }

  function check(ctx) {
    ctx = ctx || {};
    const t = nowFn();
    forget(t);
    if (Array.isArray(ctx.afterLosDone) && ctx.afterLosDone.includes("auto")) autoSelectHoldUntil = t + AUTO_SELECT_HOLD_MS;
    stepParkWait(t);

    if (session && session.pending) {
      const s = session;
      if (ctx.sat === s.key) {
        s.pending = false;
        if (!wanted(ctx, s)) { session = null; log("Auto Engage: " + label(s) + " no longer marked — not engaging"); }
        else engage(s, ctx);
      } else if (!wanted(ctx, s) || t >= s.losMs || t - s.selectAt > SELECT_TIMEOUT_MS) {
        session = null;
        log("Auto Engage: " + label(s) + " — " + c2s(s, ctx, t));
        if (s.owned.radio || s.owned.antenna) disengage(s.owned, s.key, "marked sat not selected");
      }
    } else if (session) {
      const s = session;
      if (ctx.sat !== s.key) {
        log("Auto Engage: selected sat changed " + s.key + " → " + (ctx.sat || "none") + " during " + label(s) + " — re-evaluating");
        endSession(s, ctx, t, "sat");
      } else {
        const live = selectedPass(ctx, t) || (ctx.passes || []).map((p) => ({ key: s.key, aosMs: ms(p.aos), losMs: ms(p.los) })).find((p) => samePass(p, s));
        if (live && samePass(live, s) && live.losMs != null) s.losMs = live.losMs;
        if (ctx.afterLos && ctx.afterLos.inPass) s.autoTarget = ctx.afterLos.target || null;
        if (t >= s.losMs) endSession(s, ctx, t, "los");
        else if (!wanted(ctx, s)) {
          session = null;
          log("Auto Engage: stopped managing " + label(s) + " (button off / pass unmarked / skipped) — Radio / Antenna left as they are");
        } else {
          // Anything else in its window now overlaps this pass.
          candidates(ctx, t).forEach((c) => { if (!samePass(c, s)) skip(c, s); });
        }
      }
    }

    if (linger) {
      if (ctx.sat !== linger.fromKey || t >= linger.until) {
        const owned = linger.owned;
        const from = linger.fromKey;
        linger = null;
        const c = pick(ctx, t);
        if (c) startSession(c, ctx, t, owned);
        else disengage(owned, from, ctx.sat !== from ? "Auto Select → " + ctx.sat + " has no pass within T-5" : "LOS");
      }
      return status();
    }

    if (!session) {
      const c = pick(ctx, t);
      if (c) startSession(c, ctx, t, null);
    }
    return status();
  }

  function c2s(s, ctx, t) {
    if (!wanted(ctx, s)) return "unmarked before it was selected";
    if (t >= s.losMs) return "LOS before it was selected";
    return "could not select it";
  }

  /** Radio / Antenna button (or Park) used by the user: "radio" | "antenna". */
  function userSet(kind, on) {
    if (kind !== "radio" && kind !== "antenna") return;
    if (kind === "antenna") parkWait = null;
    if (on) return;
    if (session) {
      const sup = suppressed.find((x) => samePass(x, session));
      if (sup) sup[kind] = true;
      else suppressed.push({ key: session.key, aosMs: session.aosMs, losMs: session.losMs, [kind]: true });
      if (session.owned[kind]) {
        session.owned[kind] = false;
        log("Auto Engage: " + (kind === "radio" ? "Radio" : "Antenna") + " turned off manually — not re-enabling it for " + label(session));
      }
    }
    if (linger && linger.owned[kind]) linger.owned[kind] = false;
  }

  function status() {
    const s = session;
    return {
      engaged: s && !s.pending
        ? { sat: s.key, aosMs: s.aosMs, losMs: s.losMs, radio: s.owned.radio, antenna: s.owned.antenna, toggle: s.toggle, mark: s.mark }
        : null,
      selecting: s && s.pending ? s.key : null,
      handoff: !!linger,
    };
  }

  return { check, userSet, status };
}

module.exports = { createEngine, PRE_MS, HANDOFF_MS, AUTO_SELECT_HOLD_MS, SELECT_TIMEOUT_MS };
