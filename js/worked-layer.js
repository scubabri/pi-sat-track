/**
 * Worked stations layer: QSOs logged from this app (server "worked" list,
 * ~/.rpitrack/worked.json via lib/worked.js; shared by every browser) drawn at
 * their grid on the map, and on the 3D globe via window.workedLayer +
 * the "worked-layer-change" event. One marker per callsign (latest QSO);
 * hover shows call, grid and each QSO's UTC date / time, satellite, band, mode.
 *
 * Buttons in the map button stack (after Clear Spots): "Worked" on/off
 * (localStorage "workedLayerOn", default on) and "Clear Worked" (asks first;
 * clears the server list for every browser). Logging to ADIF / UDP is not
 * affected by either.
 */
(function () {
  const LS_KEY = "workedLayerOn";
  const COLOR = "#bc8cff";
  let on = localStorage.getItem(LS_KEY) !== "0";
  let items = [];
  let layer = null;
  let btn = null;
  let clr = null;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const getMap = () => (typeof map !== "undefined" && map ? map : null);

  function utc(t) {
    const d = new Date(t);
    return d.toISOString().slice(0, 10) + " " + d.toISOString().slice(11, 16) + " UTC";
  }
  function qsoLine(q) {
    return [utc(q.time), q.sat, q.band, q.mode].filter(Boolean).join(" · ");
  }
  /** One entry per call with a grid: latest QSO's position, all its QSOs (newest first). */
  function grouped() {
    const by = new Map();
    for (const q of items) {
      if (!Number.isFinite(q.lat) || !Number.isFinite(q.lon)) continue;
      let g = by.get(q.call);
      if (!g) { g = { call: q.call, qsos: [] }; by.set(q.call, g); }
      g.qsos.push(q);
    }
    const out = [];
    for (const g of by.values()) {
      g.qsos.sort((a, b) => b.time - a.time);
      const last = g.qsos[0];
      out.push({
        call: g.call, grid: last.grid, lat: last.lat, lon: last.lon, time: last.time, count: g.qsos.length,
        tip: g.call + " " + last.grid + "\n" + g.qsos.slice(0, 5).map(qsoLine).join("\n") + (g.qsos.length > 5 ? "\n+" + (g.qsos.length - 5) + " more" : ""),
      });
    }
    return out.sort((a, b) => b.time - a.time);
  }
  function visibleItems() {
    return on ? grouped() : [];
  }
  function notify() {
    try { document.dispatchEvent(new Event("worked-layer-change")); } catch (_) {}
  }
  function syncBtn() {
    if (btn) {
      btn.classList.toggle("active", on);
      btn.classList.toggle("worked-on", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.title = (on ? "Hide" : "Show") + " worked stations (QSOs logged from this app, " + items.length + " saved)";
    }
    if (clr) {
      clr.hidden = !on;
      clr.title = "Clear the worked-stations list (" + items.length + " QSOs) for every browser. ADIF / UDP logs are not touched.";
    }
  }
  function render() {
    const m = getMap();
    syncBtn();
    if (!m || typeof L === "undefined") return;
    if (!layer) layer = L.layerGroup();
    if (on && !m.hasLayer(layer)) layer.addTo(m);
    if (!on && m.hasLayer(layer)) m.removeLayer(layer);
    layer.clearLayers();
    if (!on) return;
    for (const g of grouped()) {
      const mk = L.circleMarker([g.lat, g.lon], {
        radius: 4, weight: 1.5, color: "#ffffff", fillColor: COLOR, fillOpacity: 0.9, opacity: 0.9, className: "worked-dot",
      });
      mk.bindTooltip(esc(g.tip).replace(/\n/g, "<br>"), { direction: "top", offset: [0, -4], className: "worked-tip" });
      mk.addTo(layer);
    }
  }
  function apply(msg) {
    items = Array.isArray(msg.items) ? msg.items : [];
    render();
    notify();
  }
  function setOn(v) {
    on = !!v;
    try { localStorage.setItem(LS_KEY, on ? "1" : "0"); } catch (_) {}
    render();
    notify();
  }
  function clearAll() {
    if (!items.length) return;
    if (typeof confirm === "function" && !confirm("Clear all " + items.length + " worked stations from the map and globe (all browsers)?\nYour ADIF / UDP logs are not affected.")) return;
    try {
      if (typeof ws !== "undefined" && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "worked-clear" }));
    } catch (_) {}
  }
  function addButtons() {
    const bar = document.querySelector(".decode-toggle-control");
    const spots = bar && bar.querySelector(".decode-clear-btn");
    if (!bar || !spots) return false;
    if (btn && bar.contains(btn)) return true;
    btn = document.createElement("a");
    btn.href = "#";
    btn.className = "decode-toggle-btn worked-btn";
    btn.setAttribute("role", "button");
    btn.textContent = "Worked";
    btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); setOn(!on); });
    clr = document.createElement("a");
    clr.href = "#";
    clr.className = "decode-clear-btn worked-clear-btn";
    clr.setAttribute("role", "button");
    clr.textContent = "Clear Worked";
    clr.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); clearAll(); });
    // Directly after Clear Spots (the APRS button inserts itself there later, above these).
    spots.after(btn, clr);
    ["dblclick", "mousedown", "wheel", "touchstart", "pointerdown"].forEach((ev) => {
      btn.addEventListener(ev, (e) => e.stopPropagation());
      clr.addEventListener(ev, (e) => e.stopPropagation());
    });
    syncBtn();
    return true;
  }
  window.applyWorkedLayer = apply;
  window.workedLayer = { isOn: () => on, setOn, items: visibleItems, all: () => items.slice(), color: COLOR };

  function patchWs() {
    if (typeof ws === "undefined" || !ws || ws.__workedPatched) return;
    ws.__workedPatched = true;
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string" || ev.data.indexOf('"worked"') < 0) return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "worked") apply(msg);
      } catch (_) {}
    });
    const ask = () => { try { ws.send(JSON.stringify({ type: "worked-get" })); } catch (_) {} };
    if (ws.readyState === 1) ask();
    else ws.addEventListener("open", ask);
  }
  function init() {
    setInterval(patchWs, 500);
    const t = setInterval(() => { if (addButtons()) { clearInterval(t); render(); } }, 300);
  }
  if (typeof document !== "undefined" && document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
