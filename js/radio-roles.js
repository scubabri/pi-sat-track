/**
 * Frequencies panel: Radio 1 / Radio 2 dropdown right under "Uplink" and
 * another right under "Downlink" (two-radio setups only). Picking a radio on
 * one side puts the other radio on the other side. The choice is saved on the
 * server per station profile, per satellite (sat-offsets ulRadio); a sat
 * without a saved choice uses the profile's Default uplink radio (Configure →
 * Radio). Fine offsets stay with the Uplink / Downlink role, not the radio.
 * Server: "radio-roles" payload in, "radio-role-set" {sat, ulRadio, off} out
 * (lib/radio-roles.js, lib/radio-role-router.js).
 *
 * "Disabled" (either dropdown, per sat): that leg is not used at all, e.g. a
 * simplex digipeater (UL = DL) worked on one radio. Only one leg at a time:
 * while one side is Disabled the other side's Disabled option is greyed out.
 * The disabled leg's readout / Doppler / fine buttons are greyed and read
 * "Disabled" (js/tracker.js asks window.radioRoleOff()).
 */
(function () {
  let last = null;

  function sock() { return typeof ws !== "undefined" && ws && ws.readyState === 1 ? ws : null; }
  function el(id) { return document.getElementById(id); }
  const other = (n) => (n === 1 ? 2 : 1);

  const OFF = "off";
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
    const o = document.createElement("option");
    o.value = OFF;
    o.textContent = "Disabled";
    sel.appendChild(o);
  }
  /** Leg disabled for the selected sat ("ul" | "dl" | null); two radios only. */
  function offLeg() { return last && last.twoRadio && (last.off === "ul" || last.off === "dl") ? last.off : null; }

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
      const off = offLeg();
      sel.value = off === side ? OFF : String(n);
      // Never both legs: the other side's Disabled can't be picked meanwhile.
      const offOpt = [...(sel.options || [])].find((o) => o.value === OFF);
      if (offOpt) offOpt.disabled = !!off && off !== side;
    }
    paintOff();
    // Flex Profile label: which radio / role the Flex is on now.
    const fl = el("flex-profile-label");
    if (fl) {
      const f = two ? flexRadio() : 0;
      const role = f === m.ulRadio ? "ul" : "dl";
      const off = offLeg();
      fl.textContent = !f ? "Flex Profile"
        : off === role ? "Flex Profile \u00b7 Radio " + f + " (not used)"
          : "Flex Profile \u00b7 Radio " + f + " (" + role.toUpperCase() + ")";
    }
  }

  /** Grey the disabled leg: block class, readout text, fine buttons. */
  function paintOff() {
    const off = offLeg();
    for (const side of ["ul", "dl"]) {
      const isOff = off === side;
      const v = el("freq-" + side);
      const block = v && v.closest ? v.closest(".freq-block") : null;
      if (block) block.classList.toggle("role-off", isOff);
      for (const b of ["btn-fine-" + side + "-minus", "btn-fine-" + side + "-plus"]) {
        const btn = el(b);
        if (btn) btn.disabled = isOff;
      }
      if (isOff) {
        if (v) {
          v.textContent = "Disabled";
          v.title = "Not used for this satellite (Radio dropdown above)";
          v.classList.remove("oob", "oob-warn");
        }
        const d = el("freq-" + side + "-doppler");
        if (d) d.textContent = "";
      }
    }
  }

  /**
   * side's dropdown changed to radio n (1|2) or "off". Radio: that side gets
   * it, the other side the other radio, and a Disabled leg on this side comes
   * back (the other side's stays). Disabled: this leg off, the other leg keeps
   * its radio. Both legs off is refused (render() restores the dropdown).
   */
  function nextRoles(cur, side, v) {
    const off = cur.off === "ul" || cur.off === "dl" ? cur.off : null;
    if (v === OFF) {
      if (off && off !== side) return null; // never both legs
      return { ulRadio: cur.ulRadio, off: side };
    }
    if (v !== 1 && v !== 2) return null;
    return { ulRadio: side === "ul" ? v : other(v), off: off === side ? null : off };
  }
  window.__radioRolesNext = nextRoles; // tests

  function pick(side, v) {
    if (!last || !last.twoRadio) return;
    const next = nextRoles(last, side, v);
    if (!next) { render(); return; }
    // The two sides never match: the other dropdown follows right away.
    last = Object.assign({}, last, next, { saved: true });
    render();
    const s = sock();
    if (s) s.send(JSON.stringify({ type: "radio-role-set", sat: last.sat, ulRadio: next.ulRadio, off: next.off }));
  }

  function hookSelects() {
    for (const side of ["ul", "dl"]) {
      const sel = el("radio-role-" + side);
      if (!sel || sel.__hooked) continue;
      sel.__hooked = true;
      sel.addEventListener("change", () => pick(side, sel.value === OFF ? OFF : parseInt(sel.value, 10)));
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
  window.radioRoleOff = offLeg;
  window.radioRolesPaintOff = paintOff;

  function init() {
    hookSelects();
    patchWs();
    setInterval(patchWs, 500);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
