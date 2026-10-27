/**
 * Configure → Station → Backup & restore.
 *  - Download backup: GET /api/backup (server config files) + this browser's
 *    localStorage preferences -> pi-sat-track-backup-<YYYY-MM-DD-HHMM>.json.
 *  - Restore from backup: pick a file -> POST /api/restore?check=1 (validate +
 *    summary) -> confirm -> POST /api/restore (server keeps a pre-restore safety
 *    copy and reloads its config live) -> browser prefs applied -> page reload.
 * Format / validation: lib/backup.js.
 */
(function () {
  "use strict";
  const FORMAT = "pi-sat-track-backup";
  const VERSION = 1;
  /** Keep in sync with lib/backup.js BROWSER_EXCLUDE (caches of server state / history). */
  const BROWSER_EXCLUDE = [
    "satTrackerConfig",
    "satTrackerProfileName",
    "satTrackerAlerts",
    "satTrackerAutoEngagePasses",
    "satTrackerFavorites",
    "aprsHistory",
  ];
  const MAX_VALUE = 256 * 1024;

  function browserPrefs() {
    const out = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || BROWSER_EXCLUDE.includes(k)) continue;
        const v = localStorage.getItem(k);
        if (typeof v === "string" && v.length <= MAX_VALUE) out[k] = v;
      }
    } catch (_) {}
    return out;
  }

  function fileName(d) {
    const p = (n) => String(n).padStart(2, "0");
    return "pi-sat-track-backup-" + d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + ".json";
  }

  function status(msg, kind) {
    const el = document.getElementById("backup-status");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "form-hint backup-status" + (kind ? " " + kind : "");
  }

  async function download() {
    status("Preparing backup…");
    try {
      const r = await fetch("/api/backup", { cache: "no-store" });
      const b = await r.json();
      if (!r.ok || !b || b.format !== FORMAT) throw new Error((b && b.error) || "HTTP " + r.status);
      if (!b.appVersion) {
        try { b.appVersion = (await (await fetch("/api/version", { cache: "no-store" })).json()).version || ""; } catch (_) {}
      }
      b.browser = browserPrefs();
      const blob = new Blob([JSON.stringify(b, null, 2) + "\n"], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = fileName(new Date());
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      const n = Object.keys((b.server && b.server.profiles && b.server.profiles.profiles) || {}).length;
      status("Saved " + a.download + " (" + n + " profile" + (n === 1 ? "" : "s") + ", " + Object.keys(b.browser).length + " browser preferences).", "ok");
    } catch (e) {
      status("Backup failed: " + (e.message || e), "err");
    }
  }

  function summaryText(s) {
    const lines = [];
    lines.push("Replace ALL settings on this pi-sat-track server with this backup?");
    lines.push("");
    lines.push("Backup: " + (s.created ? s.created.replace("T", " ").replace(/\.\d+Z$/, " UTC") : "unknown date") + (s.appVersion ? " · app " + s.appVersion : ""));
    lines.push("• " + s.profileNames.length + " profile" + (s.profileNames.length === 1 ? "" : "s") + ": " + s.profileNames.join(", ") + " (active: " + s.activeProfile + ")");
    lines.push("• " + s.favorites + " favorites in total, saved offsets for " + s.offsetSats + " sat(s)" + (s.tleSources ? ", TLE sources " + s.tleSources.join(" → ") : ""));
    lines.push("• " + (s.browserKeys ? s.browserKeys + " browser preferences (applied to this browser)" : "no browser preferences"));
    lines.push("");
    lines.push("Your current settings are saved first to ~/.rpitrack/backups/ on the server. The page reloads afterwards.");
    return lines.join("\n");
  }

  async function post(url, text) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: text });
    let j = null;
    try { j = await r.json(); } catch (_) {}
    return j || { ok: false, error: "HTTP " + r.status };
  }

  async function restoreFile(file) {
    if (!file) return;
    status("Checking " + file.name + "…");
    let text, parsed;
    try {
      text = await file.text();
      parsed = JSON.parse(text);
    } catch (_) {
      status("Not a pi-sat-track backup: " + file.name + " is not a JSON file.", "err");
      return;
    }
    if (!parsed || parsed.format !== FORMAT) {
      status("Not a pi-sat-track backup: " + file.name + " has no \"" + FORMAT + "\" format tag.", "err");
      return;
    }
    if (parsed.version > VERSION) {
      status("This backup (version " + parsed.version + ") is newer than this app understands. Update pi-sat-track first.", "err");
      return;
    }
    const chk = await post("/api/restore?check=1", text).catch((e) => ({ ok: false, error: e.message }));
    if (!chk.ok) {
      status("Cannot restore " + file.name + ": " + chk.error, "err");
      return;
    }
    if (!window.confirm(summaryText(chk.summary))) {
      status("Restore cancelled; nothing changed.");
      return;
    }
    status("Restoring…");
    const r = await post("/api/restore", text).catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) {
      status("Restore failed: " + r.error, "err");
      return;
    }
    // Browser prefs: set the backup's keys (others in this browser are kept).
    const b = parsed.browser && typeof parsed.browser === "object" ? parsed.browser : {};
    let n = 0;
    for (const [k, v] of Object.entries(b)) {
      if (BROWSER_EXCLUDE.includes(k) || typeof v !== "string" || v.length > MAX_VALUE) continue;
      try { localStorage.setItem(k, v); n++; } catch (_) {}
    }
    // Server caches in this browser are stale now; the server resends them on load.
    for (const k of BROWSER_EXCLUDE) if (k !== "aprsHistory") try { localStorage.removeItem(k); } catch (_) {}
    status("Restored " + r.summary.profileNames.length + " profile(s)" + (n ? " and " + n + " browser preferences" : "") + ". Previous settings saved to " + r.safetyCopy + ". Reloading…", "ok");
    setTimeout(() => location.reload(), 1500);
  }

  function init() {
    const dl = document.getElementById("btn-backup-download");
    const rs = document.getElementById("btn-backup-restore");
    const fi = document.getElementById("backup-file");
    if (dl) dl.addEventListener("click", download);
    if (rs && fi) {
      rs.addEventListener("click", () => { fi.value = ""; fi.click(); });
      fi.addEventListener("change", () => restoreFile(fi.files && fi.files[0]));
    }
  }
  window.settingsBackup = { browserPrefs, fileName, summaryText, download, restoreFile, BROWSER_EXCLUDE };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
