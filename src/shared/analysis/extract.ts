/** Turn a PDF.js page into words, blocks, tables and drawing regions. */

import { type Matrix, multiply, readGraphics } from "./graphics";
import { buildBlocks, buildLines, finalizeBlock, orderPage } from "./layout";
import { TABLE, type Block, type Page, type Word } from "./model";
import { findRegions } from "./regions";
import { findRuleTables, findTables } from "./tables";

/** The parts of a PDF.js PDFPageProxy that extraction needs. */
export interface PageLike {
  getViewport(opts: { scale: number }): { width: number; height: number; transform: number[] };
  getTextContent(opts?: object): Promise<{ items: any[]; styles: Record<string, { ascent?: number; descent?: number }> }>;
  getOperatorList(opts?: object): Promise<{ fnArray: number[]; argsArray: unknown[] }>;
  commonObjs: { has(id: string): boolean; get(id: string): any };
}

const BOLD_RE = /bold|black|heavy|semibold|demi/i;
const CID_RE = /\(cid:\d+\)/g;

// Rough relative glyph widths, so words split from a text run get plausible
// boxes without measuring glyphs.
function charWeight(c: string): number {
  if (c === " ") return 0.28;
  if ("il.,:;'|!`".includes(c)) return 0.26;
  if ("fjtrI()[]{}-/\\\"".includes(c)) return 0.34;
  if ("mwMW@%".includes(c)) return 0.85;
  if (/[A-Z]/.test(c)) return 0.68;
  if (/[0-9]/.test(c)) return 0.56;
  return 0.52;
}

function fontInfo(page: PageLike, name: string): { bold: boolean } {
  try {
    if (page.commonObjs.has(name)) {
      const f = page.commonObjs.get(name);
      return { bold: !!(f?.bold || f?.black || BOLD_RE.test(String(f?.name ?? "")) || BOLD_RE.test(String(f?.loadedName ?? ""))) };
    }
  } catch {
    /* font not resolved */
  }
  return { bold: false };
}

export function textWords(page: PageLike, items: any[], styles: Record<string, { ascent?: number; descent?: number }>, vt: Matrix): Word[] {
  const words: Word[] = [];
  const fonts = new Map<string, { bold: boolean }>();
  let pendingSpace = true;
  for (const it of items) {
    if (typeof it?.str !== "string") continue;
    let str: string = it.str;
    if (str.includes("(cid:")) {
      const stripped = str.replace(CID_RE, "");
      str = stripped.trim() ? stripped : "•";
    }
    if (!str.trim()) {
      pendingSpace = true;
      continue;
    }
    const tx = multiply(vt, it.transform as Matrix);
    const size = Math.hypot(tx[2], tx[3]);
    const hs = Math.hypot(tx[0], tx[1]);
    if (size < 0.5 || hs < 0.01) continue;
    if (!fonts.has(it.fontName)) fonts.set(it.fontName, fontInfo(page, it.fontName));
    const bold = fonts.get(it.fontName)!.bold;
    const st = styles[it.fontName] ?? {};
    const asc = Math.min(1, Math.max(0.6, st.ascent ?? 0.8));
    const desc = Math.max(-0.4, Math.min(0, st.descent ?? -0.2));
    const width = Math.abs(it.width ?? 0) || str.length * size * 0.5;
    const upright = Math.abs(tx[1]) < 0.02 * hs && Math.abs(tx[2]) < 0.02 * size && tx[0] > 0 && tx[3] < 0;

    if (!upright) {
      // Rotated text: one word per run, with an axis-aligned box around it
      const dx = tx[0] / hs, dy = tx[1] / hs;
      const ux = -tx[2] / size, uy = -tx[3] / size; // "up" in page space
      const pts: [number, number][] = [];
      for (const along of [0, width]) for (const up of [desc * size, asc * size]) pts.push([tx[4] + dx * along + ux * up, tx[5] + dy * along + uy * up]);
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      words.push({
        text: str.replace(/\s+/g, " ").trim(), x0: Math.min(...xs), top: Math.min(...ys), x1: Math.max(...xs), bottom: Math.max(...ys),
        size, bold, upright: false, sup: false, spaceBefore: true, line: 0, start: 0, end: 0,
      });
      pendingSpace = /\s$/.test(str) || !!it.hasEOL;
      continue;
    }

    const total = [...str].reduce((n, c) => n + charWeight(c), 0) || 1;
    const scale = width / total;
    const top = tx[5] - size * asc, bottom = tx[5] - size * desc;
    let x = tx[4];
    let cur = "", curX = x, first = true;
    const flush = (endX: number) => {
      if (!cur) return;
      words.push({
        text: cur, x0: curX, top, x1: endX, bottom, size, bold, upright: true, sup: false,
        spaceBefore: first ? pendingSpace : true, line: 0, start: 0, end: 0,
      });
      first = false;
      cur = "";
    };
    for (const c of str) {
      const w = charWeight(c) * scale;
      if (/\s/.test(c)) {
        flush(x);
        if (first) pendingSpace = true;
      } else {
        if (!cur) curX = x;
        cur += c;
      }
      x += w;
    }
    flush(x);
    pendingSpace = /\s$/.test(str) || !!it.hasEOL;
  }
  return words;
}

function centerInside(w: Word, b: [number, number, number, number]): boolean {
  const cx = (w.x0 + w.x1) / 2, cy = (w.top + w.bottom) / 2;
  return b[0] - 1 <= cx && cx <= b[2] + 1 && b[1] - 1 <= cy && cy <= b[3] + 1;
}

export async function extractPage(page: PageLike, index: number): Promise<Page> {
  const vp = page.getViewport({ scale: 1 });
  const vt = vp.transform as Matrix;
  const ops = await page.getOperatorList();
  const tc = await page.getTextContent();
  const words = textWords(page, tc.items, tc.styles, vt);
  const graphics = readGraphics(ops, vt);
  const lattice = findTables(graphics.segments, words, vp.width, vp.height);
  const tables = [...lattice, ...findRuleTables(graphics.segments, words, lattice.map((t) => t.box), vp.width, vp.height)];

  const tableWords: Word[][] = tables.map(() => []);
  const free: Word[] = [];
  for (const w of words) {
    const i = tables.findIndex((t) => centerInside(w, t.box));
    if (i >= 0) tableWords[i].push(w);
    else free.push(w);
  }

  const blocks: Block[] = buildBlocks(buildLines(free)).map((lines) => finalizeBlock(lines, index));
  tables.forEach((t, i) => {
    const lines = buildLines(tableWords[i]).sort((a, b) => a.top - b.top || a.x0 - b.x0);
    const b = lines.length
      ? finalizeBlock(lines, index)
      : finalizeBlock([{ words: [], x0: t.box[0], top: t.box[1], x1: t.box[2], bottom: t.box[3], size: 10 }], index);
    [b.x0, b.top, b.x1, b.bottom] = t.box;
    b.kind = TABLE;
    b.reason = `Table, ${t.rows.length} rows`;
    b.table = t.rows;
    if (!lines.length) { b.lines = []; b.words = []; b.size = 10; }
    blocks.push(b);
  });

  const { regions, rules } = findRegions(graphics.objects, words, tables.map((t) => t.box), vp.width, vp.height);
  return { index, width: vp.width, height: vp.height, blocks: orderPage(blocks, vp.height), regions, rules };
}
