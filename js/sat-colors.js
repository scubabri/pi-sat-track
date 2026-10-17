/**
 * Shared, stable per-sat colors for the favorites map overlay and the
 * elevation chart's Favorites view, so both always agree.
 * A sat keeps its color by key: favorites get palette slots in list order;
 * anything else (or overflow past the palette) falls back to a key hash.
 */
const SAT_COLOR_PALETTE = ["#b07cc6", "#5fa8a0", "#c9a26b", "#8f9fd6", "#c97b7b", "#7fae6e", "#b8b06a", "#6fa0c0", "#c08fb0", "#9a8a78"];
const SAT_SELECTED_COLOR = "#58a6ff";

function satColorHash(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return SAT_COLOR_PALETTE[Math.abs(h) % SAT_COLOR_PALETTE.length];
}

function favColor(key) {
  key = String(key || "");
  let favs = [];
  try { favs = typeof loadFavorites === "function" ? loadFavorites() : []; } catch (_) {}
  const i = favs.indexOf(key);
  if (i >= 0) return SAT_COLOR_PALETTE[i % SAT_COLOR_PALETTE.length];
  return satColorHash(key);
}
