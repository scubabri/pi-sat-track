/**
 * LoTW accepted satellite names (ADIF SAT_NAME). LoTW rejects a satellite
 * QSO whose SAT_NAME is not on its list, so names must match exactly
 * (e.g. "AO-7" not "AO7", ISS = "ARISS", "RS95S" has no hyphen).
 *
 * Sources (fetched 2026-10-11):
 *  - Canonical list: LoTW FAQ
 *    https://lotw.arrl.org/lotw-help/frequently-asked-questions/#sats
 *  - Extra names + descriptions + service dates: TQSL configuration
 *    https://lotw.arrl.org/lotw/config.tq6 (gzip of TQSL config.xml,
 *    <satellites>, tqslconfig 11.34). TQSL validates against this file.
 *  - Rules: https://lotw.arrl.org/lotw-help/satellite-qsos/
 */
const LOTW_SOURCE = {
  faq: "https://lotw.arrl.org/lotw-help/frequently-asked-questions/#sats",
  tqslConfig: "https://lotw.arrl.org/lotw/config.tq6 (v11.34)",
  fetched: "2026-10-11",
};

/** Canonical list from the LoTW FAQ. */
const LOTW_SAT_NAMES = [
  "AISAT1", "AO-10", "AO-13", "AO-16", "AO-21", "AO-24", "AO-27", "AO-3",
  "AO-4", "AO-40", "AO-51", "AO-6", "AO-7", "AO-73", "AO-8", "AO-85",
  "AO-91", "AO-92", "AO-109", "AO-123", "ARISS", "BO-102", "BY70-1",
  "CAS-3H", "CAS-4A", "CAS-4B", "DO-64", "EO-79", "EO-88", "ESEO", "FO-12",
  "FO-20", "FO-29", "FO-99", "FS-3", "HO-68", "HO-107", "HO-113", "IO-86",
  "IO-117", "INSPR7", "JO-97", "KEDR", "LEDSAT", "LO-19", "LO-78", "LO-87",
  "LO-90", "MAYA-3", "MAYA-4", "MIREX", "MO-112", "MO-122", "NO-44", "NO-83",
  "NO-84", "NO-103", "NO-104", "PO-101", "QO-100", "RS-1", "RS-10", "RS-11",
  "RS-12", "RS-13", "RS-15", "RS-2", "RS-44", "RS-5", "RS-6", "RS-7", "RS-8",
  "RS95S", "SAREX", "SONATE", "SO-35", "SO-41", "SO-50", "SO-121", "SO-124",
  "SO-125", "TAURUS", "TEV2-1", "TEV2-2", "TEV2-3", "TEV2-4", "TEV2-5",
  "TEV2-6", "TEV2-7", "TEV2-8", "TEV2-9", "TEVEL1", "TEVEL2", "TEVEL3",
  "TEVEL4", "TEVEL5", "TEVEL6", "TEVEL7", "TEVEL8", "UKUBE1", "TO-108",
  "UO-14", "UVSQ", "VO-52", "XW-2A", "XW-2B", "XW-2C", "XW-2D", "XW-2E",
  "XW-2F",
];

/** In TQSL config.tq6 but not (yet) on the FAQ page — TQSL accepts them. */
const TQSL_EXTRA_SAT_NAMES = ["Arsene", "CAS-2T", "FO-118", "HO-119", "SO-67"];

