/**
 * Config panel connection test buttons (radio UL/DL + rotor).
 * Uses event delegation on #config-panel so clicks work even if
 * init ran before buttons existed / panel was re-rendered.
 */
function setTestButtonState(btn, state, title) {
  if (!btn) return;
  btn.classList.remove("test-ok", "test-fail", "test-busy");
  btn.disabled = state === "busy";
  if (state === "ok") btn.classList.add("test-ok");
  if (state === "fail") btn.classList.add("test-fail");
  if (state === "busy") btn.classList.add("test-busy");
  if (title != null && title !== "") btn.title = String(title);
  if (state === "idle") {
    btn.textContent = btn.dataset.label || "Test";
  } else if (state === "busy") {
    btn.textContent = "Testing…";
  } else if (state === "ok") {
    btn.textContent = "OK";
  } else if (state === "fail") {
    btn.textContent = "Fail";
  }
}

function getTrackerWs() {
  if (typeof ws !== "undefined" && ws && ws.readyState === WebSocket.OPEN) {
    return ws;
  }
  return null;
}

function sendConnectionTest(payload) {
  const sock = getTrackerWs();
  if (!sock) {
    throw new Error(
      "Not connected to server (WebSocket). Wait for live status, then retry.",
    );
  }
  sock.send(JSON.stringify(payload));
  console.log("[connection-test] sent", payload.type, payload);
}

function sideConfigFromForm(side) {
  if (typeof readSide === "function") return readSide(side);
  return {};
}

function rotorConfigFromForm() {
  const type =
    typeof val === "function" ? val("cfg-rotor-type") || "rt21" : "rt21";
  const info =
    typeof findRotorDriver === "function" ? findRotorDriver(type) : null;
  const ports = info && info.ports != null ? info.ports : 2;
  const azOnly =
    typeof isRotorAzOnlyChecked === "function" ? isRotorAzOnlyChecked() : false;
  const readDev =
    typeof readSerialDeviceField === "function"
      ? readSerialDeviceField
      : function (id) {
          const el = document.getElementById(id);
          return el ? String(el.value || "").trim() : "";
        };
  let az = "";
  let el = "";
  if (ports === 1) {
    az = readDev("cfg-rotor-device") || "/dev/ttyACM0";
    el = az;
  } else {
    az = readDev("cfg-rotor-az-device") || "/dev/ttyUSB0";
    el = readDev("cfg-rotor-el-device") || "/dev/ttyUSB1";
  }
  const baudEl = document.getElementById("cfg-rotor-baud");
  const baud = baudEl ? parseInt(baudEl.value, 10) || 4800 : 4800;
  return {
    rotorType: type,
    rotorAzDevice: az,
    rotorElDevice: el,
    rotorBaud: baud,
    rotorAzOnly: azOnly,
  };
}

function runRadioTest(side) {
  const btn = document.getElementById("btn-test-radio-" + side);
  if (!btn) {
    console.warn("[connection-test] missing button btn-test-radio-" + side);
    return;
  }
  if (!btn.dataset.label) btn.dataset.label = "Test " + side.toUpperCase();
  setTestButtonState(btn, "busy");
  try {
    const cfg = sideConfigFromForm(side);
    console.log("[connection-test] radio", side, cfg);
    sendConnectionTest({ type: "test-radio", side: side, radio: cfg });
  } catch (e) {
    console.warn("[connection-test]", e);
    setTestButtonState(btn, "fail", e.message || String(e));
  }
}

function runRotorTest() {
  const btn = document.getElementById("btn-test-rotor");
  if (!btn) return;
  if (!btn.dataset.label) btn.dataset.label = "Test rotor";
  setTestButtonState(btn, "busy");
  try {
    const cfg = rotorConfigFromForm();
    console.log("[connection-test] rotor", cfg);
    sendConnectionTest({ type: "test-rotor", rotor: cfg });
  } catch (e) {
    console.warn("[connection-test]", e);
    setTestButtonState(btn, "fail", e.message || String(e));
  }
}

function applyTestResult(msg) {
  if (!msg || msg.type !== "test-result") return;
  console.log("[connection-test] result", msg);
  let btn = null;
  if (msg.target === "radio-ul")
    btn = document.getElementById("btn-test-radio-ul");
  else if (msg.target === "radio-dl")
    btn = document.getElementById("btn-test-radio-dl");
  else if (msg.target === "rotor")
    btn = document.getElementById("btn-test-rotor");
  if (!btn) {
    console.warn("[connection-test] no button for target", msg.target);
    return;
  }
  const tip =
    (msg.message || "") + (msg.detail ? " " + JSON.stringify(msg.detail) : "");
  setTestButtonState(btn, msg.ok ? "ok" : "fail", tip);
  setTimeout(() => {
    if (
      btn.classList.contains("test-ok") ||
      btn.classList.contains("test-fail")
    ) {
      btn.textContent = btn.dataset.label || "Test";
    }
  }, 5000);
}

let connectionTestsBound = false;

function initConnectionTests() {
  const panel = document.getElementById("config-panel");
  if (!panel) {
    console.warn("[connection-test] #config-panel not found");
    return;
  }
  ["btn-test-radio-ul", "btn-test-radio-dl", "btn-test-rotor"].forEach((id) => {
    const b = document.getElementById(id);
    if (b && !b.dataset.label) {
      b.dataset.label = (b.textContent || "Test").trim();
    }
  });

  if (connectionTestsBound) return;
  connectionTestsBound = true;

  // Delegation: survives re-renders and avoids missed listeners
  panel.addEventListener("click", (e) => {
    const t =
      e.target && e.target.closest ? e.target.closest("button.btn-test") : null;
    if (!t || !panel.contains(t)) return;
    e.preventDefault();
    e.stopPropagation();

    if (t.id === "btn-test-radio-ul") {
      runRadioTest("ul");
      return;
    }
    if (t.id === "btn-test-radio-dl") {
      runRadioTest("dl");
      return;
    }
    if (t.id === "btn-test-rotor") {
      if (
        !confirm(
          "Rotor test will read position, move about 10°, then return.\n" +
            "Clear of obstacles? Antenna tracking should be OFF.",
        )
      ) {
        return;
      }
      runRotorTest();
    }
  });

  console.log("[connection-test] handlers bound on #config-panel");
}
