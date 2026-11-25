// The drawing engine past 2 GB (ported from the PDF Editor 0.9.7 - 0.12: tests/engine-4gb.test.ts and
// the drawing-engine half of tests/engine4gb.test.ts). tools/patch-pdfium.mjs makes PDFium's JavaScript
// read addresses unsigned and grow to 4 GB; its .wasm's memory maximum is lifted when the engines are
// built and again when one starts. Everything the engine hands back is the same when its memory sits
// above 2 GB - pages drawn (from bytes and from a file read in blocks), text, words, snapping - a file
// past 2 GB opens, and a sheet that ran the 2 GB engine out of memory is drawn by the 4 GB one.
// Generated files and the repository's own fixtures only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, openSync, writeSync, closeSync, ftruncateSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as mupdf from 'mupdf';
import * as pf from '../src/ui/takeoff/pdfcore';
import { VFile } from '../src/engine/pdfhost/files';
import { PATCHED_FROM } from '../src/engine/pdfhost/vendor/pdfium-4gb.js';
// @ts-expect-error (a plain .mjs tool)
import { patchGlue, liftWasm, VENDOR } from '../tools/patch-pdfium.mjs';

const GB = 1024 ** 3;
const TMP = mkdtempSync(join(tmpdir(), 'gt4gb-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
const ab = () => wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer;
const hash = (b: ArrayLike<number> & { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }) =>
  createHash('sha1').update(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)).digest('hex');

test('the patched engine is of the installed @embedpdf/pdfium, and is what tools/patch-pdfium.mjs makes (else: node tools/patch-pdfium.mjs)', () => {
  const v = JSON.parse(readFileSync('node_modules/@embedpdf/pdfium/package.json', 'utf8')).version;
  assert.equal(PATCHED_FROM, v);
  const { text, shifts } = patchGlue();
  assert.ok(shifts >= 80, 'memory indexes made unsigned: ' + shifts);
  assert.equal(readFileSync(VENDOR, 'utf8'), text, 'the committed copy is up to date');
  assert.match(text, /4294901760; \/\/ \(patched: 4 GB build\)/, 'it may grow to 4 GB less a page');
  assert.doesNotMatch(text, /HEAP\w*\[[^\]]*[^>]>>[0-3][^\]]*\]/, 'no signed memory index left');
});

test('the .wasm memory limit is raised from 2 GB to 4 GB less a page (three bytes, nothing else); the build and the engine do the same', () => {
  const a = new Uint8Array(wasm), b = new Uint8Array(pf.liftMemoryMax(ab()));
  assert.equal(a.length, b.length);
  const diff = [...a.keys()].filter((i) => a[i] !== b[i]);
  assert.equal(diff.length, 3, 'three bytes: the limit');
  assert.deepEqual([...a.subarray(diff[0], diff[0] + 3)], [0x80, 0x80, 0x02], 'was 32768 pages');
  assert.deepEqual([...b.subarray(diff[0], diff[0] + 3)], [0xff, 0xff, 0x03], 'now 65535 pages');
  assert.ok(new WebAssembly.Module(b.slice().buffer), 'still a valid module');
  assert.equal(pf.memoryLimit(), pf.MEMORY_MAX);
  // the build's copy (tools/build-engines.mjs writes it into dist/engine) is byte for byte the same
  const built = liftWasm(wasm);
  assert.equal(built.lifted, true);
  assert.equal(hash(built.bytes), hash(b));
  // a lifted one is left as it is (the engine started from the built copy)
  const again = pf.liftMemoryMax(b.slice().buffer);
  assert.equal(hash(new Uint8Array(again)), hash(b));
  assert.equal(liftWasm(b).lifted, false);
  assert.equal(liftWasm(b).pages, 65535);
  // anything else is left alone - and the engine knows it stops sooner
  const other = new Uint8Array(a); other[diff[0]] = 0x81;
  assert.equal(pf.liftMemoryMax(other.buffer), other.buffer);
  assert.equal(pf.memoryLimit(), 32769 * 65536);
  assert.equal(liftWasm(other).lifted, false);
  pf.liftMemoryMax(ab());
  assert.equal(pf.memoryLimit(), pf.MEMORY_MAX);
});

