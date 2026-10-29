/**
 * Hamlib rotor driver: talks to the rotctld that lib/hamlib starts for
 * ROTOR_TYPE "hamlib" (127.0.0.1:4537, `rotctld -m <model> -r <dev> -s <baud>`).
 * Separate AZ / EL controllers (not RT-21, which Hamlib drives itself with -R):
 * AZ rotctld 4537 gets "P az 0", EL rotctld 4538 gets "P el 0" (elevation on its
 * azimuth axis); position is read from each.
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
let pollTimer = null;
let az = null;
let el = null;
let lastCmdAz = null;
let lastCmdEl = null;
let azState = "IDLE";
let parkHold = false;
/** Move cut off by a disconnect / reconnect: sent again once connected. */
let retryTarget = null;
/** One rotctld connection: "azel" (one daemon), or "az" / "el" (separate controllers). */
let conns = [];

/** { az: {host,port}, el: {host,port}|null }; a plain {host,port} = one daemon. */
function endpoints() {
  const e = deps.endpoint ? deps.endpoint() : require("../hamlib").rotEndpoints();
  if (e && e.port) return { az: e, el: null };
  return e;
}
const azOnly = () => !!config.ROTOR_AZ_ONLY;
const elMax = () => (config.ROTOR_EL_MAX === 90 ? 90 : 180);
const norm = (a) => ((a % 360) + 360) % 360;
const azDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const connected = () => conns.length > 0 && conns.every((c) => c.connected);
const connOf = (role) => conns.find((c) => c.role === role || c.role === "azel");

function init(o) {
  if (o && o.broadcast) broadcastFn = o.broadcast;
}

