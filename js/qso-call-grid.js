/**
 * Logging panel: as the callsign is typed (600 ms debounce), look up its grid
 * (server: recent WSJT-X decode first, else g7vrd cached lookup), show
 * "DM41 · 1234 km" under the box and plot the station + great-circle line
 * from home on the map (styled like the WSJT-X heard markers).
 */
(function () {
  const DEBOUNCE_MS = 600;
  const CALL_RE = /^(?=.*\d)[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}(\/[A-Z0-9]{1,4})?$|^[A-Z0-9]{1,4}\/[A-Z0-9]{3,8}$/;
  let timer = null;
  let seq = 0;
  let pendingReq = null;
  let layer = null;
  window.qsoDxGrid = null;

  function el(id) {
    return document.getElementById(id);
  }
  function getMap() {
    return typeof map !== "undefined" && map ? map : null;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }
  function setText(text, none) {
    const g = el("qso-log-grid");
    if (!g) return;
    g.textContent = text || "";
    g.className = "qso-log-grid" + (none ? " none" : "");
  }
  function clearMap() {
    if (layer) layer.clearLayers();
  }
  function notify() { try { document.dispatchEvent(new Event("qso-dx-change")); } catch (_) {} }
  function clearAll() {
    window.qsoDxGrid = null;
    pendingReq = null;
    clearMap();
    setText("");
    notify();
  }
  function home() {
    if (typeof observerMarker !== "undefined" && observerMarker && observerMarker.getLatLng) {
      const ll = observerMarker.getLatLng();
      if (ll) return { lat: ll.lat, lon: ll.lng };
    }
    try {
      const c = typeof loadConfig === "function" ? loadConfig() : null;
      if (c && c.grid && typeof maidenheadToLatLon === "function") return maidenheadToLatLon(c.grid);
    } catch (_) {}
    return null;
  }
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;
  function distKm(a, b) {
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  /** Great-circle points a→b (lon unwrapped so splitAtDateLine can cut it). */
  function gcPoints(a, b, n) {
    const p1 = [rad(a.lat), rad(a.lon)], p2 = [rad(b.lat), rad(b.lon)];
    const d = 2 * Math.asin(Math.sqrt(Math.sin((p2[0] - p1[0]) / 2) ** 2 +
      Math.cos(p1[0]) * Math.cos(p2[0]) * Math.sin((p2[1] - p1[1]) / 2) ** 2));
    if (!(d > 1e-6)) return [[a.lat, a.lon], [b.lat, b.lon]];
    const out = [];
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
      const x = A * Math.cos(p1[0]) * Math.cos(p1[1]) + B * Math.cos(p2[0]) * Math.cos(p2[1]);
      const y = A * Math.cos(p1[0]) * Math.sin(p1[1]) + B * Math.cos(p2[0]) * Math.sin(p2[1]);
      const z = A * Math.sin(p1[0]) + B * Math.sin(p2[0]);
      out.push([deg(Math.atan2(z, Math.sqrt(x * x + y * y))), deg(Math.atan2(y, x))]);
    }
    return out;
  }
  window.qsoGcPoints = gcPoints;
  function plot(call, grid) {
    const m = getMap();
    if (!m || typeof L === "undefined" || typeof maidenheadToLatLon !== "function") return null;
    const pos = maidenheadToLatLon(grid);
    if (!pos) return null;
    if (!layer) layer = L.layerGroup().addTo(m);
    else if (!m.hasLayer(layer)) layer.addTo(m);
    layer.clearLayers();
    const h = home();
    let km = null;
    if (h) {
      km = distKm(h, pos);
      const pts = gcPoints(h, pos, 64);
      const segs = typeof splitAtDateLine === "function" ? splitAtDateLine(pts) : [pts];
      for (const s of segs)
        L.polyline(s, { color: "#ffd34d", weight: 1.25, opacity: 0.8, dashArray: "4 6", interactive: false }).addTo(layer);
    }
    const mk = L.circleMarker([pos.lat, pos.lon], {
      radius: 4, weight: 1, color: "#0b1e2d", fillColor: "#ffd34d", fillOpacity: 1, opacity: 1,
      className: "decode-dot",
    });
    mk.bindTooltip('<span class="dc-call">' + esc(call) + '</span><span class="dc-grid">' + esc(grid) + "</span>", {
      permanent: true, direction: "right", offset: [4, 0], className: "decode-label",
    });
    mk.addTo(layer);
    return km;
  }
  function onReply(msg) {
    if (!msg || msg.type !== "call-grid" || msg.reqId !== pendingReq) return;
    pendingReq = null;
    const input = el("qso-log-call");
    const cur = input ? input.value.trim().toUpperCase() : "";
    if (cur !== msg.call) return; // stale
    if (!msg.ok || !msg.grid) {
      window.qsoDxGrid = null;
      clearMap();
      setText("no lookup", true);
      notify();
      return;
    }
    window.qsoDxGrid = { call: msg.call, grid: msg.grid, source: msg.source };
    const km = plot(msg.call, msg.grid);
    notify();
    shown = { msg, km };
    showDist();
  }
  let shown = null; // last successful lookup: redrawn when the display units change
  function showDist() {
    if (!shown || !window.qsoDxGrid || window.qsoDxGrid.call !== shown.msg.call) return;
    const { msg, km } = shown;
    setText(msg.grid + (km != null ? " \u00b7 " + (typeof Units !== "undefined" ? Units.dist(km) : Math.round(km) + " km") : "") + (msg.source === "wsjtx" ? " (WSJT-X)" : ""));
  }
  document.addEventListener("units-change", showDist);
  function lookup(call) {
    if (typeof ws === "undefined" || !ws || ws.readyState !== WebSocket.OPEN) {
      setText("no lookup", true);
      return;
    }
    pendingReq = "g" + Date.now() + "-" + ++seq;
    ws.send(JSON.stringify({ type: "call-grid-lookup", call, reqId: pendingReq }));
  }
  function onInput() {
    const input = el("qso-log-call");
    const call = input ? input.value.trim().toUpperCase().replace(/\s+/g, "") : "";
    if (timer) clearTimeout(timer);
    if (!call) {
      clearAll();
      return;
    }
    if (window.qsoDxGrid && window.qsoDxGrid.call !== call) {
      window.qsoDxGrid = null;
      notify();
      clearMap();
      setText("");
    }
    if (call.length < 3 || !CALL_RE.test(call)) return;
    timer = setTimeout(() => lookup(call), DEBOUNCE_MS);
  }
  function patchWs() {
    if (typeof ws === "undefined" || !ws || ws.__callGridPatched) return;
    const prev = ws.onmessage;
    ws.onmessage = function (ev) {
      if (typeof prev === "function") prev.call(this, ev);
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "call-grid") onReply(msg);
      } catch (_) {}
    };
    ws.__callGridPatched = true;
  }
  function init() {
    const input = el("qso-log-call");
    if (input) input.addEventListener("input", onInput);
    // Field cleared after a successful log (value set programmatically)
    setInterval(() => {
      const i = el("qso-log-call");
      if (i && !i.value.trim() && (window.qsoDxGrid || (layer && layer.getLayers().length))) clearAll();
    }, 1000);
    setInterval(patchWs, 500);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
