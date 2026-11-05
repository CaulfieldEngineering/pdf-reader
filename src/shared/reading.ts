/**
 * The reading queue: what gets spoken, in order, for the current skip
 * settings. One utterance is a sentence of a block, or a row of a table.
 */

import type { BlockData, DocData } from "./analysis/analyze";
import type { Box } from "./analysis/model";
import type { SkipGroup } from "./analysis/detectors/types";

export type SkipSettings = Record<string, boolean | string>;

export interface Token {
  /** Text sent to the voice. */
  t: string;
  /** Indices of the block's words this token covers (for word highlight). */
  w: number[];
}

export interface Utterance {
  /** Block id. */
  b: number;
  /** Sentence (or table row) index inside the block. */
  k: number;
  page: number;
  tokens: Token[];
  /** Character range for sentences. */
  s?: number;
  e?: number;
  /** Highlight boxes (computed for rows, lazily for sentences). */
  rects?: Box[];
}

const hasWord = (s: string) => /[\p{L}\p{N}]/u.test(s);

export function skipValue(skip: SkipSettings, groups: SkipGroup[], gid: string): boolean | string {
  if (gid in skip) return skip[gid];
  return groups.find((g) => g.id === gid)?.default ?? false;
}

export function isSkipped(skip: SkipSettings, groups: SkipGroup[], gid: string): boolean {
  if (!gid) return false;
  const v = skipValue(skip, groups, gid);
  return typeof v === "string" ? v === "skip" : !!v;
}

/** Tokens for characters s..e of a block, with active spans removed or replaced. */
export function buildTokens(b: BlockData, s: number, e: number, skipped: (group: string) => boolean): Token[] {
  const spans = b.sp.filter((sp) => skipped(sp[3]) && sp[1] > s && sp[0] < e);
  const text = b.text;
  const tokens: (Token & { last: number })[] = [];
  b.w.forEach((w, wi) => {
    const a = Math.max(s, w[4]), z = Math.min(e, w[5]);
    if (z <= a) return;
    let kept = "";
    const reps: string[] = [];
    for (let c = a; c < z; c++) {
      const sp = spans.find((x) => c >= x[0] && c < x[1]);
      if (!sp) kept += text[c];
      else if (c === sp[0] && sp[4]) reps.push(sp[4]);
    }
    const piece = [kept.trim(), ...reps].filter(Boolean).join(" ");
    if (!piece) return;
    const prev = tokens[tokens.length - 1];
    const glued = a > 0 && text[a - 1] !== " " && prev && prev.last === wi - 1;
    if (prev && (glued || !hasWord(piece))) {
      // No space before it (hyphenation, superscript), or punctuation left
      // over after removing a citation: attach it to the previous token
      prev.t += piece;
      prev.w.push(wi);
      prev.last = wi;
    } else {
      tokens.push({ t: piece, w: [wi], last: wi });
    }
  });
  return tokens.map(({ t, w }) => ({ t, w }));
}

/** Spoken text for a table row. */
export function rowText(b: BlockData, ri: number, mode: string): string | null {
  const rows = b.rows ?? [];
  const r = rows[ri];
  if (!r) return null;
  if (mode === "rows") {
    if (ri === 0 && rows.length > 1) return null; // the header row is read with each row
    const header = rows[0]?.cells ?? [];
    const parts = r.cells
      .map((c, ci) => {
        c = (c || "").trim();
        if (!c) return null;
        const h = (header[ci] || "").trim();
        return h && h !== c ? `${h}, ${c}` : c;
      })
      .filter(Boolean);
    return parts.length ? `Row ${ri}: ${parts.join("; ")}.` : null;
  }
  const parts = r.cells.map((c) => (c || "").trim()).filter(Boolean);
  return parts.length ? parts.join(", ") + "." : null;
}

export function buildQueue(doc: DocData, skip: SkipSettings): Utterance[] {
  const groups = doc.groups;
  const skipped = (g: string) => isSkipped(skip, groups, g);
  const queue: Utterance[] = [];
  for (const b of doc.blocks) {
    if (b.kind === "table" && b.rows) {
      const mode = skipValue(skip, groups, "tables");
      if (mode === "skip" || mode === true) continue;
      b.rows.forEach((r, ri) => {
        const text = rowText(b, ri, String(mode));
        if (text) queue.push({ b: b.id, k: ri, page: b.p, rects: [r.box], tokens: text.split(/\s+/).map((t) => ({ t, w: [] })) });
      });
      continue;
    }
    if (b.group && skipped(b.group)) continue;
    b.s.forEach(([s, e], si) => {
      const tokens = buildTokens(b, s, e, skipped);
      if (tokens.some((t) => hasWord(t.t))) queue.push({ b: b.id, k: si, page: b.p, s, e, tokens });
    });
  }
  return queue;
}

/** Index of the first utterance at or after (block, k). */
export function nearestUtterance(queue: Utterance[], block: number, k: number): number {
  const i = queue.findIndex((u) => u.b > block || (u.b === block && u.k >= k));
  return i >= 0 ? i : Math.max(0, queue.length - 1);
}

export function utteranceText(u: Utterance): string {
  return u.tokens.map((t) => t.t).join(" ");
}
