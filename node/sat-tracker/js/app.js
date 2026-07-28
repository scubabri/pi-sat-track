document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initRadar();
  initProfile();
  initConfig();

  // Apply saved gridsquare after a short delay so the map is fully ready
  setTimeout(() => {
    applySavedGrid();
  }, 300);

  // Simple button toggles (placeholder)
  document.getElementById('btn-radio').addEventListener('click', function () {
    this.classList.toggle('active');
    document.getElementById('toggle-radio').checked = this.classList.contains('active');
  });

  document.getElementById('btn-antenna').addEventListener('click', function () {
    this.classList.toggle('active');
    document.getElementById('toggle-antenna').checked = this.classList.contains('active');
  });
});