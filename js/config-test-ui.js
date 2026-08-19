/**
 * Config panel connection test buttons (radio UL/DL + rotor).
 * Rotor test is guided: open session → read → confirm → nudge → confirm →
 * return → close session, per axis (holds serial port open between steps).
 * Live gauge/radar updates during the test; state ticks are suppressed.
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

/** Live rotor gauge + radar during guided test */
let testLastAz = null;
let testLastEl = null;

function showTestPosition(axis, pos) {
  if (pos == null || !Number.isFinite(Number(pos))) return;
  const v = Number(pos);
  if (axis === "az") testLastAz = v;
  else if (axis === "el") testLastEl = v;

  window.rotorTestActive = true;
  window.rotorTestAz = testLastAz;
  window.rotorTestEl = testLastEl;

  // Only rotor gauges — do not touch the satellite pass radar
  if (typeof updateRotorGauges === "function") {
    updateRotorGauges(testLastAz, testLastEl, null, null, false);
  }
  const azEl = document.getElementById("rotor-az");
  const elEl = document.getElementById("rotor-el");
  if (azEl && testLastAz != null) {
    azEl.textContent = testLastAz.toFixed(1) + "\u00B0";
  }
  if (elEl && testLastEl != null) {
    elEl.textContent = testLastEl.toFixed(1) + "\u00B0";
  }
}

/** Let the browser paint gauges before a blocking confirm() */
function paintThenConfirm(message) {
  return new Promise(function (resolve) {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        setTimeout(function () {
          resolve(window.confirm(message));
        }, 80);
      });
    });
  });
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
  const stopS = document.getElementById("cfg-rotor-az-stop-s");
  const rotorAzStop = stopS && stopS.checked ? "south" : "north";
  return {
    rotorType: type,
    rotorAzDevice: az,
    rotorElDevice: el,
    rotorBaud: baud,
    rotorAzOnly: azOnly,
    rotorAzStop: rotorAzStop,
  };
}

const pendingRotorTests = new Map();
let rotorReqSeq = 1;

