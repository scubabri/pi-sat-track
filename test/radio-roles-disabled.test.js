// Radio 1 / Radio 2 panel: "Disabled" leg per sat (simplex sats such as APRS
// digipeaters, UL = DL, worked on one radio). The disabled leg maps to no
// driver: no CAT writes, no connection to its radio (unless it is the other
// leg's radio too), no Flex profile role; the remaining radio keeps its own
// leg exactly as before. Legacy per-sat data (no roleOff) = both legs.
// Real lib/radios registry with mock rigctld / Flex CAT listeners on
// 127.0.0.1 (ephemeral ports); js/radio-roles.js with a fake DOM.
// Run: node --test --test-force-exit test/radio-roles-disabled.test.js
const test = require("node:test");
const assert = require("assert");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pst-radio-off-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const roles = require("../lib/radio-roles");
const config = require("../lib/config");
const catalog = require("../lib/catalog");
const radios = require("../lib/radios");
const satOffsets = require("../lib/sat-offsets");
const { createRouter } = require("../lib/radio-role-router");

const rig = (port) => ({ transport: "tcp", type: "rigctl", protocol: "rigctl", rigctlEndpoint: "127.0.0.1:" + port });

/* ---------- lib/radio-roles.js ---------- */

test("roles: effectiveEndpoints marks the disabled side, keeps orientation; default unchanged", () => {
  const cfg = { singleRadio: false, radioUl: rig(1001), radioDl: rig(1002), rigctlHost: "x", rigctlPort: 1 };
  assert.strictEqual(roles.effectiveEndpoints(cfg, 1, null), cfg, "both legs, Radio 1 UL: same object");
  const a = roles.effectiveEndpoints(cfg, 1, "ul");
  assert.strictEqual(a.radioUl.disabled, true);
  assert.strictEqual(a.radioUl.rigctlEndpoint, "127.0.0.1:1001");
  assert.ok(!a.radioDl.disabled && a.radioDl.rigctlEndpoint === "127.0.0.1:1002");
  assert.ok(!("rigctlHost" in a), "flat fields dropped: sides decide");
  assert.ok(!cfg.radioUl.disabled, "stored config untouched");
  const b = roles.effectiveEndpoints(cfg, 2, "dl");
  assert.strictEqual(b.radioUl.rigctlEndpoint, "127.0.0.1:1002", "Radio 2 on UL");
  assert.strictEqual(b.radioDl.disabled, true);
  assert.strictEqual(b.radioDl.rigctlEndpoint, "127.0.0.1:1001");
  const single = Object.assign({}, cfg, { singleRadio: true });
  assert.strictEqual(roles.effectiveEndpoints(single, 1, "ul"), single, "single radio: ignored");
  assert.strictEqual(roles.resolveRoleOff(single, "ul"), null);
  assert.strictEqual(roles.resolveRoleOff(cfg, "both"), null, "garbage = both legs");
  const p = roles.panelPayload(cfg, "AO-91", null, "Home", "ul");
  assert.strictEqual(p.off, "ul");
  assert.strictEqual(p.saved, true);
  assert.strictEqual(roles.panelPayload(cfg, "AO-91", null, "Home").off, null, "legacy: no roleOff");
});

test("sat-offsets: roleOff per sat per profile, legacy entries = both legs, kept with other fields", () => {
  satOffsets.setProfile("Home");
  satOffsets.set("RS-44", { ulFineOffset: 120 }); // legacy-style entry, no roleOff
  assert.strictEqual(satOffsets.getRoleOff("RS-44"), null);
  satOffsets.setRoleOff("ISS", "ul");
  satOffsets.setModeIndex("ISS", 1);
  satOffsets.set("ISS", { ulFineOffset: 50 });
  assert.strictEqual(satOffsets.getRoleOff("ISS"), "ul", "kept by setModeIndex / set");
  satOffsets.flush();
  const disk = JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".rpitrack", "sat-offsets.json"), "utf8"));
  assert.strictEqual(disk.profiles.Home.ISS.roleOff, "ul");
  satOffsets.setRoleOff("ISS", "bogus");
  assert.strictEqual(satOffsets.getRoleOff("ISS"), null);
  satOffsets.setProfile("Portable");
  assert.strictEqual(satOffsets.getRoleOff("ISS"), null, "per profile");
  satOffsets.setProfile("Home");
});

