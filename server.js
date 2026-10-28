const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

/** Build label (lib/version.js): VERSION file (SFX stamp) → git branch+sha → ~/.rpitrack/version → package.json. */
const APP_VERSION_INFO = require("./lib/version").resolveVersion({ dir: __dirname });
const APP_VERSION = APP_VERSION_INFO.version;
console.log("Sat Tracker starting version " + APP_VERSION);

let shuttingDown = false;
function logShutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Sat Tracker shutting down (" + reason + ") version " + APP_VERSION);
}
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    logShutdown(sig);
    setTimeout(() => process.exit(0), 200); // let log stream flush
  });
}
process.on("exit", (code) => logShutdown("exit " + code));
const { WebSocketServer } = require("ws");

// Capture console as early as possible (before radio/rotor registration logs)
const logHub = require("./lib/log-hub");
const { applyEndpointSave, endpointsFromMsg } = require("./lib/endpoint-apply");

const {
  ROOT,
  PORT,
  MIME,
  TCI_URI,
  REFRESH_MS,
  SATS_BROADCAST_MS,
  TICK_MS,
  STATE_MS,
} = require("./lib/config");

const catalog = require("./lib/catalog");
const state = require("./lib/state");
const tle = require("./lib/tle");
const radios = require("./lib/radios");
const rotor = require("./lib/rotor");
const rotors = require("./lib/rotors");
const config = require("./lib/config");
const platform = require("./lib/platform");
const profiles = require("./lib/profiles");
const backup = require("./lib/backup");
const connectionTest = require("./lib/connection-test");
const hamlib = require("./lib/hamlib");

/** /api/hamlib/* — JSON in / out. Update / rollback are POST (start a job; poll status). */
function handleHamlib(req, res, urlPath, qs) {
  const json = (code, o) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(o));
  };
  const fail = (e) => json(500, { ok: false, error: e && e.message ? e.message : String(e) });
  const what = urlPath.slice("/api/hamlib/".length);
  if (what === "models" && req.method === "GET") return hamlib.listModels({ force: qs.get("reload") === "1" }).then((r) => json(200, r), fail);
  if (what === "rotors" && req.method === "GET") return hamlib.listRotors().then((r) => json(200, r), fail);
  if (what === "caps" && req.method === "GET") return hamlib.caps(qs.get("model")).then((r) => json(200, { ok: true, caps: r }), fail);
  if (what === "status" && req.method === "GET") return hamlib.status({ checkLatest: qs.get("latest") === "1" }).then((r) => json(200, r), fail);
  if ((what === "update" || what === "rollback") && req.method === "POST") return json(200, hamlib.startJob(what));
  return json(404, { ok: false, error: "unknown Hamlib request" });
}
const logbook = require("./lib/logbook");
const wsjtxListener = require("./lib/wsjtx-listener");
const wsjtxDecodes = require("./lib/wsjtx-decodes");
const schedule = require("./lib/schedule");
const amsatReport = require("./lib/amsat-report");
const { applyProfileEndpoints } = require("./lib/profile-apply");
const { createRouter: createRadioRoleRouter } = require("./lib/radio-role-router");
/** First applyProfileToRuntime() after boot connects everything (lib/profile-apply.js). */
let profileAppliedOnce = false;

/** WebSocket server; set after createServer. broadcast() is safe before that. */
let wss = null;

function broadcast(obj) {
  if (!wss) return;
  const data = JSON.stringify(obj);
  for (const c of wss.clients) {
    if (c.readyState === 1) c.send(data);
  }
}

state.init({ broadcast });
logHub.setBroadcast(broadcast);
logHub.init({ broadcast });

/** Current logging output settings (from lib/config). */
function logOutputCfg() {
  return {
    method: config.LOG_METHOD,
    adifPath: config.LOG_ADIF_PATH,
    udpHost: config.LOG_UDP_HOST,
    udpPort: config.LOG_UDP_PORT,
    udpFormat: config.LOG_UDP_FORMAT,
    udpTtl: config.LOG_UDP_TTL,
    udpIface: config.LOG_UDP_IFACE,
  };
}

function stationFromProfile(fallback) {
  const prof = profiles.getActive() || {};
  const pcfg = prof.config || {};
  const fb = fallback || {};
  return {
    callsign: String(pcfg.callsign || fb.callsign || "").trim().toUpperCase(),
    grid: pcfg.grid || fb.grid || "",
  };
}

/**
 * Heard stations from WSJT-X Decode (type 2) for the map overlay. Decodes
 * only arrive while the listener gate is open; when it closes the list is
 * kept (not cleared) and simply ages out after DECODE_EXPIRE_MS (60 s, purged
 * every 5 s, so map dots and list rows go ~60 s after the last decode).
 */
const decodeStore = wsjtxDecodes.createStore({
  onChange: () => broadcast(decodeStore.payload()),
  // "Calling us" = addressed to the configured station callsign (never hardcoded).
  // Falls back to WSJT-X's own DE call (Status) when no callsign is configured.
  getMyCall: () => stationFromProfile().callsign || (typeof wsjtx !== "undefined" && wsjtx ? wsjtx.getStatus().deCall : "") || "",
});

/**
 * Worked stations (map / globe "Worked" layer): every QSO logged successfully
 * from the Log box or WSJT-X, kept in ~/.rpitrack/worked.json (lib/worked.js).
 * Display only; the ADIF / UDP output is unchanged.
 */
const worked = require("./lib/worked");
const workedStore = worked.createWorked({
  file: path.join(config.CACHE_DIR, "worked.json"),
  onChange: (p) => broadcast(p),
});
function noteWorked(summary, grid, source, time) {
  try {
    workedStore.add(worked.fromRecord(summary, grid, source, time, logbook.adifDateTime));
  } catch (e) {
    console.warn("Worked list:", e.message);
  }
}

/** Auto AMSAT "Heard" when a QSO is logged (Configure → Logging; default on). */
const amsatAuto = require("./lib/amsat-auto").createAutoHeard({
  amsat: amsatReport,
  getPassWindow: (key, date) => state.getPassWindow(key, date),
  log: (m) => console.log(m),
  notify: (evt) => broadcast(Object.assign({ type: "amsat-auto" }, evt)),
});
/** Fire-and-forget after a successful log; never blocks or fails the log. */
function autoAmsatHeard(ctx, station, time, source) {
  if (!config.LOG_AMSAT_HEARD || !ctx || ctx.isMoon) return; // Moon (EME): no AMSAT report
  setImmediate(() => {
    amsatAuto.fromQso({ ctx, station, time, source }).catch(() => {});
  });
}

/** WSJT-X listener: enrich with sat info and re-send via the logging output. */
const wsjtx = wsjtxListener.createListener({
  onQso: (q) => {
    const ctx = state.getLogContext();
    const e = wsjtxListener.enrichRecord(q.fields, ctx, stationFromProfile());
    const rec = {
      fields: e.fields,
      txHz: e.txHz,
      rxHz: e.rxHz,
      time: new Date(),
      warnings: e.warnings.concat(e.note ? [e.note] : []),
      lotwAccepted: e.lotwAccepted,
    };
    logbook
      .outputRecord(rec, logOutputCfg())
      .then((r) => {
        const out = Object.assign(
          {
            type: "log-result",
            source: "wsjtx",
            wsjtxClient: q.clientId,
            wsjtxMessage: q.source,
            enriched: e.enriched,
          },
          r,
        );
        console.log(
          "WSJT-X QSO",
          q.fields.CALL,
          "from",
          q.clientId,
          q.source,
          e.enriched ? "+ " + (e.fields.SAT_NAME || e.fields.PROP_MODE) : "(pass-through)",
          r.ok ? "-> " + r.method + " " + r.target : "FAILED: " + r.error,
          rec.warnings.length ? rec.warnings.join("; ") : "",
        );
        broadcast(out);
        broadcastWsjtxStatus(); // refresh forwarded count in config
        // Only sat QSOs (enriched with the selected sat) get an AMSAT Heard.
        if (r.ok && e.enriched) autoAmsatHeard(ctx, stationFromProfile(), rec.time, "wsjtx");
        if (r.ok) noteWorked(r.record, e.fields.GRIDSQUARE || "", "wsjtx", rec.time);
      })
      .catch((err) => console.warn("WSJT-X forward:", err.message));
  },
  onStatus: () => broadcastWsjtxStatus(),
  onDecode: (d, id, from) => decodeStore.add(d, Date.now(), from ? Object.assign({ id }, from) : null),
});

