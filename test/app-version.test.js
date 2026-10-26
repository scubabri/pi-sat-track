// Build / version label (lib/version.js) for Station → Version and /api/version.
// Run: node --test --test-force-exit test/app-version.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveVersion } = require("../lib/version");

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pst-ver-"));
  const app = path.join(d, "app"), home = path.join(d, "home");
  fs.mkdirSync(app); fs.mkdirSync(path.join(home, ".rpitrack"), { recursive: true });
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ version: "0.1.0" }));
  return { app, home };
}
const fakeGit = (branch, sha) => (cmd) => (/--abbrev-ref/.test(cmd) ? branch : sha);

test("installer stamp (VERSION) wins: <BRANCH>-alpha.N", () => {
  const { app, home } = tmp();
  fs.writeFileSync(path.join(app, "VERSION"), "UAT-alpha.43\n");
  fs.mkdirSync(path.join(app, ".git"));
  fs.writeFileSync(path.join(home, ".rpitrack", "version"), "UAT-alpha.40");
  assert.deepStrictEqual(resolveVersion({ dir: app, home, exec: fakeGit("UAT", "abc1234") }), { version: "UAT-alpha.43", source: "build" });
});

test("git checkout: branch + short sha, ahead of an old ~/.rpitrack/version", () => {
  const { app, home } = tmp();
  fs.writeFileSync(path.join(app, ".git"), "gitdir: /elsewhere\n"); // worktree style
  fs.writeFileSync(path.join(home, ".rpitrack", "version"), "UAT-alpha.40");
  assert.deepStrictEqual(resolveVersion({ dir: app, home, exec: fakeGit("ui/fixes-1026", "8e211a8") }), { version: "ui/fixes-1026+8e211a8", source: "git" });
  assert.strictEqual(resolveVersion({ dir: app, home, exec: fakeGit("HEAD", "8e211a8") }).version, "8e211a8", "detached HEAD: sha only");
});

test("no stamp, no git: installer record, then package.json", () => {
  const { app, home } = tmp();
  fs.writeFileSync(path.join(home, ".rpitrack", "version"), "main-alpha.7");
  assert.deepStrictEqual(resolveVersion({ dir: app, home }), { version: "main-alpha.7", source: "installed" });
  fs.unlinkSync(path.join(home, ".rpitrack", "version"));
  assert.deepStrictEqual(resolveVersion({ dir: app, home }), { version: "0.1.0", source: "package" });
});

test("this repo resolves to something non-empty; Station summary has a Version row", () => {
  assert.ok(resolveVersion().version);
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  assert.match(html, /<dt>Version<\/dt><dd id="cfg-sum-version">/);
  const srv = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  assert.match(srv, /urlPath === "\/api\/version"/);
});
