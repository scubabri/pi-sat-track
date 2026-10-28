/**
 * Hamlib version check + in-app Update, per OS.
 *
 *   latestRelease()      GitHub Hamlib/Hamlib releases/latest (cached 6 h, failures -> null)
 *   planFor(platform)    which method the Update button uses here
 *   runUpdate(o)         do it; o.log(line) gets progress. Never prompts, never hangs:
 *     windows  download hamlib-w64-<ver>.zip, verify SHA-256 (SHA256SUM-w64-<ver>
 *              asset and/or the release digest), extract to
 *              ~/.rpitrack/hamlib/<ver>, point current.json at it (previous kept)
 *     darwin   brew upgrade hamlib (brew install hamlib when missing)
 *     linux    apt-get install libhamlib-utils via `sudo -n` (or as root);
 *              when sudo needs a password: { needsSudo, command } to run by hand
 *   rollback()           Windows: switch current.json back to the previous version
 *   sourceBuildPlan()    "build from source" (not automated): the commands
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const cp = require("child_process");
const tools = require("./tools");

const RELEASES_API = "https://api.github.com/repos/Hamlib/Hamlib/releases/latest";
const CACHE_MS = 6 * 3600 * 1000;
let latestCache = { at: 0, value: null };

function httpsGet(url, opts, redirects) {
  opts = opts || {};
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "pi-sat-track", Accept: opts.accept || "*/*" }, timeout: opts.timeoutMs || 15000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume();
        return resolve(httpsGet(new URL(res.headers.location, url).toString(), opts, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error("HTTP " + res.statusCode + " for " + url));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout fetching " + url)));
    req.on("error", reject);
  });
}

/** { version, tag, url, assets:[{name,url,size,digest}] } or null (offline / rate limited). */
async function latestRelease(o) {
  o = o || {};
  const now = Date.now();
  if (!o.force && latestCache.at && now - latestCache.at < CACHE_MS) return latestCache.value;
  const get = o.get || httpsGet;
  let value = null;
  try {
    const j = JSON.parse(String(await get(RELEASES_API, { accept: "application/vnd.github+json", timeoutMs: 8000 })));
    value = {
      tag: j.tag_name,
      version: String(j.tag_name || "").replace(/^v/i, ""),
      url: j.html_url,
      assets: (j.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size, digest: a.digest || null })),
    };
  } catch (_) {
    value = latestCache.value; // keep the last good answer; failures are ignored
  }
  latestCache = { at: now, value };
  return value;
}

function planFor(platform) {
  const p = platform || process.platform;
  if (p === "win32") return { method: "windows-zip", label: "Download the official Hamlib w64 build into ~/.rpitrack/hamlib (no admin)" };
  if (p === "darwin") return { method: "brew", label: "Homebrew: brew upgrade hamlib (install if missing)" };
  if (p === "linux") return { method: "apt", label: "apt: install / upgrade libhamlib-utils" };
  return { method: "none", label: "No automatic update on " + p };
}

function sourceBuildPlan(version) {
  const v = version || "<version>";
  return {
    automated: false,
    label: "Build from source (not automated — run by hand; Linux / Pi)",
    commands: [
      "sudo apt-get install -y build-essential automake libtool libusb-1.0-0-dev",
      "curl -LO https://github.com/Hamlib/Hamlib/releases/download/" + v + "/hamlib-" + v + ".tar.gz",
      "tar xzf hamlib-" + v + ".tar.gz && cd hamlib-" + v,
      "./configure --prefix=/usr/local && make -j4 && sudo make install && sudo ldconfig",
    ],
  };
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Expected SHA-256 of `name` from a "hash  name" sums file. */
function sumFor(sumsText, name) {
  for (const l of String(sumsText || "").split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(l.trim());
    if (m && m[2].trim() === name) return m[1].toLowerCase();
  }
  return null;
}

function runCmd(bin, args, o) {
  o = o || {};
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = cp.spawn(bin, args, { env: Object.assign({}, process.env, o.env || {}), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, out: e.message });
    }
    const t = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (_) {}
      out += "\n(timed out after " + Math.round((o.timeoutMs || 600000) / 1000) + " s)";
    }, o.timeoutMs || 600000);
    const on = (d) => {
      out += d;
      if (o.log) String(d).split(/\r?\n/).filter((x) => x.trim()).forEach((x) => o.log(x));
    };
    child.stdout.on("data", on);
    child.stderr.on("data", on);
    child.on("error", (e) => {
      clearTimeout(t);
      resolve({ code: -1, out: out + e.message });
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code: code == null ? -1 : code, out });
    });
  });
}

