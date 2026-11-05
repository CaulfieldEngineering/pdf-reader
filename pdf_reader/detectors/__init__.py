"""Skip detectors.

Each detector looks at the whole document and labels blocks (``Block.label``)
or adds inline spans (``Block.spans``). Detectors never delete anything: the
client decides what to read from the labels and the user's settings, so a
wrong guess costs a skipped sentence that is still visible (dimmed) on the
page, never lost text.

To add a detector (code blocks, maths, ...):

1. Write a class with ``name``, ``group`` and ``run(doc)`` in this package.
2. Add its block or span kinds to ``model.SKIP_GROUP``.
3. Add it to ``DETECTORS`` and, for a new toggle, to ``GROUPS``.

Order matters: a block that already has a non-body kind is left alone by
later detectors (except references, which claim everything after the
heading).
"""

from __future__ import annotations

from ..model import Document
from .citations import CitationDetector, FootnoteDetector, ReferencesDetector
from .figures import CaptionDetector, FigureTextDetector
from .headers import HeaderFooterDetector

DETECTORS = [
    HeaderFooterDetector(),
    CaptionDetector(),
    FigureTextDetector(),
    FootnoteDetector(),
    ReferencesDetector(),
    CitationDetector(),
]

# Skip groups shown as toggles in the settings panel. "choices" turns a toggle
# into a select; the first choice is the default.
GROUPS = [
    {
        "id": "headers",
        "label": "Running headers, footers and page numbers",
        "help": "Text that repeats in the top or bottom margin, and standalone page numbers.",
        "default": True,
    },
    {
        "id": "tables",
        "label": "Tables",
        "help": "Ruled tables. Skip them, or read them row by row with the column headings.",
        "choices": [
            {"id": "skip", "label": "Skip"},
            {"id": "rows", "label": "Read as rows"},
            {"id": "plain", "label": "Read cells in order"},
        ],
        "default": "skip",
    },
    {
        "id": "figures",
        "label": "Figures and captions",
        "help": "Figure and table captions, and labels inside diagrams, schematics and images.",
        "default": True,
    },
    {
        "id": "citations",
        "label": "Citations, URLs and footnotes",
        "help": "[12], (Smith et al., 2020), long URLs, footnote markers and text, and the References section.",
        "default": True,
    },
]


def run_all(doc: Document) -> None:
    for det in DETECTORS:
        det.run(doc)
