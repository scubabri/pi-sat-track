/**
 * WSJT-X UDP listener: receives "QSO Logged" (5) / "Logged ADIF" (12) from
 * WSJT-X (pointed at this host's IP:port as its UDP Server), dedupes the
 * pair WSJT-X sends for one QSO, and hands one record per QSO to onQso().
 *
 * Binds unicast (no multicast membership). Datagrams carrying our own
 * client id are ignored so our multicast/loopback output can't echo.
 *
 * Protocol: https://raw.githubusercontent.com/WSJTX/wsjtx/master/Network/NetworkMessage.hpp
 */
const dgram = require("dgram");
const net = require("net");
const os = require("os");
const logbook = require("./logbook");
const lotw = require("./lotw-sats");

const WSJTX_MAGIC = 0xadbccbda;
const OWN_ID = logbook.UDP_CLIENT_ID;
/** Wait this long for a Logged ADIF (12) after a QSO Logged (5). */
const PAIR_WAIT_MS = 1500;
/** Remember forwarded QSOs this long to drop the late twin. */
const RECENT_MS = 30000;
const RETRY_MS = 15000;
/** Enrich QSOs logged up to this long after the sat dropped below 0°. */
const LOS_GRACE_MS = 120000;

/* ---------- QDataStream reader (big-endian, bounds-checked) ---------- */
function reader(buf) {
  let o = 0;
  const need = (n) => {
    if (o + n > buf.length) throw new Error("truncated");
  };
  return {
    remaining: () => buf.length - o,
    u8() {
      need(1);
      return buf.readUInt8(o++);
    },
    u32() {
      need(4);
      const v = buf.readUInt32BE(o);
      o += 4;
      return v;
    },
    i32() {
      need(4);
      const v = buf.readInt32BE(o);
      o += 4;
      return v;
    },
    i64() {
      need(8);
      const v = buf.readBigInt64BE(o);
      o += 8;
      return Number(v);
    },
    f64() {
      need(8);
      const v = buf.readDoubleBE(o);
      o += 8;
      return v;
    },
    bool() {
      return this.u8() !== 0;
    },
    u64() {
      need(8);
      const v = buf.readBigUInt64BE(o);
      o += 8;
      return Number(v);
    },
    utf8() {
      const n = this.u32();
      if (n === 0xffffffff) return null;
      need(n);
      const v = buf.toString("utf8", o, o + n);
      o += n;
      return v;
    },
    /** QDateTime -> Date (UTC); timespec 0/1 treated as UTC, 2 applies offset. */
    dateTime() {
      const jd = this.i64();
      const ms = this.u32();
      const spec = this.u8();
      let offsetSec = 0;
      if (spec === 2) offsetSec = this.i32();
      else if (spec === 3) throw new Error("QDateTime with time zone not supported");
      if (!jd || ms === 0xffffffff) return null; // null QDate/QTime
      const t = (jd - 2440588) * 86400000 + ms - offsetSec * 1000;
      return new Date(t);
    },
  };
}

/** WSJT-X mode name -> ADIF MODE/SUBMODE (ADIF 3.1.4). */
function wsjtxModeToAdif(m) {
  const s = String(m || "").trim().toUpperCase();
  if (!s) return { mode: "", submode: "" };
  if (/^(FT4|FST4|FST4W|Q65|JS8|FT2)$/.test(s)) return { mode: "MFSK", submode: s };
  return { mode: s, submode: "" };
}

/**
 * Decode one datagram header + supported payloads.
 * @returns {{type:number,schema:number,id:string,qso?:object,adif?:string}|null}
 */
