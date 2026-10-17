/**
 * Kenwood TS-2000 raw CAT helpers for the Hamlib/rigctl driver.
 *
 * Hamlib's TS-2000 backend (rigs/kenwood/ts2000.c) has no RIG_FUNC_SATMODE and
 * its set_vfo is a no-op while SAT is on (kenwood.c: "selecting VFO is useless
 * in SAT MODE"), so the rigctl driver talks to the radio through rigctld's
 * raw passthrough `w` with the same strings the native driver (ts2000.js) uses.
 *
 * rigctld `w` semantics (tests/rigctl_parse.c send_cmd, Hamlib 4.6+):
 *   - Kenwood backends: the ';' in the argument is sent as-is, no terminator.
 *   - It reads one ';'-terminated reply per ';' in the command, stopping at the
 *     first read timeout (rig timeout, 200 ms for the TS-2000).
 *   - Replies are printed separated by '\0'; a timeout with nothing read prints
 *     NOTHING (w is ARG_OUT so no "RPRT 0"). A pure set command therefore gets
 *     no reply at all → we always append a query ("FA…;FA;") so every `w`
 *     returns at least one token and never waits on our own CMD timeout.
 *   - A Kenwood nak shows up as a "?;" (or "E;"/"O;") token before the query reply.
 */

const MD = { LSB: "1", USB: "2", CW: "3", FM: "4", AM: "5", FSK: "6", CWR: "7", FSKR: "9" };

/** Hamlib 38-tone table (TN01..TN38, 1-based) — same as ts2000.js. */
const TONE_TABLE = [
  67.0, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4, 100.0,
  103.5, 107.2, 110.9, 114.8, 118.8, 123.0, 127.3, 131.8, 136.5, 141.3, 146.2,
  151.4, 156.7, 162.2, 167.9, 173.8, 179.9, 186.2, 192.8, 203.5, 210.7, 218.1,
  225.7, 233.6, 241.8, 250.3,
];

/** P1=1 SAT, P2=0 ch, P3=1 MAIN=DL/SUB=UL, P4=0 CTRL=MAIN, P5..P7=0 (TRACE off, VFO). */
const SA_ON = "SA1010000";
/** Same with P4=1 (control → SUB) for SUB mode / tone. */
const SA_CTRL_SUB = "SA1011000";
const SA_OFF = "SA0000000";

function mdCode(modeName) {
  return MD[String(modeName || "").toUpperCase()] || null;
}

function toneCode(hz) {
  if (hz == null || !Number.isFinite(Number(hz))) return null;
  const t = Number(hz);
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < TONE_TABLE.length; i++) {
    const d = Math.abs(TONE_TABLE[i] - t);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return bestD > 1.0 ? null : best + 1;
}

function bandOf(hz) {
  return hz >= 300e6 ? "70cm" : hz >= 100e6 ? "2m" : "other";
}

/** "FA" / "FB" + 11-digit Hz. */
function freqCmd(vfo, hz) {
  return (vfo === "B" ? "FB" : "FA") + String(Math.round(hz)).padStart(11, "0").slice(-11);
}

function parseSa(tok) {
  const m = String(tok || "").match(/SA(\d{1,8})/i);
  if (!m) return null;
  const d = m[1];
  return { on: d[0] === "1", p3: d.length > 2 ? d[2] : null, p4: d.length > 3 ? d[3] : null, raw: d };
}

function parseFreq(tok, vfo) {
  const m = String(tok || "").match(new RegExp("F" + (vfo || "A") + "(\\d{9,11})", "i"));
  return m ? parseInt(m[1], 10) : null;
}

/** Split accumulated `w` output into ';' tokens ("?;" naks kept). */
function tokens(text) {
  return String(text || "")
    .replace(/\0/g, "\n")
    .split(/[\r\n]+/)
    .join("")
    .split(";")
    .map((t) => t.trim())
    .filter(Boolean);
}

function isNakToken(t) {
  return t === "?" || t === "E" || t === "O";
}

/** Query prefixes (2 letters, no digits) a `w` command string will get replies for. */
function queriesIn(cmd) {
  return String(cmd)
    .split(";")
    .map((c) => c.trim())
    .filter((c) => /^[A-Z]{2}$/i.test(c))
    .map((c) => c.toUpperCase());
}

/**
 * Is the reply complete? true when every query has a matching token (in order).
 * Returns { done, naks, byQuery }.
 */
function matchReply(cmd, text) {
  const qs = queriesIn(cmd);
  const toks = tokens(text);
  const byQuery = {};
  let naks = 0;
  let qi = 0;
  for (const t of toks) {
    if (isNakToken(t)) {
      naks++;
      continue;
    }
    if (qi < qs.length && t.toUpperCase().startsWith(qs[qi])) {
      byQuery[qs[qi]] = t;
      qi++;
    }
  }
  return { done: qi >= qs.length, naks, byQuery };
}

module.exports = {
  MD,
  TONE_TABLE,
  SA_ON,
  SA_CTRL_SUB,
  SA_OFF,
  mdCode,
  toneCode,
  bandOf,
  freqCmd,
  parseSa,
  parseFreq,
  tokens,
  queriesIn,
  matchReply,
};
