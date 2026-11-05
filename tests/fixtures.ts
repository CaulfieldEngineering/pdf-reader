/**
 * Generated test PDFs (pdf-lib). The content is made up. The sample has a
 * running header, a footer with "Page N of M", headings, citations in several
 * styles, a long URL, a footnote with a separator rule, a vector block
 * diagram with small labels and a caption, a bullet list, a ruled table with
 * a caption, a two-column page, a References section and an appendix.
 */

import { PDFArray, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFNull, PDFPage, type PDFRef, rgb, StandardFonts, type PDFFont } from "pdf-lib";

export const HEADER_TEXT = "Sample Technical Report · Revision B";
export const FOOTER_TEXT = "ACME-TR-001 · Internal Draft · Do Not Distribute";
export const LONG_URL = "https://example.com/research/papers/2021/sample-report-final-version.pdf";
export const TABLE_ROWS = [
  ["Stage", "Role", "Gain"],
  ["TX Stage 1", "Impedance step-up", "12 dB"],
  ["TX Stage 2", "Power amplifier", "20 dB"],
  ["RX Stage", "Rectifier", "-3 dB"],
];
export const FIGURE_LABELS = ["VIN", "R1", "10k", "C1", "GND", "U1", "VOUT", "L1", "D1"];
export const LIST_ITEMS = ["Low noise", "Small size", "High efficiency", "Simple layout", "Low cost"];
export const LEFT_COLUMN = "The left column comes first. It explains the measurement method in enough detail to repeat it.";
export const RIGHT_COLUMN = "The right column comes second. It discusses what the results mean for the next design.";

const W = 612, H = 792, M = 72;

interface Fonts { body: PDFFont; bold: PDFFont; italic: PDFFont; sans: PDFFont }

class Writer {
  y = H - M - 20;
  constructor(public page: PDFPage, public f: Fonts) {}

  /** Paragraph with word wrap; "{sup:1}" inserts a superscript after the previous word. */
  para(text: string, opts: { size?: number; font?: PDFFont; x?: number; width?: number; leading?: number; after?: number } = {}) {
    const size = opts.size ?? 10.5, font = opts.font ?? this.f.body, x0 = opts.x ?? M, width = opts.width ?? W - 2 * M;
    const leading = opts.leading ?? size * 1.3;
    const tokens = text.split(/\s+/);
    let x = x0;
    const space = font.widthOfTextAtSize(" ", size);
    for (const tok of tokens) {
      const sup = /^\{sup:(.+)\}$/.exec(tok);
      if (sup) {
        const sx = x - space; // directly after the previous word
        this.page.drawText(sup[1], { x: sx, y: this.y + size * 0.38, size: size * 0.62, font });
        x = sx + font.widthOfTextAtSize(sup[1], size * 0.62) + space;
        continue;
      }
      const w = font.widthOfTextAtSize(tok, size);
      if (x > x0 && x + w > x0 + width) { x = x0; this.y -= leading; }
      this.page.drawText(tok, { x, y: this.y, size, font });
      x += w + space;
    }
    this.y -= leading + (opts.after ?? 8);
  }

  heading(text: string, size = 15) {
    this.y -= 6;
    this.page.drawText(text, { x: M, y: this.y, size, font: this.f.bold });
    this.y -= size * 1.3 + 6;
  }
}

function addOutline(doc: PDFDocument, entries: { title: string; page: PDFPage; y: number }[]): void {
  const ctx = doc.context;
  const outlinesRef = ctx.nextRef();
  const refs: PDFRef[] = entries.map(() => ctx.nextRef());
  entries.forEach((e, i) => {
    const dest = PDFArray.withContext(ctx);
    dest.push(e.page.ref);
    dest.push(PDFName.of("XYZ"));
    dest.push(PDFNull);
    dest.push(PDFNumber.of(e.y));
    dest.push(PDFNull);
    const dict = ctx.obj({}) as any;
    dict.set(PDFName.of("Title"), PDFHexString.fromText(e.title));
    dict.set(PDFName.of("Parent"), outlinesRef);
    dict.set(PDFName.of("Dest"), dest);
    if (i > 0) dict.set(PDFName.of("Prev"), refs[i - 1]);
    if (i < refs.length - 1) dict.set(PDFName.of("Next"), refs[i + 1]);
    ctx.assign(refs[i], dict);
  });
  const outlines = ctx.obj({ Type: "Outlines", First: refs[0], Last: refs[refs.length - 1], Count: refs.length });
  ctx.assign(outlinesRef, outlines);
  doc.catalog.set(PDFName.of("Outlines"), outlinesRef);
}