/* ---------- routing with mock radios ---------- */

function startFake(kind) {
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
        if (kind === "flex") continue; // mock Flex CAT never answers
        let reply = "RPRT 0";
        if (line === "f") reply = "145825000";
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
const UL = 145825000, DL = 145825500; // simplex digi (UL = DL, Doppler aside)
const ULX = 435110000, DLX = 145870000; // a normal U/V sat
const nearAny = (list, hz) => list.some((f) => Math.abs(f - hz) < 20000);

let r1, r2, sentinel, profileCfg, router;
const logs = [];
async function pushSome(ul, dl, noWait) {
  const r = radios.active();
  for (let i = 0; i < 5; i++) {
    const p = Promise.resolve(r.pushFrequencies(ul + i * 10, dl - i * 5)).catch(() => {});
    if (!noWait) await p;
    await sleep(noWait ? 150 : 60);
  }
}
const clearCmds = () => { r1.cmds.length = 0; r2.cmds.length = 0; };

test("setup: Radio 1 = rigctld A, Radio 2 = rigctld B, TX split ON", async () => {
  r1 = await startFake();
  r2 = await startFake();
  sentinel = await startFake();
  catalog.getCatalog = () => ({
    "ISS": { modes: [{ mode: "FM APRS", uplink: "145.825", downlink: "145.825" }] },
    "JO-97": { modes: [{ mode: "SSB", uplink: "435.110", downlink: "145.870" }] },
  });
  profileCfg = {
    singleRadio: false, txSplit: true,
    radioUl: rig(r1.port), radioDl: rig(r2.port),
    radioRoles: { defaultUl: 1, names: ["IC-705", "IC-9700"], bands: [["2m"], ["70cm"]] },
    radioTransport: "tcp", radioType: "rigctl", radioProtocol: "rigctl",
    rigctlHost: "127.0.0.1", rigctlPort: r2.port, rigctlUlHost: "127.0.0.1", rigctlUlPort: r1.port,
  };
  satOffsets.setProfile("Home");
  satOffsets.setRoleOff("ISS", null);
  router = createRouter({ config, radios, satOffsets, getConfig: () => profileCfg, log: (m) => logs.push(m) });
  radios.init({ getContext: () => ({ currentSatKey: "JO-97", currentModeIndex: 0 }), broadcast: () => {} });
  config.applyEndpoints(router.effective(profileCfg, "JO-97"));
  assert.strictEqual(router.appliedKey(), "1");
  radios.start();
  radios.setRadio(true, "test");
  await pushSome(ULX, DLX);
  await sleep(200);
  assert.ok(nearAny(freqsOn(r1), ULX) && nearAny(freqsOn(r2), DLX), "both legs as before");
});

test("UL Disabled (DL on Radio 2): B tracks the downlink as before, A gets nothing and is disconnected", async () => {
  assert.strictEqual(router.setForSat("ISS", 1, "ul"), true);
  assert.strictEqual(satOffsets.getRoleOff("ISS"), "ul");
  assert.strictEqual(router.applyForSat("ISS", "panel"), true);
  assert.strictEqual(router.appliedKey(), "1|ul-off");
  assert.ok(logs.some((l) => /ISS \(panel\): UL disabled, DL = Radio 2/.test(l)), logs.join("\n"));
  assert.strictEqual(radios.activeUl(), radios.nullDriver);
  assert.strictEqual(radios.activeDl().meta.id, "rigctl");
  assert.strictEqual(config.RIGCTL_UL_HOST, "", "no second rigctl endpoint");
  assert.strictEqual(config.RIGCTL_PORT, r2.port);
  await sleep(500);
  clearCmds();
  await pushSome(UL, DL);
  await sleep(300);
  assert.strictEqual(freqsOn(r1).length, 0, "Radio 1: no CAT writes: " + r1.cmds.join(","));
  assert.ok(nearAny(freqsOn(r2), DL), "Radio 2 gets DL: " + freqsOn(r2).join(","));
  assert.ok(!freqsOn(r2).some((f) => f === UL), "and no uplink write");
  await sleep(2800);
  assert.strictEqual(r1.open, 0, "Radio 1 not connected");
  assert.ok(r2.open <= 1);
  assert.strictEqual(sentinel.conns, 0);
  const st = radios.active().getRadioState();
  assert.strictEqual(st.connected, true, "connected = the used radio");
  assert.strictEqual(st.roleOff, "ul");
});

test("disabled leg keeps its offsets (saved / logged freq unchanged), center clears them", () => {
  radios.active().setOffsets({ ulFineOffset: 700, dlFineOffset: 30, manualDlOffset: 0 });
  assert.strictEqual(radios.active().getRadioState().ulFineOffset, 700);
  radios.active().center();
  assert.strictEqual(radios.active().getRadioState().ulFineOffset, 0);
});

test("same roles again: no re-apply; DL Disabled with Radio 2 on UL: B gets UL only (no TX-split DL), A off", async () => {
  assert.strictEqual(router.applyForSat("ISS", "sat"), false);
  router.setForSat("ISS", 2, "dl");
  assert.strictEqual(router.applyForSat("ISS", "panel"), true);
  assert.strictEqual(radios.activeUl().meta.id, "rigctl");
  assert.strictEqual(radios.activeDl(), radios.nullDriver);
  await sleep(500);
  clearCmds();
  await pushSome(UL, DL);
  await sleep(300);
  assert.strictEqual(freqsOn(r1).length, 0, "Radio 1 untouched: " + r1.cmds.join(","));
  assert.ok(nearAny(freqsOn(r2), UL), "Radio 2 has the uplink");
  assert.ok(!r2.cmds.some((c) => /^I\s/.test(c)), "no DL on VFO B even with TX split on: " + r2.cmds.join(","));
  await sleep(2800);
  assert.strictEqual(r1.open, 0);
});

test("re-enable (pick a radio on the disabled side) and a legacy sat: both legs again", async () => {
  router.setForSat("ISS", 1, null);
  assert.strictEqual(router.applyForSat("ISS", "panel"), true);
  assert.strictEqual(router.appliedKey(), "1");
  assert.strictEqual(router.applyForSat("JO-97", "sat"), false, "JO-97 (no roleOff) = same orientation");
  await sleep(500);
  clearCmds();
  await pushSome(ULX, DLX);
  await sleep(300);
  assert.ok(nearAny(freqsOn(r1), ULX) && nearAny(freqsOn(r2), DLX), "A: " + freqsOn(r1).join(",") + " B: " + freqsOn(r2).join(","));
});

test("Flex as Radio 2: Flex on DL keeps its DL role with UL disabled; DL disabled = Flex not used at all", async () => {
  const flexCat = await startFake("flex");
  profileCfg = {
    singleRadio: false, txSplit: false,
    radioUl: rig(r1.port),
    radioDl: { transport: "tcp", type: "smartsdr", protocol: "cat", catEndpoint: "127.0.0.1:" + flexCat.port, apiEndpoint: "", rigctlEndpoint: "127.0.0.1:" + sentinel.port },
    radioTransport: "tcp", radioType: "smartsdr", radioProtocol: "cat",
    rigctlHost: "127.0.0.1", rigctlPort: sentinel.port, rigctlUlHost: "127.0.0.1", rigctlUlPort: r1.port,
    flexUlHost: "127.0.0.1", flexUlPort: 1, flexDlHost: "127.0.0.1", flexDlPort: flexCat.port, flexApiHost: "",
  };
  satOffsets.setUlRadio("ISS", 1);
  satOffsets.setRoleOff("ISS", "ul");
  const flags = config.applyEndpoints(router.effective(profileCfg, "ISS"));
  radios.applyEndpointChange(flags);
  assert.strictEqual(radios.activeUl(), radios.nullDriver);
  assert.strictEqual(radios.activeDl().meta.id, "flex");
  assert.deepStrictEqual(router.flexRole(), { role: "dl", legacy: true }, "Flex profile memory: DL role");
  await sleep(400);
  r1.cmds.length = 0;
  await pushSome(UL, DL, true);
  await sleep(300);
  assert.strictEqual(freqsOn(r1).length, 0, "rigctl (UL, disabled) untouched");
  assert.ok(flexCat.conns >= 1, "Flex CAT (DL) dialled");
  // Now the Flex's leg is the disabled one.
  router.setForSat("ISS", 1, "dl");
  assert.strictEqual(router.applyForSat("ISS", "panel"), true);
  assert.strictEqual(radios.activeUl().meta.id, "rigctl");
  assert.strictEqual(radios.activeDl(), radios.nullDriver);
  assert.strictEqual(router.flexRole(), null, "no Flex role: no Flex profile load");
  assert.strictEqual(radios.isSelected(radios.get("flex")), false, "Flex driver deselected");
  await sleep(300);
  const c = flexCat.conns;
  r1.cmds.length = 0;
  await pushSome(UL, DL, true);
  await sleep(2800);
  assert.strictEqual(flexCat.conns, c, "Flex not re-dialled");
  assert.strictEqual(flexCat.open, 0, "Flex CAT closed");
  assert.ok(nearAny(freqsOn(r1), UL), "rigctl has the uplink");
  assert.strictEqual(sentinel.conns, 0);
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

/* ---------- js/radio-roles.js (panel) ---------- */

function panel() {
  const els = {};
  const mk = (id) => {
    const cls = new Set();
    const e = {
      id, hidden: false, disabled: false, value: "", textContent: "", title: "", innerHTML: "", options: [], __ls: {},
      classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), remove: (...c) => c.forEach((x) => cls.delete(x)), contains: (c) => cls.has(c) },
      appendChild(o) { this.options.push(o); return o; },
      addEventListener(t, f) { this.__ls[t] = f; },
      closest: () => null,
    };
    Object.defineProperty(e, "innerHTML", { set(v) { if (v === "") e.options = []; }, get() { return ""; } });
    return e;
  };
  for (const id of ["radio-role-ul-wrap", "radio-role-dl-wrap", "radio-role-ul", "radio-role-dl", 
    "freq-ul", "freq-dl", "freq-ul-doppler", "freq-dl-doppler", "btn-fine-ul-minus", "btn-fine-ul-plus", "btn-fine-dl-minus", "btn-fine-dl-plus", "flex-profile-label"]) els[id] = mk(id);
  const blocks = { ul: mk("block-ul"), dl: mk("block-dl") };
  els["freq-ul"].closest = () => blocks.ul;
  els["freq-dl"].closest = () => blocks.dl;
  const sent = [];
  const wsL = {};
  const sb = {
    console, JSON, Object, Array, Number, String, parseInt, setInterval() {},
    ws: { readyState: 1, send: (m) => sent.push(JSON.parse(m)), addEventListener: (t, f) => (wsL[t] = f) },
    document: { readyState: "complete", getElementById: (id) => els[id] || null, createElement: () => ({ value: "", textContent: "", disabled: false }), addEventListener() {} },
    loadConfig: () => ({ singleRadio: false, radioUl: { type: "rigctl", protocol: "rigctl" }, radioDl: { type: "smartsdr", protocol: "cat" } }),
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "radio-roles.js"), "utf8"), sb);
  const recv = (m) => wsL.message({ data: JSON.stringify(m) });
  const change = (side, v) => { els["radio-role-" + side].value = v; els["radio-role-" + side].__ls.change(); };
  const offOpt = (side) => els["radio-role-" + side].options.find((o) => o.value === "off");
  return { sb, els, blocks, sent, recv, change, offOpt };
}
const rolesMsg = (o) => Object.assign({ type: "radio-roles", twoRadio: true, sat: "ISS", profile: "Home", ulRadio: 1, saved: false, off: null,
  radios: [{ n: 1, label: "Radio 1 \u00b7 IC-705" }, { n: 2, label: "Radio 2 \u00b7 Flex" }] }, o);

