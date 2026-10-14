// "Report to AMSAT" dialog. Submits only when the user clicks Submit.
(function () {
  const $ = (id) => document.getElementById(id);
  let report = "Heard";
  function setStatus(msg, cls) { const s = $("amsat-status"); s.textContent = msg || ""; s.className = "amsat-status " + (cls || ""); }
  function pickReport(v) {
    report = v;
    document.querySelectorAll("#amsat-reports button").forEach((b) => b.classList.toggle("sel", b.dataset.v === v));
  }
  async function open() {
    $("amsat-backdrop").hidden = false;
    setStatus("Loading AMSAT satellite list…");
    $("amsat-submit").disabled = true;
    let cfg = {};
    try { cfg = (typeof loadConfig === "function" && loadConfig()) || {}; } catch (_) {}
    if (!$("amsat-call").value) $("amsat-call").value = (cfg.callsign || "").toUpperCase();
    if (!$("amsat-grid").value) $("amsat-grid").value = (cfg.grid || "").slice(0, 6);
    const now = new Date();
    $("amsat-date").value = now.toISOString().slice(0, 10);
    $("amsat-hour").value = now.getUTCHours();
    $("amsat-period").value = String(Math.floor(now.getUTCMinutes() / 15));
    try {
      const r = await fetch("/api/amsat-report/suggest");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
      const sel = $("amsat-sat");
      sel.innerHTML = "";
      const sugg = new Set(j.suggestions || []);
      const add = (v, parent) => { const o = document.createElement("option"); o.value = v; o.textContent = v.replace(/_/g, " "); parent.appendChild(o); };
      if (sugg.size) {
        const g = document.createElement("optgroup"); g.label = "Current satellite" + (j.sat ? " (" + j.sat.name + ")" : "");
        j.suggestions.forEach((v) => add(v, g)); sel.appendChild(g);
      }
      const g2 = document.createElement("optgroup"); g2.label = "All";
      j.names.filter((v) => !sugg.has(v)).forEach((v) => add(v, g2)); sel.appendChild(g2);
      if (j.best) sel.value = j.best;
      setStatus(j.best ? "" : "No AMSAT match for current satellite — pick one.");
      $("amsat-submit").disabled = false;
    } catch (e) { setStatus("Could not load AMSAT list: " + e.message, "err"); }
  }
  function close() { $("amsat-backdrop").hidden = true; }
  async function submit() {
    const [y, m, d] = ($("amsat-date").value || "").split("-").map(Number);
    const body = {
      satName: $("amsat-sat").value, report,
      callsign: $("amsat-call").value.trim().toUpperCase(), grid: $("amsat-grid").value.trim(),
      year: y, month: m, day: d, hour: Number($("amsat-hour").value), period: Number($("amsat-period").value),
    };
    $("amsat-submit").disabled = true;
    setStatus("Submitting…");
    try {
      const r = await fetch("/api/amsat-report/submit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
      setStatus(j.message, j.confirmed ? "ok" : "");
    } catch (e) { setStatus("Error: " + e.message, "err"); }
    $("amsat-submit").disabled = false;
  }
  function init() {
    const rep = $("amsat-reports");
    [["Heard", "Sat/Mode Active"], ["Telemetry Only", "TLM/Beacon Only"], ["Not Heard", "Not Heard"]].forEach(([v, l]) => {
      const b = document.createElement("button"); b.type = "button"; b.dataset.v = v; b.textContent = l;
      b.onclick = () => pickReport(v); rep.appendChild(b);
    });
    pickReport("Heard");
    $("btn-amsat-report").onclick = open;
    $("amsat-cancel").onclick = close;
    $("amsat-submit").onclick = submit;
    $("amsat-backdrop").addEventListener("click", (e) => { if (e.target.id === "amsat-backdrop") close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("amsat-backdrop").hidden) close(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
