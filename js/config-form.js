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
    if (info.defaultDevice) setVal("cfg-rotor-device", info.defaultDevice);
  } else {
    if (info.defaultDevice) setVal("cfg-rotor-az-device", info.defaultDevice);
  }
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
  setVal(p + "-sdrconnect-endpoint", d.sdrconnectEndpoint || "127.0.0.1:5454");
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
  // Single-radio checkbox removed — always show both UL and DL sides.
  // TX split is independent (txSplit / cfg-tx-split).
  return false;
}

function updateSingleRadioVisibility() {
  const dlSection = document.getElementById("cfg-dl-section");
  const ulTitle = document.getElementById("cfg-ul-title");
  if (dlSection) dlSection.hidden = false;
  if (ulTitle) ulTitle.textContent = "Radio UL (TX)";
  updateSideVisibility("ul");
  updateSideVisibility("dl");
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
    rotorParkAz: parseFloat(val("cfg-rotor-park-az")) || 0,
    rotorParkEl: parseFloat(val("cfg-rotor-park-el")) || 0,
    rotorElMax: (function () {
      const el = document.getElementById("cfg-rotor-el-180");
      return el && el.checked ? 180 : 90;
    })(),
    rotorAzOnly: isRotorAzOnlyChecked(),
  };
}

function fillForm(cfg) {
  const d = migrateLegacy(Object.assign(defaultsEndpoints(), cfg || {}));
  setVal("cfg-callsign", d.callsign || "");
  setVal("cfg-grid", d.grid || "");
  setVal("cfg-elev", d.elevation != null ? d.elevation : "");
  const txSplitEl = document.getElementById("cfg-tx-split");
  if (txSplitEl) txSplitEl.checked = d.txSplit !== false;
  fillSide("ul", d.radioUl);
  fillSide("dl", d.radioDl);
  updateSingleRadioVisibility();
  populateRotorTypes(d.rotorType || "rt21");
  setVal("cfg-rotor-device", d.rotorAzDevice || "/dev/ttyACM0");
  setVal("cfg-rotor-az-device", d.rotorAzDevice || "/dev/ttyUSB0");
  setVal("cfg-rotor-el-device", d.rotorElDevice || "/dev/ttyUSB1");
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
  updateRotorFormVisibility();
}
