/**
 * Config panel form: side visibility, read/fill, rotor form helpers.
 * Requires config-defaults.js (val, setVal, defaultSide, migrateLegacy, …).
 */

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

function isRotorAzOnlyChecked() {
  const el = document.getElementById("cfg-rotor-az-only");
  return !!(el && el.checked);
}

function updateRotorFormVisibility() {
  const type = val("cfg-rotor-type") || "rt21";
  const info = findRotorDriver(type);
  const ports = info && info.ports != null ? info.ports : 2;
  const azOnly = isRotorAzOnlyChecked();
  const single = document.getElementById("cfg-rotor-single-block");
  const dual = document.getElementById("cfg-rotor-dual-block");
  const hint = document.getElementById("cfg-rotor-hint");
  if (single) single.hidden = ports !== 1;
  if (dual) dual.hidden = ports !== 2;
  // AZ-only: hide EL device, park EL, 180° elevation
  const elDev = document.getElementById("cfg-rotor-el-device-wrap");
  const el180 = document.getElementById("cfg-rotor-el-180-wrap");
  const parkEl = document.getElementById("cfg-rotor-park-el-wrap");
  if (elDev) elDev.hidden = azOnly;
  if (el180) el180.hidden = azOnly;
  if (parkEl) parkEl.hidden = azOnly;
  if (hint) {
    const base = info && info.hint ? info.hint : "";
    hint.textContent = azOnly
      ? (base ? base + " " : "") + "AZ only — elevation is not commanded."
      : base;
  }
}

function onRotorTypeChange() {
  const type = val("cfg-rotor-type") || "rt21";
  const info = findRotorDriver(type);
  updateRotorFormVisibility();
  if (!info) return;
  if (info.defaultBaud) setVal("cfg-rotor-baud", info.defaultBaud);
  if (info.ports === 1) {
    if (info.defaultDevice)
      populateSerialDeviceSelect("cfg-rotor-device", info.defaultDevice);
  } else {
    if (info.defaultDevice)
      populateSerialDeviceSelect("cfg-rotor-az-device", info.defaultDevice);
  }
}

function listSerialModels(makeId) {
  const make = SERIAL_CATALOG[String(makeId || "").toLowerCase()];
  if (!make || !Array.isArray(make.models)) return [];
  return make.models;
}

/** Live list from server platform.listSerialDevices() via host message. */
let HOST_SERIAL_DEVICES = [];
/** From server hostInfo — COM* on Windows, /dev/tty* on Linux/Pi/macOS. */
let HOST_DEFAULT_SERIAL = "";
let HOST_KIND = "";

const SERIAL_DEVICE_SELECT_IDS = [
  "cfg-ul-serial-device",
  "cfg-dl-serial-device",
  "cfg-rotor-device",
  "cfg-rotor-az-device",
  "cfg-rotor-el-device",
];

function setHostSerialDevices(list, defaultDevice, kind) {
  HOST_SERIAL_DEVICES = Array.isArray(list)
    ? list.filter((d) => d && String(d).trim())
    : [];
  if (defaultDevice != null && String(defaultDevice).trim()) {
    HOST_DEFAULT_SERIAL = String(defaultDevice).trim();
  } else if (HOST_SERIAL_DEVICES.length) {
    HOST_DEFAULT_SERIAL = HOST_SERIAL_DEVICES[0];
  } else {
    HOST_DEFAULT_SERIAL = "";
  }
  if (kind) HOST_KIND = String(kind);
  populateAllSerialDeviceSelects();
}

/** True if path looks native for the current host kind. */
function serialPathFitsHost(path) {
  const p = String(path || "").trim();
  if (!p) return false;
  const kind = HOST_KIND || "";
  if (kind === "windows" || /^win/i.test(kind)) {
    return /^COM\d+$/i.test(p);
  }
  if (kind === "macos" || kind === "darwin") {
    return p.indexOf("/dev/") === 0;
  }
  // linux / raspberry-pi / unknown unix
  if (/^COM\d+$/i.test(p)) return false;
  return p.indexOf("/dev/") === 0 || p.charAt(0) === "/";
}

