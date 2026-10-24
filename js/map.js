let map = null;
let satMarker = null;
let observerMarker = null;
let footprintCircle = null;
let nowGhost = null; // live position while a pass preview is shown
let lastMapState = null;
let trailPolylines = [];
let forwardPolylines = [];
let passPolylines = [];

const EARTH_RADIUS_KM = 6371;

const MAP_CENTER_KEY = "mapCenterChoice";
const MID_ATLANTIC_VIEW = { lat: 25, lon: -35, zoom: 2.5 };

function getCenterChoice() {
  try {
    return localStorage.getItem(MAP_CENTER_KEY) === "atlantic" ? "atlantic" : "station";
  } catch (e) {
    return "station";
  }
}

function setCenterChoice(choice) {
  try {
    localStorage.setItem(MAP_CENTER_KEY, choice);
  } catch (e) {}
  document.querySelectorAll(".map-center-btn[data-center]").forEach(function (b) {
    b.classList.toggle("active", b.dataset.center === choice);
  });
}

const MAP_VIEW_KEY = "mapViewPos";
function savedMapView() {
  try {
    const v = JSON.parse(localStorage.getItem(MAP_VIEW_KEY) || "null");
    return v && Number.isFinite(v.lat) && Number.isFinite(v.lng) && Number.isFinite(v.zoom) ? v : null;
  } catch (_) { return null; }
}

function centerMidAtlantic() {
  if (typeof window.globeCenterOn === "function" && window.globeCenterOn(MID_ATLANTIC_VIEW.lat, MID_ATLANTIC_VIEW.lon)) return;
  if (!map) return;
  map.setView([MID_ATLANTIC_VIEW.lat, MID_ATLANTIC_VIEW.lon], MID_ATLANTIC_VIEW.zoom);
}

/** Small line-art satellite (body + two panels + dish) for the Follow satellite button. */
const SAT_FOLLOW_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round">' +
  '<rect x="9.2" y="9.2" width="5.6" height="5.6" rx="0.8" transform="rotate(45 12 12)"/>' +
  '<path d="M8.2 8.2 4.9 4.9M2.4 7.4l5-5 3 3-5 5zM15.8 15.8l3.3 3.3M21.6 16.6l-5 5-3-3 5-5z"/>' +
  '<path d="M15.2 8.8a3 3 0 0 0 0-3.4M17.6 6.4a6 6 0 0 0 0-1.8" stroke-width="1.4"/>' +
  "</svg>";

function initMap() {
  map = L.map("map", {
    worldCopyJump: true,
    minZoom: 2,
    // finer zoom steps (+/- and wheel)
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 120,
    wheelDebounceTime: 40,
    maxZoom: 8,
    zoomControl: false,
  });
  const sv = savedMapView();
  if (sv) map.setView([sv.lat, sv.lng], sv.zoom);
  else
    map.setView(
      getCenterChoice() === "atlantic"
        ? [MID_ATLANTIC_VIEW.lat, MID_ATLANTIC_VIEW.lon]
        : [20, 0],
      getCenterChoice() === "atlantic" ? MID_ATLANTIC_VIEW.zoom : 2,
    );
  // Remember center + zoom (and the grid it was for) across reloads.
  let mvTimer = null;
  map.on("moveend zoomend", () => {
    clearTimeout(mvTimer);
    mvTimer = setTimeout(() => {
      try {
        const c = map.getCenter();
        const cfg = typeof loadConfig === "function" ? loadConfig() : null;
        localStorage.setItem(MAP_VIEW_KEY, JSON.stringify({ lat: c.lat, lng: c.lng, zoom: map.getZoom(), grid: (cfg && cfg.grid) || "" }));
      } catch (_) {}
    }, 500);
  });

  L.control.zoom({ position: "topright" }).addTo(map);

  const CenterControl = L.Control.extend({
    options: { position: "topright" },
    onAdd: function () {
      const container = L.DomUtil.create(
        "div",
        "leaflet-bar leaflet-control map-center-control",
      );
      const mkBtn = function (choice, title, label, glyph, fn) {
        const btn = L.DomUtil.create("a", "map-center-btn", container);
        btn.href = "#";
        btn.title = title;
        btn.dataset.center = choice;
        btn.setAttribute("role", "button");
        btn.setAttribute("aria-label", label);
        btn.innerHTML = glyph;
        if (getCenterChoice() === choice) btn.classList.add("active");
        L.DomEvent.on(btn, "click", function (e) {
          L.DomEvent.preventDefault(e);
          // Centering on the station / mid-Atlantic ends Follow satellite.
          if (window.satFollow) window.satFollow.set(false, { source: "center" });
          setCenterChoice(choice);
          fn();
        });
      };
      L.DomEvent.disableClickPropagation(container);
      mkBtn("station", "Center on station (keep zoom)", "Center on station", "&#8982;", centerOnStation);
      mkBtn("atlantic", "Center mid-Atlantic", "Center mid-Atlantic", "&#127760;&#xFE0E;", centerMidAtlantic);
      // Follow satellite toggle (js/sat-follow.js: one state shared with the globe follow).
      const fb = L.DomUtil.create("a", "map-center-btn map-follow-btn", container);
      fb.href = "#";
      fb.title = "Follow satellite";
      fb.setAttribute("role", "button");
      fb.setAttribute("aria-label", "Follow satellite");
      fb.setAttribute("aria-pressed", "false");
      fb.innerHTML = SAT_FOLLOW_SVG;
      L.DomEvent.on(fb, "click", function (e) {
        L.DomEvent.preventDefault(e);
        if (window.satFollow) window.satFollow.toggle();
      });
      if (window.satFollow) setTimeout(window.satFollow.syncButtons, 0);

      return container;
    },
  });
  map.addControl(new CenterControl());

  const gibs = L.tileLayer(
    "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg",
    {
      attribution: "Leaflet | &copy; NASA GIBS / Blue Marble",
      maxZoom: 8,
      maxNativeZoom: 8,
      errorTileUrl: "",
    },
  );

  const esri = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      attribution: "Esri World Imagery",
      maxZoom: 8,
    },
  );

  gibs.addTo(map);
  gibs.on("tileerror", function () {
    if (!map.hasLayer(esri)) {
      map.removeLayer(gibs);
      esri.addTo(map);
    }
  });

  observerMarker = L.marker([0, 0], {
    icon: L.divIcon({
      className: "observer-icon",
      html: '<div style="color:#58a6ff;font-size:22px;font-weight:bold;text-shadow:0 0 4px #000;line-height:22px;text-align:center;">+</div>',
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    }),
  });

  initSunLayer();
}

