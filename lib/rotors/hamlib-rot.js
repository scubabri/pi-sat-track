/**
 * Hamlib rotor driver: talks to the rotctld that lib/hamlib starts for
 * ROTOR_TYPE "hamlib" (127.0.0.1:4537, `rotctld -m <model> -r <dev> -s <baud>`).
 * Additive only: the native drivers (RT-21, GS-232) are untouched.
 *
 * rotctld protocol (one request at a time):
 *   p\n            -> "<az>\n<el>\n"
 *   P <az> <el>\n  -> "RPRT 0\n"
 *   S\n            -> "RPRT 0\n"   (stop)
 *
 * Tracking: in view (EL >= Min EL, or inside the pass) -> point at the sat;
 * within 5 min of the next AOS -> preposition to the AOS azimuth at EL 0;
 * otherwise hold. Park -> Park AZ / EL. A move is only sent when the target
 * moved more than the deadband.
 */
const net = require("net");
const config = require("../config");

const meta = {
  id: "hamlib",
  label: "Hamlib serial (rotctld)",
  ports: 1,
  defaultBaud: 9600,
  defaultDevice: "/dev/ttyUSB0",
  hint: "Hamlib rotor via rotctld (127.0.0.1:4537).",
  match(cfg) {
    return String((cfg && cfg.ROTOR_TYPE) || "").toLowerCase() === "hamlib";
  },
};

const PREP_MS = 5 * 60 * 1000;
const POLL_MS = 1000;
const DEADBAND = Number.isFinite(config.ROTOR_DEADBAND_DEG) ? config.ROTOR_DEADBAND_DEG : 2.5;

let deps = { connect: (port, host) => net.createConnection({ port, host }), setTimeout, clearTimeout, setInterval, clearInterval, endpoint: null };
let broadcastFn = () => {};
let antennaOn = false;
let connected = false;
let sock = null;
let buf = "";
let queue = []; // [{ cmd, lines, resolve, reject, out: [] }]
let pollTimer = null;
let reconnectTimer = null;
let backoff = 1000;
let az = null;
let el = null;
let lastCmdAz = null;
let lastCmdEl = null;
let azState = "IDLE";
let parkHold = false;

function endpoint() {
  if (deps.endpoint) return deps.endpoint();
  return require("../hamlib").rotEndpoint();
}
const azOnly = () => !!config.ROTOR_AZ_ONLY;
const elMax = () => (config.ROTOR_EL_MAX === 90 ? 90 : 180);
const norm = (a) => ((a % 360) + 360) % 360;
const azDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

function init(o) {
  if (o && o.broadcast) broadcastFn = o.broadcast;
}

function getRotorState() {
  return {
    antennaOn,
    azConnected: connected,
    elConnected: azOnly() ? true : connected,
    az,
    el: azOnly() ? null : el,
    lastCmdAz,
    lastCmdEl: azOnly() ? null : lastCmdEl,
    azState,
    elState: azOnly() ? "N/A" : azState,
    minEl: config.ROTOR_MIN_EL,
    azOnly: azOnly(),
    flipped: false,
    elMax: elMax(),
  };
}
function statusPayload() {
  const s = getRotorState();
  const ep = endpoint();
  return Object.assign({ type: "rotor" }, s, { azDevice: ep.host + ":" + ep.port, elDevice: ep.host + ":" + ep.port, driver: meta.id });
}
function broadcastStatus() {
  broadcastFn(statusPayload());
}

// ---- rotctld socket ----
function send(cmd, lines) {
  if (!sock || !connected) return Promise.reject(new Error("rotctld not connected"));
  return new Promise((resolve, reject) => {
    queue.push({ cmd, lines, resolve, reject, out: [] });
    if (queue.length === 1) sock.write(cmd + "\n");
  });
}
function onData(d) {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    const q = queue[0];
    if (!q) continue;
    if (/^RPRT\s+(-?\d+)/.test(line)) {
      const code = parseInt(RegExp.$1, 10);
      queue.shift();
      if (code === 0) q.resolve(q.out);
      else q.reject(new Error("rotctld RPRT " + code));
    } else {
      q.out.push(line);
      if (q.lines && q.out.length >= q.lines) {
        queue.shift();
        q.resolve(q.out);
      } else continue;
    }
    if (queue[0] && sock) sock.write(queue[0].cmd + "\n");
  }
}
function failQueue(err) {
  const q = queue;
  queue = [];
  q.forEach((x) => x.reject(err));
}

