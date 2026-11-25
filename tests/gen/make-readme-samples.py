# The sample files for the README pictures - all made up, no real project, client, company or person.
#   python3 tests/gen/make-readme-samples.py [out folder = /tmp/goldline-readme-samples]    (needs reportlab, openpyxl)
# Writes  <out>/drawings/A-101 Typical Floor Plan.pdf   an A1 plan at 1:100: 8 flats round a corridor, a core, grid,
#                                                        dimensions, a door schedule and a title block
#         <out>/drawings/A-102 Unit Type A Enlarged Plan.pdf   one flat at 1:50
#         <out>/BOQ Finishes Doors Walls.xlsx           a small consultant-style BOQ (four bills) whose items are what
#                                                        the pictures measure
#         <out>/layout.json                             where everything is on A-101 (page units, y down) and the
#                                                        quantities worked out from the same geometry - tests/shots-readme.mjs
#                                                        reads it to measure the same things on the screen
# Then: xvfb-run -a node tests/shots-readme.mjs <out>
import json, math, os, sys
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm

OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else '/tmp/goldline-readme-samples')
os.makedirs(os.path.join(OUT, 'drawings'), exist_ok=True)
W, H = 841 * mm, 594 * mm
PT = 72 / 25.4  # points per mm

# ---------------------------------------------------------------- the building (metres, origin = grid 1/A)
GX = [0, 6, 12, 18, 24, 30]
GY = [0, 7.2, 9.6, 16.8]
BW, BH = GX[-1], GY[-1]
CORE = 2  # the bay with the stair and the lifts
T_EXT, T_PARTY, T_IN = 0.30, 0.20, 0.12
WALL_H = 3.0  # clear wall height used for the blockwork figures
DOORS = {'D1': ('ENTRANCE DOOR', 1000, 2100), 'D2': ('INTERNAL DOOR', 900, 2100), 'D3': ('BATHROOM DOOR', 800, 2100), 'D4': ('FIRE DOOR TO STAIR', 1100, 2100)}


def flats():
    """every flat as (x0, south?)"""
    return [(GX[i], s) for i in range(len(GX) - 1) if i != CORE for s in (True, False)]


def net_rooms(x0, south):
    """the flat's rooms as {name: (xa, ya, xb, yb)} in metres: net inside the wall faces. North flats are the
    south ones turned over the corridor (y -> 16.8 - y)."""
    L = x0 + (T_EXT / 2 if x0 == 0 else T_PARTY / 2)
    R = x0 + 6 - (T_EXT / 2 if x0 + 6 == BW else T_PARTY / 2)
    h = T_IN / 2
    r = {
        'LIVING / DINING': (L, T_EXT / 2, x0 + 3.6 - h, 4.8 - h),
        'BEDROOM': (x0 + 3.6 + h, T_EXT / 2, R, 4.8 - h),
        'BATH': (L, 4.8 + h, x0 + 2.0 - h, 7.2 - T_PARTY / 2),
        'HALL': (x0 + 2.0 + h, 4.8 + h, x0 + 3.4 - h, 7.2 - T_PARTY / 2),
        'KITCHEN': (x0 + 3.4 + h, 4.8 + h, R, 7.2 - T_PARTY / 2),
    }
    if not south:
        r = {k: (a, BH - d, c, BH - b) for k, (a, b, c, d) in r.items()}
    return r


def area(rc):
    return (rc[2] - rc[0]) * (rc[3] - rc[1])


def door_list(x0, south):
    """(mark, x, y, width m, orientation, hinge side) - the opening's centre on the wall line; for a north flat the same turned over"""
    d = [('D1', x0 + 2.7, 7.2, 1.0, 'h', 1), ('D2', x0 + 2.75, 4.8, 0.9, 'h', -1), ('D2', x0 + 3.6, 1.7, 0.9, 'v', 1), ('D3', x0 + 2.0, 6.0, 0.8, 'v', -1)]
    if south:
        return d
    return [(m, x, BH - y, w, o, s) for m, x, y, w, o, s in d]


