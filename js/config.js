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
        hint: "CI-V over USB.",
      },
    ],
  },
  kenwood: { label: "Kenwood", models: [] },
  yaesu: { label: "Yaesu", models: [] },
};

/** Filled from server host/endpoints message (rotors.catalog()). */
let ROTOR_CATALOG = [
  {
    id: "rt21",
    label: "Green Heron RT-21",
    ports: 2,
    defaultBaud: 4800,
    defaultDevice: "/dev/ttyUSB0",
    hint: "Two serial ports — one for AZ, one for EL.",
  },
  {
    id: "gs232",
    label: "GS-232 (K3NG / Fox Delta)",
    ports: 1,
    defaultBaud: 9600,
    defaultDevice: "/dev/ttyACM0",
    hint: "Single USB serial. AZ and EL on one controller.",
  },
];

function findRotorDriver(id) {
  const key = String(id || "").toLowerCase();
  return ROTOR_CATALOG.find((d) => d.id === key) || null;
}

function setRotorCatalog(list) {
  if (Array.isArray(list) && list.length) {
    ROTOR_CATALOG = list.slice();
  }
}

function populateRotorTypes(selected) {
  const el = document.getElementById("cfg-rotor-type");
  if (!el) return;
  const prev = selected || el.value || "rt21";
  el.innerHTML = "";
  ROTOR_CATALOG.forEach((d) => {
    const opt = document.createElement("option");
    opt.value = d.id;
    opt.textContent = d.label || d.id;
    el.appendChild(opt);
  });
  if (ROTOR_CATALOG.some((d) => d.id === prev)) el.value = prev;
  else if (ROTOR_CATALOG.length) el.value = ROTOR_CATALOG[0].id;
  updateRotorFormVisibility();
}

function updateRotorFormVisibility() {
  const type = val("cfg-rotor-type") || "rt21";
  const info = findRotorDriver(type);
  const ports = info && info.ports != null ? info.ports : 2;
  const single = document.getElementById("cfg-rotor-single-block");
  const dual = document.getElementById("cfg-rotor-dual-block");
  const hint = document.getElementById("cfg-rotor-hint");
  if (single) single.hidden = ports !== 1;
  if (dual) dual.hidden = ports !== 2;
  if (hint) hint.textContent = info && info.hint ? info.hint : "";
}

function onRotorTypeChange() {
  const type = val("cfg-rotor-type") || "rt21";
  const info = findRotorDriver(type);
  updateRotorFormVisibility();
  if (!info) return;
  if (info.defaultBaud) setVal("cfg-rotor-baud", info.defaultBaud);
  if (info.ports === 1) {
    if (info.defaultDevice) setVal("cfg-rotor-device", info.defaultDevice);
  } else {
    if (info.defaultDevice) setVal("cfg-rotor-az-device", info.defaultDevice);
  }
}

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

function defaultSide(side) {
  return {
    transport: "tcp",
    type: side === "ul" ? "smartsdr" : "smartsdr",
    protocol: "cat",
    endpoint: side === "ul" ? "172.17.18.229:60002" : "172.17.18.229:60001",
    tciEndpoint: "127.0.0.1:50001",
    rigctlEndpoint: "127.0.0.1:4532",
    catEndpoint: side === "ul" ? "172.17.18.229:60002" : "172.17.18.229:60001",
    apiEndpoint: "172.17.18.46:4992",
    serialMake: "icom",
    serialModel: "ic-705",
    serialDevice: "/dev/ttyACM0",
    serialBaud: 19200,
  };
}

function defaultsEndpoints() {
  return {
    callsign: "",
    grid: "",
    elevation: 0,
    singleRadio: false,
    radioUl: defaultSide("ul"),
    radioDl: defaultSide("dl"),
    // legacy flat fields kept for older server/profiles
    radioTransport: "tcp",
    radioType: "smartsdr",
    radioProtocol: "cat",
    rotorHost: "127.0.0.1",
    rotorAzPort: 4535,
    rotorElPort: 4536,
    rotorType: "rt21",
    rotorAzDevice: "/dev/ttyUSB0",
    rotorElDevice: "/dev/ttyUSB1",
    rotorBaud: 4800,
  };
}

