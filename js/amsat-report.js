// Inline AMSAT live-report buttons (own AMSAT Report sidebar section). One click submits;
// satellite, callsign/grid and UTC time are filled in server-side.
(function () {
  const $ = (id) => document.getElementById(id);
  let info = null, busy = false;
  const btns = () => document.querySelectorAll("#amsat-inline .amsat-rep");
  function setStatus(msg, cls) { const s = $("amsat-status"); s.textContent = msg || ""; s.className = "amsat-status " + (cls || ""); }
  function cfgStation() {
    let c = {};
    try { c = (typeof loadConfig === "function" && loadConfig()) || {}; } catch (_) {}
    return { callsign: String(c.callsign || "").trim().toUpperCase(), grid: String(c.grid || "").trim() };
  }
  function reportLabel(v) {
    const row = info && info.reports && info.reports.find((r) => r.value === v);
    return (row && row.label) || v;
  }
  function utcHm(t) {
    return new Date(t).toISOString().substr(11, 5) + " UTC";
  }
  function toast(text, isErr) {
    const old = document.getElementById("amsat-toast");
    if (old) old.remove();
    const t = document.createElement("div");
    t.id = "amsat-toast";
    t.className = "app-toast" + (isErr ? " app-toast-err" : "");
    t.setAttribute("role", "status");
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), isErr ? 8000 : 5000);
  }
  /** Server ran the auto Heard after a logged QSO (lib/amsat-auto.js). */
  window.onAmsatAuto = function (evt) {
    if (!evt) return;
    const name = evt.display || evt.satName || evt.satKey || "satellite";
    if (evt.status === "sent") {
      toast("AMSAT: Heard reported for " + name);
      setStatus(
        "Auto: reported " + amsatLabel(evt.satName || name) + " Heard - " + (evt.confirmed ? "confirmed" : "not yet visible"),
        evt.confirmed ? "ok" : "",
      );
    } else if (evt.status === "error") {
      toast("AMSAT: Heard report for " + name + " failed - " + (evt.error || "error"), true);
      setStatus("AMSAT auto error: " + (evt.error || "error"), "err");
    }
    refresh();
  };
  function amsatLabel(v) {
    // AO-91_[FM] → "AO-91 [FM]"; ISS_[VHF_Digi] → "ISS [VHF Digi]"
    return String(v || "").replace(/_/g, " ");
  }
  /**
   * Tooltip mode line: the AMSAT mode actually submitted (tag of the matched
   * row, e.g. "FM" in ISS_[FM]) and the selected tracker mode it came from.
   */
  function modeLine(i) {
    const tag = i.reportMode || (String(i.best || "").match(/_\[(.*)\]$/) || [])[1] || "";
    const sel = i.sat && i.sat.mode ? i.sat.mode : "";
    if (!tag && !sel) return "";
    return "\nAMSAT mode: " + (tag ? amsatLabel(tag) : "(none)") + (sel ? " \u2014 for selected mode \u201C" + sel + "\u201D" : "");
  }
  function render() {
    const local = cfgStation();
    const call = (info && info.station && info.station.callsign) || local.callsign;
    let why = "";
    if (!info) why = "AMSAT satellite list not loaded";
    else if (!info.sat) why = "No satellite selected";
    else if (!info.best) why = "No AMSAT match for " + info.sat.name + (info.sat.mode ? " (" + info.sat.mode + ")" : "");
    else if (!call) why = "Set your callsign in config to report to AMSAT";
    const heard = info && info.heardThisPass;
    btns().forEach((b) => {
      b.disabled = busy || !!why;
      const isHeard = b.dataset.v === "Heard";
      b.classList.toggle("sent", isHeard && !!heard && !why);
      if (why) {
        b.title = why;
        return;
      }
      b.title = "Report " + amsatLabel(info.best) + " as " + reportLabel(b.dataset.v) + " (" + call + ")" + modeLine(info);
      if (isHeard && heard) {
        b.title +=
          "\nHeard already reported this pass at " + utcHm(heard.at) +
          (heard.source === "button" ? "" : " (auto, on logged QSO)");
      }
      if (isHeard && info.autoHeard) b.title += "\nAuto: logging a QSO also reports Heard (once per pass)";
    });
  }
  async function refresh() {
    try {
      const r = await fetch("/api/amsat-report/suggest");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
      info = j;
    } catch (_) { info = null; }
    render();
  }
  async function submit(report) {
    if (busy) return;
    busy = true; render();
    setStatus("Reporting " + report + "…");
    const local = cfgStation();
    try {
      const r = await fetch("/api/amsat-report/submit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ report, fallbackCallsign: local.callsign, fallbackGrid: local.grid }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
      setStatus("Reported " + j.satName + " " + report + " - " + (j.confirmed ? "confirmed" : "not yet visible"), j.confirmed ? "ok" : "");
    } catch (e) { setStatus("AMSAT error: " + e.message, "err"); }
    busy = false;
    refresh();
  }
  // Re-fetch as soon as the selected sat / mode changes, so the tooltip never
  // shows the previous mode for up to the 10 s poll (submit always uses the current one).
  let lastSelKey = null;
  function noteSelection(sat, modeIndex) {
    const k = String(sat || "") + "|" + String(modeIndex != null ? modeIndex : "");
    if (k === lastSelKey) return;
    const first = lastSelKey == null;
    lastSelKey = k;
    if (!first && !busy) refresh();
  }
  function patchWs() {
    if (typeof ws === "undefined" || !ws || ws.__amsatReportPatched) return;
    ws.__amsatReportPatched = true;
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string" || ev.data.indexOf('"modeIndex"') < 0) return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg && msg.sat !== undefined && msg.modeIndex !== undefined) noteSelection(msg.sat, msg.modeIndex);
      } catch (_) {}
    });
  }
  function init() {
    btns().forEach((b) => (b.onclick = () => submit(b.dataset.v)));
    const sel = document.getElementById("mode-select");
    if (sel) sel.addEventListener("change", () => setTimeout(() => { if (!busy) refresh(); }, 300));
    setInterval(patchWs, 500);
    refresh();
    setInterval(() => { if (!busy) refresh(); }, 10000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
