let profileCanvas = null;
let profileCtx = null;

let lockedSky = null;
let lockedAos = null;
let lockedLos = null;
let lockedPassKey = null;
let lockedName = "";
let lockedMaxEl = 10;
let lockedSat = null;
let profileObserver = null;

function initProfile() {
  profileCanvas = document.getElementById("profile-canvas");
  if (!profileCanvas) return;
  profileCtx = profileCanvas.getContext("2d");
  resizeProfile();
  window.addEventListener("resize", resizeProfile);

  // Pass-panel / fav-drawer open-close and sat switches change layout width
  // without a window resize — keep the canvas buffer in sync.
  const parent = profileCanvas.parentElement;
  if (parent && typeof ResizeObserver === "function") {
    if (profileObserver) profileObserver.disconnect();
    profileObserver = new ResizeObserver(function () {
      resizeProfile();
    });
    profileObserver.observe(parent);
  }

  initProfileResize();
  initFavProfileEvents();
  initChartPreviewEvents();
  drawProfileEmpty();
}

function resizeProfile() {
  if (!profileCanvas || !profileCtx) return;
  const parent = profileCanvas.parentElement;
  if (!parent) return;
  const w = parent.clientWidth;
  const h = parent.clientHeight;
  if (w < 2 || h < 2) return;

  const dpr = window.devicePixelRatio || 1;
  const bw = Math.max(1, Math.floor(w * dpr));
  const bh = Math.max(1, Math.floor(h * dpr));

  // Skip no-op resizes so we don't clear a good frame on every observer tick
  if (
    profileCanvas.width === bw &&
    profileCanvas.height === bh &&
    profileCanvas.style.width === w + "px" &&
    profileCanvas.style.height === h + "px"
  ) {
    return;
  }

  profileCanvas.width = bw;
  profileCanvas.height = bh;
  profileCanvas.style.width = w + "px";
  profileCanvas.style.height = h + "px";
  profileCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redrawCurrent();
}

