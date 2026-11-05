"""Figure captions and text inside figures (diagram and schematic labels)."""

from __future__ import annotations

import re

from ..model import BODY, CAPTION, FIGURE_TEXT, HEADING, Block, Document, Page

CAPTION_RE = re.compile(
    r"^(?:figure|fig\.?|figs\.?|table|tab\.|exhibit|chart|diagram|scheme|plate|listing|"
    r"illustration|graph|photo|image|drawing)\s*"
    r"(?:[A-Z]?\d+(?:[.\-–]\d+)*[a-z]?|[A-Z]|[IVX]+)\b",
    re.I,
)
SEPARATORS = ".:-–—|)"
SENTENCE_END = re.compile(r"[.!?;]$")


def is_caption(b: Block, body_size: float, near_figure: bool) -> bool:
    text = b.text.strip()
    m = CAPTION_RE.match(text)
    if not m:
        return False
    rest = text[m.end():]
    if not rest.strip():
        return True  # just "Figure 3"
    if rest.lstrip()[0] in SEPARATORS:
        return True
    # "Figure 3 Block diagram ..." (no separator): only when it looks like a
    # caption, so "Figure 3 shows ..." in running text is still read.
    if rest.lstrip()[0].isupper() and (near_figure or b.size < 0.95 * body_size) and len(b.lines) <= 4:
        return True
    return False


def _near_figure(page: Page, b: Block, dist: float = 60.0) -> bool:
    for r in page.regions:
        if b.x1 >= r.x0 - dist and b.x0 <= r.x1 + dist and b.bottom >= r.top - dist and b.top <= r.bottom + dist:
            return True
    for o in page.blocks:
        if o.kind == "table" and b.bottom >= o.top - dist and b.top <= o.bottom + dist:
            return True
    return False


class CaptionDetector:
    name = "captions"
    group = "figures"

    def run(self, doc: Document) -> None:
        for page in doc.pages:
            for b in page.blocks:
                if b.kind in (BODY, HEADING) and is_caption(b, doc.body_size, _near_figure(page, b)):
                    b.label(CAPTION, "Figure or table caption")


def label_like(b: Block, body_size: float) -> bool:
    """A short, single-line, small-font fragment such as a schematic label."""
    if len(b.lines) != 1 or len(b.words) > 4 or len(b.text) > 30:
        return False
    if SENTENCE_END.search(b.text.strip()):
        return False
    return b.size <= 0.95 * body_size


class FigureTextDetector:
    name = "figure_text"
    group = "figures"

    def run(self, doc: Document) -> None:
        for page in doc.pages:
            self._in_regions(page, doc.body_size)
            self._rotated(page)
            self._label_clusters(page, doc.body_size)

    @staticmethod
    def _in_regions(page: Page, body_size: float) -> None:
        for b in page.blocks:
            if b.kind != BODY:
                continue
            cx, cy = (b.x0 + b.x1) / 2, (b.top + b.bottom) / 2
            for r in page.regions:
                if not r.contains(cx, cy, pad=4.0):
                    continue
                n_words = len(b.words)
                per_line = n_words / max(1, len(b.lines))
                # Prose inside a framed box is still read
                if n_words <= 8 or per_line <= 4:
                    what = "image" if r.has_image else "drawing"
                    b.label(FIGURE_TEXT, f"Text inside a {what} ({r.objects} objects)")
                break

    @staticmethod
    def _rotated(page: Page) -> None:
        for b in page.blocks:
            if b.kind == BODY and b.words and not any(w.upright for w in b.words) and len(b.words) <= 10:
                b.label(FIGURE_TEXT, "Rotated text, likely a diagram label")

    @staticmethod
    def _label_clusters(page: Page, body_size: float, reach: float = 80.0, min_size: int = 5) -> None:
        cands = [b for b in page.blocks if b.kind == BODY and label_like(b, body_size)]
        if len(cands) < min_size:
            return
        parent = list(range(len(cands)))

        def find(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        centers = [((b.x0 + b.x1) / 2, (b.top + b.bottom) / 2) for b in cands]
        for i in range(len(cands)):
            for j in range(i + 1, len(cands)):
                dx = centers[i][0] - centers[j][0]
                dy = centers[i][1] - centers[j][1]
                if dx * dx + dy * dy <= reach * reach:
                    parent[find(i)] = find(j)
        clusters: dict[int, list[Block]] = {}
        for i, b in enumerate(cands):
            clusters.setdefault(find(i), []).append(b)
        for members in clusters.values():
            if len(members) < min_size:
                continue
            # A list of short items is a stack at one or two x positions; labels
            # scattered over a drawing spread out in both directions.
            xs = {round(b.x0 / 5) for b in members}
            ys = {round(b.top / 5) for b in members}
            if len(xs) < 3 or len(ys) < 2:
                continue
            for b in members:
                b.label(FIGURE_TEXT, f"One of {len(members)} short labels scattered together")
