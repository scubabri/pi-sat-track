// Regression: single-pass alert bells (Next Passes rows + Preview banner).
//  1. Row bells did nothing: js/pass-panel.js rebuilt every row (innerHTML)
//     on the 1 s countdown and on every "state" message, so the bell under the
//     pointer was replaced between pointerdown and pointerup and the browser
//     fired no click. Rows (and their bells) are now updated in place.
//  2. Preview banner bell missing at Preview "now" with the sat below the
//     horizon: the preview time trails the wall clock, and a past time between
//     passes returned no pass. It now targets the next upcoming pass (row #1).
// Real set-guard.js, pass-alerts-core.js, pass-alerts.js, pass-panel.js and
// pass-preview.js run in one vm context with a small fake DOM.
// Run: node --test --test-force-exit test/pass-alert-row-bell.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const C = require("../js/pass-alerts-core");

const MIN = 60 * 1000;
const NOW = Date.UTC(2026, 9, 24, 15, 10, 0); // 09:10 MT
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
  for (const f of ["set-guard.js", "pass-alerts-core.js", "pass-alerts.js", "pass-panel.js", "pass-preview.js"]) {
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
  return { sb, sent, alertsSet, state, rowBells, passBody, badge, bannerBell, click, tick, body, dings,
    setClock: (t) => { clock = t; }, pp: () => sb.passPreview, PA: () => sb.PassAlerts };
}

/* ---------------- Bug 1: Next Passes row bells ---------------- */

test("row bells survive the 1 s refresh and state messages (same DOM node; click not swallowed)", () => {
  const s = sandbox();
  s.state("ISS", [P1, P2, P3]);
  const before = s.rowBells();
  const rowsBefore = s.passBody.children.slice();
  assert.strictEqual(before.length, 3);
  assert.ok(before.every(Boolean), "a bell on every row");
  // Countdown refresh + new state (server AOS jitter of a few s) while the pointer is down.
  s.tick();
  s.state("ISS", [
    Object.assign({}, P1, { aos: iso(ms(P1.aos) + 900) }),
    Object.assign({}, P2, { aos: iso(ms(P2.aos) - 700) }),
    P3,
  ]);
  s.tick();
  const after = s.rowBells();
  after.forEach((b, i) => assert.strictEqual(b, before[i], "row " + (i + 1) + " bell is the same element"));
  s.passBody.children.forEach((r, i) => assert.strictEqual(r, rowsBefore[i], "row " + (i + 1) + " is the same element"));
  assert.ok(after.every((b) => b.isConnected), "still in the document");
  // Frozen AOS kept on the bell (pass id = sat + AOS; matches the stored alert).
  assert.strictEqual(Number(after[0].dataset.aos), ms(P1.aos));
  assert.strictEqual(Number(after[0].dataset.los), ms(P1.los));
  assert.strictEqual(after[0].dataset.sat, "ISS");
  assert.strictEqual(s.passBody.children[0].__passCells.aos.textContent, "10:19:40 MT");
});

test("row bell click toggles the single-pass alert and lights; second click turns it off", () => {
  const s = sandbox();
  s.state("ISS", [P1, P2, P3]);
  const bell = s.rowBells()[1];
  s.tick(); // a refresh between render and click
  const e = s.click(bell);
  assert.ok(e.stopped, "handled in the capture phase");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s.PA().getAlerts().passes)), [{ key: "ISS", aosMs: ms(P2.aos), losMs: ms(P2.los) }]);
  const m = s.alertsSet();
  assert.strictEqual(m.length, 1);
  assert.ok(Number.isFinite(m[0].seq), "set-guard seq");
  s.tick();
  s.state("ISS", [P1, P2, P3]);
  assert.ok(s.rowBells()[1].classList.contains("on"), "row #2 bell lit after refreshes");
  assert.ok(!s.rowBells()[0].classList.contains("on") && !s.rowBells()[2].classList.contains("on"));
  assert.strictEqual(s.rowBells()[1].getAttribute("aria-pressed"), "true");
  // Server echo + ack keep it on.
  s.PA().onProfiles({ type: "profiles", alerts: m[0].alerts });
  s.PA().onAck(m[0].seq);
  s.tick();
  assert.ok(s.rowBells()[1].classList.contains("on"), "still lit after the server ack");
  // Second click: off.
  s.click(s.rowBells()[1]);
  assert.strictEqual(s.PA().getAlerts().passes.length, 0);
  s.tick();
  assert.ok(!s.rowBells()[1].classList.contains("on"), "row #2 bell off");
});

