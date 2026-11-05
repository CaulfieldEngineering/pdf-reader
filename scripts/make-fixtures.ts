/** Write the generated sample PDFs to tests/fixtures/ (for trying the app). */
import { mkdirSync, writeFileSync } from "node:fs";
import { buildNumbered, buildSample } from "../tests/fixtures";

mkdirSync("tests/fixtures", { recursive: true });
writeFileSync("tests/fixtures/sample.pdf", await buildSample());
writeFileSync("tests/fixtures/sample-no-outline.pdf", await buildSample({ outline: false }));
writeFileSync("tests/fixtures/numbered.pdf", await buildNumbered());
console.log("tests/fixtures/sample.pdf, sample-no-outline.pdf, numbered.pdf");