/** Default serial path for this host — never a cross-OS leftover. */
function hostSerialDefault(fallbackLinux) {
  if (HOST_DEFAULT_SERIAL && serialPathFitsHost(HOST_DEFAULT_SERIAL)) {
    return HOST_DEFAULT_SERIAL;
  }
  if (HOST_SERIAL_DEVICES.length) return HOST_SERIAL_DEVICES[0];
  if (HOST_KIND === "windows" || HOST_KIND === "win32") return "";
  if (fallbackLinux && serialPathFitsHost(fallbackLinux)) return fallbackLinux;
  return fallbackLinux || "";
}

/** Drop saved /dev paths when running on Windows (and vice versa). */
function sanitizeSerialPreferred(path) {
  const p = String(path || "").trim();
  if (!p) return hostSerialDefault("");
  if (HOST_KIND && !serialPathFitsHost(p)) return hostSerialDefault("");
  return p;
}

function populateAllSerialDeviceSelects() {
  SERIAL_DEVICE_SELECT_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const custom = document.getElementById(id + "-custom");
    let preferred = el.value;
    if (preferred === "__custom__" && custom) preferred = custom.value;
    else if (!preferred && custom && custom.value) preferred = custom.value;
    // Prefer currently displayed/custom value; fall back to nothing
    populateSerialDeviceSelect(id, preferred || null);
  });
}

/**
 * Fill a <select> with discovered /dev/ttyUSB* and /dev/ttyACM* (etc.).
 * Keeps preferred path even if not currently plugged in.
 * "Custom…" reveals a free-text field.
 */
function populateSerialDeviceSelect(elId, preferred) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (el.tagName !== "SELECT") {
    // Legacy text input — leave alone
    if (preferred != null && preferred !== "") el.value = preferred;
    return;
  }
  const custom = document.getElementById(elId + "-custom");
  const prev =
    preferred != null && preferred !== ""
      ? String(preferred).trim()
      : el.value === "__custom__" && custom
        ? (custom.value || "").trim()
        : (el.value || "").trim();

  const devices = HOST_SERIAL_DEVICES.slice();
  if (prev && prev !== "__custom__" && devices.indexOf(prev) < 0) {
    devices.unshift(prev);
  }

  el.innerHTML = "";
  if (!devices.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "(no serial devices found)";
    el.appendChild(o);
  } else {
    devices.forEach((d) => {
      const o = document.createElement("option");
      o.value = d;
      o.textContent = d;
      el.appendChild(o);
    });
  }
  const custOpt = document.createElement("option");
  custOpt.value = "__custom__";
  custOpt.textContent = "Custom…";
  el.appendChild(custOpt);

  if (prev && devices.indexOf(prev) >= 0) {
    el.value = prev;
    if (custom) {
      custom.hidden = true;
      custom.value = prev;
    }
  } else if (prev) {
    el.value = "__custom__";
    if (custom) {
      custom.hidden = false;
      custom.value = prev;
    }
  } else if (HOST_SERIAL_DEVICES.length) {
    el.value = HOST_SERIAL_DEVICES[0];
    if (custom) custom.hidden = true;
  } else if (devices.length) {
    el.value = devices[0];
    if (custom) custom.hidden = true;
  } else {
    el.value = "__custom__";
    if (custom) custom.hidden = false;
  }
}

function onSerialDeviceSelectChange(elId) {
  const el = document.getElementById(elId);
  const custom = document.getElementById(elId + "-custom");
  if (!el || !custom) return;
  if (el.value === "__custom__") {
    custom.hidden = false;
    custom.focus();
  } else {
    custom.hidden = true;
    if (el.value) custom.value = el.value;
  }
}

