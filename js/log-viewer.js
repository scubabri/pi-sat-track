/**
 * Open server log popup (log-viewer.html).
 * Wire from index.html: <script src="js/log-viewer.js"></script>
 * Button: <button class="btn" id="btn-log" title="Server log">Log</button>
 */
(function () {
  let logWin = null;

  function openLogViewer() {
    const url = "/log-viewer.html";
    try {
      if (logWin && !logWin.closed) {
        logWin.focus();
        return logWin;
      }
    } catch (_) {
      logWin = null;
    }
    const features =
      "width=900,height=560,menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes";
    logWin = window.open(url, "piSatTrackLog", features);
    if (!logWin) {
      console.warn(
        "Log popup blocked — allow popups for this site, or open /log-viewer.html",
      );
      // Fallback: same tab
      try {
        window.location.href = url;
      } catch (_) {}
      return null;
    }
    return logWin;
  }

  function initLogViewerButton() {
    const btn = document.getElementById("btn-log");
    if (!btn) return;
    btn.addEventListener("click", function (ev) {
      ev.preventDefault();
      openLogViewer();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initLogViewerButton);
  } else {
    initLogViewerButton();
  }

  // Optional global for console debugging
  window.openLogViewer = openLogViewer;
})();
