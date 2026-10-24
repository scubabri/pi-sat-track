const fs = require("fs");
const {
  CACHE_DIR,
  CATALOG_CACHE,
  STATUS_CACHE,
  CATALOG_URL,
  AMSAT_STATUS,
  AMSAT_STATUS_SUMMARY,
  AMSAT_STATUS_HOURS,
  DEFAULT_SAT,
} = require("./config");
const config = require("./config");
const { getSatrecForNorad } = require("./tle");
const { lookAngles, findNextPass } = require("./orbit");
const moon = require("./moon");

/**
 * The Moon (EME) is a pseudo entry (key "MOON", norad null) so every
 * getCatalog()[key] lookup (radio drivers, mode list, logging) finds it. It is
 * skipped by everything AMSAT / TLE related (status, heard, default sat).
 */
function withMoon(cat) {
  const c = cat && typeof cat === "object" ? cat : {};
  c[moon.MOON_KEY] = moon.catalogEntry();
  return c;
}

let CATALOG = withMoon({});
let catalogNote = "not loaded";
let ACTIVE = new Set();
let statusNote = "not loaded";

/**
 * Known FM CTCSS (Hz). access = talk tone; activation = timer arm (SO-50 only).
 * Keys: designator, aliases, and NORAD as "N#####".
 */
/**
 * Mode overrides by NORAD, applied when the upstream frequency DB pairs services
 * wrongly. Kept minimal; source each entry from the operator's page.
 * SONATE-2 (59112): upstream lists UL 145.825 / DL "145.880/437.025", but the
 * APRS digi is 145.825 simplex and SSTV is 145.880 downlink-only
 * (uni-wuerzburg.de SONATE-2 "Information for Radio Amateurs").
 */
const MODE_OVERRIDES = {
  59112: [
    { mode: "APRS 1k2 AFSK", uplink: "145.825", downlink: "145.825", beacon: "", status: "active", score: 2 },
    { mode: "SSTV FM", uplink: "", downlink: "145.880", beacon: "", status: "active", score: 1 },
    { mode: "TLM 9k6 GMSK", uplink: "", downlink: "437.025", beacon: "437.025", status: "active", score: 0 },
  ],
};

