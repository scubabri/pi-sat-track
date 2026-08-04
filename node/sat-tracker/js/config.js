const CONFIG_KEY = "satTrackerConfig";
const PROFILE_CACHE_KEY = "satTrackerProfileName";

/** Active profile name from server (null until first profiles message). */
let activeProfileName = localStorage.getItem(PROFILE_CACHE_KEY) || null;
let profileNames = [];
let profilesReady = false;
let migratedLocalToServer = false;

/** Mirrors lib/serial-catalog.js — keep in sync when adding models. */
const SERIAL_CATALOG = {
  icom: {
    label: "Icom",
    models: [
      {
        id: "ic-705",
        label: "IC-705",
        supported: true,
        defaultDevice: "/dev/ttyACM0",
        defaultBaud: 19200,
        hint: "CI-V over USB. Leave Radio 2 blank for SPLIT; fill for dual radios.",
      },
    ],
  },
  kenwood: {
    label: "Kenwood",
    models: [],
  },
  yaesu: {
    label: "Yaesu",
    models: [],
  },
};

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
    serialMake: "icom",
    serialModel: "ic-705",
    tciHost: "127.0.0.1",
    tciPort: 50001,
    rigctlHost: "127.0.0.1",
    rigctlPort: 4532,
    rigctlUlHost: "",
    rigctlUlPort: 0,
    flexUlHost: "172.17.18.229",
    flexUlPort: 60002,
    flexDlHost: "172.17.18.229",
    flexDlPort: 60001,
    flexApiHost: "172.17.18.46",
    flexApiPort: 4992,
    serialDevice: "/dev/ttyACM0",
    serialBaud: 19200,
    serialDevice2: "",
    serialBaud2: 19200,
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

function parseEndpoint(str, defaultHost, defaultPort) {
  const s = (str || "").trim();
  if (!s) {
    return { host: defaultHost, port: defaultPort };
  }
  const m6 = s.match(/^\[([^\]]+)\]:(\d+)$/);
  if (m6) {
    const p = parseInt(m6[2], 10);
    return {
      host: m6[1],
      port: p > 0 && p < 65536 ? p : defaultPort,
    };
  }
  const idx = s.lastIndexOf(":");
  if (idx > 0) {
    const host = s.slice(0, idx).trim();
    const p = parseInt(s.slice(idx + 1).trim(), 10);
    if (host && Number.isFinite(p) && p > 0 && p < 65536) {
      return { host, port: p };
    }
  }
  return { host: s || defaultHost, port: defaultPort };
}

function formatEndpoint(host, port) {
  if (!host) return "";
  return host + ":" + (port != null ? port : "");
}

function findSerialModel(makeId, modelId) {
  const make = SERIAL_CATALOG[String(makeId || "").toLowerCase()];
  if (!make) return null;
  const id = String(modelId || "").toLowerCase();
  return make.models.find((m) => m.id === id) || null;
}

function populateSerialMakes(selected) {
  const el = document.getElementById("cfg-serial-make");
  if (!el) return;
  el.innerHTML = "";
  Object.keys(SERIAL_CATALOG).forEach((id) => {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = SERIAL_CATALOG[id].label;
    el.appendChild(opt);
  });
  if (selected && SERIAL_CATALOG[selected]) el.value = selected;
  else el.value = "icom";
}