function wsjtxStatusPayload() {
  const st = wsjtx.getStatus();
  return Object.assign({ type: "wsjtx-listener" }, st, {
    enabled: config.WSJTX_LISTEN,
    warning: wsjtxListener.outputLoopWarning(
      { enabled: config.WSJTX_LISTEN, port: config.WSJTX_LISTEN_PORT },
      logOutputCfg(),
    ),
  });
}

function broadcastWsjtxStatus() {
  broadcast(wsjtxStatusPayload());
}

/** Gate: the listener runs while Radio is on (Antenna doesn't matter). */
function wsjtxGateState() {
  let radioOn = false;
  let antennaOn = false;
  try {
    const rs = radios.active().getRadioState();
    radioOn = !!(rs && rs.radioOn);
  } catch (_) {}
  try {
    const r = rotor.getRotorState();
    antennaOn = !!(r && r.antennaOn);
  } catch (_) {}
  return { radioOn, antennaOn };
}

function syncWsjtxGate() {
  const g = wsjtxGateState();
  const reason = "Radio must be on";
  if (wsjtx.setGate(g.radioOn, reason)) {
    console.log("WSJT-X listener gate " + (g.radioOn ? "open" : "closed (" + reason + ")"));
  }
}
// Radio/antenna state can also change inside drivers (errors, endpoint
// changes), so poll cheaply in addition to the explicit hooks below.
setInterval(syncWsjtxGate, 500).unref();

function applyWsjtxListener() {
  syncWsjtxGate();
  wsjtx.configure({
    enabled: config.WSJTX_LISTEN,
    port: config.WSJTX_LISTEN_PORT,
    bind: config.WSJTX_LISTEN_BIND,
  });
  broadcastWsjtxStatus();
}

/**
 * APRS / KISS TNC connector (lib/aprs/service.js). Config per profile under
 * profile.config.aprs; RX packets -> list + "APRS Heard" layer + daily log
 * in ~/.rpitrack/aprs/; TX (beacon / message) gated on radio + sat state.
 */
const aprsNormalize = require("./lib/aprs/service").normalizeConfig;
// Configure → KISS / APRS Bluetooth Scan / Pair / Remove / Power on (bluetoothctl)
const btManager = new (require("./lib/kiss/bt-manager").BtManager)();
btManager.on("update", (m) => broadcast(Object.assign({ type: "aprs-bt" }, m)));
const aprsService = require("./lib/aprs/service").createService({
  broadcast: (o) => broadcast(o),
  getStation: () => stationFromProfile(),
  getTxContext: () => {
    let radioOn = false;
    try {
      const rs = radios.active().getRadioState();
      radioOn = !!(rs && rs.radioOn);
    } catch (_) {}
    let sat = null;
    try {
      sat = state.getLogContext();
    } catch (_) {}
    return { radioOn, sat };
  },
});

/** Radio 1 / Radio 2 → UL / DL for the selected sat (lib/radio-role-router.js). */
const radioRoles = createRadioRoleRouter({
  config,
  radios,
  satOffsets: require("./lib/sat-offsets"),
  getConfig: () => {
    const p = profiles.getActive();
    return p && p.config && typeof p.config === "object" ? p.config : {};
  },
});
function broadcastRadioRoles() {
  broadcast(radioRoles.payload(state.getCurrentKey(), profiles.getActiveName()));
}
// A sat (or the Moon) becomes current: put its radio on uplink before its
// offsets / tones are restored (state.loadSatellite runs this first).
// Per-sat Flex profile memory follows the Flex's role (UL / DL).
if (typeof state.setFlexRoleHook === "function") state.setFlexRoleHook(() => radioRoles.flexRole());
state.setSatSelectHook((key) => {
  radioRoles.applyForSat(key, "sat");
  broadcastRadioRoles();
});

function applyProfileToRuntime(prof) {
  if (!prof) return;
  const rolesBefore = radioRoles.appliedKey();
  // Spinner/fine offsets are stored per profile — switch store + re-apply live.
  if (typeof state.setOffsetsProfile === "function")
    state.setOffsetsProfile(profiles.getActiveName());
  state.setFavorites(Array.isArray(prof.favorites) ? prof.favorites : []);
  state.setFavOverlayShown(prof.favOverlay ? prof.favOverlay.shown : null);
  state.setAutoSelect(prof.autoSelect === true);
  state.setAutoEngage(prof.autoEngage === true);
  state.setPassAlerts(prof.alerts);
  const cfg = prof.config && typeof prof.config === "object" ? prof.config : {};
  if (Object.keys(cfg).length) {
    // Re-apply only the radio / rotor whose settings differ from the current
    // ones (one log line per switch); the first call at startup applies all.
    // Two radios: Radio 1 / Radio 2 on UL / DL as saved for the current sat.
    const eff = radioRoles.effective(cfg, state.getCurrentKey());
    applyProfileEndpoints(profiles.getActiveName(), eff, { config, radios, rotor }, { startup: !profileAppliedOnce });
    if (profileAppliedOnce && radioRoles.appliedKey() !== rolesBefore && typeof state.reapplyRadioForCurrentSat === "function")
      state.reapplyRadioForCurrentSat();
  }
  profileAppliedOnce = true;
  broadcastRadioRoles();
  console.log("Radio update:", config.RADIO_UPDATE_MS, "ms");
  if (typeof state.forceRadioPush === "function") state.forceRadioPush();
  applyWsjtxListener();
  aprsService.configure(cfg.aprs, { profile: profiles.getActiveName() });
}

/**
 * Toggle saves ("fav-overlay-set", "auto-select-set", "alerts-set") carrying a
 * client seq: answer the sender after the broadcasts so it knows every later
 * message already includes this change (js/set-guard.js, latest click wins).
 */
function ackSet(ws, msg) {
  if (!msg || !Number.isFinite(msg.seq) || !ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify({ type: "set-ack", seq: msg.seq })); } catch (_) {}
}

function broadcastProfiles() {
  broadcast(profiles.publicPayload());
}

// Load named profiles from ~/.rpitrack/profiles.json and apply active one
profiles.load();
// KISS / APRS settings are per profile (config.aprs): a profile saved before it
// had any gets a copy of the active profile's, so switching never goes blank.
try {
  const n = profiles.backfillConfigKey("aprs");
  if (n) console.log("Profiles: copied KISS / APRS settings into", n, "profile(s)");
} catch (e) {
  console.warn("Profiles: APRS backfill failed:", e.message);
}
// Offsets store initialized as "default" in state.init (before profiles were
// loaded): switch it to the real active profile now, before any sat loads.
if (typeof state.setOffsetsProfile === "function")
  state.setOffsetsProfile(profiles.getActiveName());
applyProfileToRuntime(profiles.getActive());
// Only now (active profile applied) may the profile's radio connect. Drivers
// for other radio types stay closed — no Flex API / serial / rigctl probes.
radios.start();

/** In-memory NORAD → SatNOGS sat_id cache (process lifetime). */
const satnogsCache = new Map();

