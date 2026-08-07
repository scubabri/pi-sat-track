/**
 * Config panel connection test buttons (radio UL/DL + rotor).
 * Rotor test is guided: read → confirm → nudge → confirm → return, per axis.
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

/** Pending rotor step resolvers keyed by request id */
const pendingRotorTests = new Map();
let rotorReqSeq = 1;

function sendRotorStep(payload) {
  return new Promise((resolve, reject) => {
    const sock = getTrackerWs();
    if (!sock) {
      reject(
        new Error(
          "Not connected to server (WebSocket). Wait for live status, then retry.",
        ),
      );
      return;
    }
    const id = "rt" + rotorReqSeq++;
    const timer = setTimeout(() => {
      pendingRotorTests.delete(id);
      reject(new Error("Rotor step timed out"));
    }, 25000);
    pendingRotorTests.set(id, {
      resolve: (msg) => {
        clearTimeout(timer);
        resolve(msg);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    sock.send(
      JSON.stringify(
        Object.assign({}, payload, {
          type: "test-rotor-step",
          reqId: id,
        }),
      ),
    );
    console.log(
      "[connection-test] rotor step",
      payload.action,
      payload.axis,
      id,
    );
  });
}

function applyTestResult(msg) {
  if (!msg) return;

  // Step responses for guided rotor test
  if (msg.type === "test-rotor-step-result" && msg.reqId) {
    const pending = pendingRotorTests.get(msg.reqId);
    if (pending) {
      pendingRotorTests.delete(msg.reqId);
      pending.resolve(msg);
    }
    return;
  }

  if (msg.type !== "test-result") return;
  console.log("[connection-test] result", msg);
  let btn = null;
  if (msg.target === "radio-ul")
    btn = document.getElementById("btn-test-radio-ul");
  else if (msg.target === "radio-dl")
    btn = document.getElementById("btn-test-radio-dl");
  else if (msg.target === "rotor")
    btn = document.getElementById("btn-test-rotor");
  if (!btn) return;
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

function runRadioTest(side) {
  const btn = document.getElementById("btn-test-radio-" + side);
  if (!btn) return;
  if (!btn.dataset.label) btn.dataset.label = "Test " + side.toUpperCase();
  setTestButtonState(btn, "busy");
  try {
    const cfg = sideConfigFromForm(side);
    sendConnectionTest({ type: "test-radio", side: side, radio: cfg });
  } catch (e) {
    console.warn("[connection-test]", e);
    setTestButtonState(btn, "fail", e.message || String(e));
  }
}

/**
 * Guided rotor test:
 *  AZ: read → confirm → +10° → confirm → return
 *  EL: same (unless AZ-only)
 */
async function runRotorTestGuided() {
  const btn = document.getElementById("btn-test-rotor");
  if (!btn) return;
  if (!btn.dataset.label) btn.dataset.label = "Test rotor";

  if (
    !confirm(
      "Rotor guided test.\n\n" +
        "Antenna tracking should be OFF.\n" +
        "Watch the rotator — you will confirm each reading.\n\n" +
        "Continue?",
    )
  ) {
    return;
  }

  setTestButtonState(btn, "busy");
  const base = rotorConfigFromForm();

  async function axisSequence(axis) {
    const label = axis.toUpperCase();

    // 1) Read
    setTestButtonState(btn, "busy", "Reading " + label + "…");
    const read = await sendRotorStep(
      Object.assign({}, base, { action: "read", axis: axis }),
    );
    if (!read.ok) {
      throw new Error(read.message || label + " read failed");
    }
    const pos0 =
      read.detail && read.detail.pos != null ? read.detail.pos : null;
    if (pos0 == null) throw new Error(label + ": no position in reply");

    if (
      !confirm(
        label +
          " reads " +
          Math.round(pos0) +
          "°.\n\nDoes that match the rotator / controller display?",
      )
    ) {
      throw new Error(label + " read rejected by user");
    }

    // 2) Nudge +10
    setTestButtonState(btn, "busy", "Moving " + label + " +10°…");
    const nudge = await sendRotorStep(
      Object.assign({}, base, {
        action: "nudge",
        axis: axis,
        from: pos0,
        delta: 10,
      }),
    );
    if (!nudge.ok) {
      // try to return home
      try {
        await sendRotorStep(
          Object.assign({}, base, {
            action: "goto",
            axis: axis,
            degrees: pos0,
          }),
        );
      } catch (_) {}
      throw new Error(nudge.message || label + " nudge failed");
    }
    const pos1 =
      nudge.detail && nudge.detail.pos != null
        ? nudge.detail.pos
        : nudge.detail && nudge.detail.target;

    if (
      !confirm(
        label +
          " commanded +10° (target " +
          (nudge.detail && nudge.detail.target != null
            ? Math.round(nudge.detail.target)
            : "?") +
          "°).\n" +
          (pos1 != null
            ? "Controller now reads " + Math.round(pos1) + "°.\n\n"
            : "\n") +
          "Did the rotator move about 10° in the expected direction?",
      )
    ) {
      await sendRotorStep(
        Object.assign({}, base, {
          action: "goto",
          axis: axis,
          degrees: pos0,
        }),
      );
      throw new Error(label + " move rejected by user");
    }

    // 3) Return
    setTestButtonState(btn, "busy", "Returning " + label + "…");
    const back = await sendRotorStep(
      Object.assign({}, base, {
        action: "goto",
        axis: axis,
        degrees: pos0,
      }),
    );
    if (!back.ok) {
      throw new Error(back.message || label + " return failed");
    }
    if (
      !confirm(
        label + " returned toward " + Math.round(pos0) + "°.\n\nLooks correct?",
      )
    ) {
      throw new Error(label + " return rejected by user");
    }
  }

  try {
    await axisSequence("az");
    if (!base.rotorAzOnly) {
      await axisSequence("el");
    }
    setTestButtonState(
      btn,
      "ok",
      base.rotorAzOnly ? "AZ test OK" : "AZ + EL test OK",
    );
  } catch (e) {
    console.warn("[connection-test] rotor guided", e);
    setTestButtonState(btn, "fail", e.message || String(e));
  }
  setTimeout(() => {
    if (
      btn.classList.contains("test-ok") ||
      btn.classList.contains("test-fail")
    ) {
      btn.textContent = btn.dataset.label || "Test rotor";
    }
  }, 6000);
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
      runRotorTestGuided();
    }
  });

  console.log("[connection-test] handlers bound on #config-panel");
}
