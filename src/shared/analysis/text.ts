/** Sentence splitting with character offsets, and per-token clean-up for speech. */

const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "mt", "fig", "figs", "eq", "eqs",
  "no", "nos", "vs", "etc", "e.g", "i.e", "al", "approx", "sec", "secs", "ch", "chap",
  "vol", "vols", "pp", "p", "ed", "eds", "inc", "ltd", "co", "corp", "u.s", "u.k", "ref",
  "refs", "cf", "ca", "min", "max", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep",
  "sept", "oct", "nov", "dec", "dept", "est", "tab", "app", "appx", "viz", "resp", "incl",
  "ex", "nr", "op", "art", "para", "rev", "ver", "v", "pg",
]);

// A sentence ends at . ! ? (plus closing quotes/brackets) followed by space and
// something that can start a sentence.
const BOUNDARY = /[.!?]+["'”’)\]]*(?=\s+["'“‘(\[]?[A-Z0-9À-ɏ])/g;
const SOFT_SPLIT = /[;:]\s|,\s|\s[–—-]\s/g;
export const MAX_SENTENCE = 320;

function isAbbreviation(text: string, dot: number): boolean {
  if (text[dot] !== ".") return false;
  let i = dot;
  while (i > 0 && !/\s/.test(text[i - 1]) && !"([\"'".includes(text[i - 1])) i--;
  const word = text.slice(i, dot).toLowerCase().replace(/\.+$/, "");
  if (!word) return false;
  if (ABBREVIATIONS.has(word)) return true;
  if (word.length === 1 && /\p{L}/u.test(word)) return true; // initials
  if (/^(?:[a-z]\.)+[a-z]$/.test(word)) return true; // U.S.A
  return false;
}

/** (start, end) offsets of the sentences in `text`, trimmed of whitespace. */
export function splitSentences(text: string): [number, number][] {
  const spans: [number, number][] = [];
  let start = 0;
  BOUNDARY.lastIndex = 0;
  for (let m = BOUNDARY.exec(text); m; m = BOUNDARY.exec(text)) {
    if (isAbbreviation(text, m.index)) continue;
    // "1." / "2.3." / "A." / "iv." opening a heading or list item is a number, not a sentence
    if (/^\s*(?:\d+(?:\.\d+)*|[A-Za-z]|[ivxIVX]{1,5})$/.test(text.slice(start, m.index))) continue;
    const end = m.index + m[0].length;
    spans.push([start, end]);
    start = end;
  }
  spans.push([start, text.length]);
  const out: [number, number][] = [];
  for (let [s, e] of spans) {
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s) out.push(...splitLong(text, s, e));
  }
  return out;
}

function splitLong(text: string, s: number, e: number): [number, number][] {
  if (e - s <= MAX_SENTENCE) return [[s, e]];
  const mid = s + Math.floor((e - s) / 2);
  let best = -1;
  SOFT_SPLIT.lastIndex = 0;
  const sub = text.slice(0, e - 60);
  for (let m = SOFT_SPLIT.exec(sub); m; m = SOFT_SPLIT.exec(sub)) {
    if (m.index < s + 60) continue;
    const cut = m.index + 1;
    if (best < 0 || Math.abs(cut - mid) < Math.abs(best - mid)) best = cut;
  }
  if (best < 0) {
    const left = text.lastIndexOf(" ", mid);
    if (left <= s + 40) return [[s, e]];
    best = left;
  }
  let aEnd = best;
  while (aEnd > s && /\s/.test(text[aEnd - 1])) aEnd--;
  let bStart = best;
  while (bStart < e && /\s/.test(text[bStart])) bStart++;
  return [...splitLong(text, s, aEnd), ...splitLong(text, bStart, e)];
}

/**
 * Normalise one word (or a few) before it goes to the TTS engine.
 *
 * Works token by token so word positions survive: a token can grow
 * ("3–5" -> "3 to 5") or become empty, but never merges with its neighbours.
 */
export function cleanToken(token: string): string {
  let t = token.normalize("NFKC");
  t = t.replace(/…/g, "...");
  t = t.replace(/[·•▪●◦|]/g, " ");
  t = t.replace(/(?<=\d)\s?–\s?(?=\d)/g, " to ");
  t = t.replace(/\s*[–—]\s*/g, ", ");
  t = t.replace(/\(\s*\)|\[\s*\]/g, "");
  t = t.split(/\s+/).filter(Boolean).join(" ");
  if (!/[\p{L}\p{N}]/u.test(t)) t = [...t].filter((c) => ".,;:!?".includes(c)).join("");
  return t.trim();
}