function fetchSatnogsByNorad(norad) {
  const key = String(norad || "").trim();
  if (!key) return Promise.resolve(null);
  if (satnogsCache.has(key)) return Promise.resolve(satnogsCache.get(key));

  const url =
    "https://db.satnogs.org/api/satellites/?norad_cat_id=" +
    encodeURIComponent(key);
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { headers: { Accept: "application/json", "User-Agent": "pi-sat-track" } },
      (resp) => {
        let body = "";
        resp.on("data", (c) => {
          body += c;
        });
        resp.on("end", () => {
          try {
            const arr = JSON.parse(body);
            const row = Array.isArray(arr) && arr[0] ? arr[0] : null;
            const satId = row && row.sat_id ? String(row.sat_id) : null;
            const payload = satId
              ? {
                  sat_id: satId,
                  norad_cat_id: row.norad_cat_id,
                  name: row.name || null,
                  names: row.names || null,
                  status: row.status || null,
                }
              : null;
            satnogsCache.set(key, payload);
            resolve(payload);
          } catch (e) {
            satnogsCache.set(key, null);
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => {
      resolve(null);
    });
    req.setTimeout(8000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

const staticCache = require("./lib/static-cache");

/**
 * POST /api/restore (?check=1 = validate + summary only). JSON body = the
 * backup file. Requires Content-Type: application/json (a cross-site form post
 * cannot send that without a CORS preflight this server never answers).
 * Writes a safety copy to ~/.rpitrack/backups/pre-restore-<ts>.json, rewrites
 * the config files, then reloads the running config like a profile switch.
 */
function handleRestore(req, res, checkOnly) {
  const json = (code, o) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(o));
  };
  if (req.method !== "POST") return json(405, { ok: false, error: "POST required" });
  if (!/^application\/json\b/i.test(String(req.headers["content-type"] || "")))
    return json(415, { ok: false, error: "Content-Type must be application/json" });
  let body = "";
  let tooBig = false;
  req.on("data", (c) => {
    if (tooBig) return;
    body += c;
    if (body.length > backup.MAX_BYTES) tooBig = true;
  });
  req.on("end", () => {
    if (tooBig) return json(413, { ok: false, error: "File is too large to be a pi-sat-track backup." });
    if (checkOnly) {
      const v = backup.validate(body);
      return json(v.ok ? 200 : 400, v.ok ? { ok: true, summary: v.summary } : { ok: false, error: v.error });
    }
    const satOffsets = require("./lib/sat-offsets");
    satOffsets.flush(); // so the safety copy has every pending offset edit
    let r;
    try {
      r = backup.restore(body, { dir: config.CACHE_DIR, appVersion: APP_VERSION });
    } catch (e) {
      return json(500, { ok: false, error: "Restore failed: " + e.message });
    }
    if (!r.ok) return json(400, { ok: false, error: r.error });
    console.log(
      "Settings restored: " + r.summary.profileNames.length + " profile(s), active " +
        JSON.stringify(r.summary.activeProfile) + "; previous settings saved to " + r.safetyCopy,
    );
    try {
      reloadConfigAfterRestore();
    } catch (e) {
      console.warn("Restore: reload failed:", e.message);
      return json(500, { ok: false, error: "Settings were written but the reload failed (" + e.message + "); restart pi-sat-track.", safetyCopy: r.safetyCopy });
    }
    json(200, { ok: true, summary: r.summary, safetyCopy: r.safetyCopy });
  });
}

/** Re-read every restored file and re-apply the active profile live (no restart). */
function reloadConfigAfterRestore() {
  require("./lib/sat-offsets").reload();
  tle.reloadTleSourcesPref();
  profiles.load();
  try { profiles.backfillConfigKey("aprs"); } catch (_) {}
  applyProfileToRuntime(profiles.getActive());
  if (typeof state.reloadSavedSettings === "function") state.reloadSavedSettings();
  broadcastProfiles();
  const st = state.computeState();
  if (st) broadcast(st);
  const tk = state.computeTick();
  if (tk) broadcast(tk);
  broadcastSats();
  broadcast({ type: "endpoints", ...config.getEndpoints(), rotorCatalog: rotors.catalog() });
  broadcast({ type: "settings-restored" });
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
    return res.end(JSON.stringify(state.satsPayload(filter)));
  }

  // APRS digipeat log export (Messages window → Digipeats → Export CSV)
  if (urlPath === "/api/aprs/digipeats.csv") {
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="aprs-digipeats-' + new Date().toISOString().slice(0, 10) + '.csv"',
      "Cache-Control": "no-store",
    });
    return res.end(aprsService.digipeatsCsv());
  }

  if (urlPath === "/api/version") {
    // Station → Version row: installer build label ("UAT-alpha.43") or branch+sha.
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ version: APP_VERSION, source: APP_VERSION_INFO.source }));
  }

  // Hamlib (lib/hamlib): model list, caps, version / update, rigctld status.
  if (urlPath.startsWith("/api/hamlib/")) return handleHamlib(req, res, urlPath, new URLSearchParams(q));

  // Configure → Station → Backup & restore (lib/backup.js, js/settings-backup.js).
  if (urlPath === "/api/backup" && req.method === "GET") {
    try {
      require("./lib/sat-offsets").flush(); // pending fine-tune edits into the file first
      const b = backup.buildBackup({ dir: config.CACHE_DIR, appVersion: APP_VERSION });
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify(b));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }
  if (urlPath === "/api/restore") {
    return handleRestore(req, res, new URLSearchParams(q).get("check") === "1");
  }

  if (urlPath === "/api/host") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    return res.end(
      JSON.stringify({
        ...platform.hostInfo(),
        rotorCatalog: rotors.catalog(),
        rotorType: config.ROTOR_TYPE,
        rotorAzDevice: config.ROTOR_AZ_DEVICE,
        rotorElDevice: config.ROTOR_EL_DEVICE,
        rotorBaud: config.ROTOR_BAUD,
      }),
    );
  }

  if (urlPath === "/api/amsat-report/suggest" && req.method === "GET") {
    const json = (code, o) => {
      res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(o));
    };
    const lc = state.getLogContext();
    const ctx = lc && lc.isMoon ? null : lc; // Moon (EME) is not an AMSAT satellite
    return amsatReport
      .getSatNames()
      .then((list) => {
        const matches = amsatReport.matchSatNames(list.names, ctx);
        json(200, {
          names: list.names,
          source: list.source,
          sat: ctx ? { key: ctx.satKey, name: ctx.satName, mode: ctx.mode, uplink: ctx.uplink, downlink: ctx.downlink } : null,
          suggestions: matches.map((m) => m.value),
          best: matches.length ? matches[0].value : null,
          // AMSAT mode tag the buttons submit (the "[FM]" in ISS_[FM]): same match as /submit.
          reportMode: matches.length ? amsatReport.splitName(matches[0].value).tag : null,
          reports: amsatReport.REPORTS.map((v) => ({ value: v, label: amsatReport.REPORT_LABELS[v] })),
          utc: amsatReport.utcParts(new Date()),
          station: stationFromProfile(),
          heardThisPass: (() => {
            const h = ctx && ctx.satKey ? amsatAuto.heardThisPass(ctx.satKey) : null;
            return h && !h.pending ? { at: h.at, satName: h.satName, source: h.source } : null;
          })(),
          autoHeard: !!config.LOG_AMSAT_HEARD,
        });
      })
      .catch((e) => json(502, { error: e.message }));
  }

  if (urlPath === "/api/amsat-report/submit") {
    const json = (code, o) => {
      res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(o));
    };
    if (req.method !== "POST") return json(405, { error: "POST required" });
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 10000) req.destroy();
    });
    req.on("end", () => {
      let r;
      try {
        r = JSON.parse(body || "{}");
      } catch (_) {
        return json(400, { error: "invalid JSON" });
      }
      const lc = state.getLogContext();
      const btnCtx = lc && lc.isMoon ? null : lc; // Moon (EME) is not an AMSAT satellite
      amsatReport
        .getSatNames()
        .then((list) =>
          amsatReport.fillReport(r, {
            names: list.names,
            ctx: btnCtx,
            station: stationFromProfile({ callsign: r.fallbackCallsign, grid: r.fallbackGrid }),
          }),
        )
        .then((full) => {
          delete full.fallbackCallsign;
          delete full.fallbackGrid;
          console.log("AMSAT report: user submit " + full.satName + " " + full.report + " " + full.callsign);
          return amsatReport.submitReport(full).then((out) => Object.assign(out, { satName: full.satName, report: full.report }));
        })
        .then((out) => {
          console.log("AMSAT report: " + out.message);
          if (out.report === "Heard" && btnCtx && btnCtx.satKey)
            amsatAuto.noteSent(btnCtx.satKey, { satName: out.satName, source: "button" });
          json(200, out);
        })
        .catch((e) => {
          console.log("AMSAT report failed: " + e.message);
          json(e.status || 500, { error: e.message });
        });
    });
    return;
  }

  if (urlPath === "/api/satnogs") {
    const params = new URLSearchParams(q);
    const norad = params.get("norad");
    if (!norad) {
      res.writeHead(400, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      return res.end(JSON.stringify({ error: "norad required" }));
    }
    return fetchSatnogsByNorad(norad).then((payload) => {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=86400",
      });
      res.end(JSON.stringify(payload || { sat_id: null, norad_cat_id: norad }));
    });
  }

  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.stat(filePath, (serr, stat) => {
    if (serr || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found: " + urlPath);
    }
    // Static UI files: always revalidate (no-cache + ETag of version / size /
    // mtime), so a browser reload after an update never runs stale JS / CSS.
    const etag = staticCache.etagFor(APP_VERSION, stat);
    const headers = staticCache.headersFor(etag);
    if (staticCache.notModified(req, etag)) {
      res.writeHead(304, headers);
      return res.end();
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("Not found: " + urlPath);
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, Object.assign({ "Content-Type": MIME[ext] || "application/octet-stream" }, headers));
      res.end(data);
    });
  });
});

wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  } else {
    socket.destroy();
  }
});

function broadcastSats() {
  broadcast({ type: "sats", ...state.satsPayload("trackable") });
}

function pushNow() {
  const tk = state.computeTick({ forceRadio: true });
  if (tk) broadcast(tk);
}

let wsClientSeq = 0;
/** Load + persist + broadcast a new selected sat (user pick or After-LOS auto select). */
function selectSat(key) {
  return state.loadSatellite(key).then(() => {
    profiles.updateActive({ lastSat: key });
    const st = state.computeState();
    if (st) broadcast(st);
    const tk = state.computeTick();
    if (tk) broadcast(tk);
    broadcastSats();
  });
}

wss.on("connection", (ws, req) => {
  ws._clientTag =
    "client #" + ++wsClientSeq +
    " " + ((req && req.socket && req.socket.remoteAddress) || "?");
  console.log("Client connected", ws._clientTag);
  logHub.sendHistory(ws);
  ws.send(JSON.stringify({ type: "sats", ...state.satsPayload("trackable") }));
  ws.send(
    JSON.stringify({
      type: "host",
      ...platform.hostInfo(),
      rotorCatalog: rotors.catalog(),
      rotorType: config.ROTOR_TYPE,
      rotorAzDevice: config.ROTOR_AZ_DEVICE,
      rotorElDevice: config.ROTOR_EL_DEVICE,
      rotorBaud: config.ROTOR_BAUD,
      tleSources: tle.getTleSources(),
    }),
  );
  ws.send(JSON.stringify(profiles.publicPayload()));
  ws.send(JSON.stringify(radioRoles.payload(state.getCurrentKey(), profiles.getActiveName())));
  ws.send(JSON.stringify(wsjtxStatusPayload()));
  ws.send(
    JSON.stringify({
      type: "endpoints",
      ...config.getEndpoints(),
      rotorCatalog: rotors.catalog(),
    }),
  );
  ws.send(JSON.stringify(decodeStore.payload()));
  ws.send(JSON.stringify(workedStore.payload()));
  ws.send(JSON.stringify(aprsService.statusPayload()));
  ws.send(JSON.stringify(aprsService.packetsPayload()));
  ws.send(JSON.stringify(aprsService.heardPayload()));
  ws.send(JSON.stringify(aprsService.digipeatsPayload()));
  // Re-send shortly after: the sidebar logging script hooks the socket
  // asynchronously and can miss the first message.
  setTimeout(() => {
    try {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify(wsjtxStatusPayload()));
        ws.send(
          JSON.stringify({
            type: "endpoints",
            ...config.getEndpoints(),
            rotorCatalog: rotors.catalog(),
          }),
        );
        ws.send(JSON.stringify(decodeStore.payload()));
        ws.send(JSON.stringify(aprsService.statusPayload()));
        ws.send(JSON.stringify(aprsService.heardPayload()));
        ws.send(JSON.stringify(aprsService.digipeatsPayload()));
      }
    } catch (_) {}
  }, 1500);
  radios.broadcastAllStatus();
  rotor.broadcastStatus();

  const s = state.computeState();
  if (s) ws.send(JSON.stringify(s));
  const t = state.computeTick();
  if (t) ws.send(JSON.stringify(t));

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "aprs-config" && msg.aprs && typeof msg.aprs === "object") {
        // KISS clients are restarted only for connections whose transport changed (syncClients)
        const c = aprsService.configure(msg.aprs, { profile: profiles.getActiveName() });
        profiles.updateActive({ config: { aprs: c } });
        broadcastProfiles();
        const st = stationFromProfile();
        const call = String((st && st.callsign) || "").trim().toUpperCase().split("-")[0];
        const conns = Array.isArray(c.connections) ? c.connections : [];
        console.log(
          "APRS config saved (profile " + profiles.getActiveName() + "): " + (call ? call + (c.ssid ? "-" + c.ssid : "") : "no callsign") +
            ", KISS " + (c.enabled ? "on" : "off") + ", " + conns.filter((x) => x.enabled).length + "/" + conns.length + " connections enabled",
        );
      }
      if (msg.type === "aprs-send") {
        const r = aprsService.send(msg);
        ws.send(JSON.stringify(Object.assign({ type: "aprs-send-result", reqId: msg.reqId }, r)));
        if (!r.ok) console.log("APRS send blocked:", r.reasons.join("; "));
      }
      if (msg.type === "aprs-sat-path" && typeof msg.sat === "string") {
        const cur = aprsService.getConfig();
        const sp = Object.assign({}, cur.satPaths);
        const key = msg.sat.trim().toUpperCase();
        if (key) {
          if (msg.via == null || String(msg.via).trim() === "") delete sp[key];
          else sp[key] = String(msg.via).trim().toUpperCase();
          const c = aprsService.configure(Object.assign({}, cur, { satPaths: sp }), { profile: profiles.getActiveName() });
          profiles.updateActive({ config: { aprs: c } });
          broadcastProfiles();
        }
      }
      if (msg.type === "aprs-bt-devices") {
        // Paired Bluetooth devices (bluetoothctl) for Configure's picker
        aprsService.btDevices().then((r) => {
          if (ws.readyState === 1) ws.send(JSON.stringify(Object.assign({ type: "aprs-bt-devices", id: typeof msg.id === "string" ? msg.id.slice(0, 16) : "" }, r)));
        });
      }
      // Bluetooth setup from Configure (same socket as the rest of Configure)
      if (msg.type === "aprs-bt-scan") {
        const id = typeof msg.id === "string" ? msg.id.slice(0, 16) : "";
        if (msg.action === "stop") btManager.stopScan();
        else btManager.startScan({ owner: ws, id });
      }
      if (msg.type === "aprs-bt-pair" && typeof msg.mac === "string") {
        btManager.pair(msg.mac, { owner: ws, id: typeof msg.id === "string" ? msg.id.slice(0, 16) : "" });
      }
      if (msg.type === "aprs-bt-pair-reply") btManager.pairReply(msg.answer);
      if (msg.type === "aprs-bt-pair-cancel") btManager.cancelPair();
      if (msg.type === "aprs-bt-unpair" || msg.type === "aprs-bt-power") {
        const id = typeof msg.id === "string" ? msg.id.slice(0, 16) : "";
        (msg.type === "aprs-bt-power" ? btManager.powerOn() : btManager.unpair(msg.mac)).then((r) => {
          if (ws.readyState === 1) ws.send(JSON.stringify(Object.assign({ type: "aprs-bt", id }, r)));
        });
      }
      if (msg.type === "aprs-clear") aprsService.clear();
      if (msg.type === "aprs-clear-heard") aprsService.clearHeard();
      if (msg.type === "aprs-reconnect") aprsService.reconnect();
      if (msg.type === "aprs-test") {
        // One-shot probe with the (unsaved) form values; never sends a frame.
        const probe = msg.transport === "bluetooth" ? aprsService.testBt(msg.btAddress, msg.btChannel) : aprsService.testTcp(msg.host, msg.port);
        probe.then((r) => {
          // id = the Configure connection row that asked (several KISS connections)
          const id = typeof msg.id === "string" ? msg.id.slice(0, 16) : "";
          if (ws.readyState === 1) ws.send(JSON.stringify(Object.assign({ type: "aprs-test-result", id }, r)));
        });
      }

      if (msg.type === "observer" && typeof msg.lat === "number") {
        state.setObserver(msg.lat, msg.lon, msg.elevM);
      }

      if (msg.type === "tle-sources" && Array.isArray(msg.sources)) {
        const next = tle.setTleSources(msg.sources);
        broadcast({ type: "tle-sources", sources: next });
      }

      if (msg.type === "favorites" && Array.isArray(msg.keys)) {
        state.setFavorites(msg.keys);
        const pf = profiles.updateActive({ favorites: msg.keys });
        state.setFavOverlayShown(pf.favOverlay ? pf.favOverlay.shown : null);
        broadcastProfiles();
        const tk = state.computeTick();
        if (tk) broadcast(tk);
      }

      if (msg.type === "mode" && typeof msg.index === "number") {
        state.setModeIndex(msg.index);
        const tk = state.computeTick();
        if (tk) broadcast(tk);
        const st = state.computeState();
        if (st) broadcast(st);
        pushNow();
      }

      if (msg.type === "sat" && msg.key && msg.user !== true) {
        // Old/stale clients push their remembered sat on connect. Once the
        // server has a sat, only explicit user selections may change it.
        const cur = state.getCurrentKey();
        if (cur) {
          console.log(
            "Ignored non-user sat request",
            msg.key,
            "(keeping",
            cur + ")",
          );
          const st = state.computeState();
          if (st) ws.send(JSON.stringify(st));
          return;
        }
      }

      if (msg.type === "sat" && msg.key && msg.key === state.getCurrentKey()) {
        // Already selected (e.g. a chart click on the selected sat's pass from an
        // older client): no reload / offset restore; resync this client only.
        console.log("Sat", msg.key, "already selected (no reload)");
        const st = state.computeState();
        if (st) ws.send(JSON.stringify(st));
        const tk = state.computeTick();
        if (tk) ws.send(JSON.stringify(tk));
        return;
      }

      if (msg.type === "sat" && msg.key) {
        // Manual selection: normal switch behavior (immediate preposition).
        rotor.deferSwitchPrep(null);
        selectSat(msg.key).catch((err) => {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        });
      }

      if (msg.type === "radio-roles-get") {
        ws.send(JSON.stringify(radioRoles.payload(state.getCurrentKey(), profiles.getActiveName())));
        return;
      }

      if (msg.type === "radio-role-set") {
        // Frequencies panel: which radio is on uplink for this sat (the other
        // one is on downlink). Saved per profile, per sat (sat-offsets ulRadio).
        // off: "ul" | "dl" | null disables one leg (simplex sats on one radio).
        const key = typeof msg.sat === "string" && msg.sat ? msg.sat : state.getCurrentKey();
        const off = msg.off === undefined ? undefined : msg.off === "ul" || msg.off === "dl" ? msg.off : null;
        if (key && radioRoles.setForSat(key, msg.ulRadio, off)) {
          if (key === state.getCurrentKey()) {
            if (typeof state.persistCurrentOffsets === "function") state.persistCurrentOffsets();
            if (radioRoles.applyForSat(key, "panel") && typeof state.reapplyRadioForCurrentSat === "function")
              state.reapplyRadioForCurrentSat();
          }
        }
        broadcastRadioRoles();
        pushNow();
        return;
      }

      if (msg.type === "auto-select-set") {
        // Top-bar Auto Select button: saved per profile, synced to all clients.
        const pf = profiles.updateActive({ autoSelect: msg.on === true });
        state.setAutoSelect(pf.autoSelect === true);
        console.log("Auto Select", pf.autoSelect ? "ON" : "OFF");
        broadcastProfiles();
        const st = state.computeState();
        if (st) broadcast(st);
        ackSet(ws, msg);
        return;
      }

      if (msg.type === "auto-engage-set") {
        // Top-bar Auto Engage button: saved per profile, synced to all clients.
        // Separate from the pass alert bells.
        const pf = profiles.updateActive({ autoEngage: msg.on === true });
        state.setAutoEngage(pf.autoEngage === true);
        console.log("Auto Engage", pf.autoEngage ? "ON" : "OFF");
        broadcastProfiles();
        stateCycle(false); // toggled on mid-pass / within T-5: engage now
        ackSet(ws, msg);
        return;
      }

      if (msg.type === "auto-engage-passes-set" && Array.isArray(msg.passes)) {
        // Per-pass Auto Engage marks + skips under the button (top bar / Next
        // Passes / Preview icon), per profile.
        const patch = { autoEngagePasses: msg.passes };
        if (Array.isArray(msg.skips)) patch.autoEngageSkips = msg.skips;
        const pf = profiles.updateActive(patch);
        const fmtList = (l) => (l.length ? l.map((p) => p.key + "@" + new Date(p.aosMs).toTimeString().slice(0, 5)).join(", ") : "none");
        console.log("Auto Engage passes:", fmtList(pf.autoEngagePasses), "| skipped:", fmtList(pf.autoEngageSkips));
        broadcastProfiles();
        stateCycle(false);
        ackSet(ws, msg);
        return;
      }

      if (msg.type === "alerts-set" && msg.alerts && typeof msg.alerts === "object") {
        // Pass alert bells: saved per profile, synced to all clients (each
        // browser fires its own AOS−5 / AOS alerts from state.alertPasses).
        const pf = profiles.updateActive({ alerts: msg.alerts });
        state.setPassAlerts(pf.alerts);
        broadcastProfiles();
        const st = state.computeState();
        if (st) broadcast(st);
        ackSet(ws, msg);
        return;
      }

      if (msg.type === "fav-overlay-set") {
        // Map Favorites overlay state saved in the active profile.
        const patch = {};
        if (msg.on !== undefined) patch.on = !!msg.on;
        if (msg.shown === null || Array.isArray(msg.shown)) patch.shown = msg.shown;
        if (typeof msg.footprints === "boolean") patch.footprints = msg.footprints;
        const pf = profiles.updateActive({ favOverlay: patch });
        state.setFavOverlayShown(pf.favOverlay ? pf.favOverlay.shown : null);
        broadcastProfiles();
        broadcastFavTracks(true);
        const fp = favProfileCached(false);
        if (fp) broadcast(fp);
        ackSet(ws, msg);
        return;
      }
      if (msg.type === "globe-orbits-get" && Number.isFinite(msg.t)) {
        // Pass preview: orbits starting at the preview time (not cached).
        ws.send(JSON.stringify(Object.assign({ sig: state.favProfileSig(), preview: true }, state.computeGlobeOrbits(new Date(msg.t), 100))));
        return;
      }
      if (msg.type === "globe-orbits-get") {
        // 3D globe: cached; recomputed on sat / favorites / TLE change or after 10 min.
        const sig = state.favProfileSig();
        const c = globeOrbitsCache;
        if (!c.data || c.sig !== sig || Date.now() - c.data.time > 10 * 60 * 1000) {
          c.data = state.computeGlobeOrbits(new Date(), 100);
          c.sig = sig;
        }
        ws.send(JSON.stringify(Object.assign({ sig: c.sig }, c.data)));
        return;
      }
      if (msg.type === "preview-get" && Number.isFinite(msg.t)) {
        // Pass preview at time T (selected + shown favorites).
        ws.send(JSON.stringify(state.computePreview(msg.t)));
        return;
      }
      if (msg.type === "fav-profile-get") {
        const fp = favProfileCached();
        if (fp) ws.send(JSON.stringify(fp));
        return;
      }
      if (msg.type === "fav-tracks-get") {
        ws.send(JSON.stringify(state.computeFavoriteTracks()));
        return;
      }
      if (msg.type === "call-grid-lookup") {
        // Logging-panel callsign → grid. Prefer a recent WSJT-X decode (no
        // network), else the Sked Finder g7vrd lookup (shared 30 min cache).
        const cs = String(msg.call || "").trim().toUpperCase();
        const reply = (o) => ws.send(JSON.stringify(Object.assign({ type: "call-grid", reqId: msg.reqId, call: cs }, o)));
        const heard = decodeStore.list().find((s) => s.call === cs);
        if (heard && heard.grid) {
          reply({ ok: true, grid: heard.grid, source: "wsjtx" });
        } else {
          schedule.callsignGrid(cs).then((r) => reply({ ok: true, grid: r.grid, source: r.source || "g7vrd" }))
            .catch((e) => reply({ ok: false, error: e.message }));
        }
        return;
      }
      if (msg.type === "schedule-lookup") {
        const q = String(msg.query || "").trim();
        const reply = (o) => ws.send(JSON.stringify(Object.assign({ type: "schedule-lookup", reqId: msg.reqId, query: q }, o)));
        if (schedule.isGrid(q)) {
          reply({ ok: true, grid: q.length >= 6 ? q.slice(0, 4).toUpperCase() + q.slice(4, 6).toLowerCase() : q.toUpperCase(), source: "grid" });
        } else {
          schedule.callsignGrid(q).then((r) => reply(Object.assign({ ok: true, callsign: q.toUpperCase() }, r)))
            .catch((e) => reply({ ok: false, error: e.message }));
        }
        return;
      }
      if (msg.type === "schedule-find") {
        const reply = (o) => ws.send(JSON.stringify(Object.assign({ type: "schedule-result", reqId: msg.reqId }, o)));
        const grid = String(msg.grid || "").trim();
        const remote = schedule.gridToLatLon(grid);
        if (!remote) { reply({ ok: false, error: "Enter a valid 4 or 6 character grid (e.g. FN31 or FN31pr)." }); return; }
        const obs = state.getObserver();
        const home = { lat: obs.latitude * 180 / Math.PI, lon: obs.longitude * 180 / Math.PI, heightKm: obs.height };
        // Sked minEl: use rotor floor when > 0; else 10° usable default (lib resolveScheduleMinEl).
        // Rotor min 0 tracks to horizon — that made HEO mutual ≈ full-pass length in the table.
        const rotorMinEl = Number.isFinite(config.ROTOR_MIN_EL) ? config.ROTOR_MIN_EL : 0;
        const t0 = Date.now();
        schedule.findSchedule({ home, remote, hours: msg.hours === 48 ? 48 : 24, rotorMinEl })
          .then((r) => {
            console.log("Schedule " + grid + " " + r.hours + "h: " + r.rows.length + " windows, " + r.satsChecked + " sats, " + (Date.now() - t0) + "ms");
            reply(Object.assign({ ok: true, grid, remote, home, homeGrid: stationFromProfile().grid || "" }, r));
          })
          .catch((e) => reply({ ok: false, error: e.message }));
        return;
      }

      if (msg.type === "worked-clear") {
        workedStore.clear();
        console.log("Worked stations cleared");
        return;
      }
      if (msg.type === "worked-get") {
        ws.send(JSON.stringify(workedStore.payload()));
        return;
      }
      if (msg.type === "wsjtx-reply") {
        // Map / station-list click on a decoded station: answer it in WSJT-X
        // (UDP Reply 4 = double-clicking that decode), sent back to the WSJT-X
        // instance + address the decode came from.
        const call = String(msg.call || "").trim().toUpperCase();
        const out = (o) => ws.send(JSON.stringify(Object.assign({ type: "wsjtx-reply-result", call, reqId: msg.reqId || null }, o)));
        const st = wsjtx.getStatus();
        if (!st.connected) return out({ ok: false, error: "WSJT-X is not connected" });
        const r = decodeStore.replyFor(call);
        if (!r) return out({ ok: false, error: "No recent decode from " + (call || "that station") });
        wsjtx
          .sendReply(r.target, r.id, r.decode)
          .then(() => {
            console.log("WSJT-X Reply →", r.id, r.target.address + ":" + r.target.port, JSON.stringify(r.decode.message));
            out({ ok: true, message: r.decode.message, to: r.target.address + ":" + r.target.port, client: r.id });
          })
          .catch((e) => out({ ok: false, error: e.message }));
        return;
      }
      if (msg.type === "clear-decodes") {
        decodeStore.clear();
        console.log("WSJT-X spots cleared");
        return;
      }
      if (msg.type === "radio") {
        autoEngage.userSet("radio", !!msg.on);
        radios.setRadio(!!msg.on, ws._clientTag || "client");
        syncWsjtxGate();
      }

      if (msg.type === "dataMode") {
        // USB-D/LSB-D on linear sats; no-op on radios without the capability
        if (state.setDataMode(!!msg.on)) pushNow();
      }

      if (msg.type === "cwMode") {
        // CW on linear sats (UL+DL CW); exclusive with Data; no-op if unsupported
        if (state.setCwMode(!!msg.on)) pushNow();
      }

      if (msg.type === "flexProfile") {
        // SmartSDR global profile per sat ("" = no change); Flex only
        if (state.setFlexProfile(msg.name != null ? msg.name : "")) pushNow();
      }

      if (msg.type === "radioUpdateMs") {
        const before = config.RADIO_UPDATE_MS;
        const ms = config.setRadioUpdateMs(msg.ms);
        if (ms !== before) console.log("Radio update:", ms, "ms");
        profiles.updateActive({ config: { radioUpdateMs: ms } });
        broadcastProfiles();
        broadcast({
          type: "endpoints",
          ...config.getEndpoints(),
          rotorCatalog: rotors.catalog(),
        });
        pushNow();
      }

      if (msg.type === "ulFixed") {
        state.setUlFixed(!!msg.on);
        pushNow();
      }

      if (msg.type === "antenna") {
        autoEngage.userSet("antenna", !!msg.on);
        rotor.setAntenna(!!msg.on);
        syncWsjtxGate();
      }

      if (msg.type === "park") {
        autoEngage.userSet("antenna", false); // manual park takes the antenna over
        rotor.park();
      }

      if (msg.type === "fine") {
        const r = radios.active();
        const side = msg.side === "dl" ? "dl" : "ul";
        if (typeof msg.step === "number" && r.setStep) r.setStep(msg.step);
        if (typeof msg.delta === "number" && r.adjustFine)
          r.adjustFine(msg.delta, side);
        // Persist UL/DL fine for this sat so next load restores it
        if (typeof state.persistCurrentOffsets === "function")
          state.persistCurrentOffsets();
        pushNow();
      }

      if (msg.type === "center") {
        radios.active().center();
        // Center = clear saved calibration for current sat
        if (typeof state.clearPersistedOffsets === "function")
          state.clearPersistedOffsets();
        pushNow();
      }

      if (msg.type === "ctcss") {
        const which =
          msg.which === "access" || msg.which === "activation"
            ? msg.which
            : "off";
        const r = radios.active();
        if (typeof r.setCtcss === "function") r.setCtcss(which);
        pushNow();
      }

      if (msg.type === "endpoints") {
        const ep = endpointsFromMsg(msg);
        const rolesBefore = radioRoles.appliedKey();
        // Only re-open what changed: Configure's Save sends the full form even
        // when only APRS / KISS settings were edited (lib/endpoint-apply.js).
        // Two radios: applied with the current sat's UL radio (saved as is).
        applyEndpointSave(radioRoles.effective(ep, state.getCurrentKey()), {
          config,
          radios,
          rotor,
          rotors,
          applyWsjtx: applyWsjtxListener,
          debug: process.env.PST_DEBUG ? (m, o) => console.debug(m, o) : null,
        });

        const cfgPatch = Object.assign({}, ep);
        Object.assign(cfgPatch, logbook.normalizeStationFields(msg));
        if (typeof msg.elevation === "number")
          cfgPatch.elevation = msg.elevation;
        // Display units (Configure → Station → Units): screen only, per profile.
        if (msg.units !== undefined) cfgPatch.units = profiles.normalizeUnits(msg.units);
        profiles.updateActive({ config: cfgPatch });
        broadcastProfiles();
        if (radioRoles.appliedKey() !== rolesBefore && typeof state.reapplyRadioForCurrentSat === "function")
          state.reapplyRadioForCurrentSat();
        broadcastRadioRoles();

        broadcast({
          type: "endpoints",
          ...config.getEndpoints(),
          rotorCatalog: rotors.catalog(),
        });
      }

      if (msg.type === "log-qso") {
        const station = stationFromProfile({
          callsign: msg.stationCallsign,
          grid: msg.stationGrid,
        });
        const qsoTime = new Date();
        const logCtx = state.getLogContext();
        const dxGrid = (() => {
          if (schedule.isGrid(String(msg.dxGrid || ""))) return String(msg.dxGrid);
          const cs = String(msg.call || "").trim().toUpperCase();
          const h = decodeStore.list().find((s) => s.call === cs);
          return h && h.grid ? h.grid : "";
        })();
        logbook
          .logQso({
            now: qsoTime,
            call: msg.call,
            dxGrid,
            ctx: logCtx,
            station,
            cfg: logOutputCfg(),
          })
          .then((r) => {
            if (r.ok) {
              console.log(
                "QSO logged",
                r.record.call,
                r.record.satName,
                r.record.mode,
                r.record.freq,
                "->",
                r.method,
                r.target,
                r.warnings && r.warnings.length ? r.warnings.join("; ") : "",
              );
            } else {
              console.warn("QSO log failed:", r.error);
            }
            ws.send(
              JSON.stringify(
                Object.assign({ type: "log-result", reqId: msg.reqId || null }, r),
              ),
            );
            if (r.ok) autoAmsatHeard(logCtx, station, qsoTime, "log");
            if (r.ok) noteWorked(r.record, dxGrid, "log", qsoTime);
          })
          .catch((e) => {
            ws.send(
              JSON.stringify({
                type: "log-result",
                reqId: msg.reqId || null,
                ok: false,
                error: e.message || "Log error",
              }),
            );
          });
        return;
      }

      if (msg.type === "test-rotor-step") {
        const reqId = msg.reqId || null;
        console.log(
          "Test rotor step",
          msg.action,
          msg.axis,
          connectionTest.rotorTestDevice(msg),
        );
        connectionTest
          .testRotorStep(msg, {
            onProgress: (p) => {
              try {
                ws.send(
                  JSON.stringify({
                    type: "test-rotor-progress",
                    reqId,
                    axis: p.axis,
                    pos: p.pos,
                    target: p.target,
                    phase: p.phase,
                  }),
                );
              } catch (_) {}
            },
          })
          .then((r) => {
            console.log(
              "Test rotor step result",
              msg.action,
              msg.axis,
              r.ok,
              r.message,
            );
            ws.send(
              JSON.stringify({
                type: "test-rotor-step-result",
                reqId,
                ok: !!r.ok,
                message: r.message || "",
                detail: r.detail || null,
              }),
            );
          })
          .catch((e) => {
            console.warn("Test rotor step error", e.message);
            ws.send(
              JSON.stringify({
                type: "test-rotor-step-result",
                reqId,
                ok: false,
                message: e.message || "Test error",
              }),
            );
          });
        return;
      }

      if (msg.type === "test-radio") {
        const side = msg.side === "dl" ? "dl" : "ul";
        const target = "radio-" + side;
        console.log(
          "Test radio",
          side,
          msg.radio && msg.radio.transport,
          msg.radio &&
            (msg.radio.serialDevice ||
              msg.radio.tciEndpoint ||
              msg.radio.catEndpoint ||
              msg.radio.rigctlEndpoint),
        );
        const radioCfg = Object.assign({}, msg.radio || {}, {
          _testSide: side,
        });
        connectionTest
          .testRadioSide(radioCfg)
          .then((r) => {
            console.log("Test radio result", target, r.ok, r.message);
            ws.send(
              JSON.stringify({
                type: "test-result",
                target,
                ok: !!r.ok,
                message: r.message || "",
                detail: r.detail || null,
              }),
            );
          })
          .catch((e) => {
            console.warn("Test radio error", target, e.message);
            ws.send(
              JSON.stringify({
                type: "test-result",
                target,
                ok: false,
                message: e.message || "Test error",
              }),
            );
          });
        return;
      }

      if (msg.type === "test-rotor") {
        console.log("Test rotor", msg.rotor);
        connectionTest
          .testRotor(msg.rotor || {})
          .then((r) => {
            console.log("Test rotor result", r.ok, r.message);
            ws.send(
              JSON.stringify({
                type: "test-result",
                target: "rotor",
                ok: !!r.ok,
                message: r.message || "",
                detail: r.detail || null,
              }),
            );
          })
          .catch((e) => {
            console.warn("Test rotor error", e.message);
            ws.send(
              JSON.stringify({
                type: "test-result",
                target: "rotor",
                ok: false,
                message: e.message || "Test error",
              }),
            );
          });
        return;
      }

      // Configure's profile selector: load a profile's values into the form only.
      // Nothing is saved or applied (radio / rotor / KISS / logging) until Save,
      // which then sends profile-select.
      if (msg.type === "profile-peek" && msg.name) {
        const p = profiles.getProfile(msg.name);
        const cfg = p && p.config && typeof p.config === "object" ? p.config : {};
        ws.send(
          JSON.stringify(
            p
              ? { type: "profile-peek", name: profiles.sanitizeName(msg.name), config: cfg, aprs: aprsNormalize(cfg.aprs) }
              : { type: "profile-peek", name: msg.name, error: "Unknown profile" },
          ),
        );
        return;
      }

      if (msg.type === "profile-select" && msg.name) {
        if (profiles.setActive(msg.name)) {
          applyProfileToRuntime(profiles.getActive());
          broadcastProfiles();
          const st = state.computeState();
          if (st) broadcast(st);
          const tk = state.computeTick();
          if (tk) broadcast(tk);
          broadcastSats();
          broadcast({
            type: "endpoints",
            ...config.getEndpoints(),
            rotorCatalog: rotors.catalog(),
          });
        } else {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Unknown profile: " + msg.name,
            }),
          );
        }
      }

      if (msg.type === "profile-create" && msg.name) {
        if (profiles.createProfile(msg.name, msg.fromActive !== false)) {
          applyProfileToRuntime(profiles.getActive());
          broadcastProfiles();
          broadcast({
            type: "endpoints",
            ...config.getEndpoints(),
            rotorCatalog: rotors.catalog(),
          });
        } else {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Could not create profile (name empty or exists)",
            }),
          );
        }
      }

      if (msg.type === "profile-delete" && msg.name) {
        if (profiles.deleteProfile(msg.name)) {
          applyProfileToRuntime(profiles.getActive());
          broadcastProfiles();
          const st = state.computeState();
          if (st) broadcast(st);
          const tk = state.computeTick();
          if (tk) broadcast(tk);
          broadcastSats();
          broadcast({
            type: "endpoints",
            ...config.getEndpoints(),
            rotorCatalog: rotors.catalog(),
          });
        } else {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Could not delete profile",
            }),
          );
        }
      }

      if (msg.type === "profile-rename" && msg.from && msg.to) {
        const oldActive = profiles.getActiveName();
        if (profiles.renameProfile(msg.from, msg.to)) {
          // Carry the profile's per-sat offsets over to its new name.
          const satOffsets = require("./lib/sat-offsets");
          if (oldActive !== profiles.getActiveName())
            satOffsets.renameProfile(oldActive, profiles.getActiveName());
          else if (typeof profiles.sanitizeName === "function")
            satOffsets.renameProfile(profiles.sanitizeName(msg.from), profiles.sanitizeName(msg.to));
          broadcastProfiles();
        } else {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Could not rename profile",
            }),
          );
        }
      }

      if (msg.type === "profile-save") {
        const patch = {};
        if (Array.isArray(msg.favorites)) patch.favorites = msg.favorites;
        if (msg.config && typeof msg.config === "object")
          patch.config = msg.config;
        if (msg.lastSat !== undefined) patch.lastSat = msg.lastSat;
        profiles.updateActive(patch);
        if (patch.config) {
          const pc = (profiles.getActive() || {}).config || {};
          const flags = config.applyEndpoints(radioRoles.effective(patch.config, state.getCurrentKey(), pc));
          radios.applyEndpointChange(flags);
          if (flags.rotorChanged) rotor.applyEndpointChange();
          applyWsjtxListener();
        }
        if (Array.isArray(patch.favorites)) {
          state.setFavorites(patch.favorites);
          const pf = profiles.getActive();
          state.setFavOverlayShown(pf.favOverlay ? pf.favOverlay.shown : null);
        }
        broadcastProfiles();
        broadcast({
          type: "endpoints",
          ...config.getEndpoints(),
          rotorCatalog: rotors.catalog(),
        });
        const tk = state.computeTick();
        if (tk) broadcast(tk);
      }
    } catch (e) {
      console.warn("Bad message", e.message);
    }
  });

  ws.on("close", () => {
    btManager.release(ws); // stop its Bluetooth scan / pairing
    console.log("Client disconnected");
  });
});

