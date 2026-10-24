// Auto Engage per-pass icon (Next Passes rows + Preview banner): built once
// and kept across the 1 s refresh / "state" messages (clicks not lost), marks
// saved via "auto-engage-passes-set" with a set-guard seq, independent of the
// pass alert bell next to it, no icon for the Moon.
// Real set-guard.js, pass-alerts(-core).js, auto-engage-core.js,
// auto-engage-ui.js, pass-panel.js and pass-preview.js in one vm context.
// Run: node --test --test-force-exit test/auto-engage-ui.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const MIN = 60 * 1000;
const NOW = Date.UTC(2026, 9, 24, 15, 10, 0);
const iso = (t) => new Date(t).toISOString();
const ms = (s) => new Date(s).getTime();
const P1 = { aos: iso(NOW + 69 * MIN + 40000), los: iso(NOW + 80 * MIN + 18000), maxEl: 34.9, aosAz: 300 };
const P2 = { aos: iso(NOW + 168 * MIN + 44000), los: iso(NOW + 173 * MIN + 9000), maxEl: 1.8, aosAz: 262 };
const P3 = { aos: iso(NOW + 977 * MIN), los: iso(NOW + 985 * MIN), maxEl: 9.7, aosAz: 180 };

function el(tag) {
  const attrs = {};
  const cls = new Set();
  const ls = {};
  const e = {
    tagName: String(tag).toUpperCase(), children: [], parent: null, style: {}, hidden: false, title: "", type: "",
    _html: "", _text: "",
    get firstElementChild() { return this._html ? {} : this.children[0] || null; },
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v); this.children.forEach((c) => (c.parent = null)); this.children = [];
      // toast markup (js/pass-alerts.js showToast): expose its text span
      if (/class="pat-text"/.test(this._html)) { const t = el("span"); t.className = "pat-text"; e.appendChild(t); }
    },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); this.children = []; },
    get className() { return [...cls].join(" "); },
    set className(v) { cls.clear(); String(v).split(/\s+/).forEach((c) => c && cls.add(c)); },
    classList: {
      add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
      toggle: (c, on) => { on = on === undefined ? !cls.has(c) : !!on; if (on) cls.add(c); else cls.delete(c); return on; },
    },
    attrs,
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    hasAttribute(k) { return k in attrs; },
    dataset: new Proxy({}, {
      get: (_, k) => attrs["data-" + String(k).replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())],
      set: (_, k, v) => ((attrs["data-" + String(k).replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())] = String(v)), true),
    }),
    appendChild(c) { if (c.parent) c.remove(); c.parent = e; e.children.push(c); return c; },
    insertBefore(c, ref) { if (c.parent) c.remove(); const i = e.children.indexOf(ref); c.parent = e; if (i < 0) e.children.push(c); else e.children.splice(i, 0, c); return c; },
    remove() { if (e.parent) { e.parent.children = e.parent.children.filter((x) => x !== e); e.parent = null; } },
    addEventListener(t, fn) { (ls[t] = ls[t] || []).push(fn); },
    removeEventListener() {},
    querySelector(sel) { return e.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const out = [];
      const want = sel.replace(/^\./, "");
      (function walk(n) { n.children.forEach((c) => { if (c.classList.contains(want)) out.push(c); walk(c); }); })(e);
      return out;
    },
    closest(sel) {
      for (let n = e; n; n = n.parent) {
        if (sel === ".sat-alert[data-alert]" && n.classList.contains("sat-alert") && n.hasAttribute("data-alert")) return n;
      }
      return null;
    },
    get isConnected() { let n = e; while (n.parent) n = n.parent; return n.tagName === "BODY"; },
  };
  return e;
}

