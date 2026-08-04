/* Pass countdown, AOS/LOS display, time mode */
let timeMode = localStorage.getItem("satTrackerTimeMode") || "utc";
let lastPass = null;
let countdownTimer = null;

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
  if (typeof renderPassPanel === "function") renderPassPanel();
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
      if (secToAos <= 5 * 60) dot.className = "status-dot red";
      else if (secToAos <= 15 * 60) dot.className = "status-dot yellow";
      else dot.className = "status-dot";
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
  if (typeof updatePassPanelFromState === "function") {
    updatePassPanelFromState(state);
  }
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

function initTimeToggle() {
  document.querySelectorAll(".time-toggle").forEach((el) => {
    el.addEventListener("click", toggleTimeMode);
  });
}