function populateSerialModels(makeId, selected) {
  const el = document.getElementById("cfg-serial-model");
  const hint = document.getElementById("cfg-serial-hint");
  if (!el) return;

  el.innerHTML = "";
  const make = SERIAL_CATALOG[String(makeId || "").toLowerCase()];
  const models = (make && make.models) || [];

  if (!models.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(no models yet)";
    el.appendChild(opt);
    el.disabled = true;
    if (hint) {
      hint.textContent =
        "No " +
        ((make && make.label) || makeId) +
        " models wired yet. Only Icom IC-705 is supported.";
    }
    return;
  }

  el.disabled = false;
  models.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.supported ? m.label : m.label + " (soon)";
    if (!m.supported) opt.disabled = true;
    el.appendChild(opt);
  });

  const pick =
    selected && models.some((m) => m.id === selected && m.supported)
      ? selected
      : (models.find((m) => m.supported) || models[0]).id;
  el.value = pick;

  const info = findSerialModel(makeId, pick);
  if (hint) {
    hint.textContent = info && info.hint ? info.hint : "";
  }

  if (info) {
    const dev = document.getElementById("cfg-serial-device");
    const baud = document.getElementById("cfg-serial-baud");
    if (dev && (!dev.value || dev.value === "/dev/ttyUSB0")) {
      dev.value = info.defaultDevice || "/dev/ttyACM0";
    }
    if (baud && (!baud.value || baud.value === "9600")) {
      baud.value = String(info.defaultBaud || 19200);
    }
  }
}

function onSerialMakeChange() {
  const make = val("cfg-serial-make") || "icom";
  populateSerialModels(make, null);
}

function onSerialModelChange() {
  const make = val("cfg-serial-make") || "icom";
  const model = val("cfg-serial-model");
  const info = findSerialModel(make, model);
  const hint = document.getElementById("cfg-serial-hint");
  if (hint) hint.textContent = info && info.hint ? info.hint : "";
  if (info) {
    if (info.defaultDevice) setVal("cfg-serial-device", info.defaultDevice);
    if (info.defaultBaud) setVal("cfg-serial-baud", info.defaultBaud);
  }
}

