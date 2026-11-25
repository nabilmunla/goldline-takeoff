// PDFium (the engine inside Chrome, compiled to WebAssembly): opening, rendering,
// text and line work for snapping. No DOM here, so tests can run it in Node.
//
// Coordinates everywhere are "sheet points": the page as shown (rotation applied),
// origin top-left, 1 unit = 1 PDF point.
import type { WrappedPdfiumModule } from '@embedpdf/pdfium';
// (the package's JavaScript patched to use 4 GB: tools/patch-pdfium.mjs - as the PDF Editor 0.9.7)
import { init } from '../../engine/pdfhost/vendor/pdfium-4gb.js';

/** a file read on demand (the engine processes give one per open drawing, see engine/pdfhost) */
export interface Reader { readonly size: number; read(buf: Uint8Array, off: number, len: number, pos: number): number; close(): void }

let P: WrappedPdfiumModule | null = null;

/** the most the engine's memory may grow to: 4 GB less one 64 KB page (as Emscripten's own 4 GB builds) */
export const MEMORY_MAX = 65535 * 65536;
/** what the .wasm's memory may really grow to (a build that cannot be lifted stops at 2 GB) */
let memoryLimitNow = MEMORY_MAX;
export const memoryLimit = () => memoryLimitNow;

/**
 * The .wasm says its memory may grow to 2 GB (32768 pages); raised here to 65535 pages, in a copy (the
 * number is 3 bytes long either way: nothing else moves). Only that exact declaration is changed:
 * anything else (another build) is left as it is - and said so in the log, with the limit it leaves
 * the engine at (memoryLimit(); the host starts a fresh engine before that). The engine build does
 * the same to dist/engine/pdfium.wasm (tools/patch-pdfium.mjs liftWasm): a .wasm already lifted is
 * left as it is.
 */
export function liftMemoryMax(wasm: ArrayBuffer): ArrayBuffer {
  const b = new Uint8Array(wasm);
  const leb = (i: number): [number, number] => {
    let r = 0, k = 0;
    for (;;) { const x = b[i++]; r += (x & 0x7f) * 2 ** k; k += 7; if (x < 0x80 || k > 35) return [r, i]; }
  };
  const left = (why: string, limit = 32768 * 65536): ArrayBuffer => {
    memoryLimitNow = limit;
    console.error(`PDFium wasm left as it is (${why}): its memory stops at ${(limit / 2 ** 30).toFixed(2)} GB, not 4 GB`);
    return wasm;
  };
  if (b[0] !== 0 || b[1] !== 0x61 || b[2] !== 0x73 || b[3] !== 0x6d) return left('not a wasm file');
  for (let i = 8; i < b.length;) {
    const id = b[i];
    const [size, at] = leb(i + 1);
    // the memory section: one memory, with a maximum, 32768 pages as 80 80 02
    if (id === 5) {
      const [count, j] = leb(at);
      if (count !== 1 || b[j] !== 1) return left('memory section is not one memory with a maximum');
      const [, k] = leb(j + 1);
      if (b[k] !== 0x80 || b[k + 1] !== 0x80 || b[k + 2] !== 0x02) {
        // (lifted already - the engine build did it - or another build that allows 4 GB: as it is)
        const [pages] = leb(k);
        if (pages >= 65535) { memoryLimitNow = MEMORY_MAX; return wasm; }
        return left('memory maximum is not 32768 pages', pages * 65536);
      }
      const out = b.slice();
      out.set([0xff, 0xff, 0x03], k);
      memoryLimitNow = MEMORY_MAX;
      return out.buffer;
    }
    i = at + size;
  }
  return left('no memory section');
}

export async function startEngine(wasm: ArrayBuffer): Promise<void> {
  // (support, and the before / after: GT_OFF=pdfium4gb keeps the engine at 2 GB as it came)
  const off = typeof process !== 'undefined' && String(process.env?.GT_OFF || '').split(',').map((x) => x.trim()).includes('pdfium4gb');
  if (off) { memoryLimitNow = 32768 * 65536; console.error('PDFium wasm left at 2 GB (GT_OFF=pdfium4gb)'); }
  P = await init({ wasmBinary: off ? wasm : liftMemoryMax(wasm) });
  P.PDFiumExt_Init();
}

