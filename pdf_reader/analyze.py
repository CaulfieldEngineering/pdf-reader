"""Whole-document analysis: extraction, detectors, headings, sections, sentences."""

from __future__ import annotations

import io
import re
import threading
from typing import Callable

import pdfplumber
import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c

from .detectors import GROUPS, run_all
from .extract import extract_page
from .model import BODY, HEADING, REFERENCES, Block, Document, Section
from .text import split_sentences

# pdfium is not thread safe; every pdfium call in the app goes through this lock
PDFIUM_LOCK = threading.RLock()

NUMBERED_RE = re.compile(r"^(?:(?:chapter|section|part)\s+)?(\d+(?:\.\d+){0,4})\.?\s+\S", re.I)
LETTERED_RE = re.compile(r"^(?:appendix\s+)?[A-Z](?:\.\d+)*[.)]?\s+[A-Z]")


def body_size(doc: Document) -> float:
    weights: dict[float, int] = {}
    for b in doc.blocks:
        if b.kind == BODY:
            k = round(b.size * 2) / 2
            weights[k] = weights.get(k, 0) + len(b.text)
    if not weights:
        return 10.0
    return max(weights.items(), key=lambda kv: kv[1])[0]


# --------------------------------------------------------------------------- headings


def _heading_like(b: Block, body: float) -> bool:
    text = b.text.strip()
    if len(b.lines) > 3 or not (2 <= len(text) <= 160) or not re.search(r"[A-Za-z]{2}", text):
        return False
    n_words = len(text.split())
    if n_words > 20:
        return False
    if text[-1] in ",;" or (text[-1] == "." and n_words > 6):
        return False
    if b.size >= 1.15 * body:
        return True
    numbered = bool(NUMBERED_RE.match(text) or LETTERED_RE.match(text))
    if b.bold_frac >= 0.85 and b.size >= 0.95 * body and n_words <= 14:
        return True
    if numbered and (b.bold_frac >= 0.5 or b.size >= 1.05 * body) and n_words <= 14:
        return True
    return False


def detect_headings(doc: Document) -> list[Block]:
    body = doc.body_size
    heads = [
        b
        for b in doc.blocks
        if (b.kind == BODY or (b.kind == REFERENCES and b.reason.endswith("heading"))) and _heading_like(b, body)
    ]
    sizes = sorted({round(b.size * 2) / 2 for b in heads if b.size >= 1.15 * body}, reverse=True)
    for b in heads:
        m = NUMBERED_RE.match(b.text.strip())
        if m and b.size < 1.15 * body:
            level = min(4, m.group(1).count(".") + 1 + (1 if sizes else 0))
        elif b.size >= 1.15 * body:
            level = min(4, sizes.index(round(b.size * 2) / 2) + 1)
        else:
            level = min(4, len(sizes) + 1)
        b.level = level
        if b.kind == BODY:
            b.kind = HEADING
            b.reason = "Heading (larger or bold text)"
    return heads


# --------------------------------------------------------------------------- sections


def outline_sections(data: bytes, doc: Document) -> list[Section]:
    out: list[Section] = []
    with PDFIUM_LOCK:
        try:
            pdf = pdfium.PdfDocument(data)
        except Exception:
            return []
        try:
            for bm in pdf.get_toc(max_depth=6):
                title = (bm.get_title() or "").strip()
                dest = bm.get_dest()
                if not title or dest is None:
                    continue
                index = dest.get_index()
                if index is None or not (0 <= index < len(doc.pages)):
                    continue
                y = None
                try:
                    mode, pos = dest.get_view()
                    if mode == pdfium_c.PDFDEST_VIEW_XYZ and len(pos) >= 2:
                        y = pos[1]
                    elif mode in (pdfium_c.PDFDEST_VIEW_FITH, pdfium_c.PDFDEST_VIEW_FITBH) and pos:
                        y = pos[0]
                except Exception:
                    pass
                page = doc.pages[index]
                top = page.height - y if y is not None else None
                block = _block_at(page.blocks, top)
                if block is None:
                    continue
                out.append(Section(title, bm.level + 1, index, block.id, "outline"))
        finally:
            pdf.close()
    return out


def _block_at(blocks: list[Block], top: float | None) -> Block | None:
    if not blocks:
        return None
    if top is None:
        readable = [b for b in blocks if b.kind not in ("header", "footer", "page_number")]
        return (readable or blocks)[0]
    below = [b for b in blocks if b.bottom >= top - 4]
    if not below:
        return blocks[-1]
    return min(below, key=lambda b: (max(0.0, b.top - top), b.top))


def heading_sections(heads: list[Block]) -> list[Section]:
    return [Section(" ".join(b.text.split()), b.level, b.page, b.id, "headings") for b in heads]


# --------------------------------------------------------------------------- pipeline


def analyze(data: bytes, name: str, progress: Callable[[int, int], None] | None = None) -> Document:
    pages = []
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        n = len(pdf.pages)
        for i, p in enumerate(pdf.pages):
            pages.append(extract_page(p, i))
            try:
                p.close()
            except Exception:
                pass
            if progress:
                progress(i + 1, n)
    doc = Document(name=name, pages=pages)
    for i, b in enumerate(doc.blocks):
        b.id = i
    doc.body_size = body_size(doc)
    run_all(doc)
    heads = detect_headings(doc)
    for b in doc.blocks:
        b.sentences = split_sentences(b.text) if b.text else []
    doc.sections = outline_sections(data, doc) or heading_sections(heads)
    return doc


# --------------------------------------------------------------------------- JSON


def _r(v: float) -> float:
    return round(float(v), 1)


def to_json(doc: Document) -> dict:
    blocks = []
    for b in doc.blocks:
        d = {
            "id": b.id,
            "p": b.page,
            "box": [_r(b.x0), _r(b.top), _r(b.x1), _r(b.bottom)],
            "kind": b.kind,
            "group": b.group,
            "why": b.reason,
            "size": _r(b.size),
            "text": b.text,
            "w": [[_r(w.x0), _r(w.top), _r(w.x1), _r(w.bottom), w.start, w.end, w.line] for w in b.words],
            "s": [list(s) for s in b.sentences],
            "sp": [[s.start, s.end, s.kind, s.group, s.replacement] for s in b.spans],
        }
        if b.kind == HEADING or b.level:
            d["lvl"] = b.level
        if b.table:
            d["rows"] = [{"box": [_r(v) for v in r.bbox], "cells": r.cells} for r in b.table]
        blocks.append(d)
    return {
        "name": doc.name,
        "body_size": doc.body_size,
        "pages": [
            {"w": _r(p.width), "h": _r(p.height), "regions": [[_r(r.x0), _r(r.top), _r(r.x1), _r(r.bottom)] for r in p.regions]}
            for p in doc.pages
        ],
        "blocks": blocks,
        "sections": [
            {"title": s.title, "level": s.level, "page": s.page, "block": s.block, "source": s.source} for s in doc.sections
        ],
        "groups": GROUPS,
    }


def summary(doc: Document) -> dict:
    """Counts of block and span kinds, for logs and quick checks."""
    kinds: dict[str, int] = {}
    spans: dict[str, int] = {}
    for b in doc.blocks:
        kinds[b.kind] = kinds.get(b.kind, 0) + 1
        for s in b.spans:
            spans[s.kind] = spans.get(s.kind, 0) + 1
    return {"pages": len(doc.pages), "blocks": kinds, "spans": spans, "sections": len(doc.sections)}
