# Massive test drawings for the take-off (v0.12.5 big-file engine):
#   python3 tests/gen/make-huge.py <samples folder> <out folder>
#  - "Set - heavy sheets.pdf": real TOWER sheets bound into one ~350 MB set (qpdf)
#  - "Scan book.pdf": 300 scanned-looking pages (~1 MB JPEG each)
#  - "Monster strokes.pdf": one A1 sheet of 12 million separate little strokes (a traced scan /
#    some CAD exports) - ~90 MB compressed: the kind that ran PDFium out of memory in the PDF Editor
import io, os, random, subprocess, sys, zlib
import pikepdf
from PIL import Image, ImageDraw, ImageFilter

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)

def heavy_set(rounds=2):
    f = os.path.join(out, 'Set - heavy sheets.pdf')
    if os.path.exists(f): return
    # every sample sheet, twice - each opened again so its objects are copied, not shared (qpdf
    # shares a file's objects when it is bound in twice: the set came out a third of the size)
    dst = pikepdf.new()
    for _ in range(rounds):
        for n in sorted(os.listdir(src)):
            if not n.lower().endswith('.pdf'): continue
            with pikepdf.open(os.path.join(src, n)) as s:
                for pg in s.pages: dst.pages.append(pg)
    dst.save(f)

def scan_book(n=300):
    f = os.path.join(out, 'Scan book.pdf')
    if os.path.exists(f): return
    pdf = pikepdf.new()
    rnd = random.Random(7)
    for i in range(n):
        im = Image.new('L', (2480, 3508), 235)
        d = ImageDraw.Draw(im)
        for _ in range(140):
            y = rnd.randint(100, 3400); x = rnd.randint(100, 600)
            d.line([(x, y), (x + rnd.randint(300, 1800), y)], fill=rnd.randint(20, 90), width=rnd.randint(2, 5))
        d.text((200, 120), f'Page {i + 1}', fill=0)
        noise = Image.effect_noise((2480, 3508), 40)
        im = Image.blend(im, noise, 0.25).filter(ImageFilter.GaussianBlur(0.6))
        b = io.BytesIO(); im.save(b, 'JPEG', quality=72)
        img = pikepdf.Stream(pdf, b.getvalue(), Type=pikepdf.Name.XObject, Subtype=pikepdf.Name.Image, Width=2480, Height=3508,
                             ColorSpace=pikepdf.Name.DeviceGray, BitsPerComponent=8, Filter=pikepdf.Name.DCTDecode)
        page = pdf.add_blank_page(page_size=(595.28, 841.89))
        page.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=img))
        page.Contents = pdf.make_stream(b'q 595.28 0 0 841.89 0 0 cm /Im0 Do Q')
    pdf.save(f)

def monster(strokes=12_000_000):
    f = os.path.join(out, 'Monster strokes.pdf')
    if os.path.exists(f): return
    W, H = 2384.0, 1684.0  # A1 landscape
    rnd = random.Random(3)
    comp = zlib.compressobj(6)
    parts = [comp.compress(b'0 G 0.24 w 1 J\n')]
    chunk = []
    x, y = 100.0, 100.0
    for i in range(strokes):
        # a "traced" plan: short segments wandering along walls
        if i % 400 == 0:
            x, y = rnd.uniform(50, W - 50), rnd.uniform(50, H - 50)
        nx = min(W - 10, max(10, x + rnd.uniform(-1.6, 1.6)))
        ny = min(H - 10, max(10, y + rnd.uniform(-1.6, 1.6)))
        chunk.append(f'{x:.2f} {y:.2f} m {nx:.2f} {ny:.2f} l S\n')
        x, y = nx, ny
        if len(chunk) >= 200_000:
            parts.append(comp.compress(''.join(chunk).encode())); chunk = []
    parts.append(comp.compress(''.join(chunk).encode()))
    parts.append(comp.flush())
    data = b''.join(parts)
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(W, H))
    st = pikepdf.Stream(pdf, data)
    st.Filter = pikepdf.Name.FlateDecode
    # (the bytes are already compressed: written as they are)
    page.Contents = st
    pdf.save(f, compress_streams=False, stream_decode_level=pikepdf.StreamDecodeLevel.none)

heavy_set(); scan_book(); monster()
for n in sorted(os.listdir(out)): print(n, os.path.getsize(os.path.join(out, n)) // 1_000_000, 'MB')
