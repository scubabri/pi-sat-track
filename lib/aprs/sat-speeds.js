/**
 * APRS / AX.25 digipeater speed per satellite, used to route TX to a KISS
 * connection with the matching modem (1200 AFSK vs 9600 G3RUH).
 *
 * Source: AMSAT "Digipeater Satellites" list (https://www.amsat.org/live-digipeater-satellites/,
 * updated 2026-10-18, N9KT), cross-checked with SatNOGS DB transmitters for
 * CroCube, Marina and KNACKSAT-2. Only satellites with a plain AX.25 / APRS
 * digipeater at 1k2 AFSK or 9k6 G3RUH-compatible FSK/GFSK are listed;
 * ARICA-2 (4k8 GMSK), Erminaz-2U and Foresail-1p (special frame formats)
 * are left out on purpose. Anything else falls back to the selected mode
 * text ("9k6" / "G3RUH" / "1k2" / "AFSK") and then 1200.
 * A per-satellite setting (config.aprs.satSpeeds) always wins.
 *
 * via: the satellite's digipeater call from the same AMSAT list, the default
 * Via when that sat is selected (a per-sat Via in config.aprs.satPaths wins;
 * no entry = the configured default path). IO-86 also takes ARISS and NO-44
 * PCSAT-1. GUARANISAT-2 / KNACKSAT-2 have no published Via. NORAD ids are the
 * ones in the AMSAT catalog (amsat_catalog.json); CroCube's 62394 predates that
 * check and LASARsat has none, so those two also match by name.
 * label: display name for the Via dropdown (viaOptions()).
 */
const SAT_SPEEDS = [
  { label: "ISS", names: ["ISS", "ZARYA", "RS0ISS", "NA1SS"], norad: 25544, via: "ARISS", speed: 1200, freq: "145.825" },
  { label: "IO-86", names: ["IO-86", "LAPAN-A2", "YB0X"], norad: 40931, via: "YB0X", speed: 1200, freq: "145.825" },
  { label: "NO-44", names: ["NO-44", "PCSAT", "PCSAT-1", "W3ADO-1"], norad: 26931, via: "W3ADO-1", speed: 1200, freq: "145.825" },
  { label: "SONATE-2", names: ["SONATE-2", "DP0SNX"], norad: 59112, via: "DP0SNX", speed: 1200, freq: "145.825" },
  { label: "CroCube", names: ["CROCUBE", "9A0CC"], norad: 62394, via: "9A0CC", speed: 9600, freq: "436.775" },
  { label: "GRBBeta", names: ["GRBBETA", "HA2GRB"], norad: 60237, via: "HA2GRB", speed: 9600, freq: "145.935 / 436.785" },
  { label: "KNACKSAT-2", names: ["KNACKSAT-2", "HS-0K", "HS0K"], norad: 67683, speed: 9600, freq: "145.825" },
  { label: "KOSTKA", names: ["KOSTKA", "OK0KST"], norad: 69935, via: "OK0KST", speed: 9600, freq: "436.870" },
  { label: "LASARsat", names: ["LASARSAT", "OK0LSR"], via: "OK0LSR", speed: 9600, freq: "436.925" },
  { label: "Marina", names: ["MARINA", "OM9MAR"], norad: 69920, via: "OM9MAR", speed: 9600, freq: "145.925 / 436.680" },
];

const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Catalog entry for a sat context {satKey, satName, norad} or null. */
function catalogEntry(sat) {
  if (!sat) return null;
  const n = Number(sat.norad);
  const toks = new Set();
  for (const v of [sat.satKey, sat.satName, sat.satFullName]) {
    if (!v) continue;
    toks.add(norm(v));
    String(v)
      .split(/[\s()\/,;]+/)
      .forEach((t) => t && toks.add(norm(t)));
  }
  for (const e of SAT_SPEEDS) {
    if (e.norad && n === e.norad) return e;
    if (e.names.some((x) => toks.has(norm(x)))) return e;
  }
  return null;
}

/** Speed from the selected mode text, e.g. "APRS 1k2 AFSK", "9k6 GMSK" -> 1200 / 9600 / null. */
function speedFromMode(mode) {
  const m = String(mode || "");
  if (/9k6|9600|G3RUH/i.test(m)) return 9600;
  if (/1k2|1200|AFSK/i.test(m)) return 1200;
  return null;
}

/**
 * {speed, source} for a sat: per-sat setting > AMSAT list > selected mode > 1200.
 * satSpeeds keys like satPaths: sat key, display name or NORAD.
 */
function speedForSat(satSpeeds, sat) {
  const sp = satSpeeds || {};
  if (sat) {
    for (const k of [sat.satKey, sat.satName, sat.norad != null ? String(sat.norad) : ""]) {
      const key = String(k || "").toUpperCase();
      if (key && (sp[key] === 1200 || sp[key] === 9600)) return { speed: sp[key], source: "setting" };
    }
  }
  const e = catalogEntry(sat);
  if (e) return { speed: e.speed, source: "amsat" };
  const m = sat && speedFromMode(sat.mode);
  if (m) return { speed: m, source: "mode" };
  return { speed: 1200, source: "default" };
}

/** Extra Via calls a catalog sat also answers to (shown as options, not defaults). */
const EXTRA_VIAS = [
  { via: "RS0ISS", label: "ISS" },
  { via: "PCSAT-1", label: "NO-44" },
];

/**
 * Built-in Via choices for the To / Via dropdowns: every catalog sat with a
 * published Via (label = sat name + speed), then the extra calls above.
 * [{value, label}], no duplicates.
 */
function viaOptions() {
  const out = [];
  const seen = new Set();
  const add = (value, label) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push({ value, label });
  };
  for (const e of SAT_SPEEDS) if (e.via) add(e.via, (e.label || e.names[0]) + (e.speed === 9600 ? " · 9k6" : ""));
  for (const x of EXTRA_VIAS) add(x.via, x.label);
  return out;
}

module.exports = { SAT_SPEEDS, catalogEntry, speedFromMode, speedForSat, viaOptions };
