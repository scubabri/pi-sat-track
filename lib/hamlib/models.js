/**
 * Hamlib model list / capabilities / rigctld arguments (pure functions, no I/O).
 *
 *   parseList(text)            `rigctl -l` / `rotctl -l` -> [{ id, mfg, model, version, status, macro }]
 *   groupByMfg(list)           -> [{ mfg, models: [...] }] (sorted)
 *   nativeFor(entry)           our own driver for this Hamlib model, or null
 *   chooseDriver(entry, opts)  driver for a side whose Connection is Hamlib serial: always "hamlib"
 *   parseCaps(dump, conf)      `rigctl -m N --dump-caps` (+ `-L`) -> serial defaults, split / SATMODE
 *   buildRigctldArgs(o)        argv for rigctld (-m -r -s -C … -T 127.0.0.1 -t port)
 */

/** Parse the fixed-width `rigctl -l` table. Column starts come from the header line. */
function parseList(text) {
  const lines = String(text || "").split(/\r?\n/);
  const hi = lines.findIndex((l) => /^\s*(Rig|Rot)\s*#/.test(l) && /\bMfg\b/.test(l) && /\bModel\b/.test(l));
  if (hi < 0) return [];
  const h = lines[hi];
  const col = {
    mfg: h.indexOf("Mfg"),
    model: h.indexOf("Model"),
    version: h.indexOf("Version"),
    status: h.indexOf("Status"),
    macro: h.indexOf("Macro"),
  };
  const out = [];
  for (const l of lines.slice(hi + 1)) {
    const m = /^\s*(\d+)\s/.exec(l);
    if (!m) continue;
    const cut = (a, b) => (b > a ? l.slice(a, b) : l.slice(a)).trim();
    let mfg = cut(col.mfg, col.model);
    let model = cut(col.model, col.version);
    const version = cut(col.version, col.status);
    let status = cut(col.status, col.macro >= 0 ? col.macro : -1);
    const macro = col.macro >= 0 ? cut(col.macro, -1) : "";
    // Overlong names push columns right: fall back to whitespace split for status.
    if (!/^(Stable|Beta|Alpha|Untested|New|Buggy)$/i.test(status)) {
      const st = /\b(Stable|Beta|Alpha|Untested|New|Buggy)\b/i.exec(l.slice(col.version));
      status = st ? st[1] : status;
    }
    if (!model) model = mfg; // e.g. "FLRig" has no model text
    out.push({ id: parseInt(m[1], 10), mfg: mfg || "Other", model, version, status: status || "Untested", macro });
  }
  return out;
}

/** Manufacturer groups, alphabetical (Hamlib's own virtual rigs last), models by name. */
function groupByMfg(list) {
  const by = new Map();
  for (const e of list || []) {
    const k = e.mfg || "Other";
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(e);
  }
  const natural = (a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
  return Array.from(by.keys())
    .sort((a, b) => (a === "Hamlib") - (b === "Hamlib") || natural(a, b))
    .map((mfg) => ({ mfg, models: by.get(mfg).slice().sort((a, b) => natural(a.model, b.model)) }));
}

/**
 * Hamlib model number -> our native driver. Serial ones keep their native
 * driver; Flex rigs are better served by the native SmartSDR CAT (TCP).
 */
const NATIVE = {
  3085: { transport: "serial", serialMake: "icom", serialModel: "ic-705", label: "IC-705 (built-in CI-V driver)" },
  3081: { transport: "serial", serialMake: "icom", serialModel: "ic-9700", label: "IC-9700 (built-in CI-V driver)" },
  1035: { transport: "serial", serialMake: "yaesu", serialModel: "ft-991", label: "FT-991 / 991A (built-in CAT driver)" },
  1001: { transport: "serial", serialMake: "yaesu", serialModel: "ft-847", label: "FT-847 (built-in CAT driver)" },
  1038: { transport: "serial", serialMake: "yaesu", serialModel: "ft-847", label: "FT-847 (built-in CAT driver)" },
  1020: { transport: "serial", serialMake: "yaesu", serialModel: "ft-817", label: "FT-817 (built-in CAT driver)" },
  1041: { transport: "serial", serialMake: "yaesu", serialModel: "ft-817", label: "FT-818 (built-in FT-817 driver)" },
  2014: { transport: "serial", serialMake: "kenwood", serialModel: "ts-2000", label: "TS-2000 (built-in CAT driver)" },
};
const FLEX_NATIVE = { transport: "tcp", type: "smartsdr", protocol: "cat", label: "FlexRadio: built-in SmartSDR CAT (TCP)" };

function nativeFor(entry) {
  if (entry == null) return null;
  const id = typeof entry === "object" ? entry.id : parseInt(entry, 10);
  if (NATIVE[id]) return Object.assign({}, NATIVE[id]);
  const mfg = typeof entry === "object" ? String(entry.mfg || "") : "";
  const model = typeof entry === "object" ? String(entry.model || "") : "";
  if (id === 2036 || (/^FlexRadio$/i.test(mfg) && /^(6xxx|SmartSDR)/i.test(model))) return Object.assign({}, FLEX_NATIVE);
  return null;
}

/**
 * Driver for a Hamlib-serial side: always "hamlib" — the user picked Hamlib.
 * nativeFor() is only a UI hint that Native serial is also available.
 */
function chooseDriver(_entry, _opts) {
  return "hamlib";
}

/** Serial defaults and split / SATMODE support from `--dump-caps` (+ optional `-L` conf text). */
function parseCaps(dump, conf) {
  const t = String(dump || "");
  const g = (re) => {
    const m = re.exec(t);
    return m ? m[1].trim() : "";
  };
  const yes = (label) => new RegExp("^" + label + ":\\s*Y", "mi").test(t);
  const caps = {
    model: g(/^Model name:\s*(.*)$/m),
    mfg: g(/^Mfg name:\s*(.*)$/m),
    status: g(/^Backend status:\s*(.*)$/m),
    portType: g(/^Port type:\s*(.*)$/m) || "",
    baudMin: null,
    baudMax: null,
    defaultBaud: null,
    dataBits: 8,
    parity: "None",
    stopBits: 1,
    handshake: "None",
    canSplit: yes("Can set Split VFO") || yes("Can set Split Freq"),
    canSplitFreq: yes("Can set Split Freq"),
    hasSatmode: /^Set functions:.*\bSATMODE\b/m.test(t),
    targetableVfo: yes("Has targetable VFO"),
    civAddr: null,
  };
  const sp = /^Serial speed:\s*(\d+)\.\.(\d+)\s*baud[s]?,\s*(\d)([NEOMS])(\d),\s*ctrl=(\S+)/im.exec(t);
  if (sp) {
    caps.baudMin = +sp[1];
    caps.baudMax = +sp[2];
    caps.dataBits = +sp[3];
    caps.parity = { N: "None", E: "Even", O: "Odd", M: "Mark", S: "Space" }[sp[4].toUpperCase()] || "None";
    caps.stopBits = +sp[5];
    caps.handshake = /HARDWARE|CTS|RTS/i.test(sp[6]) ? "Hardware" : /XON/i.test(sp[6]) ? "XONXOFF" : "None";
    // Prefer common CAT speeds the radio allows (most USB rigs default to 19200).
    const pref = [19200, 38400, 9600, 4800, 57600, 115200, 2400, 1200];
    caps.defaultBaud = pref.find((b) => b >= caps.baudMin && b <= caps.baudMax) || caps.baudMax;
  }
  const c = String(conf || "");
  const cv = /^civaddr:.*\n\s*Default:\s*\S+,\s*Value:\s*(\d+)/m.exec(c);
  if (cv && +cv[1] > 0) caps.civAddr = +cv[1];
  return caps;
}

const HANDSHAKES = ["None", "XONXOFF", "Hardware"];
const LINE_STATES = ["Unset", "ON", "OFF"];
const PARITIES = ["None", "Even", "Odd", "Mark", "Space"];

/** CI-V address "94" / "0x94" / 148 -> 148, or null. */
function parseCiv(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v >= 1 && v <= 255 ? v : null;
  const s = String(v).trim().toLowerCase().replace(/h$/, "");
  const n = /^0x/.test(s) ? parseInt(s, 16) : /^[0-9a-f]{1,2}$/.test(s) && /[a-f]/.test(s) ? parseInt(s, 16) : /^\d+$/.test(s) ? (s.length <= 2 ? parseInt(s, 16) : parseInt(s, 10)) : NaN;
  return n >= 1 && n <= 255 ? n : null;
}

/**
 * rigctld argv for a Hamlib-serial side. Only options that differ from
 * "leave it to Hamlib" are passed (blank / Unset / default = omitted).
 */
function buildRigctldArgs(o) {
  o = o || {};
  const model = parseInt(o.model, 10);
  if (!(model > 0)) throw new Error("Hamlib model number missing");
  const port = parseInt(o.port, 10);
  if (!(port > 0 && port < 65536)) throw new Error("rigctld TCP port missing");
  const a = ["-m", String(model)];
  if (o.device) a.push("-r", String(o.device));
  const baud = parseInt(o.baud, 10);
  if (baud > 0) a.push("-s", String(baud));
  const civ = parseCiv(o.civAddr);
  if (civ != null) a.push("-c", "0x" + civ.toString(16).toUpperCase().padStart(2, "0"));
  const conf = [];
  const db = parseInt(o.dataBits, 10);
  if (db >= 5 && db <= 8) conf.push("data_bits=" + db);
  const sb = parseInt(o.stopBits, 10);
  if (sb === 1 || sb === 2) conf.push("stop_bits=" + sb);
  if (o.parity && PARITIES.includes(o.parity)) conf.push("serial_parity=" + o.parity);
  if (o.handshake && HANDSHAKES.includes(o.handshake)) conf.push("serial_handshake=" + o.handshake);
  if (o.dtr && LINE_STATES.includes(o.dtr) && o.dtr !== "Unset") conf.push("dtr_state=" + o.dtr);
  if (o.rts && LINE_STATES.includes(o.rts) && o.rts !== "Unset") conf.push("rts_state=" + o.rts);
  if (conf.length) a.push("-C", conf.join(","));
  a.push("-T", o.host || "127.0.0.1", "-t", String(port));
  return a;
}

/** Side config (transport "hamlib") -> buildRigctldArgs options. */
function sideToRigctld(side, port) {
  const s = side || {};
  return {
    model: s.hamlibModel,
    device: s.serialDevice,
    baud: s.serialBaud,
    dataBits: s.hamlibDataBits,
    stopBits: s.hamlibStopBits,
    parity: s.hamlibParity,
    handshake: s.hamlibHandshake,
    dtr: s.hamlibDtr,
    rts: s.hamlibRts,
    civAddr: s.hamlibCivAddr,
    port: port || s.hamlibPort,
  };
}

module.exports = {
  parseList,
  groupByMfg,
  nativeFor,
  chooseDriver,
  parseCaps,
  parseCiv,
  buildRigctldArgs,
  sideToRigctld,
  NATIVE,
  HANDSHAKES,
  LINE_STATES,
  PARITIES,
};
