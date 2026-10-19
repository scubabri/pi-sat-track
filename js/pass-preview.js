/**
 * Pass preview: pick a time T on the elevation chart (drag the red now line,
 * drag the amber preview line, or click the chart) and the map / globe show
 * the selected sat (and shown favorites) where they will be at T, with
 * footprints, plus a hollow red "now" ghost at the live position. Positions
 * come from the server ("preview-get" {t} -> "preview"). Radio / rotor /
 * Doppler keep running on real time. Esc, double-click the chart, or the
 * badge's "Back to now" ends it.
 *
 * API: window.passPreview.{get, set(t, {center}), clear, posOf(key), active}
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

  /** Spin the globe to the selected sat's preview position (no-op on the map). */
  function maybeCenter() {
    if (!centerPending || !data) return;
    const cur = (data.sats || []).find((s) => s.key === data.current);
    centerPending = false;
    if (cur && cur.position && typeof window.globeCenterOn === "function")
      window.globeCenterOn(cur.position.lat, cur.position.lon, { preview: true }); // no-op while the globe follows a sat
  }

  function set(t, opts) {
    if (t == null || !Number.isFinite(t)) return;
    const starting = T == null;
    T = t;
    if ((starting && !(opts && opts.drag)) || (opts && opts.center)) centerPending = true;
    request();
    fire();
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

  function renderBadge() {
    const host = document.getElementById("map");
    if (!host) return;
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "pass-preview-badge";
      ["pointerdown", "mousedown", "click", "dblclick", "wheel", "touchstart"].forEach((ev) => badge.addEventListener(ev, (e) => e.stopPropagation()));
      badge.addEventListener("click", (e) => {
        if (e.target && e.target.classList.contains("ppb-back")) { e.preventDefault(); clear(); }
      });
      host.appendChild(badge);
    }
    if (T == null) { badge.hidden = true; return; }
    badge.hidden = false;
    const cur = data && data.sats ? data.sats.find((s) => s.key === data.current) : null;
    const name = cur ? esc(cur.display || cur.key) : "";
    const look = cur && cur.look && cur.look.el >= 0
      ? '<span class="ppb-sat">' + name + " " + Math.round(cur.look.el) + "\u00B0 \u00B7 az " + Math.round((cur.look.az + 360) % 360) + "\u00B0</span>"
      : cur ? '<span class="ppb-sat ppb-dim">' + name + " below horizon</span>" : "";
    badge.innerHTML =
      '<span class="ppb-dot"></span><b>Preview ' + fmt(T) + '</b><span class="ppb-rel">' + rel(T) + "</span>" + look +
      '<a href="#" class="ppb-back" title="Back to live (Esc)">Back to now</a>';
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

  window.passPreview = { get: () => T, set, clear, settle, posOf, active: () => T != null && !!data };
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
