/**
 * Print what the skip detectors found in a PDF.
 *
 *   npm run analyze -- file.pdf [--verbose]
 */

import { summary } from "../src/shared/analysis/analyze";
import { analyzeFile } from "./pdf-node";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: npm run analyze -- file.pdf [--verbose]");
  process.exit(2);
}
const t0 = performance.now();
const doc = await analyzeFile(file);
console.log(JSON.stringify({ ...summary(doc), seconds: +((performance.now() - t0) / 1000).toFixed(2), bodySize: doc.bodySize }, null, 2));
if (args.includes("--verbose")) {
  for (const b of doc.pages.flatMap((p) => p.blocks)) {
    if (b.kind === "body" && !b.spans.length && !args.includes("--all")) continue;
    const spans = b.spans.map((s) => `${s.kind}:${JSON.stringify(b.text.slice(s.start, s.end))}`).join(", ");
    console.log(`p${String(b.page + 1).padStart(3)} #${String(b.id).padEnd(5)} ${b.kind.padEnd(12)} ${JSON.stringify(b.text.slice(0, 70))} ${spans} (${b.reason})`);
  }
  for (const s of doc.sections) console.log(`section L${s.level} p${s.page + 1} #${s.block} ${s.title}`);
}
