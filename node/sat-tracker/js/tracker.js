let ws = null;
let reconnectTimer = null;
let countdownTimer = null;

let timeMode = localStorage.getItem("satTrackerTimeMode") || "utc";
let satSortMode = localStorage.getItem("satTrackerSort") || "aos";
let lastPass = null;
let currentSatKey = localStorage.getItem("satTrackerSat") || null;
let currentSatLabel = null;
let lastSatList = null;
let lastStateSat = null;
let currentEl = null;
let pendingSatKey = null;

/** Same as pi_sat_track.py fmt_freq — MMM.KKK.HHH */
function fmtFreq(hz) {
  if (hz == null || !Number.isFinite(hz)) return "-";
  hz = Math.round(hz);
  const mhz = Math.floor(hz / 1e6);
  const khz = Math.floor((hz % 1e6) / 1e3);
  const hzz = Math.abs(hz % 1000);
  return (
    mhz +
    "." +
    String(khz).padStart(3, "0") +
    "." +
    String(hzz).padStart(3, "0")
  );
}

/** Parse "145.991" or "145.991.250" or Hz number → Hz */
function parseToHz(val) {
  if (val == null || val === "-" || val === "") return null;
  if (typeof val === "number" && Number.isFinite(val)) {
    return val > 1e4 ? val : val * 1e6;
  }
  const s = String(val).trim();
  const parts = s.split(".");
  if (parts.length === 3) {
    const mhz = parseInt(parts[0], 10);
    const khz = parseInt(parts[1], 10);
    const hz = parseInt(parts[2], 10);
    if (![mhz, khz, hz].every(Number.isFinite)) return null;
    return mhz * 1e6 + khz * 1e3 + hz;
  }
  const f = parseFloat(s);
  if (!Number.isFinite(f)) return null;
  return f * 1e6;
}

function fmtDopplerMHz(hzOffset) {
  if (hzOffset == null || !Number.isFinite(hzOffset)) return "";
  const mhz = hzOffset / 1e6;
  const sign = mhz >= 0 ? "+" : "";
  return sign + mhz.toFixed(6) + " MHz";
}

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

function setSatButtonLabel(label) {
  currentSatLabel = label;
  const btn = document.getElementById("sat-name");
  if (btn) btn.textContent = (label || "-") + " \u25BE";
  document.querySelectorAll(".sat-option[data-sat]").forEach((el) => {
    el.classList.toggle("active", el.dataset.sat === currentSatKey);
  });
}

function aosSortKey(s) {
  if (s.above) return -1e12;
  if (s.key === currentSatKey && currentEl != null && currentEl >= 0)
    return -1e12;

  if (
    typeof s.secToAos === "number" &&
    Number.isFinite(s.secToAos) &&
    s.secToAos >= 0
  ) {
    return s.secToAos;
  }

  if (s.soon) return 15 * 60;

  return 1e12;
}

function sortHeardList(list) {
  const arr = list.slice();

  if (satSortMode === "alpha") {
    arr.sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""), undefined, {
        sensitivity: "base",
      }),
    );
    return arr;
  }

  arr.sort((a, b) => {
    const ka = aosSortKey(a);
    const kb = aosSortKey(b);
    if (ka !== kb) return ka - kb;
    return String(a.name || "").localeCompare(String(b.name || ""), undefined, {
      sensitivity: "base",
    });
  });
  return arr;
}

function toggleSatSort(e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  satSortMode = satSortMode === "aos" ? "alpha" : "aos";
  localStorage.setItem("satTrackerSort", satSortMode);
  console.log("Sat sort mode:", satSortMode);
  if (lastSatList) renderSatMenu(lastSatList);
}

function applyLiveHorizon(sats) {
  if (!sats || !currentSatKey) return sats;
  return sats.map((s) => {
    if (s.key !== currentSatKey) return s;
    if (currentEl == null) return s;
    const above = currentEl >= 0;
    return Object.assign({}, s, {
      above: above,
      soon: above ? false : s.soon,
      el: currentEl,
    });
  });
}

