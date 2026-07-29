const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const satellite = require("satellite.js");

const PORT = 3000;
const ROOT = __dirname;
const CACHE_DIR = path.join(require("os").homedir(), ".rpitrack");
const CATALOG_CACHE = path.join(CACHE_DIR, "je9pel_catalog.json");
const STATUS_CACHE = path.join(CACHE_DIR, "amsat_status.json");

const JE9PEL_CSV = "https://www.ne.jp/asahi/hamradio/je9pel/satslist.csv";
const AMSAT_STATUS = "https://www.amsat.org/status/";

const DEFAULT_SAT = "RS-44";
const MIN_EL = 10.0;
const TRAIL_MINUTES = 30;
const TRAIL_STEP_SEC = 30;
const PASS_HOURS = 12;
const PASS_STEP_SEC = 30;
const REFRESH_MS = 6 * 60 * 60 * 1000;

const mime = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

/** @type {Record<string, object>} key → sat */
let CATALOG = {};
let catalogNote = "not loaded";
/** @type {Set<string>} normalized names heard recently on AMSAT status */
let ACTIVE = new Set();
let statusNote = "not loaded";

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function norm(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function makeKey(name, norad) {
  const m = String(name).match(/\b([A-Z]{1,4}[\s-]?\d{1,3}[A-Z]?)\b/i);
  if (m) {
    return m[1]
      .toUpperCase()
      .replace(/([A-Z]+)[\s-]*(\d+)/i, (_, a, d) => a + "-" + d)
      .replace(/--+/g, "-");
  }
  if (norad) return `N${norad}`;
  return norm(name).slice(0, 16) || "UNKNOWN";
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "sat-tracker/0.1" },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * JE9PEL CSV columns (semicolon):
 * name;norad;uplink;downlink;beacon;mode;callsign;status
 */
function parseJe9pelCsv(text) {
  const byNorad = new Map(); // norad → best entry
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(";");
    if (parts.length < 2) continue;

    const name = (parts[0] || "").trim();
    const noradStr = (parts[1] || "").trim();
    const norad = parseInt(noradStr, 10);
    if (!name) continue;

    const uplink = (parts[2] || "").trim();
    const downlink = (parts[3] || "").trim();
    const beacon = (parts[4] || "").trim();
    const mode = (parts[5] || "").trim();
    const callsign = (parts[6] || "").trim();
    const status = (parts[7] || "").trim().toLowerCase();

    // Prefer rows with a valid NORAD; merge modes onto same norad
    const entry = {
      name,
      norad: Number.isFinite(norad) ? norad : null,
      uplink,
      downlink,
      beacon,
      mode,
      callsign,
      status,
      key: null,
    };

    if (entry.norad) {
      const prev = byNorad.get(entry.norad);
      if (!prev) {
        byNorad.set(entry.norad, entry);
      } else {
        // Keep richest mode/freq info
        if (mode && !prev.mode.includes(mode)) {
          prev.mode = [prev.mode, mode].filter(Boolean).join(", ");
        }
        if (uplink && !prev.uplink) prev.uplink = uplink;
        if (downlink && !prev.downlink) prev.downlink = downlink;
        if (status === "active") prev.status = "active";
        // Prefer shorter common name (AO-91 over long form)
        if (name.length < prev.name.length) prev.name = name;
      }
    } else {
      // No NORAD — still list, but not trackable until resolved
      const k = makeKey(name, 0);
      entry.key = k;
    }
  }

  const catalog = {};
  for (const entry of byNorad.values()) {
    const key = makeKey(entry.name, entry.norad);
    entry.key = key;
    entry.display = entry.name;
    // Trackable only with NORAD
    entry.trackable = !!entry.norad;
    catalog[key] = entry;
  }
  return catalog;
}

/** AMSAT status: names like AO-123_[FM], cells with report counts */
function parseAmsatStatus(html) {
  const active = new Set();
  // Links/text: AO-73_[U/v], RS-44_[V/u], ISS_[FM]
  const re = />([A-Z0-9][A-Z0-9\-]{1,20})_\[[^\]]+\]</gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    active.add(norm(m[1]));
  }
  // Also plain designators in table first column
  const re2 = />([A-Z]{1,4}-?\d{1,3}[A-Z]?)_\[/gi;
  while ((m = re2.exec(html)) !== null) {
    active.add(norm(m[1]));
  }
  return active;
}

