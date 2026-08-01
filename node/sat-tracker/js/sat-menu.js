/* Satellite selector menu, favorites, sort */
let satSortMode = localStorage.getItem("satTrackerSort") || "aos";
let currentSatKey = localStorage.getItem("satTrackerSat") || null;
let currentSatLabel = null;
let lastSatList = null;
let currentEl = null;
let pendingSatKey = null;

function setSatButtonLabel(label) {
  currentSatLabel = label;
  const btn = document.getElementById("sat-name");
  if (btn) btn.textContent = (label || "-") + " \u25BE";
  document.querySelectorAll(".sat-row[data-sat]").forEach((el) => {
    el.classList.toggle("active", el.dataset.sat === currentSatKey);
  });
}

function loadFavorites() {
  try {
    const raw = localStorage.getItem("satTrackerFavorites");
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((k) => typeof k === "string") : [];
  } catch (e) {
    return [];
  }
}

function saveFavorites(keys) {
  localStorage.setItem("satTrackerFavorites", JSON.stringify(keys));
}

function isFavorite(key) {
  return !!key && loadFavorites().includes(key);
}

function toggleFavorite(key) {
  if (!key) return;
  const favs = loadFavorites();
  const i = favs.indexOf(key);
  if (i >= 0) favs.splice(i, 1);
  else favs.push(key);
  saveFavorites(favs);
  if (lastSatList) renderSatMenu(lastSatList);
}

function aosSortKey(s) {
  if (s.above) return -1e12;
  if (s.key === currentSatKey && currentEl != null && currentEl >= 0)
    return -1e12;

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

function sortHeardList(list) {
  const arr = list.slice();

  if (satSortMode === "alpha") {
    arr.sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""), undefined, {
        sensitivity: "base",
      }),
    );
    return arr;
  }

  arr.sort((a, b) => {
    const ka = aosSortKey(a);
    const kb = aosSortKey(b);
    if (ka !== kb) return ka - kb;
    return String(a.name || "").localeCompare(String(b.name || ""), undefined, {
      sensitivity: "base",
    });
  });
  return arr;
}

function toggleSatSort(e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  satSortMode = satSortMode === "aos" ? "alpha" : "aos";
  localStorage.setItem("satTrackerSort", satSortMode);
  if (lastSatList) renderSatMenu(lastSatList);
}

function applyLiveHorizon(sats) {
  if (!sats || !currentSatKey) return sats;
  return sats.map((s) => {
    if (s.key !== currentSatKey) return s;
    if (currentEl == null) return s;
    const above = currentEl >= 0;
    return Object.assign({}, s, {
      above: above,
      soon: above ? false : s.soon,
      el: currentEl,
    });
  });
}

function satHorizonClass(s) {
  if (s.above) return "sat-up";
  if (
    typeof s.secToAos === "number" &&
    Number.isFinite(s.secToAos) &&
    s.secToAos >= 0 &&
    s.secToAos <= 5 * 60
  ) {
    return "sat-imminent";
  }
  if (
    s.soon ||
    (typeof s.secToAos === "number" &&
      Number.isFinite(s.secToAos) &&
      s.secToAos >= 0 &&
      s.secToAos <= 15 * 60)
  ) {
    return "sat-soon";
  }
  return "sat-down";
}

function statusLabel(s) {
  if (s.above) {
    if (typeof s.el === "number" && Number.isFinite(s.el)) {
      return s.el.toFixed(0) + "\u00B0";
    }
    return "UP";
  }
  if (typeof s.secToAos === "number" && Number.isFinite(s.secToAos) && s.secToAos >= 0) {
    if (s.secToAos < 60) return "<1m";
    if (s.secToAos < 3600) return Math.round(s.secToAos / 60) + "m";
    return Math.floor(s.secToAos / 3600) + "h";
  }
  if (s.soon) return "<15m";
  return "\u2014";
}

function statusTitle(s) {
  if (s.above) {
    if (typeof s.el === "number") return "Above horizon " + s.el.toFixed(1) + "\u00B0";
    return "Above horizon";
  }
  if (typeof s.secToAos === "number" && s.secToAos >= 0) {
    return "AOS in " + Math.round(s.secToAos / 60) + " min";
  }
  if (s.soon) return "AOS < 15 min";
  if (s.heard) return "Heard on AMSAT";
  return "";
}

function makeSatRow(s, favSet) {
  const row = document.createElement("div");
  row.className = "sat-row " + satHorizonClass(s);
  if (s.key === currentSatKey) row.classList.add("active");
  if (s.heard) row.classList.add("heard");
  row.dataset.sat = s.key;
  row.title = statusTitle(s) || s.name + " (NORAD " + s.norad + ")";

  const star = document.createElement("button");
  star.type = "button";
  star.className = "sat-fav" + (favSet.has(s.key) ? " on" : "");
  star.textContent = favSet.has(s.key) ? "\u2605" : "\u2606";
  star.title = favSet.has(s.key) ? "Remove favorite" : "Add favorite";
  star.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleFavorite(s.key);
  });
  row.appendChild(star);

  const name = document.createElement("span");
  name.className = "sat-row-name";
  name.textContent = s.name || s.key;
  row.appendChild(name);

  const norad = document.createElement("span");
  norad.className = "sat-row-norad";
  norad.textContent = s.norad != null ? String(s.norad) : "\u2014";
  row.appendChild(norad);

  const st = document.createElement("span");
  st.className = "sat-row-status";
  st.textContent = statusLabel(s);
  row.appendChild(st);

  row.addEventListener("click", (e) => {
    if (e.target.closest(".sat-fav")) return;
    selectSatellite(s.key, s.name);
  });

  return row;
}

