let map = null;
let satMarker = null;
let observerMarker = null;
let trailPolylines = [];
let forwardPolylines = [];
let passPolylines = [];

function initMap() {
  map = L.map("map", {
    worldCopyJump: true,
    minZoom: 2,
    maxZoom: 8,
    zoomControl: true,
  }).setView([20, 0], 2);

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

  // Observer marker (+)
  observerMarker = L.marker([0, 0], {
    icon: L.divIcon({
      className: "observer-icon",
      html: '<div style="color:#58a6ff;font-size:22px;font-weight:bold;text-shadow:0 0 4px #000;line-height:22px;text-align:center;">+</div>',
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    }),
  });
}

function splitAtDateLine(latlngs) {
  if (!latlngs || latlngs.length < 2) return [latlngs || []];

  const segments = [];
  let current = [latlngs[0]];

  for (let i = 1; i < latlngs.length; i++) {
    const prev = latlngs[i - 1];
    const curr = latlngs[i];
    const prevLon = prev[1];
    const currLon = curr[1];

    if (Math.abs(currLon - prevLon) > 180) {
      segments.push(current);
      current = [curr];
    } else {
      current.push(curr);
    }
  }
  if (current.length) segments.push(current);
  return segments.filter((s) => s && s.length >= 2);
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

  // Sat marker
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
    }
  }

  // 30-min trail (past)
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

  // Forward ground track (~2 orbits)
  if (state.forward && state.forward.length >= 2) {
    setPolylinesFromPath(
      state.forward,
      {
        color: "#58a6ff",
        weight: 1.5,
        opacity: 0.45,
        dashArray: "6 8",
      },
      forwardPolylines,
    );
  } else {
    clearPolylineArray(forwardPolylines);
  }

  // Optional: next-pass ground tracks could be added here from state.passes
  // Currently server sends sky (az/el) not ground path for passes
}
