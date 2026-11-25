/// <reference types="node" />
// A PDF engine in its own background process (an Electron utility process - as the PDF Editor
// does it). Drawings are read from disk on demand (files.ts): nothing of a drawing passes through
// the window, and a sheet that runs an engine out of memory takes down only this process - the
// app starts a new one and the sheet is asked again.
//
//   dist/engine/pdf-host.mjs <engine folder> <pages kept>
//
// Calls arrive on a message port from the window: { id, t, ...args } - answered one at a time, in
// order (PDFium is single-threaded), every answer with the engine's memory (MB) and its planned
// recycle point (MB) so the window can start a fresh engine in time. A newer render for the same
// slot makes a queued one pointless.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VFile, isFileSrc } from './files';
import { startEngine, openDoc, closeDoc, docs, renderRaw, pageText, pageWords, buildSnap, snap, heapMB, isFatal, setMaxPages, memoryLimit } from '../../ui/takeoff/pdfcore';

interface PortMain { on(ev: 'message', f: (e: { data: any }) => void): void; on(ev: 'close', f: () => void): void; postMessage(m: unknown): void; start(): void }
const parentPort = (process as unknown as { parentPort: { on(ev: 'message', f: (e: { data: any; ports: PortMain[] }) => void): void; postMessage(m: unknown): void } }).parentPort;

const dir = process.argv[2] || '.';
const keep = Number(process.argv[3]) || 2;

/** what each open drawing is read from (the tests' "out of memory" sheet) */
const srcPath = new Map<string, string>();

/** after the engine failed inside (out of memory...) nothing more is tried here: the app starts a new one */
let broken: string | null = null;

/**
 * WebAssembly memory only ever grows: an engine that has grown large is replaced by a fresh one (a
 * fraction of a second; the drawings are opened in it again when next needed). The engine may grow to
 * 4 GB (tools/patch-pdfium.mjs; 2 GB up to 0.22: a sheet that needed more stopped the engine mid-call,
 * twice, and was "too heavy"). As the PDF Editor 0.9.7 - 0.12:
 *  - the planned recycle point (RECYCLE): 40 % of the PC's memory shared by the window's three drawing
 *    engines (draw, geo, bg), at least 1.4 GB (the point the Editor used inside its 2 GB ceiling), at
 *    most 3 GB, and never closer than 0.2 GB to the ceiling (a .wasm that could not be lifted stops at
 *    2 GB). Sent with every answer: the window replaces an engine past it at a natural pause - a sheet
 *    change (pdfengine.ts; 600 MB up to 0.22). A single page that needs more still gets it: this is
 *    when to start afresh, not a limit.
 *  - near the ceiling (HARD: the ceiling less 0.5 GB), here, after the call that took it there: the
 *    call is answered, then the engine ends (exit 75, planned) - the next page never starts with less
 *    room than that. Not straight after starting (a page that needs that much would loop): 30 s,
 *    twice that for each planned restart of this engine in the last 10 minutes (the window counts
 *    them and says so: 'config'). (The Editor does this at RECYCLE; a take-off works on one heavy
 *    sheet for a long time - restarting under it every 30 s would read it in again and again.)
 */
const ENGINES = 3;
const RECYCLE_MB = Math.round(Math.min(3 * 1024, Math.max(1.4 * 1024, (os.totalmem() / 2 ** 20) * 0.4 / ENGINES)));
/** the planned recycle point for an engine whose memory can grow to `limitMB` (GT_RECYCLE_AT: tests) */
export const recycleAtFor = (limitMB: number, at = Number(process.env.GT_RECYCLE_AT) || RECYCLE_MB) => Math.round(Math.min(at, limitMB - 0.2 * 1024));
/** the point past which the engine ends after answering (MB) */
export const hardAtFor = (limitMB: number) => Number(process.env.GT_RECYCLE_HARD) || Math.round(limitMB - 512);
/** planned restarts of this engine in the last 10 minutes (the window says: 'config') */
let recycles = 0;
/** seconds an engine is up before it may end near its ceiling (GT_RECYCLE_MINUP: tests) */
const minUp = () => (process.env.GT_RECYCLE_MINUP !== undefined ? Number(process.env.GT_RECYCLE_MINUP) : 30) * 2 ** Math.min(4, recycles);
/** ending (planned): the calls still queued are not run - the window asks the fresh engine */
let exiting = false;
const limitMB = () => memoryLimit() / 2 ** 20;

async function start() {
  const wasm = fs.readFileSync(path.join(dir, 'pdfium.wasm'));
  await startEngine(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);
  setMaxPages(keep);
}

type Msg = { id: number; t: string; [k: string]: any };