function decodeDatagram(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  const r = reader(buf);
  if (r.u32() !== WSJTX_MAGIC) return null;
  const schema = r.u32();
  const type = r.u32();
  const id = r.utf8() || "";
  const out = { type, schema, id };
  if (type === 2) {
    out.decode = {
      isNew: r.bool(),
      timeMs: r.u32(),
      snr: r.i32(),
      dt: r.f64(),
      df: r.u32(),
      mode: r.utf8() || "",
      message: r.utf8() || "",
      lowConfidence: r.remaining() >= 1 ? r.bool() : false,
      offAir: r.remaining() >= 1 ? r.bool() : false,
    };
  } else if (type === 12) {
    out.adif = r.utf8() || "";
  } else if (type === 5) {
    const q = {};
    q.timeOff = r.dateTime();
    q.call = r.utf8() || "";
    q.grid = r.utf8() || "";
    q.txHz = r.u64();
    q.mode = r.utf8() || "";
    q.rptSent = r.utf8() || "";
    q.rptRcvd = r.utf8() || "";
    q.txPower = r.utf8() || "";
    q.comments = r.utf8() || "";
    q.name = r.utf8() || "";
    q.timeOn = r.dateTime();
    const opt = () => (r.remaining() >= 4 ? r.utf8() || "" : "");
    q.operator = opt();
    q.myCall = opt();
    q.myGrid = opt();
    q.exchSent = opt();
    q.exchRcvd = opt();
    q.propMode = opt();
    out.qso = q;
  }
  return out;
}

/** QSO Logged payload -> ADIF field map. */
function qsoToFields(q) {
  const f = {};
  const on = q.timeOn || q.timeOff || new Date();
  const off = q.timeOff || on;
  const { mode, submode } = wsjtxModeToAdif(q.mode);
  const put = (k, v) => {
    if (v != null && String(v).trim() !== "") f[k] = String(v).trim();
  };
  put("CALL", String(q.call || "").toUpperCase());
  put("GRIDSQUARE", q.grid);
  put("QSO_DATE", logbook.adifDate(on));
  put("TIME_ON", logbook.adifTime(on));
  put("QSO_DATE_OFF", logbook.adifDate(off));
  put("TIME_OFF", logbook.adifTime(off));
  if (q.txHz > 0) {
    put("FREQ", logbook.mhzStr(q.txHz));
    put("BAND", logbook.bandForMHz(q.txHz / 1e6));
  }
  put("MODE", mode);
  put("SUBMODE", submode);
  put("RST_SENT", q.rptSent);
  put("RST_RCVD", q.rptRcvd);
  put("TX_PWR", q.txPower);
  put("COMMENT", q.comments);
  put("NAME", q.name);
  put("OPERATOR", String(q.operator || "").toUpperCase());
  put("STATION_CALLSIGN", String(q.myCall || "").toUpperCase());
  put("MY_GRIDSQUARE", q.myGrid);
  put("STX_STRING", q.exchSent);
  put("SRX_STRING", q.exchRcvd);
  put("PROP_MODE", q.propMode);
  return f;
}

/**
 * Parse ADIF text into records (field names uppercased). Lengths are
 * counted in bytes of the UTF-8 text.
 */
function parseAdif(text) {
  const buf = Buffer.from(String(text || ""), "utf8");
  const s = buf.toString("latin1"); // 1 char per byte for length math
  let i = 0;
  const eoh = s.search(/<eoh>/i);
  if (eoh >= 0) i = eoh + 5;
  const recs = [];
  let cur = {};
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) break;
    const gt = s.indexOf(">", lt);
    if (gt < 0) break;
    const tag = s.slice(lt + 1, gt);
    i = gt + 1;
    const parts = tag.split(":");
    const name = parts[0].trim().toUpperCase();
    if (name === "EOR") {
      if (Object.keys(cur).length) recs.push(cur);
      cur = {};
      continue;
    }
    if (parts.length < 2) continue;
    const len = parseInt(parts[1], 10);
    if (!Number.isFinite(len) || len < 0) continue;
    const raw = Buffer.from(s.slice(i, i + len), "latin1").toString("utf8");
    i += len;
    if (name) cur[name] = raw;
  }
  if (Object.keys(cur).length && cur.CALL) recs.push(cur);
  return recs;
}

function qsoKey(f) {
  return [
    String(f.CALL || "").toUpperCase(),
    String(f.QSO_DATE || ""),
    String(f.TIME_ON || "").slice(0, 4),
  ].join("|");
}

