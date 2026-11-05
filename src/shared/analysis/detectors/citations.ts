/** Citations, URLs, footnotes and the References section. */

import {
  BODY, CAPTION, FIGURE_TEXT, FOOTER, FOOTNOTE, HEADER, HEADING, PAGE_NUMBER, REFERENCES,
  SPAN_CITATION, SPAN_FOOTNOTE_MARK, SPAN_URL, TABLE,
  type Block, type Document, type Span, allBlocks, label, regionContains,
} from "../model";
import type { Detector } from "./types";

// --------------------------------------------------------------------------- inline

const BRACKET_RE = /\[\s*(?:\d{1,4}(?:\s*[,–—-]\s*\d{1,4})*|[A-Z][A-Za-z+]{1,12}\d{2,4}[a-z]?(?:\s*[,;]\s*[A-Z][A-Za-z+]{1,12}\d{2,4}[a-z]?)*)\s*\]/g;
const PAREN_RE = /\(([^()]{4,240})\)/g;
const YEAR = String.raw`(?:1[89]|20)\d{2}[a-z]?`;
const NAME = String.raw`\p{Lu}[\p{L}\p{N}'’\-]+`;
const LEAD = String.raw`(?:(?:see|e\.g\.,?|cf\.|i\.e\.,?)\s+)?`;
const AUTHOR_PART_RE = new RegExp(
  String.raw`^${LEAD}${NAME}(?:(?:\s+|,\s*)(?:et\s+al\.?|and|&|${NAME}|van|von|de|der|da|del|la|le))*,?\s+${YEAR}(?:\s*,\s*${YEAR})*(?:\s*,\s*(?:pp?\.|ch\.|sec\.)\s*\d+(?:[\-–]\d+)?)?$`,
  "u",
);
const NOT_AUTHORS = new Set([
  "january", "february", "march", "april", "may", "june", "july", "august", "september",
  "october", "november", "december", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep",
  "sept", "oct", "nov", "dec", "rev", "revision", "version", "ver", "fy", "q1", "q2", "q3",
  "q4", "spring", "summer", "fall", "autumn", "winter", "est", "since", "circa", "updated",
  "issued", "published", "effective", "as", "in", "by", "from", "until", "through", "the",
]);
const YEAR_ONLY_RE = new RegExp(String.raw`\(\s*${YEAR}(?:\s*[,;]\s*${YEAR})*\s*\)`, "g");
const NARRATIVE_RE = /(?:et al\.?|\p{Lu}\p{Ll}+(?:\s+(?:and|&)\s+\p{Lu}\p{Ll}+)?)\s*$/u;
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"]+/gi;
const DOI_RE = /\b(?:doi:\s*|https?:\/\/doi\.org\/)?10\.\d{4,9}\/[^\s<>"]+/gi;
const TRAILING = /[.,;:!?)\]}'"]+$/;
const MARK_RE = /^(?:\d{1,3}(?:[,–-]\d{1,3})*|[*†‡§¶]+|[a-z])$/;
const UNITS = new Set(["m", "cm", "mm", "km", "s", "ms", "ft", "in", "kg", "g", "x", "y", "z", "n", "e", "m/s"]);

function isAuthorYear(inner: string): boolean {
  const parts = inner.split(";").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return false;
  for (const p of parts) {
    if (!AUTHOR_PART_RE.test(p)) return false;
    const first = p.replace(/^(?:see|e\.g\.,?|cf\.|i\.e\.,?)\s+/i, "").split(/\s+/)[0].replace(/,$/, "").toLowerCase();
    if (NOT_AUTHORS.has(first)) return false;
  }
  return true;
}

function hostOf(url: string): string {
  try {
    const u = new URL(url.includes("://") ? url : "http://" + url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function findInline(text: string): Span[] {
  const spans: Span[] = [];
  const add = (start: number, end: number, kind: Span["kind"], replacement = "") => spans.push({ start, end, kind, replacement });
  for (const m of text.matchAll(BRACKET_RE)) add(m.index!, m.index! + m[0].length, SPAN_CITATION);
  for (const m of text.matchAll(PAREN_RE)) if (isAuthorYear(m[1].trim())) add(m.index!, m.index! + m[0].length, SPAN_CITATION);
  for (const m of text.matchAll(YEAR_ONLY_RE)) {
    // "Smith et al. (2020)": keep the names, drop the year
    if (NARRATIVE_RE.test(text.slice(Math.max(0, m.index! - 40), m.index!))) add(m.index!, m.index! + m[0].length, SPAN_CITATION);
  }
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(TRAILING, "");
    add(m.index!, m.index! + url.length, SPAN_URL, hostOf(url));
  }
  for (const m of text.matchAll(DOI_RE)) {
    const doi = m[0].replace(TRAILING, "");
    add(m.index!, m.index! + doi.length, SPAN_URL);
  }
  return spans;
}

export function footnoteMarks(b: Block): Span[] {
  const out: Span[] = [];
  b.words.forEach((w, i) => {
    if (!w.sup || !MARK_RE.test(w.text) || i === 0) return; // i == 0: the footnote's own marker
    const prev = b.words[i - 1];
    if (prev.sup) return;
    const p = prev.text;
    // Exponents: "10³", "m²"
    if (/\d$/.test(p) || UNITS.has(p.toLowerCase().replace(/[.,]+$/, "")) || (p.length < 3 && /\p{L}$/u.test(p))) return;
    out.push({ start: w.start, end: w.end, kind: SPAN_FOOTNOTE_MARK, replacement: "" });
  });
  return out;
}

export function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) {
      if (s.end > last.end) last.end = s.end;
      continue;
    }
    out.push({ ...s });
  }
  return out;
}