setInterval(() => {
  const t = state.computeTick();
  if (t) broadcast(t);
}, TICK_MS);

// After-LOS actions once the selected sat's pass ends: Park (Configure → Rotor
// → After LOS) and/or Auto Select (top-bar button). Real time only (client
// preview never fires them).
const afterLosWatch = require("./lib/after-los").createWatcher({
  log: (m) => console.log(m),
  park: () => rotor.afterLosPark(),
  selectSat: (key) => {
    // Auto select: hold the rotor until the new sat's normal T-5 preposition.
    rotor.deferSwitchPrep(key);
    return selectSat(key).catch((e) => {
      rotor.deferSwitchPrep(null);
      throw e;
    });
  },
  notify: (evt) => broadcast({ type: "after-los", ...evt }),
});

// Auto Engage (top-bar button + per-pass marks): Radio + Antenna on at T-5,
// off after LOS — only what it turned on. Uses the same enable paths as the
// Radio / Antenna buttons, so the UI reflects it. See lib/auto-engage.js.
const autoEngage = require("./lib/auto-engage").createEngine({
  log: (m) => console.log(m),
  radioAvailable: () => {
    try { return radios.active().meta.id !== "none"; } catch (_) { return false; }
  },
  radioOn: () => wsjtxGateState().radioOn,
  setRadio: (on) => {
    radios.setRadio(!!on, "Auto Engage");
    syncWsjtxGate();
  },
  antennaAvailable: () => {
    try { return rotor.active().meta.id !== "none"; } catch (_) { return false; }
  },
  antennaOn: () => wsjtxGateState().antennaOn,
  setAntenna: (on) => {
    rotor.setAntenna(!!on);
    syncWsjtxGate();
  },
  selectSat: (key) => {
    // Marked pass of another sat at T-5: normal switch (immediate preposition).
    rotor.deferSwitchPrep(null);
    return selectSat(key);
  },
  parkPending: () => !!rotor.afterLosPending().resumeAtPrep,
  cancelParkResume: () => rotor.cancelAfterLosResume(),
  notify: (evt) => broadcast({ type: "auto-engage", ...evt }),
});

