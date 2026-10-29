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
let pollLoopOn = false;
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
    flipped: azOnly() ? false : flipped,
    elSuspect: azOnly() ? false : elBad,
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
  s.on("data", (d) => {
    if (c.sock !== s) return;
    try {
      onData(c, d);
    } catch (e) {
      console.warn("Hamlib rotor: bad rotctld reply: " + e.message);
    }
  });
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
  // Chained, not an interval: next read POLL_MS after the last one ends (RT-21 -R reads take
  // > 1 s in rotctld and hold its lock; back-to-back reads starve PSTRotator etc.)
  const loop = () => {
    pollTimer = null;
    Promise.resolve(poll()).then(() => {
      if (!conns.length || pollTimer || !pollLoopOn) return;
      pollTimer = setTimeout(loop, POLL_MS);
    });
  };
  pollLoopOn = true;
  loop();
  return;
  poll();
}
function stopPoll() {
  pollLoopOn = false;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}
/** Position: "p" -> az / el; a separate EL controller reports elevation on its first (azimuth) axis. */
let polling = false;
function poll() {
  // One poll at a time: with RT-21 -R a "p" takes > 1 s in rotctld (500 ms post-write delay per
  // port), so a 1 s interval used to pile up "p" ahead of moves (Park waited seconds).
  if (polling) return Promise.resolve();
  polling = true;
  const list = conns;
  return Promise.all(list.map((c) => send(c, "p", 2).then((out) => applyPos(c, out), (e) => badRead(e && e.message))))
    .catch((e) => badRead(e && e.message))
    .then(() => {
      polling = false;
      if (lastCmdAz != null && az != null && azDiff(az, lastCmdAz) <= DEADBAND && (azOnly() || el == null || Math.abs(el - lastCmdEl) <= DEADBAND)) azState = "IDLE";
      try {
        broadcastStatus();
      } catch (_) {}
    });
}
let badReads = 0;
/** A null / short / garbled reply is a failed read: logged once per streak, never thrown. */
function badRead(why) {
  if (/dropped|disconnected|closed|not connected/.test(String(why || ""))) return;
  if (badReads++ === 0) console.warn("Hamlib rotor: position read failed (" + (why || "no reply") + ") — retrying");
}
/* Hamlib RT-21 (#405) EL readback above 99 can come back wrong (Brian, alpha.21: rotor at EL 120
 * read 12). While the antenna may be above 99 (we commanded >= 99.5, or last trusted reading >= 99)
 * a low reading (< 30) is suspect: not shown (EL "-") and not used for Park completion. */
let elBad = false;
const elSuspect = () => elBad;
function checkEl(v) {
  if (!Number.isFinite(v)) return v;
  const cmd = lastCmdEl;
  if (cmd != null && cmd >= 99.5 && v < 30 && Math.abs(v - cmd / 10) <= 3) {
    if (!elBad) console.warn("Hamlib rotor: EL reads " + v + "° with EL " + cmd + "° commanded — Hamlib RT-21 EL readback suspect, ignored");
    elBad = true;
    return null;
  }
  elBad = false;
  return v;
}
function applyPos(c, out) {
  const a = Array.isArray(out) && out.length >= 1 ? parseFloat(out[0]) : NaN;
  const e = Array.isArray(out) && out.length >= 2 ? parseFloat(out[1]) : NaN;
  if (!Number.isFinite(a) || (c.role === "azel" && !azOnly() && !Number.isFinite(e))) {
    badRead("bad reply " + JSON.stringify(out));
    return;
  }
  badReads = 0;
  if (c.role === "el") el = checkEl(a);
  else {
    az = norm(a);
    if (c.role === "azel" && Number.isFinite(e)) el = checkEl(e);
  }
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
      if (/dropped/.test(e.message)) return false;
      if (/disconnected|closed|not connected/.test(e.message)) {
        retryTarget = { az: tAz, el: tEl }; // resent when rotctld is back
        return false;
      }
      console.warn("Hamlib rotor: move failed: " + e.message);
      return false;
    },
  );
}

