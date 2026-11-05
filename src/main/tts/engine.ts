/**
 * Kokoro-82M text to speech on the CPU (transformers.js -> onnxruntime-node),
 * using kokoro-js for the model, tokenizer and voice list. Runs in a Node
 * context: the Electron utility process, or plain Node for the scripts.
 *
 * Speech is built from the reader's tokens (one per word on the page):
 *   tokens -> pronunciations (lexicon) -> clean-up -> Kokoro normalisation and
 *   phonemes per token -> input ids, remembering which ids came from which
 *   token -> model (the "timestamped" export also returns each id's duration)
 *   -> each token's start time = the time of its first phoneme.
 * So the highlight follows the word on the page even when it is spoken as
 * several words ("kW" -> "kilowatts", "2020" -> "twenty twenty").
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { env, Tensor } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import { cleanToken } from "../../shared/analysis/text";
import { applyLexicon, orderedEntries, type PronEntry } from "../../shared/lexicon";
import { encodeWav } from "../../shared/tts-align";
import { phonemizeTokens } from "./kokoro-text";

export const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX-timestamped";
export type Dtype = "fp32" | "fp16" | "q8";
export const MODEL_FILES: Record<Dtype, string> = { fp32: "model.onnx", fp16: "model_fp16.onnx", q8: "model_quantized.onnx" };
export const DEFAULT_VOICE = "af_heart";
const VOICE_URL = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/";
const VOICE_BYTES = 510 * 256 * 4;
const MAX_IDS = 510;
const RATE = 24000;
const FAVOURITES = ["af_heart", "af_bella", "af_nicole", "bf_emma", "am_michael", "am_fenrir", "bm_george", "bm_fable"];

export interface Voice { id: string; name: string; accent: string; gender: string; grade: string }
export interface SpeakResult {
  wav: Uint8Array;
  /** Start time (s) of each input token. */
  starts: number[];
  duration: number;
  rtf: number;
  /** Set when the requested voice couldn't be loaded and the default was used. */
  fallback?: { requested: string; used: string; reason: string };
}
export interface LoadProgress { fraction: number; file: string; loaded: number; total: number }
/** What was sent to the model, for tests and the sync benchmark. */
export interface Trace { ids: number[]; tokenOfId: number[]; durations: number[]; samples: number; spoken: string[]; samplesPerFrame: number[] }

export function modelPath(cacheDir: string, dtype: Dtype): string {
  return join(cacheDir, ...MODEL_ID.split("/"), "onnx", MODEL_FILES[dtype]);
}

/** The voices folder shipped inside the kokoro-js package (may be gone in a broken install). */
function packagedVoicesDir(): string | null {
  try {
    // kokoro-js doesn't export its package.json; its entry point is in dist/
    return join(dirname(createRequire(import.meta.url).resolve("kokoro-js")), "..", "voices");
  } catch {
    return null;
  }
}

export class Engine {
  private tts: KokoroTTS | null = null;
  private vocab = new Map<string, number>();
  private voiceCache = new Map<string, Float32Array>();
  private queue: Promise<unknown> = Promise.resolve();
  private lexicon: PronEntry[] = [];
  lastRtf = 0;
  lastTrace: Trace | null = null;
  /** How frames map to samples: scaled so they sum to the clip ("scale"), or 600 per frame ("fixed"). For the sync benchmark. */
  frameMapping: "scale" | "fixed" = "scale";

  constructor(readonly cacheDir: string, readonly dtype: Dtype = "fp32") {}

  get ready(): boolean {
    return this.tts !== null;
  }

  get cached(): boolean {
    return existsSync(modelPath(this.cacheDir, this.dtype));
  }

  get voicesDir(): string {
    return join(this.cacheDir, "voices");
  }

  setLexicon(entries: PronEntry[]): void {
    this.lexicon = orderedEntries(entries);
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
    const model: any = (tts.tokenizer as any).model;
    const t2i: Map<string, number> | undefined = model?.tokens_to_ids;
    if (t2i) for (const [tok, id] of t2i) this.vocab.set(tok, id);
    this.tts = tts;
    this.installVoices();
  }