/**
 * Day/night: translucent night polygon bounded by the terminator, a thin
 * terminator line and a "SUN" spot at the subsolar point (js/sun.js).
 * Own panes between tiles (200) and overlays (400) so tracks, footprints and
 * sat markers stay on top; pointer-events off so nothing captures clicks.
 * Drawn across three world copies (-540..540) for worldCopyJump; refreshed every 60 s.
 */
let nightPolygon = null;
let terminatorLine = null;
let sunMarker = null;
function initSunLayer() {
  if (!map || !window.sunCalc) return;
  const night = map.createPane("nightPane");
  night.style.zIndex = 350;
  night.style.pointerEvents = "none";
  const sunP = map.createPane("sunPane");
  sunP.style.zIndex = 390;
  sunP.style.pointerEvents = "none";
  updateSunLayer();
  setInterval(updateSunLayer, 60000);
}

function updateSunLayer() {
  if (!map || !window.sunCalc) return;
  const sun = window.sunCalc.subsolar(new Date());
  const term = window.sunCalc.terminator(sun, -540, 540, 2);
  const pole = window.sunCalc.nightPoleLat(sun);
  const ring = term.concat([[pole, 540], [pole, -540]]);
  if (!nightPolygon) {
    nightPolygon = L.polygon(ring, { pane: "nightPane", stroke: false, fillColor: "#000", fillOpacity: 0.4, interactive: false, smoothFactor: 1 }).addTo(map);
    terminatorLine = L.polyline(term, { pane: "nightPane", color: "#ffb347", weight: 1, opacity: 0.5, interactive: false }).addTo(map);
  } else {
    nightPolygon.setLatLngs(ring);
    terminatorLine.setLatLngs(term);
  }
  if (!sunMarker) {
    sunMarker = L.circleMarker([sun.lat, sun.lon], {
      pane: "sunPane", radius: 9, color: "#ff9f1c", weight: 2, fillColor: "#ffd34d", fillOpacity: 0.9, interactive: false,
    }).addTo(map);
    sunMarker.bindTooltip("SUN", { permanent: true, direction: "right", offset: [10, 0], className: "sun-label", interactive: false });
  } else sunMarker.setLatLng([sun.lat, sun.lon]);
}

/**
 * Moon (EME) visibility footprint: where the Moon is above the horizon, i.e. the
 * hemisphere centred on the sub-lunar point (geometric, ~1 deg parallax ignored).
 * Same construction as the night polygon, with the Moon in place of the Sun.
 */