const CTCSS_OVERRIDES = {
  // SO-50 — dual tone
  "SO-50": { access: 67.0, activation: 74.4 },
  SO50: { access: 67.0, activation: 74.4 },
  N27607: { access: 67.0, activation: 74.4 },

  // ISS crossband FM repeater
  ISS: { access: 67.0 },
  ZARYA: { access: 67.0 },
  N25544: { access: 67.0 },

  // IO-86 / LAPAN-A2
  "IO-86": { access: 88.5 },
  IO86: { access: 88.5 },
  "LAPAN-A2": { access: 88.5 },
  LAPANA2: { access: 88.5 },
  N40931: { access: 88.5 },

  // ASRTU-1
  "ASRTU-1": { access: 67.0 },
  ASRTU1: { access: 67.0 },
  N61781: { access: 67.0 },
};

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function norm(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function designator(name) {
  const m = String(name || "").match(/\b([A-Z]{1,4})[\s-]?(\d{1,3}[A-Z]?)\b/i);
  if (!m) return null;
  return (m[1] + "-" + m[2]).toUpperCase();
}

function callsignDesignator(cs) {
  if (!cs) return null;
  const s = String(cs).trim().toUpperCase();
  const m = s.match(/^([A-Z]{1,4})[\s-]?(\d{1,3}[A-Z]?)$/);
  if (m) return m[1] + "-" + m[2];
  return designator(s);
}

function makeKey(name, norad, callsign) {
  const d = designator(name) || callsignDesignator(callsign);
  if (d) return d;
  if (norad) return "N" + norad;
  return norm(name).slice(0, 16) || "UNKNOWN";
}

function betterName(a, b) {
  if (!a) return b;
  if (!b) return a;

  const da = designator(a);
  const db = designator(b);
  const aIsClean = da && norm(a) === norm(da);
  const bIsClean = db && norm(b) === norm(db);

  if (aIsClean && !bIsClean) return a;
  if (bIsClean && !aIsClean) return b;
  if (aIsClean && bIsClean) return a.length <= b.length ? a : b;

  if (da && !db) return a;
  if (db && !da) return b;

  return a.length <= b.length ? a : b;
}

function centerFreqMHz(field) {
  if (field == null || !String(field).trim()) return null;
  const s = String(field).trim();
  const primary = s.split(/[\/]/)[0].trim();

  const range = primary.match(/(\d+\.?\d*)\s*[-–]\s*(\d+\.?\d*)/);
  if (range) {
    const a = parseFloat(range[1]);
    const b = parseFloat(range[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return ((a + b) / 2).toFixed(3);
  }

  const single = primary.match(/(\d+\.\d+)/);
  if (single) return parseFloat(single[1]).toFixed(3);
  return null;
}

function isFmMode(mode) {
  if (!mode) return false;
  const m = String(mode).toUpperCase();
  // Explicit FM / narrow / digital voice that uses FM-family demod
  if (/\bFM\b|\bNFM\b|\bWFM\b/.test(m)) return true;
  if (/CTCSS|\bPL\b/.test(m)) return true;
  if (/GFSK|C4FM|DSTAR|DMR|YSF|NXDN/.test(m)) return true;
  // Packet / APRS voice-channel modes on FM sats
  if (/\bAFSK\b|\bAPRS\b/.test(m)) return true;
  // ARISS "Voice (Reg …)" entries are FM crossband
  if (/\bVOICE\b/.test(m)) return true;
  return false;
}

/** EME (Moon) modes: USB on TX and RX (not a transponder), e.g. "EME USB 2m". */
function isUsbBothMode(mode) {
  const m = String(mode || "").toUpperCase();
  return /\bEME\b/.test(m) && /\bUSB\b/.test(m);
}

function isInverting(mode) {
  if (!mode) return true;
  const m = String(mode).toUpperCase();
  if (/\bEME\b/.test(m)) return false;
  if (/\bFM\b|CTCSS/.test(m)) return false;
  if (/INVERT/.test(m)) return true;
  if (/\bSSB\b|\bCW\b|\bLINEAR\b|\bA\b|\bB\b/.test(m)) return true;
  return true;
}

/**
 * Extract CTCSS tones from mode text + known sat overrides.
 * Returns { access, activation } in Hz (or null).
 */
function parseCtcss(modeStr, satKey, satName, norad) {
  const result = { access: null, activation: null };
  const m = String(modeStr || "");

  // "CTCSS 67.0" / "67.0 Hz CTCSS" / "PL 67"
  const tones = [];
  const re =
    /(?:CTCSS|PL|TONE)\s*[:=]?\s*(\d{2,3}(?:\.\d)?)|(\d{2,3}\.\d)\s*(?:Hz)?\s*(?:CTCSS|PL)/gi;
  let match;
  while ((match = re.exec(m)) !== null) {
    const v = parseFloat(match[1] || match[2]);
    if (Number.isFinite(v) && v >= 67 && v <= 254.1) tones.push(v);
  }
  if (!tones.length && /CTCSS|\bPL\b/i.test(m)) {
    const bare = m.match(/\b(6[7-9]|[7-9]\d|1\d{2}|2[0-4]\d)(?:\.\d)?\b/);
    if (bare) {
      const v = parseFloat(bare[0]);
      if (v >= 67 && v <= 254.1) tones.push(v);
    }
  }

  if (tones.length >= 2) {
    const act = tones.find((t) => Math.abs(t - 74.4) < 0.05);
    if (act != null) {
      result.activation = act;
      result.access = tones.find((t) => t !== act) || tones[0];
    } else {
      result.access = tones[0];
      result.activation = tones[1];
    }
  } else if (tones.length === 1) {
    result.access = tones[0];
  }

  // Overrides win — catalog strings often omit tone for ISS etc.
  const candidates = [
    satKey,
    satName,
    designator(satName),
    designator(satKey),
    norad != null ? "N" + norad : null,
  ]
    .filter(Boolean)
    .map((k) => String(k).toUpperCase());

  // Also match "ISS" substring in name (e.g. "ISS (ZARYA)")
  const nameU = String(satName || "").toUpperCase();
  if (/\bISS\b/.test(nameU) || nameU.includes("ZARYA")) {
    candidates.unshift("ISS");
  }

  for (const k of candidates) {
    const o = CTCSS_OVERRIDES[k] || CTCSS_OVERRIDES[norm(k)];
    if (o) {
      if (o.access != null) result.access = o.access;
      if (o.activation != null) result.activation = o.activation;
      break;
    }
  }

  return result;
}

function scoreRow(row) {
  let s = 0;
  if (row.uplink) s += 2;
  if (row.downlink) s += 2;
  if (row.uplink && String(row.uplink).includes("-")) s += 2;
  if (row.downlink && String(row.downlink).includes("-")) s += 2;
  const m = String(row.mode || "").toUpperCase();
  if (/\bSSB\b|\bCW\b|\bLINEAR\b/.test(m)) s += 3;
  if (/\bA\b|\bB\b|U\/V|V\/U/i.test(m)) s += 2;
  if (/\bFM\b|CTCSS/.test(m)) s += 1;
  if (row.status === "active" || row.status === "operational") s += 1;
  return s;
}

function formatFreqDisplay(sat) {
  return formatFreqDisplayFromMode(sat);
}

function formatFreqDisplayFromMode(modeObj) {
  const ul = centerFreqMHz(modeObj && modeObj.uplink);
  const dl = centerFreqMHz(modeObj && modeObj.downlink);
  const fm = isFmMode(modeObj && modeObj.mode);
  return {
    uplink: ul || "-",
    downlink: dl || "-",
    ulLabel: fm ? "Uplink (FM)" : "Uplink (LSB)",
    dlLabel: fm ? "Downlink (FM)" : "Downlink (USB)",
    isFm: fm,
    ulMHz: ul ? parseFloat(ul) : null,
    dlMHz: dl ? parseFloat(dl) : null,
    mode: (modeObj && modeObj.mode) || "",
  };
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "sat-tracker/0.1" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.text();
}

function modeKey(m) {
  return [norm(m.mode), m.uplink || "", m.downlink || ""].join("|");
}

/**
 * Beacon frequencies from a catalog `beacon` field, as trimmed strings (MHz,
 * source precision kept like other modes' downlinks). "a/b" lists give one
 * value each; a trailing "*" (unconfirmed in the DB) is dropped. Anything that
 * is not a plain decimal MHz value is skipped: callsigns ("IU0SIA", "RS55S"),
 * mode text ("2k4 GMSK_USP"), ranges, bare integers.
 */
function parseBeaconFreqs(field) {
  if (field == null) return [];
  const out = [];
  for (const raw of String(field).split("/")) {
    const t = raw.replace(/\*/g, "").trim();
    if (!/^\d+\.\d+$/.test(t)) continue;
    const v = parseFloat(t);
    if (!Number.isFinite(v) || v < 1 || v > 300000) continue;
    out.push(t);
  }
  return out;
}

const BEACON_DUP_MHZ = 0.0015; // 1.5 kHz

/**
 * Append a downlink-only "Beacon" / "Beacon CW" mode for each distinct beacon
 * frequency of a sat, after its existing (sorted) modes so saved mode indexes
 * and mode|uplink|downlink keys of existing modes do not change. Skipped when
 * any mode's (primary) downlink is already within 1.5 kHz of the beacon
 * (e.g. TLM 437.025 = beacon 437.025, FM DL = beacon). Status is inherited
 * from the source mode row. Idempotent (cached catalogs can be re-run).
 */
function addBeaconModes(entry) {
  if (!entry || !Array.isArray(entry.modes)) return entry;
  const sources = entry.modes.slice();
  for (const src of sources) {
    for (const f of parseBeaconFreqs(src.beacon)) {
      const v = parseFloat(f);
      const dup = entry.modes.some((m) => {
        const dl = centerFreqMHz(m.downlink);
        return dl != null && Math.abs(parseFloat(dl) - v) < BEACON_DUP_MHZ;
      });
      if (dup) continue;
      entry.modes.push({
        mode: /\bCW\b/i.test(src.mode || "") ? "Beacon CW" : "Beacon",
        uplink: "",
        downlink: f,
        beacon: f,
        status: src.status || "",
        score: 0,
        synthetic: "beacon",
        ctcssAccess: null,
        ctcssActivation: null,
      });
    }
  }
  return entry;
}

function parseAmsatJson(arr) {
  const byNorad = new Map();

  for (const row of arr) {
    if (!row || !row.name) continue;
    const norad =
      row.norad_id != null && String(row.norad_id).trim() !== ""
        ? parseInt(String(row.norad_id), 10)
        : null;
    if (!Number.isFinite(norad)) continue;

    const modeEntry = {
      mode: row.mode != null ? String(row.mode).trim() : "",
      uplink: row.uplink != null ? String(row.uplink).trim() : "",
      downlink: row.downlink != null ? String(row.downlink).trim() : "",
      beacon: row.beacon != null ? String(row.beacon).trim() : "",
      // Per-transmitter status from the frequency DB (operational -> active)
      status: (function () {
        const st = String(row.status || "").trim().toLowerCase();
        return st === "operational" ? "active" : st === "non-operational" ? "inactive" : st;
      })(),
      score: 0,
    };
    modeEntry.score = scoreRow({
      uplink: modeEntry.uplink,
      downlink: modeEntry.downlink,
      mode: modeEntry.mode,
      status: row.status,
    });

    const callsign = row.callsign != null ? String(row.callsign).trim() : "";
    const entry = {
      name: String(row.name).trim(),
      norad,
      uplink: modeEntry.uplink,
      downlink: modeEntry.downlink,
      beacon: modeEntry.beacon,
      mode: modeEntry.mode,
      callsign,
      status: String(row.status || "")
        .trim()
        .toLowerCase(),
      satnogs_id: row.satnogs_id || null,
      modes: [modeEntry],
    };

    const prev = byNorad.get(norad);
    if (!prev) {
      byNorad.set(norad, entry);
      continue;
    }

    prev.name = betterName(prev.name, entry.name);

    if (entry.callsign && !prev.callsign) {
      prev.callsign = entry.callsign;
    } else if (entry.callsign && prev.callsign) {
      if (
        !callsignDesignator(prev.callsign) &&
        callsignDesignator(entry.callsign)
      ) {
        prev.callsign = entry.callsign;
      }
    }

    const seen = new Set(prev.modes.map(modeKey));
    for (const m of entry.modes) {
      const k = modeKey(m);
      if (!seen.has(k) && (m.uplink || m.downlink || m.mode)) {
        prev.modes.push(m);
        seen.add(k);
      }
    }

    const st = entry.status;
    if (st === "active" || st === "operational") prev.status = "active";
    else if (!prev.status || prev.status === "unknown") prev.status = st;
  }

  const catalog = {};
  for (const entry of byNorad.values()) {
    if (entry.status === "operational") entry.status = "active";
    if (entry.status === "non-operational") entry.status = "inactive";

    if (MODE_OVERRIDES[entry.norad]) {
      entry.modes = MODE_OVERRIDES[entry.norad].map((m) => ({ ...m }));
    }
    entry.modes.sort((a, b) => b.score - a.score);
    if (entry.modes.length) {
      entry.uplink = entry.modes[0].uplink;
      entry.downlink = entry.modes[0].downlink;
      entry.beacon = entry.modes[0].beacon || entry.beacon;
      entry.mode = entry.modes[0].mode;
    }

    const fromName = designator(entry.name);
    const fromCs = callsignDesignator(entry.callsign);
    const clean =
      fromName && norm(entry.name) === norm(fromName)
        ? fromName
        : fromCs || fromName || entry.name;

    let key = makeKey(entry.name, entry.norad, entry.callsign);
    // Prefer ISS as key for NORAD 25544
    if (entry.norad === 25544) key = "ISS";
    else if (key.startsWith("N") && (fromCs || fromName)) {
      key = fromCs || fromName;
    }
    entry.key = key;
    entry.display = entry.norad === 25544 ? "ISS" : clean;
    entry.trackable = !!entry.norad;

    // Attach CTCSS to each mode (FM modes get override tones)
    for (const mo of entry.modes) {
      const tones = parseCtcss(mo.mode, key, entry.name, entry.norad);
      // Only attach to FM-ish modes so linear modes stay clean
      if (
        isFmMode(mo.mode) ||
        tones.access != null ||
        tones.activation != null
      ) {
        mo.ctcssAccess = tones.access;
        mo.ctcssActivation = tones.activation;
      } else {
        mo.ctcssAccess = null;
        mo.ctcssActivation = null;
      }
    }

    // Beacons last (after sort + CTCSS): keeps existing mode indexes stable.
    addBeaconModes(entry);

    catalog[key] = entry;
  }
  return catalog;
}

/** AMSAT legend colors (status page CSS). */
const AMSAT_COLOR_HEARD = "#648fff"; // Sat/Mode Active (blue)
const AMSAT_COLOR_TLM = "#ffb000"; // TLM/Beacon only
const AMSAT_POSITIVE = new Set(["Heard", "Telemetry Only"]);

/** norm(base name) -> Set of AMSAT status mode tags, e.g. "SO50" -> {"FM"}. */
let AMSAT_TAGS = new Map();
/** norm(base) -> "heard" | "tlm" from positive reports in the 72h window. */
let AMSAT_KINDS = new Map();
/** norm(base) -> ISO timestamp of the winning positive report. */
let AMSAT_LATEST = new Map();

function parseAmsatTagsFromNames(names) {
  const tags = new Map();
  for (const raw of names || []) {
    const m = String(raw || "").match(
      /^([A-Za-z][A-Za-z0-9.\-_]{0,30}?)_\[([^\]]+)\]$/,
    );
    if (!m) continue;
    const base = m[1].trim();
    const tag = m[2].trim();
    if (/^crew$/i.test(tag)) continue;
    for (const k of [
      norm(base),
      norm(designator(base) || callsignDesignator(base) || ""),
    ]) {
      if (!k) continue;
      if (!tags.has(k)) tags.set(k, new Set());
      tags.get(k).add(tag);
    }
  }
  return tags;
}

function parseAmsatTags(html) {
  const tags = new Map();
  const re = /([A-Za-z][A-Za-z0-9.\-_]{0,30}?)_\[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(String(html || ""))) !== null) {
    const base = m[1].trim();
    const tag = m[2].trim();
    if (/^crew$/i.test(tag)) continue;
    for (const k of [
      norm(base),
      norm(designator(base) || callsignDesignator(base) || ""),
    ]) {
      if (!k) continue;
      if (!tags.has(k)) tags.set(k, new Set());
      tags.get(k).add(tag);
    }
  }
  return tags;
}

/**
 * Build ACTIVE set + per-sat kind from AMSAT summary API rows.
 * Only Heard (blue) and Telemetry Only count; Not Heard / Crew Active / etc. ignored.
 * Window is whatever the summary was fetched with (typically 72h).
 * Kind = most recent positive report type (Heard preferred on equal timestamps).
 */
function parseAmsatSummary(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : payload && Array.isArray(payload.data)
      ? payload.data
      : [];
  /** norm -> { heardAt, tlmAt, tags: Set, names: Set } */
  const byBase = new Map();

  function touch(base, tag, report, ts) {
    if (!base || base.length < 2) return;
    if (/^crew$/i.test(tag || "")) return;
    if (!AMSAT_POSITIVE.has(report)) return;
    const keys = new Set();
    for (const k of [
      norm(base),
      norm(designator(base) || callsignDesignator(base) || ""),
    ]) {
      if (k) keys.add(k);
    }
    for (const k of keys) {
      let ent = byBase.get(k);
      if (!ent) {
        ent = { heardAt: 0, tlmAt: 0, tags: new Set(), names: new Set() };
        byBase.set(k, ent);
      }
      if (tag) ent.tags.add(tag);
      ent.names.add(base + (tag ? "_[" + tag + "]" : ""));
      if (report === "Heard") {
        if (ts >= ent.heardAt) ent.heardAt = ts;
      } else if (report === "Telemetry Only") {
        if (ts >= ent.tlmAt) ent.tlmAt = ts;
      }
    }
  }

  for (const row of rows) {
    if (!row || !row.name) continue;
    const report = String(row.report || "").trim();
    if (!AMSAT_POSITIVE.has(report)) continue;
    const raw = String(row.name);
    const m = raw.match(/^(.+?)_\[([^\]]+)\]$/);
    const base = (m ? m[1] : raw).trim();
    const tag = m ? m[2].trim() : "";
    const ts = Date.parse(row.latest_reported_time || row.reported_time || "") || 0;
    touch(base, tag, report, ts);
  }

  const active = new Set();
  const kinds = new Map();
  const latest = new Map();
  const tags = new Map();
  const allNames = [];

  for (const [k, ent] of byBase) {
    if (!ent.heardAt && !ent.tlmAt) continue;
    let kind;
    let tsWin = 0;
    if (ent.heardAt && ent.tlmAt) {
      if (ent.heardAt >= ent.tlmAt) {
        kind = "heard";
        tsWin = ent.heardAt;
      } else {
        kind = "tlm";
        tsWin = ent.tlmAt;
      }
    } else if (ent.heardAt) {
      kind = "heard";
      tsWin = ent.heardAt;
    } else {
      kind = "tlm";
      tsWin = ent.tlmAt;
    }
    active.add(k);
    kinds.set(k, kind);
    if (tsWin) latest.set(k, new Date(tsWin).toISOString());
    if (ent.tags.size) tags.set(k, new Set(ent.tags));
    for (const n of ent.names) allNames.push(n);
  }

  // Prefer tag map built from positive-report names; fill gaps from name list.
  const fromNames = parseAmsatTagsFromNames(allNames);
  for (const [k, set] of fromNames) {
    if (!tags.has(k)) tags.set(k, set);
    else set.forEach((x) => tags.get(k).add(x));
  }

  return { active, kinds, latest, tags };
}

