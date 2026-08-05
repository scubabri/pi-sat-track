/* Tracker WebSocket, radio/antenna, station status, frequency panel */
let ws = null;
let reconnectTimer = null;
let lastStateSat = null;
let lastModesKey = "";

let radioOn = false;
let tciConnected = false;
let antennaOn = false;
/** True while a Park slew is in progress (center shows rotor, not sat). */
let parking = false;
let lastGaugeSatAz = null;
let lastGaugeSatEl = null;
let lastGaugeFlipped = false;
let fineStep = 100;
let ulFineOffset = 0;
let manualDlOffset = 0;

function getObserverFromConfig() {
  const cfg = loadConfig();
  if (!cfg.grid) return null;
  const pos = maidenheadToLatLon(cfg.grid);
  if (!pos) return null;
  return {
    lat: pos.lat,
    lon: pos.lon,
    elevM: cfg.elevation || 0,
    callsign: cfg.callsign || "",
    grid: cfg.grid || "",
  };
}

function sendObserver() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const obs = getObserverFromConfig();
  if (obs) {
    ws.send(
      JSON.stringify({
        type: "observer",
        lat: obs.lat,
        lon: obs.lon,
        elevM: obs.elevM,
      }),
    );
  }
}

function updateStationStatus() {
  const cfg = loadConfig();
  const callEl = document.getElementById("station-call");
  const gridEl = document.getElementById("station-grid");
  const latEl = document.getElementById("station-lat");
  const lonEl = document.getElementById("station-lon");
  const elevEl = document.getElementById("station-elev");

  if (callEl) callEl.textContent = cfg.callsign || "-";
  if (gridEl) gridEl.textContent = (cfg.grid || "").toUpperCase() || "-";

  if (cfg.grid) {
    const pos = maidenheadToLatLon(cfg.grid);
    if (pos) {
      if (latEl) latEl.textContent = pos.lat.toFixed(4) + "\u00B0";
      if (lonEl) lonEl.textContent = pos.lon.toFixed(4) + "\u00B0";
    } else {
      if (latEl) latEl.textContent = "-";
      if (lonEl) lonEl.textContent = "-";
    }
  } else {
    if (latEl) latEl.textContent = "-";
    if (lonEl) lonEl.textContent = "-";
  }

  if (elevEl) {
    elevEl.textContent =
      cfg.elevation != null && cfg.elevation !== ""
        ? cfg.elevation + " m"
        : "-";
  }
}
function updateModeSelect(modes, modeIndex) {
  const sel = document.getElementById("mode-select");
  if (!sel) return;

  const key = (modes || [])
    .map((m) => m.mode + "|" + m.uplink + "|" + m.downlink)
    .join(";");
  if (key !== lastModesKey) {
    lastModesKey = key;
    sel.innerHTML = "";
    if (!modes || !modes.length) {
      const opt = document.createElement("option");
      opt.value = "0";
      opt.textContent = "—";
      sel.appendChild(opt);
      sel.disabled = true;
    } else {
      sel.disabled = modes.length < 2;
      modes.forEach((m, i) => {
        const opt = document.createElement("option");
        opt.value = String(m.index != null ? m.index : i);
        const label = m.mode || "(mode " + (i + 1) + ")";
        const freqs = [];
        if (m.uplink && m.uplink !== "-") freqs.push("UL " + m.uplink);
        if (m.downlink && m.downlink !== "-") freqs.push("DL " + m.downlink);
        opt.textContent = freqs.length
          ? label + "  ·  " + freqs.join(" / ")
          : label;
        sel.appendChild(opt);
      });
    }
  }

  if (modeIndex != null && sel.options.length) {
    sel.value = String(modeIndex);
  }
}

function updateFineOffsetDisplay() {
  const el = document.getElementById("fine-offset");
  if (!el) return;
  el.textContent = fmtOffsetHz(ulFineOffset);
  el.classList.toggle("nonzero", Math.abs(ulFineOffset) >= 1);
  el.title =
    "UL fine offset applied to uplink frequency" +
    (manualDlOffset ? " · DL manual " + fmtOffsetHz(manualDlOffset) : "");
}

