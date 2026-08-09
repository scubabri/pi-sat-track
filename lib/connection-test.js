/**
 * One-shot connection tests for config UI (radio UL/DL + rotor).
 * Rotor steps use a held serial session per device so open/close
 * races between read → nudge → goto do not lock the USB adapter.
 */
const net = require("net");
const { SerialPort } = require("serialport");
const WebSocket = require("ws");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ok(message, detail) {
  return { ok: true, message: message || "OK", detail: detail || null };
}
function fail(message, detail) {
  return { ok: false, message: message || "Failed", detail: detail || null };
}

// TEMP_MINIMAL - will replace with full file
module.exports = {
  testRadioSide: async () => fail("connection-test.js incomplete — pull again"),
  testRotor: async () => fail("connection-test.js incomplete — pull again"),
  testRotorStep: async () => fail("connection-test.js incomplete — pull again"),
};
