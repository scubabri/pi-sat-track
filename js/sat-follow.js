/**
 * Follow satellite: ONE shared on/off state for "keep the selected sat
 * centered", used by
 *  - the map's top-right "Follow satellite" button (js/map.js), lit while on;
 *  - the 3D globe follow (js/globe-view.js; also started by clicking a sat
 *    name in the elevation chart's Favorites legend), which listens here and
 *    reports its own starts / stops (drag of the globe, center buttons);
 *  - the 2D map follower below (same rAF integrator idea as the globe:
 *    velocity from the last two 1 s server positions, sample error bled in
 *    over ~400 ms, so the map glides instead of jumping once a second).
 * Persisted in localStorage like the other view toggles. Ends on a manual
 * drag / pan of the map or globe and on the station / mid-Atlantic center
 * buttons; wheel zoom keeps following; a newly selected sat is followed; a
 * pass preview centers on the previewed position, "Back to now" glides back
 * to the live sat.
 *
 * API: window.satFollow.{isOn, set(on, {source}), toggle, canFollow,
 *   onMapState(state), smoothPos(key), __frame(now)}.
 * Event: "sat-follow-change" on document (detail.on, detail.source).
 */
(function (root) {
  const LS_KEY = "satFollow";

  /** Pure follow integrator (2D map), shared shape with the globe's. */
  function wrap180(x) { return ((((x + 180) % 360) + 360) % 360) - 180; }
  function createIntegrator() {
    const f = { key: null, lat: null, lng: null, vLat: 0, vLng: 0, pullLat: 0, pullLng: 0, samples: [], lastFrame: 0,
      camLat: null, camLng: null, blendUntil: 0, pvWas: false };
    return {
      f,
      reset(key, now) {
        f.key = key; f.samples = []; f.lat = f.lng = null; f.vLat = f.vLng = 0; f.pullLat = f.pullLng = 0; f.lastFrame = 0;
        if (f.camLat != null) f.blendUntil = now + 1500; // glide from where the view is to the new sat
      },
      sample(key, lat, lng, now) {
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        if (key !== f.key) this.reset(key, now);
        const q = f.samples;
        q.push({ t: now, lat, lng });
        if (q.length > 2) q.shift();
        if (f.lat == null) {
          f.lat = lat; f.lng = lng;
          if (f.camLat != null) f.blendUntil = now + 1500; // first fix after a sat switch: glide there
          if (q.length === 2 && q[1].t - q[0].t > 0) { const dt = q[1].t - q[0].t; f.vLat = (q[1].lat - q[0].lat) / dt; f.vLng = wrap180(q[1].lng - q[0].lng) / dt; }
          return;
        }
        f.pullLat = lat - f.lat;
        f.pullLng = wrap180(lng - f.lng);
        if (q.length === 2) {
          const dt = q[1].t - q[0].t;
          if (dt > 50) {
            f.vLat = f.vLat * 0.4 + ((q[1].lat - q[0].lat) / dt) * 0.6;
            f.vLng = f.vLng * 0.4 + (wrap180(q[1].lng - q[0].lng) / dt) * 0.6;
          }
        }
      },
      /** Advance to `now`; returns the camera target {lat, lng} or null. pv: preview sub-point or null. */
      step(now, pv) {
        if (f.lat != null) {
          const dt = Math.min(64, Math.max(0, now - (f.lastFrame || now)));
          f.lastFrame = now;
          if (dt > 0) {
            const a = 1 - Math.exp(-dt / 400);
            f.lat += f.vLat * dt + f.pullLat * a;
            f.lng = wrap180(f.lng + f.vLng * dt + f.pullLng * a);
            f.pullLat *= 1 - a; f.pullLng *= 1 - a;
          }
        }
        const tgt = pv ? { lat: pv.lat, lng: pv.lng } : f.lat != null ? { lat: f.lat, lng: f.lng } : null;
        if (!tgt) return null;
        if (!!pv !== f.pvWas) { f.pvWas = !!pv; if (f.camLat != null) f.blendUntil = now + 1500; }
        const dtc = Math.min(64, Math.max(0, now - (f.camAt != null ? f.camAt : now)));
        f.camAt = now;
        if (f.camLat == null || !(now < f.blendUntil)) { f.camLat = tgt.lat; f.camLng = tgt.lng; }
        else {
          const a = 1 - Math.exp(-dtc / 220);
          f.camLat += (tgt.lat - f.camLat) * a;
          f.camLng = wrap180(f.camLng + wrap180(tgt.lng - f.camLng) * a);
        }
        return { lat: f.camLat, lng: f.camLng };
      },
      pos() { return f.lat != null ? { lat: f.lat, lon: f.lng } : null; },
    };
  }

  const api = { createIntegrator, wrap180 };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; return; }

  /* ---------------- browser ---------------- */
  let on = false;
  try { on = localStorage.getItem(LS_KEY) === "1"; } catch (_) {}
  const integ = createIntegrator();
  let raf = 0;
  let lastState = null; // last live "state" seen by js/map.js
  const NO_POS_MS = 8000; // switched to a sat with no position (no TLE): stop following after this
  let targetKey = null; // selected sat being followed
  let targetSince = 0;
  let switched = false; // targetKey came from a selection change (not page load)

  function selKey() { return typeof currentSatKey !== "undefined" && currentSatKey ? currentSatKey : lastState && lastState.sat; }
  function globeMode() { return !!(document.body && document.body.classList.contains("globe-mode")); }
  function leaflet() { return typeof map !== "undefined" && map ? map : null; }

  /** Selected sat with a computed position (TLE known, or the Moon's sub-lunar point). */
  function canFollow() {
    const k = selKey();
    const p = lastState && lastState.position;
    return !!(k && lastState && lastState.sat === k && p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
  }

  function hasPos(key) {
    const p = lastState && lastState.sat === key ? lastState.position : null;
    return !!(p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
  }
  /**
   * Selected sat changed while following (top selector, Favorites, chart,
   * Sked Finder, another client ...: all end up in currentSatKey): follow the
   * new sat right away (globe via "sat-follow-target"); no position for it
   * within NO_POS_MS (no TLE) -> stop following instead of sticking on the old one.
   */
  function checkTarget(now) {
    if (!on) { targetKey = null; return; }
    const k = selKey();
    if (k !== targetKey) {
      switched = targetKey != null;
      targetKey = k;
      targetSince = now;
      if (!k) { set(false, { source: "nosat" }); return; }
      if (integ.f.key !== k) integ.reset(k, now);
      document.dispatchEvent(new CustomEvent("sat-follow-target", { detail: { key: k } }));
    }
    if (switched && k && !hasPos(k) && now - targetSince > NO_POS_MS) set(false, { source: "nosat" });
  }

  function set(next, opts) {
    next = !!next;
    if (next === on) { syncButtons(); return; }
    on = next;
    try { localStorage.setItem(LS_KEY, on ? "1" : "0"); } catch (_) {}
    targetKey = null;
    switched = false;
    if (on) {
      integ.f.camLat = null;
      integ.reset(null, Date.now());
      checkTarget(Date.now());
      if (!on) return; // nothing selected: checkTarget turned it back off
      if (lastState) onMapState(lastState);
    }
    syncButtons();
    kick();
    document.dispatchEvent(new CustomEvent("sat-follow-change", { detail: { on, source: (opts && opts.source) || "" } }));
  }

  function syncButtons() {
    const ok = canFollow();
    document.querySelectorAll(".map-follow-btn").forEach((b) => {
      b.classList.toggle("on", on);
      b.classList.toggle("disabled", !ok && !on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.setAttribute("aria-disabled", !ok && !on ? "true" : "false");
      const t = on ? "Follow satellite (on) \u2014 click to stop" : ok ? "Follow satellite" : "Follow satellite (select a satellite first)";
      if (b.title !== t) b.title = t;
    });
  }

  function toggle() {
    if (!on && !canFollow()) { syncButtons(); return false; }
    set(!on, { source: "button" });
    return on;
  }

  /** js/map.js updateMapTracking: every live state (before preview substitution). */
  function onMapState(st) {
    if (!st) return;
    lastState = st;
    const p = st.position;
    const cur = typeof currentSatKey !== "undefined" ? currentSatKey : null;
    if (on && p && (!cur || st.sat === cur)) integ.sample(st.sat, p.lat, p.lon, Date.now()); // not a stale state of the previous sat
    checkTarget(Date.now());
    kick();
  }

  /** Smoothed live position of `key` while 2D-following (marker uses it: no 1 Hz snap). */
  function smoothPos(key) {
    if (!on || globeMode() || integ.f.key !== key) return null;
    return integ.pos();
  }

  function previewPos(key) {
    const pp = window.passPreview;
    const d = pp && pp.posOf ? pp.posOf(key) : null;
    return d && d.position && Number.isFinite(d.position.lat) ? { lat: d.position.lat, lng: d.position.lon } : null;
  }

  function pxOff(m, lat, lng) {
    if (!m.latLngToContainerPoint || !m.getSize) return Infinity;
    const pt = m.latLngToContainerPoint([lat, lng]);
    const sz = m.getSize();
    return Math.max(Math.abs(pt.x - sz.x / 2), Math.abs(pt.y - sz.y / 2));
  }
  function pxDist(m, ll, p) {
    const a = m.latLngToContainerPoint(ll);
    const b = m.latLngToContainerPoint([p.lat, p.lon]);
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  }

  function frame(now) {
    const m = leaflet();
    checkTarget(now);
    if (!on || globeMode() || !m) return false;
    const key = integ.f.key;
    if (!key) return false;
    const pv = previewPos(key);
    const tgt = integ.step(now, pv);
    if (!tgt) return true;
    // Leaflet pans in whole pixels: only move when the target is >= 1/2 px off
    // center (a pan per frame for a sub-pixel change just costs repaints on a Pi).
    if (!m._animatingZoom && pxOff(m, tgt.lat, tgt.lng) >= 0.5) m.setView([tgt.lat, tgt.lng], m.getZoom(), { animate: false });
    // Move the selected marker + footprint with the integrator (live view only).
    if (!pv && typeof satMarker !== "undefined" && satMarker && satMarker.__sat === key) {
      const p = integ.pos();
      const ll = p && satMarker.getLatLng ? satMarker.getLatLng() : null;
      if (p && (!ll || !m.latLngToContainerPoint || pxDist(m, ll, p) >= 0.5)) {
        satMarker.setLatLng([p.lat, p.lon]);
        if (typeof footprintCircle !== "undefined" && footprintCircle && !(lastState && lastState.isMoon)) footprintCircle.setLatLng([p.lat, p.lon]);
      }
    }
    return true;
  }

  function loop() {
    raf = 0;
    if (document.hidden) { integ.f.lastFrame = 0; return; }
    if (frame(Date.now())) raf = requestAnimationFrame(loop);
  }
  function kick() {
    if (!raf && on && !globeMode() && leaflet() && !document.hidden) raf = requestAnimationFrame(loop);
  }

  function wireMap() {
    const m = leaflet();
    if (!m || m.__satFollowWired) return !!m;
    m.__satFollowWired = true;
    // A manual drag / pan ends following (wheel / +/- zoom keeps it).
    m.on("dragstart", () => { if (on) set(false, { source: "drag" }); });
    return true;
  }

  root.satFollow = Object.assign(api, {
    isOn: () => on, set, toggle, canFollow, onMapState, smoothPos, syncButtons,
    __frame: frame, __integ: integ, __checkTarget: checkTarget, NO_POS_MS,
  });

  document.addEventListener("visibilitychange", () => { integ.f.lastFrame = 0; kick(); });
  document.addEventListener("pass-preview-change", kick);
  const t = setInterval(() => { if (wireMap()) clearInterval(t); }, 300);
  setInterval(() => { checkTarget(Date.now()); syncButtons(); kick(); }, 1000);
})(typeof window !== "undefined" ? window : globalThis);