function sandbox(opts) {
  const o = opts || {};
  const intervals = [];
  const store = {};
  const sess = {};
  const sent = [];
  const docLs = { capture: {}, bubble: {} };
  const body = el("body");
  const host = el("div");
  body.appendChild(host);
  const passBody = el("div");
  body.appendChild(passBody);
  const dings = [];
  let clock = NOW;
  const sb = {
    console: { log() {}, warn: console.warn, error: console.error }, Math, JSON, Number, String, Array, Object, Set, Map, Promise, Proxy, Infinity, isFinite,
    Date: class extends Date { constructor(...a) { if (a.length) super(...a); else super(clock); } static now() { return clock; } },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, clearInterval() {},
    setTimeout: (fn, ms) => { if (typeof fn === "function" && !(ms > 1000)) fn(); return 0; }, clearTimeout() {},
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => (store[k] = String(v)) },
    sessionStorage: { getItem: (k) => (k in sess ? sess[k] : null), setItem: (k, v) => (sess[k] = String(v)) },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    CSS: { escape: (s) => String(s) },
    formatClockShort: (t) => new Date(t - 6 * 3600 * 1000).toISOString().slice(11, 16) + " MT",
    formatPassTime: (s) => new Date(new Date(s).getTime() - 6 * 3600 * 1000).toISOString().slice(11, 19) + " MT",
    ws: { readyState: 1, send: (d) => sent.push(JSON.parse(d)), addEventListener() {} },
    loadFavorites: () => o.favs || [],
    currentSatLabel: "ISS",
  };
  const sel = el("div");
  body.appendChild(sel);
  const topIcon = el("button");
  topIcon.className = "pass-engage pass-engage-top";
  topIcon.setAttribute("data-engage", "pass");
  topIcon.setAttribute("data-engage-scope", "next");
  topIcon.hidden = true;
  sel.appendChild(topIcon);
  const byId = { map: host, "pass-panel-body": passBody, "sat-engage-top": topIcon };
  sb.document = {
    readyState: "complete", body,
    getElementById: (id) => {
      if (byId[id]) return byId[id];
      if (id === "pass-alert-toasts") return body.children.find((c) => c.id === id) || null;
      return null;
    },
    createElement: (t) => el(t),
    addEventListener: (t, fn, cap) => ((cap ? docLs.capture : docLs.bubble)[t] = (cap ? docLs.capture : docLs.bubble)[t] || []).push(fn),
    querySelector: () => null,
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    dispatchEvent() {},
  };
  sb.window = sb;
  vm.createContext(sb);
  for (const f of ["set-guard.js", "pass-alerts-core.js", "pass-alerts.js", "auto-engage-core.js", "auto-engage-ui.js", "pass-panel.js", "pass-preview.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), sb, { filename: f });
  }
  vm.runInContext("var currentSatKey = 'ISS'; passDrawerOpen = true;", sb);
  const state = (sat, passes) => vm.runInContext("updatePassPanelFromState", sb)({ type: "state", sat, display: sat, passes });
  const rowBells = () => passBody.children.map((r) => r.querySelector(".sat-alert"));
  const badge = () => host.children.find((c) => c.classList.contains("pass-preview-badge"));
  const bannerBell = () => badge().children.find((c) => c.classList.contains("ppb-alert"));
  const click = (target) => {
    const e = { target, stopped: false, preventDefault() {}, stopPropagation() { this.stopped = true; } };
    for (const fn of docLs.capture.click || []) fn(e);
    return e;
  };
  const tick = () => intervals.filter((x) => x.ms === 1000).forEach((x) => x.fn());
  const alertsSet = () => sent.filter((x) => x.type === "alerts-set");
  const engageSet = () => sent.filter((x) => x.type === "auto-engage-passes-set");
  const rowIcons = () => passBody.children.map((r) => r.querySelector(".pass-engage"));
  const bannerIcon = () => badge().children.find((c) => c.classList.contains("ppb-engage"));
  const engageState = (ae) => { vm.runInContext("updatePassPanelFromState", sb); sb.AutoEngage.onState({ type: "state", autoEngage: ae }); };
  return { topIcon, engageState, sb, sent, alertsSet, engageSet, state, rowBells, rowIcons, passBody, badge, bannerBell, bannerIcon, click, tick, body, dings,
    setClock: (t) => { clock = t; }, pp: () => sb.passPreview, PA: () => sb.PassAlerts, AE: () => sb.AutoEngage };
}


