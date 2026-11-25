// Makes the PDFium drawing engine able to use 4 GB instead of 2 GB (ported from the PDF Editor 0.9.7 -
// 0.12, scripts/patch-pdfium.mjs).
//
// @embedpdf/pdfium is built for at most 2 GB: its JavaScript side reads memory addresses as signed
// numbers (an address past 2 GB comes out negative and reads or writes nothing), it refuses to grow
// past 2 GB, and its .wasm says its memory stops at 32768 pages. Two patches, as Emscripten's own 4 GB
// builds do it:
//  - its JavaScript, written as src/engine/pdfhost/vendor/pdfium-4gb.js: the growth limit (getHeapMax)
//    is 4 GB less one 64 KB page (a full 4 GB wraps to 0), memory indexes shift unsigned (`>>>`), and
//    the helpers that take an address read it unsigned
//  - its .wasm (liftWasm): the memory's maximum 32768 pages -> 65535, the same three bytes long
//    (80 80 02 -> ff ff 03): nothing else moves. Done when the engines are built (tools/build-engines.mjs
//    writes the lifted copy into dist/engine), and again when an engine starts (pdfcore.ts
//    liftMemoryMax - the same bytes; a .wasm already lifted is left as it is) so the tests, which read
//    the package's own .wasm, run the engine as the app does.
//
//   node tools/patch-pdfium.mjs        writes the patched JavaScript (after updating @embedpdf/pdfium)
// Every patch must match exactly, or this stops (the package changed: look before patching again).
// (tests/engine-4gb.test.ts checks the copy is of the installed version and is what this makes.)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(ROOT, 'node_modules/@embedpdf/pdfium');
export const VENDOR = join(ROOT, 'src/engine/pdfhost/vendor/pdfium-4gb.js');

/** the installed package's version */
export const installedVersion = () => JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version;

/** the package's JavaScript, patched for 4 GB: { text, shifts } */
export function patchGlue(src = readFileSync(join(PKG, 'dist/index.js'), 'utf8'), version = installedVersion()) {
  let s = src;
  /** replace `from` with `to` exactly `n` times (a mismatch means the glue changed: stop) */
  const rep = (from, to, n = 1) => {
    const got = s.split(from).length - 1;
    if (got !== n) throw new Error(`patch-pdfium: expected ${n} of ${JSON.stringify(from)}, found ${got}`);
    s = s.split(from).join(to);
  };
  /** add `code` at the start of the body of the function opened by `head` */
  const enter = (head, code) => rep(head, `${head}\n      ${code}`);

  // 1. the growth limit (getHeapMax)
  rep('      // casing all heap size related code to treat 0 specially.\n      2147483648;',
    '      // casing all heap size related code to treat 0 specially.\n      4294901760; // (patched: 4 GB build)');

  // 2. memory indexes: unsigned shifts (an address past 2 GB, signed, is negative)
  let shifts = 0;
  s = s.replace(/(HEAP\w*\[[^\]]*?\))>>([0-3])\)\]/g, (_m, a, b) => { shifts++; return `${a}>>>${b})]`; });
  if (shifts < 80) throw new Error(`patch-pdfium: only ${shifts} memory indexes found`);
  if (/HEAP\w*\[[^\]]*[^>]>>[0-3][^\]]*\]/.test(s)) throw new Error('patch-pdfium: a signed memory index is left');

  // (an address halved outside a memory index: UTF16ToString's end - a slower fallback found the
  // string anyway, but it's an address)
  rep('var idx = endPtr >> 1;', 'var idx = endPtr >>> 1;');
  if (/\b\w*(?:[pP]tr|[aA]ddr|[bB]uf)\w*\s*>>\s*[0-3]\b/.test(s)) throw new Error('patch-pdfium: an address is shifted signed: ' + s.match(/.{40}\b\w*(?:[pP]tr|[aA]ddr|[bB]uf)\w*\s*>>\s*[0-3]\b.{10}/)[0]);

  // 3. helpers that take an address: read it unsigned
  enter('function getValue(ptr, type = \'i8\') {', 'ptr >>>= 0;');
  enter('function setValue(ptr, value, type = \'i8\') {', 'ptr >>>= 0;');
  enter('var UTF8ArrayToString = (heapOrArray, idx = 0, maxBytesToRead = NaN) => {', 'idx >>>= 0;');
  enter('var UTF8ToString = (ptr, maxBytesToRead) => {', 'ptr >>>= 0;');
  enter('var stringToUTF8Array = (str, heap, outIdx, maxBytesToWrite) => {', 'outIdx >>>= 0;');
  enter('var stringToUTF8 = (str, outPtr, maxBytesToWrite) => {', 'outPtr >>>= 0;');
  enter('var UTF16ToString = (ptr, maxBytesToRead) => {', 'ptr >>>= 0;');
  enter('var stringToUTF16 = (str, outPtr, maxBytesToWrite) => {', 'outPtr >>>= 0;');
  enter('var zeroMemory = (address, size) => {', 'address >>>= 0;');
  enter('var writeArrayToMemory = (array, buffer) => {', 'buffer >>>= 0;');
  rep('var __emscripten_memcpy_js = (dest, src, num) => HEAPU8.copyWithin(dest, src, src + num);',
    'var __emscripten_memcpy_js = (dest, src, num) => { dest >>>= 0; src >>>= 0; num >>>= 0; HEAPU8.copyWithin(dest, src, src + num); };');
  // (present in some Emscripten versions; patched when there)
  for (const [head, code] of [
    ['var stringToAscii = (str, buffer) => {', 'buffer >>>= 0;'],
    ['var writeAsciiToMemory = (str, buffer, dontAddNull) => {', 'buffer >>>= 0;'],
    ['var UTF32ToString = (ptr, maxBytesToRead) => {', 'ptr >>>= 0;'],
    ['var stringToUTF32 = (str, outPtr, maxBytesToWrite) => {', 'outPtr >>>= 0;'],
  ]) if (s.includes(head)) enter(head, code);
  // (the file system calls - stat, getdents, open... - use the indexes above; PDFium reads drawings
  // through our own block reader, never the file system)
  if (!s.includes('ptr >>>= 0') || !s.includes('4294901760')) throw new Error('patch-pdfium: not patched');
  const text = `// @embedpdf/pdfium ${version} (MIT, see THIRD-PARTY-NOTICES.txt), patched for 4 GB by tools/patch-pdfium.mjs - do not edit; run the script again.\n` +
    `export const PATCHED_FROM = ${JSON.stringify(version)};\n` + s;
  return { text, shifts };
}

