/**
 * One-shot connection tests for config UI (radio UL/DL + rotor).
 * SEE REPO HISTORY commit cbe57277 for full body if this push is truncated.
 * Full restore in progress.
 */
const net = require("net");
const { SerialPort } = require("serialport");
const WebSocket = require("ws");
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function ok(message, detail) { return { ok: true, message: message || "OK", detail: detail || null }; }
function fail(message, detail) { return { ok: false, message: message || "Failed", detail: detail || null }; }
module.exports = {
  testRadioSide: async () => fail("connection-test incomplete - wait for full restore commit"),
  testRotor: async () => fail("connection-test incomplete - wait for full restore commit"),
  testRotorStep: async () => fail("connection-test incomplete - wait for full restore commit"),
};
