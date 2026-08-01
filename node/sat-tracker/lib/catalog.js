const fs = require("fs");
const {
  CACHE_DIR,
  CATALOG_CACHE,
  STATUS_CACHE,
  CATALOG_URL,
  AMSAT_STATUS,
  DEFAULT_SAT,
} = require("./config");
const { getSatrecForNorad } = require("./tle");
const { lookAngles } = require("./orbit");

let CATALOG = {};
let catalogNote = "not loaded";
let ACTIVE = new Set();
let statusNote = "not loaded";
