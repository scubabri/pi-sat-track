let ws = null;
let reconnectTimer = null;
let countdownTimer = null;

let timeMode = localStorage.getItem("satTrackerTimeMode") || "utc";
let satSortMode = localStorage.getItem("satTrackerSort") || "aos";
let lastPass = null;
let currentSatKey = localStorage.getItem("satTrackerSat") || null;
let currentSatLabel = null;
let lastSatList = null;
let lastStateSat = null;
let currentEl = null;
let pendingSatKey = null;
let lastModesKey = "";

let radioOn = false;
let tciConnected = false;
let antennaOn = false;
let fineStep = 100;
let ulFineOffset = 0;
let manualDlOffset = 0;

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
