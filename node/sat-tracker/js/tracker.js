/* Tracker WebSocket, radio/antenna, station status, fine tune (legacy UL-only bindings) */

let currentEl = null;
let currentSatKey = null;
let lastModesKey = "";

let radioOn = false;
let tciConnected = false;
let antennaOn = false;
let fineStep = 100;
let ulFineOffset = 0;
let manualDlOffset = 0;

function getObserverFromConfig() {
  const cfg = loadConfig();
  const grid = (cfg.grid || "").trim().toUpperCase();
  if (grid.length >= 4 && typeof gridToLatLon === "function") {
    const ll = gridToLatLon(grid);
    if (ll) {
      return {
        lat: ll.lat,
        lon: ll.lon,
        elevM: cfg.elevation != null ? Number(cfg.elevation) : 0,
      };
    }
  }
  return { lat: 39.7392, lon: -104.9903, elevM: 1600 };
}

function notifyObserverChanged() {
  const o = getObserverFromConfig();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: "observer",
        lat: o.lat,
        lon: o.lon,
        elevM: o.elevM,
      }),
    );
  }
}

function updateRadioUi(on, connected) {
  radioOn = !!on;
  tciConnected = !!connected;
  const btn = document.getElementById("btn-radio");
  const toggle = document.getElementById("toggle-radio");
  const status = document.getElementById("status-tci");
  if (btn) btn.classList.toggle("active", radioOn);
  if (toggle) toggle.checked = radioOn;
  if (status) {
    status.textContent = radioOn
      ? connected
        ? "Connected"
        : "Connecting…"
      : "Disconnected";
  }
}

function updateAntennaUi(on) {
  antennaOn = !!on;
  const btn = document.getElementById("btn-antenna");
  const toggle = document.getElementById("toggle-antenna");
  if (btn) btn.classList.toggle("active", antennaOn);
  if (toggle) toggle.checked = antennaOn;
}

function updateFineOffsetDisplay() {
  // Legacy single-offset display — fine-ctcss.js owns the dual UL/DL UI
  const el = document.getElementById("fine-offset");
  if (!el) return;
  const v = ulFineOffset || 0;
  el.textContent = (v >= 0 ? "+" : "") + Math.round(v) + " Hz";
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
    // Don't overwrite while the user is editing the step field
    if (stepEl && document.activeElement !== stepEl) {
      stepEl.value = String(fineStep);
    }
  }
}

function applyFreqAndLook(msg) {
  if (msg.look && typeof msg.look.el === "number") {
    const prevAbove = currentEl != null && currentEl >= 0;
    currentEl = msg.look.el;
  }
  if (typeof applyPassUi === "function") applyPassUi(msg);
  if (typeof applyFreqUi === "function") applyFreqUi(msg);
}

function applyStationStatus(msg) {
  const call = document.getElementById("station-call");
  const grid = document.getElementById("station-grid");
  const latEl = document.getElementById("station-lat");
  const lonEl = document.getElementById("station-lon");
  const elevEl = document.getElementById("station-elev");
  if (call && msg.callsign) call.textContent = msg.callsign;
  if (grid && msg.grid) grid.textContent = msg.grid;
  if (latEl && msg.lat != null) latEl.textContent = Number(msg.lat).toFixed(4);
  if (lonEl && msg.lon != null) lonEl.textContent = Number(msg.lon).toFixed(4);
  if (elevEl && msg.elevM != null) elevEl.textContent = Math.round(msg.elevM) + " m";
}

function applySatStatus(msg) {
  const nameEl = document.getElementById("sat-common");
  const noradEl = document.getElementById("sat-norad");
  const azEl = document.getElementById("sat-az");
  const elEl = document.getElementById("sat-el");
  const rangeEl = document.getElementById("sat-range");
  const orbitEl = document.getElementById("sat-orbit");
  const tleEl = document.getElementById("status-tle");
  const catEl = document.getElementById("status-catalog");

  if (msg.name && nameEl) nameEl.textContent = msg.name;
  if (msg.norad != null && noradEl) noradEl.textContent = String(msg.norad);
  if (msg.look) {
    if (azEl && msg.look.az != null)
      azEl.textContent = Number(msg.look.az).toFixed(1) + "\u00B0";
    if (elEl && msg.look.el != null)
      elEl.textContent = Number(msg.look.el).toFixed(1) + "\u00B0";
    if (rangeEl && msg.look.rangeKm != null)
      rangeEl.textContent = Number(msg.look.rangeKm).toFixed(0) + " km";
  }
  if (orbitEl && msg.orbit != null) orbitEl.textContent = String(msg.orbit);
  if (tleEl && msg.tleAge != null) tleEl.textContent = msg.tleAge;
  if (catEl && msg.catalogStatus) catEl.textContent = msg.catalogStatus;
}

function applyRotorStatus(msg) {
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

  if (typeof updateRotorGauges === "function") {
    updateRotorGauges(msg.az, msg.el);
  }
}

function toggleRadio() {
  const next = !radioOn;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "radio", on: next }));
  } else {
    console.warn("WebSocket not open — cannot toggle radio");
  }
}

function toggleAntenna() {
  const next = !antennaOn;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "antenna", on: next }));
  } else {
    console.warn("WebSocket not open — cannot toggle antenna");
  }
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

function handleTrackerMessage(msg) {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "tci" || msg.type === "icom" || msg.type === "flex") {
    applyTciStatus(msg);
  }
  if (msg.type === "rotor") {
    applyRotorStatus(msg);
    updateAntennaUi(!!msg.antennaOn);
  }
  if (msg.type === "tick" || msg.type === "state") {
    applyFreqAndLook(msg);
    applySatStatus(msg);
    if (msg.observer) applyStationStatus(msg.observer);
    if (typeof msg.radioOn === "boolean") {
      updateRadioUi(msg.radioOn, msg.tciConnected || msg.connected);
    }
    if (typeof applyFineCtcssFromTick === "function") {
      applyFineCtcssFromTick(msg);
    }
  }
  if (msg.type === "sats" && typeof applySatsMessage === "function") {
    applySatsMessage(msg);
  }
  if (msg.type === "profiles" && typeof applyProfilesMessage === "function") {
    applyProfilesMessage(msg);
  }
  if (msg.type === "endpoints" && typeof fillForm === "function") {
    // Server confirmed endpoints — refresh form cache if needed
  }
  if (msg.type === "error") {
    console.warn("Server error:", msg.message);
  }
}

function initTrackerUi() {
  const btnRadio = document.getElementById("btn-radio");
  const toggleRadio = document.getElementById("toggle-radio");
  const btnAntenna = document.getElementById("btn-antenna");
  const toggleAntenna = document.getElementById("toggle-antenna");

  if (btnRadio) btnRadio.addEventListener("click", toggleRadio);
  if (toggleRadio) {
    toggleRadio.addEventListener("change", () => {
      const next = !!toggleRadio.checked;
      if (next !== radioOn) toggleRadio();
    });
  }
  if (btnAntenna) btnAntenna.addEventListener("click", toggleAntenna);
  if (toggleAntenna) {
    toggleAntenna.addEventListener("change", () => {
      const next = !!toggleAntenna.checked;
      if (next !== antennaOn) toggleAntenna();
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

  // Expose for app.js / ws handler
  window.handleTrackerMessage = handleTrackerMessage;
  window.notifyObserverChanged = notifyObserverChanged;
  window.getObserverFromConfig = getObserverFromConfig;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initTrackerUi);
} else {
  initTrackerUi();
}
