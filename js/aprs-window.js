/**
 * Floating APRS Messages window (js/aprs-float.js chrome; position / open
 * state / tab / send type kept in localStorage "aprsWindow"). Opened from the
 * APRS window's Messages button.
 *
 *  - Messages: sent + received messages / status / UI text in one list
 *    (time, from > to, via, text; SENT vs RECEIVED, RS0ISS-digipeated
 *    flagged). Click a callsign: For (reply, like UISS's MHeard double-click);
 *    right-click: To / Via / For menu.
 *  - Packets: every packet (position reports first-class), newest first.
 *
 * Send form, modelled on UISS (ON6MU): one header To (AX.25 destination,
 * default CQ) + Via (path), shared with the APRS window, and a send type:
 *   UI text      info field sent as typed (UISS "Send UI Data")
 *   APRS message For: addressee + text -> ":ADDR     :text" (no ack)
 *   Header only  no info (UISS "Send UI Header")
 */
(function () {
  const LS = "aprsWindow";
  const MSG_TYPES = new Set(["message", "ack", "rej", "status", "other", "nmea"]);
  const MODES = { text: "UI text", message: "APRS message", header: "Header only" };
  let w = null;
  let win = null;
  let unread = 0;
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const A = () => window.APRS || null;
  const $ = (id) => win && win.querySelector("#" + id);
  function hhmmss(t) {
    const d = new Date(t);
    return [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map((n) => String(n).padStart(2, "0")).join(":") + "Z";
  }
  /** UISS max TX-data length (lib/aprs/build.js maxUiText). */
  function maxUiText(n) {
    return n === 0 ? 255 : Math.max(10, 80 - 10 * (n - 1));
  }
  const hops = (via) => String(via || "").split(/[\s,]+/).filter(Boolean);

  function build() {
    if (!window.aprsFloat) return false;
    w = window.aprsFloat.create({
      id: "aprs-window",
      cls: "aprs-msg-win",
      title: "APRS Messages",
      label: "APRS messages",
      lsKey: LS,
      width: 440,
      defaultX: (wd) => Math.max(8, window.innerWidth - wd - 380),
      defaultY: 90,
      headHtml:
        '<span class="aprs-win-tabs"><button type="button" data-tab="messages">Messages</button><button type="button" data-tab="packets">Packets</button></span>' +
        '<span class="aprs-win-kiss" id="aprs-win-kiss"></span>' +
        '<button type="button" class="aprs-win-clear" id="aprs-win-clear" title="Clear the packet list and heard stations">Clear</button>',
    });
    win = w.el;
    if (!w.st.tab) w.st.tab = "messages";
    if (!MODES[w.st.mode]) w.st.mode = "text";
    w.body.innerHTML =
      '<div class="aprs-win-list" id="aprs-win-list" aria-live="polite"></div>' +
      '<form class="aprs-win-send" id="aprs-win-send" autocomplete="off">' +
      '<div class="aprs-win-row aprs-hdr-row">' +
      '<label>To<input type="text" id="aprs-msg-to" list="aprs-dl-to" maxlength="9" spellcheck="false" placeholder="CQ" title="AX.25 destination (UISS To:): CQ, APRS, BEACON, a callsign…" /></label>' +
      '<label>Via<input type="text" id="aprs-msg-via" list="aprs-dl-via" spellcheck="false" placeholder="direct" title="Digipeater path (UISS Via:), up to 8, space or comma separated" /></label>' +
      '<a href="#" class="aprs-save-via" id="aprs-save-via" title="Use this Via by default for the selected satellite">save</a></div>' +
      '<div class="aprs-win-row aprs-mode-row" role="radiogroup" aria-label="Send type">' +
      Object.entries(MODES).map(([k, v]) => '<button type="button" role="radio" data-mode="' + k + '">' + v + "</button>").join("") +
      '<label class="aprs-for" id="aprs-for-wrap">For<input type="text" id="aprs-msg-for" list="aprs-dl-for" maxlength="9" spellcheck="false" placeholder="CALL" title="APRS message addressee (UISS For:)" /></label>' +
      "</div>" +
      '<div class="aprs-win-row"><input type="text" id="aprs-msg-text" aria-label="Text" />' +
      '<span class="aprs-count" id="aprs-msg-count"></span>' +
      '<button type="submit" id="aprs-msg-send">Send</button></div>' +
      '<div class="aprs-win-why" id="aprs-win-why" aria-live="polite"></div>' +
      "</form>";
    win.querySelectorAll(".aprs-win-tabs button").forEach((b) =>
      b.addEventListener("click", () => {
        w.st.tab = b.dataset.tab;
        w.save();
        renderList();
        sync();
      }),
    );
    win.querySelectorAll("[data-mode]").forEach((b) =>
      b.addEventListener("click", () => {
        setMode(b.dataset.mode);
        $("aprs-msg-" + (b.dataset.mode === "message" ? "for" : "text")).focus();
      }),
    );
    $("aprs-win-send").addEventListener("submit", (e) => {
      e.preventDefault();
      sendMsg();
    });
    $("aprs-msg-to").addEventListener("input", (e) => A() && A().setHdr({ to: e.target.value || null }, "win"));
    $("aprs-msg-via").addEventListener("input", (e) => {
      if (A()) A().setHdr({ via: e.target.value }, "win");
      $("aprs-win-why").dataset.result = "";
      sync();
    });
    $("aprs-msg-for").addEventListener("input", (e) => A() && A().setHdr({ for: e.target.value }, "win"));
    $("aprs-msg-text").addEventListener("input", syncCount);
    $("aprs-save-via").addEventListener("click", (e) => {
      e.preventDefault();
      const s = A() && A().status;
      if (!s || !s.sat) return showWhy("Select a satellite first", false);
      const via = $("aprs-msg-via").value.trim().toUpperCase();
      A().send({ type: "aprs-sat-path", sat: s.sat.key, via });
      A().setHdr({ via: null }, "win");
      showWhy("Default Via for " + (s.sat.name || s.sat.key) + " = " + (via || "(default)"), true);
    });
    $("aprs-win-clear").addEventListener("click", () => A() && A().send({ type: "aprs-clear" }));
    const list = $("aprs-win-list");
    list.addEventListener("click", (e) => {
      const r = e.target.closest && e.target.closest("[data-call]");
      if (r) A() && A().pasteCall(r.getAttribute("data-call"), "for");
    });
    list.addEventListener("contextmenu", (e) => {
      const r = e.target.closest && e.target.closest("[data-call]");
      if (!r || !A()) return;
      e.preventDefault();
      A().callMenu(r.getAttribute("data-call"), e.clientX, e.clientY);
    });
    w.onChange(() => {
      if (w.st.open && !w.st.min) unread = 0;
      renderList();
      sync();
    });
    return true;
  }

  function setMode(m) {
    w.st.mode = MODES[m] ? m : "text";
    w.save();
    sync();
  }
  function showWhy(text, ok) {
    const el = $("aprs-win-why");
    if (!el) return;
    el.textContent = text;
    el.title = text;
    el.className = "aprs-win-why " + (ok ? "ok" : "blocked");
    el.dataset.result = String(Date.now());
  }
  function sendMsg() {
    const kind = w.st.mode;
    const to = $("aprs-msg-to").value.trim().toUpperCase();
    const via = $("aprs-msg-via").value.trim().toUpperCase();
    const text = $("aprs-msg-text").value;
    const forCall = $("aprs-msg-for").value.trim().toUpperCase();
    if (kind === "message" && !forCall) return showWhy("Enter the addressee (For)", false);
    if (kind !== "header" && !text.trim()) return showWhy("Enter some text", false);
    const req = { type: "aprs-send", kind, to, via, reqId: Date.now() };
    if (kind !== "header") req.text = text;
    if (kind === "message") req.for = forCall;
    if (!A() || !A().send(req)) return showWhy("Not connected to the tracker server", false);
    showWhy("Sending…", true);
  }
  function onResult(r) {
    if (!win || !MODES[r.kind]) return;
    if (r.ok) {
      $("aprs-msg-text").value = "";
      syncCount();
      const t = r.packet ? r.packet.type : "";
      const as = r.kind === "text" ? (t === "other" ? " (plain text on APRS maps)" : t ? " (APRS sees: " + t + ")" : "") : "";
      showWhy("Sent " + hhmmss(Date.now()) + ": " + (r.packet ? r.packet.tnc2 : "") + as, true);
    } else showWhy((r.reasons || ["failed"]).join("; "), false);
  }

  function callSpan(call, cls) {
    return '<span class="' + cls + ' aprs-call" data-call="' + esc(call) + '" title="Click: message ' + esc(call) + ' (For). Right-click: To / Via / For">' + esc(call) + "</span>";
  }
  function rowMsg(p) {
    const tx = p.dir === "tx";
    const isMsg = p.type === "message" || p.type === "ack" || p.type === "rej";
    const text = p.type === "message" ? p.msgText : p.text;
    const via = (p.via || []).join(",");
    return (
      '<div class="aprs-m ' + (tx ? "sent" : "recv") + (p.ownEcho ? " echo" : "") + '">' +
      '<div class="aprs-m-meta"><span class="aprs-m-dir">' + (tx ? "SENT" : p.ownEcho ? "ECHO" : "RCVD") + "</span>" +
      '<span class="aprs-m-t">' + hhmmss(p.time) + "</span>" +
      callSpan(p.src, "aprs-m-from") +
      '<span class="aprs-m-arrow">&gt;</span><span class="aprs-m-dst" title="To (AX.25 destination)">' + esc(p.dst) + "</span>" +
      '<span class="aprs-m-via" title="Via">' + esc(via || "direct") + "</span>" +
      (p.viaSat ? '<span class="aprs-badge-sat" title="Digipeated by ' + esc(p.viaSat) + '">' + esc(p.viaSat) + "</span>" : "") +
      (isMsg && p.to ? '<span class="aprs-m-for" title="APRS message addressee (For)">→ ' + esc(p.to) + "</span>" : "") +
      (p.ownEcho ? '<span class="aprs-m-ok" title="Your packet was heard back">✓ digipeated</span>' : "") +
      "</div>" +
      '<div class="aprs-m-text">' + (text ? esc(p.type === "ack" || p.type === "rej" ? p.text : text) : '<i class="aprs-m-hdr">(header only)</i>') + "</div></div>"
    );
  }
  function rowPkt(p) {
    const tx = p.dir === "tx";
    const pos = p.lat != null ? (p.posSource === "grid" ? "grid " + (p.grid || "") : "pos") : p.plotSource ? p.plotSource : "";
    return (
      '<div class="aprs-p ' + (tx ? "sent" : "recv") + " t-" + esc(p.type) + '" title="' + esc(p.tnc2) + '">' +
      '<span class="aprs-m-t">' + hhmmss(p.time) + "</span>" +
      '<span class="aprs-p-dir">' + (tx ? "TX" : "RX") + "</span>" +
      callSpan(p.src, "aprs-m-from") +
      (p.viaSat ? '<span class="aprs-badge-sat">' + esc(p.viaSat) + "</span>" : "") +
      '<span class="aprs-p-type">' + esc(p.type === "other" && !p.text ? "header" : p.type) + (pos ? " · " + esc(pos) : "") + "</span>" +
      '<span class="aprs-p-text">' + esc(p.text) + "</span></div>"
    );
  }
  function renderList() {
    if (!win) return;
    const list = $("aprs-win-list");
    const pk = (A() && A().packets) || [];
    const msgs = w.st.tab === "messages";
    const rows = msgs ? pk.filter((p) => MSG_TYPES.has(p.type)).slice(0, 150).reverse() : pk.slice(0, 200);
    list.innerHTML = rows.length
      ? rows.map(msgs ? rowMsg : rowPkt).join("")
      : '<div class="aprs-empty">' + (msgs ? "No messages yet. Position reports are under Packets and on the map." : "No packets yet.") + "</div>";
    list.scrollTop = msgs ? list.scrollHeight : 0;
  }
  function syncCount() {
    const t = $("aprs-msg-text");
    const mode = w.st.mode;
    const n = hops($("aprs-msg-via").value).length;
    const max = mode === "message" ? 67 : maxUiText(n);
    t.maxLength = max;
    t.disabled = mode === "header";
    t.placeholder =
      mode === "message" ? "Message text (max 67, no ack)" : mode === "header" ? "Header only: no text is sent" : "Text sent as typed, e.g. >Hello all or >DN40aq 73 (max " + max + ")";
    $("aprs-msg-count").textContent = mode === "header" ? "" : t.value.length + "/" + max;
  }
  function syncHdr() {
    if (!win || !A()) return;
    const a = A();
    const set = (id, v) => {
      const el = $(id);
      if (el && document.activeElement !== el) el.value = v == null ? "" : v;
    };
    set("aprs-msg-to", a.getTo());
    set("aprs-msg-via", a.getVia());
    set("aprs-msg-for", a.hdr.for || "");
    syncCount();
  }
  function sync() {
    if (!win) return;
    win.querySelectorAll(".aprs-win-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === w.st.tab));
    $("aprs-win-send").hidden = w.st.tab !== "messages";
    win.querySelectorAll("[data-mode]").forEach((b) => {
      const on = b.dataset.mode === w.st.mode;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
    });
    $("aprs-for-wrap").hidden = w.st.mode !== "message";
    $("aprs-msg-send").textContent = w.st.mode === "header" ? "Send header" : "Send";
    syncHdr();
    const s = A() && A().status;
    const k = $("aprs-win-kiss");
    const state = s ? (s.enabled ? s.state : "off") : "off";
    k.className = "aprs-win-kiss kiss-" + state;
    k.textContent = s && A().statusText ? A().statusText(s).replace(/^KISS /, "") : "";
    if (s) {
      const viaEl = $("aprs-msg-via");
      const why = $("aprs-win-why");
      if (!why.dataset.result || Date.now() - Number(why.dataset.result) > 8000) {
        why.dataset.result = "";
        // Same rule as the server (lib/aprs/service.js isSatPath): any non-WIDEn-N/RELAY/TRACE hop.
        const viaSat = hops(viaEl.value).some((h) => !/^(WIDE\d?|RELAY|TRACE\d?|TEMP\d?)(-\d{1,2})?$/i.test(h));
        const g = viaSat ? s.gateMessage : s.gateMessageDirect;
        why.textContent = g && !g.ok ? g.reasons[0] : "";
        why.title = g ? g.reasons.join("\n") : "";
        why.className = "aprs-win-why" + (g && !g.ok ? " blocked" : "");
        $("aprs-msg-send").disabled = !!(g && !g.ok);
        $("aprs-msg-send").title = g && !g.ok ? g.reasons.join("\n") : "Send as " + (s.source || "?") + ">" + ($("aprs-msg-to").value || "CQ") + (viaEl.value ? "," + viaEl.value : "");
      }
      const sv = $("aprs-save-via");
      sv.hidden = !s.sat;
      if (s.sat) sv.title = "Use this Via by default for " + (s.sat.name || s.sat.key);
    }
    const n = unread ? String(unread) : "";
    ["aprs-unread", "aprs-btn-unread"].forEach((id) => {
      const b = document.getElementById(id);
      if (b) {
        b.hidden = !unread;
        b.textContent = n;
      }
    });
  }
  function open(o) {
    if (!win && !build()) return;
    if (o && o.for) {
      w.st.tab = "messages";
      setMode("message");
      if (A()) A().setHdr({ for: o.for }, "open");
    }
    unread = 0;
    w.open();
    if (o && o.for) $("aprs-msg-text").focus();
  }
  window.aprsWindow = {
    open,
    close: () => w && w.close(),
    toggle: () => (w && w.st.open && !w.st.min ? w.close() : open()),
    isOpen: () => !!(w && w.st.open),
  };

  function init() {
    const t = setInterval(() => {
      if (!window.APRS || !window.aprsFloat) return;
      clearInterval(t);
      build();
      const a = window.APRS;
      a.on("aprs-packets", () => renderList());
      a.on("aprs-packet", (m) => {
        const p = m.packet;
        if (p && p.dir === "rx" && MSG_TYPES.has(p.type) && (!w.st.open || w.st.min)) unread++;
        renderList();
        sync();
      });
      a.on("aprs-status", sync);
      a.on("hdr", syncHdr);
      a.on("aprs-send-result", onResult);
      renderList();
      sync();
    }, 200);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
