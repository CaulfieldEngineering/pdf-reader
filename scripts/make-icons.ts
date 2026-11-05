/**
 * Render build/icon.svg to PNGs and a multi-size Windows .ico.
 *
 *   npm run icons
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import sharp from "sharp";

const svg = readFileSync("build/icon.svg");
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
mkdirSync("build/icons", { recursive: true });

const pngs = new Map<number, Buffer>();
for (const size of [...ICO_SIZES, 512, 1024]) {
  const png = await sharp(svg, { density: Math.max(72, (72 * size) / 256 * 4) }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
  pngs.set(size, png);
  writeFileSync(`build/icons/${size}x${size}.png`, png);
}
writeFileSync("build/icon.png", pngs.get(512)!);

// ICO with PNG-compressed entries (supported since Windows Vista)
const entries = ICO_SIZES.map((s) => ({ size: s, data: pngs.get(s)! }));
const header = Buffer.alloc(6 + 16 * entries.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(entries.length, 4);
let offset = header.length;
entries.forEach((e, i) => {
  const o = 6 + i * 16;
  header.writeUInt8(e.size >= 256 ? 0 : e.size, o);
  header.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1);
  header.writeUInt8(0, o + 2);
  header.writeUInt8(0, o + 3);
  header.writeUInt16LE(1, o + 4);
  header.writeUInt16LE(32, o + 6);
  header.writeUInt32LE(e.data.length, o + 8);
  header.writeUInt32LE(offset, o + 12);
  offset += e.data.length;
});
writeFileSync("build/icon.ico", Buffer.concat([header, ...entries.map((e) => e.data)]));
console.log(`build/icon.ico (${ICO_SIZES.join(", ")} px), build/icon.png (512 px), build/icons/*.png`);
