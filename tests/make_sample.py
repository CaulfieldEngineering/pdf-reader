"""Generate the sample PDF used by the tests and for trying the app.

    python tests/make_sample.py [out.pdf] [--no-outline]

The document is made up for testing. It has a running header, a running
footer with "Page N of M", headings, citations in several styles, a long URL,
a footnote, a vector block diagram with labels and a caption, a ruled table
with a caption, a short bullet list, a References section and an appendix.
"""

from __future__ import annotations

import sys
from pathlib import Path

from reportlab.graphics.shapes import Circle, Drawing, Line, Rect, String
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Flowable, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

HEADER_TEXT = "Sample Technical Report · Revision B"
FOOTER_TEXT = "ACME-TR-001 · Internal Draft · Do Not Distribute"
FOOTNOTE_TEXT = "1 Measured at 25 °C ambient with the probe grounded at the test point."
LONG_URL = "https://example.com/research/papers/2021/sample-report-final-version.pdf"

TABLE_ROWS = [
    ["Stage", "Role", "Gain"],
    ["TX Stage 1", "Impedance step-up", "12 dB"],
    ["TX Stage 2", "Power amplifier", "20 dB"],
    ["RX Stage", "Rectifier", "-3 dB"],
]
FIGURE_LABELS = ["VIN", "R1", "10k", "C1", "GND", "U1", "VOUT", "L1", "D1"]
LIST_ITEMS = ["Low noise", "Small size", "High efficiency", "Simple layout", "Low cost"]


def _decorate(canv, doc, total: int) -> None:
    """Running header, footer with "Page N of M", and a footnote on page 1."""
    w, h = letter
    n = canv.getPageNumber()
    canv.saveState()
    canv.setFont("Helvetica", 8.5)
    canv.setFillColor(colors.grey)
    canv.drawString(inch, h - 0.55 * inch, HEADER_TEXT)
    canv.drawString(inch, 0.5 * inch, FOOTER_TEXT)
    canv.drawRightString(w - inch, 0.5 * inch, f"Page {n} of {total}")
    if n == 1:
        # Footnote with a short separator rule, above the footer
        canv.setStrokeColor(colors.black)
        canv.setLineWidth(0.5)
        canv.line(inch, 1.05 * inch, inch + 1.5 * inch, 1.05 * inch)
        canv.setFillColor(colors.black)
        canv.setFont("Helvetica", 7.5)
        canv.drawString(inch, 0.9 * inch, FOOTNOTE_TEXT)
    canv.restoreState()


class Bookmark(Flowable):
    """Zero-size flowable that adds an outline entry where it lands."""

    def __init__(self, title: str, level: int):
        super().__init__()
        self.title, self.level = title, level
        self.width = self.height = 0

    def draw(self):
        key = f"bm{id(self)}"
        self.canv.bookmarkHorizontal(key, 0, 2)
        self.canv.addOutlineEntry(self.title, key, level=self.level)


def block_diagram() -> Drawing:
    d = Drawing(420, 190)
    d.add(Rect(0, 0, 420, 190, strokeColor=colors.black, fillColor=None, strokeWidth=0.8))
    d.add(Rect(30, 80, 60, 40, strokeColor=colors.black, fillColor=None))
    d.add(Rect(180, 70, 70, 60, strokeColor=colors.black, fillColor=None))
    d.add(Rect(330, 80, 60, 40, strokeColor=colors.black, fillColor=None))
    d.add(Line(90, 100, 180, 100))
    d.add(Line(250, 100, 330, 100))
    d.add(Line(215, 70, 215, 30))
    d.add(Line(195, 30, 235, 30))
    d.add(Line(200, 25, 230, 25))
    d.add(Line(205, 20, 225, 20))
    d.add(Circle(135, 100, 12, strokeColor=colors.black, fillColor=None))
    d.add(Circle(290, 100, 12, strokeColor=colors.black, fillColor=None))
    d.add(Line(120, 150, 150, 150))
    d.add(Line(270, 150, 310, 150))
    placements = [(40, 125), (125, 120), (125, 72), (280, 120), (200, 8), (205, 135), (340, 125), (130, 155), (280, 155)]
    for text, (x, y) in zip(FIGURE_LABELS, placements):
        d.add(String(x, y, text, fontName="Helvetica", fontSize=7))
    return d