/** Broadcast "state", then After-LOS (park / Auto Select), then Auto Engage. */
function stateCycle(withAfterLos) {
  const s = state.computeState();
  const done = withAfterLos !== false ? afterLosWatch(s) : null;
  let ae = null;
  if (s) {
    try {
      const pf = profiles.getActive() || {};
      ae = autoEngage.check({
        sat: s.sat,
        isMoon: !!s.isMoon,
        passes: s.passes,
        toggle: pf.autoEngage === true,
        marks: pf.autoEngagePasses,
        skips: pf.autoEngageSkips,
        afterLos: s.afterLos,
        afterLosDone: done,
      });
    } catch (e) {
      console.warn("Auto Engage:", e.message);
    }
    s.autoEngage = Object.assign({}, s.autoEngage, ae || autoEngage.status());
    broadcast(s);
  }
}

setInterval(() => stateCycle(true), STATE_MS);

setInterval(broadcastSats, SATS_BROADCAST_MS);

// Pass alerts: drop single-pass alerts / exceptions once their LOS is over.
function pruneAlertsNow() {
  try {
    if (profiles.pruneAutoEngagePasses(Date.now())) broadcastProfiles();
  } catch (e) {
    console.warn("Auto Engage prune failed:", e.message);
  }
  try {
    if (profiles.pruneAlerts(Date.now())) {
      state.setPassAlerts(profiles.getActive().alerts);
      broadcastProfiles();
    }
  } catch (e) {
    console.warn("Alert prune failed:", e.message);
  }
}
pruneAlertsNow();
setInterval(pruneAlertsNow, 60 * 1000).unref();

