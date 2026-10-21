/**
 * Pass preview camera memory (globe). When a preview starts, remember the
 * camera mode that was active just before it; when the preview ends for any
 * reason (Back to now, selector / catalog / Favorites / Auto Select / legend
 * pick, a server-side selection), restore it:
 *   { mode: "qth" }            centered on the station: glide back home
 *   { mode: "follow", key }    following a sat: follow the selected sat live
 *   { mode: "free", pov }      free view: restore that camera position
 * A preview that starts while one is already active (another pass clicked)
 * keeps the original pre-preview mode. Picking a sat with no preview active
 * never calls restore.
 *
 * createPreviewCamera({ getMode, restore }) -> { onPreview(on), saved() }
 */
(function (root) {
  function createPreviewCamera(hooks) {
    let saved = null;
    let was = false;
    return {
      onPreview(on) {
        on = !!on;
        if (on && !was) {
          let m = null;
          try { m = hooks.getMode ? hooks.getMode() : null; } catch (_) { m = null; }
          saved = m ? Object.assign({}, m, m.pov ? { pov: Object.assign({}, m.pov) } : {}) : null;
        } else if (!on && was) {
          const m = saved;
          saved = null;
          if (m && hooks.restore) hooks.restore(m);
        }
        was = on;
      },
      saved() { return saved; },
    };
  }
  /** Is pov within tolDeg of the station (lat / lng)? */
  function nearHome(pov, home, tolDeg) {
    if (!pov || !home || !Number.isFinite(pov.lat) || !Number.isFinite(home.lat)) return false;
    const dLng = Math.abs(((((pov.lng - home.lng) + 180) % 360) + 360) % 360 - 180);
    return Math.abs(pov.lat - home.lat) <= tolDeg && dLng <= tolDeg;
  }
  root.createPreviewCamera = createPreviewCamera;
  root.previewCameraNearHome = nearHome;
  if (typeof module !== "undefined" && module.exports) module.exports = { createPreviewCamera, nearHome };
})(typeof window !== "undefined" ? window : globalThis);
