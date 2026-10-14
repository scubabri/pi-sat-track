#!/usr/bin/env node
/** Unit-style check: restored offsets survive setRadio(true) (no hardware). */
process.env.HOME = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "offchk-"));
const WebSocket = require("ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = { ulFineOffset: 700, dlFineOffset: -1500, manualDlOffset: -1515 };
(async () => {
  // Local TCI ws server so tci's "open" handler (old zeroing site) runs
  const wss = new WebSocket.Server({ port: parseInt(process.env.TCI_PORT || "50001", 10), host: "127.0.0.1" });
  wss.on("connection", (ws) => ws.on("error", () => {}));
  let fails = 0;
  for (const name of ["ic705", "ic9700", "rigctl", "tci", "flex"]) {
    const d = require("../lib/radios/" + name);
    if (d.init) d.init({ broadcast() {}, getContext: () => ({}) });
    d.setOffsets(R);
    d.setRadio(true);
    await sleep(800);
    const s = d.getRadioState();
    const ok = s.ulFineOffset === R.ulFineOffset && s.dlFineOffset === R.dlFineOffset && s.manualDlOffset === R.manualDlOffset;
    if (!ok) fails++;
    console.log((ok ? "PASS " : "FAIL ") + name, "UL", s.ulFineOffset, "DL", s.dlFineOffset, "manual", s.manualDlOffset,
      name === "tci" ? "(ws connected: " + s.tciConnected + ")" : "");
    try { d.setRadio(false); } catch (_) {}
  }
  wss.close();
  console.log(fails ? fails + " FAILED" : "ALL PASS");
  process.exit(fails ? 1 : 0);
})();
