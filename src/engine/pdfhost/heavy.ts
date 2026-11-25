/// <reference types="node" />
// Monster sheets: line work made of millions of separate little strokes (traced scans, some CAD
// exports). PDFium keeps one object per stroke - 12-15 million of them run a drawing engine out of
// memory, every time (the PDF Editor's F104 landscape sheet: 46 MB, 15.1 million strokes). Their
// strokes are merged into fewer, longer ones (strokes.ts - drawn the same), as the PDF Editor and
// Rev Radar do it.
//
// A one-off background process (MuPDF reads and writes the file):
//   dist/engine/heavy.mjs <file source json> <out path without extension> check|force [pages json]
//  check: files >= 30 MB, pages whose content is > 30 MB compressed and >= 4 million strokes
//  force: the pages listed (one that took the drawing engines down, and those simplified before)
//         with a lower bar: 50 thousand strokes
// The result is written as the changes after the original ("<out>.delta": an incremental update -
// the engine reads the drawing + those changes as one file), or as a whole new file ("<out>.pdf")
// when the drawing can't take an incremental update (a repaired file). The drawing itself is never
// written to.
import fs from 'node:fs';
import zlib from 'node:zlib';
import * as mupdf from 'mupdf';
import { VFile, type FileSrc } from './files';
import { fixMupdfRefs } from './mupdf-refs';
import { mergeStrokes, MIN_STROKES } from './strokes';
import { sha256Hex } from '../legacy';

/** the mark of a content stream this app merged (a key in its dictionary) */
const MERGED = 'GTMerged';
/** (the mark an earlier version of the app wrote - read by its SHA-256, never written) */
const LEGACY_MERGED = '129d8f175c698113b4cd1ddf2900c727b87544c4d20f5ccc741b3f994142527c';
/** is this content stream one the app (this or an earlier version) merged? */
function isMerged(s: mupdf.PDFObject): boolean {
  if (!s.get(MERGED).isNull()) return true;
  let old = false;
  try { s.forEach((_v, k) => { if (typeof k === 'string' && sha256Hex(k) === LEGACY_MERGED) old = true; }); } catch { /* not a dictionary */ }
  return old;
}

const parentPort = (process as unknown as { parentPort?: { postMessage(m: unknown): void } }).parentPort;

// MuPDF.js 1.28.1 holds every PDF object it wraps twice and lets go of it once (mupdf-refs.ts): put
// right before MuPDF is used (GT_OFF=mupdfrefs leaves it as it came - said in the log)
{
  const r = fixMupdfRefs(mupdf);
  if (!r.fixed) console.error('MuPDF references left as they are: ' + r.note);
}

/** compressed bytes of content worth a look (and the file size below which none can hold such a page) */
const HEAVY_RAW = Number(process.env.GT_HEAVY_RAW) || 30e6;
const FORCE_MIN = 50_000;

export interface HeavyResult {
  /** pages whose line work was merged (0-based) */
  pages: number[];
  strokesIn?: number;
  strokesOut?: number;
  /** the changes after the original's `base` bytes */
  delta?: string;
  base?: number;
  /** or a whole new file */
  full?: string;
  ms: number;
}

/** about how many stroke operators ("S" between white space) - native searches, no parsing */
function roughStrokes(b: Buffer): number {
  let n = 0;
  for (const pat of ['S\n', 'S ', 'S\r']) {
    const p = Buffer.from(pat);
    for (let i = b.indexOf(p); i >= 0 && n < MIN_STROKES; i = b.indexOf(p, i + 2)) { const c = b[i - 1]; if (c === 32 || c === 10 || c === 13) n++; }
  }
  return n;
}

