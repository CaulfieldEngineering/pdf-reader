"""Turn a pdfplumber page into lines, blocks, tables and drawing regions.

The pipeline for one page:

1. Ruled tables are found with pdfplumber's line strategy. Their words are kept
   apart and become one table block each.
2. The other words are clustered into rows by vertical overlap, and each row is
   split into segments where the horizontal gap is too wide to be a word space
   (columns, footer fields, scattered labels).
3. Segments are merged into blocks (paragraphs) by spacing, alignment and font.
4. Vector drawings and images are clustered into regions (figures, schematics).
5. Blocks are put in reading order with a column-aware XY cut.
"""

from __future__ import annotations

import re
import statistics
from collections import deque

from .model import Block, Line, Page, Region, TableRow, Word, is_bold, join_words

WORD_OPTS = dict(
    x_tolerance=1.5,
    y_tolerance=2.5,
    keep_blank_chars=False,
    use_text_flow=False,
    extra_attrs=["fontname", "size"],
)

BULLET_RE = re.compile(r"^(?:[•◦▪●‣⁃∙\-–·*]\s|\(?[0-9]{1,2}[.)]\s|\(?[a-z][.)]\s|\([ivx]{1,4}\)\s)")
CID_RE = re.compile(r"\(cid:\d+\)")
SENTENCE_END_RE =re.compile(r"[.!?:;][\"'”’)\]]*$")


# --------------------------------------------------------------------------- words


def _words(page) -> list[Word]:
    ox, oy = page.bbox[0], page.bbox[1]
    out = []
    for w in page.extract_words(**WORD_OPTS):
        text = w["text"].strip()
        if "(cid:" in text:
            # Glyphs without a Unicode mapping. A lone one is usually a bullet
            # or symbol; inside a word it is noise.
            stripped = CID_RE.sub("", text)
            text = stripped if stripped else "•"
        if not text:
            continue
        out.append(
            Word(
                text=text,
                x0=float(w["x0"]) - ox,
                top=float(w["top"]) - oy,
                x1=float(w["x1"]) - ox,
                bottom=float(w["bottom"]) - oy,
                size=float(w.get("size") or 10.0),
                font=str(w.get("fontname") or ""),
                upright=bool(w.get("upright", True)),
            )
        )
    return out


# --------------------------------------------------------------------------- lines


class _Row:
    __slots__ = ("words", "top", "bottom")

    def __init__(self, w: Word):
        self.words = [w]
        self.top, self.bottom = w.top, w.bottom

    def accepts(self, w: Word) -> bool:
        ov = min(self.bottom, w.bottom) - max(self.top, w.top)
        return ov >= 0.5 * min(w.bottom - w.top, self.bottom - self.top)

    def add(self, w: Word) -> None:
        self.words.append(w)
        # The row's core is the box of its largest word, so superscripts and
        # subscripts don't stretch it into the neighbouring lines.
        if (w.bottom - w.top) > (self.bottom - self.top):
            self.top, self.bottom = w.top, w.bottom


def _dominant_size(words: list[Word]) -> float:
    weights: dict[float, int] = {}
    for w in words:
        k = round(w.size, 1)
        weights[k] = weights.get(k, 0) + len(w.text)
    return max(weights.items(), key=lambda kv: (kv[1], kv[0]))[0] if weights else 10.0


def _lines(words: list[Word]) -> list[Line]:
    """Cluster words into rows, then split rows into segments at wide gaps."""
    rows: list[_Row] = []
    upright = [w for w in words if w.upright]
    rotated = [w for w in words if not w.upright]
    for w in sorted(upright, key=lambda w: (w.top, w.x0)):
        for r in reversed(rows[-8:]):
            if r.accepts(w):
                r.add(w)
                break
        else:
            rows.append(_Row(w))

    lines: list[Line] = []
    for r in rows:
        ws = sorted(r.words, key=lambda w: w.x0)
        size = _dominant_size(ws)
        main = [w for w in ws if w.size >= 0.9 * size] or ws
        baseline = statistics.median(w.bottom for w in main)
        for w in ws:
            w.sup = w.size < 0.85 * size and w.bottom < baseline - 0.2 * size
        seg: list[Word] = []
        for w in ws:
            if seg:
                gap = w.x0 - seg[-1].x1
                if gap > max(1.6 * size, 6.0):
                    lines.append(_make_line(seg))
                    seg = []
                else:
                    w.space_before = gap > 0.12 * min(size, w.size) or (seg[-1].sup and not w.sup)
            seg.append(w)
        if seg:
            lines.append(_make_line(seg))
    # Rotated words (vertical labels) each become their own line
    for w in rotated:
        lines.append(_make_line([w]))
    return lines


