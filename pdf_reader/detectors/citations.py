"""Citations, URLs, footnotes and the References section."""

from __future__ import annotations

import re
from urllib.parse import urlsplit

from ..model import (
    BODY,
    CAPTION,
    FIGURE_TEXT,
    FOOTER,
    FOOTNOTE,
    HEADER,
    HEADING,
    PAGE_NUMBER,
    REFERENCES,
    SPAN_CITATION,
    SPAN_FOOTNOTE_MARK,
    SPAN_URL,
    TABLE,
    Block,
    Document,
    Span,
)

# --------------------------------------------------------------------------- inline

BRACKET_RE = re.compile(
    r"\[\s*(?:\d{1,4}(?:\s*[,–—\-]\s*\d{1,4})*|[A-Z][A-Za-z+]{1,12}\d{2,4}[a-z]?(?:\s*[,;]\s*[A-Z][A-Za-z+]{1,12}\d{2,4}[a-z]?)*)\s*\]"
)
PAREN_RE = re.compile(r"\(([^()]{4,240})\)")
YEAR = r"(?:1[89]|20)\d{2}[a-z]?"
AUTHOR_PART_RE = re.compile(
    r"^(?:(?:see|e\.g\.,?|cf\.|i\.e\.,?)\s+)?"
    r"[A-Z][\w'’\-]+(?:(?:\s+|,\s*)(?:et\s+al\.?|and|&|[A-Z][\w'’\-]+|van|von|de|der|da|del|la|le))*"
    r",?\s+" + YEAR + r"(?:[a-z])?(?:\s*,\s*" + YEAR + r")*"
    r"(?:\s*,\s*(?:pp?\.|ch\.|sec\.)\s*\d+(?:[\-–]\d+)?)?$"
)
NOT_AUTHORS = {
    "january", "february", "march", "april", "may", "june", "july", "august", "september",
    "october", "november", "december", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep",
    "sept", "oct", "nov", "dec", "rev", "revision", "version", "ver", "fy", "q1", "q2", "q3",
    "q4", "spring", "summer", "fall", "autumn", "winter", "est", "since", "circa", "updated",
    "issued", "published", "effective", "as", "in", "by", "from", "until", "through", "the",
}
YEAR_ONLY_RE = re.compile(r"\(\s*" + YEAR + r"(?:\s*[,;]\s*" + YEAR + r")*\s*\)")
URL_RE = re.compile(r"(?:https?://|www\.)[^\s<>\"]+", re.I)
DOI_RE = re.compile(r"\b(?:doi:\s*|https?://doi\.org/)?10\.\d{4,9}/[^\s<>\"]+", re.I)
MARK_RE = re.compile(r"^(?:\d{1,3}(?:[,–\-]\d{1,3})*|[*†‡§¶]+|[a-z])$")
UNITS = {"m", "cm", "mm", "km", "s", "ms", "ft", "in", "kg", "g", "x", "y", "z", "n", "e", "m/s"}


def _is_author_year(inner: str) -> bool:
    parts = [p.strip() for p in inner.split(";") if p.strip()]
    if not parts:
        return False
    for p in parts:
        if not AUTHOR_PART_RE.match(p):
            return False
        first = re.sub(r"^(?:see|e\.g\.,?|cf\.|i\.e\.,?)\s+", "", p, flags=re.I).split()[0].strip(",").lower()
        if first in NOT_AUTHORS:
            return False
    return True


def find_inline(text: str) -> list[Span]:
    spans: list[Span] = []
    for m in BRACKET_RE.finditer(text):
        spans.append(Span(m.start(), m.end(), SPAN_CITATION))
    for m in PAREN_RE.finditer(text):
        if _is_author_year(m.group(1).strip()):
            spans.append(Span(m.start(), m.end(), SPAN_CITATION))
    for m in YEAR_ONLY_RE.finditer(text):
        # "Smith et al. (2020)": keep the names, drop the year
        before = text[max(0, m.start() - 40):m.start()]
        if re.search(r"(?:et al\.?|[A-Z][a-z]+(?:\s+(?:and|&)\s+[A-Z][a-z]+)?)\s*$", before):
            spans.append(Span(m.start(), m.end(), SPAN_CITATION))
    for m in URL_RE.finditer(text):
        url = m.group(0).rstrip(".,;:!?)]}'\"")
        host = urlsplit(url if "://" in url else "http://" + url).hostname or ""
        host = host[4:] if host.startswith("www.") else host
        spans.append(Span(m.start(), m.start() + len(url), SPAN_URL, replacement=host))
    for m in DOI_RE.finditer(text):
        doi = m.group(0).rstrip(".,;:!?)]}'\"")
        spans.append(Span(m.start(), m.start() + len(doi), SPAN_URL))
    return spans


