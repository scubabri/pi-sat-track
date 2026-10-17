/**
 * After-LOS action for the selected satellite (Configure → Rotor → After LOS,
 * stored per profile as config.rotorAfterLos / config.ROTOR_AFTER_LOS):
 *   "none" (default) — current behavior (hold LOS az, preposition at T-5)
 *   "park"           — park the rotor once the selected sat's pass ends
 *                      (only if the antenna is engaged); the rotor re-engages
 *                      by itself at the next T-5 preposition
 *   "auto"           — select the favorite with the soonest AOS (above the
 *                      rotor min EL); ties go to the higher max elevation.
 *                      The rotor waits for that sat's normal T-5 preposition.
 * Falls back to doing nothing when the selected sat is not a favorite, there
 * are no favorites, or no favorite has an upcoming pass.
 *
 * plan() is pure and rides on the "state" payload (top-bar indicator).
 * createWatcher() fires the action once per pass on the server, from real
 * time only (client pass preview never triggers it), so it also works with
 * no browser open.
 */
const MODES = ["none", "park", "auto"];
/** Candidates whose (effective) AOS is within this of the soonest tie on max EL. */
const TIE_MS = 60 * 1000;

function ms(v) {
  if (v == null) return null;
  const t = typeof v === "number" ? v : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

function normMode(m) {
  const v = String(m == null ? "" : m).toLowerCase().trim();
  return MODES.includes(v) ? v : "none";
}

/**
 * Favorite (other than `sat`) to switch to after the LOS at `afterMs`.
 * Uses each favorite's cached nextPass {aos, los, maxEl} (already cut at the
 * rotor min EL). A favorite already up at `afterMs` counts as starting then.
 * Soonest effective AOS wins; within TIE_MS the higher max EL wins.
 */
function pickAutoTarget(sat, favoriteKeys, favorites, afterMs) {
  const favSet = new Set(favoriteKeys || []);
  const cands = [];
  for (const f of favorites || []) {
    if (!f || !f.key || f.key === sat || !favSet.has(f.key)) continue;
    const np = f.nextPass;
    const aos = np && ms(np.aos);
    const los = np && ms(np.los);
    if (aos == null || los == null || los <= afterMs) continue;
    cands.push({
      key: f.key,
      display: f.display || f.key,
      aos,
      los,
      maxEl: np.maxEl != null && Number.isFinite(Number(np.maxEl)) ? Number(np.maxEl) : null,
      start: Math.max(aos, afterMs),
    });
  }
  if (!cands.length) return null;
  const soonest = Math.min(...cands.map((c) => c.start));
  const near = cands.filter((c) => c.start - soonest <= TIE_MS);
  near.sort(
    (a, b) =>
      (b.maxEl != null ? b.maxEl : -1) - (a.maxEl != null ? a.maxEl : -1) ||
      a.start - b.start,
  );
  const best = near[0];
  delete best.start;
  return best;
}

/**
 * ctx: { mode, sat, favoriteKeys, favorites, passes, now, antennaOn }
 * → { mode, losMs, inPass, target|null, fallback|null }
 *   fallback: "antenna-off" | "no-favorites" | "not-favorite" | "no-upcoming-pass"
 */
function plan(ctx) {
  ctx = ctx || {};
  const mode = normMode(ctx.mode);
  const now = ctx.now || Date.now();
  // The pass whose LOS the action keys off: the one in progress, else the next.
  let cur = null;
  for (const p of ctx.passes || []) {
    const a = ms(p.aos);
    const l = ms(p.los);
    if (l != null && l > now) {
      cur = { aos: a, los: l };
      break;
    }
  }
  const out = {
    mode,
    losMs: cur ? cur.los : null,
    inPass: !!(cur && cur.aos != null && cur.aos <= now),
    target: null,
    fallback: null,
  };
  if (mode === "park" && !ctx.antennaOn) out.fallback = "antenna-off";
  if (mode === "auto") {
    const favSet = new Set(ctx.favoriteKeys || []);
    if (!favSet.size) out.fallback = "no-favorites";
    else if (!favSet.has(ctx.sat)) out.fallback = "not-favorite";
    else {
      out.target = pickAutoTarget(ctx.sat, ctx.favoriteKeys, ctx.favorites, out.losMs || now);
      if (!out.target) out.fallback = "no-upcoming-pass";
    }
  }
  return out;
}

/**
 * Edge-triggered: arms while the selected sat is in a pass, fires once when
 * that pass's LOS is crossed with the same sat still selected. Selecting a
 * different sat mid-pass disarms (the new sat starts its own cycle).
 * deps: { park(), selectSat(key) → Promise, notify(evt), log(msg), now() }
 */
function createWatcher(deps) {
  const log = deps.log || (() => {});
  const notify = deps.notify || (() => {});
  const nowFn = deps.now || Date.now;
  let armed = null; // { sat, los }
  function check(st) {
    if (!st || !st.afterLos) return null;
    const now = nowFn();
    const a = st.afterLos;
    if (armed && armed.sat !== st.sat) armed = null;
    if (a.inPass && a.losMs) {
      armed = { sat: st.sat, los: a.losMs };
      return null;
    }
    if (!armed || now < armed.los) return null;
    const sat = armed.sat;
    armed = null;
    if (a.mode === "park") {
      if (a.fallback === "antenna-off") {
        log("After LOS (" + sat + "): park skipped — antenna off");
        return "skip";
      }
      log("After LOS (" + sat + "): park");
      deps.park();
      notify({ action: "park", sat });
      return "park";
    }
    if (a.mode === "auto") {
      if (!a.target) {
        log("After LOS (" + sat + "): auto select — nothing to select (" + a.fallback + ")");
        return "skip";
      }
      const t = a.target;
      log("After LOS (" + sat + "): auto select → " + t.key);
      Promise.resolve(deps.selectSat(t.key))
        .then(() => notify({ action: "auto", sat, target: t.key, display: t.display, aos: t.aos }))
        .catch((e) => log("After LOS select failed: " + (e && e.message ? e.message : e)));
      return "auto";
    }
    return null;
  }
  check.isArmed = () => !!armed;
  return check;
}

module.exports = { MODES, TIE_MS, normMode, plan, pickAutoTarget, createWatcher };
