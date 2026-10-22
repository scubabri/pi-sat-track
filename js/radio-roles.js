/**
 * Frequencies panel: Radio 1 / Radio 2 dropdown right under "Uplink" and
 * another right under "Downlink" (two-radio setups only). Picking a radio on
 * one side puts the other radio on the other side. The choice is saved on the
 * server per station profile, per satellite (sat-offsets ulRadio); a sat
 * without a saved choice uses the profile's Default uplink radio (Configure →
 * Radio). Fine offsets stay with the Uplink / Downlink role, not the radio.
 * Server: "radio-roles" payload in, "radio-role-set" {sat, ulRadio} out
 * (lib/radio-roles.js, lib/radio-role-router.js).
 */
(function () {
  let last = null;

  function sock() { return typeof ws !== "undefined" && ws && ws.readyState === 1 ? ws : null; }
  function el(id) { return document.getElementById(id); }
  const other = (n) => (n === 1 ? 2 : 1);

  function fillOptions(sel, radios) {
    const want = radios.map((r) => r.n + "|" + r.label).join(";");
    if (sel.__opts === want) return;
    sel.__opts = want;
    sel.innerHTML = "";
    for (const r of radios) {
      const o = document.createElement("option");
      o.value = String(r.n);
      o.textContent = r.label;
      sel.appendChild(o);
    }
  }

  /** Which configured radio is a Flex (CAT): 1, 2 or 0 (none / both). */
  function flexRadio() {
    let cfg = null;
    try { cfg = typeof loadConfig === "function" ? loadConfig() : null; } catch (_) {}
    if (!cfg || cfg.singleRadio) return 0;
    const isFlex = (s) => !!(s && (s.transport || "tcp") === "tcp" && (s.protocol || "cat") === "cat" && /^(smartsdr|flex|aethersdr)$/.test(String(s.type || "smartsdr")));
    const a = isFlex(cfg.radioUl), b = isFlex(cfg.radioDl);
    return a && !b ? 1 : b && !a ? 2 : 0;
  }

  function render() {
    const m = last;
    const two = !!(m && m.twoRadio);
    for (const side of ["ul", "dl"]) {
      const wrap = el("radio-role-" + side + "-wrap");
      if (!wrap) continue;
      wrap.hidden = !two;
      const block = wrap.closest && wrap.closest(".freq-block-split");
      if (block) block.classList.toggle("with-role", two);
      if (!two) continue;
      const sel = el("radio-role-" + side);
      fillOptions(sel, m.radios || []);
      const n = side === "ul" ? m.ulRadio : other(m.ulRadio);
      sel.value = String(n);
      const saved = el("radio-role-" + side + "-saved");
      if (saved) {
        const where = m.profile ? " \u00b7 " + m.profile : "";
        saved.textContent = m.saved ? "Saved for " + (m.sat || "this sat") + where : "Profile default" + where;
      }
    }
    // Flex Profile label: which radio / role the Flex is on now.
    const fl = el("flex-profile-label");
    if (fl) {
      const f = two ? flexRadio() : 0;
      fl.textContent = f ? "Flex Profile \u00b7 Radio " + f + " (" + (f === m.ulRadio ? "UL" : "DL") + ")" : "Flex Profile";
    }
  }

  function pick(side, n) {
    if (!last || !last.twoRadio || (n !== 1 && n !== 2)) return;
    const ul = side === "ul" ? n : other(n);
    // The two sides never match: the other dropdown follows right away.
    last = Object.assign({}, last, { ulRadio: ul, saved: true });
    render();
    const s = sock();
    if (s) s.send(JSON.stringify({ type: "radio-role-set", sat: last.sat, ulRadio: ul }));
  }

  function hookSelects() {
    for (const side of ["ul", "dl"]) {
      const sel = el("radio-role-" + side);
      if (!sel || sel.__hooked) continue;
      sel.__hooked = true;
      sel.addEventListener("change", () => pick(side, parseInt(sel.value, 10)));
    }
  }

  function patchWs() {
    if (typeof ws === "undefined" || !ws || ws.__radioRolesPatched) return;
    ws.__radioRolesPatched = true;
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (!msg) return;
      if (msg.type === "radio-roles") { last = msg; render(); }
      else if (msg.type === "profiles" && last) render(); // radio types / names may have changed
    });
    // The server's on-connect copy can arrive before this hook: ask for it.
    const req = () => { try { ws.send(JSON.stringify({ type: "radio-roles-get" })); } catch (_) {} };
    if (ws.readyState === 1) req();
    else ws.addEventListener("open", req);
  }

  window.radioRolesState = () => (last ? Object.assign({}, last) : null);

  function init() {
    hookSelects();
    patchWs();
    setInterval(patchWs, 500);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
