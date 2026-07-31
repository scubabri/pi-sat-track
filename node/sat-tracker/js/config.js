const CONFIG_KEY = "satTrackerConfig";

function loadConfig() {
  try {
    const cfg = JSON.parse(localStorage.getItem(CONFIG_KEY)) || {};
    if (cfg.radioType === "flex") cfg.radioType = "smartsdr";
    return cfg;
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

function defaultsEndpoints() {
  return {
    radioTransport: "tcp",
    radioType: "smartsdr",
    radioProtocol: "cat",
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

/** Parse "host:port" or "host" → { host, port }. port may be null. */
function parseEndpoint(str, defaultHost, defaultPort) {
  const s = (str || "").trim();
  if (!s) {
    return { host: defaultHost, port: defaultPort };
  }
  // IPv6 in brackets: [fe80::1]:60001
  const m6 = s.match(/^\[([^\]]+)\]:(\d+)$/);
  if (m6) {
    const p = parseInt(m6[2], 10);
    return {
      host: m6[1],
      port: p > 0 && p < 65536 ? p : defaultPort,
    };
  }
  // host:port (last colon — works for IPv4 and hostnames)
  const idx = s.lastIndexOf(":");
  if (idx > 0) {
    const host = s.slice(0, idx).trim();
    const p = parseInt(s.slice(idx + 1).trim(), 10);
    if (host && Number.isFinite(p) && p > 0 && p < 65536) {
      return { host, port: p };
    }
  }
  // host only
  return { host: s || defaultHost, port: defaultPort };
}

function formatEndpoint(host, port) {
  if (!host) return "";
  return host + ":" + (port != null ? port : "");
}

function readFormConfig() {
  const elevRaw = document.getElementById("cfg-elev");
  const prev = Object.assign(defaultsEndpoints(), loadConfig());
  let radioType = val("cfg-radio-type") || "smartsdr";
  if (radioType === "flex") radioType = "smartsdr";
  let radioProtocol = val("cfg-radio-protocol") || "cat";
  if (radioType === "smartsdr") radioProtocol = "cat";

  const tci = parseEndpoint(
    val("cfg-tci-endpoint"),
    prev.tciHost || "127.0.0.1",
    prev.tciPort || 50001,
  );
  const ul = parseEndpoint(
    val("cfg-flex-ul-endpoint"),
    prev.flexUlHost || "172.17.18.229",
    prev.flexUlPort || 60002,
  );
  const dl = parseEndpoint(
    val("cfg-flex-dl-endpoint"),
    prev.flexDlHost || "172.17.18.229",
    prev.flexDlPort || 60001,
  );

  return {
    callsign: val("cfg-callsign").trim().toUpperCase(),
    grid: val("cfg-grid").trim().toUpperCase(),
    elevation: elevRaw ? parseInt(elevRaw.value, 10) || 0 : 0,

    radioTransport: val("cfg-radio-transport") || "tcp",
    radioType,
    radioProtocol,

    tciHost: tci.host,
    tciPort: tci.port,

    flexUlHost: ul.host,
    flexUlPort: ul.port,
    flexDlHost: dl.host,
    flexDlPort: dl.port,

    serialDevice: val("cfg-serial-device").trim() || "/dev/ttyACM0",
    serialBaud: parseInt(val("cfg-serial-baud"), 10) || 19200,

    rotorHost: prev.rotorHost,
    rotorAzPort: prev.rotorAzPort,
    rotorElPort: prev.rotorElPort,
  };
}

function fillForm(cfg) {
  const d = Object.assign(defaultsEndpoints(), cfg || {});
  if (d.radioType === "flex") d.radioType = "smartsdr";

  setVal("cfg-callsign", d.callsign || "");
  setVal("cfg-grid", d.grid || "");
  setVal("cfg-elev", d.elevation != null ? d.elevation : "");

  setVal("cfg-radio-transport", d.radioTransport);
  setVal("cfg-radio-type", d.radioType);
  setVal("cfg-radio-protocol", d.radioProtocol);

  // Show saved values; leave empty only if never set (placeholders then show format)
  setVal("cfg-tci-endpoint", formatEndpoint(d.tciHost, d.tciPort));
  setVal("cfg-flex-ul-endpoint", formatEndpoint(d.flexUlHost, d.flexUlPort));
  setVal("cfg-flex-dl-endpoint", formatEndpoint(d.flexDlHost, d.flexDlPort));

  setVal("cfg-serial-device", d.serialDevice);
  setVal("cfg-serial-baud", d.serialBaud);

  updateRadioFormVisibility();
}

function updateProtocolOptions() {
  const radioType = val("cfg-radio-type") || "smartsdr";
  const proto = document.getElementById("cfg-radio-protocol");
  if (!proto) return;

  const current = proto.value;
  proto.innerHTML = "";

  const add = (value, label) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    proto.appendChild(opt);
  };

  add("cat", "CAT");
  if (radioType === "aethersdr") {
    add("tci", "TCI");
  }

  if (radioType === "smartsdr") {
    proto.value = "cat";
  } else if (current === "tci" || current === "cat") {
    proto.value = current;
  } else {
    proto.value = "cat";
  }
}

function updateRadioFormVisibility() {
  const transport = val("cfg-radio-transport") || "tcp";
  const radioType = val("cfg-radio-type") || "smartsdr";

  updateProtocolOptions();
  const protocol = val("cfg-radio-protocol") || "cat";

  const tcpBlock = document.getElementById("cfg-tcp-block");
  const serialBlock = document.getElementById("cfg-serial-block");
  const tciBlock = document.getElementById("cfg-tci-block");
  const flexCatBlock = document.getElementById("cfg-flex-cat-block");

  if (tcpBlock) tcpBlock.hidden = transport !== "tcp";
  if (serialBlock) serialBlock.hidden = transport !== "serial";

  if (transport === "tcp") {
    const isTci = protocol === "tci" && radioType === "aethersdr";
    const isCatTcp =
      protocol === "cat" &&
      (radioType === "smartsdr" ||
        radioType === "aethersdr" ||
        radioType === "flex");
    if (tciBlock) tciBlock.hidden = !isTci;
    if (flexCatBlock) flexCatBlock.hidden = !isCatTcp;
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

function pushSavedEndpoints() {
  const cfg = Object.assign(defaultsEndpoints(), loadConfig());
  if (cfg.radioType === "flex") cfg.radioType = "smartsdr";
  sendEndpointsToServer(cfg);
}
