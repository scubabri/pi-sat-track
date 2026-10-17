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

function redrawCurrent(look) {
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
let favProfileHits = { legend: [], arcs: [] };

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
    let best = null;
    let bd = 64; // 8 px radius
    for (const a of favProfileHits.arcs) {
      if (x < a.x0 - 8 || x > a.x1 + 8) continue;
      for (const p of a.pts) {
        const d = (p[0] - x) * (p[0] - x) + (p[1] - y) * (p[1] - y);
        if (d < bd) { bd = d; best = a; }
      }
    }
    return best ? { key: best.key, display: best.display } : null;
  };
  cv.addEventListener("mousemove", (e) => {
    if (!favProfileMode()) return;
    const h = hitAt(e);
    const k = h ? h.key : null;
    cv.style.cursor = h && !h.legend && favProfileData && k !== favProfileData.current ? "pointer" : "";
    if (k !== favProfileHover) { favProfileHover = k; drawFavProfile(); }
  });
  cv.addEventListener("mouseleave", () => {
    cv.style.cursor = "";
    if (favProfileHover) { favProfileHover = null; if (favProfileMode()) drawFavProfile(); }
  });
  cv.addEventListener("click", (e) => {
    if (!favProfileMode()) return;
    const h = hitAt(e);
    if (!h) { if (favProfileHover) { favProfileHover = null; drawFavProfile(); } return; }
    if (h.legend) { favProfileHover = favProfileHover === h.key ? null : h.key; drawFavProfile(); return; } // touch: tap toggles
    if (favProfileData && h.key !== favProfileData.current && typeof selectSatellite === "function")
      selectSatellite(h.key, h.display);
  });
}

function drawFavProfile() {
  if (!profileCtx || !profileCanvas) return;
  if (!ensureProfileSize()) return;
  const ctx = profileCtx;
  const w = profileCanvas.clientWidth;
  const h = profileCanvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  favProfileHits = { legend: [], arcs: [] };
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
  const t0 = now;
  const t1 = now + 24 * 3600000;
  const sats = data.sats.slice().sort((a, b) => (a.key === data.current) - (b.key === data.current));
  const cur = sats.find((s) => s.key === data.current) || null;
  const colorOf = (s) => (s.key === data.current ? SAT_SELECTED_COLOR : favColor(s.key));

  // Legend width: longest name.
  ctx.font = "10px sans-serif";
  let legW = 0;
  sats.forEach((s) => { legW = Math.max(legW, ctx.measureText((s.display || s.key) + "  99").width); });
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
    const hr = new Date(t).getHours();
    if (hr % labelEveryH === 0) {
      ctx.fillStyle = "#8b949e";
      ctx.fillText(new Date(t).toLocaleTimeString([], { hour: "numeric" }).replace(/\s/g, ""), x, padT + plotH + 4);
    }
  }

  // Watermark: selected sat.
  if (cur) {
    ctx.fillStyle = "rgba(88, 166, 255, 0.12)";
    ctx.font = "bold 28px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(cur.display || cur.key, padL + plotW / 2, padT + plotH / 2);
  }

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
      favProfileHits.arcs.push({ key: s.key, display: s.display, pts: xy, x0: xy[0][0], x1: xy[xy.length - 1][0] });
      if (p.maxEl >= 20 && !dim) {
        let pk = p.pts[0];
        p.pts.forEach((q) => { if (q[1] > pk[1]) pk = q; });
        if (pk[0] >= t0)
          labels.push({ x: X(pk[0]), y: Y(pk[1]), text: (s.display || s.key) + " " + Math.round(p.maxEl) + "\u00B0", col, pri: sel || hi ? 0 : 1, maxEl: p.maxEl });
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
    ctx.fillStyle = "rgba(13,17,23,0.7)";
    ctx.fillRect(lx - lw / 2, y - 10, lw, 10);
    ctx.fillStyle = l.col;
    ctx.fillText(l.text, lx, y);
  }

  // "Now" marker at the left edge.
  const xn = X(now) + 1;
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

  // Legend with pass counts (hover highlights).
  const lx = padL + plotW + 10;
  const rowH = Math.max(9, Math.min(13, (h - 4) / Math.max(1, sats.length)));
  const legend = sats.slice().sort((a, b) => (b.key === data.current) - (a.key === data.current));
  ctx.font = (rowH < 11 ? 9 : 10) + "px sans-serif";
  ctx.textBaseline = "middle";
  legend.forEach((s, i) => {
    const y = 2 + i * rowH + rowH / 2;
    if (y > h) return;
    const sel = s.key === data.current;
    const n = (s.passes || []).filter((p) => p.los >= t0).length;
    const dim = hk && hk !== s.key;
    ctx.globalAlpha = dim ? 0.4 : 1;
    ctx.fillStyle = colorOf(s);
    ctx.fillRect(lx, y - (sel ? 1.5 : 1), 12, sel ? 3 : 2);
    ctx.fillStyle = hk === s.key ? "#e6edf3" : colorOf(s);
    ctx.fillText((s.display || s.key) + "  " + n, lx + 16, y);
    favProfileHits.legend.push({ key: s.key, display: s.display, x: lx, y: y - rowH / 2, w: legW, h: rowH });
  });
  ctx.globalAlpha = 1;
}
