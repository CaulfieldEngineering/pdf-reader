/**
 * Ruled tables from line segments (a small "lattice" detector).
 *
 * Horizontal and vertical segments that touch are grouped; a group whose
 * lines form a reasonably complete grid of at least 2 x 2 cells is a table.
 * Block diagrams also contain boxes and lines, but their lines rarely span
 * the whole grid, so a coverage check keeps them out.
 */

import type { Box, TableRow, Word } from "./model";
import type { Segment } from "./graphics";

const TOL = 3;

export interface FoundTable {
  box: Box;
  rows: TableRow[];
}

function cluster(values: number[], tol = 2): number[] {
  const s = [...values].sort((a, b) => a - b);
  const out: number[][] = [];
  for (const v of s) {
    const last = out[out.length - 1];
    if (last && v - last[last.length - 1] <= tol) last.push(v);
    else out.push([v]);
  }
  return out.map((g) => g.reduce((a, b) => a + b, 0) / g.length);
}

/** Merge collinear, overlapping segments. */
function mergeSegments(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const horizontal of [true, false]) {
    const list = segs.filter((s) => s.horizontal === horizontal).sort((a, b) => a.at - b.at || a.from - b.from);
    for (const s of list) {
      const prev = out.find((o) => o.horizontal === horizontal && Math.abs(o.at - s.at) <= 1 && s.from <= o.to + TOL && s.to >= o.from - TOL);
      if (prev) {
        prev.from = Math.min(prev.from, s.from);
        prev.to = Math.max(prev.to, s.to);
      } else out.push({ ...s });
    }
  }
  return out;
}

function touches(h: Segment, v: Segment): boolean {
  return v.at >= h.from - TOL && v.at <= h.to + TOL && h.at >= v.from - TOL && h.at <= v.to + TOL;
}

/** Fraction of [a, b] covered by the given intervals. */
function coverage(intervals: [number, number][], a: number, b: number): number {
  const s = intervals.map(([x, y]) => [Math.max(a, x), Math.min(b, y)] as [number, number]).filter(([x, y]) => y > x).sort((p, q) => p[0] - q[0]);
  let covered = 0, reach = a;
  for (const [x, y] of s) {
    if (y <= reach) continue;
    covered += y - Math.max(x, reach);
    reach = y;
  }
  return b > a ? covered / (b - a) : 0;
}

