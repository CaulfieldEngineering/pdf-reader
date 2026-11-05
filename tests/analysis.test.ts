/** End-to-end detector tests on generated PDFs. */

import { beforeAll, describe, expect, it } from "vitest";
import { analyzeBytes } from "../scripts/pdf-node";
import { toData } from "../src/shared/analysis/analyze";
import { type Block, type Document, allBlocks } from "../src/shared/analysis/model";
import { buildQueue, utteranceText } from "../src/shared/reading";
import { FIGURE_LABELS, FOOTER_TEXT, HEADER_TEXT, LIST_ITEMS, LONG_URL, TABLE_ROWS, buildNumbered, buildSample } from "./fixtures";

let doc: Document;
let blocks: Block[];
const find = (re: RegExp) => blocks.filter((b) => re.test(b.text));
const one = (re: RegExp) => {
  const m = find(re);
  expect(m.length, `blocks matching ${re}`).toBeGreaterThan(0);
  return m[0];
};

beforeAll(async () => {
  doc = await analyzeBytes(await buildSample(), "sample.pdf");
  blocks = allBlocks(doc);
});

describe("running headers, footers and page numbers", () => {
  it("marks the repeated footer on every page", () => {
    const footers = blocks.filter((b) => b.text === FOOTER_TEXT);
    expect(footers).toHaveLength(doc.pages.length);
    for (const b of footers) expect(b.kind).toBe("footer");
  });
  it("marks the running header on every page", () => {
    const headers = blocks.filter((b) => b.text === HEADER_TEXT);
    expect(headers).toHaveLength(doc.pages.length);
    for (const b of headers) expect(b.kind).toBe("header");
  });
  it("matches 'Page N of M' across pages by normalising digits", () => {
    const pn = find(/^Page \d+ of \d+$/);
    expect(pn).toHaveLength(doc.pages.length);
    for (const b of pn) expect(["footer", "page_number"]).toContain(b.kind);
  });
  it("leaves body text alone", () => {
    expect(one(/^Wireless power links/).kind).toBe("body");
    expect(one(/^The rest of this report/).kind).toBe("body");
  });
  it("finds standalone page numbers that follow the page sequence, not stray numbers", async () => {
    const d = await analyzeBytes(await buildNumbered(4), "numbered.pdf");
    const bs = allBlocks(d);
    const nums = bs.filter((b) => /^\d+$/.test(b.text) && b.text !== "500");
    expect(nums).toHaveLength(4);
    for (const b of nums) expect(b.kind).toBe("page_number");
    expect(bs.find((b) => b.text === "500")?.kind).toBe("body");
  });
});

describe("tables", () => {
  it("detects the ruled table with its rows and cells", () => {
    const t = blocks.find((b) => b.kind === "table");
    expect(t).toBeDefined();
    expect(t!.table!.map((r) => r.cells)).toEqual(TABLE_ROWS);
  });
  it("reads rows with their column headings in rows mode", () => {
    const q = buildQueue(toData(doc), { tables: "rows", headers: true, figures: true, citations: true });
    const rows = q.filter((u) => blocks[u.b].kind === "table").map(utteranceText);
    expect(rows[0]).toBe("Row 1: Stage, TX Stage 1; Role, Impedance step-up; Gain, 12 dB.");
    expect(rows).toHaveLength(TABLE_ROWS.length - 1);
  });
  it("skips tables by default", () => {
    const q = buildQueue(toData(doc), {});
    expect(q.some((u) => blocks[u.b].kind === "table")).toBe(false);
  });
});

describe("figures and captions", () => {
  it("marks figure and table captions", () => {
    expect(one(/^Figure 1\. Block diagram/).kind).toBe("caption");
    expect(one(/^Table 1: Stage parameters/).kind).toBe("caption");
  });
  it("marks the labels inside the block diagram", () => {
    for (const l of FIGURE_LABELS) expect(blocks.find((b) => b.text === l)?.kind, l).toBe("figure_text");
  });
  it("still reads running text that mentions a figure", () => {
    expect(one(/^Figure 1 shows/).kind).toBe("body");
    expect(one(/^Table 1 summarises/).kind).toBe("body");
  });
  it("does not mistake a list of short items for diagram labels", () => {
    for (const item of LIST_ITEMS) expect(blocks.find((b) => b.text.endsWith(item))?.kind, item).toBe("body");
  });
});

