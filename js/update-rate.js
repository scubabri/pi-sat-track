/** Radio update interval spinner (ms): per-profile radioUpdateMs. */
(function () {
  const MIN = 100, MAX = 2000, STEP = 50, DEF = 250;
  let current = DEF;

  function clamp(v) {
    let n = Math.round(Number(v) / STEP) * STEP;
    if (!Number.isFinite(n)) n = current;
    return Math.max(MIN, Math.min(MAX, n));
  }

  function el() {
    return document.getElementById("update-ms");
  }

  function show(v) {
    current = clamp(v);
    const e = el();
    if (e && document.activeElement !== e) e.value = String(current);
  }

  function send(v) {
    current = clamp(v);
    show(current);
    try {
      if (typeof loadConfig === "function" && typeof saveConfig === "function") {
        const c = loadConfig() || {};
        c.radioUpdateMs = current;
        saveConfig(c);
      }
    } catch (_) {}
    if (typeof ws !== "undefined" && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "radioUpdateMs", ms: current }));
    }
  }

  function bump(dir) {
    const e = el();
    const cur = e ? parseInt(e.value, 10) : current;
    const next = clamp((Number.isFinite(cur) ? cur : current) + dir * STEP);
    if (next !== current) send(next);
    else show(next);
  }

  function patchWs() {
    if (typeof ws === "undefined" || !ws || ws.__updRatePatched) return;
    const prev = ws.onmessage;
    ws.onmessage = function (ev) {
      if (typeof prev === "function") prev.call(this, ev);
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "endpoints" && msg.radioUpdateMs != null) show(msg.radioUpdateMs);
        else if (msg.type === "profiles" && msg.config && msg.config.radioUpdateMs != null)
          show(msg.config.radioUpdateMs);
      } catch (_) {}
    };
    ws.__updRatePatched = true;
  }

  function init() {
    const e = el();
    try {
      const c = typeof loadConfig === "function" ? loadConfig() : null;
      if (c && c.radioUpdateMs != null) show(c.radioUpdateMs);
      else show(DEF);
    } catch (_) {
      show(DEF);
    }
    const up = document.getElementById("btn-update-up");
    const dn = document.getElementById("btn-update-down");
    if (up) up.addEventListener("click", () => bump(+1));
    if (dn) dn.addEventListener("click", () => bump(-1));
    if (e) {
      e.addEventListener("change", () => send(e.value));
      e.addEventListener("wheel", (ev) => {
        ev.preventDefault();
        bump(ev.deltaY < 0 ? +1 : -1);
      }, { passive: false });
      e.addEventListener("keydown", (ev) => {
        if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
          ev.preventDefault();
          bump(ev.key === "ArrowUp" ? +1 : -1);
        }
      });
    }
    setInterval(patchWs, 500);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
