/** Fix UL — hold published uplink (no Doppler). FM / 2m-UL default ON. */

(function () {
  let ulFixed = false;
  let isFm = false;

  function updateUi() {
    const btn = document.getElementById("btn-ul-fixed");
    if (!btn) return;
    btn.hidden = !isFm;
    btn.classList.toggle("active", ulFixed);
    btn.title = ulFixed
      ? "UL fixed to published frequency (no Doppler) — click to enable UL Doppler"
      : "UL Doppler ON — click to fix UL at published frequency";
  }

  function sendUlFixed(on) {
    ulFixed = !!on;
    updateUi();
    if (typeof ws !== "undefined" && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ulFixed", on: ulFixed }));
    }
  }

  function applyFromMsg(msg) {
    if (!msg) return;
    if (typeof msg.ulFixed === "boolean") ulFixed = msg.ulFixed;
    if (typeof msg.isFm === "boolean") isFm = msg.isFm;
    else if (msg.modes && msg.modes.length) {
      const m = msg.modes[msg.modeIndex != null ? msg.modeIndex : 0];
      if (m && typeof m.isFm === "boolean") isFm = m.isFm;
    }
    updateUi();
  }

  window.applyUlFixedFromTick = applyFromMsg;

  function patchWs() {
    if (typeof ws === "undefined" || !ws) return;
    if (ws.__ulFixedPatched) return;
    const prev = ws.onmessage;
    ws.onmessage = function (ev) {
      if (typeof prev === "function") prev.call(this, ev);
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "tick" || msg.type === "state" || msg.type === "tci") {
          applyFromMsg(msg);
        }
      } catch (_) {}
    };
    ws.__ulFixedPatched = true;
  }

  function init() {
    const btn = document.getElementById("btn-ul-fixed");
    if (btn) {
      btn.addEventListener("click", () => sendUlFixed(!ulFixed));
    }
    updateUi();
    setInterval(patchWs, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
