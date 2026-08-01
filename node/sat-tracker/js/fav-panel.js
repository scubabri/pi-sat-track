/* Favorites telemetry strip — collapsible drawer, sorted by AOS.
 * Rows are kept in the DOM and updated in-place to avoid flicker. */
let lastFavState = null;
let lastMultiLooks = {}; // key -> snapshot from server
let favDrawerOpen =
  localStorage.getItem("satTrackerFavDrawer") === "1"; // default closed
/** Last ordered key list rendered into the body (structure fingerprint). */
let lastFavStructureKey = "";
/** Frozen display order — only recomputed when the favorites set changes. */
let lastFavOrderKeys = null;
let lastFavOrderSet = "";

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

function favNextLabel(s, multi) {
  if (multi && multi.look && typeof multi.look.el === "number") {
    if (multi.look.el >= 0) return "UP";
  }
  if (multi && multi.above) return "UP";
  if (!s) return "\u2014";
  if (s.above) return "UP";
  if (
    typeof s.secToAos === "number" &&
    Number.isFinite(s.secToAos) &&
    s.secToAos >= 0
  ) {
    if (s.secToAos < 60) return "<1m";
    if (s.secToAos < 3600) return Math.round(s.secToAos / 60) + "m";
    return Math.floor(s.secToAos / 3600) + "h";
  }
  if (s.soon) return "<15m";
  return "\u2014";
}

/** Sort key: above horizon first, then soonest AOS, then name */
function favAosSortKey(row) {
  const s = row.meta || {};
  const multi = row.multi;
  const live = row.live;

  const el =
    live && live.look && typeof live.look.el === "number"
      ? live.look.el
      : multi && multi.look && typeof multi.look.el === "number"
        ? multi.look.el
        : typeof s.el === "number"
          ? s.el
          : null;

  const above =
    (el != null && el >= 0) || !!(multi && multi.above) || !!(s && s.above);

  if (above) return -1e12;

  if (
    typeof s.secToAos === "number" &&
    Number.isFinite(s.secToAos) &&
    s.secToAos >= 0
  ) {
    return s.secToAos;
  }
  if (s.soon) return 15 * 60;
  return 1e12;
}

function sortFavRowsByAos(rows) {
  return rows.slice().sort((a, b) => {
    const ka = favAosSortKey(a);
    const kb = favAosSortKey(b);
    if (ka !== kb) return ka - kb;
    const na =
      (a.live && a.live.display) ||
      (a.multi && a.multi.display) ||
      (a.meta && a.meta.name) ||
      a.key ||
      "";
    const nb =
      (b.live && b.live.display) ||
      (b.multi && b.multi.display) ||
      (b.meta && b.meta.name) ||
      b.key ||
      "";
    return String(na).localeCompare(String(nb), undefined, {
      sensitivity: "base",
    });
  });
}

function resolveFavRows() {
  const favs = typeof loadFavorites === "function" ? loadFavorites() : [];
  const sats =
    lastSatList && lastSatList.satellites ? lastSatList.satellites : [];
  const byKey = {};
  sats.forEach((s) => {
    if (s && s.key) byKey[s.key] = s;
  });

  const rows = favs.map((key) => {
    const s = byKey[key] || { key: key, name: key, norad: "?" };
    const multi = lastMultiLooks[key] || null;
    let live = null;
    if (lastFavState && lastFavState.sat === key) {
      live = lastFavState;
    }
    if (multi && live) {
      live = Object.assign({}, multi, live, {
        look: live.look || multi.look,
        position: live.position || multi.position,
        rangeRateKmS:
          live.rangeRateKmS != null ? live.rangeRateKmS : multi.rangeRateKmS,
        orbit: live.orbit != null ? live.orbit : multi.orbit,
        display: live.display || multi.display,
        norad: live.norad != null ? live.norad : multi.norad,
      });
    }
    return {
      key: key,
      meta: s,
      live: live,
      multi: multi,
    };
  });

  const setKey = favs.slice().sort().join("\0");
  if (setKey !== lastFavOrderSet || !lastFavOrderKeys) {
    const sorted = sortFavRowsByAos(rows);
    lastFavOrderKeys = sorted.map((r) => r.key);
    lastFavOrderSet = setKey;
    return sorted;
  }

  const byRowKey = {};
  rows.forEach((r) => {
    byRowKey[r.key] = r;
  });
  return lastFavOrderKeys
    .map((k) => byRowKey[k])
    .filter(Boolean)
    .concat(rows.filter((r) => !lastFavOrderKeys.includes(r.key)));
}

function updateFavDrawerChrome(count) {
  const panel = document.getElementById("fav-panel");
  const btn = document.getElementById("fav-drawer-toggle");
  const countEl = document.getElementById("fav-drawer-count");
  if (countEl) {
    countEl.textContent =
      count === 0
        ? "No favorites"
        : count === 1
          ? "1 favorite"
          : count + " favorites";
  }
  if (panel) {
    panel.classList.toggle("open", !!favDrawerOpen);
  }
  if (btn) {
    btn.setAttribute("aria-expanded", favDrawerOpen ? "true" : "false");
    const chev = btn.querySelector(".fav-drawer-chevron");
    if (chev) chev.textContent = favDrawerOpen ? "\u25B4" : "\u25BE";
  }
}