# ---------------------------------------------------------------- drawing helpers
class Sheet:
    def __init__(self, path, title, ox, oy, per_m):
        self.c = canvas.Canvas(path, pagesize=(W, H))
        self.c.setTitle(title)
        self.c.setAuthor('Goldline sample drawing')
        self.OX, self.OY, self.M, self.FS = ox * mm, oy * mm, per_m * mm, per_m / 10 if per_m > 10 else 1.0

    def P(self, x, y):
        return self.OX + x * self.M, self.OY + y * self.M

    def line(self, x1, y1, x2, y2, w=0.25, col=(0, 0, 0), dash=None):
        c = self.c
        c.setLineWidth(w); c.setStrokeColorRGB(*col)
        c.setDash(list(dash)) if dash else c.setDash()
        a, b = self.P(x1, y1); d, e = self.P(x2, y2)
        c.line(a, b, d, e)

    def rect(self, x, y, w, h, lw=0.25, fill=None, col=(0, 0, 0)):
        c = self.c
        c.setLineWidth(lw); c.setStrokeColorRGB(*col); c.setDash()
        if fill is not None: c.setFillColorRGB(*fill)
        a, b = self.P(x, y)
        c.rect(a, b, w * self.M, h * self.M, stroke=1, fill=1 if fill is not None else 0)

    def text(self, x, y, s, size=7, font='Helvetica', anchor='middle', col=(0, 0, 0)):
        c = self.c
        c.setFillColorRGB(*col); c.setFont(font, size * self.FS)
        a, b = self.P(x, y)
        {'middle': c.drawCentredString, 'left': c.drawString, 'right': c.drawRightString}[anchor](a, b, s)

    def sqm(self, x, y, v, size=6, col=(0.25, 0.25, 0.25)):
        """'15.6 m2' with a raised 2 (drawn: the standard fonts have no reliable superscript)"""
        c = self.c
        from reportlab.pdfbase.pdfmetrics import stringWidth
        sz = size * self.FS
        t = f'{v:.1f} m'
        w = stringWidth(t, 'Helvetica', sz) + stringWidth('2', 'Helvetica', sz * 0.65)
        a, b = self.P(x, y)
        c.setFillColorRGB(*col); c.setFont('Helvetica', sz); c.drawString(a - w / 2, b, t)
        c.setFont('Helvetica', sz * 0.65); c.drawString(a - w / 2 + stringWidth(t, 'Helvetica', sz), b + sz * 0.4, '2')

    def wall(self, x1, y1, x2, y2, t, gaps=(), fill=(0.72, 0.72, 0.72)):
        """a wall as a filled strip centred on its line; gaps = [(from, to)] along it left open (doors, windows)"""
        horiz = y1 == y2
        a, b = (min(x1, x2), max(x1, x2)) if horiz else (min(y1, y2), max(y1, y2))
        cuts = sorted(gaps)
        pos = a
        for g0, g1 in cuts + [(b, b)]:
            if g0 > pos + 1e-9:
                if horiz: self.rect(pos, y1 - t / 2, g0 - pos, t, 0.5, fill)
                else: self.rect(x1 - t / 2, pos, t, g0 - pos, 0.5, fill)
            pos = max(pos, g1)

    def door(self, x, y, w, o, side):
        """leaf and swing; (x, y) = centre of the opening, o = h: in a horizontal wall, v: in a vertical one"""
        c = self.c
        r = w * self.M
        if o == 'h':
            hx, hy = x - w / 2, y  # hinge at the left end
            a, b = self.P(hx, hy)
            c.setLineWidth(0.35); c.setStrokeColorRGB(0, 0, 0); c.setDash()
            c.line(a, b, a, b + side * r)
            c.setLineWidth(0.2); c.setDash(2, 1.5)
            c.arc(a - r, b - r, a + r, b + r, 0 if side == 1 else -90, 90)
        else:
            hx, hy = x, y - w / 2
            a, b = self.P(hx, hy)
            c.setLineWidth(0.35); c.setStrokeColorRGB(0, 0, 0); c.setDash()
            c.line(a, b, a + side * r, b)
            c.setLineWidth(0.2); c.setDash(2, 1.5)
            c.arc(a - r, b - r, a + r, b + r, 0 if side == 1 else 90, 90)
        c.setDash()

    def dim_h(self, xs, y, fs=6.5):
        self.line(xs[0], y, xs[-1], y, 0.3)
        for x in xs:
            a, b = self.P(x, y); self.c.setLineWidth(0.5); self.c.setStrokeColorRGB(0, 0, 0); self.c.line(a - 1.5, b - 1.5, a + 1.5, b + 1.5)
            self.line(x, y - 0.4, x, y + 0.4, 0.2)
        for p, q in zip(xs, xs[1:]): self.text((p + q) / 2, y + 0.25, f'{(q - p) * 1000:.0f}', fs)

    def dim_v(self, ys, x, fs=6.5):
        self.line(x, ys[0], x, ys[-1], 0.3)
        for y in ys:
            a, b = self.P(x, y); self.c.setLineWidth(0.5); self.c.setStrokeColorRGB(0, 0, 0); self.c.line(a - 1.5, b - 1.5, a + 1.5, b + 1.5)
            self.line(x - 0.4, y, x + 0.4, y, 0.2)
        for p, q in zip(ys, ys[1:]):
            a, b = self.P(x - 0.3, (p + q) / 2)
            self.c.saveState(); self.c.translate(a, b); self.c.rotate(90); self.c.setFont('Helvetica', fs); self.c.setFillColorRGB(0, 0, 0)
            self.c.drawCentredString(0, 0, f'{(q - p) * 1000:.0f}'); self.c.restoreState()


