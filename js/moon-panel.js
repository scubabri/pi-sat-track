/**
 * Moon (EME) rows in the Satellite Status panel. Shown only while the Moon is
 * the selected target; fed by the 1 Hz "state" message (msg.isMoon, msg.moon,
 * msg.eme; see lib/state.js computeState and lib/moon.js info()).
 */
(function (root) {
  function fmtSigned(n, digits) {
    return (n >= 0 ? "+" : "\u2212") + Math.abs(n).toFixed(digits);
  }
  function fmtLatLon(lat, lon) {
    return (
      Math.abs(lat).toFixed(1) + "\u00B0" + (lat >= 0 ? "N" : "S") + " " +
      Math.abs(lon).toFixed(1) + "\u00B0" + (lon >= 0 ? "E" : "W")
    );
  }
  function set(id, text, title) {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.textContent !== text) el.textContent = text;
    if (title != null) el.title = title;
  }

  /** Text for each row (pure; exported for tests). */
  function moonPanelRows(msg) {
    const m = msg && msg.moon;
    if (!msg || !msg.isMoon || !m) return null;
    const eme = msg.eme || {};
    const echo = Number.isFinite(eme.echoDopplerHz) ? eme.echoDopplerHz : m.echoDopplerHz;
    const delay = Number.isFinite(eme.delaySec) ? eme.delaySec : m.echoDelaySec;
    const loss = Number.isFinite(eme.pathLossDb) ? eme.pathLossDb : m.pathLossDb;
    const f = Number.isFinite(eme.freqHz) ? eme.freqHz : m.freqHz;
    return {
      // Range (topocentric) is already the row above; this one is Earth-centre distance.
      dist: Number.isFinite(m.geoDistKm) ? Math.round(m.geoDistKm).toLocaleString("en-US") + " km" : "-",
      distTitle: Number.isFinite(m.semiDiameterDeg) ? "Geocentric distance; Moon semi-diameter " + (m.semiDiameterDeg * 60).toFixed(1) + "'" : "Geocentric distance",
      dec: Number.isFinite(m.decDeg) ? fmtSigned(m.decDeg, 2) + "\u00B0" : "-",
      decTitle: Number.isFinite(m.raDeg) ? "RA " + (m.raDeg / 15).toFixed(3) + " h (" + m.raDeg.toFixed(2) + "\u00B0)" : "",
      illum: Number.isFinite(m.illum) ? Math.round(m.illum * 100) + "% \u00B7 " + (m.phaseName || "") : "-",
      echo: Number.isFinite(echo) ? fmtSigned(echo, 0) + " Hz" + (f ? " @ " + (f / 1e6).toFixed(3) + " MHz" : "") : "-",
      delay: Number.isFinite(delay) ? delay.toFixed(3) + " s" : "-",
      loss: Number.isFinite(loss) ? "\u2248" + loss.toFixed(1) + " dB (approx.)" : "-",
      sub: m.subPoint && Number.isFinite(m.subPoint.lat) ? fmtLatLon(m.subPoint.lat, m.subPoint.lon) : "-",
    };
  }

  function updateMoonPanel(msg) {
    const box = document.getElementById("moon-eme-info");
    if (!box) return;
    const r = moonPanelRows(msg);
    box.style.display = r ? "" : "none";
    const orbitRow = document.getElementById("sat-orbit");
    if (orbitRow && orbitRow.parentElement) orbitRow.parentElement.style.display = msg && msg.isMoon ? "none" : "";
    // The Moon is pinned in the menu: no favorite star / per-sat pass alert bell.
    ["sat-fav-top", "sat-alert-top"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.visibility = msg && msg.isMoon ? "hidden" : "";
    });
    if (!r) return;
    set("moon-dist", r.dist, r.distTitle);
    set("moon-dec", r.dec, r.decTitle);
    set("moon-illum", r.illum);
    set("moon-echo", r.echo);
    set("moon-delay", r.delay);
    set("moon-loss", r.loss);
    set("moon-sub", r.sub);
  }

  root.updateMoonPanel = updateMoonPanel;
  root.moonPanelRows = moonPanelRows;
  if (typeof module !== "undefined" && module.exports) module.exports = { moonPanelRows };
})(typeof window !== "undefined" ? window : globalThis);
