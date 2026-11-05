/** Whole-document analysis: extraction, detectors, headings, sections, sentences. */

import { GROUPS, runDetectors, type SkipGroup } from "./detectors";
import { extractPage, type PageLike } from "./extract";
import { BODY, HEADING, REFERENCES, type Block, type Box, type Document, type Page, type Section, allBlocks, groupOf } from "./model";
import { splitSentences } from "./text";

/** The parts of a PDF.js PDFDocumentProxy that analysis needs. */
export interface DocumentLike {
  numPages: number;
  getPage(n: number): Promise<PageLike & { cleanup?(): void }>;
  getOutline(): Promise<OutlineItem[] | null>;
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
}
interface OutlineItem { title: string; dest: string | unknown[] | null; items: OutlineItem[] }

const NUMBERED_RE = /^(?:(?:chapter|section|part)\s+)?(\d+(?:\.\d+){0,4})\.?\s+\S/i;
const LETTERED_RE = /^(?:appendix\s+)?[A-Z](?:\.\d+)*[.)]?\s+[A-Z]/;

export function bodySize(doc: Document): number {
  const weights = new Map<number, number>();
  for (const b of allBlocks(doc)) {
    if (b.kind !== BODY) continue;
    const k = Math.round(b.size * 2) / 2;
    weights.set(k, (weights.get(k) ?? 0) + b.text.length);
  }
  let best = 10, bw = -1;
  for (const [k, v] of weights) if (v > bw) { best = k; bw = v; }
  return best;
}

// --------------------------------------------------------------------------- headings

function headingLike(b: Block, body: number): boolean {
  const text = b.text.trim();
  if (b.lines.length > 3 || text.length < 2 || text.length > 160 || !/\p{L}{2}/u.test(text)) return false;
  const nWords = text.split(/\s+/).length;
  if (nWords > 20) return false;
  const last = text[text.length - 1];
  if (last === "," || last === ";" || (last === "." && nWords > 6)) return false;
  if (b.size >= 1.15 * body) return true;
  const numbered = NUMBERED_RE.test(text) || LETTERED_RE.test(text);
  if (b.boldFrac >= 0.85 && b.size >= 0.95 * body && nWords <= 14) return true;
  return numbered && (b.boldFrac >= 0.5 || b.size >= 1.05 * body) && nWords <= 14;
}

export function detectHeadings(doc: Document): Block[] {
  const body = doc.bodySize;
  const heads = allBlocks(doc).filter(
    (b) => (b.kind === BODY || (b.kind === REFERENCES && b.reason.endsWith("heading"))) && headingLike(b, body),
  );
  const key = (b: Block) => Math.round(b.size * 2) / 2;
  const sizes = [...new Set(heads.filter((b) => b.size >= 1.15 * body).map(key))].sort((a, b) => b - a);
  for (const b of heads) {
    const m = NUMBERED_RE.exec(b.text.trim());
    if (m && b.size < 1.15 * body) b.level = Math.min(4, m[1].split(".").length + (sizes.length ? 1 : 0));
    else if (b.size >= 1.15 * body) b.level = Math.min(4, sizes.indexOf(key(b)) + 1);
    else b.level = Math.min(4, sizes.length + 1);
    if (b.kind === BODY) {
      b.kind = HEADING;
      b.reason = "Heading (larger or bold text)";
    }
  }
  return heads;
}

// --------------------------------------------------------------------------- sections

function blockAt(blocks: Block[], top: number | null): Block | null {
  if (!blocks.length) return null;
  if (top === null) {
    const readable = blocks.filter((b) => !["header", "footer", "page_number"].includes(b.kind));
    return (readable.length ? readable : blocks)[0];
  }
  const below = blocks.filter((b) => b.bottom >= top - 4);
  if (!below.length) return blocks[blocks.length - 1];
  return below.reduce((best, b) => {
    const kb = Math.max(0, b.top - top), kbest = Math.max(0, best.top - top);
    return kb < kbest || (kb === kbest && b.top < best.top) ? b : best;
  });
}