def _make_line(words: list[Word]) -> Line:
    words[0].space_before = True
    return Line(
        words=words,
        x0=min(w.x0 for w in words),
        top=min(w.top for w in words if not w.sup) if any(not w.sup for w in words) else min(w.top for w in words),
        x1=max(w.x1 for w in words),
        bottom=max(w.bottom for w in words),
        size=_dominant_size(words),
    )


def _bold_frac(words: list[Word]) -> float:
    total = sum(len(w.text) for w in words) or 1
    return sum(len(w.text) for w in words if w.bold) / total


# --------------------------------------------------------------------------- blocks


class _Draft:
    def __init__(self, line: Line):
        self.lines = [line]
        self.x0, self.top, self.x1, self.bottom = line.x0, line.top, line.x1, line.bottom
        self.size = line.size
        self.gap: float | None = None  # typical gap between its lines

    def add(self, line: Line, gap: float) -> None:
        if self.gap is None:
            self.gap = gap
        self.lines.append(line)
        self.x0, self.x1 = min(self.x0, line.x0), max(self.x1, line.x1)
        self.bottom = max(self.bottom, line.bottom)


def _joins(d: _Draft, ln: Line) -> bool:
    last = d.lines[-1]
    size = max(ln.size, last.size)
    if not (0.88 <= ln.size / last.size <= 1.14):
        return False
    gap = ln.top - last.bottom
    if gap < -0.45 * size:
        return False
    limit = (d.gap + 0.3 * size) if d.gap is not None else 0.65 * size
    if gap > max(limit, 0.25 * size):
        return False
    # Horizontal relation: left aligned (allowing a hanging indent), or both centred
    left_ok = abs(ln.x0 - d.x0) <= 3.0 * size and ln.x1 <= d.x1 + 4.0 * size
    cx_ok = abs((ln.x0 + ln.x1) / 2 - (last.x0 + last.x1) / 2) <= 2.0 * size and (
        min(ln.x1, last.x1) > max(ln.x0, last.x0)
    )
    if not (left_ok or cx_ok):
        return False
    # Font weight change: a bold line followed by a regular one is a heading break
    lb, nb = _bold_frac(last.words), _bold_frac(ln.words)
    if (lb > 0.8 and nb < 0.3) or (lb < 0.3 and nb > 0.8):
        return False
    text = ln.text
    if BULLET_RE.match(text) and ln.x0 <= d.x0 + 1.0 * size:
        return False
    # Paragraph end: the previous line is clearly short and ends a sentence
    if len(d.lines) >= 2 and SENTENCE_END_RE.search(last.text) and last.x1 < d.x1 - 3.0 * size:
        return False
    return True


def _blocks(lines: list[Line]) -> list[_Draft]:
    drafts: list[_Draft] = []
    for ln in sorted(lines, key=lambda l: (l.top, l.x0)):
        best, best_gap = None, None
        for d in drafts[-16:]:
            if d.lines[-1] is ln:
                continue
            last = d.lines[-1]
            if last.top >= ln.top - 0.2 * ln.size:
                continue  # not above this line
            if _joins(d, ln):
                g = ln.top - last.bottom
                if best_gap is None or g < best_gap:
                    best, best_gap = d, g
        if best is not None:
            best.add(ln, best_gap)
        else:
            drafts.append(_Draft(ln))
    return drafts


def _finalize(d_lines: list[Line], page: int) -> Block:
    words: list[Word] = []
    parts: list[str] = []
    pos = 0
    for li, ln in enumerate(d_lines):
        for wi, w in enumerate(ln.words):
            w.line = li
            if words:
                prev = words[-1]
                hyphen_join = (
                    wi == 0
                    and prev.text.endswith("-")
                    and len(prev.text) > 2
                    and prev.text[-2].isalpha()
                    and w.text[:1].islower()
                )
                if hyphen_join:
                    # "impor-" + "tant" -> "important": drop the hyphen from the text
                    parts[-1] = parts[-1][:-1]
                    pos -= 1
                    prev.end -= 1
                elif wi == 0 or w.space_before:
                    parts.append(" ")
                    pos += 1
            w.start = pos
            parts.append(w.text)
            pos += len(w.text)
            w.end = pos
            words.append(w)
    text = "".join(parts)
    return Block(
        page=page,
        lines=d_lines,
        x0=min(l.x0 for l in d_lines),
        top=min(l.top for l in d_lines),
        x1=max(l.x1 for l in d_lines),
        bottom=max(l.bottom for l in d_lines),
        size=_dominant_size(words),
        text=text,
        words=words,
        bold_frac=_bold_frac(words),
    )


# --------------------------------------------------------------------------- tables


