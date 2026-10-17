/**
 * Downlink out-of-band indicator (visual only: the sidebar DL readout turns red).
 *
 * dlPassbandHz(field): the selected mode's catalog downlink -> {loHz, hiHz, single}.
 *   Uses the primary entry (text before the first "/"), the same one the tracker
 *   tunes. "29.400-29.500" (either order) is the transponder passband; a single
 *   frequency ("145.960") is a channel of +/- DL_SINGLE_TOL_HZ (10 kHz). Unparseable -> null.
 * dlOutOfBand({passbandDl, dlHz, dlDopplerHz}): compares the satellite-frame DL
 *   (displayed dlHz minus the Doppler correction the tracker applied, i.e. catalog
 *   centre + manual/fine offsets) against that passband, so Doppler on a pass can
 *   never trip it by itself. -> {oob, loHz, hiHz, satHz, text} or null if unknown.
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
    const oob = satHz < pb.loHz - 0.5 || satHz > pb.hiHz + 0.5;
    return { oob, loHz: pb.loHz, hiHz: pb.hiHz, satHz, text: "Out of band: DL passband " + fmtMHz(pb.loHz) + "\u2013" + fmtMHz(pb.hiHz) + " MHz" };
  }

  const api = { dlPassbandHz, dlOutOfBand, DL_SINGLE_TOL_HZ };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== "undefined" ? window : this);