/** Ensure backing store matches layout right before a draw. */
function ensureProfileSize() {
  if (!profileCanvas || !profileCtx) return false;
  const parent = profileCanvas.parentElement;
  if (!parent) return false;
  const w = parent.clientWidth;
  const h = parent.clientHeight;
  if (w < 2 || h < 2) return false;

  const dpr = window.devicePixelRatio || 1;
  const bw = Math.max(1, Math.floor(w * dpr));
  const bh = Math.max(1, Math.floor(h * dpr));

  if (
    profileCanvas.width !== bw ||
    profileCanvas.height !== bh ||
    profileCanvas.style.width !== w + "px" ||
    profileCanvas.style.height !== h + "px"
  ) {
    profileCanvas.width = bw;
    profileCanvas.height = bh;
    profileCanvas.style.width = w + "px";
    profileCanvas.style.height = h + "px";
    profileCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  return true;
}

function drawProfileEmpty() {
  if (!profileCtx || !profileCanvas) return;
  if (favProfileMode()) {
    drawFavProfile();
    return;
  }
  if (!ensureProfileSize()) return;
  const w = profileCanvas.clientWidth;
  const h = profileCanvas.clientHeight;
  profileCtx.clearRect(0, 0, w, h);
  profileCtx.fillStyle = "#8b949e";
  profileCtx.font = "12px sans-serif";
  profileCtx.textAlign = "center";
  profileCtx.fillText("Pass elevation profile", w / 2, h / 2);
}

function makePassKey(sat, aos) {
  const t = new Date(aos).getTime();
  if (!Number.isFinite(t)) return String(sat || "") + "|na";
  const bucket = Math.round(t / 180000) * 180000;
  return String(sat || "") + "|" + bucket;
}

function clearLock() {
  lockedSky = null;
  lockedAos = null;
  lockedLos = null;
  lockedPassKey = null;
  lockedName = "";
  lockedMaxEl = 10;
  lockedSat = null;
}

function clearProfileLock() {
  clearLock();
  drawProfileEmpty();
}

function snapshotSky(sky) {
  const out = [];
  for (let i = 0; i < sky.length; i++) {
    const p = sky[i];
    if (!p) continue;
    const az = Number(p.az);
    const el = Number(p.el);
    if (!Number.isFinite(az) || !Number.isFinite(el)) continue;
    out.push({ az: az, el: el });
  }
  return out;
}

let lastLook = null;
function redrawCurrent(look) {
  if (look) lastLook = look;
  else look = lastLook;
  if (favProfileMode()) {
    drawFavProfile();
    return;
  }
  if (!lockedSky || lockedSky.length < 2) {
    drawProfileEmpty();
    return;
  }
  drawFixedProfile(lockedSky, lockedMaxEl, lockedName, look || null);
}

function drawFixedProfile(sky, maxElHint, name, look) {
  if (!profileCtx || !profileCanvas) return;
  if (!ensureProfileSize()) return;

  const w = profileCanvas.clientWidth;
  const h = profileCanvas.clientHeight;
  const padL = 40;
  const padR = 16;
  const padT = 16;
  const padB = 24;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  profileCtx.clearRect(0, 0, w, h);

  let maxEl = 10;
  for (let i = 0; i < sky.length; i++) {
    if (sky[i].el > maxEl) maxEl = sky[i].el;
  }
  if (maxElHint && maxElHint > maxEl) maxEl = maxElHint;
  maxEl = Math.min(90, Math.ceil((maxEl + 10) / 10) * 10);
  if (maxEl < 20) maxEl = 20;

  function xAt(i) {
    return padL + (i / (sky.length - 1)) * plotW;
  }
  function yAt(el) {
    const e = Math.max(0, Math.min(maxEl, el));
    return padT + plotH - (e / maxEl) * plotH;
  }

  profileCtx.strokeStyle = "#30363d";
  profileCtx.lineWidth = 1;
  profileCtx.fillStyle = "#8b949e";
  profileCtx.font = "10px sans-serif";
  profileCtx.textAlign = "right";
  profileCtx.textBaseline = "middle";

  for (let el = 0; el <= maxEl; el += 20) {
    const y = yAt(el);
    profileCtx.beginPath();
    profileCtx.moveTo(padL, y);
    profileCtx.lineTo(padL + plotW, y);
    profileCtx.stroke();
    profileCtx.fillText(el + "\u00B0", padL - 6, y);
  }

  profileCtx.beginPath();
  profileCtx.strokeStyle = "#58a6ff";
  profileCtx.lineWidth = 2.5;
  profileCtx.lineJoin = "round";
  for (let i = 0; i < sky.length; i++) {
    const x = xAt(i);
    const y = yAt(sky[i].el);
    if (i === 0) profileCtx.moveTo(x, y);
    else profileCtx.lineTo(x, y);
  }
  profileCtx.stroke();

  const labelEvery = Math.max(1, Math.floor(sky.length / 16));
  profileCtx.font = "10px sans-serif";
  profileCtx.textAlign = "center";
  profileCtx.textBaseline = "bottom";

  for (let i = 0; i < sky.length; i++) {
    const x = xAt(i);
    const y = yAt(sky[i].el);

    profileCtx.beginPath();
    profileCtx.fillStyle = "#58a6ff";
    profileCtx.arc(x, y, 3.2, 0, Math.PI * 2);
    profileCtx.fill();

    if (i % labelEvery === 0 || i === 0 || i === sky.length - 1) {
      profileCtx.fillStyle = "#e6edf3";
      profileCtx.fillText(Math.round(sky[i].az) + "\u00B0", x, y - 6);
    }
  }

  if (look && typeof look.progress === "number") {
    const t = Math.max(0, Math.min(1, look.progress));
    const x = padL + t * plotW;

    const idxF = t * (sky.length - 1);
    const i0 = Math.floor(idxF);
    const i1 = Math.min(sky.length - 1, i0 + 1);
    const frac = idxF - i0;
    const elInterp = sky[i0].el * (1 - frac) + sky[i1].el * frac;
    const y = yAt(typeof look.el === "number" ? look.el : elInterp);

    profileCtx.strokeStyle = "#f85149";
    profileCtx.lineWidth = 1;
    profileCtx.setLineDash([4, 4]);
    profileCtx.beginPath();
    profileCtx.moveTo(x, padT);
    profileCtx.lineTo(x, padT + plotH);
    profileCtx.stroke();
    profileCtx.setLineDash([]);

    profileCtx.beginPath();
    profileCtx.fillStyle = "#fff";
    profileCtx.strokeStyle = "#f85149";
    profileCtx.lineWidth = 2;
    profileCtx.arc(x, y, 5, 0, Math.PI * 2);
    profileCtx.fill();
    profileCtx.stroke();
  }

  if (name) {
    profileCtx.fillStyle = "rgba(88, 166, 255, 0.15)";
    profileCtx.font = "bold 28px sans-serif";
    profileCtx.textAlign = "center";
    profileCtx.textBaseline = "middle";
    profileCtx.fillText(name, padL + plotW / 2, padT + plotH / 2);
  }

  // Hover cursor + preview line (time axis = AOS..LOS, same as the now dot).
  const aosMs = new Date(lockedAos).getTime();
  const losMs = new Date(lockedLos).getTime();
  if (Number.isFinite(aosMs) && losMs > aosMs) {
    const T = (x) => aosMs + ((x - padL) / plotW) * (losMs - aosMs);
    const Xt = (t) => padL + ((t - aosMs) / (losMs - aosMs)) * plotW;
    const prog = look && typeof look.progress === "number" ? look.progress : null;
    chartGeom = {
      mode: "single", padL, padT, plotW, plotH, T, X: Xt, tMin: aosMs, tMax: losMs,
      nowX: prog != null && prog >= 0 && prog <= 1 ? padL + prog * plotW : null,
    };
    const sample = (t) => {
      const f = (t - aosMs) / (losMs - aosMs);
      if (f < 0 || f > 1) return [];
      const idxF = f * (sky.length - 1);
      const i0 = Math.floor(idxF);
      const i1 = Math.min(sky.length - 1, i0 + 1);
      const fr = idxF - i0;
      const el = sky[i0].el * (1 - fr) + sky[i1].el * fr;
      let daz = sky[i1].az - sky[i0].az;
      daz = ((daz + 540) % 360) - 180;
      const az = (sky[i0].az + daz * fr + 360) % 360;
      return [{ key: lockedSat, display: name || lockedSat, el, az, y: yAt(el), col: "#58a6ff", sel: true }];
    };
    drawChartOverlays(profileCtx, chartGeom, sample);
  } else chartGeom = null;
}

function updateProfile(state) {
  if (!state) return;

  const pass = state.passes && state.passes[0] ? state.passes[0] : null;
  const sat = state.sat || null;
  const now = Date.now();

  if (lockedSat != null && sat != null && lockedSat !== sat) {
    clearLock();
  }

  if (lockedLos) {
    const losMs = new Date(lockedLos).getTime();
    if (Number.isFinite(losMs) && now > losMs + 30000) {
      clearLock();
    }
  }

  if (lockedSky && lockedSky.length >= 2 && lockedSat === sat) {
    let progress = null;
    if (lockedAos && lockedLos) {
      const aos = new Date(lockedAos).getTime();
      const los = new Date(lockedLos).getTime();
      if (los > aos) progress = (now - aos) / (los - aos);
    }
    redrawCurrent({
      az: state.look ? state.look.az : null,
      el: state.look ? state.look.el : null,
      progress: progress,
    });
    return;
  }

  // Accept shorter passes (was 5; 30s samples can undershoot on brief passes)
  if (!pass || !pass.sky || pass.sky.length < 2) {
    drawProfileEmpty();
    return;
  }

  const sky = snapshotSky(pass.sky);
  if (sky.length < 2) {
    drawProfileEmpty();
    return;
  }

  lockedSat = sat;
  lockedPassKey = makePassKey(sat, pass.aos);
  lockedAos = pass.aos;
  lockedLos = pass.los;
  lockedName = state.display || state.sat || "";
  lockedMaxEl = typeof pass.maxEl === "number" ? pass.maxEl : 10;
  lockedSky = sky;

  let progress = null;
  if (lockedAos && lockedLos) {
    const aos = new Date(lockedAos).getTime();
    const los = new Date(lockedLos).getTime();
    if (los > aos) progress = (now - aos) / (los - aos);
  }

  redrawCurrent({
    az: state.look ? state.look.az : null,
    el: state.look ? state.look.el : null,
    progress: progress,
  });
}

/* ===================== Resizable chart (drag top edge) ===================== */
const PROFILE_H_KEY = "profileChartHeight";
const PROFILE_H_MIN = 80;
function profileMaxH() {
  return Math.max(PROFILE_H_MIN, Math.min(400, Math.round(window.innerHeight * 0.5)));
}
function setProfileHeight(px, persist) {
  const box = document.getElementById("pass-profile");
  if (!box) return;
  const hpx = Math.round(Math.max(PROFILE_H_MIN, Math.min(profileMaxH(), px)));
  box.style.height = hpx + "px";
  if (persist) {
    try { localStorage.setItem(PROFILE_H_KEY, String(hpx)); } catch (_) {}
  }
  resizeProfile();
  if (typeof map !== "undefined" && map && map.invalidateSize) map.invalidateSize({ pan: false });
}
function initProfileResize() {
  const handle = document.getElementById("profile-resize");
  const box = document.getElementById("pass-profile");
  if (!handle || !box || handle.__init) return;
  handle.__init = true;
  const saved = parseInt(localStorage.getItem(PROFILE_H_KEY), 10);
  if (Number.isFinite(saved)) setProfileHeight(saved, false);
  let startY = 0;
  let startH = 0;
  let pid = null;
  handle.addEventListener("pointerdown", (e) => {
    pid = e.pointerId;
    startY = e.clientY;
    startH = box.getBoundingClientRect().height;
    handle.setPointerCapture(pid);
    handle.classList.add("dragging");
    e.preventDefault();
  });
  handle.addEventListener("pointermove", (e) => {
    if (pid !== e.pointerId) return;
    setProfileHeight(startH + (startY - e.clientY), false);
  });
  const end = (e) => {
    if (pid !== e.pointerId) return;
    pid = null;
    handle.classList.remove("dragging");
    setProfileHeight(box.getBoundingClientRect().height, true);
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  handle.addEventListener("dblclick", () => setProfileHeight(120, true));
  window.addEventListener("resize", () => {
    const hNow = box.getBoundingClientRect().height;
    if (hNow > profileMaxH()) setProfileHeight(hNow, false);
  });
}

/* ============ Favorites view: 24 h of passes (selected + favorites) ============ */
// Active while the map's Favorites overlay button is on. Data: server "fav-profile".
let favProfileData = null;
let favProfileHover = null; // sat key highlighted (legend / arc hover)
let favProfileHits = { legend: [], arcs: [], labels: [] };
let favHitAt = null; // (mouse event) -> { key, display, legend? } | null

function favProfileMode() {
  return typeof window.isFavOverlayOn === "function" && window.isFavOverlayOn();
}

function requestFavProfile() {
  if (typeof ws !== "undefined" && ws && ws.readyState === 1)
    ws.send(JSON.stringify({ type: "fav-profile-get" }));
}

function initFavProfileEvents() {
  if (initFavProfileEvents.done) return;
  initFavProfileEvents.done = true;
  document.addEventListener("fav-overlay-change", (e) => {
    favProfileHover = null;
    if (e.detail && e.detail.on) requestFavProfile();
    redrawCurrent();
  });
  // Hook the socket (reconnects create a new ws).
  setInterval(() => {
    if (typeof ws === "undefined" || !ws || ws.__favProfilePatched) return;
    ws.__favProfilePatched = true;
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string" || ev.data.indexOf('"fav-profile"') < 0) return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type !== "fav-profile") return;
        favProfileData = msg;
        if (favProfileMode()) drawFavProfile();
      } catch (_) {}
    });
    if (ws.readyState === 1) requestFavProfile();
    else ws.addEventListener("open", requestFavProfile);
  }, 500);
  // Keep the "now" marker moving even without state ticks.
  setInterval(() => { if (favProfileMode()) drawFavProfile(); }, 30000);

  const cv = profileCanvas;
  if (!cv) return;
  const hitAt = (e) => {
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    for (const l of favProfileHits.legend)
      if (x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h) return { key: l.key, display: l.display, legend: true };
    // Peak labels ("RS-44 46°") pick their sat.
    for (const l of favProfileHits.labels || [])
      if (x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h) return { key: l.key, display: l.display, t: l.t };
    // Nearest arc line (distance to segments, so steep spikes between 60 s samples still hit).
    let best = null;
    let bd = 64; // 8 px radius
    const seg = (px, py, a, b) => {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const L = dx * dx + dy * dy;
      const u = L ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / L)) : 0;
      const qx = a[0] + u * dx - px, qy = a[1] + u * dy - py;
      return qx * qx + qy * qy;
    };
    for (const a of favProfileHits.arcs) {
      if (x < a.x0 - 8 || x > a.x1 + 8) continue;
      for (let i = 0; i < a.pts.length; i++) {
        const d = i ? seg(x, y, a.pts[i - 1], a.pts[i]) : (a.pts[0][0] - x) ** 2 + (a.pts[0][1] - y) ** 2;
        if (d < bd) { bd = d; best = a; }
      }
    }
    if (best) return { key: best.key, display: best.display, arc: best };
    // Under a pass's curve (inside the spike): the lowest curve above the click wins.
    let under = null, uy = -Infinity;
    for (const a of favProfileHits.arcs) {
      if (x < a.x0 || x > a.x1) continue;
      for (let i = 1; i < a.pts.length; i++) {
        const p0 = a.pts[i - 1], p1 = a.pts[i];
        if (x < p0[0] || x > p1[0]) continue;
        const cy = p1[0] === p0[0] ? Math.min(p0[1], p1[1]) : p0[1] + ((x - p0[0]) / (p1[0] - p0[0])) * (p1[1] - p0[1]);
        if (y >= cy && cy > uy) { uy = cy; under = a; }
        break;
      }
    }
    return under ? { key: under.key, display: under.display, arc: under } : null;
  };
  favHitAt = hitAt;
  cv.addEventListener("mousemove", (e) => {
    if (!favProfileMode()) return;
    const h = hitAt(e);
    const k = h ? h.key : null;
    cv.style.cursor = h ? "pointer" : "";
    if (k !== favProfileHover) { favProfileHover = k; drawFavProfile(); }
  });
  cv.addEventListener("mouseleave", () => {
    cv.style.cursor = "";
    if (favProfileHover) { favProfileHover = null; if (favProfileMode()) drawFavProfile(); }
  });
  cv.addEventListener("click", (e) => {
    if (!favProfileMode() || chartDragged) return; // end of a preview-line drag
    const h = hitAt(e);
    if (!h) { if (favProfileHover) { favProfileHover = null; drawFavProfile(); } return; }
    // Legend name: select that sat (if not already) and spin the globe to it.
    if (h.legend) {
      if (window.passPreview) window.passPreview.clear(); // show where it is now
      if (favProfileData && h.key !== favProfileData.current && typeof selectSatellite === "function") selectSatellite(h.key, h.display);
      if (typeof window.globeSnapTo === "function") window.globeSnapTo(h.key);
      return;
    }
    // Another sat's arc: select it and spin the globe to it. The selected sat's
    // arc (like blank chart) sets the pass preview instead (initChartPreviewEvents).
    if (!favProfileData || h.key === favProfileData.current) return;
    if (window.passPreview) window.passPreview.clear(); // show where it is now
    if (typeof selectSatellite === "function") selectSatellite(h.key, h.display);
    if (typeof window.globeSnapTo === "function") window.globeSnapTo(h.key);
  });
}

