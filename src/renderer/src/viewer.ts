/**
 * Page view: PDF.js canvases rendered lazily, a transparent text layer for
 * selection, block outlines for clicking, skipped-text marks and the reading
 * highlight.
 */

import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import type { BlockData, DocData } from "../../shared/analysis/analyze";
import type { Box } from "../../shared/analysis/model";

const KIND_LABELS: Record<string, string> = {
  body: "Body text", heading: "Heading", header: "Running header", footer: "Running footer",
  page_number: "Page number", table: "Table", caption: "Caption", figure_text: "Text in a figure",
  footnote: "Footnote", references: "References", citation: "Citation", url: "Link", footnote_mark: "Footnote marker",
};
export const kindLabel = (k: string) => KIND_LABELS[k] ?? k;

interface PageView {
  index: number;
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
  overlay: HTMLDivElement;
  hl: HTMLDivElement;
  hov: HTMLDivElement;
  flags: HTMLDivElement;
  w: number;
  h: number;
  cssScale: number;
  renderedScale: number;
  visible: boolean;
  task: RenderTask | null;
}
interface BlockView { be: HTMLDivElement; lines: HTMLSpanElement[]; spans: { e: HTMLDivElement; group: string }[] }

const measure = document.createElement("canvas").getContext("2d")!;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function place(e: HTMLElement, box: Box, w: number, h: number, pad = 0): void {
  e.style.left = ((box[0] - pad) / w) * 100 + "%";
  e.style.top = ((box[1] - pad) / h) * 100 + "%";
  e.style.width = ((box[2] - box[0] + 2 * pad) / w) * 100 + "%";
  e.style.height = ((box[3] - box[1] + 2 * pad) / h) * 100 + "%";
}

export function wordRects(b: BlockData, idxs: number[]): Box[] {
  const byLine = new Map<number, Box>();
  for (const i of idxs) {
    const w = b.w[i];
    if (!w) continue;
    const r = byLine.get(w[6]);
    if (!r) byLine.set(w[6], [w[0], w[1], w[2], w[3]]);
    else byLine.set(w[6], [Math.min(r[0], w[0]), Math.min(r[1], w[1]), Math.max(r[2], w[2]), Math.max(r[3], w[3])]);
  }
  return [...byLine.values()];
}

function charRects(b: BlockData, s: number, e: number): Box[] {
  const byLine = new Map<number, Box>();
  for (const w of b.w) {
    const a = Math.max(s, w[4]), z = Math.min(e, w[5]);
    if (z <= a) continue;
    const len = Math.max(1, w[5] - w[4]);
    const x0 = w[0] + ((a - w[4]) / len) * (w[2] - w[0]);
    const x1 = w[0] + ((z - w[4]) / len) * (w[2] - w[0]);
    const r = byLine.get(w[6]);
    if (!r) byLine.set(w[6], [x0, w[1], x1, w[3]]);
    else byLine.set(w[6], [Math.min(r[0], x0), Math.min(r[1], w[1]), Math.max(r[2], x1), Math.max(r[3], w[3])]);
  }
  return [...byLine.values()];
}

export class Viewer {
  pdf: PDFDocumentProxy | null = null;
  doc: DocData | null = null;
  private pages: PageView[] = [];
  private blocks: BlockView[] = [];
  private observer: IntersectionObserver | null = null;
  private renderQueue: PageView[] = [];
  private rendering = false;
  private hlPage: PageView | null = null;
  private maxW = 612;
  zoom = 1;
  userScrollAt = 0;
  onBlockClick: (blockId: number, k: number, ev: MouseEvent) => void = () => {};
  /** Whether a click on this block reads it, and if not why (for the hover hint). */
  readable: (b: BlockData) => { ok: boolean; why: string } = () => ({ ok: true, why: "" });
  onFlagClick: (id: string) => void = () => {};
  private hoverPending: PointerEvent | null = null;
  private hoverKey = "";
  private hoverPage: PageView | null = null;
  private pressed = false;

