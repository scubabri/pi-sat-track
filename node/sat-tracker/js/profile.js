let profileCanvas, profileCtx;

function initProfile() {
  profileCanvas = document.getElementById('profile-canvas');
  if (!profileCanvas) return;

  // Make canvas resolution match its display size
  const rect = profileCanvas.parentElement.getBoundingClientRect();
  profileCanvas.width  = rect.width;
  profileCanvas.height = rect.height;

  profileCtx = profileCanvas.getContext('2d');

  // Draw a placeholder pass so the panel isn’t empty
  drawPlaceholderProfile();

  // Redraw on resize
  window.addEventListener('resize', () => {
    const r = profileCanvas.parentElement.getBoundingClientRect();
    profileCanvas.width  = r.width;
    profileCanvas.height = r.height;
    drawPlaceholderProfile();
  });
}

/**
 * Placeholder elevation profile (looks like the classic pass plot)
 * Later this will be driven by real pass data.
 */
function drawPlaceholderProfile() {
  const ctx = profileCtx;
  const w = profileCanvas.width;
  const h = profileCanvas.height;

  ctx.clearRect(0, 0, w, h);

  // Padding
  const padL = 48;   // left (elevation labels)
  const padR = 16;
  const padT = 28;   // top (azimuth labels)
  const padB = 20;

  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  // Background
  ctx.fillStyle = '#161b22';
  ctx.fillRect(0, 0, w, h);

  // Grid lines (horizontal elevation)
  ctx.strokeStyle = 'rgba(48, 54, 61, 0.8)';
  ctx.lineWidth = 1;
  ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillStyle = 'rgba(139, 148, 158, 0.9)';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (let elev = 0; elev <= 80; elev += 20) {
    const y = padT + plotH * (1 - elev / 90);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.fillText(elev + '°', padL - 8, y);
  }

  // Sample placeholder points (azimuth, elevation)
  // These roughly match the style of the image you showed
  const points = [
    { az: 307, el: 5  },
    { az: 304, el: 12 },
    { az: 301, el: 18 },
    { az: 298, el: 24 },
    { az: 293, el: 30 },
    { az: 289, el: 35 },
    { az: 283, el: 40 },
    { az: 277, el: 44 },
    { az: 270, el: 47 },
    { az: 263, el: 49 },
    { az: 255, el: 50 },
    { az: 247, el: 49 },
    { az: 239, el: 47 },
    { az: 231, el: 44 },
    { az: 224, el: 40 },
    { az: 218, el: 35 },
    { az: 212, el: 30 },
    { az: 207, el: 24 },
    { az: 203, el: 18 },
    { az: 199, el: 12 },
    { az: 196, el: 5  }
  ];

  // Convert to canvas coordinates
  const toX = (i) => padL + (i / (points.length - 1)) * plotW;
  const toY = (el) => padT + plotH * (1 - el / 90);

  // Draw the curve
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(88, 166, 255, 0.85)';
  ctx.lineWidth = 2;
  points.forEach((p, i) => {
    const x = toX(i);
    const y = toY(p.el);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Draw dots + azimuth labels
  ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';

  points.forEach((p, i) => {
    const x = toX(i);
    const y = toY(p.el);

    // Dot
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#e6edf3';
    ctx.fill();
    ctx.strokeStyle = '#58a6ff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Azimuth label above the point
    ctx.fillStyle = 'rgba(230, 237, 243, 0.9)';
    ctx.fillText(p.az + '°', x, y - 8);
  });

  // Satellite name in the middle
  ctx.font = 'bold 28px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillStyle = 'rgba(88, 166, 255, 0.25)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('RS-44', padL + plotW / 2, padT + plotH / 2);

  // Max elevation marker (vertical dashed line at peak)
  const peakIdx = points.reduce((best, p, i) => p.el > points[best].el ? i : best, 0);
  const peakX = toX(peakIdx);
  ctx.beginPath();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = 'rgba(248, 81, 73, 0.7)';
  ctx.lineWidth = 1;
  ctx.moveTo(peakX, padT);
  ctx.lineTo(peakX, padT + plotH);
  ctx.stroke();
  ctx.setLineDash([]);
}