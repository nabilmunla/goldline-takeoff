// Engine hardening (as the PDF Editor 0.12): a drawing engine that went down is started again quietly
// at most twice in 10 minutes, then the person is told (once); one that stops answering is replaced
// and that is said and logged; an idle engine that has grown big gives its memory back. The window's
// own engine client (ui/takeoff/pdfengine.ts) on stand-in engines (message ports answered here).
import { calls } from './harness/window';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { PdfEngine, engineNotices } from '../src/ui/takeoff/pdfengine';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
after(() => { setTimeout(() => process.exit(), 300).unref(); });
const win = (globalThis as any).window;
/** a port to the window, as the app hands one over (restarted: a new engine in place of the old) */
function toWindow(name: string, token: string, restarted = false, code = 0) {
  const { port1, port2 } = new MessageChannel();
  win.postMessage({ type: 'gt-pdf-port', name, restarted, code, token }, '*', [port2]);
  return port1;
}
/** a stand-in engine that answers everything at once with the memory it is said to hold */
function engine(p: any, heap: () => number) {
  p.on('message', (m: any) => { if (m.t !== 'config' && m.t !== 'hang') p.postMessage({ id: m.id, ok: true, heap: heap(), recycle: 1434 }); });
  return p;
}
const notices: string[] = [];
const listen = (t: string) => notices.push(t);
engineNotices.add(listen);
const logs = () => calls.filter((c) => c.name === 'log').map((c) => String(c.args[0]));
async function withRestarts<T>(f: (restarted: string[]) => Promise<T>): Promise<T> {
  const was = win.gt.pdf.restart;
  const restarted: string[] = [];
  win.gt.pdf.restart = async (n: string) => { restarted.push(n); return true; };
  try { return await f(restarted); } finally { win.gt.pdf.restart = was; }
}

test('an engine that goes down is started again quietly twice in 10 minutes; the third time the person is told, once; planned fresh engines never count', async () => {
  const e = new PdfEngine('draw', null);
  const c = e.clients.draw;
  let p = engine(toWindow('draw', c.token), () => 50);
  assert.equal((await c.call('heap')).ok, true);
  notices.length = 0;
  // two that went down (out of memory, killed): nothing said, both logged
  for (const code of [70, 0]) { p.close(); p = engine(toWindow('draw', c.token, true, code), () => 50); }
  assert.equal((await c.call('heap')).ok, true, 'the new engine answers');
  assert.deepEqual(notices, [], 'quiet');
  assert.ok(logs().some((l) => /pdf engine draw out of memory or failed inside: started again \(1 in the last 10 minutes\)/.test(l)), 'logged');
  assert.ok(logs().some((l) => /pdf engine draw stopped: started again \(2 in the last 10 minutes\)/.test(l)));
  // planned fresh engines (its memory had grown): not counted
  for (let k = 0; k < 3; k++) { p.close(); p = engine(toWindow('draw', c.token, true, 75), () => 50); }
  assert.deepEqual(notices, [], 'planned ones are no failure');
  // the third that went down: said
  p.close(); p = engine(toWindow('draw', c.token, true, 70), () => 50);
  assert.equal(notices.length, 1, 'said: ' + notices.join(' | '));
  assert.match(notices[0], /^The drawing engine stopped 3 times in the last 10 minutes and was started again each time - nothing was lost\./);
  assert.ok(logs().some((l) => l.startsWith('drawing engines: The drawing engine stopped 3 times')), 'and logged');
  // a fourth soon after: not said again (once in 10 minutes)
  p.close(); p = engine(toWindow('draw', c.token, true, 70), () => 50);
  assert.equal(notices.length, 1);
  assert.equal((await c.call('heap')).ok, true, 'still started again, still answering');
  // another engine keeps its own count
  const g = new PdfEngine('geo', null).clients.draw;
  let q = engine(toWindow('geo', g.token), () => 50);
  q.close(); q = engine(toWindow('geo', g.token, true, 70), () => 50);
  assert.equal(notices.length, 1);
  p.close(); q.close();
  c.fail('test over'); g.fail('test over');
});

test('an idle engine that has grown big gives its memory back (a fresh one); a small one, or one in use, keeps it', async () => {
  await withRestarts(async (restarted) => {
    const e = new PdfEngine('idle-a', null);
    const c = e.clients.draw;
    c.idleMs = 120;
    c.idleBigMB = 600;
    let heap = 300;
    const p = engine(toWindow('idle-a', c.token), () => heap);
    await c.call('render');
    await sleep(250);
    assert.deepEqual(restarted, [], 'small: kept');
    heap = 900;
    await c.call('render');
    // in use: each call starts the wait again
    for (let k = 0; k < 4; k++) { await sleep(60); await c.call('render'); }
    assert.deepEqual(restarted, [], 'in use: kept');
    await sleep(250);
    assert.deepEqual(restarted, ['idle-a'], 'idle and big: a fresh engine in its place');
    assert.ok(logs().some((l) => /pdf engine idle-a: idle 0 s at 900 MB: its memory given back - starting a fresh one/.test(l)), 'logged');
    // the fresh one takes over: what is asked now goes to it, nothing lost
    const fresh = engine(toWindow('idle-a', c.token, true, 75), () => 40);
    assert.equal((await c.call('render')).heap, 40);
    assert.equal(c.heap, 40);
    p.close(); fresh.close();
    c.fail('test over');
  });
});

test('an engine that stops answering is replaced, and that is said (whatever asked) and logged', async () => {
  await withRestarts(async (restarted) => {
    const e = new PdfEngine('hang-x', null);
    const c = e.clients.draw;
    c.hangMs = 200;
    notices.length = 0;
    const p = engine(toWindow('hang-x', c.token), () => 50);
    // a background step that never comes back (its caller ignores the failure)
    c.call('hang').catch(() => null);
    await sleep(500);
    assert.deepEqual(restarted, ['hang-x'], 'replaced');
    assert.equal(notices.length, 1);
    assert.match(notices[0], /stopped answering \(\d+ s on a sheet\), so a fresh one was started/);
    assert.ok(logs().some((l) => /drawing engines: The drawing engine stopped answering/.test(l)));
    p.close();
    c.fail('test over');
  });
});
