/**
 * Serial radio catalog — manufacturers and models.
 * Only models with a registered driver are "supported".
 * "other" under each make uses that manufacturer's protocol driver so
 * users can try unlisted radios (best-effort).
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
      {
        id: "ic-9700",
        label: "IC-9700",
        supported: true,
        driver: "icom",
        defaultDevice: "/dev/ttyUSB0",
        defaultBaud: 19200,
        civAddr: 0xa2,
        hint: "CI-V (default addr 0xA2). Split: VFO A = DL, VFO B = UL.",
      },
      {
        id: "other",
        label: "Other (CI-V)",
        supported: true,
        driver: "icom",
        defaultDevice: "/dev/ttyUSB0",
        defaultBaud: 19200,
        hint: "Generic Icom CI-V. Uses current CI-V address; may work on unlisted models.",
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
        driver: "kenwood",
        defaultDevice: "/dev/ttyUSB0",
        defaultBaud: 9600,
        hint: "Kenwood CAT (semicolon). Split: VFO A = DL, VFO B = UL.",
      },
      {
        id: "other",
        label: "Other (Kenwood CAT)",
        supported: true,
        driver: "kenwood",
        defaultDevice: "/dev/ttyUSB0",
        defaultBaud: 9600,
        hint: "Generic Kenwood ';' CAT. Try for TS/TM models not listed.",
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
        driver: "yaesu",
        defaultDevice: "/dev/ttyUSB0",
        defaultBaud: 38400,
        hint: "Yaesu CAT (semicolon). Split: VFO A = DL, VFO B = UL.",
      },
      {
        id: "ft-817",
        label: "FT-817 / 817ND / 818",
        supported: true,
        driver: "ft817",
        defaultDevice: "/dev/ttyUSB0",
        defaultBaud: 9600,
        hint: "Binary 5-byte CAT, 8N2. Match radio menu CAT RATE.",
      },
      {
        id: "other",
        label: "Other (Yaesu CAT)",
        supported: true,
        driver: "yaesu",
        defaultDevice: "/dev/ttyUSB0",
        defaultBaud: 38400,
        hint: "Generic Yaesu ';' CAT. Try for FT models not listed.",
      },
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
    civAddr: m.civAddr != null ? m.civAddr : null,
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
