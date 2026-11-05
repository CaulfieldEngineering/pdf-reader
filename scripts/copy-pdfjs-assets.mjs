// Copy the PDF.js data folders (CMaps, standard fonts, ICC profiles, wasm
// decoders) into the renderer's public folder, so the app works offline.
import { cpSync, mkdirSync } from "node:fs";
const out = "src/renderer/public/pdfjs";
mkdirSync(out, { recursive: true });
for (const dir of ["cmaps", "standard_fonts", "iccs", "wasm"]) {
  cpSync(`node_modules/pdfjs-dist/${dir}`, `${out}/${dir}`, { recursive: true });
}
console.log(`PDF.js assets copied to ${out}`);
