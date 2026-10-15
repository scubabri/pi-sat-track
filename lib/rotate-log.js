/**
 * Best-effort log rotation: keep N numbered backups of a log file.
 *
 * Shifts path.4 → path.5 … path → path.1, then leaves path absent so the
 * caller can open a fresh file. Skips missing or empty files. Never throws;
 * returns { ok, rotated, reason?, error? }. On failure the caller should warn
 * and continue — rotation must not stop the server from starting.
 */
const fs = require("fs");

/** How many old copies to keep (path.1 … path.N). */
const KEEP = 5;

/**
 * @param {string} filePath absolute or relative path to the live log
 * @param {{ keep?: number }} [opts]
 * @returns {{ ok: boolean, rotated: boolean, reason?: string, error?: string }}
 */
function rotateLogFile(filePath, opts) {
  const keep = opts && opts.keep != null ? Number(opts.keep) : KEEP;
  if (!filePath || typeof filePath !== "string") {
    return { ok: false, rotated: false, reason: "bad-path" };
  }
  if (!Number.isFinite(keep) || keep < 1) {
    return { ok: false, rotated: false, reason: "bad-keep" };
  }

  try {
    if (!fs.existsSync(filePath)) {
      return { ok: true, rotated: false, reason: "missing" };
    }
    let st;
    try {
      st = fs.statSync(filePath);
    } catch (e) {
      return { ok: false, rotated: false, error: e.message };
    }
    if (!st.isFile()) {
      return { ok: true, rotated: false, reason: "not-file" };
    }
    if (st.size === 0) {
      return { ok: true, rotated: false, reason: "empty" };
    }

    const oldest = filePath + "." + keep;
    if (fs.existsSync(oldest)) {
      fs.unlinkSync(oldest);
    }
    for (let i = keep - 1; i >= 1; i--) {
      const src = filePath + "." + i;
      const dst = filePath + "." + (i + 1);
      if (fs.existsSync(src)) {
        fs.renameSync(src, dst);
      }
    }
    fs.renameSync(filePath, filePath + ".1");
    return { ok: true, rotated: true };
  } catch (e) {
    return {
      ok: false,
      rotated: false,
      error: e && e.message ? e.message : String(e),
    };
  }
}

module.exports = {
  rotateLogFile,
  KEEP,
};