/** a generated sheet: text in a font, line work, a picture */
function generated(): Uint8Array {
  const d = new mupdf.PDFDocument();
  const font = d.addSimpleFont(new mupdf.Font('Helvetica'));
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 64, 64], false);
  pix.clear(90);
  const im = d.addImage(new mupdf.Image(pix));
  let lines = '0 0 1 RG 1 w ';
  for (let i = 0; i < 40; i++) lines += `${60 + i * 15} 80 m ${60 + i * 15} 500 l S `;
  const text = Array.from({ length: 20 }, (_, i) => `BT /F1 11 Tf 620 ${520 - i * 14} Td (Room ${101 + i} finishes schedule line ${i}) Tj ET`).join(' ');
  d.insertPage(-1, d.addPage([0, 0, 1190, 842], 0, { Font: { F1: font }, XObject: { Im1: im } }, `${lines} ${text} q 200 0 0 200 900 600 cm /Im1 Do Q BT /F1 18 Tf 900 60 Td (A-101) Tj ET`));
  return d.saveToBuffer('').asUint8Array().slice();
}
const gen = generated();
const snapShapes = new Uint8Array(readFileSync('tests/fixtures/snap-shapes.pdf'));
const binder = new Uint8Array(readFileSync('tests/fixtures/binder-3.pdf'));
const readerOf = (b: Uint8Array): pf.Reader => ({
  size: b.length,
  read(buf, off, len, pos) { buf.set(b.subarray(pos, pos + len), off); return len; },
  close() { /* in memory */ },
});
const bytes = (b: Uint8Array) => b.slice().buffer as ArrayBuffer;
/** one engine for the file (started again, the block reader it was given would be another module's) */
async function engine() { try { pf.mustP(); } catch { await pf.startEngine(ab()); } }

/** everything compared, for one run */
function sample(tag: string) {
  const out: Record<string, unknown> = {};
  const { pages } = pf.openDoc(tag + 'g', bytes(gen));
  const g = pf.docs.get(tag + 'g')!;
  out.pages = JSON.stringify(pages);
  out.text = pf.pageText(g, 0);
  out.words = JSON.stringify(pf.pageWords(g, 0));
  out.px = hash(pf.renderRaw(g, 0, 1.5, 100, 100, 900, 700, 1));
  out.quick = hash(pf.renderRaw(g, 0, 0.5, 0, 0, 595, 421, 0));
  pf.closeDoc(tag + 'g');
  // read in blocks from the "file" (the blocks land in the engine's memory)
  pf.openDoc(tag + 's', readerOf(snapShapes));
  const s = pf.docs.get(tag + 's')!;
  out.snapPx = hash(pf.renderRaw(s, 0, 2, 200, 100, 800, 600, 1));
  const ix = pf.buildSnap(s, 0);
  out.snapN = ix.n;
  const near: number[] = [];
  out.snap = JSON.stringify([pf.snap(ix, 300, 300, 40), pf.snap(ix, 600, 420, 60, near), near.length]);
  pf.closeDoc(tag + 's');
  pf.openDoc(tag + 'b', readerOf(binder));
  const b = pf.docs.get(tag + 'b')!;
  out.binder = JSON.stringify([0, 1, 2].map((i) => [pf.pageText(b, i), hash(pf.renderRaw(b, i, 0.4, 0, 0, 476, 337, 1))]));
  pf.closeDoc(tag + 'b');
  return out;
}

