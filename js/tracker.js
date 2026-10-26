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
        ? (typeof Units !== "undefined" ? Units.height(cfg.elevation) : cfg.elevation + " m")
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
      // A single mode stays enabled (not greyed): it's still the active mode.
      sel.disabled = false;
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
        opt.title = opt.textContent;
        sel.appendChild(opt);
      });
    }
  }

  if (modeIndex != null && sel.options.length) {
    sel.value = String(modeIndex);
  }
  syncModeSelectTitle(sel);
}

/** Hover shows the full selected mode text (the select truncates it). */
function syncModeSelectTitle(sel) {
  const opt = sel.options[sel.selectedIndex];
  const txt = opt && opt.value !== "" && opt.textContent !== "—" ? opt.textContent : "";
  sel.title = txt ? "Mode: " + txt : "Transponder / mode";
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

/** Top-bar Auto Select button (per profile; independent of Radio/Antenna). */
let autoSelectOn = false;
function updateAutoSelectUi(on) {
  autoSelectOn = !!on;
  const btn = document.getElementById("btn-auto-select");
  if (!btn) return;
  btn.classList.toggle("active", autoSelectOn);
  btn.textContent = autoSelectOn ? "Auto Select ON" : "Auto Select";
}

// Latest click wins (js/set-guard.js): until the server acks this set, the
// "profiles" / "state" values for Auto Select are remembered, not applied.
let lastServerAutoSelect = null;
const autoSelectGuard = typeof createSetGuard === "function"
  ? createSetGuard({ onRelease: () => { if (lastServerAutoSelect != null) updateAutoSelectUi(lastServerAutoSelect); } })
  : null;
/** Auto Select as reported by the server (profiles payload / state.afterLos). */
function applyServerAutoSelect(on) {
  lastServerAutoSelect = !!on;
  if (autoSelectGuard && autoSelectGuard.held("autoSelect")) return;
  updateAutoSelectUi(on);
}

function sendAutoSelect(on) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  updateAutoSelectUi(on); // optimistic; server broadcast confirms
  const m = { type: "auto-select-set", on: !!on };
  if (autoSelectGuard) m.seq = autoSelectGuard.begin(["autoSelect"]);
  ws.send(JSON.stringify(m));
}

/**
 * Top-bar Auto Engage button (per profile, saved on the server, which does the
 * work with no browser open; lib/auto-engage.js). Radio + Antenna on at T-5
 * for every pass of the selected sat, off after LOS (only what it turned on).
 * Separate from the pass alert bells.
 */
const AUTO_ENGAGE_TIP_OFF =
  "Auto Engage: turn Radio and Antenna on 5 min before AOS of the selected sat's next pass and back off after LOS " +
  "(only what it turned on; anything you turn off stays off for that pass). Works with no browser open. " +
  "Separate from the pass alert bells; mark single passes with the antenna icon in Next Passes.";
let autoEngageOn = false;
let autoEngageStatus = null;
function autoEngageTitle() {
  const st = autoEngageStatus;
  let tip = autoEngageOn ? "Auto Engage ON \u2014 click to turn off.\n" + AUTO_ENGAGE_TIP_OFF : AUTO_ENGAGE_TIP_OFF;
  if (st && st.engaged) {
    const parts = [];
    if (st.engaged.radio) parts.push("Radio");
    if (st.engaged.antenna) parts.push("Antenna");
    tip += "\nEngaged for " + st.engaged.sat + (parts.length ? " (turned on: " + parts.join(" + ") + ")" : "");
  } else if (st && st.selecting) {
    tip += "\nSelecting " + st.selecting + " for a marked pass";
  }
  return tip;
}
function updateAutoEngageUi(on) {
  autoEngageOn = !!on;
  const btn = document.getElementById("btn-auto-engage");
  if (!btn) return;
  btn.classList.toggle("active", autoEngageOn);
  btn.classList.toggle("engaged", !!(autoEngageStatus && autoEngageStatus.engaged));
  btn.textContent = autoEngageOn ? "Auto Engage ON" : "Auto Engage";
  const tip = autoEngageTitle();
  if (btn.title !== tip) btn.title = tip;
}
let lastServerAutoEngage = null;
const autoEngageGuard = typeof createSetGuard === "function"
  ? createSetGuard({ onRelease: () => { if (lastServerAutoEngage != null) updateAutoEngageUi(lastServerAutoEngage); } })
  : null;
