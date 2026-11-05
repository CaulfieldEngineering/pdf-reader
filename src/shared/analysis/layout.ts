/**
 * Geometry: words to lines, lines to blocks (paragraphs), and reading order.
 *
 * 1. Words are clustered into rows by vertical overlap, and each row is split
 *    into segments where the horizontal gap is too wide to be a word space
 *    (columns, footer fields, scattered labels).
 * 2. Segments are merged into blocks by spacing, alignment and font.
 * 3. Blocks are put in reading order with a column-aware XY cut.
 */

import { BODY, type Block, type Line, type Word, joinWords } from "./model";

const BULLET_RE = /^(?:[•◦▪●‣⁃∙\-–·*]\s|\(?[0-9]{1,2}[.)]\s|\(?[a-z][.)]\s|\([ivx]{1,4}\)\s)/;
const SENTENCE_END_RE = /[.!?:;]["'”’)\]]*$/;

export function dominantSize(words: Word[]): number {
  const weights = new Map<number, number>();
  for (const w of words) {
    const k = Math.round(w.size * 10) / 10;
    weights.set(k, (weights.get(k) ?? 0) + w.text.length);
  }
  let best = 10, bestW = -1;
  for (const [k, v] of weights) {
    if (v > bestW || (v === bestW && k > best)) { best = k; bestW = v; }
  }
  return best;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function boldFrac(words: Word[]): number {
  const total = words.reduce((n, w) => n + w.text.length, 0) || 1;
  return words.reduce((n, w) => n + (w.bold ? w.text.length : 0), 0) / total;
}

// --------------------------------------------------------------------------- lines

interface Row { words: Word[]; top: number; bottom: number }

function rowAccepts(r: Row, w: Word): boolean {
  const ov = Math.min(r.bottom, w.bottom) - Math.max(r.top, w.top);
  const wh = w.bottom - w.top, rh = r.bottom - r.top;
  // Superscripts and subscripts overlap their line less, so a clearly
  // smaller word needs less overlap to join it.
  const smaller = wh < 0.9 * rh || rh < 0.9 * wh;
  return ov >= (smaller ? 0.3 : 0.5) * Math.min(wh, rh);
}

export function makeLine(words: Word[]): Line {
  words[0].spaceBefore = true;
  const main = words.filter((w) => !w.sup);
  return {
    words,
    x0: Math.min(...words.map((w) => w.x0)),
    top: Math.min(...(main.length ? main : words).map((w) => w.top)),
    x1: Math.max(...words.map((w) => w.x1)),
    bottom: Math.max(...words.map((w) => w.bottom)),
    size: dominantSize(words),
  };
}

/** Cluster words into rows, then split rows into segments at wide gaps. */
export function buildLines(words: Word[]): Line[] {
  const rows: Row[] = [];
  const upright = words.filter((w) => w.upright).sort((a, b) => a.top - b.top || a.x0 - b.x0);
  for (const w of upright) {
    let placed = false;
    for (let i = rows.length - 1; i >= Math.max(0, rows.length - 8); i--) {
      const r = rows[i];
      if (rowAccepts(r, w)) {
        r.words.push(w);
        // The row's core is the box of its largest word, so superscripts don't
        // stretch it into the neighbouring lines.
        if (w.bottom - w.top > r.bottom - r.top) { r.top = w.top; r.bottom = w.bottom; }
        placed = true;
        break;
      }
    }
    if (!placed) rows.push({ words: [w], top: w.top, bottom: w.bottom });
  }

  const lines: Line[] = [];
  for (const r of rows) {
    const ws = r.words.sort((a, b) => a.x0 - b.x0);
    const size = dominantSize(ws);
    const main = ws.filter((w) => w.size >= 0.9 * size);
    const baseline = median((main.length ? main : ws).map((w) => w.bottom));
    for (const w of ws) w.sup = w.size < 0.85 * size && w.bottom < baseline - 0.2 * size;
    // Text of clearly different sizes sharing a row (a footer printed over a
    // table, a label beside a paragraph) is kept apart; superscripts stay
    // with the word before them.
    const strata: Word[][] = [];
    let lastMain: Word[] | null = null;
    for (const w of ws) {
      if (w.sup && lastMain) { lastMain.push(w); continue; }
      let s = strata.find((st) => { const m = st.find((x) => !x.sup) ?? st[0]; return Math.abs(m.size - w.size) <= 0.12 * Math.max(m.size, w.size); });
      if (!s) { s = []; strata.push(s); }
      s.push(w);
      lastMain = s;
    }
    for (const st of strata) segmentRow(st, dominantSize(st), lines);
  }
  // Rotated words (vertical labels) each become their own line
  for (const w of words) if (!w.upright) lines.push(makeLine([w]));
  return lines;
}

function segmentRow(ws: Word[], size: number, lines: Line[]): void {
  {
    let seg: Word[] = [];
    for (const w of ws) {
      if (seg.length) {
        const prev = seg[seg.length - 1];
        const gap = w.x0 - prev.x1;
        if (gap > Math.max(1.6 * size, 6)) {
          lines.push(makeLine(seg));
          seg = [];
        } else {
          // A space in the text, a visible gap, or the end of a superscript
          // separates words; pieces of one word split by kerning or a font
          // change don't.
          w.spaceBefore = w.spaceBefore || gap > 0.15 * Math.min(size, w.size) || (prev.sup && !w.sup);
        }
      }
      seg.push(w);
    }
    if (seg.length) lines.push(makeLine(seg));
  }
}

// --------------------------------------------------------------------------- blocks

interface Draft { lines: Line[]; x0: number; top: number; x1: number; bottom: number; gap: number | null }

function lineText(l: Line): string {
  return joinWords(l.words);
}

function joins(d: Draft, ln: Line): boolean {
  const last = d.lines[d.lines.length - 1];
  const size = Math.max(ln.size, last.size);
  const ratio = ln.size / last.size;
  if (ratio < 0.88 || ratio > 1.14) return false;
  const gap = ln.top - last.bottom;
  if (gap < -0.45 * size) return false;
  const limit = d.gap !== null ? d.gap + 0.3 * size : 0.65 * size;
  if (gap > Math.max(limit, 0.25 * size)) return false;
  // Left aligned (allowing a hanging indent), or both centred
  const leftOk = Math.abs(ln.x0 - d.x0) <= 3 * size && ln.x1 <= d.x1 + 4 * size;
  const cxOk = Math.abs((ln.x0 + ln.x1) / 2 - (last.x0 + last.x1) / 2) <= 2 * size &&
    Math.min(ln.x1, last.x1) > Math.max(ln.x0, last.x0);
  if (!leftOk && !cxOk) return false;
  // A bold line followed by a regular one is a heading break
  const lb = boldFrac(last.words), nb = boldFrac(ln.words);
  if ((lb > 0.8 && nb < 0.3) || (lb < 0.3 && nb > 0.8)) return false;
  if (BULLET_RE.test(lineText(ln)) && ln.x0 <= d.x0 + size) return false;
  // Paragraph end: the previous line is clearly short and ends a sentence
  if (d.lines.length >= 2 && SENTENCE_END_RE.test(lineText(last)) && last.x1 < d.x1 - 3 * size) return false;
  return true;
}

export function buildBlocks(lines: Line[]): Line[][] {
  const drafts: Draft[] = [];
  const sorted = [...lines].sort((a, b) => a.top - b.top || a.x0 - b.x0);
  for (const ln of sorted) {
    let best: Draft | null = null, bestGap = Infinity;
    for (let i = Math.max(0, drafts.length - 16); i < drafts.length; i++) {
      const d = drafts[i];
      const last = d.lines[d.lines.length - 1];
      if (last.top >= ln.top - 0.2 * ln.size) continue; // not above this line
      if (joins(d, ln)) {
        const g = ln.top - last.bottom;
        if (g < bestGap) { best = d; bestGap = g; }
      }
    }
    if (best) {
      if (best.gap === null) best.gap = bestGap;
      best.lines.push(ln);
      best.x0 = Math.min(best.x0, ln.x0);
      best.x1 = Math.max(best.x1, ln.x1);
      best.bottom = Math.max(best.bottom, ln.bottom);
    } else {
      drafts.push({ lines: [ln], x0: ln.x0, top: ln.top, x1: ln.x1, bottom: ln.bottom, gap: null });
    }
  }
  return drafts.map((d) => d.lines);
}

/** Build a block's text and character offsets, joining hyphenated line breaks. */
export function finalizeBlock(lines: Line[], page: number): Block {
  const words: Word[] = [];
  let text = "";
  lines.forEach((ln, li) => {
    ln.words.forEach((w, wi) => {
      w.line = li;
      if (words.length) {
        const prev = words[words.length - 1];
        const hyphenJoin = wi === 0 && prev.text.endsWith("-") && prev.text.length > 2 &&
          /\p{L}/u.test(prev.text[prev.text.length - 2]) && /^\p{Ll}/u.test(w.text);
        if (hyphenJoin) {
          // "impor-" + "tant" -> "important": drop the hyphen from the text
          text = text.slice(0, -1);
          prev.end -= 1;
        } else if (wi === 0 || w.spaceBefore) {
          text += " ";
        }
      }
      w.start = text.length;
      text += w.text;
      w.end = text.length;
      words.push(w);
    });
  });
  return {
    id: -1,
    page,
    lines,
    x0: Math.min(...lines.map((l) => l.x0)),
    top: Math.min(...lines.map((l) => l.top)),
    x1: Math.max(...lines.map((l) => l.x1)),
    bottom: Math.max(...lines.map((l) => l.bottom)),
    size: dominantSize(words),
    text,
    words,
    kind: BODY,
    reason: "",
    level: 0,
    spans: [],
    sentences: [],
    table: null,
    boldFrac: boldFrac(words),
  };
}

// --------------------------------------------------------------------------- order

function verticalGap(blocks: Block[], minGap = 6): [number, number] | null {
  const spans = blocks.map((b) => [b.x0, b.x1] as const).sort((a, b) => a[0] - b[0]);
  let best: [number, number] | null = null;
  let reach = spans[0][1];
  for (const [x0, x1] of spans.slice(1)) {
    if (x0 - reach >= minGap && (!best || x0 - reach > best[1] - best[0])) best = [reach, x0];
    reach = Math.max(reach, x1);
  }
  return best;
}

function bands(blocks: Block[]): Block[][] {
  const out: Block[][] = [];
  let bottom = -Infinity;
  for (const b of [...blocks].sort((a, c) => a.top - c.top || a.x0 - c.x0)) {
    if (out.length && b.top < bottom - 0.5) {
      out[out.length - 1].push(b);
      bottom = Math.max(bottom, b.bottom);
    } else {
      out.push([b]);
      bottom = b.bottom;
    }
  }
  return out;
}

const byPosition = (a: Block, b: Block) => a.top - b.top || a.x0 - b.x0;

/**
 * Reading order for a page. Thin bands of text in the top and bottom margins
 * (running headers, footers) are read first and last, so a two-column page
 * isn't split through its footer.
 */
export function orderPage(blocks: Block[], pageH: number): Block[] {
  const bs = bands(blocks);
  const head: Block[] = [], tail: Block[] = [];
  while (bs.length > 1 && Math.max(...bs[0].map((b) => b.bottom)) <= 0.12 * pageH && bandHeight(bs[0]) < 40) head.push(...bs.shift()!);
  while (bs.length > 1 && Math.min(...bs[bs.length - 1].map((b) => b.top)) >= 0.88 * pageH && bandHeight(bs[bs.length - 1]) < 40) tail.unshift(...bs.pop()!);
  const byX = (a: Block, b: Block) => a.x0 - b.x0;
  return [...head.sort(byX), ...orderBlocks(bs.flat()), ...tail.sort(byX)];
}

function bandHeight(band: Block[]): number {
  return Math.max(...band.map((b) => b.bottom)) - Math.min(...band.map((b) => b.top));
}

export function orderBlocks(blocks: Block[], depth = 0): Block[] {
  if (blocks.length <= 1 || depth > 40) return [...blocks].sort(byPosition);
  const gap = verticalGap(blocks);
  if (gap) {
    const mid = (gap[0] + gap[1]) / 2;
    const left = blocks.filter((b) => (b.x0 + b.x1) / 2 < mid);
    const right = blocks.filter((b) => (b.x0 + b.x1) / 2 >= mid);
    return [...orderBlocks(left, depth + 1), ...orderBlocks(right, depth + 1)];
  }
  const bs = bands(blocks);
  if (bs.length === 1) return [...blocks].sort(byPosition);
  // Merge neighbouring bands that share a column gutter, so a two-column
  // stretch is read column by column even where its paragraph gaps line up.
  const merged: Block[][] = [];
  let shared: [number, number] | null = null;
  for (const band of bs) {
    const g = band.length > 1 ? verticalGap(band) : null;
    if (merged.length && shared && g) {
      const lo = Math.max(shared[0], g[0]), hi = Math.min(shared[1], g[1]);
      if (hi - lo >= 6) {
        merged[merged.length - 1].push(...band);
        shared = [lo, hi];
        continue;
      }
    }
    merged.push([...band]);
    shared = g;
  }
  return merged.flatMap((band) => orderBlocks(band, depth + 1));
}
