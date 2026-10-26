"use strict";
// AMSAT live status report: name list (scraped+cached), sat matching,
// request building, submit (only on explicit user action) and read-back verify.
const fs = require("fs");
const path = require("path");
const os = require("os");

const STATUS_URL = "https://www.amsat.org/status/";
const SUBMIT_URL = "https://www.amsat.org/status/submit.php";
const API_URL = "https://www.amsat.org/status/api/v1/sat_info.php";
const CACHE_FILE = path.join(os.homedir(), ".rpitrack", "amsat_satnames.json");
const CACHE_TTL_MS = 24 * 3600 * 1000;
const REPORTS = ["Heard", "Telemetry Only", "Not Heard"];
const REPORT_LABELS = { Heard: "Sat/Mode Active", "Telemetry Only": "TLM/Beacon Only", "Not Heard": "Not Heard" };

let fetchImpl = (...a) => globalThis.fetch(...a);
let mem = null; // { names, fetchedAt, source }
let cacheFile = CACHE_FILE;

function _setFetch(f) { fetchImpl = f; }
function _setCacheFile(f) { cacheFile = f; mem = null; }

function norm(s) { return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }

function parseSatNames(html) {
  const m = String(html).match(/<select[^>]*name=["']?SatName["']?[^>]*>([\s\S]*?)<\/select>/i);
  if (!m) return [];
  const out = [];
  const re = /<option[^>]*value=["']?([^"'>]*)["']?/gi;
  let o;
  while ((o = re.exec(m[1]))) {
    const v = o[1].trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

function splitName(v) {
  const m = String(v).match(/^(.*?)_\[(.*)\]$/);
  return m ? { base: m[1], tag: m[2] } : { base: String(v), tag: "" };
}

function readCacheFile() {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (Array.isArray(j.names) && j.names.length) return j;
  } catch (_) {}
  return null;
}

async function getSatNames({ force = false } = {}) {
  if (!mem) {
    const c = readCacheFile();
    if (c) mem = { ...c, source: "cache" };
  }
  if (!force && mem && Date.now() - mem.fetchedAt < CACHE_TTL_MS) return mem;
  try {
    const res = await fetchImpl(STATUS_URL, {
      headers: { "User-Agent": "pi-sat-track" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error("AMSAT status page HTTP " + res.status);
    const names = parseSatNames(await res.text());
    if (!names.length) throw new Error("no SatName options found on AMSAT status page");
    mem = { names, fetchedAt: Date.now(), source: "live" };
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({ names, fetchedAt: mem.fetchedAt }));
    } catch (_) {}
    return mem;
  } catch (e) {
    if (mem) return { ...mem, source: "cache (stale: " + e.message + ")" };
    throw new Error("Could not load AMSAT satellite list: " + e.message);
  }
}

/** MHz from a catalog freq field ("145.825", "145.850-145.950") or Hz number. */
function mhzOf(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e4 ? v / 1e6 : v;
  const m = String(v).match(/(\d{2,4}(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

/** Coarse band from MHz: VHF / UHF / HF (10m) / L / S. */
function bandOfMHz(mhz) {
  if (!Number.isFinite(mhz)) return null;
  if (mhz >= 28 && mhz < 60) return "HF";
  if (mhz >= 144 && mhz <= 148) return "VHF";
  if (mhz >= 420 && mhz <= 450) return "UHF";
  if (mhz >= 1260 && mhz <= 1300) return "L";
  if (mhz >= 2400 && mhz < 3000) return "S";
  return null;
}

/** Uplink/downlink bands from ctx (Hz preferred, else catalog freq strings). */
function bandsFromCtx(ctx) {
  if (!ctx) return { ul: null, dl: null };
  const ul = bandOfMHz(mhzOf(ctx.ulHz != null ? ctx.ulHz : ctx.uplink));
  const dl = bandOfMHz(mhzOf(ctx.dlHz != null ? ctx.dlHz : ctx.downlink));
  return { ul, dl };
}

/** AMSAT slash-tag letter for a band (AO-7 V/a, U/v, …). */
function bandLetter(band) {
  if (band === "VHF") return "V";
  if (band === "UHF") return "U";
  if (band === "HF") return "A";
  if (band === "L") return "L";
  if (band === "S") return "S";
  return null;
}

/**
 * Score how well an AMSAT mode tag fits the tracker mode / freqs.
 * opts: { ul, dl } band hints from the selected transmitter.
 */
function modeScore(tag, mode, opts) {
  const t = String(tag).toUpperCase();
  const m = String(mode || "").toUpperCase();
  const ul = opts && opts.ul, dl = opts && opts.dl;
  const tslash = String(tag).match(/^([A-Za-z])\/([A-Za-z])/);
  if (!m && !ul && !dl) return 0;
  if (m && norm(t) === norm(m)) return 10;
  const slash = String(mode || "").match(/\b([A-Za-z])\s*\/\s*([A-Za-z])\b/);
  if (slash && tslash) {
    if (slash[1].toUpperCase() === tslash[1].toUpperCase() && slash[2].toUpperCase() === tslash[2].toUpperCase()) return 9;
    return 1;
  }
  // Catalog letter modes (AO-7 "A"/"B") or freqs → AMSAT U/v, V/a, …
  if (tslash) {
    const wantU = bandLetter(ul);
    const wantD = bandLetter(dl);
    if (wantU && wantD) {
      if (wantU === tslash[1].toUpperCase() && wantD === tslash[2].toUpperCase()) return 9;
      return 1;
    }
    // AO-7: mode A ≈ V/a (VHF→10m), mode B ≈ U/v (UHF→VHF)
    if (/^A\b/.test(m) && tslash[1].toUpperCase() === "V" && tslash[2].toUpperCase() === "A") return 8;
    if (/^B\b/.test(m) && tslash[1].toUpperCase() === "U" && tslash[2].toUpperCase() === "V") return 8;
  }
  if (m && /\bFM\b/.test(m) && t === "FM") return 8;
  // ISS / voice repeater catalog rows without "FM" in the label
  if (m && /\bVOICE\b/.test(m) && t === "FM") return 7;
  if (m && /(SSB|CW|LINEAR|TRANSPONDER)/.test(m) && tslash) return 5;
  if (m && /(APRS|PACKET|DIGI|AFSK|BPSK|GMSK|FSK)/.test(m) && /DIGI|FSK/.test(t)) {
    // Crossband FM with a data rate in the label (ISS "9k6 GFSK FM" 145.990 /
    // 437.800) is the voice repeater, not the (simplex) digipeater: let the
    // FM row (8) win. APRS / packet stay digi.
    if (/\bFM\b/.test(m) && !/(APRS|PACKET|DIGI)/.test(m) && ul && dl && ul !== dl) return 6;
    // Prefer VHF_Digi vs UHF_Digi from the selected transmitter band (ISS APRS).
    const digiBand = ul || dl;
    if (digiBand === "VHF") return /VHF/.test(t) ? 9 : /UHF/.test(t) ? 3 : 6;
    if (digiBand === "UHF") return /UHF/.test(t) ? 9 : /VHF/.test(t) ? 3 : 6;
    return /VHF/.test(t) ? 7 : 6;
  }
  if (m && /SSTV/.test(m) && t === "SSTV") return 8;
  if (m && /SSDV/.test(m) && t === "SSDV") return 8;
  if (m && /(TLM|TELEMETRY|BEACON)/.test(m) && /TLM/.test(t)) return 7;
  if (m && (m.includes(t) || t.includes(norm(m)))) return 4;
  return 0;
}

/**
 * Rank AMSAT SatName values for a tracker sat.
 * ctx: { satKey, satName, satFullName, mode, ulHz?, dlHz?, uplink?, downlink? }.
 * Returns sorted [{value, score}].
 */
function matchSatNames(names, ctx) {
  if (!ctx) return [];
  const cands = [ctx.satKey, ctx.satName, ctx.satFullName].filter(Boolean).map(String);
  const keys = new Set();
  for (const c of cands) {
    keys.add(norm(c));
    const d = c.match(/\b([A-Z]{1,4})[\s-]?(\d{1,3}[A-Z]?)\b/i);
    if (d) keys.add(norm(d[1] + d[2]));
    keys.add(norm(c.split(/[\s(]/)[0]));
    const paren = c.match(/\(([^)]+)\)/);
    if (paren) keys.add(norm(paren[1]));
  }
  keys.delete("");
  if ([...keys].some((k) => k.startsWith("ISS") || k === "ZARYA")) keys.add("ISS");
  const bands = bandsFromCtx(ctx);
  const out = [];
  for (const v of names) {
    const { base, tag } = splitName(v);
    if (!keys.has(norm(base))) continue;
    out.push({ value: v, score: 100 + modeScore(tag, ctx.mode, bands) });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function satPeriod(minute) { return Math.min(3, Math.max(0, Math.floor(Number(minute) / 15))); }
const pad2 = (n) => String(n).padStart(2, "0");

function utcParts(date = new Date()) {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    period: satPeriod(date.getUTCMinutes()),
  };
}

/** Validate input and build URLSearchParams for submit.php. Throws on bad input. */
function buildParams(r) {
  const err = (m) => { throw Object.assign(new Error(m), { status: 400 }); };
  if (!r || !r.satName) err("satellite (SatName) required");
  if (!REPORTS.includes(r.report)) err("report must be one of: " + REPORTS.join(", "));
  const call = String(r.callsign || "").trim().toUpperCase();
  if (!/^[A-Z0-9/]{3,15}$/.test(call)) err("valid callsign required");
  const grid = String(r.grid || "").trim().slice(0, 6);
  if (grid && !/^[A-R]{2}[0-9]{2}([A-X]{2})?$/i.test(grid)) err("grid square must be like DM79 or DM79lq");
  const y = +r.year, mo = +r.month, d = +r.day, h = +r.hour, p = +r.period;
  if (!(y >= 2000 && y <= 2100)) err("bad year");
  if (!(mo >= 1 && mo <= 12)) err("bad month");
  if (!(d >= 1 && d <= 31)) err("bad day");
  if (!(Number.isInteger(h) && h >= 0 && h <= 23)) err("bad hour");
  if (!(Number.isInteger(p) && p >= 0 && p <= 3)) err("bad quarter (0-3)");
  return new URLSearchParams({
    SatSubmit: "yes",
    Confirm: "yes",
    SatName: r.satName,
    SatYear: String(y),
    SatMonth: pad2(mo),
    SatDay: pad2(d),
    SatHour: pad2(h),
    SatPeriod: String(p),
    SatCall: call,
    SatReport: r.report,
    SatGridSquare: grid,
    App: "pi-sat-track",
  });
}

async function verify(satName, callsign) {
  const url = API_URL + "?" + new URLSearchParams({ name: satName, hours: "1" });
  const res = await fetchImpl(url, { headers: { "User-Agent": "pi-sat-track" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error("verify HTTP " + res.status);
  const arr = await res.json();
  const call = String(callsign).toUpperCase();
  return (Array.isArray(arr) ? arr : []).find((x) => x && String(x.callsign || "").toUpperCase() === call) || null;
}

/**
 * Fill a minimal {report} request server-side. Explicit fields in r win
 * (optional overrides); missing satName/callsign/grid/date come from ctx.
 * d: { names, ctx, station:{callsign,grid}, now }
 */
function fillReport(r, d) {
  r = Object.assign({}, r || {});
  d = d || {};
  if (!r.satName) {
    const m = matchSatNames(d.names || [], d.ctx);
    if (!m.length) throw Object.assign(new Error("No AMSAT satellite match for current satellite"), { status: 400 });
    r.satName = m[0].value;
  }
  const st = d.station || {};
  if (!r.callsign) r.callsign = st.callsign || "";
  if (!r.grid) r.grid = st.grid || "";
  if (!String(r.callsign).trim()) throw Object.assign(new Error("Callsign missing from config"), { status: 400 });
  const u = utcParts(d.now || new Date());
  for (const k of ["year", "month", "day", "hour", "period"]) if (r[k] == null || r[k] === "") r[k] = u[k];
  return r;
}

/** Submit a report. Call ONLY from an explicit user action. */
async function submitReport(r) {
  const params = buildParams(r);
  let res;
  try {
    res = await fetchImpl(SUBMIT_URL + "?" + params.toString(), {
      method: "GET",
      headers: { "User-Agent": "pi-sat-track" },
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw Object.assign(new Error("Network error contacting AMSAT: " + (e.cause && e.cause.message || e.message)), { status: 502 });
  }
  if (!res.ok) throw Object.assign(new Error("AMSAT returned HTTP " + res.status + (res.statusText ? " " + res.statusText : "")), { status: 502 });
  let confirmed = null, verifyError = null;
  try {
    confirmed = await verify(params.get("SatName"), params.get("SatCall"));
  } catch (e) { verifyError = e.message; }
  return {
    ok: true,
    submitted: Object.fromEntries(params),
    confirmed: !!confirmed,
    entry: confirmed,
    message: confirmed ? "Reported, confirmed on AMSAT" : "Submitted; not yet visible on AMSAT" + (verifyError ? " (" + verifyError + ")" : ""),
  };
}

module.exports = {
  STATUS_URL, SUBMIT_URL, API_URL, REPORTS, REPORT_LABELS, fillReport,
  parseSatNames, getSatNames, matchSatNames, modeScore, splitName, satPeriod, utcParts,
  buildParams, submitReport, verify, _setFetch, _setCacheFile,
};