/**
 * Add satellite info to a WSJT-X record.
 * @param {object} fields  ADIF fields from WSJT-X
 * @param {object|null} ctx state.getLogContext()
 * @param {{callsign?:string,grid?:string}} station
 * @param {{now?:Date, graceMs?:number}} [opts]
 * @returns {{fields:object, enriched:boolean, note:string, warnings:string[], txHz:number, rxHz:number|null, lotwAccepted?:boolean}}
 */
function enrichRecord(fields, ctx, station, opts) {
  const o = opts || {};
  const now = o.now instanceof Date ? o.now : new Date();
  const grace = o.graceMs != null ? o.graceMs : LOS_GRACE_MS;
  const f = Object.assign({}, fields);
  const warnings = [];
  const freqHz = () => {
    const m = parseFloat(f.FREQ);
    return Number.isFinite(m) ? Math.round(m * 1e6) : 0;
  };
  const rxHzOf = () => {
    const m = parseFloat(f.FREQ_RX);
    return Number.isFinite(m) ? Math.round(m * 1e6) : null;
  };
  const pass = (note) => ({
    fields: f,
    enriched: false,
    note,
    warnings,
    txHz: freqHz(),
    rxHz: rxHzOf(),
  });

  if (!ctx || !ctx.satKey) return pass("no satellite selected - forwarded unchanged");
  const el = Number.isFinite(ctx.el) ? ctx.el : null;
  const above =
    (el != null && el > 0) ||
    (ctx.lastAboveMs > 0 && now.getTime() - ctx.lastAboveMs <= grace);
  if (!above) {
    return pass(
      (ctx.satName || ctx.satKey) +
        " below horizon" +
        (el != null ? " (el " + el.toFixed(1) + "\u00b0)" : "") +
        " - forwarded unchanged",
    );
  }

  const sat = lotw.resolveSatName(
    {
      display: ctx.satName,
      name: ctx.satFullName,
      key: ctx.satKey,
      norad: ctx.norad,
    },
    logbook.adifDateTime(f.QSO_DATE, f.TIME_ON) || now,
  );
  if (sat.warning) warnings.push(sat.warning);
  f.PROP_MODE = "SAT";
  f.SAT_NAME = sat.satName;

  const ul = Number.isFinite(ctx.ulHz) && ctx.ulHz > 0 ? ctx.ulHz : null;
  const dl = Number.isFinite(ctx.dlHz) && ctx.dlHz > 0 ? ctx.dlHz : null;
  if (ul || dl) {
    const tx = ul || dl;
    f.FREQ = logbook.mhzStr(tx);
    f.BAND = logbook.bandForMHz(tx / 1e6) || f.BAND || "";
    if (dl) {
      f.FREQ_RX = logbook.mhzStr(dl);
      f.BAND_RX = logbook.bandForMHz(dl / 1e6);
    }
  } else {
    warnings.push("Tracker has no UL/DL frequency - kept WSJT-X FREQ");
  }

  logbook.applyAntennaPointing(f, ctx);

  const st = station || {};
  const myCall = logbook.normalizeCall(st.callsign);
  const myGrid = String(st.grid || "").trim().toUpperCase();
  if (!f.STATION_CALLSIGN && myCall) f.STATION_CALLSIGN = myCall;
  if (!f.OPERATOR && myCall) f.OPERATOR = myCall;
  if (!f.MY_GRIDSQUARE && myGrid) f.MY_GRIDSQUARE = myGrid;

  return {
    fields: f,
    enriched: true,
    note: "",
    warnings,
    txHz: freqHz(),
    rxHz: rxHzOf(),
    lotwAccepted: sat.accepted,
  };
}

/**
 * @param {{onQso:(q:{fields:object,source:string,clientId:string,from:string})=>void,
 *          onStatus?:(st:object)=>void, pairWaitMs?:number}} opts
 */