let moonFootprint = null;
function moonFootprintRing(sub) {
  const term = window.sunCalc.terminator(sub, -540, 540, 2);
  const pole = sub.lat < 0 ? -90 : 90; // the pole that sees the Moon
  return term.concat([[pole, 540], [pole, -540]]);
}
function updateMoonFootprint(sub) {
  if (!map) return;
  if (!sub || !window.sunCalc) {
    if (moonFootprint && map.hasLayer(moonFootprint)) map.removeLayer(moonFootprint);
    return;
  }
  const ring = moonFootprintRing(sub);
  if (!moonFootprint) {
    moonFootprint = L.polygon(ring, { color: "#c9d1d9", weight: 1, opacity: 0.5, fillColor: "#c9d1d9", fillOpacity: 0.06, interactive: false, smoothFactor: 1 }).addTo(map);
  } else {
    moonFootprint.setLatLngs(ring);
    if (!map.hasLayer(moonFootprint)) moonFootprint.addTo(map);
  }
}

/** Geometric horizon footprint radius (meters) from sat altitude */
function footprintRadiusM(heightKm) {
  if (!Number.isFinite(heightKm) || heightKm <= 0) return 0;
  const ratio = EARTH_RADIUS_KM / (EARTH_RADIUS_KM + heightKm);
  if (ratio >= 1) return 0;
  const halfAngle = Math.acos(ratio);
  return EARTH_RADIUS_KM * halfAngle * 1000;
}

function centerOnStation() {
  const cfg = typeof loadConfig === "function" ? loadConfig() : null;
  const grid = cfg && cfg.grid ? cfg.grid : null;
  if (grid && typeof window.globeCenterOn === "function" && typeof maidenheadToLatLon === "function") {
    const ll = maidenheadToLatLon(grid);
    if (ll && window.globeCenterOn(ll.lat, ll.lon, { home: true })) return; // QTH-centered (kept across a pass preview)
  }
  if (!map) return;
  if (grid) {
    centerOnGrid(grid, true);
    return;
  }
  if (observerMarker && map.hasLayer(observerMarker)) {
    map.panTo(observerMarker.getLatLng());
  }
}

/**
 * Ground-track paths come with longitudes wrapped to [-180, 180]. Splitting at
 * the jump left a gap at the dateline and only drew lines in the central
 * world copy, so with worldCopyJump / wide world views the parts of the
 * track (and future orbits) in neighbouring copies were missing. Instead:
 * unwrap to a continuous longitude, then return copies shifted by k*360 so
 * the whole span appears in every visible world copy (-540..540).
 */
/** Great-circle densify so consecutive points are <= maxDeg apart (smooth curves, esp. near poles). */
function densifyTrack(latlngs, maxDeg) {
  maxDeg = maxDeg || 0.5;
  const R = Math.PI / 180;
  const out = [latlngs[0]];
  for (let i = 1; i < latlngs.length; i++) {
    const a = latlngs[i - 1];
    const b = latlngs[i];
    const la1 = a[0] * R, lo1 = a[1] * R, la2 = b[0] * R, lo2 = b[1] * R;
    const x1 = Math.cos(la1) * Math.cos(lo1), y1 = Math.cos(la1) * Math.sin(lo1), z1 = Math.sin(la1);
    const x2 = Math.cos(la2) * Math.cos(lo2), y2 = Math.cos(la2) * Math.sin(lo2), z2 = Math.sin(la2);
    const dot = Math.max(-1, Math.min(1, x1 * x2 + y1 * y2 + z1 * z2));
    const ang = Math.acos(dot);
    const n = Math.ceil(ang / R / maxDeg);
    if (n > 1 && ang > 1e-9) {
      const sinA = Math.sin(ang);
      for (let k = 1; k < n; k++) {
        const t = k / n;
        const f1 = Math.sin((1 - t) * ang) / sinA, f2 = Math.sin(t * ang) / sinA;
        const x = f1 * x1 + f2 * x2, y = f1 * y1 + f2 * y2, z = f1 * z1 + f2 * z2;
        out.push([Math.atan2(z, Math.sqrt(x * x + y * y)) / R, Math.atan2(y, x) / R]);
      }
    }
    out.push(b);
  }
  return out;
}

