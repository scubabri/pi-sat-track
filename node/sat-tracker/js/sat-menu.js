/* Satellite selector menu, favorites, sort */
let satSortMode = localStorage.getItem("satTrackerSort") || "aos";
let satListMode = localStorage.getItem("satTrackerListMode") || "heard"; // "heard" | "favorites"
let currentSatKey = localStorage.getItem("satTrackerSat") || null;
let currentSatLabel = null;
let lastSatList = null;
let currentEl = null;
let pendingSatKey = null;

function setSatButtonLabel(label) {
  currentSatLabel = label;
  const btn = document.getElementById("sat-name");
  if (btn) btn.textContent = (label || "-") + " \u25BE";
  document.querySelectorAll(".sat-option[data-sat]").forEach((el) => {
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

function toggleSatListMode(e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  satListMode = satListMode === "heard" ? "favorites" : "heard";
  localStorage.setItem("satTrackerListMode", satListMode);
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

  const headRow = document.createElement("div");
  headRow.className = "sat-menu-head";

  // List mode toggle: Favorites ↔ Heard on AMSAT
  const listBtn = document.createElement("button");
  listBtn.type = "button";
  listBtn.className = "sat-list-btn";
  listBtn.title =
    satListMode === "favorites"
      ? "Showing favorites — click for Heard on AMSAT"
      : "Showing Heard on AMSAT — click for Favorites";
  listBtn.textContent =
    satListMode === "favorites" ? "Favorites" : "Heard on AMSAT";
  listBtn.addEventListener("click", toggleSatListMode);
  headRow.appendChild(listBtn);

  const sortBtn = document.createElement("button");
  sortBtn.type = "button";
  sortBtn.className = "sat-sort-btn";
  sortBtn.title =
    satSortMode === "aos"
      ? "Sorted by AOS — click for A–Z"
      : "Sorted A–Z — click for AOS";
  sortBtn.textContent = satSortMode === "aos" ? "AOS" : "A–Z";
  sortBtn.addEventListener("click", toggleSatSort);
  headRow.appendChild(sortBtn);
  menu.appendChild(headRow);

  let quick = [];
  const seen = new Set();

  function add(s) {
    if (!s || !s.key || seen.has(s.key)) return;
    seen.add(s.key);
    quick.push(s);
  }

  if (satListMode === "favorites") {
    // Favorites first (preserve user order), then resolve from catalog
    favs.forEach((key) => {
      const match = sats.find((s) => s.key === key);
      if (match) add(match);
      else
        add({
          key: key,
          name: key,
          norad: "?",
          heard: false,
        });
    });
  } else {
    const heard = sats.filter((s) => s.heard);
    heard.forEach(add);
    if (currentSatKey) add(sats.find((s) => s.key === currentSatKey));
  }

  quick = sortHeardList(quick);

  if (quick.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sat-menu-empty";
    empty.textContent =
      satListMode === "favorites"
        ? "No favorites yet — star a sat here or on the catalog page"
        : "No AMSAT reports loaded";
    menu.appendChild(empty);
  }

  quick.slice(0, 60).forEach((s) => {
    const wrap = document.createElement("span");
    wrap.className = "sat-chip";

    const star = document.createElement("button");
    star.type = "button";
    star.className = "sat-fav" + (favSet.has(s.key) ? " on" : "");
    star.textContent = favSet.has(s.key) ? "★" : "☆";
    star.title = favSet.has(s.key) ? "Remove favorite" : "Add favorite";
    star.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleFavorite(s.key);
    });
    wrap.appendChild(star);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sat-option";
    if (s.key === currentSatKey) btn.classList.add("active");
    btn.classList.add(satHorizonClass(s));
    if (s.heard) btn.classList.add("heard");
    btn.dataset.sat = s.key;
    btn.textContent = s.name;

    let tip = s.name + "  (NORAD " + s.norad + ")";
    if (s.above) tip += " — above horizon";
    else if (
      typeof s.secToAos === "number" &&
      s.secToAos >= 0 &&
      s.secToAos <= 5 * 60
    ) {
      tip += " — AOS < 5 min (~" + Math.round(s.secToAos / 60) + "m)";
    } else if (
      s.soon ||
      (typeof s.secToAos === "number" && s.secToAos <= 15 * 60)
    ) {
      tip += " — AOS < 15 min";
      if (typeof s.secToAos === "number")
        tip += " (~" + Math.round(s.secToAos / 60) + "m)";
    } else if (s.heard) {
      tip += " — heard (AMSAT)";
    }
    btn.title = tip;
    btn.addEventListener("click", () => selectSatellite(s.key, s.name));
    wrap.appendChild(btn);

    menu.appendChild(wrap);
  });

  const statusCat = document.getElementById("status-catalog");
  if (statusCat) {
    statusCat.textContent =
      (payload.satellites || []).length + " - " + (payload.catalogNote || "?");
  }

  if (currentSatKey) {
    const match = sats.find((s) => s.key === currentSatKey);
    if (match) setSatButtonLabel(match.name);
    else if (!currentSatLabel) setSatButtonLabel(currentSatKey);
  } else if (quick.length) {
    currentSatKey = quick[0].key;
    setSatButtonLabel(quick[0].name);
  }
}

function refreshCurrentSatChip() {
  if (!lastSatList) return;
  const menu = document.getElementById("sat-menu");
  if (menu && !menu.hidden) {
    renderSatMenu(lastSatList);
  } else {
    document.querySelectorAll(".sat-option[data-sat]").forEach((el) => {
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
  updateFineOffsetDisplay();

  if (typeof clearProfileLock === "function") clearProfileLock();
  if (typeof clearMapTracking === "function") clearMapTracking();

  const menu = document.getElementById("sat-menu");
  if (menu) menu.hidden = true;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "sat", key: key }));
  }
}

function initSatSelector() {
  const btn = document.getElementById("sat-name");
  const menu = document.getElementById("sat-menu");
  if (!btn || !menu) return;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    if (!menu.hidden && lastSatList) renderSatMenu(lastSatList);
  });

  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target) && e.target !== btn) {
      menu.hidden = true;
    }
  });
}
