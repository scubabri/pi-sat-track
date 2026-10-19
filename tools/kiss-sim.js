#!/usr/bin/env node
/**
 * Fake KISS-over-TCP TNC for testing the APRS connector (like tools/wsjtx_sim.py).
 *
 *   node tools/kiss-sim.js [--port 8001[,8002,8003]] [--host 127.0.0.1] [--interval 4]
 *                          [--rx-log /tmp/kiss-rx.jsonl] [--echo] [--once] [--all]
 *
 * - Replays sample satellite APRS packets (ISS-style, RS0ISS* paths) to every
 *   connected client, one every --interval seconds (looping unless --once).
 * - Several ports (comma separated) = several TNC channels, like Graywolf's
 *   one-channel-per-KISS-port setup plus a Direwolf 9600 port. Samples go
 *   round-robin to one port each; every 4th sample goes to all ports (the
 *   same packet heard on two receivers, to exercise de-duplication). --all
 *   sends every sample to every port.
 * - Decodes every frame a client sends and prints it as TNC2 + hex; with
 *   --rx-log appends {time, tnc2, hex, kissHex, kissPort} JSON lines.
 * - --echo: re-send received frames as if digipeated by the ISS (first
 *   un-repeated sat alias replaced by RS0ISS*).
 * - --echo-digi SHEPRD,KF6RAL-1: instead, one echo per listed terrestrial
 *   digipeater (first un-repeated hop replaced by CALL*), staggered; a
 *   satellite alias (ARISS…) is still echoed once as RS0ISS*.
 * - --dupes: each sample is heard again ~1.5 s / 3 s later via other paths
 *   (direct, then via SHEPRD*), like a digipeater-rich area; the UI collapses
 *   these into one ×N row.
 */
const net = require("net");
const fs = require("fs");
const kiss = require("../lib/kiss/kiss");
const ax25 = require("../lib/ax25");

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v == null || v.startsWith("--") ? true : v;
}
const PORTS = String(arg("port", "8001"))
  .split(",")
  .map((p) => parseInt(p, 10))
  .filter((p) => p > 0 && p < 65536);
const ALL = !!arg("all", false);
const HOST = arg("host", "127.0.0.1");
const INTERVAL = Number(arg("interval", "4")) * 1000;
const RX_LOG = arg("rx-log", "");
const ECHO = !!arg("echo", false);
const ONCE = !!arg("once", false);
const ECHO_DIGI = String(arg("echo-digi", "") || "")
  .split(",")
  .map((x) => x.trim().toUpperCase())
  .filter((x) => x && x !== "TRUE");
const DUPES = !!arg("dupes", false);
const hop = (c) => {
  const m = /^([A-Z0-9]+)(?:-(\d+))?$/.exec(c);
  return { call: m ? m[1] : c, ssid: m && m[2] ? Number(m[2]) : 0, h: true };
};

/** Sample traffic: position reports first (the main sat traffic), then text. */
const SAMPLES = [
  "VK5RK-9>S4T9P0,RS0ISS*:`BDzl -/`Hi Geoff VK5RK_%",
  "N0SAT>APRS,RS0ISS*:!3944.50N/10459.00W`Denver sat station",
  "W7XYZ-7>APDR16,RS0ISS*,WIDE2-1:=4036.12N/11153.48W>073/045/A=004500 mobile via ISS",
  "JA1UMW>JS1YCP,RS0ISS*:$GPGGA,191426.000,3542.9954,N,13946.5044,E,1,10,0.9,20.5,M,39.3,M,,0000*6E",
  "BH2VSQ>CQ,RS0ISS*:CQ BH2VSQ OL79",
  "EA1URO>CQ,RS0ISS*:=4228.50N/00817.00W-UISS test via ISS",
  "KK4YEL>APRS,RS0ISS*::N0SAT    :Hi from EL98 73",
  "DL7NDR>JN48AP,RS0ISS*:>QRV via ISS DN40aq",
  "N0SAT>APRS,RS0ISS*:>Thanks for the contact",
  "RS0ISS>0P0PS5,APRSAT:'v&l SI]ARISS-International Space Station=",
  // Real traffic from a Graywolf on 144.390 (northern Utah). MAVRIK-9's
  // Mic-E course byte is the control char 0x1c (lost when the log was copied).
  "MAVRIK-9>EBAYVY,SHEPRD*,WIDE1*,WIDE2-1:`(YTmF\x1cj/`\"C1}W5SAT_1",
  "VIC>APNX02,SHEPRD*,WIDE1*:>BEACON: N7ELY-2  Info enarsclub@gmail.com ENARS",
  "K7TX-10>APDW17,KF6RAL-1*,SHEPRD*,WIDE2*:!4025.41NS11150.07W#PHG2160 APRS Digi & iGate",
  "HRSHDE>APOT30,KF6RAL-1*,SHEPRD*,WIDE2*:!3920.05N/11127.01W# 13.3V 44F SANPETE SAR KB7K",
  // Weather / item / telemetry so every traffic-window filter has something
  "KE7WX>APRS,WIDE2-1:!4045.20N/11152.80W_220/004g005t048r000p000P000h50b10132Salt Lake WX",
  "N7AID>APRS,WIDE2-1:)AID #2!4046.00N/11150.00WA First aid station",
  "N7TLM-11>APRS,WIDE2-1:T#005,199,000,255,073,123,01101001",
  // third-party (APRS-IS -> RF) message gated by two iGates (Brian's real traffic)
  "KU5R-6>APMI06,WIDE2-1:}OTA>APZ100,TCPIP,KU5R-6*::K7ETC-7 :DE K6BOY-5 QSL Thx for the chase! 73{6278",
  "KB7COX-10>APDW17,SHEPRD,WIDE1,KU5R-6,WIDE2*:}OTA>APRS,TCPIP,KB7COX-10*::K7ETC-7 :DE K6BOY-5 QSL Thx for the chase! 73{6278",
];

