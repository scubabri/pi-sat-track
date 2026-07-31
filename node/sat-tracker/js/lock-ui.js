/** LOCK button wiring (VFO lock). Loaded after tracker.js */
(function () {
  let locked = false;

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

  function initLockButton() {
    const btn = document.getElementById("btn-lock");
    if (!btn) return;
    btn.addEventListener("click", () => sendLock(!locked));
    updateLockUi(false);
  }

  // Patch into tick/status path if applyFreqAndLook exists
  const origApply =
    typeof applyFreqAndLook === "function" ? applyFreqAndLook : null;
  if (origApply) {
    window.applyFreqAndLook = function (msg) {
      origApply(msg);
      if (typeof msg.locked === "boolean") updateLockUi(msg.locked);
    };
  }

  const origTci = typeof applyTciStatus === "function" ? applyTciStatus : null;
  if (origTci) {
    window.applyTciStatus = function (msg) {
      origTci(msg);
      if (typeof msg.locked === "boolean") updateLockUi(msg.locked);
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initLockButton);
  } else {
    initLockButton();
  }

  // Expose for debugging
  window.__setLockUi = updateLockUi;
})();