export function findTables(segments: Segment[], words: Word[], pageW: number, pageH: number): FoundTable[] {
  const segs = mergeSegments(segments.filter((s) => s.to - s.from >= 4));
  const hs = segs.filter((s) => s.horizontal);
  const vs = segs.filter((s) => !s.horizontal);
  if (hs.length < 3 || vs.length < 3) return [];

  // Connected components over touching segments
  const parent = segs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const idx = new Map(segs.map((s, i) => [s, i]));
  for (const h of hs) for (const v of vs) if (touches(h, v)) parent[find(idx.get(h)!)] = find(idx.get(v)!);
  const groups = new Map<number, Segment[]>();
  segs.forEach((s, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(s);
  });

  const tables: FoundTable[] = [];
  for (const g of groups.values()) {
    const gh = g.filter((s) => s.horizontal), gv = g.filter((s) => !s.horizontal);
    if (gh.length < 3 || gv.length < 3) continue;
    const ys = cluster(gh.map((s) => s.at));
    const xs = cluster(gv.map((s) => s.at));
    if (ys.length < 3 || xs.length < 3) continue;
    const x0 = xs[0], x1 = xs[xs.length - 1], y0 = ys[0], y1 = ys[ys.length - 1];
    const area = (x1 - x0) * (y1 - y0);
    if (x1 - x0 < 30 || y1 - y0 < 15) continue;

    // Grid completeness: the outer frame is closed and the inner lines mostly span
    const hCov = ys.map((y) => coverage(gh.filter((s) => Math.abs(s.at - y) <= 2).map((s) => [s.from, s.to]), x0, x1));
    const vCov = xs.map((x) => coverage(gv.filter((s) => Math.abs(s.at - x) <= 2).map((s) => [s.from, s.to]), y0, y1));
    const outer = [hCov[0], hCov[hCov.length - 1], vCov[0], vCov[vCov.length - 1]];
    if (Math.min(...outer) < 0.85) continue;
    const avgH = hCov.reduce((a, b) => a + b, 0) / hCov.length;
    if (avgH < 0.75) continue;

    // Rows: bands between horizontal lines; cells: merged where no vertical line divides them
    const inside = words.filter((w) => {
      const cx = (w.x0 + w.x1) / 2, cy = (w.top + w.bottom) / 2;
      return cx >= x0 - 1 && cx <= x1 + 1 && cy >= y0 - 1 && cy <= y1 + 1;
    });
    const rows: TableRow[] = [];
    for (let r = 0; r + 1 < ys.length; r++) {
      const top = ys[r], bottom = ys[r + 1];
      if (bottom - top < 3) continue;
      const mid = (top + bottom) / 2;
      const cuts = [x0];
      for (const x of xs.slice(1, -1)) {
        if (gv.some((s) => Math.abs(s.at - x) <= 2 && s.from <= mid + 1 && s.to >= mid - 1)) cuts.push(x);
      }
      cuts.push(x1);
      const cells: string[] = [];
      for (let c = 0; c + 1 < cuts.length; c++) {
        const cw = inside
          .filter((w) => {
            const cx = (w.x0 + w.x1) / 2, cy = (w.top + w.bottom) / 2;
            return cx >= cuts[c] && cx < cuts[c + 1] && cy >= top && cy < bottom;
          })
          .sort((a, b) => Math.round(a.top / 3) - Math.round(b.top / 3) || a.x0 - b.x0);
        cells.push(joinCell(cw));
      }
      rows.push({ cells, box: [x0, top, x1, bottom] });
    }
    const filled = rows.flatMap((r) => r.cells).filter((c) => c.trim());
    if (rows.length < 2 || Math.max(...rows.map((r) => r.cells.length)) < 2 || filled.length < 3) continue;
    const longest = Math.max(...filled.map((c) => c.length));
    const avg = filled.reduce((n, c) => n + c.length, 0) / filled.length;
    // A box drawn around prose (or a page frame) isn't a table
    if (longest > 400 || (area > 0.5 * pageW * pageH && avg > 120)) continue;
    tables.push({ box: [x0, y0, x1, y1], rows });
  }
  return tables;
}

/**
 * Tables drawn with horizontal rules (and often shaded rows) but no vertical
 * lines. Rules with the same left and right ends, close together, make the
 * rows; columns come from any vertical lines inside, else from gaps that run
 * through every row's text. A header row just above the first rule is
 * included when its text lines up with the columns.
 */
