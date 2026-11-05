/**
 * Running headers, footers and page numbers.
 *
 * A block in the top or bottom margin is a running header or footer when the
 * same text, with digits normalised ("Page 3 of 40" == "Page 7 of 40"),
 * appears at about the same height on several pages. A margin block that is
 * only a page number ("12", "- 12 -", "Page 12", "12 / 40", "xii") is a page
 * number.
 */

import { BODY, FOOTER, HEADER, PAGE_NUMBER, type Block, type Document, type Page, label } from "../model";
import type { Detector } from "./types";

export const REPEAT_ZONE = 0.14;
export const NUMBER_ZONE = 0.12;
const Y_TOLERANCE = 0.012;

const PAGE_NUM_RE = /^(?:page|pg\.?|p\.)?\s*[-–—(\[]?\s*(?:\d{1,4}|[ivxlcdm]{1,7})\s*[-–—)\]]?\s*(?:(?:of|\/)\s*\d{1,4})?$/i;

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/[^\p{L}\p{N}#]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export const headerFooterDetector: Detector = {
  name: "headers",
  group: "headers",
  run(doc: Document) {
    const n = doc.pages.length;
    const groups = new Map<string, { page: Page; b: Block }[]>();
    for (const page of doc.pages) {
      const h = page.height;
      for (const b of page.blocks) {
        if (b.kind !== BODY || b.lines.length > 3 || !b.text.trim()) continue;
        let zone: string;
        if (b.bottom <= REPEAT_ZONE * h) zone = "top";
        else if (b.top >= (1 - REPEAT_ZONE) * h) zone = "bottom";
        else continue;
        const key = normalize(b.text);
        if (!key || key === "#") continue;
        const k = `${zone}|${key}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push({ page, b });
      }
    }
    const minRepeat = n <= 4 ? 2 : 3;
    for (const [k, members] of groups) {
      const zone = k.slice(0, k.indexOf("|"));
      // Mostly numbers ("42 W", "93.9 %"): table cells near the margin repeat
      // too, so these need to recur on a large share of the pages.
      const letters = (k.slice(k.indexOf("|") + 1).match(/\p{L}/gu) ?? []).length;
      const need = letters < 4 ? Math.max(minRepeat, Math.ceil(0.4 * n)) : minRepeat;
      const ys = members.map(({ page, b }) => b.top / page.height);
      const mid = median(ys);
      const near = members.filter((_, i) => Math.abs(ys[i] - mid) <= Y_TOLERANCE);
      const pages = new Set(near.map((m) => m.page.index));
      if (pages.size < need) continue;
      for (const { b } of near) {
        label(b, zone === "top" ? HEADER : FOOTER, `Repeats in the ${zone} margin on ${pages.size} of ${n} pages`);
      }
    }
    // Page numbers: margin blocks that are only a number. Arabic numbers must
    // follow the page sequence (number - page index constant on several
    // pages), so a stray "500" in a table near the margin isn't taken.
    const cands: { b: Block; page: Page; value: number | null }[] = [];
    for (const page of doc.pages) {
      const h = page.height;
      for (const b of page.blocks) {
        if (b.kind !== BODY || b.lines.length !== 1) continue;
        const inZone = b.bottom <= NUMBER_ZONE * h || b.top >= (1 - NUMBER_ZONE) * h;
        const t = b.text.trim();
        if (!inZone || !PAGE_NUM_RE.test(t)) continue;
        const m = /\d+/.exec(t);
        cands.push({ b, page, value: m ? parseInt(m[0], 10) : null });
      }
    }
    const offsets = new Map<number, Set<number>>();
    for (const c of cands) {
      if (c.value === null) continue;
      const off = c.value - c.page.index;
      if (!offsets.has(off)) offsets.set(off, new Set());
      offsets.get(off)!.add(c.page.index);
    }
    const good = new Set([...offsets].filter(([, pages]) => pages.size >= Math.min(2, n)).map(([off]) => off));
    for (const c of cands) {
      if (c.value === null || good.has(c.value - c.page.index)) label(c.b, PAGE_NUMBER, "Page number in the margin");
    }
  },
};