/** the types: the package's own (this is its JavaScript, patched) */
export const VENDOR_DTS = `// types: the package's own (this is its JavaScript, patched by tools/patch-pdfium.mjs)\nexport { init } from '@embedpdf/pdfium';\nexport declare const PATCHED_FROM: string;\n`;

/**
 * The .wasm's memory maximum, 32768 pages (2 GB, LEB128 80 80 02), raised to 65535 pages (4 GB less a
 * 64 KB page, ff ff 03) in a copy. Only that exact declaration is changed: { bytes, lifted, pages, why }
 * - a module whose maximum is already 65535 or more is left as it is (lifted false, pages its own).
 * (the same as src/ui/takeoff/pdfcore.ts liftMemoryMax - tests/engine-4gb.test.ts checks they agree)
 */
export function liftWasm(input) {
  const b = new Uint8Array(input);
  const leb = (i) => {
    let r = 0, k = 0;
    for (;;) { const x = b[i++]; r += (x & 0x7f) * 2 ** k; k += 7; if (x < 0x80 || k > 35) return [r, i]; }
  };
  const left = (why, pages = 32768) => ({ bytes: b, lifted: false, pages, why });
  if (b[0] !== 0 || b[1] !== 0x61 || b[2] !== 0x73 || b[3] !== 0x6d) return left('not a wasm file');
  for (let i = 8; i < b.length;) {
    const id = b[i];
    const [size, at] = leb(i + 1);
    if (id === 5) {
      const [count, j] = leb(at);
      if (count !== 1 || b[j] !== 1) return left('memory section is not one memory with a maximum');
      const [, k] = leb(j + 1);
      if (b[k] !== 0x80 || b[k + 1] !== 0x80 || b[k + 2] !== 0x02) {
        const [pages] = leb(k);
        return pages >= 65535 ? { bytes: b, lifted: false, pages, why: '' } : left('memory maximum is not 32768 pages', pages);
      }
      const out = b.slice();
      out.set([0xff, 0xff, 0x03], k);
      return { bytes: out, lifted: true, pages: 65535, why: '' };
    }
    i = at + size;
  }
  return left('no memory section');
}

// run as a script: write the patched JavaScript
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { text, shifts } = patchGlue();
  mkdirSync(dirname(VENDOR), { recursive: true });
  writeFileSync(VENDOR, text);
  writeFileSync(VENDOR.replace(/\.js$/, '.d.ts'), VENDOR_DTS);
  console.log(`pdfium ${installedVersion()} patched: ${shifts} memory indexes`);
}
