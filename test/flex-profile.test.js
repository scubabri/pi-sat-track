// Flex SmartSDR global profile: list from API, per-sat selection, load once before CAT.
// Run: node --test --test-force-exit test/flex-profile.test.js
const test = require("node:test");
const assert = require("assert");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


const { parseProfilePayload } = require("../lib/radios/flex-api");

test("parseProfilePayload: realistic SmartSDR list with spaces + caret", () => {
  const body =
    "profile global list=KD0RC - 6 CW^KD0RC - 6 SSB^KD0RC - 10 CW^SO2RDefault^";
  const p = parseProfilePayload(body);
  assert.deepStrictEqual(p.list, [
    "KD0RC - 6 CW",
    "KD0RC - 6 SSB",
    "KD0RC - 10 CW",
    "SO2RDefault",
  ]);
});

test("parseProfilePayload: list + current= with spaces; R-body without profile prefix", () => {
  const a = parseProfilePayload(
    "profile global list=Sat VU^Sat UV^ current=Sat VU",
  );
  assert.deepStrictEqual(a.list, ["Sat VU", "Sat UV"]);
  assert.strictEqual(a.current, "Sat VU");
  const b = parseProfilePayload('list=Alpha^Bravo^Charlie^');
  assert.deepStrictEqual(b.list, ["Alpha", "Bravo", "Charlie"]);
  const c = parseProfilePayload('current="My Profile"');
  assert.strictEqual(c.current, "My Profile");
});


function fakeCat() {
  const st = { cmds: [], hz: 0, md: "2", zz: "01" };
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
        if (cmd === "FA")
          sock.write("FA" + String(st.hz).padStart(11, "0") + ";");
        else if (cmd === "MD") sock.write("MD" + st.md + ";");
        else if (cmd === "ZZMD") sock.write("ZZMD" + st.zz + ";");
        else if ((m = cmd.match(/^FA(\d+)$/))) st.hz = +m[1];
        else if ((m = cmd.match(/^MD(\d)$/))) st.md = m[1];
        else if ((m = cmd.match(/^ZZMD(\d\d)$/))) st.zz = m[1];
        else if (/^[A-Z]{2,4}$/.test(cmd)) sock.write(cmd + "0;");
      }
    });
  });
  return new Promise((res) =>
    server.listen(0, "127.0.0.1", () =>
      res({ server, st, port: server.address().port }),
    ),
  );
}

/** SmartSDR API fake: profile list/info + load; records commands. */
function fakeApi(profileNames) {
  const names = profileNames || ["Sat VU", "Sat UV", "APRS 2m"];
  const st = { cmds: [], current: "" };
  const server = net.createServer((sock) => {
    sock.write("V1.4.0\n");
    sock.write("H1234ABCD\n");
    let buf = "";
    function emitList() {
      const list = names.join("^") + (names.length ? "^" : "");
      sock.write(
        "S1|profile global list=" +
          list +
          (st.current ? " current=" + st.current : "") +
          "\n",
      );
    }
    sock.on("data", (c) => {
      buf += c.toString();
      let idx;
      while ((idx = buf.search(/\r?\n/)) >= 0) {
        const nl = buf[idx] === "\r" && buf[idx + 1] === "\n" ? 2 : 1;
        const line = buf.slice(0, idx).replace(/\r/g, "").trim();
        buf = buf.slice(idx + nl);
        if (!line) continue;
        const m = line.match(/^C(\d+)\|(.+)$/);
        if (!m) continue;
        const seq = m[1];
        const cmd = m[2];
        st.cmds.push(cmd);
        sock.write("R" + seq + "|0|\n");
        if (/^sub\s+profile/i.test(cmd) || /^profile\s+global\s+info/i.test(cmd)) {
          emitList();
        }
        if (/^profile\s+global\s+load/i.test(cmd)) {
          const nm = cmd.match(/load\s+"([^"]*)"/i);
          st.current = nm ? nm[1] : "";
          sock.write(
            "S1|profile global current=" + st.current + "\n",
          );
          sock.write(
            "S1|slice 0 RF_frequency=145.850000 mode=FM tx=1 index_letter=A\n",
          );
          sock.write(
            "S1|slice 1 RF_frequency=436.795000 mode=FM tx=0 index_letter=B\n",
          );
        }
        if (/^sub\s+slice/i.test(cmd)) {
          sock.write(
            "S1|slice 0 RF_frequency=145.850000 mode=FM tx=1 index_letter=A\n",
          );
        }
      }
    });
  });
  return new Promise((res) =>
    server.listen(0, "127.0.0.1", () =>
      res({ server, st, port: server.address().port, names }),
    ),
  );
}

function loadFlex(cfgExports) {
  const cfgPath = require.resolve(path.join(__dirname, "../lib/config"));
  const flexPath = require.resolve(path.join(__dirname, "../lib/radios/flex"));
  const apiPath = require.resolve(path.join(__dirname, "../lib/radios/flex-api"));
  delete require.cache[flexPath];
  delete require.cache[apiPath];
  require.cache[cfgPath] = {
    id: cfgPath,
    filename: cfgPath,
    loaded: true,
    exports: cfgExports,
  };
  return require("../lib/radios/flex");
}