function updateRadioUi(on, connected) {
  radioOn = !!on;
  tciConnected = !!connected;

  const toggle = document.getElementById("toggle-radio");
  if (toggle) toggle.checked = radioOn;

  const topBtn = document.getElementById("btn-radio");
  if (topBtn) {
    topBtn.classList.toggle("active", radioOn);
    if (radioOn && tciConnected) topBtn.textContent = "Radio ON";
    else if (radioOn) topBtn.textContent = "Radio…";
    else topBtn.textContent = "Radio";
  }

  const tciEl = document.getElementById("status-tci");
  if (tciEl) {
    if (radioOn && tciConnected) tciEl.textContent = "Connected";
    else if (radioOn) tciEl.textContent = "Connecting…";
    else tciEl.textContent = "Disconnected";
  }
}

function updateAntennaUi(on, azConnected, elConnected) {
  antennaOn = !!on;
  if (!antennaOn) parking = false;

  const toggle = document.getElementById("toggle-antenna");
  if (toggle) toggle.checked = antennaOn;

  const topBtn = document.getElementById("btn-antenna");
  if (topBtn) {
    topBtn.classList.toggle("active", antennaOn);
    if (antennaOn && azConnected && elConnected)
      topBtn.textContent = "Antenna ON";
    else if (antennaOn) topBtn.textContent = "Antenna…";
    else topBtn.textContent = "Antenna";
  }
}

function applyRotorStatus(msg) {
  updateAntennaUi(msg.antennaOn, msg.azConnected, msg.elConnected);

  const azEl = document.getElementById("rotor-az");
  const elEl = document.getElementById("rotor-el");
  if (azEl) {
    azEl.textContent =
      msg.az != null && Number.isFinite(msg.az)
        ? Number(msg.az).toFixed(1) + "\u00B0"
        : "-";
  }
  if (elEl) {
    elEl.textContent =
      msg.el != null && Number.isFinite(msg.el)
        ? Number(msg.el).toFixed(1) + "\u00B0"
        : "-";
  }

  if (typeof msg.flipped === "boolean") lastGaugeFlipped = msg.flipped;
  if (typeof updateRotorGauges === "function") {
    // Tracking (above horizon): center = sat. Park/below-horizon/off: center = rotor.
    const showSat =
      antennaOn &&
      !parking &&
      lastGaugeSatEl != null &&
      lastGaugeSatEl >= 0;
    const satAz = showSat ? lastGaugeSatAz : null;
    const satEl = showSat ? lastGaugeSatEl : null;
    updateRotorGauges(
      msg.az,
      msg.el,
      satAz,
      satEl,
      showSat ? lastGaugeFlipped : false,
    );
  }
}

function applyTciStatus(msg) {
  updateRadioUi(msg.radioOn, msg.connected);
  if (typeof msg.ulFineOffset === "number") {
    ulFineOffset = msg.ulFineOffset;
    updateFineOffsetDisplay();
  }
  if (typeof msg.manualDlOffset === "number") {
    manualDlOffset = msg.manualDlOffset;
    updateFineOffsetDisplay();
  }
  if (typeof msg.step === "number") {
    fineStep = msg.step;
    const stepEl = document.getElementById("fine-step");
    if (stepEl && document.activeElement !== stepEl) {
      stepEl.value = String(fineStep);
    }
  }
}