  constructor(private scroller: HTMLElement, private host: HTMLElement) {
    for (const t of ["wheel", "touchmove", "keydown"]) {
      scroller.addEventListener(t, () => { this.userScrollAt = Date.now(); }, { passive: true });
    }
    host.addEventListener("click", (ev) => this.click(ev));
    // Hover: show what a click would start reading. Hit-testing is done at most once per frame.
    host.addEventListener("pointermove", (ev) => {
      if (!this.hoverPending) requestAnimationFrame(() => this.hover());
      this.hoverPending = ev;
    });
    host.addEventListener("pointerleave", () => this.clearHover());
    host.addEventListener("pointerdown", () => { this.pressed = true; this.clearHover(); });
    window.addEventListener("pointerup", () => { this.pressed = false; });
    scroller.addEventListener("scroll", () => this.clearHover(), { passive: true });
    new ResizeObserver(() => this.layout()).observe(scroller);
  }

  clear(): void {
    this.observer?.disconnect();
    for (const p of this.pages) p.task?.cancel();
    this.host.innerHTML = "";
    this.pages = [];
    this.blocks = [];
    this.hlPage = null;
    this.pdf = null;
    this.doc = null;
    this.byPage = null;
    this.hoverPage = null;
    this.hoverKey = "";
  }

