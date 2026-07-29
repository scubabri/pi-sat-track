document.addEventListener("DOMContentLoaded", () => {
  initMap();
  initRadar();
  initProfile();
  initConfig();

  if (typeof initTimeToggle === "function") initTimeToggle();
  if (typeof initSatSelector === "function") initSatSelector();

  setTimeout(() => {
    applySavedGrid();
  }, 300);

  if (typeof connectTracker === "function") {
    connectTracker();
  } else {
    console.error("connectTracker is not defined – check js/tracker.js");
  }

  document.getElementById("btn-radio").addEventListener("click", function () {
    this.classList.toggle("active");
    document.getElementById("toggle-radio").checked =
      this.classList.contains("active");
  });

  document.getElementById("btn-antenna").addEventListener("click", function () {
    this.classList.toggle("active");
    document.getElementById("toggle-antenna").checked =
      this.classList.contains("active");
  });
});
