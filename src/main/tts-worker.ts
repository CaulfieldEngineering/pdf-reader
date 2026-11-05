/**
 * Utility process that owns the voice model, so synthesis never blocks the
 * window. Messages from the main process:
 *   { type: "init", cacheDir, dtype, lexicon }
 *   { type: "lexicon", entries }
 *   { type: "speak", id, tokens, voice, speed }
 *   { type: "voices", id }   { type: "check-voices", id }
 * Replies: "status", "result", "error", "voices".
 */

import type { PronEntry } from "../shared/lexicon";
import { Engine, type Dtype } from "./tts/engine";

const port = (process as any).parentPort as { on(ev: "message", cb: (e: { data: any }) => void): void; postMessage(m: unknown): void };
let engine: Engine | null = null;
let lexicon: PronEntry[] = [];

function status(state: string, extra: Record<string, unknown> = {}) {
  port.postMessage({ type: "status", state, ...extra });
}

async function init(cacheDir: string, dtype: Dtype) {
  engine = new Engine(cacheDir, dtype);
  engine.setLexicon(lexicon);
  status(engine.cached ? "loading" : "downloading", { progress: 0, dtype });
  let last = 0;
  try {
    await engine.load((p) => {
      const now = Date.now();
      if (now - last < 250 && p.fraction < 1) return;
      last = now;
      status("downloading", { progress: p.fraction, dtype, downloadedMB: p.loaded / 1e6, totalMB: p.total / 1e6, message: p.file });
    });
    status("loading", { progress: 1, dtype });
    const missing = engine.checkVoices().filter((v) => !v.present).map((v) => v.id);
    if (missing.length) console.log(`[voice] ${missing.length} voice files missing; they download on first use: ${missing.join(", ")}`);
    await engine.speak(["Ready."]); // warm up the session
    status("ready", { progress: 1, dtype, rtf: engine.lastRtf });
  } catch (e: any) {
    engine = null;
    status("error", { message: String(e?.message ?? e), dtype });
  }
}

port.on("message", async ({ data: m }) => {
  if (m.type === "init") {
    lexicon = Array.isArray(m.lexicon) ? m.lexicon : [];
    await init(m.cacheDir, m.dtype);
  } else if (m.type === "lexicon") {
    lexicon = Array.isArray(m.entries) ? m.entries : [];
    engine?.setLexicon(lexicon);
  } else if (m.type === "voices") {
    port.postMessage({ type: "voices", id: m.id, voices: engine?.voices() ?? [] });
  } else if (m.type === "check-voices") {
    port.postMessage({ type: "voices", id: m.id, voices: engine?.checkVoices() ?? [] });
  } else if (m.type === "speak") {
    if (!engine?.ready) {
      port.postMessage({ type: "error", id: m.id, message: "The voice model isn't ready yet" });
      return;
    }
    try {
      const r = await engine.speak(m.tokens, m.voice, m.speed);
      port.postMessage({ type: "result", id: m.id, ...r });
    } catch (e: any) {
      port.postMessage({ type: "error", id: m.id, message: String(e?.message ?? e) });
    }
  }
});