test("row icon next to the bell; same node across refreshes and state messages", () => {
  const s = sandbox();
  s.state("ISS", [P1, P2, P3]);
  const before = s.rowIcons();
  assert.strictEqual(before.length, 3);
  assert.ok(before.every(Boolean), "an icon on every row");
  const cells = s.passBody.children[0].__passCells;
  assert.ok(cells.engage.children.includes(before[0]), "own cell");
  const kids = s.passBody.children[0].children;
  assert.strictEqual(kids.indexOf(cells.engage), kids.indexOf(cells.alert) + 1, "right after the bell cell");
  s.tick();
  s.state("ISS", [Object.assign({}, P1, { aos: iso(ms(P1.aos) + 900) }), P2, P3]);
  s.tick();
  s.rowIcons().forEach((b, i) => assert.strictEqual(b, before[i], "row " + (i + 1) + " icon is the same element"));
  assert.ok(s.rowIcons().every((b) => b.isConnected));
  assert.strictEqual(before[0].dataset.engage, "pass");
  assert.strictEqual(before[0].dataset.sat, "ISS");
  assert.strictEqual(Number(before[0].dataset.aos), ms(P1.aos));
  assert.strictEqual(Number(before[0].dataset.los), ms(P1.los));
  assert.strictEqual(before[0].title, "Auto engage Radio + Antenna for this pass (AOS 10:19 MT) \u2014 click to arm");
  assert.ok(!before[0].classList.contains("sat-alert"), "not a bell");
});

test("row icon click marks / unmarks the pass (survives a refresh); bell untouched", () => {
  const s = sandbox();
  s.state("ISS", [P1, P2, P3]);
  const icon = s.rowIcons()[1];
  s.tick(); // refresh between render and click
  const e = s.click(icon);
  assert.ok(e.stopped, "handled in the capture phase");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s.AE().getMarks())), [{ key: "ISS", aosMs: ms(P2.aos), losMs: ms(P2.los) }]);
  const m = s.engageSet();
  assert.strictEqual(m.length, 1);
  assert.ok(Number.isFinite(m[0].seq), "set-guard seq");
  assert.strictEqual(s.alertsSet().length, 0, "no bell save");
  assert.strictEqual(s.PA().getAlerts().passes.length, 0, "no alert set");
  s.tick();
  s.state("ISS", [P1, P2, P3]);
  assert.ok(s.rowIcons()[1].classList.contains("on"), "row #2 icon lit");
  assert.strictEqual(s.rowIcons()[1].getAttribute("aria-pressed"), "true");
  assert.ok(!s.rowIcons()[0].classList.contains("on") && !s.rowIcons()[2].classList.contains("on"));
  assert.ok(!s.rowBells()[1].classList.contains("on"), "row #2 bell still off");
  // stale echo before the ack is held; ack applies the server copy
  s.AE().onProfiles({ type: "profiles", autoEngagePasses: [] });
  assert.ok(s.rowIcons()[1].classList.contains("on"), "stale echo ignored");
  s.AE().onProfiles({ type: "profiles", autoEngagePasses: m[0].passes });
  s.AE().onAck(m[0].seq);
  s.tick();
  assert.ok(s.rowIcons()[1].classList.contains("on"), "still lit after the ack");
  s.click(s.rowIcons()[1]);
  assert.strictEqual(s.AE().getMarks().length, 0, "second click clears");
  s.tick();
  assert.ok(!s.rowIcons()[1].classList.contains("on"));
});

test("bell click does not mark; another browser's mark lights the icon", () => {
  const s = sandbox();
  s.state("ISS", [P1, P2]);
  s.click(s.rowBells()[0]);
  assert.strictEqual(s.PA().getAlerts().passes.length, 1);
  assert.strictEqual(s.AE().getMarks().length, 0);
  assert.strictEqual(s.engageSet().length, 0);
  s.tick();
  assert.ok(!s.rowIcons()[0].classList.contains("on"));
  s.AE().onProfiles({ type: "profiles", autoEngagePasses: [{ key: "ISS", aosMs: ms(P1.aos) + 20000 }] });
  s.tick();
  assert.ok(s.rowIcons()[0].classList.contains("on"), "matched within the AOS tolerance");
  assert.ok(s.rowBells()[0].classList.contains("on"), "bell keeps its own state");
});

