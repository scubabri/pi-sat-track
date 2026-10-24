/**
 * Pass preview: pick a time T on the elevation chart (drag the red now line,
 * drag the amber preview line, or click the chart) and the map / globe show
 * the selected sat (and shown favorites) where they will be at T, with
 * footprints, plus a hollow red "now" ghost at the live position. Positions
 * come from the server ("preview-get" {t} -> "preview"). Radio / rotor /
 * Doppler keep running on real time. Esc, double-click the chart, or the
 * badge's "Back to now" ends it.
 *
 * The badge's bell sets the single-pass alert of the previewed pass
 * (previewPass(); the same alert as that pass's Next Passes bell).
 *
 * API: window.passPreview.{get, set(t, {center}), clear, posOf(key), previewPass, active}
 * Event: "pass-preview-change" on document (detail.t, null when cleared).
 */
(function () {
  let T = null;
  let data = null; // last "preview" reply for T
  let badge = null;
  let reqTimer = null;
  let centerPending = false;
  const sock = () => (typeof ws !== "undefined" && ws && ws.readyState === 1 ? ws : null);
  const fmt = (t) => (typeof formatClockShort === "function" ? formatClockShort(t) : new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function rel(t) {
    const m = Math.round((t - Date.now()) / 60000);
    if (Math.abs(m) < 1) return "now";
    const a = Math.abs(m);
    const s = a >= 60 ? Math.floor(a / 60) + "h " + (a % 60) + "m" : a + " min";
    return m > 0 ? "in " + s : s + " ago";
  }

  function request() {
    clearTimeout(reqTimer);
    reqTimer = setTimeout(() => {
      const s = sock();
      if (s && T != null) s.send(JSON.stringify({ type: "preview-get", t: Math.round(T) }));
    }, 40); // coalesce drag moves
  }

  function fire() {
    renderBadge();
    document.dispatchEvent(new CustomEvent("pass-preview-change", { detail: { t: T } }));
  }

  /** Selected sat's datum in the reply: the client's selection (a chart click may have just changed it). */
  function curOf(d) {
    if (!d || !d.sats) return null;
    const k = typeof currentSatKey !== "undefined" && currentSatKey ? currentSatKey : d.current;
    return d.sats.find((s) => s.key === k) || null;
  }
  /** Spin the globe to the selected sat's preview position (no-op on the map). */
  function maybeCenter() {
    if (!centerPending || !data) return;
    const cur = curOf(data);
    if (!cur) return; // reply predates the new sat: wait for the re-request
    centerPending = false;
    if (cur.position && typeof window.globeCenterOn === "function")
      window.globeCenterOn(cur.position.lat, cur.position.lon, { preview: true, key: cur.key }); // following that sat: followFrame centers it
  }

  function set(t, opts) {
    if (t == null || !Number.isFinite(t)) return;
    const starting = T == null;
    T = t;
    if ((starting && !(opts && opts.drag)) || (opts && opts.center)) centerPending = true;
    request();
    fire();
  }
  // This browser's own chart-click selection: its server echo keeps the preview.
  let ownPick = null; // { key, at }
  function markOwnPick(key) { ownPick = key ? { key, at: Date.now() } : null; }
  /**
   * The server's selected sat changed (state message): a selection from another
   * client, Auto Select, the schedule ... ends the preview, except the echo of
   * this browser's own chart click (within 15 s).
   */
  function onServerSat(key) {
    const own = ownPick && ownPick.key === key && Date.now() - ownPick.at < 15000;
    ownPick = null;
    if (!own) clear();
  }
  function clear() {
    if (T == null) return;
    T = null;
    data = null;
    centerPending = false;
    fire();
  }
  /** Drag ended: rotate the globe to where the sat ends up. */
  function settle() {
    if (T == null) return;
    centerPending = true;
    if (data && Math.abs(data.t - T) <= 1000) maybeCenter();
  }

  /** Preview datum {key, display, position, look} for a sat key, or null when not previewing. */
  function posOf(key) {
    if (T == null || !data || Math.abs(data.t - T) > 1000) return null;
    return (data.sats || []).find((x) => x.key === key) || null;
  }

  /**
   * Pass behind the banner's alert bell: the selected sat's Next Passes row
   * (js/pass-panel.js lastPassList, same frozen AOS as that row's bell) that
   * contains T, else the next one after T (js/pass-alerts-core.js
   * passForPreview). null when the list is for another sat / has no such pass.
   */
  function previewPass() {
    const C = window.PassAlertsCore;
    const k = typeof currentSatKey !== "undefined" ? currentSatKey : null;
    if (!C || !C.passForPreview || T == null || !k) return null;
    if (typeof lastPassListSat === "undefined" || lastPassListSat !== k || typeof lastPassList === "undefined") return null;
    const p = C.passForPreview(lastPassList, T, Date.now());
    return p ? { key: k, aosMs: p.aosMs, losMs: p.losMs } : null;
  }

  // Badge parts are built once and updated in place, so a click on the bell
  // is never lost to the 1 s refresh replacing it mid-click.
  let infoEl = null;
  let bellEl = null;
  let infoHtml = "";
  let bellSig = "";
  function buildBadge(host) {
    badge = document.createElement("div");
    badge.className = "pass-preview-badge";
    ["pointerdown", "mousedown", "click", "dblclick", "wheel", "touchstart"].forEach((ev) => badge.addEventListener(ev, (e) => e.stopPropagation()));
    badge.addEventListener("click", (e) => {
      if (e.target && e.target.classList && e.target.classList.contains("ppb-back")) { e.preventDefault(); clear(); }
    });
    infoEl = document.createElement("span");
    infoEl.className = "ppb-info";
    // Same single-pass bell as the Next Passes row: js/pass-alerts.js paints it
    // and handles its click (capture phase, before the badge's stopPropagation).
    bellEl = document.createElement("button");
    bellEl.type = "button";
    bellEl.className = "sat-alert ppb-alert";
    bellEl.setAttribute("data-alert", "pass");
    bellEl.hidden = true;
    const back = document.createElement("a");
    back.href = "#";
    back.className = "ppb-back";
    back.title = "Back to live (Esc)";
    back.textContent = "Back to now";
    badge.appendChild(infoEl);
    badge.appendChild(bellEl);
    badge.appendChild(back);
    host.appendChild(badge);
  }

  function renderBell() {
    if (!bellEl) return;
    const p = previewPass();
    const sig = p ? p.key + "|" + p.aosMs + "|" + (p.losMs != null ? p.losMs : "") : "";
    if (sig === bellSig) return;
    bellSig = sig;
    bellEl.hidden = !p;
    if (!p) return;
    bellEl.setAttribute("data-sat", p.key);
    bellEl.setAttribute("data-aos", String(p.aosMs));
    bellEl.setAttribute("data-los", p.losMs != null ? String(p.losMs) : "");
    bellEl.setAttribute("data-aos-label", fmt(p.aosMs));
    if (window.PassAlerts && window.PassAlerts.paint) window.PassAlerts.paint(badge);
  }

  function renderBadge() {
    const host = document.getElementById("map");
    if (!host) return;
    if (!badge) buildBadge(host);
    if (T == null) { badge.hidden = true; return; }
    badge.hidden = false;
    const cur = curOf(data);
    const name = cur ? esc(cur.display || cur.key) : "";
    const look = cur && cur.look && cur.look.el >= 0
      ? '<span class="ppb-sat">' + name + " " + Math.round(cur.look.el) + "\u00B0 \u00B7 az " + Math.round((cur.look.az + 360) % 360) + "\u00B0</span>"
      : cur ? '<span class="ppb-sat ppb-dim">' + name + " below horizon</span>" : "";
    const html = '<span class="ppb-dot"></span><b>Preview ' + fmt(T) + '</b><span class="ppb-rel">' + rel(T) + "</span>" + look;
    if (html !== infoHtml) { infoHtml = html; infoEl.innerHTML = html; }
    renderBell();
  }

  function patchWs() {
    if (typeof ws === "undefined" || !ws || ws.__previewPatched) return;
    ws.__previewPatched = true;
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string" || ev.data.indexOf('"type":"preview"') < 0) return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type !== "preview" || T == null || Math.abs(msg.t - T) > 1000) return;
        data = msg;
        fire();
        maybeCenter();
      } catch (_) {}
    });
    // Reconnected mid-preview: ask again on the new socket.
    if (T != null) { if (ws.readyState === 1) request(); else ws.addEventListener("open", request); }
  }

  window.passPreview = { get: () => T, set, clear, settle, posOf, markOwnPick, onServerSat, previewPass, active: () => T != null && !!data };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && T != null) clear(); });
  setInterval(patchWs, 500);
  let lastSat = null;
  setInterval(() => {
    // Selected sat changed under the preview: positions are for the new sat now.
    const k = typeof currentSatKey !== "undefined" ? currentSatKey : null;
    if (k !== lastSat) { lastSat = k; if (T != null) request(); }
    if (T != null) renderBadge(); // keep "in 1h 12m" fresh
  }, 1000);
})();