// Favorites orbit overlay: tracks refreshed every 60 s (positions ride on "state").
let lastFavTrackSig = "";
function broadcastFavTracks(force) {
  if (!wss || !wss.clients.size) return;
  const sig = state.favoritesSig();
  if (!force && sig === lastFavTrackSig && Date.now() - (broadcastFavTracks.at || 0) < 60000) return;
  const ft = state.computeFavoriteTracks();
  lastFavTrackSig = sig;
  broadcastFavTracks.at = Date.now();
  broadcast(ft);
}
// Cheap 5 s check catches favorites / selected-sat changes; full refresh every 60 s.
setInterval(() => broadcastFavTracks(false), 5000);

// Elevation chart Favorites view: 24 h pass series (selected sat + favorites).
// Recomputed only when sats / TLEs / location change, else rolled every 10 min.
const FAV_PROFILE_ROLL_MS = 10 * 60 * 1000;
let favProfile = null;
const globeOrbitsCache = { data: null, sig: "" };
let favProfileSigLast = "";
function favProfileCached(force) {
  const sig = state.favProfileSig();
  if (force || !favProfile || sig !== favProfileSigLast || Date.now() - favProfile.start > FAV_PROFILE_ROLL_MS) {
    const t = Date.now();
    favProfile = state.computeFavProfile(new Date());
    favProfileSigLast = sig;
    if (Date.now() - t > 500) console.log("Fav profile: computed in", Date.now() - t, "ms");
    return favProfile;
  }
  return favProfile;
}
setInterval(() => {
  if (!wss || !wss.clients.size) return;
  const prev = favProfile;
  const fp = favProfileCached(false);
  if (fp !== prev) broadcast(fp);
}, 5000);