function readFormConfig() {
  const elevRaw = document.getElementById("cfg-elev");
  const prev = Object.assign(defaultsEndpoints(), loadConfig());
  let radioType = val("cfg-radio-type") || "smartsdr";
  if (radioType === "flex") radioType = "smartsdr";
  let radioProtocol = val("cfg-radio-protocol") || "cat";
  // Generic rigctl path: protocol is implicit
  if (radioType === "rigctl") radioProtocol = "rigctl";
  // SmartSDR only speaks CAT (not TCI)
  else if (radioType === "smartsdr" && radioProtocol === "tci") radioProtocol = "cat";

  const tci = parseEndpoint(
    val("cfg-tci-endpoint"),
    prev.tciHost || "127.0.0.1",
    prev.tciPort || 50001,
  );
  const rigctl = parseEndpoint(
    val("cfg-rigctl-endpoint"),
    prev.rigctlHost || "127.0.0.1",
    prev.rigctlPort || 4532,
  );
  const rigctlUlRaw = val("cfg-rigctl-ul-endpoint").trim();
  const rigctlUl = rigctlUlRaw
    ? parseEndpoint(rigctlUlRaw, prev.rigctlUlHost || "", prev.rigctlUlPort || 0)
    : { host: "", port: 0 };
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
  const api = parseEndpoint(
    val("cfg-flex-api-endpoint"),
    prev.flexApiHost || "",
    prev.flexApiPort || 4992,
  );

  return {
    callsign: val("cfg-callsign").trim().toUpperCase(),
    grid: val("cfg-grid").trim().toUpperCase(),
    elevation: elevRaw ? parseInt(elevRaw.value, 10) || 0 : 0,

    radioTransport: val("cfg-radio-transport") || "tcp",
    radioType,
    radioProtocol,

    serialMake: val("cfg-serial-make") || "icom",
    serialModel: val("cfg-serial-model") || "ic-705",

    tciHost: tci.host,
    tciPort: tci.port,

    rigctlHost: rigctl.host,
    rigctlPort: rigctl.port,
    rigctlUlHost: rigctlUl.host || "",
    rigctlUlPort: rigctlUl.port || 0,

    flexUlHost: ul.host,
    flexUlPort: ul.port,
    flexDlHost: dl.host,
    flexDlPort: dl.port,
    flexApiHost: api.host,
    flexApiPort: api.port,

    serialDevice: val("cfg-serial-device").trim() || "/dev/ttyACM0",
    serialBaud: parseInt(val("cfg-serial-baud"), 10) || 19200,
    serialDevice2: val("cfg-serial-device2").trim(),
    serialBaud2: parseInt(val("cfg-serial-baud2"), 10) || 19200,

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

  setVal("cfg-tci-endpoint", formatEndpoint(d.tciHost, d.tciPort));
  setVal("cfg-rigctl-endpoint", formatEndpoint(d.rigctlHost || "127.0.0.1", d.rigctlPort || 4532));
  setVal(
    "cfg-rigctl-ul-endpoint",
    d.rigctlUlHost ? formatEndpoint(d.rigctlUlHost, d.rigctlUlPort || 0) : "",
  );
  setVal("cfg-flex-ul-endpoint", formatEndpoint(d.flexUlHost, d.flexUlPort));
  setVal("cfg-flex-dl-endpoint", formatEndpoint(d.flexDlHost, d.flexDlPort));
  setVal(
    "cfg-flex-api-endpoint",
    formatEndpoint(d.flexApiHost, d.flexApiPort || 4992),
  );

  setVal("cfg-serial-device", d.serialDevice);
  setVal("cfg-serial-baud", d.serialBaud);
  setVal("cfg-serial-device2", d.serialDevice2 || "");
  setVal("cfg-serial-baud2", d.serialBaud2 != null ? d.serialBaud2 : 19200);

  populateSerialMakes(d.serialMake || "icom");
  populateSerialModels(d.serialMake || "icom", d.serialModel || "ic-705");

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

  if (radioType === "rigctl") {
    // Protocol is implicit for generic rigctl path
    add("rigctl", "rigctl");
    proto.value = "rigctl";
    return;
  }

  add("cat", "CAT");
  if (radioType === "aethersdr") {
    add("tci", "TCI");
  }

  if (radioType === "smartsdr" && current === "tci") {
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
  const rigctlBlock = document.getElementById("cfg-rigctl-block");
  const flexCatBlock = document.getElementById("cfg-flex-cat-block");
  const apiBlock = document.getElementById("cfg-flex-api-block");

  if (tcpBlock) tcpBlock.hidden = transport !== "tcp";
  if (serialBlock) serialBlock.hidden = transport !== "serial";

  // Protocol row: hide when radio type is rigctl (protocol is implicit)
  const protocolRow = document.getElementById("cfg-radio-protocol");
  const protocolLabel = protocolRow
    ? protocolRow.closest(".form-row")
    : null;

  if (transport === "tcp") {
    const isRigctl = radioType === "rigctl" || protocol === "rigctl";
    const isTci = !isRigctl && protocol === "tci" && radioType === "aethersdr";
    const isCatTcp =
      !isRigctl &&
      protocol === "cat" &&
      (radioType === "smartsdr" ||
        radioType === "aethersdr" ||
        radioType === "flex");
    const needsApi =
      !isRigctl &&
      (radioType === "smartsdr" ||
        radioType === "aethersdr" ||
        radioType === "flex");
    if (protocolLabel) protocolLabel.hidden = isRigctl;
    if (tciBlock) tciBlock.hidden = !isTci;
    if (rigctlBlock) rigctlBlock.hidden = !isRigctl;
    if (flexCatBlock) flexCatBlock.hidden = !isCatTcp;
    if (apiBlock) apiBlock.hidden = !needsApi;
  } else {
    if (protocolLabel) protocolLabel.hidden = false;
    if (tciBlock) tciBlock.hidden = true;
    if (rigctlBlock) rigctlBlock.hidden = true;
    if (flexCatBlock) flexCatBlock.hidden = true;
    if (apiBlock) apiBlock.hidden = true;
  }
}

function sendEndpointsToServer(cfg) {
  if (typeof ws === "undefined" || !ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(
    JSON.stringify({
      type: "endpoints",
      callsign: cfg.callsign,
      grid: cfg.grid,
      elevation: cfg.elevation,
      radioTransport: cfg.radioTransport,
      radioType: cfg.radioType,
      radioProtocol: cfg.radioProtocol,
      serialMake: cfg.serialMake,
      serialModel: cfg.serialModel,
      tciHost: cfg.tciHost,
      tciPort: cfg.tciPort,
      rigctlHost: cfg.rigctlHost,
      rigctlPort: cfg.rigctlPort,
      rigctlUlHost: cfg.rigctlUlHost || "",
      rigctlUlPort: cfg.rigctlUlPort || 0,
      flexUlHost: cfg.flexUlHost,
      flexUlPort: cfg.flexUlPort,
      flexDlHost: cfg.flexDlHost,
      flexDlPort: cfg.flexDlPort,
      flexApiHost: cfg.flexApiHost,
      flexApiPort: cfg.flexApiPort,
      serialDevice: cfg.serialDevice,
      serialBaud: cfg.serialBaud,
      serialDevice2: cfg.serialDevice2 || "",
      serialBaud2: cfg.serialBaud2,
      rotorHost: cfg.rotorHost,
      rotorAzPort: cfg.rotorAzPort,
      rotorElPort: cfg.rotorElPort,
    }),
  );
}

function sendProfileSelect(name) {
  if (typeof ws === "undefined" || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "profile-select", name: name }));
}

function sendProfileCreate(name) {
  if (typeof ws === "undefined" || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "profile-create", name: name, fromActive: true }));
}

