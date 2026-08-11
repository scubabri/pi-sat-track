/**
 * Server log hub — ring buffer + console intercept + WebSocket broadcast + file.
 *
 * Require this as early as possible in server.js (before radios/rotors):
 *   const logHub = require("./lib/log-hub");  // installs console hooks immediately
 *
 * Log file: <project>/server.log — truncated on every process start.
 *
 * After broadcast() exists:
 *   logHub.setBroadcast(broadcast);
 *
 * On each WS connect:
 *   logHub.sendHistory(ws);
 *
 * Open /log-viewer.html (not /js/log-viewer.js) for the live view.
 */

const fs = require("fs");
const path = require("path");

const MAX_LINES = 800;

/** Project root = parent of lib/ */
const LOG_FILE = path.join(__dirname, "..", "server.log");

const levels = new Set(["log", "info", "warn", "error", "debug"]);

/** @type {{ type: string, t: string, level: string, msg: string }[]} */
const ring = [];
let broadcastFn = null;
let installed = false;
/** @type {fs.WriteStream|null} */
let fileStream = null;

function nowIso() {
  try {
    return new Date().toISOString();
  } catch (_) {
    return "";
  }
}

function openLogFile() {
  try {
    // Truncate on every process start
    fileStream = fs.createWriteStream(LOG_FILE, {
      flags: "w",
      encoding: "utf8",
    });
    fileStream.write(
      "# pi-sat-track server.log — started " +
        nowIso() +
        "\n" +
        "# path: " +
        LOG_FILE +
        "\n",
    );
    fileStream.on("error", (err) => {
      try {
        // Avoid recursion through console.error if file is dead
        process.stderr.write("log-hub file error: " + err.message + "\n");
      } catch (_) {}
      fileStream = null;
    });
  } catch (e) {
    fileStream = null;
    try {
      process.stderr.write(
        "log-hub: cannot open " + LOG_FILE + ": " + e.message + "\n",
      );
    } catch (_) {}
  }
}

function writeFileLine(level, msg, t) {
  if (!fileStream) return;
  try {
    const ts = t || nowIso();
    fileStream.write(ts + " [" + level + "] " + msg + "\n");
  } catch (_) {}
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
  if (msg.length > 2000) msg = msg.slice(0, 2000) + "…";

  const entry = {
    type: "log",
    t: nowIso(),
    level: levels.has(level) ? level : "log",
    msg,
  };
  ring.push(entry);
  while (ring.length > MAX_LINES) ring.shift();

  writeFileLine(entry.level, entry.msg, entry.t);

  if (typeof broadcastFn === "function") {
    try {
      broadcastFn(entry);
    } catch (_) {}
  }
}

function installConsoleHooks() {
  if (installed) return;
  installed = true;

  openLogFile();

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

/** Attach WS broadcast once the server has created it. */
function setBroadcast(fn) {
  if (typeof fn === "function") broadcastFn = fn;
}

/**
 * Back-compat: init({ broadcast }) installs hooks (if needed) and sets broadcast.
 */
function init(opts) {
  installConsoleHooks();
  if (opts && typeof opts.broadcast === "function") {
    setBroadcast(opts.broadcast);
  }
  pushLine("log", [
    "Log hub active (ring " + MAX_LINES + " lines, file " + LOG_FILE + ")",
  ]);
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

function getLogFilePath() {
  return LOG_FILE;
}

// Install hooks as soon as this module is required
installConsoleHooks();

module.exports = {
  init,
  setBroadcast,
  sendHistory,
  getHistory,
  getLogFilePath,
  installConsoleHooks,
  MAX_LINES,
  LOG_FILE,
};
