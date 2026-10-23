// Radio 1 / Radio 2 roles (two-radio setups): config migration, per-sat
// persistence (sat-offsets ulRadio, per profile), and swap routing through the
// real driver registry with mock rigctld / Flex CAT listeners on 127.0.0.1
// (ephemeral ports). Uplink Doppler must reach the radio on UL, downlink the
// other one; same orientation = nothing re-applied; no stray connections.
// Run: node --test --test-force-exit test/radio-roles.test.js
const test = require("node:test");
const assert = require("assert");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pst-radio-roles-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const roles = require("../lib/radio-roles");
const config = require("../lib/config");
const catalog = require("../lib/catalog");
const radios = require("../lib/radios");
const satOffsets = require("../lib/sat-offsets");
const { createRouter } = require("../lib/radio-role-router");

/* ---------- config migration ---------- */

/** A saved pre-roles profile config: UL Flex CAT 60002, DL Flex CAT 60001 (+ flat fields). */
function legacyFlexCfg() {
  const side = (port) => ({ transport: "tcp", type: "smartsdr", protocol: "cat", catEndpoint: "127.0.0.1:" + port, apiEndpoint: "127.0.0.1:4992", rigctlEndpoint: "127.0.0.1:4532" });
  return {
    singleRadio: false, txSplit: true,
    radioUl: side(60002), radioDl: side(60001),
    radioTransport: "tcp", radioType: "smartsdr", radioProtocol: "cat",
    flexUlHost: "127.0.0.1", flexUlPort: 60002, flexDlHost: "127.0.0.1", flexDlPort: 60001,
    flexApiHost: "127.0.0.1", flexApiPort: 4992, rigctlHost: "127.0.0.1", rigctlPort: 4532,
  };
}

test("migration: no radioRoles = Radio 1 (old UL) on uplink, config applied unchanged", () => {
  const cfg = legacyFlexCfg();
  assert.deepStrictEqual(roles.normalizeRoles(cfg.radioRoles), { defaultUl: 1, names: ["", ""], bands: [[], []] });
  assert.strictEqual(roles.resolveUlRadio(cfg, null), 1);
  assert.strictEqual(roles.effectiveEndpoints(cfg, 1), cfg, "same object: byte-for-byte the old behaviour");
  config.applyEndpoints(roles.effectiveEndpoints(cfg, 1));
  assert.strictEqual(config.FLEX_UL_PORT, 60002);
  assert.strictEqual(config.FLEX_DL_PORT, 60001);
});

test("single radio: always Radio 1, never swapped", () => {
  const cfg = Object.assign(legacyFlexCfg(), { singleRadio: true, radioRoles: { defaultUl: 2 } });
  assert.strictEqual(roles.resolveUlRadio(cfg, 2), 1);
  assert.strictEqual(roles.effectiveEndpoints(cfg, 2), cfg);
});

test("swap: sides exchanged, flat legacy radio fields dropped, globals derived; back restores", () => {
  const cfg = legacyFlexCfg();
  const eff = roles.effectiveEndpoints(cfg, 2);
  assert.notStrictEqual(eff, cfg);
  assert.strictEqual(eff.radioUl, cfg.radioDl);
  assert.strictEqual(eff.radioDl, cfg.radioUl);
  for (const k of roles.FLAT_RADIO_KEYS) assert.ok(!(k in eff), k + " dropped");
  assert.strictEqual(cfg.flexUlPort, 60002, "stored config untouched");
  config.applyEndpoints(eff);
  assert.strictEqual(config.FLEX_UL_PORT, 60001, "Radio 2 now on UL");
  assert.strictEqual(config.FLEX_DL_PORT, 60002, "Radio 1 now on DL");
  config.applyEndpoints(roles.effectiveEndpoints(cfg, 1));
  assert.strictEqual(config.FLEX_UL_PORT, 60002);
  assert.strictEqual(config.FLEX_DL_PORT, 60001);
});

