/**
 * Host platform helpers for CAT serial device discovery and OS-specific defaults.
 *
 * The sat-tracker server runs on the machine that opens the serial port
 * (Raspberry Pi, generic Linux, Windows, or macOS). UI / config use this to
 * offer the right device paths for serial CAT and rotors.
 */

const os = require("os");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

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
 * Raspberry Pi (any model) — Linux + Pi device-tree / cpuinfo markers.
 * Used for Pi-oriented defaults (ttyACM/USB patterns, install docs).
 */
function isRaspberryPi() {
  if (!isLinux()) return false;
  try {
    const modelPath = "/proc/device-tree/model";
    if (fs.existsSync(modelPath)) {
      const model = fs
        .readFileSync(modelPath, "utf8")
        .replace(/\0/g, "")
        .trim();
      if (/raspberry\s*pi/i.test(model)) return true;
    }
  } catch (_) {}
  try {
    const cpu = fs.readFileSync("/proc/cpuinfo", "utf8");
    if (/Raspberry Pi/i.test(cpu)) return true;
    // BCM27xx / RP1 typical of Pi SoCs
    if (/\bBCM2[78]\d{2}\b/i.test(cpu) || /\bRP1\b/.test(cpu)) return true;
  } catch (_) {}
  return false;
}

/**
 * Coarse host class for UI / logging:
 *   'windows' | 'macos' | 'raspberry-pi' | 'linux' | 'other'
 */
function hostKind() {
  if (isWindows()) return "windows";
  if (isDarwin()) return "macos";
  if (isRaspberryPi()) return "raspberry-pi";
  if (isLinux()) return "linux";
  return "other";
}

/**
 * Human-readable OS label for status lines.
 */
function hostLabel() {
  switch (hostKind()) {
    case "windows":
      return "Windows";
    case "macos":
      return "macOS";
    case "raspberry-pi":
      return "Raspberry Pi";
    case "linux":
      return "Linux";
    default:
      return os.type() || platformId();
  }
}

/**
 * Default serial device for IC-705-class USB CI-V on this OS.
 */
function defaultCatDevice() {
  if (isWindows()) return "COM3";
  if (isDarwin()) return "/dev/cu.usbmodem0001";
  // Pi and generic Linux: ACM first (IC-705 / CDC), else USB-serial
  return "/dev/ttyACM0";
}

/**
 * Glob-style patterns (hints for UI / docs). Actual list is listSerialDevices().
 */
function serialDevicePatterns() {
  if (isWindows()) {
    return ["COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8"];
  }
  if (isDarwin()) {
    return [
      "/dev/cu.usbmodem*",
      "/dev/cu.usbserial*",
      "/dev/tty.usbmodem*",
      "/dev/tty.usbserial*",
    ];
  }
  // Raspberry Pi and generic Linux share the same tty namespace
  return ["/dev/ttyACM*", "/dev/ttyUSB*"];
}

/** Sort COM3 / COM10 / ttyUSB10 numerically by trailing digits. */
function sortPortPaths(paths) {
  return paths.slice().sort((a, b) => {
    const ma = String(a).match(/(\d+)\s*$/);
    const mb = String(b).match(/(\d+)\s*$/);
    if (ma && mb) {
      const na = parseInt(ma[1], 10);
      const nb = parseInt(mb[1], 10);
      if (na !== nb) return na - nb;
    }
    return String(a).localeCompare(String(b));
  });
}

/**
 * Windows: enumerate present COM ports (not a fixed COM1–COM8 guess list).
 */