function readSerialDeviceField(elId) {
  const el = document.getElementById(elId);
  if (!el) return "";
  if (el.tagName === "SELECT") {
    if (el.value === "__custom__") {
      const c = document.getElementById(elId + "-custom");
      return c ? c.value.trim() : "";
    }
    return (el.value || "").trim();
  }
  return (el.value || "").trim();
}

function initSerialDeviceSelects() {
  SERIAL_DEVICE_SELECT_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (!el || el.tagName !== "SELECT") return;
    if (el.dataset.serialBound) return;
    el.dataset.serialBound = "1";
    el.addEventListener("change", () => onSerialDeviceSelectChange(id));
  });
}

/** Re-scan devices from the Pi via /api/host (plug/unplug without reload). */
function refreshHostSerialDevices() {
  return fetch("/api/host", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (data && Array.isArray(data.serialDevices)) {
        setHostSerialDevices(
          data.serialDevices,
          data.defaultCatDevice || "",
          data.kind || data.platform || "",
        );
      }
      return data;
    })
    .catch(() => null);
}

function populateSerialModels(side, selectedModel) {
  const makeEl = document.getElementById("cfg-" + side + "-serial-make");
  const modelEl = document.getElementById("cfg-" + side + "-serial-model");
  if (!modelEl) return;
  const make = makeEl ? makeEl.value : "icom";
  const models = listSerialModels(make);
  const prev = selectedModel || modelEl.value;
  modelEl.innerHTML = "";
  models.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label || m.id;
    if (m.supported === false) opt.textContent += " (soon)";
    modelEl.appendChild(opt);
  });
  if (models.some((m) => m.id === prev)) modelEl.value = prev;
  else if (models.length) modelEl.value = models[0].id;
  applySerialModelDefaultsToForm(side);
}

function applySerialModelDefaultsToForm(side) {
  const make = val("cfg-" + side + "-serial-make") || "icom";
  const model = val("cfg-" + side + "-serial-model");
  const models = listSerialModels(make);
  const m = models.find((x) => x.id === model);
  if (!m) return;
  if (m.defaultBaud) setVal("cfg-" + side + "-serial-baud", m.defaultBaud);
  if (m.defaultDevice)
    populateSerialDeviceSelect(
      "cfg-" + side + "-serial-device",
      m.defaultDevice,
    );
}