/** Legacy HTML scrape: any sat name on the page (no color / time filter). */
function parseAmsatStatus(html) {
  AMSAT_TAGS = parseAmsatTags(html);
  AMSAT_KINDS = new Map();
  AMSAT_LATEST = new Map();
  const active = new Set();
  const re = /([A-Za-z][A-Za-z0-9\-]{0,24})_\[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const base = m[1].trim();
    const tag = m[2].trim();
    if (!base || base.length < 2) continue;
    if (/^crew$/i.test(tag)) continue;
    active.add(norm(base));
    const d = designator(base) || callsignDesignator(base);
    if (d) active.add(norm(d));
    // No kind info from name-only scrape — treat as heard (blue).
    AMSAT_KINDS.set(norm(base), "heard");
    if (d) AMSAT_KINDS.set(norm(d), "heard");
  }
  return active;
}

function applyStatusMaps(active, kinds, tags, latest) {
  ACTIVE = active instanceof Set ? active : new Set(active || []);
  AMSAT_KINDS =
    kinds instanceof Map
      ? kinds
      : new Map(Object.entries(kinds || {}));
  AMSAT_LATEST =
    latest instanceof Map
      ? latest
      : new Map(Object.entries(latest || {}));
  AMSAT_TAGS =
    tags instanceof Map
      ? tags
      : new Map(
          Object.entries(tags || {}).map(([k, v]) => [
            k,
            v instanceof Set ? v : new Set(v || []),
          ]),
        );
}

