/**
 * Hamlib manager: rigctld for "Hamlib serial" radio sides, model list / caps
 * cache, version + update job.
 *
 * A side with transport "hamlib" is driven by our own rigctl TCP driver
 * (lib/radios/rigctl.js) talking to a rigctld this module starts on
 * port 4534 (main / UL radio) or 4535 (DL radio on its own serial port); both
 * set in Configure → Station → "Share rigctld on network". rigctld listens on
 * 127.0.0.1, or 0.0.0.0 when shared (our driver always dials 127.0.0.1).
 *
 * Lifetime (server sets configure({ auto: true })): rigctld runs whenever the
 * active config has a Hamlib-serial radio — Radio on or off — so WSJT-X etc.
 * can use the radio. autoSync() (called after every config apply) starts /
 * restarts / stops it to match. The Radio button only connects our rigctl
 * driver to it (Doppler, VFO / mode / sat-mode set-up); with Radio off we send
 * nothing to rigctld. The rigctl driver calls ensure() before it
 * connects and stopAll() when the radio is turned off / deselected.
 */
const fs = require("fs");
const net = require("net");
const path = require("path");
const models = require("./models");
const tools = require("./tools");
const update = require("./update");
const { Supervisor } = require("./supervisor");

const os = require("os");

/** Share setting from lib/config (HAMLIB_NET): { share, portUl, portDl }. */
function netCfg(c) {
  const n = (c && c.HAMLIB_NET) || {};
  const ok = (p, d) => (parseInt(p, 10) >= 1024 && parseInt(p, 10) < 65536 ? parseInt(p, 10) : d);
  return { share: n.share === true, portUl: ok(n.portUl, 4534), portDl: ok(n.portDl, 4535) };
}
const bindHost = (c) => (netCfg(c).share ? "0.0.0.0" : "127.0.0.1");

let config = null; // lazy (avoid a require cycle with lib/config)
function cfg() {
  if (!config) config = require("../config");
  return config;
}

const daemons = new Map(); // key (device) -> { sv, sides, argsKey, port, model }
const capsCache = new Map(); // model -> caps
let modelsCache = null; // { key, version, list }
let job = null; // { kind, running, startedAt, log:[], result }
let opts = { spawn: null, log: (m) => console.log(m), warn: (m) => console.warn(m), onChange: null };

let auto = false;
function configure(o) {
  opts = Object.assign(opts, o || {});
  if (o && typeof o.auto === "boolean") auto = o.auto;
}
/** After a config change: keep rigctld matching the config (server only; tests opt in). */
function autoSync() {
  if (!auto) return Promise.resolve();
  return ensure();
}
function changed() {
  if (typeof opts.onChange === "function") status().then(opts.onChange, () => {});
}

function sideOn(s) {
  return !!(s && typeof s === "object" && s.disabled !== true && String(s.transport || "").toLowerCase() === "hamlib");
}

/** Wanted rigctld instances from the current radio config: one per serial device. */
function wantedSpecs(c) {
  c = c || cfg();
  const out = new Map();
  const single = !!c.SINGLE_RADIO;
  const sides = single ? [["dl", c.RADIO_UL || c.RADIO_DL]] : [["dl", c.RADIO_DL], ["ul", c.RADIO_UL]];
  for (const [which, s] of sides) {
    if (!sideOn(s)) continue;
    const key = devKey(s) || "model:" + s.hamlibModel;
    if (out.has(key)) {
      out.get(key).sides.push(which);
      continue;
    }
    const port = portForSide(s, which, single ? null : which === "ul" ? c.RADIO_DL : c.RADIO_UL, c);
    const args = models.buildRigctldArgs(Object.assign(models.sideToRigctld(s, port), { host: bindHost(c) }));
    out.set(key, { key, sides: [which], port, host: bindHost(c), model: parseInt(s.hamlibModel, 10), args, argsKey: args.join(" ") });
  }
  return out;
}

const devKey = (s) => String((s && s.serialDevice) || "").trim().toLowerCase();
/**
 * rigctld port of a side (Configure → Station): the main / UL radio uses
 * portUl (4534). The DL radio uses portDl (4535) only when it has its own
 * rigctld — i.e. the UL radio is not Hamlib on the same serial port.
 * (Single radio: one rigctld on portUl.)
 */
function portForSide(s, which, other, c) {
  const n = netCfg(c || cfg());
  if (which === "ul") return n.portUl;
  const shared = sideOn(other) && devKey(other) === devKey(s);
  return other && !shared ? n.portDl : n.portUl;
}
/** rigctld endpoint for a side ("127.0.0.1:4534"), used by lib/config for the rigctl driver. */
function endpointForSide(s, which, other, c) {
  return "127.0.0.1:" + portForSide(s, which, other, c);
}

