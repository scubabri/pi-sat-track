/* Frequency formatting helpers */
function fmtFreq(hz) {
  if (hz == null || !Number.isFinite(hz)) return "-";
  hz = Math.round(hz);
  const mhz = Math.floor(hz / 1e6);
  const khz = Math.floor((hz % 1e6) / 1e3);
  const hzz = Math.abs(hz % 1000);
  return (
    mhz +
    "." +
    String(khz).padStart(3, "0") +
    "." +
    String(hzz).padStart(3, "0")
  );
}

function parseToHz(val) {
  if (val == null || val === "-" || val === "") return null;
  if (typeof val === "number" && Number.isFinite(val)) {
    return val > 1e4 ? val : val * 1e6;
  }
  const s = String(val).trim();
  const parts = s.split(".");
  if (parts.length === 3) {
    const mhz = parseInt(parts[0], 10);
    const khz = parseInt(parts[1], 10);
    const hz = parseInt(parts[2], 10);
    if (![mhz, khz, hz].every(Number.isFinite)) return null;
    return mhz * 1e6 + khz * 1e3 + hz;
  }
  const f = parseFloat(s);
  if (!Number.isFinite(f)) return null;
  return f * 1e6;
}

function fmtDopplerMHz(hzOffset) {
  if (hzOffset == null || !Number.isFinite(hzOffset)) return "";
  const mhz = hzOffset / 1e6;
  const sign = mhz >= 0 ? "+" : "";
  return sign + mhz.toFixed(6) + " MHz";
}

function fmtOffsetHz(hz) {
  if (hz == null || !Number.isFinite(hz) || hz === 0) return "0 Hz";
  const sign = hz > 0 ? "+" : "";
  return sign + Math.round(hz) + " Hz";
}
