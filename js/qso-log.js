/**
 * Sidebar QSO logger: callsign box + Log button.
 * Sends {type:"log-qso", call} and shows the server's log-result.
 * Also shows "Log to:" destination (from Logging config) and gates the
 * callsign/Log controls on Radio+Antenna engaged — same rule as WSJT-X.
 */
(function () {
  let reqSeq = 0;
  let pendingReq = null;
  let pendingTimer = null;
  let clearTimer = null;
  let busy = false;
  let radioOn = false;
  let antennaOn = false;
  let logCfg = {
    logMethod: "off",
    logAdifPath: "~/.rpitrack/pi-sat-track.adi",
    logUdpHost: "127.0.0.1",
    logUdpPort: 2237,
  };

  function els() {
    return {
      form: document.getElementById("qso-log-form"),
      input: document.getElementById("qso-log-call"),
      btn: document.getElementById("btn-qso-log"),
      status: document.getElementById("qso-log-status"),
      dest: document.getElementById("qso-log-dest"),
    };
  }

  function isMulticastIPv4(host) {
    const m = String(host || "")
      .trim()
      .match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false;
    const a = parseInt(m[1], 10);
    return a >= 224 && a <= 239;
  }

  function engaged() {
    return !!(radioOn && antennaOn);
  }

  function formatLogDest(cfg) {
    const m = String((cfg && cfg.logMethod) || "off").toLowerCase();
    if (m === "adif") {
      const p =
        (cfg && cfg.logAdifPath) || "~/.rpitrack/pi-sat-track.adi";
      return "Log to: ADIF " + p;
    }
    if (m === "udp") {
      const h = (cfg && cfg.logUdpHost) || "127.0.0.1";
      const p =
        cfg && cfg.logUdpPort != null && Number(cfg.logUdpPort) > 0
          ? Number(cfg.logUdpPort)
          : 2237;
      return (
        "Log to: UDP " +
        h +
        ":" +
        p +
        (isMulticastIPv4(h) ? " (multicast)" : "")
      );
    }
    return "Log to: not configured";
  }

  function applyLogCfg(src) {
    if (!src || typeof src !== "object") return false;
    let changed = false;
    const keys = ["logMethod", "logAdifPath", "logUdpHost", "logUdpPort"];
    for (const k of keys) {
      if (src[k] !== undefined && src[k] !== logCfg[k]) {
        logCfg[k] = src[k];
        changed = true;
      }
    }
    return changed;
  }

  function syncLogCfgFromLocal() {
    try {
      if (typeof loadConfig === "function") {
        applyLogCfg(loadConfig());
      }
    } catch (_) {}
  }

  function updateDestUi() {
    const e = els();
    if (!e.dest) return;
    const base = formatLogDest(logCfg);
    const on = engaged();
    const configured =
      String(logCfg.logMethod || "off").toLowerCase() !== "off";
    let text = base;
    let cls = "";
    if (configured) cls = on ? "ok" : "err";
    e.dest.textContent = text;
    e.dest.className = "qso-wsjtx-state" + (cls ? " " + cls : "");
    e.dest.hidden = false;
  }

  function updateEngageUi() {
    const e = els();
    const on = engaged();
    const disable = !on || busy;
    if (e.input) {
      // Callsign can be typed anytime; only the Log button waits for Radio + Antenna.
      e.input.disabled = busy;
      e.input.title = on
        ? "Callsign to log"
        : "Callsign to log (enable Radio and Antenna to log it)";
    }
    if (e.btn) {
      e.btn.disabled = disable;
      e.btn.title = on
        ? "Log QSO"
        : "Enable Radio and Antenna to log";
    }
    updateDestUi();
  }

  function setStatus(text, kind, holdMs) {
    const e = els();
    if (!e.status) return;
    e.status.textContent = text || "";
    e.status.className = "qso-log-status" + (kind ? " " + kind : "");
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = null;
    if (holdMs) {
      clearTimer = setTimeout(() => {
        e.status.textContent = "";
        e.status.className = "qso-log-status";
      }, holdMs);
    }
  }

  function setBusy(on) {
    busy = !!on;
    updateEngageUi();
  }

  function stationFromLocal() {
    try {
      const cfg = typeof loadConfig === "function" ? loadConfig() : {};
      return { callsign: cfg.callsign || "", grid: cfg.grid || "" };
    } catch (_) {
      return { callsign: "", grid: "" };
    }
  }

  function doLog() {
    if (!engaged()) {
      setStatus("Enable Radio and Antenna to log", "err", 4000);
      return;
    }
    const e = els();
    if (!e.input) return;
    const call = e.input.value.trim().toUpperCase().replace(/\s+/g, "");
    e.input.value = call;
    if (!call) {
      setStatus("Enter a callsign", "err", 3000);
      e.input.focus();
      return;
    }
    if (typeof ws === "undefined" || !ws || ws.readyState !== WebSocket.OPEN) {
      setStatus("Not connected to server", "err", 4000);
      return;
    }
    const st = stationFromLocal();
    pendingReq = "q" + Date.now() + "-" + ++reqSeq;
    ws.send(
      JSON.stringify({
        type: "log-qso",
        reqId: pendingReq,
        call,
        stationCallsign: st.callsign,
        stationGrid: st.grid,
        dxGrid: window.qsoDxGrid && window.qsoDxGrid.call === call ? window.qsoDxGrid.grid : "",
      }),
    );
    setBusy(true);
    setStatus("Logging " + call + "\u2026", "busy");
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      if (!pendingReq) return;
      pendingReq = null;
      setBusy(false);
      setStatus("No reply from server", "err", 5000);
    }, 6000);
  }

  function applyWsjtxResult(msg) {
    const r = msg.record || {};
    const warn =
      Array.isArray(msg.warnings) && msg.warnings.length
        ? msg.warnings.join("; ")
        : "";
    if (msg.ok) {
      let text =
        "Logged " +
        (r.call || "") +
        (r.satName ? " \u00b7 " + r.satName : "") +
        " " +
        (r.mode || "") +
        " (from WSJT-X)";
      if (warn) text += " \u2014 \u26a0 " + warn;
      setStatus(text, warn ? "warn" : "ok", warn ? 10000 : 6000);
    } else {
      setStatus(
        "WSJT-X " + (r.call || "QSO") + ": " + (msg.error || "forward failed"),
        "err",
        10000,
      );
    }
  }

  function applyResult(msg) {
    if (!msg || msg.type !== "log-result") return;
    if (msg.source === "wsjtx") {
      applyWsjtxResult(msg);
      return;
    }
    if (msg.reqId && pendingReq && msg.reqId !== pendingReq) return;
    pendingReq = null;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
    setBusy(false);
    const e = els();
    if (msg.ok) {
      const r = msg.record || {};
      let text =
        "Logged " +
        (r.call || "") +
        " \u00b7 " +
        (r.satName || "") +
        " " +
        (r.mode || "") +
        " \u00b7 " +
        (r.band || "") +
        (r.bandRx && r.bandRx !== r.band ? "/" + r.bandRx : "");
      const warn =
        Array.isArray(msg.warnings) && msg.warnings.length
          ? msg.warnings.join("; ")
          : "";
      if (warn) text += " \u2014 \u26a0 " + warn;
      setStatus(text, warn ? "warn" : "ok", warn ? 10000 : 5000);
      if (e.input) {
        e.input.value = "";
        if (engaged()) e.input.focus();
      }
    } else {
      setStatus(msg.error || "Log failed", "err", 8000);
    }
  }

  let lastListenerState = "";
  /** Surface WSJT-X listener errors (e.g. port in use) once in the sidebar. */
  function applyListenerState(msg) {
    const stt = msg && msg.state;
    const el = document.getElementById("qso-wsjtx-state");
    if (el) {
      let text = "";
      let cls = "";
      if (stt === "listening") {
        text =
          "WSJT-X Logging: Listening on " +
          (msg.bind || "0.0.0.0") +
          ":" +
          msg.port;
        cls = "ok";
      } else if (stt === "paused") {
        text =
          "WSJT-X Logging: " + (msg.bind || "0.0.0.0") + ":" + msg.port;
        cls = "err";
      } else if (stt === "error") {
        text = "WSJT-X Logging: " + (msg.error || "error");
        cls = "err";
      } else if (stt === "starting") {
        text = "WSJT-X Logging: starting\u2026";
      }
      el.textContent = text;
      el.className = "qso-wsjtx-state" + (cls ? " " + cls : "");
      el.hidden = !text;
    }
    if (stt === "error" && lastListenerState !== "error") {
      setStatus("WSJT-X listener: " + (msg.error || "error"), "err", 10000);
    }
    lastListenerState = stt || "";
  }

  function applyEngageFromMsg(msg) {
    let changed = false;
    if (typeof msg.radioOn === "boolean" && msg.radioOn !== radioOn) {
      radioOn = msg.radioOn;
      changed = true;
    }
    if (typeof msg.antennaOn === "boolean" && msg.antennaOn !== antennaOn) {
      antennaOn = msg.antennaOn;
      changed = true;
    }
    if (changed) updateEngageUi();
  }

  function applyConfigFromMsg(msg) {
    if (!msg) return;
    if (msg.type === "endpoints" || msg.type === "host") {
      if (applyLogCfg(msg)) updateDestUi();
    } else if (msg.type === "profiles" && msg.config) {
      if (applyLogCfg(msg.config)) updateDestUi();
    }
  }

  window.applyQsoLogResult = applyResult;

  function patchWs() {
    if (typeof ws === "undefined" || !ws) return;
    if (ws.__qsoLogPatched) return;
    const prev = ws.onmessage;
    ws.onmessage = function (ev) {
      if (typeof prev === "function") prev.call(this, ev);
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "log-result") applyResult(msg);
        if (msg.type === "wsjtx-listener") applyListenerState(msg);
        if (
          msg.type === "tick" ||
          msg.type === "state" ||
          msg.type === "flex" ||
          msg.type === "rotor" ||
          msg.type === "icom"
        ) {
          applyEngageFromMsg(msg);
        }
        if (
          msg.type === "endpoints" ||
          msg.type === "host" ||
          msg.type === "profiles"
        ) {
          applyConfigFromMsg(msg);
        }
      } catch (_) {}
    };
    ws.__qsoLogPatched = true;
  }

  function init() {
    const e = els();
    syncLogCfgFromLocal();
    updateEngageUi();
    if (e.input) {
      e.input.addEventListener("input", () => {
        const pos = e.input.selectionStart;
        e.input.value = e.input.value.toUpperCase();
        try {
          e.input.setSelectionRange(pos, pos);
        } catch (_) {}
      });
    }
    if (e.form) {
      e.form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        doLog();
      });
    }
    setInterval(patchWs, 500);
    // Config may land in localStorage after profiles migrate — refresh dest
    setInterval(() => {
      const before = formatLogDest(logCfg);
      syncLogCfgFromLocal();
      if (formatLogDest(logCfg) !== before) updateDestUi();
    }, 2000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
