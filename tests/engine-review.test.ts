// v0.12.5 review (debug run 1): what was found in the new drawing engines and how this PC's copies
// of drawings are kept - each case was a failing repro first (tests/tmp-a), fixed since.
// run: npx tsx --test tests/engine-review.test.ts
import { ROOT, userData, main, hooks, calls } from './harness/window';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, statSync, utimesSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { loadDrawing, heavySrc, trimCache } from '../src/ui/takeoff/drawings';
import { PdfEngine } from '../src/ui/takeoff/pdfengine';
import { startEngine, openDoc, mustP } from '../src/ui/takeoff/pdfcore';
import { VFile } from '../src/engine/pdfhost/files';

const require = createRequire(import.meta.url);
const loadMain = require('./harness/main.cjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fixture = readFileSync(join(process.cwd(), 'tests/fixtures/snap-shapes.pdf'));
const H = createHash('sha256').update(fixture).digest('hex');
const cacheRoot = join(userData, 'qto-cache');
const fakeEngine = (): any => ({
  converted: new Map(),
  load: async (_k: string, src: any) => {
    if (readFileSync(src.path).subarray(0, 4).toString() !== '%PDF') throw new Error('This file is not a PDF or is damaged.');
    return [{ w: 842, h: 595 }];
  },
});
const fetches = () => calls.filter((c) => c.name === 'fetch').length;

test('an unchanged sheet opened again comes from this PC\'s copy (its date is kept to the millisecond)', async () => {
  const server = join(ROOT, 'server-mtime');
  mkdirSync(server, { recursive: true });
  const f = join(server, 'A-900 Typical floor.pdf');
  copyFileSync(join(process.cwd(), 'tests/fixtures/snap-shapes.pdf'), f);
  // a date with a fraction of a millisecond, as NTFS (100 ns) and ext4 (1 ns) keep them
  utimesSync(f, new Date(), new Date(1761600000123.4567));
  const d: any = { id: 'dwg:1', path: f, unc: '', hash: '', size: statSync(f).size, mtime: Math.round(statSync(f).mtimeMs) };
  const r1: any = await loadDrawing(d, userData, fakeEngine(), {});
  for (const [, k, v] of r1.ops) d[k] = v; // as committed
  assert.ok(Number.isInteger(d.mtime), 'kept in whole milliseconds: ' + d.mtime);
  const n0 = fetches();
  const r2: any = await loadDrawing(d, userData, fakeEngine(), {});
  assert.equal(r2.fromCache, true);
  assert.equal(fetches() - n0, 0, 'not read from the server again');
  assert.equal(r2.ops.length, 0, 'nothing to record');
  // an older take-off that kept the date with its fraction: the same file still
  d.mtime = statSync(f).mtimeMs;
  const r3: any = await loadDrawing(d, userData, fakeEngine(), {});
  assert.equal(r3.fromCache, true);
});

test('an engine failure never costs this PC its copy (an earlier revision\'s is the only one)', async () => {
  const server = join(ROOT, 'server-rev');
  mkdirSync(server, { recursive: true });
  const cp = join(cacheRoot, 'pdf', H + '.pdf');
  mkdirSync(join(cacheRoot, 'pdf'), { recursive: true });
  writeFileSync(cp, fixture);
  const f = join(server, 'A-900.pdf');
  writeFileSync(f, Buffer.concat([fixture, Buffer.from('\n% rev B\n')])); // the path holds Rev B now
  const rev: any = { id: 'rv:1', path: f, unc: '', hash: H, size: fixture.length, mtime: 1 };
  // the real window-side engine client: it had a port, then the app gave up starting it again
  const e = new PdfEngine('draw', 'geo');
  const token = e.clients.draw.token;
  const { port1 } = new MessageChannel();
  (globalThis as any).window.postMessage({ type: 'gt-pdf-port', name: 'draw', restarted: false, code: 0, token }, '*', [port1]);
  (globalThis as any).window.postMessage({ type: 'gt-pdf-gaveup', name: 'draw', code: 71, token }, '*');
  assert.ok(e.dead);
  await assert.rejects(loadDrawing(rev, userData, e, { exact: true }), /keeps stopping|stopped/);
  await assert.rejects(loadDrawing({ ...rev, path: join(server, 'gone.pdf') }, userData, e, {}), /keeps stopping|stopped/);
  await sleep(100);
  port1.close();
  assert.ok(existsSync(cp), 'the copy is still there');
  assert.ok(readFileSync(cp).equals(fixture));
});

test('a port or "gave up" from an earlier start of the engines is not taken for the new one\'s', () => {
  const e = new PdfEngine('draw-2', null);
  const { port1, port2 } = new MessageChannel();
  (globalThis as any).window.postMessage({ type: 'gt-pdf-gaveup', name: 'draw-2', code: 71, token: 'an-earlier-start' }, '*');
  assert.equal(e.dead, false);
  (globalThis as any).window.postMessage({ type: 'gt-pdf-port', name: 'draw-2', restarted: true, code: 70, token: 'an-earlier-start' }, '*', [port1]);
  assert.equal(e.clients.draw.gen, 0, 'not attached');
  (globalThis as any).window.postMessage({ type: 'gt-pdf-port', name: 'draw-2', restarted: true, code: 70, token: e.clients.draw.token }, '*', [port2]);
  assert.equal(e.clients.draw.gen, 1, 'its own is');
  port2.close();
});

test('a damaged copy is set aside and replaced from the server, even one of the same size', async () => {
  const server = join(ROOT, 'server-dmg');
  mkdirSync(server, { recursive: true });
  const f = join(server, 'A-901.pdf');
  writeFileSync(f, fixture);
  const cp = join(cacheRoot, 'pdf', H + '.pdf');
  // main's 'keep' trusts a copy of that size; 'replace' (asked for after a damaged one) does not
  writeFileSync(cp, Buffer.alloc(fixture.length, 0));
  const k = await main.invoke('pdf:fetch', 'k1', f, cacheRoot, 'keep');
  assert.ok(!readFileSync(k.file).equals(fixture), "('keep' keeps the one there)");
  const r = await main.invoke('pdf:fetch', 'k2', f, cacheRoot, 'replace');
  assert.equal(r.file, cp);
  assert.ok(readFileSync(cp).equals(fixture), "'replace' puts the good bytes in place");
  // the whole way: damaged -> set aside -> read again -> opens; the set-aside copy goes
  writeFileSync(cp, Buffer.alloc(fixture.length, 0));
  const st = statSync(f);
  const d: any = { id: 'dwg:9', path: f, unc: '', hash: H, size: fixture.length, mtime: Math.round(st.mtimeMs) };
  const o: any = await loadDrawing(d, userData, fakeEngine(), {});
  assert.ok(!('missing' in o) && o.pages.length === 1, 'opens');
  assert.ok(readFileSync(cp).equals(fixture), 'this PC\'s copy is good again');
  await sleep(100);
  assert.ok(!existsSync(cp + '.bad'), 'the set-aside copy is dropped once a good one is in place');
  // the only copy (exact: an earlier revision) is never set aside
  writeFileSync(cp, Buffer.alloc(fixture.length, 0));
  await assert.rejects(loadDrawing(d, userData, fakeEngine(), { exact: true }));
  assert.ok(existsSync(cp));
  writeFileSync(cp, fixture);
});

test('main sets aside and reads only inside this PC\'s drawing cache', async () => {
  assert.equal(await main.invoke('pdf:setAside', join(userData, 'settings.json')), false);
  assert.equal(await main.invoke('pdf:setAside', join(cacheRoot, 'pdf', '..', '..', 'x.pdf')), false);
  await assert.rejects(main.invoke('pdf:fetch', 'k3', join(ROOT, 'server-dmg', 'A-901.pdf'), join(userData, 'not-qto-cache'), 'keep'), /not a drawing cache/);
  await assert.rejects(main.invoke('pdf:fetch', 'k4', join(ROOT, 'server-dmg', 'A-901.pdf'), join(userData, 'x', 'qto-cache'), 'keep'), /not a drawing cache/);
});

test('a read given up on is stopped (it leaves nothing behind)', async () => {
  const big = join(ROOT, 'big.bin');
  writeFileSync(big, Buffer.alloc(64 << 20, 7));
  const p = main.invoke('pdf:fetch', 'slow-1', big, cacheRoot, 'temp');
  assert.equal(await main.invoke('pdf:cancel', 'slow-1'), true);
  await assert.rejects(p, /was stopped/);
  assert.equal(await main.invoke('pdf:cancel', 'slow-1'), false, 'gone from the list');
  await sleep(200);
  assert.deepEqual(readdirSync(join(cacheRoot, 'tmp')).filter((n) => n.endsWith('.part')), []);
});

test('a file the PDF engine cannot open is let go (Windows could not replace it otherwise)', async () => {
  try { mustP(); } catch {
    const wasm = readFileSync(join(process.cwd(), 'node_modules/@embedpdf/pdfium/dist/pdfium.wasm'));
    await startEngine(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);
  }
  const d = mkdtempSync(join(tmpdir(), 'gtfd-'));
  const bad = join(d, 'damaged.pdf');
  writeFileSync(bad, Buffer.alloc(200000, 0x41));
  const fds = () => readdirSync('/proc/self/fd').length;
  const n0 = fds();
  for (let i = 0; i < 5; i++) assert.throws(() => openDoc('k' + i, new VFile({ path: bad })), /not a PDF or is damaged/);
  assert.equal(fds() - n0, 0);
});

test('the sheet on screen reads its own copy, not the background preparation\'s temp one', async () => {
  const key = 'f'.repeat(64);
  const tmpCopy = join(cacheRoot, 'tmp', 'mh3k2-1a2b3c4d.part');
  const kept = join(cacheRoot, 'pdf', key + '.pdf');
  // (main answers a job asked for twice once, to both)
  const waiting: (() => void)[] = [];
  const release = () => waiting.forEach((f) => f());
  const asked: boolean[] = [];
  hooks.heavy = (_s, _b, _m, _p, bg) => { asked.push(!!bg); return new Promise((r) => { waiting.push(() => r({ result: { pages: [], ms: 30000 }, error: '' })); }); };
  const bg = heavySrc(userData, key, tmpCopy, 95e6, undefined, undefined, true);
  await sleep(20);
  const front = heavySrc(userData, key, kept, 95e6);
  await sleep(20);
  release();
  const [b, f] = await Promise.all([bg, front]);
  hooks.heavy = undefined;
  assert.equal(b.src.path, tmpCopy);
  assert.equal(f.src.path, kept);
  assert.deepEqual(asked, [true, false], 'the sheet on screen asked for the same job to go first');
});

test('"Simplify the line work" says so when the page asked for was not simplified', async () => {
  const key = 'e'.repeat(64);
  const file = join(cacheRoot, 'pdf', key + '.pdf');
  mkdirSync(join(cacheRoot, 'heavy'), { recursive: true });
  writeFileSync(join(cacheRoot, 'heavy', key + '.delta'), 'x');
  writeFileSync(join(cacheRoot, 'heavy', key + '.json'), JSON.stringify({ v: 1, pages: [0], delta: key + '.delta', base: 40e6, at: 1 }));
  hooks.heavy = async (_s, outBase, mode, pages) => {
    assert.equal(mode, 'force');
    assert.deepEqual(pages, [0, 3]);
    writeFileSync(outBase + '.delta', 'y');
    return { result: { pages: [0], delta: outBase + '.delta', base: 40e6, ms: 1 }, error: '' };
  };
  await assert.rejects(heavySrc(userData, key, file, 40e6, undefined, [3]), /can't be simplified/);
  hooks.heavy = undefined;
});

test('a big-drawing check that failed is tried again at the next opening, then after an hour', async () => {
  const key = 'd'.repeat(64);
  const file = join(cacheRoot, 'pdf', key + '.pdf');
  let n = 0;
  hooks.heavy = async () => { n++; return { result: null, error: 'the check stopped (null) - not enough memory?' }; };
  const a = await heavySrc(userData, key, file, 95e6);
  assert.equal(a.src.path, file);
  const rec = JSON.parse(readFileSync(join(cacheRoot, 'heavy', key + '.json'), 'utf8'));
  assert.ok(rec.error && rec.pages.length === 0, 'kept with its error');
  await heavySrc(userData, key, file, 95e6);
  assert.equal(n, 2, 'tried once more at the next opening');
  assert.equal(JSON.parse(readFileSync(join(cacheRoot, 'heavy', key + '.json'), 'utf8')).tries, 2);
  await heavySrc(userData, key, file, 95e6);
  assert.equal(n, 2, 'then not at every opening');
  writeFileSync(join(cacheRoot, 'heavy', key + '.json'), JSON.stringify({ ...rec, tries: 2, at: Date.now() - 2 * 3600000 }));
  hooks.heavy = async () => { n++; return { result: { pages: [], ms: 9 }, error: '' }; };
  await heavySrc(userData, key, file, 95e6);
  assert.equal(n, 3, 'again after an hour');
  assert.ok(!JSON.parse(readFileSync(join(cacheRoot, 'heavy', key + '.json'), 'utf8')).error, 'and the good answer replaces it');
  hooks.heavy = undefined;
});

test('the sheet on screen\'s check does not wait behind the background preparation\'s', async () => {
  const ud = mkdtempSync(join(tmpdir(), 'gt-hc-'));
  mkdirSync(join(ud, 'qto-cache', 'heavy'), { recursive: true });
  const forks: { args: string[]; p: any }[] = [];
  const M = loadMain(ud, { onFork: (p: any) => forks.push({ args: p.args, p }) });
  const done = (i: number, result: unknown) => { forks[i].p.emit('message', { type: 'done', result, error: '' }); forks[i].p.emit('exit', 0); };
  const bg = M.invoke('pdf:heavy', { path: '/share/Monster strokes.pdf' }, join(ud, 'qto-cache', 'heavy', 'aaa'), 'check', [], true);
  await sleep(30);
  assert.equal(forks.length, 1);
  const front = M.invoke('pdf:heavy', { path: '/share/AR-00007.pdf' }, join(ud, 'qto-cache', 'heavy', 'bbb'), 'check', [], false);
  await sleep(30);
  assert.ok(forks[0].p.killed, 'the background check is stopped for it');
  assert.equal(forks.length, 2, 'the sheet\'s check starts at once');
  assert.ok(forks[1].args[1].endsWith('bbb'));
  done(1, { pages: [], ms: 5 });
  assert.deepEqual((await front).result, { pages: [], ms: 5 });
  await sleep(30);
  assert.equal(forks.length, 3, 'the background one is done after');
  assert.ok(forks[2].args[1].endsWith('aaa'));
  done(2, { pages: [0], ms: 29000 });
  assert.deepEqual((await bg).result, { pages: [0], ms: 29000 });
  // one job for the same drawing asked twice; asked by the sheet on screen, it goes first
  const b1 = M.invoke('pdf:heavy', { path: '/x/1.pdf' }, join(ud, 'qto-cache', 'heavy', 'c1'), 'check', [], true);
  const b2 = M.invoke('pdf:heavy', { path: '/x/2.pdf' }, join(ud, 'qto-cache', 'heavy', 'c2'), 'check', [], true);
  await sleep(10);
  const f2 = M.invoke('pdf:heavy', { path: '/x/2.pdf' }, join(ud, 'qto-cache', 'heavy', 'c2'), 'check', [], false);
  await sleep(10);
  assert.ok(forks[3].p.killed && forks[4].args[1].endsWith('c2'), 'c2 now goes first');
  done(4, { pages: [], ms: 1 });
  assert.deepEqual(await b2, await f2);
  await sleep(10);
  assert.ok(forks[5].args[1].endsWith('c1'));
  done(5, { pages: [], ms: 1 });
  await b1;
  assert.equal(forks.length, 6);
});

test('a slow read gives way to a newer sheet; it is stopped only when its sheet is not wanted any more', async () => {
  const server = join(ROOT, 'server-slow');
  mkdirSync(server, { recursive: true });
  const ds = [1, 2, 3, 4].map((i) => {
    const f = join(server, `A-90${i}.pdf`);
    writeFileSync(f, fixture);
    return { id: 'dwg:s' + i, path: f, unc: '', hash: '', size: fixture.length, mtime: Math.round(statSync(f).mtimeMs) } as any;
  });
  const ids: string[] = [];
  const ends: ((e: Error) => void)[] = [];
  hooks.fetch = (_s, _c, _m, id) => { ids.push(id); return new Promise((_, rej) => ends.push(rej)); };
  const cancels = () => calls.filter((c) => c.name === 'cancel').map((c) => c.args[0]);
  let want1 = true;
  const l1 = loadDrawing(ds[0], userData, fakeEngine(), { wanted: () => want1 }).catch((e) => e);
  const l2 = loadDrawing(ds[1], userData, fakeEngine(), { wanted: () => true }).catch((e) => e);
  await sleep(4200);
  want1 = false; // the user went on to another sheet
  const l3 = loadDrawing(ds[2], userData, fakeEngine(), { wanted: () => true }).catch((e) => e);
  await sleep(100);
  assert.equal(ids.length, 3, 'the newer sheet did not wait');
  assert.deepEqual(cancels(), [ids[0]], 'the read nobody waits for is stopped');
  await sleep(4000);
  const l4 = loadDrawing(ds[3], userData, fakeEngine(), { wanted: () => true }).catch((e) => e);
  await sleep(100);
  assert.equal(ids.length, 4);
  assert.deepEqual(cancels(), [ids[0]], 'a sheet still waited for is read on (only no longer holding up the others)');
  hooks.fetch = undefined;
  for (const f of ends) f(new Error('test over'));
  await Promise.all([l1, l2, l3, l4]);
});

test('a drawing whose file itself is broken is not read from the server again at every click', async () => {
  const server = join(ROOT, 'server-broken');
  mkdirSync(server, { recursive: true });
  const f = join(server, 'A-950.pdf');
  const broken = Buffer.concat([Buffer.from('%PDX'), fixture.subarray(4)]); // the server's file is bad too
  writeFileSync(f, broken);
  const h = createHash('sha256').update(broken).digest('hex');
  const cp = join(cacheRoot, 'pdf', h + '.pdf');
  writeFileSync(cp, broken);
  const st = statSync(f);
  const d: any = { id: 'dwg:b', path: f, unc: '', hash: h, size: broken.length, mtime: Math.round(st.mtimeMs) };
  // (PDFium's answer; the header sniff passes it on as not a picture)
  const engine: any = { converted: new Map(), load: async () => { throw new Error('This file is not a PDF or is damaged.'); } };
  const n0 = fetches();
  await assert.rejects(loadDrawing(d, userData, engine, {}), /not a PDF or is damaged|This is not a PDF/);
  assert.equal(fetches() - n0, 1, 'read again once (this PC\'s copy might have been the bad one)');
  await sleep(100);
  assert.ok(existsSync(cp) && !existsSync(cp + '.bad'), 'the copy is in place, nothing left set aside');
  await assert.rejects(loadDrawing(d, userData, engine, {}), /not a PDF or is damaged|This is not a PDF/);
  assert.equal(fetches() - n0, 1, 'not again');
});

test('a pipe or a folder named .pdf is refused at once (opening a pipe would wait for ever, and keep the app open)', async () => {
  const { execFileSync } = await import('node:child_process');
  const fifo = join(ROOT, 'pipe.pdf');
  execFileSync('mkfifo', [fifo]);
  const t0 = Date.now();
  await assert.rejects(main.invoke('pdf:fetch', 'fifo-1', fifo, cacheRoot, 'keep'), /not a drawing file/);
  mkdirSync(join(ROOT, 'folder.pdf'));
  await assert.rejects(main.invoke('pdf:fetch', 'dir-1', join(ROOT, 'folder.pdf'), cacheRoot, 'keep'), /not a drawing file/);
  assert.ok(Date.now() - t0 < 2000);
});

test('a sheet clicked again while it is still being read waits for that read (one read, one copy)', async () => {
  const server = join(ROOT, 'server-dup');
  mkdirSync(server, { recursive: true });
  const f = join(server, 'A-960.pdf');
  writeFileSync(f, fixture);
  const d: any = { id: 'dwg:dup', path: f, unc: '', hash: '', size: fixture.length, mtime: Math.round(statSync(f).mtimeMs) };
  let release!: () => void;
  const real = hooks.fetch;
  let n = 0;
  hooks.fetch = (src, cache, mode, id) => { n++; return new Promise((r) => { release = () => r(main.invoke('pdf:fetch', id, src, cache, mode)); }); };
  const a = loadDrawing(d, userData, fakeEngine(), {});
  await sleep(30);
  const b = loadDrawing(d, userData, fakeEngine(), {});
  const bg = loadDrawing(d, userData, fakeEngine(), { cache: false, bg: true });
  await sleep(30);
  release();
  const [ra, rb, rc]: any[] = await Promise.all([a, b, bg]);
  hooks.fetch = real;
  assert.equal(n, 1, 'read once');
  assert.equal(ra.file, rb.file);
  assert.equal(rc.file, ra.file, 'the background preparation uses this PC\'s copy too');
  assert.equal(rc.dispose, undefined, '...and does not drop it');
});

test('a file saved over while it was read is read again', async () => {
  const server = join(ROOT, 'server-chg');
  mkdirSync(server, { recursive: true });
  const f = join(server, 'A-961.pdf');
  writeFileSync(f, fixture);
  const d: any = { id: 'dwg:chg', path: f, unc: '', hash: '', size: fixture.length, mtime: Math.round(statSync(f).mtimeMs) };
  let n = 0;
  hooks.fetch = (src, cache, mode, id) => { n++; return n === 1 ? Promise.reject(new Error('A-961.pdf changed while it was being read (saved again meanwhile). Open the sheet again.')) : main.invoke('pdf:fetch', id, src, cache, mode); };
  const r: any = await loadDrawing(d, userData, fakeEngine(), {});
  hooks.fetch = undefined;
  assert.equal(n, 2);
  assert.ok(r.pages?.length === 1);
});

test('a measured sheet whose file was replaced by one that will not open shows this PC\'s copy of the measured one', async () => {
  const server = join(ROOT, 'server-garbage');
  mkdirSync(server, { recursive: true });
  const f = join(server, 'A-970.pdf');
  writeFileSync(join(cacheRoot, 'pdf', H + '.pdf'), fixture); // the measured version, on this PC
  writeFileSync(f, Buffer.from('<html><body>Sorry, the file you asked for is not here</body></html>'));
  const d: any = { id: 'dwg:g', path: f, unc: '', hash: H, size: fixture.length, mtime: 1 };
  const r: any = await loadDrawing(d, userData, fakeEngine(), {});
  assert.equal(r.key, H);
  assert.equal(r.fromCache, true);
  assert.ok(/not a PDF/.test(r.bad), r.bad);
  assert.equal(r.changed, false);
});

test('trimming: a monster sheet\'s record and its files go together, the one used last never, leftovers after an hour', async () => {
  const { truncateSync } = await import('node:fs');
  const ud = mkdtempSync(join(tmpdir(), 'gt-trim-'));
  const h = join(ud, 'qto-cache', 'heavy');
  mkdirSync(h, { recursive: true });
  const old = Date.now() / 1000 - 3 * 3600;
  // an older sheet's (200 MB) and the newest (600 MB: past the heavy limit by itself) - sparse files
  for (const [k, mb, at] of [['a'.repeat(64), 200, old], ['b'.repeat(64), 600, old + 3600]] as const) {
    truncateSync((writeFileSync(join(h, k + '-x.delta'), ''), join(h, k + '-x.delta')), mb * 1e6);
    writeFileSync(join(h, k + '.json'), JSON.stringify({ v: 1, pages: [0], delta: k + '-x.delta', base: 1, at: 1 }));
    for (const f of [k + '-x.delta', k + '.json']) utimesSync(join(h, f), at, at);
  }
  // the newest sheet's earlier simplification (no record names it any more), and one just written
  writeFileSync(join(h, 'b'.repeat(64) + '-old.delta'), 'x');
  utimesSync(join(h, 'b'.repeat(64) + '-old.delta'), old, old);
  writeFileSync(join(h, 'c'.repeat(64) + '-new.delta'), 'x');
  // 0.23.2 (DeepSeek #25): a record cut short (a crash while it was written) does not stop the trim
  writeFileSync(join(h, 'd'.repeat(64) + '.json'), '{"v":1,"pag');
  utimesSync(join(h, 'd'.repeat(64) + '.json'), old, old);
  await trimCache(ud, 1.2e9); // heavy limit = 1/3: 400 MB
  const left = readdirSync(h).sort();
  assert.ok(!left.some((f) => f.startsWith('a')), 'the older group went, record and file together: ' + left.join(', '));
  assert.ok(left.includes('b'.repeat(64) + '.json') && left.includes('b'.repeat(64) + '-x.delta'), 'the one used last stays, however big');
  assert.ok(!left.includes('b'.repeat(64) + '-old.delta'), 'a leftover no record names: gone after an hour');
  assert.ok(left.includes('c'.repeat(64) + '-new.delta'), '...not before (a job may be about to name it)');
});

test('0.14.0 review: a program named as a drawing is never read into this PC\'s drawing cache', async () => {
  const server = join(ROOT, 'server-exe');
  mkdirSync(server, { recursive: true });
  const f = join(server, 'A-990 Plan.pdf');
  writeFileSync(f, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4096, 7)]));
  const before = existsSync(join(cacheRoot, 'tmp')) ? readdirSync(join(cacheRoot, 'tmp')).length : 0;
  await assert.rejects(main.invoke('pdf:fetch', 'exe-1', f, cacheRoot, 'keep'), /is a program, not a drawing/);
  await sleep(100);
  const after = existsSync(join(cacheRoot, 'tmp')) ? readdirSync(join(cacheRoot, 'tmp')).length : 0;
  assert.equal(after, before);
  const pdfs = existsSync(join(cacheRoot, 'pdf')) ? readdirSync(join(cacheRoot, 'pdf')) : [];
  assert.equal(pdfs.some((n) => n.startsWith(createHash('sha256').update(readFileSync(f)).digest('hex'))), false);
});

