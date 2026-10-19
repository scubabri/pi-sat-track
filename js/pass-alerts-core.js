/**
 * Pass alerts — pure logic shared by the browser (js/pass-alerts.js), the
 * server (lib/profiles.js normalize/prune, lib/state.js alert sat keys) and
 * node tests. No DOM, no clock: callers pass `now`.
 *
 * Stored per station profile (profiles.json → profiles[name].alerts):
 *   {
 *     sats: ["AO-7", ...],                       // every pass of these sats
 *     passes: [{ key, aosMs, losMs }],           // one-off single passes
 *     passExceptions: [{ key, aosMs, losMs }],   // passes muted under a sat alert
 *     allFavorites: false                        // every favorite (incl. future ones)
 *   }
 * A pass is identified by sat key + AOS; AOS jitters by up to ~30 s between
 * server recomputes, so passes match within PASS_MATCH_TOL_MS.
 */
(function (root) {
  const PASS_MATCH_TOL_MS = 5 * 60 * 1000;
  const PRE_MS = 5 * 60 * 1000; // first alert at AOS−5:00
  const AOS_WINDOW_MS = 2 * 60 * 1000; // late "AOS now" still fires (throttled bg tabs)
  const PRUNE_GRACE_MS = 60 * 1000; // after LOS
  const DEFAULT_PASS_MS = 30 * 60 * 1000; // LOS unknown → assume AOS + 30 min
  const MAX_SATS = 200;
  const MAX_PASSES = 200;

  function emptyAlerts() {
    return { sats: [], passes: [], passExceptions: [], allFavorites: false };
  }

  function normPassList(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const p of list) {
      if (!p || typeof p.key !== "string" || !p.key) continue;
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

  /** Coerce anything (old/missing/garbage) into the stored shape. */
  function normalizeAlerts(a) {
    const out = emptyAlerts();
    if (!a || typeof a !== "object") return out;
    if (Array.isArray(a.sats)) {
      out.sats = a.sats
        .filter((k) => typeof k === "string" && k)
        .filter((k, i, arr) => arr.indexOf(k) === i)
        .slice(0, MAX_SATS);
    }
    out.passes = normPassList(a.passes);
    out.passExceptions = normPassList(a.passExceptions);
    out.allFavorites = a.allFavorites === true;
    return out;
  }

  function samePass(a, b) {
    return (
      !!a && !!b && a.key === b.key &&
      Number.isFinite(a.aosMs) && Number.isFinite(b.aosMs) &&
      Math.abs(a.aosMs - b.aosMs) < PASS_MATCH_TOL_MS
    );
  }

  function favList(favorites) {
    return Array.isArray(favorites) ? favorites.filter((k) => typeof k === "string" && k) : [];
  }

  /** Where a sat-level alert comes from: "sat" | "favorites" | null. */
  function satAlertSource(alerts, favorites, key) {
    if (!alerts || !key) return null;
    if (Array.isArray(alerts.sats) && alerts.sats.includes(key)) return "sat";
    if (alerts.allFavorites && favList(favorites).includes(key)) return "favorites";
    return null;
  }
  function satAlertOn(alerts, favorites, key) {
    return satAlertSource(alerts, favorites, key) != null;
  }

  /**
   * Bell state for one pass.
   *   look: "on" (explicit single pass) | "inherited" (sat/favorites alert) | "off"
   *   armed: will alert
   */
  function passAlertState(alerts, favorites, key, aosMs) {
    const p = { key, aosMs: Number(aosMs) };
    const satOn = satAlertOn(alerts, favorites, key);
    if (satOn) {
      const excepted = (alerts.passExceptions || []).some((e) => samePass(e, p));
      return { armed: !excepted, look: excepted ? "off" : "inherited", satOn: true, excepted, explicit: false };
    }
    const explicit = (alerts && alerts.passes ? alerts.passes : []).some((e) => samePass(e, p));
    return { armed: explicit, look: explicit ? "on" : "off", satOn: false, excepted: false, explicit };
  }

  function isPassArmed(alerts, favorites, key, aosMs) {
    return passAlertState(alerts, favorites, key, aosMs).armed;
  }

  function clone(a) {
    return normalizeAlerts(JSON.parse(JSON.stringify(normalizeAlerts(a))));
  }

  /** Sat bell (top bar / picker / Favorites row): alerts for every pass. */
  function toggleSat(alerts, favorites, key) {
    const a = clone(alerts);
    if (!key) return a;
    const favs = favList(favorites);
    const src = satAlertSource(a, favs, key);
    if (src) {
      a.sats = a.sats.filter((k) => k !== key);
      if (a.allFavorites && favs.includes(key)) {
        // "All favorites" no longer true: keep the other favorites on.
        a.allFavorites = false;
        favs.forEach((k) => { if (k !== key && !a.sats.includes(k)) a.sats.push(k); });
      }
    } else {
      a.sats.push(key);
      // Single-pass flags are now redundant.
      a.passes = a.passes.filter((p) => p.key !== key);
    }
    // A fresh sat on/off starts without per-pass exceptions.
    a.passExceptions = a.passExceptions.filter((p) => p.key !== key);
    return a;
  }

  /** Pass bell: explicit single pass, or an exception under a sat alert. */
  function togglePass(alerts, favorites, pass) {
    const a = clone(alerts);
    if (!pass || !pass.key || !Number.isFinite(Number(pass.aosMs))) return a;
    const p = { key: pass.key, aosMs: Math.round(Number(pass.aosMs)) };
    if (pass.losMs != null && Number.isFinite(Number(pass.losMs))) p.losMs = Math.round(Number(pass.losMs));
    if (satAlertOn(a, favorites, p.key)) {
      const had = a.passExceptions.some((e) => samePass(e, p));
      a.passExceptions = a.passExceptions.filter((e) => !samePass(e, p));
      if (!had) a.passExceptions.push(p);
    } else {
      const had = a.passes.some((e) => samePass(e, p));
      a.passes = a.passes.filter((e) => !samePass(e, p));
      if (!had) a.passes.push(p);
    }
    return a;
  }

  /** Favorites header bell: "on" (every favorite), "partial", "off". */
  function allFavoritesState(alerts, favorites) {
    const favs = favList(favorites);
    if (!favs.length) return alerts && alerts.allFavorites ? "on" : "off";
    const n = favs.filter((k) => satAlertOn(alerts, favs, k)).length;
    if (n === favs.length) return "on";
    return n > 0 ? "partial" : "off";
  }

  function toggleAllFavorites(alerts, favorites) {
    const a = clone(alerts);
    const favs = favList(favorites);
    if (allFavoritesState(a, favs) === "on") {
      a.allFavorites = false;
      a.sats = a.sats.filter((k) => !favs.includes(k));
      a.passExceptions = a.passExceptions.filter((p) => !favs.includes(p.key));
    } else {
      a.allFavorites = true;
      a.passes = a.passes.filter((p) => !favs.includes(p.key));
      a.passExceptions = a.passExceptions.filter((p) => !favs.includes(p.key));
    }
    return a;
  }

  function passEndMs(p) {
    return p.losMs != null ? p.losMs : p.aosMs + DEFAULT_PASS_MS;
  }

  /** Drop single passes / exceptions whose LOS is over. */
  function pruneAlerts(alerts, now) {
    const a = normalizeAlerts(alerts);
    const keep = (p) => passEndMs(p) + PRUNE_GRACE_MS > now;
    const passes = a.passes.filter(keep);
    const passExceptions = a.passExceptions.filter(keep);
    const changed = passes.length !== a.passes.length || passExceptions.length !== a.passExceptions.length;
    a.passes = passes;
    a.passExceptions = passExceptions;
    return { alerts: a, changed };
  }

  /** Sats the server must keep next-pass predictions for. */
  function alertSatKeys(alerts, favorites) {
    const a = normalizeAlerts(alerts);
    const out = a.sats.slice();
    if (a.allFavorites) favList(favorites).forEach((k) => out.push(k));
    a.passes.forEach((p) => out.push(p.key));
    return out.filter((k, i, arr) => arr.indexOf(k) === i);
  }

  function toMs(v) {
    if (v == null) return NaN;
    if (typeof v === "number") return v;
    return new Date(v).getTime();
  }

  /**
   * Alert events due at `now`.
   * candidates: [{ key, display, aos, los, maxEl }] (aos/los ms or ISO) —
   *   predicted passes (server next-pass per alert sat + selected-sat list).
   * fired: [{ key, kind, aosMs }] already fired in this tab (dedupe).
   * Returns [{ id, key, display, kind: "pre5"|"aos", aosMs, losMs, maxEl, minutes }].
   */
  function dueAlerts(candidates, alerts, favorites, now, fired) {
    const out = [];
    const done = Array.isArray(fired) ? fired.slice() : [];
    const seen = [];
    for (const c of candidates || []) {
      if (!c || !c.key) continue;
      const aosMs = toMs(c.aos != null ? c.aos : c.aosMs);
      if (!Number.isFinite(aosMs)) continue;
      const losMsRaw = toMs(c.los != null ? c.los : c.losMs);
      const losMs = Number.isFinite(losMsRaw) ? losMsRaw : null;
      const pass = { key: c.key, aosMs };
      if (seen.some((s) => samePass(s, pass))) continue; // same pass listed twice
      seen.push(pass);
      if (!isPassArmed(alerts, favorites, c.key, aosMs)) continue;
      const kinds = [];
      if (now >= aosMs - PRE_MS && now < aosMs) kinds.push("pre5");
      if (now >= aosMs && now < aosMs + AOS_WINDOW_MS && (losMs == null || now <= losMs)) kinds.push("aos");
      for (const kind of kinds) {
        if (done.some((f) => f.kind === kind && samePass(f, pass))) continue;
        const ev = {
          id: c.key + "|" + kind + "|" + aosMs,
          key: c.key,
          display: c.display || c.key,
          kind,
          aosMs,
          losMs,
          maxEl: c.maxEl != null && Number.isFinite(Number(c.maxEl)) ? Number(c.maxEl) : null,
          minutes: kind === "pre5" ? Math.max(1, Math.ceil((aosMs - now) / 60000 - 0.25)) : 0,
        };
        out.push(ev);
        done.push({ key: c.key, kind, aosMs });
      }
    }
    return out;
  }

  /** Toast / notification text. fmtClock(ms) → "17:03 MT" | "23:03 UTC". */
  function alertText(ev, fmtClock) {
    const name = ev.display || ev.key;
    const max = ev.maxEl != null ? Math.round(ev.maxEl) + "\u00B0" : null;
    const clock = typeof fmtClock === "function" ? fmtClock(ev.aosMs) : null;
    if (ev.kind === "pre5") {
      const bits = [];
      if (max) bits.push("max " + max);
      if (clock) bits.push(clock);
      return name + " AOS in " + (ev.minutes || 5) + " min" + (bits.length ? " (" + bits.join(", ") + ")" : "");
    }
    return name + " AOS now" + (max ? " (max " + max + ")" : "");
  }

  const api = {
    PASS_MATCH_TOL_MS,
    PRE_MS,
    AOS_WINDOW_MS,
    PRUNE_GRACE_MS,
    emptyAlerts,
    normalizeAlerts,
    samePass,
    satAlertSource,
    satAlertOn,
    passAlertState,
    isPassArmed,
    toggleSat,
    togglePass,
    allFavoritesState,
    toggleAllFavorites,
    pruneAlerts,
    alertSatKeys,
    dueAlerts,
    alertText,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PassAlertsCore = api;
})(typeof window !== "undefined" ? window : this);
