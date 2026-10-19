/**
 * 3D globe view (Map | Globe toggle on the map button stack).
 * Leaflet stays the default; the choice is saved in localStorage ("mapView").
 * globe.gl (js/vendor/globe/, bundles three.js) and the 2K Earth texture are
 * lazy-loaded the first time Globe is picked. Data: server "globe-orbits"
 * (one period per sat, ~100 [lat, lon, km] points, cached server-side) plus
 * live positions from the regular 1 s "state" message (applied every 2 s).
 * Favorites follow the map Favorites overlay (on/off + shown subset) and the
 * shared colors in js/sat-colors.js. WSJT-X heard stations follow the map's
 * "WSJT Heard" overlay (js/decode-overlay.js: same list, toggle, fading and
 * expiry). Rendering pauses while hidden.
 */
(function () {
  const LS_KEY = "mapView";
  const POV_KEY = "globePov";
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
  const ghost = { kind: "ghost", lat: 0, lng: 0, alt: 0 }; // live position while a pass preview is shown
  // Home station: "+" at the grid point with the label to its right (like the
  // map's observer marker). Same altitude as the Log-box DX dot and its
  // great-circle line, so the line meets both markers exactly.
  const MARK_ALT = 0.006; // above the footprint fill (polygonAltitude 0.004)
  const stLabel = { kind: "station", lat: 0, lng: 0, alt: MARK_ALT, text: "\u2302 Station" };
  const dxMark = { kind: "dx", lat: 0, lng: 0, alt: MARK_ALT, text: "" };
  const dxPath = { key: "__dx", footprint: true, color: "#ffd34d", w: 0.6, pts: [] };
  const footprint = { key: "__fp", footprint: true, color: "rgba(88,166,255,0.95)", w: 1.1, pts: [] };
  // Shaded footprint interior (polygon layer), same ring as the outline.
  const fpShade = { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[]] } };
  // Day/night (js/sun.js): a translucent black shell just above the surface
  // whose per-vertex alpha follows the sun angle (night ~0.5, ~3 deg soft
  // twilight edge), a thin terminator path and a non-interactive "SUN" marker.
  // (globe.gl polygons were tried for the night cap: long thin pole strips
  // triangulate with ragged edges and gaps.)
  const NIGHT_ALPHA = 0.55;
  let nightMesh = null; // three.js Mesh, or false if it couldn't be built
  const terminatorPath = { key: "__term", footprint: true, color: "rgba(255,179,71,0.45)", w: 0.4, pts: [] };
  const sunMark = { kind: "sun", lat: 0, lng: 0, alt: 0.006, text: "SUN" };
  let sunAt = 0;

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
      // A user drag (rotate / pan) of the globe ends follow mode; a click or wheel zoom doesn't.
      let downAt = null;
      el.addEventListener("pointerdown", (e) => { downAt = { x: e.clientX, y: e.clientY }; });
      el.addEventListener("pointermove", (e) => {
        if (!downAt || !follow.key || !e.buttons) return;
        if (Math.abs(e.clientX - downAt.x) + Math.abs(e.clientY - downAt.y) > 4) { downAt = null; stopFollow(); }
      });
      const up = () => { downAt = null; };
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
      G = Globe({ rendererConfig: { antialias: false, alpha: false, powerPreference: "low-power" } })(el)
        .backgroundColor("#000000")
        .backgroundImageUrl(VENDOR + "night-sky.jpg")
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
          if (d.kind === "ghost") {
            e.className = "globe-ghost";
            e.title = "now";
          } else if (d.kind === "dot") {
            e.className = "globe-dot";
            e.title = d.display || d.key;
            e.addEventListener("click", (ev) => { ev.stopPropagation(); pick(d); });
            e.addEventListener("mouseenter", () => hoverOn(d));
            e.addEventListener("mouseleave", () => hoverOff(d));
          } else if (d.kind === "dx") {
            // Callsign typed in the Log box: yellow dot + "CALL GRID" (like the map).
            e.className = "globe-dx";
            e.innerHTML = '<span class="globe-dx-dot"></span><span class="globe-label globe-dx-label"></span>';
            e.lastChild.textContent = d.text;
            d.el = e;
            return e;
          } else if (d.kind === "heard") {
            // WSJT-X heard station: same yellow dot + "CALL grid" chip as the map overlay.
            e.className = "globe-heard";
            e.innerHTML = '<div class="globe-heard-in"><span class="globe-heard-dot"></span><span class="globe-heard-label"><span class="dc-call"></span><span class="dc-grid"></span></span></div>';
            d.el = e;
            paintHeard(d);
            return e;
          } else if (d.kind === "sun") {
            e.className = "globe-sun";
            e.innerHTML = '<span class="globe-sun-dot"></span><span class="globe-label globe-sun-label">SUN</span>';
            return e;
          } else if (d.kind === "sat") {
            // globe.gl owns the element's inline transform (centers it on the point),
            // so the label sits in a zero-size anchor and is offset to the right of the dot.
            e.className = "globe-sel-anchor";
            const t = document.createElement("div");
            t.className = "globe-label globe-sel-label";
            e.appendChild(t);
            d.el = t;
            paintSelLabel();
            return e;
          } else {
            if (d.kind === "station") {
              e.className = "globe-station";
              e.innerHTML = '<span class="globe-station-mark">+</span><span class="globe-label globe-label-station"></span>';
              d.el = e;
              styleDot(d);
              return e;
            }
            e.className = "globe-label";
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
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(POV_KEY) || "null"); } catch (_) {}
      const ok = saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lng) && Number.isFinite(saved.altitude);
      placeStation(!ok);
      if (ok) G.pointOfView({ lat: saved.lat, lng: saved.lng, altitude: Math.min(8, Math.max(0.3, saved.altitude)) }, 0);
      // Remember where the globe is pointed (drag, zoom, center buttons, snaps).
      let povTimer = null;
      const savePov = () => {
        clearTimeout(povTimer);
        povTimer = setTimeout(() => {
          try { localStorage.setItem(POV_KEY, JSON.stringify(G.pointOfView())); } catch (_) {}
        }, 500);
      };
      try { G.controls().addEventListener("change", savePov); } catch (_) {}
      G.__savePov = savePov;
      window.addEventListener("pagehide", () => {
        if (mode === "globe") try { localStorage.setItem(POV_KEY, JSON.stringify(G.pointOfView())); } catch (_) {}
      });
      return G;
    });
    loading.catch(() => { loading = null; });
    return loading;
  }

  /**
   * Great-circle polyline a -> b as globe.gl path points [lat, lng, alt]:
   * exact endpoints, ~0.5 deg steps (min 64 segments), constant altitude.
   */
  window.globeGcLine = function (a, b, alt) {
    const rad = Math.PI / 180;
    const p1 = [a.lat * rad, a.lon * rad], p2 = [b.lat * rad, b.lon * rad];
    const d = 2 * Math.asin(Math.min(1, Math.sqrt(Math.sin((p2[0] - p1[0]) / 2) ** 2 +
      Math.cos(p1[0]) * Math.cos(p2[0]) * Math.sin((p2[1] - p1[1]) / 2) ** 2)));
    if (!(d > 1e-9)) return [[a.lat, a.lon, alt], [b.lat, b.lon, alt]];
    const n = Math.max(64, Math.ceil(d / rad / 0.5));
    const out = [];
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
      const x = A * Math.cos(p1[0]) * Math.cos(p1[1]) + B * Math.cos(p2[0]) * Math.cos(p2[1]);
      const y = A * Math.cos(p1[0]) * Math.sin(p1[1]) + B * Math.cos(p2[0]) * Math.sin(p2[1]);
      const z = A * Math.sin(p1[0]) + B * Math.sin(p2[0]);
      out.push([Math.atan2(z, Math.sqrt(x * x + y * y)) / rad, Math.atan2(y, x) / rad, alt]);
    }
    out[0] = [a.lat, a.lon, alt];
    out[n] = [b.lat, b.lon, alt];
    return out;
  };

  function centerOn(lat, lng) {
    const pov = G.pointOfView();
    G.pointOfView({ lat, lng, altitude: (pov && pov.altitude) || 2.2 }, 800);
    setTimeout(() => G.__savePov && G.__savePov(), 900);
  }
  /**
   * Map center buttons (station / mid-Atlantic) call this while the globe is
   * showing; it ends follow mode. opts.preview (pass preview start): while
   * following, the live sat stays centered, so it's handled without moving.
   * Returns true if handled.
   */
  window.globeCenterOn = function (lat, lng, opts) {
    if (mode !== "globe" || !G || !Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    if (opts && opts.preview && follow.key) return true;
    stopFollow();
    centerOn(lat, lng);
    return true;
  };

  /**
   * Follow mode: after a profile-chart click spins the globe to a sat, the
   * camera keeps that sat's live sub-point centered and the globe turns
   * underneath it (altitude / zoom stay the user's). Off by default, never
   * persisted. Ends on a user drag of the globe, the center buttons, Map view,
   * or another sat being selected elsewhere. Wheel / pinch zoom keeps following.
   *
   * Motion is continuous (rAF): we integrate lat/lng/alt with a velocity taken
   * from the last two 1 s server positions, gently correct when a new sample
   * arrives (no snap), and drive BOTH the camera and the selected sat's
   * marker/label from that same smoothed state. Footprint path + fill refresh
   * at ~4 Hz (not every frame) so the Pi isn't rebuilding geometries at 60 Hz.
   */
  const follow = {
    key: null, raf: 0, since: 0, lastFrame: 0, lastFp: 0,
    // integrated state (deg, deg, earth-radii) and velocity (deg/ms, deg/ms, radii/ms)
    lat: null, lng: null, alt: null, vLat: 0, vLng: 0, vAlt: 0,
    pullLat: 0, pullLng: 0, pullAlt: 0, // residual sample error, bled out over ~1 s
    samples: [], // up to 2 {t, lat, lng, alt}
  };
  function wrap180(x) { return ((((x + 180) % 360) + 360) % 360) - 180; }
  function startFollow(key) {
    follow.key = key;
    follow.since = Date.now() + 900; // let the 800 ms snap tween finish first
    follow.samples = [];
    follow.lat = follow.lng = follow.alt = null;
    follow.vLat = follow.vLng = follow.vAlt = 0;
    follow.pullLat = follow.pullLng = follow.pullAlt = 0;
    follow.lastFrame = 0;
    follow.lastFp = 0;
    if (lastState && lastState.sat === key) followSample(lastState);
    if (!follow.raf) follow.raf = requestAnimationFrame(followFrame);
  }
  function stopFollow() {
    follow.key = null;
    follow.samples = [];
    if (follow.raf) { cancelAnimationFrame(follow.raf); follow.raf = 0; }
    if (G && G.__savePov) G.__savePov();
  }
  function followSample(msg) {
    const p = msg && msg.position; // live position (a pass preview only highlights)
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return;
    const now = Date.now();
    const alt = (Number.isFinite(p.heightKm) ? p.heightKm : 0) / RE_KM;
    const q = follow.samples;
    q.push({ t: now, lat: p.lat, lng: p.lon, alt: alt });
    if (q.length > 2) q.shift();
    // Seed or softly correct the integrator so a new sample never snaps the camera.
    if (follow.lat == null) {
      follow.lat = p.lat; follow.lng = p.lon; follow.alt = alt;
      if (q.length === 2) {
        const dt = q[1].t - q[0].t;
        if (dt > 0) {
          follow.vLat = (q[1].lat - q[0].lat) / dt;
          follow.vLng = wrap180(q[1].lng - q[0].lng) / dt;
          follow.vAlt = (q[1].alt - q[0].alt) / dt;
        }
      }
      return;
    }
    // Queue the prediction error to be bled into position over ~1 s (see
    // followFrame) so a 1 Hz sample never produces a visible camera jump.
    follow.pullLat = p.lat - follow.lat;
    follow.pullLng = wrap180(p.lon - follow.lng);
    follow.pullAlt = alt - follow.alt;
    if (q.length === 2) {
      const dt = q[1].t - q[0].t;
      if (dt > 50) {
        const nLat = (q[1].lat - q[0].lat) / dt;
        const nLng = wrap180(q[1].lng - q[0].lng) / dt;
        const nAlt = (q[1].alt - q[0].alt) / dt;
        follow.vLat = follow.vLat * 0.4 + nLat * 0.6;
        follow.vLng = follow.vLng * 0.4 + nLng * 0.6;
        follow.vAlt = follow.vAlt * 0.4 + nAlt * 0.6;
      }
    }
  }
  function followFrame(ts) {
    follow.raf = 0;
    if (!follow.key || !G || mode !== "globe") return;
    follow.raf = requestAnimationFrame(followFrame);
    if (document.hidden) { follow.lastFrame = 0; return; }
    const now = Date.now();
    if (now < follow.since || follow.lat == null) return;
    const prev = follow.lastFrame || now;
    // Cap the step so a tab-thaw doesn't leap several seconds of orbit.
    const dt = Math.min(64, Math.max(0, now - prev));
    follow.lastFrame = now;
    if (dt > 0) {
      // Bleed ~63% of the residual pull per 400 ms (smooth, no 1 Hz spike).
      const a = 1 - Math.exp(-dt / 400);
      const dLat = follow.vLat * dt + follow.pullLat * a;
      const dLng = follow.vLng * dt + follow.pullLng * a;
      const dAlt = follow.vAlt * dt + follow.pullAlt * a;
      follow.lat += dLat;
      follow.lng = wrap180(follow.lng + dLng);
      follow.alt += dAlt;
      follow.pullLat *= 1 - a;
      follow.pullLng *= 1 - a;
      follow.pullAlt *= 1 - a;
    }
    const pov = G.pointOfView();
    G.pointOfView({ lat: follow.lat, lng: follow.lng, altitude: pov.altitude }, 0);
    // Move the selected sat marker + label in place (globe.gl re-reads lat/lng
    // each frame; no htmlElementsData rebuild).
    const p = pts.get(follow.key);
    if (p && p.sel) {
      p.lat = follow.lat; p.lng = follow.lng; p.alt = follow.alt;
      selLabel.lat = follow.lat; selLabel.lng = follow.lng; selLabel.alt = follow.alt;
    }
    // Footprint at ~4 Hz — geometry rebuild is the expensive bit.
    if (now - follow.lastFp > 240 && p && p.sel && lastState && lastState.position) {
      follow.lastFp = now;
      const hKm = follow.alt * RE_KM;
      footprint.pts = footprintPts(follow.lat, follow.lng, hKm);
      fpShade.geometry.coordinates = [footprint.pts.map((q) => [q[1], q[0]])];
      G.polygonsData([fpShade]);
      if (orbits) renderPaths();
      else G.pathsData((footprint.pts.length > 1 ? [footprint] : []).concat(terminatorPath.pts.length > 1 ? [terminatorPath] : []));
    }
  }
  window.globeFollowing = () => follow.key;
  /** Smoothed sub-point while following (for applyState to avoid 1 Hz snaps). */
  function followPos() {
    if (!follow.key || follow.lat == null || Date.now() < follow.since) return null;
    return { lat: follow.lat, lon: follow.lng, heightKm: follow.alt * RE_KM };
  }

  /** Profile chart click: once that sat's position arrives, spin the globe to it, then follow it. */
  let snapKey = null;
  window.globeSnapTo = function (key) {
    if (mode !== "globe" || !key) return;
    snapKey = key;
    startFollow(key);
    applyState(true);
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
    styleDot(stLabel);
    if (pov && G) G.pointOfView({ lat: ll.lat, lng: ll.lon, altitude: 2.2 }, 0);
  }

  function previewT() { return window.passPreview ? window.passPreview.get() : null; }
  function requestOrbits() {
    const s = sock();
    if (!s || mode !== "globe") return;
    const t = previewT();
    // While previewing, orbits start at the preview time so dots sit on them.
    s.send(JSON.stringify(t != null ? { type: "globe-orbits-get", t: Math.round(t) } : { type: "globe-orbits-get" }));
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

  /**
   * Night shell: globe.gl bundles three.js but doesn't export it, so the
   * constructors are borrowed from the globe's own mesh / material
   * (SphereGeometry, MeshPhongMaterial, BufferAttribute, Mesh). Low-res
   * (64x32 = 2145 vertices; 0.3% above the surface so the flat
   * facets clear the 90x45 globe mesh), never raycast, no depth write.
   */
  function ensureNightMesh() {
    if (nightMesh !== null || !G) return nightMesh;
    try {
      const gm = G.globeMaterial();
      let gMesh = null;
      G.scene().traverse((o) => { if (!gMesh && o.material === gm) gMesh = o; });
      if (!gMesh || !gMesh.parent) return null; // globe mesh not built yet: retry on the next update
      nightMesh = false;
      const geo = new gMesh.geometry.constructor(G.getGlobeRadius() * 1.003, 64, 32);
      const n = geo.attributes.position.count;
      geo.setAttribute("color", new geo.attributes.position.constructor(new Float32Array(n * 4), 4));
      const mat = new gm.constructor({ color: 0xffffff, vertexColors: true, transparent: true, depthWrite: false, shininess: 0 });
      if (mat.specular) mat.specular.setRGB(0, 0, 0);
      const m = new gMesh.constructor(geo, mat);
      m.raycast = () => {}; // invisible to hover / click picking
      // Drawn first among the transparent layers. It writes no depth, so the
      // footprint fill / paths drawn after it blend over it everywhere. With a
      // later renderOrder the shell was depth-tested against the footprint
      // fill (which writes depth): its flat facets poked through the fill's
      // own facets as dark diamonds and the rest of the fill hid the night.
      m.renderOrder = -1;
      m.name = "night-shell";
      // Sibling of the globe mesh, unrotated: same frame as G.getCoords().
      gMesh.parent.add(m);
      nightMesh = m;
    } catch (e) {
      nightMesh = false;
      console.warn("Globe night shell unavailable", e);
    }
    return nightMesh;
  }

  /** Recompute night shading / terminator / sun spot (cheap; at most once a minute). */
  function updateSun(force) {
    if (!window.sunCalc || !G) return;
    const now = Date.now();
    if (!force && now - sunAt < 60000) return;
    sunAt = now;
    const sc = window.sunCalc;
    const sun = sc.subsolar(new Date(now));
    sunMark.lat = sun.lat;
    sunMark.lng = sun.lon;
    terminatorPath.pts = sc.terminator(sun, -180, 180, 3).map((q) => [q[0], q[1], 0.003]);
    const m = ensureNightMesh();
    if (!m) { if (m === null) sunAt = 0; return; }
    const c = G.getCoords(sun.lat, sun.lon, 0);
    const cl = Math.hypot(c.x, c.y, c.z) || 1;
    const sx = c.x / cl, sy = c.y / cl, sz = c.z / cl;
    const pos = m.geometry.attributes.position, col = m.geometry.attributes.color;
    const P = pos.array, C = col.array;
    for (let i = 0, k = 0; i < pos.count; i++, k += 3) {
      const x = P[k], y = P[k + 1], z = P[k + 2];
      const cosZ = (x * sx + y * sy + z * sz) / (Math.hypot(x, y, z) || 1); // cos(sun zenith angle)
      C[i * 4 + 2] = 0.02;
      C[i * 4 + 3] = NIGHT_ALPHA * Math.min(1, Math.max(0, 0.5 - cosZ * 9));
    }
    col.needsUpdate = true;
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
      if (d === hoverDot && d.sel) hoverOff(d); // became the selected sat: it has its own label
    } else if (d.kind === "station") {
      const t = d.el.lastChild;
      if (t && t.textContent !== d.text) t.textContent = d.text;
    } else if (d.kind === "dx") {
      const t = d.el.lastChild;
      if (t && t.textContent !== d.text) t.textContent = d.text;
    }
  }

  /**
   * DX station from the Log box callsign lookup (window.qsoDxGrid): yellow dot
   * + great-circle line from the home marker. Both ends use the exact marker
   * lat/lng/alt; ~1 point per 0.5 deg of arc (min 64) so it hugs the surface.
   * Stable objects (moved in place), recomputed only when an end moves.
   */
  let dxSig = "";
  function dxItems() {
    const q = window.qsoDxGrid;
    if (!q || !q.grid || typeof maidenheadToLatLon !== "function") return null;
    const ll = maidenheadToLatLon(q.grid);
    if (!ll) return null;
    dxMark.lat = ll.lat; dxMark.lng = ll.lon; dxMark.text = q.call + " " + q.grid;
    styleDot(dxMark);
    const out = { mk: dxMark, path: null };
    if (stLabel.lat || stLabel.lng) {
      const sig = [stLabel.lat, stLabel.lng, ll.lat, ll.lon].join(",");
      if (sig !== dxSig) {
        dxSig = sig;
        dxPath.pts = window.globeGcLine({ lat: stLabel.lat, lon: stLabel.lng }, { lat: ll.lat, lon: ll.lon }, MARK_ALT);
      }
      out.path = dxPath;
    }
    return out;
  }

  /**
   * WSJT-X heard stations (window.decodeOverlay from js/decode-overlay.js).
   * One stable datum per callsign (moved / restyled in place); the list is
   * empty while the map's "WSJT Heard" toggle is off.
   */
  const heard = new Map();
  function paintHeard(d) {
    const e = d.el;
    if (!e) return;
    const inner = e.firstChild;
    if (!inner) return;
    inner.style.opacity = String(d.opacity);
    const call = inner.querySelector(".dc-call"), grid = inner.querySelector(".dc-grid");
    if (call.textContent !== d.call) call.textContent = d.call;
    if (grid.textContent !== d.grid) grid.textContent = d.grid;
    const dot = inner.firstChild;
    if (dot.title !== d.tip) { dot.title = d.tip; dot.setAttribute("aria-label", d.tip); }
  }
  function heardItems() {
    const dov = window.decodeOverlay;
    const list = dov && typeof dov.items === "function" ? dov.items() : [];
    const seen = new Set();
    for (const s of list) {
      let d = heard.get(s.call);
      if (!d) { d = { kind: "heard", key: "__heard:" + s.call, alt: 0.006 }; heard.set(s.call, d); }
      d.call = s.call; d.grid = s.grid; d.lat = s.lat; d.lng = s.lon; d.opacity = s.opacity; d.tip = s.tip;
      seen.add(s.call);
      paintHeard(d);
    }
    for (const k of [...heard.keys()]) if (!seen.has(k)) heard.delete(k);
    return [...heard.values()];
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
    if (terminatorPath.pts.length > 1) paths.push(terminatorPath);
    const dx = dxItems();
    if (dx && dx.path) paths.push(dx.path);
    G.pathsData(paths);
  }

  /**
   * Selected-sat label. Pass preview keeps the old "NAME · ALT km @ HH:MM" text;
   * live: line 1 = name + AOS/LOS countdown + clock, line 2 = El / Range / Alt
   * (satDotLabelLines in pass-ui.js). Two lines are joined with "\n" (white-space: pre).
   */
  /* ---------- hover: same stacked label as the selected sat ---------- */
  // Non-selected dots (favorites): on mouseenter a label child is added to the
  // dot (pointer-events: none, so picking/click-to-select are unchanged) with
  // satDotLabelLines() of that sat's favorites snapshot; it ticks with the
  // selected label (1 s) and is removed on mouseleave. One live label at most.
  let hoverDot = null;
  function favSnapshot(key) {
    const list = (lastState && lastState.favorites) || [];
    for (const f of list) if (f && f.key === key) return f;
    return null;
  }
  function hoverText(d) {
    const f = favSnapshot(d.key);
    if (!f || !f.position) return d.display || d.key;
    const pp = window.passPreview;
    const pv = pp && pp.posOf && pp.posOf(d.key);
    return selLabelText(pv ? Object.assign({}, f, { position: pv.position }) : f, pv ? previewT() : null);
  }
  function paintHover() {
    const d = hoverDot;
    if (!d || !d.el) return;
    let lab = d.el.__hoverLabel;
    if (!lab || lab.parentNode !== d.el) {
      lab = document.createElement("div");
      lab.className = "globe-label globe-hover-label";
      d.el.appendChild(lab);
      d.el.__hoverLabel = lab;
    }
    const txt = hoverText(d);
    if (lab.textContent !== txt) lab.textContent = txt;
    lab.classList.toggle("globe-label-2l", txt.indexOf("\n") >= 0);
    lab.style.borderLeft = "2px solid " + (d.color || "#fff");
    d.el.classList.add("globe-dot-hover");
  }
  function hoverOn(d) {
    if (!d || d.sel || (lastState && d.key === lastState.sat)) return; // selected sat already labelled
    if (hoverDot && hoverDot !== d) hoverOff(hoverDot);
    hoverDot = d;
    if (d.el) { d.el.__title = d.el.title; d.el.title = ""; } // no native tooltip on top
    paintHover();
  }
  function hoverOff(d) {
    if (!d || hoverDot !== d) return;
    hoverDot = null;
    const e = d.el;
    if (!e) return;
    if (e.__hoverLabel) { e.__hoverLabel.remove(); e.__hoverLabel = null; }
    e.classList.remove("globe-dot-hover");
    if (e.__title != null) { e.title = e.__title; e.__title = null; }
  }

  function selLabelText(st, pT) {
    if (pT) return (st.display || st.sat) + " \u00B7 " + Math.round(st.position.heightKm || 0) + " km" + " @ " + (typeof formatClockShort === "function" ? formatClockShort(pT) : new Date(pT).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    const L = typeof satDotLabelLines === "function" ? satDotLabelLines(st) : null;
    if (!L) return (st.display || st.sat) + " \u00B7 " + Math.round(st.position.heightKm || 0) + " km";
    return L.l2 ? L.l1 + "\n" + L.l2 : L.l1;
  }
  function paintSelLabel() {
    if (!selLabel.el) return;
    if (selLabel.el.textContent !== selLabel.text) selLabel.el.textContent = selLabel.text;
    selLabel.el.classList.toggle("globe-label-2l", selLabel.text.indexOf("\n") >= 0);
  }
  // Countdown ticks each second between (2 s-throttled) state applies; redraw on UTC/MT toggle.
  function tickSelLabel() {
    if (hoverDot) { if (!hoverDot.el || !hoverDot.el.isConnected || !pts.has(hoverDot.key)) hoverOff(hoverDot); else paintHover(); }
    if (!G || mode !== "globe" || !lastState || !lastState.position) return;
    if (previewT() != null) return; // preview label is static; applyState handles it
    selLabel.text = selLabelText(lastState, null);
    paintSelLabel();
  }
  setInterval(tickSelLabel, 1000);
  window.addEventListener("time-mode-change", () => { applyState(true); if (hoverDot) paintHover(); });
  document.addEventListener("qso-dx-change", () => applyState(true));
  document.addEventListener("decode-overlay-change", () => applyState(true));

  /** Live positions (moved in place), footprint and labels. */
  function applyState(force) {
    if (!G || mode !== "globe" || !lastState) return;
    const now = Date.now();
    if (!force && now - lastApply < 2000) return;
    lastApply = now;
    placeStation(false); // follows profile / grid changes (label + DX line start)
    // Pass preview: draw the selected sat + favorites at the preview time.
    const pp = window.passPreview;
    const pvSel = pp && lastState && pp.posOf(lastState.sat);
    const pT = pvSel ? pp.get() : null;
    const st = !pp || !pp.get() ? lastState : Object.assign({}, lastState, {
      position: pvSel ? pvSel.position : lastState.position,
      favorites: (lastState.favorites || []).map((f) => { const v = f && pp.posOf(f.key); return v ? Object.assign({}, f, { position: v.position }) : f; }),
    });
    const keep = new Set();
    if (st.position && Number.isFinite(st.position.lat)) {
      const p = point(st.sat);
      // While following, keep the integrator's position so applyState's 1 s
      // server sample can't snap the marker (the rAF loop owns lat/lng/alt).
      const fp = (follow.key === st.sat && !pT) ? followPos() : null;
      const use = fp || st.position;
      p.lat = use.lat; p.lng = use.lon; p.alt = (use.heightKm || 0) / RE_KM;
      p.color = selColor(); p.sel = true; p.display = st.display || st.sat;
      keep.add(st.sat);
      selLabel.lat = p.lat; selLabel.lng = p.lng; selLabel.alt = p.alt;
      selLabel.text = selLabelText(st, pT);
      if (pT) p.color = "#e3b341";
      paintSelLabel();
      footprint.pts = footprintPts(p.lat, p.lng, use.heightKm || 0);
      if (snapKey && snapKey === st.sat) {
        snapKey = null;
        const lp = (lastState && lastState.position) || st.position; // live sub-point (follow tracks the live sat)
        centerOn(lp.lat, lp.lon);
        if (follow.key === st.sat) {
          follow.since = Date.now() + 900;
          follow.lat = follow.lng = follow.alt = null;
          follow.vLat = follow.vLng = follow.vAlt = 0;
          follow.pullLat = follow.pullLng = follow.pullAlt = 0;
          follow.samples = [];
          if (lastState) followSample(lastState);
        }
      }
      fpShade.geometry.coordinates = [footprint.pts.map((q) => [q[1], q[0]])];
      G.polygonsData([fpShade]);
    }
    updateSun(false);
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
    const extra = [];
    if (pT && lastState.position) { ghost.lat = lastState.position.lat; ghost.lng = lastState.position.lon; ghost.alt = (lastState.position.heightKm || 0) / RE_KM; extra.push(ghost); }
    const dx = dxItems();
    if (dx) extra.push(dx.mk);
    if (sunMark.lat || sunMark.lng) extra.push(sunMark);
    G.htmlElementsData(heardItems().concat([...pts.values(), stLabel]).concat(st.position ? [selLabel] : [], extra));
    // footprint moves with the sat: refresh paths cheaply (same orbit arrays)
    if (orbits) renderPaths();
    else G.pathsData((footprint.pts.length > 1 ? [footprint] : []).concat(terminatorPath.pts.length > 1 ? [terminatorPath] : [], dx && dx.path ? [dx.path] : []));
  }

  function onVisibility() {
    if (!G) return;
    if (document.hidden || mode !== "globe") G.pauseAnimation();
    else {
      G.resumeAnimation();
      if (follow.key && !follow.raf) { follow.lastFrame = 0; follow.raf = requestAnimationFrame(followFrame); }
    }
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
        updateSun(true);
        requestOrbits();
        applyState(true);
        // 60 s: orbits + sun / terminator / night shading
        if (!orbitTimer) orbitTimer = setInterval(() => { requestOrbits(); updateSun(true); applyState(true); }, 60000);
      }).catch((e) => {
        console.warn("Globe load failed", e);
        toast("Couldn't load the 3D globe; staying on Map.");
        setMode("map", true);
      });
    } else {
      stopFollow();
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
          if (!!msg.preview !== (previewT() != null)) return; // stale (preview started / ended)
          orbits = msg;
          renderPaths();
        } else if (msg.type === "state") {
          const satChanged = !lastState || lastState.sat !== msg.sat;
          lastState = msg;
          if (follow.key) {
            if (msg.sat === follow.key) followSample(msg);
            else if (snapKey !== msg.sat && Date.now() - follow.since > 5000) stopFollow(); // another sat picked elsewhere
          }
          if (satChanged) { requestOrbits(); applyState(true); }
          else applyState(false);
        }
      } catch (_) {}
    });
    if (ws.readyState === 1) requestOrbits();
    else ws.addEventListener("open", requestOrbits);
  }

  let pvOrbitTimer = null;
  function onPreviewChange() {
    applyState(true);
    clearTimeout(pvOrbitTimer);
    pvOrbitTimer = setTimeout(requestOrbits, 250); // coalesce drags
  }
  function init() {
    document.addEventListener("pass-preview-change", onPreviewChange);
    setInterval(patchWs, 500);
    const t = setInterval(() => { if (addButton()) clearInterval(t); }, 300);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("fav-overlay-change", () => { requestOrbits(); renderPaths(); applyState(true); });
    if (mode === "globe") setMode("globe", false);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
