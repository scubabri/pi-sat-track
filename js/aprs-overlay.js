/**
 * APRS on the map: the "APRS" button (in the Sked Finder / WSJT Heard /
 * Clear Spots button stack, directly below Clear Spots), the floating APRS
 * window it toggles, and the "APRS Heard" layer.
 *
 * Button: highlighted while the window is open, small dot = KISS state.
 * Window (js/aprs-float.js chrome, state in localStorage "aprsStationWin"):
 * KISS status, APRS Heard toggle, Messages window button, UISS-style
 * To / Via header + comment and the primary action Send position, the reason
 * sending is blocked, and recent stations. Nothing permanently covers the map.
 *
 * Layer: stations from the server "aprs-heard" store. Position reports plot
 * at their position; messages / status without one plot at the sender's last
 * known position or a grid in the text (server lib/aprs/store.js). Clicking a
 * station shows its recent packets. The 3D globe (js/globe-view.js) draws the
 * same list via window.aprsOverlay and redraws on "aprs-overlay-change".
 */
(function () {
  const LS_ON = "aprsOverlayOn";
  let on = localStorage.getItem(LS_ON) !== "0";
  let layer = null;
  let stations = [];
  let expireMs = 60 * 60 * 1000;
  let skewMs = 0;
  const markers = new Map();

  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const getMap = () => (typeof map !== "undefined" && map ? map : null);
  const APRS = () => window.APRS || null;

  function ago(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + " s";
    if (s < 3600) return Math.round(s / 60) + " min";
    return (s / 3600).toFixed(1) + " h";
  }
  /** "HH:MM UTC" / "HH:MM MT": follows the app's UTC | local toggle. */
  function hhmm(t) {
    const A = APRS();
    if (A && A.fmtTimeShort) return A.fmtTimeShort(t);
    const d = new Date(t);
    return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0") + " UTC";
  }
  /** Same without the zone (dense rows; the zone is shown in the heading). */
  function hhmmBare(t) {
    return hhmm(t).replace(/ (UTC|MT)$/, "");
  }
  function ageOpacity(age) {
    const f = Math.min(1, Math.max(0, age / expireMs));
    return 1 - 0.7 * f;
  }
  const SRC_LABEL = { aprs: "", last: "last pos", grid: "grid", self: "you" };

  function tipText(s, age) {
    const where = s.posSource === "grid" ? " (grid " + (s.grid || "?") + ")" : s.posSource === "last" ? " (last known position)" : "";
    return s.call + where + (s.viaSat ? " · via sat" : "") + " · " + ago(age) + " ago" + (s.comment ? " · " + s.comment : "");
  }
  function popupHtml(s) {
    const now = Date.now() + skewMs;
    const rows = (s.recent || [])
      .map(
        (r) =>
          '<div class="aprs-pop-row ' + (r.dir === "tx" ? "tx" : "rx") + '"><span class="aprs-pop-t">' + hhmmBare(r.time) + "</span> " +
          '<span class="aprs-pop-k">' + esc(r.type) + "</span> " +
          (r.viaSat ? '<span class="aprs-badge-sat">SAT</span> ' : "") + esc(r.text) +
          (r.conn ? ' <span class="aprs-pop-c">[' + esc(r.conn) + "]</span>" : "") + "</div>",
      )
      .join("");
    const pos =
      s.posSource === "grid" ? "grid " + esc(s.grid) + " centre" : s.posSource === "last" ? "last known position" : s.posSource === "self" ? "your station" : s.lat.toFixed(4) + ", " + s.lon.toFixed(4);
    return (
      '<div class="aprs-pop"><div class="aprs-pop-h"><b>' + esc(s.call) + "</b>" +
      (s.symbol ? ' <span class="aprs-pop-sym" title="APRS symbol ' + esc(s.symbol) + '">' + esc(window.APRS_SYMBOLS && window.APRS_SYMBOLS.parse(s.symbol) ? window.APRS_SYMBOLS.name(s.symbol) : s.symbol) + "</span>" : "") +
      (s.viaSat ? ' <span class="aprs-badge-sat">via sat</span>' : "") + '<span class="aprs-pop-age">' + ago(now - s.lastHeard) + " ago</span></div>" +
      '<div class="aprs-pop-pos">' + pos + " · " + (s.count || 1) + " pkt · last " + hhmm(s.lastHeard) + "</div>" +
      (s.conn ? '<div class="aprs-pop-conn" title="KISS connection that heard it last">heard on ' + esc(s.conn) + "</div>" : "") +
      (s.device ? '<div class="aprs-pop-dev" title="Radio / tracker, from the Mic-E device code (aprs-deviceid)">' + esc(s.device) + "</div>" : "") +
      (s.comment ? '<div class="aprs-pop-cmt">' + esc(s.comment) + "</div>" : "") +
      rows +
      '<div class="aprs-pop-act">' +
      '<a href="#" data-aprs-paste="for" data-call="' + esc(s.call) + '" title="Open Messages with For: ' + esc(s.call) + ' (APRS message)">Message…</a>' +
      '<a href="#" data-aprs-paste="to" data-call="' + esc(s.call) + '" title="Put ' + esc(s.call) + ' in To: (AX.25 destination)">To:</a>' +
      '<a href="#" data-aprs-paste="via" data-call="' + esc(s.call) + '" title="Put ' + esc(s.call) + ' in Via: (digipeater)">Via:</a>' +
      "</div></div>"
    );
  }

  /* ---------- layer ---------- */
  function ensureLayer() {
    const m = getMap();
    if (!m || typeof L === "undefined") return null;
    if (!layer) layer = L.layerGroup();
    if (on && !m.hasLayer(layer)) layer.addTo(m);
    if (!on && m.hasLayer(layer)) m.removeLayer(layer);
    return layer;
  }
  function styleFor(s, op) {
    const tx = s.posSource === "self";
    const approx = s.posSource === "grid" || s.posSource === "last";
    return {
      radius: s.posSource === "aprs" ? 5 : 4,
      weight: s.viaSat ? 2 : 1,
      color: s.viaSat ? "#ffffff" : "#0b1e2d",
      dashArray: approx ? "2 2" : null,
      fillColor: tx ? "#3fb950" : approx ? "#7aa7c7" : "#39c5ff",
      fillOpacity: op,
      opacity: op,
    };
  }
  /** Station's APRS symbol (table+code) when the sprite set knows it, else "" (dot). */
  function symOf(s) {
    const S = window.APRS_SYMBOLS;
    return S && s && s.symbol && S.parse(s.symbol) ? s.symbol : "";
  }
  function symIcon(s, sym) {
    const cls = "aprs-sym-marker" + (s.viaSat ? " via-sat" : "") + (s.posSource === "grid" || s.posSource === "last" ? " approx" : "") + (s.posSource === "self" ? " self" : "");
    return L.divIcon({ className: cls, html: '<span class="aprs-sym-wrap">' + window.APRS_SYMBOLS.html(sym, 24) + "</span>", iconSize: [24, 24], iconAnchor: [12, 12], tooltipAnchor: [2, 0], popupAnchor: [0, -10] });
  }
  function render() {
    const lg = ensureLayer();
    syncBox();
    if (!lg) return;
    const now = Date.now() + skewMs;
    const seen = new Set();
    for (const s of stations) {
      const age = now - s.lastHeard;
      if (age > expireMs || !Number.isFinite(s.lat)) continue;
      seen.add(s.call);
      const op = ageOpacity(age);
      const sub = SRC_LABEL[s.posSource] || "";
      const html = '<span class="dc-call">' + esc(s.call) + "</span>" + (sub ? '<span class="dc-grid">' + esc(sub) + "</span>" : "");
      const sym = symOf(s);
      const kind = sym ? "sym:" + sym + ":" + s.posSource + ":" + !!s.viaSat : "dot";
      let mk = markers.get(s.call);
      if (mk && mk.__kind !== kind && (sym || mk.__kind !== "dot")) {
        lg.removeLayer(mk);
        markers.delete(s.call);
        mk = null;
      }
      if (!mk) {
        mk = sym
          ? L.marker([s.lat, s.lon], { icon: symIcon(s, sym), opacity: op, keyboard: false })
          : L.circleMarker([s.lat, s.lon], Object.assign({ className: "aprs-dot" }, styleFor(s, op)));
        mk.__kind = kind;
        mk.bindTooltip(html, { permanent: true, direction: "right", offset: sym ? [10, 0] : [5, 0], className: "decode-label aprs-label", opacity: op });
        mk.bindPopup("", { className: "aprs-popup", maxWidth: 320 });
        mk.on("popupopen", (e) => {
          const st = stations.find((x) => x.call === mk.__call);
          if (st) e.popup.setContent(popupHtml(st));
        });
        mk.addTo(lg);
        markers.set(s.call, mk);
      } else {
        mk.setLatLng([s.lat, s.lon]);
        if (mk.setStyle) mk.setStyle(styleFor(s, op));
        else mk.setOpacity(op);
        mk.setTooltipContent(html);
        const t = mk.getTooltip();
        if (t) t.setOpacity(op);
        if (mk.isPopupOpen()) mk.getPopup().setContent(popupHtml(s));
      }
      mk.__call = s.call;
      const el = mk.getElement && mk.getElement();
      if (el) el.setAttribute("aria-label", tipText(s, age));
    }
    for (const [call, mk] of markers) {
      if (!seen.has(call)) {
        lg.removeLayer(mk);
        markers.delete(call);
      }
    }
  }
  function notify() {
    try {
      document.dispatchEvent(new Event("aprs-overlay-change"));
    } catch (_) {}
  }
  function visibleItems(nowMs) {
    if (!on) return [];
    const now = (nowMs != null ? nowMs : Date.now()) + skewMs;
    const out = [];
    for (const s of stations) {
      if (!s || !Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
      const age = now - s.lastHeard;
      if (age > expireMs) continue;
      out.push({
        call: s.call,
        grid: SRC_LABEL[s.posSource] || "",
        lat: s.lat,
        lon: s.lon,
        opacity: ageOpacity(age),
        tip: tipText(s, age),
        posSource: s.posSource,
        viaSat: !!s.viaSat,
        symbol: symOf(s),
      });
    }
    return out;
  }

  /* Floating popup for the globe (no Leaflet popup there). */
  let gpop = null;
  function showGlobePopup(call, x, y) {
    const s = stations.find((st) => st.call === call);
    if (!s) return;
    if (!gpop) {
      gpop = document.createElement("div");
      gpop.className = "aprs-globe-pop leaflet-popup-content-wrapper";
      document.body.appendChild(gpop);
      document.addEventListener("click", (e) => {
        if (gpop && !gpop.contains(e.target) && !(e.target.closest && e.target.closest(".globe-aprs"))) gpop.hidden = true;
      });
      gpop.addEventListener("click", onPopupClick);
    }
    gpop.innerHTML = popupHtml(s);
    gpop.hidden = false;
    gpop.style.left = Math.min(window.innerWidth - 330, x + 12) + "px";
    gpop.style.top = Math.max(8, y - 20) + "px";
  }
  function onPopupClick(e) {
    const a = e.target.closest && e.target.closest("[data-aprs-paste]");
    if (!a) return;
    e.preventDefault();
    const field = a.getAttribute("data-aprs-paste");
    if (APRS()) APRS().pasteCall(a.getAttribute("data-call"), field);
    if (field !== "for" && win && !win.isOpen()) win.open();
    flash("Put " + a.getAttribute("data-call") + " in " + (field === "for" ? "For:" : field === "to" ? "To:" : "Via:"));
    if (gpop) gpop.hidden = true;
  }
  document.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest(".aprs-popup [data-aprs-paste]")) onPopupClick(e);
  });

  /* ---------- APRS button + window ---------- */
  let win = null;
  let btn = null;
  function winHtml() {
    return (
      '<div class="aprs-st">' +
      '<div class="aprs-box-head"><span class="aprs-kiss-dot" id="aprs-kiss-dot"></span><span class="aprs-kiss-text" id="aprs-kiss-text">KISS off</span></div>' +
      '<a href="#" role="button" class="aprs-kiss-off" id="aprs-kiss-off" hidden title="Open Configure on the KISS / APRS tab">KISS off — enable in Configure → KISS / APRS</a>' +
      '<div class="aprs-box-btns">' +
      '<a href="#" role="button" class="aprs-heard-btn" id="aprs-heard-btn">APRS Heard</a>' +
      '<a href="#" role="button" class="aprs-msgs-btn" id="aprs-msgs-btn" title="Open the APRS messages / packets window">Messages<span class="aprs-unread" id="aprs-unread" hidden></span></a>' +
      "</div>" +
      '<div class="aprs-box-tx">' +
      '<label class="aprs-f"><span>To</span><input type="text" id="aprs-box-to" list="aprs-dl-to" maxlength="9" spellcheck="false" autocomplete="off" placeholder="CQ" title="AX.25 destination (UISS To:), e.g. CQ or APRS" /></label>' +
      '<label class="aprs-f"><span>Via</span><input type="text" id="aprs-box-via" list="aprs-dl-via" spellcheck="false" autocomplete="off" placeholder="direct" title="Digipeater path (UISS Via:), up to 8 separated by space or comma" /></label>' +
      '<label class="aprs-f"><span>Comment</span><input type="text" id="aprs-box-comment" maxlength="43" autocomplete="off" placeholder="beacon comment" /></label>' +
      '<button type="button" class="aprs-send-pos" id="aprs-send-pos">Send position</button>' +
      '<div class="aprs-lasttx" id="aprs-box-lasttx" aria-live="polite"></div>' +
      '<div class="aprs-route" id="aprs-box-route" aria-live="polite" title="KISS connection this send uses (role + speed matched to the satellite; Configure → KISS / APRS)"></div>' +
      '<div class="aprs-box-why" id="aprs-box-why" aria-live="polite"></div>' +
      "</div>" +
      '<div class="aprs-box-sub">Recent stations <span class="aprs-zone" id="aprs-hl-zone"></span> <span class="aprs-hint" title="Click: show on map. Right-click: put the call in To / Via / For (like UISS MHeard)">ⓘ</span></div>' +
      '<div class="aprs-box-heard" id="aprs-box-heard"></div>' +
      "</div>"
    );
  }
  let flashT = 0;
  function flash(text) {
    if (!win) return;
    const why = win.el.querySelector("#aprs-box-why");
    why.dataset.result = String(Date.now());
    why.className = "aprs-box-why ok";
    why.textContent = text;
    clearTimeout(flashT);
    flashT = setTimeout(syncBox, 6100);
  }
  function buildWin() {
    if (win || !window.aprsFloat) return win;
    win = window.aprsFloat.create({
      id: "aprs-station-win",
      cls: "aprs-station-win",
      title: "APRS",
      label: "APRS station",
      lsKey: "aprsStationWin",
      width: 250,
      minW: 230,
      minH: 220,
      defaultX: (w) => Math.max(8, window.innerWidth - w - 400),
      defaultY: 150,
    });
    const box = win.el;
    win.body.innerHTML = winHtml();
    box.querySelector("#aprs-heard-btn").addEventListener("click", (e) => {
      e.preventDefault();
      on = !on;
      localStorage.setItem(LS_ON, on ? "1" : "0");
      render();
      notify();
    });
    box.querySelector("#aprs-kiss-off").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation(); // config.js closes the panel on any outside click
      if (APRS() && APRS().openKissConfig) APRS().openKissConfig();
    });
    box.addEventListener("click", (e) => {
      if (!(e.target.closest && e.target.closest("#aprs-digi-count"))) return;
      e.preventDefault();
      if (window.aprsWindow) window.aprsWindow.open({ view: "digipeats" });
    });
    box.querySelector("#aprs-msgs-btn").addEventListener("click", (e) => {
      e.preventDefault();
      if (window.aprsWindow) window.aprsWindow.toggle();
    });
    box.querySelector("#aprs-box-to").addEventListener("input", (e) => APRS() && APRS().setHdr({ to: e.target.value || null }, "box"));
    box.querySelector("#aprs-box-via").addEventListener("input", (e) => APRS() && APRS().setHdr({ via: e.target.value }, "box"));
    box.querySelector("#aprs-send-pos").addEventListener("click", sendPosition);
    box.querySelector("#aprs-box-comment").addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendPosition();
    });
    const heard = box.querySelector("#aprs-box-heard");
    heard.addEventListener("click", (e) => {
      const r = e.target.closest && e.target.closest("[data-call]");
      if (!r) return;
      const s = stations.find((x) => x.call === r.getAttribute("data-call"));
      const mm = getMap();
      if (s && mm && Number.isFinite(s.lat)) {
        mm.panTo([s.lat, s.lon]);
        const mk = markers.get(s.call);
        if (mk && on) mk.openPopup();
      }
    });
    heard.addEventListener("contextmenu", (e) => {
      const r = e.target.closest && e.target.closest("[data-call]");
      if (!r || !APRS()) return;
      e.preventDefault();
      APRS().callMenu(r.getAttribute("data-call"), e.clientX, e.clientY);
    });
    win.onChange(syncBtn);
    const st = APRS() && APRS().status;
    if (st && st.comment) box.querySelector("#aprs-box-comment").value = st.comment;
    syncBox();
    return win;
  }
  /** "APRS" button in the decode button stack, directly below Clear Spots. */
  function addButton() {
    const bar = document.querySelector(".decode-toggle-control");
    if (!bar || !window.aprsFloat) return false;
    if (btn && bar.contains(btn)) return true;
    btn = document.createElement("a");
    btn.href = "#";
    btn.className = "decode-toggle-btn aprs-open-btn";
    btn.id = "aprs-open-btn";
    btn.setAttribute("role", "button");
    btn.innerHTML = '<span class="aprs-btn-dot" id="aprs-btn-dot"></span>APRS<span class="aprs-unread" id="aprs-btn-unread" hidden></span>';
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      buildWin();
      win.toggle();
      syncBox();
    });
    const clr = bar.querySelector(".decode-clear-btn");
    if (clr) clr.insertAdjacentElement("afterend", btn);
    else bar.appendChild(btn);
    buildWin();
    syncBtn();
    return true;
  }
  function syncBtn() {
    if (!btn) return;
    const open = !!(win && win.isOpen());
    btn.classList.toggle("active", open);
    btn.setAttribute("aria-pressed", open ? "true" : "false");
    const st = APRS() && APRS().status;
    const state = st ? (st.enabled ? st.state : "off") : "off";
    btn.querySelector("#aprs-btn-dot").className = "aprs-btn-dot kiss-" + state;
    btn.title = (open ? "Hide" : "Show") + " the APRS window · " + (st && APRS().statusText ? APRS().statusText(st) : "KISS off");
  }
  let pendingReq = 0;
  let lastClickMs = 0;
  function sendPosition() {
    // accidental double click: ignore a second click within 1 s (no message)
    if (Date.now() - lastClickMs < 1000) return;
    lastClickMs = Date.now();
    const box = win.el;
    const to = box.querySelector("#aprs-box-to").value.trim().toUpperCase();
    const via = box.querySelector("#aprs-box-via").value.trim().toUpperCase();
    const comment = box.querySelector("#aprs-box-comment").value;
    const why = box.querySelector("#aprs-box-why");
    pendingReq = Date.now();
    if (!APRS() || !APRS().send({ type: "aprs-send", kind: "beacon", to, via, comment, reqId: pendingReq })) {
      why.textContent = "Not connected to the tracker server";
      return;
    }
    why.textContent = "Sending…";
  }
  function syncHdrFields() {
    if (!win || !APRS()) return;
    const A = APRS();
    const toEl = win.el.querySelector("#aprs-box-to");
    const viaEl = win.el.querySelector("#aprs-box-via");
    if (document.activeElement !== toEl) toEl.value = A.getTo();
    if (document.activeElement !== viaEl) viaEl.value = A.getVia();
  }
  /** Digipeat confirmation under Send: "✓ Digipeated by KU5R-6 · 17:05:54 MT",
   * "Sent 17:05:45 MT — waiting for digipeat…", "Sent … — no digipeat heard". */
  function lastTxText(last, fmt) {
    const d = last.digi;
    if (d && d.state === "digipeated") return "✓ " + (last.retry > 1 ? "#" + last.retry + " " : "") + (d.viaSat ? "Heard via " : "Digipeated by ") + d.by.join(", ") + " · " + fmt(d.firstMs || last.time);
    const sent = "Sent " + (last.retry > 1 ? "#" + last.retry + " " : "") + fmt(last.time);
    if (d && d.state === "none") return sent + " — no digipeat heard (" + (d.timeoutS || 30) + " s)";
    return sent + " — waiting for digipeat…";
  }
  function syncBox() {
    syncBtn();
    if (!win) return;
    const box = win.el;
    const b = box.querySelector("#aprs-heard-btn");
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.title = (on ? "Hide" : "Show") + " APRS stations on the map / globe";
    const st = APRS() && APRS().status;
    const dot = box.querySelector("#aprs-kiss-dot");
    const txt = box.querySelector("#aprs-kiss-text");
    const state = st ? (st.enabled ? st.state : "off") : "off";
    dot.className = "aprs-kiss-dot kiss-" + state;
    txt.textContent =
      !st || !st.enabled
        ? "KISS off"
        : state === "connected"
          ? "KISS connected" + (st.total > 1 ? " (" + st.total + ")" : "")
          : state === "partial"
            ? "KISS " + st.connected + "/" + st.total + " connected"
            : state === "waiting"
              ? "KISS down, retrying"
              : "KISS " + state;
    txt.title = st && APRS().statusText ? APRS().statusText(st) : "";
    box.querySelector("#aprs-kiss-off").hidden = !!(st && st.enabled);
    syncHdrFields();
    if (st) {
      const viaEl = box.querySelector("#aprs-box-via");
      const gate = st.gateBeacon || { ok: false, reasons: [] };
      const lt = box.querySelector("#aprs-box-lasttx");
      const last = st.lastTx;
      const dt = last && APRS().digiText ? APRS().digiText(last.digi) : null;
      const fmt = APRS().fmtTime || ((t) => new Date(t).toISOString().slice(11, 19) + " UTC");
      const dc = APRS().digipeatCount || st.digipeatCount || 0;
      lt.innerHTML =
        (last ? '<span class="aprs-digi ' + (dt ? dt.cls : "pending") + '" title="' + esc("Last TX " + fmt(last.time) + (last.conn ? " on " + last.conn : "") + "\n" + last.tnc2) + '">' + esc(lastTxText(last, fmt)) + "</span>" : "") +
        '<a href="#" class="aprs-digi-count" id="aprs-digi-count" title="Open the digipeat log (Messages window)">Digipeats: ' + dc + "</a>";
      const rt = box.querySelector("#aprs-box-route");
      const route = APRS().routeFor ? APRS().routeFor(viaEl.value) : null;
      rt.innerHTML = APRS().routeHtml ? APRS().routeHtml(route) : "";
      rt.classList.toggle("blocked", !!(route && (!route.ok || !route.connected)));
      const sb = box.querySelector("#aprs-send-pos");
      sb.disabled = !gate.ok;
      sb.title = gate.ok
        ? "Send your position (" + (st.selfPos ? st.selfPos.source : "?") + ") as " + (st.source || "?") + ">" + (box.querySelector("#aprs-box-to").value || "CQ") + (viaEl.value ? " via " + viaEl.value : " direct")
        : gate.reasons.join("\n");
      const why = box.querySelector("#aprs-box-why");
      if (!why.dataset.result || Date.now() - Number(why.dataset.result) > 6000) {
        why.dataset.result = "";
        // satellite elevation / mode never block; shown as a hint for a sat Via
        const hint = gate.ok && gate.hints && gate.hints[0] && APRS().viaIsSat && APRS().viaIsSat(viaEl.value) ? gate.hints[0] : "";
        why.textContent = gate.ok ? hint : gate.reasons[0] || "";
        why.title = gate.reasons.concat(hint ? gate.hints : []).join("\n");
        why.classList.toggle("blocked", !gate.ok);
        why.classList.toggle("hint", !!hint);
        why.classList.remove("ok");
      }
    }
    renderHeardList();
  }
  function renderHeardList() {
    if (!win) return;
    const el = win.el.querySelector("#aprs-box-heard");
    const now = Date.now() + skewMs;
    const rx = stations.filter((s) => s.posSource !== "self").slice(0, win.st.h ? 40 : 6);
    const z = win.el.querySelector("#aprs-hl-zone");
    if (z) z.textContent = "(" + hhmm(0).replace(/^.* /, "") + ")";
    el.innerHTML = rx.length
      ? rx
          .map(
            (s) =>
              '<div class="aprs-hl" data-call="' + esc(s.call) + '" title="' + esc(tipText(s, now - s.lastHeard)) + '">' +
              '<span class="aprs-hl-call">' + esc(s.call) + "</span>" +
              (s.viaSat ? '<span class="aprs-badge-sat">SAT</span>' : "") +
              '<span class="aprs-hl-age" title="Last heard ' + esc(hhmm(s.lastHeard)) + '">' + esc(hhmmBare(s.lastHeard)) + " · " + ago(now - s.lastHeard) + "</span></div>",
          )
          .join("")
      : '<div class="aprs-hl-empty">No stations heard yet</div>';
  }

  function onSendResult(r) {
    if (!win || r.kind !== "beacon") return;
    const why = win.el.querySelector("#aprs-box-why");
    why.dataset.result = String(Date.now());
    why.classList.toggle("ok", !!r.ok);
    why.classList.toggle("blocked", !r.ok);
    why.textContent = r.ok ? "Sent " + hhmm(Date.now()) + ": " + (r.packet ? r.packet.tnc2 : "") + (r.note ? " · Note: " + r.note : "") : (r.reasons || ["failed"]).join("; ");
    why.title = why.textContent;
  }

  function apply(msg) {
    stations = Array.isArray(msg.stations) ? msg.stations : [];
    if (msg.expireMs > 0) expireMs = msg.expireMs;
    if (msg.now > 0) skewMs = msg.now - Date.now();
    render();
    notify();
  }

  window.aprsOverlay = {
    isOn: () => on,
    items: visibleItems,
    ageOpacity,
    showPopup: showGlobePopup,
    stations: () => stations,
    window: () => win,
    flash,
  };

  function init() {
    let hooked = false;
    const tryHook = () => {
      if (hooked || !window.APRS) return hooked;
      hooked = true;
      const A = window.APRS;
      A.on("aprs-heard", apply);
      A.on("hdr", syncHdrFields);
      A.on("aprs-status", (st) => {
        if (win && st && st.comment != null) {
          const c = win.el.querySelector("#aprs-box-comment");
          if (c && !c.value && document.activeElement !== c) c.value = st.comment;
        }
        syncBox();
      });
      A.on("aprs-send-result", onSendResult);
      ["aprs-tx-update", "aprs-digipeat", "aprs-digipeats"].forEach((ev) => A.on(ev, syncBox));
      A.on("time-mode", () => {
        render();
        renderHeardList();
        syncBox();
      });
      if (A.heard) apply(A.heard);
      return true;
    };
    if (!tryHook()) {
      const hook = setInterval(() => {
        if (tryHook()) clearInterval(hook);
      }, 200);
    }
    setInterval(() => {
      render();
      notify();
    }, 20000);
    const t = setInterval(() => {
      if (ensureLayer() && addButton()) clearInterval(t);
    }, 300);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
