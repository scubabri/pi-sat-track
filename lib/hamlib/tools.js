/**
 * Find and run the Hamlib command-line tools (rigctl, rigctld, rotctl, rotctld).
 *
 * Search order:
 *   1. HAMLIB_BIN env (a bin folder)
 *   2. ~/.rpitrack/hamlib/current.json  (installed by the in-app Update, Windows)
 *   3. PATH
 *   4. Windows: C:\Program Files\hamlib-w64-*\bin (newest), Program Files (x86)
 *      macOS: /opt/homebrew/bin, /usr/local/bin
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const IS_WIN = process.platform === "win32";
const EXE = IS_WIN ? ".exe" : "";

function hamlibHome() {
  return path.join(os.homedir(), ".rpitrack", "hamlib");
}
function currentFile() {
  return path.join(hamlibHome(), "current.json");
}
function readCurrent() {
  try {
    return JSON.parse(fs.readFileSync(currentFile(), "utf8"));
  } catch (_) {
    return null;
  }
}

/** "4.6.2" style compare: >0 if a newer than b. */
function cmpVersion(a, b) {
  const pa = String(a || "").replace(/^v/i, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "").replace(/^v/i, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function windowsProgramDirs() {
  const roots = [process.env.ProgramW6432, process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean);
  const out = [];
  for (const r of Array.from(new Set(roots))) {
    let names = [];
    try {
      names = fs.readdirSync(r).filter((n) => /^hamlib/i.test(n));
    } catch (_) {}
    names.sort((a, b) => cmpVersion(b.replace(/^\D+/, ""), a.replace(/^\D+/, "")));
    for (const n of names) out.push(path.join(r, n, "bin"));
  }
  return out;
}

function candidateDirs() {
  const dirs = [];
  if (process.env.HAMLIB_BIN) dirs.push({ dir: process.env.HAMLIB_BIN, source: "HAMLIB_BIN" });
  const cur = readCurrent();
  if (cur && cur.bin) dirs.push({ dir: cur.bin, source: "in-app update " + (cur.version || "") });
  for (const d of String(process.env.PATH || "").split(path.delimiter)) if (d) dirs.push({ dir: d, source: "PATH" });
  if (IS_WIN) for (const d of windowsProgramDirs()) dirs.push({ dir: d, source: "Program Files" });
  if (process.platform === "darwin") {
    dirs.push({ dir: "/opt/homebrew/bin", source: "Homebrew" }, { dir: "/usr/local/bin", source: "Homebrew" });
  }
  return dirs;
}

/** Full path of a Hamlib tool, or null. */
function find(tool) {
  for (const c of candidateDirs()) {
    const p = path.join(c.dir, tool + EXE);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch (_) {}
  }
  return null;
}
function findWithSource(tool) {
  for (const c of candidateDirs()) {
    const p = path.join(c.dir, tool + EXE);
    try {
      if (fs.statSync(p).isFile()) return { path: p, source: c.source };
    } catch (_) {}
  }
  return null;
}

/**
 * Run a tool; resolves { code, stdout, stderr } (never rejects on exit code:
 * `rigctl -L` exits 2 after printing). Rejects only if it could not start.
 */
function run(bin, args, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    cp.execFile(bin, args, { timeout: opts.timeoutMs || 15000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err && (err.code === "ENOENT" || err.code === "EACCES")) return reject(err);
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || ""), killed: !!(err && err.killed) });
    });
  });
}

/** "rigctld Hamlib 4.6.2 2025-02-09…" -> "4.6.2" */
function parseVersion(text) {
  const m = /Hamlib\s+(\d+\.\d+(?:\.\d+)?(?:~\w+)?)/i.exec(String(text || ""));
  return m ? m[1] : null;
}

async function version() {
  const f = findWithSource("rigctld");
  if (!f) return { installed: false, version: null, path: null, source: null };
  try {
    const r = await run(f.path, ["--version"], { timeoutMs: 8000 });
    return { installed: true, version: parseVersion(r.stdout + r.stderr), path: f.path, source: f.source, raw: (r.stdout || r.stderr).split(/\r?\n/)[0] };
  } catch (e) {
    return { installed: false, version: null, path: f.path, source: f.source, error: e.message };
  }
}

module.exports = { find, findWithSource, run, version, parseVersion, cmpVersion, hamlibHome, currentFile, readCurrent, windowsProgramDirs, IS_WIN, EXE };
