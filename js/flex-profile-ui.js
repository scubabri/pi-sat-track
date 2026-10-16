/**
 * Flex SmartSDR global profile dropdown — own row above Uplink.
 * Always visible. Greyed/disabled for non-Flex radios or when API is down
 * (same idea as CW greyed on FM). Blank = "(no change)".
 */
(function () {
  let supported = false;
  let apiConnected = false;
  let profiles = [];
  let selected = "";
  let applying = false;

  function el() {
    return document.getElementById("flex-profile-select");
  }

  function rebuildOptions() {
    const sel = el();
    if (!sel) return;
    const want = selected || "";
    const names = Array.isArray(profiles) ? profiles.slice() : [];
    if (want && names.indexOf(want) < 0) names.unshift(want);
    sel.innerHTML = "";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "(no change)";
    sel.appendChild(blank);
    for (const n of names) {
      const opt = document.createElement("option");
      opt.value = n;
      opt.textContent = n;
      sel.appendChild(opt);
    }
    sel.value = want;
    if (sel.value !== want && want) sel.value = "";
  }

  function updateUi() {
    const sel = el();
    if (!sel) return;
    // Always shown; greyed when not Flex or API not connected
    sel.hidden = false;
    const hasList = Array.isArray(profiles) && profiles.length > 0;
    const disable = !supported || !apiConnected;
    sel.disabled = disable;
    sel.title = !supported
      ? "Flex Profile — only for SmartSDR / AetherSDR"
      : !apiConnected
        ? "Waiting for Flex radio API (LAN IP:4992)…"
        : !hasList
          ? "Connected — waiting for profile list…"
          : selected
            ? 'SmartSDR global profile: "' + selected + '" — blank = no change'
            : "SmartSDR global profile for this satellite (blank = no change)";
    rebuildOptions();
  }

  function send(name) {
    selected = name == null ? "" : String(name);
    updateUi();
    if (typeof ws !== "undefined" && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "flexProfile", name: selected }));
    }
  }

  function applyFromMsg(msg) {
    if (!msg) return;
    let changed = false;
    if (typeof msg.flexProfilesSupported === "boolean") {
      if (supported !== msg.flexProfilesSupported) changed = true;
      supported = msg.flexProfilesSupported;
    } else if (typeof msg.supportsFlexProfiles === "boolean") {
      if (supported !== msg.supportsFlexProfiles) changed = true;
      supported = msg.supportsFlexProfiles;
    }
    if (typeof msg.apiConnected === "boolean") {
      if (apiConnected !== msg.apiConnected) changed = true;
      apiConnected = msg.apiConnected;
    }
    if (Array.isArray(msg.flexProfiles)) {
      const a = msg.flexProfiles.join("\0");
      const b = profiles.join("\0");
      if (a !== b) changed = true;
      profiles = msg.flexProfiles.slice();
    }
    if (typeof msg.flexProfile === "string") {
      if (selected !== msg.flexProfile) changed = true;
      selected = msg.flexProfile;
    }
    if (changed) updateUi();
  }

  window.applyFlexProfileFromTick = applyFromMsg;

  function patchWs() {
    if (typeof ws === "undefined" || !ws || ws.__flexProfilePatched) return;
    const prev = ws.onmessage;
    ws.onmessage = function (ev) {
      if (typeof prev === "function") prev.call(this, ev);
      try {
        const msg = JSON.parse(ev.data);
        if (
          msg.type === "tick" ||
          msg.type === "state" ||
          msg.type === "flex" ||
          msg.type === "icom"
        ) {
          applying = true;
          applyFromMsg(msg);
          applying = false;
        }
      } catch (_) {}
    };
    ws.__flexProfilePatched = true;
  }

  function init() {
    const sel = el();
    if (sel) {
      sel.addEventListener("change", () => {
        if (applying) return;
        send(sel.value);
      });
    }
    updateUi();
    setInterval(patchWs, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