/** Migrate old single-radio config into radioUl / radioDl. */
function migrateLegacy(cfg) {
  const d = Object.assign(defaultsEndpoints(), cfg || {});
  if (d.radioUl && d.radioDl && d.radioUl.transport) return d;

  const transport = d.radioTransport || "tcp";
  const type = d.radioType === "flex" ? "smartsdr" : d.radioType || "smartsdr";
  let protocol = d.radioProtocol || "cat";
  if (type === "rigctl") protocol = "rigctl";

  const ul = defaultSide("ul");
  const dl = defaultSide("dl");
  ul.transport = transport;
  dl.transport = transport;
  ul.type = type;
  dl.type = type;
  ul.protocol = protocol;
  dl.protocol = protocol;

  if (d.tciHost) {
    const ep = (d.tciHost || "127.0.0.1") + ":" + (d.tciPort || 50001);
    ul.tciEndpoint = ep;
    dl.tciEndpoint = ep;
  }
  if (d.rigctlHost) {
    dl.rigctlEndpoint =
      (d.rigctlHost || "127.0.0.1") + ":" + (d.rigctlPort || 4532);
  }
  if (d.rigctlUlHost) {
    ul.rigctlEndpoint = d.rigctlUlHost + ":" + (d.rigctlUlPort || 4532);
  } else if (d.rigctlHost) {
    ul.rigctlEndpoint = dl.rigctlEndpoint;
  }
  if (d.flexUlHost) {
    ul.catEndpoint = d.flexUlHost + ":" + (d.flexUlPort || 60002);
  }
  if (d.flexDlHost) {
    dl.catEndpoint = d.flexDlHost + ":" + (d.flexDlPort || 60001);
  }
  if (d.flexApiHost) {
    const api = d.flexApiHost + ":" + (d.flexApiPort || 4992);
    ul.apiEndpoint = api;
    dl.apiEndpoint = api;
  }
  if (d.serialDevice) {
    dl.serialDevice = d.serialDevice;
    dl.serialBaud = d.serialBaud || 19200;
    dl.serialMake = d.serialMake || "icom";
    dl.serialModel = d.serialModel || "ic-705";
  }
  if (d.serialDevice2) {
    ul.serialDevice = d.serialDevice2;
    ul.serialBaud = d.serialBaud2 || 19200;
  } else if (d.serialDevice) {
    ul.serialDevice = d.serialDevice;
    ul.serialBaud = d.serialBaud || 19200;
  }

  d.radioUl = ul;
  d.radioDl = dl;
  return d;
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
  if (!s) return { host: defaultHost, port: defaultPort };
  const m6 = s.match(/^\[([^\]]+)\]:(\d+)$/);
  if (m6) {
    const p = parseInt(m6[2], 10);
    return { host: m6[1], port: p > 0 && p < 65536 ? p : defaultPort };
  }
  const idx = s.lastIndexOf(":");
  if (idx > 0) {
    const host = s.slice(0, idx).trim();
    const p = parseInt(s.slice(idx + 1).trim(), 10);
    if (host && Number.isFinite(p) && p > 0 && p < 65536)
      return { host, port: p };
  }
  return { host: s || defaultHost, port: defaultPort };
}

function formatEndpoint(host, port) {
  if (!host) return "";
  return host + ":" + (port != null ? port : "");
}

function readSide(side) {
  const p = "cfg-" + side;
  let transport = val(p + "-transport") || "tcp";
  let type = val(p + "-type") || "smartsdr";
  if (type === "flex") type = "smartsdr";
  let protocol = val(p + "-protocol") || "cat";
  if (type === "rigctl") protocol = "rigctl";
  else if (type === "smartsdr" && protocol === "tci") protocol = "cat";

  return {
    transport,
    type,
    protocol,
    tciEndpoint: val(p + "-tci-endpoint") || "127.0.0.1:50001",
    rigctlEndpoint: val(p + "-rigctl-endpoint") || "127.0.0.1:4532",
    catEndpoint: val(p + "-cat-endpoint") || "",
    apiEndpoint: val(p + "-api-endpoint") || "",
    serialMake: val(p + "-serial-make") || "icom",
    serialModel: val(p + "-serial-model") || "ic-705",
    serialDevice: val(p + "-serial-device") || "/dev/ttyACM0",
    serialBaud: parseInt(val(p + "-serial-baud"), 10) || 19200,
  };
}

