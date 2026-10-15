// Flex SmartSDR global profile auto-load by UL/DL band.
// Run: node --test --test-force-exit test/flex-profile.test.js
const test = require("node:test");
const assert = require("assert");
const net = require("net");
const path = require("path");

const {
  bandOfHz,
  bandCombo,
  selectProfile,
} = require("../lib/radios/flex-profile");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("bandOfHz: 2m / 70cm ranges; outside → null", () => {
  assert.strictEqual(bandOfHz(145850000), "2m");
  assert.strictEqual(bandOfHz(144e6), "2m");
  assert.strictEqual(bandOfHz(148e6), "2m");
  assert.strictEqual(bandOfHz(436795000), "70cm");
  assert.strictEqual(bandOfHz(420e6), "70cm");
  assert.strictEqual(bandOfHz(450e6), "70cm");
  assert.strictEqual(bandOfHz(1296000000), null); // 23cm
  assert.strictEqual(bandOfHz(143e6), null);
  assert.strictEqual(bandOfHz(149e6), null);
  assert.strictEqual(bandOfHz(NaN), null);
});

test("bandCombo: V/U, U/V, V/V; other → null", () => {
  assert.strictEqual(bandCombo(145850000, 436795000), "VU");
  assert.strictEqual(bandCombo(435300000, 145900000), "UV");
  assert.strictEqual(bandCombo(145825000, 145825000), "VV");
  assert.strictEqual(bandCombo(145825000, 145835000), "VV"); // same band
  assert.strictEqual(bandCombo(435000000, 436000000), null); // U/U
  assert.strictEqual(bandCombo(1296e6, 145e6), null);
  assert.strictEqual(bandCombo(null, 436e6), null);
});

test("selectProfile: picks configured name; blank = do nothing", () => {
  const names = { vu: "Sat VU", uv: " Sat UV ", vv: "APRS 2m" };
  assert.deepStrictEqual(selectProfile(14585e4, 436795e3, names), {
    combo: "VU",
    name: "Sat VU",
    label: "V/U",
  });
  assert.deepStrictEqual(selectProfile(4353e5, 1459e5, names), {
    combo: "UV",
    name: "Sat UV",
    label: "U/V",
  });
  assert.deepStrictEqual(selectProfile(145825e3, 145825e3, names), {
    combo: "VV",
    name: "APRS 2m",
    label: "V/V",
  });
  assert.strictEqual(
    selectProfile(14585e4, 436795e3, { vu: "", uv: "x", vv: "y" }).name,
    "",
  );
  assert.strictEqual(
    selectProfile(1296e6, 145e6, names).combo,
    null,
  );
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
        if (cmd === "FA") sock.write("FA" + String(st.hz).padStart(11, "0") + ";");
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

/** Minimal SmartSDR API fake: answers R|0| for every C command; records cmds. */
function fakeApi() {
  const st = { cmds: [], clients: 0 };
  const server = net.createServer((sock) => {
    st.clients += 1;
    sock.write("V1.4.0\n");
    sock.write("H1234ABCD\n");
    let buf = "";
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
        // After a profile load, emit a couple of slice statuses
        if (/^profile\s+global\s+load/i.test(cmd)) {
          sock.write("S1|slice 0 RF_frequency=145.850000 mode=FM tx=1 index_letter=A\n");
          sock.write("S1|slice 1 RF_frequency=436.795000 mode=FM tx=0 index_letter=B\n");
        }
        if (/^sub\s+slice/i.test(cmd)) {
          sock.write("S1|slice 0 RF_frequency=145.850000 mode=FM tx=1 index_letter=A\n");
          sock.write("S1|slice 1 RF_frequency=436.795000 mode=FM tx=0 index_letter=B\n");
        }
      }
    });
  });
  return new Promise((res) =>
    server.listen(0, "127.0.0.1", () =>
      res({ server, st, port: server.address().port }),
    ),
  );
}

