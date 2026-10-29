/**
 * Hamlib manager: rigctld for "Hamlib serial" radio sides, model list / caps
 * cache, version + update job.
 *
 * A side with transport "hamlib" is driven by our own rigctl TCP driver
 * (lib/radios/rigctl.js) talking to a rigctld this module starts on
 * port 4534 (main / UL radio) or 4535 (DL radio on its own serial port); both
 * set in Configure → Station (rigctld ports). rigctld listens on
 * 127.0.0.1 only (our driver dials 127.0.0.1).
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

/** rigctld ports from lib/config (HAMLIB_NET): { portUl, portDl }. Always localhost. */
function netCfg(c) {
  const n = (c && c.HAMLIB_NET) || {};
  const ok = (p, d) => (parseInt(p, 10) >= 1024 && parseInt(p, 10) < 65536 ? parseInt(p, 10) : d);
  return { portUl: ok(n.portUl, 4534), portDl: ok(n.portDl, 4535) };
}
const bindHost = () => "127.0.0.1";

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
/** rigctld wanted for this radio: Hamlib serial, even when a per-sat role turns its leg off. */
function sideWanted(s) {
  return !!(s && typeof s === "object" && String(s.transport || "").toLowerCase() === "hamlib");
}
/** Configured radio (1 / 2) of a leg: radioSlot from radio roles, else UL leg = Radio 1. */
function slotOf(s, which) {
  const n = parseInt(s && s.radioSlot, 10);
  return n === 1 || n === 2 ? n : which === "ul" ? 1 : 2;
}

/** Wanted rigctld instances from the current radio config: one per serial device. */
function wantedSpecs(c) {
  c = c || cfg();
  const out = new Map();
  const single = !!c.SINGLE_RADIO;
  const sides = single ? [["dl", c.RADIO_UL || c.RADIO_DL]] : [["dl", c.RADIO_DL], ["ul", c.RADIO_UL]];
  for (const [which, s] of sides) {
    if (!sideWanted(s)) continue;
    if (!(parseInt(s.hamlibModel, 10) > 0)) {
      opts.warn("Hamlib: no model chosen for the " + which.toUpperCase() + " radio — pick it in Configure → Radio");
      continue;
    }
    const key = devKey(s) || "model:" + s.hamlibModel;
    const slot = single ? 1 : slotOf(s, which);
    if (out.has(key)) {
      out.get(key).sides.push(which);
      if (out.get(key).radios.indexOf(slot) < 0) out.get(key).radios.push(slot);
      continue;
    }
    const port = portForSide(s, which, single ? null : which === "ul" ? c.RADIO_DL : c.RADIO_UL, c);
    const args = models.buildRigctldArgs(Object.assign(models.sideToRigctld(s, port), { host: bindHost(c) }));
    out.set(key, { key, sides: [which], radios: [slot], port, host: bindHost(c), model: parseInt(s.hamlibModel, 10), args, argsKey: args.join(" ") });
  }
  return out;
}

const devKey = (s) => String((s && s.serialDevice) || "").trim().toLowerCase();
/**
 * rigctld port of a leg (Configure → Station): pinned to the configured radio,
 * not to the per-satellite UL / DL role — Radio 1 = portUl (4534), Radio 2 =
 * portDl (4535). Both legs on one serial port share one rigctld (lower slot's
 * port). Single radio: Radio 1's port.
 */
function portForSide(s, which, other, c) {
  c = c || cfg();
  const n = netCfg(c);
  if (c.SINGLE_RADIO) return n.portUl;
  let slot = slotOf(s, which);
  if (sideWanted(other) && devKey(other) === devKey(s)) slot = Math.min(slot, slotOf(other, which === "ul" ? "dl" : "ul"));
  return slot === 1 ? n.portUl : n.portDl;
}
/** rigctld endpoint for a side ("127.0.0.1:4534"), used by lib/config for the rigctl driver. */
function endpointForSide(s, which, other, c) {
  return "127.0.0.1:" + portForSide(s, which, other, c);
}

