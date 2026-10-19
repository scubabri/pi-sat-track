/**
 * Floating APRS Messages window (js/aprs-float.js chrome; position / open
 * state / tab / send type kept in localStorage "aprsWindow"). Opened from the
 * APRS window's Messages button.
 *
 *  - One decoded traffic list, newest first: time (app UTC | local toggle),
 *    RX/TX, symbol, call, type badge and the decoded text (position +
 *    cleaned comment, status, "→ ADDR: text", weather...). Sent items too.
 *  - Type filter chips (Messages, Positions, Status/Beacons, Objects/Items,
 *    Weather, Telemetry, Other; all on by default) and an opt-in Raw toggle
 *    that adds the raw CALL>DEST,PATH:info line; kept in localStorage.
 *  - Click a callsign: For (reply, like UISS's MHeard double-click);
 *    right-click: To / Via / For menu.
 *  - Resizable (edges / bottom corners); size kept with the position.
 *
 * Send form, modelled on UISS (ON6MU): one header To (AX.25 destination,
 * default CQ) + Via (path), shared with the APRS window, and a send type:
 *   UI text      info field sent as typed (UISS "Send UI Data")
 *   APRS message For: addressee + text -> ":ADDR     :text" (no ack)
 *   Header only  no info (UISS "Send UI Header")
 */