def frame(s, title_lines, fields, revs, note_lines):
    c = s.c
    c.setLineWidth(1.4); c.rect(10 * mm, 10 * mm, W - 20 * mm, H - 20 * mm)
    c.setLineWidth(0.4); c.rect(15 * mm, 15 * mm, W - 30 * mm, H - 30 * mm)
    c.setFont('Helvetica', 7)
    for i in range(8):
        x = 15 * mm + (W - 30 * mm) * (i + 0.5) / 8
        c.drawCentredString(x, 11.5 * mm, str(i + 1)); c.drawCentredString(x, H - 14 * mm, str(i + 1))
    for i, L in enumerate('FEDCBA'):
        y = 15 * mm + (H - 30 * mm) * (i + 0.5) / 6
        c.drawCentredString(12.5 * mm, y, L); c.drawCentredString(W - 12.5 * mm, y, L)
    # title block
    tx, ty, tw, th = W - 215 * mm, 15 * mm, 200 * mm, 120 * mm
    c.setLineWidth(0.8); c.setStrokeColorRGB(0, 0, 0); c.rect(tx, ty, tw, th)
    c.setFillColorRGB(0, 0, 0); c.setFont('Helvetica-Bold', 13); c.drawString(tx + 5 * mm, ty + th - 12 * mm, 'GOLDLINE SAMPLE DRAWING')
    c.setFont('Helvetica-Oblique', 8); c.drawString(tx + 5 * mm, ty + th - 20 * mm, 'Not a real project - for demonstration only')
    c.setLineWidth(0.4); c.line(tx, ty + th - 26 * mm, tx + tw, ty + th - 26 * mm)
    for i, (k, v) in enumerate(fields):
        y = ty + th - 34 * mm - i * 12 * mm
        c.setFont('Helvetica', 6.5); c.setFillColorRGB(0.35, 0.35, 0.35); c.drawString(tx + 5 * mm, y + 3 * mm, k)
        c.setFont('Helvetica-Bold', 9); c.setFillColorRGB(0, 0, 0); c.drawString(tx + 5 * mm, y - 1.5 * mm, v)
        c.line(tx, y - 4.5 * mm, tx + tw, y - 4.5 * mm)
    rx, ry = tx, ty + th + 5 * mm
    c.rect(rx, ry, tw, 30 * mm)
    c.setFont('Helvetica-Bold', 7)
    for x, t in ((5, 'REV'), (20, 'DATE'), (50, 'DESCRIPTION'), (170, 'BY')): c.drawString(rx + x * mm, ry + 25 * mm, t)
    c.setFont('Helvetica', 7)
    for i, row in enumerate(revs):
        y = ry + 19 * mm - i * 6 * mm
        for x, t in zip((5, 20, 50, 170), row): c.drawString(rx + x * mm, y, t)
    nx0, ny0 = W - 215 * mm, H - 40 * mm
    c.setFont('Helvetica-Bold', 9); c.drawString(nx0, ny0, 'GENERAL NOTES')
    c.setFont('Helvetica', 7)
    for i, n in enumerate(note_lines): c.drawString(nx0, ny0 - 12 - i * 10, n)