function sendProfileDelete(name) {
  if (typeof ws === "undefined" || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "profile-delete", name: name }));
}

function sendProfileRename(from, to) {
  if (typeof ws === "undefined" || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "profile-rename", from: from, to: to }));
}

function fillProfileSelect() {
  const el = document.getElementById("cfg-profile");
  if (!el) return;
  const names = profileNames.slice();
  if (activeProfileName && names.indexOf(activeProfileName) < 0) {
    names.push(activeProfileName);
  }
  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  el.innerHTML = "";
  names.forEach((n) => {
    const opt = document.createElement("option");
    opt.value = n;
    opt.textContent = n;
    el.appendChild(opt);
  });
  if (activeProfileName) el.value = activeProfileName;
}

/**
 * Apply server profiles payload: source of truth for favorites + config.
 * localStorage is only a cache for faster paint / offline.
 */
function applyProfilesMessage(msg) {
  if (!msg || msg.type !== "profiles") return;
  profilesReady = true;
  activeProfileName = msg.active || activeProfileName;
  profileNames = Array.isArray(msg.names) ? msg.names.slice() : [];
  if (activeProfileName) {
    localStorage.setItem(PROFILE_CACHE_KEY, activeProfileName);
  }
  fillProfileSelect();

  const cfg = msg.config && typeof msg.config === "object" ? msg.config : {};
  const hasServerCfg = Object.keys(cfg).length > 0;
  const hasServerFavs = Array.isArray(msg.favorites) && msg.favorites.length > 0;

  // One-time migrate: empty server profile + local data → push up
  if (!migratedLocalToServer && !hasServerCfg && !hasServerFavs) {
    const localCfg = loadConfig();
    const localFavs =
      typeof loadFavorites === "function" ? loadFavorites() : [];
    const localHas =
      (localCfg && (localCfg.grid || localCfg.callsign || localCfg.tciHost)) ||
      (localFavs && localFavs.length);
    if (localHas && typeof ws !== "undefined" && ws && ws.readyState === 1) {
      migratedLocalToServer = true;
      const merged = Object.assign(defaultsEndpoints(), localCfg);
      saveConfig(merged);
      fillForm(merged);
      sendEndpointsToServer(merged);
      if (localFavs.length && typeof saveFavorites === "function") {
        saveFavorites(localFavs);
        if (typeof sendFavoritesToServer === "function") sendFavoritesToServer();
      }
      const hint = document.getElementById("cfg-profile-hint");
      if (hint) {
        hint.textContent =
          "Migrated browser settings into server profile “" +
          (activeProfileName || "default") +
          "”.";
      }
      return;
    }
  }

  if (hasServerCfg) {
    const merged = Object.assign(defaultsEndpoints(), cfg);
    saveConfig(merged);
    fillForm(merged);
    if (merged.grid && typeof centerOnGrid === "function") {
      centerOnGrid(merged.grid);
    }
    if (typeof notifyObserverChanged === "function") {
      notifyObserverChanged();
    }
  }

  if (typeof applyFavoritesFromServer === "function") {
    applyFavoritesFromServer(msg.favorites || []);
  }
}