function isHeard(sat) {
  const n = norm(sat.display || sat.name || sat.key);
  if (ACTIVE.has(n)) return true;
  // Partial: RS44 vs RS-44
  for (const a of ACTIVE) {
    if (n.includes(a) || a.includes(n)) return true;
  }
  return false;
}

async function refreshCatalog() {
  ensureCacheDir();
  try {
    const text = await fetchText(JE9PEL_CSV);
    const catalog = parseJe9pelCsv(text);
    const payload = {
      fetched_at: new Date().toISOString(),
      note: "JE9PEL CSV live",
      satellites: catalog,
    };
    fs.writeFileSync(CATALOG_CACHE, JSON.stringify(payload));
    CATALOG = catalog;
    catalogNote = payload.note;
    console.log(
      `Catalog: ${Object.keys(CATALOG).length} sats – ${catalogNote}`,
    );
  } catch (e) {
    if (fs.existsSync(CATALOG_CACHE)) {
      const payload = JSON.parse(fs.readFileSync(CATALOG_CACHE, "utf8"));
      CATALOG = payload.satellites || {};
      catalogNote = `cache ${payload.fetched_at} (${e.message})`;
      console.log(
        `Catalog from cache: ${Object.keys(CATALOG).length} – ${catalogNote}`,
      );
    } else {
      catalogNote = `empty (${e.message})`;
      console.error("Catalog failed:", e.message);
    }
  }
}

async function refreshStatus() {
  ensureCacheDir();
  try {
    const html = await fetchText(AMSAT_STATUS);
    const set = parseAmsatStatus(html);
    const payload = {
      fetched_at: new Date().toISOString(),
      note: "AMSAT status live",
      names: [...set],
    };
    fs.writeFileSync(STATUS_CACHE, JSON.stringify(payload));
    ACTIVE = set;
    statusNote = `${set.size} heard – ${payload.note}`;
    console.log(`Status: ${statusNote}`);
  } catch (e) {
    if (fs.existsSync(STATUS_CACHE)) {
      const payload = JSON.parse(fs.readFileSync(STATUS_CACHE, "utf8"));
      ACTIVE = new Set(payload.names || []);
      statusNote = `cache ${payload.fetched_at} (${e.message})`;
      console.log(`Status from cache: ${ACTIVE.size}`);
    } else {
      statusNote = `empty (${e.message})`;
      console.error("Status failed:", e.message);
    }
  }
}

