// MuPDF.js 1.28.1 kept every PDF object it wrapped twice and let go of it once, so nothing a wrapper
// ever touched was freed. src/engine/pdfhost/mupdf-refs.ts fixes its two helpers: one wrapper = one
// reference (ported from the PDF Editor 0.12, tests/refs.test.ts - the parts that are MuPDF.js's own;
// the editor's journal and Combine are not in the take-off: the monster-sheet job is checked instead).
// Counts are read from MuPDF's memory (refsOf: the object's `short refs`). Generated files only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as mupdf from 'mupdf';
import { refsFixed, refsOf, refsNote, setRefsFixForTests, fixMupdfRefs } from '../src/engine/pdfhost/mupdf-refs';
import { simplify } from '../src/engine/pdfhost/heavy';
import { VFile } from '../src/engine/pdfhost/files';

// (heavy.ts put the fix in when it was loaded)
v8.setFlagsFromString('--expose-gc');
const gcNow: () => void = vm.runInNewContext('gc');
/** the collector, then a moment for its finalizers (they run as tasks of their own) */
async function collect() { for (let i = 0; i < 3; i++) { gcNow(); await new Promise((r) => setTimeout(r, 0)); } }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gtrefs-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));
const MB = 2 ** 20;
type O = mupdf.PDFObject;
const ptr = (o: unknown) => (o as { pointer: number }).pointer;
/** MuPDF's memory as bytes (a buffer's bytes are a view of it) */
const mem = () => new Uint8Array(new mupdf.Buffer().asUint8Array().buffer);
/** how big MuPDF's memory has grown (it never shrinks) */
const heap = () => mem().buffer.byteLength;
/** both ways round: with the fix (as built) and without (MuPDF.js as it came) */
async function bothWays<T>(f: (fix: boolean) => T | Promise<T>): Promise<[T, T]> {
  try {
    setRefsFixForTests(true); const on = await f(true);
    setRefsFixForTests(false); const off = await f(false);
    return [on, off];
  } finally { setRefsFixForTests(true); }
}

test('200,000 new dictionaries let go of - MuPDF\'s memory does not grow (it grew with every one)', async () => {
  // (first in this file: MuPDF's memory only grows, and freed room inside it would hide a leak)
  assert.equal(refsFixed(), true, 'the fix is in: ' + refsNote());
  const doc = new mupdf.PDFDocument();
  const [on, off] = await bothWays(() => {
    const h0 = heap();
    for (let i = 0; i < 200000; i++) doc.newDictionary().destroy();
    return heap() - h0;
  });
  console.log(`   200,000 x newDictionary + destroy: MuPDF grew ${(on / MB).toFixed(2)} MB with the fix, ${(off / MB).toFixed(2)} MB without`);
  assert.ok(on < MB, `under 1 MB with the fix (${(on / MB).toFixed(2)} MB)`);
  assert.ok(off > 4 * MB, `without it, every one leaks (${(off / MB).toFixed(2)} MB)`);
  doc.destroy();
});

test('the reference count is pdf_obj\'s first field - N wrappers move it by N (by 2N without the fix), nothing else moves', async () => {
  const doc = new mupdf.PDFDocument();
  const ind = doc.addObject(doc.newDictionary());
  const first = ind.resolve();
  const p = ptr(first);
  const fields = () => { const v = new DataView(mem().buffer); return [0, 2, 4, 6, 8, 10, 12, 14].map((k) => v.getInt16(p + k, true)); };
  await bothWays((fix) => {
    for (const n of [1, 5, 37]) {
      const f0 = fields();
      const ws = [...Array(n)].map(() => ind.resolve());
      const f1 = fields();
      assert.deepEqual(f1.map((v, k) => v - f0[k]), [fix ? n : 2 * n, 0, 0, 0, 0, 0, 0, 0], `${n} wrappers, fix ${fix}`);
      assert.equal(refsOf(ws[0]), f1[0], 'refsOf reads that field');
      ws.forEach((w) => w.destroy());
      // (without the fix each wrapper leaves one reference behind)
      assert.equal(fields()[0] - f0[0], fix ? 0 : n);
    }
  });
  assert.equal(String.fromCharCode(mem()[p + 2]), 'd', 'and the kind byte after it says dictionary');
  assert.equal(refsOf(doc.newBoolean(true)), -1, 'true is not memory');
  assert.equal(refsOf(doc.newName('Type')), -1, 'nor a built-in name');
  assert.equal(refsOf(mupdf.PDFObject.Null), -1);
  first.destroy(); ind.destroy(); doc.destroy();
});

