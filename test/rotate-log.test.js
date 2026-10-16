// Run: node test/rotate-log.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { rotateLogFile, KEEP } = require("../lib/rotate-log");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rotate-log-"));
const log = path.join(dir, "server.log");

function wipe() {
  for (const name of fs.readdirSync(dir)) {
    fs.unlinkSync(path.join(dir, name));
  }
}

function write(p, body) {
  fs.writeFileSync(p, body);
}

function exists(p) {
  return fs.existsSync(p);
}

function read(p) {
  return fs.readFileSync(p, "utf8");
}

assert.strictEqual(KEEP, 5, "default keep is 5");

// missing → no-op
wipe();
let r = rotateLogFile(log);
assert.deepStrictEqual(
  { ok: r.ok, rotated: r.rotated, reason: r.reason },
  { ok: true, rotated: false, reason: "missing" },
);

// empty → skip
wipe();
write(log, "");
r = rotateLogFile(log);
assert.strictEqual(r.ok, true);
assert.strictEqual(r.rotated, false);
assert.strictEqual(r.reason, "empty");
assert.ok(exists(log), "empty live file left in place");

// first rotate moves live → .1
wipe();
write(log, "gen0\n");
r = rotateLogFile(log);
assert.strictEqual(r.ok, true);
assert.strictEqual(r.rotated, true);
assert.ok(!exists(log), "live renamed away");
assert.strictEqual(read(log + ".1"), "gen0\n");

// successive rotates shift .1→.2 … and drop beyond keep
wipe();
write(log, "A");
assert.ok(rotateLogFile(log).rotated);
write(log, "B");
assert.ok(rotateLogFile(log).rotated);
write(log, "C");
assert.ok(rotateLogFile(log).rotated);
write(log, "D");
assert.ok(rotateLogFile(log).rotated);
write(log, "E");
assert.ok(rotateLogFile(log).rotated);
write(log, "F");
assert.ok(rotateLogFile(log).rotated);
assert.ok(!exists(log));
assert.strictEqual(read(log + ".1"), "F");
assert.strictEqual(read(log + ".2"), "E");
assert.strictEqual(read(log + ".3"), "D");
assert.strictEqual(read(log + ".4"), "C");
assert.strictEqual(read(log + ".5"), "B");
assert.ok(!exists(log + ".6"), "nothing older than keep");
assert.ok(!exists(path.join(dir, "server.log.0")));

// custom keep=2
wipe();
const short = path.join(dir, "short.log");
write(short, "1");
rotateLogFile(short, { keep: 2 });
write(short, "2");
rotateLogFile(short, { keep: 2 });
write(short, "3");
rotateLogFile(short, { keep: 2 });
assert.strictEqual(read(short + ".1"), "3");
assert.strictEqual(read(short + ".2"), "2");
assert.ok(!exists(short + ".3"));

// failure must not throw (bad path type)
r = rotateLogFile(null);
assert.strictEqual(r.ok, false);
assert.strictEqual(r.rotated, false);

// log-hub / rt21 still require the helper
assert.ok(
  /rotateLogFile/.test(fs.readFileSync(path.join(__dirname, "..", "lib", "log-hub.js"), "utf8")),
  "log-hub uses rotateLogFile",
);
assert.ok(
  /rotateLogFile/.test(fs.readFileSync(path.join(__dirname, "..", "lib", "rotors", "rt21.js"), "utf8")),
  "rt21 uses rotateLogFile",
);
assert.ok(
  /rotorLogRotated/.test(fs.readFileSync(path.join(__dirname, "..", "lib", "rotors", "rt21.js"), "utf8")),
  "rt21 rotates once per process",
);

// log-viewer stays on WS ring (does not read server.log from disk)
const viewer = fs.readFileSync(path.join(__dirname, "..", "log-viewer.html"), "utf8");
assert.ok(!/server\.log/.test(viewer), "log-viewer.html does not hardcode server.log path");
assert.ok(/log-history|WebSocket|ws/.test(viewer), "log-viewer uses live WS feed");

wipe();
fs.rmdirSync(dir);
console.log("rotate-log tests OK");