/** AMSAT status-page mode tags for a catalog sat (same name matching as isHeard), or null. */
function amsatTagsFor(sat) {
  if (!AMSAT_TAGS.size || !sat) return null;
  const out = new Set();
  for (const n of [sat.name, sat.display, sat.key, sat.callsign].filter(Boolean)) {
    for (const k of [norm(n), norm(designator(n) || callsignDesignator(n) || "")]) {
      const t = k && AMSAT_TAGS.get(k);
      if (t) t.forEach((x) => out.add(x));
    }
  }
  return out.size ? [...out] : null;
}

/** True once the AMSAT status list has been loaded (live or disk cache). */
function amsatStatusLoaded() {
  return AMSAT_TAGS.size > 0 || ACTIVE.size > 0;
}

function lookupKindKeys(sat) {
  const keys = [];
  const names = [sat.name, sat.display, sat.key, sat.callsign].filter(Boolean);
  for (const n of names) {
    const nn = norm(n);
    if (nn) keys.push(nn);
    const d = designator(n) || callsignDesignator(n);
    if (d) keys.push(norm(d));
  }
  return keys;
}

function isHeard(sat) {
  for (const k of lookupKindKeys(sat)) {
    if (k && ACTIVE.has(k)) return true;
  }
  return false;
}

/** "heard" | "tlm" | null — AMSAT positive-report kind for icon color. */
function heardKindFor(sat) {
  let best = null;
  for (const k of lookupKindKeys(sat)) {
    const kind = k && AMSAT_KINDS.get(k);
    if (!kind) continue;
    if (kind === "heard") return "heard";
    if (kind === "tlm") best = "tlm";
  }
  return best;
}