/** MuPDF.js's lines that make wrappers: by the constructor, through each helper */
function wrapperLines() {
  const src = fs.readFileSync(path.join(process.cwd(), 'node_modules', 'mupdf', 'dist', 'mupdf.js'), 'utf8').split('\n');
  const at = (re: RegExp) => src.map((l, i) => (re.test(l) ? i + 1 : 0)).filter(Boolean);
  return { ctor: at(/new PDFObject\(/), owned: at(/\._fromPDFObjectNew\(/), borrowed: at(/\._fromPDFObjectKeep\(/) };
}
const OWNED = [1876, 1879, 1880, 1881, 1882, 1883, 1892, 1898, 1899, 1900, 1909, 1912, 1915, 1922, 1933, 1939, 1943, 1947, 1964, 1984, 2457];
const BORROWED = [1955, 2210, 2330, 2353, 2357, 2358, 2410, 2411, 2474, 2824];

test('MuPDF.js is the one the fix was made for - the same 4 + 31 places make wrappers', () => {
  assert.equal(JSON.parse(fs.readFileSync('node_modules/mupdf/package.json', 'utf8')).version, '1.28.1');
  const w = wrapperLines();
  assert.deepEqual(w.ctor, [1814, 1820, 1872, 2448]);
  assert.deepEqual(w.owned, OWNED);
  assert.deepEqual(w.borrowed, BORROWED);
});

/** a generated file: two pages, text in a font, an image, a square, a file attachment with its embedded file */
function generated() {
  const doc = new mupdf.PDFDocument();
  const font = new mupdf.Font('Times-Roman');
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 8, 8], false);
  pix.clear(128);
  const image = new mupdf.Image(pix);
  const f1 = doc.addSimpleFont(font);
  const im = doc.addImage(image);
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: f1 }, XObject: { Im1: im } }, 'BT /F1 12 Tf 72 720 Td (Sheet 1) Tj ET q 100 0 0 100 72 500 cm /Im1 Do Q'));
  doc.insertPage(-1, doc.addPage([0, 0, 842, 595], 0, {}, '0 0 1 RG 60 60 200 200 re S'));
  const p0 = doc.loadPage(0) as mupdf.PDFPage;
  const sq = p0.createAnnotation('Square'); sq.setRect([100, 100, 200, 160]); sq.update();
  const ef = doc.addEmbeddedFile('notes.txt', 'text/plain', new TextEncoder().encode('sheet notes'), new Date(2026, 0, 1), new Date(2026, 0, 2));
  const fa = p0.createAnnotation('FileAttachment'); fa.setRect([300, 300, 320, 320]); fa.setFileSpec(ef); fa.update();
  const other = new mupdf.PDFDocument();
  const oleaf = other.newString('from the other file');
  const odict = other.addObject({ Kind: other.newName('ZzOther'), N: 7, Arr: [1, 2, other.newString('x')] });
  const holder = doc.addObject({ ZzKey: { A: 1, B: [doc.newString('in the holder')] }, Arr: [1, 2, 3] });
  doc.getTrailer().get('Root').put('ZzHolder', holder);
  return { doc, font, image, p0, sq, fa, other, oleaf, odict, holder };
}
/** a dictionary key's own wrapper, as forEach makes it (2410): caught on its way through the helper */
function forEachKey(doc: mupdf.PDFDocument, dict: O, want: string): O {
  const d = doc as unknown as { _fromPDFObjectKeep(p: number): O };
  const was = Object.getPrototypeOf(d)._fromPDFObjectKeep as (p: number) => O;
  let got: O | null = null, n = 0;
  d._fromPDFObjectKeep = function (p: number) { const w = was.call(this, p); if (n++ % 2 === 0 && !got && w.isName() && w.asName() === want) got = w; return w; };
  try { dict.forEach(() => { /* (the keys go through the helper) */ }); } finally { delete (d as { _fromPDFObjectKeep?: unknown })._fromPDFObjectKeep; }
  assert.ok(got, 'forEach made a wrapper of the key');
  return got!;
}