/** How to install Hamlib on this platform (shown when rigctl / rigctld is missing). */
function installHint() {
  if (process.platform === "darwin") return "install it with: brew install hamlib (or Configure → Radio → Hamlib → Update)";
  if (process.platform === "linux") return "install it with: sudo apt install libhamlib-utils (or Configure → Radio → Hamlib → Update)";
  return "install Hamlib (Configure → Radio → Hamlib → Update)";
}

/** This machine's LAN IPv4 addresses, minus virtual / VPN / link-local adapters. */
const VIRTUAL_IF = /vEthernet|Hyper-V|WSL|VirtualBox|VBox|VMware|vmnet|docker|br-|veth|virbr|tun|tap|wg\d|ZeroTier|zt|tailscale|VPN|Loopback|utun|awdl|llw/i;
function lanIps() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces() || {})) {
    if (VIRTUAL_IF.test(name)) continue;
    for (const a of list || []) {
      if (!a || !(a.family === "IPv4" || a.family === 4) || a.internal) continue;
      if (/^169\.254\./.test(a.address) || /^192\.168\.56\./.test(a.address)) continue; // link-local, VirtualBox host-only
      out.push(a.address);
    }
  }
  return out;
}
/** All non-internal IPv4 (for the "other addresses" expander). */
function allIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces() || {}))
    for (const a of list || []) if (a && (a.family === "IPv4" || a.family === 4) && !a.internal) out.push(a.address);
  return out;
}
/**
 * Primary LAN IP: the local address the OS would use for the default route
 * (UDP "connect" picks the route; no packet is sent). Falls back to lanIps()[0].
 */
let primaryCache = { t: 0, ip: null };
function primaryIp() {
  if (Date.now() - primaryCache.t < 30000) return Promise.resolve(primaryCache.ip);
  return new Promise((resolve) => {
    const dgram = require("dgram");
    const s = dgram.createSocket("udp4");
    const done = (ip) => {
      try { s.close(); } catch (_) {}
      if (ip && (ip === "0.0.0.0" || /^169\.254\./.test(ip))) ip = null;
      primaryCache = { t: Date.now(), ip: ip || lanIps()[0] || null };
      resolve(primaryCache.ip);
    };
    s.on("error", () => done(null));
    try {
      s.connect(53, "192.0.2.1", () => { // TEST-NET-1: never contacted, only routed
        let ip = null;
        try { ip = s.address().address; } catch (_) {}
        done(ip);
      });
    } catch (_) {
      done(null);
    }
  });
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
      daemons.get(key).radios = w.radios;
      continue;
    }
    if (!bin) {
      opts.warn("Hamlib: rigctld not found — " + installHint());
      daemons.set(key, Object.assign({ sv: deadSupervisor(w, "rigctld not found") }, w));
      continue;
    }
    if (!(await portFree(w.port, w.host))) {
      opts.warn("Hamlib: port " + w.port + " is already in use — not starting rigctld (change the rigctld port)");
      daemons.set(key, Object.assign({ sv: deadSupervisor(w, "port " + w.port + " in use") }, w));
      continue;
    }
    // Name the model from the installed Hamlib's own `rigctl -l` (catches a wrong / stale number).
    try {
      const lm = await listModels();
      let hit = null;
      for (const g of lm.groups || []) for (const m of g.models) if (m.id === w.model) hit = m;
      if (hit) opts.log("rigctld: radio " + w.sides.map((x) => x.toUpperCase()).join("+") + " = Hamlib #" + w.model + " " + hit.mfg + " " + hit.model + " on port " + w.port);
      else if (lm.ok) opts.warn("Hamlib: model #" + w.model + " is not in this Hamlib's model list (rigctl -l " + (lm.version || "") + ") — pick the radio again in Configure → Radio");
    } catch (_) {}
    const sv = new Supervisor({ name: "rigctld", bin, args: w.args, port: w.port, bindHost: w.host, spawn: opts.spawn || undefined, log: opts.log, warn: opts.warn });
    sv.on("state", changed);
    daemons.set(key, Object.assign({ sv }, w));
    caps(w.model).catch(() => {}); // warm the split / SATMODE hint
    await sv.start();
  }
  await doEnsureRot(c);
  changed();
}

