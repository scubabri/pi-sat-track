/**
 * Floating APRS window (draggable, minimise, close; position / open state
 * kept in localStorage "aprsWindow"). Opened from the map APRS box.
 *
 *  - Messages: sent + received messages / status / free text in one
 *    conversation list (time, from, to, via, text; SENT vs RECEIVED,
 *    RS0ISS-digipeated flagged). Send fields To / Via / Text at the bottom.
 *    To empty = status packet (">Text"); To set = APRS message (no ack).
 *  - Packets: every packet (position reports first-class), newest first.
 */
(function () {
  const LS = "aprsWindow";
  const MSG_TYPES = new Set(["message", "ack", "rej", "status", "other", "nmea"]);
  let st = { open: false, min: false, x: null, y: null, tab: "messages" };
  try {
    st = Object.assign(st, JSON.parse(localStorage.getItem(LS) || "{}"));
  } catch (_) {}
  let win = null;
  let unread = 0;
  let viaEdited = false;
  let lastSatKey = null;
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const A = () => window.APRS || null;
  const save = () => localStorage.setItem(LS, JSON.stringify(st));
  function hhmmss(t) {
    const d = new Date(t);
    return [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map((n) => String(n).padStart(2, "0")).join(":") + "Z";
  }

  function build() {
    win = document.createElement("div");
    win.id = "aprs-window";
    win.className = "aprs-window";
    win.setAttribute("role", "dialog");
    win.setAttribute("aria-label", "APRS messages");
    win.innerHTML =
      '<div class="aprs-win-head" id="aprs-win-head"><span class="aprs-win-title">APRS</span>' +
      '<span class="aprs-win-tabs"><button type="button" data-tab="messages">Messages</button><button type="button" data-tab="packets">Packets</button></span>' +
      '<span class="aprs-win-kiss" id="aprs-win-kiss"></span>' +
      '<button type="button" class="aprs-win-clear" id="aprs-win-clear" title="Clear the packet list and heard stations">Clear</button>' +
      '<button type="button" class="aprs-win-btn" id="aprs-win-min" title="Minimise">&#8211;</button>' +
      '<button type="button" class="aprs-win-btn" id="aprs-win-close" title="Close">&#215;</button></div>' +
      '<div class="aprs-win-body">' +
      '<div class="aprs-win-list" id="aprs-win-list" aria-live="polite"></div>' +
      '<form class="aprs-win-send" id="aprs-win-send" autocomplete="off">' +
      '<div class="aprs-win-row"><label>To<input type="text" id="aprs-msg-to" maxlength="9" spellcheck="false" placeholder="CALL (empty = status)" title="Addressee callsign(-SSID). Empty sends the text as a status packet." /></label>' +
      '<label>Via<input type="text" id="aprs-msg-via" spellcheck="false" placeholder="ARISS" /></label>' +
      '<a href="#" class="aprs-save-via" id="aprs-save-via" title="Use this Via by default for the selected satellite">save</a></div>' +
      '<div class="aprs-win-row"><input type="text" id="aprs-msg-text" maxlength="67" placeholder="Text (max 67)" aria-label="Message text" />' +
      '<button type="submit" id="aprs-msg-send">Send</button></div>' +
      '<div class="aprs-win-why" id="aprs-win-why" aria-live="polite"></div>' +
      "</form>" +
      "</div>";
    document.body.appendChild(win);
    win.querySelectorAll(".aprs-win-tabs button").forEach((b) =>
      b.addEventListener("click", () => {
        st.tab = b.dataset.tab;
        save();
        renderList();
        sync();
      }),
    );
    win.querySelector("#aprs-win-close").addEventListener("click", close);
    win.querySelector("#aprs-win-min").addEventListener("click", () => {
      st.min = !st.min;
      save();
      sync();
    });
    win.querySelector("#aprs-win-send").addEventListener("submit", (e) => {
      e.preventDefault();
      sendMsg();
    });
    win.querySelector("#aprs-msg-via").addEventListener("input", () => {
      viaEdited = true;
      win.querySelector("#aprs-win-why").dataset.result = "";
      sync();
    });
    win.querySelector("#aprs-save-via").addEventListener("click", (e) => {
      e.preventDefault();
      const s = A() && A().status;
      if (!s || !s.sat) return showWhy("Select a satellite first", false);
      const via = win.querySelector("#aprs-msg-via").value.trim().toUpperCase();
      A().send({ type: "aprs-sat-path", sat: s.sat.key, via });
      viaEdited = false;
      showWhy("Default Via for " + (s.sat.name || s.sat.key) + " = " + (via || "(default)"), true);
    });
    win.querySelector("#aprs-win-clear").addEventListener("click", () => {
      if (A()) A().send({ type: "aprs-clear" });
    });
    win.querySelector("#aprs-win-list").addEventListener("click", (e) => {
      const r = e.target.closest && e.target.closest("[data-reply]");
      if (r) {
        win.querySelector("#aprs-msg-to").value = r.getAttribute("data-reply");
        win.querySelector("#aprs-msg-text").focus();
      }
    });
    dragify(win.querySelector("#aprs-win-head"));
    place();
  }

  function place() {
    const w = win.offsetWidth || 420;
    const h = win.offsetHeight || 360;
    let x = st.x != null ? st.x : Math.max(8, window.innerWidth - w - 380);
    let y = st.y != null ? st.y : 90;
    x = Math.max(0, Math.min(window.innerWidth - Math.min(w, 120), x));
    y = Math.max(0, Math.min(window.innerHeight - 32, y));
    win.style.left = x + "px";
    win.style.top = y + "px";
  }
  function dragify(handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, drag = false;
    handle.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      drag = true;
      sx = e.clientX;
      sy = e.clientY;
      ox = win.offsetLeft;
      oy = win.offsetTop;
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener("pointermove", (e) => {
      if (!drag) return;
      st.x = ox + e.clientX - sx;
      st.y = oy + e.clientY - sy;
      place();
    });
    const end = () => {
      if (!drag) return;
      drag = false;
      st.x = win.offsetLeft;
      st.y = win.offsetTop;
      save();
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    window.addEventListener("resize", () => win && place());
  }

  function showWhy(text, ok) {
    const w = win && win.querySelector("#aprs-win-why");
    if (!w) return;
    w.textContent = text;
    w.title = text;
    w.className = "aprs-win-why " + (ok ? "ok" : "blocked");
    w.dataset.result = String(Date.now());
  }
  function sendMsg() {
    const to = win.querySelector("#aprs-msg-to").value.trim().toUpperCase();
    const via = win.querySelector("#aprs-msg-via").value.trim().toUpperCase();
    const text = win.querySelector("#aprs-msg-text").value;
    if (!text.trim()) return showWhy("Enter some text", false);
    if (!A() || !A().send({ type: "aprs-send", kind: "message", to, via, text, reqId: Date.now() }))
      return showWhy("Not connected to the tracker server", false);
    showWhy("Sending…", true);
  }
  function onResult(r) {
    if (!win || r.kind !== "message") return;
    if (r.ok) {
      win.querySelector("#aprs-msg-text").value = "";
      showWhy("Sent " + hhmmss(Date.now()) + ": " + (r.packet ? r.packet.tnc2 : ""), true);
    } else showWhy((r.reasons || ["failed"]).join("; "), false);
  }

  function rowMsg(p) {
    const tx = p.dir === "tx";
    const to = p.to || (p.type === "status" ? "status" : p.dst);
    const text = p.type === "message" ? p.msgText : p.text;
    const via = (p.via || []).join(",");
    return (
      '<div class="aprs-m ' + (tx ? "sent" : "recv") + (p.ownEcho ? " echo" : "") + '">' +
      '<div class="aprs-m-meta"><span class="aprs-m-dir">' + (tx ? "SENT" : p.ownEcho ? "ECHO" : "RCVD") + "</span>" +
      '<span class="aprs-m-t">' + hhmmss(p.time) + "</span>" +
      '<span class="aprs-m-from"' + (!tx ? ' data-reply="' + esc(p.src) + '" title="Reply to ' + esc(p.src) + '"' : "") + ">" + esc(p.src) + "</span>" +
      '<span class="aprs-m-arrow">→</span><span class="aprs-m-to">' + esc(to) + "</span>" +
      (p.viaSat ? '<span class="aprs-badge-sat" title="Digipeated by ' + esc(p.viaSat) + '">' + esc(p.viaSat) + "</span>" : "") +
      '<span class="aprs-m-via" title="Via">' + esc(via || "direct") + "</span>" +
      (p.ownEcho ? '<span class="aprs-m-ok" title="Your packet was heard back">✓ digipeated</span>' : "") +
      "</div>" +
      '<div class="aprs-m-text">' + esc(p.type === "ack" || p.type === "rej" ? p.text : text) + "</div></div>"
    );
  }
  function rowPkt(p) {
    const tx = p.dir === "tx";
    const pos = p.lat != null ? (p.posSource === "grid" ? "grid " + (p.grid || "") : "pos") : p.plotSource ? p.plotSource : "";
    return (
      '<div class="aprs-p ' + (tx ? "sent" : "recv") + " t-" + esc(p.type) + '" title="' + esc(p.tnc2) + '">' +
      '<span class="aprs-m-t">' + hhmmss(p.time) + "</span>" +
      '<span class="aprs-p-dir">' + (tx ? "TX" : "RX") + "</span>" +
      '<span class="aprs-m-from">' + esc(p.src) + "</span>" +
      (p.viaSat ? '<span class="aprs-badge-sat">' + esc(p.viaSat) + "</span>" : "") +
      '<span class="aprs-p-type">' + esc(p.type) + (pos ? " · " + esc(pos) : "") + "</span>" +
      '<span class="aprs-p-text">' + esc(p.text) + "</span></div>"
    );
  }
  function renderList() {
    if (!win) return;
    const list = win.querySelector("#aprs-win-list");
    const pk = (A() && A().packets) || [];
    const msgs = st.tab === "messages";
    const rows = msgs ? pk.filter((p) => MSG_TYPES.has(p.type)).slice(0, 150).reverse() : pk.slice(0, 200);
    list.innerHTML = rows.length
      ? rows.map(msgs ? rowMsg : rowPkt).join("")
      : '<div class="aprs-empty">' + (msgs ? "No messages yet. Position reports are under Packets and on the map." : "No packets yet.") + "</div>";
    if (msgs) list.scrollTop = list.scrollHeight;
    else list.scrollTop = 0;
  }
  function sync() {
    if (!win) return;
    win.hidden = !st.open;
    win.classList.toggle("min", !!st.min);
    win.querySelectorAll(".aprs-win-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === st.tab));
    win.querySelector("#aprs-win-send").hidden = st.tab !== "messages";
    const s = A() && A().status;
    const k = win.querySelector("#aprs-win-kiss");
    const state = s ? (s.enabled ? s.state : "off") : "off";
    k.className = "aprs-win-kiss kiss-" + state;
    k.textContent = s && A().statusText ? A().statusText(s).replace(/^KISS /, "") : "";
    if (s) {
      const satKey = s.sat ? s.sat.key : null;
      if (satKey !== lastSatKey) {
        lastSatKey = satKey;
        viaEdited = false;
      }
      const viaEl = win.querySelector("#aprs-msg-via");
      if (!viaEdited && document.activeElement !== viaEl) viaEl.value = s.defaultVia || "";
      const why = win.querySelector("#aprs-win-why");
      if (!why.dataset.result || Date.now() - Number(why.dataset.result) > 8000) {
        why.dataset.result = "";
        // Same rule as the server (lib/aprs/service.js isSatPath): any non-WIDEn-N/RELAY/TRACE hop.
        const viaSat = viaEl.value
          .split(/[\s,]+/)
          .filter(Boolean)
          .some((h) => !/^(WIDE\d?|RELAY|TRACE\d?|TEMP\d?)(-\d{1,2})?$/i.test(h));
        const g = viaSat ? s.gateMessage : s.gateMessageDirect;
        why.textContent = g && !g.ok ? g.reasons[0] : "";
        why.title = g ? g.reasons.join("\n") : "";
        why.className = "aprs-win-why" + (g && !g.ok ? " blocked" : "");
        win.querySelector("#aprs-msg-send").disabled = !!(g && !g.ok);
        win.querySelector("#aprs-msg-send").title = g && !g.ok ? g.reasons.join("\n") : "Send as " + (s.source || "?");
      }
      const sv = win.querySelector("#aprs-save-via");
      sv.hidden = !s.sat;
      if (s.sat) sv.title = "Use this Via by default for " + (s.sat.name || s.sat.key);
    }
    const badge = document.getElementById("aprs-unread");
    if (badge) {
      badge.hidden = !unread;
      badge.textContent = unread ? String(unread) : "";
    }
  }
  function open(o) {
    if (!win) build();
    st.open = true;
    st.min = false;
    if (o && o.to) {
      st.tab = "messages";
      win.querySelector("#aprs-msg-to").value = o.to;
    }
    unread = 0;
    save();
    place();
    renderList();
    sync();
    if (o && o.to) win.querySelector("#aprs-msg-text").focus();
  }
  function close() {
    st.open = false;
    save();
    sync();
  }
  window.aprsWindow = {
    open,
    close,
    toggle: () => (st.open && !st.min ? close() : open()),
    isOpen: () => !!st.open,
  };

  function init() {
    const t = setInterval(() => {
      if (!window.APRS) return;
      clearInterval(t);
      build();
      const a = window.APRS;
      a.on("aprs-packets", () => renderList());
      a.on("aprs-packet", (m) => {
        const p = m.packet;
        if (p && p.dir === "rx" && MSG_TYPES.has(p.type) && (!st.open || st.min)) unread++;
        renderList();
        sync();
      });
      a.on("aprs-status", sync);
      a.on("aprs-send-result", onResult);
      renderList();
      sync();
    }, 200);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