function fillSide(side, s) {
  const p = "cfg-" + side;
  const d = Object.assign(defaultSide(side), s || {});
  if (d.type === "flex") d.type = "smartsdr";
  setVal(p + "-transport", d.transport || "tcp");
  setVal(p + "-type", d.type || "smartsdr");
  setVal(p + "-protocol", d.protocol || "cat");
  setVal(p + "-tci-endpoint", d.tciEndpoint || "127.0.0.1:50001");
  setVal(p + "-rigctl-endpoint", d.rigctlEndpoint || "127.0.0.1:4532");
  setVal(p + "-cat-endpoint", d.catEndpoint || "");
  setVal(p + "-api-endpoint", d.apiEndpoint || "");
  setVal(p + "-serial-make", d.serialMake || "icom");
  setVal(p + "-serial-model", d.serialModel || "ic-705");
  setVal(p + "-serial-device", d.serialDevice || "/dev/ttyACM0");
  setVal(p + "-serial-baud", d.serialBaud != null ? d.serialBaud : 19200);
  updateSideVisibility(side);
}

function updateSideProtocolOptions(side) {
  const p = "cfg-" + side;
  const type = val(p + "-type") || "smartsdr";
  const proto = document.getElementById(p + "-protocol");
  if (!proto) return;
  const current = proto.value;
  proto.innerHTML = "";
  const add = (value, label) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    proto.appendChild(opt);
  };
  if (type === "rigctl") {
    add("rigctl", "rigctl");
    proto.value = "rigctl";
    return;
  }
  add("cat", "CAT");
  if (type === "aethersdr") add("tci", "TCI");
  if (type === "smartsdr" && current === "tci") proto.value = "cat";
  else if (current === "tci" || current === "cat") proto.value = current;
  else proto.value = "cat";
}

function updateSideVisibility(side) {
  const p = "cfg-" + side;
  updateSideProtocolOptions(side);
  const transport = val(p + "-transport") || "tcp";
  const type = val(p + "-type") || "smartsdr";
  const protocol = val(p + "-protocol") || "cat";

  const tcpBlock = document.getElementById(p + "-tcp-block");
  const serialBlock = document.getElementById(p + "-serial-block");
  const tciBlock = document.getElementById(p + "-tci-block");
  const rigctlBlock = document.getElementById(p + "-rigctl-block");
  const catBlock = document.getElementById(p + "-cat-block");
  const apiBlock = document.getElementById(p + "-api-block");
  const protocolRow = document.getElementById(p + "-protocol-row");

  if (tcpBlock) tcpBlock.hidden = transport !== "tcp";
  if (serialBlock) serialBlock.hidden = transport !== "serial";

  if (transport !== "tcp") {
    if (protocolRow) protocolRow.hidden = true;
    if (tciBlock) tciBlock.hidden = true;
    if (rigctlBlock) rigctlBlock.hidden = true;
    if (catBlock) catBlock.hidden = true;
    if (apiBlock) apiBlock.hidden = true;
    return;
  }

  const isRigctl = type === "rigctl" || protocol === "rigctl";
  const isTci = !isRigctl && protocol === "tci" && type === "aethersdr";
  const isCat =
    !isRigctl &&
    protocol === "cat" &&
    (type === "smartsdr" || type === "aethersdr" || type === "flex");
  const needsApi = isCat || isTci;

  if (protocolRow) protocolRow.hidden = isRigctl;
  if (tciBlock) tciBlock.hidden = !isTci;
  if (rigctlBlock) rigctlBlock.hidden = !isRigctl;
  if (catBlock) catBlock.hidden = !isCat;
  if (apiBlock) apiBlock.hidden = !needsApi;
}

function isSingleRadioChecked() {
  const el = document.getElementById("cfg-single-radio");
  return !!(el && el.checked);
}

