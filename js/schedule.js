/**
 * Schedule Contact: mutual pass finder (server "schedule-lookup" / "schedule-find").
 * Button sits in the FT / ✕ decode control bar.
 */
(function () {
  let panel, backdrop, qEl, resEl, barEl, tbody, theadRow, findBtn, sortEl, footEl;
  let hours = 24;
  let sortBy = "best";
  let rows = [];
  let meta = null;
  let selIdx = -1;
  let mapLayer = null;
  let reqSeq = 0;
  let pendingFind = 0;
  let pendingLookup = 0;
  let lookupLabel = "";

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const GRID_RE = /^[A-R]{2}[0-9]{2}([A-X]{2})?$/i;
  function sock() { return typeof ws !== "undefined" && ws && ws.readyState === 1 ? ws : null; }
  function send(o) { const s = sock(); if (!s) return false; s.send(JSON.stringify(o)); return true; }
  function tzAbbr(d) {
    try { return new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName").value; } catch (_) { return ""; }
  }
  const p2 = (n) => String(n).padStart(2, "0");
  const hmL = (d) => p2(d.getHours()) + ":" + p2(d.getMinutes());
  const hmU = (d) => p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes());
  /** Actual local date, e.g. "Wed Oct 14 ". */
  function dayTag(d) {
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).replace(/,/g, "") + " ";
  }
  function dur(s) { const m = Math.floor(s / 60); return m + "m " + p2(s % 60) + "s"; }

  function build() {
    backdrop = document.createElement("div");
    backdrop.id = "sched-backdrop"; backdrop.hidden = true;
    panel = document.createElement("div");
    panel.id = "sched-panel"; panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.innerHTML =
      '<div class="sc-head"><h3>Sked Finder</h3><button class="sc-x" title="Close" aria-label="Close">\u2715</button></div>' +
      '<div class="sc-body"><div class="sc-row">' +
      '<div><label for="sched-q">Callsign or grid</label><input type="text" id="sched-q" placeholder="FN31 or W1AW" autocomplete="off" spellcheck="false"></div>' +
      '<div><label>Window</label><div class="sc-seg"><button data-h="24" class="on">24h</button><button data-h="48">48h</button></div></div>' +
      '<button class="sc-btn sc-primary" id="sched-find">Find</button></div>' +
      '<div class="sc-resolved" id="sched-res"></div>' +
      '<div class="sc-bar"><span id="sched-summary"></span><span class="sc-sort">Sort: <a data-sort="best">Best</a> · <a data-sort="start">Start time</a></span></div>' +
      '<table><thead><tr><th>Sat</th><th>Mode</th><th class="sortable" data-sort="start">Start – End</th><th class="sortable" data-sort="best">Duration</th><th>Max El me / them</th><th>Az @ mid me / them</th></tr></thead><tbody></tbody></table></div>' +
      '<div class="sc-foot"><span id="sched-foot"></span><span id="sched-tz"></span></div>';
    document.body.appendChild(backdrop);
    document.body.appendChild(panel);
    qEl = panel.querySelector("#sched-q");
    resEl = panel.querySelector("#sched-res");
    barEl = panel.querySelector("#sched-summary");
    tbody = panel.querySelector("tbody");
    theadRow = panel.querySelector("thead tr");
    findBtn = panel.querySelector("#sched-find");
    sortEl = panel.querySelector(".sc-sort");
    footEl = panel.querySelector("#sched-foot");
    panel.querySelector("#sched-tz").textContent = "Times local (" + tzAbbr(new Date()) + ") and UTC";
    panel.querySelector(".sc-x").addEventListener("click", close);
    backdrop.addEventListener("click", close);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) close(); });
    panel.querySelectorAll(".sc-seg button").forEach((b) => b.addEventListener("click", () => {
      hours = parseInt(b.dataset.h, 10);
      panel.querySelectorAll(".sc-seg button").forEach((x) => x.classList.toggle("on", x === b));
    }));
    panel.querySelectorAll("[data-sort]").forEach((a) => a.addEventListener("click", () => { sortBy = a.dataset.sort; render(); }));
    findBtn.addEventListener("click", onFind);
    qEl.addEventListener("keydown", (e) => { if (e.key === "Enter") onFind(); });
    // Typing a new query invalidates the resolved grid
    qEl.addEventListener("input", () => { lookupLabel = ""; setRes(""); });
  }

  function setRes(html, err) { resEl.innerHTML = html; resEl.classList.toggle("err", !!err); }

  function open() {
    if (!panel) build();
    panel.hidden = false; backdrop.hidden = false;
    setTimeout(() => qEl.focus(), 0);
  }
  function close() {
    if (!panel) return;
    panel.hidden = true; backdrop.hidden = true;
    clearMap();
  }

  function onFind() {
    clearMap();
    const q = qEl.value.trim();
    if (!q) { setRes("Enter a callsign or grid (e.g. FN31).", true); return; }
    if (GRID_RE.test(q)) {
      const g = q.length >= 6 ? q.slice(0, 4).toUpperCase() + q.slice(4).toLowerCase() : q.toUpperCase();
      lookupLabel = "grid";
      setRes("Grid <b>" + esc(g) + "</b>");
      return runFind(g);
    }
    pendingLookup = ++reqSeq;
    setRes("Looking up " + esc(q.toUpperCase()) + "…");
    findBtn.disabled = true;
    if (!send({ type: "schedule-lookup", query: q, reqId: pendingLookup })) { findBtn.disabled = false; setRes("Not connected to server.", true); }
  }

  function runFind(grid) {
    pendingFind = ++reqSeq;
    findBtn.disabled = true;
    rows = []; selIdx = -1; meta = null;
    barEl.textContent = "";
    tbody.innerHTML = '<tr><td colspan="6" class="sc-empty">Computing mutual windows for ' + esc(grid) + " (" + hours + "h)…</td></tr>";
    if (!send({ type: "schedule-find", grid, hours, reqId: pendingFind })) { findBtn.disabled = false; tbody.innerHTML = '<tr><td colspan="6" class="sc-empty">Not connected to server.</td></tr>'; }
  }

  function onLookup(msg) {
    if (msg.reqId !== pendingLookup) return;
    findBtn.disabled = false;
    if (!msg.ok) {
      setRes(esc(msg.error || "Lookup failed.") + " Enter a grid instead (e.g. FN31) and press Find.", true);
      qEl.focus(); qEl.select();
      return;
    }
    lookupLabel = "lookup";
    let via = "";
    if (msg.source === "g7vrd") {
      via = " via g7vrd";
      if (msg.ts) { const d = new Date(msg.ts); if (!isNaN(d)) via += " (last seen " + d.toISOString().slice(0, 10) + ")"; }
    }
    setRes(esc((msg.callsign || q0(msg)).toUpperCase()) + " \u2192 grid <b>" + esc(msg.grid) + "</b>" + esc(via));
    runFind(msg.grid);
  }

  function q0(msg) { return String(msg.query || qEl.value || "").trim(); }

  function onResult(msg) {
    if (msg.reqId !== pendingFind) return;
    findBtn.disabled = false;
    if (!msg.ok) { tbody.innerHTML = '<tr><td colspan="6" class="sc-empty">' + esc(msg.error) + "</td></tr>"; return; }
    meta = msg;
    rows = msg.rows || [];
    selIdx = -1;
    render();
  }

  function sorted() {
    const r = rows.slice();
    if (sortBy === "start") r.sort((a, b) => new Date(a.start) - new Date(b.start));
    else r.sort((a, b) => b.durationSec - a.durationSec || Math.min(b.maxElMe, b.maxElThem) - Math.min(a.maxElMe, a.maxElThem) || new Date(a.start) - new Date(b.start));
    return r;
  }

  function render() {
    if (!panel) return;
    // Sort control and header arrow always reflect the same state
    sortEl.querySelectorAll("a").forEach((a) => {
      const on = a.dataset.sort === sortBy;
      a.classList.toggle("on", on);
      a.textContent = (a.dataset.sort === "best" ? "Best" : "Start time") + (on ? (sortBy === "best" ? " \u25BE" : " \u25B4") : "");
    });
    theadRow.querySelectorAll("th.sortable").forEach((th) => {
      const on = th.dataset.sort === sortBy;
      th.classList.toggle("s", on);
      const base = th.dataset.sort === "start" ? "Start – End" : "Duration";
      th.textContent = base + (on ? (sortBy === "best" ? " \u25BE" : " \u25B4") : "");
    });
    if (!meta) return;
    const q = qEl.value.trim().toUpperCase();
    const them = q && !GRID_RE.test(q) ? q + " " + meta.grid : meta.grid;
    barEl.textContent = rows.length + " mutual window" + (rows.length === 1 ? "" : "s") + " · me " + (meta.homeGrid || "home") + " \u2194 " + them;
    footEl.textContent = "Min El " + meta.minEl + "° at both ends · " + meta.satsChecked + " FM/linear sats checked" + (meta.satsNoTle ? " (" + meta.satsNoTle + " without TLE)" : "");
    if (!rows.length) { tbody.innerHTML = '<tr><td colspan="6" class="sc-empty">No mutual windows in the next ' + meta.hours + "h.</td></tr>"; return; }
    const list = sorted();
    tbody.innerHTML = list.map((r, i) => {
      const s = new Date(r.start), e = new Date(r.end);
      const sel = rows.indexOf(r) === selIdx;
      return '<tr data-i="' + rows.indexOf(r) + '"' + (sel ? ' class="sel"' : "") + "><td><b>" + esc(r.name) + "</b>" +
        (sel ? '<div class="acts"><button class="sc-btn sc-primary" data-act="map">Show on map</button><button class="sc-btn" data-act="track">Track</button></div>' : "") +
        '</td><td><span class="badge ' + (r.mode === "fm" ? "fm\">FM" : "lin\">Linear") + "</span></td>" +
        "<td>" + dayTag(s) + hmL(s) + " – " + hmL(e) + " " + esc(tzAbbr(s)) + '<div class="sub">' + hmU(s) + " – " + hmU(e) + " UTC</div></td>" +
        "<td>" + dur(r.durationSec) + "</td><td>" + Math.round(r.maxElMe) + "° / " + Math.round(r.maxElThem) + "°</td>" +
        "<td>" + r.azMidMe + "° / " + r.azMidThem + "°</td></tr>";
    }).join("");
    tbody.querySelectorAll("tr[data-i]").forEach((tr) => tr.addEventListener("click", (ev) => {
      const i = parseInt(tr.dataset.i, 10);
      const act = ev.target && ev.target.dataset && ev.target.dataset.act;
      if (act === "map") return showOnMap(rows[i]);
      if (act === "track") return track(rows[i]);
      selIdx = i; render();
    }));
  }

  function getMap() { return typeof map !== "undefined" && map ? map : null; }
  function clearMap() { const m = getMap(); if (mapLayer && m) m.removeLayer(mapLayer); mapLayer = null; }
  function showOnMap(r) {
    const m = getMap();
    if (!m || typeof L === "undefined" || !meta) return;
    clearMap();
    mapLayer = L.layerGroup().addTo(m);
    const pin = L.marker([meta.remote.lat, meta.remote.lon]).addTo(mapLayer);
    pin.bindTooltip((qEl.value.trim().toUpperCase() && !GRID_RE.test(qEl.value.trim()) ? qEl.value.trim().toUpperCase() + " " : "") + meta.grid, { permanent: true, direction: "top", className: "sched-pin-label", offset: [0, -30] });
    const pts = [[meta.remote.lat, meta.remote.lon], [meta.home.lat, meta.home.lon]];
    if (r.sub) {
      const rad = typeof footprintRadiusM === "function" ? footprintRadiusM(r.sub.heightKm) : 2000e3;
      L.circle([r.sub.lat, r.sub.lon], { radius: rad, color: "#c48a00", weight: 1.5, opacity: 0.8, fillColor: "#c48a00", fillOpacity: 0.08, interactive: false }).addTo(mapLayer);
      L.circleMarker([r.sub.lat, r.sub.lon], { radius: 4, color: "#c48a00", fillOpacity: 1, interactive: false })
        .bindTooltip(r.name + " @ " + hmL(new Date(r.mid)), { permanent: true, direction: "right", className: "sched-pin-label" }).addTo(mapLayer);
      pts.push([r.sub.lat, r.sub.lon]);
    }
    // Hide the modal so the map is visible, but keep the overlay until closed / new search
    panel.hidden = true; backdrop.hidden = true;
    reopenHint();
    try { m.fitBounds(L.latLngBounds(pts).pad(0.3)); } catch (_) {}
  }
  let schedBtn = null;
  function reopenHint() { if (schedBtn) schedBtn.classList.toggle("active", !!mapLayer); }
  function track(r) { send({ type: "sat", key: r.key, user: true }); }

  // Re-opening via the button keeps results; closing clears the overlay.
  function toggle() {
    if (panel && !panel.hidden) close();
    else open();
    reopenHint();
  }

  function addButton() {
    const bar = document.querySelector(".decode-toggle-control");
    if (!bar) return false;
    if (bar.querySelector(".sched-open-btn")) return true;
    schedBtn = document.createElement("a");
    schedBtn.href = "#";
    schedBtn.className = "sched-open-btn";
    schedBtn.setAttribute("role", "button");
    schedBtn.title = "Sked Finder: find mutual passes with another station";
    schedBtn.textContent = "Sked Finder";
    schedBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); toggle(); });
    bar.insertBefore(schedBtn, bar.firstChild);
    return true;
  }

  function patchWs() {
    if (typeof ws === "undefined" || !ws || ws.__schedPatched) return;
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "schedule-lookup") onLookup(msg);
        else if (msg.type === "schedule-result") onResult(msg);
      } catch (_) {}
    });
    ws.__schedPatched = true;
  }
  function init() {
    setInterval(patchWs, 500);
    const t = setInterval(() => { if (addButton()) clearInterval(t); }, 300);
  }
  window.ScheduleContact = { open, close };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