test('past 2 GB, and near 4 GB: pages drawn, text, words and snapping come out the same', { timeout: 300_000 }, async () => {
  await engine();
  const low = sample('a');
  assert.ok(pf.nextAddress() < 2 ** 31, 'first run below 2 GB');
  assert.ok(String(low.text).includes('Room 101') && Number(low.snapN) > 10 && JSON.parse(low.words as string).length > 50, 'the samples are real');
  // everything after this lands past 2 GB
  const give = pf.fillBelow(2 ** 31, 2.1 * GB);
  try {
    assert.ok(pf.nextAddress() > 2 ** 31, `next allocation past 2 GB (${(pf.nextAddress() / GB).toFixed(2)} GB)`);
    assert.ok(pf.heapBytes() > 2 * GB);
    const high = sample('b');
    for (const k of Object.keys(low)) assert.equal(high[k], low[k], k + ' differs past 2 GB');
    // and further: up to the 4 GB limit
    const give2 = pf.fillBelow(3.6 * GB, 1.5 * GB);
    try {
      assert.ok(pf.nextAddress() > 3.6 * GB);
      assert.ok(pf.heapBytes() > 3.6 * GB, `grew to ${(pf.heapBytes() / GB).toFixed(2)} GB`);
      assert.ok(pf.heapBytes() <= pf.MEMORY_MAX);
      const top = sample('c');
      for (const k of Object.keys(low)) assert.equal(top[k], low[k], k + ' differs near 4 GB');
      // past the limit: refused as out of memory (fatal: a fresh engine), never written over address 0
      assert.throws(() => pf.holdMemory(0.6 * GB), (e: unknown) => pf.isFatal(e));
    } finally { give2(); }
  } finally { give(); }
  assert.equal(pf.docs.size, 0);
});

/**
 * A two-page PDF whose second page (and the cross-reference table) sit past `gap` bytes of a dummy
 * stream: the hole is never written (a sparse file, no disk used).
 */
