/**
 * Shared chrome for the floating APRS windows (js/aprs-overlay.js station
 * window, js/aprs-window.js messages window): draggable by the header,
 * minimise, close, position + open state kept in localStorage.
 *
 *   const w = aprsFloat.create({ id, title, lsKey, headHtml, defaultX, defaultY, label });
 *   w.el / w.head / w.body / w.st (persisted state; extra keys allowed)
 *   w.open() w.close() w.toggle() w.isOpen() w.save() w.onChange(fn)
 */
(function () {
  let zTop = 1200;
  function create(o) {
    const st = { open: false, min: false, x: null, y: null };
    try {
      Object.assign(st, JSON.parse(localStorage.getItem(o.lsKey) || "{}"));
    } catch (_) {}
    const listeners = [];
    const el = document.createElement("div");
    el.id = o.id;
    el.className = "aprs-window " + (o.cls || "");
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", o.label || o.title);
    el.innerHTML =
      '<div class="aprs-win-head"><span class="aprs-win-title">' + o.title + "</span>" + (o.headHtml || "") +
      '<button type="button" class="aprs-win-btn aprs-win-min" title="Minimise" aria-label="Minimise">&#8211;</button>' +
      '<button type="button" class="aprs-win-btn aprs-win-close" title="Close" aria-label="Close">&#215;</button></div>' +
      '<div class="aprs-win-body"></div>';
    el.hidden = true;
    document.body.appendChild(el);
    const head = el.querySelector(".aprs-win-head");
    const body = el.querySelector(".aprs-win-body");
    const save = () => {
      try {
        localStorage.setItem(o.lsKey, JSON.stringify(st));
      } catch (_) {}
    };
    const fire = () => listeners.forEach((fn) => fn(st));
    function place() {
      const w = el.offsetWidth || o.width || 360;
      let x = st.x != null ? st.x : typeof o.defaultX === "function" ? o.defaultX(w) : o.defaultX || 80;
      let y = st.y != null ? st.y : o.defaultY || 90;
      x = Math.max(0, Math.min(window.innerWidth - Math.min(w, 120), x));
      y = Math.max(0, Math.min(window.innerHeight - 32, y));
      el.style.left = x + "px";
      el.style.top = y + "px";
    }
    function front() {
      el.style.zIndex = String(++zTop);
    }
    function sync() {
      el.hidden = !st.open;
      el.classList.toggle("min", !!st.min);
      if (st.open) place();
    }
    function open() {
      st.open = true;
      st.min = false;
      save();
      sync();
      front();
      fire();
    }
    function close() {
      st.open = false;
      save();
      sync();
      fire();
    }
    head.querySelector(".aprs-win-close").addEventListener("click", close);
    head.querySelector(".aprs-win-min").addEventListener("click", () => {
      st.min = !st.min;
      save();
      sync();
      fire();
    });
    el.addEventListener("pointerdown", front, true);
    let sx = 0, sy = 0, ox = 0, oy = 0, drag = false;
    head.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button, input, select, a")) return;
      drag = true;
      sx = e.clientX;
      sy = e.clientY;
      ox = el.offsetLeft;
      oy = el.offsetTop;
      head.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    head.addEventListener("pointermove", (e) => {
      if (!drag) return;
      st.x = ox + e.clientX - sx;
      st.y = oy + e.clientY - sy;
      place();
    });
    const end = () => {
      if (!drag) return;
      drag = false;
      st.x = el.offsetLeft;
      st.y = el.offsetTop;
      save();
    };
    head.addEventListener("pointerup", end);
    head.addEventListener("pointercancel", end);
    window.addEventListener("resize", () => st.open && place());
    // Keys typed in the windows must not reach map / app shortcuts.
    ["keydown", "keyup", "keypress"].forEach((ev) => el.addEventListener(ev, (e) => e.stopPropagation()));
    sync();
    return {
      el,
      head,
      body,
      st,
      open,
      close,
      toggle: () => (st.open && !st.min ? close() : open()),
      isOpen: () => !!st.open,
      save,
      place,
      sync,
      onChange: (fn) => listeners.push(fn),
    };
  }
  window.aprsFloat = { create };
})();
