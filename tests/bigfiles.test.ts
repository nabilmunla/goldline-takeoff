// v0.12.5 massive drawings (the PDF Editor's way): the engines read a drawing from disk on demand,
// and monster sheets get their line work simplified - drawn the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdtempSync, statSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { startEngine, openDoc, closeDoc, docs, renderRaw, heapMB, mustP, pageText, type Reader } from '../src/ui/takeoff/pdfcore';
import { VFile } from '../src/engine/pdfhost/files';

const SAMPLES = process.env.QTO_SAMPLES ?? '';
const HUGE = process.env.HUGE ?? '';
const sample = (part: string) => { if (!existsSync(SAMPLES)) return null; const f = readdirSync(SAMPLES).find((x) => x.includes(part)); return f ? join(SAMPLES, f) : null; };
const tmp = () => mkdtempSync(join(tmpdir(), 'gtbig-'));

async function engine() {
  try { mustP(); } catch {
    const wasm = readFileSync(join(process.cwd(), 'node_modules/@embedpdf/pdfium/dist/pdfium.wasm'));
    await startEngine(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  }
}

/** a reader that counts what it is asked for */
function counting(r: Reader) {
  const c = { bytes: 0, calls: 0 };
  return { c, r: { size: r.size, read: (b: Uint8Array, o: number, l: number, p: number) => { c.bytes += l; c.calls++; return r.read(b, o, l, p); }, close: () => r.close() } as Reader };
}

/** a one-page PDF: n separate little strokes (the kind monster sheets are made of) */
function strokesPdf(n: number): Uint8Array {
  const parts = ['0 G 0.5 w\n'];
  let x = 50, y = 50;
  for (let i = 0; i < n; i++) {
    if (i % 300 === 0) { x = 50 + ((i * 7) % 700); y = 50 + ((i * 13) % 500); }
    const nx = x + ((i * 31) % 5) - 2, ny = y + ((i * 17) % 5) - 2;
    parts.push(`${x.toFixed(2)} ${y.toFixed(2)} m ${nx.toFixed(2)} ${ny.toFixed(2)} l S\n`);
    x = nx; y = ny;
  }
  const content = deflateSync(Buffer.from(parts.join('')));
  const objs: Buffer[] = [];
  const offs: number[] = [];
  let pos = 0;
  const put = (b: Buffer) => { objs.push(b); pos += b.length; };
  put(Buffer.from('%PDF-1.4\n'));
  const obj = (k: number, body: string, stream?: Buffer) => { offs[k] = pos; put(Buffer.from(`${k} 0 obj\n${body}\n`)); if (stream) { put(Buffer.from('stream\n')); put(stream); put(Buffer.from('\nendstream\n')); } put(Buffer.from('endobj\n')); };
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Contents 4 0 R >>');
  obj(4, `<< /Length ${content.length} /Filter /FlateDecode >>`, content);
  const xref = pos;
  let x2 = 'xref\n0 5\n0000000000 65535 f \n';
  for (let k = 1; k <= 4; k++) x2 += String(offs[k]).padStart(10, '0') + ' 00000 n \n';
  put(Buffer.from(x2 + `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(objs));
}

test('a drawing read on demand: the same pages and picture as read whole, without reading it all', { skip: !sample('11030') && 'no sample drawings' }, async () => {
  await engine();
  const f = sample('11030')!;
  const bytes = readFileSync(f);
  const whole = openDoc('whole', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const { c, r } = counting(new VFile({ path: f }));
  const lazy = openDoc('lazy', r);
  assert.deepEqual(lazy.pages, whole.pages);
  assert.ok(c.bytes < bytes.length / 4, `opening read ${c.bytes} of ${bytes.length} bytes`);
  const a = renderRaw(docs.get('whole')!, 0, 0.3, 200, 100, 300, 200, 1);
  const b = renderRaw(docs.get('lazy')!, 0, 0.3, 200, 100, 300, 200, 1);
  assert.deepEqual(b, a, 'the same picture');
  assert.equal(pageText(docs.get('lazy')!, 0), pageText(docs.get('whole')!, 0));
  closeDoc('whole');
  closeDoc('lazy');
});

test('a 350 MB bound set opens on demand in a fraction of a second, the engine stays small', { skip: !existsSync(join(HUGE, 'Set - heavy sheets.pdf')) && 'no huge test files (tests/gen/make-huge.py)' }, async () => {
  await engine();
  const f = join(HUGE, 'Set - heavy sheets.pdf');
  const before = heapMB();
  const t0 = performance.now();
  const { c, r } = counting(new VFile({ path: f }));
  const { pages } = openDoc('set', r);
  const ms = performance.now() - t0;
  console.log(`  ${Math.round(statSync(f).size / 1e6)} MB, ${pages.length} pages: open ${Math.round(ms)} ms, read ${Math.round(c.bytes / 1e6 * 10) / 10} MB, engine ${heapMB()} MB (was ${before})`);
  assert.ok(pages.length >= 40);
  assert.ok(ms < 3000, 'opens quickly');
  assert.ok(c.bytes < 20e6, 'reads a small part to open');
  // the last page drawn small: only that page's bytes are read
  const px = renderRaw(docs.get('set')!, pages.length - 1, 0.1, 0, 0, 200, 150, 0);
  assert.equal(px.length, 200 * 150 * 4);
  assert.ok(heapMB() - before < 900, `engine grew ${heapMB() - before} MB`);
  closeDoc('set');
});

test('a file plus changes reads as one; a base that changed since is refused', () => {
  const d = tmp();
  writeFileSync(join(d, 'base.bin'), Buffer.from('0123456789'));
  writeFileSync(join(d, 'delta.bin'), Buffer.from('ABCDE'));
  const v = new VFile({ path: join(d, 'base.bin'), size: 8, delta: join(d, 'delta.bin') });
  assert.equal(v.size, 13);
  const b = new Uint8Array(13);
  assert.equal(v.read(b, 0, 13, 0), 13);
  assert.equal(Buffer.from(b).toString(), '01234567ABCDE', 'the first 8 bytes of the base, then the changes');
  const p = new Uint8Array(4);
  assert.equal(v.read(p, 0, 4, 6), 4);
  assert.equal(Buffer.from(p).toString(), '67AB', 'a read across the join');
  v.close();
  assert.equal(v.read(p, 0, 4, 0), 0, 'closed: nothing');
  // the base cut short since the changes were written: not spliced at the wrong place
  writeFileSync(join(d, 'short.bin'), Buffer.from('0123'));
  assert.throws(() => new VFile({ path: join(d, 'short.bin'), size: 8, delta: join(d, 'delta.bin') }), /changed meanwhile/);
  appendFileSync(join(d, 'short.bin'), 'x');
  assert.throws(() => new VFile({ path: join(d, 'missing.bin') }), /ENOENT/);
});

test('a monster sheet simplified: far fewer strokes, drawn the same, read as the original + changes', async (t) => {
  let heavy: typeof import('../src/engine/pdfhost/heavy');
  try { heavy = await import('../src/engine/pdfhost/heavy'); } catch (e) { t.skip('MuPDF not installed: ' + (e as Error).message); return; }
  await engine();
  const d = tmp();
  const f = join(d, 'monster.pdf');
  writeFileSync(f, strokesPdf(120_000));
  // a check finds nothing in a small file (only true monsters are looked at)
  assert.deepEqual(heavy.simplify({ path: f }, join(d, 'chk'), 'check').pages, []);
  // a page that took the engines down: simplified on request
  const r = heavy.simplify({ path: f }, join(d, 'out'), 'force', [0]);
  console.log(`  ${r.strokesIn} strokes -> ${r.strokesOut} in ${r.ms} ms, ${r.delta ? 'changes ' + statSync(r.delta).size + ' bytes' : 'whole file'}`);
  assert.deepEqual(r.pages, [0]);
  assert.equal(r.strokesIn, 120_000);
  assert.ok(r.strokesOut! < 200);
  assert.ok(r.delta && r.base === statSync(f).size, 'written as changes after the original');
  const bytes = readFileSync(f);
  openDoc('orig', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  openDoc('merged', new VFile({ path: f, size: r.base, delta: r.delta }));
  const a = renderRaw(docs.get('orig')!, 0, 1, 0, 0, 842, 595, 1);
  const b = renderRaw(docs.get('merged')!, 0, 1, 0, 0, 842, 595, 1);
  let diff = 0;
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 60) diff++;
  console.log(`  pixels that differ visibly: ${diff} of ${a.length / 4}`);
  assert.ok(diff < (a.length / 4) * 0.002, 'drawn the same (anti-aliasing aside)');
  closeDoc('orig');
  closeDoc('merged');
  // pages listed again (with one more): done again from the original, never on top of the changes
  const r2 = heavy.simplify({ path: f }, join(d, 'out'), 'force', [0, 5]);
  assert.deepEqual(r2.pages, [0]);
});
