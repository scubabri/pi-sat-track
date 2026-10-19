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
  function updateVisibility() {
    const serial = $("cfg-kiss-transport") && $("cfg-kiss-transport").value === "bluetooth";
    if ($("cfg-kiss-tcp-row")) $("cfg-kiss-tcp-row").hidden = serial;
    if ($("cfg-kiss-serial-row")) $("cfg-kiss-serial-row").hidden = !serial;
    if ($("cfg-kiss-bt-hint")) $("cfg-kiss-bt-hint").hidden = !serial;
    const ll = $("cfg-kiss-pos-source") && $("cfg-kiss-pos-source").value === "latlon";
    if ($("cfg-kiss-latlon-row")) $("cfg-kiss-latlon-row").hidden = !ll;
    const tb = $("btn-test-kiss");
    if (tb) tb.title = serial ? "Test checks TCP only; for Bluetooth save and watch the status" : "One-shot connect to the host/port above (unsaved values); sends nothing";
  }
  function fillTab(c0) {
    const c = c0 || {};
    setChk("cfg-kiss-enabled", c.enabled === true);
    setVal("cfg-kiss-preset", c.preset || "graywolf");
    setVal("cfg-kiss-transport", c.transport === "bluetooth" || c.transport === "serial" ? "bluetooth" : "tcp");
    setVal("cfg-kiss-host", c.host || "");
    setVal("cfg-kiss-port", c.port || PRESET_PORTS[c.preset || "graywolf"] || 6700);
    setVal("cfg-kiss-serial-device", c.serialDevice || "/dev/rfcomm0");
    setVal("cfg-kiss-serial-baud", c.serialBaud || 9600);
    setVal("cfg-kiss-kissport", c.kissPort || 0);
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
    setVal("cfg-kiss-beacon-int", c.beaconIntervalS || 60);
    setVal("cfg-kiss-msg-int", c.msgIntervalS || 10);
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
      preset: v("cfg-kiss-preset"),
      transport: v("cfg-kiss-transport"),
      host: v("cfg-kiss-host").trim(),
      port: numOrNull("cfg-kiss-port"),
      serialDevice: v("cfg-kiss-serial-device").trim(),
      serialBaud: numOrNull("cfg-kiss-serial-baud"),
      kissPort: numOrNull("cfg-kiss-kissport") || 0,
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
      beaconIntervalS: numOrNull("cfg-kiss-beacon-int"),
      msgIntervalS: numOrNull("cfg-kiss-msg-int"),
      logToFile: ck("cfg-kiss-log"),
    };
  }
  APRS.readTab = readTab;
  APRS.textToSatPaths = textToSatPaths;

  function statusText(st) {
    if (!st) return "KISS: unknown";
    if (!st.enabled) return "KISS: off (not connecting)";
    const base = "KISS " + (st.target || "");
    switch (st.state) {
      case "connected":
        return base + ": connected · RX " + (st.rx || 0) + " · TX " + (st.tx || 0);
      case "connecting":
        return base + ": connecting…";
      case "waiting":
        return base + ": " + (st.error || "down") + " — retrying" + (st.nextRetryAt ? " in " + Math.max(0, Math.round((st.nextRetryAt - Date.now()) / 1000)) + " s" : "");
      default:
        return base + ": " + (st.state || "idle");
    }
  }
  APRS.statusText = statusText;
  function showStatus(st) {
    const e = $("cfg-kiss-status");
    if (e) {
      e.textContent = statusText(st);
      e.className = "form-hint kiss-status kiss-" + (st && st.enabled ? st.state : "off");
    }
    const h = $("cfg-kiss-source-hint");
    if (h && st) h.textContent = "Source = " + (st.source || "(set your callsign in Station)") + ". SSID is optional; leave empty for the plain callsign.";
  }
  function showTest(r) {
    const btn = $("btn-test-kiss");
    const out = $("cfg-kiss-test-result");
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("test-busy");
      btn.classList.add(r.ok ? "test-ok" : "test-fail");
      btn.textContent = r.ok ? "Connected ✓" : "Failed ✗";
    }
    const enabled = !!($("cfg-kiss-enabled") && $("cfg-kiss-enabled").checked);
    const tip = $("cfg-kiss-test-tip");
    if (tip) {
      tip.hidden = !(r.ok && !enabled);
      tip.textContent = 'Connection works — tick "Connect to a KISS TNC" and Save to stay connected.';
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
    const preset = $("cfg-kiss-preset");
    if (preset) {
      preset.addEventListener("change", () => {
        // Only fill the port when it is empty or still another preset's default;
        // never overwrite a port the user typed (e.g. Graywolf channel 2 on 8002).
        const p = PRESET_PORTS[preset.value];
        const cur = String(($("cfg-kiss-port") && $("cfg-kiss-port").value) || "").trim();
        const isDefault = cur === "" || Object.values(PRESET_PORTS).map(String).includes(cur);
        if (p && isDefault) setVal("cfg-kiss-port", p);
      });
    }
    const en = $("cfg-kiss-enabled");
    if (en) en.addEventListener("change", () => { if ($("cfg-kiss-test-tip") && en.checked) $("cfg-kiss-test-tip").hidden = true; });
    ["cfg-kiss-transport", "cfg-kiss-pos-source"].forEach((id) => {
      const e = $(id);
      if (e) e.addEventListener("change", updateVisibility);
    });
    const tb = $("btn-test-kiss");
    if (tb) {
      tb.addEventListener("click", () => {
        const host = ($("cfg-kiss-host").value || "").trim();
        const port = $("cfg-kiss-port").value;
        tb.disabled = true;
        tb.classList.remove("test-ok", "test-fail");
        tb.classList.add("test-busy");
        tb.textContent = "Testing…";
        const out = $("cfg-kiss-test-result");
        if (out) out.textContent = "Connecting to " + (host || "localhost") + ":" + port + " …";
        if (!APRS.send({ type: "aprs-test", host, port })) showTest({ ok: false, target: (host || "localhost") + ":" + port, error: "not connected to the tracker server" });
      });
    }
    // Re-fill from the saved config whenever the dialog opens (drops unsaved edits).
    const openBtn = $("btn-config");
    if (openBtn)
      openBtn.addEventListener("click", () => {
        fillTab(APRS.cfg);
        const tbtn = $("btn-test-kiss");
        if (tbtn) {
          tbtn.classList.remove("test-ok", "test-fail", "test-busy");
          tbtn.textContent = "Test connection";
        }
        if ($("cfg-kiss-test-result")) $("cfg-kiss-test-result").textContent = "";
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