export async function buildSample(opts: { outline?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("Sample Technical Report");
  const f: Fonts = {
    body: await doc.embedFont(StandardFonts.TimesRoman),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.TimesRomanItalic),
    sans: await doc.embedFont(StandardFonts.Helvetica),
  };
  const outline: { title: string; page: PDFPage; y: number }[] = [];
  const pages: PDFPage[] = [];
  const newPage = () => { const p = doc.addPage([W, H]); pages.push(p); return new Writer(p, f); };
  const mark = (w: Writer, title: string) => outline.push({ title, page: w.page, y: w.y + 2 });

  // Page 1: title, introduction, citations, URL, footnote
  let w = newPage();
  mark(w, "Sample Technical Report");
  w.heading("Sample Technical Report", 22);
  mark(w, "1. Introduction");
  w.heading("1. Introduction");
  w.para("Wireless power links have been studied for decades [1]. Recent designs reach high efficiency at moderate distances [2–4], and resonant coupling is now the usual approach (Smith et al., 2020). Jones and Lee (2019) compared several coil geometries and found that spacing dominates the result.");
  w.para(`All measurements in this report use the same bench setup {sup:1} and the same load. The raw data is available at ${LONG_URL} for anyone who wants to check the numbers.`);
  w.para("The rest of this report describes the system, presents the results and draws some conclusions. Each section is short, so the whole report can be read in a few minutes. The work was planned in March (March 2020) and finished on time.");
  w.page.drawLine({ start: { x: M, y: 92 }, end: { x: M + 108, y: 92 }, thickness: 0.5 });
  w.page.drawText("1", { x: M, y: 82, size: 5, font: f.sans });
  w.page.drawText("Measured at 25 °C ambient with the probe grounded at the test point.", { x: M + 5, y: 80, size: 7.5, font: f.sans });

  // Page 2: system overview, figure with labels and caption, bullet list
  w = newPage();
  mark(w, "2. System Overview");
  w.heading("2. System Overview");
  w.para("The power stage converts the input voltage to a regulated output. The main parts are shown in the block diagram below, with the input on the left and the load on the right.");
  const fy = w.y - 200, fx = M + 20;
  const p = w.page;
  p.drawRectangle({ x: fx, y: fy, width: 420, height: 190, borderColor: rgb(0, 0, 0), borderWidth: 0.8 });
  for (const [x, y, bw, bh] of [[30, 80, 60, 40], [180, 70, 70, 60], [330, 80, 60, 40]]) {
    p.drawRectangle({ x: fx + x, y: fy + y, width: bw, height: bh, borderColor: rgb(0, 0, 0), borderWidth: 0.8 });
  }
  for (const [x1, y1, x2, y2] of [[90, 100, 180, 100], [250, 100, 330, 100], [215, 70, 215, 30], [195, 30, 235, 30], [200, 25, 230, 25], [205, 20, 225, 20], [120, 150, 150, 150], [270, 150, 310, 150]]) {
    p.drawLine({ start: { x: fx + x1, y: fy + y1 }, end: { x: fx + x2, y: fy + y2 }, thickness: 0.8 });
  }
  p.drawCircle({ x: fx + 135, y: fy + 100, size: 12, borderColor: rgb(0, 0, 0), borderWidth: 0.8 });
  p.drawCircle({ x: fx + 290, y: fy + 100, size: 12, borderColor: rgb(0, 0, 0), borderWidth: 0.8 });
  const places = [[40, 125], [125, 120], [125, 72], [280, 120], [200, 8], [205, 135], [340, 125], [130, 155], [280, 155]];
  FIGURE_LABELS.forEach((t, i) => p.drawText(t, { x: fx + places[i][0], y: fy + places[i][1], size: 7, font: f.sans }));
  w.y = fy - 18;
  w.para("Figure 1. Block diagram of the sample power stage.", { font: f.italic, size: 9, after: 10 });
  w.para("The design goals were simple and are listed here.", { after: 4 });
  for (const item of LIST_ITEMS) {
    w.page.drawText("•", { x: M + 6, y: w.y, size: 10.5, font: f.body });
    w.para(item, { x: M + 18, after: 0 });
  }

  // Page 3: results, table caption, ruled table, "Figure 1 shows" body text, conclusion
  w = newPage();
  mark(w, "3. Results");
  w.heading("3. Results");
  w.para("Table 1 summarises the gain of each stage measured on the bench.");
  w.para("Table 1: Stage parameters", { font: f.italic, size: 9, after: 4 });
  const colX = [M, M + 100, M + 250, M + 330];
  const rowH = 20;
  const top = w.y + 4;
  TABLE_ROWS.forEach((row, r) => {
    row.forEach((cell, c) => w.page.drawText(cell, { x: colX[c] + 5, y: top - (r + 1) * rowH + 6, size: 9, font: r === 0 ? f.bold : f.sans }));
  });
  for (let r = 0; r <= TABLE_ROWS.length; r++) w.page.drawLine({ start: { x: colX[0], y: top - r * rowH }, end: { x: colX[3], y: top - r * rowH }, thickness: 0.6 });
  for (const x of colX) w.page.drawLine({ start: { x, y: top }, end: { x, y: top - TABLE_ROWS.length * rowH }, thickness: 0.6 });
  w.y = top - TABLE_ROWS.length * rowH - 22;
  w.para("Figure 1 shows that the output stage carries most of the current. The second transmit stage provides most of the gain, as expected from the simulations.");
  mark(w, "4. Conclusion");
  w.heading("4. Conclusion");
  w.para("The prototype met every goal. Further work will look at thermal limits and at a smaller coil.");

  // Page 4: two columns
  w = newPage();
  mark(w, "5. Discussion");
  w.heading("5. Discussion");
  const colW = (W - 2 * M - 24) / 2;
  const y0 = w.y;
  w.para(LEFT_COLUMN + " " + LEFT_COLUMN, { width: colW });
  w.para("A second paragraph in the left column keeps the column going for a while longer.", { width: colW });
  w.y = y0;
  w.para(RIGHT_COLUMN + " " + RIGHT_COLUMN, { x: M + colW + 24, width: colW });
  w.para("A second paragraph in the right column closes the discussion.", { x: M + colW + 24, width: colW });

  // Page 5: references and appendix
  w = newPage();
  mark(w, "References");
  w.heading("References");
  for (const r of [
    "[1] A. Smith, B. Jones, and C. Lee, “A survey of wireless power,” Journal of Power, vol. 3, pp. 1–10, 2020.",
    "[2] D. Brown, “Resonant coupling in practice,” in Proc. Power Conf., 2018, pp. 44–50.",
    "[3] E. Green and F. White, Coil Design, 2nd ed. New York: Example Press, 2017.",
    "[4] G. Black, “Efficiency at distance,” IEEE Trans. Power, vol. 12, no. 4, 2021.",
  ]) w.para(r, { size: 9.5, after: 4 });
  mark(w, "Appendix A. Extra Data");
  w.heading("Appendix A. Extra Data");
  w.para("This appendix lists the raw readings. It should still be read aloud.");

  // Running header and footer on every page
  pages.forEach((pg, i) => {
    pg.drawText(HEADER_TEXT, { x: M, y: H - 40, size: 8.5, font: f.sans, color: rgb(0.4, 0.4, 0.4) });
    pg.drawText(FOOTER_TEXT, { x: M, y: 36, size: 8.5, font: f.sans, color: rgb(0.4, 0.4, 0.4) });
    const pn = `Page ${i + 1} of ${pages.length}`;
    pg.drawText(pn, { x: W - M - f.sans.widthOfTextAtSize(pn, 8.5), y: 36, size: 8.5, font: f.sans, color: rgb(0.4, 0.4, 0.4) });
  });
  if (opts.outline !== false) addOutline(doc, outline);
  return doc.save();
}

/** A short document whose page numbers stand alone ("3") in the bottom margin. */
export async function buildNumbered(pagesCount = 4): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  for (let i = 0; i < pagesCount; i++) {
    const page = doc.addPage([W, H]);
    const w = new Writer(page, { body: font, bold: font, italic: font, sans: font });
    w.para(`This is page ${i + 1} of the numbered sample. It has one paragraph of body text so the page is not empty. The sentence count does not matter here.`);
    page.drawText(String(i + 1), { x: W / 2 - 3, y: 30, size: 10, font });
    // A stray number near the top margin that is not a page number
    if (i === 1) page.drawText("500", { x: W - 120, y: H - 50, size: 10, font });
  }
  return doc.save();
}
