/**
 * WSJT-X station list window (green "WSJT Heard" state, js/decode-overlay.js),
 * modelled on the APRS station window (js/aprs-float.js chrome, position /
 * size in localStorage "wsjtxListWin").
 *
 * Rows: every station WSJT-X decoded within the server's expiry (15 min),
 * colored like the map (red = calling you, green = CQ / 73, yellow = other),
 * sorted calling-you first, then CQ / 73, then the rest, newest first; they
 * fade with age and drop out on expiry like the APRS recent stations.
 * Clicking a row answers that station in WSJT-X (UDP Reply, same as clicking
 * it on the map) while WSJT-X is connected. Closing the window steps the
 * button back to map-only.
 */
(function () {
  const MAX_ROWS = 100;
  let win = null;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const D = () => window.decodeOverlay || null;
  function ago(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + " s";
    return Math.round(s / 60) + " min";
  }
  function hhmm(t) {
    const A = window.APRS;
    if (A && A.fmtTimeShort) return A.fmtTimeShort(t).replace(/ (UTC|MT)$/, "");
    const d = new Date(t);
    return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
  }
  const KIND_LABEL = { me: "calling you", cq: "CQ / 73", other: "other" };

  function build() {
    if (win || !window.aprsFloat) return win;
    win = window.aprsFloat.create({
      id: "wsjtx-list-win",
      cls: "aprs-station-win wsjtx-list-win",
      title: "WSJT-X",
      label: "WSJT-X stations",
      lsKey: "wsjtxListWin",
      width: 300,
      minW: 240,
      minH: 160,
      defaultX: (w) => Math.max(8, window.innerWidth - w - 680),
      defaultY: 150,
    });
    win.body.innerHTML =
      '<div class="wsjtx-st" id="wsjtx-st"></div>' +
      '<div class="wsjtx-legend">' +
      ["me", "cq", "other"].map((k) => '<span class="wsjtx-lg"><i class="wsjtx-dot k-' + k + '"></i>' + KIND_LABEL[k] + "</span>").join("") +
      "</div>" +
      '<div class="wsjtx-rows" id="wsjtx-rows" aria-live="polite"></div>';
    win.body.addEventListener("click", (e) => {
      const row = e.target.closest && e.target.closest(".wsjtx-row");
      if (!row || !D()) return;
      if (!D().canReply()) return;
      D().reply(row.dataset.call);
      row.classList.add("sent");
      setTimeout(() => row.classList.remove("sent"), 1500);
    });
    win.onChange((st) => {
      // Closed with × while the button says "list": step back to map-only.
      if (!st.open && D() && D().mode() === "list") D().setMode("map");
      render();
    });
    return win;
  }

  function render() {
    if (!win || !win.isOpen() || !D()) return;
    const can = D().canReply();
    const st = win.body.querySelector("#wsjtx-st");
    const client = D().client ? D().client() : "";
    st.className = "wsjtx-st " + (can ? "ok" : "off");
    st.textContent = can
      ? "WSJT-X connected" + (client ? " (" + client + ")" : "") + " · click a station to answer it"
      : "WSJT-X not connected · click-to-answer off";
    const items = D().list().slice(0, MAX_ROWS);
    const rows = win.body.querySelector("#wsjtx-rows");
    rows.classList.toggle("can-reply", can);
    rows.innerHTML = items.length
      ? items
          .map((s) => {
            const snr = Number.isFinite(s.snr) ? (s.snr > 0 ? "+" : "") + s.snr : "";
            return (
              '<div class="wsjtx-row k-' + esc(s.kind) + '" data-call="' + esc(s.call) + '" style="opacity:' + s.opacity.toFixed(2) + '" title="' +
              esc(s.tip + (can ? "\nClick: answer " + s.call + " in WSJT-X" : "")) + '">' +
              '<i class="wsjtx-dot k-' + esc(s.kind) + '"></i>' +
              '<span class="wsjtx-call">' + esc(s.call) + "</span>" +
              '<span class="wsjtx-grid">' + esc(s.grid || "\u2014") + "</span>" +
              '<span class="wsjtx-snr">' + esc(snr) + "</span>" +
              '<span class="wsjtx-msg">' + esc(s.message || "") + "</span>" +
              '<span class="wsjtx-age" title="Last heard ' + esc(hhmm(s.lastHeard)) + '">' + esc(ago(s.age)) + "</span></div>"
            );
          })
          .join("")
      : '<div class="aprs-hl-empty">No WSJT-X decodes yet</div>';
  }

  function sync() {
    const d = D();
    if (!d) return;
    const want = d.mode() === "list";
    if (want) {
      build();
      if (win && !win.isOpen()) win.open();
    } else if (win && win.isOpen()) win.close();
    render();
  }

  window.wsjtxList = { render, sync, window: () => win };
  function init() {
    document.addEventListener("decode-overlay-mode", sync);
    document.addEventListener("decode-overlay-change", render);
    setInterval(render, 10000); // ages / fading / expiry between updates
    const t = setInterval(() => {
      if (window.aprsFloat && D()) {
        clearInterval(t);
        sync();
      }
    }, 300);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