function renderSatMenu(payload) {
  const menu = document.getElementById("sat-menu");
  if (!menu) return;

  lastSatList = payload;
  const sats = applyLiveHorizon(payload.satellites || []);

  menu.innerHTML = "";

  const browse = document.createElement("a");
  browse.className = "sat-option sat-browse";
  browse.href = "/sats.html";
  browse.textContent = "Browse full catalog...";
  browse.title = "Search all AMSAT satellites";
  menu.appendChild(browse);

  const headRow = document.createElement("div");
  headRow.className = "sat-menu-head";

  const head = document.createElement("div");
  head.className = "sat-menu-section";
  head.textContent = "Heard on AMSAT";
  headRow.appendChild(head);

  const sortBtn = document.createElement("button");
  sortBtn.type = "button";
  sortBtn.className = "sat-sort-btn";
  sortBtn.title =
    satSortMode === "aos"
      ? "Sorted by AOS — click for A–Z"
      : "Sorted A–Z — click for AOS";
  sortBtn.textContent = satSortMode === "aos" ? "AOS" : "A–Z";
  sortBtn.addEventListener("click", toggleSatSort);
  headRow.appendChild(sortBtn);
  menu.appendChild(headRow);

  const heard = sats.filter((s) => s.heard);
  let quick = [];
  const seen = new Set();

  function add(s) {
    if (!s || !s.key || seen.has(s.key)) return;
    seen.add(s.key);
    quick.push(s);
  }

  heard.forEach(add);
  if (currentSatKey) add(sats.find((s) => s.key === currentSatKey));

  quick = sortHeardList(quick);

  if (quick.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sat-menu-empty";
    empty.textContent = "No AMSAT reports loaded";
    menu.appendChild(empty);
  }

  quick.slice(0, 40).forEach((s) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sat-option";
    if (s.key === currentSatKey) btn.classList.add("active");

    if (s.above) btn.classList.add("sat-up");
    else if (s.soon) btn.classList.add("sat-soon");
    else btn.classList.add("sat-down");

    btn.classList.add("heard");
    btn.dataset.sat = s.key;
    btn.textContent = s.name;

    let tip = s.name + "  (NORAD " + s.norad + ")";
    if (s.above) tip += " — above horizon";
    else if (s.soon) {
      tip += " — AOS < 15 min";
      if (typeof s.secToAos === "number")
        tip += " (~" + Math.round(s.secToAos / 60) + "m)";
    } else {
      tip += " — heard (AMSAT)";
    }
    btn.title = tip;
    btn.addEventListener("click", () => selectSatellite(s.key, s.name));
    menu.appendChild(btn);
  });

  const statusCat = document.getElementById("status-catalog");
  if (statusCat) {
    statusCat.textContent =
      (payload.satellites || []).length + " - " + (payload.catalogNote || "?");
  }

  if (currentSatKey) {
    const match = sats.find((s) => s.key === currentSatKey);
    if (match) setSatButtonLabel(match.name);
    else if (!currentSatLabel) setSatButtonLabel(currentSatKey);
  } else if (quick.length) {
    currentSatKey = quick[0].key;
    setSatButtonLabel(quick[0].name);
  }
}

function refreshCurrentSatChip() {
  if (!lastSatList) return;
  const menu = document.getElementById("sat-menu");
  if (menu && !menu.hidden) {
    renderSatMenu(lastSatList);
  } else {
    document.querySelectorAll(".sat-option[data-sat]").forEach((el) => {
      if (el.dataset.sat !== currentSatKey) return;
      el.classList.remove("sat-up", "sat-soon", "sat-down");
      if (currentEl != null && currentEl >= 0) el.classList.add("sat-up");
      else el.classList.add("sat-down");
    });
  }
}

function selectSatellite(key, label) {
  pendingSatKey = key;
  currentSatKey = key;
  setSatButtonLabel(label || key);
  localStorage.setItem("satTrackerSat", key);
  lastPass = null;
  lastStateSat = null;
  currentEl = null;

  if (typeof clearProfileLock === "function") clearProfileLock();
  if (typeof clearMapTracking === "function") clearMapTracking();

  const menu = document.getElementById("sat-menu");
  if (menu) menu.hidden = true;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "sat", key: key }));
  }
}