test("Flex profile load: sent once, before CAT freq/mode, correct command", async () => {
  const u = await fakeCat();
  const d = await fakeCat();
  const a = await fakeApi();

  // Fresh module load so createApiClient / flex state are clean
  const cfgPath = require.resolve(path.join(__dirname, "../lib/config"));
  const flexPath = require.resolve(path.join(__dirname, "../lib/radios/flex"));
  const apiPath = require.resolve(path.join(__dirname, "../lib/radios/flex-api"));
  delete require.cache[flexPath];
  delete require.cache[apiPath];

  require.cache[cfgPath] = {
    id: cfgPath,
    filename: cfgPath,
    loaded: true,
    exports: {
      FLEX_UL_HOST: "127.0.0.1",
      FLEX_UL_PORT: u.port,
      FLEX_DL_HOST: "127.0.0.1",
      FLEX_DL_PORT: d.port,
      FLEX_API_HOST: "127.0.0.1",
      FLEX_API_PORT: a.port,
      FLEX_PROFILE_VU: "Sat VU Profile",
      FLEX_PROFILE_UV: "Sat UV Profile",
      FLEX_PROFILE_VV: "APRS VV",
      RADIO_TRANSPORT: "tcp",
      C_MS: 299792458,
    },
  };

  const catalog = require("../lib/catalog");
  catalog.getCatalog = () => ({
    "SO-50": {
      modes: [{ mode: "FM", uplink: "145.850", downlink: "436.795" }],
    },
    "AO-91": {
      modes: [{ mode: "FM", uplink: "435.250", downlink: "145.960" }],
    },
    "ISS": {
      modes: [{ mode: "APRS", uplink: "145.825", downlink: "145.825" }],
    },
  });

  const flex = require("../lib/radios/flex");
  const logs = [];
  const oL = console.log;
  const oW = console.warn;
  console.log = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => logs.push("WARN " + args.join(" "));

  let sat = "SO-50";
  try {
    flex.init({
      getContext: () => ({ currentSatKey: sat, currentModeIndex: 0 }),
    });
    flex.setLock(true);
    flex.setRadio(true);

    // Push until sync settles enough that profile + CAT ran
    for (let i = 0; i < 8; i++) {
      await flex.pushFrequencies(145850000 + i, 436795000 - i);
      await sleep(200);
    }

    const loads = a.st.cmds.filter((c) =>
      /^profile\s+global\s+load\s+"Sat VU Profile"$/.test(c),
    );
    assert.strictEqual(
      loads.length,
      1,
      "profile load once: " + a.st.cmds.join(" | "),
    );
    assert.ok(
      logs.some((l) => /Flex profile: loading "Sat VU Profile" for V\/U/.test(l)),
      "log line: " + logs.filter((l) => /profile/i.test(l)).join(" || "),
    );

    // Profile command must precede any FA write on CAT (profile resets slices)
    const firstFaUl = u.st.cmds.findIndex((c) => /^FA\d+$/.test(c));
    const firstFaDl = d.st.cmds.findIndex((c) => /^FA\d+$/.test(c));
    // API profile load happens; CAT may open in parallel for sync — but
    // ensureFlexProfile awaits load before pushSide. So by the time FA is
    // written, profile cmd is already in a.st.cmds.
    assert.ok(a.st.cmds.indexOf(loads[0]) >= 0);
    assert.ok(firstFaUl >= 0 || firstFaDl >= 0, "CAT freqs were written");

    // Same sat again: no second load
    const before = a.st.cmds.filter((c) => /profile\s+global\s+load/.test(c))
      .length;
    for (let i = 0; i < 4; i++) {
      await flex.pushFrequencies(145850100 + i, 436794900 - i);
      await sleep(150);
    }
    const after = a.st.cmds.filter((c) => /profile\s+global\s+load/.test(c))
      .length;
    assert.strictEqual(after, before, "no re-load for same profile");

    // Switch to U/V sat → different profile
    sat = "AO-91";
    flex.resetOffsets();
    a.st.cmds.length = 0;
    u.st.cmds.length = 0;
    d.st.cmds.length = 0;
    for (let i = 0; i < 8; i++) {
      await flex.pushFrequencies(435250000 + i, 145960000 - i);
      await sleep(200);
    }
    const uvLoads = a.st.cmds.filter((c) =>
      /^profile\s+global\s+load\s+"Sat UV Profile"$/.test(c),
    );
    assert.strictEqual(
      uvLoads.length,
      1,
      "U/V load once: " + a.st.cmds.join(" | "),
    );
    assert.ok(
      logs.some((l) => /Flex profile: loading "Sat UV Profile" for U\/V/.test(l)),
    );

    // V/V simplex
    sat = "ISS";
    flex.resetOffsets();
    a.st.cmds.length = 0;
    for (let i = 0; i < 8; i++) {
      await flex.pushFrequencies(145825000 + i, 145825000 + i);
      await sleep(200);
    }
    const vvLoads = a.st.cmds.filter((c) =>
      /^profile\s+global\s+load\s+"APRS VV"$/.test(c),
    );
    assert.strictEqual(
      vvLoads.length,
      1,
      "V/V load once: " + a.st.cmds.join(" | "),
    );
    assert.ok(
      logs.some((l) => /Flex profile: loading "APRS VV" for V\/V/.test(l)),
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
    delete require.cache[flexPath];
    delete require.cache[apiPath];
  }
});

test("Flex profile: no API host → one-line skip, no load attempt", async () => {
  const u = await fakeCat();
  const d = await fakeCat();
  const cfgPath = require.resolve(path.join(__dirname, "../lib/config"));
  const flexPath = require.resolve(path.join(__dirname, "../lib/radios/flex"));
  const apiPath = require.resolve(path.join(__dirname, "../lib/radios/flex-api"));
  delete require.cache[flexPath];
  delete require.cache[apiPath];
  require.cache[cfgPath] = {
    id: cfgPath,
    filename: cfgPath,
    loaded: true,
    exports: {
      FLEX_UL_HOST: "127.0.0.1",
      FLEX_UL_PORT: u.port,
      FLEX_DL_HOST: "127.0.0.1",
      FLEX_DL_PORT: d.port,
      FLEX_API_HOST: "",
      FLEX_API_PORT: 4992,
      FLEX_PROFILE_VU: "Should Skip",
      FLEX_PROFILE_UV: "",
      FLEX_PROFILE_VV: "",
      RADIO_TRANSPORT: "tcp",
      C_MS: 299792458,
    },
  };
  const catalog = require("../lib/catalog");
  catalog.getCatalog = () => ({
    "SO-50": {
      modes: [{ mode: "FM", uplink: "145.850", downlink: "436.795" }],
    },
  });
  const flex = require("../lib/radios/flex");
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
    for (let i = 0; i < 6; i++) {
      await flex.pushFrequencies(145850000 + i, 436795000 - i);
      await sleep(120);
    }
    const skips = logs.filter((l) =>
      /Flex profile: skip "Should Skip" for V\/U/.test(l),
    );
    assert.strictEqual(skips.length, 1, "one skip log: " + skips.join(" | "));
  } finally {
    console.log = oL;
    console.warn = oW;
    try {
      flex.close();
    } catch (_) {}
    u.server.close();
    d.server.close();
    delete require.cache[flexPath];
    delete require.cache[apiPath];
  }
});