export interface Doc {
  key: string;
  /** the file's bytes in the engine's memory (opened from bytes), or 0 (read from a file on demand) */
  ptr: number;
  /** read on demand: the FPDF_FILEACCESS block and the reader's slot */
  fa: number;
  slot: number;
  reader: Reader | null;
  doc: number;
  pages: Map<number, number>;
  snap: Map<number, SnapIndex>;
}
export const docs = new Map<string, Doc>();

export interface SnapIndex {
  /** x0,y0,x1,y1 per segment */
  seg: Float32Array;
  /** per segment: 1 = its start is not a corner, 2 = its end is not a corner, 4 = no middle (pieces of a curve) */
  fl: Uint8Array;
  n: number;
  cols: number;
  rows: number;
  cw: number;
  ch: number;
  /** cell -> start offset into ids (cols*rows + 1 entries) */
  start: Int32Array;
  ids: Int32Array;
  w: number;
  h: number;
}

/** the WebAssembly memory views (typed loosely by the package) */
const heap = (Q: WrappedPdfiumModule) => Q.pdfium as unknown as { HEAPU8: Uint8Array; HEAPF32: Float32Array };
// Addresses are read unsigned (`>>> 0`) everywhere: past 2 GB they come back from the engine negative.
// 0 = no memory left: a file would then be copied over address 0 - the engine's own data - and every
// later call fail; it stops as out of memory instead (fatal: a fresh engine, the call asked again).
const malloc = (n: number) => {
  const p = mustP().pdfium.wasmExports.malloc(n) >>> 0;
  if (!p && n > 0) throw new Error(`Out of memory: the drawing engine could not get ${Math.round(n / 2 ** 20)} MB more`);
  return p;
};
const free = (p: number) => mustP().pdfium.wasmExports.free(p);

export function mustP(): WrappedPdfiumModule {
  if (!P) throw new Error('PDF engine not started');
  return P;
}

/**
 * Pages kept loaded, most recent last. A loaded page of a heavy sheet holds hundreds of megabytes
 * inside the engine (its drawing, parsed), and the engine's memory only ever grows: two pages are
 * kept (a sheet and the revision it is compared with), the others are let go.
 */
const loaded: { d: Doc; i: number }[] = [];
let MAX_PAGES = 2;
/** the geometry worker keeps one (its line work is read once into the snapping index) */
export function setMaxPages(n: number) { MAX_PAGES = Math.max(1, n); }

export function page(d: Doc, i: number): number {
  let p = d.pages.get(i);
  const at = loaded.findIndex((x) => x.d === d && x.i === i);
  if (at >= 0) loaded.splice(at, 1);
  loaded.push({ d, i });
  if (p) return p;
  while (loaded.length > MAX_PAGES) {
    const old = loaded.shift()!;
    const op = old.d.pages.get(old.i);
    if (op) { mustP().FPDF_ClosePage(op); old.d.pages.delete(old.i); }
  }
  p = mustP().FPDF_LoadPage(d.doc, i);
  if (!p) { loaded.pop(); throw new Error('Could not read page ' + (i + 1)); }
  d.pages.set(i, p);
  return p;
}

/** how big the engine's memory has grown (it never shrinks; only a new engine gives it back) */
export function heapMB(): number {
  return P ? Math.round(heap(P).HEAPU8.buffer.byteLength / 1048576) : 0;
}
/** the same in bytes */
export const heapBytes = () => (P ? heap(P).HEAPU8.buffer.byteLength : 0);
/** (tests) take `n` bytes of the engine's memory until the returned function gives them back - so
 *  what comes after lands past 2 GB; and where the next allocation would land */
export function holdMemory(n: number): () => void { const p = malloc(n); return () => free(p); }
export function nextAddress(n = 16): number { const p = malloc(n); free(p); return p; }
/** (tests) take `top` bytes, then the gaps left below, until what comes next lands past `at` */
export function fillBelow(at: number, top: number): () => void {
  const gives: (() => void)[] = [];
  for (let got = 0; got < top; got += 2 ** 30) gives.push(holdMemory(Math.min(2 ** 30, top - got)));
  for (const n of [1 << 22, 1 << 18, 1 << 14, 1 << 10, 64, 16]) while (nextAddress(n) < at) gives.push(holdMemory(n));
  return () => { for (const g of gives) g(); };
}