/** TQSL config.xml metadata: name -> [description, startDate, endDate]. */
const TQSL_SAT_META = {
  "AISAT1": ["AISAT-1 AMSAT India APRS Digipeater", "2019-04-07", ""],
  "AO-10": ["AMSAT-OSCAR 10", "1983-06-16", ""],
  "AO-109": ["AMSAT-OSCAR 109", "2021-07-20", ""],
  "AO-123": ["ASRTU-OSCAR 123", "2024-11-04", ""],
  "AO-13": ["AMSAT-OSCAR 13", "1988-06-15", "1996-12-07"],
  "AO-16": ["AMSAT-OSCAR 16", "1990-01-22", ""],
  "AO-21": ["OSCAR 21/RS-14", "1991-01-29", "1994-09-16"],
  "AO-27": ["AMRAD-OSCAR 27", "1993-09-26", ""],
  "AO-3": ["AMSAT-OSCAR 3", "1965-03-18", "1965-03-27"],
  "AO-4": ["AMSAT-OSCAR 4", "1965-12-21", "1966-03-16"],
  "AO-40": ["AMSAT-OSCAR 40", "2000-11-16", "2004-01-25"],
  "AO-51": ["AMSAT-OSCAR 51", "2004-06-29", "2011-11-29"],
  "AO-6": ["AMSAT-OSCAR 6", "1972-10-15", "1977-06-21"],
  "AO-7": ["AMSAT-OSCAR 7", "1974-11-15", ""],
  "AO-73": ["AMSAT-OSCAR 73", "2013-11-21", ""],
  "AO-8": ["AMSAT-OSCAR 8", "1978-03-15", "1983-06-24"],
  "AO-85": ["AMSAT-OSCAR 85 (Fox-1A)", "2015-10-09", ""],
  "AO-91": ["AMSAT-OSCAR 91 (RadFxSat / Fox-1B)", "2017-11-23", ""],
  "AO-92": ["AMSAT-OSCAR 92 (Fox-1D)", "2018-01-12", ""],
  "ARISS": ["ARISS", "1998-11-20", ""],
  "Arsene": ["OSCAR 24", "1993-05-13", "1993-09-10"],
  "BO-102": ["BIT Progress-OSCAR 102 (CAS-7B)", "2019-07-25", ""],
  "BY70-1": ["Bayi Kepu Weixing 1", "2016-12-28", "2017-02-17"],
  "CAS-2T": ["CAS-2T", "2016-11-09", ""],
  "CAS-3H": ["LilacSat-2", "2015-09-18", ""],
  "CAS-4A": ["CAMSAT 4A (CAS-4A)", "2017-10-18", ""],
  "CAS-4B": ["CAMSAT 4B (CAS-4B)", "2017-10-18", ""],
  "DO-64": ["Delfi OSCAR-64", "2008-04-28", ""],
  "EO-79": ["FUNcube-3", "2014-06-19", ""],
  "EO-88": ["Emirates-OSCAR 88 (Nayif-1)", "2017-02-15", ""],
  "FO-118": ["CAS-5A", "2022-12-09", ""],
  "FO-12": ["Fuji-OSCAR 12", "1986-08-12", "1989-11-05"],
  "FO-20": ["Fuji-OSCAR 20", "1990-02-07", ""],
  "FO-29": ["Fuji-OSCAR 29", "1996-07-17", ""],
  "FO-99": ["Fuji-OSCAR 99 (NEXUS)", "2019-01-26", ""],
  "FS-3": ["FalconSAT 3", "2017-09-24", ""],
  "HO-107": ["HuskySat OSCAR 107", "2020-05-10", ""],
  "HO-113": ["HO-113", "2021-12-26", ""],
  "HO-119": ["Hope-OSCAR 119", "2022-12-18", ""],
  "HO-68": ["Hope-Oscar 68", "2009-12-15", ""],
  "INSPR7": ["INSPIRE-Sat7", "2023-04-15", ""],
  "IO-117": ["GreenCube", "2022-07-13", ""],
  "IO-86": ["Indonesia-OSCAR 86 (LAPAN-ORARI)", "2015-09-28", ""],
  "JO-97": ["Jordan-OSCAR 97(JY1Sat)", "2018-12-08", ""],
  "KEDR": ["ARISSat-1", "2011-08-03", "2012-01-04"],
  "LEDSAT": ["LEDSAT", "2021-08-17", ""],
  "LO-19": ["Lusat-OSCAR 19", "1990-01-22", ""],
  "LO-78": ["LituanicaSAT-1", "2014-04-22", "2014-07-28"],
  "LO-87": ["LUSEX-OSCAR 87", "2016-05-30", ""],
  "LO-90": ["LilacSat-OSCAR 90 (LilacSat-1)", "2017-05-25", ""],
  "MAYA-3": ["Cubesat", "2021-10-10", ""],
  "MAYA-4": ["Cubesat", "2021-10-10", ""],
  "MIREX": ["MIR Packet Digipeater", "1991-02-01", "2000-06-16"],
  "MO-112": ["Mirsat-1", "2021-06-22", ""],
  "MO-122": ["MESAT1-OSCAR 122", "2024-07-04", ""],
  "NO-103": ["Navy-OSCAR 103 (BRICSAT 2)", "2019-06-25", ""],
  "NO-104": ["Navy-OSCAR 104 (PSAT 2)", "2019-06-25", ""],
  "NO-44": ["Navy-OSCAR 44", "2001-09-30", ""],
  "NO-83": ["BRICsat", "2015-05-20", ""],
  "NO-84": ["PSAT", "2015-05-20", ""],
  "PO-101": ["Phillipines-OSCAR-101 (Diwata-2)", "2018-10-18", ""],
  "QO-100": ["Qatar-OSCAR 100 (Es'hail-2/P4A)", "2019-02-02", ""],
  "RS-1": ["Radio Sputnik 1", "1978-10-26", "1979-02-01"],
  "RS-10": ["Radio Sputnik 10", "1987-06-23", "2000-11-01"],
  "RS-11": ["Radio Sputnik 11", "1987-06-23", "2000-11-01"],
  "RS-12": ["Radio Sputnik 12", "1991-02-05", "2002-02-15"],
  "RS-13": ["Radio Sputnik 13", "1991-02-05", "2002-02-15"],
  "RS-15": ["Radio Sputnik 15", "1994-12-16", ""],
  "RS-2": ["Radio Sputnik 2", "1978-10-26", "1979-02-01"],
  "RS-44": ["Radio Sputnik 44 (DOSAAF-85)", "2020-04-30", ""],
  "RS-5": ["Radio Sputnik 5", "1981-12-17", "1987-05-10"],
  "RS-6": ["Radio Sputnik 6", "1981-12-17", "1984-12-09"],
  "RS-7": ["Radio Sputnik 7", "1981-12-18", "1987-06-01"],
  "RS-8": ["Radio Sputnik 8", "1981-12-17", "1985-12-16"],
  "SAREX": ["Shuttle Amateur Radio Experiment (SAREX) Digipeater", "1990-12-02", "1999-07-28"],
  "SO-121": ["Hades-D", "2023-11-11", ""],
  "SO-124": ["Hades-R", "2025-01-14", ""],
  "SO-125": ["Hades-ICM", "2025-06-05", ""],
  "SO-35": ["Sunsat-OSCAR 35", "1999-02-23", "2001-06-10"],
  "SO-41": ["Saudi-OSCAR 41", "2000-09-26", ""],
  "SO-50": ["Saudi-OSCAR 50", "2002-12-20", ""],
  "SO-67": ["Sumbandila Oscar 67", "2009-09-17", ""],
  "SONATE": ["SONATE-2", "2024-03-04", ""],
  "TAURUS": ["Taurus-1 (Jinniuzuo-1)", "2019-09-17", ""],
  "TEV2-1": ["Tevel2-1", "2025-03-15", ""],
  "TEV2-2": ["Tevel2-2", "2025-03-15", ""],
  "TEV2-3": ["Tevel2-3", "2025-03-15", ""],
  "TEV2-4": ["Tevel2-4", "2025-03-15", ""],
  "TEV2-5": ["Tevel2-5", "2025-03-15", ""],
  "TEV2-6": ["Tevel2-6", "2025-03-15", ""],
  "TEV2-7": ["Tevel2-7", "2025-03-15", ""],
  "TEV2-8": ["Tevel2-8", "2025-03-15", ""],
  "TEV2-9": ["Tevel2-9", "2025-03-15", ""],
  "TEVEL1": ["Tevel-1", "2022-01-13", ""],
  "TEVEL2": ["Tevel-2", "2022-01-13", ""],
  "TEVEL3": ["Tevel-3", "2022-01-13", ""],
  "TEVEL4": ["Tevel-4", "2022-01-13", ""],
  "TEVEL5": ["Tevel-5", "2022-01-13", ""],
  "TEVEL6": ["Tevel-6", "2022-01-13", ""],
  "TEVEL7": ["Tevel-7", "2022-01-13", ""],
  "TEVEL8": ["Tevel-8", "2022-01-13", ""],
  "TO-108": ["TQ-OSCAR 108 (CAS-6 / TQ-1)", "2019-12-20", ""],
  "UKUBE1": ["UKube-1 (FUNcube-2)", "2016-06-01", ""],
  "UO-14": ["UOSAT-OSCAR 14", "1990-01-22", ""],
  "UVSQ": ["CubeSat", "2021-03-05", ""],
  "VO-52": ["VUsat-OSCAR 52", "2005-05-05", "2014-07-11"],
  "XW-2A": ["Hope 2A (CAS-3A)", "2015-09-18", ""],
  "XW-2B": ["Hope 2B (CAS-3B)", "2015-09-18", ""],
  "XW-2C": ["Hope 2C (CAS-3C)", "2015-09-18", ""],
  "XW-2D": ["Hope 2D (CAS-3D)", "2015-09-18", ""],
  "XW-2E": ["Hope 2E (CAS-3E)", "2015-09-18", ""],
  "XW-2F": ["Hope 2F (CAS-2F)", "2015-09-18", ""],
};

