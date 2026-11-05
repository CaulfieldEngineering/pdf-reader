/** Load and analyse a PDF in Node (tests and scripts) with the PDF.js legacy build. */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { analyze } from "../src/shared/analysis/analyze";
import type { Document } from "../src/shared/analysis/model";

export function openPdf(data: Uint8Array) {
  return pdfjs.getDocument({ data, disableFontFace: true, verbosity: 0 } as Parameters<typeof pdfjs.getDocument>[0]);
}

export async function analyzeBytes(data: Uint8Array, name = "document.pdf"): Promise<Document> {
  const task = openPdf(data);
  try {
    return await analyze((await task.promise) as any, name);
  } finally {
    await task.destroy();
  }
}

export async function analyzeFile(path: string): Promise<Document> {
  return analyzeBytes(new Uint8Array(await readFile(path)), basename(path));
}

export { pdfjs };
