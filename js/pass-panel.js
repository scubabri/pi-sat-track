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
  // Moon (EME) passes last hours: "9h 56m" instead of "596m 12s".
  if (sec >= 3600) return Math.floor(sec / 3600) + "h " + String(Math.floor((sec % 3600) / 60)).padStart(2, "0") + "m";
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

/** Set text only when it changed (no DOM churn on the 1 s refresh). */
function setPassCellText(el, txt) {
  if (el.textContent !== txt) el.textContent = txt;
}

/**
 * One Next Passes row: built once, then updated in place. The rows are
 * refreshed every second (countdown) and on every "state" message; rebuilding
 * them (innerHTML) replaced the bell under the pointer between pointerdown and
 * pointerup, so the browser fired no click on it and the single-pass alert
 * never toggled (worst on a busy Pi / touch screen). The bell element must
 * stay the same node; only its data-sat / data-aos / data-los change.
 */
function passRowEl(body, idx) {
  let row = body.children[idx];
  if (row && row.classList && row.classList.contains("pass-row-item") && row.__passCells) return row;
  row = document.createElement("div");
  row.className = "pass-row-item";
  const mk = (cls) => {
    const c = document.createElement("span");
    c.className = "pass-cell " + cls;
    row.appendChild(c);
    return c;
  };
  const cells = {
    alert: mk("pass-alert"),
    engage: mk("pass-engage-cell"),
    idx: mk("pass-idx"),
    aos: mk("pass-time"),
    los: mk("pass-time"),
    maxEl: mk("pass-num"),
    dur: mk("pass-num"),
    aosAz: mk("pass-num"),
    status: mk("pass-status"),
  };
  row.__passCells = cells;
  if (idx < body.children.length) body.insertBefore(row, body.children[idx]);
  else body.appendChild(row);
  return row;
}

function syncPassRowBell(cell, sat, aosMs, losMs) {
  let bell = cell.querySelector(".sat-alert");
  if (!sat || !Number.isFinite(aosMs)) {
    if (bell) bell.remove();
    return;
  }
  if (!bell) {
    bell = document.createElement("button");
    bell.type = "button";
    bell.className = "sat-alert";
    bell.setAttribute("data-alert", "pass");
    cell.appendChild(bell);
  }
  const los = Number.isFinite(losMs) ? String(losMs) : "";
  if (bell.getAttribute("data-sat") !== String(sat)) bell.setAttribute("data-sat", String(sat));
  if (bell.getAttribute("data-aos") !== String(aosMs)) bell.setAttribute("data-aos", String(aosMs));
  if (bell.getAttribute("data-los") !== los) bell.setAttribute("data-los", los);
}

/**
 * Auto Engage icon (js/auto-engage-ui.js paints + handles clicks), next to the
 * bell but independent of it. Same rule as the bell: built once per row and
 * kept (only data-* change) so a click is never lost to a refresh. No icon for
 * the Moon (EME is never auto engaged).
 */
function syncPassRowEngage(cell, sat, aosMs, losMs) {
  let icon = cell.querySelector(".pass-engage");
  const core = window.AutoEngageCore;
  const moon = core ? core.isMoonKey(sat) : String(sat || "").toUpperCase() === "MOON";
  if (!sat || !Number.isFinite(aosMs) || moon) {
    if (icon) icon.remove();
    return;
  }
  if (!icon) {
    icon = document.createElement("button");
    icon.type = "button";
    icon.className = "pass-engage";
    icon.setAttribute("data-engage", "pass");
    cell.appendChild(icon);
  }
  const los = Number.isFinite(losMs) ? String(losMs) : "";
  if (icon.getAttribute("data-sat") !== String(sat)) icon.setAttribute("data-sat", String(sat));
  if (icon.getAttribute("data-aos") !== String(aosMs)) icon.setAttribute("data-aos", String(aosMs));
  if (icon.getAttribute("data-los") !== los) icon.setAttribute("data-los", los);
}

function renderPassPanel() {
  const body = document.getElementById("pass-panel-body");
  if (!body) return;

  const passes = (lastPassList || []).slice(0, 5);
  updatePassDrawerChrome((lastPassList || []).length);

  if (!passes.length) {
    const msg = lastPassListSat
      ? "No upcoming passes computed"
      : "Select a satellite to see upcoming passes";
    const first = body.children[0];
    if (body.children.length === 1 && first.classList.contains("pass-panel-empty")) {
      setPassCellText(first, msg);
      return;
    }
    body.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "pass-panel-empty";
    empty.textContent = msg;
    body.appendChild(empty);
    return;
  }

  // Drop the empty-state note / surplus rows; keep existing rows (and bells).
  Array.from(body.children).forEach((c, i) => {
    if (!c.classList.contains("pass-row-item") || i >= passes.length) c.remove();
  });

  const now = Date.now();
  passes.forEach((p, idx) => {
    const row = passRowEl(body, idx);
    const cells = row.__passCells;
    const aosMs = new Date(p.aos).getTime();
    const losMs = new Date(p.los).getTime();
    const inPass = now >= aosMs && now <= losMs;
    const past = now > losMs;
    const cls = "pass-row-item" + (inPass ? " in-pass" : past ? " past" : "");
    if (row.className !== cls) row.className = cls;

    const maxEl =
      p.maxEl != null && Number.isFinite(p.maxEl)
        ? Number(p.maxEl).toFixed(1) + "\u00B0"
        : "\u2014";
    const aosAz =
      p.aosAz != null && Number.isFinite(p.aosAz)
        ? Number(p.aosAz).toFixed(0) + "\u00B0"
        : "\u2014";

    // Pass alert bell (js/pass-alerts.js paints on/inherited/off + clicks).
    syncPassRowBell(cells.alert, lastPassListSat, aosMs, losMs);
    if (cells.engage) syncPassRowEngage(cells.engage, lastPassListSat, aosMs, losMs);
    setPassCellText(cells.idx, String(idx + 1));
    setPassCellText(cells.aos, passTimeText(p.aos));
    setPassCellText(cells.los, passTimeText(p.los));
    setPassCellText(cells.maxEl, maxEl);
    setPassCellText(cells.dur, passDurLabel(p.aos, p.los));
    setPassCellText(cells.aosAz, aosAz);
    setPassCellText(cells.status, passStatusLabel(p, now));
  });
  if (window.PassAlerts) window.PassAlerts.paint(body);
  if (window.AutoEngage) window.AutoEngage.paint(body);
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

  // Server findPasses steps on a 30s grid anchored to `now`, so absolute AOS
  // walks ~1s per tick. Freeze client-side and only accept a new AOS when it
  // clearly is a different pass (>> step jitter).
  const TOL_MS = 5 * 60 * 1000; // 5 minutes
  const next = passes.slice(0, 5);
  const newFrozen = [];
  const stabilized = next.map((p, i) => {
    const aosMs = new Date(p.aos).getTime();
    const losMs = new Date(p.los).getTime();
    let prev = frozenPassTimes[i];
    // Prefer index match; fall back to any nearby frozen AOS (list shift)
    if (
      !(
        prev &&
        Number.isFinite(prev.aosMs) &&
        Number.isFinite(aosMs) &&
        Math.abs(prev.aosMs - aosMs) < TOL_MS
      )
    ) {
      prev = frozenPassTimes.find(
        (f) =>
          f &&
          Number.isFinite(f.aosMs) &&
          Number.isFinite(aosMs) &&
          Math.abs(f.aosMs - aosMs) < TOL_MS,
      );
    }
    if (prev && Math.abs(prev.aosMs - aosMs) < TOL_MS) {
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
