/**
 * Downlink out-of-band indicator (visual only), two levels on the sidebar DL readout:
 *   red    (level "oob")  satellite-frame DL outside the passband;
 *   yellow (level "warn") station/displayed DL (Doppler included) outside the
 *                         passband while the satellite-frame DL is inside.
 *   Red takes priority.
 *
 * dlPassbandHz(field): the selected mode's catalog downlink -> {loHz, hiHz, single}.
 *   Uses the primary entry (text before the first "/"), the same one the tracker
 *   tunes. "29.400-29.500" (either order) is the transponder passband; a single
 *   frequency ("145.960") is a channel of +/- DL_SINGLE_TOL_HZ (10 kHz). Unparseable -> null.
 * dlOutOfBand({passbandDl, dlHz, dlDopplerHz}): satellite-frame DL = displayed dlHz
 *   minus the Doppler correction the tracker applied (catalog centre + manual/fine
 *   offsets), so Doppler alone can never turn it red; the displayed dlHz is checked
 *   too for the yellow warning. Edges inclusive.
 *   -> {level: "oob"|"warn"|null, oob, warn, satOut, stationOut, loHz, hiHz, satHz,
 *       stationHz, text} or null if unknown. text is "" when level is null.
 */
(function (root) {
  const DL_SINGLE_TOL_HZ = 10000;

  function dlPassbandHz(field) {
    if (field == null) return null;
    const primary = String(field).trim().split("/")[0].trim();
    if (!primary || primary === "-") return null;
    const r = primary.match(/(\d+\.?\d*)\s*[-\u2013]\s*(\d+\.?\d*)/);
    if (r) {
      const a = parseFloat(r[1]) * 1e6;
      const b = parseFloat(r[2]) * 1e6;
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      return { loHz: Math.round(Math.min(a, b)), hiHz: Math.round(Math.max(a, b)), single: false };
    }
    const s = primary.match(/(\d+\.\d+)/);
    if (!s) return null;
    const f = parseFloat(s[1]) * 1e6;
    if (!Number.isFinite(f) || f <= 0) return null;
    return { loHz: Math.round(f - DL_SINGLE_TOL_HZ), hiHz: Math.round(f + DL_SINGLE_TOL_HZ), single: true };
  }

  function fmtMHz(hz) { return (hz / 1e6).toFixed(3); }

  function dlOutOfBand(msg) {
    if (!msg || msg.dlHz == null || !Number.isFinite(msg.dlHz)) return null;
    const pb = dlPassbandHz(msg.passbandDl);
    if (!pb) return null;
    const dop = Number.isFinite(msg.dlDopplerHz) ? msg.dlDopplerHz : 0;
    const satHz = msg.dlHz - dop;
    const stationHz = msg.dlHz;
    const out = (hz) => hz < pb.loHz - 0.5 || hz > pb.hiHz + 0.5;
    const satOut = out(satHz);
    const stationOut = out(stationHz);
    const level = satOut ? "oob" : stationOut ? "warn" : null;
    const band = fmtMHz(pb.loHz) + "\u2013" + fmtMHz(pb.hiHz) + " MHz";
    const text = level === "oob" ? "Out of band at satellite: DL passband " + band
      : level === "warn" ? "Station frequency outside DL passband " + band + " (satellite in band)" : "";
    return { level, oob: level === "oob", warn: level === "warn", satOut, stationOut, loHz: pb.loHz, hiHz: pb.hiHz, satHz, stationHz, text };
  }

  const api = { dlPassbandHz, dlOutOfBand, DL_SINGLE_TOL_HZ };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== "undefined" ? window : this);
