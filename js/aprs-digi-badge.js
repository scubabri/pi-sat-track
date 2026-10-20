/**
 * When the APRS window's last-TX badge ("✓ Digipeated by KU5R-6 · 02:03:42 UTC",
 * "Sent … — waiting for digipeat…") is shown, and its age text.
 *
 * The badge ages out on the same window as Recent stations / APRS Heard
 * (Configure → KISS / APRS "heard expire", server aprs-heard expireMs), and
 * goes away at LOS of the satellite it went through (server latches
 * digi.losMs) or after the window's Clear (digi.clearedMs). Age counts from
 * the first digipeat (or the send while still waiting). The "Digipeats: N"
 * link is the session count and is independent of the badge.
 *
 * Shared by the browser (window.aprsDigiBadge) and node tests.
 */
(function (root) {
  /** {ageMs} while the badge should show, else null. now = server-skewed ms. */
  function digiBadge(last, now, expireMs) {
    if (!last) return null;
    const d = last.digi || {};
    if (d.clearedMs || d.losMs) return null;
    const ref = d.state === "digipeated" && d.firstMs ? d.firstMs : last.time;
    if (!Number.isFinite(ref)) return null;
    const age = Math.max(0, now - ref);
    if (expireMs > 0 && age > expireMs) return null;
    return { ageMs: age };
  }
  /** "just now", "40 s ago", "3 min ago", "1.5 h ago". */
  function agoText(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 10) return "just now";
    if (s < 60) return s + " s ago";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    return (s / 3600).toFixed(1) + " h ago";
  }
  const api = { digiBadge, agoText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.aprsDigiBadge = api;
})(typeof window !== "undefined" ? window : this);