/** This machine's LAN IPv4 addresses (for the "share on network" hint). */
function lanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces() || {}))
    for (const a of list || []) if (a && (a.family === "IPv4" || a.family === 4) && !a.internal) out.push(a.address);
  return out;
}

function portFree(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, host || "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

let ensuring = Promise.resolve();
/** Start / keep / restart rigctld instances to match the config. Resolves when ready (or failed). */
function ensure(c) {
  ensuring = ensuring.then(() => doEnsure(c)).catch((e) => opts.warn("Hamlib: " + e.message));
  return ensuring;
}
async function doEnsure(c) {
  let want;
  try {
    want = wantedSpecs(c);
  } catch (e) {
    opts.warn("Hamlib: " + e.message);
    want = new Map();
  }
  for (const [key, d] of Array.from(daemons)) {
    const w = want.get(key);
    if (!w || w.argsKey !== d.argsKey) {
      daemons.delete(key);
      await d.sv.stop();
    }
  }
  const bin = tools.find("rigctld");
  for (const [key, w] of want) {
    if (daemons.has(key)) {
      daemons.get(key).sides = w.sides;
      continue;
    }
    if (!bin) {
      opts.warn("Hamlib: rigctld not found — install Hamlib (Configure → Radio → Hamlib → Update)");
      daemons.set(key, Object.assign({ sv: deadSupervisor(w, "rigctld not found") }, w));
      continue;
    }
    if (!(await portFree(w.port, w.host))) {
      opts.warn("Hamlib: port " + w.port + " is already in use — not starting rigctld (change the rigctld port)");
      daemons.set(key, Object.assign({ sv: deadSupervisor(w, "port " + w.port + " in use") }, w));
      continue;
    }
    const sv = new Supervisor({ name: "rigctld", bin, args: w.args, port: w.port, spawn: opts.spawn || undefined, log: opts.log, warn: opts.warn });
    sv.on("state", changed);
    daemons.set(key, Object.assign({ sv }, w));
    caps(w.model).catch(() => {}); // warm the split / SATMODE hint
    await sv.start();
  }
  changed();
}

function deadSupervisor(w, err) {
  return { status: () => ({ name: "rigctld", state: "failed", port: w.port, args: w.args, error: err, restarts: 0, pid: null }), stop: () => Promise.resolve() };
}

async function stopAll() {
  const list = Array.from(daemons.values());
  daemons.clear();
  await Promise.all(list.map((d) => d.sv.stop()));
  if (list.length) changed();
}

function anyWanted(c) {
  const k = c || cfg();
  return sideOn(k.RADIO_UL) || sideOn(k.RADIO_DL);
}

/** Split / SATMODE hint for the rigctl driver (null = unknown, probe as before). */
function capsHint(c) {
  c = c || cfg();
  for (const s of [c.RADIO_DL, c.RADIO_UL]) {
    if (!sideOn(s)) continue;
    const k = capsCache.get(parseInt(s.hamlibModel, 10));
    if (k) return { satDual: k.hasSatmode ? true : null, canSplit: k.canSplit, model: k.model };
  }
  return null;
}

async function listModels(o) {
  o = o || {};
  const rigctl = tools.find("rigctl");
  if (!rigctl) return { ok: false, error: "rigctl not found — Hamlib is not installed", groups: [], count: 0 };
  let mtime = 0;
  try {
    mtime = fs.statSync(rigctl).mtimeMs;
  } catch (_) {}
  const key = rigctl + "|" + mtime;
  if (!o.force && modelsCache && modelsCache.key === key) return modelsCache.value;
  const r = await tools.run(rigctl, ["-l"], { timeoutMs: 20000 });
  const list = models.parseList(r.stdout);
  const v = await tools.version();
  const value = { ok: list.length > 0, version: v.version, count: list.length, groups: models.groupByMfg(list).map((g) => ({ mfg: g.mfg, models: g.models.map((m) => Object.assign({}, m, { native: models.nativeFor(m) })) })) };
  if (!list.length) value.error = "rigctl -l returned no models";
  modelsCache = { key, value };
  return value;
}

async function listRotors() {
  const rotctl = tools.find("rotctl");
  if (!rotctl) return { ok: false, error: "rotctl not found", groups: [] };
  const r = await tools.run(rotctl, ["-l"], { timeoutMs: 20000 });
  const list = models.parseList(r.stdout);
  return { ok: list.length > 0, count: list.length, groups: models.groupByMfg(list) };
}

async function caps(model) {
  const id = parseInt(model, 10);
  if (!(id > 0)) throw new Error("model?");
  if (capsCache.has(id)) return capsCache.get(id);
  const rigctl = tools.find("rigctl");
  if (!rigctl) throw new Error("rigctl not found");
  const [d, l] = await Promise.all([tools.run(rigctl, ["-m", String(id), "--dump-caps"], { timeoutMs: 15000 }), tools.run(rigctl, ["-m", String(id), "-L"], { timeoutMs: 15000 })]);
  const c = Object.assign(models.parseCaps(d.stdout, l.stdout), { id, native: models.nativeFor(id) });
  capsCache.set(id, c);
  return c;
}

/** Test button for a Hamlib-serial side: use our running rigctld, or a temporary one. */
async function testSide(side, probe) {
  for (const d of daemons.values()) {
    if (String(d.key) === String(side.serialDevice || "").trim().toLowerCase() && d.sv.state === "running") return probe("127.0.0.1", d.port);
  }
  const bin = tools.find("rigctld");
  if (!bin) return { ok: false, message: "rigctld not found — install / update Hamlib first" };
  const port = await freePort();
  let args;
  try {
    args = models.buildRigctldArgs(models.sideToRigctld(side, port));
  } catch (e) {
    return { ok: false, message: e.message };
  }
  const sv = new Supervisor({ name: "rigctld(test)", bin, args, port, spawn: opts.spawn || undefined, log: opts.log, warn: opts.warn, readyTimeoutMs: 6000 });
  try {
    if (!(await sv.start())) return { ok: false, message: "rigctld did not start: " + (sv.lastError || sv.lastLine || "see log") };
    const r = await probe("127.0.0.1", port);
    r.message = "Hamlib " + (r.message || "");
    return r;
  } finally {
    await sv.stop();
  }
}

let latest = null;
async function status(o) {
  const v = await tools.version().catch(() => ({ installed: false }));
  if (o && o.checkLatest) latest = await update.latestRelease().catch(() => null);
  return {
    installed: !!v.installed,
    version: v.version || null,
    path: v.path || null,
    source: v.source || null,
    latest: latest ? { version: latest.version, url: latest.url } : null,
    updateAvailable: !!(latest && v.version && tools.cmpVersion(latest.version, v.version) > 0),
    plan: update.planFor(),
    sourceBuild: process.platform === "linux" ? update.sourceBuildPlan(latest && latest.version) : null,
    rollback: !!(tools.readCurrent() && tools.readCurrent().previous),
    daemons: Array.from(daemons.values()).map((d) => Object.assign(d.sv.status(), { sides: d.sides, model: d.model })),
    net: Object.assign(netCfg(cfg()), { host: bindHost(cfg()), lanIps: lanIps(), platform: process.platform }),
    job: job ? { kind: job.kind, running: job.running, startedAt: job.startedAt, log: job.log.slice(-40), result: job.result } : null,
  };
}

/** Run the per-OS update (or rollback) once; poll status() for progress. */
function startJob(kind) {
  if (job && job.running) return { ok: false, error: "An update is already running" };
  job = { kind, running: true, startedAt: Date.now(), log: [], result: null };
  const log = (l) => {
    job.log.push(String(l));
    if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
    opts.log("Hamlib update: " + l);
  };
  const wasRunning = daemons.size > 0;
  const o = {
    log,
    stopDaemons: () => stopAll(),
    restartDaemons: async () => {
      if (wasRunning) await ensure();
    },
  };
  const p = kind === "rollback" ? update.rollback(o) : update.runUpdate(o);
  p.then(
    (r) => (job.result = r),
    (e) => (job.result = { ok: false, error: e.message }),
  ).then(() => {
    job.running = false;
    modelsCache = null; // reload the model list from the new version
    capsCache.clear();
    log(job.result.ok ? "done" : "failed: " + job.result.error);
    changed();
  });
  return { ok: true };
}

// Never leave a rigctld behind when the server exits.
process.on("exit", () => {
  for (const d of daemons.values()) {
    try {
      if (d.sv.child) d.sv.child.kill();
    } catch (_) {}
  }
});

module.exports = {
  configure,
  autoSync,
  ensure,
  stopAll,
  anyWanted,
  wantedSpecs,
  endpointForSide,
  capsHint,
  listModels,
  listRotors,
  caps,
  testSide,
  status,
  startJob,
  portForSide,
  netCfg,
  lanIps,
  _daemons: daemons,
};