  load(pdf: PDFDocumentProxy, doc: DocData): void {
    this.clear();
    this.pdf = pdf;
    this.doc = doc;
    this.maxW = Math.max(...doc.pages.map((p) => p.w));
    doc.pages.forEach((P, i) => {
      const page = el("div", "page");
      page.dataset.p = String(i);
      const canvas = el("canvas");
      const overlay = el("div", "overlay");
      const hl = el("div", "hl");
      const hov = el("div", "hov");
      const flags = el("div", "flags");
      page.append(canvas, overlay, hov, hl, flags, el("div", "pnum", String(i + 1)));
      this.host.append(page);
      this.pages.push({ index: i, el: page, canvas, overlay, hl, hov, flags, w: P.w, h: P.h, cssScale: 1, renderedScale: 0, visible: false, task: null });
    });
    for (const b of doc.blocks) this.blocks[b.id] = this.buildBlock(b);
    this.layout();
    this.observer = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const pv = this.pages[Number((en.target as HTMLElement).dataset.p)];
        pv.visible = en.isIntersecting;
        if (pv.visible) this.queueRender(pv);
      }
      this.releaseFar();
    }, { root: this.scroller, rootMargin: "900px 0px" });
    for (const p of this.pages) this.observer.observe(p.el);
  }

  private buildBlock(b: BlockData): BlockView {
    const pv = this.pages[b.p];
    const be = el("div", "block");
    place(be, b.box, pv.w, pv.h, 1.5);
    be.dataset.b = String(b.id);
    pv.overlay.append(be);
    const lines: HTMLSpanElement[] = [];
    let cur: { n: number; s: number; e: number; box: Box } | null = null;
    const ls: { text: string; box: Box }[] = [];
    for (const w of b.w) {
      if (!cur || cur.n !== w[6]) {
        if (cur) ls.push({ text: b.text.slice(cur.s, cur.e), box: cur.box });
        cur = { n: w[6], s: w[4], e: w[5], box: [w[0], w[1], w[2], w[3]] };
      } else {
        cur.e = w[5];
        cur.box = [Math.min(cur.box[0], w[0]), Math.min(cur.box[1], w[1]), Math.max(cur.box[2], w[2]), Math.max(cur.box[3], w[3])];
      }
    }
    if (cur) ls.push({ text: b.text.slice(cur.s, cur.e), box: cur.box });
    for (const ln of ls) {
      const s = el("span", "line", ln.text);
      const h = Math.max(1, ln.box[3] - ln.box[1]);
      s.style.left = (ln.box[0] / pv.w) * 100 + "%";
      s.style.top = (ln.box[1] / pv.h) * 100 + "%";
      s.style.fontSize = `calc(var(--s) * ${h.toFixed(2)}px)`;
      measure.font = `${h}px Arial, Helvetica, sans-serif`;
      const textW = measure.measureText(ln.text).width;
      if (textW > 0) s.style.transform = `scaleX(${((ln.box[2] - ln.box[0]) / textW).toFixed(4)})`;
      pv.overlay.append(s);
      lines.push(s);
    }
    const spans: BlockView["spans"] = [];
    for (const sp of b.sp) {
      for (const r of charRects(b, sp[0], sp[1])) {
        const e = el("div", "skipspan");
        place(e, r, pv.w, pv.h, 0.5);
        e.title = kindLabel(sp[2]) + (sp[4] ? ` (read as “${sp[4]}”)` : "");
        pv.overlay.append(e);
        spans.push({ e, group: sp[3] });
      }
    }
    return { be, lines, spans };
  }

  // ---------------------------------------------------------------- layout & rendering

  layout(): void {
    if (!this.doc) return;
    const avail = Math.max(280, this.scroller.clientWidth - 48);
    const base = Math.min(avail, 1000);
    const s = (base * this.zoom) / this.maxW;
    const anchor = this.scroller.scrollTop / Math.max(1, this.scroller.scrollHeight);
    for (const pv of this.pages) {
      pv.cssScale = s;
      pv.el.style.width = Math.round(pv.w * s) + "px";
      pv.el.style.height = Math.round(pv.h * s) + "px";
      pv.el.style.setProperty("--s", s.toFixed(5));
      if (pv.visible) this.queueRender(pv);
    }
    this.scroller.scrollTop = anchor * this.scroller.scrollHeight;
  }

  private queueRender(pv: PageView): void {
    const want = pv.cssScale * (window.devicePixelRatio || 1);
    if (Math.abs(pv.renderedScale - want) < 0.01) return;
    if (!this.renderQueue.includes(pv)) this.renderQueue.push(pv);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.rendering || !this.pdf) return;
    this.rendering = true;
    try {
      while (this.renderQueue.length) {
        // Visible pages first, nearest the current scroll position
        this.renderQueue.sort((a, b) => Number(b.visible) - Number(a.visible));
        const pv = this.renderQueue.shift()!;
        if (!pv.visible) continue;
        await this.renderPage(pv);
      }
    } finally {
      this.rendering = false;
    }
  }

  private async renderPage(pv: PageView): Promise<void> {
    const pdf = this.pdf;
    if (!pdf) return;
    const dpr = window.devicePixelRatio || 1;
    let scale = pv.cssScale * dpr;
    // Keep each canvas under ~16 megapixels
    const maxScale = Math.sqrt(16e6 / (pv.w * pv.h));
    scale = Math.min(scale, maxScale);
    let page: PDFPageProxy;
    try { page = await pdf.getPage(pv.index + 1); } catch { return; }
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const task = page.render({ canvas, viewport, canvasContext: canvas.getContext("2d")! } as any);
    pv.task = task;
    try {
      await task.promise;
    } catch {
      return; // cancelled
    } finally {
      pv.task = null;
    }
    if (this.pdf !== pdf) return;
    canvas.className = "shown";
    pv.canvas.replaceWith(canvas);
    pv.canvas = canvas;
    pv.renderedScale = pv.cssScale * dpr;
  }

  /** Free canvases far from the viewport so long documents stay light. */
  private releaseFar(): void {
    const rendered = this.pages.filter((p) => p.renderedScale > 0 && !p.visible);
    if (rendered.length <= 8) return;
    const mid = this.scroller.scrollTop + this.scroller.clientHeight / 2;
    rendered
      .sort((a, b) => Math.abs(b.el.offsetTop - mid) - Math.abs(a.el.offsetTop - mid))
      .slice(0, rendered.length - 8)
      .forEach((p) => {
        p.canvas.width = p.canvas.height = 0;
        p.canvas.className = "";
        p.renderedScale = 0;
      });
  }

  // ---------------------------------------------------------------- skips

  applySkips(blockSkipped: (b: BlockData) => boolean, groupSkipped: (g: string) => boolean, describe: (b: BlockData) => string): void {
    if (!this.doc) return;
    for (const b of this.doc.blocks) {
      const v = this.blocks[b.id];
      if (!v) continue;
      const skip = blockSkipped(b);
      v.be.classList.toggle("skip", skip);
      v.be.title = describe(b);
      for (const l of v.lines) l.classList.toggle("skip", skip);
      for (const sp of v.spans) sp.e.classList.toggle("on", !skip && groupSkipped(sp.group));
    }
  }

  // ---------------------------------------------------------------- highlight

  highlight(page: number, rects: Box[]): void {
    if (this.hlPage) this.hlPage.hl.innerHTML = "";
    const pv = this.pages[page];
    this.hlPage = pv ?? null;
    if (!pv) return;
    for (const r of rects) {
      const d = el("div", "s");
      place(d, r, pv.w, pv.h, 1.5);
      pv.hl.append(d);
    }
  }

  word(rects: Box[]): void {
    const pv = this.hlPage;
    if (!pv) return;
    const old = [...pv.hl.querySelectorAll<HTMLDivElement>(".w")];
    rects.forEach((r, i) => {
      const d = old[i] ?? el("div", "w");
      place(d, r, pv.w, pv.h, 1);
      if (!d.parentNode) pv.hl.append(d);
    });
    old.slice(rects.length).forEach((d) => d.remove());
  }

  scrollTo(page: number, box: Box, force: boolean, follow = true): void {
    const pv = this.pages[page];
    if (!pv) return;
    if (!force && (!follow || Date.now() - this.userScrollAt < 4000)) return;
    const pr = pv.el.getBoundingClientRect();
    const vr = this.scroller.getBoundingClientRect();
    const y = pr.top + (box[1] / pv.h) * pr.height;
    const y2 = pr.top + (box[3] / pv.h) * pr.height;
    const margin = vr.height * 0.2;
    if (!force && y >= vr.top + margin && y2 <= vr.bottom - margin - 90) return;
    this.scroller.scrollTo({ top: this.scroller.scrollTop + (y - vr.top) - vr.height * 0.3, behavior: force ? "auto" : "smooth" });
  }

  // ---------------------------------------------------------------- clicks

  /** The block and sentence (or table row) under a point, if any. */
  private hit(ev: MouseEvent): { pv: PageView; b: BlockData; k: number } | null {
    const page = (ev.target as HTMLElement).closest?.<HTMLElement>(".page");
    if (!page || !this.doc) return null;
    const pi = Number(page.dataset.p);
    const P = this.doc.pages[pi];
    const r = page.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * P.w;
    const y = ((ev.clientY - r.top) / r.height) * P.h;
    let best: BlockData | null = null, area = Infinity;
    for (const b of this.pageBlocks(pi)) {
      const [x0, y0, x1, y1] = b.box;
      if (x >= x0 - 2 && x <= x1 + 2 && y >= y0 - 2 && y <= y1 + 2) {
        const a = (x1 - x0) * (y1 - y0);
        if (a < area) { best = b; area = a; }
      }
    }
    if (!best) return null;
    return { pv: this.pages[pi], b: best, k: sentenceAt(best, x, y) };
  }

  private byPage: BlockData[][] | null = null;
  private pageBlocks(pi: number): BlockData[] {
    if (!this.byPage && this.doc) {
      this.byPage = this.doc.pages.map(() => []);
      for (const b of this.doc.blocks) this.byPage[b.p].push(b);
    }
    return this.byPage?.[pi] ?? [];
  }

  private hover(): void {
    const ev = this.hoverPending;
    this.hoverPending = null;
    if (!ev || this.pressed || ev.buttons) { this.clearHover(); return; }
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) { this.clearHover(); return; }
    const h = this.hit(ev);
    if (!h) { this.clearHover(); return; }
    const can = this.readable(h.b);
    const key = `${h.b.id}:${h.k}:${can.ok}`;
    if (key === this.hoverKey) return;
    this.clearHover();
    this.hoverKey = key;
    this.hoverPage = h.pv;
    h.pv.el.classList.add(can.ok ? "can-read" : "no-read");
    h.pv.el.title = can.ok ? "" : can.why;
    if (!can.ok) return;
    const rects = h.b.rows ? (h.b.rows[h.k] ? [h.b.rows[h.k].box] : []) : sentenceRects(h.b, h.k);
    rects.forEach((rc, i) => {
      const d = el("div", "r");
      place(d, rc, h.pv.w, h.pv.h, 1.5);
      h.pv.hov.append(d);
      if (i === 0) {
        const go = el("div", "go", "\u25b6");
        go.style.left = (rc[0] / h.pv.w) * 100 + "%";
        go.style.top = `calc(${(((rc[1] + rc[3]) / 2) / h.pv.h) * 100}% - 7px)`;
        h.pv.hov.append(go);
      }
    });
    requestAnimationFrame(() => h.pv.hov.classList.add("on"));
  }

  clearHover(): void {
    const pv = this.hoverPage;
    this.hoverKey = "";
    this.hoverPage = null;
    if (!pv) return;
    pv.el.classList.remove("can-read", "no-read");
    pv.el.title = "";
    pv.hov.classList.remove("on");
    pv.hov.innerHTML = "";
  }

  /** Bookmark flags in the left margin of their sentence's first line. */
  setFlags(items: { id: string; page: number; box: Box; label: string }[]): void {
    for (const pv of this.pages) pv.flags.innerHTML = "";
    for (const it of items) {
      const pv = this.pages[it.page];
      if (!pv) continue;
      const f = el("div", "flag");
      f.style.left = (Math.max(14, it.box[0]) / pv.w) * 100 + "%";
      f.style.top = `calc(${(it.box[1] / pv.h) * 100}% + 1px)`;
      f.title = `Bookmark: ${it.label}`;
      f.addEventListener("click", (e) => { e.stopPropagation(); this.onFlagClick(it.id); });
      pv.flags.append(f);
    }
  }

  private click(ev: MouseEvent): void {
    const sel = window.getSelection();
    if (sel && sel.toString().trim()) return;
    if ((ev.target as HTMLElement).closest?.(".flag")) return;
    const h = this.hit(ev);
    if (h) this.onBlockClick(h.b.id, h.k, ev);
  }
}

/** Index of the sentence (or table row) of block `b` nearest to the point (x, y). */
export function sentenceAt(b: BlockData, x: number, y: number): number {
  if (b.rows) return Math.max(0, b.rows.findIndex((row) => y >= row.box[1] && y <= row.box[3]));
  if (!b.w.length) return 0;
  let wi = 0, dmin = Infinity;
  b.w.forEach((w, i) => {
    const dx = x < w[0] ? w[0] - x : x > w[2] ? x - w[2] : 0;
    const dy = y < w[1] ? w[1] - y : y > w[3] ? y - w[3] : 0;
    const d = dx * dx + dy * dy * 4;
    if (d < dmin) { dmin = d; wi = i; }
  });
  const pos = b.w[wi][4];
  return Math.max(0, b.s.findIndex(([s, e]) => pos >= s && pos < e));
}

/** Highlight boxes (one per line) for sentence k of block b. */
export function sentenceRects(b: BlockData, k: number): Box[] {
  const sent = b.s[k];
  if (!sent) return [];
  const idx: number[] = [];
  b.w.forEach((w, i) => { if (w[4] < sent[1] && w[5] > sent[0]) idx.push(i); });
  return wordRects(b, idx);
}
