// Inline AMSAT live-report buttons (Logging section). One click submits;
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
      b.title = why || "Report " + info.best.replace(/_/g, " ") + " as " + b.dataset.v + " (" + call + ")";
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