/**
 * Catalog/common names -> LoTW SAT_NAME (keys are normKey()'d).
 * Covers names that differ from the LoTW designator.
 */
const ALIASES = {
  ISS: "ARISS",
  ZARYA: "ARISS",
  ARISS: "ARISS",
  RS0ISS: "ARISS",
  GREENCUBE: "IO-117",
  XW3: "HO-113",
  CAS9: "HO-113",
  CAS5A: "FO-118",
  CAS6: "TO-108",
  TQ1: "TO-108",
  SONATE2: "SONATE",
  UVSQSAT: "UVSQ",
  INSPIRESAT7: "INSPR7",
  AISAT1: "AISAT1",
  UKUBE1: "UKUBE1",
  ARISSAT1: "KEDR",
  LITUANICASAT1: "LO-78",
  LY5N: "LO-78",
  FALCONSAT3: "FS-3",
  PFS3: "FS-3",
  TAURUS1: "TAURUS",
  TVL2: "TEV2-9",
};

/** NORAD overrides (null = known NOT to be on the LoTW list). */
const NORAD_TO_LOTW = {
  25544: "ARISS", // ISS
  50466: "HO-113", // CAS-9 / XW-3
  47438: "UVSQ", // UVSQ-SAT
  59112: "SONATE", // SONATE-2 (LoTW "SONATE" starts 2024-03-04)
  44400: null, // original SONATE (2019) — not on the LoTW list
};

