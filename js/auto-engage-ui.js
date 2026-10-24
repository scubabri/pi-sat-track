/**
 * Auto Engage per-pass icons — browser side. Logic in js/auto-engage-core.js;
 * the server (lib/auto-engage.js) does the engaging, with or without a browser.
 *  - paints every `.pass-engage[data-engage="pass"]` icon: the top bar one
 *    (#sat-engage-top, right after the sat bell: the selected sat's current or
 *    next pass), Next Passes rows and the Preview banner; handles their clicks
 *    (capture phase, so rows and the banner don't also react);
 *  - states: grey = off; bright yellow = this pass marked; dim yellow =
 *    covered by the Auto Engage button; grey "skipped" = button on but this
 *    pass skipped; green (ring) = engaged now for this pass;
 *  - js/tracker.js hands it "profiles" (autoEngage, autoEngagePasses,
 *    autoEngageSkips), "state" (autoEngage.on / .engaged) and "set-ack";
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
  let skips = [];
  try {
    const c = JSON.parse(localStorage.getItem(LS_MARKS) || "null");
    if (Array.isArray(c)) marks = C.normalizeMarks(c);
    else if (c) { marks = C.normalizeMarks(c.marks); skips = C.normalizeMarks(c.skips); }
  } catch (_) {}
  let toggleOn = false;
  let engaged = null; // { sat, aosMs, ... } from state.autoEngage.engaged

  function sock() {
    return typeof ws !== "undefined" && ws && ws.readyState === 1 ? ws : null;
  }
  function selKey() {
    return typeof currentSatKey !== "undefined" ? currentSatKey : null;
  }
  function fmt(ms) {
    if (!Number.isFinite(ms)) return "?";
    if (typeof formatClockShort === "function") return formatClockShort(ms);
    return new Date(ms).toISOString().substr(11, 5) + " UTC";
  }
  function stateFor(key, aosMs) {
    return C.passEngageState({ marks, skips, toggleOn, selectedKey: selKey(), key, aosMs, engaged });
  }

  function titleFor(el, st) {
    const key = el.dataset.sat;
    const aos = Number(el.dataset.aos);
    const los = el.dataset.los ? Number(el.dataset.los) : NaN;
    const which = el.dataset.engageScope === "next" ? key + "'s next pass" : "this pass";
    switch (st.look) {
      case "active":
        return "Active: Auto Engage turned on Radio + Antenna for this pass" + (Number.isFinite(los) ? " (LOS " + fmt(los) + ")" : "") +
          " \u2014 off after LOS; click to disarm (leaves them on)";
      case "on":
        return "Armed: Radio + Antenna on at " + fmt(aos - C.PRE_MS) + " (AOS\u22125), off after LOS \u2014 click to disarm this pass";
      case "inherited":
        return "Armed by the Auto Engage button (every pass of " + key + "): on at " + fmt(aos - C.PRE_MS) + ", off after LOS \u2014 click to skip this pass";
      case "skipped":
        return "Skipped: the Auto Engage button won't engage this pass (AOS " + fmt(aos) + ") \u2014 click to arm it again";
      default:
        return "Auto engage Radio + Antenna for " + which + " (AOS " + fmt(aos) + ") \u2014 click to arm";
    }
  }

  function paintOne(el) {
    if (!el.firstElementChild) el.innerHTML = ICON_SVG;
    const key = el.dataset.sat;
    const st = key ? stateFor(key, Number(el.dataset.aos)) : { look: "off", armed: false };
    el.classList.toggle("on", st.look === "on");
    el.classList.toggle("inherited", st.look === "inherited");
    el.classList.toggle("skipped", st.look === "skipped");
    el.classList.toggle("active", st.look === "active");
    const pressed = st.look === "active" || st.armed ? "true" : "false";
    if (el.getAttribute("aria-pressed") !== pressed) el.setAttribute("aria-pressed", pressed);
    const title = key ? titleFor(el, st) : "Auto engage Radio + Antenna";
    if (el.title !== title) el.title = title;
    if (el.getAttribute("aria-label") !== title) el.setAttribute("aria-label", title);
  }

  /**
   * Top bar icon: selected sat's pass in progress, else its next pass (the
   * Next Passes list, js/pass-panel.js — same frozen AOS as row #1). Built
   * once in index.html; only data-* change, so clicks are never lost.
   */
  function topPass() {
    const k = selKey();
    if (!k || C.isMoonKey(k)) return null;
    if (typeof lastPassListSat === "undefined" || lastPassListSat !== k || typeof lastPassList === "undefined") return null;
    const now = Date.now();
    for (const p of lastPassList || []) {
      const aosMs = new Date(p.aos).getTime();
      const losMs = new Date(p.los).getTime();
      if (Number.isFinite(aosMs) && Number.isFinite(losMs) && losMs > now) return { key: k, aosMs, losMs };
    }
    return null;
  }
  function syncTopbar() {
    const el = document.getElementById("sat-engage-top");
    if (!el) return;
    const p = topPass();
    const hide = !p;
    if (el.hidden !== hide) el.hidden = hide;
    if (!p) return;
    const los = String(p.losMs);
    if (el.getAttribute("data-sat") !== p.key) el.setAttribute("data-sat", p.key);
    if (el.getAttribute("data-aos") !== String(p.aosMs)) el.setAttribute("data-aos", String(p.aosMs));
    if (el.getAttribute("data-los") !== los) el.setAttribute("data-los", los);
  }

  function paint(root) {
    if (!root || root === document) syncTopbar();
    (root || document).querySelectorAll(".pass-engage").forEach((el) => {
      if (el.dataset && el.dataset.engage === "pass" && !el.hidden) paintOne(el);
    });
  }

  function save() {
    try { localStorage.setItem(LS_MARKS, JSON.stringify({ marks, skips })); } catch (_) {}
  }

  function commit(next) {
    const now = Date.now();
    marks = C.pruneMarks(next.marks, now).marks;
    skips = C.pruneMarks(next.skips, now).marks;
    save();
    const s = sock();
    if (s) {
      const m = { type: "auto-engage-passes-set", passes: marks, skips };
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
    commit(C.clickPass({ marks, skips, toggleOn, selectedKey: selKey(), engaged }, { key, aosMs, losMs }));
  }

  // While a change is un-acked, "profiles" echoes are remembered and re-applied on ack.
  let lastProfileMsg = null;
  const guard = typeof createSetGuard === "function" ? createSetGuard({ onRelease: () => { if (lastProfileMsg) applyProfile(lastProfileMsg); } }) : null;
  function applyProfile(msg) {
    if (!msg || msg.type !== "profiles") return;
    lastProfileMsg = msg;
    toggleOn = msg.autoEngage === true;
    if (!(guard && guard.held("autoEngagePasses"))) {
      marks = C.normalizeMarks(msg.autoEngagePasses);
      skips = C.normalizeMarks(msg.autoEngageSkips);
      save();
    }
    setTimeout(paint, 0);
  }

  function applyState(msg) {
    const a = msg && msg.autoEngage;
    if (!a) return;
    toggleOn = a.on === true;
    engaged = a.engaged || null;
    paint();
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
    e.stopPropagation(); // don't select the row / close the banner / open the sat menu
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
    setInterval(() => paint(), 1000); // top bar follows sat / pass changes
    paint();
  }

  window.AutoEngage = {
    paint,
    ICON_SVG,
    // called from js/tracker.js; never let a bug here break its handler
    onProfiles: (msg) => { try { applyProfile(msg); } catch (e) { console.warn("auto engage", e); } },
    onState: (msg) => { try { applyState(msg); } catch (e) { console.warn("auto engage", e); } },
    onAck: (seq) => { if (guard) guard.ack(seq); },
    getMarks: () => C.normalizeMarks(marks),
    getSkips: () => C.normalizeMarks(skips),
    stateFor,
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
