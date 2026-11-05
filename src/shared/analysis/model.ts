/**
 * Data model shared by extraction, the detectors and the UI.
 *
 * Coordinates are PDF points with the origin at the top left of the page
 * (viewport space at scale 1): x grows to the right, `top` and `bottom` grow
 * downwards.
 */

export type Box = [x0: number, top: number, x1: number, bottom: number];

// Block kinds. "body" and "heading" are read; every other kind belongs to a
// skip group (see SKIP_GROUP) and is read or skipped according to the settings.
export const BODY = "body";
export const HEADING = "heading";
export const HEADER = "header";
export const FOOTER = "footer";
export const PAGE_NUMBER = "page_number";
export const TABLE = "table";
export const CAPTION = "caption";
export const FIGURE_TEXT = "figure_text";
export const FOOTNOTE = "footnote";
export const REFERENCES = "references";

export type BlockKind =
  | typeof BODY | typeof HEADING | typeof HEADER | typeof FOOTER | typeof PAGE_NUMBER
  | typeof TABLE | typeof CAPTION | typeof FIGURE_TEXT | typeof FOOTNOTE | typeof REFERENCES;

// Inline span kinds (parts of a block's text)
export const SPAN_CITATION = "citation";
export const SPAN_URL = "url";
export const SPAN_FOOTNOTE_MARK = "footnote_mark";
export type SpanKind = typeof SPAN_CITATION | typeof SPAN_URL | typeof SPAN_FOOTNOTE_MARK;

export type GroupId = "headers" | "tables" | "figures" | "citations";

export const SKIP_GROUP: Record<string, GroupId> = {
  header: "headers",
  footer: "headers",
  page_number: "headers",
  table: "tables",
  caption: "figures",
  figure_text: "figures",
  footnote: "citations",
  references: "citations",
  citation: "citations",
  url: "citations",
  footnote_mark: "citations",
};

export interface Word {
  text: string;
  x0: number;
  top: number;
  x1: number;
  bottom: number;
  size: number;
  bold: boolean;
  upright: boolean;
  /** Raised and smaller than the line: a superscript. */
  sup: boolean;
  /** Whether the text has a space before this word. */
  spaceBefore: boolean;
  /** Index of the line inside its block. */
  line: number;
  /** Character offsets into Block.text. */
  start: number;
  end: number;
}

export interface Line {
  words: Word[];
  x0: number;
  top: number;
  x1: number;
  bottom: number;
  /** Dominant font size of the line. */
  size: number;
}

export interface Span {
  start: number;
  end: number;
  kind: SpanKind;
  /** What to say instead when the span is skipped ("" = nothing). */
  replacement: string;
}

export interface TableRow {
  cells: string[];
  box: Box;
}

export interface Block {
  id: number;
  page: number;
  lines: Line[];
  x0: number;
  top: number;
  x1: number;
  bottom: number;
  size: number;
  text: string;
  words: Word[];
  kind: BlockKind;
  reason: string;
  /** Heading level (1 = top) for headings. */
  level: number;
  spans: Span[];
  sentences: [number, number][];
  table: TableRow[] | null;
  boldFrac: number;
}

/** A drawing or image area on a page (a figure, diagram or schematic). */
export interface Region {
  x0: number;
  top: number;
  x1: number;
  bottom: number;
  objects: number;
  hasImage: boolean;
}

export interface Page {
  index: number;
  width: number;
  height: number;
  blocks: Block[];
  regions: Region[];
  /** Short horizontal lines (footnote separators and the like). */
  rules: Box[];
}

export interface Section {
  title: string;
  level: number;
  page: number;
  block: number;
  source: "outline" | "headings";
}

export interface Document {
  name: string;
  pages: Page[];
  bodySize: number;
  sections: Section[];
}

export function allBlocks(doc: Document): Block[] {
  return doc.pages.flatMap((p) => p.blocks);
}

export function groupOf(kind: string): GroupId | "" {
  return SKIP_GROUP[kind] ?? "";
}

export function label(b: Block, kind: BlockKind, reason: string): void {
  b.kind = kind;
  b.reason = reason;
}

export function regionContains(r: Region, x: number, y: number, pad = 0): boolean {
  return r.x0 - pad <= x && x <= r.x1 + pad && r.top - pad <= y && y <= r.bottom + pad;
}

export function joinWords(words: Word[]): string {
  let out = "";
  words.forEach((w, i) => {
    if (i && w.spaceBefore) out += " ";
    out += w.text;
  });
  return out;
}
