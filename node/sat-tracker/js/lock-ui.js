/** LOCK button — VFO lock UI + WS status sync */
(function () {
  let locked = false;
  let patched = false;

  function updateLockUi(on) {
    locked = !!on;
    const btn = document.getElementById("btn-lock");
    if (!btn) return;
    btn.classList.toggle("active", locked);
    btn.title = locked
      ? "VFO locked — operator DL tunes ignored (click to unlock)"
      : "VFO unlocked — operator DL tunes adjust UL (click to lock)";
  }

  function sendLock(on) {
    if (typeof ws !== "undefined" && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "lock", on: !!on }));
    }
    updateLockUi(on);
  }

  function tryPatchWs() {
    if (patched) return;
    if (typeof ws === "undefined" || !ws || !ws.onmessage) return;
    const prev = ws.onmessage.bind(ws);
    ws.onmessage = function (ev) {
      prev(ev);
      try {
        const msg = JSON.parse(ev.data);
        if (typeof msg.locked === "boolean") updateLockUi(msg.locked);
        if (msg.type === "tci" && typeof msg.locked === "boolean") {
          updateLockUi(msg.locked);
        }
      } catch (_) {}
    };
    patched = true;
  }

  function initLockButton() {
    const btn = document.getElementById("btn-lock");
    if (!btn) return;
    btn.addEventListener("click", () => sendLock(!locked));
    updateLockUi(false);
    setInterval(tryPatchWs, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initLockButton);
  } else {
    initLockButton();
  }
})();
