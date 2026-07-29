let ws = null;
let reconnectTimer = null;

let timeMode = localStorage.getItem("satTrackerTimeMode") || "utc";
let lastPass = null;
let currentSatKey = localStorage.getItem("satTrackerSat") || null;
let currentSatLabel = null;
let lastSatList = null;

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
  if (btn) btn.textContent = (label || "—") + " ▾";
  document.querySelectorAll(".sat-option[data-sat]").forEach((el) => {
    el.classList.toggle("active", el.dataset.sat === currentSatKey);
  });
}

/**
 * Quick menu: heard first, then a few active, always include current.
 * Full list lives on /sats.html
 */
function renderSatMenu(payload) {
  const menu = document.getElementById("sat-menu");
  if (!menu) return;

  lastSatList = payload;
  const sats = payload.satellites || [];

  // Keep browse link + section header; rebuild the rest
  const browse = menu.querySelector(".sat-browse");
  const section = menu.querySelector(".sat-menu-section");
  menu.innerHTML = "";
  if (browse) menu.appendChild(browse);
  else {
    const a = document.createElement("a");
    a.className = "sat-option sat-browse";
    a.href = "/sats.html";
    a.textContent = "Browse all satellites…";
    menu.appendChild(a);
  }
  if (section) menu.appendChild(section);
  else {
    const head = document.createElement("div");
    head.className = "sat-menu-section";
    head.textContent = "Heard / active";
    menu.appendChild(head);
  }

  const heard = sats.filter((s) => s.heard);
  const active = sats.filter((s) => !s.heard && s.status === "active");
  const quick = [];
  const seen = new Set();

  function add(s) {
    if (!s || seen.has(s.key)) return;
    seen.add(s.key);
    quick.push(s);
  }

  // Current first if known
  if (currentSatKey) {
    add(sats.find((s) => s.key === currentSatKey));
  }
  heard.forEach(add);
  active.slice(0, 12).forEach(add);

  // Cap quick list
  const shown = quick.slice(0, 20);

  shown.forEach((s) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sat-option" + (s.key === currentSatKey ? " active" : "");
    if (s.heard) btn.classList.add("heard");
    btn.dataset.sat = s.key;
    btn.textContent = s.name;
    btn.title = `${s.name}  (NORAD ${s.norad})` + (s.heard ? " · heard" : "");
    btn.addEventListener("click", () => selectSatellite(s.key, s.name));
    menu.appendChild(btn);
  });

  const statusCat = document.getElementById("status-catalog");
  if (statusCat) {
    const n = sats.length;
    statusCat.textContent = `${n} · ${payload.catalogNote || "?"}`;
  }

  // Sync label from list
  if (currentSatKey) {
    const match = sats.find((s) => s.key === currentSatKey);
    if (match) setSatButtonLabel(match.name);
    else if (!currentSatLabel) setSatButtonLabel(currentSatKey);
  } else if (shown.length) {
    currentSatKey = shown[0].key;
    setSatButtonLabel(shown[0].name);
  }
}

function selectSatellite(key, label) {
  currentSatKey = key;
  setSatButtonLabel(label || key);
  localStorage.setItem("satTrackerSat", key);

  const menu = document.getElementById("sat-menu");
  if (menu) menu.hidden = true;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "sat", key }));
  }
}

function connectTracker() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws`;

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
        currentSatKey = msg.sat;
        setSatButtonLabel(msg.display || msg.sat);
      }

      // Frequencies from catalog
      const ul = document.getElementById("freq-ul");
      const dl = document.getElementById("freq-dl");
      if (ul) ul.textContent = msg.uplink || "—";
      if (dl) dl.textContent = msg.downlink || "—";

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
    console.log("Tracker WebSocket closed – reconnecting in 2s");
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

function updateSidebar(state) {
  const tleEl = document.getElementById("status-tle");
  if (tleEl) tleEl.textContent = state.tleNote || "—";

  if (state.passes && state.passes.length) {
    const p = state.passes[0];
    lastPass = p;
    renderPassTimes();

    const maxEl = document.getElementById("pass-maxel");
    const durEl = document.getElementById("pass-duration");
    if (maxEl) maxEl.textContent = p.maxEl.toFixed(1) + "°";

    if (durEl) {
      const aos = new Date(p.aos);
      const los = new Date(p.los);
      const durSec = (los - aos) / 1000;
      const durMin = Math.floor(durSec / 60);
      const durS = Math.floor(durSec % 60);
      durEl.textContent = `${durMin}m ${durS}s`;
    }

    const now = Date.now();
    const secToAos = (new Date(p.aos).getTime() - now) / 1000;
    const secToLos = (new Date(p.los).getTime() - now) / 1000;
    const countdownEl = document.getElementById("countdown");
    const dot = document.querySelector("#pass-status .status-dot");

    if (countdownEl) {
      if (secToAos > 0) {
        countdownEl.textContent = formatCountdown(secToAos);
        if (dot) {
          dot.className =
            "status-dot " +
            (secToAos > 1800 ? "green" : secToAos > 300 ? "yellow" : "red");
        }
      } else if (secToLos > 0) {
        countdownEl.textContent = "LOS " + formatCountdown(secToLos);
        if (dot) dot.className = "status-dot red";
      } else {
        countdownEl.textContent = "—";
      }
    }
  }
}

function formatCountdown(sec) {
  if (sec < 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
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