def build(path: str | Path, outline: bool = True) -> Path:
    path = Path(path)
    ss = getSampleStyleSheet()
    body = ParagraphStyle("Body", parent=ss["Normal"], fontName="Times-Roman", fontSize=10.5, leading=13.5, spaceAfter=8)
    h1 = ParagraphStyle("H1", parent=ss["Heading1"], fontName="Helvetica-Bold", fontSize=15, spaceBefore=10, spaceAfter=8)
    title = ParagraphStyle("Title", parent=ss["Title"], fontName="Helvetica-Bold", fontSize=22, spaceAfter=14)
    caption = ParagraphStyle("Caption", parent=body, fontName="Times-Italic", fontSize=9, leading=11, spaceBefore=4)
    bullet = ParagraphStyle("Bullet", parent=body, leftIndent=18, bulletIndent=6, spaceAfter=2)
    ref = ParagraphStyle("Ref", parent=body, fontSize=9.5, leading=12, leftIndent=18, firstLineIndent=-18, spaceAfter=4)

    def heading(text, level=0, style=h1):
        out = [Bookmark(text, level)] if outline else []
        return out + [Paragraph(text, style)]

    story = []
    story += heading("Sample Technical Report", 0, title)
    story += heading("1. Introduction")
    story.append(Paragraph(
        "Wireless power links have been studied for decades [1]. Recent designs reach high efficiency at "
        "moderate distances [2–4], and resonant coupling is now the usual approach (Smith et al., 2020). "
        "Jones and Lee (2019) compared several coil geometries and found that spacing dominates the result.", body))
    story.append(Paragraph(
        "All measurements in this report use the same bench setup<super>1</super> and the same load. "
        f"The raw data is available at {LONG_URL} for anyone who wants to check the numbers.", body))
    story.append(Paragraph(
        "The rest of this report describes the system, presents the results and draws some conclusions. "
        "Each section is short, so the whole report can be read in a few minutes.", body))
    story.append(PageBreak())

    story += heading("2. System Overview")
    story.append(Paragraph(
        "The power stage converts the input voltage to a regulated output. The main parts are shown in the "
        "block diagram below, with the input on the left and the load on the right.", body))
    story.append(block_diagram())
    story.append(Paragraph("Figure 1. Block diagram of the sample power stage.", caption))
    story.append(Spacer(1, 6))
    story.append(Paragraph("The design goals were simple and are listed here.", body))
    for item in LIST_ITEMS:
        story.append(Paragraph(item, bullet, bulletText="•"))
    story.append(PageBreak())

    story += heading("3. Results")
    story.append(Paragraph("Table 1 summarises the gain of each stage measured on the bench.", body))
    story.append(Paragraph("Table 1: Stage parameters", caption))
    t = Table(TABLE_ROWS, colWidths=[1.4 * inch, 2.0 * inch, 1.0 * inch])
    t.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.6, colors.black),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
    ]))
    story.append(t)
    story.append(Spacer(1, 10))
    story.append(Paragraph(
        "Figure 1 shows that the output stage carries most of the current. The second transmit stage provides "
        "most of the gain, as expected from the simulations.", body))
    story += heading("4. Conclusion")
    story.append(Paragraph(
        "The prototype met every goal. Further work will look at thermal limits and at a smaller coil.", body))
    story.append(PageBreak())

    story += heading("References")
    refs = [
        "[1] A. Smith, B. Jones, and C. Lee, “A survey of wireless power,” Journal of Power, vol. 3, pp. 1–10, 2020.",
        "[2] D. Brown, “Resonant coupling in practice,” in Proc. Power Conf., 2018, pp. 44–50.",
        "[3] E. Green and F. White, Coil Design, 2nd ed. New York: Example Press, 2017.",
        "[4] G. Black, “Efficiency at distance,” IEEE Trans. Power, vol. 12, no. 4, 2021.",
    ]
    for r in refs:
        story.append(Paragraph(r, ref))
    story += heading("Appendix A. Extra Data")
    story.append(Paragraph("This appendix lists the raw readings. It should still be read aloud.", body))

    # Two passes: the first counts the pages for the "Page N of M" footer
    import copy

    total = 0
    for _ in range(2):
        doc = SimpleDocTemplate(str(path), pagesize=letter, topMargin=1.0 * inch, bottomMargin=1.2 * inch,
                                leftMargin=inch, rightMargin=inch, title="Sample Technical Report")
        on_page = lambda c, d, t=total: _decorate(c, d, t)  # noqa: E731
        doc.build(copy.deepcopy(story), onFirstPage=on_page, onLaterPages=on_page)
        total = doc.page
    return path


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    out = build(args[0] if args else "sample.pdf", outline="--no-outline" not in sys.argv)
    print(out)