/** Hide Radio DL when single-radio (split) is checked; update UL title. */
function updateSingleRadioVisibility() {
  const single = isSingleRadioChecked();
  const dlSection = document.getElementById("cfg-dl-section");
  const ulTitle = document.getElementById("cfg-ul-title");
  const hint = document.getElementById("cfg-single-radio-hint");
  if (dlSection) dlSection.hidden = single;
  if (ulTitle) ulTitle.textContent = single ? "Radio (split)" : "Radio UL (TX)";
  if (hint) hint.hidden = !single;
  updateSideVisibility("ul");
  if (!single) updateSideVisibility("dl");
}

function updateRadioFormVisibility() {
  updateSingleRadioVisibility();
}

function readFormConfig() {
  const elevRaw = document.getElementById("cfg-elev");
  const prev = migrateLegacy(Object.assign(defaultsEndpoints(), loadConfig()));
  const singleRadio = isSingleRadioChecked();
  const radioUl = readSide("ul");
  // Single radio (split): DL uses the same config as UL
  const radioDl = singleRadio ? Object.assign({}, radioUl) : readSide("dl");

  return {
    callsign: val("cfg-callsign").trim().toUpperCase(),
    grid: val("cfg-grid").trim().toUpperCase(),
    elevation: elevRaw ? parseInt(elevRaw.value, 10) || 0 : 0,
    singleRadio,
    radioUl,
    radioDl,
    radioTransport: radioDl.transport,
    radioType: radioDl.type,
    radioProtocol: radioDl.protocol,
    rotorHost: prev.rotorHost,
    rotorAzPort: prev.rotorAzPort,
    rotorElPort: prev.rotorElPort,
    rotorType: (function () {
      const t = val("cfg-rotor-type") || "rt21";
      return t.toLowerCase();
    })(),
    rotorAzDevice: (function () {
      const t = val("cfg-rotor-type") || "rt21";
      const info = findRotorDriver(t);
      const ports = info && info.ports != null ? info.ports : 2;
      if (ports === 1) {
        return val("cfg-rotor-device").trim() || "/dev/ttyACM0";
      }
      return val("cfg-rotor-az-device").trim() || "/dev/ttyUSB0";
    })(),
    rotorElDevice: (function () {
      const t = val("cfg-rotor-type") || "rt21";
      const info = findRotorDriver(t);
      const ports = info && info.ports != null ? info.ports : 2;
      if (ports === 1) {
        return val("cfg-rotor-device").trim() || "/dev/ttyACM0";
      }
      return val("cfg-rotor-el-device").trim() || "/dev/ttyUSB1";
    })(),
    rotorBaud: parseInt(val("cfg-rotor-baud"), 10) || 4800,
  };
}

function fillForm(cfg) {
  const d = migrateLegacy(Object.assign(defaultsEndpoints(), cfg || {}));
  setVal("cfg-callsign", d.callsign || "");
  setVal("cfg-grid", d.grid || "");
  setVal("cfg-elev", d.elevation != null ? d.elevation : "");
  const singleEl = document.getElementById("cfg-single-radio");
  if (singleEl) singleEl.checked = !!d.singleRadio;
  fillSide("ul", d.radioUl);
  fillSide("dl", d.radioDl);
  updateSingleRadioVisibility();
  populateRotorTypes(d.rotorType || "rt21");
  setVal("cfg-rotor-device", d.rotorAzDevice || "/dev/ttyACM0");
  setVal("cfg-rotor-az-device", d.rotorAzDevice || "/dev/ttyUSB0");
  setVal("cfg-rotor-el-device", d.rotorElDevice || "/dev/ttyUSB1");
  setVal("cfg-rotor-baud", d.rotorBaud != null ? d.rotorBaud : 4800);
  updateRotorFormVisibility();
}

function sideToServerFields(side, s) {
  // Expand one side into the flat keys the server still understands,
  // prefixed conceptually — server maps radioUl/radioDl objects.
  return s;
}

