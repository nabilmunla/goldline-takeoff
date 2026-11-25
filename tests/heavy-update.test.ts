// Monster sheets' simplified line work, written as an incremental update by us (heavy.ts
// writeUpdate) - not by MuPDF, whose own save builds "the whole original + changes" in memory and
// failed past ~600 MB (a 758 MB set with one monster sheet: "realloc failed", v0.12.5 after the PDF
// Editor 0.8.2). Every kind of file below must come out drawn the same through the drawing engine,
// and open without repair.
// run: npx tsx --test tests/heavy-update.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import * as mupdf from 'mupdf';
import { simplify, __test } from '../src/engine/pdfhost/heavy';
import { startEngine, openDoc, closeDoc, renderRaw, docs, mustP } from '../src/ui/takeoff/pdfcore';
import { VFile, type FileSrc } from '../src/engine/pdfhost/files';

const dir = mkdtempSync(join(tmpdir(), 'gt-heavyupd-'));

/** content of n separate little strokes (as a traced scan has them) */
function strokes(n: number, seed = 0): Buffer {
  const parts = ['0 G 0.5 w\n'];
  let x = 50, y = 50;
  for (let i = 0; i < n; i++) {
    if (i % 300 === 0) { x = 50 + (((i + seed) * 7) % 700); y = 50 + (((i + seed) * 13) % 500); }
    const nx = x + ((i * 31) % 5) - 2, ny = y + ((i * 17) % 5) - 2;
    parts.push(`${x.toFixed(2)} ${y.toFixed(2)} m ${nx.toFixed(2)} ${ny.toFixed(2)} l S\n`);
    x = nx; y = ny;
  }
  return deflateSync(Buffer.from(parts.join('')));
}

/**
 * A PDF written by hand: objects [num, gen, body, stream?]; then optional extra updates
 * (each its own objects + xref + trailer with /Prev) and junk after the end.
 */
function pdf(objs: [number, number, string, Buffer?][], root: string, updates: [number, number, string][][] = [], junk = ''): Buffer {
  const chunks: Buffer[] = [];
  let pos = 0;
  const put = (b: Buffer | string) => { const v = typeof b === 'string' ? Buffer.from(b, 'latin1') : b; chunks.push(v); pos += v.length; };
  put('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  const section = (list: [number, number, string, Buffer?][], prev: number | null, size: number) => {
    const at: [number, number, number][] = [];
    for (const [num, gen, body, stream] of list) {
      at.push([num, gen, pos]);
      put(`${num} ${gen} obj\n${body}\n`);
      if (stream) { put('stream\n'); put(stream); put('\nendstream\n'); }
      put('endobj\n');
    }
    const xref = pos;
    let x = 'xref\n' + (prev === null ? '0 1\n0000000000 65535 f\r\n' : '');
    for (const [num, gen, off] of at.sort((a, b) => a[0] - b[0])) x += `${num} 1\n${String(off).padStart(10, '0')} ${String(gen).padStart(5, '0')} n\r\n`;
    put(x + `trailer\n<< /Size ${size} /Root ${root}${prev === null ? '' : ' /Prev ' + prev} >>\nstartxref\n${xref}\n%%EOF\n`);
    return xref;
  };
  const size = Math.max(...objs.map((o) => o[0]), ...updates.flat().map((o) => o[0])) + 1;
  let prev = section(objs, null, size);
  for (const u of updates) prev = section(u, prev, size);
  put(junk);
  return Buffer.concat(chunks);
}

const page = (parent: string, contents: string) => `<< /Type /Page /Parent ${parent} /MediaBox [0 0 842 595] /Contents ${contents} >>`;

async function engine() {
  try { mustP(); } catch {
    const wasm = readFileSync(join(process.cwd(), 'node_modules/@embedpdf/pdfium/dist/pdfium.wasm'));
    await startEngine(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);
  }
}
let seq = 0;
/** each page drawn small through the drawing engine (PDFium); `xrefOk`: it read the file through its
 *  cross-references (false = it had to rebuild them, reading the whole file: what an update with wrong
 *  offsets costs at every opening - drawn the same, so a picture compare alone would not see it) */