function applyFreqAndLook(msg) {
  if (msg.look && typeof msg.look.el === "number") {
    currentEl = msg.look.el;
    if (typeof refreshCurrentSatChip === "function") refreshCurrentSatChip();
  }

  if (msg.modes) {
    updateModeSelect(msg.modes, msg.modeIndex);
  }

  if (typeof msg.ulFineOffset === "number") {
    ulFineOffset = msg.ulFineOffset;
    updateFineOffsetDisplay();
  }
  if (typeof msg.manualDlOffset === "number") {
    manualDlOffset = msg.manualDlOffset;
    updateFineOffsetDisplay();
  }

  const ulEl = document.getElementById("freq-ul");
  const dlEl = document.getElementById("freq-dl");
  const ulDopEl = document.getElementById("freq-ul-doppler");
  const dlDopEl = document.getElementById("freq-dl-doppler");
  const pbUl = document.getElementById("passband-ul");
  const pbDl = document.getElementById("passband-dl");

  let ulHz =
    msg.ulHz != null && Number.isFinite(msg.ulHz)
      ? msg.ulHz
      : parseToHz(msg.uplink);
  let dlHz =
    msg.dlHz != null && Number.isFinite(msg.dlHz)
      ? msg.dlHz
      : parseToHz(msg.downlink);

  if (ulEl) ulEl.textContent = fmtFreq(ulHz);
  if (dlEl) dlEl.textContent = fmtFreq(dlHz);

  const ulLab = document.getElementById("freq-ul-label");
  const dlLab = document.getElementById("freq-dl-label");
  if (ulLab) {
    ulLab.textContent =
      msg.ulLabel || (msg.isFm ? "Uplink (FM)" : "Uplink (LSB)");
  }
  if (dlLab) {
    dlLab.textContent =
      msg.dlLabel || (msg.isFm ? "Downlink (FM)" : "Downlink (USB)");
  }

  let ulDop = msg.ulDopplerHz;
  let dlDop = msg.dlDopplerHz;
  if (ulDop == null && msg.ulBase != null && ulHz != null) {
    const base = parseToHz(msg.ulBase);
    if (base != null) ulDop = ulHz - base;
  }
  if (dlDop == null && msg.dlBase != null && dlHz != null) {
    const base = parseToHz(msg.dlBase);
    if (base != null) dlDop = dlHz - base;
  }

  if (ulDopEl)
    ulDopEl.textContent =
      ulDop != null ? "Doppler " + fmtDopplerMHz(ulDop) : "";
  if (dlDopEl)
    dlDopEl.textContent =
      dlDop != null ? "Doppler " + fmtDopplerMHz(dlDop) : "";

  if (ulEl && ulDop != null) ulEl.title = "Doppler " + fmtDopplerMHz(ulDop);
  if (dlEl && dlDop != null) dlEl.title = "Doppler " + fmtDopplerMHz(dlDop);

  if (pbUl) pbUl.textContent = msg.passbandUl || "-";
  if (pbDl) pbDl.textContent = msg.passbandDl || "-";

  if (msg.look) {
    lastGaugeSatAz = msg.look.az;
    if (typeof msg.look.el === "number") lastGaugeSatEl = msg.look.el;
    const azEl = document.getElementById("sat-az");
    const elEl = document.getElementById("sat-el");
    const rangeEl = document.getElementById("sat-range");
    if (azEl) azEl.textContent = msg.look.az.toFixed(1) + "\u00B0";
    if (elEl) elEl.textContent = msg.look.el.toFixed(1) + "\u00B0";
    if (rangeEl && msg.look.rangeKm != null) {
      rangeEl.textContent = msg.look.rangeKm.toFixed(1) + " km";
    }
  }

  if (typeof msg.radioOn === "boolean") {
    updateRadioUi(msg.radioOn, msg.tciConnected);
  }

  if (typeof msg.antennaOn === "boolean") {
    updateAntennaUi(msg.antennaOn, msg.rotorAzConnected, msg.rotorElConnected);
  }

  // Always refresh gauges when look or rotor position arrives so sat AZ
  // center readout tracks the satellite as it moves (not only on rotor moves).
  if (msg.look || msg.rotorAz != null || msg.rotorEl != null) {
    const azEl = document.getElementById("rotor-az");
    const elEl = document.getElementById("rotor-el");
    if (azEl && msg.rotorAz != null)
      azEl.textContent = Number(msg.rotorAz).toFixed(1) + "\u00B0";
    if (elEl && msg.rotorEl != null)
      elEl.textContent = Number(msg.rotorEl).toFixed(1) + "\u00B0";
    if (typeof msg.flipped === "boolean") lastGaugeFlipped = msg.flipped;
    if (typeof updateRotorGauges === "function") {
      // Tracking (above horizon): center = sat. Park/below-horizon/off: center = rotor.
      const showSat =
      antennaOn &&
      !parking &&
      lastGaugeSatEl != null &&
      lastGaugeSatEl >= 0;
      const satAz = showSat
        ? msg.look
          ? msg.look.az
          : lastGaugeSatAz
        : null;
      const satEl = showSat
        ? msg.look && typeof msg.look.el === "number"
          ? msg.look.el
          : lastGaugeSatEl
        : null;
      updateRotorGauges(
        msg.rotorAz != null ? msg.rotorAz : null,
        msg.rotorEl != null ? msg.rotorEl : null,
        satAz,
        satEl,
        showSat ? lastGaugeFlipped : false,
      );
    }
  }
}

