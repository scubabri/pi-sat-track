// .run stub (build-sfx.sh): each platform installs only its own installer files.
// Run: node --test --test-force-exit test/sfx-per-os.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const os = require("os");

test(".run skips the other OS's files (print-platform)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pst-sfx-"));
  const src = path.join(tmp, "pi-sat-track");
  fs.mkdirSync(src);
  for (const f of ["package.json", "install-pi.sh", "install-mac.sh", "install-win.bat", "server.js"]) fs.writeFileSync(path.join(src, f), "{}");
  execFileSync("bash", [path.join(__dirname, "../build-sfx.sh"), src], { env: Object.assign({}, process.env, { OUT_DIR: tmp, VERSION: "1", BRANCH: "t" }), stdio: "pipe" });
  const run = path.join(tmp, "pi-sat-track-t-alpha.1.run");
  const out = (p) => execFileSync("bash", [run, "--print-platform"], { env: Object.assign({}, process.env, { PST_FORCE_PLATFORM: p, PST_MAC_DEST: tmp }) }).toString();
  const mac = out("mac");
  assert.match(mac, /run install-mac\.sh/);
  assert.match(mac, /Skipped \(other OS\): .*install-win\.bat.*win-network\.ps1.*installer.*install-pi\.sh.*\.gitattributes/);
  assert.doesNotMatch(mac, /Skipped.*install-mac\.sh/);
  const lx = out("linux");
  assert.match(lx, /run install-pi\.sh/);
  assert.match(lx, /Skipped \(other OS\): .*install-win\.bat.*install-mac\.sh uninstall-mac\.sh/);
  assert.doesNotMatch(lx, /Skipped.*install-pi\.sh/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("Windows setup excludes .sh (Mac / Pi installers) and repo files", () => {
  const iss = fs.readFileSync(path.join(__dirname, "../installer/windows/pi-sat-track.iss"), "utf8");
  assert.match(iss, /Excludes: "[^"]*\\\*\.sh[^"]*"/);
  assert.match(iss, /Excludes: "[^"]*\\\.gitattributes/);
});
