/**
 * Word timing from Kokoro's per-phoneme durations.
 *
 * The timestamped Kokoro export returns, for every input id (phoneme), how
 * many audio frames it lasts. Phonemes are grouped into words at spaces. When
 * the number of spoken words matches the number of word tokens the client
 * sent, each token gets its word's start time exactly; otherwise starts are
 * spread over the spoken phonemes in proportion to each token's length.
 */

const PUNCT = new Set([...".,;:!?—…\"()“”'«»-[]{}¡¿"]);
const hasWord = (s: string) => /[\p{L}\p{N}]/u.test(s);

/**
 * @param phonemes  The phoneme for each input id, pads included ("" for pads).
 * @param durations Frames per input id (same length as `phonemes`).
 * @param seconds   Length of the audio in seconds.
 * @param tokens    The tokens the text was made from, in order.
 * @returns Start time in seconds for each token.
 */
export function tokenStarts(phonemes: string[], durations: number[], seconds: number, tokens: string[]): number[] {
  if (!tokens.length) return [];
  const total = durations.reduce((a, b) => a + b, 0);
  const perFrame = total > 0 ? seconds / total : 0;
  const starts: number[] = [];
  let acc = 0;
  for (const d of durations) {
    starts.push(acc * perFrame);
    acc += d;
  }
  // Spoken words: runs of voiced phonemes between spaces
  const words: number[] = [];
  const voiced: number[] = [];
  let inWord = false;
  phonemes.forEach((p, i) => {
    if (p === " " || p === "") { inWord = false; return; }
    if (PUNCT.has(p)) return;
    voiced.push(starts[i]);
    if (!inWord) { words.push(starts[i]); inWord = true; }
  });
  const wordTokens = tokens.map((t) => hasWord(t));
  const nWordTokens = wordTokens.filter(Boolean).length;
  const out: number[] = new Array(tokens.length).fill(0);
  if (words.length === nWordTokens && nWordTokens > 0) {
    let j = 0;
    tokens.forEach((_, i) => { out[i] = wordTokens[i] ? words[j++] : (words[j] ?? words[words.length - 1] ?? 0); });
    return out.map(round);
  }
  if (!voiced.length) {
    return tokens.map((_, i) => round((i * seconds) / tokens.length));
  }
  const weights = tokens.map((t) => [...t].filter((c) => /[\p{L}\p{N}]/u.test(c)).length);
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  let before = 0;
  tokens.forEach((_, i) => {
    const idx = Math.min(voiced.length - 1, Math.round((before / sum) * voiced.length));
    out[i] = voiced[idx];
    before += weights[i];
  });
  return out.map(round);
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/** 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array, rate: number): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}