function drawFavProfile() {
  if (!profileCtx || !profileCanvas) return;
  if (!ensureProfileSize()) return;
  const ctx = profileCtx;
  const w = profileCanvas.clientWidth;
  const h = profileCanvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  favProfileHits = { legend: [], arcs: [], labels: [] };
  const data = favProfileData;
  if (!data || !Array.isArray(data.sats)) {
    ctx.fillStyle = "#8b949e";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Favorites: computing 24 h passes…", w / 2, h / 2);
    if (!data) requestFavProfile();
    return;
  }
  const now = Date.now();
  const t0 = now - 2 * 3600000; // 2 h of recent past so "now" sits in from the edge
  const t1 = now + 22 * 3600000;
  const sats = data.sats.slice().sort((a, b) => (a.key === data.current) - (b.key === data.current));
  const colorOf = (s) => (s.key === data.current ? SAT_SELECTED_COLOR : favColor(s.key));

  // Legend width: longest name.
  ctx.font = "10px sans-serif";
  let legW = 0;
  sats.forEach((s) => { legW = Math.max(legW, ctx.measureText(s.display || s.key).width); });
  legW = Math.min(170, Math.ceil(legW) + 22);
  const padL = 34;
  const padR = legW + 10;
  const padT = 12;
  const padB = 18;
  const plotW = Math.max(10, w - padL - padR);
  const plotH = Math.max(10, h - padT - padB);
  const X = (t) => padL + ((t - t0) / (t1 - t0)) * plotW;
  const Y = (el) => padT + plotH - (Math.max(0, Math.min(90, el)) / 90) * plotH;

  // Grid + hour ticks (local time).
  ctx.lineWidth = 1;
  ctx.font = "10px sans-serif";
  ctx.fillStyle = "#8b949e";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const elStep = plotH > 140 ? 30 : 45;
  for (let el = 0; el <= 90; el += elStep) {
    ctx.strokeStyle = "#30363d";
    ctx.beginPath();
    ctx.moveTo(padL, Y(el));
    ctx.lineTo(padL + plotW, Y(el));
    ctx.stroke();
    ctx.fillText(el + "\u00B0", padL - 4, Y(el));
  }
  const hourMs = 3600000;
  const d0 = new Date(t0);
  d0.setMinutes(0, 0, 0);
  const labelEveryH = plotW / 24 < 28 ? 3 : plotW / 24 < 45 ? 2 : 1;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let t = d0.getTime() + hourMs; t < t1; t += hourMs) {
    const x = X(t);
    ctx.strokeStyle = "#21262d";
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    const utc = typeof isUtcTimeMode === "function" && isUtcTimeMode();
    const hr = utc ? new Date(t).getUTCHours() : new Date(t).getHours();
    if (hr % labelEveryH === 0) {
      ctx.fillStyle = "#8b949e";
      ctx.fillText(typeof formatAxisHour === "function" ? formatAxisHour(t) : new Date(t).toLocaleTimeString([], { hour: "numeric" }).replace(/\s/g, ""), x, padT + plotH + 4);
    }
  }

  // No sat-name watermark in favorites mode (legend names each sat); the
  // single-sat chart keeps its watermark.

  // Arcs: favorites first (thin), selected last (thick, on top).
  const labels = [];
  const hk = favProfileHover;
  ctx.save();
  ctx.beginPath();
  ctx.rect(padL, 0, plotW, padT + plotH + 1);
  ctx.clip();
  ctx.lineJoin = "round";
  for (const s of sats) {
    const sel = s.key === data.current;
    const col = colorOf(s);
    const hi = hk === s.key;
    const dim = hk && !hi;
    for (const p of s.passes || []) {
      if (!p.pts || p.pts.length < 2 || p.los < t0 || p.aos > t1) continue;
      const low = p.maxEl < 10;
      ctx.globalAlpha = dim ? 0.15 : hi ? 1 : low ? 0.35 : sel ? 1 : 0.8;
      ctx.strokeStyle = col;
      ctx.lineWidth = sel ? 2.5 : hi ? 2 : 1.2;
      ctx.beginPath();
      const xy = [];
      p.pts.forEach((q, i) => {
        const x = X(Math.max(t0, q[0]));
        const y = Y(q[1]);
        xy.push([x, y]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      favProfileHits.arcs.push({ key: s.key, display: s.display, pts: xy, x0: xy[0][0], x1: xy[xy.length - 1][0],
        ts: p.pts.map((q) => Math.max(t0, q[0])), aos: p.aos, los: p.los }); // times for click → preview T
      if (p.maxEl >= 20 && !dim) {
        let pk = p.pts[0];
        p.pts.forEach((q) => { if (q[1] > pk[1]) pk = q; });
        if (pk[0] >= t0)
          labels.push({ key: s.key, display: s.display, t: pk[0], x: X(pk[0]), y: Y(pk[1]), text: (s.display || s.key) + " " + Math.round(p.maxEl) + "\u00B0", col, pri: sel || hi ? 0 : 1, maxEl: p.maxEl });
      }
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;

  // Peak labels with collision staggering (selected / highlighted first, then highest).
  ctx.font = "bold 9px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  const placed = [];
  labels.sort((a, b) => a.pri - b.pri || b.maxEl - a.maxEl);
  for (const l of labels) {
    const lw = ctx.measureText(l.text).width + 4;
    const lx = Math.max(padL + lw / 2, Math.min(padL + plotW - lw / 2, l.x));
    let y = Math.max(padT + 10, l.y - 2);
    const hits = (yy) => placed.some((o) => Math.abs(o.x - lx) < (o.w + lw) / 2 && Math.abs(o.y - yy) < 10);
    let ok = !hits(y);
    for (let k = 1; !ok && k <= 4; k++) {
      for (const dy of [10 * k, -10 * k]) {
        const yy = y + dy;
        if (yy < padT + 10 || yy > padT + plotH) continue;
        if (!hits(yy)) { y = yy; ok = true; break; }
      }
    }
    if (!ok) continue; // drop rather than overprint
    placed.push({ x: lx, y, w: lw });
    if (l.key) favProfileHits.labels.push({ key: l.key, display: l.display, t: l.t, x: lx - lw / 2, y: y - 11, w: lw, h: 12 });
    ctx.fillStyle = "rgba(13,17,23,0.7)";
    ctx.fillRect(lx - lw / 2, y - 10, lw, 10);
    ctx.fillStyle = l.col;
    ctx.fillText(l.text, lx, y);
  }

  // "Now" marker at the left edge.
  const xn = X(now) + 1;
  // Recent past: dim it so the future reads as the main part of the chart.
  ctx.fillStyle = "rgba(13,17,23,0.45)";
  ctx.fillRect(padL, padT, xn - padL, plotH);
  ctx.strokeStyle = "#f85149";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(xn, padT);
  ctx.lineTo(xn, padT + plotH);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#f85149";
  ctx.font = "9px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("now", xn + 3, 1);

  // Legend: swatch + sat name (hover highlights, click selects).
  const lx = padL + plotW + 10;
  const rowH = Math.max(9, Math.min(13, (h - 4) / Math.max(1, sats.length)));
  const legend = sats.slice().sort((a, b) => (b.key === data.current) - (a.key === data.current));
  ctx.font = (rowH < 11 ? 9 : 10) + "px sans-serif";
  ctx.textBaseline = "middle";
  legend.forEach((s, i) => {
    const y = 2 + i * rowH + rowH / 2;
    if (y > h) return;
    const sel = s.key === data.current;
    const dim = hk && hk !== s.key;
    ctx.globalAlpha = dim ? 0.4 : 1;
    ctx.fillStyle = colorOf(s);
    ctx.fillRect(lx, y - (sel ? 1.5 : 1), 12, sel ? 3 : 2);
    ctx.fillStyle = hk === s.key ? "#e6edf3" : colorOf(s);
    ctx.fillText(s.display || s.key, lx + 16, y);
    favProfileHits.legend.push({ key: s.key, display: s.display, x: lx, y: y - rowH / 2, w: legW, h: rowH });
  });
  ctx.globalAlpha = 1;

  // Hover cursor + preview line.
  chartGeom = { mode: "fav", padL, padT, plotW, plotH, T: (x) => t0 + ((x - padL) / plotW) * (t1 - t0), X, tMin: t0, tMax: t1, nowX: xn };
  const sample = (t) => {
    const out = [];
    for (const s of sats) {
      for (const p of s.passes || []) {
        if (!p.pts || p.pts.length < 2 || t < p.pts[0][0] || t > p.pts[p.pts.length - 1][0]) continue;
        let i = 1;
        while (i < p.pts.length - 1 && p.pts[i][0] < t) i++;
        const a = p.pts[i - 1], b = p.pts[i];
        const fr = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
        const el = a[1] + (b[1] - a[1]) * fr;
        // az: 0-deg crossing points carry no az; borrow the neighbour's.
        const aaz = a[2] != null ? a[2] : b[2], baz = b[2] != null ? b[2] : a[2];
        let az = null;
        if (aaz != null) { let d = baz - aaz; d = ((d + 540) % 360) - 180; az = (aaz + d * fr + 360) % 360; }
        out.push({ key: s.key, display: s.display || s.key, el, az, y: Y(el), col: colorOf(s), sel: s.key === data.current });
        break;
      }
    }
    return out;
  };
  drawChartOverlays(ctx, chartGeom, sample);
}

/* ============ Hover time cursor + pass preview (amber) line ============
 * Hover: thin cursor line with the local time on top and, for each sat up at
 * that moment (nearest arc first, max 3), elevation + azimuth interpolated
 * from the chart's own samples. Preview: drag the red now line / amber line
 * or click blank chart (or the selected sat's arc) to set T; Esc, double-click
 * or the map badge's "Back to now" clears it (js/pass-preview.js). */
let chartGeom = null; // layout of the last drawn chart (either mode)
let chartHover = null; // {x, y} css px in canvas
let chartDragged = false; // a preview-line drag just ended (swallow its click)
const PREVIEW_COL = "#e3b341";
function fmtClock(t) {
  if (typeof formatClockShort === "function") return formatClockShort(t);
  return new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function pill(ctx, x, y, text, opt) {
  ctx.font = opt.font || "bold 10px sans-serif";
  const tw = ctx.measureText(text).width;
  const w = tw + 10 + (opt.swatch ? 10 : 0);
  const h = 15;
  let px = opt.align === "left" ? x : opt.align === "right" ? x - w : x - w / 2;
  px = Math.max(opt.minX != null ? opt.minX : 0, Math.min((opt.maxX != null ? opt.maxX : 1e9) - w, px));
  ctx.fillStyle = opt.bg || "rgba(13,17,23,0.92)";
  ctx.strokeStyle = opt.border || "#484f58";
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(px + 0.5, y + 0.5, w, h, 3); else ctx.rect(px + 0.5, y + 0.5, w, h);
  ctx.fill();
  ctx.stroke();
  if (opt.swatch) {
    ctx.fillStyle = opt.swatch;
    ctx.beginPath();
    ctx.arc(px + 8, y + h / 2 + 0.5, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = opt.color || "#e6edf3";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, px + 5 + (opt.swatch ? 10 : 0), y + h / 2 + 1);
  return { x: px, w, h };
}
function ringDot(ctx, x, y, col, r) {
  ctx.beginPath();
  ctx.fillStyle = col;
  ctx.strokeStyle = "#0d1117";
  ctx.lineWidth = 2;
  ctx.arc(x, y, r || 4, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fill();
}
function drawChartOverlays(ctx, g, sample) {
  const x0 = g.padL, x1 = g.padL + g.plotW;
  const top = g.padT, bot = g.padT + g.plotH;
  const pT = typeof window.passPreview === "object" ? window.passPreview.get() : null;
  // Preview line (amber, solid) — the red now line stays where it is.
  if (pT != null && pT >= g.tMin && pT <= g.tMax) {
    const xp = g.X(pT);
    ctx.save();
    ctx.strokeStyle = PREVIEW_COL;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xp, top);
    ctx.lineTo(xp, bot);
    ctx.stroke();
    // drag grip
    ctx.fillStyle = PREVIEW_COL;
    ctx.beginPath();
    ctx.moveTo(xp - 5, bot); ctx.lineTo(xp + 5, bot); ctx.lineTo(xp, bot - 6); ctx.closePath();
    ctx.fill();
    sample(pT).forEach((s) => ringDot(ctx, xp, s.y, s.sel ? PREVIEW_COL : s.col, s.sel ? 4.5 : 3));
    if (!chartHover || Math.abs(chartHover.x - xp) > 60)
      pill(ctx, xp, 0, "Preview " + fmtClock(pT), { color: "#0d1117", bg: PREVIEW_COL, border: PREVIEW_COL, minX: x0, maxX: x1 });
    ctx.restore();
  }
  // Hover cursor.
  if (chartHover && chartHover.x >= x0 && chartHover.x <= x1) {
    const x = chartHover.x;
    const t = g.T(x);
    ctx.save();
    ctx.strokeStyle = "rgba(230,237,243,0.6)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, top);
    ctx.lineTo(Math.round(x) + 0.5, bot);
    ctx.stroke();
    pill(ctx, x, 0, fmtClock(t), { minX: x0, maxX: x1 });
    let up = sample(t);
    // nearest arc to the mouse first (or the arc the legend/arc hover picked)
    up.sort((a, b) => (b.key === favProfileHover) - (a.key === favProfileHover) || Math.abs(a.y - chartHover.y) - Math.abs(b.y - chartHover.y));
    up = up.slice(0, 3);
    up.forEach((s, i) => ringDot(ctx, x, s.y, s.col, i === 0 ? 4.5 : 3.2));
    const right = x + 150 < x1;
    up.forEach((s, i) => {
      const txt = s.display + "  " + Math.round(s.el) + "\u00B0" + (s.az != null ? " \u00B7 az " + Math.round(s.az) + "\u00B0" : "");
      pill(ctx, right ? x + 7 : x - 7, top + 8 + i * 17, txt, {
        align: right ? "left" : "right", swatch: s.col, minX: x0, maxX: x1,
        font: (i === 0 ? "bold " : "") + "10px sans-serif", color: i === 0 ? "#e6edf3" : "#c9d1d9",
      });
    });
    ctx.restore();
  }
}
/**
 * Preview time for a click / drag at (x, y) on a pass arc ({pts: [[x, y]...],
 * ts: [t...], aos, los}). Wide arcs: the time under x. Narrow spikes (a
 * 10 min pass is a few px on the 24 h chart): the time of the nearest point
 * on the curve, so the click's height picks it (near the base → near AOS /
 * LOS, the rising side before the peak, the falling side after). Clamped to
 * the pass's AOS..LOS.
 */
const ARC_X_MAP_MIN_PX = 40;
function passTimeAtPoint(arc, x, y) {
  if (!arc || !arc.pts || !arc.ts || !arc.pts.length) return null;
  const P = arc.pts, ts = arc.ts, n = P.length;
  const lo = Number.isFinite(arc.aos) ? arc.aos : ts[0];
  const hi = Number.isFinite(arc.los) ? arc.los : ts[n - 1];
  const clamp = (t) => Math.max(lo, Math.min(hi, t));
  if (n === 1) return clamp(ts[0]);
  const x0 = P[0][0], x1 = P[n - 1][0];
  if (x1 - x0 >= ARC_X_MAP_MIN_PX) {
    if (x <= x0) return clamp(ts[0]);
    if (x >= x1) return clamp(ts[n - 1]);
    for (let i = 1; i < n; i++) {
      if (x > P[i][0]) continue;
      const dx = P[i][0] - P[i - 1][0];
      const u = dx > 0 ? (x - P[i - 1][0]) / dx : 0;
      return clamp(ts[i - 1] + u * (ts[i] - ts[i - 1]));
    }
    return clamp(ts[n - 1]);
  }
  let best = null, bd = Infinity;
  for (let i = 1; i < n; i++) {
    const a = P[i - 1], b = P[i];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = dx * dx + dy * dy;
    const u = L ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L)) : 0;
    const qx = a[0] + u * dx - x, qy = a[1] + u * dy - y;
    const d = qx * qx + qy * qy;
    if (d < bd) { bd = d; best = ts[i - 1] + u * (ts[i] - ts[i - 1]); }
  }
  return clamp(best);
}
/** Preview T for a hit on the selected sat's pass (arc point / peak label), else null. */
function previewTimeForHit(h, x, y) {
  if (!h || h.legend || !favProfileData || h.key !== favProfileData.current) return null;
  if (h.arc) return passTimeAtPoint(h.arc, x, y);
  if (Number.isFinite(h.t)) return h.t; // peak label → TCA
  return null;
}
function previewClampT(t) {
  if (!chartGeom) return null;
  const lo = Math.max(chartGeom.tMin, chartGeom.mode === "fav" ? Date.now() : chartGeom.tMin);
  return Math.max(lo, Math.min(chartGeom.tMax, t));
}
function initChartPreviewEvents() {
  const cv = profileCanvas;
  if (!cv || cv.__previewEvents) return;
  cv.__previewEvents = true;
  let drag = false;
  let dragArc = null; // pointerdown on the selected sat's pass: scrub along it
  const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const nearLine = (x) => {
    if (!chartGeom) return false;
    const pT = window.passPreview && window.passPreview.get();
    if (pT != null && Math.abs(chartGeom.X(pT) - x) < 6) return true;
    return chartGeom.nowX != null && Math.abs(chartGeom.nowX - x) < 6;
  };
  cv.addEventListener("pointermove", (e) => {
    const p = pos(e);
    chartHover = p;
    if (drag && chartGeom) {
      chartDragged = true;
      const t = dragArc ? passTimeAtPoint(dragArc, p.x, p.y) : chartGeom.T(p.x);
      if (t != null) window.passPreview.set(previewClampT(t), { drag: true });
      return;
    }
    if (nearLine(p.x)) cv.style.cursor = "ew-resize";
    else if (cv.style.cursor === "ew-resize") cv.style.cursor = "";
    redrawCurrent();
  });
  cv.addEventListener("pointerleave", () => { chartHover = null; if (!drag) redrawCurrent(); });
  cv.addEventListener("pointerdown", (e) => {
    const p = pos(e);
    dragArc = null;
    const h = chartGeom && chartGeom.mode === "fav" && favHitAt ? favHitAt(e) : null;
    if (h && h.arc && previewTimeForHit(h, p.x, p.y) != null) dragArc = h.arc; // scrub the pass
    else if (!nearLine(p.x)) return;
    drag = true; chartDragged = false;
    try { cv.setPointerCapture(e.pointerId); } catch (_) {}
  });
  const end = () => {
    if (drag && chartDragged) window.passPreview.settle();
    drag = false;
    dragArc = null;
  };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
  cv.addEventListener("click", (e) => {
    if (chartDragged) { chartDragged = false; return; }
    if (!chartGeom) return;
    const p = pos(e);
    if (p.x < chartGeom.padL || p.x > chartGeom.padL + chartGeom.plotW) return;
    // Fav mode: legend rows and other sats' arcs keep their own click (select + snap).
    if (chartGeom.mode === "fav" && favHitAt) {
      const h = favHitAt(e);
      if (h && (h.legend || !favProfileData || h.key !== favProfileData.current)) return;
      // The selected sat's pass: the clicked point along the curve (not just its peak).
      const t = previewTimeForHit(h, p.x, p.y);
      if (t != null) { window.passPreview.set(previewClampT(t)); return; }
    }
    window.passPreview.set(previewClampT(chartGeom.T(p.x)));
  });
  cv.addEventListener("dblclick", () => window.passPreview.clear());
  document.addEventListener("pass-preview-change", () => redrawCurrent());
  window.addEventListener("time-mode-change", () => redrawCurrent());
}
