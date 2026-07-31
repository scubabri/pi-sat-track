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
    radioTransport: "tcp", // tcp | serial
    radioType: "flex", // flex (tcp) — more later
    radioProtocol: "cat", // cat | tci
    tciHost: "127.0.0.1",
    tciPort: 50001,
    flexUlHost: "172.17.18.229",
    flexUlPort: 60002,
    flexDlHost: "172.17.18.229",
    flexDlPort: 60001,
    serialDevice: "/dev/ttyACM0",
    serialBaud: 19200,
    rotorHost: "127.0.0.1",
    rotorAzPort: 4535,
    rotorElPort: 4536,
  };
}

function val(id) {
  const el = document.getElementById(id);
  return el ? el.value : "";
}

function setVal(id, v) {
  const el = document.getElementById(id);
  if (el) el.value = v != null ? v : "";
}

function readFormConfig() {
  const elevRaw = document.getElementById("cfg-elev");
  const prev = Object.assign(defaultsEndpoints(), loadConfig());
  return {
    callsign: val("cfg-callsign").trim().toUpperCase(),
    grid: val("cfg-grid").trim().toUpperCase(),
    elevation: elevRaw ? parseInt(elevRaw.value, 10) || 0 : 0,

    radioTransport: val("cfg-radio-transport") || "tcp",
    radioType: val("cfg-radio-type") || "flex",
    radioProtocol: val("cfg-radio-protocol") || "cat",

    tciHost: val("cfg-tci-host").trim() || "127.0.0.1",
    tciPort: parseInt(val("cfg-tci-port"), 10) || 50001,

    flexUlHost: val("cfg-flex-ul-host").trim() || "172.17.18.229",
    flexUlPort: parseInt(val("cfg-flex-ul-port"), 10) || 60002,
    flexDlHost: val("cfg-flex-dl-host").trim() || "172.17.18.229",
    flexDlPort: parseInt(val("cfg-flex-dl-port"), 10) || 60001,

    serialDevice: val("cfg-serial-device").trim() || "/dev/ttyACM0",
    serialBaud: parseInt(val("cfg-serial-baud"), 10) || 19200,

    // Rotor fields removed from UI; keep last saved / defaults
    rotorHost: prev.rotorHost,
    rotorAzPort: prev.rotorAzPort,
    rotorElPort: prev.rotorElPort,
  };
}

function fillForm(cfg) {
  const d = Object.assign(defaultsEndpoints(), cfg || {});
  setVal("cfg-callsign", d.callsign || "");
  setVal("cfg-grid", d.grid || "");
  setVal("cfg-elev", d.elevation != null ? d.elevation : "");

  setVal("cfg-radio-transport", d.radioTransport);
  setVal("cfg-radio-type", d.radioType);
  setVal("cfg-radio-protocol", d.radioProtocol);

  setVal("cfg-tci-host", d.tciHost);
  setVal("cfg-tci-port", d.tciPort);

  setVal("cfg-flex-ul-host", d.flexUlHost);
  setVal("cfg-flex-ul-port", d.flexUlPort);
  setVal("cfg-flex-dl-host", d.flexDlHost);
  setVal("cfg-flex-dl-port", d.flexDlPort);

  setVal("cfg-serial-device", d.serialDevice);
  setVal("cfg-serial-baud", d.serialBaud);

  updateRadioFormVisibility();
}

function updateRadioFormVisibility() {
  const transport = val("cfg-radio-transport") || "tcp";
  const protocol = val("cfg-radio-protocol") || "cat";
  const radioType = val("cfg-radio-type") || "flex";

  const tcpBlock = document.getElementById("cfg-tcp-block");
  const serialBlock = document.getElementById("cfg-serial-block");
  const tciBlock = document.getElementById("cfg-tci-block");
  const flexCatBlock = document.getElementById("cfg-flex-cat-block");

  if (tcpBlock) tcpBlock.hidden = transport !== "tcp";
  if (serialBlock) serialBlock.hidden = transport !== "serial";

  if (transport === "tcp") {
    const isTci = protocol === "tci";
    const isFlexCat = protocol === "cat" && radioType === "flex";
    if (tciBlock) tciBlock.hidden = !isTci;
    if (flexCatBlock) flexCatBlock.hidden = !isFlexCat;
  } else {
    if (tciBlock) tciBlock.hidden = true;
    if (flexCatBlock) flexCatBlock.hidden = true;
  }
}

function sendEndpointsToServer(cfg) {
  if (typeof ws === "undefined" || !ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(
    JSON.stringify({
      type: "endpoints",
      radioTransport: cfg.radioTransport,
      radioType: cfg.radioType,
      radioProtocol: cfg.radioProtocol,
      tciHost: cfg.tciHost,
      tciPort: cfg.tciPort,
      flexUlHost: cfg.flexUlHost,
      flexUlPort: cfg.flexUlPort,
      flexDlHost: cfg.flexDlHost,
      flexDlPort: cfg.flexDlPort,
      serialDevice: cfg.serialDevice,
      serialBaud: cfg.serialBaud,
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

  ["cfg-radio-transport", "cfg-radio-type", "cfg-radio-protocol"].forEach(
    (id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("change", updateRadioFormVisibility);
    },
  );

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
