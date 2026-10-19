/**
 * KISS / APRS: shared client hub (window.APRS) + Configure → "KISS / APRS" tab.
 *
 * window.APRS keeps the latest server messages (aprs-status / aprs-packets /
 * aprs-packet / aprs-heard / aprs-send-result / aprs-test-result) and lets
 * js/aprs-overlay.js (map box + heard layer) and js/aprs-window.js (floating
 * messages / packets window) subscribe with APRS.on(type, fn).
 *
 * Settings live per profile under profile.config.aprs (server normalises);
 * the tab is filled from the "profiles" message and saved with the dialog's
 * Save button as a separate {type:"aprs-config"} message.
 */
(function () {
  const PRESET_PORTS = { graywolf: 6700, direwolf: 8001 };
  const listeners = {};
  const APRS = {
    cfg: null,
    status: null,
    packets: [],
    heard: null,
    on(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    emit(type, msg) {
      (listeners[type] || []).forEach((fn) => {
        try {
          fn(msg);
        } catch (e) {
          console.warn("APRS listener", type, e);
        }
      });
    },
    send(obj) {
      if (typeof ws === "undefined" || !ws || ws.readyState !== 1) return false;
      ws.send(JSON.stringify(obj));
      return true;
    },
  };
  window.APRS = APRS;

  /* ---------- UISS-style TX header + history ----------
   * One To (AX.25 destination) / Via (path) header shared by the APRS window
   * (Send position) and the Messages window (UI text, APRS message, header),
   * like UISS's single To: / Via: boxes. null = follow the default (To from
   * Configure, Via per satellite); "" Via = direct. History like UISS:
   * To 15, Via 15, For 10 entries, newest first, saved in localStorage. */
  const LS_HDR = "aprsTxHdr";
  const LS_HIST = "aprsHistory";
  const HIST_MAX = { to: 15, via: 15, for: 10 };
  const loadJson = (k, d) => {
    try {
      const v = JSON.parse(localStorage.getItem(k) || "null");
      return v && typeof v === "object" ? Object.assign(d, v) : d;
    } catch (_) {
      return d;
    }
  };
  APRS.hdr = loadJson(LS_HDR, { to: null, via: null, for: "" });
  APRS.hist = loadJson(LS_HIST, { to: [], via: [], for: [] });
  const up = (v) => String(v == null ? "" : v).trim().toUpperCase();
  /** Satellite Via? Mirror of SAT_DIGIS / isSatPath in lib/aprs/service.js: a
   * known sat digipeater hop; WIDEn-N, RELAY, TRACE and other calls are terrestrial. */
  APRS.viaIsSat = (via) =>
    String(via || "")
      .split(/[\s,]+/)
      .filter(Boolean)
      .some((h) => /^(RS0ISS|NA1SS|ARISS|APRSAT|DP0SNX|W3ADO|PCSAT|YB0X|PSAT2?|9A0CC|HA2GRB|HS0K|OK0KST|OK0LSR|OM9MAR)(-\d{1,2})?\*?$/i.test(h));
  APRS.getTo = () => (APRS.hdr.to != null && APRS.hdr.to !== "" ? APRS.hdr.to : (APRS.status && APRS.status.defaultTo) || "CQ");
  APRS.getVia = () => (APRS.hdr.via != null ? APRS.hdr.via : (APRS.status && APRS.status.defaultVia) || "ARISS");
  APRS.setHdr = (patch, origin) => {
    for (const k of ["to", "via", "for"]) if (patch && k in patch) APRS.hdr[k] = patch[k] == null ? null : up(patch[k]);
    try {
      localStorage.setItem(LS_HDR, JSON.stringify(APRS.hdr));
    } catch (_) {}
    APRS.emit("hdr", { origin: origin || "" });
  };
  APRS.remember = (field, value) => {
    const v = up(value);
    const list = APRS.hist[field] || (APRS.hist[field] = []);
    if (field !== "via" && !v) return;
    const i = list.indexOf(v);
    if (i >= 0) list.splice(i, 1);
    list.unshift(v);
    list.length = Math.min(list.length, HIST_MAX[field] || 10);
    try {
      localStorage.setItem(LS_HIST, JSON.stringify(APRS.hist));
    } catch (_) {}
    refreshDatalists();
  };
  /** History first, then presets (UISS "reset to defaults" values), deduplicated. */
  APRS.choices = (field) => {
    const st = APRS.status || {};
    const pre = (st.presets && st.presets[field]) || (field === "to" ? ["CQ", "APRS", "APRSAT", "BEACON", "APZPST"] : field === "via" ? ["ARISS", "RS0ISS", "APRSAT", "WIDE2-1"] : []);
    const extra = field === "via" ? [st.defaultVia || ""] : field === "to" ? [st.defaultTo || ""] : [];
    const out = [];
    for (const v of [].concat(APRS.hist[field] || [], extra, pre)) {
      if (v && !out.includes(v)) out.push(v);
    }
    return out;
  };
  function refreshDatalists() {
    if (!document.body) return;
    for (const f of ["to", "via", "for"]) {
      let dl = document.getElementById("aprs-dl-" + f);
      if (!dl) {
        dl = document.createElement("datalist");
        dl.id = "aprs-dl-" + f;
        document.body.appendChild(dl);
      }
      const html = APRS.choices(f).map((v) => '<option value="' + v.replace(/"/g, "") + '"></option>').join("");
      if (dl.innerHTML !== html) dl.innerHTML = html;
    }
  }
  APRS.refreshDatalists = refreshDatalists;
  /** UISS MHeard "paste into To: / Via: / For:" for a heard callsign. */
  APRS.pasteCall = (call, field) => {
    const c = up(call);
    if (!c) return;
    if (field === "for") {
      APRS.setHdr({ for: c }, "paste");
      if (window.aprsWindow) window.aprsWindow.open({ for: c });
    } else if (field === "to" || field === "via") {
      APRS.setHdr({ [field]: c }, "paste");
    }
    APRS.emit("paste", { call: c, field });
  };
  let menu = null;
  /** Small right-click menu like UISS's MHeard list: put CALL in To / Via / For. */
  APRS.callMenu = (call, x, y) => {
    if (!menu) {
      menu = document.createElement("div");
      menu.className = "aprs-call-menu";
      menu.setAttribute("role", "menu");
      document.body.appendChild(menu);
      menu.addEventListener("click", (e) => {
        const b = e.target.closest && e.target.closest("[data-paste]");
        if (!b) return;
        e.preventDefault();
        APRS.pasteCall(menu.dataset.call, b.getAttribute("data-paste"));
        menu.hidden = true;
      });
      document.addEventListener("pointerdown", (e) => {
        if (menu && !menu.contains(e.target)) menu.hidden = true;
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && menu) menu.hidden = true;
      });
    }
    const c = up(call);
    menu.dataset.call = c;
    menu.innerHTML =
      '<div class="aprs-cm-h">' + c.replace(/[<>&"]/g, "") + "</div>" +
      '<button type="button" data-paste="for" role="menuitem">Message (For: ' + c.replace(/[<>&"]/g, "") + ")</button>" +
      '<button type="button" data-paste="to" role="menuitem">Put in To:</button>' +
      '<button type="button" data-paste="via" role="menuitem">Put in Via:</button>';
    menu.hidden = false;
    menu.style.left = Math.max(4, Math.min(window.innerWidth - 190, x)) + "px";
    menu.style.top = Math.max(4, Math.min(window.innerHeight - 120, y)) + "px";
  };

  function onMessage(msg) {
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "profiles") {
      const c = msg.config && msg.config.aprs;
      if (c && typeof c === "object") {
        APRS.cfg = c;
        APRS._cfgJson = JSON.stringify(c);
      }
      const panel = document.getElementById("config-panel");
      if (!panel || !panel.classList.contains("open")) fillTab(APRS.cfg);
      APRS.emit("cfg", APRS.cfg);
      return;
    }
    if (msg.type.indexOf("aprs-") !== 0) return;
    if (msg.type === "aprs-status") {
      const prevSat = APRS.status && APRS.status.sat ? APRS.status.sat.key : undefined;
      APRS.status = msg;
      const satKey = msg.sat ? msg.sat.key : null;
      // New satellite: Via follows its default again (UISS keeps one Via box; we re-default per sat).
      if (prevSat !== undefined && prevSat !== satKey && APRS.hdr.via != null) APRS.setHdr({ via: null }, "sat");
      refreshDatalists();
      // The live (normalised) config rides on every status, so a client that
      // hooked the socket after the first "profiles" message still has it.
      if (msg.config && typeof msg.config === "object") {
        const j = JSON.stringify(msg.config);
        if (j !== APRS._cfgJson) {
          APRS._cfgJson = j;
          APRS.cfg = msg.config;
          const panel = document.getElementById("config-panel");
          if (!panel || !panel.classList.contains("open")) fillTab(APRS.cfg);
          APRS.emit("cfg", APRS.cfg);
        }
      }
      showStatus(msg);
    } else if (msg.type === "aprs-packets") {
      APRS.packets = Array.isArray(msg.packets) ? msg.packets : [];
    } else if (msg.type === "aprs-packet" && msg.packet) {
      APRS.packets.unshift(msg.packet);
      if (APRS.packets.length > 300) APRS.packets.length = 300;
    } else if (msg.type === "aprs-tx-update") {
      const p = APRS.packets.find((x) => x.id === msg.id);
      if (p) p.digi = msg.digi;
      if (APRS.status && APRS.status.lastTx && APRS.status.lastTx.id === msg.id) APRS.status.lastTx.digi = msg.digi;
    } else if (msg.type === "aprs-digipeats") {
      APRS.digipeats = Array.isArray(msg.entries) ? msg.entries : [];
      APRS.digipeatCount = msg.count || APRS.digipeats.length;
    } else if (msg.type === "aprs-digipeat" && msg.entry) {
      APRS.digipeats.unshift(msg.entry);
      APRS.digipeatCount = msg.count || APRS.digipeats.length;
    } else if (msg.type === "aprs-packet-dup") {
      // same packet heard on another KISS connection: one row, both names
      const p = APRS.packets.find((x) => x.id === msg.id);
      if (p && Array.isArray(msg.conns)) p.conns = msg.conns;
    } else if (msg.type === "aprs-heard") {
      APRS.heard = msg;
    } else if (msg.type === "aprs-test-result") {
      showTest(msg);
    } else if (msg.type === "aprs-send-result" && msg.ok && msg.packet) {
      const p = msg.packet;
      APRS.remember("to", p.dst);
      APRS.remember("via", (p.via || []).map((v) => v.replace(/\*$/, "")).join(","));
      if (p.type === "message" && p.to) APRS.remember("for", p.to);
    }
    APRS.emit(msg.type, msg);
  }

  APRS.digipeats = APRS.digipeats || [];
  APRS.digipeatCount = APRS.digipeatCount || 0;
  APRS.__feed = onMessage; // tests / debugging

  /* ---------- times: follow the app's UTC | local toggle (js/pass-ui.js) ---------- */
  const isUtc = () => (typeof isUtcTimeMode === "function" ? isUtcTimeMode() : (localStorage.getItem("satTrackerTimeMode") || "utc") === "utc");
  const two = (n) => String(n).padStart(2, "0");
  /** "21:48:52 UTC" / "15:48:52 MT", same as the AOS/LOS times. */
  APRS.fmtTime = (t) => {
    if (typeof formatPassTime === "function" && typeof isUtcTimeMode === "function") return formatPassTime(t);
    const d = new Date(t);
    if (isUtc()) return two(d.getUTCHours()) + ":" + two(d.getUTCMinutes()) + ":" + two(d.getUTCSeconds()) + " UTC";
    return two(d.getHours()) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds()) + " MT";
  };
  /** "21:48 UTC" / "15:48 MT" (chart / popup style). */
  APRS.fmtTimeShort = (t) => {
    if (typeof formatClockShort === "function" && typeof isUtcTimeMode === "function") return formatClockShort(t);
    const d = new Date(t);
    if (isUtc()) return two(d.getUTCHours()) + ":" + two(d.getUTCMinutes()) + " UTC";
    return two(d.getHours()) + ":" + two(d.getMinutes()) + " MT";
  };
  /** Time without the zone (list rows); zone shown once in the window header. */
  APRS.fmtClock = (t) => APRS.fmtTime(t).replace(/ (UTC|MT)$/, "");
  /** Open Configure on the KISS / APRS tab. */
  APRS.openKissConfig = () => {
    const panel = document.getElementById("config-panel");
    const btn = document.getElementById("btn-config");
    if (panel && !panel.classList.contains("open") && btn) btn.click();
    const tab = document.querySelector('#config-panel .cfg-tab[data-tab="kiss"]');
    if (tab) tab.click();
  };
  APRS.zoneLabel = () => (isUtc() ? "UTC" : "MT");
  if (typeof window.addEventListener === "function") window.addEventListener("time-mode-change", () => APRS.emit("time-mode", {}));

  /* ---------- symbol picker (Configure → KISS / APRS → Map symbol) ----------
   * Stores the 2-char table+code in the hidden #cfg-kiss-symbol (e.g. "/`").
   * Common symbols first, then the full primary and alternate tables;
   * search by name or code. Alternate symbols may carry an overlay char. */
  const SYM = () => window.APRS_SYMBOLS || null;
  function symEsc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }
  function syncSymbolField() {
    const S = SYM();
    const b = document.getElementById("cfg-kiss-symbol-btn");
    const h = document.getElementById("cfg-kiss-symbol");
    if (!S || !b || !h) return;
    const v = h.value || "/`";
    b.innerHTML = S.html(v, 24) + '<span class="aprs-sym-name">' + symEsc(S.name(v) || v) + "</span><code>" + symEsc(v) + '</code><span class="aprs-sym-caret">▾</span>';
    const p = S.parse(v);
    const ov = document.getElementById("cfg-kiss-symbol-ov");
    if (ov && document.activeElement !== ov) {
      ov.value = p && p.overlay ? p.overlay : "";
      ov.disabled = !p || p.table !== 1;
    }
    renderSymbolList();
  }
  function renderSymbolList() {
    const S = SYM();
    const list = document.getElementById("cfg-kiss-symbol-list");
    const pop = document.getElementById("cfg-kiss-symbol-pop");
    if (!S || !list || !pop || pop.hidden) return;
    const q = (document.getElementById("cfg-kiss-symbol-q").value || "").trim().toLowerCase();
    const cur = document.getElementById("cfg-kiss-symbol").value || "/`";
    const curP = S.parse(cur);
    const curBase = curP ? (curP.table ? "\\" : "/") + curP.code : cur;
    const opt = (sym) =>
      '<button type="button" class="aprs-sym-opt' + (sym === curBase ? " sel" : "") + '" role="option" aria-selected="' + (sym === curBase) + '" data-sym="' + symEsc(sym) + '" title="' + symEsc(S.name(sym) + "  " + sym) + '">' +
      S.html(sym, 24) + '<span>' + symEsc(S.name(sym)) + "</span></button>";
    const match = (e) => !q || e.name.toLowerCase().includes(q) || e.sym.toLowerCase() === q;
    const sec = (title, items) => (items.length ? '<div class="aprs-sym-sec">' + title + '</div><div class="aprs-sym-grid">' + items.map(opt).join("") + "</div>" : "");
    const common = S.COMMON.map((s) => ({ sym: s, name: S.name(s) })).filter(match).map((e) => e.sym);
    const prim = S.list("/").filter(match).map((e) => e.sym);
    const alt = S.list("\\").filter(match).map((e) => e.sym);
    list.innerHTML =
      (q ? "" : sec("Common", common)) +
      sec(q ? "Primary table ( / )" : "Primary table ( / )", prim) +
      sec("Alternate table ( \\ )", alt) ||
      '<div class="aprs-sym-none">No symbol matches “' + symEsc(q) + "”</div>";
  }
  function setSymbol(sym) {
    const h = document.getElementById("cfg-kiss-symbol");
    if (!h) return;
    h.value = sym;
    syncSymbolField();
  }
  function initSymbolPicker() {
    const b = document.getElementById("cfg-kiss-symbol-btn");
    const pop = document.getElementById("cfg-kiss-symbol-pop");
    if (!b || !pop) return;
    b.addEventListener("click", () => {
      pop.hidden = !pop.hidden;
      b.setAttribute("aria-expanded", pop.hidden ? "false" : "true");
      if (!pop.hidden) {
        renderSymbolList();
        const q = document.getElementById("cfg-kiss-symbol-q");
        q.focus();
        const sel = pop.querySelector(".aprs-sym-opt.sel");
        if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest" });
      }
    });
    document.getElementById("cfg-kiss-symbol-q").addEventListener("input", renderSymbolList);
    document.getElementById("cfg-kiss-symbol-q").addEventListener("keydown", (e) => {
      e.stopPropagation(); // keep Enter / Escape away from the dialog's own key handlers
      if (e.key === "Enter") {
        e.preventDefault();
        const first = pop.querySelector(".aprs-sym-opt");
        if (first) first.click();
      } else if (e.key === "Escape") {
        pop.hidden = true;
        b.setAttribute("aria-expanded", "false");
        b.focus();
      }
    });
    document.getElementById("cfg-kiss-symbol-list").addEventListener("click", (e) => {
      const o = e.target.closest && e.target.closest("[data-sym]");
      if (!o) return;
      const sym = o.getAttribute("data-sym");
      const ov = (document.getElementById("cfg-kiss-symbol-ov").value || "").toUpperCase();
      // Hide first: re-rendering the list would detach the clicked node and
      // config.js treats clicks on detached nodes as "outside" (closes the dialog).
      pop.hidden = true;
      b.setAttribute("aria-expanded", "false");
      setSymbol(sym[0] === "\\" && /^[A-Z0-9]$/.test(ov) ? ov + sym[1] : sym);
    });
    document.getElementById("cfg-kiss-symbol-ov").addEventListener("input", (e) => {
      const S = SYM();
      const h = document.getElementById("cfg-kiss-symbol");
      const p = S && S.parse(h.value);
      if (!p || p.table !== 1) return;
      const c = (e.target.value || "").toUpperCase();
      e.target.value = /^[A-Z0-9]$/.test(c) ? c : "";
      h.value = (e.target.value || "\\") + p.code;
      syncSymbolField();
    });
    syncSymbolField();
  }
  APRS.syncSymbolField = syncSymbolField;

  function patchWs() {
    if (typeof ws === "undefined" || !ws || ws.__aprsPatched) return;
    ws.addEventListener("message", (ev) => {
      try {
        onMessage(JSON.parse(ev.data));
      } catch (_) {}
    });
    ws.__aprsPatched = true;
  }

  /* ---------- Configure tab ---------- */
  const $ = (id) => document.getElementById(id);
  function setVal(id, v) {
    const e = $(id);
    if (e) e.value = v == null ? "" : String(v);
  }
  function setChk(id, v) {
    const e = $(id);
    if (e) e.checked = !!v;
  }
  function satPathsToText(sp) {
    return Object.entries(sp || {})
      .map(([k, v]) => k + "=" + v)
      .join("\n");
  }
  function textToSatPaths(t) {
    const out = {};
    String(t || "")
      .split(/\n+/)
      .forEach((line) => {
        const m = /^\s*([^=]+?)\s*=\s*(.*?)\s*$/.exec(line);
        if (m && m[1]) out[m[1].toUpperCase()] = m[2].toUpperCase();
      });
    return out;
  }
  /* ---------- KISS connections list (one row per TNC channel / port) ---------- */
  const ROLE_LABEL = { rxtx: "RX + TX", rx: "RX only", tx: "TX only" };
  const SPEED_LABEL = { 1200: "1200 AFSK", 9600: "9600 G3RUH" };
  const PRESET_LABEL = { graywolf: "Graywolf", direwolf: "Direwolf", custom: "Custom" };
  const opt = (map, v) => Object.entries(map).map(([k, l]) => '<option value="' + k + '"' + (String(k) === String(v) ? " selected" : "") + ">" + l + "</option>").join("");
  const escA = (x) => String(x == null ? "" : x).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  function connRowHtml(c) {
    const bt = c.transport === "bluetooth";
    return (
      '<div class="kiss-conn" data-id="' + escA(c.id) + '">' +
      '<div class="kc-head">' +
      '<label class="kc-en" title="Connect this one (with the master switch on)"><input type="checkbox" data-f="enabled"' + (c.enabled !== false ? " checked" : "") + " /> Enabled</label>" +
      '<input type="text" class="kc-name" data-f="name" maxlength="24" spellcheck="false" placeholder="Name, e.g. FLEX ch1" value="' + escA(c.name) + '" aria-label="Connection name" />' +
      '<span class="kc-status kiss-off" data-s>not saved</span>' +
      '<button type="button" class="btn-test kc-test-btn" data-act="test" title="One-shot connect to this host / port (unsaved values); sends nothing">Test</button>' +
      '<button type="button" class="kc-rm" data-act="remove" title="Remove this connection" aria-label="Remove connection">×</button>' +
      "</div>" +
      '<div class="kc-grid">' +
      '<label>Software<select class="cfg-select" data-f="preset">' + opt(PRESET_LABEL, c.preset || "graywolf") + "</select></label>" +
      '<label>Connection<select class="cfg-select" data-f="transport">' + opt({ tcp: "TCP", bluetooth: "Bluetooth" }, bt ? "bluetooth" : "tcp") + "</select></label>" +
      '<label>Role<select class="cfg-select" data-f="role">' + opt(ROLE_LABEL, c.role || "rxtx") + "</select></label>" +
      '<label>Speed<select class="cfg-select" data-f="speed">' + opt(SPEED_LABEL, c.speed || 1200) + "</select></label>" +
      "</div>" +
      '<div class="kc-grid kc-tcp"' + (bt ? " hidden" : "") + ">" +
      '<label>Host<input type="text" data-f="host" placeholder="localhost (or remote IP / hostname)" autocomplete="off" spellcheck="false" value="' + escA(c.host) + '" /></label>' +
      '<label>Port<input type="number" data-f="port" min="1" max="65535" step="1" placeholder="6700" value="' + escA(c.port || PRESET_PORTS[c.preset || "graywolf"] || 6700) + '" /></label>' +
      "</div>" +
      '<div class="kc-grid kc-bt"' + (bt ? "" : " hidden") + ">" +
      '<label>Device<input type="text" data-f="serialDevice" placeholder="/dev/rfcomm0" autocomplete="off" spellcheck="false" value="' + escA(c.serialDevice || "/dev/rfcomm0") + '" /></label>' +
      '<label>Baud<input type="number" data-f="serialBaud" min="1200" step="1" placeholder="9600" value="' + escA(c.serialBaud || 9600) + '" /></label>' +
      "</div>" +
      '<p class="form-hint kc-bt-hint"' + (bt ? "" : " hidden") + '>Pair the TNC first and bind it with rfcomm, e.g. <code>sudo rfcomm bind 0 &lt;TNC MAC&gt;</code> &rarr; <code>/dev/rfcomm0</code> (Bluetooth Classic / SPP). Test checks TCP only.</p>' +
      '<details class="kc-adv"' + (c.kissPort ? " open" : "") + "><summary>Advanced</summary>" +
      '<label class="kc-kp">KISS port (channel)<input type="number" data-f="kissPort" min="0" max="15" step="1" placeholder="0" value="' + escA(c.kissPort || 0) + '" /></label>' +
      '<span class="form-hint">Direwolf/multi-port TNCs only; leave 0 for Graywolf</span></details>' +
      '<p class="form-hint kc-test" data-t aria-live="polite"></p>' +
      "</div>"
    );
  }
  function nextConnId() {
    const used = new Set([...document.querySelectorAll("#cfg-kiss-conns .kiss-conn")].map((r) => r.dataset.id));
    let n = 1;
    while (used.has("c" + n)) n++;
    return "c" + n;
  }
  function readConnRow(r) {
    const f = (k) => r.querySelector('[data-f="' + k + '"]');
    const num = (k) => {
      const e = f(k);
      if (!e || e.value === "") return null;
      const n = Number(e.value);
      return Number.isFinite(n) ? n : null;
    };
    return {
      id: r.dataset.id,
      name: f("name").value.trim(),
      enabled: f("enabled").checked,
      preset: f("preset").value,
      transport: f("transport").value,
      host: f("host").value.trim(),
      port: num("port"),
      serialDevice: f("serialDevice").value.trim(),
      serialBaud: num("serialBaud"),
      kissPort: num("kissPort") || 0,
      role: f("role").value,
      speed: Number(f("speed").value) === 9600 ? 9600 : 1200,
    };
  }
  function readConns() {
    return [...document.querySelectorAll("#cfg-kiss-conns .kiss-conn")].map(readConnRow);
  }
  function renderConns(list) {
    const box = $("cfg-kiss-conns");
    if (!box) return;
    box.innerHTML = list.length ? list.map(connRowHtml).join("") : '<p class="form-hint kc-empty">No connections. Add one (Graywolf port, Direwolf, Bluetooth TNC).</p>';
    refreshDefaultTx();
    if (APRS.status) showStatus(APRS.status);
  }
  function refreshDefaultTx(sel) {
    const s0 = $("cfg-kiss-default-tx");
    if (!s0) return;
    const cur = sel != null ? sel : s0.value;
    const tx = readConns().filter((c) => c.role !== "rx");
    s0.innerHTML =
      '<option value="">Auto (first TX-capable 1200 connection)</option>' +
      tx.map((c) => '<option value="' + escA(c.id) + '">' + escA((c.name || c.id) + " · " + SPEED_LABEL[c.speed] + (c.enabled ? "" : " (disabled)")) + "</option>").join("");
    s0.value = tx.some((c) => c.id === cur) ? cur : "";
  }
  /** Migrate an older single-endpoint config (also done server-side). */
  function connsOf(c) {
    if (Array.isArray(c.connections)) return c.connections;
    return [{ id: "c1", name: PRESET_LABEL[c.preset] === "Custom" ? "TNC" : PRESET_LABEL[c.preset || "graywolf"] || "Graywolf", enabled: true, preset: c.preset || "graywolf", transport: c.transport === "bluetooth" || c.transport === "serial" ? "bluetooth" : "tcp", host: c.host || "", port: c.port || PRESET_PORTS[c.preset || "graywolf"] || 6700, serialDevice: c.serialDevice, serialBaud: c.serialBaud, kissPort: c.kissPort || 0, role: "rxtx", speed: 1200 }];
  }
  function onConnsEvent(e) {
    const r = e.target.closest && e.target.closest(".kiss-conn");
    if (!r) return;
    const f = e.target.dataset && e.target.dataset.f;
    if (e.type === "change" && f === "preset") {
      // Only fill the port when empty or still another preset's default (never a typed port like 8002).
      const p = PRESET_PORTS[e.target.value];
      const pe = r.querySelector('[data-f="port"]');
      const cur = String(pe.value || "").trim();
      if (p && (cur === "" || Object.values(PRESET_PORTS).map(String).includes(cur))) pe.value = p;
      const ne = r.querySelector('[data-f="name"]');
      if (!ne.value.trim() || Object.values(PRESET_LABEL).concat(["TNC"]).some((l) => ne.value.trim().replace(/ \d+$/, "") === l)) ne.value = e.target.value === "custom" ? "TNC" : PRESET_LABEL[e.target.value];
    }
    if (e.type === "change" && f === "transport") {
      const bt = e.target.value === "bluetooth";
      r.querySelector(".kc-tcp").hidden = bt;
      r.querySelector(".kc-bt").hidden = !bt;
      r.querySelector(".kc-bt-hint").hidden = !bt;
    }
    if (f === "name" || f === "role" || f === "speed" || f === "enabled") refreshDefaultTx();
    if (e.type === "click" && e.target.dataset.act === "remove") {
      e.preventDefault();
      r.remove();
      if (!document.querySelector("#cfg-kiss-conns .kiss-conn")) renderConns([]);
      refreshDefaultTx();
    }
    if (e.type === "click" && e.target.dataset.act === "test") {
      e.preventDefault();
      const c = readConnRow(r);
      const tb = e.target;
      const out = r.querySelector("[data-t]");
      if (c.transport === "bluetooth") {
        out.textContent = "Test checks TCP only; for Bluetooth save and watch the status.";
        return;
      }
      tb.disabled = true;
      tb.classList.remove("test-ok", "test-fail");
      tb.classList.add("test-busy");
      tb.textContent = "Testing…";
      out.textContent = "Connecting to " + (c.host || "localhost") + ":" + c.port + " …";
      if (!APRS.send({ type: "aprs-test", id: c.id, host: c.host, port: c.port })) showTest({ id: c.id, ok: false, target: (c.host || "localhost") + ":" + c.port, error: "not connected to the tracker server" });
    }
  }
  APRS.readConns = readConns;
  APRS.renderConns = renderConns;

  function updateVisibility() {
    const ll = $("cfg-kiss-pos-source") && $("cfg-kiss-pos-source").value === "latlon";
    if ($("cfg-kiss-latlon-row")) $("cfg-kiss-latlon-row").hidden = !ll;
  }
  function fillTab(c0) {
    const c = c0 || {};
    setChk("cfg-kiss-enabled", c.enabled === true);
    renderConns(connsOf(c));
    refreshDefaultTx(c.defaultTxConn || "");
    setVal("cfg-kiss-satspeeds", satPathsToText(c.satSpeeds));
    setVal("cfg-kiss-expire", c.heardExpireMin || 60);
    setVal("cfg-kiss-ssid", c.ssid || "");
    setVal("cfg-kiss-symbol", c.symbol || "/`");
    syncSymbolField();
    setVal("cfg-kiss-comment", c.comment || "");
    setVal("cfg-kiss-pos-source", c.posSource || "grid");
    setVal("cfg-kiss-ambiguity", c.posAmbiguity || 0);
    setVal("cfg-kiss-lat", c.lat != null ? c.lat : "");
    setVal("cfg-kiss-lon", c.lon != null ? c.lon : "");
    setChk("cfg-kiss-tx", c.txEnabled === true);
    setVal("cfg-kiss-path", c.path != null ? c.path : "ARISS");
    setVal("cfg-kiss-default-to", c.defaultTo || "CQ");
    setVal("cfg-kiss-satpaths", satPathsToText(c.satPaths));
    setChk("cfg-kiss-req-radio", c.txRequireRadioOn !== false);
    setChk("cfg-kiss-retry-tag", c.retryTag !== false);
    setVal("cfg-kiss-digi-timeout", c.digiTimeoutS || 30);
    setVal("cfg-kiss-dupe", c.dupeWindowS || 30);
    setChk("cfg-kiss-log", c.logToFile !== false);
    updateVisibility();
  }
  function numOrNull(id) {
    const e = $(id);
    if (!e || e.value === "") return null;
    const n = Number(e.value);
    return Number.isFinite(n) ? n : null;
  }
  function readTab() {
    const v = (id) => ($(id) ? $(id).value : "");
    const ck = (id) => !!($(id) && $(id).checked);
    return {
      enabled: ck("cfg-kiss-enabled"),
      connections: readConns(),
      defaultTxConn: v("cfg-kiss-default-tx"),
      satSpeeds: textToSatSpeeds(v("cfg-kiss-satspeeds")),
      heardExpireMin: numOrNull("cfg-kiss-expire"),
      ssid: v("cfg-kiss-ssid").trim().replace(/^-/, ""),
      symbol: v("cfg-kiss-symbol"),
      comment: v("cfg-kiss-comment"),
      posSource: v("cfg-kiss-pos-source"),
      posAmbiguity: numOrNull("cfg-kiss-ambiguity") || 0,
      lat: numOrNull("cfg-kiss-lat"),
      lon: numOrNull("cfg-kiss-lon"),
      txEnabled: ck("cfg-kiss-tx"),
      path: v("cfg-kiss-path").trim().toUpperCase(),
      defaultTo: v("cfg-kiss-default-to").trim().toUpperCase(),
      satPaths: textToSatPaths(v("cfg-kiss-satpaths")),
      txRequireRadioOn: ck("cfg-kiss-req-radio"),
      retryTag: ck("cfg-kiss-retry-tag"),
      digiTimeoutS: numOrNull("cfg-kiss-digi-timeout"),
      dupeWindowS: numOrNull("cfg-kiss-dupe"),
      logToFile: ck("cfg-kiss-log"),
    };
  }
  APRS.readTab = readTab;
  function textToSatSpeeds(t) {
    const out = {};
    for (const [k, v] of Object.entries(textToSatPaths(t))) {
      const n = parseInt(String(v).replace(/[^0-9]/g, ""), 10);
      if (n === 1200 || n === 9600) out[k] = n;
      else if (/^9K6$/i.test(v)) out[k] = 9600;
      else if (/^1K2$/i.test(v)) out[k] = 1200;
    }
    return out;
  }
  APRS.textToSatSpeeds = textToSatSpeeds;
  APRS.textToSatPaths = textToSatPaths;

  /** One connection's state, e.g. "connected · RX 12 · TX 1" / "refused — retrying in 4 s". */
  function connStateText(x) {
    if (!x) return "not saved";
    if (!x.enabled) return "disabled";
    switch (x.state) {
      case "connected":
        return "connected · RX " + (x.rx || 0) + " · TX " + (x.tx || 0);
      case "connecting":
        return "connecting…";
      case "waiting":
        return (x.error || "down") + " — retrying" + (x.nextRetryAt ? " in " + Math.max(0, Math.round((x.nextRetryAt - Date.now()) / 1000)) + " s" : "");
      case "off":
        return "off";
      default:
        return x.state || "idle";
    }
  }
  APRS.connStateText = connStateText;
  function statusText(st) {
    if (!st) return "KISS: unknown";
    if (!st.enabled) return "KISS: off (not connecting)";
    const list = (st.connections || []).filter((x) => x.enabled);
    if (!list.length) return "KISS: no connection enabled";
    if (list.length === 1) return "KISS " + list[0].name + " " + (list[0].target || "") + ": " + connStateText(list[0]);
    const up = list.filter((x) => x.state === "connected").length;
    return "KISS " + up + "/" + list.length + " connected · RX " + (st.rx || 0) + " · TX " + (st.tx || 0) + (st.error ? " · " + st.error : "");
  }
  APRS.statusText = statusText;
  /** Info field of a packet record (TNC2 text after the first ":"). */
  const infoOf = (p) => {
    if (p.thirdParty && p.thirdParty.info != null) return p.thirdParty.info; // same inner packet via any iGate
    const t = String(p.tnc2 || "");
    const i = t.indexOf(":");
    return i < 0 ? "" : t.slice(i + 1);
  };
  APRS.infoOf = infoOf;
  /**
   * Collapse duplicate copies for the Messages window. packets: newest first.
   * Same direction + source + info within windowS of the group's first copy =
   * one group (like Graywolf's 30 s dupe window). Echoes of our own TX
   * (p.echoOf) attach to that TX's group instead. Returns groups newest
   * first: {key, id, first, last, copies[] (oldest first), echoes[], time}.
   */
  APRS.groupPackets = (packets, windowS) => {
    const W = (windowS > 0 ? windowS : 30) * 1000;
    const groups = [];
    const open = new Map();
    const byId = new Map();
    const list = (packets || []).slice().sort((a, b) => a.time - b.time || a.id - b.id);
    const orphanEchoes = [];
    for (const p of list) {
      if (p.echoOf != null) {
        const g = byId.get(p.echoOf);
        if (g) {
          g.echoes.push(p);
          continue;
        }
        orphanEchoes.push(p);
      }
      const key = (p.dir || "rx") + "|" + p.src + "|" + infoOf(p);
      const g0 = p.dir === "tx" ? null : open.get(key);
      if (g0 && p.time - g0.first.time <= W) {
        g0.copies.push(p);
        g0.last = p;
        byId.set(p.id, g0);
        continue;
      }
      const g = { key, id: p.id, first: p, last: p, copies: [p], echoes: [], time: p.time };
      groups.push(g);
      open.set(key, g);
      byId.set(p.id, g);
    }
    return groups.reverse();
  };
  /** Path for display: "direct" or "via SHEPRD*,WIDE2*" (used hops marked *). */
  APRS.pathText = (p) => {
    const v = (p && p.via) || [];
    return v.length ? "via " + v.join(",") : "direct";
  };
  /** Digipeat state of a TX: {cls, text}. Sats: "Heard via RS0ISS"; else "Digipeated by SHEPRD, KF6RAL-1". */
  APRS.digiText = (d) => {
    if (!d) return null;
    if (d.state === "digipeated") return { cls: "ok", text: (d.viaSat ? "Heard via " : "Digipeated by ") + d.by.join(", ") };
    if (d.state === "none") return { cls: "none", text: "No digipeat heard (" + (d.timeoutS || 30) + " s)" };
    return { cls: "pending", text: "Waiting for a digipeat…" };
  };
  const SRC_LABEL = { setting: "your per-sat setting", amsat: "AMSAT digipeater list", mode: "selected mode", default: "default" };
  /** Route for a typed Via: the sat route (status.txRoute) or the terrestrial / direct one. */
  APRS.routeFor = (via) => {
    const st = APRS.status;
    if (!st) return null;
    return APRS.viaIsSat(via) && st.sat ? st.txRouteSat || st.txRoute : st.txRouteDirect;
  };
  /** HTML line "TX via FLEX ch1 [1200] · ISS (AMSAT digipeater list)" or the blocking reason. */
  APRS.routeHtml = (r) => {
    const st = APRS.status;
    if (!r || !st) return "";
    const e = (x) => String(x == null ? "" : x).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
    if (!r.ok) return '<span class="aprs-route-x">⚠ ' + e(r.reason) + "</span>";
    const sp = r.conn.speed || r.speed;
    return (
      "TX via <b>" + e(r.conn.name) + '</b> <span class="aprs-route-sp s' + sp + '">' + sp + "</span>" +
      (r.satRoute && st.sat ? " · " + e(st.sat.name || st.sat.key) + " " + sp + " (" + e(SRC_LABEL[r.speedSource] || r.speedSource || "") + ")" : " · default TX (no satellite path)") +
      (r.connected ? "" : " · not connected")
    );
  };
  function showStatus(st) {
    const e = $("cfg-kiss-status");
    if (e) {
      e.textContent = statusText(st);
      e.className = "form-hint kiss-status kiss-" + (st && st.enabled ? st.state : "off");
    }
    const h = $("cfg-kiss-source-hint");
    if (h && st) h.textContent = "Source = " + (st.source || "(set your callsign in Station)") + ". SSID is optional; leave empty for the plain callsign.";
    // per-row live status
    const saved = new Map(((st && st.connections) || []).map((x) => [x.id, x]));
    if (!document.querySelectorAll) return;
    document.querySelectorAll("#cfg-kiss-conns .kiss-conn").forEach((r) => {
      const x = saved.get(r.dataset.id);
      const el = r.querySelector("[data-s]");
      if (!el) return;
      const state = !x ? "unsaved" : !st.enabled || !x.enabled ? "off" : x.state;
      el.className = "kc-status kiss-" + state;
      el.textContent = !x ? "not saved" : !st.enabled ? "master off" : connStateText(x);
      el.title = x && x.target ? x.target : "";
    });
  }
  function showTest(r) {
    const row = r.id ? document.querySelector('#cfg-kiss-conns .kiss-conn[data-id="' + String(r.id).replace(/"/g, "") + '"]') : document.querySelector("#cfg-kiss-conns .kiss-conn");
    const btn = row && row.querySelector('[data-act="test"]');
    const out = row && row.querySelector("[data-t]");
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("test-busy");
      btn.classList.add(r.ok ? "test-ok" : "test-fail");
      btn.textContent = r.ok ? "Connected ✓" : "Failed ✗";
    }
    const master = !!($("cfg-kiss-enabled") && $("cfg-kiss-enabled").checked);
    const rowOn = !row || !!row.querySelector('[data-f="enabled"]').checked;
    const tip = $("cfg-kiss-test-tip");
    if (tip) {
      tip.hidden = !(r.ok && (!master || !rowOn));
      const name = row ? row.querySelector('[data-f="name"]').value.trim() || "this connection" : "this connection";
      tip.textContent = !master
        ? 'Connection works — tick "Connect to a KISS TNC" and Save to stay connected.'
        : "Connection works — tick Enabled on " + name + " and Save to stay connected.";
    }
    if (out) {
      out.textContent = r.ok
        ? "Connected to " + r.target + " in " + r.ms + " ms" +
          (r.frames ? "; " + r.frames + " KISS frame" + (r.frames === 1 ? "" : "s") + " in 3 s" + (r.sample ? ": " + r.sample : "") : "; no frames in 3 s (normal when the band is quiet)") +
          (r.closedByPeer ? " (peer closed the connection)" : "")
        : r.target + ": " + (r.error || "failed");
    }
  }

  function init() {
    setInterval(patchWs, 500);
    patchWs();
    const box = $("cfg-kiss-conns");
    if (box) {
      box.addEventListener("change", onConnsEvent);
      box.addEventListener("input", (e) => e.target.dataset && e.target.dataset.f === "name" && refreshDefaultTx());
      box.addEventListener("click", onConnsEvent);
    }
    const add = $("cfg-kiss-add");
    if (add)
      add.addEventListener("click", (e) => {
        e.preventDefault();
        const list = readConns();
        if (list.length >= 8) return;
        const n = list.length + 1;
        list.push({ id: nextConnId(), name: "Graywolf " + n, enabled: true, preset: "graywolf", transport: "tcp", host: list.length ? list[list.length - 1].host : "", port: "", role: "rx", speed: 1200, kissPort: 0 });
        const keep = $("cfg-kiss-default-tx").value;
        renderConns(list);
        refreshDefaultTx(keep);
        const last = [...document.querySelectorAll("#cfg-kiss-conns .kiss-conn")].pop();
        if (last) last.querySelector('[data-f="port"]').focus();
      });
    const en = $("cfg-kiss-enabled");
    if (en) en.addEventListener("change", () => { if ($("cfg-kiss-test-tip") && en.checked) $("cfg-kiss-test-tip").hidden = true; });
    ["cfg-kiss-pos-source"].forEach((id) => {
      const e = $(id);
      if (e) e.addEventListener("change", updateVisibility);
    });
    // Re-fill from the saved config whenever the dialog opens (drops unsaved edits).
    const openBtn = $("btn-config");
    if (openBtn)
      openBtn.addEventListener("click", () => {
        fillTab(APRS.cfg);
        if ($("cfg-kiss-test-tip")) $("cfg-kiss-test-tip").hidden = true;
      });
    const save = $("btn-save-config");
    if (save) save.addEventListener("click", () => APRS.send({ type: "aprs-config", aprs: readTab() }));
    fillTab(null);
    initSymbolPicker();
    refreshDatalists();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
