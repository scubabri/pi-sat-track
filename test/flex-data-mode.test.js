// Flex Data button: USB→DIGU, LSB→DIGL, FM→DFM via ZZMD; OFF restores MD1/2/4.
// Run: node --test --test-force-exit test/flex-data-mode.test.js
const test = require("node:test");
const assert = require("assert");
const net = require("net");
const path = require("path");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeCat(name) {
  const st = { name, cmds: [], hz: 0, md: "2", zz: "01" };
  const MD2ZZ = { "1": "00", "2": "01", "3": "03", "4": "05" };
  const ZZ2MD = { "00": "1", "01": "2", "03": "3", "05": "4", "07": "6", "09": "6", "12": "4" };
  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf(";")) >= 0) {
        const cmd = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!cmd) continue;
        st.cmds.push(cmd);
        let m;
        if (cmd === "FA") sock.write("FA" + String(st.hz).padStart(11, "0") + ";");
        else if (cmd === "MD") sock.write("MD" + st.md + ";");
        else if (cmd === "ZZMD") sock.write("ZZMD" + st.zz + ";");
        else if ((m = cmd.match(/^FA(\d+)$/))) st.hz = +m[1];
        else if ((m = cmd.match(/^MD(\d)$/))) { st.md = m[1]; st.zz = MD2ZZ[m[1]] || "01"; }
        else if ((m = cmd.match(/^ZZMD(\d\d)$/))) { st.zz = m[1]; st.md = ZZ2MD[m[1]] || "2"; }
        else if (/^[A-Z]{2,4}$/.test(cmd)) sock.write(cmd + "0;");
      }
    });
  });
  return new Promise((res) => server.listen(0, "127.0.0.1", () => res({ server, st, port: server.address().port })));
}

test("Flex data ON: DIGU/DIGL (linear), DFM (FM); OFF restores; one resend", async () => {
  const u = await fakeCat("ul"), d = await fakeCat("dl");
  const cfgPath = require.resolve(path.join(__dirname, "../lib/config"));
  require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: {
    FLEX_UL_HOST: "127.0.0.1", FLEX_UL_PORT: u.port, FLEX_DL_HOST: "127.0.0.1", FLEX_DL_PORT: d.port,
    FLEX_API_HOST: "", FLEX_API_PORT: 0, RADIO_TRANSPORT: "tcp", C_MS: 299792458,
  } };
  const catalog = require("../lib/catalog");
  catalog.getCatalog = () => ({
    "RS-44": { modes: [{ mode: "SSB", uplink: "145.965", downlink: "435.640" }] },
    "SO-50": { modes: [{ mode: "FM", uplink: "145.850", downlink: "436.795" }] },
  });
  const flex = require("../lib/radios/flex");
  const logs = [];
  const oL = console.log, oW = console.warn;
  console.log = (...a) => logs.push(a.join(" "));
  console.warn = (...a) => logs.push("WARN " + a.join(" "));
  let sat = "RS-44";
  try {
    flex.init({ getContext: () => ({ currentSatKey: sat, currentModeIndex: 0 }) });
    flex.setLock(true);
    flex.setRadio(true);
    const push = async (n, ulHz, dlHz) => {
      for (let i = 0; i < n; i++) { await flex.pushFrequencies(ulHz + i, dlHz - i); await sleep(120); }
    };
    await push(12, 145965000, 435640000);
    assert.strictEqual(u.st.md, "1", "UL LSB"); assert.strictEqual(d.st.md, "2", "DL USB");
    assert.strictEqual(flex.getRadioState().supportsDataMode, true);
    assert.strictEqual(flex.getRadioState().dataMode, false, "default OFF");

    u.st.cmds.length = 0; d.st.cmds.length = 0;
    flex.setDataMode(true);
    await push(8, 145965100, 435639000);
    assert.strictEqual(u.st.zz, "09", "UL DIGL"); assert.strictEqual(d.st.zz, "07", "DL DIGU");
    assert.strictEqual(u.st.cmds.filter((c) => /^ZZMD\d\d$/.test(c)).length, 1, "one resend UL: " + u.st.cmds.join(","));
    assert.strictEqual(d.st.cmds.filter((c) => /^ZZMD\d\d$/.test(c)).length, 1, "one resend DL");
    assert.ok(logs.some((l) => /^Flex data ON/.test(l)));

    flex.setDataMode(false);
    await push(4, 145965200, 435638000);
    assert.strictEqual(u.st.md, "1"); assert.strictEqual(d.st.md, "2");
    assert.ok(logs.some((l) => /^Flex data OFF/.test(l)));

    // FM sat: DFM on both
    sat = "SO-50";
    flex.resetOffsets();
    flex.setDataMode(true);
    await push(12, 145850000, 436795000);
    assert.strictEqual(u.st.zz, "12", "UL DFM"); assert.strictEqual(d.st.zz, "12", "DL DFM");
  } finally {
    console.log = oL; console.warn = oW;
    flex.setRadio(false);
    u.server.close(); d.server.close();
  }
});
