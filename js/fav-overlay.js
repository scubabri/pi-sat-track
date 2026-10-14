/**
 * Favorites orbit overlay: ground track, footprint and labelled dot for every
 * favorite sat (selected sat excluded; map.js draws it bright on top).
 * Tracks: server "fav-tracks" (60 s). Positions: favorites[] in "state" (1 s).
 * Toggle sits above Sked Finder in the map control bar; state in localStorage.
 */
(function () {
  const LS_KEY = "favOverlayOn";
  let on = localStorage.getItem(LS_KEY) === "1";
  let layer = null;
  let btn = null;
  let tracks = [];
  let currentKey = null;
  const items = new Map(); // key -> { color, lines:[], dot, circle }
  const PALETTE = ["#b07cc6", "#5fa8a0", "#c9a26b", "#8f9fd6", "#c97b7b", "#7fae6e", "#b8b06a", "#6fa0c0", "#c08fb0", "#9a8a78"];
  const colorFor = (() => {
    const map = new Map();
    return (key) => {
      if (!map.has(key)) map.set(key, PALETTE[map.size % PALETTE.length]);
      return map.get(key);
    };
  })();

  function getMap() { return typeof map !== "undefined" && map ? map : null; }
  function sock() { return typeof ws !== "undefined" && ws && ws.readyState === 1 ? ws : null; }

  function ensureLayer() {
    const m = getMap();
    if (!m || typeof L === "undefined") return null;
    if (!layer) layer = L.layerGroup();
    if (on && !m.hasLayer(layer)) {
      layer.addTo(m);
      // keep the selected sat's track / marker above the overlay
      bringSelectedToFront();
    }
    if (!on && m.hasLayer(layer)) m.removeLayer(layer);
    return layer;
  }
  function bringSelectedToFront() {
    try {
      [].concat(typeof trailPolylines !== "undefined" ? trailPolylines : [], typeof forwardPolylines !== "undefined" ? forwardPolylines : [])
        .forEach((l) => l && l.bringToFront && l.bringToFront());
      if (typeof footprintCircle !== "undefined" && footprintCircle) footprintCircle.bringToFront();
      if (typeof satMarker !== "undefined" && satMarker) satMarker.bringToFront();
    } catch (_) {}
  }

  function drop(key) {
    const it = items.get(key);
    if (!it) return;
    if (layer) {
      it.lines.forEach((l) => layer.removeLayer(l));
      if (it.dot) layer.removeLayer(it.dot);
      if (it.circle) layer.removeLayer(it.circle);
      if (it.hit) layer.removeLayer(it.hit);
    }
    items.delete(key);
    if (hoverKey === key) hoverKey = null;
    if (pinKey === key) pinKey = null;
  }
  function item(key) {
    let it = items.get(key);
    if (!it) { it = { color: colorFor(key), lines: [], dot: null, circle: null }; items.set(key, it); }
    return it;
  }

  function drawTracks() {
    if (!ensureLayer()) return;
    const keep = new Set(tracks.map((t) => t.key));
    for (const k of [...items.keys()]) if (!keep.has(k) || k === currentKey) drop(k);
    // Redraw replaces the hovered polylines; Leaflet never fires mouseout for a
    // removed layer, so the old hover would stick. Drop it; the next mouseover
    // re-establishes it.
    clearHover();
    if (!on) return;
    for (const t of tracks) {
      if (t.key === currentKey) continue;
      const it = item(t.key);
      it.lines.forEach((l) => layer.removeLayer(l));
      it.lines = [];
      const split = typeof splitAtDateLine === "function" ? splitAtDateLine : (p) => [p];
      for (const seg of split(t.trail || [])) it.lines.push(hookHover(L.polyline(seg, { color: it.color, weight: 0.75, opacity: 0.6, smoothFactor: 0.5, lineJoin: "round", lineCap: "round", interactive: true, bubblingMouseEvents: false }), t.key, "trail").addTo(layer));
      for (const seg of split(t.forward || [])) it.lines.push(hookHover(L.polyline(seg, { color: it.color, weight: 0.5, opacity: 0.45, dashArray: "4 7", smoothFactor: 0.5, lineJoin: "round", lineCap: "round", interactive: true, bubblingMouseEvents: false }), t.key, "fwd").addTo(layer));
    }
    applyHighlight();
  }

  function updatePositions(st) {
    if (!on || !ensureLayer()) return;
    const favs = st.favorites || [];
    const trackKeys = new Set(tracks.map((t) => t.key));
    for (const f of favs) {
      if (!f || f.key === currentKey || !trackKeys.has(f.key) || !f.position) continue;
      const p = f.position;
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
      const it = item(f.key);
      const ll = [p.lat, p.lon];
      if (!it.dot) {
        it.dot = L.circleMarker(ll, { radius: 4, color: "#0d1117", weight: 1, fillColor: it.color, fillOpacity: 1, interactive: false }).addTo(layer);
        // Larger invisible hit target; carries the (interactive) name label.
        it.hit = hookHover(L.circleMarker(ll, { radius: 11, stroke: false, fillColor: "#000", fillOpacity: 0, interactive: true, bubblingMouseEvents: false }), f.key, "hit")
          .bindTooltip(f.display || f.key, { permanent: true, interactive: true, direction: "right", offset: [6, 0], className: "decode-label fav-label" })
          .addTo(layer);
        const tt = it.hit.getTooltip();
        if (tt) { hookHover(tt, f.key, "label"); }
        applyHighlight();
      } else { it.dot.setLatLng(ll); if (it.hit) it.hit.setLatLng(ll); }
      const rM = typeof footprintRadiusM === "function" ? footprintRadiusM(p.heightKm) : 0;
      if (rM > 0) {
        if (!it.circle) { it.circle = L.circle(ll, { radius: rM, color: it.color, weight: 1, opacity: 0.4, fillColor: it.color, fillOpacity: 0.03, interactive: false }).addTo(layer); applyHighlight(); }
        else { it.circle.setLatLng(ll); it.circle.setRadius(rM); }
      }
    }
  }

  /* ---------- hover / tap highlight ---------- */
  let hoverKey = null; // mouse hover
  let pinKey = null; // touch tap toggle
  const isTouch = () => window.matchMedia && window.matchMedia("(hover: none)").matches;

  function hookHover(obj, key, kind) {
    const on = (ev, fn) => (obj.on ? obj.on(ev, fn) : null);
    on("mouseover", () => { if (!isTouch()) { hoverKey = key; applyHighlight(); } });
    on("mouseout", () => { if (!isTouch() && hoverKey === key) { hoverKey = null; applyHighlight(); } });
    on("click", (e) => {
      if (e && e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
      if (isTouch()) { pinKey = pinKey === key ? null : key; applyHighlight(); }
    });
    return obj;
  }

  function clearHover() {
    if (hoverKey == null) return;
    hoverKey = null;
    applyHighlight();
  }

  function applyHighlight() {
    const hk = hoverKey || pinKey;
    for (const [key, it] of items) {
      const hi = hk === key;
      const dim = hk && !hi;
      it.lines.forEach((l) => {
        const fwd = !!(l.options && l.options.dashArray);
        l.setStyle({
          weight: hi ? 1.5 : fwd ? 0.5 : 0.75,
          opacity: hi ? (fwd ? 0.85 : 1) : dim ? 0.12 : fwd ? 0.45 : 0.6,
        });
      });
      if (it.circle) it.circle.setStyle({ opacity: hi ? 0.9 : dim ? 0.12 : 0.4, weight: hi ? 2 : 1, fillOpacity: hi ? 0.1 : dim ? 0.01 : 0.03 });
      if (it.dot) it.dot.setStyle({ radius: hi ? 6 : 4, fillOpacity: dim ? 0.35 : 1, opacity: dim ? 0.35 : 1 });
      const tt = it.hit && it.hit.getTooltip && it.hit.getTooltip();
      const el = tt && tt.getElement && tt.getElement();
      if (el) {
        el.classList.toggle("fav-hi", hi);
        el.classList.toggle("fav-dim", !!dim);
        el.style.borderLeft = hi ? "3px solid " + it.color : "";
        el.style.zIndex = hi ? 1000 : "";
      }
      if (hi) {
        it.lines.forEach((l) => l.bringToFront());
        if (it.circle) it.circle.bringToFront();
        if (it.dot) it.dot.bringToFront();
        if (it.hit) it.hit.bringToFront();
      }
    }
    // Selected sat always stays on top and unchanged.
    bringSelectedToFront();
  }

  // Tap on empty map clears a touch highlight.
  function hookMapClear() {
    const m = getMap();
    if (!m || m.__favHiClear) return;
    m.__favHiClear = true;
    m.on("click", () => { if (pinKey) { pinKey = null; applyHighlight(); } });
    // Single source of truth for hover: any pointer movement over bare map
    // (fav layers don't bubble), or leaving the map, clears a stale hover
    // (fast moves / missed mouseout).
    m.on("mousemove", (e) => {
      const t = e && e.originalEvent && e.originalEvent.target;
      if (t && t.closest && t.closest(".fav-label")) return; // over a fav name label
      if (!isTouch()) clearHover();
    });
    m.on("mouseout", () => { if (!isTouch()) clearHover(); });
    const c = m.getContainer && m.getContainer();
    if (c) c.addEventListener("mouseleave", () => { if (!isTouch()) clearHover(); });
  }

  function request() { const s = sock(); if (s) s.send(JSON.stringify({ type: "fav-tracks-get" })); }

  function syncBtn() {
    if (!btn) return;
    btn.classList.toggle("active", on);
    btn.title = (on ? "Hide" : "Show") + " favorite satellites' orbits on the map";
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  function addButton() {
    const bar = document.querySelector(".decode-toggle-control");
    const sked = bar && bar.querySelector(".sched-open-btn");
    if (!bar || !sked) return false; // wait so we land above Sked Finder
    if (bar.querySelector(".fav-overlay-btn")) return true;
    btn = document.createElement("a");
    btn.href = "#";
    btn.className = "decode-toggle-btn fav-overlay-btn";
    btn.setAttribute("role", "button");
    btn.textContent = "Favorites";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      on = !on;
      localStorage.setItem(LS_KEY, on ? "1" : "0");
      syncBtn();
      ensureLayer();
      if (on) { drawTracks(); request(); }
    });
    bar.insertBefore(btn, sked);
    syncBtn();
    return true;
  }

  function patchWs() {
    if (typeof ws === "undefined" || !ws || ws.__favOverlayPatched) return;
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "fav-tracks") {
          tracks = msg.tracks || [];
          currentKey = msg.current || currentKey;
          drawTracks();
        } else if (msg.type === "state") {
          if (msg.sat && msg.sat !== currentKey) { currentKey = msg.sat; drop(currentKey); }
          updatePositions(msg);
        }
      } catch (_) {}
    });
    ws.__favOverlayPatched = true;
    if (ws.readyState === 1) request();
    else ws.addEventListener("open", request);
  }

  function init() {
    setInterval(patchWs, 500);
    const t = setInterval(() => { if (addButton()) { hookMapClear(); clearInterval(t); } }, 300);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
