/**
 * Host platform helpers for CAT serial device discovery.
 *
 * The sat-tracker server runs on the machine that opens the serial port
 * (typically a Raspberry Pi). UI / config use this to know which device
 * paths to offer for CAT Serial.
 */

const os = require("os");
const fs = require("fs");
const path = require("path");

/** Node process.platform: linux | darwin | win32 | ... */
function platformId() {
  return process.platform;
}

function isLinux() {
  return process.platform === "linux";
}

function isDarwin() {
  return process.platform === "darwin";
}

function isWindows() {
  return process.platform === "win32";
}

/**
 * Default serial device for IC-705-class USB CI-V on this OS.
 */
function defaultCatDevice() {
  if (isWindows()) return "COM3";
  if (isDarwin()) return "/dev/cu.usbmodem*";
  return "/dev/ttyACM0"; // Linux / Raspberry Pi
}

/**
 * Glob-style patterns (as strings) the UI can show as hints.
 * Actual enumeration is listSerialDevices().
 */
function serialDevicePatterns() {
  if (isWindows()) {
    return ["COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8"];
  }
  if (isDarwin()) {
    return ["/dev/cu.usbmodem*", "/dev/cu.usbserial*", "/dev/tty.usbmodem*"];
  }
  // Linux: ACM = native USB CDC (IC-705), USB = FTDI/CP210x adapters
  return ["/dev/ttyACM*", "/dev/ttyUSB*"];
}

/**
 * List present serial-ish device nodes on this host.
 * Best-effort; empty on failure or unsupported OS.
 */
function listSerialDevices() {
  try {
    if (isWindows()) {
      // No reliable enumeration without extra deps; return common COMs only as hints
      return serialDevicePatterns();
    }

    const dir = "/dev";
    const names = fs.readdirSync(dir);
    let matched;

    if (isDarwin()) {
      matched = names.filter(
        (n) =>
          n.startsWith("cu.usbmodem") ||
          n.startsWith("cu.usbserial") ||
          n.startsWith("tty.usbmodem") ||
          n.startsWith("tty.usbserial"),
      );
    } else {
      // linux
      matched = names.filter(
        (n) => n.startsWith("ttyACM") || n.startsWith("ttyUSB"),
      );
    }

    matched.sort();
    return matched.map((n) => path.join(dir, n));
  } catch (e) {
    console.warn("listSerialDevices:", e.message);
    return [];
  }
}

/** Snapshot for endpoints / status payloads. */
function hostInfo() {
  return {
    platform: platformId(), // linux | darwin | win32
    type: os.type(), // Linux | Darwin | Windows_NT
    release: os.release(),
    arch: os.arch(),
    hostname: os.hostname(),
    defaultCatDevice: defaultCatDevice(),
    serialPatterns: serialDevicePatterns(),
    serialDevices: listSerialDevices(),
  };
}

module.exports = {
  platformId,
  isLinux,
  isDarwin,
  isWindows,
  defaultCatDevice,
  serialDevicePatterns,
  listSerialDevices,
  hostInfo,
};