def _tables(page, width: float, height: float) -> list[tuple[tuple[float, float, float, float], list[TableRow]]]:
    ox, oy = page.bbox[0], page.bbox[1]
    found = []
    try:
        tables = page.find_tables()
    except Exception:  # malformed drawing operators shouldn't kill the page
        return []
    for t in tables:
        try:
            data = t.extract()
            rows = t.rows
        except Exception:
            continue
        if len(data) < 2 or max((len(r) for r in data), default=0) < 2:
            continue
        cells = [c for r in data for c in r if c and c.strip()]
        if len(cells) < 3:
            continue
        x0, top, x1, bottom = t.bbox
        bbox = (x0 - ox, top - oy, x1 - ox, bottom - oy)
        area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
        longest = max(len(c) for c in cells)
        avg = sum(len(c) for c in cells) / len(cells)
        # A box drawn around prose (or a page frame) isn't a table
        if longest > 400 or (area > 0.5 * width * height and avg > 120):
            continue
        out_rows = []
        for r, row in zip(data, rows):
            rb = row.bbox
            out_rows.append(
                TableRow(
                    cells=[" ".join((c or "").split()) for c in r],
                    bbox=(rb[0] - ox, rb[1] - oy, rb[2] - ox, rb[3] - oy),
                )
            )
        found.append((bbox, out_rows))
    return found


def _inside(x: float, y: float, bbox, pad: float = 1.0) -> bool:
    return bbox[0] - pad <= x <= bbox[2] + pad and bbox[1] - pad <= y <= bbox[3] + pad


# --------------------------------------------------------------------------- regions


