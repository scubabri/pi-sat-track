/**
 * 3D globe view (Map | Globe toggle on the map button stack).
 * Leaflet stays the default; the choice is saved in localStorage ("mapView").
 * globe.gl (js/vendor/globe/, bundles three.js) and the 2K Earth texture are
 * lazy-loaded the first time Globe is picked. Data: server "globe-orbits"
 * (one period per sat, ~100 [lat, lon, km] points, cached server-side) plus
 * live positions from the regular 1 s "state" message (applied every 2 s).
 * Favorites follow the map Favorites overlay (on/off + shown subset) and the
 * shared colors in js/sat-colors.js. Rendering pauses while hidden.
 */
(function () {
  const LS_KEY = "mapView";
  const RE_KM = 6371;
  const VENDOR = "js/vendor/globe/";
  let mode = localStorage.getItem(LS_KEY) === "globe" ? "globe" : "map";
  let btn = null;
  let el = null;
  let G = null;
  let loading = null;
  let orbits = null;
  let lastState = null;
  let lastApply = 0;
  let orbitTimer = null;
  const pts = new Map(); // key -> point datum (stable identity: moved in place)
  const selLabel = { kind: "sat", lat: 0, lng: 0, alt: 0, text: "" };
  const stLabel = { kind: "station", lat: 0, lng: 0, alt: 0.01, text: "\u2302 Station" };
  const footprint = { key: "__fp", footprint: true, color: "rgba(88,166,255,0.95)", w: 1.1, pts: [] };
  // Shaded footprint interior (polygon layer), same ring as the outline.
  const fpShade = { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[]] } };

  function sock() { return typeof ws !== "undefined" && ws && ws.readyState === 1 ? ws : null; }
  function selColor() { return typeof SAT_SELECTED_COLOR !== "undefined" ? SAT_SELECTED_COLOR : "#58a6ff"; }
  function colorOf(key) { return typeof favColor === "function" ? favColor(key) : "#b07cc6"; }
  function favOn() { return typeof window.isFavOverlayOn === "function" && window.isFavOverlayOn(); }

  function toast(msg) {
    const t = document.createElement("div");
    t.className = "globe-toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4500);
  }

  function webglOk() {
    try {
      const c = document.createElement("canvas");
      return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
    } catch (_) { return false; }
  }

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = res;
      s.onerror = () => rej(new Error("load failed: " + src));
      document.head.appendChild(s);
    });
  }

  function ensureGlobe() {
    if (G) return Promise.resolve(G);
    if (loading) return loading;
    loading = (typeof Globe === "function" ? Promise.resolve() : loadScript(VENDOR + "globe.gl.min.js")).then(() => {
      const host = document.getElementById("map");
      el = document.createElement("div");
      el.id = "globe-view";
      host.appendChild(el);
      // Keep Leaflet from panning/zooming underneath the globe.
      if (typeof L !== "undefined" && L.DomEvent) {
        L.DomEvent.disableClickPropagation(el);
        L.DomEvent.disableScrollPropagation(el);
      }
      ["pointerdown", "mousedown", "touchstart", "dblclick", "contextmenu"].forEach((ev) => el.addEventListener(ev, (e) => e.stopPropagation()));
      G = Globe({ rendererConfig: { antialias: false, alpha: false, powerPreference: "low-power" } })(el)
        .backgroundColor("#0a1628")
        .showAtmosphere(false)
        .globeImageUrl(VENDOR + "earth-2k.jpg")
        .pathPoints("pts")
        .pathPointLat((p) => p[0])
        .pathPointLng((p) => p[1])
        .pathPointAlt((p) => p[2])
        .pathColor((d) => d.color)
        .pathStroke((d) => d.w)
        .pathTransitionDuration(0)
        .pathLabel((d) => (d.footprint ? "" : d.display))
        // Sat dots + labels are HTML markers at true (scaled) altitude; the
        // points layer would draw altitude as a cylinder from the ground.
        .htmlLat("lat").htmlLng("lng").htmlAltitude("alt")
        .htmlElement((d) => {
          const e = document.createElement("div");
          if (d.kind === "dot") {
            e.className = "globe-dot";
            e.title = d.display || d.key;
            e.addEventListener("click", (ev) => { ev.stopPropagation(); pick(d); });
          } else {
            e.className = "globe-label" + (d.kind === "station" ? " globe-label-station" : "");
            e.textContent = d.text;
          }
          d.el = e;
          styleDot(d);
          return e;
        })
        .htmlTransitionDuration(0)
        .polygonGeoJsonGeometry("geometry")
        .polygonCapColor(() => "rgba(88,166,255,0.22)")
        .polygonSideColor(() => "rgba(0,0,0,0)")
        .polygonStrokeColor(() => false)
        .polygonAltitude(0.004)
        .polygonsTransitionDuration(0)
        .onPathClick(pick);
      try { G.renderer().setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5)); } catch (_) {}
      const fit = () => { if (el && G && mode === "globe") G.width(el.clientWidth).height(el.clientHeight); };
      if (typeof ResizeObserver === "function") new ResizeObserver(fit).observe(host);
      fit();
      placeStation(true);
      return G;
    });
    loading.catch(() => { loading = null; });
    return loading;
  }

  /** Map center buttons call this while the globe is showing. Returns true if handled. */
  window.globeCenterOn = function (lat, lng) {
    if (mode !== "globe" || !G || !Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    const pov = G.pointOfView();
    G.pointOfView({ lat, lng, altitude: (pov && pov.altitude) || 2.2 }, 800);
    return true;
  };

  function pick(d) {
    if (!d || !d.key || d.footprint || d.kind === "station") return;
    if (lastState && d.key === lastState.sat) return;
    if (typeof selectSatellite === "function") selectSatellite(d.key, d.display || d.key);
  }

  function placeStation(pov) {
    let cfg = null;
    try { cfg = typeof loadConfig === "function" ? loadConfig() : null; } catch (_) {}
    const ll = cfg && cfg.grid && typeof maidenheadToLatLon === "function" ? maidenheadToLatLon(cfg.grid) : null;
    if (!ll) return;
    stLabel.lat = ll.lat;
    stLabel.lng = ll.lon;
    stLabel.text = "\u2302 " + (cfg.callsign || cfg.grid);
    if (pov && G) G.pointOfView({ lat: ll.lat, lng: ll.lon, altitude: 2.2 }, 0);
  }

  function requestOrbits() {
    const s = sock();
    if (s && mode === "globe") s.send(JSON.stringify({ type: "globe-orbits-get" }));
  }

  /** Visible-horizon circle around the sub-satellite point (same math as the map). */
  function footprintPts(lat, lon, hKm) {
    const lam = Math.acos(RE_KM / (RE_KM + hKm));
    const la = (lat * Math.PI) / 180;
    const lo = (lon * Math.PI) / 180;
    const out = [];
    for (let i = 0; i <= 90; i++) {
      const az = (i / 90) * 2 * Math.PI;
      const l2 = Math.asin(Math.sin(la) * Math.cos(lam) + Math.cos(la) * Math.sin(lam) * Math.cos(az));
      const o2 = lo + Math.atan2(Math.sin(az) * Math.sin(lam) * Math.cos(la), Math.cos(lam) - Math.sin(la) * Math.sin(l2));
      out.push([(l2 * 180) / Math.PI, ((((o2 * 180) / Math.PI) + 540) % 360) - 180, 0.005]);
    }
    return out;
  }

  function point(key) {
    let p = pts.get(key);
    if (!p) { p = { kind: "dot", key, lat: 0, lng: 0, alt: 0, color: "#fff", r: 0.4, display: key }; pts.set(key, p); }
    return p;
  }
  function styleDot(d) {
    if (!d.el) return;
    if (d.kind === "dot") {
      const px = d.sel ? 10 : 7;
      d.el.style.cssText = "width:" + px + "px;height:" + px + "px;margin:-" + px / 2 + "px 0 0 -" + px / 2 + "px;background:" + d.color + ";";
    } else if (d.kind === "station") {
      d.el.textContent = d.text;
    }
  }

  /** Orbits changed (sat / favorites / TLE / overlay): rebuild paths. */
  function renderPaths() {
    if (!G || !orbits) return;
    const cur = lastState ? lastState.sat : orbits.current;
    const showFav = favOn();
    const paths = [];
    for (const s of orbits.sats || []) {
      const sel = s.key === cur;
      if (!sel && !showFav) continue;
      paths.push({
        key: s.key,
        display: s.display,
        color: sel ? selColor() : colorOf(s.key),
        w: sel ? 0.9 : 0.35,
        pts: s.pts.map((q) => [q[0], q[1], q[2] / RE_KM]),
      });
    }
    if (footprint.pts.length > 1) paths.push(footprint);
    G.pathsData(paths);
  }

  /** Live positions (moved in place), footprint and labels. */
  function applyState(force) {
    if (!G || mode !== "globe" || !lastState) return;
    const now = Date.now();
    if (!force && now - lastApply < 2000) return;
    lastApply = now;
    const st = lastState;
    const keep = new Set();
    if (st.position && Number.isFinite(st.position.lat)) {
      const p = point(st.sat);
      p.lat = st.position.lat; p.lng = st.position.lon; p.alt = (st.position.heightKm || 0) / RE_KM;
      p.color = selColor(); p.sel = true; p.display = st.display || st.sat;
      keep.add(st.sat);
      selLabel.lat = p.lat; selLabel.lng = p.lng; selLabel.alt = p.alt;
      selLabel.text = (st.display || st.sat) + " \u00B7 " + Math.round(st.position.heightKm || 0) + " km";
      if (selLabel.el) selLabel.el.textContent = selLabel.text;
      footprint.pts = footprintPts(p.lat, p.lng, st.position.heightKm || 0);
      fpShade.geometry.coordinates = [footprint.pts.map((q) => [q[1], q[0]])];
      G.polygonsData([fpShade]);
    }
    if (favOn()) {
      const shown = typeof window.favOverlayShown === "function" ? window.favOverlayShown() : null;
      const ok = shown ? new Set(shown) : null;
      for (const f of st.favorites || []) {
        if (!f || !f.position || f.key === st.sat || (ok && !ok.has(f.key))) continue;
        const p = point(f.key);
        p.lat = f.position.lat; p.lng = f.position.lon; p.alt = (f.position.heightKm || 0) / RE_KM;
        p.color = colorOf(f.key); p.sel = false; p.display = f.display || f.key;
        keep.add(f.key);
      }
    }
    for (const k of [...pts.keys()]) if (!keep.has(k)) pts.delete(k);
    pts.forEach(styleDot);
    G.htmlElementsData([...pts.values(), stLabel].concat(st.position ? [selLabel] : []));
    // footprint moves with the sat: refresh paths cheaply (same orbit arrays)
    if (orbits) renderPaths();
    else G.pathsData(footprint.pts.length > 1 ? [footprint] : []);
  }

  function onVisibility() {
    if (!G) return;
    if (document.hidden || mode !== "globe") G.pauseAnimation();
    else G.resumeAnimation();
  }

  function setMode(next, save) {
    if (next === "globe" && !webglOk()) {
      toast("3D globe needs WebGL, which isn't available here; staying on Map.");
      next = "map";
    }
    mode = next;
    if (save) localStorage.setItem(LS_KEY, mode);
    syncBtn();
    document.body.classList.toggle("globe-mode", mode === "globe");
    if (mode === "globe") {
      ensureGlobe().then(() => {
        if (mode !== "globe") return;
        el.hidden = false;
        G.width(el.clientWidth).height(el.clientHeight);
        onVisibility();
        requestOrbits();
        applyState(true);
        if (!orbitTimer) orbitTimer = setInterval(requestOrbits, 60000);
      }).catch((e) => {
        console.warn("Globe load failed", e);
        toast("Couldn't load the 3D globe; staying on Map.");
        setMode("map", true);
      });
    } else {
      if (el) el.hidden = true;
      if (G) G.pauseAnimation();
      if (orbitTimer) { clearInterval(orbitTimer); orbitTimer = null; }
      if (typeof map !== "undefined" && map && map.invalidateSize) setTimeout(() => map.invalidateSize({ pan: false }), 0);
    }
  }

  function syncBtn() {
    if (!btn) return;
    btn.innerHTML = '<span class="mv-seg' + (mode === "map" ? " on" : "") + '">Map</span><span class="mv-sep">|</span><span class="mv-seg' + (mode === "globe" ? " on" : "") + '">Globe</span>';
    btn.title = mode === "globe" ? "Showing 3D globe — click for the flat map" : "Showing flat map — click for the 3D globe";
    btn.setAttribute("aria-pressed", mode === "globe" ? "true" : "false");
  }

  function addButton() {
    const bar = document.querySelector(".decode-toggle-control");
    if (!bar) return false;
    if (bar.querySelector(".map-view-btn")) return true;
    btn = document.createElement("a");
    btn.href = "#";
    btn.className = "decode-toggle-btn map-view-btn";
    btn.setAttribute("role", "button");
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setMode(mode === "globe" ? "map" : "globe", true);
    });
    bar.insertBefore(btn, bar.firstChild);
    syncBtn();
    return true;
  }

  function patchWs() {
    if (typeof ws === "undefined" || !ws || ws.__globePatched) return;
    ws.__globePatched = true;
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return;
      const d = ev.data;
      const isState = d.indexOf('"type":"state"') >= 0;
      if (!isState && d.indexOf('"globe-orbits"') < 0) return;
      if (isState && mode !== "globe") return; // nothing to do while on Map
      try {
        const msg = JSON.parse(d);
        if (msg.type === "globe-orbits") {
          orbits = msg;
          renderPaths();
        } else if (msg.type === "state") {
          const satChanged = !lastState || lastState.sat !== msg.sat;
          lastState = msg;
          if (satChanged) { requestOrbits(); applyState(true); }
          else applyState(false);
        }
      } catch (_) {}
    });
    if (ws.readyState === 1) requestOrbits();
    else ws.addEventListener("open", requestOrbits);
  }

  function init() {
    setInterval(patchWs, 500);
    const t = setInterval(() => { if (addButton()) clearInterval(t); }, 300);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("fav-overlay-change", () => { requestOrbits(); renderPaths(); applyState(true); });
    if (mode === "globe") setMode("globe", false);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
