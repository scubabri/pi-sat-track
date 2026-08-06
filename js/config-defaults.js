/**
 * Config defaults, migration, localStorage, endpoint parse helpers.
 * Loaded before config-form.js and config.js (global script order).
 */
const CONFIG_KEY = "satTrackerConfig";
const PROFILE_CACHE_KEY = "satTrackerProfileName";

/** Mirrors lib/serial-catalog.js — keep in sync when adding models. */
const SERIAL_CATALOG = {
  icom: {
    label: "Icom",
    models: [
      {
        id: "ic-705",
        label: "IC-705",
        supported: true,
        defaultDevice: "/dev/ttyACM0",
        defaultBaud: 19200,
        hint: "CI-V over USB.",
      },
      {
        id: "ic-9700",
        label: "IC-9700",
        supported: true,
        defaultDevice: "/dev/ttyUSB0",
        defaultBaud: 19200,
        hint: "CI-V (addr 0xA2).",
      },
      {
        id: "other",
        label: "Other (CI-V)",
        supported: true,
        defaultDevice: "/dev/ttyUSB0",
        defaultBaud: 19200,
        hint: "Generic Icom CI-V.",
      },
    ],
  },
  kenwood: {
    label: "Kenwood",
    models: [
      {
        id: "ts-2000",
        label: "TS-2000",
        supported: true,
        defaultDevice: "/dev/ttyUSB0",
        defaultBaud: 9600,
        hint: "Kenwood CAT serial.",
      },
      {
        id: "other",
        label: "Other (Kenwood CAT)",
        supported: true,
        defaultDevice: "/dev/ttyUSB0",
        defaultBaud: 9600,
        hint: "Generic Kenwood CAT.",
      },
    ],
  },
  yaesu: {
    label: "Yaesu",
    models: [
      {
        id: "ft-991",
        label: "FT-991 / FT-991A",
        supported: true,
        defaultDevice: "/dev/ttyUSB0",
        defaultBaud: 38400,
        hint: "Yaesu CAT serial.",
      },
      {
        id: "other",
        label: "Other (Yaesu CAT)",
        supported: true,
        defaultDevice: "/dev/ttyUSB0",
        defaultBaud: 38400,
        hint: "Generic Yaesu CAT.",
      },
    ],
  },
};

/** Filled from server host/endpoints message (rotors.catalog()). */
let ROTOR_CATALOG = [
  {
    id: "rt21",
    label: "Green Heron RT-21",
    ports: 2,
    defaultBaud: 4800,
    defaultDevice: "/dev/ttyUSB0",
    hint: "Two serial ports — one for AZ, one for EL.",
  },
  {
    id: "gs232",
    label: "GS-232 (K3NG / Fox Delta)",
    ports: 1,
    defaultBaud: 9600,
    defaultDevice: "/dev/ttyACM0",
    hint: "Single USB serial. AZ and EL on one controller.",
  },
];

function findRotorDriver(id) {
  const key = String(id || "").toLowerCase();
  return ROTOR_CATALOG.find((d) => d.id === key) || null;
}

function setRotorCatalog(list) {
  if (Array.isArray(list) && list.length) {
    ROTOR_CATALOG = list.slice();
  }
}