/** Extract a zip: Windows tar.exe (bsdtar), then PowerShell, then unzip (tests on Linux). */
async function extractZip(zip, dest, log) {
  fs.mkdirSync(dest, { recursive: true });
  const tries = [];
  if (process.platform === "win32") {
    tries.push([path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"), ["-xf", zip, "-C", dest]]);
    tries.push(["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Expand-Archive -LiteralPath '" + zip.replace(/'/g, "''") + "' -DestinationPath '" + dest.replace(/'/g, "''") + "' -Force"]]);
  } else {
    tries.push(["unzip", ["-q", "-o", zip, "-d", dest]]);
    tries.push(["bsdtar", ["-xf", zip, "-C", dest]]);
  }
  for (const [bin, args] of tries) {
    const r = await runCmd(bin, args, { timeoutMs: 120000 });
    if (r.code === 0) return true;
    if (log) log("extract with " + path.basename(bin) + " failed: " + r.out.trim().slice(0, 200));
  }
  return false;
}

function findBinDir(root, exe) {
  const stack = [root];
  while (stack.length) {
    const d = stack.shift();
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    if (ents.some((e) => e.isFile() && e.name.toLowerCase() === exe)) return d;
    for (const e of ents) if (e.isDirectory()) stack.push(path.join(d, e.name));
  }
  return null;
}

function writeCurrent(rec) {
  fs.mkdirSync(tools.hamlibHome(), { recursive: true });
  const f = tools.currentFile();
  fs.writeFileSync(f + ".tmp", JSON.stringify(rec, null, 2));
  fs.renameSync(f + ".tmp", f);
}

async function updateWindows(o) {
  const log = o.log || (() => {});
  const rel = await latestRelease({ force: true, get: o.get });
  if (!rel) return { ok: false, error: "Could not reach GitHub to find the latest Hamlib release" };
  const zipName = "hamlib-w64-" + rel.version + ".zip";
  const asset = rel.assets.find((a) => a.name === zipName);
  if (!asset) return { ok: false, error: "Release " + rel.version + " has no " + zipName };
  const cur = tools.readCurrent();
  if (cur && cur.version === rel.version && fs.existsSync(path.join(cur.bin || "", "rigctld.exe")) && !o.reinstall)
    return { ok: true, version: rel.version, unchanged: true, message: "Hamlib " + rel.version + " is already installed" };
  log("Downloading " + asset.url);
  const get = o.get || httpsGet;
  const buf = await get(asset.url, { timeoutMs: 120000 });
  const got = sha256(buf);
  let expected = null;
  let checkedWith = [];
  const sums = rel.assets.find((a) => a.name === "SHA256SUM-w64-" + rel.version);
  if (sums) {
    try {
      expected = sumFor(String(await get(sums.url, { timeoutMs: 20000 })), zipName);
      if (expected) checkedWith.push(sums.name);
    } catch (e) {
      log("could not fetch " + sums.name + ": " + e.message);
    }
  }
  const digest = asset.digest && /^sha256:([0-9a-f]{64})$/i.exec(asset.digest);
  if (digest) {
    if (expected && expected !== digest[1].toLowerCase()) return { ok: false, error: "Published checksums disagree for " + zipName };
    expected = expected || digest[1].toLowerCase();
    checkedWith.push("release digest");
  }
  if (expected && expected !== got) return { ok: false, error: "SHA-256 mismatch for " + zipName + " (got " + got + ", expected " + expected + ")" };
  log(expected ? "SHA-256 verified (" + checkedWith.join(" + ") + "): " + got : "No published checksum; recorded SHA-256 " + got);
  const home = tools.hamlibHome();
  const dest = path.join(home, rel.version);
  const tmpZip = path.join(home, zipName);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(tmpZip, buf);
  try {
    fs.rmSync(dest, { recursive: true, force: true });
  } catch (_) {}
  if (!(await (o.extract || extractZip)(tmpZip, dest, log))) return { ok: false, error: "Could not extract " + zipName };
  try {
    fs.unlinkSync(tmpZip);
  } catch (_) {}
  const bin = findBinDir(dest, "rigctld.exe");
  if (!bin) return { ok: false, error: "rigctld.exe not found in " + zipName };
  // Stop our rigctld (it runs the old binary), switch, restart.
  if (o.stopDaemons) await o.stopDaemons();
  const prev = cur && cur.version !== rel.version ? { version: cur.version, bin: cur.bin, dir: cur.dir, sha256: cur.sha256 } : cur && cur.previous;
  writeCurrent({ version: rel.version, bin, dir: dest, sha256: got, verified: !!expected, installedAt: new Date().toISOString(), previous: prev || null });
  log("Hamlib " + rel.version + " installed in " + bin + (prev ? " (previous " + prev.version + " kept for rollback)" : ""));
  if (o.restartDaemons) await o.restartDaemons();
  return { ok: true, version: rel.version, bin, sha256: got, verified: !!expected };
}

async function rollback(o) {
  o = o || {};
  const cur = tools.readCurrent();
  if (!cur || !cur.previous || !cur.previous.bin) return { ok: false, error: "No previous Hamlib version to roll back to" };
  if (o.stopDaemons) await o.stopDaemons();
  const back = cur.previous;
  writeCurrent({ version: back.version, bin: back.bin, dir: back.dir, sha256: back.sha256, installedAt: new Date().toISOString(), previous: { version: cur.version, bin: cur.bin, dir: cur.dir, sha256: cur.sha256 } });
  if (o.restartDaemons) await o.restartDaemons();
  return { ok: true, version: back.version };
}

function findBrew() {
  for (const p of ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]) if (fs.existsSync(p)) return p;
  return tools.find("brew");
}

