/**
 * Mic-E device identification (comment prefix / suffix).
 *
 * Source: aprsorg/aprs-deviceid tocalls.yaml (commit c50d026, 2026-10-19),
 * sections "mice" and "micelegacy"; that database continues Bob Bruninga's
 * http://www.aprs.org/aprs12/mic-e-types.txt. Licensed CC BY-SA 2.0
 * (https://creativecommons.org/licenses/by-sa/2.0/), https://github.com/aprsorg/aprs-deviceid
 *
 * New style: comment starts with ` (messaging capable) or ' (tracker) and
 * ends with a 2-character device suffix. Legacy Kenwood: comment starts with
 * ">" (HT) or "]" (mobile), optionally ending with a 1-character suffix.
 */
const MICE_SUFFIX = new Map([
  ["_ ", "Yaesu VX-8"],
  ["_\"", "Yaesu FTM-350"],
  ["_#", "Yaesu VX-8G"],
  ["_$", "Yaesu FT1D"],
  ["_(", "Yaesu FT2D"],
  ["_0", "Yaesu FT3D"],
  ["_3", "Yaesu FT5D"],
  ["_1", "Yaesu FTM-300D"],
  ["_2", "Yaesu FTM-200D"],
  ["_4", "Yaesu FTM-500D"],
  ["_5", "Yaesu FTM-510D"],
  ["_6", "Yaesu FTX-1"],
  ["_7", "Yaesu FTM-310D"],
  ["_)", "Yaesu FTM-100D"],
  ["_%", "Yaesu FTM-400DR"],
  ["(5", "Anytone D578UV"],
  ["(8", "Anytone D878UV"],
  ["|3", "Byonics TinyTrak3"],
  ["|4", "Byonics TinyTrak4"],
  ["^A", "AxelStack LLC APRS Connect"],
  ["^v", "HinzTec anyfrog"],
  ["*v", "KissOZ Tracker"],
  ["*9", "NOR AVRT9"],
  [":2", "SQ8L VP-Tracker"],
  [" X", "SainSonic AP510"],
  ["[1", "Open Source APRSdroid"],
]);
/** Longest (prefix+suffix) match first. */
const MICE_LEGACY = [
  { prefix: ">", suffix: "", name: "Kenwood TH-D7A" },
  { prefix: ">", suffix: "=", name: "Kenwood TH-D72" },
  { prefix: ">", suffix: "^", name: "Kenwood TH-D74" },
  { prefix: ">", suffix: "&", name: "Kenwood TH-D75" },
  { prefix: "]", suffix: "", name: "Kenwood TM-D700" },
  { prefix: "]", suffix: "=", name: "Kenwood TM-D710" },
].sort((a, b) => b.suffix.length - a.suffix.length);

module.exports = { MICE_SUFFIX, MICE_LEGACY };
