// Pass alert bell in the map's yellow "Preview" banner (js/pass-preview.js):
// it is the very same single-pass alert as that pass's Next Passes bell
// (js/pass-alerts.js data-alert="pass", "alerts-set" + js/set-guard.js seq),
// for the selected sat's pass containing the preview time, else the next pass
// after it (js/pass-alerts-core.js passForPreview). Real set-guard.js,
// pass-alerts-core.js, pass-alerts.js, pass-panel.js and pass-preview.js run in
// one vm context with a tiny fake DOM.
// Run: node --test --test-force-exit test/preview-pass-alarm.test.js
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const C = require("../js/pass-alerts-core");

const MIN = 60 * 1000;
const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
const iso = (t) => new Date(t).toISOString();
// Next Passes list shape (server findPasses, rotor min-EL cutoff): ISO aos/los.
const P1 = { aos: iso(NOW + 60 * MIN), los: iso(NOW + 70 * MIN), maxEl: 30 };
const P2 = { aos: iso(NOW + 160 * MIN), los: iso(NOW + 171 * MIN), maxEl: 62 };
const P3 = { aos: iso(NOW + 260 * MIN), los: iso(NOW + 268 * MIN), maxEl: 12 };
const ms = (s) => new Date(s).getTime();

/* ---------------- which pass ---------------- */

test("passForPreview: pass containing the preview time (AOS/LOS inclusive)", () => {
  const list = [P1, P2, P3];
  assert.deepStrictEqual(C.passForPreview(list, NOW + 65 * MIN, NOW), { aosMs: ms(P1.aos), losMs: ms(P1.los) });
  assert.strictEqual(C.passForPreview(list, ms(P2.aos), NOW).aosMs, ms(P2.aos), "at AOS");
  assert.strictEqual(C.passForPreview(list, ms(P2.los), NOW).aosMs, ms(P2.aos), "at LOS");
});

test("passForPreview: below the cutoff at the preview time -> next pass after it", () => {
  const list = [P1, P2, P3];
  assert.strictEqual(C.passForPreview(list, NOW + 30 * MIN, NOW).aosMs, ms(P1.aos));
  assert.strictEqual(C.passForPreview(list, NOW + 100 * MIN, NOW).aosMs, ms(P2.aos));
  assert.strictEqual(C.passForPreview(list, ms(P1.los) + 1000, NOW).aosMs, ms(P2.aos), "just after LOS");
  // unsorted input / ms fields work too
  const mixed = [{ aosMs: ms(P3.aos), losMs: ms(P3.los) }, P2, P1];
  assert.strictEqual(C.passForPreview(mixed, NOW + 200 * MIN, NOW).aosMs, ms(P3.aos));
});

test("passForPreview: no pass -> null (after the list, empty, bad input)", () => {
  assert.strictEqual(C.passForPreview([P1, P2, P3], NOW + 300 * MIN, NOW), null, "beyond the last listed pass");
  assert.strictEqual(C.passForPreview([], NOW + 10 * MIN, NOW), null);
  assert.strictEqual(C.passForPreview(null, NOW + 10 * MIN, NOW), null);
  assert.strictEqual(C.passForPreview([P1], NaN, NOW), null);
  assert.strictEqual(C.passForPreview([{ aos: "nope" }], NOW, NOW), null);
});

test("passForPreview: past preview time", () => {
  // In a pass that is still running now -> that pass.
  const running = { aos: iso(NOW - 5 * MIN), los: iso(NOW + 5 * MIN) };
  assert.strictEqual(C.passForPreview([running, P1], NOW - 2 * MIN, NOW).aosMs, ms(running.aos));
  // Past and between passes (incl. Preview "now", which trails the clock):
  // counts as now -> the next upcoming pass (Next Passes row #1), not "no bell".
  assert.strictEqual(C.passForPreview([P1, P2], NOW - 60 * MIN, NOW).aosMs, ms(P1.aos));
});

/* ---------------- banner bell <-> Next Passes bell ---------------- */

function el(tag) {
  const attrs = {};
  const cls = new Set();
  const ls = {};
  const e = {
    tagName: String(tag).toUpperCase(), children: [], parent: null, style: {}, hidden: false, title: "", textContent: "",
    _html: "", firstElementChild: null,
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); this.firstElementChild = v ? {} : null; },
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
    appendChild(c) { c.parent = e; e.children.push(c); return c; },
    addEventListener(t, fn) { (ls[t] = ls[t] || []).push(fn); },
    removeEventListener() {},
    querySelector: () => null,
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
    __ls: ls,
  };
  return e;
}

