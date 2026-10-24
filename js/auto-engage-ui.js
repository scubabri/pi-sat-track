/**
 * Auto Engage per-pass marks — browser side. Logic in js/auto-engage-core.js;
 * the server (lib/auto-engage.js) does the engaging, with or without a browser.
 *  - paints every `.pass-engage[data-engage="pass"]` icon (Next Passes rows,
 *    Preview banner) and handles their clicks (capture phase, so rows and the
 *    banner don't also react);
 *  - js/tracker.js hands it "profiles" (autoEngagePasses) and "set-ack";
 *  - saves on the active station profile ("auto-engage-passes-set" → server →
 *    "profiles" broadcast to every client), latest click wins (set-guard.js).
 * Fully independent of the pass alert bells (js/pass-alerts.js): own state,
 * own storage, own click handler, own CSS class.
 */
(function () {
  const C = window.AutoEngageCore;
  if (!C) return;

  const LS_MARKS = "satTrackerAutoEngagePasses"; // startup cache only; server is the source of truth
  const ICON_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9" r="1.7"/><path d="M12 11v10M8.5 21h7"/>' +
    '<path d="M8.4 12.6a5.1 5.1 0 0 1 0-7.2M15.6 5.4a5.1 5.1 0 0 1 0 7.2M5.6 15.4a9 9 0 0 1 0-12.8M18.4 2.6a9 9 0 0 1 0 12.8"/></svg>';

  let marks = [];
  try { marks = C.normalizeMarks(JSON.parse(localStorage.getItem(LS_MARKS) || "null")); } catch (_) {}
  let toggleOn = false;

  function sock() {
    return typeof ws !== "undefined" && ws && ws.readyState === 1 ? ws : null;
  }

  function paintOne(el) {
    if (!el.firstElementChild) el.innerHTML = ICON_SVG;
    const key = el.dataset.sat;
    const aos = Number(el.dataset.aos);
    const on = !!key && C.isMarked(marks, key, aos);
    el.classList.toggle("on", on);
    el.setAttribute("aria-pressed", on ? "true" : "false");
    const when = el.dataset.aosLabel ? " (AOS " + el.dataset.aosLabel + ")" : "";
    const title = on
      ? "Auto engage on for this pass" + when + ": Radio + Antenna on 5 min before AOS, off after LOS \u2014 click to clear"
      : "Auto engage Radio + Antenna for this pass" + when + (toggleOn ? " (Auto Engage button is on: the selected sat's passes are already covered)" : "");
    if (el.title !== title) el.title = title;
    if (el.getAttribute("aria-label") !== title) el.setAttribute("aria-label", title);
  }

  function paint(root) {
    (root || document).querySelectorAll(".pass-engage").forEach((el) => {
      if (el.dataset && el.dataset.engage === "pass") paintOne(el);
    });
  }

  function commit(next) {
    marks = C.pruneMarks(next, Date.now()).marks;
    try { localStorage.setItem(LS_MARKS, JSON.stringify(marks)); } catch (_) {}
    const s = sock();
    if (s) {
      const m = { type: "auto-engage-passes-set", passes: marks };
      if (guard) m.seq = guard.begin(["autoEngagePasses"]);
      s.send(JSON.stringify(m));
    }
    paint();
  }

  function onIcon(el) {
    const key = el.dataset.sat;
    const aosMs = Number(el.dataset.aos);
    if (!key || !Number.isFinite(aosMs)) return;
    const losMs = el.dataset.los ? Number(el.dataset.los) : null;
    commit(C.toggleMark(marks, { key, aosMs, losMs }));
  }

  // While a change is un-acked, "profiles" echoes are remembered and re-applied on ack.
  let lastProfileMsg = null;
  const guard = typeof createSetGuard === "function" ? createSetGuard({ onRelease: () => { if (lastProfileMsg) applyProfile(lastProfileMsg); } }) : null;
  function applyProfile(msg) {
    if (!msg || msg.type !== "profiles") return;
    lastProfileMsg = msg;
    toggleOn = msg.autoEngage === true;
    if (guard && guard.held("autoEngagePasses")) return;
    marks = C.normalizeMarks(msg.autoEngagePasses);
    try { localStorage.setItem(LS_MARKS, JSON.stringify(marks)); } catch (_) {}
    setTimeout(paint, 0);
  }

  function findIcon(t) {
    for (let n = t; n; n = n.parent || n.parentElement || null) {
      if (n.classList && n.classList.contains("pass-engage") && n.dataset && n.dataset.engage === "pass") return n;
    }
    return null;
  }

  function onCaptureClick(e) {
    const el = e.target ? findIcon(e.target) : null;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation(); // don't select the row / close the banner
    onIcon(el);
  }

  function onCaptureKey(e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    const el = e.target ? findIcon(e.target) : null;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    onIcon(el);
  }

  function boot() {
    document.addEventListener("click", onCaptureClick, true);
    document.addEventListener("keydown", onCaptureKey, true);
    paint();
  }

  window.AutoEngage = {
    paint,
    ICON_SVG,
    // called from js/tracker.js; never let a bug here break its handler
    onProfiles: (msg) => { try { applyProfile(msg); } catch (e) { console.warn("auto engage", e); } },
    onAck: (seq) => { if (guard) guard.ack(seq); },
    getMarks: () => C.normalizeMarks(marks),
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
