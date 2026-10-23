/**
 * Pass alerts (bells). Logic lives in js/pass-alerts-core.js; this file does
 * the browser side:
 *  - paints every `.sat-alert` bell (data-alert="sat" | "pass" | "all-favorites")
 *    and handles their clicks (capture phase, so rows/menus don't also react);
 *  - js/tracker.js hands it "profiles" (alerts) and "state" (alertPasses +
 *    selected-sat passes) messages;
 *  - saves changes on the active station profile ("alerts-set" → server →
 *    "profiles" broadcast to every client);
 *  - fires AOS−5:00 and AOS alerts: ding ×3 + toast, plus an opt-in desktop
 *    Notification. Fired events are remembered per tab (sessionStorage).
 *  - unlocks audio on the first click/key (browsers block sound before a gesture).
 */
(function () {
  const C = window.PassAlertsCore;
  if (!C) return;

  const LS_ALERTS = "satTrackerAlerts"; // startup cache only; server is the source of truth
  const LS_DESKTOP = "satTrackerAlertDesktop";
  const SS_FIRED = "satTrackerAlertsFired";
  const DING_GAP_S = 0.6;
  const TOAST_MS = 15000;

  let alerts = C.emptyAlerts();
  try { alerts = C.normalizeAlerts(JSON.parse(localStorage.getItem(LS_ALERTS) || "null")); } catch (_) {}
  let candidates = []; // [{ key, display, aos, los, maxEl }]
  let fired = [];
  try { fired = JSON.parse(sessionStorage.getItem(SS_FIRED) || "[]") || []; } catch (_) { fired = []; }

  const BELL_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a6 6 0 0 0-6 6v3.5c0 .7-.3 1.4-.8 1.9L4 16h16l-1.2-1.6c-.5-.5-.8-1.2-.8-1.9V9a6 6 0 0 0-6-6z"/><path d="M9.55 19a2.5 2.5 0 0 0 4.9 0z"/></svg>';

  function favs() {
    return typeof loadFavorites === "function" ? loadFavorites() : [];
  }
  function selKey() {
    return typeof currentSatKey !== "undefined" ? currentSatKey : null;
  }
  function sock() {
    return typeof ws !== "undefined" && ws && ws.readyState === 1 ? ws : null;
  }

  /* ---------------- audio ---------------- */
  let actx = null;
  let dingBuf = null;
  let dingLoading = null;
  let unlocked = false;

  function dingUrls() {
    const a = document.createElement("audio");
    const aac = a.canPlayType && a.canPlayType('audio/mp4; codecs="mp4a.40.2"');
    return aac ? ["sounds/ding.m4a", "sounds/ding.mp3"] : ["sounds/ding.mp3", "sounds/ding.m4a"];
  }

  function loadDing() {
    if (dingBuf || dingLoading || !actx) return dingLoading;
    const urls = dingUrls();
    dingLoading = (async () => {
      for (const u of urls) {
        try {
          const r = await fetch(u);
          if (!r.ok) continue;
          const ab = await r.arrayBuffer();
          dingBuf = await new Promise((res, rej) => actx.decodeAudioData(ab, res, rej));
          return dingBuf;
        } catch (_) {}
      }
      return null;
    })().finally(() => { dingLoading = null; });
    return dingLoading;
  }

  function unlockAudio() {
    if (unlocked && actx && actx.state === "running") return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!actx) actx = new AC();
      if (actx.state !== "running") actx.resume().catch(() => {});
      unlocked = true;
      loadDing();
    } catch (_) {}
  }

  /** Bell strike(s): count strikes DING_GAP_S apart. */
  async function playDing(count) {
    count = count || 1;
    try {
      if (actx) {
        if (actx.state !== "running") await actx.resume().catch(() => {});
        if (!dingBuf) await loadDing();
        if (dingBuf && actx.state === "running") {
          const t0 = actx.currentTime + 0.03;
          for (let i = 0; i < count; i++) {
            const src = actx.createBufferSource();
            src.buffer = dingBuf;
            src.connect(actx.destination);
            src.start(t0 + i * DING_GAP_S);
          }
          return true;
        }
      }
    } catch (_) {}
    // Fallback: plain <audio> (works once the page had any user gesture)
    const url = dingUrls()[0];
    for (let i = 0; i < count; i++) {
      setTimeout(() => {
        try { new Audio(url).play().catch(() => {}); } catch (_) {}
      }, i * DING_GAP_S * 1000);
    }
    return false;
  }

  /* ---------------- painting ---------------- */
  function setLook(el, look, title) {
    if (!el.firstElementChild) el.innerHTML = BELL_SVG;
    el.classList.toggle("on", look === "on");
    el.classList.toggle("inherited", look === "inherited");
    el.classList.toggle("partial", look === "partial");
    el.setAttribute("aria-pressed", look === "off" ? "false" : look === "partial" ? "mixed" : "true");
    if (title && el.title !== title) el.title = title;
    if (el.getAttribute("aria-label") !== title) el.setAttribute("aria-label", title);
  }

  function paintOne(el) {
    const kind = el.dataset.alert;
    const f = favs();
    if (kind === "all-favorites") {
      const st = C.allFavoritesState(alerts, f);
      const n = f.filter((k) => C.satAlertOn(alerts, f, k)).length;
      setLook(el, st,
        st === "on" ? "Alerts on for all favorites \u2014 click to turn all off"
          : st === "partial" ? n + " of " + f.length + " favorites have alerts \u2014 click to turn on all"
            : "Alert for all favorites (AOS\u22125 min and AOS)");
      return;
    }
    const key = el.dataset.sat;
    if (!key) { setLook(el, "off", "Pass alert"); return; }
    if (kind === "sat") {
      const src = C.satAlertSource(alerts, f, key);
      // "favorites" = covered by the all-favorites bell → dim (inherited) look
      setLook(el, src === "sat" ? "on" : src ? "inherited" : "off",
        src ? "Alerts on for every pass" + (src === "favorites" ? " (all favorites)" : "") + " \u2014 click to turn off"
          : "Alert for every pass (AOS\u22125 min and AOS)");
      return;
    }
    if (kind === "pass") {
      const st = C.passAlertState(alerts, f, key, Number(el.dataset.aos));
      setLook(el, st.look,
        st.look === "inherited" ? "Alert on (every pass of this sat) \u2014 click to skip this pass"
          : st.excepted ? "Skipped (sat alerts on) \u2014 click to alert for this pass"
            : st.look === "on" ? "Alert on for this pass \u2014 click to clear"
              : "Alert for this pass (AOS\u22125 min and AOS)");
    }
  }

  function syncTopbar() {
    const key = selKey();
    const star = document.getElementById("sat-fav-top");
    const bell = document.getElementById("sat-alert-top");
    if (star) {
      const on = !!key && favs().includes(key);
      if (key) star.dataset.sat = key;
      star.hidden = !key;
      star.classList.toggle("on", on);
      const txt = on ? "\u2605" : "\u2606";
      if (star.textContent !== txt) star.textContent = txt;
      star.title = on ? "Remove favorite" : "Add favorite";
    }
    if (bell) {
      if (key) bell.dataset.sat = key;
      bell.hidden = !key;
    }
  }

  function paint(root) {
    if (!root || root === document) syncTopbar();
    (root || document).querySelectorAll(".sat-alert").forEach(paintOne);
  }

  /* ---------------- changes ---------------- */
  function commit(next, turnedOn) {
    alerts = C.pruneAlerts(next, Date.now()).alerts;
    try { localStorage.setItem(LS_ALERTS, JSON.stringify(alerts)); } catch (_) {}
    const s = sock();
    if (s) {
      const m = { type: "alerts-set", alerts };
      if (guard) m.seq = guard.begin(["alerts"]); // latest click wins over stale echoes
      s.send(JSON.stringify(m));
    }
    paint();
  }

  function onBell(el) {
    unlockAudio();
    const kind = el.dataset.alert;
    const f = favs();
    if (kind === "all-favorites") {
      const before = C.allFavoritesState(alerts, f);
      commit(C.toggleAllFavorites(alerts, f), before !== "on");
    } else if (kind === "sat" && el.dataset.sat) {
      const before = C.satAlertOn(alerts, f, el.dataset.sat);
      commit(C.toggleSat(alerts, f, el.dataset.sat), !before);
    } else if (kind === "pass" && el.dataset.sat) {
      const aosMs = Number(el.dataset.aos);
      const losMs = el.dataset.los ? Number(el.dataset.los) : null;
      const before = C.isPassArmed(alerts, f, el.dataset.sat, aosMs);
      commit(C.togglePass(alerts, f, { key: el.dataset.sat, aosMs, losMs }), !before);
    }
  }

  // js/set-guard.js: while a bell change is un-acked, "profiles" echoes are
  // remembered (lastProfileMsg) and re-applied on ack instead of reverting it.
  let lastProfileMsg = null;
  const guard = typeof createSetGuard === "function" ? createSetGuard({ onRelease: () => { if (lastProfileMsg) applyProfile(lastProfileMsg); } }) : null;
  function applyProfile(msg) {
    if (!msg || !msg.alerts) return;
    lastProfileMsg = msg;
    if (guard && guard.held("alerts")) return;
    alerts = C.normalizeAlerts(msg.alerts);
    try { localStorage.setItem(LS_ALERTS, JSON.stringify(alerts)); } catch (_) {}
    // favorites may have changed in the same payload; sat-menu applies them first
    setTimeout(paint, 0);
  }

  function applyState(msg) {
    const list = [];
    if (Array.isArray(msg.alertPasses)) msg.alertPasses.forEach((p) => list.push(p));
    if (msg.sat && Array.isArray(msg.passes)) {
      msg.passes.forEach((p) => list.push({ key: msg.sat, display: msg.display, aos: p.aos, los: p.los, maxEl: p.maxEl }));
    }
    candidates = list;
    checkDue();
  }

  /* ---------------- firing ---------------- */
  function fmtClock(ms) {
    if (typeof formatClockShort === "function") return formatClockShort(ms);
    return new Date(ms).toISOString().substr(11, 5) + " UTC";
  }

  function toastHost() {
    let h = document.getElementById("pass-alert-toasts");
    if (!h) {
      h = document.createElement("div");
      h.id = "pass-alert-toasts";
      h.setAttribute("role", "status");
      h.setAttribute("aria-live", "polite");
      document.body.appendChild(h);
    }
    return h;
  }

  function showToast(ev) {
    const text = C.alertText(ev, fmtClock);
    const host = toastHost();
    const old = host.querySelector('[data-id="' + CSS.escape(ev.key + "|" + ev.aosMs) + '"]');
    if (old) old.remove(); // AOS replaces the AOS−5 toast of the same pass
    const t = document.createElement("div");
    t.className = "pass-alert-toast" + (ev.kind === "aos" ? " now" : "");
    t.dataset.id = ev.key + "|" + ev.aosMs;
    t.title = "Click to dismiss";
    t.innerHTML = '<span class="pat-bell">' + BELL_SVG + '</span><span class="pat-text"></span>';
    t.querySelector(".pat-text").textContent = text;
    t.addEventListener("click", () => t.remove());
    host.appendChild(t);
    setTimeout(() => t.remove(), TOAST_MS);
    return text;
  }

  function desktopOn() {
    return localStorage.getItem(LS_DESKTOP) === "1";
  }

  function notify(ev, text) {
    if (!desktopOn() || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try {
      const n = new Notification(ev.kind === "aos" ? (ev.display || ev.key) + " AOS now" : (ev.display || ev.key) + " AOS in " + ev.minutes + " min", {
        body: text,
        tag: ev.id, // same tag in every tab of this browser → one OS notification
      });
      n.onclick = () => { window.focus(); n.close(); };
    } catch (_) {}
  }

  function fire(ev) {
    playDing(3);
    const text = showToast(ev);
    notify(ev, text);
    console.log("Pass alert:", text);
  }

  function checkDue(now) {
    now = now != null ? now : Date.now();
    const f = favs();
    const due = C.dueAlerts(candidates, alerts, f, now, fired);
    if (!due.length) return due;
    due.forEach((ev) => fired.push({ key: ev.key, kind: ev.kind, aosMs: ev.aosMs }));
    // keep only recent entries
    fired = fired.filter((x) => x.aosMs > now - 6 * 3600 * 1000);
    try { sessionStorage.setItem(SS_FIRED, JSON.stringify(fired)); } catch (_) {}
    due.forEach(fire);
    return due;
  }

  /* ---------------- desktop notification setting ---------------- */
  function initDesktopSetting() {
    const cb = document.getElementById("cfg-alert-desktop");
    const hint = document.getElementById("cfg-alert-desktop-hint");
    if (!cb) return;
    const baseHint = hint ? hint.textContent.trim() : "";
    const setHint = (extra) => { if (hint) hint.textContent = baseHint + (extra ? " " + extra : ""); };
    const supported = typeof Notification !== "undefined" && window.isSecureContext !== false;
    function refresh() {
      const perm = typeof Notification !== "undefined" ? Notification.permission : "unsupported";
      cb.checked = desktopOn() && perm === "granted";
      if (!supported) setHint("Not available here: browsers only allow notifications on https:// or http://localhost.");
      else if (perm === "denied") setHint("Notifications are blocked for this site in the browser's site settings.");
      else setHint("");
    }
    cb.addEventListener("change", async (e) => {
      e.stopPropagation(); // browser-local, applies now (not part of Save)
      unlockAudio();
      if (!cb.checked) {
        localStorage.setItem(LS_DESKTOP, "0");
        refresh();
        return;
      }
      if (!supported) { cb.checked = false; refresh(); return; }
      let perm = Notification.permission;
      if (perm === "default") {
        try { perm = await Notification.requestPermission(); } catch (_) { perm = Notification.permission; }
      }
      localStorage.setItem(LS_DESKTOP, perm === "granted" ? "1" : "0");
      refresh();
    });
    refresh();
  }

  /* ---------------- wiring ---------------- */
  function onCaptureClick(e) {
    unlockAudio();
    const bell = e.target && e.target.closest ? e.target.closest(".sat-alert[data-alert]") : null;
    if (bell) {
      e.preventDefault();
      e.stopPropagation(); // don't select the fav row / toggle the drawer / close the menu
      onBell(bell);
      return;
    }
    const star = e.target && e.target.closest ? e.target.closest("#sat-fav-top") : null;
    if (star) {
      e.preventDefault();
      e.stopPropagation();
      const key = selKey();
      if (key && typeof toggleFavorite === "function") toggleFavorite(key);
      setTimeout(paint, 0);
    }
  }

  function onCaptureKey(e) {
    unlockAudio();
    if (e.key !== "Enter" && e.key !== " ") return;
    const bell = e.target && e.target.closest ? e.target.closest('.sat-alert[role="button"]') : null;
    if (!bell) return;
    e.preventDefault();
    e.stopPropagation();
    onBell(bell);
  }

  function boot() {
    document.addEventListener("click", onCaptureClick, true);
    document.addEventListener("keydown", onCaptureKey, true);
    document.addEventListener("pointerdown", unlockAudio, true);
    initDesktopSetting();
    setInterval(() => {
      checkDue();
      paint(); // cheap; keeps bells right after favorites / sat changes
    }, 1000);
    paint();
  }

  window.PassAlerts = {
    paint,
    // called from js/tracker.js; never let an alert bug break its handler
    onProfiles: (msg) => { try { applyProfile(msg); } catch (e) { console.warn("pass alerts", e); } },
    onAck: (seq) => { if (guard) guard.ack(seq); },
    onState: (msg) => { try { applyState(msg); } catch (e) { console.warn("pass alerts", e); } },
    playDing,
    unlockAudio,
    checkDue,
    getAlerts: () => C.normalizeAlerts(alerts),
    getCandidates: () => candidates.slice(),
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
