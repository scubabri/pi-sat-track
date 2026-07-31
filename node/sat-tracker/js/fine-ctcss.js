/** Dual UL/DL fine-tune + CTCSS access/activation UI */

(function () {
  let ulFineOffset = 0;
  let dlFineOffset = 0;
  let fineStep = 100;
  let ctcssMode = "off";
  let ctcssAccessHz = null;
  let ctcssActivationHz = null;

  function fmtOffsetHz(hz) {
    if (hz == null || !Number.isFinite(hz) || hz === 0) return "0 Hz";
    const sign = hz > 0 ? "+" : "";
    return sign + Math.round(hz) + " Hz";
  }

  function updateDisplays() {
    const ulEl = document.getElementById("fine-offset-ul");
    const dlEl = document.getElementById("fine-offset-dl");
    if (ulEl) {
      ulEl.textContent = fmtOffsetHz(ulFineOffset);
      ulEl.classList.toggle("nonzero", Math.abs(ulFineOffset) >= 1);
    }
    if (dlEl) {
      dlEl.textContent = fmtOffsetHz(dlFineOffset);
      dlEl.classList.toggle("nonzero", Math.abs(dlFineOffset) >= 1);
    }
    const stepEl = document.getElementById("fine-step");
    if (stepEl) stepEl.value = String(fineStep);

    const row = document.getElementById("ctcss-row");
    const has = ctcssAccessHz != null || ctcssActivationHz != null;
    if (row) row.hidden = !has;

    const btnAcc = document.getElementById("btn-ctcss-access");
    const btnAct = document.getElementById("btn-ctcss-activation");
    const btnOff = document.getElementById("btn-ctcss-off");
    if (btnAcc) {
      btnAcc.hidden = ctcssAccessHz == null;
      btnAcc.textContent =
        "Access " +
        (ctcssAccessHz != null ? ctcssAccessHz.toFixed(1) : "") +
        " Hz";
      btnAcc.classList.toggle("active", ctcssMode === "access");
    }
    if (btnAct) {
      btnAct.hidden = ctcssActivationHz == null;
      btnAct.textContent =
        "Activate " +
        (ctcssActivationHz != null ? ctcssActivationHz.toFixed(1) : "") +
        " Hz";
      btnAct.classList.toggle("active", ctcssMode === "activation");
    }
    if (btnOff) {
      btnOff.classList.toggle("active", ctcssMode === "off");
    }
  }

  function sendFine(delta, side) {
    if (side === "dl") dlFineOffset += delta;
    else ulFineOffset += delta;
    updateDisplays();
    if (typeof ws !== "undefined" && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "fine",
          delta: delta,
          side: side,
          step: fineStep,
        }),
      );
    }
  }

  function sendCenter() {
    ulFineOffset = 0;
    dlFineOffset = 0;
    updateDisplays();
    if (typeof ws !== "undefined" && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "center" }));
    }
  }

  function sendCtcss(which) {
    let next = which;
    if (which === ctcssMode) next = "off";
    ctcssMode = next;
    updateDisplays();
    if (typeof ws !== "undefined" && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ctcss", which: next }));
    }
  }

  function applyFromMsg(msg) {
    if (!msg || typeof msg !== "object") return;
    if (typeof msg.ulFineOffset === "number") ulFineOffset = msg.ulFineOffset;
    if (typeof msg.dlFineOffset === "number") dlFineOffset = msg.dlFineOffset;
    if (typeof msg.ctcssMode === "string") ctcssMode = msg.ctcssMode;
    if (msg.ctcssAccessHz !== undefined) ctcssAccessHz = msg.ctcssAccessHz;
    if (msg.ctcssActivationHz !== undefined)
      ctcssActivationHz = msg.ctcssActivationHz;
    if (msg.modes && msg.modes.length) {
      const idx = msg.modeIndex != null ? msg.modeIndex : 0;
      const m = msg.modes[idx] || msg.modes[0];
      if (m) {
        if (m.ctcssAccess != null) ctcssAccessHz = m.ctcssAccess;
        if (m.ctcssActivation != null) ctcssActivationHz = m.ctcssActivation;
      }
    }
    updateDisplays();
  }

  window.applyFineCtcssFromTick = applyFromMsg;

  function patchWs() {
    if (typeof ws === "undefined" || !ws) return;
    if (ws.__fineCtcssPatched) return;
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
    ws.__fineCtcssPatched = true;
  }

  function initFineCtcss() {
    const bind = (id, side, sign) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("click", () => {
        const stepEl = document.getElementById("fine-step");
        const step = parseInt(stepEl && stepEl.value, 10) || fineStep;
        fineStep = step;
        sendFine(sign * step, side);
      });
    };
    bind("btn-fine-ul-minus", "ul", -1);
    bind("btn-fine-ul-plus", "ul", +1);
    bind("btn-fine-dl-minus", "dl", -1);
    bind("btn-fine-dl-plus", "dl", +1);

    const stepEl = document.getElementById("fine-step");
    if (stepEl) {
      stepEl.addEventListener("change", () => {
        const step = parseInt(stepEl.value, 10);
        if (Number.isFinite(step) && step > 0) fineStep = step;
      });
      stepEl.addEventListener("dblclick", sendCenter);
    }

    const centerBtn = document.getElementById("btn-fine-center");
    if (centerBtn) centerBtn.addEventListener("click", sendCenter);

    const acc = document.getElementById("btn-ctcss-access");
    const act = document.getElementById("btn-ctcss-activation");
    const off = document.getElementById("btn-ctcss-off");
    if (acc) acc.addEventListener("click", () => sendCtcss("access"));
    if (act) act.addEventListener("click", () => sendCtcss("activation"));
    if (off) off.addEventListener("click", () => sendCtcss("off"));

    updateDisplays();
    setInterval(patchWs, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initFineCtcss);
  } else {
    initFineCtcss();
  }
})();
