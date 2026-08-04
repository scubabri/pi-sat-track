/**
 * Serial radio catalog — manufacturers and models.
 * Only models with a registered driver are "supported".
 * Adding a Kenwood/Yaesu driver: register it in radios/index.js and
 * mark the model supported: true here.
 */

const SERIAL_CATALOG = {
  icom: {
    label: "Icom",
    models: [
      {
        id: "ic-705",
        label: "IC-705",
        supported: true,
        driver: "icom",
        defaultDevice: "/dev/ttyACM0",
        defaultBaud: 19200,
        civAddr: 0xa4,
        hint: "CI-V over USB. Cross-band split: VFO A = DL, VFO B = UL.",
      },
      // Future Icom models:
      // { id: "ic-9700", label: "IC-9700", supported: false, driver: "icom" },
    ],
  },
  kenwood: {
    label: "Kenwood",
    models: [
      // { id: "ts-2000", label: "TS-2000", supported: false, driver: "kenwood" },
    ],
  },
  yaesu: {
    label: "Yaesu",
    models: [
      // { id: "ft-817", label: "FT-817/818", supported: false, driver: "yaesu" },
    ],
  },
};

function listMakes() {
  return Object.keys(SERIAL_CATALOG).map((id) => ({
    id,
    label: SERIAL_CATALOG[id].label,
  }));
}

function listModels(makeId) {
  const make = SERIAL_CATALOG[String(makeId || "").toLowerCase()];
  if (!make) return [];
  return make.models.map((m) => ({
    id: m.id,
    label: m.label,
    supported: !!m.supported,
    driver: m.driver || null,
    defaultDevice: m.defaultDevice || "/dev/ttyUSB0",
    defaultBaud: m.defaultBaud || 9600,
    hint: m.hint || "",
  }));
}

function findModel(makeId, modelId) {
  const models = listModels(makeId);
  const id = String(modelId || "").toLowerCase();
  return models.find((m) => m.id === id) || null;
}

function defaultSerialSelection() {
  return { make: "icom", model: "ic-705" };
}

module.exports = {
  SERIAL_CATALOG,
  listMakes,
  listModels,
  findModel,
  defaultSerialSelection,
};