function readSide(side) {
  const p = "cfg-" + side;
  let transport = val(p + "-transport") || "tcp";
  let type = val(p + "-type") || "smartsdr";
  if (type === "flex") type = "smartsdr";
  let protocol = val(p + "-protocol") || "cat";
  if (type === "rigctl") protocol = "rigctl";
  else if (type === "sdrconnect" || type === "sdrplay") protocol = "websocket";
  else if (type === "smartsdr" && protocol === "tci") protocol = "cat";

  return {
    transport,
    type,
    protocol,
    tciEndpoint: val(p + "-tci-endpoint") || "127.0.0.1:50001",
    rigctlEndpoint: val(p + "-rigctl-endpoint") || "127.0.0.1:4532",
    catEndpoint: val(p + "-cat-endpoint") || "",
    sdrconnectEndpoint: val(p + "-sdrconnect-endpoint") || "127.0.0.1:5454",
    apiEndpoint: val(p + "-api-endpoint") || "",
    serialMake: val(p + "-serial-make") || "icom",
    serialModel: val(p + "-serial-model") || "ic-705",
    serialDevice:
      readSerialDeviceField("cfg-" + side + "-serial-device") ||
      hostSerialDefault("/dev/ttyACM0"),
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
  setVal(p + "-sdrconnect-endpoint", d.sdrconnectEndpoint || "127.0.0.1:5454");
  setVal(p + "-api-endpoint", d.apiEndpoint || "");
  setVal(p + "-serial-make", d.serialMake || "icom");
  populateSerialModels(side, d.serialModel || "ic-705");
  setVal(p + "-serial-model", d.serialModel || "ic-705");
  populateSerialDeviceSelect(
    p + "-serial-device",
    sanitizeSerialPreferred(d.serialDevice) ||
      hostSerialDefault("/dev/ttyACM0"),
  );
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
  if (type === "sdrconnect" || type === "sdrplay") {
    add("websocket", "WebSocket");
    proto.value = "websocket";
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
  const sdrconnectBlock = document.getElementById(p + "-sdrconnect-block");
  const catBlock = document.getElementById(p + "-cat-block");
  const apiBlock = document.getElementById(p + "-api-block");
  const protocolRow = document.getElementById(p + "-protocol-row");

  if (tcpBlock) tcpBlock.hidden = transport !== "tcp";
  if (serialBlock) serialBlock.hidden = transport !== "serial";

  if (transport !== "tcp") {
    if (protocolRow) protocolRow.hidden = true;
    if (tciBlock) tciBlock.hidden = true;
    if (rigctlBlock) rigctlBlock.hidden = true;
    if (sdrconnectBlock) sdrconnectBlock.hidden = true;
    if (catBlock) catBlock.hidden = true;
    if (apiBlock) apiBlock.hidden = true;
    return;
  }

  const isRigctl = type === "rigctl" || protocol === "rigctl";
  const isSdrconnect = type === "sdrconnect" || type === "sdrplay";
  const isTci =
    !isRigctl && !isSdrconnect && protocol === "tci" && type === "aethersdr";
  const isCat =
    !isRigctl &&
    !isSdrconnect &&
    protocol === "cat" &&
    (type === "smartsdr" || type === "aethersdr" || type === "flex");
  const needsApi = isCat || isTci;

  if (protocolRow) protocolRow.hidden = isRigctl || isSdrconnect;
  if (tciBlock) tciBlock.hidden = !isTci;
  if (rigctlBlock) rigctlBlock.hidden = !isRigctl;
  if (sdrconnectBlock) sdrconnectBlock.hidden = !isSdrconnect;
  if (catBlock) catBlock.hidden = !isCat;
  if (apiBlock) apiBlock.hidden = !needsApi;
}

function isSingleRadioChecked() {
  const el = document.getElementById("cfg-single-radio");
  return el ? !!el.checked : false;
}

function updateSingleRadioVisibility() {
  const single = isSingleRadioChecked();
  const dlSection = document.getElementById("cfg-dl-section");
  const ulTitle = document.getElementById("cfg-ul-title");
  if (dlSection) dlSection.hidden = single;
  if (ulTitle) {
    ulTitle.textContent = single ? "Radio (TX/RX)" : "Radio UL (TX)";
  }
  const btnUl = document.getElementById("btn-test-radio-ul");
  const btnDl = document.getElementById("btn-test-radio-dl");
  if (btnUl) {
    const label = single ? "Test radio" : "Test UL";
    btnUl.dataset.label = label;
    if (!btnUl.classList.contains("test-busy")) {
      btnUl.textContent = label;
    }
  }
  if (btnDl) {
    btnDl.hidden = !!single;
    // clear stale OK/Fail color when switching modes
    btnDl.classList.remove("test-ok", "test-fail", "test-busy");
    btnDl.disabled = false;
    btnDl.textContent = btnDl.dataset.label || "Test DL";
  }
  if (btnUl) {
    btnUl.classList.remove("test-ok", "test-fail");
  }
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
  const radioDl = singleRadio ? Object.assign({}, radioUl) : readSide("dl");

  return {
    callsign: val("cfg-callsign").trim().toUpperCase(),
    grid: val("cfg-grid").trim().toUpperCase(),
    elevation: elevRaw ? parseInt(elevRaw.value, 10) || 0 : 0,
    singleRadio,
    txSplit: (function () {
      const el = document.getElementById("cfg-tx-split");
      return el ? !!el.checked : true;
    })(),
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
        return (
          readSerialDeviceField("cfg-rotor-device") ||
          hostSerialDefault("/dev/ttyACM0")
        );
      }
      return (
        readSerialDeviceField("cfg-rotor-az-device") ||
        hostSerialDefault("/dev/ttyUSB0")
      );
    })(),
    rotorElDevice: (function () {
      const t = val("cfg-rotor-type") || "rt21";
      const info = findRotorDriver(t);
      const ports = info && info.ports != null ? info.ports : 2;
      if (ports === 1) {
        return (
          readSerialDeviceField("cfg-rotor-device") ||
          hostSerialDefault("/dev/ttyACM0")
        );
      }
      return (
        readSerialDeviceField("cfg-rotor-el-device") ||
        hostSerialDefault("/dev/ttyUSB1")
      );
    })(),
    rotorBaud: parseInt(val("cfg-rotor-baud"), 10) || 4800,
    rotorParkAz: parseFloat(val("cfg-rotor-park-az")) || 0,
    rotorParkEl: parseFloat(val("cfg-rotor-park-el")) || 0,
    rotorElMax: (function () {
      const el = document.getElementById("cfg-rotor-el-180");
      return el && el.checked ? 180 : 90;
    })(),
    rotorAzOnly: isRotorAzOnlyChecked(),
    rotorAzStop: (function () {
      const s = document.getElementById("cfg-rotor-az-stop-s");
      if (s && s.checked) return "south";
      return "north";
    })(),
  };
}