(function () {
  const LS = "aprsWindow";
  /** Filter chips, in display order (category ids from lib/aprs/describe.js). */
  const CATS = [
    ["message", "Messages", "APRS messages, acks, UI text and what you sent"],
    ["position", "Positions", "Position reports incl. Mic-E and NMEA"],
    ["status", "Status/Beacons", "Status reports and plain-text beacons"],
    ["object", "Objects/Items", "APRS objects and items"],
    ["weather", "Weather", "Weather reports"],
    ["telemetry", "Telemetry", "Telemetry (T#, PARM/UNIT/EQNS/BITS)"],
    ["other", "Other", "Anything else (unknown formats, header-only frames)"],
  ];
  const LABEL = { message: "MSG", position: "POS", status: "STATUS", object: "OBJ", weather: "WX", telemetry: "TLM", other: "OTHER" };
  /** Category for a packet record (server sets p.category; fallback for old ones). */
  function catOf(p) {
    if (p.category) return p.category;
    if (p.dir === "tx" && (p.kind === "text" || p.kind === "header" || p.kind === "message")) return "message";
    const t = p.type;
    if (t === "message" || t === "ack" || t === "rej") return "message";
    if (t === "position" || t === "mic-e" || t === "nmea") return "position";
    if (t === "object" || t === "item") return "object";
    if (t === "weather" || t === "telemetry" || t === "status") return t;
    return p.text ? "status" : "other";
  }
  const MODES = { text: "UI text", message: "APRS message", header: "Header only" };
  let w = null;
  let win = null;
  let unread = 0;
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const A = () => window.APRS || null;
  const $ = (id) => win && win.querySelector("#" + id);
  /** "HH:MM:SS UTC" / "HH:MM:SS MT", following the app's UTC | local toggle. */
  function hhmmss(t) {
    if (A() && A().fmtTime) return A().fmtTime(t);
    const d = new Date(t);
    return [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map((n) => String(n).padStart(2, "0")).join(":") + " UTC";
  }
  const bare = (t) => hhmmss(t).replace(/ (UTC|MT)$/, "");
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
      width: 460,
      minW: 340,
      minH: 260,
      defaultX: (wd) => Math.max(8, window.innerWidth - wd - 380),
      defaultY: 90,
      headHtml:
        '<span class="aprs-win-kiss" id="aprs-win-kiss"></span>' +
        '<button type="button" class="aprs-win-clear" id="aprs-win-clear" title="Clear the packet list and heard stations">Clear</button>',
    });
    win = w.el;
    delete w.st.tab; // old Messages / Packets tabs
    if (!MODES[w.st.mode]) w.st.mode = "text";
    if (!w.st.filters || typeof w.st.filters !== "object") w.st.filters = {};
    CATS.forEach(([k]) => {
      if (typeof w.st.filters[k] !== "boolean") w.st.filters[k] = true;
    });
    w.st.raw = w.st.raw === true;
    w.body.innerHTML =
      '<div class="aprs-win-filters" id="aprs-win-filters" role="group" aria-label="Show packet types">' +
      CATS.map(([k, v, tip]) => '<button type="button" class="aprs-chip c-' + k + '" data-cat="' + k + '" aria-pressed="true" title="' + esc(tip) + '">' + esc(v) + '<span class="aprs-chip-n" data-n="' + k + '"></span></button>').join("") +
      '<span class="aprs-filt-sp"></span>' +
      '<button type="button" class="aprs-chip aprs-raw" id="aprs-win-raw" aria-pressed="false" title="Also show the raw packet (CALL&gt;DEST,PATH:info)">Raw</button>' +
      '<span class="aprs-win-zone" id="aprs-win-zone"></span>' +
      "</div>" +
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
    win.querySelectorAll("[data-cat]").forEach((b) =>
      b.addEventListener("click", (e) => {
        const k = b.dataset.cat;
        if (e.shiftKey || e.altKey) CATS.forEach(([c]) => (w.st.filters[c] = c === k)); // solo
        else w.st.filters[k] = !w.st.filters[k];
        if (!CATS.some(([c]) => w.st.filters[c])) CATS.forEach(([c]) => (w.st.filters[c] = true));
        w.save();
        renderList();
      }),
    );
    $("aprs-win-raw").addEventListener("click", () => {
      w.st.raw = !w.st.raw;
      w.save();
      renderList();
    });
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
  function symHtml(p) {
    const S = window.APRS_SYMBOLS;
    return p.symbol && S && S.parse(p.symbol) ? S.html(p.symbol, 16, "aprs-row-sym") : '<span class="aprs-row-sym aprs-row-nosym"></span>';
  }
  function decodedText(p, cat) {
    if (p.type === "message" && p.dir === "tx") return "→ " + (p.to || "") + ": " + (p.msgText || "");
    if (p.dir === "tx" && cat === "message") return p.kind === "header" || !(p.text || "").trim() ? "" : p.text;
    if (p.decoded != null && p.decoded !== "") return p.decoded;
    if (p.type === "message") return "→ " + (p.to || "") + ": " + (p.msgText || "");
    return p.text || "";
  }
  function row(p) {
    const tx = p.dir === "tx";
    const cat = catOf(p);
    const txt = decodedText(p, cat);
    const via = (p.via || []).join(",");
    const tip = p.tnc2 + (p.device ? "\nDevice: " + p.device : "");
    return (
      '<div class="aprs-r ' + (tx ? "sent" : "recv") + " c-" + cat + (p.ownEcho ? " echo" : "") + '" title="' + esc(tip) + '">' +
      '<div class="aprs-r-main">' +
      '<span class="aprs-m-t">' + esc(bare(p.time)) + "</span>" +
      '<span class="aprs-r-dir">' + (tx ? "TX" : "RX") + "</span>" +
      symHtml(p) +
      callSpan(p.src, "aprs-m-from") +
      '<span class="aprs-badge c-' + cat + '" title="' + esc(p.type) + '">' + LABEL[cat] + "</span>" +
      (p.viaSat ? '<span class="aprs-badge-sat" title="Digipeated by ' + esc(p.viaSat) + '">' + esc(p.viaSat) + "</span>" : "") +
      (p.ownEcho ? '<span class="aprs-m-ok" title="Your packet was heard back">✓ digipeated</span>' : "") +
      '<span class="aprs-r-text">' + (txt ? esc(txt) : '<i class="aprs-m-hdr">(header only)</i>') + "</span>" +
      (p.device ? '<span class="aprs-r-dev">' + esc(p.device) + "</span>" : "") +
      "</div>" +
      (w.st.raw ? '<div class="aprs-r-raw">' + esc(p.tnc2 || p.src + ">" + p.dst + (via ? "," + via : "") + ":") + "</div>" : "") +
      "</div>"
    );
  }
  function renderList() {
    if (!win) return;
    const list = $("aprs-win-list");
    const pk = (A() && A().packets) || [];
    const n = {};
    pk.forEach((p) => {
      const c = catOf(p);
      n[c] = (n[c] || 0) + 1;
    });
    win.querySelectorAll("[data-cat]").forEach((b) => {
      const on = !!w.st.filters[b.dataset.cat];
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    win.querySelectorAll("[data-n]").forEach((e) => (e.textContent = n[e.dataset.n] ? " " + n[e.dataset.n] : ""));
    const raw = $("aprs-win-raw");
    raw.classList.toggle("active", w.st.raw);
    raw.setAttribute("aria-pressed", w.st.raw ? "true" : "false");
    $("aprs-win-zone").textContent = A() && A().zoneLabel ? A().zoneLabel() : "UTC";
    const rows = pk.filter((p) => w.st.filters[catOf(p)]).slice(0, 300);
    const keep = list.scrollTop;
    list.innerHTML = rows.length
      ? rows.map(row).join("")
      : '<div class="aprs-empty">' + (pk.length ? "Nothing matches the selected types (" + pk.length + " hidden)." : "No packets yet.") + "</div>";
    list.scrollTop = keep > 4 ? keep : 0;
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
        // Same rule as the server (lib/aprs/service.js isSatPath): a known satellite digipeater hop.
        const viaSat = !!(A().viaIsSat && A().viaIsSat(viaEl.value));
        const g = viaSat ? s.gateMessage : s.gateMessageDirect;
        const hint = g && g.ok && viaSat && g.hints && g.hints[0] ? g.hints[0] : "";
        why.textContent = g && !g.ok ? g.reasons[0] : hint;
        why.title = g ? g.reasons.concat(viaSat ? g.hints || [] : []).join("\n") : "";
        why.className = "aprs-win-why" + (g && !g.ok ? " blocked" : hint ? " hint" : "");
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
        if (p && p.dir === "rx" && catOf(p) === "message" && (!w.st.open || w.st.min)) unread++;
        renderList();
        sync();
      });
      a.on("aprs-status", sync);
      a.on("hdr", syncHdr);
      a.on("aprs-send-result", onResult);
      a.on("time-mode", renderList);
      renderList();
      sync();
    }, 200);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
