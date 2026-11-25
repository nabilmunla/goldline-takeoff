# v0.16.2 test sheet with door tags on it (from the 0.16.1 QA hunt's repro, plus a fixture tag F12 that is not a door)
import sys, os
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A1, landscape
out = sys.argv[1]
os.makedirs(out, exist_ok=True)
W, H = landscape(A1)
c = canvas.Canvas(os.path.join(out, 'B-201 Door tags.pdf'), pagesize=(W, H), pageCompression=1)
c.setFont('Helvetica', 16)
c.drawString(40, H - 50, 'B-201 - CORE PLAN')
c.drawString(40, H - 80, 'SCALE 1:100')
c.setLineWidth(2)
c.line(80, 120, 80, H - 140)
c.line(80, 120, W - 80, 120)
c.setFont('Helvetica', 12)
for x, y, t in [(300, 200, 'D01'), (700, 200, 'D01'), (1100, 200, 'D02'), (500, 400, 'D01'), (900, 600, 'F12'), (1300, 600, 'F12')]:
    c.drawString(x, y, t)
    c.setLineWidth(0.8)
    c.rect(x - 6, y - 6, 26, 18)
c.showPage()
c.save()
