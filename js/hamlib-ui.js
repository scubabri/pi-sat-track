/**
 * Configure → Radio → Connection "Hamlib serial" (lib/hamlib).
 *
 * Injects a block per radio side (cfg-ul / cfg-dl): Manufacturer → Model
 * (from the installed Hamlib's `rigctl -l`, with its status), serial port /
 * baud / CI-V, serial options, rigctld port, plus the Hamlib version line with
 * Update / Rollback / Reload models. The selected model always runs through
 * rigctld; a built-in driver is only mentioned as a hint (Native serial).
 * config-form.js calls hamlibUI.read / fill / visible.
 */
(function () {
  const SIDES = ["ul", "dl"];
  let modelsP = null; // Promise<{ok, groups, version, error}>
  let byId = new Map();
  let statusTimer = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const opt = (v, t) => '<option value="' + esc(v) + '">' + esc(t) + "</option>";

  function blockHtml(side) {
    const p = "cfg-" + side + "-hamlib";
    const sel = (id, opts, title) => '<select id="' + p + "-" + id + '" class="cfg-select"' + (title ? ' title="' + esc(title) + '"' : "") + ">" + opts + "</select>";
    return (
      '<div id="' + p + '-block" class="hamlib-block" hidden>' +
      '<div class="form-row"><label for="' + p + '-mfg">Manufacturer</label>' + sel("mfg", opt("", "Loading Hamlib models…")) + "</div>" +
      '<div class="form-row"><label for="' + p + '-model">Model</label>' + sel("model", "", "Hamlib model (status from Hamlib: Stable / Beta / Alpha / Untested)") + "</div>" +
      '<div class="form-hint hamlib-native" id="' + p + '-native" hidden></div>' +
      '<div class="form-row"><label for="' + p + '-device">Serial device</label>' +
      '<select id="' + p + '-device" class="cfg-select cfg-serial-device"></select>' +
      '<input type="text" id="' + p + '-device-custom" class="cfg-serial-custom" placeholder="/dev/ttyUSB0 or COM5" autocomplete="off" spellcheck="false" hidden /></div>' +
      '<div class="form-row-2"><div><label for="' + p + '-baud">Baud</label><input type="number" id="' + p + '-baud" min="300" step="1" placeholder="19200" /></div>' +
      '<div id="' + p + '-civ-row"><label for="' + p + '-civ">CI-V address (hex)</label><input type="text" id="' + p + '-civ" placeholder="model default" maxlength="4" spellcheck="false" autocomplete="off" title="Icom CI-V address, e.g. 94 for IC-7300. Blank = Hamlib model default." /></div></div>' +
      '<details class="hamlib-serial-opts"><summary>Serial options</summary>' +
      '<div class="form-row-2"><div><label for="' + p + '-databits">Data bits</label>' + sel("databits", opt("", "model default") + opt("8", "8") + opt("7", "7")) + "</div>" +
      '<div><label for="' + p + '-stopbits">Stop bits</label>' + sel("stopbits", opt("", "model default") + opt("1", "1") + opt("2", "2")) + "</div></div>" +
      '<div class="form-row-2"><div><label for="' + p + '-parity">Parity</label>' + sel("parity", opt("", "model default") + ["None", "Even", "Odd", "Mark", "Space"].map((x) => opt(x, x)).join("")) + "</div>" +
      '<div><label for="' + p + '-handshake">Handshake</label>' + sel("handshake", opt("", "model default") + opt("None", "None") + opt("XONXOFF", "XON/XOFF") + opt("Hardware", "Hardware (RTS/CTS)")) + "</div></div>" +
      '<div class="form-row-2"><div><label for="' + p + '-dtr">DTR</label>' + sel("dtr", opt("Unset", "leave (Unset)") + opt("ON", "ON") + opt("OFF", "OFF"), "Some interfaces power the radio's CAT from DTR / RTS; some key PTT on them (then OFF)") + "</div>" +
      '<div><label for="' + p + '-rts">RTS</label>' + sel("rts", opt("Unset", "leave (Unset)") + opt("ON", "ON") + opt("OFF", "OFF")) + "</div></div>" +
      "</details>" +
      '<p class="form-hint hamlib-run" id="' + p + '-run"></p>' +
      '<div class="hamlib-ver"><span class="hamlib-ver-text">Hamlib: checking…</span> ' +
      '<button type="button" class="btn btn-small hamlib-update" hidden>Update</button> ' +
      '<button type="button" class="btn btn-small hamlib-rollback" hidden>Roll back</button> ' +
      '<button type="button" class="btn btn-small hamlib-reload" title="Read the model list from the installed Hamlib again">Reload models</button></div>' +
      '<pre class="hamlib-job" hidden></pre>' +
      "</div>"
    );
  }

  function inject() {
    for (const side of SIDES) {
      const serial = $("cfg-" + side + "-serial-block");
      if (!serial || $("cfg-" + side + "-hamlib-block")) continue;
      serial.insertAdjacentHTML("afterend", blockHtml(side));
      const tr = $("cfg-" + side + "-transport");
      if (tr && !tr.querySelector('option[value="hamlib"]')) {
        const s = tr.querySelector('option[value="serial"]');
        if (s) s.textContent = "Native serial";
        tr.insertAdjacentHTML("beforeend", opt("hamlib", "Hamlib serial (rigctld)"));
      }
      if (typeof SERIAL_DEVICE_SELECT_IDS !== "undefined" && SERIAL_DEVICE_SELECT_IDS.indexOf("cfg-" + side + "-hamlib-device") < 0)
        SERIAL_DEVICE_SELECT_IDS.push("cfg-" + side + "-hamlib-device");
      const p = "cfg-" + side + "-hamlib";
      $(p + "-mfg").addEventListener("change", () => fillModels(side, null, true));
      $(p + "-model").addEventListener("change", () => onModel(side, true));
      $(p + "-block").querySelector(".hamlib-update").addEventListener("click", () => job("update"));
      $(p + "-block").querySelector(".hamlib-rollback").addEventListener("click", () => job("rollback"));
      $(p + "-block").querySelector(".hamlib-reload").addEventListener("click", () => {
        modelsP = null;
        loadModels(true).then(() => SIDES.forEach((s) => fillMfgs(s, $("cfg-" + s + "-hamlib-model").value || pending[s])));
      });
    }
    if (typeof initSerialDeviceSelects === "function") initSerialDeviceSelects();
  }

  function loadModels(reload) {
    if (!modelsP)
      modelsP = fetch("/api/hamlib/models" + (reload ? "?reload=1" : ""), { cache: "no-store" })
        .then((r) => r.json())
        .catch((e) => ({ ok: false, error: e.message, groups: [] }))
        .then((r) => {
          byId = new Map();
          (r.groups || []).forEach((g) => g.models.forEach((m) => byId.set(String(m.id), m)));
          if (!r.ok) modelsP = null; // retry next time (e.g. after installing Hamlib)
          return r;
        });
    return modelsP;
  }

  const pending = {}; // side -> model id to select once the list arrives

  function fillMfgs(side, modelId) {
    const p = "cfg-" + side + "-hamlib";
    return loadModels().then((r) => {
      const mfg = $(p + "-mfg");
      if (!r.ok) {
        mfg.innerHTML = opt("", r.error || "Hamlib not installed");
        $(p + "-model").innerHTML = modelId ? opt(modelId, "model " + modelId) : "";
        return;
      }
      const want = byId.get(String(modelId || ""));
      mfg.innerHTML = r.groups.map((g) => opt(g.mfg, g.mfg + " (" + g.models.length + ")")).join("");
      mfg.value = want ? want.mfg : r.groups.some((g) => g.mfg === "Icom") ? "Icom" : r.groups[0].mfg;
      fillModels(side, modelId, false);
    });
  }

  function fillModels(side, modelId, user) {
    const p = "cfg-" + side + "-hamlib";
    modelsP &&
      modelsP.then((r) => {
        const g = (r.groups || []).find((x) => x.mfg === $(p + "-mfg").value);
        const sel = $(p + "-model");
        sel.innerHTML = g ? g.models.map((m) => opt(m.id, m.model + " · " + m.status + (m.native ? " · built-in driver available" : "") + " (#" + m.id + ")")).join("") : "";
        if (modelId && byId.has(String(modelId))) sel.value = String(modelId);
        onModel(side, user);
      });
  }

  /** Model picked: native-driver note, CI-V row, and (user change) defaults from --dump-caps. */
  function onModel(side, user) {
    const p = "cfg-" + side + "-hamlib";
    const m = byId.get($(p + "-model").value);
    const icom = !!(m && /icom/i.test(m.mfg));
    $(p + "-civ-row").hidden = !icom;
    const note = $(p + "-native");
    // Informational only: the Hamlib model is always run through rigctld.
    if (m && m.native) {
      note.hidden = false;
      note.innerHTML =
        "Built-in driver available: " + esc(m.native.label) + ". Hamlib (rigctld) will be used as selected; " +
        (m.native.transport === "tcp" ? "Connection = TCP (SmartSDR CAT)" : "Connection = Native serial") + " is also an option.";
    } else {
      note.hidden = true;
      note.innerHTML = "";
    }
    if (!user || !m) return;
    fetch("/api/hamlib/caps?model=" + encodeURIComponent(m.id), { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!j.ok || $(p + "-model").value !== String(m.id)) return;
        const c = j.caps;
        if (c.defaultBaud) $(p + "-baud").value = c.defaultBaud;
        $(p + "-databits").value = c.dataBits ? String(c.dataBits) : "";
        $(p + "-stopbits").value = c.stopBits ? String(c.stopBits) : "";
        $(p + "-parity").value = c.parity || "";
        $(p + "-handshake").value = c.handshake || "";
        $(p + "-civ").value = c.civAddr ? c.civAddr.toString(16).toUpperCase() : "";
        $(p + "-run").textContent =
          "Hamlib: " + (c.status || "?") + " · " + (c.baudMin ? c.baudMin + "–" + c.baudMax + " baud" : "no serial port") + " · " +
          (c.hasSatmode ? "satellite mode (Main / Sub)" : c.canSplit ? "split: DL on VFO A, UL on VFO B" : "no split: downlink only on one VFO");
      })
      .catch(() => {});
  }

  /** config-form readSide(): always the Hamlib side for the selected model. */
  function read(side, base) {
    const p = "cfg-" + side + "-hamlib";
    const id = parseInt($(p + "-model").value || pending[side], 10) || null;
    const m = byId.get(String(id));
    const device = typeof readSerialDeviceField === "function" ? readSerialDeviceField(p + "-device") : $(p + "-device").value;
    const baud = parseInt($(p + "-baud").value, 10) || null;
    const v = (k) => $(p + "-" + k).value || "";
    return Object.assign({}, base, {
      transport: "hamlib",
      type: "rigctl",
      protocol: "rigctl",
      hamlibModel: id,
      hamlibMfg: m ? m.mfg : $(p + "-mfg").value || "",
      hamlibModelName: m ? m.model : "",
      serialDevice: device,
      serialBaud: baud,
      hamlibCivAddr: v("civ").trim(),
      hamlibDataBits: parseInt(v("databits"), 10) || null,
      hamlibStopBits: parseInt(v("stopbits"), 10) || null,
      hamlibParity: v("parity"),
      hamlibHandshake: v("handshake"),
      hamlibDtr: v("dtr") || "Unset",
      hamlibRts: v("rts") || "Unset",
    });
  }

  /** config-form fillSide(): restore a saved Hamlib side (or defaults). */
  function fill(side, d) {
    const p = "cfg-" + side + "-hamlib";
    if (!$(p + "-block")) return;
    d = d || {};
    const h = d.transport === "hamlib";
    pending[side] = h ? d.hamlibModel : null;
    if (typeof populateSerialDeviceSelect === "function") populateSerialDeviceSelect(p + "-device", h ? d.serialDevice : d.serialDevice || "");
    $(p + "-baud").value = h && d.serialBaud ? d.serialBaud : "";
    $(p + "-civ").value = h ? d.hamlibCivAddr || "" : "";
    $(p + "-databits").value = h && d.hamlibDataBits ? String(d.hamlibDataBits) : "";
    $(p + "-stopbits").value = h && d.hamlibStopBits ? String(d.hamlibStopBits) : "";
    $(p + "-parity").value = h ? d.hamlibParity || "" : "";
    $(p + "-handshake").value = h ? d.hamlibHandshake || "" : "";
    $(p + "-dtr").value = h ? d.hamlibDtr || "Unset" : "Unset";
    $(p + "-rts").value = h ? d.hamlibRts || "Unset" : "Unset";
    if (h) fillMfgs(side, d.hamlibModel);
  }

  /** config-form updateSideVisibility(): show the block for transport "hamlib". */
  function visible(side, transport) {
    const b = $("cfg-" + side + "-hamlib-block");
    if (!b) return;
    const on = transport === "hamlib";
    b.hidden = !on;
    if (on) {
      if (!$("cfg-" + side + "-hamlib-model").options.length) fillMfgs(side, pending[side]);
      refreshStatus(true);
    }
  }

  function renderStatus(st) {
    document.querySelectorAll(".hamlib-block").forEach((b) => {
      const t = b.querySelector(".hamlib-ver-text");
      t.textContent = !st.installed
        ? "Hamlib is not installed" + (st.plan && st.plan.method !== "none" ? "" : " — install it with your package manager")
        : "Hamlib " + (st.version || "?") + (st.latest ? (st.updateAvailable ? " · newer " + st.latest.version + " available" : " · up to date") : "") + (st.source ? " (" + st.source + ")" : "");
      t.title = (st.path || "") + (st.plan ? "\nUpdate: " + st.plan.label : "");
      const up = b.querySelector(".hamlib-update");
      up.hidden = !(st.plan && st.plan.method !== "none") || (st.installed && st.latest && !st.updateAvailable && st.plan.method !== "apt");
      up.textContent = st.installed ? "Update" : "Install";
      up.disabled = !!(st.job && st.job.running);
      b.querySelector(".hamlib-rollback").hidden = !st.rollback;
      const pre = b.querySelector(".hamlib-job");
      if (st.job) {
        const r = st.job.result;
        pre.hidden = false;
        pre.textContent =
          (st.job.running ? "Updating Hamlib… (" + (st.plan ? st.plan.label : "") + ")\n" : "") +
          st.job.log.slice(-12).join("\n") +
          (r && !r.ok ? "\n" + (r.error || "failed") + (r.command ? "\n\n  " + r.command : "") : "") +
          (r && r.ok ? "\n" + (r.message || "Hamlib " + (r.version || "") + " ready") + (r.note ? " — " + r.note : "") : "");
      } else pre.hidden = true;
      const runEl = b.querySelector(".hamlib-run");
      const ds = (st.daemons || []).map((x) => "rigctld " + x.state + " on " + (st.net && st.net.share ? "0.0.0.0" : "127.0.0.1") + ":" + x.port + (x.error ? " — " + x.error : "") + (x.restarts ? " · " + x.restarts + " restarts" : ""));
      if (ds.length) runEl.textContent = ds.join(" · ");
    });
    renderNet(st);
    if (st.sourceBuild && !document.querySelector(".hamlib-src")) {
      document.querySelectorAll(".hamlib-ver").forEach((v) =>
        v.insertAdjacentHTML("afterend", '<details class="hamlib-src"><summary>' + esc(st.sourceBuild.label) + "</summary><pre>" + esc(st.sourceBuild.commands.join("\n")) + "</pre></details>"),
      );
    }
  }

  let lastLatest = 0;
  function refreshStatus(latest) {
    const want = latest && Date.now() - lastLatest > 600000;
    if (want) lastLatest = Date.now();
    return fetch("/api/hamlib/status" + (want ? "?latest=1" : ""), { cache: "no-store" })
      .then((r) => r.json())
      .then((st) => {
        renderStatus(st);
        clearTimeout(statusTimer);
        if (st.job && st.job.running) statusTimer = setTimeout(() => refreshStatus(false), 1500);
        else if (st.job && st.job.result && st.job.result.ok && !st.job.reloaded) {
          st.job.reloaded = true;
          modelsP = null;
          loadModels(true).then(() => SIDES.forEach((s) => fillMfgs(s, $("cfg-" + s + "-hamlib-model").value || pending[s])));
        }
        return st;
      })
      .catch(() => null);
  }

  function job(kind) {
    if (kind === "rollback" && !confirm("Switch back to the previous Hamlib version?")) return;
    fetch("/api/hamlib/" + kind, { method: "POST" })
      .then((r) => r.json())
      .then((j) => {
        if (!j.ok) alert(j.error || "Could not start");
        refreshStatus(false);
      })
      .catch((e) => alert(e.message));
  }

  // ---- Configure → Station: "Share rigctld on network" (config.hamlibNet) ----
  function injectNet() {
    if ($("cfg-hamlib-net")) return;
    const units = $("cfg-units");
    const row = units && units.closest(".form-row, div");
    if (!row) return;
    row.insertAdjacentHTML(
      "afterend",
      '<div class="form-row" id="cfg-hamlib-net">' +
        '<label class="cfg-check"><input type="checkbox" id="cfg-hamlib-share" /> Share rigctld on network (Hamlib serial radios)</label>' +
        '<div class="form-row-2"><div><label for="cfg-hamlib-port-ul">rigctld port — main / UL radio</label><input type="number" id="cfg-hamlib-port-ul" min="1024" max="65535" placeholder="4534" /></div>' +
        '<div><label for="cfg-hamlib-port-dl">rigctld port — DL radio</label><input type="number" id="cfg-hamlib-port-dl" min="1024" max="65535" placeholder="4535" /></div></div>' +
        '<p class="form-hint" id="cfg-hamlib-net-hint"></p></div>',
    );
    $("cfg-hamlib-share").addEventListener("change", () => renderNet(lastStatus));
    ["ul", "dl"].forEach((k) => $("cfg-hamlib-port-" + k).addEventListener("input", () => renderNet(lastStatus)));
  }
  let lastStatus = null;
  function readNet() {
    if (!$("cfg-hamlib-net")) return undefined;
    return {
      share: !!$("cfg-hamlib-share").checked,
      portUl: parseInt($("cfg-hamlib-port-ul").value, 10) || 4534,
      portDl: parseInt($("cfg-hamlib-port-dl").value, 10) || 4535,
    };
  }
  function fillNet(n) {
    injectNet();
    if (!$("cfg-hamlib-net")) return;
    n = n || {};
    $("cfg-hamlib-share").checked = n.share === true;
    $("cfg-hamlib-port-ul").value = n.portUl || 4534;
    $("cfg-hamlib-port-dl").value = n.portDl || 4535;
    renderNet(lastStatus);
    refreshStatus(false);
  }
  function renderNet(st) {
    if (st) lastStatus = st;
    const h = $("cfg-hamlib-net-hint");
    if (!h) return;
    const n = readNet();
    const ips = (lastStatus && lastStatus.net && lastStatus.net.lanIps) || [];
    const win = lastStatus && lastStatus.net && lastStatus.net.platform === "win32";
    const where = (port) => (n.share ? (ips.length ? ips : ["<this computer's IP>"]).map((ip) => ip + ":" + port).join(" or ") : "127.0.0.1:" + port + " (this computer only)");
    h.innerHTML =
      "Main / UL radio: <b>" + esc(where(n.portUl)) + "</b> · DL radio (own serial port): <b>" + esc(where(n.portDl)) + "</b><br>" +
      (n.share
        ? "rigctld has <b>no password</b>: use on your local network only. "
        : "Off: rigctld listens on 127.0.0.1 only. ") +
      "In WSJT-X set Rig = <b>Hamlib NET rigctl</b>, Network Server = the address above, and turn its Doppler tracking and Split off so it does not fight our Doppler. Saving restarts rigctld." +
      (win && n.share && (n.portUl < 4534 || n.portUl > 4535 || n.portDl < 4534 || n.portDl > 4535)
        ? " <b>Windows Firewall:</b> setup opened TCP 4534–4535 only; allow other ports yourself."
        : "");
  }

  inject();
  injectNet();
  window.hamlibUI = { read, fill, visible, refreshStatus, loadModels, readNet, fillNet };
})();