// 0.23.2 (DeepSeek #0): a read the server never finishes ("too long") said so - it was taken for "stopped,
// nobody waiting" and read again from byte 0, for ever
test('a read that takes too long ends with the network message, not a new read', async () => {
  const { readLimits } = await import('../src/ui/takeoff/drawings');
  const server = join(ROOT, 'server-stall');
  mkdirSync(server, { recursive: true });
  const f = join(server, 'A-901 Stalled.pdf');
  copyFileSync(join(process.cwd(), 'tests/fixtures/snap-shapes.pdf'), f);
  const d: any = { id: 'dwg:stall', path: f, unc: '', hash: '', size: statSync(f).size, mtime: Math.round(statSync(f).mtimeMs) };
  const was = readLimits.ms;
  readLimits.ms = 300;
  hooks.fetch = () => new Promise(() => {}); // the server never answers
  const n0 = fetches();
  try {
    await assert.rejects(loadDrawing(d, userData, fakeEngine(), {}), /did not answer/);
    await sleep(500);
    assert.equal(fetches() - n0, 1, 'read once, given up once');
  } finally { hooks.fetch = undefined; readLimits.ms = was; }
});

// 0.23.2 (DeepSeek #23, #24)
test('a page of no size is a plain error (not "out of memory"); a document whose page can\'t be read is let go again', async () => {
  const pf = await import('../src/ui/takeoff/pdfcore');
  const wasm = readFileSync(join(process.cwd(), 'node_modules/@embedpdf/pdfium/dist/pdfium.wasm'));
  try { mustP(); } catch { await startEngine(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer); }
  const ok = readFileSync(join(process.cwd(), 'tests/fixtures/snap-shapes.pdf'));
  openDoc('z0', ok.buffer.slice(ok.byteOffset, ok.byteOffset + ok.byteLength) as ArrayBuffer);
  let err: any = null;
  try { pf.renderRaw(pf.docs.get('z0')!, 0, 1, 0, 0, 0, 0, 1); } catch (e) { err = e; }
  assert.ok(err && /no size/.test(err.message), String(err?.message));
  assert.equal(pf.isFatal(err), false, 'the engine is not taken down for it');
  pf.closeDoc('z0');
  const bad = readFileSync(join(process.cwd(), 'tests/fixtures/bad-page-tree.pdf'));
  assert.throws(() => openDoc('zb', bad.buffer.slice(bad.byteOffset, bad.byteOffset + bad.byteLength) as ArrayBuffer), /Could not read page/);
  assert.equal(pf.docs.has('zb'), false, 'not left open');
});
