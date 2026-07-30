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
    ctx.strokeStyle = "#58a6ff";
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
    ctx.fillStyle = "#58a6ff";
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
    az != null && Number.isFinite(az)
      ? Math.round(((az % 360) + 360) % 360) + "°"
      : "—",
    cx,
    cy,
  );
}

/**
 * EL — same circular face; 0° at right (E), 90° at top (N).
 * Scale is 0–90 only (quarter used for scale labels); needle still draws full line.
 */
function drawElGauge(el) {
  if (!elCtx) return;
  const ctx = elCtx;
  const cx = RG_CENTER;
  const cy = RG_CENTER;
  const r = RG_RADIUS;

  drawCircularFace(ctx);

  // Rings at 30 / 60 / 90 along the radius (like elev rings on sat radar)
  ctx.strokeStyle = "rgba(139, 148, 158, 0.45)";
  ctx.lineWidth = 1;
  [30, 60, 90].forEach((elev) => {
    const ringR = r * (elev / 90);
    ctx.beginPath();
    ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
    ctx.stroke();
  });

  // Spokes every 30° of compass for visual match
  ctx.strokeStyle = "rgba(139, 148, 158, 0.35)";
  for (let a = 0; a < 360; a += 30) {
    const rad = ((a - 90) * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + r * Math.cos(rad), cy + r * Math.sin(rad));
    ctx.stroke();
  }

  // Cardinals
  ctx.fillStyle = "rgba(230, 237, 243, 0.85)";
  ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lo = r + 2;
  ctx.fillText("N", cx, cy - lo + 10);
  ctx.fillText("E", cx + lo - 8, cy);
  ctx.fillText("S", cx, cy + lo - 8);
  ctx.fillText("W", cx - lo + 8, cy);

  // Elev scale labels on NE quadrant
  ctx.fillStyle = "rgba(139, 148, 158, 0.7)";
  ctx.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText("30°", cx + 4, cy - r * (30 / 90) + 3);
  ctx.fillText("60°", cx + 4, cy - r * (60 / 90) + 3);

  // Needle: map elev 0→90 onto compass bearing 90°(E) → 0°(N)
  // So elev angle on screen = 90 - elev (from north, clockwise would be wrong;
  // we use: 0 elev points East, 90 elev points North)
  if (el != null && Number.isFinite(el)) {
    const clamped = Math.max(-5, Math.min(90, el));
    // Screen angle: elev 0 → east (az 90), elev 90 → north (az 0)
    const compassAz = 90 - clamped;
    const rad = ((compassAz - 90) * Math.PI) / 180;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + (r - 4) * Math.cos(rad), cy + (r - 4) * Math.sin(rad));
    ctx.strokeStyle = "#3fb950";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.stroke();

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

  // Center degrees
  ctx.beginPath();
  ctx.arc(cx, cy, 22, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(13, 17, 23, 0.9)";
  ctx.fill();

  ctx.fillStyle = el != null && Number.isFinite(el) ? "#e6edf3" : "#8b949e";
  ctx.font =
    "bold 16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(
    el != null && Number.isFinite(el) ? Math.round(el) + "°" : "—",
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