export async function outlineSections(pdf: DocumentLike, doc: Document): Promise<Section[]> {
  let outline: OutlineItem[] | null = null;
  try { outline = await pdf.getOutline(); } catch { return []; }
  if (!outline?.length) return [];
  const out: Section[] = [];
  const walk = async (items: OutlineItem[], level: number) => {
    for (const it of items) {
      try {
        let dest = it.dest;
        if (typeof dest === "string") dest = await pdf.getDestination(dest);
        if (Array.isArray(dest) && dest.length) {
          const index = typeof dest[0] === "number" ? (dest[0] as number) : await pdf.getPageIndex(dest[0]);
          const page = doc.pages[index];
          if (page) {
            const mode = (dest[1] as { name?: string } | undefined)?.name;
            let y: number | null = null;
            if (mode === "XYZ" && typeof dest[3] === "number") y = dest[3] as number;
            else if ((mode === "FitH" || mode === "FitBH") && typeof dest[2] === "number") y = dest[2] as number;
            const b = blockAt(page.blocks, y === null ? null : page.height - y);
            const title = (it.title || "").trim();
            if (b && title) out.push({ title, level, page: index, block: b.id, source: "outline" });
          }
        }
      } catch { /* broken destination: skip it */ }
      if (it.items?.length && level < 6) await walk(it.items, level + 1);
    }
  };
  await walk(outline, 1);
  return out;
}

// --------------------------------------------------------------------------- pipeline

export async function analyze(pdf: DocumentLike, name: string, progress?: (done: number, total: number) => void): Promise<Document> {
  const pages: Page[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = await pdf.getPage(i);
    pages.push(await extractPage(p, i - 1));
    try { p.cleanup?.(); } catch { /* ignore */ }
    progress?.(i, pdf.numPages);
  }
  const doc: Document = { name, pages, bodySize: 10, sections: [] };
  allBlocks(doc).forEach((b, i) => { b.id = i; });
  doc.bodySize = bodySize(doc);
  runDetectors(doc);
  const heads = detectHeadings(doc);
  for (const b of allBlocks(doc)) b.sentences = b.text ? splitSentences(b.text) : [];
  doc.sections = await outlineSections(pdf, doc);
  if (!doc.sections.length) {
    doc.sections = heads.map((b) => ({ title: b.text.split(/\s+/).join(" "), level: b.level, page: b.page, block: b.id, source: "headings" as const }));
  }
  return doc;
}

// --------------------------------------------------------------------------- view data

/** Compact form of a document for the UI (and for tests that inspect output). */
export interface BlockData {
  id: number;
  p: number;
  box: Box;
  kind: string;
  group: string;
  why: string;
  size: number;
  text: string;
  /** Words: [x0, top, x1, bottom, start, end, line] */
  w: [number, number, number, number, number, number, number][];
  /** Sentences: [start, end] */
  s: [number, number][];
  /** Spans: [start, end, kind, group, replacement] */
  sp: [number, number, string, string, string][];
  lvl?: number;
  rows?: { box: Box; cells: string[] }[];
}
export interface DocData {
  name: string;
  bodySize: number;
  pages: { w: number; h: number; regions: Box[] }[];
  blocks: BlockData[];
  sections: Section[];
  groups: SkipGroup[];
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export function toData(doc: Document): DocData {
  return {
    name: doc.name,
    bodySize: doc.bodySize,
    pages: doc.pages.map((p) => ({ w: r1(p.width), h: r1(p.height), regions: p.regions.map((r) => [r1(r.x0), r1(r.top), r1(r.x1), r1(r.bottom)] as Box) })),
    blocks: allBlocks(doc).map((b) => {
      const d: BlockData = {
        id: b.id,
        p: b.page,
        box: [r1(b.x0), r1(b.top), r1(b.x1), r1(b.bottom)],
        kind: b.kind,
        group: groupOf(b.kind),
        why: b.reason,
        size: r1(b.size),
        text: b.text,
        w: b.words.map((w) => [r1(w.x0), r1(w.top), r1(w.x1), r1(w.bottom), w.start, w.end, w.line]),
        s: b.sentences,
        sp: b.spans.map((s) => [s.start, s.end, s.kind, groupOf(s.kind), s.replacement]),
      };
      if (b.kind === HEADING || b.level) d.lvl = b.level;
      if (b.table) d.rows = b.table.map((r) => ({ box: r.box.map(r1) as Box, cells: r.cells }));
      return d;
    }),
    sections: doc.sections,
    groups: GROUPS,
  };
}

export function summary(doc: Document): { pages: number; blocks: Record<string, number>; spans: Record<string, number>; sections: number } {
  const blocks: Record<string, number> = {}, spans: Record<string, number> = {};
  for (const b of allBlocks(doc)) {
    blocks[b.kind] = (blocks[b.kind] ?? 0) + 1;
    for (const s of b.spans) spans[s.kind] = (spans[s.kind] ?? 0) + 1;
  }
  return { pages: doc.pages.length, blocks, spans, sections: doc.sections.length };
}
