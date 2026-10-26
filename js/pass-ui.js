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

/** Short clock for chart hover / preview labels; follows the AOS/LOS UTC|local toggle. */
function formatClockShort(t) {
  const d = new Date(t);
  if (timeMode === "utc") return d.toISOString().substr(11, 5) + " UTC";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) + " MT";
}
/** Chart axis hour label (no zone suffix). */
function formatAxisHour(t) {
  const d = new Date(t);
  const h = timeMode === "utc" ? d.getUTCHours() : d.getHours();
  return String(h).padStart(2, "0") + (timeMode === "utc" ? "Z" : "");
}
function isUtcTimeMode() { return timeMode === "utc"; }

/* ---- Sat-dot label (map + globe): name + AOS/LOS countdown, El / Range / Alt ---- */
/** "12m 34s", "45s", "1h 05m" for the dot label countdown. */
function formatCountdownShort(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return h + "h " + String(m).padStart(2, "0") + "m";
  if (m > 0) return m + "m " + String(s).padStart(2, "0") + "s";
  return s + "s";
}

/**
 * Two-line label for a sat dot from data already on the client:
 *  - st.passes (selected sat, "state" msg; computed with the rotor min-EL cutoff)
 *  - or st.nextPass {aos, los} (favorites payload, lib/fav-passes.js)
 *  - st.look {el, rangeKm}, st.position.heightKm (live).
 * In a pass (aos <= now < los): stacked NAME / LOS 00:05:10 / 14:17 UTC / El 34° / Rng 1234 km / Alt 568 km.
 * Otherwise:                    stacked NAME / AOS 00:12:34 / 14:05 UTC / Rng / Alt.
 * Returns { l1, l2, up } (l2 may be "").
 */
/** "01:00:01" (HH:MM:SS) countdown for the sat-dot label. */
function formatCountdownClock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const p = (n) => String(n).padStart(2, "0");
  return p(Math.floor(sec / 3600)) + ":" + p(Math.floor((sec % 3600) / 60)) + ":" + p(sec % 60);
}
function satDotLabelLines(st, now) {
  if (!st) return null;
  now = now != null ? now : Date.now();
  const name = st.display || st.sat || st.key || "";
  const clock = (t) => formatPassTime(t); // HH:MM:SS UTC|MT, to the second
  const hKm = st.position && Number.isFinite(st.position.heightKm) ? st.position.heightKm : null;
  const lk = st.look || {};
  const D = (km) => (typeof Units !== "undefined" ? Units.dist(km) : Math.round(km) + " km");
  const alt = hKm != null ? "Alt " + D(hKm) : "";
  const rng = Number.isFinite(lk.rangeKm) ? "Rng " + D(lk.rangeKm) : "";
  const el = Number.isFinite(lk.el) ? "El " + Math.round(lk.el) + "\u00B0" : "";
  const list = Array.isArray(st.passes) && st.passes.length ? st.passes : (st.nextPass ? [st.nextPass] : []);
  let pass = null;
  for (const p of list) {
    if (!p || !p.aos || !p.los) continue;
    if (new Date(p.los).getTime() > now) { pass = p; break; }
  }
  // Stacked: name / AOS|LOS countdown / clock / [El] / Rng / Alt
  const out = (lines, up) => {
    lines = lines.filter(Boolean);
    return { lines, l1: lines[0] || name, l2: lines.slice(1).join("\n"), up };
  };
  if (!pass) return out([name, el, rng, alt], false);
  const aosMs = new Date(pass.aos).getTime();
  const losMs = new Date(pass.los).getTime();
  if (aosMs <= now)
    return out([name, "LOS " + formatCountdownClock((losMs - now) / 1000), clock(losMs), el, rng, alt], true);
  return out([name, "AOS " + formatCountdownClock((aosMs - now) / 1000), clock(aosMs), el, rng, alt], false);
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
  window.dispatchEvent(new Event("time-mode-change"));
}

function formatCountdown(sec) {
  if (sec < 0 || !Number.isFinite(sec)) return "-";
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  // Always HH:MM:SS (matches the sat-dot label).
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

function tickCountdown() {
  const countdownEl = document.getElementById("countdown");
  const labelEl = document.getElementById("pass-label");
  const dot = document.querySelector("#pass-status .status-dot");
  if (!countdownEl) return;

  const now = Date.now();

  // Prefer pass window over elevation alone.
  // Old bug: currentEl >= 0 forced "LOS in" using lastPass.los even when
  // lastPass was still the *next* pass (AOS in the future), so the timer
  // matched time-to-AOS while labeled LOS.
  if (lastPass && lastPass.aos && lastPass.los) {
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
      return;
    }

    if (secToLos > 0) {
      if (labelEl) labelEl.textContent = "LOS in";
      countdownEl.textContent = formatCountdown(secToLos);
      if (dot) dot.className = "status-dot green";
      return;
    }

    lastPass = null;
  }

  if (currentEl != null && currentEl >= 0) {
    if (labelEl) labelEl.textContent = "EL";
    countdownEl.textContent = currentEl.toFixed(1) + "°";
    if (dot) dot.className = "status-dot green";
    return;
  }

  if (labelEl) labelEl.textContent = "Next AOS in";
  countdownEl.textContent = "-";
  if (dot) dot.className = "status-dot";
}

function startCountdownTimer() {
  if (countdownTimer) clearInterval(countdownTimer);
  tickCountdown();
  countdownTimer = setInterval(tickCountdown, 1000);
}