/** ISO timestamp of the winning positive AMSAT report, or null. */
function heardReportAtFor(sat) {
  let bestIso = null;
  let bestMs = -1;
  for (const k of lookupKindKeys(sat)) {
    const iso = k && AMSAT_LATEST.get(k);
    if (!iso) continue;
    const ms = Date.parse(iso);
    if (Number.isFinite(ms) && ms >= bestMs) {
      bestMs = ms;
      bestIso = iso;
    }
  }
  return bestIso;
}

function horizonFlags(norad, observer) {
  const rec = getSatrecForNorad(norad);
  if (!rec) return { above: false, soon: false, el: null, secToAos: null };

  const now = new Date();
  const look = lookAngles(rec, observer, now);
  const el = look ? look.el : null;
  // Same cutoff as the pass list / header (rotor min elevation), so the
  // favorites countdown never points at a pass the pass list filters out.
  const minEl =
    config.ROTOR_MIN_EL != null && Number.isFinite(config.ROTOR_MIN_EL)
      ? config.ROTOR_MIN_EL
      : 0;
  const above = el != null && el >= minEl;
  if (above) return { above: true, soon: false, el, secToAos: 0 };

  // Coarse 30s scan, then binary-refine so AOS has true second resolution
  // (without this every sat lands on a multiple of 30 and client countdowns
  // share the same second residual).
  const step = 30;
  let prev = el;
  let secToAos = null;
  for (let s = step; s <= 12 * 3600; s += step) {
    const look2 = lookAngles(rec, observer, new Date(now.getTime() + s * 1000));
    if (!look2) continue;
    if (prev != null && prev < minEl && look2.el >= minEl) {
      let lo = s - step;
      let hi = s;
      for (let i = 0; i < 10; i++) {
        const mid = (lo + hi) / 2;
        const lookM = lookAngles(
          rec,
          observer,
          new Date(now.getTime() + mid * 1000),
        );
        if (lookM && lookM.el >= minEl) hi = mid;
        else lo = mid;
      }
      secToAos = Math.round(hi);
      break;
    }
    prev = look2.el;
  }
  return {
    above: false,
    soon: secToAos != null && secToAos <= 15 * 60,
    el,
    secToAos,
  };
}

