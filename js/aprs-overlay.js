/**
 * APRS on the map: the "APRS" box (a Leaflet control directly below the
 * WSJT Heard / Clear Spots bar) and the "APRS Heard" layer.
 *
 * Box: KISS status, APRS Heard toggle, Messages window button, and the
 * primary action: Send position (Via + comment editable), plus the last
 * few heard stations. Reasons why sending is blocked are shown inline.
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
  let box = null;
  let stations = [];
  let expireMs = 60 * 60 * 1000;
  let skewMs = 0;
  const markers = new Map();
  let viaEdited = false;
  let lastSatKey = null;

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
  function hhmm(t) {
    const d = new Date(t);
    return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0") + "Z";
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
          '<div class="aprs-pop-row ' + (r.dir === "tx" ? "tx" : "rx") + '"><span class="aprs-pop-t">' + hhmm(r.time) + "</span> " +
          '<span class="aprs-pop-k">' + esc(r.type) + "</span> " +
          (r.viaSat ? '<span class="aprs-badge-sat">SAT</span> ' : "") + esc(r.text) + "</div>",
      )
      .join("");
    const pos =
      s.posSource === "grid" ? "grid " + esc(s.grid) + " centre" : s.posSource === "last" ? "last known position" : s.posSource === "self" ? "your station" : s.lat.toFixed(4) + ", " + s.lon.toFixed(4);
    return (
      '<div class="aprs-pop"><div class="aprs-pop-h"><b>' + esc(s.call) + "</b>" + (s.symbol ? ' <span class="aprs-pop-sym">' + esc(s.symbol) + "</span>" : "") +
      (s.viaSat ? ' <span class="aprs-badge-sat">via sat</span>' : "") + '<span class="aprs-pop-age">' + ago(now - s.lastHeard) + " ago</span></div>" +
      '<div class="aprs-pop-pos">' + pos + " · " + (s.count || 1) + " pkt</div>" + rows +
      '<div class="aprs-pop-act"><a href="#" data-aprs-to="' + esc(s.call) + '">Message ' + esc(s.call) + "…</a></div></div>"
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
      let mk = markers.get(s.call);
      if (!mk) {
        mk = L.circleMarker([s.lat, s.lon], Object.assign({ className: "aprs-dot" }, styleFor(s, op)));
        mk.bindTooltip(html, { permanent: true, direction: "right", offset: [5, 0], className: "decode-label aprs-label", opacity: op });
        mk.bindPopup("", { className: "aprs-popup", maxWidth: 320 });
        mk.on("popupopen", (e) => {
          const st = stations.find((x) => x.call === mk.__call);
          if (st) e.popup.setContent(popupHtml(st));
        });
        mk.addTo(lg);
        markers.set(s.call, mk);
      } else {
        mk.setLatLng([s.lat, s.lon]);
        mk.setStyle(styleFor(s, op));
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
    const a = e.target.closest && e.target.closest("[data-aprs-to]");
    if (!a) return;
    e.preventDefault();
    if (window.aprsWindow) window.aprsWindow.open({ to: a.getAttribute("data-aprs-to") });
    if (gpop) gpop.hidden = true;
  }
  document.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest(".aprs-popup [data-aprs-to]")) onPopupClick(e);
  });

  /* ---------- map box ---------- */
  function boxHtml() {
    return (
      '<div class="aprs-box-head"><span class="aprs-box-title">APRS</span>' +
      '<span class="aprs-kiss-dot" id="aprs-kiss-dot"></span><span class="aprs-kiss-text" id="aprs-kiss-text">KISS off</span></div>' +
      '<div class="aprs-box-btns">' +
      '<a href="#" role="button" class="aprs-heard-btn" id="aprs-heard-btn">APRS Heard</a>' +
      '<a href="#" role="button" class="aprs-msgs-btn" id="aprs-msgs-btn" title="Open the APRS messages / packets window">Messages<span class="aprs-unread" id="aprs-unread" hidden></span></a>' +
      "</div>" +
      '<div class="aprs-box-tx">' +
      '<label class="aprs-f"><span>Via</span><input type="text" id="aprs-box-via" spellcheck="false" autocomplete="off" placeholder="ARISS" /></label>' +
      '<label class="aprs-f"><span>Comment</span><input type="text" id="aprs-box-comment" maxlength="43" autocomplete="off" placeholder="beacon comment" /></label>' +
      '<button type="button" class="aprs-send-pos" id="aprs-send-pos">Send position</button>' +
      '<div class="aprs-box-why" id="aprs-box-why" aria-live="polite"></div>' +
      "</div>" +
      '<div class="aprs-box-heard" id="aprs-box-heard"></div>'
    );
  }
  function addBox() {
    const m = getMap();
    const bar = document.querySelector(".decode-toggle-control");
    if (!m || !bar || typeof L === "undefined") return false;
    if (box) return true;
    box = L.DomUtil.create("div", "leaflet-bar leaflet-control aprs-box");
    box.innerHTML = boxHtml();
    L.DomEvent.disableClickPropagation(box);
    L.DomEvent.disableScrollPropagation(box);
    ["keydown", "keyup", "keypress", "dblclick", "mousedown", "touchstart", "pointerdown"].forEach((ev) =>
      box.addEventListener(ev, (e) => e.stopPropagation()),
    );
    // Directly below the WSJT Heard / Clear Spots bar.
    bar.parentNode.insertBefore(box, bar.nextSibling);
    box.querySelector("#aprs-heard-btn").addEventListener("click", (e) => {
      e.preventDefault();
      on = !on;
      localStorage.setItem(LS_ON, on ? "1" : "0");
      render();
      notify();
    });
    box.querySelector("#aprs-msgs-btn").addEventListener("click", (e) => {
      e.preventDefault();
      if (window.aprsWindow) window.aprsWindow.toggle();
    });
    box.querySelector("#aprs-box-via").addEventListener("input", () => {
      viaEdited = true;
    });
    box.querySelector("#aprs-send-pos").addEventListener("click", sendPosition);
    box.querySelector("#aprs-box-heard").addEventListener("click", (e) => {
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
    const commentEl = box.querySelector("#aprs-box-comment");
    const st = APRS() && APRS().status;
    if (st && st.comment) commentEl.value = st.comment;
    syncBox();
    return true;
  }
  let pendingReq = 0;
  function sendPosition() {
    const via = box.querySelector("#aprs-box-via").value.trim().toUpperCase();
    const comment = box.querySelector("#aprs-box-comment").value;
    const why = box.querySelector("#aprs-box-why");
    pendingReq = Date.now();
    if (!APRS() || !APRS().send({ type: "aprs-send", kind: "beacon", via, comment, reqId: pendingReq })) {
      why.textContent = "Not connected to the tracker server";
      return;
    }
    why.textContent = "Sending…";
  }
  function syncBox() {
    if (!box) return;
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
      !st || !st.enabled ? "KISS off" : state === "connected" ? "KISS connected" : state === "waiting" ? "KISS down, retrying" : "KISS " + state;
    box.title = st && APRS().statusText ? APRS().statusText(st) : "";
    const viaEl = box.querySelector("#aprs-box-via");
    if (st) {
      const satKey = st.sat ? st.sat.key : null;
      if (satKey !== lastSatKey) {
        lastSatKey = satKey;
        viaEdited = false;
      }
      if (!viaEdited && document.activeElement !== viaEl) viaEl.value = st.defaultVia || "";
      const gate = st.gateBeacon || { ok: false, reasons: [] };
      const btn = box.querySelector("#aprs-send-pos");
      btn.disabled = !gate.ok;
      btn.title = gate.ok ? "Send your position (" + (st.selfPos ? st.selfPos.source : "?") + ") as " + (st.source || "?") + " via " + (viaEl.value || "direct") : gate.reasons.join("\n");
      const why = box.querySelector("#aprs-box-why");
      if (!why.dataset.result || Date.now() - Number(why.dataset.result) > 6000) {
        why.dataset.result = "";
        why.textContent = gate.ok ? "" : gate.reasons[0] || "";
        why.title = gate.reasons.join("\n");
        why.classList.toggle("blocked", !gate.ok);
        why.classList.remove("ok");
      }
    }
    renderHeardList();
  }
  function renderHeardList() {
    if (!box) return;
    const el = box.querySelector("#aprs-box-heard");
    const now = Date.now() + skewMs;
    const rx = stations.filter((s) => s.posSource !== "self").slice(0, 4);
    el.innerHTML = rx.length
      ? rx
          .map(
            (s) =>
              '<div class="aprs-hl" data-call="' + esc(s.call) + '" title="' + esc(tipText(s, now - s.lastHeard)) + '">' +
              '<span class="aprs-hl-call">' + esc(s.call) + "</span>" +
              (s.viaSat ? '<span class="aprs-badge-sat">SAT</span>' : "") +
              '<span class="aprs-hl-age">' + ago(now - s.lastHeard) + "</span></div>",
          )
          .join("")
      : '<div class="aprs-hl-empty">No stations heard yet</div>';
  }

  function onSendResult(r) {
    if (!box || r.kind !== "beacon") return;
    const why = box.querySelector("#aprs-box-why");
    why.dataset.result = String(Date.now());
    why.classList.toggle("ok", !!r.ok);
    why.classList.toggle("blocked", !r.ok);
    why.textContent = r.ok ? "Sent " + hhmm(Date.now()) + ": " + (r.packet ? r.packet.tnc2 : "") : (r.reasons || ["failed"]).join("; ");
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
  };

  function init() {
    let hooked = false;
    const tryHook = () => {
      if (hooked || !window.APRS) return hooked;
      hooked = true;
      const A = window.APRS;
      A.on("aprs-heard", apply);
      A.on("aprs-status", (st) => {
        if (box && st && st.comment != null) {
          const c = box.querySelector("#aprs-box-comment");
          if (c && !c.value && document.activeElement !== c) c.value = st.comment;
        }
        syncBox();
      });
      A.on("aprs-send-result", onSendResult);
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
      if (ensureLayer() && addBox()) clearInterval(t);
    }, 300);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