setInterval(() => {
  catalog.refreshCatalog().catch(() => {});
  catalog.refreshStatus().catch(() => {});
}, REFRESH_MS);

(async () => {
  await catalog.refreshCatalog();
  await catalog.refreshStatus();
  // Start on the active profile's last selected sat; fall back to the default (RS-44).
  const defKey = catalog.pickDefaultKey();
  const last = (profiles.getActive() || {}).lastSat;
  const cat = catalog.getCatalog() || {};
  const keys = [];
  if (last && cat[last]) keys.push(last);
  else if (last) console.warn("Last sat " + last + " not in catalog; using default");
  if (defKey && keys.indexOf(defKey) < 0) keys.push(defKey);
  for (const key of keys) {
    try {
      await state.loadSatellite(key);
      console.log("Startup sat: " + key + (key === last ? " (last selected)" : " (default)"));
      break;
    } catch (err) {
      console.warn("Startup sat load failed (" + key + "):", err.message);
    }
  }
  // Hamlib serial radios: rigctld runs from now on (Radio on or off) and follows the config.
  hamlib.configure({
    auto: true,
    onChange: (st) => broadcast({ type: "hamlib", daemons: st.daemons, net: st.net }),
  });
  hamlib.ensure().catch(() => {});
  server.listen(PORT, "0.0.0.0", () => {
    const host = platform.hostInfo();
    console.log("Sat Tracker  http://127.0.0.1:" + PORT);
    console.log("Version     " + APP_VERSION);
    console.log(
      "Host OS     " +
        host.platform +
        " (" +
        host.type +
        " " +
        host.release +
        ") " +
        host.arch +
        " @ " +
        host.hostname,
    );
    console.log(
      "Serial      default " +
        host.defaultCatDevice +
        (host.serialDevices.length
          ? " | present: " + host.serialDevices.join(", ")
          : " | (none scanned)"),
    );
    console.log(
      "Active radio",
      radios.active().meta.id,
      radios.active().meta.label,
    );
    console.log(
      "Active rotor",
      rotors.active().meta.id,
      rotors.active().meta.label,
    );
    console.log("TCI target   " + TCI_URI);
    console.log(
      "Tick " + TICK_MS + "ms (Doppler), state " + STATE_MS + "ms (map)",
    );
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
