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

const SKIP = new Set([" ", "ˈ", "ˌ"]); // spaces and stress marks don't take part in matching

/**
 * Which token each character of a clause's phonemes belongs to.
 *
 * espeak phonemises a clause as a whole (natural stress, words sometimes
 * merged: "have been" -> "hɐvbɪn"), while each token phonemised alone gives
 * its own phonemes. The two are aligned character by character with an edit
 * distance, which is monotonic, so every token gets one contiguous stretch of
 * the clause's phonemes. Stress marks go with the sound after them, spaces
 * with the sound before.
 */
export function alignPhonemes(tokenPhonemes: string[], clause: string): number[] {
  const a: { c: string; t: number }[] = [];
  tokenPhonemes.forEach((p, t) => { for (const c of p) if (!SKIP.has(c)) a.push({ c, t }); });
  const chars = [...clause];
  const bIdx: number[] = [];
  chars.forEach((c, i) => { if (!SKIP.has(c)) bIdx.push(i); });
  const n = a.length, m = bIdx.length;
  const out: number[] = new Array(chars.length).fill(-1);
  if (!n || !m) return out.map(() => (n ? a[0].t : 0));
  // DP with a cheap substitution for vowel/consonant variants is overkill; unit costs work well
  const w = m + 1;
  const d = new Uint32Array((n + 1) * w);
  for (let j = 0; j <= m; j++) d[j] = j;
  for (let i = 1; i <= n; i++) {
    d[i * w] = i;
    const ai = a[i - 1].c;
    for (let j = 1; j <= m; j++) {
      const sub = d[(i - 1) * w + j - 1] + (ai === chars[bIdx[j - 1]] ? 0 : 1);
      const del = d[(i - 1) * w + j] + 1;
      const ins = d[i * w + j - 1] + 1;
      d[i * w + j] = Math.min(sub, del, ins);
    }
  }
  // Backtrace: give each clause sound the token of the token sound it lines up with
  const tokOfB: number[] = new Array(m).fill(-1);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    const here = d[i * w + j];
    const sub = d[(i - 1) * w + j - 1] + (a[i - 1].c === chars[bIdx[j - 1]] ? 0 : 1);
    if (here === sub) { tokOfB[j - 1] = a[i - 1].t; i--; j--; }
    else if (here === d[(i - 1) * w + j] + 1) i--;
    else { tokOfB[j - 1] = a[Math.max(0, i - 1)].t; j--; }
  }
  for (; j > 0; j--) tokOfB[j - 1] = a[0].t;
  // Keep the mapping monotonic
  for (let k = 1; k < m; k++) if (tokOfB[k] < tokOfB[k - 1]) tokOfB[k] = tokOfB[k - 1];
  bIdx.forEach((ci, k) => { out[ci] = tokOfB[k]; });
  // Stress marks take the next sound's token; spaces the previous one's
  for (let k = chars.length - 1, next = out[bIdx[m - 1]]; k >= 0; k--) {
    if (out[k] >= 0) next = out[k];
    else if (chars[k] !== " ") out[k] = next;
  }
  for (let k = 0, prev = out.find((v) => v >= 0) ?? 0; k < chars.length; k++) {
    if (out[k] >= 0) prev = out[k];
    else out[k] = prev;
  }
  return out;
}
