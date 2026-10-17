/**
 * After-LOS actions for the selected satellite, fired once per pass when its
 * min-EL LOS is crossed (server-side, real time only; the client pass preview
 * never triggers them, and it works with no browser open):
 *   Park        — Configure → Rotor → After LOS = "park" (config.rotorAfterLos
 *                 / ROTOR_AFTER_LOS, per profile; default "none"). Parks the
 *                 rotor if the antenna is engaged; the rotor re-engages by
 *                 itself at the next T-5 preposition.
 *   Auto Select — top-bar button (profile.autoSelect). Selects the favorite
 *                 with the soonest AOS above the rotor min EL (already-up
 *                 favorites count as starting at LOS; ties within 60 s go to
 *                 the higher max EL). The rotor waits for the new sat's normal
 *                 T-5 preposition. Does nothing if the selected sat is not a
 *                 favorite, there are no favorites, or none has a pass.
 * Both may be on: park first, then auto select.
 */
const MODES = ["none", "park"];
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
 * ctx: { mode, autoSelect, sat, favoriteKeys, favorites, passes, now, antennaOn }
 * → { mode, autoSelect, losMs, inPass, park, parkFallback, target, fallback }
 *   park: true when Park will run at LOS (mode "park" and antenna engaged)
 *   parkFallback: "antenna-off" | null
 *   target: auto-select target {key, display, aos, los, maxEl} | null
 *   fallback (auto select): "no-favorites" | "not-favorite" | "no-upcoming-pass"
 *     | "pending" (before the pass; target not known yet) | null
 */
function plan(ctx) {
  ctx = ctx || {};
  const mode = normMode(ctx.mode);
  const autoSelect = ctx.autoSelect === true;
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
    autoSelect,
    losMs: cur ? cur.los : null,
    inPass: !!(cur && cur.aos != null && cur.aos <= now),
    park: false,
    parkFallback: null,
    target: null,
    fallback: null,
  };
  if (mode === "park") {
    if (ctx.antennaOn) out.park = true;
    else out.parkFallback = "antenna-off";
  }
  if (autoSelect) {
    const favSet = new Set(ctx.favoriteKeys || []);
    if (!favSet.size) out.fallback = "no-favorites";
    else if (!favSet.has(ctx.sat)) out.fallback = "not-favorite";
    else {
      out.target = pickAutoTarget(ctx.sat, ctx.favoriteKeys, ctx.favorites, out.losMs || now);
      // Favorites only carry their NEXT pass, so before the selected sat's
      // pass a later LOS may simply be out of range yet: "pending" (resolved
      // as passes roll forward). During the pass, no target = nothing to do.
      if (!out.target) out.fallback = out.inPass || !out.losMs ? "no-upcoming-pass" : "pending";
    }
  }
  return out;
}

/**
 * Edge-triggered: arms while the selected sat is in a pass, fires once when
 * that pass's LOS is crossed with the same sat still selected. Selecting a
 * different sat mid-pass disarms (the new sat starts its own cycle).
 * deps: { park(), selectSat(key) → Promise, notify(evt), log(msg), now() }
 * notify evt: { sat, park: bool, target?: key, display?: name }
 * Returns the list of actions taken (["park", "auto"]), [] when armed but
 * nothing to do, or null when not firing.
 */
function createWatcher(deps) {
  const log = deps.log || (() => {});
  const notify = deps.notify || (() => {});
  const nowFn = deps.now || Date.now;
  let armed = null; // { sat, los, target } — target from the last in-pass plan
  function check(st) {
    if (!st || !st.afterLos) return null;
    const now = nowFn();
    const a = st.afterLos;
    if (armed && armed.sat !== st.sat) armed = null;
    if (a.inPass && a.losMs) {
      armed = { sat: st.sat, los: a.losMs, target: a.target || null, fallback: a.fallback || null };
      return null;
    }
    if (!armed || now < armed.los) return null;
    const sat = armed.sat;
    // After LOS the live plan keys off the sat's NEXT pass, so the auto-select
    // target must come from the pass that just ended (last in-pass plan).
    const target = armed.target && armed.target.los > now ? armed.target : null;
    const fallback = armed.target ? (target ? null : "no-upcoming-pass") : armed.fallback;
    armed = null;
    const done = [];
    if (a.mode === "park") {
      if (a.park) {
        log("After LOS (" + sat + "): park");
        deps.park();
        done.push("park");
      } else {
        log("After LOS (" + sat + "): park skipped — antenna off");
      }
    }
    if (a.autoSelect) {
      if (target) {
        const t = target;
        log("After LOS (" + sat + "): auto select → " + t.key);
        done.push("auto");
        const parked = done.includes("park");
        Promise.resolve(deps.selectSat(t.key))
          .then(() => notify({ sat, park: parked, target: t.key, display: t.display, aos: t.aos }))
          .catch((e) => {
            log("After LOS select failed: " + (e && e.message ? e.message : e));
            if (parked) notify({ sat, park: true });
          });
      } else {
        log("After LOS (" + sat + "): auto select — nothing to select (" + (fallback || "no-upcoming-pass") + ")");
      }
    }
    if (done.length === 1 && done[0] === "park") notify({ sat, park: true });
    return done;
  }
  check.isArmed = () => !!armed;
  return check;
}

module.exports = { MODES, TIE_MS, normMode, plan, pickAutoTarget, createWatcher };