function createListener(opts) {
  const onQso = (opts && opts.onQso) || (() => {});
  const onStatus = (opts && opts.onStatus) || (() => {});
  const onDecode = (opts && opts.onDecode) || (() => {});
  const pairWait = (opts && opts.pairWaitMs) || PAIR_WAIT_MS;

  let sock = null;
  let cfg = { enabled: false, port: 2237, bind: "0.0.0.0" };
  /** Gate (Radio AND Antenna on). Closed by default: nothing is bound. */
  let gateOpen = false;
  let gateReason = "Radio and Antenna must be on";
  let retryTimer = null;
  const pending = new Map(); // key -> timer (type 5 waiting for 12)
  const recent = new Map(); // key -> ms forwarded
  const status = {
    // Enabled but gate closed at startup → show Paused immediately
    state: cfg.enabled ? "paused" : "off",
    message: cfg.enabled ? "Paused \u2014 Radio and Antenna must be on" : "",
    bind: cfg.bind,
    port: cfg.port,
    error: "",
    received: 0,
    forwarded: 0,
    duplicates: 0,
    ignoredOwn: 0,
    lastClient: "",
    gateOpen: false,
  };

  function emitStatus() {
    try {
      onStatus(Object.assign({}, status));
    } catch (_) {}
  }

  function purgeRecent() {
    const t = Date.now();
    for (const [k, ms] of recent) if (t - ms > RECENT_MS) recent.delete(k);
  }

  function forward(fields, source, clientId, from) {
    const k = qsoKey(fields);
    purgeRecent();
    if (recent.has(k)) {
      status.duplicates++;
      return false;
    }
    recent.set(k, Date.now());
    status.forwarded++;
    try {
      onQso({ fields, source, clientId, from });
    } catch (e) {
      console.warn("WSJT-X listener onQso:", e.message);
    }
    return true;
  }

  function handle(buf, rinfo) {
    if (!gateOpen || !cfg.enabled) return; // gated off: drop everything
    let msg;
    try {
      msg = decodeDatagram(buf);
    } catch (e) {
      return; // malformed / truncated: ignore
    }
    if (!msg) return;
    if (msg.id === OWN_ID) {
      status.ignoredOwn++;
      return;
    }
    status.received++;
    status.lastClient = msg.id;
    const from = rinfo ? rinfo.address + ":" + rinfo.port : "";
    if (msg.type === 2 && msg.decode) {
      try {
        onDecode(msg.decode, msg.id);
      } catch (_) {}
    } else if (msg.type === 12) {
      let recs = [];
      try {
        recs = parseAdif(msg.adif);
      } catch (_) {
        recs = [];
      }
      for (const f of recs) {
        if (!f.CALL) continue;
        const k = qsoKey(f);
        const t = pending.get(k);
        if (t) {
          clearTimeout(t);
          pending.delete(k);
        }
        forward(f, "wsjtx12", msg.id, from);
      }
    } else if (msg.type === 5 && msg.qso) {
      const f = qsoToFields(msg.qso);
      if (!f.CALL) return;
      const k = qsoKey(f);
      purgeRecent();
      if (recent.has(k)) {
        status.duplicates++;
        return;
      }
      if (pending.has(k)) return;
      pending.set(
        k,
        setTimeout(() => {
          pending.delete(k);
          if (!gateOpen || !cfg.enabled) return;
          forward(f, "wsjtx5", msg.id, from);
        }, pairWait),
      );
    }
    // other types (heartbeat, status, ...) ignored
  }

  function clearPending() {
    for (const t of pending.values()) clearTimeout(t);
    pending.clear();
  }

  function close() {
    clearPending();
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    if (sock) {
      const s = sock;
      sock = null;
      try {
        s.removeAllListeners("message");
        s.close();
      } catch (_) {}
    }
  }

  function open() {
    close();
    status.bind = cfg.bind;
    status.port = cfg.port;
    status.gateOpen = gateOpen;
    status.message = "";
    if (!cfg.enabled) {
      status.state = "off";
      status.error = "";
      emitStatus();
      return;
    }
    if (!gateOpen) {
      status.state = "paused";
      status.error = "";
      status.message = "Paused \u2014 " + gateReason;
      emitStatus();
      return;
    }
    if (net.isIP(cfg.bind) !== 4) {
      status.state = "error";
      status.error = "Invalid bind address: " + cfg.bind;
      emitStatus();
      return;
    }
    status.state = "starting";
    status.error = "";
    const s = dgram.createSocket({ type: "udp4", reuseAddr: false });
    sock = s;
    s.on("message", handle);
    s.on("error", (err) => {
      if (sock !== s) return;
      status.state = "error";
      status.error =
        err && err.code === "EADDRINUSE"
          ? "Port " +
            cfg.port +
            " already in use on " +
            cfg.bind +
            " (another app on this host?)"
          : err && err.code === "EADDRNOTAVAIL"
            ? cfg.bind + " is not an address on this host"
            : "Listener error: " + ((err && err.message) || err);
      console.warn("WSJT-X listener:", status.error);
      try {
        s.close();
      } catch (_) {}
      sock = null;
      emitStatus();
      // retry later (port may free up)
      if (cfg.enabled && gateOpen && !retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (cfg.enabled && gateOpen && !sock) open();
        }, RETRY_MS);
      }
    });
    s.on("listening", () => {
      if (sock !== s) return;
      const a = s.address();
      status.state = "listening";
      status.error = "";
      status.port = a.port;
      console.log("WSJT-X listener on " + a.address + ":" + a.port);
      emitStatus();
    });
    try {
      s.bind(cfg.port, cfg.bind);
    } catch (e) {
      s.emit("error", e);
    }
  }

  /** Apply settings; rebinds only when something changed. */
  function configure(next) {
    const n = {
      enabled: !!(next && next.enabled),
      port: (() => {
        const p = parseInt(next && next.port, 10);
        return p >= 0 && p < 65536 ? p : 2237;
      })(),
      bind: String((next && next.bind) || "0.0.0.0").trim() || "0.0.0.0",
    };
    const changed =
      n.enabled !== cfg.enabled || n.port !== cfg.port || n.bind !== cfg.bind;
    cfg = n;
    if (
      changed ||
      (n.enabled && gateOpen && !sock && status.state !== "error")
    )
      open();
    return getStatus();
  }

  /**
   * Open/close the gate (Radio AND Antenna on). Closing unbinds the socket
   * and drops pending QSOs; opening rebinds if the listener is enabled.
   */
  function setGate(open_, reason) {
    const o = !!open_;
    if (o === gateOpen) {
      if (reason && reason !== gateReason) {
        gateReason = reason;
        if (!o && status.state === "paused") {
          status.message = "Paused \u2014 " + gateReason;
          emitStatus();
        }
      }
      return false;
    }
    if (reason) gateReason = reason;
    gateOpen = o;
    open();
    return true;
  }

  function getStatus() {
    return Object.assign({}, status);
  }

  function stop() {
    cfg.enabled = false;
    close();
    status.state = "off";
  }

  return {
    configure,
    setGate,
    isGateOpen: () => gateOpen,
    isBound: () => !!sock,
    getStatus,
    stop,
    handle,
  };
}

