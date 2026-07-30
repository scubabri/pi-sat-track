const CONFIG_KEY = "satTrackerConfig";

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

function defaultsEndpoints() {
  return {
    tciHost: "127.0.0.1",
    tciPort: 50001,
    rotorHost: "127.0.0.1",
    rotorAzPort: 4535,
    rotorElPort: 4536,
  };
}

function readFormConfig() {
  const elevRaw = document.getElementById("cfg-elev");
  const tciHost = document.getElementById("cfg-tci-host");
  const tciPort = document.getElementById("cfg-tci-port");
  const rotorHost = document.getElementById("cfg-rotor-host");
  const rotorAz = document.getElementById("cfg-rotor-az-port");
  const rotorEl = document.getElementById("cfg-rotor-el-port");

  return {
    callsign: document
      .getElementById("cfg-callsign")
      .value.trim()
      .toUpperCase(),
    grid: document.getElementById("cfg-grid").value.trim().toUpperCase(),
    elevation: elevRaw ? parseInt(elevRaw.value, 10) || 0 : 0,
    tciHost: tciHost ? tciHost.value.trim() || "127.0.0.1" : "127.0.0.1",
    tciPort: tciPort ? parseInt(tciPort.value, 10) || 50001 : 50001,
    rotorHost: rotorHost ? rotorHost.value.trim() || "127.0.0.1" : "127.0.0.1",
    rotorAzPort: rotorAz ? parseInt(rotorAz.value, 10) || 4535 : 4535,
    rotorElPort: rotorEl ? parseInt(rotorEl.value, 10) || 4536 : 4536,
  };
}

function fillForm(cfg) {
  const d = Object.assign(defaultsEndpoints(), cfg || {});
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val != null ? val : "";
  };
  set("cfg-callsign", d.callsign || "");
  set("cfg-grid", d.grid || "");
  set("cfg-elev", d.elevation != null ? d.elevation : "");
  set("cfg-tci-host", d.tciHost);
  set("cfg-tci-port", d.tciPort);
  set("cfg-rotor-host", d.rotorHost);
  set("cfg-rotor-az-port", d.rotorAzPort);
  set("cfg-rotor-el-port", d.rotorElPort);
}

function sendEndpointsToServer(cfg) {
  if (typeof ws === "undefined" || !ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(
    JSON.stringify({
      type: "endpoints",
      tciHost: cfg.tciHost,
      tciPort: cfg.tciPort,
      rotorHost: cfg.rotorHost,
      rotorAzPort: cfg.rotorAzPort,
      rotorElPort: cfg.rotorElPort,
    }),
  );
}

function initConfig() {
  const cfg = loadConfig();
  fillForm(cfg);

  const btn = document.getElementById("btn-config");
  const panel = document.getElementById("config-panel");
  if (!btn || !panel) return;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    panel.classList.toggle("open");
  });

  document.addEventListener("click", (e) => {
    if (!panel.contains(e.target) && e.target !== btn) {
      panel.classList.remove("open");
    }
  });

  document.getElementById("btn-save-config").addEventListener("click", () => {
    const newCfg = readFormConfig();
    saveConfig(newCfg);

    if (newCfg.grid) {
      centerOnGrid(newCfg.grid);
    }

    if (typeof notifyObserverChanged === "function") {
      notifyObserverChanged();
    }

    sendEndpointsToServer(newCfg);

    panel.classList.remove("open");
  });

  document.getElementById("btn-center-grid").addEventListener("click", () => {
    const grid = document.getElementById("cfg-grid").value.trim();
    if (grid) centerOnGrid(grid);
    else alert("Please enter a gridsquare first");
  });
}

function applySavedGrid() {
  const cfg = loadConfig();
  if (cfg.grid) centerOnGrid(cfg.grid);
}

/** Call after WebSocket opens so server gets saved endpoints */
function pushSavedEndpoints() {
  const cfg = Object.assign(defaultsEndpoints(), loadConfig());
  sendEndpointsToServer(cfg);
}