// ---- rotctld for a Hamlib rotor (Configure → Rotor → Hamlib serial) ----
/** Our rotctld ports on 127.0.0.1: 4537 (rotor / AZ controller), 4538 (separate EL controller).
 *  Not Hamlib's 4533 default, which a user's own rotctld may use. */
const ROT_PORT = 4537;
const ROT_EL_PORT = 4538;
/** Hamlib RT-21 (#405) drives a 2nd controller itself: rotctld -R <EL port> (ROTPORT2 = elevation). */
const RT21_MODEL = 405;
const rotDaemons = new Map(); // key ("rot" | "rotEl") -> { sv, argsKey, port, model, args, role }

/**
 * Wanted rotctld instances from the rotor config ([] for native rotor drivers).
 *   single controller:               [{ key "rot",   role "azel", 4537 }]
 *   separate AZ / EL, RT-21 (#405):  [{ key "rot",   role "azel", 4537, -r AZ -R EL }]   (Hamlib native)
 *   separate AZ / EL, other models:  [{ key "rot",   role "az", 4537 }, { key "rotEl", role "el", 4538 }]
 */
function rotSpecs(c) {
  c = c || cfg();
  if (String(c.ROTOR_TYPE || "").toLowerCase() !== "hamlib") return [];
  const model = parseInt(c.ROTOR_HAMLIB_MODEL, 10);
  if (!(model > 0)) {
    opts.warn("Hamlib: no rotor model chosen — pick it in Configure → Rotor");
    return [];
  }
  const mk = (key, role, o) => {
    const args = models.buildRotctldArgs(o);
    return { key, role, port: o.port, host: "127.0.0.1", model: parseInt(o.model, 10), args, argsKey: args.join(" ") };
  };
  const split = !!c.ROTOR_HAMLIB_SPLIT && !c.ROTOR_AZ_ONLY && String(c.ROTOR_HAMLIB_EL_DEVICE || "").trim();
  if (!split) return [mk("rot", "azel", { model, device: c.ROTOR_AZ_DEVICE, baud: c.ROTOR_BAUD, port: ROT_PORT })];
  const elDev = String(c.ROTOR_HAMLIB_EL_DEVICE).trim();
  if (model === RT21_MODEL) return [mk("rot", "azel", { model, device: c.ROTOR_AZ_DEVICE, device2: elDev, baud: c.ROTOR_BAUD, port: ROT_PORT })];
  const elModel = parseInt(c.ROTOR_HAMLIB_EL_MODEL, 10) > 0 ? parseInt(c.ROTOR_HAMLIB_EL_MODEL, 10) : model;
  return [
    mk("rot", "az", { model, device: c.ROTOR_AZ_DEVICE, baud: c.ROTOR_BAUD, port: ROT_PORT }),
    mk("rotEl", "el", { model: elModel, device: elDev, baud: c.ROTOR_HAMLIB_EL_BAUD || c.ROTOR_BAUD, port: ROT_EL_PORT }),
  ];
}
/** Back-compat: the first (AZ / single) spec or null. */
function rotSpec(c) {
  return rotSpecs(c)[0] || null;
}

