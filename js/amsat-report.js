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
  function amsatLabel(v) {
    // AO-91_[FM] → "AO-91 [FM]"; ISS_[VHF_Digi] → "ISS [VHF Digi]"
    return String(v || "").replace(/_/g, " ");
  }
  function render() {
    const local = cfgStation();
    const call = (info && info.station && info.station.callsign) || local.callsign;
    let why = "";
    if (!info) why = "AMSAT satellite list not loaded";
    else if (!info.sat) why = "No satellite selected";
    else if (!info.best) why = "No AMSAT match for " + info.sat.name + (info.sat.mode ? " (" + info.sat.mode + ")" : "");
    else if (!call) why = "Set your callsign in config to report to AMSAT";
    btns().forEach((b) => {
      b.disabled = busy || !!why;
      if (why) {
        b.title = why;
        return;
      }
      // Match AMSAT row (includes mode tag) + report type; mention tracker mode when present
      const satMode = info.sat && info.sat.mode ? "; tracker mode " + info.sat.mode : "";
      b.title = "Report " + amsatLabel(info.best) + " as " + reportLabel(b.dataset.v) + " (" + call + ")" + satMode;
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
    busy = false; render();
  }
  function init() {
    btns().forEach((b) => (b.onclick = () => submit(b.dataset.v)));
    refresh();
    setInterval(() => { if (!busy) refresh(); }, 10000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