async function updateMac(o) {
  const log = o.log || (() => {});
  const brew = findBrew();
  if (!brew) return { ok: false, error: "Homebrew not found", command: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" && brew install hamlib' };
  const env = { HOMEBREW_NO_INSTALL_CLEANUP: "1", HOMEBREW_NO_ENV_HINTS: "1" };
  const has = await runCmd(brew, ["list", "--versions", "hamlib"], { env, timeoutMs: 60000 });
  const args = has.code === 0 && has.out.trim() ? ["upgrade", "hamlib"] : ["install", "hamlib"];
  log("brew " + args.join(" "));
  if (o.stopDaemons) await o.stopDaemons();
  const r = await runCmd(brew, args, { env, log, timeoutMs: 20 * 60000 });
  if (o.restartDaemons) await o.restartDaemons();
  // "already installed" / "already up-to-date" exits 0 on current brew.
  if (r.code !== 0) return { ok: false, error: "brew " + args.join(" ") + " failed (exit " + r.code + ")", command: "brew " + args.join(" ") };
  return { ok: true };
}

async function updateLinux(o) {
  const log = o.log || (() => {});
  const cmdText = "sudo apt-get update && sudo apt-get install -y libhamlib-utils";
  if (!fs.existsSync("/usr/bin/apt-get")) return { ok: false, error: "No apt-get on this Linux: install Hamlib (rigctld) with your package manager", command: cmdText };
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const sudo = isRoot ? [] : ["sudo", "-n"];
  if (!isRoot) {
    const t = await runCmd("sudo", ["-n", "true"], { timeoutMs: 10000 });
    if (t.code !== 0)
      return { ok: false, needsSudo: true, error: "Updating needs administrator rights (sudo asks for a password). Run this in a terminal on the Pi, then press Reload models:", command: cmdText };
  }
  const env = { DEBIAN_FRONTEND: "noninteractive" };
  const run = (args) => (sudo.length ? runCmd(sudo[0], sudo.slice(1).concat(args), { env, log, timeoutMs: 10 * 60000 }) : runCmd(args[0], args.slice(1), { env, log, timeoutMs: 10 * 60000 }));
  log("apt-get update");
  await run(["apt-get", "update"]);
  if (o.stopDaemons) await o.stopDaemons();
  log("apt-get install -y libhamlib-utils");
  const r = await run(["apt-get", "install", "-y", "libhamlib-utils"]);
  if (o.restartDaemons) await o.restartDaemons();
  if (r.code !== 0) return { ok: false, error: "apt-get install libhamlib-utils failed (exit " + r.code + ")", command: cmdText };
  return { ok: true, note: "apt installs the distribution's Hamlib, which can be older than the newest upstream release." };
}

async function runUpdate(o) {
  o = o || {};
  const plan = planFor(o.platform);
  if (plan.method === "windows-zip") return updateWindows(o);
  if (plan.method === "brew") return updateMac(o);
  if (plan.method === "apt") return updateLinux(o);
  return { ok: false, error: plan.label };
}

module.exports = { latestRelease, planFor, runUpdate, rollback, sourceBuildPlan, sumFor, sha256, extractZip, findBinDir, updateWindows, httpsGet, _resetCache: () => (latestCache = { at: 0, value: null }) };
