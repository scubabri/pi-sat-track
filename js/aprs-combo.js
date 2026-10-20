/**
 * Dark-UI combobox for the APRS header fields (To / Via / For / Default To).
 *
 * Replaces <input list=…> + <datalist>: the browser popup can't be styled,
 * opens offset from the field and only shows options that match the current
 * text, so a filled Via ("RS0ISS") hid every other choice.
 *
 *   aprsCombo.attach(input, { items: () => [{ value, label }], title })
 *
 * - ▼, focus or click: ALL options, current value highlighted.
 * - Typing filters (value or label contains the text); free text is kept.
 * - Up / Down, Enter picks the highlighted option, Escape closes.
 * - One shared menu on <body>, position: fixed directly under the field, same
 *   width, clipped to the viewport (flips above when there is no room below),
 *   above the floating windows and the Configure modal. Follows the field
 *   while the window is moved / resized; closes on blur, outside click or
 *   when the field is hidden (window minimised / closed).
 * A pick sets the value and fires "input" + "change" on the field, so the
 * existing listeners (APRS.setHdr …) run as if the user had typed it.
 */
(function () {
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  let menu = null;
  let cur = null; // { input, wrap, opts, items, hi, raf }

  function ensureMenu() {
    if (menu) return menu;
    menu = document.createElement("div");
    menu.className = "aprs-combo-menu";
    menu.setAttribute("role", "listbox");
    menu.hidden = true;
    document.body.appendChild(menu);
    // keep focus in the field while clicking the menu
    menu.addEventListener("mousedown", (e) => e.preventDefault());
    menu.addEventListener("click", (e) => {
      e.stopPropagation(); // Configure closes on any click outside its panel
      const o = e.target.closest && e.target.closest("[data-i]");
      if (o && cur) pick(cur.items[Number(o.getAttribute("data-i"))]);
    });
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (!cur) return;
        if (menu.contains(e.target) || cur.wrap.contains(e.target)) return;
        close();
      },
      true,
    );
    window.addEventListener("resize", () => cur && place());
    return menu;
  }

  function norm(v) {
    return String(v == null ? "" : v).trim().toUpperCase();
  }
  function itemsFor(c) {
    let list = [];
    try {
      list = (c.opts.items && c.opts.items()) || [];
    } catch (_) {}
    const out = [];
    const seen = new Set();
    for (const it of list) {
      const o = typeof it === "string" ? { value: it } : it;
      if (!o || !o.value || seen.has(o.value)) continue;
      seen.add(o.value);
      out.push(o);
    }
    return out;
  }

  function open(input, all) {
    ensureMenu();
    const c = input._aprsCombo;
    if (!c) return;
    if (cur && cur !== c) close();
    cur = c;
    const items = itemsFor(c);
    const v = norm(input.value);
    c.all = !!all;
    c.items = all || !v ? items : items.filter((o) => norm(o.value).includes(v) || norm(o.label).includes(v));
    // current value highlighted (show-all); while typing nothing is pre-picked
    // so Enter keeps the free text unless the user arrows to an option
    c.hi = c.items.findIndex((o) => norm(o.value) === v);
    if (!c.items.length) {
      menu.hidden = true;
      c.wrap.classList.remove("open");
      return;
    }
    render();
    menu.hidden = false;
    c.wrap.classList.add("open");
    input.setAttribute("aria-expanded", "true");
    place();
    scrollHi();
    if (!c.raf) {
      const follow = () => {
        if (cur !== c) return (c.raf = 0);
        place();
        c.raf = requestAnimationFrame(follow);
      };
      c.raf = requestAnimationFrame(follow);
    }
  }
  function close() {
    if (!cur) return;
    const c = cur;
    cur = null;
    if (c.raf) cancelAnimationFrame(c.raf);
    c.raf = 0;
    c.wrap.classList.remove("open");
    c.input.setAttribute("aria-expanded", "false");
    if (menu) menu.hidden = true;
  }
  function render() {
    const c = cur;
    const v = norm(c.input.value);
    menu.innerHTML = c.items
      .map(
        (o, i) =>
          '<div class="aprs-combo-opt' + (i === c.hi ? " hi" : "") + (norm(o.value) === v ? " cur" : "") + '" role="option" data-i="' + i + '"' +
          (i === c.hi ? ' aria-selected="true"' : "") + (o.title ? ' title="' + esc(o.title) + '"' : "") + ">" +
          '<span class="aprs-combo-v">' + esc(o.value) + "</span>" +
          (o.label ? '<span class="aprs-combo-l">' + esc(o.label) + "</span>" : "") +
          "</div>",
      )
      .join("");
  }
  function scrollHi() {
    const el = cur && cur.hi >= 0 ? menu.querySelector('[data-i="' + cur.hi + '"]') : null;
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
  }
  /** Directly under the field, same width, inside the viewport. */
  function place() {
    const c = cur;
    if (!c) return;
    const r = c.wrap.getBoundingClientRect();
    // field hidden (window minimised / closed / For row hidden): close
    if (!r.width || !r.height || !c.input.offsetParent) return close();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 4;
    const w = Math.min(Math.max(r.width, 120), vw - 2 * pad);
    const left = Math.max(pad, Math.min(vw - w - pad, r.left));
    const below = vh - r.bottom - pad - 2;
    const above = r.top - pad - 2;
    const want = Math.min(260, menu.scrollHeight + 2);
    const up = below < Math.min(want, 120) && above > below;
    const maxH = Math.max(40, Math.min(260, up ? above : below));
    const s = menu.style;
    s.left = left + "px";
    s.width = w + "px";
    s.maxHeight = maxH + "px";
    if (up) {
      s.top = "";
      s.bottom = vh - r.top + 2 + "px";
    } else {
      s.bottom = "";
      s.top = r.bottom + 2 + "px";
    }
  }
  function pick(o) {
    const c = cur;
    if (!c || !o) return close();
    const input = c.input;
    close();
    input.value = o.value;
    c.squelch = true;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    c.squelch = false;
    if (document.activeElement !== input) {
      c.skipFocus = true;
      input.focus();
      c.skipFocus = false;
    }
  }

  function attach(input, opts) {
    if (!input || input._aprsCombo) return input && input._aprsCombo;
    input.removeAttribute("list");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    const wrap = document.createElement("span");
    wrap.className = "aprs-combo";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "aprs-combo-btn";
    btn.tabIndex = -1;
    btn.setAttribute("aria-label", "Show all " + ((opts && opts.title) || "choices"));
    btn.title = "Show all " + ((opts && opts.title) || "choices");
    btn.innerHTML = "&#9662;";
    wrap.appendChild(btn);
    const c = { input, wrap, btn, opts: opts || {}, items: [], hi: -1, raf: 0, squelch: false };
    input._aprsCombo = c;

    btn.addEventListener("mousedown", (e) => e.preventDefault()); // keep / take focus ourselves
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (cur === c && !menu.hidden) return close();
      if (document.activeElement !== input) {
        c.skipFocus = true;
        input.focus();
        c.skipFocus = false;
      }
      open(input, true);
    });
    input.addEventListener("focus", () => {
      if (!c.skipFocus) open(input, true);
    });
    input.addEventListener("click", () => {
      if (cur !== c || menu.hidden) open(input, true);
    });
    input.addEventListener("input", () => {
      if (!c.squelch) open(input, false);
    });
    input.addEventListener("blur", () => {
      if (cur === c) close();
    });
    input.addEventListener("keydown", (e) => {
      const isOpen = cur === c && menu && !menu.hidden;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!isOpen) return open(input, true);
        const n = c.items.length;
        if (!n) return;
        c.hi = e.key === "ArrowDown" ? (c.hi + 1) % n : c.hi <= 0 ? n - 1 : c.hi - 1;
        render();
        scrollHi();
      } else if (e.key === "Enter") {
        if (isOpen && c.hi >= 0 && c.items[c.hi]) {
          e.preventDefault();
          e.stopPropagation();
          pick(c.items[c.hi]);
        } else if (isOpen) close();
      } else if (e.key === "Escape") {
        if (isOpen) {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      } else if (e.key === "Tab") close();
    });
    return c;
  }

  window.aprsCombo = { attach, close, isOpen: () => !!cur && !!menu && !menu.hidden };
})();
