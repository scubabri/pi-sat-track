const path = require("path");
const os = require("os");
const {
  listMakes,
  listModels,
  findModel,
  defaultSerialSelection,
} = require("./serial-catalog");
const platform = require("./platform");

const ROOT = path.join(__dirname, "..");
const CACHE_DIR = path.join(os.homedir(), ".rpitrack");
const CATALOG_CACHE = path.join(CACHE_DIR, "amsat_catalog.json");
const STATUS_CACHE = path.join(CACHE_DIR, "amsat_status.json");

const PORT = 3000;

const CATALOG_URL =
  "https://raw.githubusercontent.com/palewire/amateur-satellite-database/main/data/amsat-all-frequencies.json";
const AMSAT_STATUS = "https://www.amsat.org/status/";

let RADIO_TRANSPORT = process.env.RADIO_TRANSPORT || "tcp";
let RADIO_TYPE = process.env.RADIO_TYPE || "smartsdr";
let RADIO_PROTOCOL = process.env.RADIO_PROTOCOL || "cat";

if (RADIO_TYPE === "flex") RADIO_TYPE = "smartsdr";

/** Per-side radio config (UL TX / DL RX). Drivers still read mapped globals. */
let RADIO_UL = null;
let SINGLE_RADIO = false;
let RADIO_DL = null;

function defaultSideConfig(side) {
  return {
    transport: "tcp",
    type: "smartsdr",
    protocol: "cat",
    tciEndpoint: "127.0.0.1:50001",
    rigctlEndpoint: "127.0.0.1:4532",
    catEndpoint: side === "ul" ? "172.17.18.229:60002" : "172.17.18.229:60001",
    apiEndpoint: "",
    serialMake: "icom",
    serialModel: "ic-705",
    serialDevice: "/dev/ttyACM0",
    serialBaud: 19200,
  };
}

function normalizeSide(s, side) {
  const d = Object.assign(defaultSideConfig(side), s || {});
  d.transport = String(d.transport || "tcp").toLowerCase();
  d.type = normalizeRadioType(d.type || "smartsdr");
  d.protocol = String(d.protocol || "cat").toLowerCase();
  if (d.type === "rigctl") d.protocol = "rigctl";
  if (d.type === "smartsdr" && d.protocol === "tci") d.protocol = "cat";
  return d;
}
