/**
 * Sidebar QSO logger: callsign box + Log button.
 * Sends {type:"log-qso", call} and shows the server's log-result.
 */
(function () {
  let reqSeq = 0;
  let pendingReq = null;
  let pendingTimer = null;
  let clearTimer = null;

  function els() {
    return {
      form: document.getElementById("qso-log-form"),
      input: document.getElementById("qso-log-call"),
      btn: document.getElementById("btn-qso-log"),
      status: document.getElementById("qso-log-status"),
    };
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

  function setBusy(busy) {
    const e = els();
    if (e.btn) e.btn.disabled = !!busy;
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

  function applyResult(msg) {
    if (!msg || msg.type !== "log-result") return;
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
        e.input.focus();
      }
    } else {
      setStatus(msg.error || "Log failed", "err", 8000);
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
      } catch (_) {}
    };
    ws.__qsoLogPatched = true;
  }

  function init() {
    const e = els();
    if (e.input) {
      e.input.addEventListener("input", () => {
        const pos = e.input.selectionStart;
        e.input.value = e.input.value.toUpperCase();
        try {
          e.input.setSelectionRange(pos, pos);
        } catch (_) {}
      });
    }
    // Enter in the input submits the form -> Log
    if (e.form) {
      e.form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        doLog();
      });
    }
    setInterval(patchWs, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