function connect() {
  if (sock) return;
  const ep = endpoint();
  const s = deps.connect(ep.port, ep.host);
  sock = s;
  buf = "";
  s.on("connect", () => {
    if (sock !== s) return;
    connected = true;
    backoff = 1000;
    console.log("Hamlib rotor: connected to rotctld " + ep.host + ":" + ep.port);
    startPoll();
    broadcastStatus();
  });
  s.on("data", (d) => sock === s && onData(d));
  s.on("error", () => {});
  s.on("close", () => {
    if (sock !== s) return;
    sock = null;
    connected = false;
    failQueue(new Error("rotctld closed"));
    stopPoll();
    broadcastStatus();
    if (antennaOn) scheduleReconnect();
  });
}
function scheduleReconnect() {
  if (reconnectTimer) return;
  const ms = backoff;
  backoff = Math.min(backoff * 2, 30000);
  reconnectTimer = deps.setTimeout(() => {
    reconnectTimer = null;
    if (antennaOn) connect();
  }, ms);
}
function disconnect() {
  if (reconnectTimer) deps.clearTimeout(reconnectTimer);
  reconnectTimer = null;
  stopPoll();
  const s = sock;
  sock = null;
  connected = false;
  failQueue(new Error("rotctld disconnected"));
  if (s) {
    try {
      s.end();
      s.destroy();
    } catch (_) {}
  }
}
function startPoll() {
  stopPoll();
  pollTimer = deps.setInterval(poll, POLL_MS);
  poll();
}
function stopPoll() {
  if (pollTimer) deps.clearInterval(pollTimer);
  pollTimer = null;
}
function poll() {
  return send("p", 2).then(
    (out) => {
      const a = parseFloat(out[0]);
      const e = parseFloat(out[1]);
      if (Number.isFinite(a)) az = norm(a);
      if (Number.isFinite(e)) el = e;
      if (lastCmdAz != null && az != null && azDiff(az, lastCmdAz) <= DEADBAND && (azOnly() || el == null || Math.abs(el - lastCmdEl) <= DEADBAND)) azState = "IDLE";
      broadcastStatus();
    },
    () => {},
  );
}

/** Send P az el when the target moved past the deadband. */
function goTo(tAz, tEl) {
  tAz = norm(tAz);
  tEl = azOnly() ? 0 : Math.max(0, Math.min(elMax(), tEl));
  if (lastCmdAz != null && azDiff(tAz, lastCmdAz) <= DEADBAND && Math.abs(tEl - lastCmdEl) <= DEADBAND) return Promise.resolve(false);
  lastCmdAz = tAz;
  lastCmdEl = tEl;
  azState = "MOVING";
  return send("P " + tAz.toFixed(1) + " " + tEl.toFixed(1), 0).then(
    () => true,
    (e) => {
      console.warn("Hamlib rotor: move failed: " + e.message);
      lastCmdAz = lastCmdEl = null;
      return false;
    },
  );
}

function setAntenna(on) {
  if (!on) parkHold = false;
  antennaOn = !!on;
  if (antennaOn) {
    lastCmdAz = lastCmdEl = null;
    azState = "IDLE";
    connect();
  } else {
    if (connected) send("S", 0).catch(() => {});
    disconnect();
  }
  broadcastStatus();
}

function applyEndpointChange() {
  if (!meta.match(config)) {
    if (sock) disconnect();
    return;
  }
  if (antennaOn) {
    disconnect();
    connect();
  } else broadcastStatus();
}

function updateTracking(look, aosAz, losAz, m) {
  m = m || {};
  if (!antennaOn || parkHold || !connected) return;
  if (!look || typeof look.az !== "number" || typeof look.el !== "number") return;
  const minEl = m.minEl != null && Number.isFinite(m.minEl) ? m.minEl : config.ROTOR_MIN_EL || 0;
  const inView = look.el >= minEl || (m.inPass === true && look.el >= 0);
  if (inView) return goTo(look.az, look.el);
  const now = Date.now();
  const prepAz = m.nextAosAz != null && Number.isFinite(m.nextAosAz) ? m.nextAosAz : aosAz;
  if (!m.deferSwitchPrep && prepAz != null && Number.isFinite(prepAz) && m.nextAosMs != null && m.nextAosMs - now <= PREP_MS) return goTo(prepAz, 0);
}

function park() {
  const paz = Number.isFinite(config.ROTOR_PARK_AZ) ? config.ROTOR_PARK_AZ : 0;
  const pel = Number.isFinite(config.ROTOR_PARK_EL) ? config.ROTOR_PARK_EL : 0;
  console.log("Hamlib rotor park → az " + paz + " el " + pel);
  parkHold = true;
  const go = () => {
    lastCmdAz = lastCmdEl = null;
    goTo(paz, pel);
  };
  if (!antennaOn) {
    antennaOn = true;
    connect();
  }
  if (connected) go();
  else if (sock) sock.once("connect", go);
  broadcastStatus();
}

function resumeAfterPark() {
  parkHold = false;
  if (!antennaOn) setAntenna(true);
  else broadcastStatus();
}

function logSample() {}

/** Tests: inject socket / timers / endpoint, and reset state. */
function _setDeps(d) {
  disconnect();
  deps = Object.assign({}, deps, d || {});
  antennaOn = connected = parkHold = false;
  az = el = lastCmdAz = lastCmdEl = null;
  azState = "IDLE";
  backoff = 1000;
}

module.exports = {
  meta,
  init,
  setAntenna,
  updateTracking,
  park,
  resumeAfterPark,
  getRotorState,
  statusPayload,
  broadcastStatus,
  applyEndpointChange,
  logSample,
  _setDeps,
};
