// Flex Profile dropdown = SmartSDR GLOBAL profiles only. The radio also sends
// "profile tx list=…" and "profile mic list=…" (plus current=) status, e.g.
// right after a global profile load; those must never replace the global list
// (regression: the mic list showed up in the FREQUENCIES Flex profile menu).
// Run: node --test --test-force-exit test/flex-profile-types.test.js
const test = require("node:test");
const assert = require("assert");
const net = require("net");
const path = require("path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GLOBAL = ["PiTrack-144up", "PiTrack-435up", "SO2RDefault"];
const MIC = ["Default", "Default FHM-1", "Default FHM-1 DX", "FHM-2", "FHM-3 ESSB", "Default HDST Condenser", "Default PR781", "Inrad M629", "macOS_default_Profile"];
const TX = ["Default", "PiTrack TX", "ESSB 4k"];
const lst = (a) => a.join("^") + "^";

test("parseProfilePayload: only global profile status / bodies are accepted", () => {
  const { parseProfilePayload } = require("../lib/radios/flex-api");
  assert.deepStrictEqual(parseProfilePayload("profile global list=" + lst(GLOBAL)).list, GLOBAL);
  assert.strictEqual(parseProfilePayload("profile global current=PiTrack-144up").current, "PiTrack-144up");
  assert.strictEqual(parseProfilePayload("profile mic list=" + lst(MIC)), null);
  assert.strictEqual(parseProfilePayload("profile mic list=" + lst(MIC) + " current=FHM-2"), null);
  assert.strictEqual(parseProfilePayload("profile mic current=Default FHM-1"), null);
  assert.strictEqual(parseProfilePayload("profile tx list=" + lst(TX)), null);
  assert.strictEqual(parseProfilePayload("profile TX current=PiTrack TX"), null);
  assert.strictEqual(parseProfilePayload("profile displays list=A^B^"), null);
  // R body of "profile global info" (no type prefix) is still global
  assert.deepStrictEqual(parseProfilePayload("list=" + lst(GLOBAL)).list, GLOBAL);
});

/** SmartSDR API fake: answers like a FLEX-6600 that reports every profile kind. */
function fakeApi() {
  const st = { cmds: [], socks: [], current: "PiTrack-144up" };
  const server = net.createServer((sock) => {
    st.socks.push(sock);
    sock.write("V1.4.0\nH1234ABCD\n");
    let buf = "";
    const mixed = (cur) => {
      // global, then tx, then mic (mic last = the one that used to win)
      sock.write("S1|profile global list=" + lst(GLOBAL) + (cur ? " current=" + cur : "") + "\n");
      sock.write("S1|profile tx list=" + lst(TX) + " current=PiTrack TX\n");
      sock.write("S1|profile mic list=" + lst(MIC) + " current=Default FHM-1\n");
      sock.write("S1|profile mic current=Default FHM-1\n");
    };
    sock.on("data", (c) => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const m = line.match(/^C(\d+)\|(.+)$/);
        if (!m) continue;
        st.cmds.push(m[2]);
        if (/^profile\s+mic\s+info/i.test(m[2])) sock.write("R" + m[1] + "|0|list=" + lst(MIC) + "\n");
        else sock.write("R" + m[1] + "|0|\n");
        if (/^profile\s+global\s+info/i.test(m[2])) mixed(st.current);
        const ld = m[2].match(/^profile\s+global\s+load\s+"([^"]*)"/i);
        if (ld) {
          st.current = ld[1];
          sock.write("S1|profile global current=" + ld[1] + "\n");
          mixed(ld[1]);
        }
      }
    });
  });
  return new Promise((res) => server.listen(0, "127.0.0.1", () => res({ server, st, port: server.address().port })));
}

test("API client: mixed global / tx / mic status keeps only the global list and current", async () => {
  const a = await fakeApi();
  const cfgPath = require.resolve(path.join(__dirname, "../lib/config"));
  const apiPath = require.resolve(path.join(__dirname, "../lib/radios/flex-api"));
  const prevCfg = require.cache[cfgPath];
  delete require.cache[apiPath];
  require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: { FLEX_API_PORT: a.port } };
  const { createApiClient } = require("../lib/radios/flex-api");
  const api = createApiClient();
  const seen = [];
  api.onProfilesChanged((p) => seen.push(p));
  const log = console.log;
  console.log = () => {};
  try {
    assert.ok(await api.connect("127.0.0.1", a.port));
    for (let i = 0; i < 40 && api.getGlobalProfiles().length === 0; i++) await sleep(25);
    await sleep(150);
    assert.deepStrictEqual(api.getGlobalProfiles(), GLOBAL);
    assert.strictEqual(api.getCurrentGlobalProfile(), "PiTrack-144up");
    // a global load makes the radio re-send tx + mic lists after the global one
    assert.ok(await api.loadGlobalProfile("PiTrack-435up"));
    await sleep(150);
    assert.deepStrictEqual(api.getGlobalProfiles(), GLOBAL);
    assert.strictEqual(api.getCurrentGlobalProfile(), "PiTrack-435up");
    // unsolicited mic / tx status later (no reconnect in between) changes nothing
    a.st.socks.forEach((s) => s.write("S1|profile mic list=" + lst(MIC) + "\nS1|profile tx list=" + lst(TX) + " current=ESSB 4k\n"));
    // and an R body of a non-global profile command is not taken as global
    await api.sendAndWait("profile mic info", 1000);
    await sleep(150);
    assert.deepStrictEqual(api.getGlobalProfiles(), GLOBAL);
    assert.strictEqual(api.getCurrentGlobalProfile(), "PiTrack-435up");
    for (const p of seen) {
      for (const n of p.list) assert.ok(GLOBAL.includes(n), "non-global name notified: " + n);
      assert.ok(!p.current || GLOBAL.includes(p.current), "non-global current notified: " + p.current);
    }
  } finally {
    console.log = log;
    api.close();
    a.server.close();
    delete require.cache[apiPath];
    if (prevCfg) require.cache[cfgPath] = prevCfg;
    else delete require.cache[cfgPath];
  }
});
