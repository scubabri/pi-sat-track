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
