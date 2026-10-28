/**
 * Station Configuration modal: tabs, backdrop, Esc/X/Cancel close,
 * unsaved-change dots, sidebar summary card. Layout only — open/close,
 * fill and save logic stay in config.js (#config-panel.open toggle).
 */
(function () {
  function txt(sel) {
    if (!sel || sel.selectedIndex < 0) return "";
    const o = sel.options[sel.selectedIndex];
    return o ? o.textContent.trim() : "";
  }

  function updateSummary() {
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) { el.textContent = v || "-"; el.title = v || ""; }
    };
    let cfg = {};
    try { cfg = typeof loadConfig === "function" ? loadConfig() : {}; } catch (e) {}
    // the active profile, not an unsaved pick in Configure
    set("cfg-sum-profile", (typeof activeProfileName !== "undefined" && activeProfileName) || txt(document.getElementById("cfg-profile")));
    set("cfg-sum-grid", cfg.grid || document.getElementById("cfg-grid")?.value);
    // Serial connections use make/model; the TCP "Radio / software" select is stale then.
    const radioName = (side) => {
      const tr = document.getElementById("cfg-" + side + "-transport");
      if (tr && tr.value === "hamlib") {
        const m = document.getElementById("cfg-" + side + "-hamlib-model");
        const t = m && m.selectedIndex >= 0 ? m.options[m.selectedIndex].textContent.split(" · ")[0] : "";
        return "Hamlib " + (t || "serial");
      }
      if (tr && tr.value === "serial") {
        const make = txt(document.getElementById("cfg-" + side + "-serial-make"));
        const model = txt(document.getElementById("cfg-" + side + "-serial-model"));
        return model ? (make && !model.startsWith(make) ? make + " " + model : model) : make;
      }
      return txt(document.getElementById("cfg-" + side + "-type"));
    };
    const ulType = radioName("ul");
    const dlType = radioName("dl");
    const single = document.getElementById("cfg-single-radio")?.checked;
    set("cfg-sum-radio", single || !dlType || ulType === dlType ? ulType : ulType + " / " + dlType);
    set("cfg-sum-rotor", txt(document.getElementById("cfg-rotor-type")));
    set("cfg-sum-log", txt(document.getElementById("cfg-log-method")));
  }

  /** Station → Version: build label from the server (/api/version). */
  function loadVersion() {
    const el = document.getElementById("cfg-sum-version");
    if (!el || typeof fetch !== "function") return;
    fetch("/api/version", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j || !j.version) return;
        el.textContent = j.version;
        el.title = j.version + (j.source === "build" || j.source === "installed" ? " (installer build)" : j.source === "git" ? " (git checkout: branch+commit)" : "");
      })
      .catch(() => {});
  }

  function init() {
    loadVersion();
    const panel = document.getElementById("config-panel");
    const backdrop = document.getElementById("config-backdrop");
    const cfgBtn = document.getElementById("btn-config");
    if (!panel) return;
    const tabs = Array.from(panel.querySelectorAll(".cfg-tab"));
    const panes = Array.from(panel.querySelectorAll(".cfg-tab-pane"));

    function showTab(name) {
      tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
      panes.forEach((p) => { p.hidden = p.dataset.tab !== name; });
    }
    tabs.forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));

    function clearDirty() { tabs.forEach((t) => t.classList.remove("dirty")); }
    function markDirty(e) {
      if (!e.isTrusted) return;
      const pane = e.target.closest && e.target.closest(".cfg-tab-pane");
      if (!pane) return;
      const tab = tabs.find((t) => t.dataset.tab === pane.dataset.tab);
      if (tab) tab.classList.add("dirty");
    }
    panel.addEventListener("input", markDirty);
    panel.addEventListener("change", markDirty);

    function close() { panel.classList.remove("open"); }
    function open() {
      if (!panel.classList.contains("open") && cfgBtn) cfgBtn.click();
    }

    // Mirror .open (toggled by config.js) onto backdrop/body
    let wasOpen = false;
    new MutationObserver(() => {
      const isOpen = panel.classList.contains("open");
      if (isOpen === wasOpen) return;
      wasOpen = isOpen;
      if (backdrop) backdrop.hidden = !isOpen;
      document.body.classList.toggle("cfg-modal-open", isOpen);
      clearDirty();
      if (!isOpen) setTimeout(updateSummary, 0);
    }).observe(panel, { attributes: true, attributeFilter: ["class"] });

    document.getElementById("btn-config-close")?.addEventListener("click", close);
    document.getElementById("btn-cancel-config")?.addEventListener("click", close);
    document.getElementById("btn-config-open")?.addEventListener("click", (e) => {
      e.stopPropagation(); // config.js closes on outside document clicks
      open();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && panel.classList.contains("open")) close();
    });
    // Backdrop click: config.js's document click handler already closes.

    document.getElementById("cfg-profile")?.addEventListener("change", () => setTimeout(updateSummary, 300));
    updateSummary();
    setTimeout(updateSummary, 1500);
    setTimeout(updateSummary, 4000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