test('each of the 31 places and getTrailer - one wrapper holds one reference (two without the fix), N hold N, all let go of: as before, intact', async () => {
  const G = generated();
  const { doc } = G;
  // [name, MuPDF.js line, make a wrapper, how the object is reached again]. "owned": the C call
  // made or kept it for us; "same": calling again gives the same object (a cache, or an object
  // that already was), so what one more wrapper adds can be counted; "fresh": a new object each
  // time - nothing else holds it, so its count with one wrapper is 0 + 1
  const owned: [string, number, () => O, 'fresh' | 'same'][] = [
    ['createObject', 1876, () => doc.createObject(), 'fresh'],
    ['newInteger', 1880, () => doc.newInteger(12345), 'fresh'],
    ['newReal', 1881, () => doc.newReal(1.5), 'fresh'],
    ['newName', 1882, () => doc.newName('ZzSheetKey'), 'fresh'],
    ['newString', 1883, () => doc.newString('Sheet A-101'), 'fresh'],
    ['newByteString', 1892, () => doc.newByteString(new Uint8Array([1, 2, 3])), 'fresh'],
    ['newIndirect', 1898, () => doc.newIndirect(1), 'fresh'],
    ['newArray', 1899, () => doc.newArray(), 'fresh'],
    ['newDictionary', 1900, () => doc.newDictionary(), 'fresh'],
    ['addObject', 1909, () => doc.addObject(doc.newDictionary()), 'fresh'],
    ['addObject of a reference', 1909, () => doc.addObject(G.holder), 'same'],
    ['addStream', 1912, () => doc.addStream('0 0 m 1 1 l S', {}), 'fresh'],
    ['addRawStream', 1915, () => doc.addRawStream('0 0 m 1 1 l S', {}), 'fresh'],
    ['graftObject of a dictionary', 1922, () => doc.graftObject(G.odict.resolve()), 'fresh'],
    ['graftObject of a reference', 1922, () => doc.graftObject(G.odict), 'fresh'],
    ['graftObject of a string', 1922, () => doc.graftObject(G.oleaf), 'same'],
    ['addSimpleFont', 1933, () => doc.addSimpleFont(G.font), 'same'],
    ['addCJKFont', 1939, () => doc.addCJKFont(G.font, 'zh-Hans'), 'same'],
    ['addFont', 1943, () => doc.addFont(G.font), 'same'],
    ['addImage', 1947, () => doc.addImage(G.image), 'same'],
    ['addPage', 1964, () => doc.addPage([0, 0, 100, 100], 0, {}, ''), 'fresh'],
    ['addEmbeddedFile', 1984, () => doc.addEmbeddedFile('a.txt', 'text/plain', new TextEncoder().encode('x'), new Date(2026, 0, 1), new Date(2026, 0, 1)), 'fresh'],
    ['PDFGraftMap.graftObject of a reference', 2457, () => doc.newGraftMap().graftObject(G.odict), 'fresh'],
    ['PDFGraftMap.graftObject of a string', 2457, () => doc.newGraftMap().graftObject(G.oleaf), 'same'],
  ];
  const holderDict = G.holder.resolve();
  const borrowed: [string, number, () => O][] = [
    ['findPage', 1955, () => doc.findPage(0)],
    ['PDFPage.getObject', 2210, () => G.p0.getObject()],
    ['resolve', 2330, () => G.holder.resolve()],
    ['get', 2353, () => G.holder.get('ZzKey')],
    ['getInheritable (a name object)', 2357, () => doc.findPage(0).getInheritable(doc.newName('MediaBox'))],
    ['getInheritable (a key)', 2358, () => doc.findPage(0).getInheritable('MediaBox')],
    ['forEach key', 2410, () => forEachKey(doc, holderDict, 'ZzKey')],
    ['forEach value', 2411, () => { let v: O | null = null; holderDict.forEach((x, k) => { if (k === 'ZzKey') v = x; }); return v!; }],
    ['PDFAnnotation.getObject', 2474, () => G.sq.getObject()],
    ['getFileSpec', 2824, () => G.fa.getFileSpec()],
  ];
  const trailer: [string, number, () => O] = ['getTrailer', 1872, () => doc.getTrailer()];
  // newBoolean (1879) gives MuPDF's own true: no memory, nothing to count
  assert.equal(refsOf(doc.newBoolean(true)), -1);
  // (every one of the 31 places is measured below; addObject and the two graftObjects more than one way)
  assert.deepEqual([...new Set([...owned.map((o) => o[1]), 1879])].sort(), [...OWNED].sort(), 'every owned place');
  assert.deepEqual(borrowed.map((o) => o[1]), BORROWED, 'every borrowed place');
  await bothWays((fix) => {
    const per = fix ? 1 : 2;
    for (const [name, line, make, how] of owned) {
      const a = make();
      if (how === 'fresh') { assert.equal(refsOf(a), per, `${name} (${line}): count with one wrapper, fix ${fix}`); continue; }
      const c1 = refsOf(a);
      const more = [...Array(4)].map(() => make());
      assert.ok(more.every((m) => ptr(m) === ptr(a)), `${name}: the same object again`);
      assert.equal(refsOf(a) - c1, 4 * per, `${name} (${line}): 4 wrappers more, fix ${fix}`);
      more.forEach((m) => m.destroy());
      assert.equal(refsOf(a), c1 + (fix ? 0 : 4), `${name}: let go of - as before (without the fix: one each left)`);
    }
    for (const [name, line, make] of [...borrowed, trailer]) {
      const k = name === 'getTrailer' ? 1 : per;
      const a = make();
      const c1 = refsOf(a);
      const more = [...Array(5)].map(() => make());
      assert.ok(more.every((m) => ptr(m) === ptr(a)), `${name}: the same object again`);
      assert.equal(refsOf(a) - c1, 5 * k, `${name} (${line}): 5 wrappers more, fix ${fix}`);
      more.forEach((m) => m.destroy());
      assert.equal(refsOf(a), c1 + (fix || name === 'getTrailer' ? 0 : 5), `${name}: let go of - as before`);
      a.destroy();
    }
  });
  // with the fix, every object let go of and collected: what the file holds is intact, read again
  // through its parent - and what each borrowed place gives is held by its parent once more than before
  const js = (o: O) => JSON.stringify(o.asJS({}));
  // (wrappers left to the collector so far are gone first: their references with them)
  await collect();
  const before = borrowed.map(([, , make]) => { const w = make(); const r = [refsOf(w), js(w)] as const; w.destroy(); return r; });
  // (fresh objects put in a parent first: the parent's reference is then the only one)
  const parent = doc.addObject({});
  const parentDict = parent.resolve();
  const putIn: string[] = [];
  for (const [, , make] of owned) { const w = make(); parentDict.put('K' + putIn.length, w); putIn.push(js(w)); w.destroy(); }
  parentDict.destroy();
  await collect();
  borrowed.forEach(([name, , make], i) => { const w = make(); assert.deepEqual([refsOf(w), js(w)], before[i], `${name}: intact, held as before`); w.destroy(); });
  const back = parent.resolve();
  putIn.forEach((j, i) => {
    const w = back.get('K' + i);
    assert.equal(js(w), j, `${owned[i][0]}: intact through its parent`);
    // (the parent, and this wrapper; more where something else holds it too - a cache, the file)
    assert.ok(refsOf(w) === -1 || refsOf(w) >= 2, `${owned[i][0]}: still held by its parent (${refsOf(w)})`);
    if (owned[i][3] === 'fresh' && !w.isIndirect()) assert.equal(refsOf(w), 2, `${owned[i][0]}: the parent and this wrapper only`);
    w.destroy();
  });
  // and the file saves and reads back the same
  const saved = doc.saveToBuffer('').asUint8Array().slice();
  const again = mupdf.Document.openDocument(saved, 'application/pdf').asPDF()!;
  assert.equal(again.countPages(), 2);
  assert.equal(JSON.stringify(again.newIndirect(parent.asIndirect()).resolve().asJS()), JSON.stringify(back.asJS()));
  again.destroy();
  back.destroy(); parent.destroy();
});

