/**
 * Map-corner gauges (sky radar, rotor AZ/EL): drawn in a fixed 220-unit
 * logical space, rendered at GAUGE_PX CSS px with a devicePixelRatio backing
 * store (crisp, no bitmap scaling). Fonts get a boost so labels stay legible
 * at the smaller size.
 */
const GAUGE_LOGICAL = 220;
const GAUGE_FONT_BOOST = 1.7; // logical font px multiplier (11px -> ~9.4 CSS px at 110)

function gaugeCssPx() {
  const w = window.innerWidth || 1280;
  return w < 600 ? 84 : w < 1000 ? 96 : 110;
}

/** Size canvas backing store for current CSS size + DPR; returns ctx with logical transform. */
function setupGaugeCanvas(canvas) {
  if (!canvas) return null;
  const css = gaugeCssPx();
  const dpr = window.devicePixelRatio || 1;
  const px = Math.round(css * dpr);
  canvas.style.width = css + "px";
  canvas.style.height = css + "px";
  if (canvas.width !== px) canvas.width = px;
  if (canvas.height !== px) canvas.height = px;
  const ctx = canvas.getContext("2d");
  const s = px / GAUGE_LOGICAL;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  return ctx;
}

/** Logical font string (size boosted for legibility at the reduced size). */
function gaugeFont(px, family, bold) {
  return (bold ? "bold " : "") + Math.round(px * GAUGE_FONT_BOOST) + "px " + family;
}

/** Re-setup + redraw all gauges when DPR or breakpoint changes. */
(function () {
  let last = "";
  function check() {
    const sig = (window.devicePixelRatio || 1) + "|" + gaugeCssPx();
    if (sig === last) return;
    const first = !last;
    last = sig;
    if (first) return;
    if (typeof reinitGaugeCanvases === "function") reinitGaugeCanvases();
  }
  window.addEventListener("resize", check);
  check();
})();

/** Column if it fits in the map area, else a row (tall chart / short screens). */
(function () {
  function fit() {
    const box = document.getElementById("radar");
    const host = document.getElementById("map-container");
    if (!box || !host) return;
    box.classList.remove("gauges-row", "gauges-compact");
    if (box.getBoundingClientRect().height + 24 <= host.clientHeight) return;
    box.classList.add("gauges-row");
    const r = box.getBoundingClientRect();
    // Neither fits (narrow phone map): keep only the sky radar.
    if (r.width + 60 > host.clientWidth || r.height + 24 > host.clientHeight) box.classList.add("gauges-compact");
  }
  function init() {
    const host = document.getElementById("map-container");
    if (!host) return;
    if (typeof ResizeObserver === "function") new ResizeObserver(fit).observe(host);
    window.addEventListener("resize", fit);
    fit();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
