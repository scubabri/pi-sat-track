// Static UI files revalidate on every load (no stale JS after an update), and
// a "sat" request for the already-selected sat is a no-op on the server.
// Run: node --test --test-force-exit test/static-cache-and-same-sat.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const sc = require("../lib/static-cache");

test("static files: no-cache + ETag (version / size / mtime), 304 on a match", () => {
  const st = { size: 12345, mtimeMs: 1792579234372.5 };
  const e1 = sc.etagFor("0.1.0+63138c0", st);
  assert.match(e1, /^W\/"0\.1\.0\+63138c0-/);
  assert.notStrictEqual(e1, sc.etagFor("0.1.0+aaaaaaa", st), "new version → new ETag");
  assert.notStrictEqual(e1, sc.etagFor("0.1.0+63138c0", { size: 12346, mtimeMs: st.mtimeMs }), "new content → new ETag");
  assert.deepStrictEqual(sc.headersFor(e1), { "Cache-Control": "no-cache", ETag: e1 });
  assert.strictEqual(sc.notModified({ headers: { "if-none-match": e1 } }, e1), true);
  assert.strictEqual(sc.notModified({ headers: { "if-none-match": 'W/"x", ' + e1 } }, e1), true);
  assert.strictEqual(sc.notModified({ headers: { "if-none-match": 'W/"old"' } }, e1), false);
  assert.strictEqual(sc.notModified({ headers: {} }, e1), false);
  const src = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  assert.ok(/staticCache\.headersFor\(etag\)/.test(src) && /res\.writeHead\(304, headers\)/.test(src), "server.js uses it for static files");
});

test("server: a sat request for the current sat does not reload it", () => {
  const src = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const i = src.indexOf('msg.key === state.getCurrentKey()');
  const j = src.indexOf("selectSat(msg.key)");
  assert.ok(i > 0 && j > i, "same-key check runs before the select / load");
  assert.ok(/already selected \(no reload\)[\s\S]{0,300}return;/.test(src.slice(i, j)));
});