function listSatsPayload(filter) {
  const rows = [];
  for (const s of Object.values(CATALOG)) {
    if (!s.trackable) continue;
    const st = s.status || "";
    if (filter === "active" && st !== "active" && !isHeard(s)) continue;
    if (filter === "trackable" && (st === "re-entered" || st === "failure"))
      continue;

    rows.push({
      key: s.key,
      name: s.display || s.name,
      norad: s.norad,
      uplink: s.uplink,
      downlink: s.downlink,
      mode: s.mode,
      status: s.status,
      heard: isHeard(s),
    });
  }
  rows.sort((a, b) => {
    if (a.heard !== b.heard) return a.heard ? -1 : 1;
    if ((a.status === "active") !== (b.status === "active")) {
      return a.status === "active" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  return {
    catalogNote,
    statusNote,
    count: rows.length,
    satellites: rows,
  };
}

async function fetchTLE(norad) {
  ensureCacheDir();
  const tlePath = path.join(CACHE_DIR, `tle_${norad}.txt`);
  const metaPath = path.join(CACHE_DIR, `tle_${norad}.meta.json`);

  try {
    const url = `https://celestrak.org/NORAD/elements/gp.php?CATNR=${norad}&FORMAT=TLE`;
    const res = await fetch(url, {
      headers: { "User-Agent": "sat-tracker/0.1" },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = (await res.text()).trim();
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    let name, l1, l2;
    if (lines[0].startsWith("1 ")) {
      name = `NORAD ${norad}`;
      l1 = lines[0];
      l2 = lines[1];
    } else {
      name = lines[0];
      l1 = lines[1];
      l2 = lines[2];
    }

    fs.writeFileSync(tlePath, `${name}\n${l1}\n${l2}\n`);
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        fetched_at: new Date().toISOString(),
        name,
      }),
    );
    return { name, l1, l2, note: "Celestrak (just fetched)" };
  } catch (err) {
    if (fs.existsSync(tlePath)) {
      const lines = fs
        .readFileSync(tlePath, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      let age = "?";
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          const then = new Date(meta.fetched_at);
          const secs = Math.floor((Date.now() - then.getTime()) / 1000);
          if (secs < 3600) age = `${Math.floor(secs / 60)}m`;
          else if (secs < 86400) age = `${Math.floor(secs / 3600)}h`;
          else age = `${Math.floor(secs / 86400)}d`;
        } catch {}
      }
      return {
        name: lines[0],
        l1: lines[1],
        l2: lines[2],
        note: `TLE cache age ${age}`,
      };
    }
    throw err;
  }
}

function gmstFromDate(date) {
  return satellite.gstime(date);
}

function eciToLatLon(positionEci, date) {
  const gmst = gmstFromDate(date);
  const geodetic = satellite.eciToGeodetic(positionEci, gmst);
  let lon = satellite.radiansToDegrees(geodetic.longitude);
  lon = ((lon + 180) % 360) - 180;
  return {
    lat: satellite.radiansToDegrees(geodetic.latitude),
    lon,
    heightKm: geodetic.height,
  };
}

function lookAngles(satrec, observer, date) {
  const pv = satellite.propagate(satrec, date);
  if (!pv.position) return null;
  const gmst = gmstFromDate(date);
  const positionEcf = satellite.eciToEcf(pv.position, gmst);
  const look = satellite.ecfToLookAngles(observer, positionEcf);
  return {
    az: satellite.radiansToDegrees(look.azimuth),
    el: satellite.radiansToDegrees(look.elevation),
    rangeKm: look.rangeSat,
  };
}

function groundPoint(satrec, date) {
  const pv = satellite.propagate(satrec, date);
  if (!pv.position) return null;
  return eciToLatLon(pv.position, date);
}

function buildTrail(satrec, now, minutes, stepSec) {
  const points = [];
  const start = new Date(now.getTime() - minutes * 60 * 1000);
  for (let t = start.getTime(); t <= now.getTime(); t += stepSec * 1000) {
    const p = groundPoint(satrec, new Date(t));
    if (p) points.push([p.lat, p.lon]);
  }
  return points;
}

function buildForwardTrack(satrec, now, orbits, stepSec) {
  const periodMin = (2 * Math.PI) / satrec.no;
  const totalSec = periodMin * orbits * 60;
  const points = [];
  const end = now.getTime() + totalSec * 1000;
  for (let t = now.getTime(); t <= end; t += stepSec * 1000) {
    const p = groundPoint(satrec, new Date(t));
    if (p) points.push([p.lat, p.lon]);
  }
  return points;
}

function findPasses(satrec, observer, now, minEl, hours, stepSec) {
  const passes = [];
  const end = new Date(now.getTime() + hours * 3600 * 1000);
  let prevEl = null,
    aosTime = null,
    aosAz = null,
    maxEl = minEl;

  for (let t = now.getTime(); t <= end.getTime(); t += stepSec * 1000) {
    const date = new Date(t);
    const look = lookAngles(satrec, observer, date);
    if (!look) continue;
    const el = look.el;
    if (prevEl !== null) {
      if (prevEl < minEl && el >= minEl) {
        aosTime = date;
        aosAz = look.az;
        maxEl = el;
      } else if (prevEl >= minEl && el < minEl && aosTime) {
        passes.push({
          aos: aosTime.toISOString(),
          los: date.toISOString(),
          maxEl,
          aosAz,
        });
        if (passes.length >= 2) break;
        aosTime = null;
      } else if (aosTime && el > maxEl) maxEl = el;
    }
    prevEl = el;
  }
  return passes;
}

function passSkyPath(satrec, observer, aosIso, losIso, stepSec) {
  const points = [];
  const start = new Date(aosIso).getTime();
  const end = new Date(losIso).getTime();
  for (let t = start; t <= end; t += stepSec * 1000) {
    const look = lookAngles(satrec, observer, new Date(t));
    if (look && look.el >= 0) points.push({ az: look.az, el: look.el });
  }
  return points;
}

let currentSatKey = null;
let satrec = null;
let tleNote = "";
let observer = {
  latitude: satellite.degreesToRadians(40.5),
  longitude: satellite.degreesToRadians(-111.9),
  height: 1.324,
};

async function loadSatellite(key) {
  const info = CATALOG[key];
  if (!info || !info.norad)
    throw new Error(`Unknown or non-trackable sat: ${key}`);
  currentSatKey = key;
  const tle = await fetchTLE(info.norad);
  satrec = satellite.twoline2satrec(tle.l1, tle.l2);
  tleNote = tle.note;
  console.log(`Loaded ${info.display || key} (${info.norad}) – ${tleNote}`);
}

function pickDefaultKey() {
  if (CATALOG[DEFAULT_SAT]) return DEFAULT_SAT;
  for (const [k, s] of Object.entries(CATALOG)) {
    if (norm(s.name).includes("RS44")) return k;
  }
  const active = Object.values(CATALOG).find(
    (s) => s.status === "active" && s.norad,
  );
  return active ? active.key : Object.keys(CATALOG)[0] || null;
}

function computeState() {
  if (!satrec) return null;
  const now = new Date();
  const pos = groundPoint(satrec, now);
  const look = lookAngles(satrec, observer, now);
  if (!pos || !look) return null;

  const trail = buildTrail(satrec, now, TRAIL_MINUTES, TRAIL_STEP_SEC);
  const forward = buildForwardTrack(satrec, now, 2, TRAIL_STEP_SEC);
  const passesRaw = findPasses(
    satrec,
    observer,
    now,
    MIN_EL,
    PASS_HOURS,
    PASS_STEP_SEC,
  );
  const passes = passesRaw.map((p) => ({
    aos: p.aos,
    los: p.los,
    maxEl: p.maxEl,
    aosAz: p.aosAz,
    sky: passSkyPath(satrec, observer, p.aos, p.los, PASS_STEP_SEC),
  }));

  const info = CATALOG[currentSatKey] || {};
  return {
    type: "state",
    sat: currentSatKey,
    display: info.display || info.name || currentSatKey,
    uplink: info.uplink || "",
    downlink: info.downlink || "",
    mode: info.mode || "",
    tleNote,
    catalogNote,
    statusNote,
    time: now.toISOString(),
    position: { lat: pos.lat, lon: pos.lon, heightKm: pos.heightKm },
    look: { az: look.az, el: look.el, rangeKm: look.rangeKm },
    trail,
    forward,
    passes,
  };
}

const server = http.createServer((req, res) => {
  let urlPath = req.url === "/" ? "/index.html" : req.url;
  const q = urlPath.includes("?") ? urlPath.split("?")[1] : "";
  urlPath = urlPath.split("?")[0];

  if (urlPath === "/api/sats") {
    const params = new URLSearchParams(q);
    const filter = params.get("filter") || "trackable";
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    return res.end(JSON.stringify(listSatsPayload(filter)));
  }

  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end(`Not found: ${urlPath}`);
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mime[ext] || "application/octet-stream",
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  } else socket.destroy();
});

