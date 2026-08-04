/**
 * LOCK button UI.
 * Server drives locked via tick/state/tci messages (field: locked).
 * This module wires the button and keeps the green active state in sync.
 */
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
    // tracker.js exposes ws as a top-level binding; also try window.ws
    const sock =
      typeof window !== "undefined" && window.ws
        ? window.ws
        : typeof ws !== "undefined"
          ? ws
          : null;
    if (sock && sock.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify({ type: "lock", on: !!on }));
    }
    updateLockUi(on);
  }

  function handleMsg(msg) {
    if (!msg || typeof msg !== "object") return;
    if (typeof msg.locked === "boolean") updateLockUi(msg.locked);
  }

  function init() {
    const btn = document.getElementById("btn-lock");
    if (btn) {
      btn.addEventListener("click", () => sendLock(!locked));
    }

    // Hook native WebSocket so we see every server message
    const OrigWS = window.WebSocket;
    if (OrigWS && !OrigWS.__lockPatched) {
      function PatchedWS(url, protocols) {
        const sock = protocols
          ? new OrigWS(url, protocols)
          : new OrigWS(url);
        const prev = sock.onmessage;
        sock.addEventListener("message", (ev) => {
          try {
            handleMsg(JSON.parse(ev.data));
          } catch (_) {}
        });
        if (url && String(url).indexOf("/ws") !== -1) {
          window.ws = sock;
        }
        return sock;
      }
      PatchedWS.prototype = OrigWS.prototype;
      PatchedWS.CONNECTING = OrigWS.CONNECTING;
      PatchedWS.OPEN = OrigWS.OPEN;
      PatchedWS.CLOSING = OrigWS.CLOSING;
      PatchedWS.CLOSED = OrigWS.CLOSED;
      PatchedWS.__lockPatched = true;
      window.WebSocket = PatchedWS;
    }

    updateLockUi(false);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.__updateLockUi = updateLockUi;
})();
