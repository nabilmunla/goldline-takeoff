// Bundles the PDF engine processes into dist/engine/ (after `vite build`, which empties dist/):
//   pdf-host.mjs   a drawing engine (PDFium) - draws sheets, reads their text and line work
//   heavy.mjs      a one-off job (MuPDF) that simplifies monster sheets' line work
//   pdfium.wasm, mupdf/   their WebAssembly (MuPDF loads its .wasm from its own folder)
// The drawing engine may use 4 GB (tools/patch-pdfium.mjs): its JavaScript is the patched copy in
// src/engine/pdfhost/vendor (brought up to date here when @embedpdf/pdfium was updated - each patch
// must match exactly, or the build stops), its .wasm is written here with its memory maximum lifted.
// Everything stays inside dist/ with plain names: an app update may only carry dist\..., electron\*.cjs
// and package.json (electron/versions.cjs appFile, tools/legacy-release.cjs safeRel).
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { patchGlue, liftWasm, VENDOR, VENDOR_DTS, installedVersion } from './patch-pdfium.mjs';

// (node tools/build-engines.mjs [dist folder] - another one for a test build beside dist/)
const out = join(process.argv[2] || 'dist', 'engine');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'mupdf'), { recursive: true });
// the drawing engine's JavaScript: the patched copy of the installed version (made again if it is not)
{
  const { text } = patchGlue();
  if (!existsSync(VENDOR) || readFileSync(VENDOR, 'utf8') !== text) {
    mkdirSync(dirname(VENDOR), { recursive: true });
    writeFileSync(VENDOR, text);
    writeFileSync(VENDOR.replace(/\.js$/, '.d.ts'), VENDOR_DTS);
    console.log(`pdfium ${installedVersion()}: its 4 GB copy made again (src/engine/pdfhost/vendor - commit it)`);
  }
}
// ...and its .wasm, with its memory maximum lifted to 4 GB less a page
{
  const w = liftWasm(readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm'));
  if (!w.lifted && w.pages < 65535) throw new Error('pdfium.wasm could not be lifted to 4 GB: ' + w.why);
  writeFileSync(join(out, 'pdfium.wasm'), w.bytes);
}
for (const f of ['mupdf.js', 'mupdf-wasm.js', 'mupdf-wasm.wasm']) copyFileSync(join('node_modules/mupdf/dist', f), join(out, 'mupdf', f));
// (ES modules: said so - Node otherwise tries them as CommonJS first and parses them twice)
writeFileSync(join(out, 'mupdf', 'package.json'), JSON.stringify({ type: 'module' }) + '\n');
await build({
  entryPoints: { 'pdf-host': 'src/engine/pdfhost/host.ts', heavy: 'src/engine/pdfhost/heavy.ts' },
  outdir: out,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  splitting: false,
  sourcemap: false,
  legalComments: 'none',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  plugins: [{
    name: 'mupdf-external',
    setup(b) { b.onResolve({ filter: /^mupdf$/ }, () => ({ path: './mupdf/mupdf.js', external: true })); },
  }],
  logLevel: 'warning',
});
console.log('engines built');