function updateSidebar(state) {
  updateAfterLosIndicator(state);
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
      durEl.textContent =
        durSec >= 3600 // Moon (EME): hours-long passes
          ? Math.floor(durSec / 3600) + "h " + String(Math.floor((durSec % 3600) / 60)).padStart(2, "0") + "m"
          : durMin + "m " + durS + "s";
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

/* ---- TLE source checkboxes (Satellite Status) ---- */
function readTleSourceChecks() {
  const root = document.getElementById("tle-sources");
  if (!root) return ["celestrak", "amsat", "satnogs"];
  const ids = [];
  root.querySelectorAll("input[data-tle-src]").forEach(function (inp) {
    if (inp.checked) ids.push(inp.getAttribute("data-tle-src"));
  });
  return ids;
}

function applyTleSourceChecks(sources) {
  const root = document.getElementById("tle-sources");
  if (!root || !Array.isArray(sources)) return;
  const set = new Set(sources.map(String));
  root.querySelectorAll("input[data-tle-src]").forEach(function (inp) {
    const id = inp.getAttribute("data-tle-src");
    inp.checked = set.has(id);
  });
}

function sendTleSources() {
  let ids = readTleSourceChecks();
  if (!ids.length) {
    // Keep at least one source enabled
    const first = document.querySelector("#tle-sources input[data-tle-src]");
    if (first) {
      first.checked = true;
      ids = [first.getAttribute("data-tle-src")];
    }
  }
  if (typeof ws !== "undefined" && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "tle-sources", sources: ids }));
  }
}

function initTleSourceUi() {
  const root = document.getElementById("tle-sources");
  if (!root || root.dataset.bound) return;
  root.dataset.bound = "1";
  root.addEventListener("change", function (ev) {
    if (!ev.target || !ev.target.matches("input[data-tle-src]")) return;
    sendTleSources();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initTleSourceUi);
} else {
  initTleSourceUi();
}

/* ---- Real-time clock (lower left of the map/globe); click toggles UTC / local ---- */
(function initRtcClock() {
  function tick() {
    const el = document.getElementById("rtc-clock");
    if (!el) return;
    const d = new Date();
    el.textContent = timeMode === "utc"
      ? d.toISOString().substr(11, 8) + " UTC"
      : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) + " MT";
  }
  function start() {
    const el = document.getElementById("rtc-clock");
    if (!el) return;
    el.addEventListener("click", (e) => { e.stopPropagation(); toggleTimeMode(); });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleTimeMode(); } });
    ["pointerdown", "mousedown", "dblclick", "wheel"].forEach((ev) => el.addEventListener(ev, (e) => e.stopPropagation()));
    window.addEventListener("time-mode-change", tick);
    tick();
    setInterval(tick, 1000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();

/* ---- After-LOS indicator (top bar, next to the AOS/LOS countdown) ---- */
const AFTER_LOS_FALLBACK_TEXT = {
  "antenna-off": "antenna off — rotor will not move",
  "no-favorites": "no favorites — will do nothing",
  "not-favorite": "selected sat is not a favorite — will do nothing",
  "no-upcoming-pass": "no favorite has an upcoming pass — will do nothing",
};
function updateAfterLosIndicator(state) {
  const el = document.getElementById("after-los-ind");
  if (!el) return;
  const a = state && state.afterLos;
  if (a && typeof applyServerAutoSelect === "function") applyServerAutoSelect(a.autoSelect === true);
  else if (a && typeof updateAutoSelectUi === "function") updateAutoSelectUi(a.autoSelect === true);
  const wantPark = !!a && a.mode === "park";
  const wantAuto = !!a && a.autoSelect === true;
  if (!wantPark && !wantAuto) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.classList.toggle("armed", !!a.inPass);
  const parkDead = wantPark && !!a.parkFallback;
  const autoDead = wantAuto && !a.target && a.fallback !== "pending";
  // Dim only when nothing will actually happen at LOS.
  el.classList.toggle("none", (!wantPark || parkDead) && (!wantAuto || autoDead));
  const parts = [];
  const tips = [];
  if (wantPark) {
    parts.push("Park");
    tips.push("park rotor" + (parkDead ? " (" + AFTER_LOS_FALLBACK_TEXT[a.parkFallback] + ")" : ""));
  }
  if (wantAuto) {
    if (a.target) {
      const sec = (a.target.aos - Date.now()) / 1000;
      const when = sec <= 0 ? "already up" : "AOS in " + formatCountdownShort(sec);
      parts.push("Auto: " + a.target.display);
      tips.push(
        "auto select " + a.target.display + " (" + when + ", " + formatClockShort(a.target.aos) +
          (a.target.maxEl != null ? ", max " + Math.round(a.target.maxEl) + "°" : "") + ")",
      );
    } else if (a.fallback === "pending") {
      parts.push("Auto");
      tips.push("auto select the favorite with the soonest AOS (picked once the pass is near)");
    } else {
      parts.push("Auto: —");
      tips.push("auto select — " + (AFTER_LOS_FALLBACK_TEXT[a.fallback] || "nothing to select"));
    }
  }
  el.textContent = "→ " + parts.join(" · ");
  el.title =
    "After LOS" + (a.losMs ? " at LOS " + formatClockShort(a.losMs) : "") + ": " + tips.join("; then ");
}

/** Short toast when the server ran the After-LOS action(s). */
function showAfterLosToast(evt) {
  if (!evt) return;
  const parts = [];
  if (evt.park) parts.push("parked");
  if (evt.target) parts.push("auto-selected " + (evt.display || evt.target));
  if (!parts.length) return;
  const old = document.getElementById("after-los-toast");
  if (old) old.remove();
  const t = document.createElement("div");
  t.id = "after-los-toast";
  t.className = "app-toast";
  t.setAttribute("role", "status");
  t.textContent = "After LOS: " + parts.join(", ");
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 5000);
}