function getRotorState() {
  const azc = connOf("az");
  const elc = connOf("el");
  return {
    antennaOn,
    azConnected: !!(azc && azc.connected),
    elConnected: azOnly() ? true : !!(elc && elc.connected),
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
  const e = endpoints();
  const fmt = (x) => x.host + ":" + x.port;
  return Object.assign({ type: "rotor" }, getRotorState(), { azDevice: fmt(e.az), elDevice: fmt(e.el || e.az), driver: meta.id });
}
function broadcastStatus() {
  broadcastFn(statusPayload());
}

// ---- rotctld sockets ----
function makeConn(role, ep) {
  const c = { role, ep, sock: null, connected: false, buf: "", queue: [], timer: null, backoff: 1000 };
  return c;
}
function send(c, cmd, lines) {
  if (!c || !c.sock || !c.connected) return Promise.reject(new Error("rotctld not connected"));
  return new Promise((resolve, reject) => {
    const job = { cmd, lines, resolve, reject, out: [] };
    // Moves coalesce: a newer "P" replaces one still waiting (never a backlog of stale moves).
    if (cmd[0] === "P") {
      for (let k = c.queue.length - 1; k >= 1; k--) {
        if (c.queue[k].cmd[0] === "P") c.queue.splice(k, 1)[0].resolve(null);
      }
    }
    // Moves / stop go ahead of queued position polls (never behind a backlog of "p");
    // index 0 is in flight on the socket and stays first.
    if (cmd !== "p" && c.queue.length > 1) {
      let i = 1;
      while (i < c.queue.length && c.queue[i].cmd !== "p") i++;
      c.queue.splice(i, 0, job);
    } else c.queue.push(job);
    if (c.queue.length === 1) c.sock.write(cmd + "\n");
  });
}
function onData(c, d) {
  c.buf += d.toString();
  let i;
  while ((i = c.buf.indexOf("\n")) >= 0) {
    const line = c.buf.slice(0, i).trim();
    c.buf = c.buf.slice(i + 1);
    const q = c.queue[0];
    if (!q) continue;
    const m = /^RPRT\s+(-?\d+)/.exec(line);
    if (m) {
      c.queue.shift();
      if (m[1] === "0") q.resolve(q.out);
      else q.reject(new Error("rotctld RPRT " + m[1]));
    } else {
      q.out.push(line);
      if (q.lines && q.out.length >= q.lines) {
        c.queue.shift();
        q.resolve(q.out);
      } else continue;
    }
    if (c.queue[0] && c.sock) c.sock.write(c.queue[0].cmd + "\n");
  }
}
function failQueue(c, err) {
  const q = c.queue;
  c.queue = [];
  q.forEach((x) => x.reject(err));
}
function open(c) {
  if (c.sock) return;
  const s = deps.connect(c.ep.port, c.ep.host);
  c.sock = s;
  c.buf = "";
  s.on("connect", () => {
    if (c.sock !== s) return;
    c.connected = true;
    c.backoff = 1000;
    console.log("Hamlib rotor: connected to rotctld (" + c.role + ") " + c.ep.host + ":" + c.ep.port);
    if (connected()) {
      startPoll();
      if (retryTarget && antennaOn) {
        const t = retryTarget;
        retryTarget = null;
        goTo(t.az, t.el);
      }
    }
    broadcastStatus();
  });
  s.on("data", (d) => c.sock === s && onData(c, d));
  s.on("error", () => {});
  s.on("close", () => {
    if (c.sock !== s) return;
    c.sock = null;
    c.connected = false;
    failQueue(c, new Error("rotctld closed"));
    broadcastStatus();
    if (antennaOn && conns.indexOf(c) >= 0 && !c.timer) {
      const ms = c.backoff;
      c.backoff = Math.min(c.backoff * 2, 30000);
      c.timer = deps.setTimeout(() => {
        c.timer = null;
        if (antennaOn && conns.indexOf(c) >= 0) open(c);
      }, ms);
    }
  });
}
function close(c) {
  if (c.timer) deps.clearTimeout(c.timer);
  c.timer = null;
  const s = c.sock;
  c.sock = null;
  c.connected = false;
  failQueue(c, new Error("rotctld disconnected"));
  if (s) {
    try {
      s.end();
      s.destroy();
    } catch (_) {}
  }
}
function connect() {
  if (conns.length) return;
  const e = endpoints();
  conns = e.el ? [makeConn("az", e.az), makeConn("el", e.el)] : [makeConn("azel", e.az)];
  conns.forEach(open);
}
function disconnect() {
  stopPoll();
  polling = false;
  const list = conns;
  conns = [];
  list.forEach(close);
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
/** Position: "p" -> az / el; a separate EL controller reports elevation on its first (azimuth) axis. */
let polling = false;
function poll() {
  // One poll at a time: with RT-21 -R a "p" takes > 1 s in rotctld (500 ms post-write delay per
  // port), so a 1 s interval used to pile up "p" ahead of moves (Park waited seconds).
  if (polling) return Promise.resolve();
  polling = true;
  return Promise.all(
    conns.map((c) =>
      send(c, "p", 2).then(
        (out) => {
          const a = parseFloat(out[0]);
          const e = parseFloat(out[1]);
          if (c.role === "el") {
            if (Number.isFinite(a)) el = a;
          } else {
            if (Number.isFinite(a)) az = norm(a);
            if (c.role === "azel" && Number.isFinite(e)) el = e;
          }
        },
        () => {},
      ),
    ),
  ).then(() => {
    polling = false;
    if (lastCmdAz != null && az != null && azDiff(az, lastCmdAz) <= DEADBAND && (azOnly() || el == null || Math.abs(el - lastCmdEl) <= DEADBAND)) azState = "IDLE";
    broadcastStatus();
  });
}

/** Send the move when the target moved past the deadband: one daemon "P az el";
 *  separate controllers: AZ daemon "P az 0", EL daemon "P el 0". */
function goTo(tAz, tEl) {
  tAz = norm(tAz);
  tEl = azOnly() ? 0 : Math.max(0, Math.min(elMax(), tEl));
  if (lastCmdAz != null && azDiff(tAz, lastCmdAz) <= DEADBAND && Math.abs(tEl - lastCmdEl) <= DEADBAND) return Promise.resolve(false);
  lastCmdAz = tAz;
  lastCmdEl = tEl;
  azState = "MOVING";
  const one = connOf("azel") && connOf("azel").role === "azel";
  const jobs = one
    ? [send(connOf("azel"), "P " + tAz.toFixed(1) + " " + tEl.toFixed(1), 0)]
    : [send(connOf("az"), "P " + tAz.toFixed(1) + " 0.0", 0)].concat(azOnly() ? [] : [send(connOf("el"), "P " + tEl.toFixed(1) + " 0.0", 0)]);
  return Promise.all(jobs).then(
    () => true,
    (e) => {
      lastCmdAz = lastCmdEl = null;
      if (/disconnected|closed|not connected/.test(e.message)) {
        retryTarget = { az: tAz, el: tEl }; // resent when rotctld is back
        return false;
      }
      console.warn("Hamlib rotor: move failed: " + e.message);
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
    retryTarget = null;
    stopPark();
    // Stop must reach rotctld: drop queued moves / polls, send S, close once answered (max 3 s).
    stopPoll();
    polling = false;
    const list = conns;
    conns = [];
    const stops = list.map((c) => {
      c.queue.splice(1).forEach((q) => q.resolve(null));
      return c.connected ? send(c, "S", 0).catch(() => {}) : Promise.resolve();
    });
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      list.forEach(close);
    };
    Promise.all(stops).then(fin);
    deps.setTimeout(fin, 3000);
  }
  broadcastStatus();
}

function applyEndpointChange() {
  if (!meta.match(config)) {
    if (conns.length) disconnect();
    return;
  }
  if (antennaOn) {
    disconnect();
    connect();
  } else broadcastStatus();
}

function updateTracking(look, aosAz, losAz, m) {
  m = m || {};
  if (!antennaOn || parkHold || !connected()) return;
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
  watchPark(paz, pel);
  const go = () => {
    lastCmdAz = lastCmdEl = null;
    goTo(paz, pel);
  };
  if (!antennaOn) {
    antennaOn = true;
    connect();
  }
  if (connected()) go();
  else {
    const t0 = Date.now();
    const wait = () => (connected() ? go() : antennaOn && Date.now() - t0 < 15000 && deps.setTimeout(wait, 200));
    deps.setTimeout(wait, 200);
  }
  broadcastStatus();
}

/** Like the native RT-21 driver: once at Park (within ROTOR_SETTLE_DEG) or after 60 s, Antenna off. */
const PARK_POLL_MS = 500;
const PARK_MAX_MS = 60000;
let parkTimer = null;
function stopPark() {
  if (parkTimer) deps.clearTimeout(parkTimer);
  parkTimer = null;
}
function watchPark(paz, pel) {
  stopPark();
  const t0 = Date.now();
  const settle = config.ROTOR_SETTLE_DEG != null ? config.ROTOR_SETTLE_DEG : 3;
  const tick = () => {
    parkTimer = null;
    if (!antennaOn || !parkHold) return;
    const tEl = azOnly() ? 0 : Math.max(0, Math.min(elMax(), pel));
    const at = connected() && az != null && azDiff(az, norm(paz)) <= settle && (azOnly() || (el != null && Math.abs(el - tEl) <= settle));
    const timedOut = Date.now() - t0 >= PARK_MAX_MS;
    if (at || timedOut) {
      console.log("Hamlib rotor park complete — disconnecting" + (timedOut ? " (timeout)" : "") + " az " + az + " el " + el);
      setAntenna(false);
      broadcastStatus();
      return;
    }
    parkTimer = deps.setTimeout(tick, PARK_POLL_MS);
  };
  parkTimer = deps.setTimeout(tick, PARK_POLL_MS);
}

function resumeAfterPark() {
  stopPark();
  parkHold = false;
  if (!antennaOn) setAntenna(true);
  else broadcastStatus();
}

function logSample() {}

/** Tests: inject socket / timers / endpoint, and reset state. */
function _setDeps(d) {
  stopPark();
  disconnect();
  deps = Object.assign({}, deps, d || {});
  antennaOn = parkHold = false;
  az = el = lastCmdAz = lastCmdEl = retryTarget = null;
  azState = "IDLE";
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