function sendRotorStep(payload) {
  return new Promise(function (resolve, reject) {
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
    const timer = setTimeout(function () {
      pendingRotorTests.delete(id);
      reject(new Error("Rotor step timed out"));
    }, 30000);
    pendingRotorTests.set(id, {
      resolve: function (msg) {
        clearTimeout(timer);
        resolve(msg);
      },
      reject: function (err) {
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

function radioConfirmMessage(msg) {
  const d = msg.detail || {};
  const lines = [];
  const side =
    msg.target === "radio-dl"
      ? "DL (RX)"
      : msg.target === "radio-ul"
        ? "UL (TX)"
        : "Radio";
  lines.push(side + " connection test");
  lines.push("");
  if (d.freqMHz) {
    lines.push("Frequency: " + d.freqMHz + " MHz");
  }
  if (d.mode) {
    lines.push("Mode: " + d.mode);
  }
  if (d.device) {
    lines.push("Device: " + d.device);
  }
  if (d.endpoint) {
    lines.push("Endpoint: " + d.endpoint);
  }
  if (!d.freqMHz && !d.mode && msg.message) {
    lines.push(msg.message);
  }
  lines.push("");
  lines.push("Does this match the radio display?");
  return lines.join("\n");
}

function applyTestResult(msg) {
  if (!msg) return;

  // Live motion samples while nudge/goto is in progress
  if (msg.type === "test-rotor-progress" && msg.pos != null) {
    const axis = msg.axis === "el" ? "el" : "az";
    showTestPosition(axis, msg.pos);
    return;
  }

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

  // Radio success → confirm frequency/mode with user
  if (msg.ok && (msg.target === "radio-ul" || msg.target === "radio-dl")) {
    setTestButtonState(btn, "busy", tip);
    paintThenConfirm(radioConfirmMessage(msg)).then(function (yes) {
      if (yes) {
        setTestButtonState(btn, "ok", tip);
      } else {
        setTestButtonState(
          btn,
          "fail",
          "User rejected reading — check device/baud/CAT",
        );
      }
      setTimeout(function () {
        if (
          btn.classList.contains("test-ok") ||
          btn.classList.contains("test-fail")
        ) {
          btn.textContent = btn.dataset.label || "Test";
        }
      }, 5000);
    });
    return;
  }

  setTestButtonState(btn, msg.ok ? "ok" : "fail", tip);
  setTimeout(function () {
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
 * Guided rotor test with held serial session per axis.
 * Gauges/radar update before each confirm so the user can verify visually.
 */
async function runRotorTestGuided() {
  const btn = document.getElementById("btn-test-rotor");
  if (!btn) return;
  if (!btn.dataset.label) btn.dataset.label = "Test rotator";

  if (
    !(await paintThenConfirm(
      "Rotor guided test.\n\n" +
        "Antenna tracking should be OFF.\n" +
        "Watch the rotator and the AZ/EL gauges — you will confirm each reading.\n\n" +
        "Continue?",
    ))
  ) {
    return;
  }

  setTestButtonState(btn, "busy");
  testLastAz = null;
  testLastEl = null;
  window.rotorTestActive = true;
  window.rotorTestAz = null;
  window.rotorTestEl = null;
  const base = rotorConfigFromForm();

  async function axisSequence(axis) {
    const label = axis.toUpperCase();
    setTestButtonState(btn, "busy", "Opening " + label + " port…");

    const opened = await sendRotorStep(
      Object.assign({}, base, { action: "open", axis: axis }),
    );
    if (!opened.ok) {
      throw new Error(opened.message || label + " open failed");
    }

    try {
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
      showTestPosition(axis, pos0);

      if (
        !(await paintThenConfirm(
          label +
            " reads " +
            Math.round(pos0) +
            "° on " +
            ((read.detail && read.detail.device) || "?") +
            ".\n\nGauges should show this value.\nDoes that match the rotator / controller display?",
        ))
      ) {
        throw new Error(label + " read rejected by user");
      }

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
      if (pos1 != null) showTestPosition(axis, pos1);
      else if (nudge.detail && nudge.detail.target != null)
        showTestPosition(axis, nudge.detail.target);

      if (
        !(await paintThenConfirm(
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
        ))
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
      if (back.detail && back.detail.pos != null)
        showTestPosition(axis, back.detail.pos);
      else showTestPosition(axis, pos0);

      if (
        !(await paintThenConfirm(
          label +
            " returned toward " +
            Math.round(pos0) +
            "°.\n\nLooks correct?",
        ))
      ) {
        throw new Error(label + " return rejected by user");
      }
    } finally {
      try {
        await sendRotorStep(
          Object.assign({}, base, { action: "close", axis: axis }),
        );
      } catch (e) {
        console.warn("[connection-test] session close", e);
      }
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
  } finally {
    window.rotorTestActive = false;
  }
  setTimeout(function () {
    if (
      btn.classList.contains("test-ok") ||
      btn.classList.contains("test-fail")
    ) {
      btn.textContent = btn.dataset.label || "Test rotator";
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
  ["btn-test-radio-ul", "btn-test-radio-dl", "btn-test-rotor"].forEach(
    function (id) {
      const b = document.getElementById(id);
      if (b && !b.dataset.label) {
        b.dataset.label = (b.textContent || "Test").trim();
      }
    },
  );

  if (connectionTestsBound) return;
  connectionTestsBound = true;

  panel.addEventListener("click", function (e) {
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
      if (
        typeof isSingleRadioChecked === "function" &&
        isSingleRadioChecked()
      ) {
        return; // hidden in single-radio mode
      }
      runRadioTest("dl");
      return;
    }
    if (t.id === "btn-test-rotor") {
      runRotorTestGuided();
    }
  });

  console.log("[connection-test] handlers bound on #config-panel");
}
