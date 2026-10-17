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
 * In a pass (aos <= now < los): "NAME · LOS in 5m 10s · 14:17 UTC" / "El 34° · Rng 1234 km · Alt 568 km".
 * Otherwise:                    "NAME · AOS in 12m 34s · 14:05 UTC" / "Alt 568 km".
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
  const clock = (t) => (typeof formatClockShort === "function" ? formatClockShort(t) : new Date(t).toISOString().substr(11, 5) + " UTC");
  const hKm = st.position && Number.isFinite(st.position.heightKm) ? st.position.heightKm : null;
  const lk = st.look || {};
  const alt = hKm != null ? "Alt " + Math.round(hKm) + " km" : "";
  const rng = Number.isFinite(lk.rangeKm) ? "Rng " + Math.round(lk.rangeKm) + " km" : "";
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
  if (!pass) return out([name, rng, alt], false);
  const aosMs = new Date(pass.aos).getTime();
  const losMs = new Date(pass.los).getTime();
  if (aosMs <= now)
    return out([name, "LOS " + formatCountdownClock((losMs - now) / 1000), clock(losMs), el, rng, alt], true);
  return out([name, "AOS " + formatCountdownClock((aosMs - now) / 1000), clock(aosMs), rng, alt], false);
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