function setAntenna(on, why, o) {
  if (!!on !== antennaOn) console.log("Hamlib rotor: Antenna " + (on ? "on" : "off") + (why ? " (" + why + ")" : ""));
  if (!on) parkHold = false;
  antennaOn = !!on;
  resetFlip();
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
      c.queue.splice(1).forEach((q) => q.reject(new Error("rotctld dropped (antenna off)")));
      if (o && o.noStop) return Promise.resolve();
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

/* ---- Over-the-top flip (same rules as the native RT-21 driver, lib/rotors/rt21.js) ----
 * Only with AZ-only off and Max EL 180. Flip when the AZ path crosses the AZ stop
 * (ROTOR_AZ_STOP north @ 0 / south @ 180): before AOS from AOS -> LOS (pre-position
 * AZ + 180 at EL = Max EL, mode locked for the pass), mid-pass from now -> LOS.
 * Flipped: AZ + 180, EL = Max EL - el. The mode holds until the sat drops below Min EL. */
let flipped = false;
let passMode = null; // null | false | true: mode locked for the pass in view
let prepMode = null; // mode chosen at the pre-position (used at AOS)
let modeSat = null;
const flipEnabled = () => !azOnly() && elMax() >= 180;
function azStop() {
  const s = String(config.ROTOR_AZ_STOP || "north").toLowerCase();
  return s === "south" || s === "s" ? "south" : "north";
}
/** Copy of rt21.js shortestPathCrossesStop (read-only reuse; native untouched). */
function crossesStop(fromAz, toAz) {
  if (fromAz == null || toAz == null || !Number.isFinite(fromAz) || !Number.isFinite(toAz)) return false;
  const a = norm(fromAz);
  const b = norm(toAz);
  const cw = (b - a + 360) % 360;
  const ccw = (a - b + 360) % 360;
  if (Math.min(cw, ccw) < 0.5) return false;
  if (azStop() === "south") {
    if (cw <= ccw) return a < 180 && a + cw > 180;
    return a > 180 && a - ccw < 180;
  }
  if (cw <= ccw) return a + cw >= 360;
  return a - ccw <= 0;
}
function resetFlip() {
  flipped = false;
  passMode = prepMode = null;
}

function updateTracking(look, aosAz, losAz, m) {
  m = m || {};
  if (m.satKey != null && String(m.satKey) !== modeSat) {
    modeSat = String(m.satKey);
    resetFlip();
  }
  if (!antennaOn || parkHold || !connected()) return;
  if (!look || typeof look.az !== "number" || typeof look.el !== "number") return;
  const minEl = m.minEl != null && Number.isFinite(m.minEl) ? m.minEl : config.ROTOR_MIN_EL || 0;
  const inView = look.el >= minEl || (m.inPass === true && look.el >= 0);
  if (inView) {
    if (passMode == null) {
      if (!flipEnabled()) passMode = false;
      else if (prepMode != null) passMode = prepMode;
      else passMode = typeof m.remainingCrossesStop === "boolean" ? m.remainingCrossesStop : crossesStop(look.az, losAz);
      prepMode = null;
    }
    flipped = passMode && flipEnabled();
    const e = Math.max(0, Math.min(90, look.el));
    return flipped ? goTo(look.az + 180, elMax() - e) : goTo(look.az, e);
  }
  if (passMode != null) {
    // below Min EL: the pass is over
    passMode = null;
    flipped = false;
  }
  const now = Date.now();
  const prepAz = m.nextAosAz != null && Number.isFinite(m.nextAosAz) ? m.nextAosAz : aosAz;
  if (!m.deferSwitchPrep && prepAz != null && Number.isFinite(prepAz) && m.nextAosMs != null && m.nextAosMs - now <= PREP_MS) {
    const f =
      flipEnabled() &&
      (typeof m.nextCrossesStop === "boolean" ? m.nextCrossesStop : crossesStop(prepAz, m.nextLosAz != null ? m.nextLosAz : null));
    prepMode = f;
    flipped = f;
    return f ? goTo(prepAz + 180, elMax()) : goTo(prepAz, 0);
  }
}

function park() {
  const paz = Number.isFinite(config.ROTOR_PARK_AZ) ? config.ROTOR_PARK_AZ : 0;
  const pel = Number.isFinite(config.ROTOR_PARK_EL) ? config.ROTOR_PARK_EL : 0;
  console.log("Hamlib rotor park → az " + paz + " el " + pel);
  parkHold = true;
  resetFlip();
  watchPark(paz, pel);
  parkMovedAt = null;
  const go = () => {
    lastCmdAz = lastCmdEl = null;
    goTo(paz, pel).then((ok) => {
      if (ok && parkHold) parkMovedAt = Date.now();
    });
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
const PARK_MIN_MS = 3000;
const PARK_STEADY_MS = 3000;
let parkMovedAt = null;
let parkTimer = null;
function stopPark() {
  if (parkTimer) deps.clearTimeout(parkTimer);
  parkTimer = null;
}
function watchPark(paz, pel) {
  stopPark();
  const t0 = Date.now();
  const settle = config.ROTOR_SETTLE_DEG != null ? config.ROTOR_SETTLE_DEG : 3;
  let steady = null;
  const tick = () => {
    parkTimer = null;
    if (!antennaOn || !parkHold) return;
    // Complete once the park move was answered (+3 s) and the readings are steady for 3 s.
    // No Stop is sent at complete, so the controller always finishes the move; we just go quiet
    // (do not hold rotctld for 60 s: RT-21 stops a few degrees off, or EL reads oddly above 99).
    const moved = parkMovedAt != null && Date.now() - parkMovedAt >= PARK_MIN_MS;
    if (connected() && az != null) {
      const cur = { az, el: azOnly() ? 0 : el };
      if (!steady || azDiff(cur.az, steady.az) > 0.5 || (cur.el != null && steady.el != null && Math.abs(cur.el - steady.el) > 0.5)) steady = { az: cur.az, el: cur.el, t: Date.now() };
    }
    const tEl = azOnly() ? 0 : Math.max(0, Math.min(elMax(), pel));
    const atPark = az != null && azDiff(az, norm(paz)) <= settle && (azOnly() || (el != null && Math.abs(el - tEl) <= settle));
    const at = moved && steady != null && Date.now() - steady.t >= PARK_STEADY_MS;
    const timedOut = Date.now() - t0 >= PARK_MAX_MS;
    if (at || timedOut) {
      console.log("Hamlib rotor park complete — disconnecting" + (timedOut ? " (timeout)" : atPark ? "" : " (stopped off park; controller finishes)") + " az " + az + " el " + el);
      try {
        setAntenna(false, "park complete", { noStop: true });
      } catch (e) {
        console.warn("Hamlib rotor: " + e.message);
      }
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
  resetFlip();
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
  az = el = lastCmdAz = lastCmdEl = retryTarget = parkMovedAt = null;
  elBad = false;
  resetFlip();
  modeSat = null;
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