function splitAtDateLine(latlngs) {
  if (!latlngs || latlngs.length < 2) return [];
  latlngs = densifyTrack(latlngs, 0.5);
  const un = [];
  let off = 0;
  let prev = latlngs[0][1];
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < latlngs.length; i++) {
    const lat = latlngs[i][0];
    const lon = latlngs[i][1];
    if (i > 0) {
      const d = lon - prev;
      if (d > 180) off -= 360;
      else if (d < -180) off += 360;
    }
    prev = lon;
    const ul = lon + off;
    if (ul < min) min = ul;
    if (ul > max) max = ul;
    un.push([lat, ul]);
  }
  const out = [];
  const kLo = Math.ceil((-540 - max) / 360);
  const kHi = Math.floor((540 - min) / 360);
  for (let k = kLo; k <= kHi; k++) {
    out.push(k === 0 ? un : un.map((p) => [p[0], p[1] + k * 360]));
  }
  return out;
}

function clearPolylineArray(arr) {
  if (!arr) return;
  for (let i = 0; i < arr.length; i++) {
    if (map && arr[i]) map.removeLayer(arr[i]);
  }
  arr.length = 0;
}

function clearMapTracking() {
  clearPolylineArray(trailPolylines);
  clearPolylineArray(forwardPolylines);
  clearPolylineArray(passPolylines);
  if (satMarker && map) {
    map.removeLayer(satMarker);
    satMarker = null;
  }
  if (nowGhost && map) {
    map.removeLayer(nowGhost);
    nowGhost = null;
  }
  updateMoonFootprint(null);
  if (footprintCircle && map) {
    map.removeLayer(footprintCircle);
    footprintCircle = null;
  }
}

function setPolylinesFromPath(latlngs, style, targetArray) {
  clearPolylineArray(targetArray);
  if (!map || !latlngs || latlngs.length < 2) return;

  const segments = splitAtDateLine(latlngs);
  for (let i = 0; i < segments.length; i++) {
    const line = L.polyline(
      segments[i],
      Object.assign({ smoothFactor: 0.5, lineJoin: "round", lineCap: "round" }, style),
    ).addTo(map);
    targetArray.push(line);
  }
}

function centerOnGrid(grid, keepZoom) {
  if (!map || !grid) return;
  const pos = maidenheadToLatLon(grid);
  if (!pos) return;

  if (observerMarker) {
    observerMarker.setLatLng([pos.lat, pos.lon]);
    if (!map.hasLayer(observerMarker)) observerMarker.addTo(map);
    // Station label (callsign, or grid if none), matching the globe's "⌂ CALL".
    let call = "";
    try { const c = typeof loadConfig === "function" ? loadConfig() : null; call = (c && c.callsign) || ""; } catch (_) {}
    const txt = "\u2302 " + (call || grid);
    if (!observerMarker.getTooltip()) {
      observerMarker.bindTooltip(txt, { permanent: true, direction: "right", offset: [10, 0], className: "station-label" });
    } else observerMarker.setTooltipContent(txt);
  }

  // Load/config-driven recenter: respect a stored mid-Atlantic choice
  if (!keepZoom && getCenterChoice() === "atlantic") return;
  // Load/config-driven recenter: keep the restored view unless the grid changed.
  if (!keepZoom) {
    const sv = savedMapView();
    if (sv && String(sv.grid || "").toUpperCase() === String(grid).toUpperCase()) return;
  }

  if (keepZoom) {
    map.panTo([pos.lat, pos.lon]);
  } else {
    map.setView([pos.lat, pos.lon], Math.max(map.getZoom(), 4));
  }
}

function escHtmlMap(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/**
 * Selected-sat dot label. Pass preview (pT) keeps the old "NAME @ HH:MM" text;
 * live: line 1 = name + AOS/LOS countdown + clock, line 2 = El / Range / Alt.
 */
function selSatLabelHtml(state, pT) {
  const name = state.display || state.sat || "";
  if (pT) return escHtmlMap(name + " @ " + (typeof formatClockShort === "function" ? formatClockShort(pT) : new Date(pT).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })));
  const L = typeof satDotLabelLines === "function" ? satDotLabelLines(state) : null;
  if (!L) return escHtmlMap(name);
  const rest = (L.lines || [L.l1, L.l2]).slice(1).filter(Boolean);
  return escHtmlMap(L.l1) + (rest.length ? '<br><span class="sel-sat-l2">' + rest.map(escHtmlMap).join("<br>") + "</span>" : "");
}

function setSelSatLabel(label) {
  if (!satMarker || !label || satMarker.__label === label) return;
  if (satMarker.getTooltip()) satMarker.setTooltipContent(label);
  else
    satMarker.bindTooltip(label, {
      permanent: true,
      direction: "right",
      offset: [9, 0],
      className: "decode-label sel-sat-label",
    });
  satMarker.__label = label;
}

