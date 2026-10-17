/**
 * Map overlay of stations heard by WSJT-X (server "wsjtx-decodes" message).
 * Small circle marker at the grid-square centre + compact permanent label.
 * Opacity fades with age; stations drop out when the server expires them.
 * Toggle (map control, top-right) persisted in localStorage.
 * The 3D globe (js/globe-view.js) draws the same list via window.decodeOverlay
 * and redraws on the "decode-overlay-change" document event.
 */
(function () {
  const LS_KEY = "decodeOverlayOn";
  let on = localStorage.getItem(LS_KEY) !== "0";
  let layer = null;
  let stations = [];
  let expireMs = 15 * 60 * 1000;
  let skewMs = 0; // server now - client now
  const markers = new Map();
  let btn = null;

  function getMap() {
    return typeof map !== "undefined" && map ? map : null;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }
  function ensureLayer() {
    const m = getMap();
    if (!m || typeof L === "undefined") return null;
    if (!layer) {
      layer = L.layerGroup();
      addControl(m);
    }
    if (on && !m.hasLayer(layer)) layer.addTo(m);
    if (!on && m.hasLayer(layer)) m.removeLayer(layer);
    return layer;
  }
  function addControl(m) {
    const Ctl = L.Control.extend({
      options: { position: "topright" },
      onAdd: function () {
        const c = L.DomUtil.create("div", "leaflet-bar leaflet-control decode-toggle-control");
        btn = L.DomUtil.create("a", "decode-toggle-btn", c);
        btn.href = "#";
        btn.setAttribute("role", "button");
        btn.textContent = "WSJT Heard";
        L.DomEvent.disableClickPropagation(c);
        L.DomEvent.on(btn, "click", (e) => {
          L.DomEvent.preventDefault(e);
          on = !on;
          localStorage.setItem(LS_KEY, on ? "1" : "0");
          render();
          notify();
        });
        const clr = L.DomUtil.create("a", "decode-clear-btn", c);
        clr.href = "#";
        clr.setAttribute("role", "button");
        clr.title = "Clear WSJT-X spots";
        clr.setAttribute("aria-label", "Clear WSJT-X spots");
        clr.textContent = "Clear Spots";
        L.DomEvent.on(clr, "click", (e) => {
          L.DomEvent.preventDefault(e);
          if (layer) layer.clearLayers();
          markers.clear();
          stations = [];
          notify();
          try {
            if (typeof ws !== "undefined" && ws && ws.readyState === 1)
              ws.send(JSON.stringify({ type: "clear-decodes" }));
          } catch (_) {}
        });
        syncBtn();
        return c;
      },
    });
    new Ctl().addTo(m);
  }
  function syncBtn() {
    if (!btn) return;
    btn.classList.toggle("active", on);
    btn.title = (on ? "Hide" : "Show") + " WSJT-X decoded stations";
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  function ageOpacity(ageMs) {
    const f = Math.min(1, Math.max(0, ageMs / expireMs));
    return 1 - 0.75 * f; // 1.0 fresh -> 0.25 just before expiry
  }
  function tipText(s, age) {
    return (
      s.call + " " + s.grid + (s.mode ? " " + s.mode : "") +
      (Number.isFinite(s.snr) ? " " + (s.snr > 0 ? "+" : "") + s.snr + " dB" : "") +
      " · " + Math.max(0, Math.round(age / 60000)) + " min ago"
    );
  }
  /** Stations to draw now (empty when toggled off): {call, grid, lat, lon, opacity, tip}. */
  function visibleItems(nowMs) {
    if (!on) return [];
    const now = (nowMs != null ? nowMs : Date.now()) + skewMs;
    const out = [];
    for (const s of stations) {
      if (!s || !Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
      const age = now - s.lastHeard;
      if (age > expireMs) continue;
      out.push({ call: s.call, grid: s.grid, lat: s.lat, lon: s.lon, opacity: ageOpacity(age), tip: tipText(s, age) });
    }
    return out;
  }
  function notify() {
    try { document.dispatchEvent(new Event("decode-overlay-change")); } catch (_) {}
  }
  function render() {
    const lg = ensureLayer();
    syncBtn();
    if (!lg) return;
    const now = Date.now() + skewMs;
    const seen = new Set();
    for (const s of stations) {
      const age = now - s.lastHeard;
      if (age > expireMs) continue;
      seen.add(s.call);
      const op = ageOpacity(age);
      let mk = markers.get(s.call);
      const html =
        '<span class="dc-call">' + esc(s.call) + '</span><span class="dc-grid">' + esc(s.grid) + "</span>";
      const tip = tipText(s, age);
      if (!mk) {
        mk = L.circleMarker([s.lat, s.lon], {
          radius: 3,
          weight: 1,
          color: "#0b1e2d",
          fillColor: "#ffd34d",
          fillOpacity: op,
          opacity: op,
          className: "decode-dot",
        });
        mk.bindTooltip(html, {
          permanent: true,
          direction: "right",
          offset: [4, 0],
          className: "decode-label",
          opacity: op,
        });
        mk.addTo(lg);
        markers.set(s.call, mk);
      } else {
        mk.setLatLng([s.lat, s.lon]);
        mk.setStyle({ fillOpacity: op, opacity: op });
        mk.setTooltipContent(html);
        const t = mk.getTooltip();
        if (t) t.setOpacity(op);
      }
      const el = mk.getElement && mk.getElement();
      if (el) el.setAttribute("aria-label", tip);
      mk.options.title = tip;
    }
    for (const [call, mk] of markers) {
      if (!seen.has(call)) {
        lg.removeLayer(mk);
        markers.delete(call);
      }
    }
  }
  function apply(msg) {
    stations = Array.isArray(msg.stations) ? msg.stations : [];
    if (msg.expireMs > 0) expireMs = msg.expireMs;
    if (msg.now > 0) skewMs = msg.now - Date.now();
    render();
    notify();
  }
  window.applyDecodeOverlay = apply;
  window.decodeOverlay = {
    isOn: () => on,
    items: visibleItems,
    ageOpacity: (ageMs) => ageOpacity(ageMs),
  };

  function patchWs() {
    if (typeof ws === "undefined" || !ws || ws.__decodeOverlayPatched) return;
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "wsjtx-decodes") apply(msg);
      } catch (_) {}
    });
    ws.__decodeOverlayPatched = true;
  }
  function init() {
    setInterval(patchWs, 500);
    setInterval(() => { render(); notify(); }, 20000); // refresh fading / expiry between updates
    const t = setInterval(() => {
      if (ensureLayer()) clearInterval(t);
    }, 300);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
