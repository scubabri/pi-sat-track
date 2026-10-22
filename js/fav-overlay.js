/**
 * Favorites orbit overlay: ground track, footprint and labelled dot for every
 * favorite sat (selected sat excluded; map.js draws it bright on top).
 * Tracks: server "fav-tracks" (60 s). Positions: favorites[] in "state" (1 s).
 * Toggle sits above Sked Finder in the map control bar. On/off and the shown
 * subset are saved in the active station profile (server "profiles" payload,
 * favOverlay {on, shown|null, footprints}); localStorage is only a startup cache.
 * "Footprints" (sub-toggle under Favorites, default off): a very light shade
 * for favorites that are up or rising within 15 min. Off = no favorite rings.
 */
(function () {
  const LS_KEY = "favOverlayOn";
  let on = localStorage.getItem(LS_KEY) === "1";
  let shown = null; // null = all favorites
  let profileName = "";
  let picker = null;
  let layer = null;
  let btn = null;
  let tracks = [];
  let currentKey = null;
  let fullKey = null; // favorite whose label is expanded (hover)
  const items = new Map(); // key -> { color, lines:[], dot, circle }
  let fpOn = localStorage.getItem(LS_KEY + "Fp") === "1";
  let fpBtn = null;
  // Favorites' footprints must read as background: well under the selected
  // sat's (fill 0.06 / solid outline 0.55, map.js).
  const FP = { fill: 0.04, opacity: 0.28, weight: 0.75, dash: "3 5" };
  const FP_NEAR_EL = -5; // deg: just set / about to rise still counts
  const FP_AOS_SOON_MS = 15 * 60e3; // or AOS within 15 min
  /** Favorite worth a footprint: up (el >= -5 deg) or AOS within 15 min of `now`. */
  function fpNear(f, now) {
    const el = f && f.look && f.look.el;
    if (Number.isFinite(el) && el >= FP_NEAR_EL) return true;
    const np = f && f.nextPass;
    // nextPass.aos is epoch ms from the server (ISO string tolerated).
    const t = np && np.aos != null ? (typeof np.aos === "number" ? np.aos : Date.parse(np.aos)) : NaN;
    const aos = t - now;
    return aos > 0 && aos <= FP_AOS_SOON_MS;
  }
  window.__favFpNear = fpNear; // tests
  const colorFor = (key) => (typeof favColor === "function" ? favColor(key) : "#b07cc6");

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
    if (fullKey === key) fullKey = null;
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
      const col = colorFor(t.key); // favorites reordered -> keep map & chart in sync
      if (it.color !== col) {
        it.color = col;
        if (it.dot) it.dot.setStyle({ fillColor: col });
        if (it.circle) it.circle.setStyle({ color: col, fillColor: col });
      }
      it.lines.forEach((l) => layer.removeLayer(l));
      it.lines = [];
      const split = typeof splitAtDateLine === "function" ? splitAtDateLine : (p) => [p];
      for (const seg of split(t.trail || [])) it.lines.push(hookHover(L.polyline(seg, { color: it.color, weight: 0.75, opacity: 0.6, smoothFactor: 0.5, lineJoin: "round", lineCap: "round", interactive: true, bubblingMouseEvents: false }), t.key, "trail").addTo(layer));
      for (const seg of split(t.forward || [])) it.lines.push(hookHover(L.polyline(seg, { color: it.color, weight: 0.5, opacity: 0.45, dashArray: "4 7", smoothFactor: 0.5, lineJoin: "round", lineCap: "round", interactive: true, bubblingMouseEvents: false }), t.key, "fwd").addTo(layer));
    }
    applyHighlight();
  }

  let lastSt = null;
  document.addEventListener("pass-preview-change", () => { if (lastSt) updatePositions(lastSt); });
  function updatePositions(st) {
    lastSt = st;
    if (!on || !ensureLayer()) return;
    // Pass preview: favorites drawn at the preview time.
    const pp = window.passPreview;
    const favs = (st.favorites || []).map((f) => {
      const pv = f && pp && pp.posOf(f.key);
      return pv ? Object.assign({}, f, { position: pv.position, look: pv.look || f.look }) : f;
    });
    const tNow = pp && pp.get && pp.get() != null && pp.posOf ? pp.get() : Date.now();
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
      // Moon (EME): no satellite-style footprint circle (it would cover half the Earth).
      // Footprints off, not up/rising soon, or no TLE (no position): no ring.
      const rM = !fpOn || f.isMoon || !fpNear(f, tNow) ? 0 : typeof footprintRadiusM === "function" ? footprintRadiusM(p.heightKm) : 0;
      if (rM > 0) {
        if (!it.circle) { it.circle = L.circle(ll, { radius: rM, color: it.color, weight: FP.weight, opacity: FP.opacity, dashArray: FP.dash, fillColor: it.color, fillOpacity: FP.fill, interactive: false }).addTo(layer); applyHighlight(); }
        else { it.circle.setLatLng(ll); it.circle.setRadius(rM); }
      } else if (it.circle) { layer.removeLayer(it.circle); it.circle = null; }
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
      if (it.circle) it.circle.setStyle({ opacity: hi ? 0.6 : dim ? 0.1 : FP.opacity, weight: hi ? 1.25 : FP.weight, fillOpacity: hi ? 0.05 : dim ? 0.015 : FP.fill });
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
    paintHoverLabel();
  }

  /* ---------- hover: full stacked label (same as the selected sat) ---------- */
  // The hovered (or tapped) favorite's name label is expanded in place to the
  // selected-sat content (selSatLabelHtml → satDotLabelLines on the favorites
  // snapshot: name, AOS/LOS countdown + clock, El, Rng, Alt) and ticks each
  // second; it reverts to the plain name when the hover ends. Only one label
  // is ever live, so this stays cheap on a Pi.
  function favSnap(key) {
    const list = (lastSt && lastSt.favorites) || [];
    for (const f of list) if (f && f.key === key) return f;
    return null;
  }
  function fullHtml(key) {
    const f = favSnap(key);
    if (!f || typeof selSatLabelHtml !== "function") return null;
    const pp = window.passPreview;
    const pv = pp && pp.posOf && pp.posOf(key);
    return pv && pp.get && pp.get() != null
      ? selSatLabelHtml(Object.assign({}, f, { position: pv.position || f.position }), pp.get())
      : selSatLabelHtml(f, null);
  }
  function labelTip(key) {
    const it = items.get(key);
    const tt = it && it.hit && it.hit.getTooltip && it.hit.getTooltip();
    return tt || null;
  }
  function paintHoverLabel() {
    const want = hoverKey || pinKey;
    if (fullKey && fullKey !== want) {
      const tt = labelTip(fullKey);
      if (tt) {
        const f = favSnap(fullKey);
        const name = (f && (f.display || f.key)) || fullKey;
        tt.setContent(String(name).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])));
        tt.__full = null;
        const el = tt.getElement && tt.getElement();
        if (el) el.classList.remove("fav-full");
      }
      fullKey = null;
    }
    if (!want) return;
    const tt = labelTip(want);
    const html = tt && fullHtml(want);
    if (!html) return;
    if (tt.__full !== html) {
      tt.setContent(html);
      tt.__full = html;
    }
    const el = tt.getElement && tt.getElement();
    if (el) el.classList.add("fav-full");
    fullKey = want;
  }
  setInterval(() => { if (hoverKey || pinKey) paintHoverLabel(); }, 1000);
  window.addEventListener("time-mode-change", () => { if (hoverKey || pinKey) paintHoverLabel(); });

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
    if (fpBtn) {
      fpBtn.classList.toggle("active", fpOn);
      fpBtn.title = (fpOn ? "Hide" : "Show") + " light footprints for favorites that are up or rising within 15 min";
      fpBtn.setAttribute("aria-pressed", fpOn ? "true" : "false");
    }
  }

  function setFp(v) {
    fpOn = !!v;
    localStorage.setItem(LS_KEY + "Fp", fpOn ? "1" : "0");
    syncBtn();
    if (lastSt) updatePositions(lastSt);
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
    btn.innerHTML = 'Favorites<span class="fav-pick-caret" title="Choose which favorites are shown">\u25BE</span>';
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.target && e.target.closest && e.target.closest(".fav-pick-caret")) { togglePicker(); return; }
      setOn(!on);
      sendSet({ on });
    });
    bar.insertBefore(btn, sked);
    // Footprints sub-toggle directly below Favorites (standard toggle style).
    fpBtn = document.createElement("a");
    fpBtn.href = "#";
    fpBtn.className = "decode-toggle-btn fav-fp-btn";
    fpBtn.setAttribute("role", "button");
    fpBtn.textContent = "Footprints";
    fpBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setFp(!fpOn);
      sendSet({ footprints: fpOn });
    });
    bar.insertBefore(fpBtn, sked);
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
        } else if (msg.type === "profiles") {
          applyProfile(msg);
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

  function sendSet(o) { const s = sock(); if (s) s.send(JSON.stringify(Object.assign({ type: "fav-overlay-set" }, o))); }

  function fireChange() {
    document.dispatchEvent(new CustomEvent("fav-overlay-change", { detail: { on, shown } }));
  }

  function setOn(v) {
    const changed = v !== on;
    on = v;
    localStorage.setItem(LS_KEY, on ? "1" : "0");
    syncBtn();
    ensureLayer();
    if (on) { drawTracks(); request(); }
    if (changed) fireChange();
  }

  /** Server "profiles" payload: favOverlay is the source of truth. */
  function applyProfile(msg) {
    const prevName = profileName;
    profileName = msg.active || "";
    const fo = msg.favOverlay;
    if (!fo) {
      // First time for this profile: migrate this browser's cached toggle once.
      sendSet({ on, shown: null, footprints: false });
      if (fpOn) setFp(false);
      renderPicker();
      return;
    }
    const nextShown = Array.isArray(fo.shown) ? fo.shown.slice() : null;
    const shownChanged = JSON.stringify(nextShown) !== JSON.stringify(shown);
    shown = nextShown;
    try { localStorage.setItem(LS_KEY + "Shown", JSON.stringify(shown)); } catch (_) {}
    if (!!fo.footprints !== fpOn) setFp(!!fo.footprints);
    if (!!fo.on !== on) setOn(!!fo.on);
    else if (shownChanged || prevName !== profileName) { request(); fireChange(); }
    renderPicker();
  }

  /* ---------- picker: which favorites the overlay shows (per profile) ---------- */
  function favList() { return typeof loadFavorites === "function" ? loadFavorites() : []; }
  function togglePicker() {
    if (!picker) {
      picker = document.createElement("div");
      picker.className = "fav-picker";
      picker.hidden = true;
      ["click", "dblclick", "mousedown", "wheel", "touchstart", "pointerdown"].forEach((ev) =>
        picker.addEventListener(ev, (e) => e.stopPropagation()));
      (document.getElementById("map-container") || document.body).appendChild(picker);
      document.addEventListener("click", (e) => {
        if (picker && !picker.hidden && !picker.contains(e.target) && !(btn && btn.contains(e.target))) picker.hidden = true;
      });
    }
    picker.hidden = !picker.hidden;
    renderPicker();
  }
  function renderPicker() {
    if (!picker || picker.hidden) return;
    const favs = favList();
    const set = shown ? new Set(shown) : null;
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    picker.innerHTML =
      '<div class="fav-picker-head"><span>Map favorites</span><span class="fav-picker-profile" title="Saved with this station profile">' + esc(profileName || "—") + "</span></div>" +
      (favs.length
        ? favs.map((k) => '<label class="fav-picker-row"><input type="checkbox" data-key="' + esc(k) + '"' + (!set || set.has(k) ? " checked" : "") +
            '><span class="fav-picker-sw" style="background:' + colorFor(k) + '"></span>' + esc(k) + "</label>").join("")
        : '<div class="fav-picker-empty">No favorites yet — star sats in the list</div>') +
      '<div class="fav-picker-foot"><a href="#" data-act="all">All</a><a href="#" data-act="none">None</a><span>Saved with profile</span></div>';
    picker.querySelectorAll("input[data-key]").forEach((cb) => cb.addEventListener("change", () => {
      const keys = [...picker.querySelectorAll("input[data-key]")].filter((c) => c.checked).map((c) => c.dataset.key);
      const all = keys.length === favs.length;
      shown = all ? null : keys;
      sendSet({ shown, on: true });
    }));
    picker.querySelectorAll("a[data-act]").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      shown = a.dataset.act === "all" ? null : [];
      sendSet({ shown, on: true });
      renderPicker();
    }));
  }

  window.isFavOverlayOn = () => on;
  /** Keys the overlay shows right now (null = all favorites). */
  window.favOverlayShown = () => (shown ? shown.slice() : null);

  function init() {
    setInterval(patchWs, 500);
    const t = setInterval(() => { if (addButton()) { hookMapClear(); clearInterval(t); } }, 300);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
