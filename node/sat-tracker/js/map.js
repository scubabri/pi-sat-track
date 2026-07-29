let map;
let stationMarker = null;
let satMarker = null;
let trailLines = []; // array of polylines (split at date line)
let forwardLines = []; // array of polylines (split at date line)

function initMap() {
  map = L.map("map", {
    center: [20, 0],
    zoom: 2,
    minZoom: 1,
    maxZoom: 8,
    zoomControl: false,
  });

  const blueMarble = L.tileLayer(
    "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/" +
      "BlueMarble_ShadedRelief_Bathymetry/default/" +
      "GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg",
    {
      attribution: "© NASA GIBS / Blue Marble",
      maxZoom: 8,
      tileSize: 256,
    },
  );

  const esri = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { attribution: "Tiles © Esri", maxZoom: 19 },
  );

  blueMarble.addTo(map);
  blueMarble.on("tileerror", () => {
    if (map.hasLayer(blueMarble)) {
      map.removeLayer(blueMarble);
      esri.addTo(map);
    }
  });

  L.control.zoom({ position: "bottomleft" }).addTo(map);

  // Live satellite
  satMarker = L.circleMarker([0, 0], {
    radius: 7,
    color: "#fff",
    weight: 2,
    fillColor: "#58a6ff",
    fillOpacity: 1,
  }).addTo(map);
}

function centerOnGrid(grid) {
  if (!map) return;
  const pos = maidenheadToLatLon(grid);
  if (!pos) return;

  map.panTo([pos.lat, pos.lon]);

  if (stationMarker) {
    stationMarker.setLatLng([pos.lat, pos.lon]);
  } else {
    stationMarker = L.marker([pos.lat, pos.lon], {
      title: "Station",
      riseOnHover: true,
    }).addTo(map);
    stationMarker.bindPopup(`Grid: ${grid.toUpperCase()}`);
  }
}

/**
 * Split a path at antimeridian crossings so Leaflet doesn't
 * draw a horizontal line across the whole map.
 * points: array of [lat, lon]
 * returns: array of segments, each segment is [lat, lon][]
 */
function splitAtDateLine(points) {
  if (!points || points.length < 2) return points ? [points] : [];

  const segments = [];
  let current = [points[0]];

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const dLon = Math.abs(curr[1] - prev[1]);

    if (dLon > 180) {
      // crossed the date line – start a new segment
      if (current.length > 1) segments.push(current);
      current = [curr];
    } else {
      current.push(curr);
    }
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

function clearLines(lineArray) {
  lineArray.forEach((l) => map.removeLayer(l));
  lineArray.length = 0;
}

function setSplitPolylines(lineArray, points, style) {
  clearLines(lineArray);
  const segments = splitAtDateLine(points);
  segments.forEach((seg) => {
    const line = L.polyline(seg, style).addTo(map);
    lineArray.push(line);
  });
}

/**
 * In-place updates only – never recreates the map.
 */
function updateMapTracking(state) {
  if (!map || !state || !state.position) return;

  const { lat, lon } = state.position;
  satMarker.setLatLng([lat, lon]);

  if (state.trail && state.trail.length) {
    setSplitPolylines(trailLines, state.trail, {
      color: "#58a6ff",
      weight: 2,
      opacity: 0.75,
    });
  }

  if (state.forward && state.forward.length) {
    setSplitPolylines(forwardLines, state.forward, {
      color: "#f85149",
      weight: 1.5,
      opacity: 0.8,
      dashArray: "6 4",
    });
  }
}
