/**
 * Pronunciations: how written forms are spoken ("kW" -> "kilowatts").
 *
 * Works on the reader's tokens (one per displayed word) and returns the
 * spoken text for each token, so every spoken word still belongs to the word
 * on the page it came from: "kW" stays highlighted while "kilowatts" is said.
 * Runs before the voice engine's own number handling, so "5 kW" reaches it as
 * "5 kilowatts" and is read "five kilowatts".
 */

export interface PronEntry {
  id: string;
  /** Written form (or a regular expression when `regex` is set). */
  written: string;
  /** Spoken form; for units the plural ("kilowatts"). */
  spoken: string;
  /** Spoken form after exactly "1" ("kilowatt"). Optional. */
  singular?: string;
  enabled: boolean;
  /** Match the whole word only (default). Otherwise replace inside words. */
  wholeWord: boolean;
  /** Match case exactly (default): mA is not MA. */
  caseSensitive: boolean;
  /** Only right after a number ("5 V", "5V"); a lone "V" in prose is left alone. */
  afterNumber: boolean;
  /** Treat `written` as a regular expression applied inside the word. */
  regex?: boolean;
  /** Set on built-in entries ("engineering"). */
  pack?: string;
}

export interface Lexicon {
  version: 1;
  entries: PronEntry[];
}

// Characters with look-alikes that should match each other
function fold(s: string): string {
  return s.replace(/µ/g, "μ").replace(/Ω/g, "Ω");
}

const NUMBER = String.raw`[~±≈<>≤≥]?\d+(?:[.,]\d+)*(?:\s?[–—-]\s?\d+(?:[.,]\d+)*)?`;
const NUMBER_RE = new RegExp(`^${NUMBER}$`);
const LEAD_RE = /^[("'“‘[{]+/;
const TRAIL_RE = /[)\]}"'”’.,;:!?]+$/;

export function isNumberToken(t: string): boolean {
  return NUMBER_RE.test(t.replace(LEAD_RE, "").replace(TRAIL_RE, ""));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Split "(5kW)," into "(", "5kW", "),". A trailing "." that ends a sentence stays in the tail. */
function splitPunct(token: string): [string, string, string] {
  const lead = LEAD_RE.exec(token)?.[0] ?? "";
  let rest = token.slice(lead.length);
  const trail = TRAIL_RE.exec(rest)?.[0] ?? "";
  rest = rest.slice(0, rest.length - trail.length);
  return [lead, rest, trail];
}

function unitForm(e: PronEntry, count: string | null): string {
  return count !== null && e.singular && /^1$/.test(count.trim()) ? e.singular : e.spoken;
}

/**
 * Spoken text for each token. `entries` are applied in order and the first
 * match wins, so put user entries before the starter pack.
 */
export function applyLexicon(tokens: string[], entries: PronEntry[]): string[] {
  const active = entries.filter((e) => e.enabled && e.written);
  if (!active.length) return [...tokens];
  const compiled = active.map((e) => {
    const flags = e.caseSensitive ? "u" : "iu";
    const w = fold(e.written);
    let inner: RegExp | null = null;
    if (e.regex) {
      try { inner = new RegExp(e.written, flags + "g"); } catch { inner = null; }
    }
    return {
      e,
      word: new RegExp(`^${escape(w)}$`, flags),
      attached: new RegExp(`^(${NUMBER})\\s?(${escape(w)})$`, flags),
      inside: e.wholeWord ? null : new RegExp(escape(w), flags + "g"),
      inner,
    };
  });
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const [lead, coreRaw, trail] = splitPunct(tokens[i]);
    const core = fold(coreRaw);
    const prev = i > 0 ? splitPunct(tokens[i - 1])[1] : "";
    const prevNumber = prev && NUMBER_RE.test(prev) ? prev : null;
    let spoken: string | null = null;
    for (const c of compiled) {
      if (c.e.regex) {
        if (c.inner && c.inner.test(core)) {
          c.inner.lastIndex = 0;
          spoken = core.replace(c.inner, c.e.spoken);
          break;
        }
        continue;
      }
      if (c.word.test(core)) {
        if (c.e.afterNumber && prevNumber === null) continue;
        spoken = unitForm(c.e, prevNumber);
        break;
      }
      const m = c.attached.exec(core);
      // "1990s" is a decade, not seconds
      if (m && !(c.e.written === "s" && /^\d{4}$/.test(m[1]))) {
        // "5kW", "5 kW" in one token, "4.8–7.1MHz"
        spoken = `${m[1]} ${unitForm(c.e, m[1])}`;
        break;
      }
      if (c.inside && !c.e.afterNumber && c.inside.test(core)) {
        c.inside.lastIndex = 0;
        spoken = core.replace(c.inside, c.e.spoken);
        break;
      }
    }
    out.push(spoken === null ? tokens[i] : lead + spoken + trail);
  }
  return out;
}