let xrefOk = true;
function draw(src: FileSrc): Uint8ClampedArray[] {
  const key = 'k' + ++seq;
  const r = openDoc(key, new VFile(src)) as { pages: { w: number; h: number }[] };
  xrefOk = !!(mustP() as any).FPDF_DocumentHasValidCrossReferenceTable(docs.get(key)!.doc);
  const out = r.pages.map((p, i) => renderRaw(docs.get(key)!, i, 300 / p.w, 0, 0, 300, Math.round(p.h * 300 / p.w), 1));
  closeDoc(key);
  return out;
}
const differing = (a: Uint8ClampedArray, b: Uint8ClampedArray) => { let d = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 60) d++; return d; };
/** the update: ours (starts with a new line and an object) or MuPDF's (its comment) */
const writer = (delta: string) => (readFileSync(delta).subarray(0, 60).toString('latin1').trimStart().startsWith('% Written by MuPDF') ? 'mupdf' : 'ours');
/** opened by MuPDF too, without repair */
function opensClean(src: FileSrc): boolean {
  const v = new VFile(src);
  try {
    const stm = new mupdf.Stream({ fileSize: () => v.size, read: (m: Uint8Array, o: number, l: number, p: number) => v.read(m, o, l, p), close() { /* */ } } as never);
    const d = mupdf.Document.openDocument(stm, 'application/pdf').asPDF()!;
    return !d.wasRepaired();
  } finally { v.close(); }
}

async function check(name: string, bytes: Buffer, pagesToForce: number[], expectWriter: 'ours' | 'mupdf') {
  await engine();
  const f = join(dir, name + '.pdf');
  writeFileSync(f, bytes);
  const before = draw({ path: f });
  const xrefBefore = xrefOk;
  const r = simplify({ path: f }, join(dir, name), 'force', pagesToForce);
  assert.ok(r.pages.length >= pagesToForce.length, name + ': simplified ' + JSON.stringify(r.pages));
  assert.ok(r.delta && existsSync(r.delta), name + ': an update, not a whole new file');
  assert.equal(writer(r.delta!), expectWriter, name + ': written by');
  const src = { path: f, size: r.base, delta: r.delta };
  assert.ok(opensClean(src), name + ': opens without repair');
  const after = draw(src);
  if (xrefBefore) assert.ok(xrefOk, name + ': the engine reads it through its cross-references (not rebuilt)');
  assert.equal(after.length, before.length, name + ': same pages');
  for (let i = 0; i < before.length; i++) assert.ok(differing(before[i], after[i]) < before[i].length / 4 / 1000, `${name}: page ${i + 1} drawn the same (${differing(before[i], after[i])} pixels differ)`);
  return r;
}