function makeSectionHead(title, withSort) {
  const head = document.createElement("div");
  head.className = "sat-menu-head";

  const label = document.createElement("span");
  label.className = "sat-menu-section";
  label.textContent = title;
  head.appendChild(label);

  if (withSort) {
    const sortBtn = document.createElement("button");
    sortBtn.type = "button";
    sortBtn.className = "sat-sort-btn";
    sortBtn.title =
      satSortMode === "aos"
        ? "Sorted by AOS — click for A–Z"
        : "Sorted A–Z — click for AOS";
    sortBtn.textContent = satSortMode === "aos" ? "AOS" : "A–Z";
    sortBtn.addEventListener("click", toggleSatSort);
    head.appendChild(sortBtn);
  }
  return head;
}

function makeColHead() {
  const head = document.createElement("div");
  head.className = "sat-row sat-row-head";
  head.innerHTML =
    '<span class="sat-fav-spacer"></span>' +
    '<span class="sat-row-name">Name</span>' +
    '<span class="sat-row-norad">NORAD</span>' +
    '<span class="sat-row-status">Next</span>';
  return head;
}

function renderSatMenu(payload) {
  const menu = document.getElementById("sat-menu");
  if (!menu) return;

  lastSatList = payload;
  const sats = applyLiveHorizon(payload.satellites || []);
  const favs = loadFavorites();
  const favSet = new Set(favs);

  menu.innerHTML = "";

  const browse = document.createElement("a");
  browse.className = "sat-option sat-browse";
  browse.href = "/sats.html";
  browse.textContent = "Browse full catalog...";
  browse.title = "Search all AMSAT satellites";
  menu.appendChild(browse);

  // --- Favorites (always on top) ---
  menu.appendChild(makeSectionHead("Favorites"));

  const favList = [];
  favs.forEach((key) => {
    const match = sats.find((s) => s.key === key);
    if (match) favList.push(match);
    else
      favList.push({
        key: key,
        name: key,
        norad: "?",
        heard: false,
      });
  });

  if (favList.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sat-menu-empty";
    empty.textContent = "Star a sat below or on the catalog page";
    menu.appendChild(empty);
  } else {
    menu.appendChild(makeColHead());
    sortHeardList(favList).forEach((s) => {
      menu.appendChild(makeSatRow(s, favSet));
    });
  }

  // --- Heard on AMSAT ---
  menu.appendChild(makeSectionHead("Heard on AMSAT", true));

  const seen = new Set(favs);
  let heard = sats.filter((s) => s.heard && !seen.has(s.key));
  if (currentSatKey && !seen.has(currentSatKey)) {
    const cur = sats.find((s) => s.key === currentSatKey);
    if (cur && !heard.some((h) => h.key === currentSatKey)) heard.push(cur);
  }
  heard = sortHeardList(heard);

  if (heard.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sat-menu-empty";
    empty.textContent = "No AMSAT reports loaded";
    menu.appendChild(empty);
  } else {
    menu.appendChild(makeColHead());
    heard.slice(0, 60).forEach((s) => {
      menu.appendChild(makeSatRow(s, favSet));
    });
  }

  const statusCat = document.getElementById("status-catalog");
  if (statusCat) {
    statusCat.textContent =
      (payload.satellites || []).length + " - " + (payload.catalogNote || "?");
  }

  if (currentSatKey) {
    const match = sats.find((s) => s.key === currentSatKey);
    if (match) setSatButtonLabel(match.name);
    else if (!currentSatLabel) setSatButtonLabel(currentSatKey);
  }
}

function refreshCurrentSatChip() {
  if (!lastSatList) return;
  const menu = document.getElementById("sat-menu");
  if (menu && menu.classList.contains("open")) {
    renderSatMenu(lastSatList);
  } else {
    document.querySelectorAll(".sat-row[data-sat]").forEach((el) => {
      if (el.dataset.sat !== currentSatKey) return;
      el.classList.remove("sat-up", "sat-soon", "sat-imminent", "sat-down");
      if (currentEl != null && currentEl >= 0) el.classList.add("sat-up");
      else el.classList.add("sat-down");
    });
  }
}

function selectSatellite(key, label) {
  pendingSatKey = key;
  currentSatKey = key;
  setSatButtonLabel(label || key);
  localStorage.setItem("satTrackerSat", key);
  lastPass = null;
  lastStateSat = null;
  currentEl = null;
  lastModesKey = "";
  ulFineOffset = 0;
  manualDlOffset = 0;
  if (typeof updateFineOffsetDisplay === "function") updateFineOffsetDisplay();

  if (typeof clearProfileLock === "function") clearProfileLock();
  if (typeof clearMapTracking === "function") clearMapTracking();

  closeSatDrawer();

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "sat", key: key }));
  }
}

function openSatDrawer() {
  const menu = document.getElementById("sat-menu");
  if (!menu) return;
  menu.hidden = false;
  // force reflow so transition runs
  void menu.offsetWidth;
  menu.classList.add("open");
  if (lastSatList) renderSatMenu(lastSatList);
}

function closeSatDrawer() {
  const menu = document.getElementById("sat-menu");
  if (!menu) return;
  menu.classList.remove("open");
  const done = () => {
    if (!menu.classList.contains("open")) menu.hidden = true;
    menu.removeEventListener("transitionend", done);
  };
  menu.addEventListener("transitionend", done);
  // fallback if no transition
  setTimeout(done, 220);
}

function initSatSelector() {
  const btn = document.getElementById("sat-name");
  const menu = document.getElementById("sat-menu");
  if (!btn || !menu) return;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.classList.contains("open")) closeSatDrawer();
    else openSatDrawer();
  });

  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target) && e.target !== btn) {
      if (menu.classList.contains("open")) closeSatDrawer();
    }
  });
}
