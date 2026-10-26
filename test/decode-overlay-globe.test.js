// WSJT-X heard stations: the shared list js/decode-overlay.js exposes for the
// 3D globe (window.decodeOverlay) and the globe's "heard" htmlElements layer.
const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadOverlay(lsInit) {
  const ls = Object.assign({}, lsInit || {});
  const events = [];
  const ctx = {
    console,
    Date,
    Math,
    Number,
    JSON,
    Set,
    Map,
    String,
    Array,
    Event: class { constructor(t) { this.type = t; } },
    localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); } },
    document: { readyState: "complete", dispatchEvent: (e) => events.push(e.type), addEventListener() {} },
    setInterval: () => 0,
    clearInterval() {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/decode-overlay.js"), "utf8"), ctx);
  return { ctx, events };
}

const MIN = 60000;
function payload(now) {
  return {
    type: "wsjtx-decodes",
    expireMs: 15 * MIN,
    now,
    stations: [
      { call: "K1ABC", grid: "FN42", lat: 42.5, lon: -71, lastHeard: now - 1 * MIN, snr: -7, mode: "~" },
      { call: "JA1ABC", grid: "PM95", lat: 35.5, lon: 139, lastHeard: now - 10 * MIN, snr: 3, mode: "~" },
      { call: "OLD1", grid: "EN34", lat: 44.5, lon: -93, lastHeard: now - 16 * MIN },
    ],
  };
}

test("decodeOverlay.items: same stations, fading and expiry as the map", () => {
  const { ctx, events } = loadOverlay();
  const now = Date.now();
  ctx.applyDecodeOverlay(payload(now));
  assert.ok(events.includes("decode-overlay-change"), "globe is notified on new decodes");
  const items = ctx.decodeOverlay.items(now);
  assert.strictEqual(items.map((i) => i.call).join(","), "K1ABC,JA1ABC", "expired station dropped");
  const k = items[0];
  assert.strictEqual(k.grid, "FN42");
  assert.strictEqual(k.lat, 42.5);
  assert.strictEqual(k.lon, -71);
  assert.ok(Math.abs(k.opacity - (1 - 0.75 * (1 / 15))) < 1e-3, "opacity " + k.opacity);
  assert.ok(items[1].opacity < k.opacity, "older is fainter");
  assert.match(k.tip, /^K1ABC FN42 ~ -7 dB · 1 min ago$/);
  assert.match(items[1].tip, /\+3 dB · 10 min ago$/);
});

test("decodeOverlay.items is empty while the WSJT Heard toggle is off", () => {
  const { ctx } = loadOverlay({ decodeOverlayOn: "0" });
  const now = Date.now();
  ctx.applyDecodeOverlay(payload(now));
  assert.strictEqual(ctx.decodeOverlay.isOn(), false);
  assert.strictEqual(ctx.decodeOverlay.items(now).length, 0);
});

test("globe-view draws decodeOverlay stations as 'heard' html markers", () => {
  const src = fs.readFileSync(path.join(__dirname, "../js/globe-view.js"), "utf8");
  assert.match(src, /d\.kind === "heard"/, "heard marker kind rendered");
  assert.match(src, /heardItems\(\)\.concat\(/, "heard items included in htmlElementsData");
  assert.match(src, /addEventListener\("decode-overlay-change"/, "globe redraws on decode changes");
  const css = fs.readFileSync(path.join(__dirname, "../css/decode-overlay.css"), "utf8");
  assert.match(css, /\.globe-heard-dot/);
});

test("WSJT Heard button: 3 states off -> map -> list -> off, persisted; old on/off migrates", () => {
  assert.strictEqual(loadOverlay({}).ctx.decodeOverlay.mode(), "map", "default = map (old default on)");
  assert.strictEqual(loadOverlay({ decodeOverlayOn: "0" }).ctx.decodeOverlay.mode(), "off");
  const { ctx } = loadOverlay({ decodeOverlayMode: "list" });
  assert.strictEqual(ctx.decodeOverlay.mode(), "list");
  assert.strictEqual(ctx.decodeOverlay.isOn(), true, "list includes the map");
  ctx.decodeOverlay.setMode("off");
  assert.strictEqual(ctx.decodeOverlay.isOn(), false);
  assert.strictEqual(ctx.localStorage.getItem("decodeOverlayMode"), "off");
  assert.strictEqual(loadOverlay({ decodeOverlayMode: "off", decodeOverlayOn: "0" }).ctx.decodeOverlay.mode(), "off");
  const src = fs.readFileSync(path.join(__dirname, "../js/decode-overlay.js"), "utf8");
  assert.match(src, /MODES\[\(MODES\.indexOf\(mode\) \+ 1\) % MODES\.length\]/, "click cycles");
});