describe("citations, URLs, footnotes and references", () => {
  it("finds bracketed and author-year citations", () => {
    const b = one(/^Wireless power links/);
    const spans = b.spans.map((s) => b.text.slice(s.start, s.end));
    expect(spans).toEqual(expect.arrayContaining(["[1]", "[2–4]", "(Smith et al., 2020)", "(2019)"]));
  });
  it("does not treat a dated aside as a citation", () => {
    const b = one(/^The rest of this report/);
    expect(b.spans.map((s) => b.text.slice(s.start, s.end))).not.toContain("(March 2020)");
  });
  it("finds the long URL and the footnote marker", () => {
    const b = one(/^All measurements/);
    const url = b.spans.find((s) => s.kind === "url")!;
    expect(b.text.slice(url.start, url.end)).toBe(LONG_URL);
    expect(url.replacement).toBe("example.com");
    expect(b.spans.some((s) => s.kind === "footnote_mark" && b.text.slice(s.start, s.end) === "1")).toBe(true);
  });
  it("marks the footnote text at the foot of the page", () => {
    expect(one(/^Measured at 25/).kind).toBe("footnote");
  });
  it("marks the References section and stops at the appendix", () => {
    expect(blocks.find((b) => b.text === "References")?.kind).toBe("references");
    for (const b of find(/^\[\d\] /)) expect(b.kind).toBe("references");
    expect(one(/^This appendix lists/).kind).toBe("body");
  });
  it("speaks sentences without citations, and with the URL's host", () => {
    const texts = buildQueue(toData(doc), {}).map(utteranceText);
    expect(texts).toContain("Wireless power links have been studied for decades.");
    expect(texts.find((t) => t.startsWith("The raw data"))).toBe("The raw data is available at example.com for anyone who wants to check the numbers.");
    expect(texts.find((t) => t.startsWith("All measurements"))).toBe("All measurements in this report use the same bench setup and the same load.");
  });
  it("reads everything when the toggles are off", () => {
    const texts = buildQueue(toData(doc), { headers: false, figures: false, citations: false, tables: "plain" }).map(utteranceText).join(" ");
    expect(texts).toContain("[1]");
    expect(texts).toContain("ACME-TR-001");
    expect(texts).toContain("Figure 1. Block diagram");
    expect(texts).toContain("TX Stage 1, Impedance step-up, 12 dB.");
  });
});

describe("layout and sections", () => {
  it("reads a two-column page column by column, footer last", () => {
    const texts = doc.pages[3].blocks.map((b) => b.text);
    const left = texts.findIndex((t) => t.startsWith("The left column"));
    const left2 = texts.findIndex((t) => t.startsWith("A second paragraph in the left"));
    const right = texts.findIndex((t) => t.startsWith("The right column"));
    const footer = texts.indexOf(FOOTER_TEXT);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left).toBeLessThan(left2);
    expect(left2).toBeLessThan(right);
    expect(footer).toBeGreaterThan(right);
  });
  it("takes sections from the PDF outline", () => {
    expect(doc.sections.every((s) => s.source === "outline")).toBe(true);
    const intro = doc.sections.find((s) => s.title === "1. Introduction")!;
    expect(blocks[intro.block].text).toBe("1. Introduction");
    const appendix = doc.sections.find((s) => s.title.startsWith("Appendix"))!;
    expect(blocks[appendix.block].text).toBe("Appendix A. Extra Data");
  });
  it("falls back to detected headings without an outline", async () => {
    const d = await analyzeBytes(await buildSample({ outline: false }), "plain.pdf");
    expect(d.sections.length).toBeGreaterThanOrEqual(6);
    expect(d.sections.every((s) => s.source === "headings")).toBe(true);
    expect(d.sections.map((s) => s.title)).toEqual(expect.arrayContaining(["1. Introduction", "3. Results", "Appendix A. Extra Data"]));
  });
  it("splits blocks into sentences", () => {
    expect(one(/^Wireless power links/).sentences.length).toBe(3);
  });
});
