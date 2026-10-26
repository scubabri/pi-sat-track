"use strict";
/**
 * Build / version label shown in the UI (Station → Version) and logs.
 *
 * Order:
 *   1. <app>/VERSION         stamped by build-sfx.sh (SFX installer) as
 *                            "<BRANCH>-alpha.<N>", e.g. "UAT-alpha.43"
 *   2. git checkout          "<branch>+<short sha>" (detached HEAD: "<short sha>")
 *   3. ~/.rpitrack/version   recorded by the installer (app dir without VERSION)
 *   4. package.json version
 * A git checkout beats ~/.rpitrack/version so a dev checkout on a box that once
 * ran an installer doesn't claim the old installer build.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");

function tryRead(f) {
  try {
    const v = fs.readFileSync(f, "utf8").trim();
    return v || null;
  } catch (_) {
    return null;
  }
}

function gitLabel(dir, exec) {
  exec = exec || ((cmd) => cp.execSync(cmd, { cwd: dir, stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).toString().trim());
  if (!fs.existsSync(path.join(dir, ".git"))) return null; // .git dir, or file in a worktree
  try {
    const sha = exec("git rev-parse --short HEAD");
    if (!sha) return null;
    let branch = "";
    try { branch = exec("git rev-parse --abbrev-ref HEAD"); } catch (_) {}
    return branch && branch !== "HEAD" ? branch + "+" + sha : sha;
  } catch (_) {
    return null;
  }
}

/** -> { version, source: "build" | "git" | "installed" | "package" } */
function resolveVersion(opts) {
  opts = opts || {};
  const dir = opts.dir || path.join(__dirname, "..");
  const home = opts.home || os.homedir();
  let v = tryRead(path.join(dir, "VERSION"));
  if (v) return { version: v, source: "build" };
  v = gitLabel(dir, opts.exec);
  if (v) return { version: v, source: "git" };
  v = tryRead(path.join(home, ".rpitrack", "version"));
  if (v) return { version: v, source: "installed" };
  let pkg = "?";
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version || "?"; } catch (_) {}
  return { version: pkg, source: "package" };
}

module.exports = { resolveVersion, gitLabel };
