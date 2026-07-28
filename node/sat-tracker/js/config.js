const CONFIG_KEY = 'satTrackerConfig';

function loadConfig() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY)) || {};
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

function initConfig() {
  const cfg = loadConfig();

  // Populate fields
  document.getElementById('cfg-callsign').value = cfg.callsign || '';
  document.getElementById('cfg-grid').value     = cfg.grid || '';
  document.getElementById('cfg-elev').value     = cfg.elevation || '';

  // Toggle dropdown
  const btn = document.getElementById('btn-config');
  const panel = document.getElementById('config-panel');

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.classList.toggle('open');
  });

  // Close when clicking outside
  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && e.target !== btn) {
      panel.classList.remove('open');
    }
  });

  // Save button → save + center + marker
  document.getElementById('btn-save-config').addEventListener('click', () => {
    const newCfg = {
      callsign:  document.getElementById('cfg-callsign').value.trim().toUpperCase(),
      grid:      document.getElementById('cfg-grid').value.trim().toUpperCase(),
      elevation: parseInt(document.getElementById('cfg-elev').value, 10) || 0
    };

    saveConfig(newCfg);

    if (newCfg.grid) {
      centerOnGrid(newCfg.grid);
    }

    panel.classList.remove('open');
  });

  // Manual Center Map button
  document.getElementById('btn-center-grid').addEventListener('click', () => {
    const grid = document.getElementById('cfg-grid').value.trim();
    if (grid) {
      centerOnGrid(grid);
    } else {
      alert('Please enter a gridsquare first');
    }
  });
}

/**
 * Called after the map is ready
 */
function applySavedGrid() {
  const cfg = loadConfig();
  if (cfg.grid) {
    centerOnGrid(cfg.grid);
  }
}