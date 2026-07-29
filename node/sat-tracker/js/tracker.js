let ws = null;
let reconnectTimer = null;
let countdownTimer = null;

let timeMode = localStorage.getItem("satTrackerTimeMode") || "utc";
let lastPass = null;
let currentSatKey = localStorage.getItem("satTrackerSat") || null;
let currentSatLabel = null;
let lastSatList = null;
let lastStateSat = null;

function getObserverFromConfig() {
  const cfg = loadConfig();
  if (!cfg.grid) return null;
  const pos = maidenheadToLatLon(cfg.grid);
  if (!pos) return null;
  return {
    lat: pos.lat,
    lon: pos.lon,
    elevM: cfg.elevation || 0,
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

function setSatButtonLabel(label) {
  currentSatLabel = label;
  const btn = document.getElementById("sat-name");
  if (btn) btn.textContent = (label || "-") + " \u25BE";
  document.querySelectorAll(".sat-option[data-sat]").forEach((el) => {
    el.classList.toggle("active", el.dataset.sat === currentSatKey);
  });
}

function renderSatMenu(payload) {
  const menu = document.getElementById("sat-menu");
  if (!menu) return;

  lastSatList = payload;
  const sats = payload.satellites || [];

  menu.innerHTML = "";

  // Browse full catalog — always first, distinct from chips
  const browse = document.createElement("a");
  browse.className = "sat-option sat-browse";
  browse.href = "/sats.html";
  browse.textContent = "Browse full catalog...";
  browse.title = "Search all JE9PEL satellites";
  menu.appendChild(browse);

  const head = document.createElement("div");
  head.className = "sat-menu-section";
  head.textContent = "Heard on AMSAT";
  menu.appendChild(head);

  // ONLY AMSAT-heard (plus current). Do NOT dump JE9PEL "active".
  const heard = sats.filter((s) => s.heard);
  const quick = [];
  const seen = new Set();

  function add(s) {
    if (!s || seen.has(s.key)) return;
    seen.add(s.key);
    quick.push(s);
  }

  if (currentSatKey) add(sats.find((s) => s.key === currentSatKey));
  heard.filter((s) => s.above).forEach(add);
  heard.filter((s) => s.soon && !s.above).forEach(add);
  heard.forEach(add);

  if (quick.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sat-menu-empty";
    empty.textContent = "No AMSAT reports loaded";
    menu.appendChild(empty);
  }

  quick.slice(0, 30).forEach((s) => {
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
    if (s.above) tip += " - above horizon";
    else if (s.soon) tip += " - AOS < 15 min";
    else tip += " - heard (AMSAT)";
    btn.title = tip;
    btn.addEventListener("click", () => selectSatellite(s.key, s.name));
    menu.appendChild(btn);
  });

  const statusCat = document.getElementById("status-catalog");
  if (statusCat) {
    statusCat.textContent = sats.length + " - " + (payload.catalogNote || "?");
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

function selectSatellite(key, label) {
  currentSatKey = key;
  setSatButtonLabel(label || key);
  localStorage.setItem("satTrackerSat", key);
  lastPass = null;

  const menu = document.getElementById("sat-menu");
  if (menu) menu.hidden = true;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "sat", key }));
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
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);

      if (msg.type === "sats") {
        renderSatMenu(msg);
        if (currentSatKey) {
          ws.send(JSON.stringify({ type: "sat", key: currentSatKey }));
        }
        return;
      }

      if (msg.type === "error") {
        console.warn("Server error:", msg.message);
        return;
      }

      if (msg.type !== "state") return;

      if (msg.sat) {
        if (msg.sat !== lastStateSat) {
          lastPass = null;
          lastStateSat = msg.sat;
        }
        currentSatKey = msg.sat;
        setSatButtonLabel(msg.display || msg.sat);
      }

      const ul = document.getElementById("freq-ul");
      const dl = document.getElementById("freq-dl");
      if (ul) ul.textContent = msg.uplink || "-";
      if (dl) dl.textContent = msg.downlink || "-";

      const labels = document.querySelectorAll(".freq-block .freq-label");
      if (labels[0] && msg.ulLabel) labels[0].textContent = msg.ulLabel;
      if (labels[1] && msg.dlLabel) labels[1].textContent = msg.dlLabel;

      updateMapTracking(msg);

      if (msg.look) {
        const sky =
          msg.passes && msg.passes[0] && msg.passes[0].sky
            ? msg.passes[0].sky
            : null;
        updateRadar(msg.look.az, msg.look.el, sky);
      }

      updateSidebar(msg);
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
      dot.className =
        "status-dot " +
        (secToAos > 1800 ? "green" : secToAos > 300 ? "orange" : "red");
    }
  } else if (secToLos > 0) {
    if (labelEl) labelEl.textContent = "LOS in";
    countdownEl.textContent = formatCountdown(secToLos);
    if (dot) dot.className = "status-dot red";
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
  }
}

function notifyObserverChanged() {
  sendObserver();
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
  });

  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target) && e.target !== btn) {
      menu.hidden = true;
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startCountdownTimer);
} else {
  startCountdownTimer();
}
