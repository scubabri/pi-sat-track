/**
 * Convert Maidenhead grid square to approximate lat/lon (center of square)
 * Supports 4 or 6 character grids (e.g. DN40 or DN40ab)
 */
function maidenheadToLatLon(grid) {
  if (!grid || grid.length < 4) return null;

  grid = grid.toUpperCase();

  const lon = (grid.charCodeAt(0) - 65) * 20 - 180 +
              (parseInt(grid.charAt(2), 10) * 2);

  const lat = (grid.charCodeAt(1) - 65) * 10 - 90 +
              (parseInt(grid.charAt(3), 10) * 1);

  // 6-character precision
  if (grid.length >= 6) {
    const lonSub = (grid.charCodeAt(4) - 65) * (2 / 24);
    const latSub = (grid.charCodeAt(5) - 65) * (1 / 24);
    return {
      lat: lat + latSub + (1 / 48),
      lon: lon + lonSub + (1 / 24)
    };
  }

  // 4-character – return center of the square
  return {
    lat: lat + 0.5,
    lon: lon + 1.0
  };
}