test('setters - a dictionary and an array filled every way, every wrapper let go of and collected: every child held, the file reads back the same', async () => {
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, {}, ''));
  const root = doc.getTrailer().get('Root');
  const dict = doc.addObject(doc.newDictionary());
  const arr = doc.addObject(doc.newArray());
  root.put('ZzDict', dict); root.put('ZzArr', arr);
  const d = dict.resolve(), a = arr.resolve();
  const target = doc.addObject({ Is: 'Target', N: 3 });
  // numbers, strings, names, wrapped direct objects, indirect references, JS values made into objects
  const values: (() => unknown)[] = [
    () => 42, () => 2.5, () => 'ZzName', () => '(a string)',
    () => doc.newInteger(7), () => doc.newString('wrapped'), () => doc.newName('ZzWrapped'),
    () => doc.newDictionary(), () => doc.newArray(), () => ({ A: 1, B: [doc.newString('deep')] }), () => [1, doc.newDictionary(), target],
    () => target, () => doc.addObject({ Fresh: true }), () => doc.newByteString(new Uint8Array([0, 255])),
  ];
  values.forEach((v, i) => {
    d.put('S' + i, v() as never);                        // dict, by a key
    d.put(doc.newName('N' + i), v() as never);           // dict, by a name object
    a.push(v() as never);                                // array, at the end
    a.push(null as never); a.put(a.length - 1, v() as never); // array, at an index
  });
  d.put('Gone', doc.newDictionary()); d.delete('Gone'); d.put('Gone2', 1); d.delete(doc.newName('Gone2'));
  a.push(5); a.delete(a.length - 1);
  const w1 = doc.addObject({}); w1.writeObject({ Written: doc.newString('over'), Ref: target }); d.put('W1', w1);
  const s1 = doc.addStream('0 0 m 10 10 l S', { ZzS: 1 }); s1.writeStream('1 1 m 20 20 l S'); d.put('S1', s1);
  const s2 = doc.addRawStream('2 2 m 3 3 l S', { ZzR: doc.newDictionary() }); s2.writeRawStream('4 4 m 5 5 l S'); d.put('S2', s2);
  const want = { d: JSON.stringify(d.asJS()), a: JSON.stringify(a.asJS()), w1: JSON.stringify(w1.resolve().asJS()), s1: s1.readStream().asString(), s2: s2.readRawStream().asString() };
  const nums = { dict: dict.asIndirect(), arr: arr.asIndirect(), w1: w1.asIndirect(), s1: s1.asIndirect(), s2: s2.asIndirect() };
  // every wrapper let go of, then the collector: what the containers hold must still be there
  for (const x of [d, a, root, target, w1, s1, s2]) x.destroy();
  await collect();
  const d2 = dict.resolve(), a2 = arr.resolve();
  const low: string[] = [];
  d2.forEach((v, k) => { const r = refsOf(v); if (r !== -1 && r < 2) low.push('dict ' + k + ': ' + r); });
  a2.forEach((v, i) => { const r = refsOf(v); if (r !== -1 && r < 2) low.push('array ' + i + ': ' + r); });
  assert.deepEqual(low, [], 'every child held by its container (and the wrapper reading it)');
  assert.equal(JSON.stringify(d2.asJS()), want.d);
  assert.equal(JSON.stringify(a2.asJS()), want.a);
  const saved = doc.saveToBuffer('').asUint8Array().slice();
  const r = mupdf.Document.openDocument(saved, 'application/pdf').asPDF()!;
  const R = (n: number) => r.newIndirect(n);
  assert.equal(JSON.stringify(R(nums.dict).resolve().asJS()).length, want.d.length, 'the dictionary read back');
  assert.equal(JSON.stringify(R(nums.arr).resolve().asJS()).length, want.a.length, 'the array read back');
  assert.equal(JSON.stringify(R(nums.w1).resolve().asJS()), want.w1);
  assert.equal(R(nums.s1).readStream().asString(), want.s1);
  assert.equal(R(nums.s2).readRawStream().asString(), want.s2);
  r.destroy();
  for (const x of [dict, arr, d2, a2]) x.destroy();
  doc.destroy();
});