function sendEndpointsToServer(cfg) {
  if (typeof ws === "undefined" || !ws || ws.readyState !== WebSocket.OPEN)
    return;
  const singleRadio = !!cfg.singleRadio;
  const ul = cfg.radioUl || defaultSide("ul");
  // Single radio (split): force DL = UL so server maps one radio with split semantics
  const dl = singleRadio
    ? Object.assign({}, ul)
    : cfg.radioDl || defaultSide("dl");

  const ulCat = parseEndpoint(ul.catEndpoint, "172.17.18.229", 60002);
  const dlCat = parseEndpoint(dl.catEndpoint, "172.17.18.229", 60001);
  const ulRig = parseEndpoint(ul.rigctlEndpoint, "127.0.0.1", 4532);
  const dlRig = parseEndpoint(dl.rigctlEndpoint, "127.0.0.1", 4532);
  const ulTci = parseEndpoint(ul.tciEndpoint, "127.0.0.1", 50001);
  const dlTci = parseEndpoint(dl.tciEndpoint, "127.0.0.1", 50001);
  const api = parseEndpoint(dl.apiEndpoint || ul.apiEndpoint, "", 4992);

  // Serial split: only one device — clear device2 so isDualCat() is false
  const serialDevice = singleRadio ? ul.serialDevice : dl.serialDevice;
  const serialBaud = singleRadio ? ul.serialBaud : dl.serialBaud;
  const serialDevice2 = singleRadio ? "" : ul.serialDevice;
  const serialBaud2 = singleRadio ? 19200 : ul.serialBaud;

  ws.send(
    JSON.stringify({
      type: "endpoints",
      callsign: cfg.callsign,
      grid: cfg.grid,
      elevation: cfg.elevation,
      singleRadio,
      radioUl: ul,
      radioDl: dl,
      radioTransport: dl.transport,
      radioType: dl.type,
      radioProtocol: dl.protocol,
      tciHost: (dl.protocol === "tci" ? dlTci : ulTci).host,
      tciPort: (dl.protocol === "tci" ? dlTci : ulTci).port,
      rigctlHost: dlRig.host,
      rigctlPort: dlRig.port,
      // Single-endpoint split: no separate UL rigctl host
      rigctlUlHost: singleRadio
        ? ""
        : ul.protocol === "rigctl" || ul.type === "rigctl"
          ? ulRig.host
          : "",
      rigctlUlPort: singleRadio
        ? 0
        : ul.protocol === "rigctl" || ul.type === "rigctl"
          ? ulRig.port
          : 0,
      flexUlHost: ulCat.host,
      flexUlPort: ulCat.port,
      // Single radio: same CAT endpoint for both sides
      flexDlHost: singleRadio ? ulCat.host : dlCat.host,
      flexDlPort: singleRadio ? ulCat.port : dlCat.port,
      flexApiHost: api.host || "",
      flexApiPort: api.port || 4992,
      serialDevice,
      serialBaud,
      serialDevice2,
      serialBaud2,
      serialMake: (singleRadio ? ul : dl).serialMake,
      serialModel: (singleRadio ? ul : dl).serialModel,
      rotorHost: cfg.rotorHost,
      rotorAzPort: cfg.rotorAzPort,
      rotorElPort: cfg.rotorElPort,
      rotorType: cfg.rotorType,
      rotorAzDevice: cfg.rotorAzDevice,
      rotorElDevice: cfg.rotorElDevice,
      rotorBaud: cfg.rotorBaud,
    }),
  );
}

function sendProfileSelect(name) {
  if (typeof ws === "undefined" || !ws || ws.readyState !== WebSocket.OPEN)
    return;
  ws.send(JSON.stringify({ type: "profile-select", name: name }));
}
function sendProfileCreate(name) {
  if (typeof ws === "undefined" || !ws || ws.readyState !== WebSocket.OPEN)
    return;
  ws.send(
    JSON.stringify({ type: "profile-create", name: name, fromActive: true }),
  );
}
function sendProfileDelete(name) {
  if (typeof ws === "undefined" || !ws || ws.readyState !== WebSocket.OPEN)
    return;
  ws.send(JSON.stringify({ type: "profile-delete", name: name }));
}
function sendProfileRename(from, to) {
  if (typeof ws === "undefined" || !ws || ws.readyState !== WebSocket.OPEN)
    return;
  ws.send(JSON.stringify({ type: "profile-rename", from: from, to: to }));
}

