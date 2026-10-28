#!/usr/bin/env node
/**
 * How much time does rigctld add? Starts `rigctld -m 1` (Hamlib dummy rig,
 * no serial port) on a free 127.0.0.1 port and times N sequential get_freq
 * (`f`) and set_freq (`F <hz>`) round trips over local TCP; also times a bare
 * local TCP echo server with the same line protocol as a baseline.
 * Real radios add their own CAT time on the serial line on top (same as our
 * native drivers pay).
 *   node tools/hamlib-latency.js [iterations=1000] [model=1]
 */
const net = require("net");
const path = require("path");
const { Supervisor } = require(path.join(__dirname, "..", "lib", "hamlib", "supervisor"));
const tools = require(path.join(__dirname, "..", "lib", "hamlib", "tools"));
const models = require(path.join(__dirname, "..", "lib", "hamlib", "models"));

const N = parseInt(process.argv[2], 10) || 1000;
const MODEL = parseInt(process.argv[3], 10) || 1;

function freePort() {
  return new Promise((r) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
}
function client(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => {
      sock.setNoDelay(true);
      let buf = "";
      let waiter = null;
      sock.on("data", (d) => {
        buf += d;
        const i = buf.indexOf("\n");
        if (i >= 0 && waiter) {
          const l = buf.slice(0, i);
          buf = buf.slice(i + 1);
          const w = waiter;
          waiter = null;
          w(l);
        }
      });
      resolve({ cmd: (c) => new Promise((r) => ((waiter = r), sock.write(c + "\n"))), close: () => sock.destroy() });
    });
    sock.on("error", reject);
  });
}
function stats(ms) {
  const s = ms.slice().sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, median: q(0.5), p90: q(0.9), p99: q(0.99), max: s[s.length - 1] };
}
async function time(c, mk) {
  const out = [];
  for (let i = 0; i < 50; i++) await c.cmd(mk(i)); // warm-up
  for (let i = 0; i < N; i++) {
    const t = process.hrtime.bigint();
    await c.cmd(mk(i));
    out.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  return stats(out);
}
const fmt = (s) => "median " + s.median.toFixed(3) + " ms · p90 " + s.p90.toFixed(3) + " · p99 " + s.p99.toFixed(3) + " · max " + s.max.toFixed(3) + " (n=" + s.n + ")";

(async () => {
  const bin = tools.find("rigctld");
  if (!bin) throw new Error("rigctld not found");
  const v = await tools.version();
  // Baseline: bare TCP line echo in this process ("f" -> a number, "F" -> RPRT 0)
  const echo = net.createServer((s) => {
    s.setNoDelay(true);
    let b = "";
    s.on("data", (d) => {
      b += d;
      let i;
      while ((i = b.indexOf("\n")) >= 0) {
        const l = b.slice(0, i);
        b = b.slice(i + 1);
        s.write(l[0] === "F" ? "RPRT 0\n" : "145800000\n");
      }
    });
  });
  await new Promise((r) => echo.listen(0, "127.0.0.1", r));
  const ec = await client(echo.address().port);
  const baseGet = await time(ec, () => "f");
  const baseSet = await time(ec, (i) => "F " + (145800000 + i));
  ec.close();
  echo.close();

  const port = await freePort();
  const sv = new Supervisor({ name: "rigctld", bin, args: models.buildRigctldArgs({ model: MODEL, port }), port, log: () => {}, warn: () => {} });
  if (!(await sv.start())) throw new Error("rigctld did not start");
  const c = await client(port);
  const get = await time(c, () => "f");
  const set = await time(c, (i) => "F " + (145800000 + i));
  c.close();
  await sv.stop();
  console.log("Hamlib " + (v.version || "?") + " rigctld -m " + MODEL + " on 127.0.0.1, " + N + " sequential round trips each");
  console.log("  get_freq (f)  via rigctld : " + fmt(get));
  console.log("  set_freq (F)  via rigctld : " + fmt(set));
  console.log("  bare local TCP line echo  : get " + fmt(baseGet));
  console.log("                              set " + fmt(baseSet));
  console.log("  rigctld adds (median)     : get " + (get.median - baseGet.median).toFixed(3) + " ms · set " + (set.median - baseSet.median).toFixed(3) + " ms");
  if (MODEL === 1)
    console.log("  note: Hamlib's dummy backend sleeps on purpose in set_freq (CMDSLEEP 20 ms in rigs/dummy/dummy.c, twice),\n        so set_freq here is ~40 ms of simulated radio time; get_freq shows the rigctld + TCP cost.");
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
