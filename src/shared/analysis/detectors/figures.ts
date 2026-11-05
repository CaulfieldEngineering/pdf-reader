/** Figure captions and text inside figures (diagram and schematic labels). */

import { BODY, CAPTION, FIGURE_TEXT, HEADING, TABLE, type Block, type Document, type Page, type Region, label, regionContains } from "../model";
import type { Detector } from "./types";

const CAPTION_RE = /^(?:figure|fig\.?|figs\.?|table|tab\.|exhibit|chart|diagram|scheme|plate|listing|illustration|graph|photo|image|drawing)\s*(?:[A-Z]?\d+(?:[.\-–]\d+)*[a-z]?|[A-Z]|[IVX]+)\b/i;
const SEPARATORS = ".:-–—|)";
const SENTENCE_END = /[.!?;]$/;

export function isCaption(b: Block, bodySize: number, nearFigure: boolean): boolean {
  const text = b.text.trim();
  const m = CAPTION_RE.exec(text);
  if (!m) return false;
  const rest = text.slice(m[0].length).trimStart();
  if (!rest) return true; // just "Figure 3"
  if (SEPARATORS.includes(rest[0])) return true;
  // "Figure 3 Block diagram ..." (no separator): only when it looks like a
  // caption, so "Figure 3 shows ..." in running text is still read.
  return /^\p{Lu}/u.test(rest) && (nearFigure || b.size < 0.95 * bodySize) && b.lines.length <= 4;
}

function nearFigure(page: Page, b: Block, dist = 60): boolean {
  for (const r of page.regions) {
    if (b.x1 >= r.x0 - dist && b.x0 <= r.x1 + dist && b.bottom >= r.top - dist && b.top <= r.bottom + dist) return true;
  }
  return page.blocks.some((o) => o.kind === TABLE && b.bottom >= o.top - dist && b.top <= o.bottom + dist);
}

export const captionDetector: Detector = {
  name: "captions",
  group: "figures",
  run(doc: Document) {
    for (const page of doc.pages) {
      for (const b of page.blocks) {
        if ((b.kind === BODY || b.kind === HEADING) && isCaption(b, doc.bodySize, nearFigure(page, b))) {
          label(b, CAPTION, "Figure or table caption");
        }
      }
    }
  },
};

/** A short, single-line, small-font fragment such as a schematic label. */
export function labelLike(b: Block, bodySize: number): boolean {
  if (b.lines.length !== 1 || b.words.length > 4 || b.text.length > 30) return false;
  if (SENTENCE_END.test(b.text.trim())) return false;
  return b.size <= 0.95 * bodySize;
}

/** A wide, short image with nothing drawn on it: a banner behind a title. */
function isBanner(r: Region, page: Page): boolean {
  return r.hasImage && r.objects <= 6 && r.bottom - r.top <= 110 && r.x1 - r.x0 >= 0.5 * page.width;
}

function inRegions(page: Page, bodySize: number): void {
  for (const b of page.blocks) {
    if (b.kind !== BODY) continue;
    const cx = (b.x0 + b.x1) / 2, cy = (b.top + b.bottom) / 2;
    const r = page.regions.find((r) => regionContains(r, cx, cy, 4) && !isBanner(r, page));
    if (!r) continue;
    // Large text over a picture is a title, not a label
    if (r.hasImage && b.size >= 1.15 * bodySize) continue;
    const perLine = b.words.length / Math.max(1, b.lines.length);
    // Prose inside a framed box is still read
    if (b.words.length <= 8 || perLine <= 4) {
      label(b, FIGURE_TEXT, `Text inside ${r.hasImage ? "an image" : "a drawing"} (${r.objects} objects)`);
    }
  }
}

function rotated(page: Page): void {
  for (const b of page.blocks) {
    if (b.kind === BODY && b.words.length && b.words.every((w) => !w.upright) && b.words.length <= 10) {
      label(b, FIGURE_TEXT, "Rotated text, likely a diagram label");
    }
  }
}

function labelClusters(page: Page, bodySize: number, reach = 80, minSize = 5): void {
  const cands = page.blocks.filter((b) => b.kind === BODY && labelLike(b, bodySize));
  if (cands.length < minSize) return;
  const parent = cands.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const centers = cands.map((b) => [(b.x0 + b.x1) / 2, (b.top + b.bottom) / 2]);
  for (let i = 0; i < cands.length; i++) {
    for (let j = i + 1; j < cands.length; j++) {
      const dx = centers[i][0] - centers[j][0], dy = centers[i][1] - centers[j][1];
      if (dx * dx + dy * dy <= reach * reach) parent[find(i)] = find(j);
    }
  }
  const clusters = new Map<number, Block[]>();
  cands.forEach((b, i) => {
    const r = find(i);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r)!.push(b);
  });
  for (const members of clusters.values()) {
    if (members.length < minSize) continue;
    // A list of short items is a stack at one or two x positions; labels
    // scattered over a drawing spread out in both directions.
    const xs = new Set(members.map((b) => Math.round(b.x0 / 5)));
    const ys = new Set(members.map((b) => Math.round(b.top / 5)));
    if (xs.size < 3 || ys.size < 2) continue;
    for (const b of members) label(b, FIGURE_TEXT, `One of ${members.length} short labels scattered together`);
  }
}

export const figureTextDetector: Detector = {
  name: "figure_text",
  group: "figures",
  run(doc: Document) {
    for (const page of doc.pages) {
      inRegions(page, doc.bodySize);
      rotated(page);
      labelClusters(page, doc.bodySize);
    }
  },
};