async function doEnsureRot(c) {
  let want = [];
  try {
    want = rotSpecs(c);
  } catch (e) {
    opts.warn("Hamlib: " + e.message);
  }
  const byKey = new Map(want.map((w) => [w.key, w]));
  for (const [key, d] of Array.from(rotDaemons)) {
    const w = byKey.get(key);
    if (!w || w.argsKey !== d.argsKey) {
      rotDaemons.delete(key);
      await d.sv.stop();
    }
  }
  const bin = want.length ? tools.find("rotctld") : null;
  for (const w of want) {
    if (rotDaemons.has(w.key)) continue;
    if (!bin) {
      opts.warn("Hamlib: rotctld not found — " + installHint());
      rotDaemons.set(w.key, Object.assign({ sv: deadSupervisor(w, "rotctld not found", "rotctld") }, w));
      continue;
    }
    if (!(await portFree(w.port, w.host))) {
      opts.warn("Hamlib: port " + w.port + " is already in use — not starting rotctld (" + w.role + ")");
      rotDaemons.set(w.key, Object.assign({ sv: deadSupervisor(w, "port " + w.port + " in use", "rotctld") }, w));
      continue;
    }
    const what = w.role === "az" ? "AZ controller" : w.role === "el" ? "EL controller" : "rotor";
    opts.log("rotctld: " + what + " = Hamlib #" + w.model + " on 127.0.0.1:" + w.port + (w.args.indexOf("-R") >= 0 ? " (2nd port -R for EL)" : ""));
    const sv = new Supervisor({ name: w.role === "el" ? "rotctld-el" : "rotctld", bin, args: w.args, port: w.port, bindHost: w.host, spawn: opts.spawn || undefined, log: opts.log, warn: opts.warn });
    sv.on("state", changed);
    rotDaemons.set(w.key, Object.assign({ sv }, w));
    await sv.start();
  }
}

/** rotctld endpoints for lib/rotors/hamlib-rot.js: { az, el } (el null = one daemon does both). */
function rotEndpoints(c) {
  let specs = [];
  try {
    specs = rotSpecs(c);
  } catch (_) {}
  const el = specs.find((w) => w.role === "el");
  return { az: { host: "127.0.0.1", port: ROT_PORT }, el: el ? { host: "127.0.0.1", port: ROT_EL_PORT } : null };
}
function rotEndpoint() {
  return { host: "127.0.0.1", port: ROT_PORT };
}

function deadSupervisor(w, err, name) {
  return { status: () => ({ name: name || "rigctld", state: "failed", port: w.port, args: w.args, error: err, restarts: 0, pid: null }), stop: () => Promise.resolve() };
}

async function stopAll() {
  const list = Array.from(daemons.values());
  daemons.clear();
  for (const d of rotDaemons.values()) list.push(d);
  rotDaemons.clear();
  await Promise.all(list.map((d) => d.sv.stop()));
  if (list.length) changed();
}

function anyWanted(c) {
  const k = c || cfg();
  return sideWanted(k.RADIO_UL) || sideWanted(k.RADIO_DL);
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
  if (!rigctl) return { ok: false, error: "rigctl not found — Hamlib is not installed (" + installHint() + ")", groups: [], count: 0 };
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
  if (!rotctl) return { ok: false, error: "rotctl not found — " + installHint(), groups: [] };
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
  if (!bin) return { ok: false, message: "rigctld not found — " + installHint() };
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
    daemons: Array.from(daemons.values()).map((d) => Object.assign(d.sv.status(), { sides: d.sides, radios: (d.radios || []).slice().sort(), model: d.model })),
    rotor: rotDaemons.get("rot") ? Object.assign(rotDaemons.get("rot").sv.status(), { model: rotDaemons.get("rot").model, role: rotDaemons.get("rot").role }) : null,
    rotors: Array.from(rotDaemons.values()).map((d) => Object.assign(d.sv.status(), { model: d.model, role: d.role })),
    net: Object.assign(netCfg(cfg()), { host: bindHost(), platform: process.platform }),
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
  const wasRunning = daemons.size > 0 || rotDaemons.size > 0;
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
  for (const d of Array.from(daemons.values()).concat(Array.from(rotDaemons.values()))) {
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
  rotSpec,
  rotSpecs,
  rotEndpoint,
  rotEndpoints,
  ROT_PORT,
  ROT_EL_PORT,
  RT21_MODEL,
  _rot: () => rotDaemons.get("rot") || null,
  _rotEl: () => rotDaemons.get("rotEl") || null,
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
