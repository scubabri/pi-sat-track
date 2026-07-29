let radarCanvas, radarCtx;
const RADAR_SIZE = 220;
const RADAR_CENTER = RADAR_SIZE / 2;
const RADAR_RADIUS = RADAR_SIZE / 2 - 8;

function initRadar() {
  radarCanvas = document.getElementById("radar-canvas");
  if (!radarCanvas) return;
  radarCtx = radarCanvas.getContext("2d");
  drawRadarBackground();
}

function drawRadarBackground() {
  const ctx = radarCtx;
  const cx = RADAR_CENTER;
  const cy = RADAR_CENTER;
  const r = RADAR_RADIUS;

  ctx.clearRect(0, 0, RADAR_SIZE, RADAR_SIZE);

  const elevRings = [0, 30, 60];
  ctx.strokeStyle = "rgba(139, 148, 158, 0.45)";
  ctx.lineWidth = 1;

  elevRings.forEach((elev) => {
    const ringR = r * (1 - elev / 90);
    ctx.beginPath();
    ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
    ctx.stroke();
  });

  ctx.strokeStyle = "rgba(139, 148, 158, 0.35)";
  for (let az = 0; az < 360; az += 30) {
    const rad = ((az - 90) * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + r * Math.cos(rad), cy + r * Math.sin(rad));
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(230, 237, 243, 0.85)";
  ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const labelOffset = r + 2;
  ctx.fillText("N", cx, cy - labelOffset + 10);
  ctx.fillText("E", cx + labelOffset - 8, cy);
  ctx.fillText("S", cx, cy + labelOffset - 8);
  ctx.fillText("W", cx - labelOffset + 8, cy);

  ctx.fillStyle = "rgba(139, 148, 158, 0.7)";
  ctx.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText("30°", cx + 4, cy - r * (1 - 30 / 90) + 3);
  ctx.fillText("60°", cx + 4, cy - r * (1 - 60 / 90) + 3);
}

function azElToXY(az, el) {
  const cx = RADAR_CENTER;
  const cy = RADAR_CENTER;
  const r = RADAR_RADIUS;
  const dist = r * (1 - Math.max(0, Math.min(90, el)) / 90);
  const rad = ((az - 90) * Math.PI) / 180;
  return {
    x: cx + dist * Math.cos(rad),
    y: cy + dist * Math.sin(rad),
  };
}

/**
 * skyPath: [{az, el}, ...] next pass
 * az, el: current look angles
 */
function updateRadar(az, el, skyPath) {
  if (!radarCtx) return;

  drawRadarBackground();
  const ctx = radarCtx;

  // Next pass path (dashed green)
  if (skyPath && skyPath.length >= 2) {
    ctx.beginPath();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = "rgba(63, 185, 80, 0.9)";
    ctx.lineWidth = 1.5;

    skyPath.forEach((p, i) => {
      const { x, y } = azElToXY(p.az, p.el);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);

    const ends = [skyPath[0], skyPath[skyPath.length - 1]];
    ends.forEach((p) => {
      const { x, y } = azElToXY(p.az, p.el);
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(63, 185, 80, 0.95)";
      ctx.fill();
    });
  }

  // Live sat when above horizon
  if (typeof el === "number" && el >= 0) {
    const { x, y } = azElToXY(az, el);
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#58a6ff";
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

function updateRadarSat(az, el) {
  updateRadar(az, el, null);
}