function sendRadio(on) {
  console.log("Client sendRadio", on);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "radio", on: !!on }));
  } else {
    console.warn("WebSocket not open — cannot toggle radio");
  }
}

function sendAntenna(on) {
  console.log("Client sendAntenna", on);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "antenna", on: !!on }));
  } else {
    console.warn("WebSocket not open — cannot toggle antenna");
  }
}

function sendPark() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  console.log("sendPark");
  parking = true;
  // Immediately show rotor coords in gauge center (not sat)
  if (typeof updateRotorGauges === "function") {
    updateRotorGauges(null, null, null, null, false);
  }
  ws.send(JSON.stringify({ type: "park" }));
}

function sendFine(delta) {
  ulFineOffset += delta;
  updateFineOffsetDisplay();

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "fine", delta: delta, step: fineStep }));
  } else {
    console.warn(
      "WebSocket not open — fine offset is local only until reconnect",
    );
  }
}

function sendCenter() {
  ulFineOffset = 0;
  manualDlOffset = 0;
  updateFineOffsetDisplay();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "center" }));
  }
}

function connectTracker() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = proto + "://" + location.host + "/ws";

  console.log("Connecting to", url);
  ws = new WebSocket(url);

  ws.onopen = () => {
    console.log("Tracker WebSocket connected");
    sendObserver();
    if (typeof pushSavedEndpoints === "function") pushSavedEndpoints();
    updateStationStatus();
    if (typeof currentSatKey !== "undefined" && currentSatKey) {
      if (typeof pendingSatKey !== "undefined") pendingSatKey = currentSatKey;
      ws.send(JSON.stringify({ type: "sat", key: currentSatKey }));
    }
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);

      if (msg.type === "sats") {
        if (typeof renderSatMenu === "function") renderSatMenu(msg);
        return;
      }

      if (msg.type === "tci" || msg.type === "icom" || msg.type === "flex") {
        applyTciStatus(msg);
        return;
      }

      if (msg.type === "rotor") {
        applyRotorStatus(msg);
        return;
      }

      if (msg.type === "error") {
        console.warn("Server error:", msg.message);
        return;
      }

      if (msg.type === "profiles") {
        if (typeof applyProfilesMessage === "function") {
          applyProfilesMessage(msg);
        }
        return;
      }

      if (msg.type === "host" || msg.type === "endpoints") {
        if (msg.rotorCatalog && typeof setRotorCatalog === "function") {
          setRotorCatalog(msg.rotorCatalog);
          if (typeof populateRotorTypes === "function") {
            populateRotorTypes(msg.rotorType);
          }
        }
        if (msg.rotorType && typeof setVal === "function") {
          if (document.getElementById("cfg-rotor-type")) {
            setVal("cfg-rotor-type", msg.rotorType);
            if (msg.rotorAzDevice) {
              setVal("cfg-rotor-device", msg.rotorAzDevice);
              setVal("cfg-rotor-az-device", msg.rotorAzDevice);
            }
            if (msg.rotorElDevice)
              setVal("cfg-rotor-el-device", msg.rotorElDevice);
            if (msg.rotorBaud != null) setVal("cfg-rotor-baud", msg.rotorBaud);
            if (typeof updateRotorFormVisibility === "function") {
              updateRotorFormVisibility();
            }
          }
        }
        return;
      }

      if (msg.type === "tick") {
        applyFreqAndLook(msg);
        if (typeof updateFavPanelFromState === "function") {
          updateFavPanelFromState(
            Object.assign({ type: "tick", sat: msg.sat || currentSatKey }, msg),
          );
        }
        return;
      }

      if (msg.type !== "state") return;

      if (msg.sat) {
        if (msg.sat !== lastStateSat) {
          lastStateSat = msg.sat;
          lastModesKey = "";
          if (typeof clearProfileLock === "function") clearProfileLock();
          if (typeof clearMapTracking === "function") clearMapTracking();
        }
        currentSatKey = msg.sat;
        if (typeof setSatButtonLabel === "function") {
          setSatButtonLabel(msg.display || msg.sat);
        }
      }

      applyFreqAndLook(msg);

      if (typeof updateMapTracking === "function") updateMapTracking(msg);

      if (msg.look) {
        lastGaugeSatAz = msg.look.az;
        if (typeof msg.look.el === "number") lastGaugeSatEl = msg.look.el;
        if (typeof msg.flipped === "boolean") lastGaugeFlipped = msg.flipped;
        if (typeof updateRotorGauges === "function") {
          const showSat =
      antennaOn &&
      !parking &&
      lastGaugeSatEl != null &&
      lastGaugeSatEl >= 0;
          const satAz = showSat ? lastGaugeSatAz : null;
          const satEl = showSat ? lastGaugeSatEl : null;
          updateRotorGauges(
            msg.rotorAz != null ? msg.rotorAz : null,
            msg.rotorEl != null ? msg.rotorEl : null,
            satAz,
            satEl,
            showSat ? lastGaugeFlipped : false,
          );
        }
        const sky =
          msg.passes && msg.passes[0] && msg.passes[0].sky
            ? msg.passes[0].sky
            : null;
        if (typeof updateRadar === "function") {
          updateRadar(msg.look.az, msg.look.el, sky);
        }
      }

      if (typeof updateProfile === "function") updateProfile(msg);
      if (typeof updateSidebar === "function") updateSidebar(msg);
      updateSatelliteStatus(msg);
      if (typeof updateFavPanelFromState === "function")
        updateFavPanelFromState(msg);
    } catch (e) {
      console.warn("Bad state message", e);
    }
  };

  ws.onclose = () => {
    console.log("Tracker WebSocket closed - reconnecting in 2s");
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectTracker, 2000);
  };

  ws.onerror = () => {
    ws.close();
  };
}