wss.on("connection", (ws) => {
  console.log("Client connected");
  ws.send(JSON.stringify({ type: "sats", ...listSatsPayload("trackable") }));

  const state = computeState();
  if (state) ws.send(JSON.stringify(state));

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "observer" && typeof msg.lat === "number") {
        observer = {
          latitude: satellite.degreesToRadians(msg.lat),
          longitude: satellite.degreesToRadians(msg.lon),
          height: (msg.elevM || 0) / 1000,
        };
      }
      if (msg.type === "sat" && msg.key) {
        loadSatellite(msg.key)
          .then(() => {
            const s = computeState();
            if (s) broadcast(s);
          })
          .catch((err) => {
            ws.send(JSON.stringify({ type: "error", message: err.message }));
          });
      }
    } catch (e) {
      console.warn("Bad message", e.message);
    }
  });

  ws.on("close", () => console.log("Client disconnected"));
});

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const c of wss.clients) {
    if (c.readyState === 1) c.send(data);
  }
}

setInterval(() => {
  const s = computeState();
  if (s) broadcast(s);
}, 1000);

setInterval(() => {
  refreshCatalog().catch(() => {});
  refreshStatus().catch(() => {});
}, REFRESH_MS);

(async () => {
  await refreshCatalog();
  await refreshStatus();
  const key = pickDefaultKey();
  if (key) await loadSatellite(key);
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Sat Tracker  http://127.0.0.1:${PORT}`);
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
