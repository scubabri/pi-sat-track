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
  /** Expanded duplicate groups (first packet id); not persisted. */
  const expanded = new Set();
  /** Search text (lower case); session only. */
  let query = "";
  /** Everything a search can match in one packet. */
  function hay(p) {
    const tp = p.thirdParty || {};
    return [p.src, p.dst, p.gateway, tp.src, tp.dst, (tp.path || []).join(","), p.to, p.msgText, p.text, p.decoded, p.comment, p.device, (p.via || []).join(","), A() && A().pathText ? A().pathText(p) : "", p.tnc2, p.innerTnc2, connsOf(p).join(" "), p.digi && p.digi.by ? p.digi.by.join(",") : "", (p.echoDigis || []).join(",")]
      .filter((x) => x != null && x !== "")
      .join("\n")
      .toLowerCase();
  }
  function groupMatches(g) {
    return !query || g.copies.concat(g.echoes || []).some((p) => hay(p).includes(query));
  }
  /** Wrap search matches in <mark> (text nodes only). */
  function highlight(root) {
    if (!query || !document.createTreeWalker) return;
    const tw = document.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
    const nodes = [];
    while (tw.nextNode()) if (tw.currentNode.nodeValue.toLowerCase().includes(query)) nodes.push(tw.currentNode);
    nodes.forEach((n) => {
      const v = n.nodeValue;
      const lv = v.toLowerCase();
      const frag = document.createDocumentFragment();
      let i = 0;
      let j;
      while ((j = lv.indexOf(query, i)) >= 0) {
        if (j > i) frag.appendChild(document.createTextNode(v.slice(i, j)));
        const m = document.createElement("mark");
        m.className = "aprs-qhl";
        m.textContent = v.slice(j, j + query.length);
        frag.appendChild(m);
        i = j + query.length;
      }
      if (i < v.length) frag.appendChild(document.createTextNode(v.slice(i)));
      n.parentNode.replaceChild(frag, n);
    });
  }
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
        '<button type="button" class="aprs-win-clear" id="aprs-win-clear" title="Clear the packet list, heard stations and the digipeat log">Clear</button>',
    });
    win = w.el;
    delete w.st.tab; // old Messages / Packets tabs
    if (!MODES[w.st.mode]) w.st.mode = "text";
    if (!w.st.filters || typeof w.st.filters !== "object") w.st.filters = {};
    CATS.forEach(([k]) => {
      if (typeof w.st.filters[k] !== "boolean") w.st.filters[k] = true;
    });
    w.st.raw = w.st.raw === true;
    w.st.view = w.st.view === "digipeats" ? "digipeats" : "traffic";
    w.body.innerHTML =
      '<div class="aprs-win-search" role="search">' +
      '<input type="search" id="aprs-win-q" placeholder="Search call, text, path, device, raw…" spellcheck="false" autocomplete="off" aria-label="Search packets" title="Live filter (case-insensitive): call/SSID, third-party source/addressee, decoded text/comment, device, digipeater path, raw line. Esc clears." />' +
      '<button type="button" id="aprs-win-q-x" class="aprs-win-q-x" title="Clear search (Esc)" aria-label="Clear search" hidden>×</button>' +
      '<span class="aprs-win-q-n" id="aprs-win-q-n" aria-live="polite"></span>' +
      "</div>" +
      '<div class="aprs-win-filters" id="aprs-win-filters" role="group" aria-label="Show packet types">' +
      CATS.map(([k, v, tip]) => '<button type="button" class="aprs-chip c-' + k + '" data-cat="' + k + '" aria-pressed="true" title="' + esc(tip) + '">' + esc(v) + '<span class="aprs-chip-n" data-n="' + k + '"></span></button>').join("") +
      '<span class="aprs-filt-sp"></span>' +
      '<button type="button" class="aprs-chip aprs-raw" id="aprs-win-raw" aria-pressed="false" title="Also show the raw packet (CALL&gt;DEST,PATH:info)">Raw</button>' +
      '<button type="button" class="aprs-chip aprs-digi-view" id="aprs-win-digi" aria-pressed="false" title="Your packets heard back through a digipeater / satellite (kept across restarts)">Digipeats<span class="aprs-chip-n" id="aprs-win-digi-n"></span></button>' +
      '<a class="aprs-chip aprs-digi-csv" id="aprs-win-digi-csv" href="/api/aprs/digipeats.csv" download hidden title="Download the whole digipeat log as CSV">Export CSV</a>' +
      '<span class="aprs-win-zone" id="aprs-win-zone"></span>' +
      "</div>" +
      '<div class="aprs-win-list" id="aprs-win-list" aria-live="polite"></div>' +
      '<form class="aprs-win-send" id="aprs-win-send" autocomplete="off">' +
      '<div class="aprs-win-row aprs-hdr-row">' +
      '<label>To<input type="text" id="aprs-msg-to" maxlength="9" spellcheck="false" placeholder="CQ" title="AX.25 destination (UISS To:): CQ, APRS, BEACON, a callsign…" /></label>' +
      '<label>Via<input type="text" id="aprs-msg-via" spellcheck="false" placeholder="direct" title="Digipeater path (UISS Via:), up to 8, space or comma separated" /></label>' +
      '<a href="#" class="aprs-save-via" id="aprs-save-via" title="Use this Via by default for the selected satellite">save</a></div>' +
      '<div class="aprs-win-row aprs-mode-row" role="radiogroup" aria-label="Send type">' +
      Object.entries(MODES).map(([k, v]) => '<button type="button" role="radio" data-mode="' + k + '">' + v + "</button>").join("") +
      '<label class="aprs-for" id="aprs-for-wrap">For<input type="text" id="aprs-msg-for" maxlength="9" spellcheck="false" placeholder="CALL" title="APRS message addressee (UISS For:)" /></label>' +
      "</div>" +
      '<div class="aprs-win-row"><input type="text" id="aprs-msg-text" aria-label="Text" />' +
      '<span class="aprs-count" id="aprs-msg-count"></span>' +
      '<button type="submit" id="aprs-msg-send">Send</button></div>' +
      '<div class="aprs-route" id="aprs-msg-route" aria-live="polite" title="KISS connection this send uses"></div>' +
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
    // free-text search: live (debounced), not persisted
    const qEl = $("aprs-win-q");
    let qTimer = null;
    const setQuery = (v) => {
      query = String(v || "").trim().toLowerCase();
      $("aprs-win-q-x").hidden = !qEl.value;
      renderList();
    };
    qEl.addEventListener("input", () => {
      clearTimeout(qTimer);
      qTimer = setTimeout(() => setQuery(qEl.value), 150);
    });
    qEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        qEl.value = "";
        clearTimeout(qTimer);
        setQuery("");
      }
    });
    $("aprs-win-q-x").addEventListener("click", () => {
      qEl.value = "";
      setQuery("");
      qEl.focus();
    });
    $("aprs-win-digi").addEventListener("click", () => {
      w.st.view = w.st.view === "digipeats" ? "traffic" : "digipeats";
      w.save();
      renderList();
    });
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
    if (A() && A().combo) ["to", "via", "for"].forEach((f) => A().combo($("aprs-msg-" + f), f));
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
      if (r) return A() && A().pasteCall(r.getAttribute("data-call"), "for");
      // click a collapsed group (×N / echo badge or the row): expand / collapse its copies
      const g = e.target.closest && e.target.closest("[data-grp]");
      if (g && !(e.target.closest && e.target.closest("a, input, button:not([data-grp])"))) {
        const id = Number(g.getAttribute("data-grp"));
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);
        renderList();
      }
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
  let lastSendMs = 0;
  function sendMsg() {
    // accidental double click / Enter: ignore a second send within 1 s (no message)
    if (Date.now() - lastSendMs < 1000) return;
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
    lastSendMs = Date.now();
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
      showWhy("Sent " + hhmmss(Date.now()) + (r.packet && r.packet.conn ? " via " + r.packet.conn : "") + ": " + (r.packet ? r.packet.tnc2 : "") + as + (r.note ? " · Note: " + r.note : ""), true);
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
  /** Distinct iGates that gated a third-party group. */
  function gateways(g) {
    const out = [];
    (g.copies || [g.first]).forEach((c) => c.gateway && !out.includes(c.gateway) && out.push(c.gateway));
    return out;
  }
  function connsOf(p) {
    return Array.isArray(p.conns) && p.conns.length ? p.conns : p.conn ? [p.conn] : [];
  }
  function rawLine(p) {
    const via = (p.via || []).join(",");
    const c = connsOf(p);
    return '<div class="aprs-r-raw">' + (c.length ? '<span class="aprs-r-conn">[' + esc(c.join(" + ")) + "]</span> " : "") + esc(p.tnc2 || p.src + ">" + p.dst + (via ? "," + via : "") + ":") + "</div>";
  }
  /** One copy / echo inside an expanded group: time, path (used hops *), connection. */
  function copyRow(p, label) {
    const c = connsOf(p);
    return (
      '<div class="aprs-cp">' +
      '<span class="aprs-m-t">' + esc(bare(p.time)) + "</span>" +
      (label ? '<span class="aprs-cp-l">' + esc(label) + "</span>" : "") +
      (p.gateway ? '<span class="aprs-cp-l">iGate <b>' + esc(p.gateway) + "</b>" + (p.thirdParty ? " · inner " + esc(p.thirdParty.src + ">" + p.thirdParty.dst + (p.thirdParty.path.length ? "," + p.thirdParty.path.join(",") : "")) : "") + "</span>" : "") +
      '<span class="aprs-cp-path">' + esc(A() && A().pathText ? A().pathText(p) : (p.via || []).join(",")) + "</span>" +
      (c.length ? '<span class="aprs-r-conn">[' + esc(c.join(" + ")) + "]</span>" : "") +
      "</div>" +
      (w.st.raw ? rawLine(p) : "")
    );
  }
  function row(g) {
    const p = g.first;
    const tx = p.dir === "tx";
    const cat = catOf(p);
    const txt = decodedText(p, cat);
    const conns = connsOf(p);
    const n = g.copies.length;
    const sub = tx ? g.echoes : g.copies;
    const canExpand = tx ? sub.length > 0 : n > 1;
    const open = canExpand && expanded.has(g.id);
    const tip = (conns.length ? "[" + conns.join(" + ") + "] " : "") + p.tnc2 + (p.device ? "\nDevice: " + p.device : "") + (canExpand ? "\nClick to " + (open ? "collapse" : "show each copy") : "");
    const dt = tx && A() && A().digiText ? A().digiText(p.digi) : null;
    return (
      '<div class="aprs-r ' + (tx ? "sent" : "recv") + " c-" + cat + (p.ownEcho ? " echo" : "") + (canExpand ? " grp" : "") + (open ? " open" : "") + '"' + (canExpand ? ' data-grp="' + g.id + '"' : "") + ' title="' + esc(tip) + '">' +
      '<div class="aprs-r-main">' +
      '<span class="aprs-m-t">' + esc(bare(p.time)) + "</span>" +
      '<span class="aprs-r-dir">' + (tx ? "TX" : p.ownEcho ? "ECHO" : "RX") + "</span>" +
      symHtml(p) +
      callSpan(p.src, "aprs-m-from") +
      '<span class="aprs-badge c-' + cat + '" title="' + esc(p.type) + '">' + LABEL[cat] + "</span>" +
      (!tx && n > 1 ? '<button type="button" class="aprs-dup" data-grp="' + g.id + '" title="' + n + " copies within " + dupeS() + ' s (different paths / connections). Click to ' + (open ? "collapse" : "expand") + '">×' + n + "</button>" : "") +
      (p.viaSat ? '<span class="aprs-badge-sat" title="Digipeated by ' + esc(p.viaSat) + '">' + esc(p.viaSat) + "</span>" : "") +
      (tx && p.retry > 1 ? '<span class="aprs-retry" title="Retry ' + p.retry + (p.retryTagged ? ' (“ #' + p.retry + '” added to the comment / text)' : " (sent identical: retry number off)") + '">#' + p.retry + "</span>" : "") +
      (dt ? '<span class="aprs-digi ' + dt.cls + '"' + (sub.length ? ' data-grp="' + g.id + '"' : "") + ' title="' + esc(dt.text + (sub.length ? " · " + sub.length + " echo" + (sub.length > 1 ? "es" : "") + " heard, click to " + (open ? "hide" : "show") : "")) + '">' + (dt.cls === "ok" ? "✓ " : dt.cls === "none" ? "⚠ " : "… ") + esc(dt.text) + (sub.length ? " ×" + sub.length : "") + "</span>" : "") +
      (p.ownEcho && !tx ? '<span class="aprs-m-ok" title="Your packet was heard back">' + (p.echoDigis && p.echoDigis.length ? "✓ via " + esc(p.echoDigis.join(",")) : "own packet") + "</span>" : "") +
      '<span class="aprs-r-text">' + (txt ? esc(txt) : '<i class="aprs-m-hdr">(header only)</i>') + "</span>" +
      (p.gateway ? '<span class="aprs-r-igate" title="Third-party packet gated to RF by ' + esc(gateways(g).join(", ")) + (p.innerTnc2 ? "\n" + esc(p.innerTnc2) : "") + '">(via iGate ' + esc(gateways(g).join(", ")) + ")</span>" : "") +
      (p.device ? '<span class="aprs-r-dev">' + esc(p.device) + "</span>" : "") +
      "</div>" +
      (open
        ? '<div class="aprs-cps">' + sub.map((c, k) => copyRow(c, tx ? "echo " + (c.echoDigis && c.echoDigis.length ? "via " + c.echoDigis.join(",") : "") : "copy " + (k + 1))).join("") + "</div>"
        : w.st.raw
          ? rawLine(p)
          : "") +
      "</div>"
    );
  }
  function dupeS() {
    const c = A() && A().cfg;
    return (c && c.dupeWindowS) || 30;
  }
  function digiRow(e) {
    const t = Date.parse(e.time);
    const by = (e.digis || []).join(", ");
    return (
      '<div class="aprs-dg' + (e.viaSat ? " sat" : "") + '" title="' + esc(e.raw) + '">' +
      '<div class="aprs-r-main">' +
      '<span class="aprs-m-t">' + esc(A() && A().fmtTimeShort ? bare(t) : e.time) + "</span>" +
      (e.viaSat ? '<span class="aprs-badge-sat">SAT</span>' : '<span class="aprs-badge c-message">DIGI</span>') +
      '<span class="aprs-dg-by">' + (e.viaSat ? "Heard via " : "Digipeated by ") + "<b>" + esc(by) + "</b></span>" +
      (e.retry > 1 ? '<span class="aprs-retry" title="Retry number of the send">#' + e.retry + "</span>" : "") +
      (e.sat && e.viaSat ? '<span class="aprs-dg-sat">' + esc(e.sat) + (e.satEl != null ? " el " + e.satEl + "°" : "") + (e.satAboveHorizon === false ? " (below horizon)" : "") + "</span>" : "") +
      '<span class="aprs-r-conn">[' + esc(e.conn || "?") + "]</span>" +
      "</div>" +
      '<div class="aprs-dg-tx">' + esc(e.src + ">" + e.dst + (e.path ? "," + e.path : "") + ":" + e.info) + "</div>" +
      (w.st.raw ? '<div class="aprs-r-raw">' + esc(e.raw) + "</div>" : "") +
      "</div>"
    );
  }
  function renderList() {
    if (!win) return;
    const list = $("aprs-win-list");
    const pk = (A() && A().packets) || [];
    const groups = A() && A().groupPackets ? A().groupPackets(pk, dupeS()) : pk.map((p) => ({ id: p.id, first: p, last: p, copies: [p], echoes: [] }));
    const digi = w.st.view === "digipeats";
    const n = {};
    groups.forEach((g) => {
      const c = catOf(g.first);
      n[c] = (n[c] || 0) + 1;
    });
    win.querySelectorAll("[data-cat]").forEach((b) => {
      const on = !!w.st.filters[b.dataset.cat];
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.hidden = digi;
    });
    win.querySelectorAll("[data-n]").forEach((e) => (e.textContent = n[e.dataset.n] ? " " + n[e.dataset.n] : ""));
    const raw = $("aprs-win-raw");
    raw.classList.toggle("active", w.st.raw);
    raw.setAttribute("aria-pressed", w.st.raw ? "true" : "false");
    const db = $("aprs-win-digi");
    db.classList.toggle("active", digi);
    db.setAttribute("aria-pressed", digi ? "true" : "false");
    const dc = (A() && A().digipeatCount) || 0;
    $("aprs-win-digi-n").textContent = dc ? " " + dc : "";
    $("aprs-win-digi-csv").hidden = !digi;
    $("aprs-win-zone").textContent = A() && A().zoneLabel ? A().zoneLabel() : "UTC";
    const keep = list.scrollTop;
    const qn = $("aprs-win-q-n");
    if (digi) {
      const all = (A() && A().digipeats) || [];
      const d = query ? all.filter((e) => JSON.stringify(e).toLowerCase().includes(query)) : all;
      qn.textContent = query ? d.length + " of " + all.length : "";
      list.innerHTML = d.length
        ? d.slice(0, 300).map(digiRow).join("")
        : query && all.length
          ? '<div class="aprs-empty">No digipeats match “' + esc(query) + "”.</div>"
          : '<div class="aprs-empty">No digipeats yet. When one of your packets is heard back through a digipeater or satellite it is listed here (and kept in ~/.rpitrack/aprs/digipeats.jsonl).</div>';
    } else {
      const byType = groups.filter((g) => w.st.filters[catOf(g.first)]);
      const matched = byType.filter(groupMatches);
      qn.textContent = query ? matched.length + " of " + byType.length : "";
      const rows = matched.slice(0, 300);
      list.innerHTML = rows.length
        ? rows.map(row).join("")
        : '<div class="aprs-empty">' +
          (query && byType.length ? "No packets match “" + esc(query) + "”." : groups.length ? "Nothing matches the selected types (" + groups.length + " hidden)." : "No packets yet.") +
          "</div>";
    }
    highlight(list);
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
        const g = viaSat ? s.gateMessageSat || s.gateMessage : s.gateMessageDirect;
        // Like the APRS window: only a blocking / not-connected route and blocking
        // reasons. The TX connection is in the sidebar STATION panel ("APRS" line);
        // "TX via …" and non-blocking sat hints (below the horizon, mode) are not shown.
        const route = A().routeFor ? A().routeFor(viaEl.value) : null;
        const rtBad = !!(route && (!route.ok || !route.connected));
        const rt = $("aprs-msg-route");
        rt.innerHTML = rtBad && A().routeHtml ? A().routeHtml(route) : "";
        rt.hidden = !rtBad;
        rt.classList.toggle("blocked", rtBad);
        why.textContent = g && !g.ok ? g.reasons[0] || "" : "";
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
    if (o && o.view) {
      w.st.view = o.view === "digipeats" ? "digipeats" : "traffic";
      w.save();
      renderList();
    }
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
        if (p && p.dir === "rx" && catOf(p) === "message" && p.dupOf == null && !p.ownEcho && (!w.st.open || w.st.min)) unread++;
        renderList();
        sync();
      });
      a.on("aprs-status", sync);
      a.on("hdr", syncHdr);
      a.on("aprs-send-result", onResult);
      a.on("aprs-packet-dup", renderList);
      a.on("aprs-tx-update", renderList);
      a.on("aprs-digipeats", renderList);
      a.on("aprs-digipeat", renderList);
      a.on("time-mode", renderList);
      renderList();
      sync();
    }, 200);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
