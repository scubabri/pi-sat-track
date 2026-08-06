/**
 * Config panel: profiles, send endpoints to server, init.
 * Requires config-defaults.js and config-form.js (script order).
 */

/** Active profile name from server (null until first profiles message). */
let activeProfileName = localStorage.getItem(PROFILE_CACHE_KEY) || null;
let profileNames = [];
let profilesReady = false;
let migratedLocalToServer = false;

function sideToServerFields(side, s) {
  return s;
}

function sendEndpointsToServer(cfg) {
  if (typeof ws === "undefined" || !ws || ws.readyState !== WebSocket.OPEN)
    return;
  const singleRadio = !!cfg.singleRadio;
  const ul = cfg.radioUl || defaultSide("ul");
  const dl = singleRadio
    ? Object.assign({}, ul)
    : cfg.radioDl || defaultSide("dl");

  const ulCat = parseEndpoint(ul.catEndpoint, "172.17.18.229", 60002);
  const dlCat = parseEndpoint(dl.catEndpoint, "172.17.18.229", 60001);
  const ulRig = parseEndpoint(ul.rigctlEndpoint, "127.0.0.1", 4532);
  const dlRig = parseEndpoint(dl.rigctlEndpoint, "127.0.0.1", 4532);
  const ulTci = parseEndpoint(ul.tciEndpoint, "127.0.0.1", 50001);
  const dlTci = parseEndpoint(dl.tciEndpoint, "127.0.0.1", 50001);
  const ulSdr = parseEndpoint(ul.sdrconnectEndpoint, "127.0.0.1", 5454);
  const dlSdr = parseEndpoint(dl.sdrconnectEndpoint, "127.0.0.1", 5454);
  const api = parseEndpoint(dl.apiEndpoint || ul.apiEndpoint, "", 4992);

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
      txSplit: cfg.txSplit !== false,
      radioUl: ul,
      radioDl: dl,
      radioTransport: dl.transport,
      radioType: dl.type,
      radioProtocol: dl.protocol,
      tciHost: (dl.protocol === "tci" ? dlTci : ulTci).host,
      tciPort: (dl.protocol === "tci" ? dlTci : ulTci).port,
      sdrconnectHost: (dl.type === "sdrconnect" || dl.type === "sdrplay"
        ? dlSdr
        : ulSdr
      ).host,
      sdrconnectPort: (dl.type === "sdrconnect" || dl.type === "sdrplay"
        ? dlSdr
        : ulSdr
      ).port,
      rigctlHost: dlRig.host,
      rigctlPort: dlRig.port,
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
      rotorParkAz: cfg.rotorParkAz,
      rotorParkEl: cfg.rotorParkEl,
      rotorElMax: cfg.rotorElMax != null ? cfg.rotorElMax : 180,
      rotorAzOnly: !!cfg.rotorAzOnly,
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

  const rotorTypeEl = document.getElementById("cfg-rotor-type");
  if (rotorTypeEl) rotorTypeEl.addEventListener("change", onRotorTypeChange);

  const azOnlyEl = document.getElementById("cfg-rotor-az-only");
  if (azOnlyEl) {
    azOnlyEl.addEventListener("change", () => updateRotorFormVisibility());
  }

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