test("roles normalize: default, names, bands", () => {
  const r = roles.normalizeRoles({ defaultUl: "2", names: [" IC-705 ", "Flex 6600"], bands: [["70cm", "2m", "bogus"], ["any", "2m"]] });
  assert.deepStrictEqual(r, { defaultUl: 2, names: ["IC-705", "Flex 6600"], bands: [["2m", "70cm"], ["any"]] });
  const cfg = Object.assign(legacyFlexCfg(), { radioRoles: r });
  assert.strictEqual(roles.resolveUlRadio(cfg, null), 2, "profile default");
  assert.strictEqual(roles.resolveUlRadio(cfg, 1), 1, "per-sat choice wins");
  const p = roles.panelPayload(cfg, "RS-44", null, "Home");
  assert.strictEqual(p.ulRadio, 2);
  assert.strictEqual(p.saved, false);
  assert.deepStrictEqual(p.radios.map((x) => x.label), ["Radio 1 \u00b7 IC-705", "Radio 2 \u00b7 Flex 6600"]);
});

/* ---------- per-sat persistence ---------- */

test("sat-offsets: ulRadio saved per profile, per sat; kept with offsets; on disk", () => {
  satOffsets.load();
  satOffsets.setProfile("Home");
  assert.strictEqual(satOffsets.getUlRadio("JO-97"), null);
  satOffsets.setUlRadio("JO-97", 2);
  satOffsets.set("JO-97", { ulFineOffset: 120, dlFineOffset: -40, manualDlOffset: 0 });
  satOffsets.setModeIndex("JO-97", 0);
  assert.strictEqual(satOffsets.getUlRadio("JO-97"), 2, "offset / mode writes keep the radio choice");
  assert.strictEqual(satOffsets.get("JO-97").ulFineOffset, 120);
  assert.strictEqual(satOffsets.getUlRadio("RS-44"), null);
  satOffsets.setUlRadio("RS-44", 1);
  satOffsets.setProfile("Portable");
  assert.strictEqual(satOffsets.getUlRadio("JO-97"), null, "other profile: own map");
  satOffsets.setProfile("Home");
  assert.strictEqual(satOffsets.getUlRadio("JO-97"), 2);
  satOffsets.flush();
  const disk = JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".rpitrack", "sat-offsets.json"), "utf8"));
  assert.strictEqual(disk.profiles.Home["JO-97"].ulRadio, 2);
  assert.strictEqual(disk.profiles.Home["RS-44"].ulRadio, 1);
  satOffsets.setUlRadio("RS-44", null);
  assert.strictEqual(satOffsets.getUlRadio("RS-44"), null, "cleared = profile default");
  satOffsets.setUlRadio("JO-97", 7);
  assert.strictEqual(satOffsets.getUlRadio("JO-97"), null, "garbage clears");
  satOffsets.setUlRadio("JO-97", 2);
});

/* ---------- swap routing with mock radios ---------- */

function startFake() {
  const st = { conns: 0, open: 0, cmds: [], socks: [] };
  const server = net.createServer((sock) => {
    st.conns += 1;
    st.open += 1;
    st.socks.push(sock);
    sock.on("error", () => {});
    sock.on("close", () => (st.open -= 1));
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString("utf8");
      let nl;
      while ((nl = buf.search(/[\n;]/)) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        st.cmds.push(line);
        let reply = "RPRT 0";
        if (line === "f") reply = "145870000";
        else if (line === "U ?") reply = "LOCK";
        sock.write(reply + "\n");
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      st.port = server.address().port;
      st.close = () => new Promise((r) => { for (const s of st.socks) s.destroy(); server.close(() => r()); });
      resolve(st);
    }),
  );
}

const freqsOn = (st) => st.cmds.filter((c) => /^[FI]\s+\d+/.test(c)).map((c) => parseInt(c.split(/\s+/)[1], 10));
const UL = 435110000, DL = 145870000;
const near = (list, hz) => list.some((f) => Math.abs(f - hz) < 20000);

let r1, r2, sentinel, profileCfg, router, reapplied;
const logs = [];