function localIPv4Set() {
  const set = new Set(["0.0.0.0"]);
  const ifs = os.networkInterfaces() || {};
  for (const n of Object.keys(ifs))
    for (const a of ifs[n] || [])
      if (a && (a.family === "IPv4" || a.family === 4)) set.add(a.address);
  return set;
}

/**
 * Warning when our UDP output would land on the listener's own port on this
 * host (loopback, a local address, multicast w/ loopback, or broadcast).
 */
function outputLoopWarning(listen, out) {
  if (!listen || !listen.enabled || !out || out.method !== "udp") return "";
  const lp = parseInt(listen.port, 10);
  const op = parseInt(out.udpPort, 10);
  if (!lp || lp !== op) return "";
  const h = String(out.udpHost || "").trim();
  const local =
    /^127\./.test(h) ||
    localIPv4Set().has(h) ||
    logbook.isMulticastIPv4(h) ||
    logbook.isBroadcastIPv4(h);
  if (!local) return "";
  return (
    "Listener port " +
    lp +
    " equals the output port on this host (" +
    h +
    "). Our own packets are ignored (loop guard), but apps on this Pi using port " +
    lp +
    " will clash - use a different output port (e.g. 2238) or receivers on another machine."
  );
}

module.exports = {
  OWN_ID,
  PAIR_WAIT_MS,
  LOS_GRACE_MS,
  decodeDatagram,
  parseAdif,
  qsoToFields,
  wsjtxModeToAdif,
  enrichRecord,
  createListener,
  outputLoopWarning,
  qsoKey,
};
