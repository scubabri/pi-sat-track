"use strict";
/**
 * Worked stations: QSOs logged from this app (Log box or WSJT-X), kept for the
 * map / globe "Worked" layer. Simple JSON in the settings folder
 * (~/.rpitrack/worked.json), shared by every browser, survives restarts.
 * Size-safe: newest MAX_ITEMS kept, strings clipped, written atomically.
 * Purely a display list; the ADIF / UDP logging output is untouched.
 */
const fs = require("fs");
const path = require("path");

const MAX_ITEMS = 2000;
const GRID_RE = /^[A-R]{2}[0-9]{2}([A-X]{2})?$/i;
const clip = (v, n) => String(v == null ? "" : v).trim().slice(0, n);

function gridCenter(g) {
  const G = String(g).toUpperCase();
  let lon = (G.charCodeAt(0) - 65) * 20 - 180 + Number(G[2]) * 2;
  let lat = (G.charCodeAt(1) - 65) * 10 - 90 + Number(G[3]);
  if (G.length >= 6) {
    lon += (G.charCodeAt(4) - 65) * (5 / 60) + 2.5 / 60;
    lat += (G.charCodeAt(5) - 65) * (2.5 / 60) + 1.25 / 60;
  } else {
    lon += 1;
    lat += 0.5;
  }
  return { lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4 };
}

/** Normalize one QSO -> stored item, or null without a callsign. */
function normalize(q) {
  if (!q) return null;
  const call = clip(q.call, 20).toUpperCase();
  if (!call) return null;
  const g = clip(q.grid, 6);
  const grid = GRID_RE.test(g) ? g.slice(0, 4).toUpperCase() + g.slice(4).toLowerCase() : "";
  const t = Number(q.time instanceof Date ? q.time.getTime() : q.time);
  const item = {
    call,
    grid,
    time: Number.isFinite(t) && t > 0 ? Math.round(t) : Date.now(),
    sat: clip(q.sat, 40),
    band: clip(q.band, 20),
    mode: clip(q.mode, 20),
    source: clip(q.source, 12),
  };
  if (grid) Object.assign(item, gridCenter(grid));
  return item;
}

function keyOf(i) {
  const d = new Date(i.time);
  return i.call + "|" + d.toISOString().slice(0, 16); // same call within the same minute = same QSO
}

function createWorked(opts) {
  const o = opts || {};
  const file = o.file;
  const max = o.max || MAX_ITEMS;
  const onChange = o.onChange || (() => {});
  let items = [];

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      const arr = Array.isArray(j) ? j : Array.isArray(j.items) ? j.items : [];
      items = arr.map(normalize).filter(Boolean).sort((a, b) => a.time - b.time).slice(-max);
    } catch (_) {
      items = [];
    }
  }
  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }));
      fs.renameSync(tmp, file);
    } catch (e) {
      console.warn("Worked list save failed:", e.message);
    }
  }
  function changed() {
    save();
    try { onChange(payload()); } catch (_) {}
  }
  /** Add one logged QSO; returns the stored item (null if ignored / duplicate). */
  function add(q) {
    const it = normalize(q);
    if (!it) return null;
    const k = keyOf(it);
    if (items.some((x) => keyOf(x) === k)) return null;
    items.push(it);
    items.sort((a, b) => a.time - b.time);
    if (items.length > max) items = items.slice(-max);
    changed();
    return it;
  }
  function clear() {
    items = [];
    changed();
  }
  function list() {
    return items.slice();
  }
  function payload() {
    return { type: "worked", max, items: items.slice() };
  }
  load();
  return { add, clear, list, payload, load };
}

/** Worked item from a Log-box / WSJT-X record summary (lib/logbook recordSummary) + grid. */
function fromRecord(summary, grid, source, fallbackTime, adifDateTime) {
  const s = summary || {};
  const t = (adifDateTime && adifDateTime(s.date, s.time)) || fallbackTime || new Date();
  const band = s.band && s.bandRx && s.bandRx !== s.band ? s.band + "/" + s.bandRx : s.band || s.bandRx || "";
  return { call: s.call, grid, time: t, sat: s.satName || (s.propMode === "EME" ? "EME" : ""), band, mode: s.mode, source };
}

module.exports = { createWorked, normalize, fromRecord, gridCenter, MAX_ITEMS };