test("setup: Radio 1 = rigctld A, Radio 2 = rigctld B (TX split off)", async () => {
  r1 = await startFake();
  r2 = await startFake();
  sentinel = await startFake(); // the (unused) default rigctl endpoint: must never be dialled
  catalog.getCatalog = () => ({ "JO-97": { modes: [{ mode: "SSB", uplink: "435.110", downlink: "145.870" }] }, "RS-44": { modes: [{ mode: "SSB", uplink: "145.965", downlink: "435.640" }] } });
  const side = (port) => ({ transport: "tcp", type: "rigctl", protocol: "rigctl", rigctlEndpoint: "127.0.0.1:" + port });
  profileCfg = {
    singleRadio: false, txSplit: false,
    radioUl: side(r1.port), radioDl: side(r2.port),
    radioRoles: { defaultUl: 1, names: ["IC-705", "IC-9700"], bands: [["2m"], ["70cm"]] },
    // flat fields as js/config.js derives them for this (unswapped) form
    radioTransport: "tcp", radioType: "rigctl", radioProtocol: "rigctl",
    rigctlHost: "127.0.0.1", rigctlPort: r2.port, rigctlUlHost: "127.0.0.1", rigctlUlPort: r1.port,
  };
  satOffsets.setProfile("Home");
  satOffsets.setUlRadio("JO-97", 2); // saved: Radio 2 on UL for JO-97
  router = createRouter({ config, radios, satOffsets, getConfig: () => profileCfg, log: (m) => logs.push(m) });
  radios.init({ getContext: () => ({ currentSatKey: "RS-44", currentModeIndex: 0 }), broadcast: () => {} });
  // Profile applied for RS-44 (no saved choice → default Radio 1 on UL).
  config.applyEndpoints(router.effective(profileCfg, "RS-44"));
  assert.strictEqual(router.applied(), 1);
  assert.strictEqual(config.RIGCTL_UL_PORT, r1.port);
  assert.strictEqual(config.RIGCTL_PORT, r2.port);
  radios.start();
  radios.setRadio(true, "test");
});

async function pushSome(ul, dl, noWait) {
  const r = radios.active();
  for (let i = 0; i < 5; i++) {
    // noWait: the mock Flex CAT never answers (its waits would only slow the test).
    const p = Promise.resolve(r.pushFrequencies(ul + i * 10, dl - i * 5)).catch(() => {});
    if (!noWait) await p;
    await sleep(noWait ? 150 : 60);
  }
}

test("default roles: uplink → Radio 1 (A), downlink → Radio 2 (B)", async () => {
  await pushSome(UL, DL);
  await sleep(200);
  assert.ok(near(freqsOn(r1), UL) && !near(freqsOn(r1), DL), "A gets UL only: " + freqsOn(r1).join(","));
  assert.ok(near(freqsOn(r2), DL) && !near(freqsOn(r2), UL), "B gets DL only: " + freqsOn(r2).join(","));
});

test("same orientation: applyForSat is a no-op (nothing torn down)", async () => {
  const c1 = r1.conns, c2 = r2.conns;
  assert.strictEqual(router.applyForSat("RS-44", "test"), false);
  await sleep(300);
  assert.strictEqual(r1.conns, c1);
  assert.strictEqual(r2.conns, c2);
});

test("select JO-97 (saved Radio 2 UL): uplink Doppler → B, downlink → A", async () => {
  r1.cmds.length = 0;
  r2.cmds.length = 0;
  assert.strictEqual(router.applyForSat("JO-97", "sat"), true);
  assert.strictEqual(router.applied(), 2);
  assert.strictEqual(config.RIGCTL_UL_PORT, r2.port, "UL endpoint = Radio 2");
  assert.strictEqual(config.RIGCTL_PORT, r1.port, "DL endpoint = Radio 1");
  await sleep(400);
  await pushSome(UL, DL);
  await sleep(300);
  assert.ok(near(freqsOn(r2), UL) && !near(freqsOn(r2), DL), "B gets UL only: " + freqsOn(r2).join(","));
  assert.ok(near(freqsOn(r1), DL) && !near(freqsOn(r1), UL), "A gets DL only: " + freqsOn(r1).join(","));
  assert.ok(logs.some((l) => /UL = Radio 2/.test(l)));
});

test("panel pick back to Radio 1 for JO-97: saved, routed back", async () => {
  assert.strictEqual(router.setForSat("JO-97", 1), true);
  assert.strictEqual(satOffsets.getUlRadio("JO-97"), 1);
  r1.cmds.length = 0;
  r2.cmds.length = 0;
  assert.strictEqual(router.applyForSat("JO-97", "panel"), true);
  await sleep(400);
  await pushSome(UL, DL);
  await sleep(300);
  assert.ok(near(freqsOn(r1), UL) && !near(freqsOn(r1), DL));
  assert.ok(near(freqsOn(r2), DL) && !near(freqsOn(r2), UL));
  const p = router.payload("JO-97", "Home");
  assert.strictEqual(p.ulRadio, 1);
  assert.strictEqual(p.saved, true);
});

