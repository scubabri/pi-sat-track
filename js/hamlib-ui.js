/**
 * Configure → Radio → Connection "Hamlib serial" (lib/hamlib).
 *
 * Injects a block per radio side (cfg-ul / cfg-dl): Manufacturer → Model
 * (from the installed Hamlib's `rigctl -l`, with its status), serial port /
 * baud / CI-V, serial options, rigctld port, plus the Hamlib version line with
 * Update / Rollback / Reload models. The selected model always runs through
 * rigctld.
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
      // Switching a native serial radio to Hamlib: preselect its Hamlib model (IC-705 -> 3085),
      // never a silent first-of-manufacturer (that saved IC ID-1 = 3054 before).
      if (!modelId && pendingNative[side]) {
        for (const g of r.groups) for (const m of g.models) if (m.native && m.native.serialModel === pendingNative[side]) modelId = m.id;
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
        sel.innerHTML =
          opt("", "— choose the model —") +
          (g ? g.models.map((m) => opt(m.id, m.model + " · " + m.status + " (#" + m.id + ")")).join("") : "");
        sel.value = modelId && byId.has(String(modelId)) && g && g.models.some((m) => String(m.id) === String(modelId)) ? String(modelId) : "";
        onModel(side, user);
      });
  }

  /** Model picked: CI-V row, and (user change) defaults from --dump-caps. */
  function onModel(side, user) {
    const p = "cfg-" + side + "-hamlib";
    const m = byId.get($(p + "-model").value);
    const icom = !!(m && /icom/i.test(m.mfg));
    $(p + "-civ-row").hidden = !icom;
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
    // Only what is selected in the list (from this Hamlib's rigctl -l); "" = not chosen.
    const id = parseInt($(p + "-model").value, 10) || (byId.size ? null : parseInt(pending[side], 10) || null);
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
  const pendingNative = {};
  function fill(side, d) {
    const p = "cfg-" + side + "-hamlib";
    if (!$(p + "-block")) return;
    d = d || {};
    const h = d.transport === "hamlib";
    pending[side] = h ? d.hamlibModel : null;
    pendingNative[side] = !h && d.transport === "serial" ? d.serialModel || null : null;
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
      const ds = (st.daemons || []).map((x) => "rigctld " + x.state + " on " + "127.0.0.1" + ":" + x.port + (x.error ? " — " + x.error : "") + (x.restarts ? " · " + x.restarts + " restarts" : ""));
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
  let reloadedJob = null;
  function refreshStatus(latest) {
    const want = latest && Date.now() - lastLatest > 600000;
    if (want) lastLatest = Date.now();
    return fetch("/api/hamlib/status" + (want ? "?latest=1" : ""), { cache: "no-store" })
      .then((r) => r.json())
      .then((st) => {
        renderStatus(st);
        clearTimeout(statusTimer);
        if (st.job && st.job.running) statusTimer = setTimeout(() => refreshStatus(false), 1500);
        else if (st.job && st.job.result && st.job.result.ok && reloadedJob !== st.job.startedAt) {
          reloadedJob = st.job.startedAt; // once per finished update (st is a fresh object every poll)
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

  // ---- Configure → Station: rigctld ports per radio (config.hamlibNet), localhost only ----
  function injectNet() {
    if ($("cfg-hamlib-net")) return;
    const units = $("cfg-units");
    const row = units && units.closest(".form-row, div");
    if (!row) return;
    row.insertAdjacentHTML(
      "afterend",
      '<div class="form-row" id="cfg-hamlib-net">' +
        '<div class="form-row-2"><div><label for="cfg-hamlib-port-ul">rigctld port — Radio 1</label><input type="number" id="cfg-hamlib-port-ul" min="1024" max="65535" placeholder="4534" /><small class="form-hint hamlib-port-off" id="cfg-hamlib-port-ul-off" hidden>not shared (no rigctld)</small></div>' +
        '<div><label for="cfg-hamlib-port-dl">rigctld port — Radio 2</label><input type="number" id="cfg-hamlib-port-dl" min="1024" max="65535" placeholder="4535" /><small class="form-hint hamlib-port-off" id="cfg-hamlib-port-dl-off" hidden>not shared (no rigctld)</small></div></div>' +
        '<p class="form-hint" id="cfg-hamlib-net-hint"></p></div>',
    );
    ["ul", "dl"].forEach((k) => $("cfg-hamlib-port-" + k).addEventListener("input", () => renderNet(lastStatus)));
  }
  let lastStatus = null;
  function readNet() {
    if (!$("cfg-hamlib-net")) return undefined;
    return {
      portUl: parseInt($("cfg-hamlib-port-ul").value, 10) || 4534,
      portDl: parseInt($("cfg-hamlib-port-dl").value, 10) || 4535,
    };
  }
  function fillNet(n) {
    injectNet();
    if (!$("cfg-hamlib-net")) return;
    n = n || {};
    $("cfg-hamlib-port-ul").value = n.portUl || 4534;
    $("cfg-hamlib-port-dl").value = n.portDl || 4535;
    renderNet(lastStatus);
    refreshStatus(false);
  }
  function devOf(side) {
    const id = "cfg-" + side + "-hamlib-device";
    return String((typeof readSerialDeviceField === "function" ? readSerialDeviceField(id) : ($(id) || {}).value) || "").trim().toLowerCase();
  }
  function renderNet(st) {
    if (st) lastStatus = st;
    const h = $("cfg-hamlib-net-hint");
    if (!h) return;
    const n = readNet();
    const addr = (port) => "127.0.0.1:" + port;
    // Ports belong to the configured radio (Radio 1 / Radio 2), not to the per-satellite UL / DL role.
    const single = !!($("cfg-single-radio") || {}).checked;
    const isHamlib = (side) => ($("cfg-" + side + "-transport") || {}).value === "hamlib";
    const h1 = isHamlib("ul");
    const h2 = !single && isHamlib("dl") && !(h1 && devOf("ul") === devOf("dl"));
    const show = (side, on) => {
      const f = $("cfg-hamlib-port-" + side);
      // Always shown side by side; a radio without rigctld is grayed out (its stored port is kept on save).
      if (f) {
        if (f.parentElement) f.parentElement.hidden = false;
        f.disabled = !on;
        f.style.opacity = on ? "" : "0.5";
        f.title = on ? "" : "Radio not on Hamlib serial: not shared (no rigctld)";
      }
      const off = $("cfg-hamlib-port-" + side + "-off");
      if (off) off.hidden = on;
    };
    show("ul", h1);
    show("dl", h2);
    const line = (k, on, port) => "Radio " + k + ": " + (on ? esc(addr(port)) : "not shared (no rigctld)");
    const lines = [line(1, h1, n.portUl)];
    if (!single) lines.push(line(2, h2 || (!single && isHamlib("dl") && h1), h2 ? n.portDl : n.portUl));
    h.innerHTML = !h1 && !h2 ? "No radio uses Hamlib serial yet. Set Radio 1 or Radio 2 to Hamlib serial in Radio config first." : lines.join(" · ");
  }

  // ---- Station summary: rigctld state (separate from Radio on/off) ----
  function renderSummary(daemons, net) {
    const dt = $("cfg-sum-rigctld-dt");
    const dd = $("cfg-sum-rigctld");
    if (!dt || !dd) return;
    const list = daemons || [];
    dt.hidden = dd.hidden = !list.length;
    if (!list.length) return;
    const who = (d) => (d.radios && d.radios.length ? "R" + d.radios.join("+") + " " : "");
    const one = (d) =>
      who(d) +
      (d.state === "running" ? "connected :" + d.port
      : d.state === "failed" ? "error" + (d.error ? ": " + d.error : "")
      : "reconnecting" + (d.restarts ? " (" + d.restarts + ")" : ""));
    dd.textContent = list.map(one).join(" · ");
    dd.title = "rigctld 127.0.0.1 (runs with Radio off). " + list.map((d) => "Radio " + (d.radios || []).join("+") + " port " + d.port + " " + d.state + (d.error ? " — " + d.error : "")).join("; ");
    dd.className = list.some((d) => d.state === "failed") ? "hamlib-sum-err" : list.every((d) => d.state === "running") ? "hamlib-sum-ok" : "hamlib-sum-wait";
  }
  function hookWs() {
    if (typeof ws === "undefined" || !ws || ws.__hamlibHooked) return;
    ws.__hamlibHooked = true;
    ws.addEventListener("message", (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m && m.type === "hamlib") renderSummary(m.daemons, m.net);
    });
    ws.addEventListener("open", () => refreshSummary());
  }
  function refreshSummary() {
    return fetch("/api/hamlib/status", { cache: "no-store" })
      .then((r) => r.json())
      .then((st) => renderSummary(st.daemons, st.net))
      .catch(() => {});
  }
  setInterval(hookWs, 2000);
  setInterval(refreshSummary, 30000);
  setTimeout(() => { hookWs(); refreshSummary(); }, 500);

  // Station hint follows Radio-tab changes (transport, single radio, serial port).
  document.addEventListener("change", (e) => {
    const id = (e.target && e.target.id) || "";
    if (/^cfg-(ul|dl)-(transport|hamlib-device|hamlib-model)$|^cfg-single-radio$/.test(id)) renderNet(null);
  });

  // ---- Configure → Rotor → Controller "Hamlib serial (rotctld)": Manufacturer / Model from `rotctl -l` ----
  let rotP = null;
  let rotById = new Map();
  let rotPending = null;
  let rotElPending = null;
  const RT21 = 405; // Hamlib RT-21: 2nd controller via rotctld -R (native)
  function rotSplitUi() {
    const split = !!($("cfg-rotor-hamlib-split") || {}).checked;
    const rt21 = ($("cfg-rotor-hamlib-model") || {}).value === String(RT21);
    const elb = $("cfg-rotor-hamlib-el");
    if (elb) elb.hidden = !split;
    const opts = $("cfg-rotor-hamlib-el-opts");
    if (opts) opts.hidden = rt21; // RT-21: EL port only; baud / model from the AZ unit
    const h = $("cfg-rotor-hamlib-hint");
    if (h) h.textContent = !split ? "rotctld 127.0.0.1:4537." : rt21 ? "RT-21: one rotctld 127.0.0.1:4537, EL port via -R." : "rotctld AZ 127.0.0.1:4537 · EL 127.0.0.1:4538.";
  }
  function fillElModels(modelId) {
    rotP &&
      rotP.then((r) => {
        const g = (r.groups || []).find((x) => x.mfg === $("cfg-rotor-hamlib-mfg").value);
        const sel = $("cfg-rotor-hamlib-el-model");
        if (!sel) return;
        sel.innerHTML = opt("", "same as AZ") + (g ? g.models.map((m) => opt(m.id, m.model + " (#" + m.id + ")")).join("") : "");
        sel.value = modelId && g && g.models.some((m) => String(m.id) === String(modelId)) ? String(modelId) : "";
      });
  }
  function injectRotor() {
    const type = $("cfg-rotor-type");
    if (!type || $("cfg-rotor-hamlib")) return;
    const row = type.closest(".form-row") || type.parentElement;
    if (!row) return;
    row.insertAdjacentHTML(
      "afterend",
      '<div class="form-row" id="cfg-rotor-hamlib" hidden><div class="form-row-2">' +
        '<div><label for="cfg-rotor-hamlib-mfg">Manufacturer</label><select id="cfg-rotor-hamlib-mfg" class="cfg-select"></select></div>' +
        '<div><label for="cfg-rotor-hamlib-model">Model</label><select id="cfg-rotor-hamlib-model" class="cfg-select"></select></div></div>' +
        '<label class="cfg-check-label" for="cfg-rotor-hamlib-split"><input type="checkbox" id="cfg-rotor-hamlib-split" /> Separate AZ / EL controllers</label>' +
        '<div id="cfg-rotor-hamlib-el" hidden>' +
        '<div class="form-row"><label for="cfg-rotor-hamlib-el-device">EL serial device</label>' +
        '<select id="cfg-rotor-hamlib-el-device" class="cfg-select cfg-serial-device"></select>' +
        '<input type="text" id="cfg-rotor-hamlib-el-device-custom" class="cfg-serial-custom" placeholder="/dev/ttyUSB1 or COM6" autocomplete="off" spellcheck="false" hidden /></div>' +
        '<div class="form-row-2" id="cfg-rotor-hamlib-el-opts"><div><label for="cfg-rotor-hamlib-el-baud">EL baud</label><input type="number" id="cfg-rotor-hamlib-el-baud" min="300" step="1" placeholder="AZ baud" /></div>' +
        '<div><label for="cfg-rotor-hamlib-el-model">EL model</label><select id="cfg-rotor-hamlib-el-model" class="cfg-select"></select></div></div></div>' +
        '<p class="form-hint" id="cfg-rotor-hamlib-hint">rotctld 127.0.0.1:4537.</p></div>',
    );
    type.addEventListener("change", rotorVisible);
    $("cfg-rotor-hamlib-mfg").addEventListener("change", () => fillRotModels(null));
    $("cfg-rotor-hamlib-model").addEventListener("change", () => {
      // Green Heron RT-21 az + el is two controllers: default to separate
      if ($("cfg-rotor-hamlib-model").value === String(RT21)) $("cfg-rotor-hamlib-split").checked = true;
      fillElModels(null);
      rotSplitUi();
    });
    $("cfg-rotor-hamlib-split").addEventListener("change", rotSplitUi);
    if (typeof SERIAL_DEVICE_SELECT_IDS !== "undefined" && SERIAL_DEVICE_SELECT_IDS.indexOf("cfg-rotor-hamlib-el-device") < 0)
      SERIAL_DEVICE_SELECT_IDS.push("cfg-rotor-hamlib-el-device");
  }
  function loadRotors() {
    if (!rotP)
      rotP = fetch("/api/hamlib/rotors", { cache: "no-store" })
        .then((r) => r.json())
        .catch((e) => ({ ok: false, error: e.message, groups: [] }))
        .then((r) => {
          rotById = new Map();
          (r.groups || []).forEach((g) => g.models.forEach((m) => rotById.set(String(m.id), m)));
          if (!r.ok) rotP = null;
          return r;
        });
    return rotP;
  }
  function rotorVisible() {
    const b = $("cfg-rotor-hamlib");
    if (!b) return;
    b.hidden = ($("cfg-rotor-type") || {}).value !== "hamlib";
    if (!b.hidden) fillRotMfgs(rotPending);
  }
  function fillRotMfgs(modelId) {
    return loadRotors().then((r) => {
      const mfg = $("cfg-rotor-hamlib-mfg");
      if (!r.ok) {
        mfg.innerHTML = opt("", r.error || "Hamlib not installed");
        $("cfg-rotor-hamlib-model").innerHTML = modelId ? opt(modelId, "model " + modelId) : opt("", "—");
        return;
      }
      const want = rotById.get(String(modelId || ""));
      mfg.innerHTML = opt("", "— manufacturer —") + r.groups.map((g) => opt(g.mfg, g.mfg + " (" + g.models.length + ")")).join("");
      mfg.value = want ? want.mfg : "";
      fillRotModels(modelId);
    });
  }
  function fillRotModels(modelId) {
    rotP &&
      rotP.then((r) => {
        const g = (r.groups || []).find((x) => x.mfg === $("cfg-rotor-hamlib-mfg").value);
        const sel = $("cfg-rotor-hamlib-model");
        sel.innerHTML = opt("", "— choose the model —") + (g ? g.models.map((m) => opt(m.id, m.model + " · " + m.status + " (#" + m.id + ")")).join("") : "");
        sel.value = modelId && g && g.models.some((m) => String(m.id) === String(modelId)) ? String(modelId) : "";
        fillElModels(rotElPending);
        rotSplitUi();
      });
  }
  /** config-form: separate AZ / EL controller fields. */
  function readRotorEl() {
    if (!$("cfg-rotor-hamlib-split")) return {};
    const dev = typeof readSerialDeviceField === "function" ? readSerialDeviceField("cfg-rotor-hamlib-el-device") : $("cfg-rotor-hamlib-el-device").value;
    const em = parseInt(($("cfg-rotor-hamlib-el-model") || {}).value, 10);
    return {
      rotorHamlibSplit: !!$("cfg-rotor-hamlib-split").checked,
      rotorHamlibElDevice: String(dev || "").trim(),
      rotorHamlibElBaud: parseInt($("cfg-rotor-hamlib-el-baud").value, 10) || null,
      rotorHamlibElModel: em > 0 ? em : rotById.size ? null : rotElPending,
    };
  }
  function fillRotorEl(d) {
    injectRotor();
    d = d || {};
    if (!$("cfg-rotor-hamlib-split")) return;
    $("cfg-rotor-hamlib-split").checked = d.rotorHamlibSplit === true;
    if (typeof populateSerialDeviceSelect === "function") populateSerialDeviceSelect("cfg-rotor-hamlib-el-device", d.rotorHamlibElDevice || "");
    else $("cfg-rotor-hamlib-el-device").value = d.rotorHamlibElDevice || "";
    $("cfg-rotor-hamlib-el-baud").value = d.rotorHamlibElBaud || "";
    rotElPending = parseInt(d.rotorHamlibElModel, 10) > 0 ? parseInt(d.rotorHamlibElModel, 10) : null;
    rotSplitUi();
  }
  /** config-form: rotorHamlibModel (null = not chosen; never a silent first entry). */
  function readRotor() {
    const sel = $("cfg-rotor-hamlib-model");
    if (!sel) return undefined;
    const v = parseInt(sel.value, 10);
    if (v > 0) return v;
    return rotById.size ? null : parseInt(rotPending, 10) || null;
  }
  function fillRotor(model) {
    injectRotor();
    rotPending = parseInt(model, 10) > 0 ? parseInt(model, 10) : null;
    rotorVisible();
  }

  inject();
  injectNet();
  injectRotor();
  window.hamlibUI = { read, fill, visible, refreshStatus, loadModels, readNet, fillNet, readRotor, fillRotor, readRotorEl, fillRotorEl };
})();