test("sat alert on: row bells inherited; click skips just that pass; sat bell unaffected", () => {
  const s = sandbox();
  s.state("ISS", [P1, P2, P3]);
  s.PA().onProfiles({ type: "profiles", alerts: { sats: ["ISS"] } });
  s.tick();
  assert.ok(s.rowBells().every((b) => b.classList.contains("inherited")), "dim yellow on every row");
  s.click(s.rowBells()[0]);
  const a = JSON.parse(JSON.stringify(s.PA().getAlerts()));
  assert.deepStrictEqual(a.sats, ["ISS"], "sat alert kept");
  assert.deepStrictEqual(a.passExceptions, [{ key: "ISS", aosMs: ms(P1.aos), losMs: ms(P1.los) }]);
  s.tick();
  assert.ok(!s.rowBells()[0].classList.contains("inherited") && !s.rowBells()[0].classList.contains("on"), "row #1 skipped");
  assert.ok(s.rowBells()[1].classList.contains("inherited"), "row #2 still inherited");
  s.click(s.rowBells()[0]);
  assert.strictEqual(s.PA().getAlerts().passExceptions.length, 0, "un-skip");
});

test("empty list -> note; passes again -> rows with bells", () => {
  const s = sandbox();
  s.state("ISS", []);
  assert.strictEqual(s.passBody.children.length, 1);
  assert.ok(s.passBody.children[0].classList.contains("pass-panel-empty"));
  s.state("ISS", [P1]);
  assert.strictEqual(s.passBody.children.length, 1);
  assert.ok(s.rowBells()[0]);
  s.state("SO-50", [P2, P3]);
  assert.strictEqual(s.rowBells().length, 2);
  assert.strictEqual(s.rowBells()[0].dataset.sat, "SO-50");
  assert.strictEqual(Number(s.rowBells()[0].dataset.aos), ms(P2.aos));
});

test("single-pass alert from a row fires AOS-5 and AOS (toast + ding)", () => {
  const s = sandbox();
  const logs = [];
  s.sb.console.log = (...a) => logs.push(a.join(" "));
  s.state("ISS", [P1, P2]);
  s.click(s.rowBells()[0]);
  s.PA().onState({ type: "state", sat: "ISS", display: "ISS", passes: [P1, P2] });
  const pre = s.PA().checkDue(ms(P1.aos) - 5 * MIN + 1000);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(pre.map((x) => x.kind))), ["pre5"]);
  const aos = s.PA().checkDue(ms(P1.aos) + 1000);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(aos.map((x) => x.kind))), ["aos"]);
  assert.strictEqual(s.PA().checkDue(ms(P1.aos) + 2000).length, 0, "fires once");
  const toasts = s.body.children.find((c) => c.id === "pass-alert-toasts");
  assert.ok(toasts && toasts.children.length >= 1, "toast shown");
  assert.ok(logs.some((l) => /Pass alert: ISS AOS in 5 min/.test(l)) && logs.some((l) => /Pass alert: ISS AOS now/.test(l)));
});

/* ---------------- Bug 2: Preview banner bell at "now" ---------------- */

test("passForPreview: preview at / just before now, below horizon -> next pass", () => {
  const list = [P1, P2, P3];
  assert.strictEqual(C.passForPreview(list, NOW, NOW).aosMs, ms(P1.aos), "t == now");
  assert.strictEqual(C.passForPreview(list, NOW - 5000, NOW).aosMs, ms(P1.aos), "a few s behind now");
  assert.strictEqual(C.passForPreview(list, NOW - 3 * MIN, NOW).aosMs, ms(P1.aos), "minutes behind now");
  // Pass running now, preview a bit earlier (before its AOS) -> the running pass.
  const running = { aos: iso(NOW - 2 * MIN), los: iso(NOW + 8 * MIN) };
  assert.strictEqual(C.passForPreview([running, P1], NOW - 10 * MIN, NOW).aosMs, ms(running.aos));
});

test("banner bell visible at Preview now with ISS below horizon; targets and lights row #1", () => {
  const s = sandbox();
  s.state("ISS", [P1, P2, P3]);
  s.pp().set(NOW); // "Preview 09:10 MT now"
  s.setClock(NOW + 4000); // wall clock moves on
  s.tick();
  const b = s.bannerBell();
  assert.strictEqual(b.hidden, false, "bell present");
  assert.strictEqual(b.dataset.sat, "ISS");
  assert.strictEqual(Number(b.dataset.aos), ms(P1.aos), "next pass = row #1");
  assert.strictEqual(b.title, "Alert for this pass (AOS 10:19 MT)");
  s.setClock(NOW + 3 * MIN);
  s.tick();
  assert.strictEqual(s.bannerBell().hidden, false, "still present minutes later");
  s.click(s.bannerBell());
  s.tick();
  assert.ok(s.bannerBell().classList.contains("on"), "banner bell lit");
  assert.ok(s.rowBells()[0].classList.contains("on"), "Next Passes row #1 lit");
  assert.ok(!s.rowBells()[1].classList.contains("on"));
  // Row #1 bell clears it -> banner off.
  s.click(s.rowBells()[0]);
  s.tick();
  assert.ok(!s.bannerBell().classList.contains("on"));
});