/** the engine itself failed (out of memory, a crash inside the library): it can't be used again */
export function isFatal(e: unknown): boolean {
  const m = String((e as any)?.message ?? e);
  return (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError) || /Aborted\(|abort\(|memory access out of bounds|unreachable|Out of memory|Cannot enlarge memory/i.test(m);
}

export function pageSize(p: number): { w: number; h: number } {
  const Q = mustP();
  return { w: Q.FPDF_GetPageWidthF(p), h: Q.FPDF_GetPageHeightF(p) };
}

/** affine from PDF user space to sheet points: [a,b,c,d,e,f] so x' = a x + c y + e, y' = b x + d y + f */
export function userToSheet(p: number): number[] {
  const Q = mustP();
  const { w, h } = pageSize(p);
  const K = 64; // sub-point precision (PageToDevice returns whole device pixels)
  const sx = Math.round(w * K), sy = Math.round(h * K);
  const out = malloc(8);
  const dev = (x: number, y: number): [number, number] => {
    Q.FPDF_PageToDevice(p, 0, 0, sx, sy, 0, x, y, out, out + 4);
    return [Q.pdfium.getValue(out, 'i32') / K, Q.pdfium.getValue(out + 4, 'i32') / K];
  };
  const o = dev(0, 0), ex = dev(1000, 0), ey = dev(0, 1000);
  free(out);
  return [(ex[0] - o[0]) / 1000, (ex[1] - o[1]) / 1000, (ey[0] - o[0]) / 1000, (ey[1] - o[1]) / 1000, o[0], o[1]];
}

export function renderRaw(d: Doc, pg: number, scale: number, x: number, y: number, w: number, h: number, quality: number): Uint8ClampedArray {
  const Q = mustP();
  const p = page(d, pg);
  const { w: pw, h: ph } = pageSize(p);
  // (a page of no size is a plain error, not "out of memory" - that took the drawing engine down, 0.23.2, DeepSeek #23)
  if (!(w >= 1 && h >= 1) || !Number.isFinite(w * h)) throw new Error('This page has no size (' + w + '×' + h + ') and can\'t be drawn.');
  const bmp = Q.FPDFBitmap_Create(w, h, 1);
  if (!bmp) throw new Error('Out of memory for a ' + w + '×' + h + ' render');
  try {
    Q.FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xffffffff);
    // flags: FPDF_ANNOT 0x01 | FPDF_LCD_TEXT 0x02 (no) | FPDF_REVERSE_BYTE_ORDER 0x10 (RGBA for ImageData)
    // quality 0 = quick preview: no anti-aliasing on paths (FPDF_RENDER_NO_SMOOTHPATH 0x2000)
    const flags = 0x01 | 0x10 | (quality === 0 ? 0x2000 : 0);
    Q.FPDF_RenderPageBitmap(bmp, p, -Math.round(x), -Math.round(y), Math.round(pw * scale), Math.round(ph * scale), 0, flags);
    const buf = Q.FPDFBitmap_GetBuffer(bmp) >>> 0;
    const stride = Q.FPDFBitmap_GetStride(bmp);
    let px: Uint8ClampedArray;
    if (stride === w * 4) px = new Uint8ClampedArray(heap(Q).HEAPU8.buffer, buf, w * h * 4).slice();
    else {
      px = new Uint8ClampedArray(w * h * 4);
      for (let r = 0; r < h; r++) px.set(new Uint8Array(heap(Q).HEAPU8.buffer, buf + r * stride, w * 4), r * w * 4);
    }
    return px;
  } finally {
    Q.FPDFBitmap_Destroy(bmp);
  }
}

export function pageText(d: Doc, pg: number): string {
  const Q = mustP();
  const tp = Q.FPDFText_LoadPage(page(d, pg));
  if (!tp) return '';
  try {
    const n = Q.FPDFText_CountChars(tp);
    if (n <= 0) return '';
    const buf = malloc((n + 1) * 2);
    Q.FPDFText_GetText(tp, 0, n, buf);
    const s = Q.pdfium.UTF16ToString(buf);
    free(buf);
    return s;
  } finally {
    Q.FPDFText_ClosePage(tp);
  }
}

/** a word on a page, in sheet points (its box as drawn, rotated text too) */
export interface Word { t: string; x0: number; y0: number; x1: number; y1: number }

/**
 * The words of a page with where they are (auto-count by tag, v0.15): characters run together while they
 * touch; a space, a line end, or a gap of half a character ends a word. Tags drawn as two pieces of text
 * ("D" + "01") come out as two words - the matcher joins neighbours.
 */
export function pageWords(d: Doc, pg: number): Word[] {
  const Q = mustP();
  const p = page(d, pg);
  const tp = Q.FPDFText_LoadPage(p);
  if (!tp) return [];
  const T = userToSheet(p);
  const out: Word[] = [];
  const box = malloc(32);
  try {
    const n = Q.FPDFText_CountChars(tp);
    let cur: { t: string; l: number; r: number; b: number; tp: number; s: number } | null = null;
    const end = () => {
      if (cur && cur.t.trim()) {
        const xs = [cur.l, cur.r], ys = [cur.b, cur.tp];
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const x of xs) for (const y of ys) {
          const X = T[0] * x + T[2] * y + T[4], Y = T[1] * x + T[3] * y + T[5];
          x0 = Math.min(x0, X); x1 = Math.max(x1, X); y0 = Math.min(y0, Y); y1 = Math.max(y1, Y);
        }
        out.push({ t: cur.t, x0: Math.round(x0 * 10) / 10, y0: Math.round(y0 * 10) / 10, x1: Math.round(x1 * 10) / 10, y1: Math.round(y1 * 10) / 10 });
      }
      cur = null;
    };
    for (let i = 0; i < n; i++) {
      const u = Q.FPDFText_GetUnicode(tp, i);
      if (u <= 32 || u === 0xa0 || u === 0x3000 || u === 0xfffe || u === 0xffff) { end(); continue; }
      if (!Q.FPDFText_GetCharBox(tp, i, box, box + 8, box + 16, box + 24)) { end(); continue; }
      const l = Q.pdfium.getValue(box, 'double'), r = Q.pdfium.getValue(box + 8, 'double');
      const b = Q.pdfium.getValue(box + 16, 'double'), t = Q.pdfium.getValue(box + 24, 'double');
      const sz = Math.max(r - l, t - b, 0.5);
      if (cur) {
        const gx = Math.max(0, l - cur.r, cur.l - r), gy = Math.max(0, b - cur.tp, cur.b - t);
        if (Math.hypot(gx, gy) > 0.5 * Math.max(sz, cur.s) || cur.t.length > 60) end();
      }
      const ch = String.fromCodePoint(u);
      if (!cur) cur = { t: ch, l, r, b, tp: t, s: sz };
      else { cur.t += ch; cur.l = Math.min(cur.l, l); cur.r = Math.max(cur.r, r); cur.b = Math.min(cur.b, b); cur.tp = Math.max(cur.tp, t); cur.s = Math.max(cur.s, sz); }
    }
    end();
  } finally {
    free(box);
    Q.FPDFText_ClosePage(tp);
  }
  return out;
}