/** Sat-list row for the Moon (always listed first; no AMSAT status). */
function moonRow(observer) {
  const s = CATALOG[moon.MOON_KEY];
  if (!s) return null;
  const row = {
    key: s.key,
    name: s.display,
    norad: null,
    isMoon: true,
    uplink: s.uplink,
    downlink: s.downlink,
    mode: "EME",
    status: s.status,
    heard: false,
    heardKind: null,
    heardReportAt: null,
    isFm: false,
    above: false,
    soon: false,
    el: null,
    secToAos: null,
  };
  if (!observer) return row;
  try {
    const minEl =
      config.ROTOR_MIN_EL != null && Number.isFinite(config.ROTOR_MIN_EL) ? config.ROTOR_MIN_EL : 0;
    const now = new Date();
    const look = lookAngles(moon.MOON_REC, observer, now);
    row.el = look ? look.el : null;
    row.above = row.el != null && row.el >= minEl;
    if (row.above) row.secToAos = 0;
    else {
      const np = findNextPass(moon.MOON_REC, observer, now, minEl);
      if (np && np.aos > now.getTime()) {
        row.secToAos = Math.round((np.aos - now.getTime()) / 1000);
        row.soon = row.secToAos <= 15 * 60;
      }
    }
  } catch (_) {}
  return row;
}