test("no stray connections: one socket per radio, default endpoint never dialled", async () => {
  await sleep(2800); // > one 2.5 s reconnect period
  assert.strictEqual(sentinel.conns, 0);
  assert.ok(r1.open <= 1, "A open sockets " + r1.open);
  assert.ok(r2.open <= 1, "B open sockets " + r2.open);
});

test("single radio profile: setForSat refused, routing stays", () => {
  const saved = profileCfg;
  profileCfg = Object.assign({}, saved, { singleRadio: true });
  assert.strictEqual(router.setForSat("RS-44", 2), false);
  assert.strictEqual(router.payload("RS-44", "Home").twoRadio, false);
  profileCfg = saved;
});

test("mixed drivers: Radio 1 rigctl, Radio 2 Flex CAT — swap re-routes, no stray links", async () => {
  const flexCat = await startFake();
  const side1 = { transport: "tcp", type: "rigctl", protocol: "rigctl", rigctlEndpoint: "127.0.0.1:" + r1.port };
  const side2 = { transport: "tcp", type: "smartsdr", protocol: "cat", catEndpoint: "127.0.0.1:" + flexCat.port, apiEndpoint: "", rigctlEndpoint: "127.0.0.1:" + sentinel.port };
  profileCfg = {
    singleRadio: false, txSplit: false, radioUl: side1, radioDl: side2,
    radioTransport: "tcp", radioType: "smartsdr", radioProtocol: "cat",
    rigctlHost: "127.0.0.1", rigctlPort: sentinel.port, rigctlUlHost: "127.0.0.1", rigctlUlPort: r1.port,
    flexUlHost: "127.0.0.1", flexUlPort: 1, flexDlHost: "127.0.0.1", flexDlPort: flexCat.port, flexApiHost: "",
  };
  satOffsets.setUlRadio("RS-44", null);
  // Profile switch to this setup (RS-44: default, Radio 1 rigctl on UL).
  const flags = config.applyEndpoints(router.effective(profileCfg, "RS-44"));
  radios.applyEndpointChange(flags);
  await sleep(600);
  assert.strictEqual(radios.activeUl().meta.id, "rigctl");
  assert.strictEqual(radios.activeDl().meta.id, "flex");
  r1.cmds.length = 0;
  await pushSome(UL, DL, true);
  await sleep(300);
  assert.ok(near(freqsOn(r1), UL) && !near(freqsOn(r1), DL), "rigctl (UL) gets UL: " + freqsOn(r1).join(","));
  // Swap for JO-97: Flex on UL, rigctl on DL.
  router.setForSat("JO-97", 2);
  assert.strictEqual(router.applyForSat("JO-97", "sat"), true);
  assert.strictEqual(radios.activeUl().meta.id, "flex");
  assert.strictEqual(radios.activeDl().meta.id, "rigctl");
  assert.strictEqual(config.FLEX_UL_PORT, flexCat.port, "Flex CAT now the UL link");
  await sleep(600);
  r1.cmds.length = 0;
  await pushSome(UL, DL, true);
  await sleep(300);
  assert.ok(near(freqsOn(r1), DL) && !near(freqsOn(r1), UL), "rigctl (DL) gets DL only: " + freqsOn(r1).join(","));
  await sleep(2800);
  assert.strictEqual(sentinel.conns, 0, "unused rigctl default never dialled");
  assert.ok(r1.open <= 1, "rigctl open sockets " + r1.open);
  assert.ok(flexCat.open <= 1, "Flex CAT open sockets " + flexCat.open);
  assert.ok(flexCat.conns >= 1, "Flex CAT dialled");
  radios.setRadio(false, "test");
  await sleep(200);
  await flexCat.close();
});

test("teardown", async () => {
  radios.setRadio(false, "test");
  await sleep(150);
  await r1.close();
  await r2.close();
  await sentinel.close();
});