/** Every straight piece of line work on the page, for snapping (curves become their chords). */
export function buildSnap(d: Doc, pg: number): SnapIndex {
  const Q = mustP();
  const p = page(d, pg);
  const { w, h } = pageSize(p);
  const T0 = userToSheet(p);
  let seg = new Float32Array(1 << 20);
  let fl = new Uint8Array(1 << 18);
  let n = 0;
  const push = (x0: number, y0: number, x1: number, y1: number, flags = 0) => {
    // skip specks (hatch dots, text-like noise) – they make snapping jumpy (curve pieces are short by nature)
    if (!flags && Math.abs(x1 - x0) + Math.abs(y1 - y0) < 0.6) return;
    if (n * 4 + 4 > seg.length) {
      const g = new Float32Array(seg.length * 2);
      g.set(seg);
      seg = g;
      const gf = new Uint8Array(fl.length * 2);
      gf.set(fl);
      fl = gf;
    }
    seg[n * 4] = x0; seg[n * 4 + 1] = y0; seg[n * 4 + 2] = x1; seg[n * 4 + 3] = y1;
    fl[n] = flags;
    n++;
  };
  const mat = malloc(24);
  const xy = malloc(8);
  const H = () => heap(Q).HEAPF32;
  const mul = (A: number[], B: number[]) => [
    A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
  ];
  const visit = (obj: number, T: number[], depth: number) => {
    const type = Q.FPDFPageObj_GetType(obj);
    if (type !== 2 && type !== 5) return; // path or form only
    let M = [1, 0, 0, 1, 0, 0];
    if (Q.FPDFPageObj_GetMatrix(obj, mat)) {
      const f = H();
      const i = mat >>> 2;
      M = [f[i], f[i + 1], f[i + 2], f[i + 3], f[i + 4], f[i + 5]];
    }
    const A = mul(T, M);
    if (type === 5) {
      if (depth > 6) return;
      const c = Q.FPDFFormObj_CountObjects(obj);
      for (let k = 0; k < c; k++) visit(Q.FPDFFormObj_GetObject(obj, k), A, depth + 1);
      return;
    }
    const cnt = Q.FPDFPath_CountSegments(obj);
    let sx = 0, sy = 0, px = 0, py = 0, has = false;
    // a curve comes as three points (two control points, then where it ends): it is followed
    // in short pieces, so snapping lands on the curve and never on a control point off it
    const bz: number[] = [];
    for (let k = 0; k < cnt; k++) {
      const s = Q.FPDFPath_GetPathSegment(obj, k);
      if (!Q.FPDFPathSegment_GetPoint(s, xy, xy + 4)) continue;
      const f = H();
      const ux = f[xy >>> 2], uy = f[(xy >>> 2) + 1];
      const X = A[0] * ux + A[2] * uy + A[4];
      const Y = A[1] * ux + A[3] * uy + A[5];
      const t = Q.FPDFPathSegment_GetType(s); // 0 line, 1 bezier, 2 move
      if (t === 2 || !has) { sx = X; sy = Y; has = true; bz.length = 0; }
      else if (t === 1) {
        bz.push(X, Y);
        if (bz.length < 6) continue;
        const [x1, y1, x2, y2, x3, y3] = bz;
        bz.length = 0;
        const N = 8;
        let qx = px, qy = py;
        for (let j = 1; j <= N; j++) {
          const u = j / N, v = 1 - u;
          const a0 = v * v * v, a1 = 3 * v * v * u, a2 = 3 * v * u * u, a3 = u * u * u;
          const nx = a0 * px + a1 * x1 + a2 * x2 + a3 * x3, ny = a0 * py + a1 * y1 + a2 * y2 + a3 * y3;
          // only the curve's own two ends are corners to snap to; no middles of the pieces
          push(qx, qy, nx, ny, 4 | (j > 1 ? 1 : 0) | (j < N ? 2 : 0));
          qx = nx; qy = ny;
        }
      } else push(px, py, X, Y);
      px = X; py = Y;
      if (Q.FPDFPathSegment_GetClose(s) && (px !== sx || py !== sy)) { push(px, py, sx, sy); px = sx; py = sy; }
    }
  };
  const count = Q.FPDFPage_CountObjects(p);
  for (let i = 0; i < count; i++) visit(Q.FPDFPage_GetObject(p, i), T0, 0);
  free(mat);
  free(xy);

  // grid index
  const cols = 128, rows = Math.max(16, Math.round((128 * h) / w));
  const cw = w / cols, ch = h / rows;
  const counts = new Int32Array(cols * rows + 1);
  const cellsOf = (i: number, f: (c: number) => void) => {
    const x0 = Math.min(seg[i * 4], seg[i * 4 + 2]), x1 = Math.max(seg[i * 4], seg[i * 4 + 2]);
    const y0 = Math.min(seg[i * 4 + 1], seg[i * 4 + 3]), y1 = Math.max(seg[i * 4 + 1], seg[i * 4 + 3]);
    const c0 = Math.max(0, Math.floor(x0 / cw)), c1 = Math.min(cols - 1, Math.floor(x1 / cw));
    const r0 = Math.max(0, Math.floor(y0 / ch)), r1 = Math.min(rows - 1, Math.floor(y1 / ch));
    if (c1 < c0 || r1 < r0) return;
    if (r0 === r1 || c0 === c1) { for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) f(r * cols + c); return; }
    // a slanted line: in each row only the cells it actually passes through (not its whole
    // bounding box - a diagonal across the sheet would otherwise sit in thousands of cells)
    const ax = seg[i * 4], ay = seg[i * 4 + 1], bx = seg[i * 4 + 2], by = seg[i * 4 + 3];
    const xAt = (y: number) => ax + ((bx - ax) * (y - ay)) / (by - ay);
    for (let r = r0; r <= r1; r++) {
      const ya = Math.max(y0, r * ch), yb = Math.min(y1, (r + 1) * ch);
      const xa = xAt(ya), xb = xAt(yb);
      const ca = Math.max(c0, Math.floor((Math.min(xa, xb) - cw * 0.05) / cw)), cb = Math.min(c1, Math.floor((Math.max(xa, xb) + cw * 0.05) / cw));
      for (let c = ca; c <= cb; c++) f(r * cols + c);
    }
  };
  for (let i = 0; i < n; i++) cellsOf(i, (c) => counts[c + 1]++);
  for (let c = 0; c < cols * rows; c++) counts[c + 1] += counts[c];
  const ids = new Int32Array(counts[cols * rows]);
  const fill = counts.slice();
  for (let i = 0; i < n; i++) cellsOf(i, (c) => (ids[fill[c]++] = i));
  return { seg: seg.subarray(0, n * 4), fl: fl.subarray(0, n), n, cols, rows, cw, ch, start: counts, ids, w, h };
}

