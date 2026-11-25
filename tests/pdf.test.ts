// PDF engine on real drawings (skipped when the samples are not on this machine).
// Checks that what we snap to is really where the ink is: render the sheet, snap
// to line ends, and look at the pixels under them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { startEngine, openDoc, closeDoc, docs, renderRaw, pageText, buildSnap, snap } from '../src/ui/takeoff/pdfcore';
import { scalesInText } from '../src/engine/qto/geometry';

const require = createRequire(import.meta.url);
const SAMPLES = process.env.QTO_SAMPLES ?? '';
const have = existsSync(SAMPLES) && readdirSync(SAMPLES).some((f) => f.endsWith('.pdf'));
const file = (part: string) => join(SAMPLES, readdirSync(SAMPLES).find((f) => f.includes(part))!);

test('pdf engine: open, size with rotation, text, snapping lands on ink', { skip: !have && 'no sample drawings' }, async () => {
  const wasm = readFileSync(join(process.cwd(), 'node_modules/@embedpdf/pdfium/dist/pdfium.wasm'));
  await startEngine(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const bytes = readFileSync(file('11030'));
  let t = performance.now();
  const { pages } = openDoc('l01', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  console.log('  open', Math.round(performance.now() - t), 'ms');
  assert.equal(pages.length, 1);
  assert.equal(Math.round(pages[0].w), 3370, 'landscape A0 as shown (page is rotated 90°)');
  assert.equal(Math.round(pages[0].h), 2384);
  const d = docs.get('l01')!;
  assert.ok(pageText(d, 0).includes('SCALE'));
  t = performance.now();
  const ix = buildSnap(d, 0);
  console.log('  snap index', ix.n, 'segments in', Math.round(performance.now() - t), 'ms');
  assert.ok(ix.n > 100000);

  // render the middle of the sheet at 4 px/pt and check snapped ends sit on dark pixels
  const S = 4, X = 1500, Y = 1000, W = 400, H = 300;
  const px = renderRaw(d, 0, S, X * S, Y * S, W * S, H * S, 1);
  const dark = (x: number, y: number) => {
    let best = 255;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const ix2 = Math.round((x - X) * S) + dx, iy = Math.round((y - Y) * S) + dy;
      if (ix2 < 0 || iy < 0 || ix2 >= W * S || iy >= H * S) continue;
      const o = (iy * W * S + ix2) * 4;
      best = Math.min(best, (px[o] + px[o + 1] + px[o + 2]) / 3);
    }
    return best;
  };
  let hits = 0, onInk = 0;
  for (let i = 0; i < 60; i++) {
    const x = X + 20 + ((i * 37) % (W - 40)), y = Y + 20 + ((i * 53) % (H - 40));
    const h = snap(ix, x, y, 6);
    if (!h || h.k !== 'end') continue;
    hits++;
    if (dark(h.x, h.y) < 200) onInk++;
  }
  console.log('  snapped', hits, 'of 60 probes to line ends;', onInk, 'on ink');
  assert.ok(hits >= 20, 'expected plenty of line ends in the middle of a GA plan');
  assert.ok(onInk / hits > 0.9, 'snap points must sit on the drawn lines');
  closeDoc('l01');
});

test('pdf engine: scale marks read from the sheet text', { skip: (!have || !readdirSync(SAMPLES).some((f) => f.includes('01005'))) && 'no sample drawing 01005' }, async () => {
  const bytes = readFileSync(file('01005'));
  openDoc('gf', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const text = pageText(docs.get('gf')!, 0);
  assert.deepEqual(scalesInText(text).slice(0, 1), [600]);
  const t = performance.now();
  const ix = buildSnap(docs.get('gf')!, 0);
  console.log('  heaviest sheet: snap index', ix.n, 'segments in', Math.round(performance.now() - t), 'ms');
  closeDoc('gf');
});

test('pictures named .pdf: JPEG wrapped in a PDF at its own resolution; other files refused with the reason', async () => {
  const { asPdf, fileKind } = await import('../src/ui/takeoff/imagepdf');
  const wasm = readFileSync(join(process.cwd(), 'node_modules/@embedpdf/pdfium/dist/pdfium.wasm'));
  await startEngine(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const jpg = readFileSync(join(process.cwd(), 'tests/fixtures/plan-300dpi.jpg'));
  assert.equal(fileKind(new Uint8Array(jpg)), 'jpeg');
  assert.equal(fileKind(new Uint8Array(readFileSync(join(process.cwd(), 'tests/fixtures/plan-150dpi.png')))), 'png');
  const { pdf, converted } = await asPdf(new Uint8Array(jpg));
  assert.equal(converted, 'jpeg');
  const { pages } = openDoc('jpg', pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer);
  assert.equal(pages.length, 1);
  assert.equal(Math.round(pages[0].w), 360, '1500 px at 300 dpi = 5 in = 360 pt');
  assert.equal(Math.round(pages[0].h), 240);
  const px = renderRaw(docs.get('jpg')!, 0, 1, 0, 0, 360, 240, 1);
  // the frame line (150 px at 300 dpi = 36 pt from the edge) is dark
  const at = (x: number, y: number) => px[(y * 360 + x) * 4];
  assert.ok(at(36, 120) < 90 && at(10, 10) > 230, 'picture content rendered');
  closeDoc('jpg');
  await assert.rejects(asPdf(new Uint8Array(readFileSync(join(process.cwd(), 'tests/fixtures/fake.dwg')))), /AutoCAD drawing/);
});

test('snapping: curves are followed (never their control points), slanted lines indexed only where they run', async () => {
  const wasm = readFileSync(join(process.cwd(), 'node_modules/@embedpdf/pdfium/dist/pdfium.wasm'));
  await startEngine(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const bytes = readFileSync(join(process.cwd(), 'tests/fixtures/snap-shapes.pdf'));
  const { pages } = openDoc('shapes', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const H = pages[0].h;
  const ix = buildSnap(docs.get('shapes')!, 0);
  // circle of radius 80 at (900, 200) in PDF space = (900, H - 200) on the sheet
  const cx = 900, cy = H - 200;
  const onCircle = (h: { x: number; y: number }) => Math.abs(Math.hypot(h.x - cx, h.y - cy) - 80) < 0.6;
  // right on the curves' control points (80 × 0.5523 off each quarter point): nothing there to snap to
  const k = 80 * 0.5523;
  for (const [x, y] of [[cx + 80, cy - k], [cx + k, cy - 80], [cx - 80, cy + k], [cx - k, cy + 80]] as [number, number][]) {
    const h = snap(ix, x, y, 8);
    assert.ok(!h || onCircle(h), `nothing off the circle near the control point ${x.toFixed(0)},${y.toFixed(0)}: got ${h && h.k + ' ' + h.x.toFixed(1) + ',' + h.y.toFixed(1)}`);
  }
  // near the curve: snaps onto it
  for (const a of [0.4, 1.2, 2.5, 4]) {
    const h = snap(ix, cx + 82 * Math.cos(a), cy + 82 * Math.sin(a), 8);
    assert.ok(h && onCircle(h), `on the circle at angle ${a}`);
  }
  // the circle's own quarter points are still corners
  const top = snap(ix, cx + 1, cy - 79, 6)!;
  assert.equal(top.k, 'end');
  // the square's corner
  const c = snap(ix, 101, H - 101, 6)!;
  assert.deepEqual([Math.round(c.x), Math.round(c.y), c.k], [100, Math.round(H - 100), 'end']);
  // the long diagonal: on it in the middle of the sheet, and not stored in every cell of its box
  const mx = (20 + pages[0].w - 20) / 2, my = H / 2;
  const on = snap(ix, mx + 2, my + 1, 6)!;
  assert.ok(on && on.k !== 'end');
  assert.ok(ix.ids.length < 1500, `index entries ${ix.ids.length}`);
  closeDoc('shapes');
});

test('pages let go: only the last two pages stay loaded, so the engine\'s memory stays bounded sheet after sheet', async () => {
  const { startEngine: _s, mustP, heapMB, isFatal } = await import('../src/ui/takeoff/pdfcore');
  try { mustP(); } catch {
    const wasm = readFileSync(join(process.cwd(), 'node_modules/@embedpdf/pdfium/dist/pdfium.wasm'));
    await _s(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  }
  const bytes = readFileSync(join('tests', 'fixtures', 'snap-shapes.pdf'));
  const ab = () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  for (const k of ['p1', 'p2', 'p3', 'p4']) openDoc(k, ab());
  for (const k of ['p1', 'p2', 'p3', 'p4']) renderRaw(docs.get(k)!, 0, 0.5, 0, 0, 200, 150, 0);
  const loaded = ['p1', 'p2', 'p3', 'p4'].reduce((a, k) => a + docs.get(k)!.pages.size, 0);
  assert.equal(loaded, 2);
  assert.equal(docs.get('p4')!.pages.size, 1, 'the one just drawn is kept');
  // drawn again after being let go: loaded again, same picture
  const a = renderRaw(docs.get('p1')!, 0, 0.5, 0, 0, 200, 150, 0);
  const b = renderRaw(docs.get('p1')!, 0, 0.5, 0, 0, 200, 150, 0);
  assert.deepEqual(a, b);
  for (const k of ['p1', 'p2', 'p3', 'p4']) closeDoc(k);
  assert.ok(heapMB() > 0);
  assert.equal(isFatal(new Error('Aborted(native code called abort())')), true);
  assert.equal(isFatal(new Error('This PDF is password protected.')), false);
});
