/**
 * Kokoro's text front end, per token.
 *
 * Adapted from kokoro-js (Apache-2.0, https://github.com/hexgrad/kokoro),
 * which normalises a whole string and phonemises it in one go. Here the same
 * normalisation runs on each reader token, and the phonemes of every clause
 * are assigned back to the tokens they came from. The voice then gets
 * exactly the phonemes kokoro-js would give it, and we know which input ids
 * belong to which word on the page.
 */

import { phonemize } from "phonemizer";
import { alignPhonemes } from "../../shared/tts-align";

const PUNCT = ';:,.!?¡¿—…"«»“”(){}[]';
const PUNCT_RUN = new RegExp(`(\\s*[${PUNCT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}]+\\s*)+`, "g");

function year(e: string): string {
  if (e.includes(".")) return e;
  if (e.includes(":")) {
    const [h, m] = e.split(":").map(Number);
    return m === 0 ? `${h} o'clock` : m < 10 ? `${h} oh ${m}` : `${h} ${m}`;
  }
  const a = parseInt(e.slice(0, 4), 10);
  if (a < 1100 || a % 1000 < 10) return e;
  const t = e.slice(0, 2), r = parseInt(e.slice(2, 4), 10), s = e.endsWith("s") ? "s" : "";
  if (a % 1000 >= 100 && a % 1000 <= 999) {
    if (r === 0) return `${t} hundred${s}`;
    if (r < 10) return `${t} oh ${r}${s}`;
  }
  return `${t} ${r}${s}`;
}

function money(e: string): string {
  const unit = e[0] === "$" ? "dollar" : "pound";
  if (isNaN(Number(e.slice(1)))) return `${e.slice(1)} ${unit}s`;
  if (!e.includes(".")) return `${e.slice(1)} ${unit}${e.slice(1) === "1" ? "" : "s"}`;
  const [a, b] = e.slice(1).split(".");
  const n = parseInt(b.padEnd(2, "0"), 10);
  const cents = e[0] === "$" ? (n === 1 ? "cent" : "cents") : n === 1 ? "penny" : "pence";
  return `${a} ${unit}${a === "1" ? "" : "s"} and ${n} ${cents}`;
}

function decimal(e: string): string {
  const [a, b] = e.split(".");
  return `${a} point ${b.split("").join(" ")}`;
}

/** Kokoro's normalisation for one token. `next` is the following token (for "Dr. Smith"). */
export function normalizeToken(text: string, next = ""): string {
  let t = text
    .replace(/[‘’]/g, "'").replace(/«/g, "“").replace(/»/g, "”").replace(/[“”]/g, '"')
    .replace(/\(/g, "«").replace(/\)/g, "»")
    .replace(/[^\S \n]/g, " ").replace(/ {2,}/g, " ");
  const capNext = /^[A-Z]/.test(next);
  if (capNext) {
    t = t.replace(/^D[Rr]\.$/, "Doctor").replace(/^(?:Mr\.|MR\.)$/, "Mister").replace(/^(?:Ms\.|MS\.)$/, "Miss").replace(/^(?:Mrs\.|MRS\.)$/, "Mrs");
  }
  if (!capNext) t = t.replace(/\betc\.$/i, "etc");
  return t
    .replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, year)
    .replace(/(?<=\d),(?=\d)/g, "")
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, money)
    .replace(/\d*\.\d+/g, decimal)
    .replace(/(?<=\d)-(?=\d)/g, " to ")
    .replace(/(?<=\d)S/g, " S")
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, "s")
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, "-")
    .trim();
}

/** Kokoro's phoneme fix-ups, applied to one word's phonemes. */
export function fixPhonemes(p: string, lang: string): string {
  let r = p
    .replace(/kəkˈoːɹoʊ/g, "kˈoʊkəɹoʊ").replace(/kəkˈɔːɹəʊ/g, "kˈəʊkəɹəʊ")
    .replace(/ʲ/g, "j").replace(/r/g, "ɹ").replace(/x/g, "k").replace(/ɬ/g, "l")
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, " ");
  if (lang === "en-us") r = r.replace(/(?<=nˈaɪn)ti(?!ː)/g, "di");
  return r;
}

export interface Piece {
  token: number;
  /** Phoneme text (words separated by spaces), or punctuation passed through as is. */
  text: string;
}

interface Chunk { token: number; text: string; punct: boolean }

function chunks(token: number, text: string): Chunk[] {
  const out: Chunk[] = [];
  let last = 0;
  PUNCT_RUN.lastIndex = 0;
  for (const m of text.matchAll(PUNCT_RUN)) {
    if (m.index! > last) out.push({ token, text: text.slice(last, m.index), punct: false });
    if (m[0]) out.push({ token, text: m[0], punct: true });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ token, text: text.slice(last), punct: false });
  return out;
}

const words = (s: string) => s.split(/\s+/).filter(Boolean);
const phon = async (text: string, lang: string) => (await phonemize(text, lang)).join(" ");

/**
 * Phonemes for a sentence, as pieces that each belong to one token.
 * Each clause (text between punctuation) is phonemised as a whole, for
 * natural stress, and its phoneme words are shared out to the tokens by how
 * many words each token produces on its own.
 */
export async function phonemizeTokens(tokens: string[], lang: string): Promise<Piece[]> {
  const espeakLang = lang === "en-us" ? "en-us" : "en";
  const all: Chunk[] = [];
  tokens.forEach((t, i) => {
    if (!t) return;
    const norm = normalizeToken(t, tokens[i + 1] ?? "");
    const cs = chunks(i, norm);
    // Tokens are separated by a space. Next to punctuation the space goes
    // with the punctuation (as in kokoro-js); between words it stays in the clause.
    const last = all[all.length - 1];
    if (last && cs.length) {
      if (last.punct) last.text = last.text.replace(/\s*$/, " ");
      else cs[0] = { ...cs[0], text: " " + cs[0].text };
    }
    all.push(...cs);
  });
  const pieces: Piece[] = [];
  let i = 0;
  while (i < all.length) {
    if (all[i].punct) {
      pieces.push({ token: all[i].token, text: all[i].text });
      i++;
      continue;
    }
    // A clause: consecutive text chunks
    const clause: Chunk[] = [];
    while (i < all.length && !all[i].punct) clause.push(all[i++]);
    const clauseText = clause.map((c) => c.text).join("");
    const whole = words(await phon(clauseText, espeakLang)).map((w) => fixPhonemes(w, espeakLang)).join(" ");
    const own = await Promise.all(clause.map(async (c) => (c.text.trim() ? fixPhonemes(await phon(c.text.trim(), espeakLang), espeakLang) : "")));
    const owner = alignPhonemes(own, whole);
    // Contiguous stretches of the clause's phonemes, one piece per token
    const lead = pieces.length && !isPunct(pieces[pieces.length - 1]) ? " " : "";
    let cur = -1, buf = lead;
    [...whole].forEach((ch, k) => {
      const t = clause[owner[k]]?.token ?? clause[0].token;
      if (t !== cur && cur >= 0) { pieces.push({ token: cur, text: buf }); buf = ""; }
      cur = t;
      buf += ch;
    });
    if (cur >= 0 && buf) pieces.push({ token: cur, text: buf });
  }
  return pieces;
}

const isPunct = (p: Piece) => /^[\s;:,.!?¡¿—…"«»“”(){}[\]]*$/.test(p.text);
