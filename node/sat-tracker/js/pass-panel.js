/* Next-passes drawer for the selected satellite (same pattern as favorites). */
let lastPassList = []; // array of { aos, los, maxEl, aosAz, ... }
let lastPassListSat = null;
let passDrawerOpen =
  localStorage.getItem("satTrackerPassDrawer") === "1";
/** Frozen absolute AOS/LOS (ms) so server recompute drift does not reset countdown. */
let frozenPassTimes = []; // [{ aosMs, losMs }, ...]

function passDurLabel(aosIso, losIso) {
  const aos = new Date(aosIso).getTime();
  const los = new Date(losIso).getTime();
  if (!Number.isFinite(aos) || !Number.isFinite(los) || los <= aos) return "\u2014";
  const sec = Math.round((los - aos) / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + "m " + String(s).padStart(2, "0") + "s";
}

function formatPassAosHms(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return "\u2014";
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (
    String(h).padStart(2, "0") +
    ":" +
    String(m).padStart(2, "0") +
    ":" +
    String(s).padStart(2, "0")
  );
}

function passStatusLabel(p, now) {
  const aos = new Date(p.aos).getTime();
  const los = new Date(p.los).getTime();
  if (!Number.isFinite(aos) || !Number.isFinite(los)) return "\u2014";
  if (now >= aos && now <= los) return "IN PASS";
  if (now < aos) {
    return formatPassAosHms((aos - now) / 1000);
  }
  return "DONE";
}

function passTimeText(iso) {
  if (typeof formatPassTime === "function") return formatPassTime(iso);
  try {
    return new Date(iso).toISOString().substr(11, 8) + " UTC";
  } catch (e) {
    return "\u2014";
  }
}

function updatePassDrawerChrome(count) {
  const panel = document.getElementById("pass-panel");
  const btn = document.getElementById("pass-drawer-toggle");
  const countEl = document.getElementById("pass-drawer-count");
  const satEl = document.getElementById("pass-drawer-sat");
  if (countEl) {
    countEl.textContent =
      count === 0
        ? "No passes"
        : count === 1
          ? "1 pass"
          : Math.min(count, 5) + " of " + count + " passes";
  }
  if (satEl) {
    satEl.textContent = lastPassListSat
      ? currentSatLabel || lastPassListSat
      : "";
  }
  if (panel) panel.classList.toggle("open", !!passDrawerOpen);
  if (btn) {
    btn.setAttribute("aria-expanded", passDrawerOpen ? "true" : "false");
    const chev = btn.querySelector(".pass-drawer-chevron");
    if (chev) chev.textContent = passDrawerOpen ? "\u25B4" : "\u25BE";
  }
}

function setPassDrawerOpen(open) {
  passDrawerOpen = !!open;
  localStorage.setItem("satTrackerPassDrawer", passDrawerOpen ? "1" : "0");
  updatePassDrawerChrome(lastPassList.length);
}

function togglePassDrawer(e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  setPassDrawerOpen(!passDrawerOpen);
}

function renderPassPanel() {
  const body = document.getElementById("pass-panel-body");
  if (!body) return;

  const passes = (lastPassList || []).slice(0, 5);
  updatePassDrawerChrome((lastPassList || []).length);

  body.innerHTML = "";

  if (!passes.length) {
    const empty = document.createElement("div");
    empty.className = "pass-panel-empty";
    empty.textContent = lastPassListSat
      ? "No upcoming passes computed"
      : "Select a satellite to see upcoming passes";
    body.appendChild(empty);
    return;
  }

  const now = Date.now();
  passes.forEach((p, idx) => {
    const row = document.createElement("div");
    const aosMs = new Date(p.aos).getTime();
    const losMs = new Date(p.los).getTime();
    const inPass = now >= aosMs && now <= losMs;
    const past = now > losMs;
    row.className =
      "pass-row-item" + (inPass ? " in-pass" : past ? " past" : "");

    const status = passStatusLabel(p, now);
    const maxEl =
      p.maxEl != null && Number.isFinite(p.maxEl)
        ? Number(p.maxEl).toFixed(1) + "\u00B0"
        : "\u2014";
    const aosAz =
      p.aosAz != null && Number.isFinite(p.aosAz)
        ? Number(p.aosAz).toFixed(0) + "\u00B0"
        : "\u2014";

    row.innerHTML =
      '<span class="pass-cell pass-idx">' +
      (idx + 1) +
      "</span>" +
      '<span class="pass-cell pass-time">' +
      passTimeText(p.aos) +
      "</span>" +
      '<span class="pass-cell pass-time">' +
      passTimeText(p.los) +
      "</span>" +
      '<span class="pass-cell pass-num">' +
      maxEl +
      "</span>" +
      '<span class="pass-cell pass-num">' +
      passDurLabel(p.aos, p.los) +
      "</span>" +
      '<span class="pass-cell pass-num">' +
      aosAz +
      "</span>" +
      '<span class="pass-cell pass-status">' +
      status +
      "</span>";

    body.appendChild(row);
  });
}

/**
 * Adopt server pass list but freeze AOS/LOS absolute times when the server
 * only drifts them by a few seconds (recompute each tick). Same idea as
 * favAosDeadline — otherwise the countdown never advances and clock times walk.
 */
function adoptPasses(passes, satKey) {
  if (satKey && satKey !== lastPassListSat) {
    lastPassListSat = satKey;
    frozenPassTimes = [];
  }
  if (!Array.isArray(passes)) return;

  const next = passes.slice(0, 5);
  const newFrozen = [];
  const stabilized = next.map((p, i) => {
    const aosMs = new Date(p.aos).getTime();
    const losMs = new Date(p.los).getTime();
    const prev = frozenPassTimes[i];
    // Keep prior absolute times if within 15s (server step / recompute jitter)
    if (
      prev &&
      Number.isFinite(prev.aosMs) &&
      Number.isFinite(aosMs) &&
      Math.abs(prev.aosMs - aosMs) < 15000
    ) {
      newFrozen.push(prev);
      return Object.assign({}, p, {
        aos: new Date(prev.aosMs).toISOString(),
        los: new Date(prev.losMs).toISOString(),
      });
    }
    newFrozen.push({
      aosMs: aosMs,
      losMs: Number.isFinite(losMs) ? losMs : aosMs,
    });
    return p;
  });
  frozenPassTimes = newFrozen;
  lastPassList = stabilized;
}

function updatePassPanelFromState(state) {
  if (!state) return;
  if (Array.isArray(state.passes)) {
    adoptPasses(state.passes, state.sat || lastPassListSat);
  } else if (state.sat && state.sat !== lastPassListSat) {
    lastPassListSat = state.sat;
    lastPassList = [];
    frozenPassTimes = [];
  }
  renderPassPanel();
}

function initPassPanel() {
  const btn = document.getElementById("pass-drawer-toggle");
  if (btn) btn.addEventListener("click", togglePassDrawer);
  updatePassDrawerChrome(0);
  renderPassPanel();
  // Live AOS HH:MM:SS countdown while drawer is open
  setInterval(function () {
    if (passDrawerOpen && lastPassList.length) renderPassPanel();
  }, 1000);
}
