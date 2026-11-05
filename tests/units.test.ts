/** Unit tests for text helpers, inline detectors, timing and constants. */

import { describe, expect, it } from "vitest";
import { pdfjs } from "../scripts/pdf-node";
import { findInline } from "../src/shared/analysis/detectors/citations";
import { normalize } from "../src/shared/analysis/detectors/headers";
import { OPS } from "../src/shared/analysis/graphics";
import { cleanToken, splitSentences } from "../src/shared/analysis/text";
import { encodeWav, tokenStarts } from "../src/shared/tts-align";

const spans = (t: string) => findInline(t).map((s) => t.slice(s.start, s.end));

describe("sentence splitting", () => {
  it("keeps abbreviations, initials and decimals inside a sentence", () => {
    const t = 'See Fig. 3 for details. Dr. J. Smith et al. reported 3.5 V (e.g. at 10 kHz). Next one! And "quoted." Then more.';
    expect(splitSentences(t).map(([s, e]) => t.slice(s, e))).toEqual([
      "See Fig. 3 for details.",
      "Dr. J. Smith et al. reported 3.5 V (e.g. at 10 kHz).",
      "Next one!",
      'And "quoted."',
      "Then more.",
    ]);
  });
  it("keeps a section number with its heading", () => {
    const t = "1. Introduction";
    expect(splitSentences(t)).toEqual([[0, t.length]]);
    expect(splitSentences("2.3. Results. More text.").length).toBe(2);
  });
  it("splits very long sentences at a clause boundary", () => {
    const t = Array.from({ length: 30 }, (_, i) => `clause number ${i} goes here`).join(", ") + ".";
    const parts = splitSentences(t);
    expect(parts.length).toBeGreaterThan(1);
    for (const [s, e] of parts) expect(e - s).toBeLessThanOrEqual(320);
  });
});

describe("speech clean-up", () => {
  it("reads number ranges and drops separators", () => {
    expect(cleanToken("2–4")).toBe("2 to 4");
    expect(cleanToken("·")).toBe("");
    expect(cleanToken("word—")).toBe("word,");
    expect(cleanToken("results.")).toBe("results.");
  });
});

describe("inline citations and URLs", () => {
  it("finds numeric and author-year citations", () => {
    expect(spans("as shown [12] and [3–5] and [1, 4, 7].")).toEqual(["[12]", "[3–5]", "[1, 4, 7]"]);
    expect(spans("coupling (Smith et al., 2020; Lee and Park, 2019a) works")).toEqual(["(Smith et al., 2020; Lee and Park, 2019a)"]);
    expect(spans("see (Jones, 2018, pp. 4–6).")).toEqual(["(Jones, 2018, pp. 4–6)"]);
  });
  it("ignores parentheses and brackets that are not citations", () => {
    expect(spans("released (March 2020) and (Rev 2021) and (see below) and (Q3 2022)")).toEqual([]);
    expect(spans("an array [i] and a range [a, b]")).toEqual([]);
  });
  it("finds URLs without trailing punctuation, and DOIs", () => {
    expect(spans("Go to https://example.org/a/b?c=1, then www.test.com.")).toEqual(["https://example.org/a/b?c=1", "www.test.com"]);
    expect(findInline("at https://www.example.org/x.")[0].replacement).toBe("example.org");
    expect(spans("doi:10.1109/5.771073.")).toContain("doi:10.1109/5.771073");
  });
});

describe("header normalisation", () => {
  it("treats page numbers as equal", () => {
    expect(normalize("Page 3 of 40")).toBe(normalize("Page 17 of 40"));
    expect(normalize("ACME-X2-DOC · Internal")).toBe("acme x# doc internal");
  });
});

describe("word timing", () => {
  it("maps word tokens to spoken words exactly when the counts match", () => {
    const ph = ["", "h", "ə", "l", "ˈ", "o", " ", "w", "ɜ", "l", "d", ".", ""];
    const dur = [2, 1, 1, 1, 0, 1, 1, 2, 1, 1, 1, 1, 2];
    const starts = tokenStarts(ph, dur, 1.5, ["Hello", "world."]);
    expect(starts[0]).toBeCloseTo(0.2, 2);
    expect(starts[1]).toBeCloseTo(0.7, 2);
  });
  it("falls back to proportional timing when the word counts differ", () => {
    const ph = ["", "t", "w", "ɛ", "n", "t", "i", " ", "t", "w", "ɛ", "n", "t", "i", " ", "j", "ɪ", "ɹ", ""];
    const starts = tokenStarts(ph, new Array(ph.length).fill(1), 1.9, ["2020", "year"]);
    expect(starts[0]).toBeLessThan(starts[1]);
    expect(starts[1]).toBeGreaterThan(0.5);
  });
  it("writes a valid 16-bit WAV", () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 1]), 24000);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(wav.length).toBe(44 + 8);
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(24000);
  });
});

describe("PDF.js operator codes", () => {
  it("match the installed pdfjs-dist", () => {
    for (const [name, code] of Object.entries(OPS)) expect((pdfjs.OPS as Record<string, number>)[name], name).toBe(code);
  });
});
