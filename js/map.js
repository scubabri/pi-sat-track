let map = null;
let satMarker = null;
let observerMarker = null;
let footprintCircle = null;
let trailPolylines = [];
let forwardPolylines = [];
let passPolylines = [];

const EARTH_RADIUS_KM = 6371;

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
  }).setView([20, 0], 2);

  L.control.zoom({ position: "topright" }).addTo(map);

  const CenterControl = L.Control.extend({
    options: { position: "topright" },
    onAdd: function () {
      const container = L.DomUtil.create(
        "div",
        "leaflet-bar leaflet-control map-center-control",
      );
      const btn = L.DomUtil.create("a", "map-center-btn", container);
      btn.href = "#";
      btn.title = "Center on station (keep zoom)";
      btn.setAttribute("role", "button");
      btn.setAttribute("aria-label", "Center on station");
      btn.innerHTML = "&#8982;";

      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.on(btn, "click", function (e) {
        L.DomEvent.preventDefault(e);
        centerOnStation();
      });

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
  if (!map) return;
  const cfg = typeof loadConfig === "function" ? loadConfig() : null;
  const grid = cfg && cfg.grid ? cfg.grid : null;
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
function splitAtDateLine(latlngs) {
  if (!latlngs || latlngs.length < 2) return [];
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
    const line = L.polyline(segments[i], style).addTo(map);
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
  }

  if (keepZoom) {
    map.panTo([pos.lat, pos.lon]);
  } else {
    map.setView([pos.lat, pos.lon], Math.max(map.getZoom(), 4));
  }
}

function updateMapTracking(state) {
  if (!map || !state) return;

  if (state.position) {
    const lat = state.position.lat;
    const lon = state.position.lon;
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      if (!satMarker) {
        satMarker = L.circleMarker([lat, lon], {
          radius: 7,
          color: "#fff",
          weight: 2,
          fillColor: "#58a6ff",
          fillOpacity: 1,
        }).addTo(map);
      } else {
        satMarker.setLatLng([lat, lon]);
        if (!map.hasLayer(satMarker)) satMarker.addTo(map);
      }
      const label = state.display || state.sat || "";
      if (label && satMarker.__label !== label) {
        satMarker.unbindTooltip();
        satMarker.bindTooltip(label, {
          permanent: true,
          direction: "right",
          offset: [9, 0],
          className: "decode-label sel-sat-label",
        });
        satMarker.__label = label;
      }

      const hKm = state.position.heightKm;
      const rM = footprintRadiusM(hKm);
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
        weight: 2,
        opacity: 0.7,
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
        weight: 1.8,
        opacity: 0.7,
        dashArray: "6 8",
      },
      forwardPolylines,
    );
  } else {
    clearPolylineArray(forwardPolylines);
  }
}
