/**
 * Cache policy for the static UI files (index.html, js/*.js, css/*.css ...):
 * "Cache-Control: no-cache" + a weak ETag of app version / size / mtime, so a
 * browser always revalidates (cheap 304 when unchanged) and a reload after an
 * update never runs stale JS / CSS.
 */
function etagFor(version, stat) {
  return 'W/"' + String(version || "").replace(/[^\w.+-]/g, "") + "-" + stat.size.toString(36) + "-" + Math.floor(stat.mtimeMs).toString(36) + '"';
}
function headersFor(etag) {
  return { "Cache-Control": "no-cache", ETag: etag };
}
/** True when the request's If-None-Match matches (send 304). */
function notModified(req, etag) {
  const inm = req && req.headers ? req.headers["if-none-match"] : null;
  if (!inm) return false;
  return String(inm).split(",").map((s) => s.trim()).includes(etag);
}
module.exports = { etagFor, headersFor, notModified };
