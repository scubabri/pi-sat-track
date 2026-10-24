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
  const byId = { map: host, "pass-panel-body": passBody };
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
  return { sb, sent, alertsSet, engageSet, state, rowBells, rowIcons, passBody, badge, bannerBell, bannerIcon, click, tick, body, dings,
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
  assert.strictEqual(before[0].title, "Auto engage Radio + Antenna for this pass");
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
  assert.strictEqual(b.title, "Auto engage Radio + Antenna for this pass (AOS 10:19 MT)");
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