const satnogsIdCache = new Map();
let satnogsLinkNorad = null;

function satnogsDbUrl(satId) {
  return "https://db.satnogs.org/satellite/" + encodeURIComponent(satId);
}

function resolveSatnogsId(norad) {
  const key = String(norad || "").trim();
  if (!key) return Promise.resolve(null);
  if (satnogsIdCache.has(key)) {
    return Promise.resolve(satnogsIdCache.get(key));
  }
  return fetch("/api/satnogs?norad=" + encodeURIComponent(key))
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const id = j && j.sat_id ? String(j.sat_id) : null;
      satnogsIdCache.set(key, id);
      return id;
    })
    .catch(() => {
      satnogsIdCache.set(key, null);
      return null;
    });
}

function setSatNamePlain(nameEl, name) {
  if (!nameEl) return;
  nameEl.textContent = name;
}

function setSatNameLink(nameEl, name, satId) {
  if (!nameEl || !satId) {
    setSatNamePlain(nameEl, name);
    return;
  }
  nameEl.textContent = "";
  const a = document.createElement("a");
  a.href = satnogsDbUrl(satId);
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.className = "sat-name-link";
  a.textContent = name;
  a.title = "Open in SatNOGS DB";
  nameEl.appendChild(a);
}

function updateSatelliteStatus(state) {
  const nameEl = document.getElementById("sat-common");
  const noradEl = document.getElementById("sat-norad");
  const orbitEl = document.getElementById("sat-orbit");

  const name = state.display || state.sat || "-";
  const norad = state.norad != null ? String(state.norad) : null;

  if (noradEl) noradEl.textContent = norad || "-";

  if (nameEl) {
    if (norad && name !== "-") {
      const cached = satnogsIdCache.has(norad)
        ? satnogsIdCache.get(norad)
        : undefined;
      if (cached) {
        satnogsLinkNorad = norad;
        setSatNameLink(nameEl, name, cached);
      } else {
        satnogsLinkNorad = norad;
        setSatNamePlain(nameEl, name);
        if (cached === undefined) {
          resolveSatnogsId(norad).then((satId) => {
            if (satnogsLinkNorad !== norad) return;
            if (satId) setSatNameLink(nameEl, name, satId);
          });
        }
      }
    } else {
      satnogsLinkNorad = null;
      setSatNamePlain(nameEl, name);
    }
  }

  if (state.look) {
    const azEl = document.getElementById("sat-az");
    const elEl = document.getElementById("sat-el");
    const rangeEl = document.getElementById("sat-range");
    if (azEl) azEl.textContent = state.look.az.toFixed(1) + "\u00B0";
    if (elEl) elEl.textContent = state.look.el.toFixed(1) + "\u00B0";
    if (rangeEl) {
      const km = state.look.rangeKm;
      rangeEl.textContent = km != null ? km.toFixed(1) + " km" : "-";
    }
  }

  if (orbitEl) {
    orbitEl.textContent = state.orbit != null ? String(state.orbit) : "-";
  }
}
function notifyObserverChanged() {
  sendObserver();
  updateStationStatus();
}
function initModeSelect() {
  const sel = document.getElementById("mode-select");
  if (!sel) return;
  sel.addEventListener("change", () => {
    const idx = parseInt(sel.value, 10);
    if (!Number.isFinite(idx)) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "mode", index: idx }));
    }
  });
}