function loadConfig() {
  try {
    const cfg = JSON.parse(localStorage.getItem(CONFIG_KEY)) || {};
    if (cfg.radioType === "flex") cfg.radioType = "smartsdr";
    return cfg;
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

function defaultSide(side) {
  return {
    transport: "tcp",
    type: side === "ul" ? "smartsdr" : "smartsdr",
    protocol: "cat",
    endpoint: side === "ul" ? "172.17.18.229:60002" : "172.17.18.229:60001",
    tciEndpoint: "127.0.0.1:50001",
    rigctlEndpoint: "127.0.0.1:4532",
    catEndpoint: side === "ul" ? "172.17.18.229:60002" : "172.17.18.229:60001",
    sdrconnectEndpoint: "127.0.0.1:5454",
    apiEndpoint: "172.17.18.46:4992",
    serialMake: "icom",
    serialModel: "ic-705",
    serialDevice: "/dev/ttyACM0",
    serialBaud: 19200,
  };
}

function defaultsEndpoints() {
  return {
    callsign: "",
    grid: "",
    elevation: 0,
    singleRadio: false,
    txSplit: true,
    radioUl: defaultSide("ul"),
    radioDl: defaultSide("dl"),
    // legacy flat fields kept for older server/profiles
    radioTransport: "tcp",
    radioType: "smartsdr",
    radioProtocol: "cat",
    rotorHost: "127.0.0.1",
    rotorAzPort: 4535,
    rotorElPort: 4536,
    rotorType: "rt21",
    rotorAzDevice: "/dev/ttyUSB0",
    rotorElDevice: "/dev/ttyUSB1",
    rotorBaud: 4800,
    rotorParkAz: 0,
    rotorParkEl: 0,
    rotorElMax: 180,
    rotorAzOnly: false,
  };
}

/** Migrate old single-radio config into radioUl / radioDl. */
function migrateLegacy(cfg) {
  const d = Object.assign(defaultsEndpoints(), cfg || {});
  if (d.radioUl && d.radioDl && d.radioUl.transport) return d;

  const transport = d.radioTransport || "tcp";
  const type = d.radioType === "flex" ? "smartsdr" : d.radioType || "smartsdr";
  let protocol = d.radioProtocol || "cat";
  if (type === "rigctl") protocol = "rigctl";

  const ul = defaultSide("ul");
  const dl = defaultSide("dl");
  ul.transport = transport;
  dl.transport = transport;
  ul.type = type;
  dl.type = type;
  ul.protocol = protocol;
  dl.protocol = protocol;

  if (d.tciHost) {
    const ep = (d.tciHost || "127.0.0.1") + ":" + (d.tciPort || 50001);
    ul.tciEndpoint = ep;
    dl.tciEndpoint = ep;
  }
  if (d.rigctlHost) {
    dl.rigctlEndpoint =
      (d.rigctlHost || "127.0.0.1") + ":" + (d.rigctlPort || 4532);
  }
  if (d.rigctlUlHost) {
    ul.rigctlEndpoint = d.rigctlUlHost + ":" + (d.rigctlUlPort || 4532);
  } else if (d.rigctlHost) {
    ul.rigctlEndpoint = dl.rigctlEndpoint;
  }
  if (d.flexUlHost) {
    ul.catEndpoint = d.flexUlHost + ":" + (d.flexUlPort || 60002);
  }
  if (d.flexDlHost) {
    dl.catEndpoint = d.flexDlHost + ":" + (d.flexDlPort || 60001);
  }
  if (d.flexApiHost) {
    const api = d.flexApiHost + ":" + (d.flexApiPort || 4992);
    ul.apiEndpoint = api;
    dl.apiEndpoint = api;
  }
  if (d.serialDevice) {
    dl.serialDevice = d.serialDevice;
    dl.serialBaud = d.serialBaud || 19200;
    dl.serialMake = d.serialMake || "icom";
    dl.serialModel = d.serialModel || "ic-705";
  }
  if (d.serialDevice2) {
    ul.serialDevice = d.serialDevice2;
    ul.serialBaud = d.serialBaud2 || 19200;
  } else if (d.serialDevice) {
    ul.serialDevice = d.serialDevice;
    ul.serialBaud = d.serialBaud || 19200;
  }

  d.radioUl = ul;
  d.radioDl = dl;
  return d;
}

function val(id) {
  const el = document.getElementById(id);
  return el ? el.value : "";
}

function setVal(id, v) {
  const el = document.getElementById(id);
  if (el) el.value = v != null ? v : "";
}

function parseEndpoint(str, defaultHost, defaultPort) {
  const s = (str || "").trim();
  if (!s) return { host: defaultHost, port: defaultPort };
  const m6 = s.match(/^\[([^\]]+)\]:(\d+)$/);
  if (m6) {
    const p = parseInt(m6[2], 10);
    return { host: m6[1], port: p > 0 && p < 65536 ? p : defaultPort };
  }
  const idx = s.lastIndexOf(":");
  if (idx > 0) {
    const host = s.slice(0, idx).trim();
    const p = parseInt(s.slice(idx + 1).trim(), 10);
    if (host && Number.isFinite(p) && p > 0 && p < 65536)
      return { host, port: p };
  }
  return { host: s || defaultHost, port: defaultPort };
}

function formatEndpoint(host, port) {
  if (!host) return "";
  return host + ":" + (port != null ? port : "");
}
