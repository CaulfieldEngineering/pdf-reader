/**
 * Measure how well word highlight times match the speech.
 *
 * Ground truth comes from the audio: after a pause (a comma, a full stop) the
 * next word starts where the energy envelope rises out of silence. Those
 * onsets are compared with the start times the engine reports for the words
 * that follow punctuation. Each such word is matched to the nearest onset
 * after a silence of 35 ms or more; a nearest onset more than 300 ms away
 * counts as a miss (the voice didn't pause, or the prediction is far off)
 * and is reported separately rather than averaged in.
 *
 *   npm run sync-bench            (current engine vs the v0.1.0 alignment)
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/main/tts/engine";
import { STARTER_PACK } from "../src/shared/lexicon";
import { LegacyEngine } from "./bench/legacy-engine";

const cache = join(process.env.APPDATA ?? join(homedir(), ".config"), "Readalong", "models");
const SENTENCES = [
  "The bridge runs at 6.78 MHz, the coils sit 30 mm apart, and the load draws 5 kW.",
  "In 2020, Smith and Jones measured 4.8–7.1 MHz, with a peak of 12.5 A, under load.",
  "First, the gate driver switches on; then, after 60 ns, the second leg follows.",
  "Wireless power links have been studied for decades, and resonant coupling is now usual.",
  "The receiver, a full-bridge rectifier, feeds a 48 V bus through a 10 µH inductor.",
  "Dr. Brown reported 93.9 % efficiency, which beat the 2018 result by 2.8 points.",
  "Capture: the port is shorted, read at once, and released; the cycle then repeats.",
  "At 25 °C, the MOSFET dissipates 3.4 W, so the heatsink needs 1.2 K/W or better.",
];

function decode(wav: Uint8Array): Float32Array {
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const n = (wav.length - 44) / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = v.getInt16(44 + i * 2, true) / 32768;
  return out;
}

/** Onsets (s): the first sound, and every rise out of a silence of at least 35 ms. */
function onsets(x: Float32Array): number[] {
  const hop = 120, win = 240; // 5 ms hop, 10 ms window at 24 kHz
  const rms: number[] = [];
  for (let s = 0; s + win <= x.length; s += hop) {
    let e = 0;
    for (let k = s; k < s + win; k++) e += x[k] * x[k];
    rms.push(Math.sqrt(e / win));
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const thr = Math.max(0.01, 0.12 * sorted[Math.floor(sorted.length * 0.95)]);
  const loud = rms.map((r) => r > thr);
  const out: number[] = [];
  const first = loud.indexOf(true);
  if (first >= 0) out.push(first);
  for (let k = first; k >= 0 && k < loud.length; ) {
    if (loud[k]) { k++; continue; }
    const s = k;
    while (k < loud.length && !loud[k]) k++;
    if (k < loud.length && k - s >= 7) out.push(k);
  }
  return out.map((f) => (f * hop + win / 2) / 24000);
}

/** Indices of the tokens that start after a pause: the first, and each one after , ; : . */
function pausedTokens(tokens: string[]): number[] {
  const out = [0];
  tokens.forEach((t, i) => { if (i + 1 < tokens.length && /[,;:.]$/.test(t) && !/^(?:Dr|Mr|Mrs|Ms)\.$/.test(t)) out.push(i + 1); });
  return out;
}

type Speak = (tokens: string[], speed: number) => Promise<{ wav: Uint8Array; starts: number[] }>;

async function measure(name: string, speak: Speak, speed: number) {
  const errs: number[] = [];
  let misses = 0;
  for (const s of SENTENCES) {
    const tokens = s.split(" ");
    const r = await speak(tokens, speed);
    const want = pausedTokens(tokens);
    const got = onsets(decode(r.wav));
    const near = want.map((t) => got.reduce((best, o) => (Math.abs(o - r.starts[t]) < Math.abs(best - r.starts[t]) ? o : best), Infinity));
    want.forEach((t, k) => {
      const e = (r.starts[t] - near[k]) * 1000;
      if (Math.abs(e) <= 300) errs.push(e); else misses++;
    });
    if (process.env.SYNC_VERBOSE) console.log(`  ${s.slice(0, 40)}… ` + want.map((t, k) => `${tokens[t]} pred ${r.starts[t].toFixed(2)} onset ${near[k].toFixed(2)}`).join(" | "));
  }
  const abs = errs.map(Math.abs).sort((a, b) => a - b);
  const signed = [...errs].sort((a, b) => a - b);
  const q = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  console.log(`${name.padEnd(34)} ${speed.toFixed(1)}x  matched ${errs.length}, missed ${misses}  median |err| ${q(abs, 0.5).toFixed(0).padStart(4)} ms  p90 ${q(abs, 0.9).toFixed(0).padStart(4)} ms  max ${abs[abs.length - 1].toFixed(0).padStart(4)} ms  bias ${q(signed, 0.5).toFixed(0)} ms`);
}

const legacy = new LegacyEngine(cache, "fp32");
await legacy.load();
const engine = new Engine(cache, "fp32");
await engine.load();
await engine.speak(["Warm", "up."]);
for (const speed of process.env.SYNC_QUICK ? [1.0] : [1.0, 1.5]) {
  await measure("before: v0.1.0 (word grouping)", (t, sp) => legacy.speak(t, "af_heart", sp), speed);
  engine.setLexicon([]);
  engine.frameMapping = "fixed";
  await measure("after: per-token ids, 600/frame", (t, sp) => engine.speak(t, "af_heart", sp), speed);
  engine.frameMapping = "scale";
  await measure("after: per-token ids, scaled", (t, sp) => engine.speak(t, "af_heart", sp), speed);
  engine.setLexicon(STARTER_PACK);
  await measure("after + pronunciations", (t, sp) => engine.speak(t, "af_heart", sp), speed);
}