test("flex-api parses profile global list status and load command", async () => {
  const a = await fakeApi(["Alpha", "Bravo"]);
  const cfgPath = require.resolve(path.join(__dirname, "../lib/config"));
  const apiPath = require.resolve(path.join(__dirname, "../lib/radios/flex-api"));
  delete require.cache[apiPath];
  require.cache[cfgPath] = {
    id: cfgPath,
    filename: cfgPath,
    loaded: true,
    exports: { FLEX_API_PORT: a.port },
  };
  const { createApiClient } = require("../lib/radios/flex-api");
  const api = createApiClient();
  let notified = null;
  api.onProfilesChanged((p) => {
    notified = p;
  });
  const ok = await api.connect("127.0.0.1", a.port);
  assert.ok(ok);
  await sleep(300);
  assert.ok(
    a.st.cmds.some((c) => /^sub\s+profile\s+all$/i.test(c)),
    "sub profile all: " + a.st.cmds.join(" | "),
  );
  assert.ok(
    a.st.cmds.some((c) => /^profile\s+global\s+info$/i.test(c)),
    "profile global info",
  );
  // Wait for status parse
  for (let i = 0; i < 20 && api.getGlobalProfiles().length === 0; i++)
    await sleep(50);
  assert.deepStrictEqual(api.getGlobalProfiles(), ["Alpha", "Bravo"]);
  assert.ok(notified && notified.list.length === 2);

  const loaded = await api.loadGlobalProfile("Alpha");
  assert.ok(loaded);
  assert.ok(
    a.st.cmds.some((c) => c === 'profile global load "Alpha"'),
    a.st.cmds.join(" | "),
  );
  assert.strictEqual(api.getCurrentGlobalProfile(), "Alpha");
  api.close();
  a.server.close();
  delete require.cache[apiPath];
});

test("Flex profile: load once before CAT when selected; blank = no load", async () => {
  const u = await fakeCat();
  const d = await fakeCat();
  const a = await fakeApi();

  const flex = loadFlex({
    FLEX_UL_HOST: "127.0.0.1",
    FLEX_UL_PORT: u.port,
    FLEX_DL_HOST: "127.0.0.1",
    FLEX_DL_PORT: d.port,
    FLEX_API_HOST: "127.0.0.1",
    FLEX_API_PORT: a.port,
    RADIO_TRANSPORT: "tcp",
    C_MS: 299792458,
  });

  const catalog = require("../lib/catalog");
  catalog.getCatalog = () => ({
    "SO-50": {
      modes: [{ mode: "FM", uplink: "145.850", downlink: "436.795" }],
    },
  });

  const logs = [];
  const oL = console.log;
  const oW = console.warn;
  console.log = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => logs.push("WARN " + args.join(" "));

  try {
    flex.init({
      getContext: () => ({ currentSatKey: "SO-50", currentModeIndex: 0 }),
    });
    flex.setLock(true);
    flex.setRadio(true);

    // Blank selection: no profile load
    for (let i = 0; i < 4; i++) {
      await flex.pushFrequencies(145850000 + i, 436795000 - i);
      await sleep(150);
    }
    assert.strictEqual(
      a.st.cmds.filter((c) => /profile\s+global\s+load/.test(c)).length,
      0,
      "no load when blank: " + a.st.cmds.filter((c) => /profile/.test(c)).join("|"),
    );

    // Select a profile → load immediately + before subsequent CAT
    a.st.cmds.length = 0;
    u.st.cmds.length = 0;
    flex.setFlexProfile("Sat VU");
    await sleep(1500); // connect settle + load wait
    const loads = a.st.cmds.filter(
      (c) => c === 'profile global load "Sat VU"',
    );
    assert.strictEqual(loads.length, 1, "load once: " + a.st.cmds.join(" | "));
    assert.ok(logs.some((l) => /Flex profile: loading "Sat VU"/.test(l)));

    const st = flex.getRadioState();
    assert.strictEqual(st.flexProfile, "Sat VU");
    assert.strictEqual(st.supportsFlexProfiles, true);

    // More pushes: no second load
    const before = a.st.cmds.filter((c) => /profile\s+global\s+load/.test(c))
      .length;
    for (let i = 0; i < 4; i++) {
      await flex.pushFrequencies(145850100 + i, 436794900 - i);
      await sleep(150);
    }
    assert.strictEqual(
      a.st.cmds.filter((c) => /profile\s+global\s+load/.test(c)).length,
      before,
      "deduped",
    );

    // Switch profile → new load
    a.st.cmds.length = 0;
    flex.setFlexProfile("APRS 2m");
    await sleep(1500);
    assert.strictEqual(
      a.st.cmds.filter((c) => c === 'profile global load "APRS 2m"').length,
      1,
      a.st.cmds.join(" | "),
    );

    // Clear → no further loads
    a.st.cmds.length = 0;
    flex.setFlexProfile("");
    for (let i = 0; i < 3; i++) {
      await flex.pushFrequencies(145850200 + i, 436794800 - i);
      await sleep(120);
    }
    assert.strictEqual(
      a.st.cmds.filter((c) => /profile\s+global\s+load/.test(c)).length,
      0,
    );
  } finally {
    console.log = oL;
    console.warn = oW;
    try {
      flex.close();
    } catch (_) {}
    u.server.close();
    d.server.close();
    a.server.close();
  }
});