function setFavDrawerOpen(open) {
  favDrawerOpen = !!open;
  localStorage.setItem("satTrackerFavDrawer", favDrawerOpen ? "1" : "0");
  const rows = resolveFavRows();
  updateFavDrawerChrome(rows.length);
}

function toggleFavDrawer(e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  setFavDrawerOpen(!favDrawerOpen);
}

function favRowValues(row) {
  const s = row.meta;
  const live = row.live;
  const multi = row.multi;
  const src = live || multi;

  const visible = src
    ? src.look
      ? src.look.el >= 0
      : !!src.above
    : !!(s && s.above);

  const name =
    (live && live.display) ||
    (multi && multi.display) ||
    s.name ||
    s.key ||
    row.key;
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

  return {
    name: name,
    norad: norad,
    visible: visible,
    visText: visible ? "YES" : "NO",
    az: az,
    elev: elev,
    range: range,
    rate: rate,
    lat: lat,
    lon: lon,
    alt: alt,
    orbit: orbit,
    next: favNextLabel(s, multi || live),
    active: row.key === currentSatKey,
  };
}

function setCellText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

function patchFavRow(el, row) {
  const v = favRowValues(row);
  el.classList.toggle("active", !!v.active);

  const cells = el.children;
  if (cells.length < 12) return;

  setCellText(cells[0], v.name);
  if (cells[0].getAttribute("title") !== v.name) {
    cells[0].setAttribute("title", v.name);
  }
  setCellText(cells[1], v.norad);

  const vis = cells[2];
  setCellText(vis, v.visText);
  vis.classList.toggle("yes", !!v.visible);
  vis.classList.toggle("no", !v.visible);

  setCellText(cells[3], v.az);
  setCellText(cells[4], v.elev);
  setCellText(cells[5], v.range);
  setCellText(cells[6], v.rate);
  setCellText(cells[7], v.lat);
  setCellText(cells[8], v.lon);
  setCellText(cells[9], v.alt);
  setCellText(cells[10], v.orbit);
  setCellText(cells[11], v.next);
}

function buildFavRowEl(row) {
  const v = favRowValues(row);
  const el = document.createElement("div");
  el.className = "fav-row" + (v.active ? " active" : "");
  el.dataset.sat = row.key;

  el.innerHTML =
    '<span class="fav-cell fav-name" title="' +
    v.name.replace(/"/g, """) +
    '">' +
    v.name +
    "</span>" +
    '<span class="fav-cell fav-norad">' +
    v.norad +
    "</span>" +
    '<span class="fav-cell fav-vis ' +
    (v.visible ? "yes" : "no") +
    '">' +
    v.visText +
    "</span>" +
    '<span class="fav-cell fav-num">' +
    v.az +
    "</span>" +
    '<span class="fav-cell fav-num">' +
    v.elev +
    "</span>" +
    '<span class="fav-cell fav-num">' +
    v.range +
    "</span>" +
    '<span class="fav-cell fav-num">' +
    v.rate +
    "</span>" +
    '<span class="fav-cell fav-num">' +
    v.lat +
    "</span>" +
    '<span class="fav-cell fav-num">' +
    v.lon +
    "</span>" +
    '<span class="fav-cell fav-num">' +
    v.alt +
    "</span>" +
    '<span class="fav-cell fav-num">' +
    v.orbit +
    "</span>" +
    '<span class="fav-cell fav-next">' +
    v.next +
    "</span>";

  el.addEventListener("click", () => {
    if (typeof selectSatellite === "function") {
      const nameEl = el.querySelector(".fav-name");
      const name = (nameEl && nameEl.textContent) || row.key;
      selectSatellite(row.key, name);
    }
  });
  return el;
}

function renderFavPanel() {
  const body = document.getElementById("fav-panel-body");
  if (!body) return;

  const rows = resolveFavRows();
  updateFavDrawerChrome(rows.length);

  if (!rows.length) {
    if (lastFavStructureKey !== "__empty__") {
      body.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "fav-panel-empty";
      empty.textContent =
        "No favorites yet — star sats in the picker or catalog";
      body.appendChild(empty);
      lastFavStructureKey = "__empty__";
    }
    return;
  }

  const structureKey = rows.map((r) => r.key).join("\0");
  const needRebuild = structureKey !== lastFavStructureKey;

  if (needRebuild) {
    body.innerHTML = "";
    rows.forEach((row) => {
      body.appendChild(buildFavRowEl(row));
    });
    lastFavStructureKey = structureKey;
    return;
  }

  const existing = body.querySelectorAll(".fav-row");
  for (let i = 0; i < rows.length; i++) {
    const el = existing[i];
    if (!el || el.dataset.sat !== rows[i].key) {
      lastFavStructureKey = "";
      renderFavPanel();
      return;
    }
    patchFavRow(el, rows[i]);
  }
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

function invalidateFavPanelStructure() {
  lastFavStructureKey = "";
  lastFavOrderKeys = null;
  lastFavOrderSet = "";
  renderFavPanel();
}

function initFavPanel() {
  const btn = document.getElementById("fav-drawer-toggle");
  if (btn) {
    btn.addEventListener("click", toggleFavDrawer);
  }
  updateFavDrawerChrome(
    typeof loadFavorites === "function" ? loadFavorites().length : 0,
  );
  lastFavStructureKey = "";
  renderFavPanel();
}
