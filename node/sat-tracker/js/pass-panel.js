/* Next-passes drawer for the selected satellite (same pattern as favorites). */
let lastPassList = []; // array of { aos, los, maxEl, aosAz, ... }
let lastPassListSat = null;
let passDrawerOpen =
  localStorage.getItem("satTrackerPassDrawer") === "1";

function passDurLabel(aosIso, losIso) {
  const aos = new Date(aosIso).getTime();
  const los = new Date(losIso).getTime();
  if (!Number.isFinite(aos) || !Number.isFinite(los) || los <= aos) return "\u2014";
  const sec = Math.round((los - aos) / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + "m " + String(s).padStart(2, "0") + "s";
}

function passStatusLabel(p, now) {
  const aos = new Date(p.aos).getTime();
  const los = new Date(p.los).getTime();
  if (!Number.isFinite(aos) || !Number.isFinite(los)) return "\u2014";
  if (now >= aos && now <= los) return "IN PASS";
  if (now < aos) {
    const sec = (aos - now) / 1000;
    if (sec < 60) return "<1m";
    if (sec < 3600) return Math.round(sec / 60) + "m";
    if (sec < 86400) {
      const h = Math.floor(sec / 3600);
      const m = Math.round((sec % 3600) / 60);
      return h + "h " + m + "m";
    }
    const d = Math.floor(sec / 86400);
    return d + "d";
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

function updatePassPanelFromState(state) {
  if (!state) return;
  if (state.sat) lastPassListSat = state.sat;
  if (Array.isArray(state.passes)) {
    lastPassList = state.passes;
  }
  renderPassPanel();
}

function initPassPanel() {
  const btn = document.getElementById("pass-drawer-toggle");
  if (btn) btn.addEventListener("click", togglePassDrawer);
  updatePassDrawerChrome(0);
  renderPassPanel();
  setInterval(function () {
    if (passDrawerOpen && lastPassList.length) renderPassPanel();
  }, 30000);
}