function listSatsPayload(filter, observer) {
  const rows = [];
  for (const s of Object.values(CATALOG)) {
    if (!s.trackable || s.isMoon) continue;
    const st = s.status || "";
    if (filter === "active" && st !== "active" && !isHeard(s)) continue;
    if (filter === "trackable" && (st === "re-entered" || st === "failure"))
      continue;

    const activeMode = (s.modes && s.modes[0]) || s;
    const freqs = formatFreqDisplayFromMode(activeMode);
    const heard = isHeard(s);
    const heardKind = heard ? heardKindFor(s) || "heard" : null;
    const heardReportAt = heard ? heardReportAtFor(s) : null;
    const row = {
      key: s.key,
      name: s.display || s.name,
      norad: s.norad,
      uplink: freqs.uplink,
      downlink: freqs.downlink,
      mode: s.mode,
      status: s.status,
      heard,
      heardKind,
      heardReportAt,
      isFm: freqs.isFm,
      above: false,
      soon: false,
      el: null,
      secToAos: null,
    };

    if (heard || s.status === "active") {
      const h = horizonFlags(s.norad, observer);
      row.above = h.above;
      row.soon = h.soon;
      row.el = h.el;
      row.secToAos = h.secToAos;
    }

    rows.push(row);
  }
  rows.sort((a, b) => {
    if (a.above !== b.above) return a.above ? -1 : 1;
    if (a.soon !== b.soon) return a.soon ? -1 : 1;
    const aSec =
      typeof a.secToAos === "number" ? a.secToAos : Number.POSITIVE_INFINITY;
    const bSec =
      typeof b.secToAos === "number" ? b.secToAos : Number.POSITIVE_INFINITY;
    if (aSec !== bSec) return aSec - bSec;
    if ((a.status === "active") !== (b.status === "active")) {
      return a.status === "active" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  const mr = moonRow(observer);
  if (mr) rows.unshift(mr);
  return {
    catalogNote,
    statusNote,
    count: rows.length,
    satellites: rows,
  };
}

async function refreshCatalog() {
  ensureCacheDir();
  try {
    const text = await fetchText(CATALOG_URL);
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error("catalog not an array");
    const catalog = parseAmsatJson(arr);
    const payload = {
      fetched_at: new Date().toISOString(),
      note: "AMSAT frequencies JSON live",
      source: CATALOG_URL,
      satellites: catalog,
    };
    fs.writeFileSync(CATALOG_CACHE, JSON.stringify(payload));
    CATALOG = withMoon(catalog);
    catalogNote = payload.note;
    const rs = catalog["RS-44"];
    console.log(
      "Catalog: " + Object.keys(CATALOG).length + " sats - " + catalogNote,
    );
    if (rs) {
      console.log(
        "RS-44 ok: name=" +
          rs.name +
          " display=" +
          rs.display +
          " callsign=" +
          (rs.callsign || "-") +
          " modes=" +
          (rs.modes || []).length,
      );
    } else {
      console.warn("RS-44 not found in catalog keys");
    }
    const iss = catalog["ISS"];
    if (iss) {
      const fm = (iss.modes || []).filter((m) => isFmMode(m.mode));
      console.log(
        "ISS modes:",
        (iss.modes || [])
          .map(
            (m) =>
              m.mode + (m.ctcssAccess != null ? " CTCSS " + m.ctcssAccess : ""),
          )
          .join(" | "),
      );
    }
  } catch (e) {
    if (fs.existsSync(CATALOG_CACHE)) {
      const payload = JSON.parse(fs.readFileSync(CATALOG_CACHE, "utf8"));
      const sats = payload.satellites || {};
      // Caches written before Beacon modes existed get them now (idempotent).
      for (const k of Object.keys(sats)) addBeaconModes(sats[k]);
      CATALOG = withMoon(sats);
      catalogNote =
        "cache " + (payload.fetched_at || "?") + " (" + e.message + ")";
      console.log(
        "Catalog from cache: " +
          Object.keys(CATALOG).length +
          " - " +
          catalogNote,
      );
    } else {
      catalogNote = "empty (" + e.message + ")";
      console.error("Catalog failed:", e.message);
    }
  }
}

function loadStatusCachePayload(payload) {
  const kinds = payload.kinds || {};
  const tags = payload.tags || {};
  const latest = payload.latest || {};
  applyStatusMaps(payload.names || [], kinds, tags, latest);
  // Older caches had names only — default kind to heard.
  if (!payload.kinds) {
    for (const n of ACTIVE) {
      if (!AMSAT_KINDS.has(n)) AMSAT_KINDS.set(n, "heard");
    }
  }
}

async function refreshStatus() {
  ensureCacheDir();
  const hours = AMSAT_STATUS_HOURS || 72;
  try {
    const text = await fetchText(AMSAT_STATUS_SUMMARY);
    const json = JSON.parse(text);
    const parsed = parseAmsatSummary(json);
    applyStatusMaps(parsed.active, parsed.kinds, parsed.tags, parsed.latest);
    const payload = {
      fetched_at: new Date().toISOString(),
      note: "AMSAT summary " + hours + "h Heard/TLM",
      hours,
      names: [...ACTIVE],
      kinds: Object.fromEntries(AMSAT_KINDS),
      latest: Object.fromEntries(AMSAT_LATEST),
      tags: Object.fromEntries([...AMSAT_TAGS].map(([k, v]) => [k, [...v]])),
    };
    fs.writeFileSync(STATUS_CACHE, JSON.stringify(payload));
    statusNote = ACTIVE.size + " heard - " + payload.note;
    console.log("Status: " + statusNote + " -> " + [...ACTIVE].sort().join(", "));
  } catch (e) {
    if (fs.existsSync(STATUS_CACHE)) {
      const payload = JSON.parse(fs.readFileSync(STATUS_CACHE, "utf8"));
      loadStatusCachePayload(payload);
      statusNote =
        "cache " + (payload.fetched_at || "?") + " (" + e.message + ")";
      console.log("Status from cache: " + ACTIVE.size);
    } else {
      // Last resort: legacy HTML name scrape (no color/time filter).
      try {
        const html = await fetchText(AMSAT_STATUS);
        const set = parseAmsatStatus(html);
        ACTIVE = set;
        statusNote =
          set.size + " heard - AMSAT status HTML fallback (" + e.message + ")";
        console.warn("Status: " + statusNote);
      } catch (e2) {
        statusNote = "empty (" + e.message + ")";
        console.error("Status failed:", e.message);
      }
    }
  }
}

function getCatalog() {
  return CATALOG;
}

function getCatalogNote() {
  return catalogNote;
}

function getStatusNote() {
  return statusNote;
}

function pickDefaultKey() {
  if (CATALOG[DEFAULT_SAT]) return DEFAULT_SAT;

  for (const [k, s] of Object.entries(CATALOG)) {
    const n = norm(s.name || s.display || k);
    if (n === "RS44" || n.includes("RS44")) return k;
  }

  const heardActive = Object.values(CATALOG).filter(
    (s) => s.trackable && isHeard(s) && s.norad,
  );
  if (heardActive.length) {
    const preferred = [
      "RS-44",
      "AO-7",
      "AO-91",
      "SO-50",
      "FO-29",
      "ISS",
      "AO-73",
    ];
    for (const p of preferred) {
      const hit = heardActive.find(
        (s) =>
          s.key === p ||
          norm(s.name) === norm(p) ||
          norm(s.display) === norm(p),
      );
      if (hit) return hit.key;
    }
    return heardActive[0].key;
  }

  const active = Object.values(CATALOG).find(
    (s) => s.status === "active" && s.norad,
  );
  if (active) return active.key;

  const any = Object.values(CATALOG).find((s) => s.trackable && s.norad);
  return any ? any.key : null;
}

module.exports = {
  ensureCacheDir,
  norm,
  designator,
  callsignDesignator,
  makeKey,
  centerFreqMHz,
  isFmMode,
  isInverting,
  isUsbBothMode,
  parseCtcss,
  formatFreqDisplay,
  formatFreqDisplayFromMode,
  isHeard,
  heardKindFor,
  heardReportAtFor,
  amsatTagsFor,
  amsatStatusLoaded,
  parseAmsatSummary,
  parseAmsatStatus,
  listSatsPayload,
  refreshCatalog,
  refreshStatus,
  AMSAT_COLOR_HEARD,
  AMSAT_COLOR_TLM,
  getCatalog,
  getCatalogNote,
  getStatusNote,
  pickDefaultKey,
  parseAmsatJson,
  parseBeaconFreqs,
  addBeaconModes,
};
