"""Synthetic stand-ins for the TOWER drawings the take-off tests use (when the real ones are
not on this machine): same file names, A0/A1 sheets, scale text, dense line work, a rotated
page. Usage: python3 tests/fixtures/make-samples.py <output-dir>"""
import sys, os, random
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A0, A1, landscape

out = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('QTO_SAMPLES', 'samples')
os.makedirs(out, exist_ok=True)
P = 'P101-ABC-DWG-AR-'

def plan(c, w, h, seed, rooms=6, scale='SCALE 1:100'):
    rnd = random.Random(seed)
    c.setLineWidth(0.6)
    # frame and title block
    c.rect(20, 20, w - 40, h - 40)
    c.rect(w - 420, 20, 400, 160)
    c.setFont('Helvetica', 14)
    c.drawString(w - 400, 140, 'SAMPLE TOWER')
    c.drawString(w - 400, 110, scale)
    # a tower outline with rooms
    x0, y0, x1, y1 = w * 0.3, h * 0.3, w * 0.7, h * 0.7
    c.setLineWidth(2)
    c.rect(x0, y0, x1 - x0, y1 - y0)
    c.setLineWidth(0.8)
    for i in range(1, rooms):
        x = x0 + (x1 - x0) * i / rooms + rnd.uniform(-10, 10)
        c.line(x, y0, x, y1)
    c.line(x0, (y0 + y1) / 2, x1, (y0 + y1) / 2)
    # doors (quarter circles = curves)
    for i in range(rooms):
        cx = x0 + (x1 - x0) * (i + 0.5) / rooms
        c.arc(cx - 20, (y0 + y1) / 2 - 20, cx + 20, (y0 + y1) / 2 + 20, 0, 90)

def dense(c, x0, y0, x1, y1, step=12):
    # tiles drawn as separate strokes: lots of line ends to snap to (and >100k segments on A0)
    c.setLineWidth(0.25)
    p = c.beginPath()
    y = y0
    while y < y1:
        x = x0
        while x < x1:
            p.moveTo(x, y); p.lineTo(x + step * 0.8, y)
            p.moveTo(x, y); p.lineTo(x, y + step * 0.8)
            x += step
        y += step
    c.drawPath(p, stroke=1, fill=0)

def sheet(name, size, seed, rotate=False, heavy=False, scale='SCALE 1:100'):
    c = canvas.Canvas(os.path.join(out, P + name + '.pdf'), pagesize=size, pageCompression=1)
    w, h = size
    if rotate: c.setPageRotation(90)
    if heavy: dense(c, 40, 200, w - 40, h - 200, 10)
    plan(c, w, h, seed, scale=scale)
    c.showPage(); c.save()

A0p = landscape(A0)          # reportlab swaps the box for a rotated page: portrait box + /Rotate 90 = landscape on screen
sheet('11030-GA L01 Tower A', A0p, 1, rotate=True, heavy=True)
sheet('11031-GA L02 Tower A', landscape(A1), 2)
sheet('11032-GA L03 Tower A', landscape(A1), 3)
sheet('12030-GA L01 Tower B', landscape(A1), 4)
sheet('12031-GA L02 Tower B', landscape(A1), 5)
sheet('01005-GA L00 Tower A', landscape(A0), 6, scale='SCALE 1 : 600   KEY PLAN 1:1000')
sheet('01006-Basement 01 Floor', landscape(A1), 7)
sheet('00001-Document Sheet', landscape(A1), 8)
sheet('00010-Area Calculations - GF', landscape(A1), 9)
sheet('14030-GA Roof', landscape(A1), 10)
sheet('30001-Sections', landscape(A1), 11, scale='SCALE 1:50')
print('written to', out)
