"""Data model shared by extraction, the detectors and the server.

Coordinates are PDF points with the origin at the top left of the page
(pdfplumber's convention): x grows to the right, ``top`` and ``bottom`` grow
downwards.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Block kinds. "body" and "heading" are read; every other kind belongs to a
# skip group (see SKIP_GROUP) and is read or skipped according to the settings.
BODY = "body"
HEADING = "heading"
HEADER = "header"
FOOTER = "footer"
PAGE_NUMBER = "page_number"
TABLE = "table"
CAPTION = "caption"
FIGURE_TEXT = "figure_text"
FOOTNOTE = "footnote"
REFERENCES = "references"

# Inline span kinds (parts of a block's text)
SPAN_CITATION = "citation"
SPAN_URL = "url"
SPAN_FOOTNOTE_MARK = "footnote_mark"

SKIP_GROUP = {
    HEADER: "headers",
    FOOTER: "headers",
    PAGE_NUMBER: "headers",
    TABLE: "tables",
    CAPTION: "figures",
    FIGURE_TEXT: "figures",
    FOOTNOTE: "citations",
    REFERENCES: "citations",
    SPAN_CITATION: "citations",
    SPAN_URL: "citations",
    SPAN_FOOTNOTE_MARK: "citations",
}


@dataclass
class Word:
    text: str
    x0: float
    top: float
    x1: float
    bottom: float
    size: float
    font: str
    upright: bool = True
    sup: bool = False          # raised and smaller than the line: a superscript
    space_before: bool = True  # whether the text has a space before this word
    line: int = 0              # index of the line inside its block
    start: int = 0             # character offsets into Block.text
    end: int = 0

    @property
    def bold(self) -> bool:
        return is_bold(self.font)


@dataclass
class Line:
    words: list[Word]
    x0: float
    top: float
    x1: float
    bottom: float
    size: float  # dominant font size of the line

    @property
    def text(self) -> str:
        return join_words(self.words)


@dataclass
class Span:
    start: int
    end: int
    kind: str
    replacement: str = ""  # what to say instead when the span is skipped ("" = nothing)

    @property
    def group(self) -> str:
        return SKIP_GROUP.get(self.kind, "")


@dataclass
class TableRow:
    cells: list[str]
    bbox: tuple[float, float, float, float]


@dataclass
class Block:
    page: int
    lines: list[Line]
    x0: float
    top: float
    x1: float
    bottom: float
    size: float
    id: int = -1
    text: str = ""
    words: list[Word] = field(default_factory=list)
    kind: str = BODY
    reason: str = ""
    level: int = 0                       # heading level (1 = top) when kind == heading
    spans: list[Span] = field(default_factory=list)
    sentences: list[tuple[int, int]] = field(default_factory=list)
    table: list[TableRow] | None = None  # rows, for kind == table
    bold_frac: float = 0.0

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    @property
    def height(self) -> float:
        return self.bottom - self.top

    @property
    def group(self) -> str:
        return SKIP_GROUP.get(self.kind, "")

    def label(self, kind: str, reason: str) -> None:
        self.kind = kind
        self.reason = reason


@dataclass
class Region:
    """A drawing or image area on a page (a figure, diagram or schematic)."""

    x0: float
    top: float
    x1: float
    bottom: float
    objects: int
    has_image: bool

    def contains(self, x: float, y: float, pad: float = 0.0) -> bool:
        return self.x0 - pad <= x <= self.x1 + pad and self.top - pad <= y <= self.bottom + pad


@dataclass
class Page:
    index: int
    width: float
    height: float
    blocks: list[Block] = field(default_factory=list)
    regions: list[Region] = field(default_factory=list)
    rules: list[tuple[float, float, float, float]] = field(default_factory=list)  # short horizontal lines


@dataclass
class Section:
    title: str
    level: int
    page: int
    block: int  # block id the section starts at
    source: str  # "outline" or "headings"


@dataclass
class Document:
    name: str
    pages: list[Page]
    body_size: float = 10.0
    sections: list[Section] = field(default_factory=list)

    @property
    def blocks(self) -> list[Block]:
        return [b for p in self.pages for b in p.blocks]


def is_bold(font: str) -> bool:
    f = font.lower()
    return any(k in f for k in ("bold", "black", "heavy", "semibold", "demi"))


def join_words(words: list[Word]) -> str:
    out = []
    for i, w in enumerate(words):
        if i and w.space_before:
            out.append(" ")
        out.append(w.text)
    return "".join(out)
