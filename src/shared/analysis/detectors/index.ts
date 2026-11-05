/**
 * Skip detectors.
 *
 * To add one (code blocks, maths, ...):
 *   1. Write a `Detector` in this folder.
 *   2. Add its block or span kinds to `SKIP_GROUP` in ../model.ts.
 *   3. Add it to `DETECTORS` and, for a new toggle, to `GROUPS`.
 *
 * Order matters: a block that already has a non-body kind is left alone by
 * later detectors (except references, which claim everything after the
 * heading).
 */

import type { Document } from "../model";
import { citationDetector, footnoteDetector, referencesDetector } from "./citations";
import { captionDetector, figureTextDetector } from "./figures";
import { headerFooterDetector } from "./headers";
import type { Detector, SkipGroup } from "./types";

export type { Detector, SkipGroup } from "./types";

export const DETECTORS: Detector[] = [
  headerFooterDetector,
  captionDetector,
  figureTextDetector,
  footnoteDetector,
  referencesDetector,
  citationDetector,
];

export const GROUPS: SkipGroup[] = [
  {
    id: "headers",
    label: "Headers, footers and page numbers",
    help: "Text that repeats in the top or bottom margin, and standalone page numbers.",
    default: true,
  },
  {
    id: "tables",
    label: "Tables",
    help: "Ruled tables. Skip them, or read them row by row with the column headings.",
    choices: [
      { id: "skip", label: "Skip" },
      { id: "rows", label: "Read as rows" },
      { id: "plain", label: "Read cells in order" },
    ],
    default: "skip",
  },
  {
    id: "figures",
    label: "Figures and captions",
    help: "Figure and table captions, and labels inside diagrams, schematics and images.",
    default: true,
  },
  {
    id: "citations",
    label: "Citations, URLs and footnotes",
    help: "[12], (Smith et al., 2020), long URLs, footnote markers and text, and the References section.",
    default: true,
  },
];

export function runDetectors(doc: Document): void {
  for (const d of DETECTORS) d.run(doc);
}