// Tick the AOS/LOS countdown each second between state messages; redraw on UTC/MT toggle.
function refreshSelSatLabel() {
  if (!satMarker || !lastMapState || !map || !map.hasLayer(satMarker)) return;
  const pv = window.passPreview && window.passPreview.posOf(lastMapState.sat);
  setSelSatLabel(selSatLabelHtml(lastMapState, pv && window.passPreview.get()));
}
setInterval(refreshSelSatLabel, 1000);
window.addEventListener("time-mode-change", refreshSelSatLabel);
document.addEventListener("units-change", refreshSelSatLabel);

function updateMapTracking(state) {
  if (!map || !state) return;
  // Layers belong to one sat: a state for a different sat starts fresh.
  if (state.sat && satMarker && satMarker.__sat && satMarker.__sat !== state.sat) {
    clearMapTracking();
  }

  lastMapState = state;
  if (window.satFollow) window.satFollow.onMapState(state); // live sample for Follow satellite
  // Pass preview: draw the selected sat at the preview time instead of now,
  // with a hollow red "now" ghost at the live position.
  const pv = window.passPreview && window.passPreview.posOf(state.sat);
  const livePos = state.position;
  if (pv) state = Object.assign({}, state, { position: pv.position });
  if (pv && livePos && Number.isFinite(livePos.lat)) {
    if (!nowGhost) nowGhost = L.circleMarker([livePos.lat, livePos.lon], { radius: 5, color: "#f85149", weight: 1.5, dashArray: "2 2", fillColor: "#f85149", fillOpacity: 0.15, interactive: false }).addTo(map);
    else { nowGhost.setLatLng([livePos.lat, livePos.lon]); if (!map.hasLayer(nowGhost)) nowGhost.addTo(map); }
  } else if (nowGhost && map.hasLayer(nowGhost)) map.removeLayer(nowGhost);

  if (state.position) {
    // Following in 2D (live view): the follow integrator owns the marker, so
    // the 1 s server sample doesn't snap it (js/sat-follow.js).
    const sp = !pv && window.satFollow ? window.satFollow.smoothPos(state.sat) : null;
    const lat = sp ? sp.lat : state.position.lat;
    const lon = sp ? sp.lon : state.position.lon;
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      if (!satMarker) {
        satMarker = L.circleMarker([lat, lon], {
          radius: 7,
          color: "#fff",
          weight: 2,
          fillColor: "#58a6ff",
          fillOpacity: 1,
        }).addTo(map);
        satMarker.__sat = state.sat || null;
      } else {
        satMarker.setLatLng([lat, lon]);
        if (!map.hasLayer(satMarker)) satMarker.addTo(map);
      }
      const pT = pv && window.passPreview.get();
      const label = selSatLabelHtml(state, pT);
      satMarker.setStyle(pv ? { fillColor: "#e3b341", color: "#fff" } : state.isMoon ? { fillColor: "#e6edf3", color: "#8b949e" } : { fillColor: "#58a6ff", color: "#fff" });
      setSelSatLabel(label);

      const hKm = state.position.heightKm;
      // Moon (EME): its "footprint" is nearly a hemisphere (Leaflet circles break
      // past ~80 deg), so draw it as a polygon bounded by its own terminator.
      const rM = state.isMoon ? 0 : footprintRadiusM(hKm);
      updateMoonFootprint(state.isMoon ? { lat: lat, lon: lon } : null);
      if (rM > 0) {
        if (!footprintCircle) {
          footprintCircle = L.circle([lat, lon], {
            radius: rM,
            color: "#58a6ff",
            weight: 1,
            opacity: 0.55,
            fillColor: "#58a6ff",
            fillOpacity: 0.06,
            interactive: false,
          }).addTo(map);
        } else {
          footprintCircle.setLatLng([lat, lon]);
          footprintCircle.setRadius(rM);
          if (!map.hasLayer(footprintCircle)) footprintCircle.addTo(map);
        }
      }
    }
  }

  if (state.trail && state.trail.length >= 2) {
    setPolylinesFromPath(
      state.trail,
      {
        color: "#58a6ff",
        weight: 1,
        opacity: 0.8,
      },
      trailPolylines,
    );
  } else {
    clearPolylineArray(trailPolylines);
  }

  if (state.forward && state.forward.length >= 2) {
    setPolylinesFromPath(
      state.forward,
      {
        color: "#58a6ff",
        weight: 0.9,
        opacity: 0.75,
        dashArray: "6 8",
      },
      forwardPolylines,
    );
  } else {
    clearPolylineArray(forwardPolylines);
  }
}

// Pass preview started / moved / ended: redraw from the last live state now.
document.addEventListener("pass-preview-change", function () {
  if (lastMapState) updateMapTracking(lastMapState);
});
