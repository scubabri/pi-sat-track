/**
 * Shared chrome for the floating APRS windows (js/aprs-overlay.js station
 * window, js/aprs-window.js messages window): draggable by the header,
 * minimise, close, position + open state kept in localStorage.
 *
 *   const w = aprsFloat.create({ id, title, lsKey, headHtml, defaultX, defaultY, label,
 *                                 minW, minH, resizable });
 * Resizable from the left / right / bottom edges and both bottom corners;
 * size (w, h) is saved with the position and clamped to the viewport.
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
      '<div class="aprs-win-body"></div>' +
      (o.resizable === false ? "" : ["e", "w", "s", "se", "sw"].map((d) => '<div class="aprs-rz aprs-rz-' + d + '" data-rz="' + d + '" aria-hidden="true"></div>').join(""));
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
    const minW = o.minW || 220;
    const minH = o.minH || 160;
    function applySize() {
      if (st.w) el.style.width = Math.max(minW, Math.min(window.innerWidth - 16, st.w)) + "px";
      if (st.h && !st.min) {
        el.style.height = Math.max(minH, Math.min(window.innerHeight - 16, st.h)) + "px";
        el.classList.add("sized");
      } else {
        el.style.height = "";
        el.classList.remove("sized");
      }
    }
    function place() {
      applySize();
      const w = el.offsetWidth || o.width || 360;
      let x = st.x != null ? st.x : typeof o.defaultX === "function" ? o.defaultX(w) : o.defaultX || 80;
      let y = st.y != null ? st.y : o.defaultY || 90;
      const h = el.offsetHeight || 32;
      // keep the whole window on-screen (also after the viewport shrinks)
      x = Math.max(0, Math.min(window.innerWidth - w, x));
      y = Math.max(0, Math.min(window.innerHeight - h, y));
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
      else applySize();
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
    // Edge / corner resize
    el.querySelectorAll("[data-rz]").forEach((h) => {
      let rz = null;
      h.addEventListener("pointerdown", (e) => {
        rz = { d: h.dataset.rz, sx: e.clientX, sy: e.clientY, x: el.offsetLeft, w: el.offsetWidth, h: el.offsetHeight };
        h.setPointerCapture(e.pointerId);
        e.preventDefault();
        e.stopPropagation();
      });
      h.addEventListener("pointermove", (e) => {
        if (!rz) return;
        const dx = e.clientX - rz.sx;
        const dy = e.clientY - rz.sy;
        if (rz.d.includes("e")) st.w = Math.max(minW, rz.w + dx);
        if (rz.d.includes("w")) {
          const nw = Math.max(minW, rz.w - dx);
          st.x = rz.x + (rz.w - nw);
          st.w = nw;
        }
        if (rz.d.includes("s")) st.h = Math.max(minH, rz.h + dy);
        st.min = false;
        el.classList.remove("min");
        place();
      });
      const done = () => {
        if (!rz) return;
        rz = null;
        st.x = el.offsetLeft;
        st.y = el.offsetTop;
        save();
        fire();
      };
      h.addEventListener("pointerup", done);
      h.addEventListener("pointercancel", done);
    });
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
