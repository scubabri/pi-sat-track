let radarCanvas, radarCtx;
const RADAR_SIZE = 220;
const RADAR_CENTER = RADAR_SIZE / 2;
const RADAR_RADIUS = RADAR_SIZE / 2 - 8;   // leave a little margin

function initRadar() {
  radarCanvas = document.getElementById('radar-canvas');
  if (!radarCanvas) return;

  radarCtx = radarCanvas.getContext('2d');
  drawRadarBackground();
}

/**
 * Draw the static polar grid (elevation rings + azimuth lines + labels)
 */
function drawRadarBackground() {
  const ctx = radarCtx;
  const cx = RADAR_CENTER;
  const cy = RADAR_CENTER;
  const r  = RADAR_RADIUS;

  ctx.clearRect(0, 0, RADAR_SIZE, RADAR_SIZE);

  // Elevation rings (0° outer → 90° center)
  // We draw rings at 0°, 30°, 60°
  const elevRings = [0, 30, 60];
  ctx.strokeStyle = 'rgba(139, 148, 158, 0.45)';
  ctx.lineWidth = 1;

  elevRings.forEach(elev => {
    // elev 0 = full radius, elev 90 = center
    const ringR = r * (1 - elev / 90);
    ctx.beginPath();
    ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
    ctx.stroke();
  });

  // Azimuth lines every 30°
  ctx.strokeStyle = 'rgba(139, 148, 158, 0.35)';
  for (let az = 0; az < 360; az += 30) {
    const rad = (az - 90) * Math.PI / 180;   // 0° = North (up)
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(
      cx + r * Math.cos(rad),
      cy + r * Math.sin(rad)
    );
    ctx.stroke();
  }

  // Cardinal labels
  ctx.fillStyle = 'rgba(230, 237, 243, 0.85)';
  ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const labelOffset = r + 2;
  // N
  ctx.fillText('N', cx, cy - labelOffset + 10);
  // E
  ctx.fillText('E', cx + labelOffset - 8, cy);
  // S
  ctx.fillText('S', cx, cy + labelOffset - 8);
  // W
  ctx.fillText('W', cx - labelOffset + 8, cy);

  // Small elevation labels
  ctx.fillStyle = 'rgba(139, 148, 158, 0.7)';
  ctx.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText('30°', cx + 4, cy - r * (1 - 30/90) + 3);
  ctx.fillText('60°', cx + 4, cy - r * (1 - 60/90) + 3);
}

/**
 * Plot current satellite az/el on the radar
 * az: 0–360, el: 0–90
 */
function updateRadarSat(az, el) {
  drawRadarBackground();

  if (el < 0) return;   // below horizon

  const ctx = radarCtx;
  const cx = RADAR_CENTER;
  const cy = RADAR_CENTER;
  const r  = RADAR_RADIUS;

  // elev 90 = center, elev 0 = outer ring
  const dist = r * (1 - el / 90);
  const rad  = (az - 90) * Math.PI / 180;   // 0° = North

  const x = cx + dist * Math.cos(rad);
  const y = cy + dist * Math.sin(rad);

  // Satellite marker
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#58a6ff';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}