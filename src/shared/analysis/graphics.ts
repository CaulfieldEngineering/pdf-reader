/**
 * Vector graphics and images from a PDF.js operator list.
 *
 * The current transformation matrix is tracked through save / restore /
 * transform and form XObjects, so every path and image is placed in page
 * (viewport) coordinates.
 */

import type { Box } from "./model";

// PDF.js OPS codes (pdfjs-dist 6.x). A test checks them against the library.
export const OPS = {
  save: 10,
  restore: 11,
  transform: 12,
  stroke: 20,
  closeStroke: 21,
  fill: 22,
  eoFill: 23,
  fillStroke: 24,
  eoFillStroke: 25,
  closeFillStroke: 26,
  closeEOFillStroke: 27,
  endPath: 28,
  shadingFill: 62,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  paintImageMaskXObject: 83,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  paintImageXObjectRepeat: 88,
  paintImageMaskXObjectRepeat: 89,
  paintSolidColorImageMask: 90,
  constructPath: 91,
} as const;

const PAINT_OPS = new Set<number>([
  OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke,
  OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke,
]);
const STROKE_OPS = new Set<number>([
  OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke,
]);
const IMAGE_OPS = new Set<number>([
  OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject,
  OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectRepeat, OPS.paintSolidColorImageMask,
]);
// Path drawing commands inside constructPath data (PDF.js DrawOPS)
const MOVE = 0, LINE = 1, CURVE = 2, QUAD = 3, CLOSE = 4;

export type Matrix = [number, number, number, number, number, number];

export function multiply(m: Matrix, n: Matrix): Matrix {
  // Same convention as pdfjs Util.transform(m, n)
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function boxOf(m: Matrix, x0: number, y0: number, x1: number, y1: number): Box {
  const pts = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** An axis-aligned straight segment: horizontal (y fixed) or vertical (x fixed). */
export interface Segment {
  horizontal: boolean;
  /** Fixed coordinate (y for horizontal, x for vertical). */
  at: number;
  from: number;
  to: number;
}

export interface Graphic {
  box: Box;
  image: boolean;
}

export interface Graphics {
  objects: Graphic[];
  segments: Segment[];
}

interface OperatorList {
  fnArray: number[];
  argsArray: unknown[];
}

function addSegment(out: Segment[], a: [number, number], b: [number, number]): void {
  const dx = Math.abs(a[0] - b[0]), dy = Math.abs(a[1] - b[1]);
  if (dy < 1 && dx >= 2) out.push({ horizontal: true, at: (a[1] + b[1]) / 2, from: Math.min(a[0], b[0]), to: Math.max(a[0], b[0]) });
  else if (dx < 1 && dy >= 2) out.push({ horizontal: false, at: (a[0] + b[0]) / 2, from: Math.min(a[1], b[1]), to: Math.max(a[1], b[1]) });
}

/** Turn one painted path into segments (for ruled tables). */
function pathSegments(data: ArrayLike<number>, m: Matrix, stroked: boolean, out: Segment[]): void {
  let start: [number, number] | null = null;
  let cur: [number, number] | null = null;
  const poly: [number, number][] = [];
  let curved = false;
  for (let i = 0; i < data.length; ) {
    const op = data[i++];
    if (op === MOVE) {
      cur = apply(m, data[i], data[i + 1]);
      start = cur;
      poly.push(cur);
      i += 2;
    } else if (op === LINE) {
      const p = apply(m, data[i], data[i + 1]);
      if (cur && stroked) addSegment(out, cur, p);
      cur = p;
      poly.push(p);
      i += 2;
    } else if (op === CURVE) {
      cur = apply(m, data[i + 4], data[i + 5]);
      curved = true;
      i += 6;
    } else if (op === QUAD) {
      cur = apply(m, data[i + 2], data[i + 3]);
      curved = true;
      i += 4;
    } else if (op === CLOSE) {
      if (cur && start && stroked) addSegment(out, cur, start);
      cur = start;
    } else {
      break; // unknown command: stop rather than misread the rest
    }
  }
  if (stroked || curved || poly.length < 4) return;
  // A filled rectangle: a thin one is a rule; a larger one contributes its
  // edges (cell shading), as pdfplumber does.
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const axisAligned = poly.every((p) => (Math.abs(p[0] - x0) < 0.5 || Math.abs(p[0] - x1) < 0.5) && (Math.abs(p[1] - y0) < 0.5 || Math.abs(p[1] - y1) < 0.5));
  if (!axisAligned) return;
  if (y1 - y0 < 2 && x1 - x0 >= 2) out.push({ horizontal: true, at: (y0 + y1) / 2, from: x0, to: x1 });
  else if (x1 - x0 < 2 && y1 - y0 >= 2) out.push({ horizontal: false, at: (x0 + x1) / 2, from: y0, to: y1 });
  else if (x1 - x0 >= 2 && y1 - y0 >= 2) {
    out.push({ horizontal: true, at: y0, from: x0, to: x1 }, { horizontal: true, at: y1, from: x0, to: x1 });
    out.push({ horizontal: false, at: x0, from: y0, to: y1 }, { horizontal: false, at: x1, from: y0, to: y1 });
  }
}

/** Collect painted paths and images, in page coordinates. */
export function readGraphics(ops: OperatorList, base: Matrix): Graphics {
  const objects: Graphic[] = [];
  const segments: Segment[] = [];
  let m: Matrix = [...base];
  const stack: Matrix[] = [];
  const n = ops.fnArray.length;
  for (let i = 0; i < n; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] as any;
    switch (fn) {
      case OPS.save:
        stack.push(m);
        break;
      case OPS.restore:
        m = stack.pop() ?? m;
        break;
      case OPS.transform:
        m = multiply(m, args as Matrix);
        break;
      case OPS.paintFormXObjectBegin:
        stack.push(m);
        if (Array.isArray(args?.[0]) || ArrayBuffer.isView(args?.[0])) m = multiply(m, Array.from(args[0] as ArrayLike<number>) as Matrix);
        break;
      case OPS.paintFormXObjectEnd:
        m = stack.pop() ?? m;
        break;
      case OPS.constructPath: {
        const paint = args?.[0] as number;
        const data = args?.[1]?.[0] as ArrayLike<number> | null;
        const minMax = args?.[2] as ArrayLike<number> | null;
        if (!PAINT_OPS.has(paint) || !minMax) break;
        objects.push({ box: boxOf(m, minMax[0], minMax[1], minMax[2], minMax[3]), image: false });
        if (data) pathSegments(data, m, STROKE_OPS.has(paint), segments);
        break;
      }
      default:
        if (IMAGE_OPS.has(fn)) objects.push({ box: boxOf(m, 0, 0, 1, 1), image: true });
    }
  }
  return { objects, segments };
}
