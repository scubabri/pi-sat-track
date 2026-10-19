#!/usr/bin/env node
/**
 * Synthesize the pass-alert bell: one strike, ~1 kHz fundamental with a few
 * low-level inharmonic bell partials, fast attack, ~1.8 s exponential decay,
 * light Schroeder reverb (~20 % wet). Writes 16-bit mono WAVs:
 *   node tools/make-ding.js <out-single.wav> [<out-x3.wav>]
 * then encode, e.g.
 *   ffmpeg -i ding.wav -c:a aac -b:a 64k sounds/ding.m4a
 *   ffmpeg -i ding.wav -c:a libmp3lame -b:a 64k sounds/ding.mp3
 */
const fs = require("fs");

const SR = 44100;
const F0 = 1046.5; // C6
// [ratio, amplitude, decay tau (s), detune for slow beating]
const PARTIALS = [
  [1.0, 1.0, 0.55, 0],
  [1.0, 0.35, 0.5, 1.6], // close pair → gentle bell warble
  [0.5, 0.06, 0.8, 0], // hum
  [2.756, 0.16, 0.22, 0],
  [5.404, 0.07, 0.09, 0],
  [8.933, 0.025, 0.05, 0],
];
const STRIKE_LEN_S = 2.4;
const WET = 0.2;

function strike() {
  const n = Math.round(STRIKE_LEN_S * SR);
  const out = new Float32Array(n);
  const attack = 0.002 * SR;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const atk = i < attack ? i / attack : 1;
    let v = 0;
    for (const [r, a, tau, det] of PARTIALS) {
      v += a * Math.exp(-t / tau) * Math.sin(2 * Math.PI * (F0 * r + det) * t);
    }
    // tiny mallet click (first ~4 ms)
    if (t < 0.004) v += 0.08 * rnd() * (1 - t / 0.004);
    // fade the last 50 ms to true silence
    const tail = n - i < 0.05 * SR ? (n - i) / (0.05 * SR) : 1;
    out[i] = v * atk * tail;
  }
  return out;
}

/** Small-room Schroeder reverb: 4 parallel combs → 2 series allpasses. */
function reverb(x, extraS) {
  const n = x.length + Math.round(extraS * SR);
  const input = new Float32Array(n);
  input.set(x);
  const combs = [[1116, 0.78], [1188, 0.77], [1277, 0.76], [1356, 0.75]];
  const wet = new Float32Array(n);
  for (const [d, g] of combs) {
    const buf = new Float32Array(d);
    let idx = 0;
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const y = buf[idx];
      lp = y * 0.6 + lp * 0.4; // damping
      buf[idx] = input[i] + lp * g;
      wet[i] += y / combs.length;
      idx = (idx + 1) % d;
    }
  }
  for (const [d, g] of [[556, 0.5], [441, 0.5]]) {
    const buf = new Float32Array(d);
    let idx = 0;
    for (let i = 0; i < n; i++) {
      const b = buf[idx];
      const y = -wet[i] + b;
      buf[idx] = wet[i] + b * g;
      wet[i] = y;
      idx = (idx + 1) % d;
    }
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (1 - WET) * input[i] + WET * wet[i];
  return out;
}

function normalize(x, peak) {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  const k = m > 0 ? peak / m : 1;
  for (let i = 0; i < x.length; i++) x[i] *= k;
  return x;
}

function wav(path, x) {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + x.length * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) {
    b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  }
  fs.writeFileSync(path, b);
}

const one = strike();
const single = normalize(reverb(one, 0.4), 0.8);
if (process.argv[2]) wav(process.argv[2], single);
if (process.argv[3]) {
  // Three strikes 0.6 s apart — how the alert sounds in the app.
  const gap = Math.round(0.6 * SR);
  const mix = new Float32Array(one.length + 2 * gap);
  for (let k = 0; k < 3; k++) for (let i = 0; i < one.length; i++) mix[k * gap + i] += one[i];
  wav(process.argv[3], normalize(reverb(mix, 0.4), 0.8));
}