test("sat-offsets persists flexProfile per sat (like Data/CW)", () => {
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "flexprof-"));
  // Fresh module
  const soPath = require.resolve("../lib/sat-offsets");
  delete require.cache[soPath];
  const so = require("../lib/sat-offsets");
  so.load();
  so.setFlexProfile("SO-50", "Sat VU");
  so.set("SO-50", { ulFineOffset: 0, dlFineOffset: 100, manualDlOffset: 0 });
  assert.strictEqual(so.getFlexProfile("SO-50"), "Sat VU");
  so.flush();
  so.load();
  assert.strictEqual(so.getFlexProfile("SO-50"), "Sat VU");
  assert.strictEqual(so.find("SO50").flexProfile, "Sat VU");
  so.setFlexProfile("SO-50", "");
  // Still has offsets so entry remains; flexProfile blank
  assert.strictEqual(so.getFlexProfile("SO-50"), "");
  so.setFlexProfile("ISS", "APRS 2m");
  assert.strictEqual(so.getFlexProfile("ISS"), "APRS 2m");
  assert.strictEqual(so.getDataMode("ISS"), false);
});

test("Flex API connects for profile list with radio DISABLED", async () => {
  const a = await fakeApi(["KD0RC - 6 CW", "Sat VU"]);
  const flex = loadFlex({
    FLEX_UL_HOST: "127.0.0.1",
    FLEX_UL_PORT: 1,
    FLEX_DL_HOST: "127.0.0.1",
    FLEX_DL_PORT: 1,
    FLEX_API_HOST: "127.0.0.1",
    FLEX_API_PORT: a.port,
    RADIO_TRANSPORT: "tcp",
    C_MS: 299792458,
  });
  const logs = [];
  const oL = console.log;
  const oW = console.warn;
  console.log = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => logs.push("WARN " + args.join(" "));
  try {
    flex.init({
      getContext: () => ({ currentSatKey: "SO-50", currentModeIndex: 0 }),
    });
    // Do NOT enable radio — list should still arrive
    assert.strictEqual(flex.getRadioState().radioOn, false);
    for (let i = 0; i < 40 && !flex.getRadioState().apiConnected; i++)
      await sleep(50);
    assert.ok(
      logs.some((l) => /Flex API: connecting 127\.0\.0\.1:/.test(l)),
      "connecting log: " + logs.filter((l) => /Flex API/.test(l)).join(" || "),
    );
    assert.ok(flex.getRadioState().apiConnected, "apiConnected with radio off");
    for (let i = 0; i < 40 && flex.getRadioState().flexProfiles.length === 0; i++)
      await sleep(50);
    assert.ok(
      flex.getRadioState().flexProfiles.includes("KD0RC - 6 CW"),
      "profiles: " + JSON.stringify(flex.getRadioState().flexProfiles),
    );
    assert.ok(
      logs.some((l) => /Flex API: \d+ global profiles/.test(l)),
      "N global profiles log",
    );
    // Selecting a profile while radio off saves but does not load
    a.st.cmds.length = 0;
    flex.setFlexProfile("Sat VU");
    await sleep(200);
    assert.strictEqual(
      a.st.cmds.filter((c) => /profile\s+global\s+load/.test(c)).length,
      0,
      "no load while radio off",
    );
    assert.strictEqual(flex.getRadioState().flexProfile, "Sat VU");
  } finally {
    console.log = oL;
    console.warn = oW;
    try {
      flex.close();
    } catch (_) {}
    a.server.close();
  }
});

test("Flex API: skip log when host unset", async () => {
  const flex = loadFlex({
    FLEX_UL_HOST: "127.0.0.1",
    FLEX_UL_PORT: 1,
    FLEX_DL_HOST: "127.0.0.1",
    FLEX_DL_PORT: 1,
    FLEX_API_HOST: "",
    FLEX_API_PORT: 4992,
    RADIO_TRANSPORT: "tcp",
    C_MS: 299792458,
  });
  const logs = [];
  const oL = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    flex.init({
      getContext: () => ({ currentSatKey: null, currentModeIndex: 0 }),
    });
    await sleep(50);
    assert.ok(
      logs.some((l) => /Flex API: skip — no API host configured/.test(l)),
      logs.join(" || "),
    );
  } finally {
    console.log = oL;
    try {
      flex.close();
    } catch (_) {}
  }
});

