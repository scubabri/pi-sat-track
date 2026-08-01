/* Favorites telemetry strip (Gpredict-style table at top) */
let lastFavState = null;
let lastMultiLooks = {}; // key -> snapshot from server

function fmtDeg(v, digits) {
  if (v == null || !Number.isFinite(v)) return "\u2014";
  digits = digits == null ? 2 : digits;
  return Number(v).toFixed(digits) + "\u00B0";
}

function fmtKm(v, digits) {
  if (v == null || !Number.isFinite(v)) return "\u2014";
  digits = digits == null ? 1 : digits;
  return Number(v).toFixed(digits) + " km";
}

function fmtRate(v) {
  if (v == null || !Number.isFinite(v)) return "\u2014";
  const sign = v > 0 ? "+" : "";
  return sign + Number(v).toFixed(2) + " km/s";
}

function favNextLabel(s) {
  if (!s) return "\u2014";
  if (s.above) return "UP";
  if (typeof s.secToAos === "number" && Number.isFinite(s.secToAos) && s.secToAos >= 0) {
    if (s.secToAos < 60) return "<1m";
    if (s.secToAos < 3600) return Math.round(s.secToAos / 60) + "m";
    return Math.floor(s.secToAos / 3600) + "h";
  }
  if (s.soon) return "<15m";
  return "\u2014";
}

function resolveFavRows() {
  const favs = typeof loadFavorites === "function" ? loadFavorites() : [];
  const sats =
    lastSatList && lastSatList.satellites ? lastSatList.satellites : [];
  const byKey = {};
  sats.forEach((s) => {
    if (s && s.key) byKey[s.key] = s;
  });

  return favs.map((key) => {
    const s = byKey[key] || { key: key, name: key, norad: "?" };
    const multi = lastMultiLooks[key] || null;
    const isLive = lastFavState && lastFavState.sat === key;
    return {
      key: key,
      meta: s,
      live: isLive ? lastFavState : null,
      multi: multi,
    };
  });
}

function renderFavPanel() {
  const body = document.getElementById("fav-panel-body");
  if (!body) return;

  const rows = resolveFavRows();
  body.innerHTML = "";

  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "fav-panel-empty";
    empty.textContent =
      "No favorites yet — star sats in the picker or catalog";
    body.appendChild(empty);
    return;
  }

  rows.forEach((row) => {
    const s = row.meta;
    const live = row.live;
    const multi = row.multi;
    const src = live || multi;

    const visible = src
      ? src.look
        ? src.look.el >= 0
        : !!src.above
      : !!(s && s.above);

    const el = document.createElement("div");
    el.className = "fav-row" + (row.key === currentSatKey ? " active" : "");
    el.dataset.sat = row.key;

    const name =
      (live && live.display) ||
      (multi && multi.display) ||
      s.name ||
      s.key;
    const noradRaw =
      live && live.norad != null
        ? live.norad
        : multi && multi.norad != null
          ? multi.norad
          : s.norad;
    const norad = noradRaw != null ? String(noradRaw) : "\u2014";

    let az = "\u2014";
    let elev = "\u2014";
    let range = "\u2014";
    let rate = "\u2014";
    let lat = "\u2014";
    let lon = "\u2014";
    let alt = "\u2014";
    let orbit = "\u2014";

    if (src && src.look) {
      az = fmtDeg(src.look.az, 2);
      elev = fmtDeg(src.look.el, 2);
      range = fmtKm(src.look.rangeKm, 1);
    } else if (s.above && typeof s.el === "number") {
      elev = fmtDeg(s.el, 1);
    }

    if (src) {
      rate = fmtRate(src.rangeRateKmS);
      if (src.position) {
        lat = fmtDeg(src.position.lat, 2);
        lon = fmtDeg(src.position.lon, 2);
        alt = fmtKm(src.position.heightKm, 1);
      }
      if (src.orbit != null) orbit = String(src.orbit);
    }
    if (live && live.orbit != null) orbit = String(live.orbit);

    el.innerHTML =
      '<span class="fav-cell fav-name" title="' +
      name +
      '">' +
      name +
      "</span>" +
      '<span class="fav-cell fav-norad">' +
      norad +
      "</span>" +
      '<span class="fav-cell fav-vis ' +
      (visible ? "yes" : "no") +
      '">' +
      (visible ? "YES" : "NO") +
      "</span>" +
      '<span class="fav-cell fav-num">' +
      az +
      "</span>" +
      '<span class="fav-cell fav-num">' +
      elev +
      "</span>" +
      '<span class="fav-cell fav-num">' +
      range +
      "</span>" +
      '<span class="fav-cell fav-num">' +
      rate +
      "</span>" +
      '<span class="fav-cell fav-num">' +
      lat +
      "</span>" +
      '<span class="fav-cell fav-num">' +
      lon +
      "</span>" +
      '<span class="fav-cell fav-num">' +
      alt +
      "</span>" +
      '<span class="fav-cell fav-num">' +
      orbit +
      "</span>" +
      '<span class="fav-cell fav-next">' +
      favNextLabel(s) +
      "</span>";

    el.addEventListener("click", () => {
      if (typeof selectSatellite === "function") {
        selectSatellite(row.key, name);
      }
    });
    body.appendChild(el);
  });
}

function updateFavPanelFromState(state) {
  if (!state) return;
  lastFavState = state;
  if (Array.isArray(state.favorites)) {
    const map = {};
    state.favorites.forEach((f) => {
      if (f && f.key) map[f.key] = f;
    });
    lastMultiLooks = map;
  }
  renderFavPanel();
}

function initFavPanel() {
  renderFavPanel();
}