/**
 * Uppercase, strip spaces/hyphens/punctuation, drop leading zeros in numbers
 * (AO-07 -> AO7). Equivalent to trying with and without the letter-digit hyphen.
 */
function normKey(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/([A-Z])0+(\d)/g, "$1$2");
}

const ALL_NAMES = LOTW_SAT_NAMES.concat(TQSL_EXTRA_SAT_NAMES);
const BY_KEY = new Map();
for (const n of ALL_NAMES) BY_KEY.set(normKey(n), n);
for (const k of Object.keys(ALIASES)) {
  if (!BY_KEY.has(normKey(k))) BY_KEY.set(normKey(k), ALIASES[k]);
}
// Index TQSL descriptions (e.g. "Hope 2A (CAS-3A)", "Tevel2-1") as aliases
const BY_DESC = new Map();
for (const n of Object.keys(TQSL_SAT_META)) {
  const desc = TQSL_SAT_META[n][0] || "";
  const paren = desc.match(/\(([^)]+)\)/);
  const bare = desc.replace(/\([^)]*\)/g, "").trim();
  [desc, bare, paren && paren[1]].forEach((d) => {
    if (!d) return;
    String(d)
      .split("/")
      .forEach((part) => {
        const k = normKey(part);
        if (k && k.length >= 3 && !BY_DESC.has(k)) BY_DESC.set(k, n);
      });
  });
}

function isLotwSatName(name) {
  return ALL_NAMES.indexOf(String(name || "")) >= 0;
}

/**
 * Resolve the LoTW SAT_NAME for a tracker satellite.
 * @param {{display?:string,name?:string,key?:string,callsign?:string,norad?:number}} sat
 * @param {Date} [when] QSO time; checked against the TQSL service window.
 * @returns {{satName:string, accepted:boolean, warning:string|null}}
 */
function resolveSatName(sat, when) {
  const s = sat || {};
  const fallback = String(s.display || s.name || s.key || "")
    .trim()
    .toUpperCase();
  let name = null;
  const hasOverride =
    s.norad != null &&
    Object.prototype.hasOwnProperty.call(NORAD_TO_LOTW, s.norad);
  if (hasOverride) {
    name = NORAD_TO_LOTW[s.norad];
  } else {
    const cands = [s.display, s.name, s.key].filter(Boolean);
    for (const c of cands) {
      name = BY_KEY.get(normKey(c)) || null;
      if (name) break;
    }
    if (!name) {
      for (const c of cands) {
        name = BY_DESC.get(normKey(c)) || null;
        if (name) break;
      }
    }
  }
  if (!name) {
    return {
      satName: fallback,
      accepted: false,
      warning:
        'Sat name "' + fallback + '" may not be LoTW-accepted (not on LoTW list)',
    };
  }
  let warning = null;
  const meta = TQSL_SAT_META[name];
  if (meta && when instanceof Date && !isNaN(when.getTime())) {
    const d = when.toISOString().slice(0, 10);
    if (meta[1] && d < meta[1])
      warning = "LoTW accepts " + name + " QSOs only from " + meta[1];
    else if (meta[2] && d > meta[2])
      warning = "LoTW accepts " + name + " QSOs only until " + meta[2];
  }
  return { satName: name, accepted: !warning, warning };
}

module.exports = {
  LOTW_SOURCE,
  LOTW_SAT_NAMES,
  TQSL_EXTRA_SAT_NAMES,
  TQSL_SAT_META,
  isLotwSatName,
  resolveSatName,
  normKey,
};