function listSerialDevicesWindows() {
  const found = new Set();

  try {
    const out = execSync(
      'powershell -NoProfile -NonInteractive -Command "[System.IO.Ports.SerialPort]::GetPortNames() | ForEach-Object { $_.Trim() }"',
      {
        encoding: "utf8",
        timeout: 8000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    for (const line of String(out).split(/\r?\n/)) {
      const p = line.trim();
      if (/^COM\d+$/i.test(p)) found.add(p.toUpperCase());
    }
  } catch (e) {
    console.warn(
      "listSerialDevices Windows PowerShell:",
      e.message || String(e),
    );
  }

  if (found.size === 0) {
    try {
      const out = execSync("mode", {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const re = /Status for device (COM\d+):/gi;
      let m;
      while ((m = re.exec(out))) {
        found.add(m[1].toUpperCase());
      }
    } catch (e) {
      console.warn("listSerialDevices Windows mode:", e.message || String(e));
    }
  }

  if (found.size === 0) {
    console.warn(
      "listSerialDevices: no COM ports detected — showing COM1–COM8 hints",
    );
    return serialDevicePatterns();
  }

  return sortPortPaths([...found]);
}

/**
 * macOS: cu.* preferred (callout); also tty.* USB serial nodes.
 */
function listSerialDevicesDarwin() {
  const dir = "/dev";
  const names = fs.readdirSync(dir);
  const matched = names.filter(
    (n) =>
      n.startsWith("cu.usbmodem") ||
      n.startsWith("cu.usbserial") ||
      n.startsWith("cu.SLAB_USBtoUART") ||
      n.startsWith("cu.wchusbserial") ||
      n.startsWith("cu.usbserial-") ||
      n.startsWith("tty.usbmodem") ||
      n.startsWith("tty.usbserial"),
  );
  return sortPortPaths(matched.map((n) => path.join(dir, n)));
}

/**
 * Linux + Raspberry Pi: ttyACM (CDC) and ttyUSB (FTDI/CP210x/CH340).
 */
function listSerialDevicesLinux() {
  const dir = "/dev";
  const names = fs.readdirSync(dir);
  const matched = names.filter(
    (n) => n.startsWith("ttyACM") || n.startsWith("ttyUSB"),
  );
  return sortPortPaths(matched.map((n) => path.join(dir, n)));
}

/**
 * List present serial device paths for this host OS.
 */
function listSerialDevices() {
  try {
    const kind = hostKind();
    if (kind === "windows") return listSerialDevicesWindows();
    if (kind === "macos") return listSerialDevicesDarwin();
    if (kind === "raspberry-pi" || kind === "linux")
      return listSerialDevicesLinux();
    // other Unix-ish
    if (fs.existsSync("/dev")) return listSerialDevicesLinux();
    return [];
  } catch (e) {
    console.warn("listSerialDevices:", e.message);
    return [];
  }
}

/**
 * Async detailed list via serialport (all platforms).
 * Returns [{ path, manufacturer, serialNumber, friendlyName }, ...]
 */
async function listSerialDevicesDetailed() {
  try {
    const { SerialPort } = require("serialport");
    const ports = await SerialPort.list();
    return ports
      .map((p) => ({
        path: p.path,
        manufacturer: p.manufacturer || "",
        serialNumber: p.serialNumber || "",
        friendlyName: p.friendlyName || p.pnpId || "",
      }))
      .filter((p) => p.path)
      .sort((a, b) => {
        const ma = String(a.path).match(/(\d+)\s*$/);
        const mb = String(b.path).match(/(\d+)\s*$/);
        if (ma && mb) {
          const na = parseInt(ma[1], 10);
          const nb = parseInt(mb[1], 10);
          if (na !== nb) return na - nb;
        }
        return String(a.path).localeCompare(String(b.path));
      });
  } catch (e) {
    console.warn("listSerialDevicesDetailed:", e.message);
    return listSerialDevices().map((p) => ({
      path: p,
      manufacturer: "",
      serialNumber: "",
      friendlyName: "",
    }));
  }
}

/** Pi device-tree model string when available. */
function piModel() {
  if (!isRaspberryPi()) return null;
  try {
    const modelPath = "/proc/device-tree/model";
    if (fs.existsSync(modelPath)) {
      return fs.readFileSync(modelPath, "utf8").replace(/\0/g, "").trim();
    }
  } catch (_) {}
  return "Raspberry Pi";
}

/** Snapshot for endpoints / status payloads / startup log. */
function hostInfo() {
  const kind = hostKind();
  return {
    platform: platformId(), // linux | darwin | win32
    kind, // windows | macos | raspberry-pi | linux | other
    label: hostLabel(),
    type: os.type(),
    release: os.release(),
    arch: os.arch(),
    hostname: os.hostname(),
    isRaspberryPi: kind === "raspberry-pi",
    piModel: piModel(),
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
  isRaspberryPi,
  hostKind,
  hostLabel,
  defaultCatDevice,
  serialDevicePatterns,
  listSerialDevices,
  listSerialDevicesDetailed,
  piModel,
  hostInfo,
};