/**
 * Nearest snap target to (x, y) within r sheet points:
 * line ends and corners first, then middles, then the nearest point on a line.
 */
export function snap(ix: SnapIndex, x: number, y: number, r: number, near?: number[]): { x: number; y: number; k: 'end' | 'mid' | 'on' } | null {
  const c0 = Math.max(0, Math.floor((x - r) / ix.cw)), c1 = Math.min(ix.cols - 1, Math.floor((x + r) / ix.cw));
  const r0 = Math.max(0, Math.floor((y - r) / ix.ch)), r1 = Math.min(ix.rows - 1, Math.floor((y + r) / ix.ch));
  let bestEnd = r * r, end: [number, number] | null = null;
  let bestMid = (r * 0.7) ** 2, mid: [number, number] | null = null;
  let bestOn = (r * 0.6) ** 2, on: [number, number] | null = null;
  const seen = new Set<number>();
  const s = ix.seg;
  for (let rr = r0; rr <= r1; rr++) {
    for (let cc = c0; cc <= c1; cc++) {
      const cell = rr * ix.cols + cc;
      for (let k = ix.start[cell]; k < ix.start[cell + 1]; k++) {
        const sid = ix.ids[k], i = sid * 4, f = ix.fl[sid];
        const ax = s[i], ay = s[i + 1], bx = s[i + 2], by = s[i + 3];
        let d: number;
        if (!(f & 1)) { d = (ax - x) ** 2 + (ay - y) ** 2; if (d < bestEnd) { bestEnd = d; end = [ax, ay]; } }
        if (!(f & 2)) { d = (bx - x) ** 2 + (by - y) ** 2; if (d < bestEnd) { bestEnd = d; end = [bx, by]; } }
        if (!(f & 4)) {
          const mx = (ax + bx) / 2, my = (ay + by) / 2;
          d = (mx - x) ** 2 + (my - y) ** 2;
          if (d < bestMid) { bestMid = d; mid = [mx, my]; }
        }
        const dx = bx - ax, dy = by - ay;
        const l2 = dx * dx + dy * dy;
        if (l2 > 0) {
          let t = ((x - ax) * dx + (y - ay) * dy) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = ax + t * dx, qy = ay + t * dy;
          d = (qx - x) ** 2 + (qy - y) ** 2;
          if (d < bestOn) { bestOn = d; on = [qx, qy]; }
          // v0.18.1 the lines within r of the pointer (the ⊥ snap from the last node is worked out by the window)
          if (near && d < r * r && near.length < 4 * 64 && !seen.has(sid)) { seen.add(sid); near.push(ax, ay, bx, by); }
        }
      }
    }
  }
  if (end) return { x: end[0], y: end[1], k: 'end' };
  if (mid) return { x: mid[0], y: mid[1], k: 'mid' };
  if (on) return { x: on[0], y: on[1], k: 'on' };
  return null;
}

