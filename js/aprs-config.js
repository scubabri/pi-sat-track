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
      APRS.status = msg;
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
    }
    APRS.emit(msg.type, msg);
  }

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
    const serial = $("cfg-kiss-transport") && $("cfg-kiss-transport").value === "serial";
    if ($("cfg-kiss-tcp-row")) $("cfg-kiss-tcp-row").hidden = serial;
    if ($("cfg-kiss-serial-row")) $("cfg-kiss-serial-row").hidden = !serial;
    const ll = $("cfg-kiss-pos-source") && $("cfg-kiss-pos-source").value === "latlon";
    if ($("cfg-kiss-latlon-row")) $("cfg-kiss-latlon-row").hidden = !ll;
    const tb = $("btn-test-kiss");
    if (tb) tb.title = serial ? "Test checks TCP only; save and watch the status for serial" : "One-shot connect to the host/port above (unsaved values); sends nothing";
  }
  function fillTab(c0) {
    const c = c0 || {};
    setChk("cfg-kiss-enabled", c.enabled === true);
    setVal("cfg-kiss-preset", c.preset || "graywolf");
    setVal("cfg-kiss-transport", c.transport || "tcp");
    setVal("cfg-kiss-host", c.host || "");
    setVal("cfg-kiss-port", c.port || PRESET_PORTS[c.preset || "graywolf"] || 6700);
    setVal("cfg-kiss-serial-device", c.serialDevice || "/dev/rfcomm0");
    setVal("cfg-kiss-serial-baud", c.serialBaud || 9600);
    setVal("cfg-kiss-kissport", c.kissPort || 0);
    setVal("cfg-kiss-expire", c.heardExpireMin || 60);
    setVal("cfg-kiss-ssid", c.ssid || "");
    setVal("cfg-kiss-symbol", c.symbol || "/`");
    setVal("cfg-kiss-comment", c.comment || "");
    setVal("cfg-kiss-pos-source", c.posSource || "grid");
    setVal("cfg-kiss-ambiguity", c.posAmbiguity || 0);
    setVal("cfg-kiss-lat", c.lat != null ? c.lat : "");
    setVal("cfg-kiss-lon", c.lon != null ? c.lon : "");
    setChk("cfg-kiss-tx", c.txEnabled === true);
    setVal("cfg-kiss-path", c.path != null ? c.path : "ARISS");
    setVal("cfg-kiss-minel", c.minEl != null ? c.minEl : 0);
    setVal("cfg-kiss-satpaths", satPathsToText(c.satPaths));
    setChk("cfg-kiss-req-radio", c.txRequireRadioOn !== false);
    setChk("cfg-kiss-req-mode", c.txRequireAprsMode !== false);
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
      minEl: numOrNull("cfg-kiss-minel") || 0,
      satPaths: textToSatPaths(v("cfg-kiss-satpaths")),
      txRequireRadioOn: ck("cfg-kiss-req-radio"),
      txRequireAprsMode: ck("cfg-kiss-req-mode"),
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
        const p = PRESET_PORTS[preset.value];
        if (p) setVal("cfg-kiss-port", p);
      });
    }
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
      });
    const save = $("btn-save-config");
    if (save) save.addEventListener("click", () => APRS.send({ type: "aprs-config", aprs: readTab() }));
    fillTab(null);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
