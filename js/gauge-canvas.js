/**
 * Map-corner gauges (sky radar, rotor AZ/EL): drawn in a fixed 220-unit
 * logical space, rendered at GAUGE_PX CSS px with a devicePixelRatio backing
 * store (crisp, no bitmap scaling). Fonts get a boost so labels stay legible
 * at the smaller size.
 */
const GAUGE_LOGICAL = 220;
const GAUGE_FONT_BOOST = 1.7; // logical font px multiplier (11px -> ~9.4 CSS px at 110)

let gaugeFitPx = null; // set by the fit logic below when the map area is short

function gaugeBasePx() {
  const w = window.innerWidth || 1280;
  return w < 600 ? 84 : w < 1000 ? 96 : 110;
}

function gaugeCssPx() {
  const b = gaugeBasePx();
  return gaugeFitPx ? Math.min(b, gaugeFitPx) : b;
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

/**
 * Gauges stack vertically at the map's top-left. If the stack can't fit the
 * map height (tall elevation chart / short screen), shrink them (min 56 px)
 * instead of changing the layout.
 */
(function () {
  const MIN_PX = 56;
  function fit() {
    const box = document.getElementById("radar");
    const host = document.getElementById("map-container");
    if (!box || !host) return;
    const n = box.querySelectorAll("canvas").length || 3;
    const cur = gaugeCssPx();
    const extra = box.getBoundingClientRect().height - n * cur; // gaps + labels
    const room = host.clientHeight - 24 - Math.max(0, extra);
    const want = Math.max(MIN_PX, Math.floor(room / n));
    const next = want >= gaugeBasePx() ? null : want;
    if (next === gaugeFitPx) return;
    gaugeFitPx = next;
    if (typeof reinitGaugeCanvases === "function") reinitGaugeCanvases();
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