// --------------------------------------------------------------------------- starter pack

type Seed = [written: string, spoken: string, singular?: string, opts?: Partial<PronEntry>];
const AFTER = { afterNumber: true };
const ANYCASE = { caseSensitive: false };

const SEEDS: Seed[] = [
  ["W", "watts", "watt", AFTER],
  ["kW", "kilowatts", "kilowatt"],
  ["MW", "megawatts", "megawatt"],
  ["V", "volts", "volt", AFTER],
  ["mV", "millivolts", "millivolt"],
  ["kV", "kilovolts", "kilovolt"],
  ["A", "amps", "amp", AFTER],
  ["mA", "milliamps", "milliamp"],
  ["µA", "microamps", "microamp"],
  ["Hz", "hertz", "hertz"],
  ["kHz", "kilohertz", "kilohertz"],
  ["MHz", "megahertz", "megahertz"],
  ["GHz", "gigahertz", "gigahertz"],
  ["Ω", "ohms", "ohm"],
  ["mΩ", "milliohms", "milliohm"],
  ["kΩ", "kilohms", "kilohm"],
  ["MΩ", "megohms", "megohm"],
  ["ohm", "ohms", "ohm", { ...AFTER, ...ANYCASE }],
  ["F", "farads", "farad", AFTER],
  ["pF", "picofarads", "picofarad"],
  ["nF", "nanofarads", "nanofarad"],
  ["µF", "microfarads", "microfarad"],
  ["H", "henries", "henry", AFTER],
  ["nH", "nanohenries", "nanohenry"],
  ["µH", "microhenries", "microhenry"],
  ["mH", "millihenries", "millihenry"],
  ["s", "seconds", "second", AFTER],
  ["ns", "nanoseconds", "nanosecond", AFTER],
  ["µs", "microseconds", "microsecond", AFTER],
  ["ms", "milliseconds", "millisecond", AFTER],
  ["dB", "decibels", "decibel"],
  ["dBA", "decibels A", "decibel A"],
  ["°C", "degrees Celsius", "degree Celsius"],
  ["rms", "R M S", undefined, ANYCASE],
  ["pk-pk", "peak to peak", undefined, ANYCASE],
];

export const STARTER_PACK: PronEntry[] = SEEDS.map(([written, spoken, singular, opts]) => ({
  id: `eng-${written}`,
  written,
  spoken,
  ...(singular ? { singular } : {}),
  enabled: true,
  wholeWord: true,
  caseSensitive: true,
  afterNumber: false,
  pack: "engineering",
  ...opts,
}));

export function defaultLexicon(): Lexicon {
  return { version: 1, entries: STARTER_PACK.map((e) => ({ ...e })) };
}

/** User entries first (they override), then the starter pack, keeping each group's order. */
export function orderedEntries(entries: PronEntry[]): PronEntry[] {
  return [...entries.filter((e) => !e.pack), ...entries.filter((e) => e.pack)];
}

/** Validate and normalise imported JSON. Throws with a readable message. */
export function parseLexicon(json: unknown): Lexicon {
  const list = Array.isArray(json) ? json : (json as { entries?: unknown })?.entries;
  if (!Array.isArray(list)) throw new Error("Expected a list of pronunciations");
  const entries: PronEntry[] = list.map((raw, i) => {
    const r = raw as Partial<PronEntry>;
    if (typeof r.written !== "string" || !r.written.trim() || typeof r.spoken !== "string") {
      throw new Error(`Entry ${i + 1} needs "written" and "spoken"`);
    }
    return {
      id: typeof r.id === "string" && r.id ? r.id : `user-${Date.now().toString(36)}-${i}`,
      written: r.written.trim(),
      spoken: r.spoken,
      ...(typeof r.singular === "string" && r.singular ? { singular: r.singular } : {}),
      enabled: r.enabled !== false,
      wholeWord: r.wholeWord !== false,
      caseSensitive: r.caseSensitive !== false,
      afterNumber: !!r.afterNumber,
      ...(r.regex ? { regex: true } : {}),
      ...(typeof r.pack === "string" ? { pack: r.pack } : {}),
    };
  });
  return { version: 1, entries };
}
