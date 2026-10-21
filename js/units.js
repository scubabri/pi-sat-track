/**
 * Display units (per station profile, Configure → Station → Units).
 *   metric:   km (small distances / heights in m), speeds in m/s
 *   imperial: mi (small distances / heights in ft), speeds in mph
 * Display only: the server, Doppler, logging (ADIF / LoTW / UDP) and the log
 * file keep their standard units. Profiles without the field are Metric.
 *
 * window.Units.{get, set, normalize, relabel, dist, distValue, distUnit, height,
 * small, rate, speed, speedUnit}; "units-change" event on document when the
 * mode changes (detail.units).
 */
(function (root) {
  const KM_PER_MI = 1.609344;
  const FT_PER_M = 1 / 0.3048;
  const MPH_PER_MS = 3600 / 1609.344; // 2.2369...
  let mode = "metric";

  function normalize(u) { return u === "imperial" ? "imperial" : "metric"; }
  function get() { return mode; }
  function set(u) {
    const next = normalize(u);
    if (next === mode) return false;
    mode = next;
    try {
      if (root.document && typeof root.document.dispatchEvent === "function" && typeof root.CustomEvent === "function")
        root.document.dispatchEvent(new root.CustomEvent("units-change", { detail: { units: mode } }));
    } catch (_) {}
    return true;
  }
  const ok = (v) => v != null && v !== "" && Number.isFinite(Number(v));
  const u = (o) => normalize(o && o.units ? o.units : mode);
  function fixed(v, digits, sep) {
    if (sep) return Number(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return Number(v).toFixed(digits);
  }

  /** Distance / altitude given in km: number in display units. */
  function distValue(km, o) { return u(o) === "imperial" ? Number(km) / KM_PER_MI : Number(km); }
  function distUnit(o) { return u(o) === "imperial" ? "mi" : "km"; }
  /**
   * "1234.5 km" / "767.1 mi". opts: digits (0), sep (thousands separators),
   * dash (text for a missing value, "-"), units (override the mode).
   */
  function dist(km, o) {
    o = o || {};
    if (!ok(km)) return o.dash != null ? o.dash : "-";
    return fixed(distValue(km, o), o.digits || 0, o.sep) + " " + distUnit(o);
  }
  /** Height / small length given in m: "1324 m" / "4344 ft". */
  function height(m, o) {
    o = o || {};
    if (!ok(m)) return o.dash != null ? o.dash : "-";
    return u(o) === "imperial" ? Math.round(Number(m) * FT_PER_M) + " ft" : Math.round(Number(m)) + " m";
  }
  /**
   * Small distance given in m (e.g. a position-ambiguity hint): metric m below
   * 1 km, else km; imperial ft below 1000 ft, else mi. Below 10 km / mi one
   * decimal ("1.8 km", "1.1 mi"), otherwise whole numbers.
   */
  function small(m, o) {
    o = o || {};
    if (!ok(m)) return o.dash != null ? o.dash : "-";
    m = Number(m);
    const big = (x, unit) => (x < 10 ? x.toFixed(1).replace(/\.0$/, "") : String(Math.round(x))) + " " + unit;
    if (u(o) === "imperial") {
      const ft = m * FT_PER_M;
      return ft < 1000 ? Math.round(ft) + " ft" : big(m / 1609.344, "mi");
    }
    return m < 1000 ? Math.round(m) + " m" : big(m / 1000, "km");
  }
  function speedUnit(o) { return u(o) === "imperial" ? "mph" : "m/s"; }
  /** Speed given in m/s: "7660 m/s" / "17135 mph". opts: digits (0), sign (+ for > 0). */
  function speed(ms, o) {
    o = o || {};
    if (!ok(ms)) return o.dash != null ? o.dash : "-";
    const v = u(o) === "imperial" ? Number(ms) * MPH_PER_MS : Number(ms);
    const s = fixed(v, o.digits || 0, o.sep);
    return (o.sign && Number(s) > 0 ? "+" : "") + (Number(s) === 0 ? fixed(0, o.digits || 0) : s) + " " + speedUnit(o);
  }
  /** Range rate given in km/s (server): "+1234 m/s" / "+2760 mph" (signed). */
  function rate(kmS, o) {
    o = Object.assign({ sign: true }, o || {});
    if (!ok(kmS)) return o.dash != null ? o.dash : "-";
    return speed(Number(kmS) * 1000, o);
  }

  /** Hand-written "(~18 m)" hints on elements with data-m (metres), e.g. Configure's position ambiguity. */
  function relabel() {
    const d = root.document;
    if (!d || typeof d.querySelectorAll !== "function") return;
    d.querySelectorAll("[data-m]").forEach((e) => {
      const t = e.textContent;
      const nt = t.replace(/\(~[^)]*\)/, "(~" + small(e.getAttribute("data-m")) + ")");
      if (nt !== t) e.textContent = nt;
    });
  }
  if (root.document && typeof root.document.addEventListener === "function") {
    root.document.addEventListener("units-change", relabel);
  }

  const api = { get, set, normalize, relabel, dist, distValue, distUnit, height, small, speed, speedUnit, rate, KM_PER_MI, FT_PER_M, MPH_PER_MS };
  root.Units = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
