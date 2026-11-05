/**
 * Kokoro-82M text to speech on the CPU (kokoro-js -> transformers.js ->
 * onnxruntime-node). Runs in a Node context: the Electron utility process, or
 * plain Node for the benchmark script.
 *
 * The model is the "timestamped" ONNX export, which also returns how long
 * each phoneme lasts; that is what drives word highlighting.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import { cleanToken } from "../../shared/analysis/text";
import { encodeWav, tokenStarts } from "../../shared/tts-align";

export const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX-timestamped";
export type Dtype = "fp32" | "fp16" | "q8";
export const MODEL_FILES: Record<Dtype, string> = { fp32: "model.onnx", fp16: "model_fp16.onnx", q8: "model_quantized.onnx" };
export const SAMPLE_RATE = 24000;
const FAVOURITES = ["af_heart", "af_bella", "af_nicole", "bf_emma", "am_michael", "am_fenrir", "bm_george", "bm_fable"];

export interface Voice { id: string; name: string; accent: string; gender: string; grade: string }
export interface SpeakResult { wav: Uint8Array; starts: number[]; duration: number; rtf: number }
export interface LoadProgress { fraction: number; file: string; loaded: number; total: number }

export function modelPath(cacheDir: string, dtype: Dtype): string {
  return join(cacheDir, ...MODEL_ID.split("/"), "onnx", MODEL_FILES[dtype]);
}

export class Engine {
  private tts: KokoroTTS | null = null;
  private vocab: string[] = [];
  private captured: { ids: number[]; durations: number[] } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  lastRtf = 0;

  constructor(readonly cacheDir: string, readonly dtype: Dtype = "fp32") {}

  get ready(): boolean {
    return this.tts !== null;
  }

  /** True when the model files are already on disk (no download needed). */
  get cached(): boolean {
    return existsSync(modelPath(this.cacheDir, this.dtype));
  }

  async load(onProgress?: (p: LoadProgress) => void): Promise<void> {
    env.cacheDir = this.cacheDir;
    // Once downloaded, load straight from disk and never touch the network.
    // The download cache has the same layout as a local model folder.
    const cached = this.cached;
    env.localModelPath = this.cacheDir;
    env.allowLocalModels = cached;
    env.allowRemoteModels = !cached;
    const files = new Map<string, { loaded: number; total: number }>();
    const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: this.dtype,
      device: "cpu",
      progress_callback: (p: any) => {
        if (p.status !== "progress" || !p.file) return;
        files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
        let loaded = 0, total = 0;
        for (const f of files.values()) { loaded += f.loaded; total += f.total; }
        onProgress?.({ fraction: total ? loaded / total : 0, file: p.file, loaded, total });
      },
    });
    // Phoneme for each token id, to group the durations into words
    const model: any = (tts.tokenizer as any).model;
    const t2i: Map<string, number> | undefined = model?.tokens_to_ids;
    if (t2i) for (const [tok, id] of t2i) this.vocab[id] = tok;
    else if (Array.isArray(model?.vocab)) this.vocab = model.vocab;
    // Capture the model's inputs and its duration output on every call
    const inner = tts.model as any;
    const wrapped = async (inputs: any) => {
      const out = await inner(inputs);
      const ids = Array.from(inputs.input_ids.data as ArrayLike<number | bigint>, Number);
      const durations = out.durations ? Array.from(out.durations.data as ArrayLike<number | bigint>, Number) : [];
      this.captured = { ids, durations };
      return out;
    };
    (tts as any).model = wrapped;
    this.tts = tts;
  }

  voices(): Voice[] {
    if (!this.tts) return [];
    const all = this.tts.voices as Record<string, { name: string; language: string; gender: string; overallGrade: string }>;
    const rank = (id: string) => (FAVOURITES.indexOf(id) + 1 || 99);
    return Object.entries(all)
      .map(([id, v]) => ({ id, name: v.name, accent: v.language === "en-gb" ? "UK" : "US", gender: v.gender, grade: v.overallGrade }))
      .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  }

  /** Synthesize one utterance. Calls are serialised; onnxruntime uses all cores per call. */
  speak(tokens: string[], voice = "af_heart", speed = 1): Promise<SpeakResult> {
    const run = this.queue.then(() => this.speakNow(tokens, voice, speed));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async speakNow(rawTokens: string[], voice: string, speed: number): Promise<SpeakResult> {
    if (!this.tts) throw new Error("The voice model isn't loaded yet");
    const tokens = rawTokens.map(cleanToken);
    const text = tokens.filter(Boolean).join(" ");
    if (!text) throw new Error("Nothing to say");
    const t0 = performance.now();
    this.captured = null;
    const audio = await this.tts.generate(text, { voice: voice as any, speed: Math.min(2, Math.max(0.5, speed)) });
    const elapsed = (performance.now() - t0) / 1000;
    const samples = audio.audio as Float32Array;
    const duration = samples.length / audio.sampling_rate;
    let starts: number[];
    const cap = this.captured as { ids: number[]; durations: number[] } | null;
    if (cap && cap.durations.length === cap.ids.length) {
      const phonemes = cap.ids.map((id: number) => (id === 0 ? "" : this.vocab[id] ?? ""));
      starts = tokenStarts(phonemes, cap.durations, duration, tokens);
    } else {
      starts = tokenStarts([], [], duration, tokens);
    }
    this.lastRtf = duration > 0 ? elapsed / duration : 0;
    return { wav: encodeWav(samples, audio.sampling_rate), starts, duration, rtf: this.lastRtf };
  }
}