/** Auto Engage as reported by the server (profiles payload / state.autoEngage). */
function applyServerAutoEngage(on, status) {
  if (status !== undefined) autoEngageStatus = status || null;
  lastServerAutoEngage = !!on;
  if (autoEngageGuard && autoEngageGuard.held("autoEngage")) { updateAutoEngageUi(autoEngageOn); return; }
  updateAutoEngageUi(on);
}
function sendAutoEngage(on) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  updateAutoEngageUi(on); // optimistic; server broadcast confirms
  const m = { type: "auto-engage-set", on: !!on };
  if (autoEngageGuard) m.seq = autoEngageGuard.begin(["autoEngage"]);
  ws.send(JSON.stringify(m));
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
  if (window.rotorTestActive) {
    if (typeof updateRotorGauges === "function") {
      updateRotorGauges(
        window.rotorTestAz != null ? window.rotorTestAz : null,
        window.rotorTestEl != null ? window.rotorTestEl : null,
        null,
        null,
        false,
      );
    }
    return;
  }
  if (typeof updateRotorGauges === "function") {
    // Above horizon: center = sat AZ/EL.
    // Below horizon / preposition: pass null so gauges derive sky
    // direction from rotor (rotor+180 when flipped).
    const showSat =
      antennaOn && !parking && lastGaugeSatEl != null && lastGaugeSatEl >= 0;
    updateRotorGauges(
      msg.az,
      msg.el,
      showSat ? lastGaugeSatAz : null,
      showSat ? lastGaugeSatEl : null,
      antennaOn ? lastGaugeFlipped : false,
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

  // Moon (EME): TX stays on the dial; RX carries the station's own echo Doppler.
  const dopWord = msg.isMoon ? "Echo Doppler " : "Doppler ";
  if (ulDopEl)
    ulDopEl.textContent =
      msg.isMoon ? "No Doppler (TX on dial)" : ulDop != null ? "Doppler " + fmtDopplerKHz(ulDop) : "";
  if (dlDopEl)
    dlDopEl.textContent =
      dlDop != null ? dopWord + fmtDopplerKHz(dlDop) : "";

  if (ulEl && ulDop != null) ulEl.title = msg.isMoon ? "TX on dial frequency (no Doppler applied)" : "Doppler " + fmtDopplerKHz(ulDop);
  if (dlEl && dlDop != null) dlEl.title = dopWord + fmtDopplerKHz(dlDop);
  // Out-of-band indicator (visual only; see js/dl-band.js): red = satellite-frame
  // DL out of the passband, yellow = only the station (displayed) DL is out.
  if (dlEl) {
    const ob = typeof dlOutOfBand === "function" ? dlOutOfBand({ passbandDl: msg.passbandDl, dlHz, dlDopplerHz: dlDop }) : null;
    const lvl = ob ? ob.level : null;
    dlEl.classList.toggle("oob", lvl === "oob");
    dlEl.classList.toggle("oob-warn", lvl === "warn");
    if (lvl) dlEl.title = ob.text;
    else if (dlDop == null && /^(Out of band|Station frequency outside)/.test(dlEl.title)) dlEl.title = "";
  }
  // Two radios, one leg Disabled for this sat (js/radio-roles.js): its readout
  // reads "Disabled" instead of a frequency nothing is tuned to.
  if (typeof window.radioRolesPaintOff === "function") window.radioRolesPaintOff();

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
      rangeEl.textContent = typeof Units !== "undefined" ? Units.dist(msg.look.rangeKm, { digits: 1 }) : msg.look.rangeKm.toFixed(1) + " km";
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
    if (window.rotorTestActive) {
      // Guided rotor test owns the gauges — re-apply test coords
      if (typeof updateRotorGauges === "function") {
        updateRotorGauges(
          window.rotorTestAz != null ? window.rotorTestAz : null,
          window.rotorTestEl != null ? window.rotorTestEl : null,
          null,
          null,
          false,
        );
      }
      return;
    }
    const azEl = document.getElementById("rotor-az");
    const elEl = document.getElementById("rotor-el");
    if (azEl && msg.rotorAz != null)
      azEl.textContent = Number(msg.rotorAz).toFixed(1) + "\u00B0";
    if (elEl && msg.rotorEl != null)
      elEl.textContent = Number(msg.rotorEl).toFixed(1) + "\u00B0";
    if (typeof msg.flipped === "boolean") lastGaugeFlipped = msg.flipped;
    if (typeof updateRotorGauges === "function") {
      const elVal =
        msg.look && typeof msg.look.el === "number"
          ? msg.look.el
          : lastGaugeSatEl;
      const showSat =
        antennaOn && !parking && elVal != null && Number(elVal) >= 0;
      const azVal = msg.look ? msg.look.az : lastGaugeSatAz;
      updateRotorGauges(
        msg.rotorAz != null ? msg.rotorAz : null,
        msg.rotorEl != null ? msg.rotorEl : null,
        showSat ? azVal : null,
        showSat ? elVal : null,
        antennaOn ? lastGaugeFlipped : false,
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

/** "/index.html?sat=KEY" from sats.html (Browse full catalog...): select it once, then drop the param. */
function applyCatalogPick() {
  let key = null;
  try {
    key = new URLSearchParams(location.search).get("sat");
  } catch (_) {}
  if (!key) return;
  try {
    history.replaceState(null, "", location.pathname + location.hash);
  } catch (_) {}
  if (typeof selectSatellite === "function") selectSatellite(key, key);
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
    // Do NOT push our localStorage sat on (re)connect: the server is the
    // source of truth and sends "state" right after connect. Pushing here let
    // a second tab / reconnecting client switch the live sat (and rotor).
    // Exception: an explicit pick from the catalog page (?sat=KEY), once.
    applyCatalogPick();
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);

      if (msg.type === "sats") {
        if (typeof renderSatMenu === "function") renderSatMenu(msg);
        return;
      }

      if (msg.type === "amsat-auto") {
        if (typeof window.onAmsatAuto === "function") window.onAmsatAuto(msg);
        return;
      }

      if (msg.type === "after-los") {
        if (typeof showAfterLosToast === "function") showAfterLosToast(msg);
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

      if (msg.type === "wsjtx-listener") {
        if (typeof applyWsjtxListenerStatus === "function")
          applyWsjtxListenerStatus(msg);
        return;
      }

      if (msg.type === "error") {
        console.warn("Server error:", msg.message);
        return;
      }

      if (msg.type === "profile-peek") {
        if (typeof applyProfilePeek === "function") applyProfilePeek(msg);
        return;
      }
      if (msg.type === "profiles") {
        if (typeof applyProfilesMessage === "function") {
          applyProfilesMessage(msg);
        }
        applyServerAutoSelect(msg.autoSelect === true);
        applyServerAutoEngage(msg.autoEngage === true);
        if (window.PassAlerts) window.PassAlerts.onProfiles(msg);
        if (window.AutoEngage) window.AutoEngage.onProfiles(msg);
        return;
      }

      if (msg.type === "set-ack") {
        // Toggle save acknowledged (js/set-guard.js); fav-overlay.js has its own listener.
        if (autoSelectGuard) autoSelectGuard.ack(msg.seq);
        if (autoEngageGuard) autoEngageGuard.ack(msg.seq);
        if (window.AutoEngage && window.AutoEngage.onAck) window.AutoEngage.onAck(msg.seq);
        if (window.PassAlerts && window.PassAlerts.onAck) window.PassAlerts.onAck(msg.seq);
        return;
      }

      if (
        msg.type === "test-result" ||
        msg.type === "test-rotor-step-result" ||
        msg.type === "test-rotor-progress"
      ) {
        if (typeof applyTestResult === "function") applyTestResult(msg);
        return;
      }

      if (msg.type === "tle-sources" && Array.isArray(msg.sources)) {
        if (typeof applyTleSourceChecks === "function") {
          applyTleSourceChecks(msg.sources);
        }
        return;
      }

      if (msg.type === "host" || msg.type === "endpoints") {
        const ifs =
          msg.ipv4Interfaces || (msg.host && msg.host.ipv4Interfaces) || null;
        if (Array.isArray(ifs) && typeof setHostIPv4Interfaces === "function") {
          setHostIPv4Interfaces(ifs);
        }
        if (
          Array.isArray(msg.tleSources) &&
          typeof applyTleSourceChecks === "function"
        ) {
          applyTleSourceChecks(msg.tleSources);
        }
        if (
          Array.isArray(msg.serialDevices) &&
          typeof setHostSerialDevices === "function"
        ) {
          setHostSerialDevices(
            msg.serialDevices,
            msg.defaultCatDevice || "",
            msg.kind || msg.platform || "",
          );
        }
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
              if (typeof populateSerialDeviceSelect === "function") {
                populateSerialDeviceSelect(
                  "cfg-rotor-device",
                  msg.rotorAzDevice,
                );
                populateSerialDeviceSelect(
                  "cfg-rotor-az-device",
                  msg.rotorAzDevice,
                );
              } else {
                setVal("cfg-rotor-device", msg.rotorAzDevice);
                setVal("cfg-rotor-az-device", msg.rotorAzDevice);
              }
            }
            if (msg.rotorElDevice) {
              if (typeof populateSerialDeviceSelect === "function") {
                populateSerialDeviceSelect(
                  "cfg-rotor-el-device",
                  msg.rotorElDevice,
                );
              } else {
                setVal("cfg-rotor-el-device", msg.rotorElDevice);
              }
            }
            if (msg.rotorBaud != null) setVal("cfg-rotor-baud", msg.rotorBaud);
            if (typeof updateRotorFormVisibility === "function") {
              updateRotorFormVisibility();
            }
          }
        }
        return;
      }

      if (msg.type === "tick") {
        if (pendingSatKey && msg.sat && msg.sat !== pendingSatKey && Date.now() - pendingSatAt < 15000) return;
        applyFreqAndLook(msg);
        if (typeof updateFavPanelFromState === "function") {
          updateFavPanelFromState(
            Object.assign({ type: "tick", sat: msg.sat || currentSatKey }, msg),
          );
        }
        return;
      }

      if (msg.type !== "state") return;

      // Pass alerts: next passes of alerted sats (fires AOS−5 / AOS).
      if (window.PassAlerts) window.PassAlerts.onState(msg);
      if (msg.autoEngage) applyServerAutoEngage(msg.autoEngage.on === true, msg.autoEngage);
      if (window.AutoEngage && window.AutoEngage.onState) window.AutoEngage.onState(msg);

      // After a local switch, drop in-flight state for any other sat (it would
      // draw the old sat's position under the new name). Expires after 15 s
      // so a switch made from another client still wins.
      if (pendingSatKey && msg.sat) {
        if (msg.sat === pendingSatKey) pendingSatKey = null;
        else if (Date.now() - pendingSatAt < 15000) return;
        else pendingSatKey = null;
      }

      if (msg.sat) {
        if (msg.sat !== lastStateSat) {
          // A selection (here or from the server) ends a pass preview, unless it
          // is the echo of this browser's chart pass click (js/pass-preview.js).
          currentSatKey = msg.sat; // before a clear, so "back to live" centers on this sat
          if (window.passPreview && window.passPreview.onServerSat) window.passPreview.onServerSat(msg.sat);
          lastStateSat = msg.sat;
          lastModesKey = "";
          if (typeof clearProfileLock === "function") clearProfileLock();
          if (typeof clearMapTracking === "function") clearMapTracking();
          if (typeof clearRadar === "function") clearRadar();
        }
        currentSatKey = msg.sat;
        try {
          localStorage.setItem("satTrackerSat", msg.sat);
        } catch (_) {}
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
          updateRotorGauges(
            msg.rotorAz != null ? msg.rotorAz : null,
            msg.rotorEl != null ? msg.rotorEl : null,
            showSat ? lastGaugeSatAz : null,
            showSat ? lastGaugeSatEl : null,
            antennaOn ? lastGaugeFlipped : false,
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
      if (typeof updateMoonPanel === "function") updateMoonPanel(msg);
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
      rangeEl.textContent = km == null ? "-" : typeof Units !== "undefined" ? Units.dist(km, { digits: 1 }) : km.toFixed(1) + " km";
    }
  }

  if (orbitEl) {
    orbitEl.textContent = state.orbit != null ? String(state.orbit) : "-";
  }
}
// Display units changed (profile saved / switched): station elevation now; the rest repaint on the next 1 Hz state.
document.addEventListener("units-change", () => { try { updateStationStatus(); } catch (_) {} });
function notifyObserverChanged() {
  sendObserver();
  updateStationStatus();
}
function initModeSelect() {
  const sel = document.getElementById("mode-select");
  if (!sel) return;
  sel.addEventListener("change", () => {
    syncModeSelectTitle(sel);
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

  const autoBtn = document.getElementById("btn-auto-select");
  if (autoBtn) {
    autoBtn.addEventListener("click", () => {
      console.log("btn-auto-select click, currently", autoSelectOn);
      sendAutoSelect(!autoSelectOn);
    });
  }

  const engageBtn = document.getElementById("btn-auto-engage");
  if (engageBtn) {
    updateAutoEngageUi(autoEngageOn); // tooltip before the first server message
    engageBtn.addEventListener("click", () => {
      console.log("btn-auto-engage click, currently", autoEngageOn);
      sendAutoEngage(!autoEngageOn);
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

  // Offset-step input (change/▲▼/dblclick-center) is wired once in fine-ctcss.js.

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

function fmtDopplerKHz(hz) {
  const k = Number(hz) / 1000;
  return (k >= 0 ? "+" : "") + k.toFixed(3) + " kHz";
}