test('wrappers that outlive their document - let go of after it, collected, then a new file opened, changed and saved', async () => {
  const src = generated();
  const doc = src.doc;
  const saved0 = doc.saveToBuffer('').asUint8Array().slice();
  // wrappers of every kind, made every way; the page and markup objects let go of (they hold the document)
  const keep: O[] = [
    doc.getTrailer(), doc.getTrailer().get('Root'), doc.findPage(0), doc.findPage(0).resolve(), src.p0.getObject(), src.sq.getObject(), src.fa.getFileSpec(),
    doc.newDictionary(), doc.newArray(), doc.newString('s'), doc.newName('ZzKept'), doc.newInteger(9), doc.newReal(0.5), doc.newByteString(new Uint8Array([7])),
    doc.newIndirect(2), doc.createObject(), doc.addObject({ K: [1, doc.newDictionary()] }), doc.addStream('x', {}), doc.graftObject(src.odict), doc.newGraftMap().graftObject(src.odict.resolve()),
    doc.addSimpleFont(src.font), doc.addImage(src.image), src.holder, src.holder.resolve(), src.holder.get('ZzKey', 'B'),
  ];
  const filled = doc.newDictionary(); filled.put('Kids', keep.slice(7, 14)); keep.push(filled);
  src.sq.destroy(); src.fa.destroy(); src.p0.destroy();
  doc.destroy();
  for (const w of keep) w.destroy();
  await collect();
  src.other.destroy(); src.oleaf.destroy(); src.odict.destroy();
  await collect();
  // a new file: opened, changed, saved, opened again
  const d = mupdf.Document.openDocument(saved0, 'application/pdf').asPDF()!;
  const pg = d.loadPage(1) as mupdf.PDFPage;
  const t = pg.createAnnotation('Text'); t.setRect([50, 50, 70, 70]); t.setContents('after the other file'); t.update();
  const out = d.saveToBuffer('').asUint8Array().slice();
  d.destroy();
  const r = mupdf.Document.openDocument(out, 'application/pdf').asPDF()!;
  assert.equal(r.countPages(), 2);
  assert.equal((r.loadPage(1) as mupdf.PDFPage).getAnnotations()[0].getContents(), 'after the other file');
  r.destroy();
});