def footnote_marks(b: Block) -> list[Span]:
    out = []
    for i, w in enumerate(b.words):
        if not w.sup or not MARK_RE.match(w.text):
            continue
        if i == 0:
            continue  # a marker opening a footnote; the footnote block handles it
        prev = b.words[i - 1]
        if prev.sup:
            continue
        p = prev.text
        # Exponents: "10³", "m²"
        if p[-1:].isdigit() or p.lower().rstrip(".,") in UNITS or len(p) < 3 and p[-1:].isalpha():
            continue
        out.append(Span(w.start, w.end, SPAN_FOOTNOTE_MARK))
    return out


def merge_spans(spans: list[Span]) -> list[Span]:
    spans = sorted(spans, key=lambda s: (s.start, -(s.end - s.start)))
    out: list[Span] = []
    for s in spans:
        if out and s.start < out[-1].end:
            if s.end > out[-1].end:
                out[-1].end = s.end
            continue
        out.append(s)
    return out


class CitationDetector:
    name = "inline_citations"
    group = "citations"
    kinds = (BODY, HEADING, CAPTION, FOOTNOTE)

    def run(self, doc: Document) -> None:
        for b in doc.blocks:
            if b.kind not in self.kinds or not b.text:
                continue
            b.spans = merge_spans(b.spans + find_inline(b.text) + footnote_marks(b))


# --------------------------------------------------------------------------- footnotes

FOOTNOTE_START_RE = re.compile(r"^\s*(?:\d{1,3}|[*†‡§¶]+)[\s.)]?\s*\S")


class FootnoteDetector:
    """Small-font notes at the bottom of a page, below all body-size text."""

    name = "footnotes"
    group = "citations"

    def run(self, doc: Document) -> None:
        body = doc.body_size
        for page in doc.pages:
            h = page.height
            body_blocks = [b for b in page.blocks if b.kind in (BODY, HEADING) and b.size >= 0.95 * body]
            floor = max((b.bottom for b in body_blocks), default=0.0)
            cands = sorted(
                (
                    b
                    for b in page.blocks
                    if b.kind == BODY and b.size <= 0.9 * body and b.top >= 0.5 * h and b.top >= floor - 2
                    and not any(r.contains((b.x0 + b.x1) / 2, (b.top + b.bottom) / 2) for r in page.regions)
                ),
                key=lambda b: b.top,
            )
            started = False
            for b in cands:
                if not started:
                    marker = bool(FOOTNOTE_START_RE.match(b.text)) or (b.words and b.words[0].sup)
                    rule = any(
                        b.top - 20 <= r[1] <= b.top + 1 and abs(r[0] - b.x0) <= 25 and (r[2] - r[0]) < 0.6 * page.width
                        for r in page.rules
                    )
                    started = marker or rule
                if started:
                    b.label(FOOTNOTE, "Small text at the foot of the page")


# --------------------------------------------------------------------------- references

REF_HEAD_RE = re.compile(
    r"^(?:\d+(?:\.\d+)*\.?\s+|[A-Z]\.\s+|[IVX]+\.\s+)?"
    r"(?:references|bibliography|works cited|literature cited|reference list|cited works|"
    r"references and notes|cited literature|sources)\s*:?$",
    re.I,
)
APPENDIX_RE = re.compile(r"^(?:\d+(?:\.\d+)*\.?\s+|[A-Z]\.?\s+)?(?:appendix|appendices|annex)\b", re.I)
REF_ENTRY_RE = re.compile(r"(?:^\s*\[\d+\])|(?:^\s*\d{1,3}\.\s)|(?:\b(?:1[89]|20)\d{2}[a-z]?\b)")
SKIPPED_KINDS = (HEADER, FOOTER, PAGE_NUMBER)


class ReferencesDetector:
    """The References / Bibliography section, from its heading onward.

    It stops at a following "Appendix" heading so appendices are still read.
    """

    name = "references"
    group = "citations"

    def run(self, doc: Document) -> None:
        blocks = [b for b in doc.blocks if b.kind not in SKIPPED_KINDS]
        if not blocks:
            return
        n_pages = len(doc.pages)
        start = None
        for i in range(len(blocks) - 1, -1, -1):
            b = blocks[i]
            if len(b.lines) > 2 or "...." in b.text or not REF_HEAD_RE.match(b.text.strip()):
                continue
            if b.size < 0.95 * doc.body_size and b.bold_frac < 0.5:
                continue
            if n_pages > 2 and b.page < 0.4 * (n_pages - 1):
                continue  # most likely a contents entry
            following = blocks[i + 1:i + 6]
            if not any(REF_ENTRY_RE.search(f.text) for f in following):
                continue
            start = i
            break
        if start is None:
            return
        blocks[start].label(REFERENCES, "References section heading")
        for b in blocks[start + 1:]:
            if len(b.lines) <= 2 and APPENDIX_RE.match(b.text.strip()) and (
                b.size > 1.05 * doc.body_size or b.bold_frac > 0.5
            ):
                break
            if b.kind in (BODY, HEADING, CAPTION, FIGURE_TEXT, FOOTNOTE, TABLE):
                b.label(REFERENCES, "In the References section")
