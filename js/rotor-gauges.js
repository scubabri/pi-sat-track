const RG_SIZE = 220;
const RG_CENTER = RG_SIZE / 2;
const RG_RADIUS = RG_SIZE / 2 - 8;

let azCanvas, azCtx, elCanvas, elCtx;
let lastRotorAz = null;
let lastRotorEl = null;

function initRotorGauges() {
  azCanvas = document.getElementById("rotor-az-canvas");
  elCanvas = document.getElementById("rotor-el-canvas");
  if (azCanvas) {
    azCanvas.width = RG_SIZE;
    azCanvas.height = RG_SIZE;
    azCtx = azCanvas.getContext("2d");
  }
  if (elCanvas) {
    elCanvas.width = RG_SIZE;
    elCanvas.height = RG_SIZE;
    elCtx = elCanvas.getContext("2d");
  }
  drawAzGauge(null);
  drawElGauge(null);
}

function drawCircularFace(ctx) {
  const cx = RG_CENTER;
  const cy = RG_CENTER;
  const r = RG_RADIUS;

  ctx.clearRect(0, 0, RG_SIZE, RG_SIZE);

  // Same translucent disk as sat radar
  ctx.beginPath();
  ctx.arc(cx, cy, r + 6, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(13, 17, 23, 0.75)";
  ctx.fill();

  // Outer ring
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(139, 148, 158, 0.45)";
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** AZ — same layout as sat radar: N up, radial ticks, needle + center degrees */
function drawAzGauge(az) {
  if (!azCtx) return;
  const ctx = azCtx;
  const cx = RG_CENTER;
  const cy = RG_CENTER;
  const r = RG_RADIUS;

  drawCircularFace(ctx);

  // Elevation-style rings (decorative, match sat radar rings)
  ctx.strokeStyle = "rgba(139, 148, 158, 0.45)";
  ctx.lineWidth = 1;
  [0.33, 0.66, 1].forEach((f) => {
    ctx.beginPath();
    ctx.arc(cx, cy, r * f, 0, Math.PI * 2);
    ctx.stroke();
  });

  // Azimuth spokes every 30°
  ctx.strokeStyle = "rgba(139, 148, 158, 0.35)";
  for (let a = 0; a < 360; a += 30) {
    const rad = ((a - 90) * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + r * Math.cos(rad), cy + r * Math.sin(rad));
    ctx.stroke();
  }

  // Cardinals — same placement as sat radar
  ctx.fillStyle = "rgba(230, 237, 243, 0.85)";
  ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lo = r + 2;
  ctx.fillText("N", cx, cy - lo + 10);
  ctx.fillText("E", cx + lo - 8, cy);
  ctx.fillText("S", cx, cy + lo - 8);
  ctx.fillText("W", cx - lo + 8, cy);

  // Needle (position line)
  if (az != null && Number.isFinite(az)) {
    const rad = ((az - 90) * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + (r - 4) * Math.cos(rad), cy + (r - 4) * Math.sin(rad));
    ctx.strokeStyle = "#3fb950";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.stroke();

    // Tip dot
    ctx.beginPath();
    ctx.arc(
      cx + (r - 4) * Math.cos(rad),
      cy + (r - 4) * Math.sin(rad),
      4,
      0,
      Math.PI * 2,
    );
    ctx.fillStyle = "#3fb950";
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Center hub + degrees
  ctx.beginPath();
  ctx.arc(cx, cy, 22, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(13, 17, 23, 0.9)";
  ctx.fill();

  ctx.fillStyle = az != null && Number.isFinite(az) ? "#e6edf3" : "#8b949e";
  ctx.font =
    "bold 16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(
    az != null && Number.isFinite(az) ? Math.round(az) + "°" : "—",
    cx,
    cy,
  );
}

/**
 * Fold rotor EL (0–180) to angle-from-horizon (0–90–0).
 * Needle + center readout use this; the 0–180 grid stays as-is.
 */
function toHorizonEl(el) {
  if (el == null || !Number.isFinite(el)) return null;
  const e = Math.max(0, Math.min(180, Number(el)));
  return e <= 90 ? e : 180 - e;
}

/**
 * EL — upper semicircle for 0–180° rotor travel.
 * Grid: 0° = right, 90° = top, 180° = left.
 * Needle/center: horizon angle only (0→90→0), not raw rotor EL past 90.
 */
function drawElGauge(el) {
  if (!elCtx) return;
  const ctx = elCtx;
  const cx = RG_CENTER;
  // Shift center slightly down so the semicircle fills the canvas better
  const cy = RG_CENTER + 18;
  const r = RG_RADIUS - 4;

  ctx.clearRect(0, 0, RG_SIZE, RG_SIZE);

  // Background: filled upper semicircle + a little padding
  ctx.beginPath();
  ctx.arc(cx, cy, r + 6, Math.PI, 0, false); // left → right via top (CCW from π to 0)
  ctx.lineTo(cx + r + 6, cy);
  ctx.lineTo(cx - r - 6, cy);
  ctx.closePath();
  ctx.fillStyle = "rgba(13, 17, 23, 0.75)";
  ctx.fill();

  // Outer arc (0° right → 180° left via top)
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, 0, false);
  ctx.strokeStyle = "rgba(139, 148, 158, 0.55)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Diameter line (horizon / 0–180 baseline)
  ctx.beginPath();
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx + r, cy);
  ctx.strokeStyle = "rgba(139, 148, 158, 0.4)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Concentric arcs at 30° intervals of radius (visual depth only)
  ctx.strokeStyle = "rgba(139, 148, 158, 0.3)";
  ctx.lineWidth = 1;
  [0.33, 0.66].forEach((f) => {
    ctx.beginPath();
    ctx.arc(cx, cy, r * f, Math.PI, 0, false);
    ctx.stroke();
  });

  // Tick marks every 30° of elevation
  ctx.strokeStyle = "rgba(139, 148, 158, 0.5)";
  ctx.lineWidth = 1;
  for (let elev = 0; elev <= 180; elev += 30) {
    // elev 0 → east (right), elev 90 → north (up), elev 180 → west (left)
    const compassAz = 90 - elev;
    const rad = ((compassAz - 90) * Math.PI) / 180;
    const x1 = cx + (r - 8) * Math.cos(rad);
    const y1 = cy + (r - 8) * Math.sin(rad);
    const x2 = cx + r * Math.cos(rad);
    const y2 = cy + r * Math.sin(rad);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  // Labels — inset so "180°" is not clipped at the left edge
  // (previous position at r-10° was clipping to "80°")
  ctx.fillStyle = "rgba(230, 237, 243, 0.85)";
  ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // 0° right — just inside the rim, above the diameter
  ctx.fillText("0°", cx + r - 12, cy - 12);
  // 90° top
  ctx.fillText("90°", cx, cy - r - 8);
  // 180° left — same inset so the full "180°" stays on-canvas
  ctx.fillText("180°", cx - r + 16, cy - 12);

  // Intermediate labels (30 / 60 / 120 / 150) a bit inward
  ctx.fillStyle = "rgba(139, 148, 158, 0.75)";
  ctx.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  const labelR = r - 14;
  [
    [30, "30°"],
    [60, "60°"],
    [120, "120°"],
    [150, "150°"],
  ].forEach(([elev, txt]) => {
    const compassAz = 90 - elev;
    const rad = ((compassAz - 90) * Math.PI) / 180;
    const lx = cx + labelR * Math.cos(rad);
    const ly = cy + labelR * Math.sin(rad);
    ctx.fillText(txt, lx, ly);
  });

  // Needle + center: angle-from-horizon (0→90→0). Grid stays 0–180.
  // When rotor is past zenith (el>90), horizon angle is 180-el.
  const horizon = toHorizonEl(el);
  if (horizon != null) {
    const clamped = Math.max(0, Math.min(90, horizon));
    const compassAz = 90 - clamped;
    const rad = ((compassAz - 90) * Math.PI) / 180;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + (r - 4) * Math.cos(rad), cy + (r - 4) * Math.sin(rad));
    ctx.strokeStyle = "#3fb950";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.stroke();

    // Tip dot
    ctx.beginPath();
    ctx.arc(
      cx + (r - 4) * Math.cos(rad),
      cy + (r - 4) * Math.sin(rad),
      4,
      0,
      Math.PI * 2,
    );
    ctx.fillStyle = "#3fb950";
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Center hub + horizon degrees
  ctx.beginPath();
  ctx.arc(cx, cy, 22, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(13, 17, 23, 0.9)";
  ctx.fill();

  ctx.fillStyle = horizon != null ? "#e6edf3" : "#8b949e";
  ctx.font =
    "bold 16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(
    horizon != null ? Math.round(horizon) + "°" : "—",
    cx,
    cy,
  );
}

function updateRotorGauges(az, el) {
  if (az != null && Number.isFinite(az)) lastRotorAz = az;
  if (el != null && Number.isFinite(el)) lastRotorEl = el;
  drawAzGauge(lastRotorAz);
  drawElGauge(lastRotorEl);
}
