let map;
let stationMarker = null;

function initMap() {
  map = L.map('map', {
    center: [20, 0],
    zoom: 2,
    minZoom: 1,
    maxZoom: 8,
    zoomControl: false
  });

  const blueMarble = L.tileLayer(
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/' +
    'BlueMarble_ShadedRelief_Bathymetry/default/' +
    'GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg',
    {
      attribution: '© NASA GIBS / Blue Marble',
      maxZoom: 8,
      tileSize: 256
    }
  );

  const esri = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'Tiles © Esri', maxZoom: 19 }
  );

  blueMarble.addTo(map);

  blueMarble.on('tileerror', () => {
    if (map.hasLayer(blueMarble)) {
      map.removeLayer(blueMarble);
      esri.addTo(map);
    }
  });

  L.control.zoom({ position: 'bottomleft' }).addTo(map);
}

/**
 * Center the map on a Maidenhead grid and place/update the station marker.
 * Keeps the current zoom level (only pans).
 */
function centerOnGrid(grid) {
  if (!map) {
    console.warn('Map not ready yet');
    return;
  }

  const pos = maidenheadToLatLon(grid);
  if (!pos) {
    console.warn('Invalid gridsquare:', grid);
    return;
  }

  // Keep current zoom, only pan to the new location
  map.panTo([pos.lat, pos.lon]);

  // Add or move the station marker
  if (stationMarker) {
    stationMarker.setLatLng([pos.lat, pos.lon]);
  } else {
    stationMarker = L.marker([pos.lat, pos.lon], {
      title: 'Station location',
      riseOnHover: true
    }).addTo(map);

    stationMarker.bindPopup(`Grid: ${grid.toUpperCase()}`);
  }
}