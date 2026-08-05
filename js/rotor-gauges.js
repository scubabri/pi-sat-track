const RG_SIZE = 220;
const RG_CENTER = RG_SIZE / 2;
const RG_RADIUS = RG_SIZE / 2 - 8;

/** Needle colors: normal = green, flipped/over-top = amber */
const RG_COLOR_NORMAL = "#3fb950";
const RG_COLOR_FLIPPED = "#e3b341";

let azCanvas, azCtx, elCanvas, elCtx;
let lastRotorAz = null;
let lastRotorEl = null;
let lastSatAz = null;
let lastSatEl = null;
let lastFlipped = false;

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
  drawAzGauge(null, null, false);
  drawElGauge(null, null, false);
}

function needleColor(flipped) {
  return flipped ? RG_COLOR_FLIPPED : RG_COLOR_NORMAL;
}

function drawCircularFace(ctx) {
  const cx = RG_CENTER;
  const cy = RG_CENTER;
  const r = RG_RADIUS;

  ctx.clearRect(0, 0, RG_SIZE, RG_SIZE);

  ctx.beginPath();
  ctx.arc(cx, cy, r + 6, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(13, 17, 23, 0.75)";
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(139, 148, 158, 0.45)";
  ctx.lineWidth = 1;
  ctx.stroke();
}

/**
 * AZ gauge:
 *   - Needle: true rotor AZ on the compass grid (hardware, may be flipped)
 *   - Center number: sky pointing AZ (sat AZ, or rotorAz+180 when flipped)
 *   - Amber needle when flipped / over-top
 */
function drawAzGauge(rotorAz, satAz, flipped) {
  if (!azCtx) return;
  const ctx = azCtx;
  const cx = RG_CENTER;
  const cy = RG_CENTER;
  const r = RG_RADIUS;
  const color = needleColor(flipped);

  drawCircularFace(ctx);

  ctx.strokeStyle = "rgba(139, 148, 158, 0.45)";
  ctx.lineWidth = 1;
  [0.33, 0.66, 1].forEach((f) => {
    ctx.beginPath();
    ctx.arc(cx, cy, r * f, 0, Math.PI * 2);
    ctx.stroke();
  });

  ctx.strokeStyle = "rgba(139, 148, 158, 0.35)";
  for (let a = 0; a < 360; a += 30) {
    const rad = ((a - 90) * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + r * Math.cos(rad), cy + r * Math.sin(rad));
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(230, 237, 243, 0.85)";
  ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lo = r + 2;
  ctx.fillText("N", cx, cy - lo + 10);
  ctx.fillText("E", cx + lo - 8, cy);
  ctx.fillText("S", cx, cy + lo - 8);
  ctx.fillText("W", cx - lo + 8, cy);

  // Needle = true rotor position
  if (rotorAz != null && Number.isFinite(rotorAz)) {
    const rad = ((rotorAz - 90) * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + (r - 4) * Math.cos(rad), cy + (r - 4) * Math.sin(rad));
    ctx.strokeStyle = color;
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
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Center hub
  ctx.beginPath();
  ctx.arc(cx, cy, 22, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(13, 17, 23, 0.9)";
  ctx.fill();
  if (flipped) {
    ctx.beginPath();
    ctx.arc(cx, cy, 22, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Center number = sky pointing AZ; needle = rotor hardware.
  // When flipped and no sat AZ, sky = rotorAz + 180.
  let displayAz = null;
  if (satAz != null && Number.isFinite(satAz)) {
    displayAz = satAz;
  } else if (rotorAz != null && Number.isFinite(rotorAz)) {
    displayAz = flipped
      ? ((Number(rotorAz) + 180) % 360 + 360) % 360
      : rotorAz;
  }
  ctx.fillStyle = displayAz != null ? "#e6edf3" : "#8b949e";
  ctx.font =
    "bold 16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(
    displayAz != null ? Math.round(displayAz) + "°" : "—",
    cx,
    cy,
  );
}

/**
 * EL gauge:
 *   - Grid + needle: true rotor EL 0→180 (hardware, may be over-top)
 *   - Center number: sky/horizon elevation 0–90 only
 *   - Amber when flipped / over-top
 */
function drawElGauge(rotorEl, satEl, flipped) {
  if (!elCtx) return;
  const ctx = elCtx;
  const cx = RG_CENTER;
  const cy = RG_CENTER + 18;
  const r = RG_RADIUS - 4;
  const color = needleColor(flipped);

  ctx.clearRect(0, 0, RG_SIZE, RG_SIZE);

  ctx.beginPath();
  ctx.arc(cx, cy, r + 6, Math.PI, 0, false);
  ctx.lineTo(cx + r + 6, cy);
  ctx.lineTo(cx - r + 6, cy);
  ctx.closePath();
  ctx.fillStyle = "rgba(13, 17, 23, 0.75)";
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, 0, false);
  ctx.strokeStyle = "rgba(139, 148, 158, 0.55)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx + r, cy);
  ctx.strokeStyle = "rgba(139, 148, 158, 0.4)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.strokeStyle = "rgba(139, 148, 158, 0.3)";
  ctx.lineWidth = 1;
  [0.33, 0.66].forEach((f) => {
    ctx.beginPath();
    ctx.arc(cx, cy, r * f, Math.PI, 0, false);
    ctx.stroke();
  });

  ctx.strokeStyle = "rgba(139, 148, 158, 0.5)";
  ctx.lineWidth = 1;
  for (let elev = 0; elev <= 180; elev += 30) {
    const compassAz = 90 - elev;
    const rad = ((compassAz - 90) * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(cx + (r - 8) * Math.cos(rad), cy + (r - 8) * Math.sin(rad));
    ctx.lineTo(cx + r * Math.cos(rad), cy + r * Math.sin(rad));
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(230, 237, 243, 0.85)";
  ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("0°", cx + r - 12, cy - 12);
  ctx.fillText("90°", cx, cy - r - 8);
  ctx.fillText("180°", cx - r + 16, cy - 12);

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
    ctx.fillText(
      txt,
      cx + labelR * Math.cos(rad),
      cy + labelR * Math.sin(rad),
    );
  });

  // Needle = true rotor EL (0–180 hardware position)
  const trueEl =
    rotorEl != null && Number.isFinite(rotorEl)
      ? Math.max(0, Math.min(180, Number(rotorEl)))
      : null;
  if (trueEl != null) {
    const compassAz = 90 - trueEl;
    const rad = ((compassAz - 90) * Math.PI) / 180;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + (r - 4) * Math.cos(rad), cy + (r - 4) * Math.sin(rad));
    ctx.strokeStyle = color;
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
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(cx, cy, 22, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(13, 17, 23, 0.9)";
  ctx.fill();
  if (flipped) {
    ctx.beginPath();
    ctx.arc(cx, cy, 22, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Center number = sky/horizon elevation 0–90 only.
  // Needle stays on true rotor EL 0–180. When flipped over-top
  // (rotor EL > 90), center shows 180 - rotorEl so 180→0, 150→30, etc.
  let displayEl = null;
  if (satEl != null && Number.isFinite(satEl) && satEl >= 0) {
    displayEl = Math.min(90, satEl);
  } else if (trueEl != null) {
    displayEl = trueEl > 90 ? 180 - trueEl : trueEl;
  }
  ctx.fillStyle = displayEl != null ? "#e6edf3" : "#8b949e";
  ctx.font =
    "bold 16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(
    displayEl != null ? Math.round(displayEl) + "°" : "—",
    cx,
    cy,
  );
}

/**
 * @param {number|null} rotorAz - true rotor azimuth (needle)
 * @param {number|null} rotorEl - true rotor elevation 0–180 (needle)
 * @param {number|null} [satAz] - satellite azimuth for AZ center readout
 * @param {number|null} [satEl] - satellite elevation for EL center readout
 * @param {boolean} [flipped] - over-top mode → amber indicators
 */
function updateRotorGauges(rotorAz, rotorEl, satAz, satEl, flipped) {
  // Back-compat: old call sites passed (az, el, satAz, flipped)
  if (typeof satEl === "boolean" && typeof flipped === "undefined") {
    flipped = satEl;
    satEl = null;
  }
  if (rotorAz != null && Number.isFinite(rotorAz)) lastRotorAz = rotorAz;
  if (rotorEl != null && Number.isFinite(rotorEl)) lastRotorEl = rotorEl;

  // null satAz/satEl = clear sticky (park / antenna off).
  // Explicit clear so sticky lastSat* does not keep a stale or negative value.
  if (satAz === null) {
    lastSatAz = null;
  } else if (satAz != null && Number.isFinite(satAz)) {
    lastSatAz = satAz;
  }
  if (satEl === null || (satEl != null && Number.isFinite(satEl) && satEl < 0)) {
    lastSatEl = null;
  } else if (satEl != null && Number.isFinite(satEl)) {
    lastSatEl = satEl;
  }

  if (typeof flipped === "boolean") lastFlipped = flipped;
  drawAzGauge(lastRotorAz, lastSatAz, lastFlipped);
  drawElGauge(lastRotorEl, lastSatEl, lastFlipped);
}