function fillForm(cfg) {
  const d = migrateLegacy(Object.assign(defaultsEndpoints(), cfg || {}));
  setVal("cfg-callsign", d.callsign || "");
  setVal("cfg-grid", d.grid || "");
  setVal("cfg-elev", d.elevation != null ? d.elevation : "");
  const singleEl = document.getElementById("cfg-single-radio");
  if (singleEl) singleEl.checked = !!d.singleRadio;
  const txSplitEl = document.getElementById("cfg-tx-split");
  if (txSplitEl) txSplitEl.checked = d.txSplit !== false;
  fillSide("ul", d.radioUl);
  fillSide("dl", d.radioDl);
  updateSingleRadioVisibility();
  populateRotorTypes(d.rotorType || "rt21");
  populateSerialDeviceSelect(
    "cfg-rotor-device",
    sanitizeSerialPreferred(d.rotorAzDevice) ||
      hostSerialDefault("/dev/ttyACM0"),
  );
  populateSerialDeviceSelect(
    "cfg-rotor-az-device",
    sanitizeSerialPreferred(d.rotorAzDevice) ||
      hostSerialDefault("/dev/ttyUSB0"),
  );
  populateSerialDeviceSelect(
    "cfg-rotor-el-device",
    sanitizeSerialPreferred(d.rotorElDevice) ||
      hostSerialDefault("/dev/ttyUSB1"),
  );
  setVal("cfg-rotor-baud", d.rotorBaud != null ? d.rotorBaud : 4800);
  setVal("cfg-rotor-park-az", d.rotorParkAz != null ? d.rotorParkAz : 0);
  setVal("cfg-rotor-park-el", d.rotorParkEl != null ? d.rotorParkEl : 0);
  const el180 = document.getElementById("cfg-rotor-el-180");
  if (el180) {
    const max = d.rotorElMax != null ? Number(d.rotorElMax) : 180;
    el180.checked = max !== 90;
  }
  const azOnlyEl = document.getElementById("cfg-rotor-az-only");
  if (azOnlyEl) azOnlyEl.checked = !!d.rotorAzOnly;
  const stop =
    String(d.rotorAzStop || "north").toLowerCase() === "south"
      ? "south"
      : "north";
  const stopN = document.getElementById("cfg-rotor-az-stop-n");
  const stopS = document.getElementById("cfg-rotor-az-stop-s");
  if (stopN) stopN.checked = stop === "north";
  if (stopS) stopS.checked = stop === "south";
  updateRotorFormVisibility();
}
