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

/** Small filled arrow ~same footprint as the old r=5 blue dot */
function drawSatArrow(ctx, x, y, angleRad) {
  const len = 10; // tip-to-tail ≈ diameter of old 5px-radius dot
  const halfW = 4.5;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angleRad);

  ctx.beginPath();
  // Tip forward, base back — classic chevron/arrowhead
  ctx.moveTo(len * 0.55, 0); // tip
  ctx.lineTo(-len * 0.45, halfW);
  ctx.lineTo(-len * 0.2, 0);
  ctx.lineTo(-len * 0.45, -halfW);
  ctx.closePath();

  ctx.fillStyle = "#58a6ff";
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.25;
  ctx.lineJoin = "round";
  ctx.stroke();

  ctx.restore();
}

/** Heading (screen radians) from sky path near current position */
function headingFromSkyPath(az, el, skyPath) {
  if (!skyPath || skyPath.length < 2) return null;

  // Find nearest path index
  let bestI = 0;
  let bestD = Infinity;
  for (let i = 0; i < skyPath.length; i++) {
    const p = skyPath[i];
    const daz = ((p.az - az + 540) % 360) - 180;
    const del = p.el - el;
    const d = daz * daz + del * del;
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  }

  // Prefer forward segment; fall back to previous if at end
  let a, b;
  if (bestI < skyPath.length - 1) {
    a = skyPath[bestI];
    b = skyPath[bestI + 1];
  } else {
    a = skyPath[bestI - 1];
    b = skyPath[bestI];
  }

  const pa = azElToXY(a.az, a.el);
  const pb = azElToXY(b.az, b.el);
  const dx = pb.x - pa.x;
  const dy = pb.y - pa.y;
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return null;
  return Math.atan2(dy, dx);
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

  // Live sat when above horizon — arrow pointing along track
  if (typeof el === "number" && el >= 0) {
    const { x, y } = azElToXY(az, el);
    const heading = headingFromSkyPath(az, el, skyPath);

    if (heading != null) {
      drawSatArrow(ctx, x, y, heading);
    } else {
      // Fallback: same-size filled circle if no path heading available
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#58a6ff";
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

function updateRadarSat(az, el) {
  updateRadar(az, el, null);
}