function sandbox() {
  const intervals = [];
  const store = {};
  const sess = {};
  const sent = [];
  const docLs = { capture: {}, bubble: {} };
  const body = el("body");
  const host = el("div");
  body.appendChild(host);
  const passBody = el("div"); // Next Passes rows
  body.appendChild(passBody);
  const sb = {
    console, Math, JSON, Number, String, Array, Object, Set, Map, Promise, Proxy, Infinity, isFinite,
    Date: class extends Date { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, clearInterval() {},
    setTimeout: (fn) => { if (typeof fn === "function") fn(); return 0; }, clearTimeout() {},
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => (store[k] = String(v)) },
    sessionStorage: { getItem: (k) => (k in sess ? sess[k] : null), setItem: (k, v) => (sess[k] = String(v)) },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    formatClockShort: (t) => new Date(t).toISOString().slice(11, 16) + " UTC",
    ws: { readyState: 1, send: (d) => sent.push(JSON.parse(d)), addEventListener() {} },
    loadFavorites: () => [],
  };
  sb.document = {
    readyState: "complete", body,
    getElementById: (id) => (id === "map" ? host : null),
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
  vm.runInContext("var currentSatKey = 'ISS';", sb);
  const state = (sat, passes) => vm.runInContext("updatePassPanelFromState", sb)({ type: "state", sat, display: sat, passes });
  // Next Passes row bells as js/pass-panel.js renders them (data-sat/aos/los from lastPassList).
  const rows = () => {
    passBody.children = [];
    const list = vm.runInContext("lastPassList", sb);
    const sat = vm.runInContext("lastPassListSat", sb);
    return list.map((p) => {
      const b = el("button");
      b.className = "sat-alert";
      b.setAttribute("data-alert", "pass");
      b.setAttribute("data-sat", sat);
      b.setAttribute("data-aos", String(ms(p.aos)));
      b.setAttribute("data-los", String(ms(p.los)));
      passBody.appendChild(b);
      return b;
    });
  };
  const badge = () => host.children.find((c) => c.classList.contains("pass-preview-badge"));
  const bell = () => badge().children.find((c) => c.classList.contains("ppb-alert"));
  const click = (target) => {
    const e = { target, stopped: false, preventDefault() {}, stopPropagation() { this.stopped = true; } };
    for (const fn of docLs.capture.click || []) fn(e);
    return e;
  };
  const tick = () => intervals.filter((x) => x.ms === 1000).forEach((x) => x.fn());
  return { sb, sent, state, rows, badge, bell, click, tick, pp: () => sb.passPreview, PA: () => sb.PassAlerts };
}

test("banner bell sits before Back to now; picks the containing / next pass; hidden without one", () => {
  const s = sandbox();
  s.state("ISS", [P1, P2, P3]);
  s.pp().set(NOW + 65 * MIN); // inside P1
  const kids = s.badge().children;
  assert.ok(kids[1].classList.contains("ppb-alert") && kids[2].classList.contains("ppb-back"), "bell before Back to now");
  const b = s.bell();
  assert.strictEqual(b.hidden, false);
  assert.strictEqual(b.dataset.alert, "pass");
  assert.strictEqual(b.dataset.sat, "ISS");
  assert.strictEqual(Number(b.dataset.aos), ms(P1.aos));
  assert.strictEqual(Number(b.dataset.los), ms(P1.los));
  assert.strictEqual(b.title, "Alert for this pass (AOS 13:00 UTC)");
  assert.ok(!b.classList.contains("on"), "off by default");

  s.pp().set(NOW + 100 * MIN); // below horizon -> next pass
  assert.strictEqual(Number(s.bell().dataset.aos), ms(P2.aos));
  assert.strictEqual(s.bell().title, "Alert for this pass (AOS 14:40 UTC)");

  s.pp().set(NOW + 400 * MIN); // beyond the listed passes
  assert.strictEqual(s.bell().hidden, true, "no pass -> hidden");

  s.pp().set(NOW + 65 * MIN);
  vm.runInContext("currentSatKey = 'SO-50';", s.sb); // list still for ISS until the state arrives
  s.tick();
  assert.strictEqual(s.bell().hidden, true, "pass list of another sat -> hidden");
  s.state("SO-50", [P3]);
  s.tick();
  assert.strictEqual(s.bell().hidden, false);
  assert.strictEqual(s.bell().dataset.sat, "SO-50");
  assert.strictEqual(Number(s.bell().dataset.aos), ms(P3.aos));
});

test("toggling the banner bell sets the same single-pass alert as the Next Passes row (both ways)", () => {
  const s = sandbox();
  s.state("ISS", [P1, P2, P3]);
  const rows = s.rows();
  s.pp().set(NOW + 100 * MIN); // P2 is the previewed pass
  const e = s.click(s.bell());
  assert.ok(e.stopped, "handled by js/pass-alerts.js in the capture phase");
  const a = JSON.parse(JSON.stringify(s.PA().getAlerts()));
  assert.deepStrictEqual(a.passes, [{ key: "ISS", aosMs: ms(P2.aos), losMs: ms(P2.los) }], "single-pass alert stored");
  assert.deepStrictEqual(a.sats, [], "not a sat alert");
  const m = s.sent.filter((x) => x.type === "alerts-set");
  assert.strictEqual(m.length, 1, "same server message");
  assert.ok(Number.isFinite(m[0].seq), "set-guard seq");
  assert.ok(s.bell().classList.contains("on"), "banner bell lit");
  assert.ok(rows[1].classList.contains("on"), "matching Next Passes row lit");
  assert.ok(!rows[0].classList.contains("on") && !rows[2].classList.contains("on"), "other rows untouched");
  assert.strictEqual(s.bell().title, "Alert on for this pass (AOS 14:40 UTC) \u2014 click to clear");

  // Row bell clears it -> banner bell off.
  s.click(rows[1]);
  assert.strictEqual(s.PA().getAlerts().passes.length, 0);
  assert.ok(!s.bell().classList.contains("on"));
  // Row bell sets it -> banner bell on.
  s.click(rows[1]);
  assert.ok(s.bell().classList.contains("on"));
  // Banner bell clears it -> row off.
  s.click(s.bell());
  assert.ok(!rows[1].classList.contains("on"));
  assert.strictEqual(s.sent.filter((x) => x.type === "alerts-set").length, 4);
});

test("another browser's change (server profiles) lights the banner bell; stale echo held by the set-guard", () => {
  const s = sandbox();
  s.state("ISS", [P1, P2, P3]);
  s.pp().set(NOW + 65 * MIN); // P1
  // Another client armed P1 (AOS jittered by the server recompute).
  s.PA().onProfiles({ type: "profiles", alerts: { sats: [], passes: [{ key: "ISS", aosMs: ms(P1.aos) + 20000 }] } });
  assert.ok(s.bell().classList.contains("on"), "server state -> banner bell on");
  // Clear from the banner; a stale echo (still armed) arrives before the ack.
  s.click(s.bell());
  const seq = s.sent.filter((x) => x.type === "alerts-set").pop().seq;
  s.PA().onProfiles({ type: "profiles", alerts: { sats: [], passes: [{ key: "ISS", aosMs: ms(P1.aos) }] } });
  assert.ok(!s.bell().classList.contains("on"), "stale echo ignored while un-acked");
  s.PA().onProfiles({ type: "profiles", alerts: { sats: [], passes: [] } });
  s.PA().onAck(seq);
  assert.ok(!s.bell().classList.contains("on"), "stays off after the ack");
});

test("sat alert on: banner bell shows inherited and skips just this pass (exception)", () => {
  const s = sandbox();
  s.state("ISS", [P1, P2]);
  s.pp().set(NOW + 65 * MIN);
  s.PA().onProfiles({ type: "profiles", alerts: { sats: ["ISS"] } });
  assert.ok(s.bell().classList.contains("inherited"));
  s.click(s.bell());
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s.PA().getAlerts().passExceptions)), [{ key: "ISS", aosMs: ms(P1.aos), losMs: ms(P1.los) }]);
  assert.ok(!s.bell().classList.contains("inherited") && !s.bell().classList.contains("on"));
});

test("Back to now hides the banner; alerts untouched", () => {
  const s = sandbox();
  s.state("ISS", [P1]);
  s.pp().set(NOW + 30 * MIN);
  s.click(s.bell());
  s.pp().clear();
  assert.strictEqual(s.badge().hidden, true);
  assert.strictEqual(s.PA().getAlerts().passes.length, 1, "the alert stays set");
});
