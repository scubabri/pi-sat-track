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
  // Moon (EME): ~60 Earth radii out, so its marker sits just above the
  // sub-lunar point instead; the footprint still uses the real distance.
  const MOON_MARK_ALT = 0.02;
  const stLabel = { kind: "station", lat: 0, lng: 0, alt: MARK_ALT, text: "\u2302 Station" };
  const dxMark = { kind: "dx", lat: 0, lng: 0, alt: MARK_ALT, text: "" };
  const dxPath = { key: "__dx", footprint: true, color: "#ffd34d", w: 0.6, pts: [] };
  const footprint = { key: "__fp", footprint: true, color: "rgba(88,166,255,0.95)", w: 1.1, pts: [] };
  // Selected-sat footprint is a persistent three.js group (fill + ring), built
  // once and reoriented each frame — globe.gl's polygonsData leaked meshes and
  // left a painted trail when refreshed at follow rates (see ensureFpMesh).
  const fpShade = { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[]] } }; // unused for selected sat; kept so old refs don't throw
  let fpMesh = null; // { group, fill, ring, lam, R } | false if unavailable
  let fpLam = -1;
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
        if (!downAt || !e.buttons) return;
        if (Math.abs(e.clientX - downAt.x) + Math.abs(e.clientY - downAt.y) > 4) { downAt = null; homeLock = false; if (follow.key) stopFollow(); }
      });
      el.addEventListener("pointermove", (e) => { if (e.pointerType !== "touch") mouseAt = { x: e.clientX, y: e.clientY }; });
      el.addEventListener("pointerleave", () => { mouseAt = null; if (hoverDot) hoverOff(hoverDot); });
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
            // Favorite dot + its name label (like the map's fav-overlay.js): name
            // only, the full selected-sat content while hovered. The dot, the
            // label and a few px of slop around each are the hover / click target.
            e.className = "globe-dot";
            e.__d = d;
            const lab = document.createElement("div");
            lab.className = "globe-label globe-fav-label";
            e.appendChild(lab);
            e.__favLabel = lab;
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
            // APRS heard stations (js/aprs-overlay.js) reuse it with .globe-aprs styling.
            e.className = "globe-heard" + (d.src === "aprs" ? " globe-aprs" : "");
            e.innerHTML = '<div class="globe-heard-in"><span class="globe-heard-dot"></span><span class="globe-heard-label"><span class="dc-call"></span><span class="dc-grid"></span></span></div>';
            d.el = e;
            paintHeard(d);
            if (d.src === "aprs") {
              const dot = e.querySelector(".globe-heard-dot");
              dot.style.cursor = "pointer";
              dot.addEventListener("click", (ev) => {
                ev.stopPropagation();
                if (window.aprsOverlay && window.aprsOverlay.showPopup) window.aprsOverlay.showPopup(d.call, ev.clientX, ev.clientY);
              });
            }
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
        .pathDashLength(1)
        .pathDashGap(0)
        .onPathClick(pick);
      // Never animate polygon morphs — leftover tween meshes painted the footprint trail.
      try { G.polygonsData([]); } catch (_) {}
      try { G.renderer().setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5)); } catch (_) {}
      const fit = () => { if (el && G && mode === "globe") G.width(el.clientWidth).height(el.clientHeight); };
      if (typeof ResizeObserver === "function") new ResizeObserver(fit).observe(host);
      fit();
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(POV_KEY) || "null"); } catch (_) {}
      const ok = saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lng) && Number.isFinite(saved.altitude);
      placeStation(!ok);
      homeLock = !ok || window.previewCameraNearHome({ lat: saved.lat, lng: saved.lng }, stLabel, 0.5);
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
   * following, followFrame glides the camera to the preview position itself.
   * Returns true if handled.
   */
  window.globeCenterOn = function (lat, lng, opts) {
    if (mode !== "globe" || !G || !Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    // Preview of the followed sat: followFrame glides the camera there itself.
    if (opts && opts.preview && follow.key && (!opts.key || opts.key === follow.key)) return true;
    stopFollow();
    if (!(opts && opts.preview)) homeLock = !!(opts && opts.home); // the station button: QTH-centered
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
   * marker/label from that same smoothed state. Footprint is a persistent
   * three.js mesh reoriented each frame (no polygonsData churn / trail).
   */
  let homeLock = false; // centered on the station (the station button / initial view) until a drag or another center
  const follow = {
    key: null, raf: 0, since: 0, lastFrame: 0,
    // integrated state (deg, deg, earth-radii) and velocity (deg/ms, deg/ms, radii/ms)
    lat: null, lng: null, alt: null, vLat: 0, vLng: 0, vAlt: 0,
    pullLat: 0, pullLng: 0, pullAlt: 0, // residual sample error, bled out over ~1 s
    samples: [], // up to 2 {t, lat, lng, alt}
    camLat: null, camLng: null, blendUntil: 0, pvWas: false, // camera (preview-aware)
  };
  function wrap180(x) { return ((((x + 180) % 360) + 360) % 360) - 180; }
  function startFollow(key) {
    homeLock = false;
    follow.key = key;
    follow.since = Date.now() + 900; // let the 800 ms snap tween finish first
    follow.samples = [];
    follow.lat = follow.lng = follow.alt = null;
    follow.vLat = follow.vLng = follow.vAlt = 0;
    follow.pullLat = follow.pullLng = follow.pullAlt = 0;
    follow.lastFrame = 0;
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
    const alt = msg.isMoon ? MOON_MARK_ALT : (Number.isFinite(p.heightKm) ? p.heightKm : 0) / RE_KM;
    follow.fpKm = msg.isMoon && Number.isFinite(p.heightKm) ? p.heightKm : null;
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
    // Pass preview: the camera centers on the sat's PREVIEW sub-point, and the
    // marker / label / footprint stay where applyState put them (at the preview
    // time). The integrator keeps tracking the live sat so "Back to now" resumes.
    const pv = window.passPreview && window.passPreview.posOf ? window.passPreview.posOf(follow.key) : null;
    const tgt = pv && pv.position && Number.isFinite(pv.position.lat)
      ? { lat: pv.position.lat, lng: pv.position.lon }
      : { lat: follow.lat, lng: follow.lng };
    const pvNow = !!(pv && pv.position);
    if (pvNow !== follow.pvWas) { follow.pvWas = pvNow; follow.blendUntil = now + 1500; }
    const cam = followCamera(follow, tgt, dt, now);
    const pov = G.pointOfView();
    G.pointOfView({ lat: cam.lat, lng: cam.lng, altitude: pov.altitude }, 0);
    if (pvNow) return;
    // Move the selected sat marker + label in place (globe.gl re-reads lat/lng
    // each frame; no htmlElementsData rebuild).
    const p = pts.get(follow.key);
    if (p && p.sel) {
      p.lat = follow.lat; p.lng = follow.lng; p.alt = follow.alt;
      selLabel.lat = follow.lat; selLabel.lng = follow.lng; selLabel.alt = follow.alt;
      orientFpMesh(follow.lat, follow.lng, follow.fpKm != null ? follow.fpKm : follow.alt * RE_KM);
    }
  }
  /**
   * Follow camera: locked on the target, except for ~1.5 s after a preview
   * starts / ends, when it glides there (no snap across the globe).
   */
  function followCamera(f, tgt, dt, now) {
    if (f.camLat == null || !(now < (f.blendUntil || 0))) {
      f.camLat = tgt.lat; f.camLng = tgt.lng;
    } else {
      const a = 1 - Math.exp(-Math.max(0, dt) / 220);
      f.camLat += (tgt.lat - f.camLat) * a;
      f.camLng = wrap180(f.camLng + wrap180(tgt.lng - f.camLng) * a);
    }
    return { lat: f.camLat, lng: f.camLng };
  }
  window.globeFollowing = () => follow.key;
  window.__fpMesh = () => fpMesh;
  /** Debug / headless checks: selected marker + camera (deg). */
  window.__globeSel = () => {
    const p = lastState ? pts.get(lastState.sat) : null;
    const pov = G ? G.pointOfView() : null;
    return { key: lastState && lastState.sat, marker: p ? { lat: p.lat, lng: p.lng } : null, label: { lat: selLabel.lat, lng: selLabel.lng, text: selLabel.text }, pov: pov ? { lat: pov.lat, lng: pov.lng } : null, following: follow.key };
  };
  window.__countFp = () => {
    if (!G) return { fp: 0, poly: 0, named: 0 };
    let fp = 0, poly = 0, named = 0;
    G.scene().traverse((o) => {
      if (o.name === "sat-footprint") fp++;
      if (o.name && o.name.indexOf("sat-footprint") === 0) named++;
      if (o.type === "Mesh" && o.parent && o.parent.__globeObjType === "polygons") poly++;
      if (o.__globeObjType === "polygons") poly++;
    });
    return { fp, named, poly, children: G.scene().children.length };
  };
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
   * Persistent footprint fill + ring (siblings of the globe mesh). Geometry sits
   * on the +Z pole in local space; each frame we only set the group's quaternion
   * so +Z points at the sub-satellite point. Rebuild when the angular radius
   * changes by >0.2 deg (altitude). depthWrite false, renderOrder 0 (after the
   * night shell at -1) — same anti-diamond setup as before.
   */
  function ensureFpMesh() {
    if (fpMesh !== null || !G) return fpMesh;
    try {
      const gm = G.globeMaterial();
      let gMesh = null;
      G.scene().traverse((o) => { if (!gMesh && o.material === gm) gMesh = o; });
      if (!gMesh || !gMesh.parent) return null;
      fpMesh = false;
      const Mesh = gMesh.constructor;
      const SphereGeometry = gMesh.geometry.constructor;
      const Mat = gm.constructor;
      const V3 = G.camera().position.constructor;
      const Quat = G.camera().quaternion.constructor;
      // Group: reuse an empty Object3D via a Mesh we never render, or parent.children.
      // Scene graph: add a Mesh-less holder by cloning the globe mesh's parent API —
      // three.js Object3D is the prototype of Mesh.
      const Object3D = Object.getPrototypeOf(Mesh.prototype).constructor;
      const group = new Object3D();
      group.name = "sat-footprint";
      group.matrixAutoUpdate = true;
      const R = G.getGlobeRadius() * 1.0045; // above night shell (1.003) and globe
      // Placeholder cap; rebuildFpGeom fills real lam.
      const fillGeo = new SphereGeometry(R, 64, 24, 0, Math.PI * 2, 0, 0.01);
      const fillMat = new Mat({
        color: 0x58a6ff, transparent: true, opacity: 0.22,
        depthWrite: false, shininess: 0, side: 2, // DoubleSide
      });
      if (fillMat.specular) fillMat.specular.setRGB(0, 0, 0);
      const fill = new Mesh(fillGeo, fillMat);
      fill.raycast = () => {};
      fill.renderOrder = 0;
      fill.name = "sat-footprint-fill";
      // Ring: thin spherical band (Line width is unreliable in WebGL).
      const ringGeo = new SphereGeometry(R * 1.0003, 96, 3, 0, Math.PI * 2, 0.009, 0.002);
      const ringMat = new Mat({
        color: 0x58a6ff, transparent: true, opacity: 0.95,
        depthWrite: false, shininess: 0, side: 2,
      });
      if (ringMat.specular) ringMat.specular.setRGB(0, 0, 0);
      const ring = new Mesh(ringGeo, ringMat);
      ring.raycast = () => {};
      ring.renderOrder = 1;
      ring.name = "sat-footprint-ring";
      group.add(fill);
      group.add(ring);
      gMesh.parent.add(group);
      fpMesh = { group, fill, ring, lam: -1, R, V3, Quat, SphereGeometry, Mesh, Mat };
      // Drop any leftover globe.gl polygon footprint (stops the trail).
      try { G.polygonsData([]); } catch (_) {}
    } catch (e) {
      fpMesh = false;
      console.warn("Globe footprint mesh unavailable", e);
    }
    return fpMesh;
  }

  function rebuildFpGeom(m, lam) {
    // Cap from the +Z pole down to polar angle `lam`.
    const fillGeo = new m.SphereGeometry(m.R, 64, Math.max(8, Math.ceil(lam * 24)), 0, Math.PI * 2, 0, lam);
    m.fill.geometry.dispose();
    m.fill.geometry = fillGeo;
    const band = m.band || 0.0035; // ~0.2 deg visual width
    const ringGeo = new m.SphereGeometry(m.R * 1.0004, 96, 3, 0, Math.PI * 2, Math.max(0, lam - band / 2), band);
    m.ring.geometry.dispose();
    m.ring.geometry = ringGeo;
    m.lam = lam;
  }

  /** Point the footprint group at (lat,lng) and size it for heightKm. */
  function orientFpMesh(lat, lng, hKm) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !(hKm > 0)) return;
    const m = ensureFpMesh();
    if (!m) return;
    orientFpGroup(m, lat, lng, hKm);
  }
  function orientFpGroup(m, lat, lng, hKm) {
    const lam = Math.acos(RE_KM / (RE_KM + hKm));
    if (!(lam > 1e-4)) { m.group.visible = false; return; }
    m.group.visible = true;
    if (Math.abs(lam - m.lam) > (0.2 * Math.PI) / 180) rebuildFpGeom(m, lam);
    // SphereGeometry's pole is +Y; rotate that to the subpoint (globe.gl coords).
    const c = G.getCoords(lat, lng, 0);
    const target = new m.V3(c.x, c.y, c.z).normalize();
    const q = new m.Quat().setFromUnitVectors(new m.V3(0, 1, 0), target);
    m.group.quaternion.copy(q);
    m.group.updateMatrixWorld(true);
  }

  function hideFpMesh() {
    if (fpMesh && fpMesh.group) fpMesh.group.visible = false;
  }

  /*
   * Favorite footprints (map "Footprints" sub-toggle, js/fav-overlay.js): same
   * rule as the 2D map — Favorites overlay on, Footprints on, favorite shown,
   * not the selected sat, not the Moon, has a position (TLE) and is up or
   * rising within 15 min (window.favFootprintNear). One small fill + ring
   * group per favorite, built with the selected footprint's three.js
   * constructors, moved in applyState (2 s) and disposed when no longer wanted.
   * Styled like the map relative to the selected footprint: the selected globe
   * footprint is fill 0.22 / ring 0.95, a favorite fill 0.08 / ring 0.45 with a
   * thinner ring, slightly below and drawn before the selected one.
   */
  const FAV_FP = { fill: 0.08, ring: 0.45, band: 0.0022, rScale: 1.0040 };
  const favFp = new Map(); // key -> { group, fill, ring, lam, R, band, color, ... }
  function favFpOn() { return favOn() && typeof window.isFavFootprintsOn === "function" && window.isFavFootprintsOn(); }
  /** Favorites (from a state snapshot) that should get a globe footprint now. */
  function favFootprintList(st, now) {
    if (!st || !favFpOn()) return [];
    const near = typeof window.favFootprintNear === "function" ? window.favFootprintNear : null;
    if (!near) return [];
    const shown = typeof window.favOverlayShown === "function" ? window.favOverlayShown() : null;
    const ok = shown ? new Set(shown) : null;
    const out = [];
    for (const f of st.favorites || []) {
      if (!f || f.key === st.sat || f.isMoon || (ok && !ok.has(f.key))) continue;
      const p = f.position;
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon) || !(p.heightKm > 0)) continue;
      if (!near(f, now)) continue;
      out.push(f);
    }
    return out;
  }
  window.__globeFavFpKeys = (st, now) => favFootprintList(st || lastState, now != null ? now : Date.now()).map((f) => f.key); // tests
  window.__globeFavFp = () => favFp; // tests / debug
  function makeFavFp(color) {
    const base = ensureFpMesh();
    if (!base || !base.group || !base.group.parent) return null;
    const R = G.getGlobeRadius() * FAV_FP.rScale;
    const mat = (op) => {
      const m = new base.Mat({ color, transparent: true, opacity: op, depthWrite: false, shininess: 0, side: 2 });
      if (m.specular) m.specular.setRGB(0, 0, 0);
      return m;
    };
    const Object3D = base.group.constructor;
    const group = new Object3D();
    group.name = "fav-footprint";
    const fill = new base.Mesh(new base.SphereGeometry(R, 8, 2, 0, Math.PI * 2, 0, 0.01), mat(FAV_FP.fill));
    fill.raycast = () => {};
    fill.renderOrder = -0.5; // after the night shell (-1), before the selected footprint (0 / 1)
    fill.name = "fav-footprint-fill";
    const ring = new base.Mesh(new base.SphereGeometry(R, 8, 2, 0, Math.PI * 2, 0.009, 0.002), mat(FAV_FP.ring));
    ring.raycast = () => {};
    ring.renderOrder = -0.4;
    ring.name = "fav-footprint-ring";
    group.add(fill);
    group.add(ring);
    base.group.parent.add(group);
    return { group, fill, ring, lam: -1, R, band: FAV_FP.band, color, V3: base.V3, Quat: base.Quat, SphereGeometry: base.SphereGeometry };
  }
  function dropFavFp(key) {
    const m = favFp.get(key);
    if (!m) return;
    favFp.delete(key);
    if (m.group.parent) m.group.parent.remove(m.group);
    for (const o of [m.fill, m.ring]) {
      if (o.geometry && o.geometry.dispose) o.geometry.dispose();
      if (o.material && o.material.dispose) o.material.dispose();
    }
  }
  /** Create / move / drop the favorite footprint groups for this snapshot. */
  function updateFavFootprints(st, now) {
    const want = favFootprintList(st, now);
    const keep = new Set();
    for (const f of want) {
      let m = favFp.get(f.key);
      const col = colorOf(f.key);
      if (!m) { m = makeFavFp(col); if (!m) break; favFp.set(f.key, m); }
      else if (m.color !== col) {
        m.color = col;
        m.fill.material.color.set(col);
        m.ring.material.color.set(col);
      }
      orientFpGroup(m, f.position.lat, f.position.lon, f.position.heightKm);
      keep.add(f.key);
    }
    for (const k of [...favFp.keys()]) if (!keep.has(k)) dropFavFp(k);
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
      const disp = d.el.style.display; // globe.gl hides it (display: none) behind the globe
      d.el.style.cssText = "width:" + px + "px;height:" + px + "px;margin:-" + px / 2 + "px 0 0 -" + px / 2 + "px;background:" + d.color + ";" + (disp ? "display:" + disp + ";" : "");
      if (d === hoverDot && d.sel) hoverOff(d); // became the selected sat: it has its own label
      paintFavLabel(d);
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
    if (d.src === "aprs") {
      e.classList.toggle("aprs-approx", d.posSource === "grid" || d.posSource === "last");
      e.classList.toggle("aprs-self", d.posSource === "self");
      e.classList.toggle("aprs-sat", !!d.viaSat);
      // Actual APRS symbol icon (js/aprs-symbols.js) when known, else the dot.
      const S = window.APRS_SYMBOLS;
      const sym = S && d.symbol && S.parse(d.symbol) ? d.symbol : "";
      if (d._sym !== sym) {
        d._sym = sym;
        const dotEl = inner.firstChild;
        dotEl.innerHTML = sym ? S.html(sym, 20) : "";
        e.classList.toggle("has-sym", !!sym);
      }
    }
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
    // APRS heard stations (window.aprsOverlay from js/aprs-overlay.js), keyed apart from WSJT-X.
    const aov = window.aprsOverlay;
    const alist = aov && typeof aov.items === "function" ? aov.items() : [];
    for (const s of alist) {
      const k = "aprs:" + s.call;
      let d = heard.get(k);
      if (!d) { d = { kind: "heard", src: "aprs", key: "__aprs:" + s.call, alt: 0.006 }; heard.set(k, d); }
      d.call = s.call; d.grid = s.grid; d.lat = s.lat; d.lng = s.lon; d.opacity = s.opacity; d.tip = s.tip;
      d.posSource = s.posSource; d.viaSat = s.viaSat; d.symbol = s.symbol || "";
      seen.add(k);
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
    // Ring comes from the custom fp mesh when available (avoids path rebuild trails).
    if (!(fpMesh && fpMesh.group && fpMesh.group.visible) && footprint.pts.length > 1) paths.push(footprint);
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
  /* ---------- favorites: name label, full label on hover (like the map) ---------- */
  // Same rules as the map (js/fav-overlay.js): every shown favorite other than
  // the selected sat carries a name-only label; hovering its dot or label
  // expands that label in place to the selected-sat content (selSatLabelHtml
  // from js/map.js on the favorites snapshot: name, AOS/LOS countdown + clock,
  // El, Rng, Alt; "NAME @ HH:MM" during a pass preview), ticking each second,
  // and dims the other favorites' labels. The selected sat keeps its own full
  // label. Hover is re-checked under a still pointer while the globe rotates /
  // follows, and ends on mouse leave or when the sat goes behind the globe.
  let hoverDot = null;
  const escG = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  function favSnapshot(key) {
    const list = (lastState && lastState.favorites) || [];
    for (const f of list) if (f && f.key === key) return f;
    return null;
  }
  /** Hovered favorite's full label HTML (same as the map's fav-overlay fullHtml), or null. */
  function favFullHtml(key) {
    const f = favSnapshot(key);
    if (!f) return null;
    const pp = window.passPreview;
    const pv = pp && pp.posOf && pp.posOf(key);
    const pT = pv && pp.get && pp.get() != null ? pp.get() : null;
    const st = pT != null ? Object.assign({}, f, { position: pv.position || f.position }) : f;
    if (typeof selSatLabelHtml === "function") return selSatLabelHtml(st, pT);
    if (!st.position) return escG(st.display || st.key);
    return escG(selLabelText(st, pT)).replace(/\n/, '<br><span class="sel-sat-l2">').replace(/\n/g, "<br>") + (selLabelText(st, pT).indexOf("\n") >= 0 ? "</span>" : "");
  }
  /** Name-only by default, full while hovered; dimmed while another favorite is hovered. */
  function favLabelState(d) {
    if (d.sel || (lastState && d.key === lastState.sat)) return { hidden: true };
    const hk = hoverDot ? hoverDot.key : null;
    const name = escG(d.display || d.key);
    const full = hk === d.key ? favFullHtml(d.key) : null;
    return { hidden: false, html: full || name, full: !!full, hi: hk === d.key, dim: !!hk && hk !== d.key };
  }
  window.__globeFavLabelState = favLabelState; // tests / debug
  function paintFavLabel(d) {
    const lab = d && d.el && d.el.__favLabel;
    if (!lab) return;
    const s = favLabelState(d);
    lab.hidden = s.hidden;
    if (s.hidden) return;
    if (lab.__html !== s.html) { lab.innerHTML = s.html; lab.__html = s.html; }
    lab.classList.toggle("fav-hi", s.hi);
    lab.classList.toggle("fav-full", s.full);
    lab.classList.toggle("fav-dim", s.dim);
    lab.style.borderLeft = s.hi ? "3px solid " + (d.color || "#fff") : "";
    d.el.classList.toggle("globe-dot-hover", s.hi);
  }
  function paintHover() { pts.forEach(paintFavLabel); }
  function hoverOn(d) {
    if (!d || d.sel || (lastState && d.key === lastState.sat)) return; // selected sat already labelled
    if (hoverDot === d) return;
    hoverDot = d;
    paintHover();
  }
  function hoverOff(d) {
    if (!d || hoverDot !== d) return;
    hoverDot = null;
    paintHover();
  }
  function shownOnScreen(e) {
    if (!e || !e.isConnected) return false;
    for (let n = e; n && n !== el; n = n.parentElement) if (n.style && n.style.display === "none") return false;
    return true;
  }
  /** Pointer still while the globe turns: what's under it now (dot / label + slop). */
  let mouseAt = null;
  function recheckHover() {
    if (hoverDot && (!pts.has(hoverDot.key) || !shownOnScreen(hoverDot.el))) hoverOff(hoverDot); // behind the globe / gone
    if (!mouseAt || mode !== "globe" || typeof document.elementFromPoint !== "function") return;
    const t = document.elementFromPoint(mouseAt.x, mouseAt.y);
    const dot = t && t.closest ? t.closest(".globe-dot") : null;
    const d = dot && dot.__d && pts.get(dot.__d.key) === dot.__d ? dot.__d : null;
    if (d && d !== hoverDot) hoverOn(d);
    else if (!d && hoverDot) hoverOff(hoverDot);
  }
  setInterval(recheckHover, 200);

  function selLabelText(st, pT) {
    const D = (km) => (typeof Units !== "undefined" ? Units.dist(km || 0) : Math.round(km || 0) + " km");
    if (pT) return (st.display || st.sat) + " \u00B7 " + D(st.position.heightKm) + " @ " + (typeof formatClockShort === "function" ? formatClockShort(pT) : new Date(pT).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    const L = typeof satDotLabelLines === "function" ? satDotLabelLines(st) : null;
    if (!L) return (st.display || st.sat) + " \u00B7 " + D(st.position.heightKm);
    return L.l2 ? L.l1 + "\n" + L.l2 : L.l1;
  }
  function paintSelLabel() {
    if (!selLabel.el) return;
    if (selLabel.el.textContent !== selLabel.text) selLabel.el.textContent = selLabel.text;
    selLabel.el.classList.toggle("globe-label-2l", selLabel.text.indexOf("\n") >= 0);
  }
  // Countdown ticks each second between (2 s-throttled) state applies; redraw on UTC/MT toggle.
  function tickSelLabel() {
    if (hoverDot) { if (!pts.has(hoverDot.key) || !shownOnScreen(hoverDot.el)) hoverOff(hoverDot); else paintHover(); }
    if (!G || mode !== "globe" || !lastState || !lastState.position) return;
    if (previewT() != null) return; // preview label is static; applyState handles it
    selLabel.text = selLabelText(lastState, null);
    paintSelLabel();
  }
  setInterval(tickSelLabel, 1000);
  window.addEventListener("time-mode-change", () => { applyState(true); if (hoverDot) paintHover(); });
  document.addEventListener("qso-dx-change", () => applyState(true));
  document.addEventListener("units-change", () => { applyState(true); if (hoverDot) paintHover(); });
  document.addEventListener("decode-overlay-change", () => applyState(true));
  document.addEventListener("aprs-overlay-change", () => applyState(true));

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
      favorites: (lastState.favorites || []).map((f) => { const v = f && pp.posOf(f.key); return v ? Object.assign({}, f, { position: v.position, look: v.look || f.look }) : f; }),
    });
    const keep = new Set();
    if (st.position && Number.isFinite(st.position.lat)) {
      const p = point(st.sat);
      // While following, keep the integrator's position so applyState's 1 s
      // server sample can't snap the marker (the rAF loop owns lat/lng/alt).
      const fp = (follow.key === st.sat && !pT) ? followPos() : null;
      const use = fp || st.position;
      const fpKm = st.isMoon ? st.position.heightKm || 0 : use.heightKm || 0;
      p.lat = use.lat; p.lng = use.lon; p.alt = st.isMoon ? MOON_MARK_ALT : (use.heightKm || 0) / RE_KM;
      p.color = selColor(); p.sel = true; p.display = st.display || st.sat;
      keep.add(st.sat);
      selLabel.lat = p.lat; selLabel.lng = p.lng; selLabel.alt = p.alt;
      selLabel.text = selLabelText(st, pT);
      if (pT) p.color = "#e3b341";
      paintSelLabel();
      footprint.pts = footprintPts(p.lat, p.lng, fpKm); // kept for any fallback path consumers
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
      orientFpMesh(p.lat, p.lng, fpKm);
      try { G.polygonsData([]); } catch (_) {}
    } else {
      hideFpMesh();
    }
    updateSun(false);
    if (favOn()) {
      const shown = typeof window.favOverlayShown === "function" ? window.favOverlayShown() : null;
      const ok = shown ? new Set(shown) : null;
      for (const f of st.favorites || []) {
        if (!f || !f.position || f.key === st.sat || (ok && !ok.has(f.key))) continue;
        const p = point(f.key);
        p.lat = f.position.lat; p.lng = f.position.lon; p.alt = f.isMoon ? MOON_MARK_ALT : (f.position.heightKm || 0) / RE_KM;
        p.color = colorOf(f.key); p.sel = false; p.display = f.display || f.key;
        keep.add(f.key);
      }
    }
    updateFavFootprints(st, pp && pp.get && pp.get() != null ? pp.get() : now);
    for (const k of [...pts.keys()]) if (!keep.has(k)) pts.delete(k);
    pts.forEach(styleDot);
    const extra = [];
    if (pT && lastState.position) { ghost.lat = lastState.position.lat; ghost.lng = lastState.position.lon; ghost.alt = lastState.isMoon ? MOON_MARK_ALT : (lastState.position.heightKm || 0) / RE_KM; extra.push(ghost); }
    const dx = dxItems();
    if (dx) extra.push(dx.mk);
    if (sunMark.lat || sunMark.lng) extra.push(sunMark);
    G.htmlElementsData(heardItems().concat([...pts.values(), stLabel]).concat(st.position ? [selLabel] : [], extra));
    // Orbits / terminator / DX paths (footprint ring is the custom mesh).
    if (orbits) renderPaths();
    else {
      const paths = [];
      if (!(fpMesh && fpMesh.group && fpMesh.group.visible) && footprint.pts.length > 1) paths.push(footprint);
      if (terminatorPath.pts.length > 1) paths.push(terminatorPath);
      if (dx && dx.path) paths.push(dx.path);
      G.pathsData(paths);
    }
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
  /**
   * Pre-preview camera mode (js/preview-camera.js): saved when a preview
   * starts, restored when it ends for any reason (Back to now, any sat pick,
   * a server-side selection). Chained previews keep the original mode.
   */
  function cameraMode() {
    if (!G || mode !== "globe") return null;
    if (follow.key) return { mode: "follow", key: follow.key };
    const pov = G.pointOfView();
    if (homeLock || window.previewCameraNearHome(pov, stLabel, 0.5)) return { mode: "qth" };
    return { mode: "free", pov: { lat: pov.lat, lng: pov.lng, altitude: pov.altitude } };
  }
  function restoreCamera(m) {
    if (!G || mode !== "globe" || !m) return;
    if (m.mode === "follow") {
      const key = typeof currentSatKey !== "undefined" && currentSatKey ? currentSatKey : lastState && lastState.sat;
      if (key) { window.globeSnapTo(key); return; } // follow the (newly) selected sat live
    }
    stopFollow();
    snapKey = null;
    if (m.mode === "qth") {
      homeLock = true;
      if (Number.isFinite(stLabel.lat) && (stLabel.lat || stLabel.lng)) centerOn(stLabel.lat, stLabel.lng);
    } else if (m.mode === "free" && m.pov && Number.isFinite(m.pov.lat)) {
      G.pointOfView({ lat: m.pov.lat, lng: m.pov.lng, altitude: m.pov.altitude || 2.2 }, 800);
      setTimeout(() => G.__savePov && G.__savePov(), 900);
    }
  }
  const pvCam = window.createPreviewCamera({ getMode: cameraMode, restore: restoreCamera });
  window.__globePreviewCam = { saved: () => pvCam.saved(), mode: cameraMode, homeLock: () => homeLock }; // debug / tests
  function onPreviewChange() {
    pvCam.onPreview(previewT() != null);
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
    document.addEventListener("fav-footprints-change", () => applyState(true));
    if (mode === "globe") setMode("globe", false);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