/** documents read on demand: PDFium asks for blocks, they are read from the file */
const readers = new Map<number, Reader>();
let slotSeq = 1;
let getBlockFn = 0;
function getBlock(): number {
  if (!getBlockFn) {
    const M = mustP().pdfium as unknown as { addFunction(f: (...a: number[]) => number, sig: string): number };
    getBlockFn = M.addFunction((param: number, pos: number, buf: number, len: number) => {
      const r = readers.get(param);
      if (!r) return 0;
      // (the file can't be read - gone, a network drive dropped: the page fails, the engine lives)
      try { return r.read(heap(mustP()).HEAPU8, buf >>> 0, len, pos >>> 0) === len ? 1 : 0; } catch { return 0; }
    }, 'iiiii');
  }
  return getBlockFn;
}

const openError = (err: number) => new Error(err === 4 ? 'This PDF is password protected.' : err === 3 ? 'This file is not a PDF or is damaged.' : err === 2 ? 'The file could not be read.' : 'Could not open the PDF (error ' + err + ').');

/**
 * Open a drawing: from bytes (tests, small files), or from a reader - the file stays on disk and
 * PDFium reads only what the pages it draws need (a 350 MB set opens in a fraction of a second).
 */
export function openDoc(key: string, src: ArrayBuffer | Reader): { pages: { w: number; h: number }[] } {
  const Q = mustP();
  let d = docs.get(key);
  let fresh = false;
  if (!d) {
    let ptr = 0, fa = 0, slot = 0, doc = 0;
    if (src instanceof ArrayBuffer) {
      const bytes = new Uint8Array(src);
      ptr = malloc(bytes.length);
      heap(Q).HEAPU8.set(bytes, ptr);
      doc = Q.FPDF_LoadMemDocument(ptr, bytes.length, '');
    } else {
      // (positions are read unsigned, the size is written as its 32 bits: up to 4 GB less a byte)
      if (src.size > 0xffffffff) throw new Error('Drawings of 4 GB or more can\'t be opened.');
      slot = slotSeq++;
      readers.set(slot, src);
      fa = malloc(12);
      Q.pdfium.setValue(fa, src.size | 0, 'i32');
      Q.pdfium.setValue(fa + 4, getBlock(), 'i32');
      Q.pdfium.setValue(fa + 8, slot, 'i32');
      doc = (Q as unknown as { FPDF_LoadCustomDocument(fa: number, pw: string): number }).FPDF_LoadCustomDocument(fa, '');
    }
    if (!doc) {
      const err = Q.FPDF_GetLastError();
      if (ptr) free(ptr);
      if (fa) free(fa);
      if (slot) readers.delete(slot);
      // (the file it was to be read from is let go: a drawing that would not open must not keep
      // its file open - on Windows it could not be replaced or trimmed after)
      if (!(src instanceof ArrayBuffer)) { try { src.close(); } catch { /* */ } }
      throw openError(err);
    }
    d = { key, ptr, fa, slot, reader: src instanceof ArrayBuffer ? null : src, doc, pages: new Map(), snap: new Map() };
    docs.set(key, d);
    fresh = true;
  } else if (!(src instanceof ArrayBuffer)) src.close(); // open already: this reader is not needed
  const n = Q.FPDF_GetPageCount(d.doc);
  const pages: { w: number; h: number }[] = [];
  const sz = malloc(16);
  try {
    for (let i = 0; i < n; i++) {
      // size without loading the page (fast for big documents)
      if (Q.FPDF_GetPageSizeByIndexF(d.doc, i, sz)) {
        const f = heap(Q).HEAPF32;
        pages.push({ w: f[sz >>> 2], h: f[(sz >>> 2) + 1] });
      } else pages.push(pageSize(page(d, i)));
    }
  } catch (e) {
    // a page that can't be read while it was being opened: the document is let go again (it stayed open, its file
    // held, and every later try failed the same way - 0.23.2, DeepSeek #24)
    if (fresh) { try { closeDoc(key); } catch { /* */ } }
    throw e;
  } finally {
    free(sz);
  }
  return { pages };
}

export function closeDoc(key: string) {
  const d = docs.get(key);
  if (!d) return;
  const Q = mustP();
  for (const p of d.pages.values()) Q.FPDF_ClosePage(p);
  for (let k = loaded.length - 1; k >= 0; k--) if (loaded[k].d === d) loaded.splice(k, 1);
  Q.FPDF_CloseDocument(d.doc);
  if (d.ptr) free(d.ptr);
  if (d.fa) free(d.fa);
  if (d.slot) readers.delete(d.slot);
  d.reader?.close();
  docs.delete(key);
}