function handle(msg: Msg, port: PortMain) {
  const post = (m: Record<string, unknown>) => { try { port.postMessage({ ...m, heap: heapMB(), recycle: recycleAtFor(limitMB()) }); } catch { /* the window went away */ } };
  const { id, t } = msg;
  if (broken) { post({ id, ok: false, error: broken, fatal: true }); return; }
  try {
    switch (t) {
      case 'open': {
        if (!isFileSrc(msg.file)) throw new Error('no file');
        // already open: no reader needed (openDoc closes it)
        srcPath.set(msg.key, msg.file.path);
        const r = openDoc(msg.key, docs.has(msg.key) ? new ArrayBuffer(0) : new VFile(msg.file));
        post({ id, ok: true, ...r });
        return;
      }
      case 'render': {
        const d = docs.get(msg.key);
        if (!d) throw new Error('not open');
        // (tests: a sheet that runs the engine out of memory until its line work is simplified)
        const oom = process.env.GT_TEST_OOM;
        // (simplified: read as drawing + changes, or a whole new file in the heavy folder)
        if (oom && msg.key.startsWith(oom) && !((d.reader as VFile | null)?.parts?.length === 2) && !/[\\/]heavy[\\/]/.test(srcPath.get(msg.key) ?? '')) throw new WebAssembly.RuntimeError('Aborted(Cannot enlarge memory) (test)');
        const t0 = performance.now();
        const px = renderRaw(d, msg.pg, msg.scale, msg.x, msg.y, msg.w, msg.h, msg.quality ?? 1);
        post({ id, ok: true, px, w: msg.w, h: msg.h, ms: performance.now() - t0 });
        return;
      }
      case 'text': {
        const d = docs.get(msg.key);
        if (!d) throw new Error('not open');
        post({ id, ok: true, text: pageText(d, msg.pg) });
        return;
      }
      case 'words': {
        const d = docs.get(msg.key);
        if (!d) throw new Error('not open');
        post({ id, ok: true, words: pageWords(d, msg.pg) });
        return;
      }
      case 'snapIndex': {
        const d = docs.get(msg.key);
        if (!d) throw new Error('not open');
        const t0 = performance.now();
        let ix = d.snap.get(msg.pg);
        if (!ix) { ix = buildSnap(d, msg.pg); d.snap.set(msg.pg, ix); }
        post({ id, ok: true, n: ix.n, ms: performance.now() - t0 });
        return;
      }
      case 'snap': {
        const ix = docs.get(msg.key)?.snap.get(msg.pg);
        const near: number[] | undefined = msg.near ? [] : undefined;
        post({ id, ok: true, hit: ix ? snap(ix, msg.x, msg.y, msg.r, near) : null, near });
        return;
      }
      case 'close':
        closeDoc(msg.key);
        post({ id, ok: true });
        return;
      case 'heap':
        post({ id, ok: true, rss: Math.round(process.memoryUsage().rss / 1048576), limit: Math.round(limitMB()), hard: hardAtFor(limitMB()), minUp: minUp() });
        return;
      case 'fail':
        // (tests: the engine failing inside, as it does out of memory on a heavy sheet)
        throw new WebAssembly.RuntimeError('unreachable (test)');
      case 'hang': {
        // (tests only: a call inside the PDF library that never returns - the window must notice the
        // engine has stopped answering and replace it. Not a request the app ever makes.)
        if (process.env.GT_TEST_HANG !== '1') break;
        const until = Date.now() + (Number(msg.ms) || 3_600_000);
        while (Date.now() < until) { /* stuck, as PDFium would be: nothing else runs in this process */ }
        post({ id, ok: true });
        return;
      }
    }
    throw new Error('unknown request ' + t);
  } catch (e: any) {
    const fatal = isFatal(e);
    if (fatal) broken = String(e?.message ?? e);
    post({ id, ok: false, error: String(e?.message ?? e), fatal });
    // broken now: answered, then gone - the app starts a new engine and the window asks again
    if (fatal) setTimeout(() => process.exit(70), 50);
  }
}

/** after a call: an engine that has come near its ceiling ends now (answered, planned) */
function afterCall() {
  if (exiting || broken) return;
  const heap = heapMB(), hard = hardAtFor(limitMB());
  if (heap <= hard || process.uptime() < minUp()) return;
  exiting = true;
  console.error(`drawing engine at ${heap} MB (its ceiling ${Math.round(limitMB())} MB): a fresh one takes over`);
  setTimeout(() => process.exit(75), 20);
}

const ready = start();
const latestSlot = new Map<string, number>();
let chain: Promise<void> = Promise.resolve();

function serve(port: PortMain) {
  port.on('message', (e) => {
    const msg = e.data as Msg;
    if (!msg || typeof msg.id !== 'number') return;
    // (what the window knows about this engine: taken at once, never answered)
    if (msg.t === 'config') { recycles = Math.max(0, Number(msg.recycles) || 0); return; }
    if (msg.t === 'render' && msg.slot) latestSlot.set(msg.slot, msg.id);
    chain = chain.then(async () => {
      await ready;
      // (ending: not run here - the window asks the fresh engine)
      if (exiting) return;
      if (msg.t === 'render' && msg.slot && latestSlot.get(msg.slot) !== msg.id) {
        try { port.postMessage({ id: msg.id, ok: false, error: 'superseded', superseded: true, heap: heapMB() }); } catch { /* gone */ }
        return;
      }
      handle(msg, port);
      afterCall();
    }).catch((err) => {
      // (the chain must never stay rejected: every later call would be skipped)
      console.error('engine call failed outside its handler: ' + String(err?.message ?? err));
    });
  });
  port.start();
}

parentPort.on('message', (e) => {
  if (e.data && e.data.type === 'port' && e.ports && e.ports[0]) serve(e.ports[0]);
});
ready.then(() => parentPort.postMessage({ type: 'ready', pid: process.pid }), (err) => {
  parentPort.postMessage({ type: 'failed', error: String((err && err.stack) || err) });
  setTimeout(() => process.exit(71), 50);
});
