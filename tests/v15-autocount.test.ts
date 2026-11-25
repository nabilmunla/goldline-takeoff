// Auto-count by tag (v0.15): words of a real PDF page, tags found in them
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findTags, byTag, tagKey, type Word } from '../src/engine/qto/autocount';

const W = (t: string, x: number, y: number, w = 10, h = 4): Word => ({ t, x0: x, y0: y, x1: x + w, y1: y + h });

test('exact tags; pieces that touch are read together; bold (drawn twice) counted once', () => {
  const words = [
    W('D01', 10, 10), W('D01', 10.2, 10), // bold
    W('D', 50, 10, 3), W('01', 53.5, 10, 6), // two pieces
    W('D01A', 90, 10), W('D', 130, 10, 3), W('02', 160, 10, 6), // far apart: not one tag
    W('DOOR', 200, 10, 16), W('SCHEDULE', 220, 10, 30), W('d-01', 300, 50),
  ];
  const f = findTags(words, 'D01', 'exact');
  assert.deepEqual(f.map((x) => x.text), ['D01', 'D01', 'd-01']);
  assert.deepEqual(f[1].p, [(50 + 59.5) / 2, 12]);
  const s = findTags(words, 'D', 'starts');
  // by tag: D01 (written D01, D+01 and d-01: the same tag) ×3, D01A ×1; not DOOR, not the lone far "D"
  assert.deepEqual(byTag(s).map((g) => [g.key, g.n]), [['D01', 3], ['D01A', 1], ['D02', 0]].filter((x) => x[1]));
  assert.equal(findTags(words, 'D01', 'contains').length, 3); // D01 (once), D01A, d-01: pieces are not joined here
  assert.equal(tagKey(' sd-1 '), 'SD1');
});

test("the words of a real page (PDFium): the sheet's own text is found where it is drawn", async () => {
  const { startEngine, openDoc, docs, pageWords, closeDoc } = await import('../src/ui/takeoff/pdfcore');
  const wasm = readFileSync(join(process.cwd(), 'node_modules/@embedpdf/pdfium/dist/pdfium.wasm'));
  await startEngine(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const bytes = readFileSync(join(process.cwd(), 'tests/fixtures/snap-shapes.pdf'));
  openDoc('ac', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const words = pageWords(docs.get('ac')!, 0);
  closeDoc('ac');
  const sc = words.find((w) => w.t === 'SCALE');
  assert.ok(sc, 'SCALE found: ' + words.map((w) => w.t).join(' '));
  assert.ok(words.some((w) => w.t === '1:100'));
  // top-left origin, inside the A3 page
  assert.ok(sc!.x0 > 0 && sc!.x1 < 1191 && sc!.y0 > 0 && sc!.y1 < 842 && sc!.x1 > sc!.x0 && sc!.y1 > sc!.y0);
  const f = findTags(words, 'scale', 'exact');
  assert.equal(f.length, 1);
});
