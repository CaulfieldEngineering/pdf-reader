/**
 * Drawing regions: clusters of vector graphics and images (figures, diagrams,
 * schematics). Objects are rasterised onto a coarse grid and grouped by
 * connected cells, which stays fast even for schematics with thousands of
 * path objects.
 */

import type { Box, Region, Word } from "./model";
import type { Graphic } from "./graphics";

export interface RegionResult {
  regions: Region[];
  rules: Box[];
}

function inside(x: number, y: number, b: Box, pad = 1): boolean {
  return b[0] - pad <= x && x <= b[2] + pad && b[1] - pad <= y && y <= b[3] + pad;
}

export function findRegions(objects: Graphic[], words: Word[], tableBoxes: Box[], width: number, height: number): RegionResult {
  const rules: Box[] = [];
  const keep: Graphic[] = [];

  // Index word bottoms for the underline test
  const byY = new Map<number, Word[]>();
  for (const w of words) {
    const k = Math.floor(w.bottom / 4);
    if (!byY.has(k)) byY.set(k, []);
    byY.get(k)!.push(w);
  }
  const underline = (x0: number, y: number, x1: number): boolean => {
    const k = Math.floor(y / 4);
    for (const kk of [k - 1, k, k + 1]) {
      for (const w of byY.get(kk) ?? []) {
        if (Math.abs(y - w.bottom) <= Math.max(2.5, 0.35 * w.size) && Math.min(x1, w.x1) - Math.max(x0, w.x0) > 0.5 * (x1 - x0)) return true;
      }
    }
    return false;
  };

  for (const o of objects) {
    const [x0, top, x1, bottom] = o.box;
    const ow = x1 - x0, oh = bottom - top;
    const cx = (x0 + x1) / 2, cy = (top + bottom) / 2;
    if (o.image) {
      if (ow * oh > 0.6 * width * height && words.length) continue; // scanned page or background
      keep.push(o);
      continue;
    }
    if (tableBoxes.some((tb) => inside(cx, cy, tb, 2))) continue;
    if (ow * oh > 0.4 * width * height) continue; // page frame or background
    if (oh < 1.5 && ow > 1) {
      if (ow >= 15 && ow <= 0.5 * width) rules.push(o.box);
      if (ow > 0.8 * width || underline(x0, top, x1)) continue;
    }
    if (ow < 1.5 && oh > 0.8 * height) continue;
    keep.push(o);
  }
  if (!keep.length) return { regions: [], rules };

  const cell = Math.max(4, Math.max(width, height) / 250);
  const nx = Math.floor(width / cell) + 2, ny = Math.floor(height / cell) + 2;
  const grid = new Int32Array(nx * ny).fill(-1); // -1 empty, -2 occupied, >=0 component
  const pad = 3;
  const firstCell: number[] = [];
  for (const o of keep) {
    const cx0 = Math.max(0, Math.floor((o.box[0] - pad) / cell));
    const cx1 = Math.min(nx - 1, Math.floor((o.box[2] + pad) / cell));
    const cy0 = Math.max(0, Math.floor((o.box[1] - pad) / cell));
    const cy1 = Math.min(ny - 1, Math.floor((o.box[3] + pad) / cell));
    if (cx1 < 0 || cy1 < 0 || cx0 >= nx || cy0 >= ny) { firstCell.push(-1); continue; }
    firstCell.push(cy0 * nx + cx0);
    for (let gy = cy0; gy <= cy1; gy++) for (let gx = cx0; gx <= cx1; gx++) grid[gy * nx + gx] = -2;
  }
  let comp = 0;
  const queue = new Int32Array(nx * ny);
  for (let start = 0; start < grid.length; start++) {
    if (grid[start] !== -2) continue;
    let head = 0, tail = 0;
    queue[tail++] = start;
    grid[start] = comp;
    while (head < tail) {
      const c = queue[head++];
      const gx = c % nx, gy = (c - gx) / nx;
      const nbs = [gx + 1 < nx ? c + 1 : -1, gx > 0 ? c - 1 : -1, gy + 1 < ny ? c + nx : -1, gy > 0 ? c - nx : -1];
      for (const nb of nbs) {
        if (nb >= 0 && grid[nb] === -2) { grid[nb] = comp; queue[tail++] = nb; }
      }
    }
    comp++;
  }

  const acc = new Map<number, { box: Box; count: number; image: boolean }>();
  keep.forEach((o, i) => {
    if (firstCell[i] < 0) return;
    const c = grid[firstCell[i]];
    const a = acc.get(c);
    if (!a) acc.set(c, { box: [...o.box] as Box, count: 1, image: o.image });
    else {
      a.box = [Math.min(a.box[0], o.box[0]), Math.min(a.box[1], o.box[1]), Math.max(a.box[2], o.box[2]), Math.max(a.box[3], o.box[3])];
      a.count++;
      a.image = a.image || o.image;
    }
  });
  const regions: Region[] = [];
  for (const { box, count, image } of acc.values()) {
    const w = box[2] - box[0], h = box[3] - box[1];
    if ((image && w * h >= 1500) || (count >= 6 && w >= 40 && h >= 25)) {
      regions.push({ x0: box[0], top: box[1], x1: box[2], bottom: box[3], objects: count, hasImage: image });
    }
  }
  return { regions, rules };
}
