// The drawing engines' memory (as the PDF Editor 0.12's tests/engine-heap.test.ts, for the take-off's
// PDFium engines): every answer carries how big the engine's memory has grown and its planned recycle
// point; the window replaces an engine past that point at a sheet change; a planned fresh engine is no
// failure of the calls that waited; near its 4 GB ceiling an engine ends itself once it has answered.
// The engine host (engine/pdfhost/host.ts) runs here in this process with a fake parent, reached from
// the window's own client (ui/takeoff/pdfengine.ts) through a real message channel.
import { calls } from './harness/window';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { MessageChannel } from 'node:worker_threads';

// the host: its .wasm from the package, a planned recycle point of 40 MB (so a small sheet passes it)
process.argv[2] = 'node_modules/@embedpdf/pdfium/dist';
process.argv[3] = '1';
process.env.GT_RECYCLE_AT = '40';
type Fn = (e: { data: any; ports?: any[] }) => void;
const parent: { fns: Fn[]; sent: any[] } = { fns: [], sent: [] };
(process as any).parentPort = { on(_ev: string, f: Fn) { parent.fns.push(f); }, postMessage(m: unknown) { parent.sent.push(m); } };
const host = await import('../src/engine/pdfhost/host');
const { PdfEngine } = await import('../src/ui/takeoff/pdfengine');
for (let i = 0; i < 400 && !parent.sent.some((m) => m.type === 'ready'); i++) await new Promise((r) => setTimeout(r, 25));
assert.ok(parent.sent.some((m) => m.type === 'ready'), 'the host came up');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// (the app's stand-in keeps timers of its own: the file ends when its tests have)
after(() => { setTimeout(() => process.exit(), 300).unref(); });
const win = (globalThis as any).window;
/** a port to the window, as the app hands one over (restarted: a new engine in place of the old) */
function toWindow(name: string, token: string, restarted = false, code = 0) {
  const { port1, port2 } = new MessageChannel();
  win.postMessage({ type: 'gt-pdf-port', name, restarted, code, token }, '*', [port2]);
  return port1;
}
/** the host served on a port of its own: the window's engine `name` talks to it */
function connect(name: string, token: string, restarted = false, code = 0) {
  const p = toWindow(name, token, restarted, code);
  const main = { on(ev: string, f: (e: { data: any }) => void) { if (ev === 'message') p.on('message', (data: any) => f({ data })); }, postMessage(m: unknown) { p.postMessage(m); }, start() { /* started */ } };
  for (const f of parent.fns) f({ data: { type: 'port' }, ports: [main] });
  return p;
}

/** a one-page PDF of n separate little strokes (enough to grow the engine's memory) */
function strokesPdf(n: number): Buffer {
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
  return Buffer.concat(objs);
}
const dir = mkdtempSync(join(tmpdir(), 'gtheap-'));
const sheetA = join(dir, 'A-101.pdf'), sheetB = join(dir, 'A-102.pdf');
writeFileSync(sheetA, strokesPdf(400_000));
writeFileSync(sheetB, strokesPdf(1_000));

test('the planned recycle point: 40 % of the PC\'s memory shared by three engines, 1.4 to 3 GB, at least 0.2 GB under the ceiling; near the ceiling: 0.5 GB under it', () => {
  const ram = totalmem() / 2 ** 20;
  const want = Math.round(Math.min(3072, Math.max(1.4 * 1024, ram * 0.4 / 3)));
  assert.equal(host.recycleAtFor(4096 - 1 / 16, want), Math.round(want));
  assert.equal(host.recycleAtFor(4096, 3072), 3072, '4 GB engine, a big PC: 3 GB');
  assert.equal(host.recycleAtFor(2048, 3072), 1843, 'an engine left at 2 GB: 0.2 GB under it');
  assert.equal(host.recycleAtFor(4096), 40, '(this test: GT_RECYCLE_AT)');
  assert.equal(host.hardAtFor(4096), 3584);
  assert.equal(host.hardAtFor(2048), 1536);
});

test('every answer carries the engine\'s memory and its recycle point; the window keeps the last figures', async () => {
  const e = new PdfEngine('heap-a', null);
  const c = e.clients.draw;
  const port = connect('heap-a', c.token);
  const h = await c.call('heap');
  assert.equal(h.ok, true);
  assert.equal(typeof h.heap, 'number');
  assert.ok(h.heap > 0, 'a started engine holds some memory: ' + h.heap);
  assert.equal(h.limit, 4096, 'its ceiling: 4 GB (the .wasm lifted when it started)');
  assert.equal(h.recycle, 40);
  assert.equal(c.recycleAt, 40, 'the window keeps its recycle point');
  const before = h.heap;
  const o = await c.call('open', { key: 'a', file: { path: sheetA } });
  assert.equal(o.ok, true);
  const r = await c.call('render', { key: 'a', pg: 0, scale: 1, x: 0, y: 0, w: 400, h: 300, quality: 0 });
  assert.ok(r.heap > before, `a heavy page read in grows it (${before} -> ${r.heap} MB)`);
  assert.equal(c.heap, r.heap, 'the window keeps the figure of the last answer');
  const bad = await c.call('noSuchCall').catch((err: Error) => err);
  assert.match(String(bad?.message), /unknown request/);
  assert.equal(c.heap, r.heap, 'an error answer carries it too');
  // a fresh engine: none yet
  const fresh = toWindow('heap-a', c.token, true, 75);
  assert.equal(c.heap, 0, 'restarted: the new engine has none yet');
  port.close(); fresh.close();
  c.fail('test over');
});

