"""Bound sets ("binder" PDFs) for the v0.16 tests: several sheets in one PDF, each with a title block that says its
drawing number and title (or none), and a different big mark in the middle so a test can tell the pages apart.
Usage: python3 tests/fixtures/make-binder.py <out.pdf> "<no>|<title>" "<no>|<title>" ...   (empty no = none)"""
import sys
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A3, landscape

out = sys.argv[1]
pages = [a.split('|', 1) for a in sys.argv[2:]] or [['A-101', 'Ground Floor Plan'], ['', 'Typical details'], ['A-103', 'Roof Plan']]
w, h = landscape(A3)
c = canvas.Canvas(out, pagesize=(w, h))
for i, (no, title) in enumerate(pages):
    c.setLineWidth(0.8)
    c.rect(20, 20, w - 40, h - 40)
    # title block, bottom right
    c.rect(w - 320, 20, 300, 110)
    c.setFont('Helvetica', 9)
    c.drawString(w - 310, 112, 'PROJECT: SAMPLE TOWER')
    c.drawString(w - 310, 92, 'DRAWING TITLE:')
    c.setFont('Helvetica-Bold', 11)
    c.drawString(w - 230, 92, title)
    c.setFont('Helvetica', 9)
    c.drawString(w - 310, 62, 'SCALE 1:100')
    if no:
        c.drawString(w - 310, 40, 'DRAWING NO.')
        c.setFont('Helvetica-Bold', 12)
        c.drawString(w - 240, 40, no)
    # rooms
    c.setLineWidth(1.5)
    c.rect(w * 0.2, h * 0.3, w * 0.25, h * 0.35)
    c.rect(w * 0.45, h * 0.3, w * 0.2, h * 0.35)
    # page mark: page 2 has a big filled block in the middle, the others a cross
    if i % 2 == 1:
        c.rect(w / 2 - 60, h / 2 - 60, 120, 120, fill=1)
    else:
        c.line(w / 2 - 60, h / 2, w / 2 + 60, h / 2)
        c.line(w / 2, h / 2 - 60, w / 2, h / 2 + 60)
    c.showPage()
c.save()