  // ---------------------------------------------------------------- voices

  voices(): Voice[] {
    if (!this.tts) return [];
    const all = this.tts.voices as Record<string, { name: string; language: string; gender: string; overallGrade: string }>;
    const rank = (id: string) => FAVOURITES.indexOf(id) + 1 || 99;
    return Object.entries(all)
      .map(([id, v]) => ({ id, name: v.name, accent: v.language === "en-gb" ? "UK" : "US", gender: v.gender, grade: v.overallGrade }))
      .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  }

  /**
   * Copy the voices the app offers into the user's model folder, so speech
   * never depends on the app's own files (a portable copy runs from a temp
   * folder that can be cleaned up while it is open).
   */
  installVoices(): { installed: number; missing: string[] } {
    mkdirSync(this.voicesDir, { recursive: true });
    const src = packagedVoicesDir();
    const missing: string[] = [];
    let installed = 0;
    for (const v of this.voices()) {
      const dest = join(this.voicesDir, `${v.id}.bin`);
      if (validVoiceFile(dest)) { installed++; continue; }
      const from = src ? join(src, `${v.id}.bin`) : "";
      try {
        // Read and write rather than copy, so it also works from inside the app's asar archive
        if (from && existsSync(from)) { writeFileSync(dest, readFileSync(from)); if (validVoiceFile(dest)) { installed++; continue; } }
      } catch { /* fall through to download on first use */ }
      missing.push(v.id);
    }
    return { installed, missing };
  }

  /** Every offered voice and whether its file is in place (if not, it downloads on first use). */
  checkVoices(): { id: string; file: string; present: boolean }[] {
    return this.voices().map((v) => {
      const file = join(this.voicesDir, `${v.id}.bin`);
      return { id: v.id, file, present: validVoiceFile(file) };
    });
  }

  private async voiceData(id: string): Promise<Float32Array> {
    const hit = this.voiceCache.get(id);
    if (hit) return hit;
    if (!/^[a-z]{2}_[a-z]+$/.test(id) || !this.voices().some((v) => v.id === id)) throw new Error(`"${id}" isn't one of the voices`);
    const file = join(this.voicesDir, `${id}.bin`);
    if (!validVoiceFile(file)) {
      // Last resort: download the same file kokoro-js would fetch
      let res: Response;
      try { res = await fetch(VOICE_URL + `${id}.bin`); } catch { throw new Error(`its file is missing and it couldn't be downloaded (offline?)`); }
      if (!res.ok) throw new Error(`its file is missing and the download failed (HTTP ${res.status})`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length !== VOICE_BYTES) throw new Error(`the downloaded voice file was incomplete`);
      mkdirSync(this.voicesDir, { recursive: true });
      writeFileSync(file, buf);
    }
    const b = readFileSync(file);
    const data = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    this.voiceCache.set(id, data);
    return data;
  }

  // ---------------------------------------------------------------- speech