test('at a sheet change an idle engine past its recycle point is replaced (a fresh one), one under it is not', async () => {
  const e = new PdfEngine('heap-b', null);
  const c = e.clients.draw;
  const port = connect('heap-b', c.token);
  const was = win.gt.pdf.restart;
  const restarted: string[] = [];
  win.gt.pdf.restart = async (n: string) => { restarted.push(n); return true; };
  try {
    // (the engine says its point with every answer: far above it first)
    process.env.GT_RECYCLE_AT = '100000';
    await c.call('heap');
    await e.load('b', { path: sheetB });
    await e.load('a', { path: sheetA });
    assert.deepEqual(restarted, [], 'under its point: kept');
    // ...then under what it holds (as after a heavy sheet)
    process.env.GT_RECYCLE_AT = '1';
    const h = await c.call('heap');
    assert.equal(c.recycleAt, 1);
    assert.ok(c.heap > h.recycle, 'past its point now: ' + c.heap);
    assert.deepEqual(restarted, [], 'never in the middle of a sheet');
    e.load('c', { path: sheetB }).catch(() => null);
    assert.deepEqual(restarted, ['heap-b'], 'the next sheet: a fresh engine first');
    assert.match(String(calls.filter((x) => x.name === 'log').pop()?.args[0] ?? ''), /heap-b: memory \d+ MB, past 1 MB - starting a fresh one/, 'and the log says why');
  } finally {
    process.env.GT_RECYCLE_AT = '40';
    win.gt.pdf.restart = was;
    port.close();
    c.fail('test over');
  }
});

test('a planned fresh engine is no failure: what waited is asked again (three in a row too); two real failures say "twice"; each engine is told its planned restarts', async () => {
  // (pictures: no ImageBitmap in Node - the engine's pixels are what matters)
  const g = globalThis as any;
  g.ImageData ??= class { constructor(public data: unknown, public width: number, public height: number) {} };
  g.createImageBitmap ??= async (x: unknown) => x;
  const e = new PdfEngine('heap-c', null);
  const c = e.clients.draw;
  const got: any[] = [];
  let answerRender = false;
  // a stand-in engine: opens at once, draws only when told
  const engine = (p: any) => {
    p.on('message', (m: any) => {
      got.push(m);
      if (m.t === 'open') p.postMessage({ id: m.id, ok: true, pages: [{ w: 100, h: 100 }], heap: 5 });
      if (m.t === 'render' && answerRender) p.postMessage({ id: m.id, ok: true, px: new Uint8ClampedArray(m.w * m.h * 4), w: m.w, h: m.h, ms: 1, heap: 6 });
    });
    return p;
  };
  let p = engine(toWindow('heap-c', c.token));
  await e.load('k', { path: sheetB });
  const r1 = e.render('k', 0, 1, 0, 0, 10, 10);
  // three planned fresh engines while it waits (each once the call has reached it), then one draws it
  const renders = async (n: number) => { for (let i = 0; i < 200 && got.filter((m) => m.t === 'render').length < n; i++) await sleep(5); };
  for (let k = 0; k < 3; k++) {
    await renders(k + 1);
    p.close(); p = engine(toWindow('heap-c', c.token, true, 75));
  }
  await renders(4);
  answerRender = true;
  p.close(); p = engine(toWindow('heap-c', c.token, true, 75));
  const done = await Promise.race([r1, sleep(2000).then(() => null)]);
  assert.ok(done && done.bmp, 'drawn after four planned fresh engines - not "ran out of memory twice"');
  assert.equal(got.filter((m) => m.t === 'render').length, 5, 'asked of each engine in turn');
  assert.deepEqual(got.filter((m) => m.t === 'config').map((m) => m.recycles), [0, 1, 2, 3, 4], 'each engine is told how many planned restarts came before it (it waits longer before ending near its ceiling)');
  // two engines that went down under it (out of memory: 70) fail it, "twice"
  answerRender = false;
  const r2 = e.render('k', 0, 1, 0, 0, 10, 10).catch((err: any) => err);
  for (let k = 0; k < 2; k++) { await renders(6 + k); p.close(); p = engine(toWindow('heap-c', c.token, true, 70)); }
  const err = await r2;
  assert.equal(err?.heavy, true, 'two failures: too heavy');
  assert.match(String(err?.message), /ran out of memory on it twice/);
  p.close();
  c.fail('test over');
});

test('near its ceiling an engine ends itself once it has answered (exit 75, planned); what was queued behind is left for the fresh one', async () => {
  const e = new PdfEngine('heap-d', null);
  const c = e.clients.draw;
  const port = connect('heap-d', c.token);
  await c.call('open', { key: 'd', file: { path: sheetB } });
  const exit = process.exit;
  const codes: number[] = [];
  (process as any).exit = (code: number) => { codes.push(code); };
  process.env.GT_RECYCLE_HARD = '1';
  process.env.GT_RECYCLE_MINUP = '0';
  try {
    const a = c.call('text', { key: 'd', pg: 0 });
    const behind = c.call('text', { key: 'd', pg: 0 }).then(() => 'answered', () => 'failed');
    const r = await a;
    assert.equal(r.ok, true, 'the call that took it there is answered');
    await sleep(100);
    assert.deepEqual(codes, [75], 'then the engine ends: planned');
    assert.equal(await Promise.race([behind, sleep(200).then(() => 'waiting')]), 'waiting', 'the call behind it waits for the fresh engine');
    const fresh = toWindow('heap-d', c.token, true, 75);
    await sleep(20);
    assert.equal(await Promise.race([behind, sleep(200).then(() => 'waiting')]), 'failed', 'and is handed back to be asked again (retry, planned)');
    fresh.close();
  } finally {
    (process as any).exit = exit;
    delete process.env.GT_RECYCLE_HARD;
    delete process.env.GT_RECYCLE_MINUP;
    port.close();
    c.fail('test over');
  }
});
