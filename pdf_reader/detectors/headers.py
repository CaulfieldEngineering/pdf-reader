"""Running headers, footers and page numbers.

A block in the top or bottom margin is a running header or footer when the
same text, with digits normalised ("Page 3 of 40" == "Page 7 of 40"), appears
at about the same height on several pages. A block in the margin that is only
a page number ("12", "- 12 -", "Page 12", "12 / 40", "xii") is a page number.
"""

from __future__ import annotations

import re
import statistics

from ..model import BODY, FOOTER, HEADER, PAGE_NUMBER, Document

REPEAT_ZONE = 0.14     # fraction of page height searched for repeated text
NUMBER_ZONE = 0.12     # fraction of page height searched for page numbers
Y_TOLERANCE = 0.03     # fraction of page height a repeat may drift

PAGE_NUM_RE = re.compile(
    r"^(?:page|pg\.?|p\.)?\s*[-–—(\[]?\s*(?:\d{1,4}|[ivxlcdm]{1,7})\s*[-–—)\]]?"
    r"\s*(?:(?:of|/)\s*\d{1,4})?$",
    re.I,
)


def normalize(text: str) -> str:
    t = text.lower()
    t = re.sub(r"\d+", "#", t)
    t = re.sub(r"[^\w#]+", " ", t)
    return " ".join(t.split())


class HeaderFooterDetector:
    name = "headers"
    group = "headers"

    def run(self, doc: Document) -> None:
        n = len(doc.pages)
        groups: dict[tuple[str, str], list] = {}
        for page in doc.pages:
            h = page.height
            for b in page.blocks:
                if b.kind != BODY or len(b.lines) > 3 or not b.text.strip():
                    continue
                if b.bottom <= REPEAT_ZONE * h:
                    zone = "top"
                elif b.top >= (1 - REPEAT_ZONE) * h:
                    zone = "bottom"
                else:
                    continue
                key = normalize(b.text)
                if not key or key == "#":
                    continue
                groups.setdefault((zone, key), []).append((page, b))

        min_repeat = 2 if n <= 4 else 3
        for (zone, _), members in groups.items():
            ys = [b.top / p.height for p, b in members]
            mid = statistics.median(ys)
            near = [(p, b) for (p, b), y in zip(members, ys) if abs(y - mid) <= Y_TOLERANCE]
            pages = {p.index for p, _ in near}
            if len(pages) < min_repeat:
                continue
            kind = HEADER if zone == "top" else FOOTER
            where = "top" if zone == "top" else "bottom"
            for _, b in near:
                b.label(kind, f"Repeats in the {where} margin on {len(pages)} of {n} pages")

        for page in doc.pages:
            h = page.height
            for b in page.blocks:
                if b.kind != BODY or len(b.lines) != 1:
                    continue
                in_zone = b.bottom <= NUMBER_ZONE * h or b.top >= (1 - NUMBER_ZONE) * h
                if in_zone and PAGE_NUM_RE.match(b.text.strip()):
                    b.label(PAGE_NUMBER, "Page number in the margin")