function applyFreqAndLook(msg) {
  if (msg.look && typeof msg.look.el === "number") {
    const prevAbove = currentEl != null && currentEl >= 0;
    currentEl = msg.look.el;
    const nowAbove = currentEl >= 0;
    if (prevAbove !== nowAbove) {
      refreshCurrentSatChip();
    }
  }

  const ulEl = document.getElementById("freq-ul");
  const dlEl = document.getElementById("freq-dl");
  const ulDopEl = document.getElementById("freq-ul-doppler");
  const dlDopEl = document.getElementById("freq-dl-doppler");

  // Prefer full-precision Hz from server
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

  const labels = document.querySelectorAll(".freq-block .freq-label");
  if (labels[0] && msg.ulLabel) labels[0].textContent = msg.ulLabel;
  if (labels[1] && msg.dlLabel) labels[1].textContent = msg.dlLabel;

  if (msg.look) {
    const azEl = document.getElementById("sat-az");
    const elEl = document.getElementById("sat-el");
    const rangeEl = document.getElementById("sat-range");
    if (azEl) azEl.textContent = msg.look.az.toFixed(1) + "\u00B0";
    if (elEl) elEl.textContent = msg.look.el.toFixed(1) + "\u00B0";
    if (rangeEl && msg.look.rangeKm != null) {
      rangeEl.textContent = msg.look.rangeKm.toFixed(1) + " km";
    }
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
    updateStationStatus();
    if (currentSatKey) {
      pendingSatKey = currentSatKey;
      ws.send(JSON.stringify({ type: "sat", key: currentSatKey }));
    }
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);

      if (msg.type === "sats") {
        renderSatMenu(msg);
        return;
      }

      if (msg.type === "error") {
        console.warn("Server error:", msg.message);
        return;
      }

      if (msg.type === "tick") {
        if (pendingSatKey && msg.sat && msg.sat !== pendingSatKey) return;
        applyFreqAndLook(msg);
        return;
      }

      if (msg.type !== "state") return;

      if (pendingSatKey && msg.sat && msg.sat !== pendingSatKey) {
        return;
      }
      if (pendingSatKey && msg.sat === pendingSatKey) {
        pendingSatKey = null;
      }

      if (msg.sat) {
        if (msg.sat !== lastStateSat) {
          lastPass = null;
          lastStateSat = msg.sat;
          currentEl = null;
          if (typeof clearProfileLock === "function") clearProfileLock();
          if (typeof clearMapTracking === "function") clearMapTracking();
        }
        currentSatKey = msg.sat;
        setSatButtonLabel(msg.display || msg.sat);
      }

      applyFreqAndLook(msg);

      if (typeof updateMapTracking === "function") updateMapTracking(msg);

      if (msg.look) {
        const sky =
          msg.passes && msg.passes[0] && msg.passes[0].sky
            ? msg.passes[0].sky
            : null;
        if (typeof updateRadar === "function") {
          updateRadar(msg.look.az, msg.look.el, sky);
        }
      }

      if (typeof updateProfile === "function") updateProfile(msg);
      updateSidebar(msg);
      updateSatelliteStatus(msg);
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

function updateSatelliteStatus(state) {
  const nameEl = document.getElementById("sat-common");
  const noradEl = document.getElementById("sat-norad");
  const orbitEl = document.getElementById("sat-orbit");

  if (nameEl) nameEl.textContent = state.display || state.sat || "-";
  if (noradEl)
    noradEl.textContent = state.norad != null ? String(state.norad) : "-";

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

function formatPassTime(iso) {
  const d = new Date(iso);
  if (timeMode === "utc") {
    return d.toISOString().substr(11, 8) + " UTC";
  }
  const opts = {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  };
  return d.toLocaleTimeString([], opts) + " MT";
}

function renderPassTimes() {
  if (!lastPass) return;
  const aosEl = document.getElementById("pass-aos");
  const losEl = document.getElementById("pass-los");
  if (aosEl) aosEl.textContent = formatPassTime(lastPass.aos);
  if (losEl) losEl.textContent = formatPassTime(lastPass.los);
}

function toggleTimeMode() {
  timeMode = timeMode === "utc" ? "local" : "utc";
  localStorage.setItem("satTrackerTimeMode", timeMode);
  renderPassTimes();
}

function formatCountdown(sec) {
  if (sec < 0 || !Number.isFinite(sec)) return "-";
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return (
      String(h).padStart(2, "0") +
      ":" +
      String(m).padStart(2, "0") +
      ":" +
      String(s).padStart(2, "0")
    );
  }
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

function tickCountdown() {
  const countdownEl = document.getElementById("countdown");
  const labelEl = document.getElementById("pass-label");
  const dot = document.querySelector("#pass-status .status-dot");
  if (!countdownEl) return;

  if (currentEl != null && currentEl >= 0) {
    if (labelEl) labelEl.textContent = "LOS in";
    if (dot) dot.className = "status-dot green";

    if (lastPass && lastPass.los) {
      const secToLos = (new Date(lastPass.los).getTime() - Date.now()) / 1000;
      if (secToLos > 0) {
        countdownEl.textContent = formatCountdown(secToLos);
        return;
      }
    }
    countdownEl.textContent = currentEl.toFixed(1) + "\u00B0";
    return;
  }

  if (!lastPass || !lastPass.aos || !lastPass.los) {
    if (labelEl) labelEl.textContent = "Next AOS in";
    countdownEl.textContent = "-";
    if (dot) dot.className = "status-dot";
    return;
  }

  const now = Date.now();
  const aosMs = new Date(lastPass.aos).getTime();
  const losMs = new Date(lastPass.los).getTime();
  const secToAos = (aosMs - now) / 1000;
  const secToLos = (losMs - now) / 1000;

  if (secToAos > 0) {
    if (labelEl) labelEl.textContent = "Next AOS in";
    countdownEl.textContent = formatCountdown(secToAos);
    if (dot) {
      dot.className = "status-dot " + (secToAos > 900 ? "green" : "orange");
    }
  } else if (secToLos > 0) {
    if (labelEl) labelEl.textContent = "LOS in";
    countdownEl.textContent = formatCountdown(secToLos);
    if (dot) dot.className = "status-dot green";
  } else {
    lastPass = null;
    if (labelEl) labelEl.textContent = "Next AOS in";
    countdownEl.textContent = "-";
    if (dot) dot.className = "status-dot";
  }
}

function startCountdownTimer() {
  if (countdownTimer) clearInterval(countdownTimer);
  tickCountdown();
  countdownTimer = setInterval(tickCountdown, 1000);
}

function updateSidebar(state) {
  const tleEl = document.getElementById("status-tle");
  if (tleEl) tleEl.textContent = state.tleNote || "-";

  if (state.passes && state.passes.length) {
    const p = state.passes[0];
    const now = Date.now();

    const needLock =
      !lastPass ||
      lastPass.sat !== state.sat ||
      now > new Date(lastPass.los).getTime() + 2000 ||
      Math.abs(new Date(p.aos).getTime() - new Date(lastPass.aos).getTime()) >
        120000;

    if (needLock) {
      lastPass = {
        sat: state.sat,
        aos: p.aos,
        los: p.los,
        maxEl: p.maxEl,
        aosAz: p.aosAz,
      };
    }

    renderPassTimes();

    const maxEl = document.getElementById("pass-maxel");
    const durEl = document.getElementById("pass-duration");
    if (maxEl)
      maxEl.textContent = (lastPass.maxEl || p.maxEl).toFixed(1) + " deg";

    if (durEl) {
      const aos = new Date(lastPass.aos);
      const los = new Date(lastPass.los);
      const durSec = (los - aos) / 1000;
      const durMin = Math.floor(durSec / 60);
      const durS = Math.floor(durSec % 60);
      durEl.textContent = durMin + "m " + durS + "s";
    }

    tickCountdown();
  } else {
    tickCountdown();
  }
}

function notifyObserverChanged() {
  sendObserver();
  updateStationStatus();
}

function initTimeToggle() {
  document.querySelectorAll(".time-toggle").forEach((el) => {
    el.addEventListener("click", toggleTimeMode);
  });
}

function initSatSelector() {
  const btn = document.getElementById("sat-name");
  const menu = document.getElementById("sat-menu");
  if (!btn || !menu) return;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    if (!menu.hidden && lastSatList) renderSatMenu(lastSatList);
  });

  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target) && e.target !== btn) {
      menu.hidden = true;
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", function () {
    startCountdownTimer();
    updateStationStatus();
  });
} else {
  startCountdownTimer();
  updateStationStatus();
}