function sparsePdf(name: string, gap: number): string {
  const p = join(TMP, name);
  const fd = openSync(p, 'w');
  let at = 0;
  const offs: number[] = [];
  const put = (s: string) => { const b = Buffer.from(s, 'latin1'); writeSync(fd, b, 0, b.length, at); at += b.length; };
  const page = (n: number, text: string) => {
    const c = `BT /F1 40 Tf 60 400 Td (${text}) Tj ET 0 0 1 rg 60 100 200 100 re f`;
    offs[n] = at; put(`${n} 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 3 0 R>>>>/Contents ${n + 1} 0 R>>\nendobj\n`);
    offs[n + 1] = at; put(`${n + 1} 0 obj\n<</Length ${c.length}>>\nstream\n${c}\nendstream\nendobj\n`);
  };
  put('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
  offs[1] = at; put('1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n');
  offs[2] = at; put('2 0 obj\n<</Type/Pages/Kids[4 0 R 7 0 R]/Count 2>>\nendobj\n');
  offs[3] = at; put('3 0 obj\n<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>\nendobj\n');
  page(4, 'FIRST PAGE');
  offs[6] = at; put(`6 0 obj\n<</Length ${gap}>>\nstream\n`);
  at += gap;
  put('\nendstream\nendobj\n');
  page(7, 'PAGE PAST THE GAP');
  const xref = at;
  let t = `xref\n0 9\n0000000000 65535 f \n`;
  for (let k = 1; k <= 8; k++) t += `${String(offs[k]).padStart(10, '0')} 00000 n \n`;
  put(t + `trailer\n<</Size 9/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`);
  ftruncateSync(fd, at);
  closeSync(fd);
  return p;
}

test('a drawing of 2.05 GB opens on demand: its page past 2 GB is read and drawn; 4 GB and more is refused with a message', async () => {
  await engine();
  const f = sparsePdf('two-gb.pdf', Math.round(2.05 * GB));
  const vf = new VFile({ path: f });
  assert.ok(vf.size > 2 ** 31);
  const { pages } = pf.openDoc('g2', vf);
  assert.equal(pages.length, 2);
  const d = pf.docs.get('g2')!;
  assert.match(pf.pageText(d, 1), /PAGE PAST THE GAP/);
  const px = pf.renderRaw(d, 1, 1, 0, 0, 595, 842, 1);
  const i = ((842 - 150) * 595 + 160) * 4; // the blue box on page 2
  assert.ok(px[i + 2] > 200 && px[i] < 60, 'the page past 2 GB drawn: ' + [px[i], px[i + 1], px[i + 2]]);
  pf.closeDoc('g2');
  const f4 = sparsePdf('four-gb.pdf', 2 ** 32 + 10);
  const v4 = new VFile({ path: f4 });
  assert.throws(() => pf.openDoc('g4', v4), /4 GB or more can't be opened/);
  v4.close();
});

// A sheet that took the drawing engine down before 0.23: tests/gen/make-huge.py's "Monster strokes.pdf"
// (an A1 sheet of 12 million separate strokes, 94 MB) needs about 2.8 GB of engine memory to draw.
// Drawn here in a process of its own both ways: at 2 GB (GT_OFF=pdfium4gb, as up to 0.22) the engine
// stops (the app had to start a new one - and after a second time said "too heavy"); at 4 GB it is drawn.
const HUGE = process.env.HUGE ?? '';
const MONSTER = HUGE ? join(HUGE, 'Monster strokes.pdf') : '';
test('a sheet that ran the 2 GB engine out of memory is drawn by the 4 GB one, no restart', { skip: !(MONSTER && existsSync(MONSTER)) && 'no huge test files (HUGE=<folder of tests/gen/make-huge.py>)', timeout: 600_000 }, () => {
  const probe = join(TMP, 'monster.mts');
  writeFileSync(probe, [
    `import fs from 'node:fs';`,
    `import * as pf from ${JSON.stringify(pathToFileURL(resolve('src/ui/takeoff/pdfcore.ts')).href)};`,
    `import { VFile } from ${JSON.stringify(pathToFileURL(resolve('src/engine/pdfhost/files.ts')).href)};`,
    `const w = fs.readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');`,
    `await pf.startEngine(w.buffer.slice(w.byteOffset, w.byteOffset + w.byteLength));`,
    `const t0 = Date.now();`,
    `try {`,
    `  const { pages } = pf.openDoc('m', new VFile({ path: ${JSON.stringify(MONSTER)} }));`,
    `  const s = 0.15, W = Math.round(pages[0].w * s), H = Math.round(pages[0].h * s);`,
    `  const px = pf.renderRaw(pf.docs.get('m'), 0, s, 0, 0, W, H, 0);`,
    `  let ink = 0; for (let i = 0; i < px.length; i += 4) if (px[i] < 128) ink++;`,
    `  console.log(JSON.stringify({ ok: true, ink, heap: pf.heapMB(), ms: Date.now() - t0 }));`,
    `} catch (e) { console.log(JSON.stringify({ ok: false, fatal: pf.isFatal(e), error: String(e?.message ?? e).slice(0, 100), heap: pf.heapMB(), ms: Date.now() - t0 })); }`,
  ].join('\n'));
  const run = (off: string) => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', probe], { env: { ...process.env, GT_OFF: off }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 24 }).trim().split('\n').pop()!);
  const before = run('pdfium4gb');
  const now = run('');
  console.log(`   12 M-stroke sheet: 2 GB engine ${before.ok ? 'drew it' : 'stopped (' + before.error + ')'} at ${before.heap} MB; 4 GB engine ${now.ok ? 'drew it' : 'stopped'} at ${now.heap} MB in ${(now.ms / 1000).toFixed(1)} s`);
  assert.equal(before.ok, false, 'the 2 GB engine runs out of memory on it');
  assert.equal(before.fatal, true, '...fatally (the app had to start a new engine)');
  assert.equal(now.ok, true, 'the 4 GB engine draws it: ' + JSON.stringify(now));
  assert.ok(now.ink > 1000 && now.heap > 2048, 'drawn, past 2 GB');
});