def draw_flat(s, x0, south, label_scale=1.0, furniture=True):
    """one flat at (x0, south) - walls with their openings, fittings, door swings and room labels"""
    c = s.c
    rooms = net_rooms(x0, south)
    sgn = 1 if south else -1
    Y = (lambda y: y) if south else (lambda y: BH - y)
    # interior walls (south drawing; the north flat is mirrored by Y)
    s.wall(x0 + 3.6, Y(0), x0 + 3.6, Y(4.8), T_IN, gaps=[(0.85, 1.75)] if south else [(BH - 1.75, BH - 0.85)])
    ys = sorted([Y(0), Y(4.8)])
    s.wall(x0, Y(4.8), x0 + 6, Y(4.8), T_IN, gaps=[(x0 + 2.3, x0 + 3.2)])
    s.wall(x0 + 2.0, Y(4.8), x0 + 2.0, Y(7.2), T_IN, gaps=[(5.6, 6.4)] if south else [(BH - 6.4, BH - 5.6)])
    s.wall(x0 + 3.4, Y(4.8), x0 + 3.4, Y(7.2), T_IN, gaps=[(5.2, 6.4)] if south else [(BH - 6.4, BH - 5.2)])
    # doors
    for m, x, y, w, o, side in door_list(x0, south):
        s.door(x, y, w, o, side * (1 if south else -1) if o == 'h' else side)
    if not furniture: return
    # (the labels are drawn at the end, over the fittings)
    la, lb, lc, ld = rooms['LIVING / DINING']
    # bathroom: tiles grid, WC, basin, shower
    bx0, by0, bx1, by1 = rooms['BATH']
    t = 0.3
    xx = bx0
    while xx < bx1: s.line(xx, by0, xx, by1, 0.06, (0.6, 0.6, 0.6)); xx += t
    yy = by0
    while yy < by1: s.line(bx0, yy, bx1, yy, 0.06, (0.6, 0.6, 0.6)); yy += t
    a, b = s.P(bx0 + 0.4, by1 - 0.5 if south else by0 + 0.5)
    c.setLineWidth(0.3); c.setStrokeColorRGB(0, 0, 0); c.setFillColorRGB(1, 1, 1); c.ellipse(a - 0.2 * s.M, b - 0.28 * s.M, a + 0.2 * s.M, b + 0.28 * s.M, fill=1)
    sy = by0 + 0.1 if south else by1 - 0.9
    s.rect(bx0 + 0.1, sy, 0.8, 0.8, 0.3, (1, 1, 1)); s.line(bx0 + 0.1, sy, bx0 + 0.9, sy + 0.8, 0.15)
    # kitchen counter along the corridor-side wall + hob and sink
    kx0, ky0, kx1, ky1 = rooms['KITCHEN']
    cy0 = ky0 if south else ky1 - 0.6
    s.rect(kx0 + 0.05, cy0 + (0.05 if south else 0), kx1 - kx0 - 0.1, 0.6, 0.3, (0.95, 0.95, 0.95))
    for k in range(4):
        a, b = s.P(kx0 + 0.4 + (k % 2) * 0.35, cy0 + (0.2 if south else 0.12) + (k // 2) * 0.24); c.setFillColorRGB(1, 1, 1); c.circle(a, b, 0.1 * s.M, fill=0)
    s.rect(kx0 + 1.3, cy0 + (0.15 if south else 0.1), 0.8, 0.4, 0.3, (1, 1, 1))
    # bedroom: bed, side tables, wardrobe
    ba, bb, bc, bd = rooms['BEDROOM']
    fy = bb if south else bd
    d = 1 if south else -1
    s.rect(ba + 0.5, (fy + 0.3) if south else (fy - 2.3), 1.6, 2.0, 0.35, (1, 1, 1))
    s.rect(ba + 0.55, (fy + 0.4) if south else (fy - 0.75), 0.5, 0.35, 0.2); s.rect(ba + 1.55, (fy + 0.4) if south else (fy - 0.75), 0.5, 0.35, 0.2)
    s.rect(bc - 0.65, (bb + 1.8) if south else (bd - 4.2), 0.6, 2.4, 0.3)
    for k in range(5): s.line(bc - 0.65, ((bb + 1.8) if south else (bd - 4.2)) + 0.48 * k, bc - 0.05, ((bb + 1.8) if south else (bd - 4.2)) + 0.48 * k + 0.48, 0.1)
    # living: sofa and table
    la, lb, lc, ld = rooms['LIVING / DINING']
    s.rect(la + 0.3, (lb + 0.5) if south else (ld - 1.4), 2.4, 0.9, 0.35, (1, 1, 1))
    # room labels with their net areas, over the fittings, each where it is free
    for nm, rc in rooms.items():
        cx, cy = (rc[0] + rc[2]) / 2, (rc[1] + rc[3]) / 2
        if nm == 'BEDROOM': cy = (bb + 3.6) if south else (bd - 3.6)
        if nm == 'LIVING / DINING': cy = (lb + 3.0) if south else (ld - 3.0)
        if nm in ('BATH', 'HALL', 'KITCHEN'): cy = (rc[3] - 0.35) if south else (rc[1] + 0.35)  # at the corridor end: the app's own tag sits in the middle
        if nm == 'BATH': cx += 0.45
        if nm == 'BEDROOM': cx -= 0.35
        fs = 5.5 * label_scale
        s.text(cx, cy + 0.12, 'BATH' if nm == 'BATH' else nm, fs, 'Helvetica-Bold')
        s.sqm(cx, cy - 0.38, area(rc), 5 * label_scale)


def window(s, x1, x2, y):
    s.rect(x1, y - 0.15, x2 - x1, 0.3, 0.4, (1, 1, 1)); s.line(x1, y, x2, y, 0.25)


def plan_sheet(path, title, ox, oy, per_m, only_flat=None, sheetno='A-101', drawing='TYPICAL FLOOR PLAN - LEVELS 1 TO 12', scale='1:100 @ A1', unit_plan=False):
    s = Sheet(path, title, ox, oy, per_m)
    c = s.c
    notes = ['1. ALL DIMENSIONS ARE IN MILLIMETRES UNLESS NOTED OTHERWISE.', '2. DO NOT SCALE FROM THIS DRAWING; USE FIGURED DIMENSIONS ONLY.',
             '3. READ WITH THE STRUCTURAL AND MEP DRAWINGS.', '4. WALL TYPES: EXTERNAL 300 BLOCKWORK, PARTY WALLS 200, PARTITIONS 100.',
             '5. ROOM AREAS ARE NET INTERNAL AREAS.', '6. THIS IS A SAMPLE DRAWING FOR DEMONSTRATION ONLY.', '    IT DOES NOT REPRESENT ANY REAL PROJECT.']
    frame(s, [], [('PROJECT', 'SAMPLE RESIDENTIAL BUILDING'), ('DRAWING', drawing), ('DRAWING NO.', sheetno), ('SCALE', scale), ('REVISION', 'P1'), ('DATE', '09.11.2026')],
          [('P1', '09.11.2026', 'ISSUED FOR TENDER', 'GL'), ('P0', '02.11.2026', 'FIRST ISSUE FOR COMMENT', 'GL')], notes)
    if unit_plan:
        # one flat, enlarged, with its own walls
        x0 = 6.0
        for a in [(x0, 0, x0 + 6, 0, T_EXT, [(x0 + 0.9, x0 + 2.6), (x0 + 3.4 + 0.2, x0 + 5.1)]), (x0, 7.2, x0 + 6, 7.2, T_PARTY, [(x0 + 2.2, x0 + 3.2)])]:
            s.wall(*a[:5], gaps=a[5])
        s.wall(x0, 0, x0, 7.2, T_PARTY); s.wall(x0 + 6, 0, x0 + 6, 7.2, T_PARTY)
        for x in (x0, x0 + 6):
            for y in (0, 7.2): s.rect(x - 0.25, y - 0.25, 0.5, 0.5, 0.5, (0.15, 0.15, 0.15))
        window(s, x0 + 0.9, x0 + 2.6, 0); window(s, x0 + 3.6 + 0.2, x0 + 5.1, 0)
        draw_flat(s, x0, True, label_scale=1.5)
        s.dim_h([x0, x0 + 0.9, x0 + 2.6, x0 + 3.6, x0 + 5.1, x0 + 6], -1.0); s.dim_h([x0, x0 + 2.0, x0 + 3.4, x0 + 6], 8.2); s.dim_v([0, 4.8, 7.2], x0 - 1.0)
        c.setFillColorRGB(0, 0, 0); c.setFont('Helvetica-Bold', 12); c.drawString(s.OX + x0 * s.M, s.OY - 40 * mm, 'UNIT TYPE A - ENLARGED PLAN')
        c.setFont('Helvetica', 8); c.drawString(s.OX + x0 * s.M, s.OY - 45 * mm, 'SCALE 1:50')
        c.showPage(); c.save()
        return
    # grid
    for x, L in zip(GX, '123456'):
        s.line(x, -3.2, x, BH + 3.2, 0.3, (0.35, 0.35, 0.35), (6, 2, 1, 2))
        for yy in (-4.2, BH + 4.2):
            a, b = s.P(x, yy); c.setDash(); c.setLineWidth(0.4); c.setStrokeColorRGB(0, 0, 0); c.circle(a, b, 4.2 * mm)
            s.text(x, yy - 0.28, L, 9, 'Helvetica-Bold')
    for y, L in zip(GY, 'ABCD'):
        s.line(-3.2, y, BW + 3.2, y, 0.3, (0.35, 0.35, 0.35), (6, 2, 1, 2))
        for xx in (-4.2, BW + 4.2):
            a, b = s.P(xx, y); c.setDash(); c.setLineWidth(0.4); c.setStrokeColorRGB(0, 0, 0); c.circle(a, b, 4.2 * mm)
            s.text(xx, y - 0.28, L, 9, 'Helvetica-Bold')
    # external walls with windows (gaps), party walls, corridor walls (door gaps)
    win = lambda g0, g1: [(g0 + 0.9, g0 + 2.6), (g0 + 3.8, g1 - 0.9)]
    for y in (0, BH):
        s.wall(0, y, BW, y, T_EXT, gaps=[g for i in range(5) if i != CORE for g in win(GX[i], GX[i + 1])])
    s.wall(0, 0, 0, BH, T_EXT); s.wall(BW, 0, BW, BH, T_EXT)
    for x in GX[1:-1]:
        s.wall(x, 0, x, GY[1], T_PARTY); s.wall(x, GY[2], x, BH, T_PARTY)
    # corridor walls: gaps at the entrance doors (D1) and the stair door (D4)
    for y, sd in ((GY[1], True), (GY[2], False)):
        gaps = []
        for x0, so in flats():
            if so == sd: gaps.append((x0 + 2.2, x0 + 3.2))
        if sd: gaps.append((GX[CORE] + 2.45, GX[CORE] + 3.55))
        s.wall(0, y, BW, y, T_PARTY, gaps=gaps)
    for i in range(5):
        if i == CORE: continue
        for y in (0, BH):
            window(s, GX[i] + 0.9, GX[i] + 2.6, y); window(s, GX[i] + 3.8, GX[i + 1] - 0.9, y)
    for x in GX:
        for y in GY: s.rect(x - 0.25, y - 0.25, 0.5, 0.5, 0.5, (0.15, 0.15, 0.15))
    # the flats
    for x0, south in flats(): draw_flat(s, x0, south)
    # the core: stair (south), lifts and services (north)
    cx = GX[CORE]
    s.rect(cx + 0.3, 0.3, 5.4, GY[1] - 0.6, 0.35)
    for k in range(18): s.line(cx + 0.3, 0.6 + k * 0.36, cx + 2.9, 0.6 + k * 0.36, 0.2); s.line(cx + 3.1, 0.6 + k * 0.36, cx + 5.7, 0.6 + k * 0.36, 0.2)
    s.line(cx + 3.0, 0.3, cx + 3.0, GY[1] - 0.3, 0.35)
    s.text(cx + 1.6, 3.4, 'UP', 7, 'Helvetica-Bold'); s.text(cx + 4.4, 3.4, 'DOWN', 7, 'Helvetica-Bold')
    s.text(cx + 3.0, -1.0, 'STAIR 1', 7)
    for k in range(2):
        lx = cx + 0.6 + k * 1.9
        s.rect(lx, GY[2] + 0.3, 1.7, 1.9, 0.4); s.line(lx, GY[2] + 0.3, lx + 1.7, GY[2] + 2.2, 0.2); s.line(lx, GY[2] + 2.2, lx + 1.7, GY[2] + 0.3, 0.2)
    s.text(cx + 2.0, GY[2] + 2.7, 'LIFTS', 7)
    s.rect(cx + 4.4, GY[2] + 0.3, 1.3, 2.9, 0.3); s.text(cx + 5.05, GY[2] + 1.8, 'ELEC', 6)
    s.rect(cx + 0.6, GY[2] + 3.6, 5.1, 3.0, 0.3); s.text(cx + 3.15, GY[2] + 5.1, 'REFUSE + SERVICES', 6.5)
    s.door(cx + 3.0, GY[1], 1.1, 'h', 1)
    s.text(BW / 2, (GY[1] + GY[2]) / 2 - 0.2, 'CORRIDOR', 8, 'Helvetica-Bold')
    xx = 0.3
    while xx < BW - 0.3: s.line(xx, GY[1] + 0.12, xx, GY[2] - 0.12, 0.06, (0.65, 0.65, 0.65)); xx += 0.6
    # dimensions
    s.dim_h(GX, BH + 2.0); s.dim_h([0, BW], BH + 2.8); s.dim_v(GY, -2.0); s.dim_v([0, BH], -2.8)
    # north arrow, scale bar, title
    nx, ny = s.OX + BW * s.M + 28 * mm, s.OY + BH * s.M - 5 * mm
    c.setLineWidth(0.6); c.setStrokeColorRGB(0, 0, 0); c.circle(nx, ny, 9 * mm)
    p = c.beginPath(); p.moveTo(nx, ny + 8 * mm); p.lineTo(nx - 3 * mm, ny - 5 * mm); p.lineTo(nx, ny - 2 * mm); p.close(); c.setFillColorRGB(0, 0, 0); c.drawPath(p, fill=1)
    c.setFont('Helvetica-Bold', 10); c.drawCentredString(nx, ny + 11 * mm, 'N')
    sx, sy = s.OX, s.OY - 30 * mm
    for i in range(5):
        c.setFillColorRGB(*((0, 0, 0) if i % 2 == 0 else (1, 1, 1))); c.setStrokeColorRGB(0, 0, 0); c.rect(sx + i * s.M, sy, s.M, 2 * mm, fill=1)
    c.setFillColorRGB(0, 0, 0); c.setFont('Helvetica', 7)
    for i in range(6): c.drawCentredString(sx + i * s.M, sy - 4 * mm, str(i))
    c.drawString(sx + 5 * s.M + 4 * mm, sy - 4 * mm, 'm')
    c.setFont('Helvetica-Bold', 12); c.drawString(sx, sy + 12 * mm, 'TYPICAL FLOOR PLAN (LEVELS 1-12)')
    c.setFont('Helvetica', 8); c.drawString(sx, sy + 7.5 * mm, 'SCALE 1:100')
    # door schedule
    dx, dy = W - 215 * mm, 215 * mm
    c.setFont('Helvetica-Bold', 9); c.drawString(dx, dy + 8 * mm, 'DOOR SCHEDULE (PER FLOOR)')
    cols = [(0, 'MARK'), (16, 'DESCRIPTION'), (88, 'WIDTH'), (110, 'HEIGHT'), (135, 'NR')]
    c.setLineWidth(0.5); c.rect(dx, dy - 4 * 6 * mm - 2 * mm, 200 * mm, 4 * 6 * mm + 8 * mm)
    c.setFont('Helvetica-Bold', 7)
    for x, t in cols: c.drawString(dx + (x + 2) * mm, dy + 1.5 * mm, t)
    c.line(dx, dy - 1 * mm, dx + 200 * mm, dy - 1 * mm)
    c.setFont('Helvetica', 7)
    counts = door_counts()
    for i, (m, (nm, w, h)) in enumerate(DOORS.items()):
        y = dy - 6 * mm - i * 6 * mm
        for x, t in zip([c_[0] for c_ in cols], [m, nm, str(w), str(h), str(counts[m])]): c.drawString(dx + (x + 2) * mm, y, t)
    # key plan + legend
    kx, ky, k = W - 215 * mm, 300 * mm, 2.6 * mm
    c.setLineWidth(0.6); c.setFillColorRGB(0.85, 0.9, 0.95); c.rect(kx, ky, BW * k, BH * k, fill=1)
    c.setFillColorRGB(0.95, 0.8, 0.3); c.rect(kx, ky, 6 * k, GY[1] * k, fill=1)
    c.setFillColorRGB(0, 0, 0); c.setFont('Helvetica-Bold', 10); c.drawString(kx, ky + BH * k + 5 * mm, 'KEY PLAN'); c.setFont('Helvetica', 7); c.drawString(kx, ky - 5 * mm, 'UNIT TYPE A SHOWN SHADED')
    ly = 275 * mm
    c.setFont('Helvetica-Bold', 9); c.drawString(kx + 100 * mm, ky + 36 * mm, 'LEGEND')
    for i, (col, n) in enumerate([((0.72, 0.72, 0.72), 'BLOCKWORK WALL'), ((0.15, 0.15, 0.15), 'RC COLUMN'), ((1, 1, 1), 'WINDOW / GLAZING'), ((0.95, 0.95, 0.95), 'KITCHEN COUNTER')]):
        yy = ky + 28 * mm - i * 7 * mm
        c.setFillColorRGB(*col); c.setLineWidth(0.4); c.rect(kx + 100 * mm, yy, 14 * mm, 4 * mm, fill=1)
        c.setFillColorRGB(0, 0, 0); c.setFont('Helvetica', 7); c.drawString(kx + 118 * mm, yy + 1 * mm, n)
    c.showPage(); c.save()


def door_counts():
    n = {m: 0 for m in DOORS}
    for x0, south in flats():
        for m, *_ in door_list(x0, south): n[m] += 1
    n['D4'] += 1
    return n


# ---------------------------------------------------------------- what the plan holds, worked out from the same geometry
def quantities():
    fl = [net_rooms(x0, s) for x0, s in flats()]
    areas = lambda names: sum(area(r[n]) for r in fl for n in names)
    per = lambda r: 2 * ((r[2] - r[0]) + (r[3] - r[1]))
    dw = {'D1': 1.0, 'D2': 0.9, 'D3': 0.8}
    skirt = lambda names: sum(per(r[n]) for r in fl for n in names)
    corr = (BW - T_EXT) * (GY[2] - GY[1] - T_PARTY)
    return {
        'tiles_main': areas(['LIVING / DINING', 'HALL', 'KITCHEN']),
        'tiles_bath': areas(['BATH']),
        'laminate': areas(['BEDROOM']),
        'corridor': corr,
        'services': 5.1 * 3.0,
        'skirting_main': skirt(['LIVING / DINING', 'HALL', 'KITCHEN']),
        'skirting_bed': skirt(['BEDROOM']),
        'doors': door_counts(),
        'party_len': sum(GY[1] - 0 for x in GX[1:-1]) * 2,
        'partition_len': sum(4.8 + 2.4 + 2.4 + 6 for _ in flats()),
    }


def layout(sheet):
    """page units (points, y down) of everything the screen test measures"""
    to = lambda x, y: [round(sheet['OX'] + x * sheet['M'], 3), round(H - (sheet['OY'] + y * sheet['M']), 3)]
    h = T_IN / 2
    partitions, party = [], []
    for x0, south in flats():
        Y = (lambda y: y) if south else (lambda y: BH - y)
        e = T_EXT / 2
        partitions += [[to(x0 + 3.6, Y(e)), to(x0 + 3.6, Y(4.8))], [to(x0 + T_PARTY / 2, Y(4.8)), to(x0 + 6 - T_PARTY / 2, Y(4.8))],
                       [to(x0 + 2.0, Y(4.8)), to(x0 + 2.0, Y(7.1))], [to(x0 + 3.4, Y(4.8)), to(x0 + 3.4, Y(7.1))]]
    for x in GX[1:-1]:
        party += [[to(x, T_EXT / 2), to(x, GY[1] - T_PARTY / 2)], [to(x, GY[2] + T_PARTY / 2), to(x, BH - T_EXT / 2)]]
    cx = GX[CORE]
    doors = [{'mark': m, 'at': to(x, y)} for x0, south in flats() for m, x, y, *_ in door_list(x0, south)] + [{'mark': 'D4', 'at': to(cx + 3.0, GY[1])}]
    return {
        'page': [round(W, 3), round(H, 3)],
        'flats': [{'x0': x0, 'south': south, 'rooms': {nm: [to(rc[0], rc[1]), to(rc[2], rc[1]), to(rc[2], rc[3]), to(rc[0], rc[3])] for nm, rc in net_rooms(x0, south).items()}}
                  for x0, south in flats()],
        'doors': doors,
        'corridor': [to(0.15, GY[1] + 0.1), to(BW - 0.15, GY[2] - 0.1)],
        'services': [to(cx + 0.6, GY[2] + 3.6), to(cx + 5.7, GY[2] + 6.6)],
        'partitions': partitions,
        'party': party,
        'qty': quantities(),
        'm_pt': round(sheet['M'], 4),
        'origin': to(0, 0),
    }


# ---------------------------------------------------------------- the BOQ (Excel, consultant style)
def make_boq(path):
    from openpyxl import Workbook
    from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
    q = quantities()
    wb = Workbook()
    thin = Side(style='thin', color='999999')
    hdr_fill = PatternFill('solid', fgColor='DDDDDD')
    # (the quantities are the consultant's: round numbers a little off what the plan gives - the filled copy shows
    # the difference. Rooms are Unit Type A x 8 flats; doors, the corridor and the services room as drawn.)
    bills = [
        ('Bill 1 - Floor Finishes', 'BILL No. 1 - FLOOR FINISHES (PER TYPICAL FLOOR)', [
            ('1.1', 'Porcelain floor tiles 600 x 600 mm, laid on 40 mm screed, to living, hall and kitchen areas', 'm2', 208.0, 118),
            ('1.2', 'Ceramic floor tiles 300 x 300 mm to bathrooms, including waterproofing', 'm2', 36.8, 132),
            ('1.3', 'Laminate flooring 8 mm with underlay to bedrooms', 'm2', 82.0, 96),
            ('1.4', 'Porcelain floor tiles to common corridor', 'm2', round(q['corridor'], 1), 125),
            ('1.5', 'Anti-slip epoxy floor coating to refuse and services room', 'm2', round(q['services'], 1), 72),
        ]),
        ('Bill 2 - Skirting', 'BILL No. 2 - SKIRTING (PER TYPICAL FLOOR)', [
            ('2.1', 'Porcelain skirting 100 mm high to match floor tiles', 'm', 275, 34),
            ('2.2', 'Timber skirting 100 mm high, painted, to bedrooms', 'm', 108, 29),
        ]),
        ('Bill 3 - Doors', 'BILL No. 3 - DOORS (PER TYPICAL FLOOR)', [
            ('3.1', 'Door D1 - entrance door set, 1000 x 2100 mm, fire rated 30 minutes', 'nr', q['doors']['D1'], 2650),
            ('3.2', 'Door D2 - internal flush door set, 900 x 2100 mm', 'nr', q['doors']['D2'], 980),
            ('3.3', 'Door D3 - bathroom door set, 800 x 2100 mm', 'nr', q['doors']['D3'], 890),
            ('3.4', 'Door D4 - fire door to stair, 1100 x 2100 mm, 60 minutes', 'nr', q['doors']['D4'], 3400),
        ]),
        ('Bill 4 - Walls', 'BILL No. 4 - BLOCKWORK AND WALL FINISHES (PER TYPICAL FLOOR)', [
            ('4.1', 'Hollow concrete blockwork 200 mm thick, party walls between flats, 3.0 m high', 'm2', 172, 88),
            ('4.2', 'Hollow concrete blockwork 100 mm thick, partitions within flats, 3.0 m high', 'm2', 366, 64),
            ('4.3', 'Emulsion paint, 3 coats, to internal walls and partitions', 'm2', 1120, 16),
            ('4.4', 'Ceramic wall tiles 300 x 600 mm to bathrooms, 2.4 m high', 'm2', 160, 78),
            ('4.5', 'Emulsion paint, 2 coats, to soffits', 'm2', 335, 14),
        ]),
    ]
    first = True
    for name, title, rows in bills:
        ws = wb.active if first else wb.create_sheet()
        first = False
        ws.title = name
        ws['A1'] = title; ws['A1'].font = Font(bold=True, size=12)
        ws['A2'] = 'Sample Residential Building - Bill of Quantities (sample, not a real project)'; ws['A2'].font = Font(italic=True, color='555555')
        for j, h in enumerate(['Item', 'Description', 'Unit', 'Qty', 'Rate', 'Amount']):
            c = ws.cell(row=4, column=j + 1, value=h); c.font = Font(bold=True); c.fill = hdr_fill; c.border = Border(top=thin, bottom=thin)
            c.alignment = Alignment(horizontal='right' if j >= 3 else 'left')
        for i, (ref, desc, unit, qty, rate) in enumerate(rows):
            r = 5 + i
            ws.cell(row=r, column=1, value=ref); ws.cell(row=r, column=2, value=desc).alignment = Alignment(wrap_text=True, vertical='top')
            ws.cell(row=r, column=3, value=unit); ws.cell(row=r, column=4, value=qty).number_format = '#,##0.0' if unit == 'm2' else '#,##0'
            ws.cell(row=r, column=5, value=rate).number_format = '#,##0.00'
            ws.cell(row=r, column=6, value=f'=D{r}*E{r}').number_format = '#,##0.00'
        t = 5 + len(rows) + 1
        ws.cell(row=t, column=2, value='Carried to Collection').font = Font(bold=True)
        ws.cell(row=t, column=6, value=f'=SUM(F5:F{t - 2})').number_format = '#,##0.00'
        ws.cell(row=t, column=6).font = Font(bold=True)
        for col, w in zip('ABCDEF', (7, 70, 7, 11, 11, 14)): ws.column_dimensions[col].width = w
    wb.save(path)


if __name__ == '__main__':
    d = os.path.join(OUT, 'drawings')
    ox, oy = 90, 215
    plan_sheet(os.path.join(d, 'A-101 Typical Floor Plan.pdf'), 'Sample Residential Building - Typical Floor Plan', ox, oy, 10)
    plan_sheet(os.path.join(d, 'A-102 Unit Type A Enlarged Plan.pdf'), 'Sample Residential Building - Unit Type A Enlarged Plan', 60, 190, 20, sheetno='A-102', drawing='UNIT TYPE A - ENLARGED PLAN', scale='1:50 @ A1', unit_plan=True)
    make_boq(os.path.join(OUT, 'BOQ Finishes Doors Walls.xlsx'))
    lay = layout({'OX': ox * PT, 'OY': oy * PT, 'M': 10 * PT})
    json.dump(lay, open(os.path.join(OUT, 'layout.json'), 'w'), indent=1)
    print('written', OUT, json.dumps({k: (round(v, 1) if isinstance(v, float) else v) for k, v in lay['qty'].items()}))
