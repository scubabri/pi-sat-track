/* Satellite selector menu, favorites, sort */
let satSortMode = localStorage.getItem("satTrackerSort") || "aos";
let satListMode = localStorage.getItem("satTrackerListMode") || "heard"; // "heard" | "favorites"
let currentSatKey = localStorage.getItem("satTrackerSat") || null;
let currentSatLabel = null;
let lastSatList = null;
let currentEl = null;
let pendingSatKey = null;

function setSatButtonLabel(label) {
  currentSatLabel = label;
  const btn = document.getElementById("sat-name");
  if (btn) btn.textContent = (label || "-") + " \u25BE";
  document.querySelectorAll(".sat-option[data-sat]").forEach((el) => {
    el.classList.toggle("active", el.dataset.sat === currentSatKey);
  });
}

function loadFavorites() {
  try {
    const raw = localStorage.getItem("satTrackerFavorites");
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((k) => typeof k === "string") : [];
  } catch (e) {
    return [];
  }
}

function saveFavorites(keys) {
  localStorage.setItem("satTrackerFavorites", JSON.stringify(keys));
}

/** Apply favorites from server profile (source of truth). */
function applyFavoritesFromServer(keys) {
  if (!Array.isArray(keys)) keys = [];
  keys = keys
    .filter((k) => typeof k === "string" && k)
    .filter((k, i, a) => a.indexOf(k) === i);
  saveFavorites(keys);
  if (lastSatList) renderSatMenu(lastSatList);
  if (typeof invalidateFavPanelStructure === "function") {
    invalidateFavPanelStructure();
  } else if (typeof renderFavPanel === "function") {
    renderFavPanel();
  }
}

function isFavorite(key) {
  return !!key && loadFavorites().includes(key);
}

function sendFavoritesToServer() {
  if (typeof ws === "undefined" || !ws || ws.readyState !== WebSocket.OPEN)
    return;
  const keys = loadFavorites();
  ws.send(JSON.stringify({ type: "favorites", keys: keys }));
}

function toggleFavorite(key) {
  if (!key) return;
  const favs = loadFavorites();
  const i = favs.indexOf(key);
  if (i >= 0) favs.splice(i, 1);
  else favs.push(key);
  saveFavorites(favs);
  if (lastSatList) renderSatMenu(lastSatList);
  if (typeof invalidateFavPanelStructure === "function") {
    invalidateFavPanelStructure();
  } else if (typeof renderFavPanel === "function") {
    renderFavPanel();
  }
  sendFavoritesToServer();
}