/** "SRC>DST,DIGI*,..:info" -> AX.25 frame (H bit set on digis up to the last '*'). */
function tnc2ToFrame(line) {
  const ci = line.indexOf(":");
  const head = line.slice(0, ci);
  const info = line.slice(ci + 1);
  const [src, rest] = head.split(">");
  const parts = rest.split(",");
  const dst = parts.shift();
  let lastStar = -1;
  parts.forEach((p, i) => {
    if (p.endsWith("*")) lastStar = i;
  });
  const path = parts.map((p, i) => {
    const a = ax25.parseAddr(p.replace(/\*$/, ""));
    a.h = i <= lastStar;
    return a;
  });
  return ax25.encodeUI({ src, dst, path, info: Buffer.from(info, "utf8") });
}

function main() {
  const byPort = new Map(PORTS.map((p) => [p, new Set()]));
  let idx = 0;
  const total = () => [...byPort.values()].reduce((n, s) => n + s.size, 0);
  function sendTo(port, frame) {
    const k = kiss.encode(frame);
    for (const c of byPort.get(port) || []) c.write(k);
  }
  const servers = PORTS.map((PORT) => {
  const clients = byPort.get(PORT);
  const sendAll = (frame) => sendTo(PORT, frame);
  const server = net.createServer((sock) => {
    clients.add(sock);
    const tag = sock.remoteAddress + ":" + sock.remotePort + " on :" + PORT;
    console.log("[kiss-sim] client connected", tag);
    const dec = new kiss.Decoder();
    sock.on("data", (b) => {
      for (const f of dec.push(b)) {
        const fr = ax25.decode(f.data);
        const tnc2 = fr ? ax25.toTnc2(fr) : "(undecodable)";
        const kissHex = kiss.encode(f.data, { port: f.port, cmd: f.cmd }).toString("hex");
        console.log("[kiss-sim] RX from client port " + f.port + " cmd " + f.cmd + ": " + tnc2);
        console.log("[kiss-sim]   ax25 " + f.data.toString("hex"));
        if (RX_LOG) {
          fs.appendFileSync(
            RX_LOG,
            JSON.stringify({ time: new Date().toISOString(), tcpPort: PORT, tnc2, hex: f.data.toString("hex"), kissHex, kissPort: f.port, cmd: f.cmd }) + "\n",
          );
        }
        if (ECHO_DIGI.length && fr && f.cmd === 0) {
          const i = fr.path.findIndex((p) => !p.h);
          const satHop = i >= 0 && /^(ARISS|RS0ISS|APRSAT|SATELLITE|SGATE)$/.test(fr.path[i].call);
          (satHop ? ["RS0ISS"] : ECHO_DIGI).forEach((d, k) => {
            const path = fr.path.slice();
            if (i >= 0) path[i] = hop(d);
            else path.push(hop(d));
            setTimeout(() => sendAll(ax25.encodeUI({ src: fr.src, dst: fr.dst, path, info: fr.info })), 800 + k * 1200);
          });
        } else if (ECHO && fr && f.cmd === 0) {
          const i = fr.path.findIndex((p) => !p.h);
          if (i >= 0) {
            fr.path[i] = { call: "RS0ISS", ssid: 0, h: true };
            setTimeout(
              () => sendAll(ax25.encodeUI({ src: fr.src, dst: fr.dst, path: fr.path, info: fr.info })),
              800,
            );
          }
        }
      }
    });
    sock.on("close", () => {
      clients.delete(sock);
      console.log("[kiss-sim] client gone", tag);
    });
    sock.on("error", () => {});
  });

  server.listen(PORT, HOST, () => {
    console.log("[kiss-sim] KISS TCP TNC on " + HOST + ":" + PORT + " (" + SAMPLES.length + " samples every " + INTERVAL / 1000 + " s)");
  });
  return server;
  });

  const timer = setInterval(() => {
    if (!total()) return;
    if (ONCE && idx >= SAMPLES.length) return;
    const line = SAMPLES[idx % SAMPLES.length];
    const all = ALL || PORTS.length === 1 || idx % 4 === 0;
    const targets = all ? PORTS : [PORTS[idx % PORTS.length]];
    idx++;
    console.log("[kiss-sim] TX :" + targets.join(",:") + " " + line);
    const fr = tnc2ToFrame(line);
    targets.forEach((p) => sendTo(p, fr));
    if (DUPES && !/^RS0ISS>/.test(line)) {
      const d = ax25.decode(fr);
      if (d) {
        const paths = [[], [hop("SHEPRD"), { call: "WIDE2", ssid: 0, h: true }]];
        paths.forEach((path, k) =>
          setTimeout(() => targets.forEach((p) => sendTo(p, ax25.encodeUI({ src: d.src, dst: d.dst, path, info: d.info }))), 1500 * (k + 1)),
        );
      }
    }
  }, INTERVAL);

  process.on("SIGINT", () => {
    clearInterval(timer);
    servers.forEach((s) => s.close());
    process.exit(0);
  });
}

if (require.main === module) main();

module.exports = { tnc2ToFrame, SAMPLES };