  /** Synthesize one utterance. Calls are serialised; onnxruntime uses all cores per call. */
  speak(tokens: string[], voice = DEFAULT_VOICE, speed = 1): Promise<SpeakResult> {
    const run = this.queue.then(() => this.speakNow(tokens, voice, speed));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The spoken text for each token, after pronunciations and clean-up. */
  spokenTokens(tokens: string[]): string[] {
    return applyLexicon(tokens, this.lexicon).map(cleanToken);
  }

  private async speakNow(rawTokens: string[], voice: string, speed: number): Promise<SpeakResult> {
    if (!this.tts) throw new Error("The voice model isn't loaded yet");
    const spoken = this.spokenTokens(rawTokens);
    if (!spoken.some(Boolean)) throw new Error("Nothing to say");
    let fallback: SpeakResult["fallback"];
    let style: Float32Array;
    try {
      style = await this.voiceData(voice);
    } catch (e: any) {
      if (voice === DEFAULT_VOICE) throw new Error(`The voice couldn't be loaded: ${e?.message ?? e}`);
      fallback = { requested: voice, used: DEFAULT_VOICE, reason: String(e?.message ?? e) };
      voice = DEFAULT_VOICE;
      style = await this.voiceData(voice);
    }
    const lang = voice.startsWith("b") ? "en-gb" : "en-us";
    const t0 = performance.now();

    // Phoneme pieces -> ids, remembering the token of every id
    const pieces = await phonemizeTokens(spoken, lang);
    const ids: number[] = [], tokenOfId: number[] = [];
    for (const p of pieces) {
      for (const ch of p.text) {
        const id = this.vocab.get(ch);
        if (id === undefined) continue;
        ids.push(id);
        tokenOfId.push(p.token);
      }
    }
    if (!ids.length) throw new Error("Nothing to say");

    // Long sentences go to the model in windows of at most MAX_IDS, cut between tokens
    const windows: [number, number][] = [];
    for (let s = 0; s < ids.length; ) {
      let e = Math.min(ids.length, s + MAX_IDS);
      if (e < ids.length) {
        let cut = e;
        while (cut > s + 1 && tokenOfId[cut] === tokenOfId[cut - 1]) cut--;
        if (cut > s + 1) e = cut;
      }
      windows.push([s, e]);
      s = e;
    }
    const parts: Float32Array[] = [];
    const idStart: number[] = new Array(ids.length).fill(0);
    const durations: number[] = [];
    const samplesPerFrame: number[] = [];
    let offset = 0;
    for (const [s, e] of windows) {
      const win = [0, ...ids.slice(s, e), 0];
      const row = Math.min(Math.max(win.length - 2, 0), 509) * 256;
      const out: any = await (this.tts.model as any)({
        input_ids: new Tensor("int64", BigInt64Array.from(win.map((v) => BigInt(v))), [1, win.length]),
        style: new Tensor("float32", style.slice(row, row + 256), [1, 256]),
        speed: new Tensor("float32", new Float32Array([Math.min(2, Math.max(0.5, speed))]), [1]),
      });
      const wave = out.waveform.data as Float32Array;
      const dur = out.durations ? Array.from(out.durations.data as ArrayLike<number | bigint>, Number) : [];
      // Durations are frames; map them onto the actual samples so they sum to the clip length
      const frames = dur.reduce((a, b) => a + b, 0);
      const perFrame = this.frameMapping === "fixed" ? 600 : frames > 0 ? wave.length / frames : 0;
      samplesPerFrame.push(perFrame);
      let acc = 0;
      dur.forEach((d, k) => {
        if (k >= 1 && k <= e - s) idStart[s + k - 1] = (offset + acc * perFrame) / RATE;
        acc += d;
      });
      durations.push(...dur.slice(1, -1));
      parts.push(wave);
      offset += wave.length;
    }
    const samples = new Float32Array(offset);
    let at = 0;
    for (const p of parts) { samples.set(p, at); at += p.length; }
    const duration = samples.length / RATE;
    const elapsed = (performance.now() - t0) / 1000;
    this.lastRtf = duration > 0 ? elapsed / duration : 0;

    // A token starts at its first sounding phoneme (not the space or punctuation before it)
    const quiet = new Set([..." ;:,.!?¡¿—…\"«»“”(){}[]"].map((c) => this.vocab.get(c)).filter((v): v is number => v !== undefined));
    const starts: number[] = new Array(rawTokens.length).fill(-1);
    for (let k = 0; k < ids.length; k++) {
      const t = tokenOfId[k];
      if (starts[t] < 0 && !quiet.has(ids[k])) starts[t] = idStart[k];
    }
    for (let t = starts.length - 1; t >= 0; t--) {
      if (starts[t] < 0) starts[t] = t + 1 < starts.length ? starts[t + 1] : duration;
    }
    this.lastTrace = { ids, tokenOfId, durations, samples: samples.length, spoken, samplesPerFrame };
    const result: SpeakResult = { wav: encodeWav(samples, RATE), starts: starts.map((v) => Math.round(v * 1000) / 1000), duration, rtf: this.lastRtf };
    if (fallback) result.fallback = fallback;
    return result;
  }
}

function validVoiceFile(p: string): boolean {
  try { return statSync(p).size === VOICE_BYTES; } catch { return false; }
}