/** a file's objects, each as text (streams: their bytes too) */
function objectsOf(b: Uint8Array): string[] {
  const d = mupdf.Document.openDocument(b, 'application/pdf').asPDF()!;
  const out: string[] = [];
  try {
    for (let i = 1; i < d.countObjects(); i++) {
      const r = d.newIndirect(i);
      const o = r.resolve();
      let s = o.toString();
      if (r.isStream()) s += ' stream:' + Buffer.from(r.readRawStream().asUint8Array()).toString('base64');
      out.push(s);
      r.destroy();
    }
  } finally { d.destroy(); }
  return out;
}

/** a page of n separate little strokes per page (the kind monster sheets are made of), `pages` pages */
function strokesPdf(n: number, pages = 1): Uint8Array {
  const objs: Buffer[] = [];
  const offs: number[] = [];
  let pos = 0;
  const put = (b: Buffer) => { objs.push(b); pos += b.length; };
  const obj = (k: number, body: string, stream?: Buffer) => { offs[k] = pos; put(Buffer.from(`${k} 0 obj\n${body}\n`)); if (stream) { put(Buffer.from('stream\n')); put(stream); put(Buffer.from('\nendstream\n')); } put(Buffer.from('endobj\n')); };
  put(Buffer.from('%PDF-1.4\n'));
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${[...Array(pages).keys()].map((p) => `${3 + 2 * p} 0 R`).join(' ')}] /Count ${pages} >>`);
  for (let p = 0; p < pages; p++) {
    const parts = ['0 G 0.5 w\n'];
    let x = 50, y = 50;
    for (let i = 0; i < n; i++) {
      if (i % 300 === 0) { x = 50 + ((i * 7 + p * 11) % 700); y = 50 + ((i * 13) % 500); }
      const nx = x + ((i * 31) % 5) - 2, ny = y + ((i * 17) % 5) - 2;
      parts.push(`${x.toFixed(2)} ${y.toFixed(2)} m ${nx.toFixed(2)} ${ny.toFixed(2)} l S\n`);
      x = nx; y = ny;
    }
    const content = deflateSync(Buffer.from(parts.join('')));
    obj(3 + 2 * p, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Contents ${4 + 2 * p} 0 R >>`);
    obj(4 + 2 * p, `<< /Length ${content.length} /Filter /FlateDecode >>`, content);
  }
  const size = 3 + 2 * pages;
  const xref = pos;
  let x2 = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let k = 1; k < size; k++) x2 += String(offs[k]).padStart(10, '0') + ' 00000 n \n';
  put(Buffer.from(x2 + `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(objs));
}

test('the monster-sheet job gives the same changes, object by object, with the fix on and off', async () => {
  const f = path.join(scratch, 'traced.pdf');
  fs.writeFileSync(f, strokesPdf(60_000, 3));
  const [on, off] = await bothWays(async (fix) => {
    const r = simplify({ path: f }, path.join(scratch, 'out-' + fix), 'force', [0, 2]);
    assert.deepEqual(r.pages, [0, 2]);
    assert.ok(r.delta, 'written as changes after the original');
    // the drawing + its changes, read as one file
    const v = new VFile({ path: f, size: r.base, delta: r.delta });
    const all = new Uint8Array(v.size);
    v.read(all, 0, v.size, 0);
    v.close();
    await collect();
    return { objects: objectsOf(all), strokes: [r.strokesIn, r.strokesOut] };
  });
  assert.deepEqual(on.strokes, off.strokes);
  assert.equal(on.objects.length, off.objects.length, 'as many objects');
  const diff = on.objects.map((x, i) => (x === off.objects[i] ? -1 : i + 1)).filter((i) => i > 0);
  assert.deepEqual(diff, [], 'every object the same');
  console.log(`   ${on.objects.length} objects, ${on.strokes[0]} strokes -> ${on.strokes[1]}, the same either way`);
});

test('the monster-sheet job as a process of its own: the fix is in (GT_OFF=mupdfrefs leaves it out, and says so)', () => {
  const f = path.join(scratch, 'small.pdf');
  fs.writeFileSync(f, strokesPdf(55_000, 1));
  const probe = path.join(scratch, 'probe.mts');
  fs.writeFileSync(probe, [
    `import { simplify } from ${JSON.stringify(pathToFileURL(path.resolve('src/engine/pdfhost/heavy.ts')).href)};`,
    `import { refsFixed, refsNote } from ${JSON.stringify(pathToFileURL(path.resolve('src/engine/pdfhost/mupdf-refs.ts')).href)};`,
    `const r = simplify({ path: ${JSON.stringify(f)} }, ${JSON.stringify(path.join(scratch, 'p'))}, 'force', [0]);`,
    `console.log(JSON.stringify({ fixed: refsFixed(), note: refsNote(), pages: r.pages }));`,
  ].join('\n'));
  const run = (env: Record<string, string>) => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', probe], { cwd: process.cwd(), env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(out.trim().split('\n').pop()!);
  };
  assert.deepEqual(run({ GT_OFF: '' }), { fixed: true, note: '', pages: [0] });
  const off = run({ GT_OFF: 'mupdfrefs' });
  assert.equal(off.fixed, false);
  assert.match(off.note, /GT_OFF=mupdfrefs/);
  assert.deepEqual(off.pages, [0], 'and the job does its work either way');
});

test('not 1.28.1\'s text (a doctored helper) - nothing patched, refsFixed() false, and the note says why', async () => {
  // a fresh copy of the module would be another MuPDF.js; here the text check is run on a doctored
  // stand-in with this module's own classes
  const P = mupdf.PDFObject;
  class Doc { _fromPDFObjectNew(p: number) { return p === 0 ? P.Null : new (P as never as new (d: unknown, q: number) => O)(this, p); } _fromPDFObjectKeep(p: number) { return this._fromPDFObjectNew(p); } }
  const stand = { PDFObject: P, PDFDocument: Doc } as unknown as typeof mupdf;
  // (fixMupdfRefs answers once per process: its check is reached through a fresh copy of the file)
  const copy = path.join(scratch, 'mupdf-refs-copy.ts');
  fs.copyFileSync('src/engine/pdfhost/mupdf-refs.ts', copy);
  const fresh = await import(pathToFileURL(copy).href) as typeof import('../src/engine/pdfhost/mupdf-refs');
  const r = fresh.fixMupdfRefs(stand);
  assert.equal(r.fixed, false);
  assert.match(r.note, /differently from 1\.28\.1/);
  assert.equal(fresh.refsFixed(), false);
  assert.equal(fresh.setRefsFixForTests(true), false, 'and the setter cannot switch it on');
  assert.equal(Doc.prototype._fromPDFObjectNew.toString().includes('_drop'), false, 'its helpers left as they were');
  // the real one: in, and the setter switches it off and on
  assert.equal(fixMupdfRefs(mupdf).fixed, true);
  assert.equal(setRefsFixForTests(false), false);
  const d = new mupdf.PDFDocument();
  assert.equal(refsOf(d.newDictionary()), 2, 'off: as MuPDF.js came');
  assert.equal(setRefsFixForTests(true), true);
  assert.equal(refsOf(d.newDictionary()), 1);
  d.destroy();
});
