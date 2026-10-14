/* Collapsible sidebar sections: click the header to toggle; state kept in localStorage. */
(function () {
  document.querySelectorAll(".panel-section.collapsible").forEach((sec) => {
    const key = "collapse:" + (sec.dataset.collapseKey || "");
    const head = sec.querySelector(".collapse-head");
    if (!head) return;
    if (localStorage.getItem(key) === "1") sec.classList.add("collapsed");
    head.addEventListener("click", () => {
      const c = sec.classList.toggle("collapsed");
      localStorage.setItem(key, c ? "1" : "0");
    });
  });
})();