function initProfileControls() {
  const profileSel = document.getElementById("cfg-profile");
  if (profileSel) {
    profileSel.addEventListener("change", () => {
      const name = profileSel.value;
      if (name && name !== activeProfileName) sendProfileSelect(name);
    });
  }

  const btnNew = document.getElementById("btn-profile-new");
  if (btnNew) {
    btnNew.addEventListener("click", () => {
      const name = prompt("New profile name:");
      if (name && name.trim()) sendProfileCreate(name.trim());
    });
  }

  const btnRen = document.getElementById("btn-profile-rename");
  if (btnRen) {
    btnRen.addEventListener("click", () => {
      if (!activeProfileName) return;
      const name = prompt("Rename profile to:", activeProfileName);
      if (name && name.trim() && name.trim() !== activeProfileName) {
        sendProfileRename(activeProfileName, name.trim());
      }
    });
  }

  const btnDel = document.getElementById("btn-profile-delete");
  if (btnDel) {
    btnDel.addEventListener("click", () => {
      if (!activeProfileName) return;
      if (profileNames.length <= 1) {
        alert("Cannot delete the only profile.");
        return;
      }
      if (confirm('Delete profile "' + activeProfileName + '"?')) {
        sendProfileDelete(activeProfileName);
      }
    });
  }
}

function initConfig() {
  const cfg = loadConfig();
  fillForm(cfg);
  fillProfileSelect();
  initProfileControls();

  const btn = document.getElementById("btn-config");
  const panel = document.getElementById("config-panel");
  if (!btn || !panel) return;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!panel.classList.contains("open")) {
      fillForm(loadConfig());
      fillProfileSelect();
    }
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

  const makeEl = document.getElementById("cfg-serial-make");
  const modelEl = document.getElementById("cfg-serial-model");
  if (makeEl) makeEl.addEventListener("change", onSerialMakeChange);
  if (modelEl) modelEl.addEventListener("change", onSerialModelChange);

  const saveBtn = document.getElementById("btn-save-config");
  if (saveBtn) {
    saveBtn.addEventListener("click", () => {
      const newCfg = readFormConfig();
      saveConfig(newCfg);

      if (newCfg.grid && typeof centerOnGrid === "function") {
        centerOnGrid(newCfg.grid);
      }

      if (typeof notifyObserverChanged === "function") {
        notifyObserverChanged();
      }

      sendEndpointsToServer(newCfg);

      panel.classList.remove("open");
    });
  }
}

function applySavedGrid() {
  const cfg = loadConfig();
  if (cfg.grid) centerOnGrid(cfg.grid);
}

/** Push last *saved* config to server (WS reconnect). Does not read the open form. */
function pushSavedEndpoints() {
  // Server owns config after profiles. Only push if profiles never arrived
  // (legacy / offline). Prefer waiting for profiles message.
  if (profilesReady) return;
  setTimeout(() => {
    if (profilesReady) return;
    const cfg = Object.assign(defaultsEndpoints(), loadConfig());
    if (cfg.radioType === "flex") cfg.radioType = "smartsdr";
    sendEndpointsToServer(cfg);
    // Do not push — server owns config. applyProfilesMessage migrates once if empty.
  }, 1500);
}