export function findRuleTables(segments: Segment[], words: Word[], taken: Box[], pageW: number, pageH: number): FoundTable[] {
  const segs = mergeSegments(segments.filter((s) => s.to - s.from >= 4));
  const free = (s: Segment) => !taken.some((b) => (s.horizontal ? s.at : (s.from + s.to) / 2) >= b[1] - 2 && (s.horizontal ? s.at : (s.from + s.to) / 2) <= b[3] + 2 && (s.horizontal ? (s.from + s.to) / 2 : s.at) >= b[0] - 2 && (s.horizontal ? (s.from + s.to) / 2 : s.at) <= b[2] + 2);
  const rules = segs.filter((s) => s.horizontal && s.to - s.from >= 80 && free(s)).sort((a, b) => a.at - b.at);
  const verticals = segs.filter((s) => !s.horizontal);
  const used = new Set<Segment>();
  const out: FoundTable[] = [];
  for (const r0 of rules) {
    if (used.has(r0)) continue;
    const run = [r0];
    for (const r of rules) {
      if (r === r0 || used.has(r) || r.at <= run[run.length - 1].at + 3) continue;
      if (Math.abs(r.from - r0.from) > 6 || Math.abs(r.to - r0.to) > 6) continue;
      if (r.at - run[run.length - 1].at > 120) break;
      run.push(r);
    }
    if (run.length < 3) continue;
    const x0 = Math.min(...run.map((r) => r.from)), x1 = Math.max(...run.map((r) => r.to));
    let ys = cluster(run.map((r) => r.at));
    if (ys.length < 3) continue;
    const rowH = (ys[ys.length - 1] - ys[0]) / (ys.length - 1);
    const within = (w: Word, top: number, bottom: number) => {
      const cx = (w.x0 + w.x1) / 2, cy = (w.top + w.bottom) / 2;
      return cx >= x0 - 1 && cx <= x1 + 1 && cy >= top && cy < bottom;
    };
    // Header row above the first rule
    // (only when its text has a column-sized gap, so a paragraph line isn't taken)
    const above = words.filter((w) => within(w, ys[0] - Math.min(1.6 * rowH, 60), ys[0])).sort((a, b) => a.x0 - b.x0);
    const columnar = above.length <= 12 && above.some((w, i) => i > 0 && w.x0 - Math.max(...above.slice(0, i).map((p) => p.x1)) >= 12);
    const caption = /^(?:figure|fig\.?|table)\s*\d/i.test(above.map((w) => w.text).join(" "));
    if (above.length && columnar && !caption) ys = [Math.min(...above.map((w) => w.top)) - 2, ...ys];
    const y0 = ys[0], y1 = ys[ys.length - 1];
    const inside = words.filter((w) => within(w, y0, y1));
    if (!inside.length) continue;
    // Column cuts: vertical lines inside, else gaps through all the text
    let cuts = cluster(verticals.filter((v) => v.at > x0 + 3 && v.at < x1 - 3 && v.to > y0 && v.from < y1).map((v) => v.at));
    if (!cuts.length) {
      const spans = inside.map((w) => [w.x0, w.x1] as [number, number]).sort((a, b) => a[0] - b[0]);
      let reach = spans[0][1];
      for (const [a, b] of spans.slice(1)) {
        if (a - reach >= 8) cuts.push((a + reach) / 2);
        reach = Math.max(reach, b);
      }
    }
    if (!cuts.length) continue;
    const edges = [x0, ...cuts, x1];
    const rows: TableRow[] = [];
    for (let i = 0; i + 1 < ys.length; i++) {
      const top = ys[i], bottom = ys[i + 1];
      if (bottom - top < 3) continue;
      const cells: string[] = [];
      for (let c = 0; c + 1 < edges.length; c++) {
        const cw = inside
          .filter((w) => { const cx = (w.x0 + w.x1) / 2, cy = (w.top + w.bottom) / 2; return cx >= edges[c] && cx < edges[c + 1] && cy >= top && cy < bottom; })
          .sort((a, b) => Math.round(a.top / 3) - Math.round(b.top / 3) || a.x0 - b.x0);
        cells.push(joinCell(cw));
      }
      if (cells.some((c) => c)) rows.push({ cells, box: [x0, top, x1, bottom] });
    }
    const multi = rows.filter((r) => r.cells.filter((c) => c).length >= 2).length;
    if (rows.length < 2 || multi < Math.max(2, 0.6 * rows.length)) continue;
    if (rows.some((r) => r.box[3] - r.box[1] > 150)) continue;
    const filled = rows.flatMap((r) => r.cells).filter((c) => c);
    if (Math.max(...filled.map((c) => c.length)) > 400) continue;
    if ((x1 - x0) * (y1 - y0) > 0.7 * pageW * pageH) continue;
    run.forEach((r) => used.add(r));
    out.push({ box: [x0, y0, x1, y1], rows });
  }
  return out;
}

function joinCell(words: Word[]): string {
  // Words are sorted by line then x; rejoin with single spaces
  let out = "";
  let lastTop = -Infinity;
  for (const w of words) {
    const newLine = w.top > lastTop + 3;
    if (out && (w.spaceBefore || newLine)) out += " ";
    out += w.text;
    lastTop = w.top;
  }
  return out.replace(/\s+/g, " ").trim();
}