const INLINE_KINDS = new Set<string>([BODY, HEADING, CAPTION, FOOTNOTE]);

export const citationDetector: Detector = {
  name: "inline_citations",
  group: "citations",
  run(doc: Document) {
    for (const b of allBlocks(doc)) {
      if (!INLINE_KINDS.has(b.kind) || !b.text) continue;
      b.spans = mergeSpans([...b.spans, ...findInline(b.text), ...footnoteMarks(b)]);
    }
  },
};

// --------------------------------------------------------------------------- footnotes

const FOOTNOTE_START_RE = /^\s*(?:\d{1,3}|[*†‡§¶]+)[\s.)]?\s*\S/;

/** Small-font notes at the bottom of a page, below all body-size text. */
export const footnoteDetector: Detector = {
  name: "footnotes",
  group: "citations",
  run(doc: Document) {
    const body = doc.bodySize;
    for (const page of doc.pages) {
      const h = page.height;
      const bodyBlocks = page.blocks.filter((b) => (b.kind === BODY || b.kind === HEADING) && b.size >= 0.95 * body);
      const floor = Math.max(0, ...bodyBlocks.map((b) => b.bottom));
      const cands = page.blocks
        .filter((b) => b.kind === BODY && b.size <= 0.9 * body && b.top >= 0.5 * h && b.top >= floor - 2 &&
          !page.regions.some((r) => regionContains(r, (b.x0 + b.x1) / 2, (b.top + b.bottom) / 2)))
        .sort((a, b) => a.top - b.top);
      let started = false;
      for (const b of cands) {
        if (!started) {
          const marker = FOOTNOTE_START_RE.test(b.text) || (b.words.length > 0 && b.words[0].sup);
          const rule = page.rules.some((r) => b.top - 20 <= r[1] && r[1] <= b.top + 1 && Math.abs(r[0] - b.x0) <= 25 && r[2] - r[0] < 0.6 * page.width);
          started = marker || rule;
        }
        if (started) label(b, FOOTNOTE, "Small text at the foot of the page");
      }
    }
  },
};

// --------------------------------------------------------------------------- references

const REF_HEAD_RE = /^(?:\d+(?:\.\d+)*\.?\s+|[A-Z]\.\s+|[IVX]+\.\s+)?(?:references|bibliography|works cited|literature cited|reference list|cited works|references and notes|cited literature|sources)\s*:?$/i;
const APPENDIX_RE = /^(?:\d+(?:\.\d+)*\.?\s+|[A-Z]\.?\s+)?(?:appendix|appendices|annex)\b/i;
const REF_ENTRY_RE = /(?:^\s*\[\d+\])|(?:^\s*\d{1,3}\.\s)|(?:\b(?:1[89]|20)\d{2}[a-z]?\b)/;
const SKIPPED = new Set<string>([HEADER, FOOTER, PAGE_NUMBER]);
const CLAIMABLE = new Set<string>([BODY, HEADING, CAPTION, FIGURE_TEXT, FOOTNOTE, TABLE]);

/**
 * The References / Bibliography section, from its heading onward. It stops
 * at a following "Appendix" heading so appendices are still read.
 */
export const referencesDetector: Detector = {
  name: "references",
  group: "citations",
  run(doc: Document) {
    const blocks = allBlocks(doc).filter((b) => !SKIPPED.has(b.kind));
    const nPages = doc.pages.length;
    let start = -1;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.lines.length > 2 || b.text.includes("....") || !REF_HEAD_RE.test(b.text.trim())) continue;
      if (b.size < 0.95 * doc.bodySize && b.boldFrac < 0.5) continue;
      if (nPages > 2 && b.page < 0.4 * (nPages - 1)) continue; // most likely a contents entry
      if (!blocks.slice(i + 1, i + 6).some((f) => REF_ENTRY_RE.test(f.text))) continue;
      start = i;
      break;
    }
    if (start < 0) return;
    label(blocks[start], REFERENCES, "References section heading");
    for (const b of blocks.slice(start + 1)) {
      if (b.lines.length <= 2 && APPENDIX_RE.test(b.text.trim()) && (b.size > 1.05 * doc.bodySize || b.boldFrac > 0.5)) break;
      if (CLAIMABLE.has(b.kind)) label(b, REFERENCES, "In the References section");
    }
  },
};