function fillProfileSelect() {
  const el = document.getElementById("cfg-profile");
  if (!el) return;
  const names = profileNames.slice();
  if (activeProfileName && names.indexOf(activeProfileName) < 0)
    names.push(activeProfileName);
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

function applyProfilesMessage(msg) {
  if (!msg || msg.type !== "profiles") return;
  profilesReady = true;
  activeProfileName = msg.active || activeProfileName;
  profileNames = Array.isArray(msg.names) ? msg.names.slice() : [];
  if (activeProfileName)
    localStorage.setItem(PROFILE_CACHE_KEY, activeProfileName);
  fillProfileSelect();

  const cfg = msg.config && typeof msg.config === "object" ? msg.config : {};
  const hasServerCfg = Object.keys(cfg).length > 0;
  const hasServerFavs =
    Array.isArray(msg.favorites) && msg.favorites.length > 0;

  if (!migratedLocalToServer && !hasServerCfg && !hasServerFavs) {
    const localCfg = loadConfig();
    const localFavs =
      typeof loadFavorites === "function" ? loadFavorites() : [];
    const localHas =
      (localCfg &&
        (localCfg.grid ||
          localCfg.callsign ||
          localCfg.tciHost ||
          localCfg.radioUl)) ||
      (localFavs && localFavs.length);
    if (localHas && typeof ws !== "undefined" && ws && ws.readyState === 1) {
      migratedLocalToServer = true;
      const merged = migrateLegacy(
        Object.assign(defaultsEndpoints(), localCfg),
      );
      saveConfig(merged);
      fillForm(merged);
      sendEndpointsToServer(merged);
      if (localFavs.length && typeof saveFavorites === "function") {
        saveFavorites(localFavs);
        if (typeof sendFavoritesToServer === "function")
          sendFavoritesToServer();
      }
      return;
    }
  }

  if (hasServerCfg) {
    const merged = migrateLegacy(Object.assign(defaultsEndpoints(), cfg));
    saveConfig(merged);
    fillForm(merged);
    if (merged.grid && typeof centerOnGrid === "function")
      centerOnGrid(merged.grid);
    if (typeof notifyObserverChanged === "function") notifyObserverChanged();
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
  const cfg = migrateLegacy(loadConfig());
  fillForm(cfg);
  fillProfileSelect();
  initProfileControls();

  const btn = document.getElementById("btn-config");
  const panel = document.getElementById("config-panel");
  if (!btn || !panel) return;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!panel.classList.contains("open")) {
      fillForm(migrateLegacy(loadConfig()));
      fillProfileSelect();
    }
    panel.classList.toggle("open");
  });

  document.addEventListener("click", (e) => {
    if (!panel.contains(e.target) && e.target !== btn) {
      panel.classList.remove("open");
    }
  });

  ["ul", "dl"].forEach((side) => {
    ["transport", "type", "protocol"].forEach((field) => {
      const el = document.getElementById("cfg-" + side + "-" + field);
      if (el) el.addEventListener("change", () => updateSideVisibility(side));
    });
  });

  const singleCb = document.getElementById("cfg-single-radio");
  if (singleCb) {
    singleCb.addEventListener("change", () => updateSingleRadioVisibility());
  }

  const rotorTypeEl = document.getElementById("cfg-rotor-type");
  if (rotorTypeEl) rotorTypeEl.addEventListener("change", onRotorTypeChange);

  const saveBtn = document.getElementById("btn-save-config");
  if (saveBtn) {
    saveBtn.addEventListener("click", () => {
      const newCfg = readFormConfig();
      saveConfig(newCfg);
      if (newCfg.grid && typeof centerOnGrid === "function")
        centerOnGrid(newCfg.grid);
      if (typeof notifyObserverChanged === "function") notifyObserverChanged();
      sendEndpointsToServer(newCfg);
      panel.classList.remove("open");
    });
  }
}

function applySavedGrid() {
  const cfg = loadConfig();
  if (cfg.grid) centerOnGrid(cfg.grid);
}

function pushSavedEndpoints() {
  if (profilesReady) return;
  setTimeout(() => {
    if (profilesReady) return;
    const cfg = migrateLegacy(Object.assign(defaultsEndpoints(), loadConfig()));
    sendEndpointsToServer(cfg);
  }, 1500);
}
