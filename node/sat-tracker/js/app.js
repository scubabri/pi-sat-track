function initApp() {
  if (typeof initMap === "function") initMap();
  if (typeof initRadar === "function") initRadar();
  if (typeof initRotorGauges === "function") initRotorGauges();
  if (typeof initProfile === "function") initProfile();
  if (typeof initTimeToggle === "function") initTimeToggle();
  if (typeof initSatSelector === "function") initSatSelector();
  if (typeof initFavPanel === "function") initFavPanel();
  if (typeof initConfig === "function") initConfig();
  if (typeof connectTracker === "function") connectTracker();
  if (typeof updateStationStatus === "function") updateStationStatus();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}
