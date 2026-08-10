/**
 * Server log hub — ring buffer + console intercept + WebSocket broadcast.
 *
 * Wire in server.js (near the top, after broadcast is defined):
 *   const logHub = require("./lib/log-hub");
 *   logHub.init({ broadcast });
 *
 * On each WS connect:
 *   logHub.sendHistory(ws);
 *
 * Client popup (log-viewer.html) connects to /ws and shows type:"log" lines.
 */

const MAX_LINES = 800;

const levels = new Set(["log", "info", "warn", "error", "debug"]);

/** @type {{ t: string, level: string, msg: string }[]} */
const ring = [];
let broadcastFn = null;
let installed = false;

function nowIso() {
  try {
    return new Date().toISOString();
  } catch (_) {
    return "";
  }
}

function pushLine(level, args) {
  let msg;
  try {
    msg = args
      .map((a) => {
        if (typeof a === "string") return a;
        if (a instanceof Error) return a.stack || a.message || String(a);
        try {
          return JSON.stringify(a);
        } catch (_) {
          return String(a);
        }
      })
      .join(" ");
  } catch (_) {
    msg = String(args[0]);
  }
  // Cap individual line length
  if (msg.length > 2000) msg = msg.slice(0, 2000) + "…";

  const entry = {
    type: "log",
    t: nowIso(),
    level: levels.has(level) ? level : "log",
    msg,
  };
  ring.push(entry);
  while (ring.length > MAX_LINES) ring.shift();

  if (typeof broadcastFn === "function") {
    try {
      broadcastFn(entry);
    } catch (_) {
      // never throw from logging
    }
  }
}

function installConsoleHooks() {
  if (installed) return;
  installed = true;

  const orig = {
    log: console.log.bind(console),
    info: console.info ? console.info.bind(console) : console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug
      ? console.debug.bind(console)
      : console.log.bind(console),
  };

  function wrap(level) {
    return function (...args) {
      try {
        orig[level](...args);
      } catch (_) {}
      try {
        pushLine(level === "info" ? "log" : level, args);
      } catch (_) {}
    };
  }

  console.log = wrap("log");
  console.info = wrap("info");
  console.warn = wrap("warn");
  console.error = wrap("error");
  console.debug = wrap("debug");
}

/**
 * @param {{ broadcast?: (obj: object) => void }} opts
 */
function init(opts) {
  if (opts && typeof opts.broadcast === "function") {
    broadcastFn = opts.broadcast;
  }
  installConsoleHooks();
  // Seed so the hub itself is visible once
  pushLine("log", ["Log hub active (ring " + MAX_LINES + " lines)"]);
}

/** Send ring buffer to one client (call on WS connect). */
function sendHistory(ws) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(
      JSON.stringify({
        type: "log-history",
        lines: ring.slice(),
      }),
    );
  } catch (_) {}
}

function getHistory() {
  return ring.slice();
}

module.exports = {
  init,
  sendHistory,
  getHistory,
  MAX_LINES,
};