function initRadioControls() {
  const toggle = document.getElementById("toggle-radio");
  if (toggle) {
    toggle.addEventListener("change", () => {
      console.log("toggle-radio change", toggle.checked);
      sendRadio(toggle.checked);
    });
  }

  const topBtn = document.getElementById("btn-radio");
  if (topBtn) {
    topBtn.addEventListener("click", () => {
      console.log("btn-radio click, currently", radioOn);
      sendRadio(!radioOn);
    });
  }

  const antToggle = document.getElementById("toggle-antenna");
  if (antToggle) {
    antToggle.addEventListener("change", () => {
      console.log("toggle-antenna change", antToggle.checked);
      sendAntenna(antToggle.checked);
    });
  }

  const antBtn = document.getElementById("btn-antenna");
  if (antBtn) {
    antBtn.addEventListener("click", () => {
      console.log("btn-antenna click, currently", antennaOn);
      sendAntenna(!antennaOn);
    });
  }

  const parkBtn = document.getElementById("btn-park");
  if (parkBtn) {
    parkBtn.addEventListener("click", () => {
      console.log("btn-park click");
      sendPark();
    });
  }

  const minus = document.getElementById("btn-fine-minus");
  const plus = document.getElementById("btn-fine-plus");
  const stepEl = document.getElementById("fine-step");

  if (minus) {
    minus.addEventListener("click", () => {
      const step = parseInt(stepEl && stepEl.value, 10) || fineStep;
      fineStep = step;
      sendFine(-step);
    });
  }
  if (plus) {
    plus.addEventListener("click", () => {
      const step = parseInt(stepEl && stepEl.value, 10) || fineStep;
      fineStep = step;
      sendFine(+step);
    });
  }

  if (stepEl) {
    stepEl.addEventListener("change", () => {
      const step = parseInt(stepEl.value, 10);
      if (!Number.isFinite(step) || step <= 0) {
        stepEl.value = String(fineStep);
        return;
      }
      fineStep = step;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "fine", delta: 0, step: fineStep }));
      }
    });
    stepEl.addEventListener("dblclick", () => {
      sendCenter();
    });
    stepEl.title = "Fine step (Hz). Double-click to center/reset offsets.";
  }

  updateFineOffsetDisplay();
}

function initTrackerUi() {
  if (typeof startCountdownTimer === "function") startCountdownTimer();
  updateStationStatus();
  initModeSelect();
  initRadioControls();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initTrackerUi);
} else {
  initTrackerUi();
}
