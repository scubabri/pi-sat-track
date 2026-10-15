/** Data toggle — USB-D/LSB-D/FM-D (IC-705) or DIGU/DIGL/DFM (Flex). Default OFF. */

(function () {
  let dataMode = false;
  let supported = false;
  let cwMode = false;
  let cwSupported = false;
  let isFm = false;
  let modes = [];
  let modeIndex = 0;
  let tickMode = "";

  function isDataCapableMode(m) {
    const s = String(m || "");
    if (/\bCW\b/i.test(s) && !/\bSSB\b/i.test(s)) return false;
    return true; // SSB / USB / LSB / FM
  }

  function selectedModeStr() {
    const sel = document.getElementById("mode-select");
    const idx = sel && sel.value !== "" ? Number(sel.value) : modeIndex;
    const m = modes[idx] || modes[modeIndex];
    if (m) return m.mode || m.name || "";
    return tickMode;
  }

  function isLinearMode(m) {
    return /\b(SSB|USB|LSB)\b/i.test(String(m || "")) && !isFm;
  }

  function updateUi() {
    const cwBtn = document.getElementById("btn-cw-mode");
    if (cwBtn) {
      cwBtn.hidden = !cwSupported || !isLinearMode(selectedModeStr());
      cwBtn.classList.toggle("active", cwMode);
      cwBtn.title = cwMode
        ? "CW ON (UL + DL CW) — click for voice (USB/LSB)"
        : "CW OFF (voice) — click for CW on UL + DL";
    }
    const btn = document.getElementById("btn-data-mode");
    if (!btn) return;
    void isFm;
    btn.hidden = !supported || !isDataCapableMode(selectedModeStr());
    btn.classList.toggle("active", dataMode);
    btn.title = dataMode
      ? "Data mode ON (USB-D/LSB-D/FM-D; Flex DIGU/DIGL/DFM) — click for voice"
      : "Data mode OFF (voice USB/LSB/FM) — click for data mode";
  }

  function sendCw(on) {
    cwMode = !!on;
    if (cwMode) dataMode = false; // exclusive
    updateUi();
    if (typeof ws !== "undefined" && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "cwMode", on: cwMode }));
    }
  }

  function send(on) {
    dataMode = !!on;
    if (dataMode) cwMode = false; // exclusive
    updateUi();
    if (typeof ws !== "undefined" && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "dataMode", on: dataMode }));
    }
  }

  function applyFromMsg(msg) {
    if (!msg) return;
    if (typeof msg.dataModeSupported === "boolean") supported = msg.dataModeSupported;
    else if (typeof msg.supportsDataMode === "boolean") supported = msg.supportsDataMode;
    if (typeof msg.dataMode === "boolean") dataMode = msg.dataMode;
    if (typeof msg.cwModeSupported === "boolean") cwSupported = msg.cwModeSupported;
    else if (typeof msg.supportsCwMode === "boolean") cwSupported = msg.supportsCwMode;
    if (typeof msg.cwMode === "boolean") cwMode = msg.cwMode;
    if (typeof msg.isFm === "boolean") isFm = msg.isFm;
    if (Array.isArray(msg.modes)) modes = msg.modes;
    if (typeof msg.mode === "string") tickMode = msg.mode;
    if (typeof msg.modeIndex === "number") modeIndex = msg.modeIndex;
    updateUi();
  }

  window.applyDataModeFromTick = applyFromMsg;

  function patchWs() {
    if (typeof ws === "undefined" || !ws || ws.__dataModePatched) return;
    const prev = ws.onmessage;
    ws.onmessage = function (ev) {
      if (typeof prev === "function") prev.call(this, ev);
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "tick" || msg.type === "state" || msg.type === "icom") {
          applyFromMsg(msg);
        }
      } catch (_) {}
    };
    ws.__dataModePatched = true;
  }

  function init() {
    const btn = document.getElementById("btn-data-mode");
    if (btn) btn.addEventListener("click", () => send(!dataMode));
    const cwBtn = document.getElementById("btn-cw-mode");
    if (cwBtn) cwBtn.addEventListener("click", () => sendCw(!cwMode));
    const sel = document.getElementById("mode-select");
    if (sel) sel.addEventListener("change", updateUi); // live on mode change
    updateUi();
    setInterval(patchWs, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