test("no icon for the Moon; icons follow a sat change", () => {
  const s = sandbox();
  s.state("MOON", [P1, P2]);
  assert.ok(s.rowIcons().every((x) => !x), "no Moon icon");
  assert.ok(s.rowBells().every(Boolean), "bells still there");
  s.state("SO-50", [P2, P3]);
  assert.ok(s.rowIcons().every(Boolean));
  assert.strictEqual(s.rowIcons()[0].dataset.sat, "SO-50");
  assert.strictEqual(Number(s.rowIcons()[0].dataset.aos), ms(P2.aos));
});

test("Preview banner icon: next to the bell, targets the previewed pass, lights its row", () => {
  const s = sandbox();
  s.state("ISS", [P1, P2, P3]);
  s.pp().set(NOW);
  s.tick();
  const b = s.bannerIcon();
  assert.ok(b, "banner icon");
  assert.strictEqual(b.hidden, false);
  const kids = s.badge().children;
  assert.strictEqual(kids.indexOf(b), kids.indexOf(s.bannerBell()) + 1, "right after the bell");
  assert.strictEqual(b.dataset.sat, "ISS");
  assert.strictEqual(Number(b.dataset.aos), ms(P1.aos));
  assert.strictEqual(b.title, "Auto engage Radio + Antenna for this pass (AOS 10:19 MT) \u2014 click to arm");
  s.click(b);
  s.tick();
  assert.ok(s.bannerIcon().classList.contains("on"), "banner icon lit");
  assert.ok(s.rowIcons()[0].classList.contains("on"), "row #1 lit");
  assert.ok(!s.bannerBell().classList.contains("on"), "banner bell untouched");
  assert.strictEqual(s.PA().getAlerts().passes.length, 0);
  s.click(s.rowIcons()[0]);
  s.tick();
  assert.ok(!s.bannerIcon().classList.contains("on"), "cleared from the row");
});

/* ---------------- v2: top bar icon + yellow / dim / skipped / green states ---------------- */

const look = (e) => ["on", "inherited", "skipped", "active"].filter((c) => e.classList.contains(c)).join(" ") || "off";

test("top bar icon: selected sat's next pass (row #1), same node across refreshes, kept in sync both ways", () => {
  const s = sandbox();
  s.state("ISS", [P1, P2, P3]);
  s.tick();
  const top = s.topIcon;
  assert.strictEqual(top.hidden, false);
  assert.strictEqual(top.dataset.sat, "ISS");
  assert.strictEqual(Number(top.dataset.aos), ms(P1.aos), "row #1 pass");
  assert.strictEqual(top.title, "Auto engage Radio + Antenna for ISS's next pass (AOS 10:19 MT) \u2014 click to arm");
  // refresh + state jitter: same node, same pass
  s.state("ISS", [Object.assign({}, P1, { aos: iso(ms(P1.aos) + 900) }), P2, P3]);
  s.tick();
  assert.strictEqual(s.topIcon, top);
  assert.strictEqual(Number(top.dataset.aos), ms(P1.aos), "frozen AOS (same as row #1)");
  // top -> row #1
  s.click(top);
  s.tick();
  assert.strictEqual(look(top), "on");
  assert.strictEqual(look(s.rowIcons()[0]), "on", "row #1 lit");
  assert.strictEqual(look(s.rowIcons()[1]), "off");
  assert.strictEqual(top.title, "Armed: Radio + Antenna on at 10:14 MT (AOS\u22125), off after LOS \u2014 click to disarm this pass");
  // row #1 -> top
  s.click(s.rowIcons()[0]);
  s.tick();
  assert.strictEqual(look(top), "off");
  // banner -> top
  s.pp().set(NOW);
  s.tick();
  s.click(s.bannerIcon());
  s.tick();
  assert.strictEqual(look(top), "on", "banner click lights the top bar");
  assert.strictEqual(s.PA().getAlerts().passes.length, 0, "bells untouched");
});