test('a plain file: our update, drawn the same', async () => {
  const s = strokes(80_000);
  await check('plain', pdf([[1, 0, '<< /Type /Catalog /Pages 2 0 R >>'], [2, 0, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'], [3, 0, page('2 0 R', '4 0 R')], [4, 0, `<< /Length ${s.length} /Filter /FlateDecode >>`, s]], '1 0 R'), [0], 'ours');
});

test('a page object of generation 1, and two pages sharing one content', async () => {
  const s = strokes(70_000, 5);
  const r = await check('gen1-shared', pdf([[1, 0, '<< /Type /Catalog /Pages 2 0 R >>'], [2, 0, '<< /Type /Pages /Kids [3 1 R 5 0 R] /Count 2 >>'], [3, 1, page('2 0 R', '4 0 R')], [5, 0, page('2 0 R', '4 0 R')], [4, 0, `<< /Length ${s.length} /Filter /FlateDecode >>`, s]], '1 0 R'), [0], 'ours');
  assert.deepEqual([...r.pages].sort(), [0, 1], 'the page sharing it got the merged content too');
  assert.match(readFileSync(r.delta!, 'latin1'), /\n3 1 obj\n/, 'written with its own generation');
});

test('a file already updated (two /Prev) and with junk after its end', async () => {
  const s = strokes(60_000, 9);
  await check('updated-junk', pdf([[1, 0, '<< /Type /Catalog /Pages 2 0 R >>'], [2, 0, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'], [3, 0, page('2 0 R', '4 0 R')], [4, 0, `<< /Length ${s.length} /Filter /FlateDecode >>`, s]], '1 0 R',
    [[[6, 0, '<< /Title (first update) >>']], [[7, 0, '<< /Title (second update) >>']]], '\n\n   \n'), [0], 'ours');
});

test('compressed cross-references (object streams), as MuPDF saves them', async () => {
  const s = strokes(60_000, 13);
  const plain = pdf([[1, 0, '<< /Type /Catalog /Pages 2 0 R >>'], [2, 0, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'], [3, 0, page('2 0 R', '4 0 R')], [4, 0, `<< /Length ${s.length} /Filter /FlateDecode >>`, s]], '1 0 R');
  const d = mupdf.Document.openDocument(plain, 'application/pdf').asPDF()!;
  const buf = d.saveToBuffer('compress,objstms');
  await check('objstm', Buffer.from(buf.asUint8Array()), [0], 'ours');
});

test('an encrypted file (owner password only, opens without one): MuPDF writes the update', async () => {
  const s = strokes(60_000, 21);
  const plain = pdf([[1, 0, '<< /Type /Catalog /Pages 2 0 R >>'], [2, 0, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'], [3, 0, page('2 0 R', '4 0 R')], [4, 0, `<< /Length ${s.length} /Filter /FlateDecode >>`, s]], '1 0 R');
  const d = mupdf.Document.openDocument(plain, 'application/pdf').asPDF()!;
  const buf = d.saveToBuffer('encrypt=aes-128,owner-password=gt,user-password=,permissions=-1');
  await check('encrypted', Buffer.from(buf.asUint8Array()), [0], 'mupdf');
});

test('a damaged file (repaired on opening) past the size MuPDF can save whole: a new file written object by object', async () => {
  await engine();
  const s = strokes(60_000, 33);
  const good = pdf([[1, 0, '<< /Type /Catalog /Pages 2 0 R >>'], [2, 0, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'], [3, 0, page('2 0 R', '4 0 R')], [4, 0, `<< /Length ${s.length} /Filter /FlateDecode >>`, s]], '1 0 R');
  // the cross-reference points nowhere: MuPDF (and PDFium) rebuild it on opening
  const bad = Buffer.from(good.toString('latin1').replace(/startxref\n\d+/, 'startxref\n12'), 'latin1');
  const f = join(dir, 'damaged.pdf');
  writeFileSync(f, bad);
  const before = draw({ path: f });
  process.env.GT_STREAM_SAVE = '1000';
  try {
    const r = simplify({ path: f }, join(dir, 'damaged'), 'force', [0]);
    assert.deepEqual(r.pages, [0]);
    assert.ok(r.full && existsSync(r.full) && !r.delta, 'a whole new file');
    assert.match(readFileSync(r.full!).subarray(0, 12).toString('latin1'), /^%PDF-1\.7/, 'ours (object by object)');
    assert.ok(opensClean({ path: r.full! }), 'which opens without repair');
    const after = draw({ path: r.full! });
    assert.ok(differing(before[0], after[0]) < before[0].length / 4 / 1000, 'drawn the same');
  } finally { delete process.env.GT_STREAM_SAVE; }
});

test('bytes before %PDF (offsets counted from there): our update counts the same way', async () => {
  const s = strokes(60_000, 41);
  const body = pdf([[1, 0, '<< /Type /Catalog /Pages 2 0 R >>'], [2, 0, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'], [3, 0, page('2 0 R', '4 0 R')], [4, 0, `<< /Length ${s.length} /Filter /FlateDecode >>`, s]], '1 0 R');
  const r = await check('prefix', Buffer.concat([Buffer.from('X-Mailer: scanner 3.1\r\nContent-Type: application/pdf\r\n\r\n'), body]), [0], 'ours');
  assert.match(readFileSync(r.delta!, 'latin1'), /startxref\n(\d+)/);
});

test('"startxref" with no space before its number: the last section is still the one built on', async () => {
  const s = strokes(60_000, 45);
  const square = deflateSync(Buffer.from('0 g 100 100 600 400 re f\n'));
  // page 2's content replaced by a later revision; that revision's startxref has no space
  const b = pdf([[1, 0, '<< /Type /Catalog /Pages 2 0 R >>'], [2, 0, '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>'], [3, 0, page('2 0 R', '4 0 R')], [4, 0, `<< /Length ${s.length} /Filter /FlateDecode >>`, s], [5, 0, page('2 0 R', '6 0 R')], [6, 0, '<< /Length 0 >>', Buffer.alloc(0)]], '1 0 R',
    [[[6, 0, `<< /Length ${square.length} /Filter /FlateDecode >>`, square] as any]]);
  const t = b.toString('latin1');
  const last = t.lastIndexOf('startxref\n');
  const nows = Buffer.from(t.slice(0, last) + 'startxref' + t.slice(last + 10), 'latin1');
  assert.equal(__test.lastXref(new VFile({ path: (() => { const f = join(dir, 'nows-probe.pdf'); writeFileSync(f, nows); return f; })() })), Number(/startxref(\d+)/.exec(nows.toString('latin1').slice(last))![1]));
  await check('nows', nows, [0], 'ours'); // page 2 (the square) drawn the same: the later revision kept
});

test('AES-256 with object streams: MuPDF writes the update, and it is taken (not a whole new file)', async () => {
  const s = strokes(60_000, 49);
  const plain = pdf([[1, 0, '<< /Type /Catalog /Pages 2 0 R >>'], [2, 0, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'], [3, 0, page('2 0 R', '4 0 R')], [4, 0, `<< /Length ${s.length} /Filter /FlateDecode >>`, s]], '1 0 R');
  const d = mupdf.Document.openDocument(plain, 'application/pdf').asPDF()!;
  await check('aes256', Buffer.from(d.saveToBuffer('compress,objstms,encrypt=aes-256,owner-password=x,user-password=,permissions=-1').asUint8Array()), [0], 'mupdf');
});

test('the read-back check: an update whose offsets are wrong is refused, even when MuPDF repairs it only later', async () => {
  const s = strokes(60_000, 53);
  const f = join(dir, 'lazy.pdf');
  writeFileSync(f, pdf([[1, 0, '<< /Type /Catalog /Pages 2 0 R >>'], [2, 0, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'], [3, 0, page('2 0 R', '4 0 R')], [4, 0, `<< /Length ${s.length} /Filter /FlateDecode >>`, s]], '1 0 R'));
  const r = simplify({ path: f }, join(dir, 'lazy'), 'force', [0]);
  const good = readFileSync(r.delta!, 'latin1');
  const ch = { pages: new Map([[3, 0]]), streams: new Map<number, Uint8Array>() };
  const want = { pages: 1, objects: 6 };
  assert.ok(__test.updateReads({ path: f }, r.base!, r.delta!, ch, want), 'the real one passes');
  // the page's offset moved 7 bytes: MuPDF opens it fine, then repairs when the page is loaded
  const bad = good.replace(/\n3 1\n(\d{10})/, (_m, o) => '\n3 1\n' + String(Number(o) + 7).padStart(10, '0'));
  assert.notEqual(bad, good);
  const bd = join(dir, 'lazy-bad.delta');
  writeFileSync(bd, Buffer.from(bad, 'latin1'));
  assert.equal(__test.updateReads({ path: f }, r.base!, bd, ch, want), false);
});

test('a whole file written object by object keeps names byte for byte and a direct /Info', async () => {
  const s = strokes(60_000, 57);
  const good = pdf([[1, 0, '<< /Type /Catalog /Pages 2 0 R /Metadata 6 0 R >>'], [2, 0, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'], [3, 0, page('2 0 R', '4 0 R')], [4, 0, `<< /Length ${s.length} /Filter /FlateDecode >>`, s], [6, 0, '<< /Type /Metadata /A#80#e9 1 /Length 4 >>', Buffer.from('meta')]], '1 0 R /Info << /Title (direct) >>');
  const bad = Buffer.from(good.toString('latin1').replace(/startxref\n\d+/, 'startxref\n12'), 'latin1');
  const f = join(dir, 'names.pdf');
  writeFileSync(f, bad);
  process.env.GT_STREAM_SAVE = '1000';
  try {
    const r = simplify({ path: f }, join(dir, 'names'), 'force', [0]);
    const t = readFileSync(r.full!, 'latin1');
    assert.match(t, /\/A#80#[eE]9/, 'the name as it was');
    assert.match(t, /\/Info\s*<<\s*\/Title\s*\(direct\)/, 'the direct /Info kept');
  } finally { delete process.env.GT_STREAM_SAVE; }
});

test('a wrong offset found while merging (MuPDF repairs then, dropping the edits): merged again, really simplified', async () => {
  await engine();
  const s = strokes(70_000, 61);
  const other = deflateSync(Buffer.from('0 g 100 100 300 200 re f\n'));
  const good = pdf([[1, 0, '<< /Type /Catalog /Pages 2 0 R >>'], [2, 0, '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>'], [3, 0, page('2 0 R', '4 0 R')], [4, 0, `<< /Length ${s.length} /Filter /FlateDecode >>`, s],
    [5, 0, page('2 0 R', '6 0 R')], [6, 0, `<< /Length ${other.length} /Filter /FlateDecode >>`, other], [7, 0, page('2 0 R', '8 0 R')], [8, 0, `<< /Length ${s.length} /Filter /FlateDecode >>`, s]], '1 0 R');
  // object 6 (page 2's content) listed 7 bytes off
  const bad = Buffer.from(good.toString('latin1').replace(/\n6 1\n(\d{10})/, (_m, o) => '\n6 1\n' + String(Number(o) + 7).padStart(10, '0')), 'latin1');
  assert.notDeepEqual(bad, good);
  const f = join(dir, 'lazy-merge.pdf');
  writeFileSync(f, bad);
  const r = simplify({ path: f }, join(dir, 'lazy-merge'), 'force', [0, 2]);
  assert.deepEqual(r.pages, [0, 2]);
  assert.ok(r.full, 'a whole new file (the document was repaired)');
  const d = mupdf.Document.openDocument(readFileSync(r.full!), 'application/pdf').asPDF()!;
  for (const i of [0, 2]) assert.ok(!d.findPage(i).get('Contents').get('GTMerged').isNull(), `page ${i + 1} really points at the merged content`);
  const before = draw({ path: f });
  const after = draw({ path: r.full! });
  for (const i of [0, 2]) assert.ok(differing(before[i], after[i]) < before[i].length / 4 / 1000, `page ${i + 1} drawn the same`);
});

test('a stamped drawing: the line work wrapped in small uncompressed q / Q streams is simplified too', async () => {
  const s = strokes(60_000, 65);
  await check('stamped', pdf([[1, 0, '<< /Type /Catalog /Pages 2 0 R >>'], [2, 0, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'], [3, 0, page('2 0 R', '[5 0 R 4 0 R 6 0 R]')],
    [4, 0, `<< /Length ${s.length} /Filter /FlateDecode >>`, s], [5, 0, '<< /Length 2 >>', Buffer.from('q\n')], [6, 0, '<< /Length 33 >>', Buffer.from('Q\nq 1 0 0 RG 20 20 100 50 re S Q\n')]], '1 0 R'), [0], 'ours');
});

test('compressed content with a wrong checksum at its end (the readers draw it): simplified, drawn the same', async () => {
  const s = Buffer.from(strokes(60_000, 69));
  s[s.length - 1] ^= 0xff; // the adler-32 at its end
  await check('badsum', pdf([[1, 0, '<< /Type /Catalog /Pages 2 0 R >>'], [2, 0, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'], [3, 0, page('2 0 R', '4 0 R')], [4, 0, `<< /Length ${s.length} /Filter /FlateDecode >>`, s]], '1 0 R'), [0], 'ours');
});