test("panel: Disabled option on both dropdowns; UL Disabled greys the UL readout and blocks DL Disabled", () => {
  const p = panel();
  p.recv(rolesMsg({}));
  assert.deepStrictEqual(p.els["radio-role-ul"].options.map((o) => o.textContent), ["Radio 1 \u00b7 IC-705", "Radio 2 \u00b7 Flex", "Disabled"]);
  assert.strictEqual(p.offOpt("dl").disabled, false);
  p.change("ul", "off");
  assert.deepStrictEqual(p.sent.pop(), { type: "radio-role-set", sat: "ISS", ulRadio: 1, off: "ul" });
  assert.strictEqual(p.els["radio-role-ul"].value, "off");
  assert.strictEqual(p.els["radio-role-dl"].value, "2", "DL keeps its radio");
  assert.strictEqual(p.offOpt("dl").disabled, true, "can't disable both legs");
  assert.strictEqual(p.els["freq-ul"].textContent, "Disabled");
  assert.ok(p.blocks.ul.classList.contains("role-off") && !p.blocks.dl.classList.contains("role-off"));
  assert.ok(p.els["btn-fine-ul-plus"].disabled && !p.els["btn-fine-dl-plus"].disabled);
  assert.strictEqual(p.sb.radioRoleOff(), "ul");
  assert.match(p.els["flex-profile-label"].textContent, /Radio 2 \(DL\)/);
  // Forced DL Disabled while UL is Disabled (e.g. keyboard): refused, dropdown restored.
  const n = p.sent.length;
  p.change("dl", "off");
  assert.strictEqual(p.sent.length, n, "nothing sent");
  assert.strictEqual(p.els["radio-role-dl"].value, "2");
  // DL moved to Radio 1 while UL stays disabled: orientation follows.
  p.change("dl", "1");
  assert.deepStrictEqual(p.sent.pop(), { type: "radio-role-set", sat: "ISS", ulRadio: 2, off: "ul" });
  // Picking a radio on the disabled side re-enables it.
  p.change("ul", "1");
  assert.deepStrictEqual(p.sent.pop(), { type: "radio-role-set", sat: "ISS", ulRadio: 1, off: null });
  assert.ok(!p.blocks.ul.classList.contains("role-off"));
  assert.ok(!p.els["btn-fine-ul-plus"].disabled);
});

test("panel: server payload with DL off; Flex on the disabled leg reads 'not used'; next-roles rules", () => {
  const p = panel();
  p.recv(rolesMsg({ ulRadio: 1, off: "dl", saved: true }));
  assert.strictEqual(p.els["radio-role-dl"].value, "off");
  assert.strictEqual(p.offOpt("ul").disabled, true);
  assert.strictEqual(p.els["freq-dl"].textContent, "Disabled");
  assert.match(p.els["flex-profile-label"].textContent, /Radio 2 \(not used\)/);
  const next = p.sb.__radioRolesNext;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(next({ ulRadio: 2, off: null }, "dl", "off"))), { ulRadio: 2, off: "dl" });
  assert.strictEqual(next({ ulRadio: 2, off: "ul" }, "dl", "off"), null);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(next({ ulRadio: 1, off: "dl" }, "ul", 2))), { ulRadio: 2, off: "dl" }, "UL radio change keeps DL off");
  p.recv(rolesMsg({ off: null }));
  assert.strictEqual(p.els["radio-role-dl"].value, "2");
  assert.strictEqual(p.offOpt("ul").disabled, false);
});