test("top bar icon: current pass while in progress; hidden for the Moon / no pass", () => {
  const s = sandbox();
  const running = { aos: iso(NOW - 2 * MIN), los: iso(NOW + 6 * MIN) };
  s.state("ISS", [running, P1]);
  s.tick();
  assert.strictEqual(Number(s.topIcon.dataset.aos), ms(running.aos), "pass in progress");
  s.setClock(NOW + 7 * MIN);
  s.tick();
  assert.strictEqual(Number(s.topIcon.dataset.aos), ms(P1.aos), "after LOS -> next pass");
  vm.runInContext("currentSatKey = 'MOON'", s.sb);
  s.state("MOON", [P1]);
  s.tick();
  assert.strictEqual(s.topIcon.hidden, true, "no icon for the Moon");
  vm.runInContext("currentSatKey = 'SO-50'", s.sb);
  s.state("SO-50", []);
  s.tick();
  assert.strictEqual(s.topIcon.hidden, true, "no pass");
});

test("button on: dim yellow everywhere; click skips just that pass (grey), again un-skips", () => {
  const s = sandbox();
  s.state("ISS", [P1, P2, P3]);
  s.AE().onProfiles({ type: "profiles", autoEngage: true, autoEngagePasses: [], autoEngageSkips: [] });
  s.tick();
  assert.ok(s.rowIcons().every((e) => look(e) === "inherited"), "rows dim yellow");
  assert.strictEqual(look(s.topIcon), "inherited", "top bar dim yellow");
  assert.strictEqual(s.topIcon.title, "Armed by the Auto Engage button (every pass of ISS): on at 10:14 MT, off after LOS \u2014 click to skip this pass");
  s.click(s.topIcon);
  s.tick();
  const m = s.engageSet().pop();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(m.skips)), [{ key: "ISS", aosMs: ms(P1.aos), losMs: ms(P1.los) }], "skip saved");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(m.passes)), []);
  assert.strictEqual(look(s.topIcon), "skipped");
  assert.strictEqual(look(s.rowIcons()[0]), "skipped", "row #1 skipped too");
  assert.strictEqual(look(s.rowIcons()[1]), "inherited", "row #2 still covered");
  assert.ok(/^Skipped: the Auto Engage button won't engage this pass/.test(s.rowIcons()[0].title));
  assert.strictEqual(s.rowIcons()[0].getAttribute("aria-pressed"), "false");
  s.click(s.rowIcons()[0]);
  s.tick();
  assert.strictEqual(look(s.topIcon), "inherited", "un-skipped");
  assert.deepStrictEqual(s.engageSet().pop().skips, []);
  // a marked pass under the button shows bright yellow; click -> skipped (mark dropped)
  s.click(s.rowIcons()[1]); // covered -> skip
  s.click(s.rowIcons()[1]); // skipped -> un-skip
  s.AE().onAck(s.engageSet().pop().seq); // server acked: its echoes apply again
  s.AE().onProfiles({ type: "profiles", autoEngage: true, autoEngagePasses: [{ key: "ISS", aosMs: ms(P2.aos) }], autoEngageSkips: [] });
  s.tick();
  assert.strictEqual(look(s.rowIcons()[1]), "on", "marked wins over covered");
  // button off -> covered passes go grey, marks stay
  s.engageState({ on: false, engaged: null });
  s.tick();
  assert.strictEqual(look(s.rowIcons()[0]), "off");
});

test("engaged now: green on the top bar, row and banner for that pass only", () => {
  const s = sandbox();
  const running = { aos: iso(NOW - 2 * MIN), los: iso(NOW + 6 * MIN) };
  s.state("ISS", [running, P1]);
  s.engageState({ on: true, engaged: { sat: "ISS", aosMs: ms(running.aos) + 20000, losMs: ms(running.los), radio: true, antenna: true } });
  s.tick();
  assert.strictEqual(look(s.topIcon), "active");
  assert.strictEqual(look(s.rowIcons()[0]), "active");
  assert.strictEqual(look(s.rowIcons()[1]), "inherited");
  assert.strictEqual(s.topIcon.title, "Active: Auto Engage turned on Radio + Antenna for this pass (LOS 09:16 MT) \u2014 off after LOS; click to disarm (leaves them on)");
  s.pp().set(NOW);
  s.tick();
  assert.strictEqual(look(s.bannerIcon()), "active", "banner green");
  // disengaged -> back to dim yellow
  s.engageState({ on: true, engaged: null });
  assert.strictEqual(look(s.topIcon), "inherited");
});
