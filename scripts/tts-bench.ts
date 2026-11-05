/**
 * Download the voice model (if needed), synthesize sentences and report the
 * real-time factor (synthesis time / audio length; below 1 is faster than
 * real time).
 *
 *   npm run tts-bench -- [--dtype fp32|fp16|q8] [--out out.wav] [--cache dir]
 */

import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Engine, type Dtype } from "../src/main/tts/engine";

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const base = process.env.APPDATA ?? join(homedir(), ".config");
const cache = arg("cache", join(base, "Readalong", "models"));
const dtype = arg("dtype", "fp32") as Dtype;
const out = arg("out", "");

const engine = new Engine(cache, dtype);
console.log(`model cache: ${cache} (${engine.cached ? "cached" : "will download"})`);
let last = 0;
const t0 = performance.now();
await engine.load((p) => {
  if (performance.now() - last > 1500) {
    last = performance.now();
    console.log(`  downloading ${p.file}: ${(p.loaded / 1e6).toFixed(0)} / ${(p.total / 1e6).toFixed(0)} MB (${(p.fraction * 100).toFixed(0)}%)`);
  }
});
console.log(`loaded ${dtype} in ${((performance.now() - t0) / 1000).toFixed(1)} s; ${engine.voices().length} voices`);

const sentences = [
  "The power stage converts the input voltage to a regulated output, and the main parts are shown in the block diagram below, with the input on the left and the load on the right.",
  "Wireless power links have been studied for decades.",
  "Recent designs reach high efficiency at moderate distances, and resonant coupling is now the usual approach.",
];
await engine.speak(["Warm", "up."]);
let audio = 0, synth = 0;
for (const s of sentences) {
  const tokens = s.split(/\s+/);
  const t = performance.now();
  const r = await engine.speak(tokens, "af_heart", 1);
  const el = (performance.now() - t) / 1000;
  audio += r.duration;
  synth += el;
  console.log(`${r.duration.toFixed(2)} s of audio in ${el.toFixed(2)} s, RTF ${(el / r.duration).toFixed(3)}; first words at ${tokens.slice(0, 4).map((w, i) => `${w}@${r.starts[i]}`).join(" ")}`);
  if (out && s === sentences[0]) writeFileSync(out, r.wav);
}
console.log(`overall RTF ${(synth / audio).toFixed(3)} (${(audio / synth).toFixed(1)}x faster than real time)`);