/** no transparency / blend modes / soft masks (merged strokes would overlap differently) */
function opaqueStates(po: mupdf.PDFObject): boolean {
  // (a page without resources: nothing to look at - MuPDF's null object can't be asked further)
  const res = po.getInheritable('Resources');
  if (!res.isDictionary()) return true;
  const gs = res.get('ExtGState');
  if (!gs.isDictionary()) return true;
  let ok = true;
  gs.forEach((v: mupdf.PDFObject) => {
    const g = v.resolve();
    if (!g.isDictionary()) return;
    for (const k of ['CA', 'ca']) { const a = g.get(k); if (a.isNumber() && a.asNumber() < 1) ok = false; }
    const bm = g.get('BM'); if (!bm.isNull() && !(bm.isName() && bm.asName() === 'Normal')) ok = false;
    const sm = g.get('SMask'); if (!sm.isNull() && !(sm.isName() && sm.asName() === 'None')) ok = false;
  });
  return ok;
}

let strokesIn = 0, strokesOut = 0;

/** Flate-compressed bytes undone - as forgiving as the PDF readers are: a stream cut short, or with a
 *  wrong checksum at its end, is drawn by them as far as it goes (Node's own check refused it) */
function inflate(b: Uint8Array): Buffer {
  try { return zlib.inflateSync(b); } catch { /* forgiving next */ }
  try { return zlib.inflateSync(b, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { /* without its header and checksum */ }
  return zlib.inflateRawSync(b.subarray(2), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
}

/** what a merge changed: the pages whose /Contents now points elsewhere, and the new streams */
interface Changed { pages: Map<number, number>; streams: Map<number, Uint8Array> }

/** merge one page's strokes; true if its content was replaced */
function mergePage(doc: mupdf.PDFDocument, i: number, force: boolean, done: Map<string, mupdf.PDFObject>, ch?: Changed): boolean {
  try {
    const po = doc.findPage(i);
    const c = po.get('Contents');
    const list = c.isArray() ? [...Array(c.length).keys()].map((k) => c.get(k)) : [c];
    let total = 0;
    for (const s of list) { const l = s.get('Length'); if (l.isNumber()) total += l.asNumber(); }
    if (!force && total <= HEAVY_RAW) return false;
    // pages sharing their content (one stream for several pages): merged once
    const key = list.map((s) => (s.isIndirect() ? s.asIndirect() : -1)).join(',');
    if (done.has(key)) { po.put('Contents', done.get(key)!); notePage(po, ch); return true; }
    if (list.some((s) => !s.isStream() || isMerged(s))) return false;
    if (!opaqueStates(po)) return false;
    // every part Flate-compressed (as such files are); the parts are one content together - a path
    // can begin in one and be stroked in the next, so they are merged as one
    const flate = (s: mupdf.PDFObject) => { const f = s.get('Filter'); const nm = f.isName() ? f.asName() : f.isArray() && f.length === 1 && f.get(0).isName() ? f.get(0).asName() : ''; return nm === 'FlateDecode' && s.get('DecodeParms').isNull(); };
    // (or not compressed at all: a stamp added later wraps the drawing in small q / Q streams of its own)
    const plain = (s: mupdf.PDFObject) => s.get('Filter').isNull() || (s.get('Filter').isArray() && s.get('Filter').length === 0);
    if (!list.every((s) => flate(s) || plain(s))) return false;
    const raws = list.map((s) => s.readRawStream());
    let out: Uint8Array | null = null;
    try {
      const decs = raws.map((r, k) => (plain(list[k]) ? Buffer.from(r.asUint8Array()) : inflate(r.asUint8Array())));
      const dec = decs.length === 1 ? decs[0] : Buffer.concat(decs.flatMap((b, k) => (k ? [Buffer.from('\n'), b] : [b])));
      // (a quick count first: a big but ordinary sheet is not read through stroke by stroke)
      if (!force && (dec.length < MIN_STROKES * 10 || roughStrokes(dec) < MIN_STROKES * 0.8)) return false;
      const r = mergeStrokes(new Uint8Array(dec.buffer, dec.byteOffset, dec.byteLength), force ? FORCE_MIN : MIN_STROKES);
      if (!r) return false;
      strokesIn += r.strokesIn;
      strokesOut += r.strokesOut;
      const z = zlib.deflateSync(r.out, { level: 6 });
      out = new Uint8Array(z.buffer, z.byteOffset, z.byteLength);
    } finally { for (const r of raws) r.destroy?.(); }
    const d = doc.newDictionary();
    d.put('Filter', doc.newName('FlateDecode'));
    d.put(MERGED, true);
    const ref = doc.addRawStream(out, d);
    po.put('Contents', ref);
    done.set(key, ref);
    notePage(po, ch);
    if (ch && ref.isIndirect()) ch.streams.set(ref.asIndirect(), out);
    return true;
  } catch { return false; /* left as it is */ }
}

/** an object's generation, as a reference to it says it ("12 1 R") */
const genOf = (ref: mupdf.PDFObject) => { const m = /^\d+ (\d+) R$/.exec(ref.toString()); return m ? Number(m[1]) : 0; };
/** (the page's number and generation from the reference the page tree holds: MuPDF's newIndirect(num) always says 0) */
const notePage = (po: mupdf.PDFObject, ch?: Changed) => { if (ch) ch.pages.set(po.isIndirect() ? po.asIndirect() : -1, po.isIndirect() ? genOf(po) : 0); };

/** where the file's last cross-reference section starts (its "startxref"), -1 if not found - read as
 *  MuPDF reads it: the last "startxref", white space or none, then the number (v0.12.6 review: with no
 *  space, "startxref12015", the one before was taken - an older revision of the file) */
function lastXref(vf: VFile): number {
  const n = Math.min(4096, vf.size);
  const tail = new Uint8Array(n);
  if (vf.read(tail, 0, n, vf.size - n) !== n) return -1;
  const t = new TextDecoder('latin1').decode(tail);
  const at = t.lastIndexOf('startxref');
  if (at < 0) return -1;
  const m = /^[ \t\r\n\f\0]*(\d+)/.exec(t.slice(at + 9));
  return m ? parseInt(m[1], 10) : -1;
}

/** where "%PDF-" is: readers count every offset from there (a file with bytes before it - an e-mail
 *  gateway's, a scanner's - has all its offsets shifted so; -1 if not in the first 1 KB) */
function headerAt(vf: VFile): number {
  const n = Math.min(1024, vf.size);
  const head = new Uint8Array(n);
  if (vf.read(head, 0, n, 0) !== n) return -1;
  return new TextDecoder('latin1').decode(head).indexOf('%PDF-');
}
/** the trailer's /Info as it is: a reference, or a dictionary written out (v0.12.6 review: a direct
 *  one was dropped) */
function infoOf(tr: mupdf.PDFObject): string {
  const v = tr.get('Info');
  if (v.isIndirect()) return `/Info ${v.asIndirect()} ${genOf(v)} R`;
  return v.isDictionary() ? '/Info ' + v.toString(true, true) : '';
}

/**
 * The incremental update written here, not by MuPDF: MuPDF's own builds "the whole original +
 * the changes" in its memory first - past ~600 MB it fails ("realloc failed": a 758 MB set with one
 * monster sheet could never be simplified, v0.12.5 review against the PDF Editor 0.8.2). Only what
 * changed is written: the pages that point at their new content, the new content streams, a
 * cross-reference section for them and a trailer whose /Prev is the original's. Not for encrypted
 * files (the new streams would have to be encrypted) - MuPDF's then.
 */
function writeUpdate(doc: mupdf.PDFDocument, vf: VFile, ch: Changed, target: string): boolean {
  const prev = lastXref(vf);
  const hdr = headerAt(vf);
  if (prev < 0 || hdr < 0 || ch.pages.has(-1) || !ch.pages.size) return false;
  const tr = doc.getTrailer();
  if (!tr.get('Encrypt').isNull()) return false;
  const parts: (string | Uint8Array)[] = [];
  let pos = vf.size;
  const w = (b: string | Uint8Array) => { parts.push(b); pos += b.length; };
  const at = new Map<number, { off: number; gen: number }>();
  w('\n');
  for (const [num, gen] of [...ch.pages].sort((a, b) => a[0] - b[0])) {
    at.set(num, { off: pos, gen });
    w(`${num} ${gen} obj\n${doc.newIndirect(num).resolve().toString(true, true)}\nendobj\n`);
  }
  for (const [num, bytes] of [...ch.streams].sort((a, b) => a[0] - b[0])) {
    at.set(num, { off: pos, gen: 0 });
    w(`${num} 0 obj\n<</Filter/FlateDecode/${MERGED} true/Length ${bytes.length}>>\nstream\n`);
    w(bytes);
    w('\nendstream\nendobj\n');
  }
  const xref = pos;
  let x = 'xref\n';
  // (offsets from "%PDF-", as the original's own: bytes before it shift them all)
  for (const [num, e] of [...at].sort((a, b) => a[0] - b[0])) x += `${num} 1\n${String(e.off - hdr).padStart(10, '0')} ${String(e.gen).padStart(5, '0')} n\r\n`;
  const root = tr.get('Root');
  if (!root.isIndirect()) return false;
  const id = tr.get('ID');
  x += `trailer\n<</Size ${doc.countObjects()}/Root ${root.asIndirect()} ${genOf(root)} R${infoOf(tr)}${id.isArray() ? '/ID ' + id.toString(true, true) : ''}/Prev ${prev}>>\nstartxref\n${xref - hdr}\n%%EOF\n`;
  w(x);
  writePieces(target, (put) => { for (const b of parts) put(b); });
  return true;
}

/**
 * The drawing + changes read as one file, checked: each changed page's content is the merged one,
 * each new stream reads back whole, the same pages and objects as the document they came from - and
 * no repair needed, asked after all that was read (MuPDF repairs lazily, when an object's offset turns
 * out wrong: asked right after opening, a broken update passed - v0.12.6 review).
 */
function updateReads(src: FileSrc, base: number, delta: string, ch: Changed, want: { pages: number; objects: number }): boolean {
  const v2 = new VFile({ path: src.path, size: base, delta });
  let d: mupdf.PDFDocument | null = null;
  try {
    const stm = new mupdf.Stream({ fileSize: () => v2.size, read: (m: Uint8Array, o: number, l: number, p: number) => v2.read(m, o, l, p), close() { /* closed below */ } } as never);
    d = mupdf.Document.openDocument(stm, 'application/pdf').asPDF();
    if (!d) return false;
    for (const num of ch.pages.keys()) {
      const c = d.newIndirect(num).resolve().get('Contents');
      if (!c.isIndirect() || c.get(MERGED).isNull()) return false;
    }
    // (an encrypted file's streams are longer once encrypted - AES: its own start and padding)
    const encrypted = !d.getTrailer().get('Encrypt').isNull();
    for (const [num, bytes] of ch.streams) {
      const ref = d.newIndirect(num);
      if (!ref.isStream()) return false;
      const raw = encrypted ? ref.readStream() : ref.readRawStream();
      try { if (encrypted ? raw.asUint8Array().length !== zlib.inflateSync(bytes).length : raw.asUint8Array().length !== bytes.length) return false; } finally { raw.destroy?.(); }
    }
    // (MuPDF's own update of a file with a cross-reference stream adds one: that stream)
    if (d.countPages() !== want.pages || d.countObjects() < want.objects) return false;
    return !d.wasRepaired();
  } catch { return false; } finally { try { d?.destroy?.(); } catch { /* */ } v2.close(); }
}

/** a whole new file read back: opens without repair, the same number of pages, each simplified one merged */
function fileReads(file: string, pages: number[], count: number): boolean {
  const v = new VFile({ path: file });
  let d: mupdf.PDFDocument | null = null;
  try {
    const stm = new mupdf.Stream({ fileSize: () => v.size, read: (m: Uint8Array, o: number, l: number, p: number) => v.read(m, o, l, p), close() { /* closed below */ } } as never);
    d = mupdf.Document.openDocument(stm, 'application/pdf').asPDF();
    if (!d || d.countPages() !== count) return false;
    for (const i of pages) if (d.findPage(i).get('Contents').get(MERGED).isNull()) return false;
    return !d.wasRepaired();
  } catch { return false; } finally { try { d?.destroy?.(); } catch { /* */ } v.close(); }
}

/** past this a whole new file is written object by object (MuPDF's save fails at about 1 GB) */
const streamSave = () => Number(process.env.GT_STREAM_SAVE) || 350e6;

/** a file written in pieces, never whole in memory */
function writePieces(target: string, fill: (put: (b: string | Uint8Array) => void) => void) {
  const fd = fs.openSync(target, 'w');
  try {
    fill((b) => { const v = typeof b === 'string' ? Buffer.from(b, 'latin1') : b; for (let o = 0; o < v.length;) o += fs.writeSync(fd, v, o, Math.min(16 << 20, v.length - o)); });
  } catch (e) { try { fs.closeSync(fd); } catch { /* */ } try { fs.rmSync(target, { force: true }); } catch { /* */ } throw e; }
  fs.closeSync(fd);
}

/**
 * A PDF written object by object (the PDF Editor 0.8.2's writeObjects): only what the file uses (from
 * the trailer's Root and Info), each stream's bytes copied as they are. Not for encrypted files.
 */
function writeObjects(doc: mupdf.PDFDocument, put: (b: string | Uint8Array) => void) {
  const n = doc.countObjects();
  const tr = doc.getTrailer();
  const keep = new Set<number>();
  const queue: number[] = [];
  const gen = new Map<number, number>();
  const walk = (v: mupdf.PDFObject, depth: number) => {
    if (depth > 64) return;
    if (v.isIndirect()) { const k = v.asIndirect(); if (k > 0 && k < n && !keep.has(k)) { keep.add(k); queue.push(k); gen.set(k, genOf(v)); } return; }
    if (v.isArray()) { for (let i = 0; i < v.length; i++) walk(v.get(i), depth + 1); return; }
    if (v.isDictionary()) v.forEach((x: mupdf.PDFObject) => walk(x, depth + 1));
  };
  for (const k of ['Root', 'Info']) walk(tr.get(k), 0);
  while (queue.length) walk(doc.newIndirect(queue.pop()!).resolve(), 0);
  let pos = 0;
  const w = (b: string | Uint8Array) => { put(b); pos += b.length; };
  w('%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n');
  const offs: number[] = [0];
  const gens: number[] = [65535];
  // (the stream's dictionary as MuPDF prints it, with its real length: rebuilt key by key, names
  // with bytes that aren't UTF-8 came out changed - v0.12.6 review; this document is thrown away after)
  const dictWith = (obj: mupdf.PDFObject, len: number) => {
    const l = obj.get('Length');
    if (!(l.isNumber() && !l.isIndirect() && l.asNumber() === len)) obj.put('Length', len);
    return obj.toString(true, true);
  };
  for (let num = 1; num < n; num++) {
    offs[num] = pos;
    const ref = doc.newIndirect(num);
    if (!keep.has(num)) { gens[num] = 0; w(`${num} 0 obj\nnull\nendobj\n`); continue; }
    const g = (gens[num] = gen.get(num) ?? 0);
    const obj = ref.resolve();
    if (ref.isStream()) {
      const raw = ref.readRawStream();
      try {
        const v = raw.asUint8Array();
        w(`${num} ${g} obj\n${dictWith(obj, v.length)}\nstream\n`);
        w(v);
        w('\nendstream\nendobj\n');
      } finally { raw.destroy?.(); }
    } else w(`${num} ${g} obj\n${obj.isNull() ? 'null' : obj.toString(true, true)}\nendobj\n`);
  }
  const xref = pos;
  let x = `xref\n0 ${n}\n0000000000 65535 f\r\n`;
  for (let num = 1; num < n; num++) x += String(offs[num]).padStart(10, '0') + ' ' + String(gens[num]).padStart(5, '0') + ' n\r\n';
  const root = tr.get('Root');
  const id = tr.get('ID');
  x += `trailer\n<</Size ${n}${root.isIndirect() ? `/Root ${root.asIndirect()} ${genOf(root)} R` : ''}${infoOf(tr)}${id.isArray() ? '/ID ' + id.toString(true, true) : ''}>>\nstartxref\n${xref}\n%%EOF\n`;
  w(x);
}

/** the incremental save really starts with the file as it is (both ends checked - PDF Editor 0.8.2) */
function sameStart(vf: VFile, v: Uint8Array, base: number): boolean {
  const n = Math.min(65536, base);
  const a = new Uint8Array(n);
  for (const at of [0, base - n]) {
    if (vf.read(a, 0, n, at) !== n) return false;
    for (let i = 0; i < n; i++) if (a[i] !== v[at + i]) return false;
  }
  return true;
}

/** write bytes in pieces (a big buffer straight out of MuPDF's memory) */
function writeView(p: string, v: Uint8Array, from = 0) {
  const fd = fs.openSync(p, 'w');
  try {
    const CH = 16 << 20;
    for (let o = from; o < v.length; o += CH) {
      const end = Math.min(v.length, o + CH);
      let w = o;
      while (w < end) w += fs.writeSync(fd, v, w, end - w);
    }
  } catch (e) {
    // (cut short - the disk full: nothing half-written is left behind)
    try { fs.closeSync(fd); } catch { /* */ }
    try { fs.rmSync(p, { force: true }); } catch { /* */ }
    throw e;
  }
  fs.closeSync(fd);
}

export function simplify(src: FileSrc, outBase: string, mode: 'check' | 'force', want: number[] = []): HeavyResult {
  const t0 = Date.now();
  strokesIn = 0;
  strokesOut = 0; // (per call: the tests run several in one process)
  const vf = new VFile(src);
  try {
    if (mode === 'check' && vf.size < HEAVY_RAW) return { pages: [], ms: Date.now() - t0 };
    const stm = new mupdf.Stream({ fileSize: () => vf.size, read: (m: Uint8Array, o: number, l: number, p: number) => vf.read(m, o, l, p), close() { /* closed below */ } } as never);
    const d = mupdf.Document.openDocument(stm, 'application/pdf');
    const doc = d.asPDF();
    if (!doc) throw new Error('not a PDF');
    if (doc.needsPassword()) return { pages: [], ms: Date.now() - t0 };
    const forced = new Set(want);
    const mergeAll = () => {
      strokesIn = 0;
      strokesOut = 0;
      const done = new Map<string, mupdf.PDFObject>();
      const ch: Changed = { pages: new Map(), streams: new Map() };
      const pages: number[] = [];
      const n = doc.countPages();
      for (let i = 0; i < n; i++) {
        if (mode === 'force' && !forced.has(i)) continue;
        if (mergePage(doc, i, mode === 'force', done, ch)) pages.push(i);
      }
      // other pages showing the same content get the merged one too
      if (pages.length && mode === 'force') {
        for (let i = 0; i < n; i++) {
          if (forced.has(i)) continue;
          try {
            const po = doc.findPage(i);
            const c = po.get('Contents');
            const key = (c.isArray() ? [...Array(c.length).keys()].map((k) => c.get(k)) : [c]).map((x) => (x.isIndirect() ? x.asIndirect() : -1)).join(',');
            const r = done.get(key);
            if (r) { po.put('Contents', r); notePage(po, ch); pages.push(i); }
          } catch { /* left as it is */ }
        }
      }
      return { ch, pages };
    };
    const repairedAtOpen = doc.wasRepaired();
    let { ch, pages } = mergeAll();
    // a wrong offset found while merging (another page's content): MuPDF repairs then - and the
    // repair throws away what was changed so far (v0.12.6 review: the result said "simplified" and
    // held the original monster). Merged again, on the repaired document - a whole new file after.
    if (!repairedAtOpen && doc.wasRepaired()) ({ ch, pages } = mergeAll());
    // (only pages that really point at merged content now)
    pages = pages.filter((i) => { try { return !doc.findPage(i).get('Contents').get(MERGED).isNull(); } catch { return false; } });
    if (!pages.length) return { pages: [], ms: Date.now() - t0 };
    // the changes after the original (the engine reads drawing + changes); a repaired file can't
    // take an incremental update: a whole new file then
    // (a name of its own each time: an engine may still have the one before open - on Windows it
    // couldn't be replaced; the record says which is current, the old one is trimmed)
    const stamp = '-' + Date.now().toString(36);
    const counts = { pages: doc.countPages(), objects: doc.countObjects() };
    if (!doc.wasRepaired()) {
      const delta = outBase + stamp + '.delta';
      const part = delta + '.part';
      // ours first: only the changes, never the whole drawing in memory
      try {
        if (writeUpdate(doc, vf, ch, part)) {
          if (updateReads(src, vf.size, part, ch, counts)) {
            fs.renameSync(part, delta);
            return { pages, strokesIn, strokesOut, delta, base: vf.size, ms: Date.now() - t0 };
          }
        }
      } catch { /* MuPDF's then */ }
      try { fs.rmSync(part, { force: true }); } catch { /* */ }
      // MuPDF's (an encrypted file: the new streams must be encrypted) - only if it really is the
      // original + changes (both ends) and reads back as checked above
      let buf: mupdf.Buffer | null = null;
      try {
        buf = doc.saveToBuffer('incremental');
        const v = buf.asUint8Array();
        if (v.length > vf.size && sameStart(vf, v, vf.size)) {
          writeView(part, v, vf.size);
          if (updateReads(src, vf.size, part, ch, counts)) {
            fs.renameSync(part, delta);
            return { pages, strokesIn, strokesOut, delta, base: vf.size, ms: Date.now() - t0 };
          }
        }
      } catch { /* a whole file instead */ } finally { buf?.destroy?.(); }
      try { fs.rmSync(part, { force: true }); } catch { /* */ }
    }
    const full = outBase + stamp + '.pdf';
    try {
      if (vf.size > streamSave() && doc.getTrailer().get('Encrypt').isNull()) {
        // a big repaired file: written object by object (MuPDF's own save holds it whole and fails)
        writePieces(full + '.part', (put) => writeObjects(doc, put));
      } else {
        const buf = doc.saveToBuffer('compress');
        try { writeView(full + '.part', buf.asUint8Array()); } finally { buf.destroy?.(); }
      }
      // read back as the engines will read it: the same pages, the simplified ones merged, no repair
      if (!fileReads(full + '.part', pages, counts.pages)) throw new Error('the simplified file did not read back right');
      fs.renameSync(full + '.part', full);
    } catch (e) { try { fs.rmSync(full + '.part', { force: true }); } catch { /* */ } throw e; }
    return { pages, strokesIn, strokesOut, full, ms: Date.now() - t0 };
  } finally { vf.close(); }
}

// as a background process: one job, then gone (MuPDF's memory goes with it)
if (parentPort && process.argv[2]) {
  let result: HeavyResult | null = null;
  let error = '';
  try {
    result = simplify(JSON.parse(process.argv[2]) as FileSrc, process.argv[3], process.argv[4] === 'force' ? 'force' : 'check', JSON.parse(process.argv[5] || '[]'));
  } catch (e: any) {
    error = String(e?.message ?? e);
    // (MuPDF's "realloc (551620174 bytes) failed": said in words - what is left is an encrypted file
    // too big to hold whole, which only MuPDF can write)
    if (/realloc|malloc|out of memory|Cannot enlarge memory/i.test(error)) error = 'not enough memory on this PC to simplify a drawing this big (one locked with an owner password has to be held whole)';
  }
  parentPort.postMessage({ type: 'done', result, error });
  setTimeout(() => process.exit(0), 50);
}

/** (for the tests) */
export const __test = { updateReads, lastXref, headerAt };