def _regions(page, width, height, words, table_boxes):
    ox, oy = page.bbox[0], page.bbox[1]
    objs: list[tuple[float, float, float, float, bool]] = []
    rules: list[tuple[float, float, float, float]] = []

    # Index word bottoms for the underline test
    by_y: dict[int, list[Word]] = {}
    for w in words:
        by_y.setdefault(int(w.bottom // 4), []).append(w)

    def underline(x0, y, x1) -> bool:
        for k in (int(y // 4) - 1, int(y // 4), int(y // 4) + 1):
            for w in by_y.get(k, ()):
                if abs(y - w.bottom) <= max(2.5, 0.35 * w.size) and min(x1, w.x1) - max(x0, w.x0) > 0.5 * (x1 - x0):
                    return True
        return False

    graphics = []
    for kind in ("rects", "lines", "curves"):
        try:
            graphics.extend(getattr(page, kind))
        except Exception:
            pass
    for o in graphics:
        x0, top, x1, bottom = float(o["x0"]) - ox, float(o["top"]) - oy, float(o["x1"]) - ox, float(o["bottom"]) - oy
        ow, oh = x1 - x0, bottom - top
        cx, cy = (x0 + x1) / 2, (top + bottom) / 2
        if any(_inside(cx, cy, tb, 2.0) for tb in table_boxes):
            continue
        if ow * oh > 0.4 * width * height:
            continue  # page frame or background
        if oh < 1.5 and ow > 1:
            if 15 <= ow <= 0.5 * width:
                rules.append((x0, top, x1, bottom))
            if ow > 0.8 * width or underline(x0, top, x1):
                continue
        if ow < 1.5 and oh > 0.8 * height:
            continue
        objs.append((x0, top, x1, bottom, False))
    try:
        images = page.images
    except Exception:
        images = []
    for im in images:
        x0, top, x1, bottom = float(im["x0"]) - ox, float(im["top"]) - oy, float(im["x1"]) - ox, float(im["bottom"]) - oy
        if (x1 - x0) * (bottom - top) > 0.6 * width * height and words:
            continue  # a scanned page or background image
        objs.append((x0, top, x1, bottom, True))
    if not objs:
        return [], rules

    cell = max(4.0, max(width, height) / 250.0)
    nx, ny = int(width // cell) + 2, int(height // cell) + 2
    grid: dict[tuple[int, int], int] = {}
    pad = 3.0
    obj_cells = []
    for i, (x0, top, x1, bottom, _) in enumerate(objs):
        cx0 = max(0, int((x0 - pad) // cell))
        cx1 = min(nx - 1, int((x1 + pad) // cell))
        cy0 = max(0, int((top - pad) // cell))
        cy1 = min(ny - 1, int((bottom + pad) // cell))
        obj_cells.append((cx0, cy0))
        for gx in range(cx0, cx1 + 1):
            for gy in range(cy0, cy1 + 1):
                grid[(gx, gy)] = -1

    comp: dict[tuple[int, int], int] = {}
    n = 0
    for start in grid:
        if start in comp:
            continue
        comp[start] = n
        q = deque([start])
        while q:
            gx, gy = q.popleft()
            for nb in ((gx + 1, gy), (gx - 1, gy), (gx, gy + 1), (gx, gy - 1)):
                if nb in grid and nb not in comp:
                    comp[nb] = n
                    q.append(nb)
        n += 1

    acc: dict[int, list] = {}
    for (x0, top, x1, bottom, img), c0 in zip(objs, obj_cells):
        c = comp[c0]
        a = acc.setdefault(c, [x0, top, x1, bottom, 0, False])
        a[0], a[1], a[2], a[3] = min(a[0], x0), min(a[1], top), max(a[2], x1), max(a[3], bottom)
        a[4] += 1
        a[5] = a[5] or img
    regions = []
    for x0, top, x1, bottom, count, img in acc.values():
        w, h = x1 - x0, bottom - top
        if img and w * h >= 1500:
            regions.append(Region(x0, top, x1, bottom, count, True))
        elif count >= 6 and w >= 40 and h >= 25:
            regions.append(Region(x0, top, x1, bottom, count, False))
    return regions, rules


# --------------------------------------------------------------------------- order


def _vertical_gap(blocks: list[Block], min_gap: float = 6.0):
    """The widest x interval inside the blocks' span that no block covers."""
    spans = sorted((b.x0, b.x1) for b in blocks)
    best = None
    reach = spans[0][1]
    for x0, x1 in spans[1:]:
        if x0 - reach >= min_gap and (best is None or x0 - reach > best[1] - best[0]):
            best = (reach, x0)
        reach = max(reach, x1)
    return best


def _bands(blocks: list[Block]) -> list[list[Block]]:
    bands: list[list[Block]] = []
    bottom = None
    for b in sorted(blocks, key=lambda b: (b.top, b.x0)):
        if bands and b.top < bottom - 0.5:
            bands[-1].append(b)
            bottom = max(bottom, b.bottom)
        else:
            bands.append([b])
            bottom = b.bottom
    return bands


def order_blocks(blocks: list[Block], depth: int = 0) -> list[Block]:
    if len(blocks) <= 1 or depth > 40:
        return sorted(blocks, key=lambda b: (b.top, b.x0))
    gap = _vertical_gap(blocks)
    if gap:
        mid = (gap[0] + gap[1]) / 2
        left = [b for b in blocks if (b.x0 + b.x1) / 2 < mid]
        right = [b for b in blocks if (b.x0 + b.x1) / 2 >= mid]
        return order_blocks(left, depth + 1) + order_blocks(right, depth + 1)
    bands = _bands(blocks)
    if len(bands) == 1:
        return sorted(blocks, key=lambda b: (b.top, b.x0))
    # Merge neighbouring bands that share a column gutter, so a two-column
    # stretch is read column by column even where its paragraph gaps line up.
    merged: list[list[Block]] = []
    shared = None
    for band in bands:
        g = _vertical_gap(band) if len(band) > 1 else None
        if merged and shared and g:
            lo, hi = max(shared[0], g[0]), min(shared[1], g[1])
            if hi - lo >= 4.0:
                merged[-1].extend(band)
                shared = (lo, hi)
                continue
        merged.append(list(band))
        shared = g
    out: list[Block] = []
    for band in merged:
        out.extend(order_blocks(band, depth + 1))
    return out


# --------------------------------------------------------------------------- page


def extract_page(page, index: int) -> Page:
    width, height = float(page.width), float(page.height)
    words = _words(page)
    tables = _tables(page, width, height)

    table_words: list[list[Word]] = [[] for _ in tables]
    free: list[Word] = []
    for w in words:
        cx, cy = (w.x0 + w.x1) / 2, (w.top + w.bottom) / 2
        for i, (bbox, _) in enumerate(tables):
            if _inside(cx, cy, bbox):
                table_words[i].append(w)
                break
        else:
            free.append(w)

    blocks = [_finalize(d.lines, index) for d in _blocks(_lines(free))]
    for (bbox, rows), tw in zip(tables, table_words):
        lines = sorted(_lines(tw), key=lambda l: (l.top, l.x0)) if tw else []
        if lines:
            b = _finalize(lines, index)
        else:
            b = Block(page=index, lines=[], x0=0, top=0, x1=0, bottom=0, size=10.0)
        b.x0, b.top, b.x1, b.bottom = bbox
        b.kind = "table"
        b.reason = f"Ruled table, {len(rows)} rows"
        b.table = rows
        blocks.append(b)

    regions, rules = _regions(page, width, height, words, [t[0] for t in tables])
    return Page(index=index, width=width, height=height, blocks=order_blocks(blocks), regions=regions, rules=rules)
