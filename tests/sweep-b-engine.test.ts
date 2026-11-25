// Sweep B 15 (release candidate 0.23.0): calls waiting for an engine that went down are told to ask again -
// and are not ALSO sent to the new engine (a render the window gave up on, done for nothing; the very
// call that took the engine down, run twice). The window's engine client on a stand-in engine.
import './harness/window';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { PdfEngine } from '../src/ui/takeoff/pdfengine';

after(() => { setTimeout(() => process.exit(), 300).unref(); });
const win = (globalThis as any).window;
function toWindow(name: string, token: string, restarted = false, code = 0) {
  const { port1, port2 } = new MessageChannel();
  win.postMessage({ type: 'gt-pdf-port', name, restarted, code, token }, '*', [port2]);
  return port1;
}

test('15: a call that waited for an engine that went down is asked again by its caller, never sent to the new engine as well', async () => {
  const was = win.gt.pdf.restart;
  win.gt.pdf.restart = async () => true;
  try {
    const e = new PdfEngine('w15', null);
    const c = e.clients.draw;
    const p1 = toWindow('w15', c.token);
    p1.on('message', (m: any) => { if (m.t !== 'config') p1.postMessage({ id: m.id, ok: true }); });
    assert.equal((await c.call('heap')).ok, true);
    // the engine is being replaced (no port): a render waits for the next one
    c.replace('test');
    const waiting = c.call('render', { key: 'sheet-1', pg: 0 });
    // ...which comes up in place of one that went down
    const got: any[] = [];
    const p2 = toWindow('w15', c.token, true, 70);
    p2.on('message', (m: any) => { got.push(m); if (m.t !== 'config') p2.postMessage({ id: m.id, ok: true }); });
    await assert.rejects(waiting, (err: any) => err.retry === true);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(got.filter((m) => m.t !== 'config').map((m) => m.t), [], 'the new engine is not asked for it as well');
    assert.equal((await c.call('heap')).ok, true, 'the new engine answers');
    p1.close(); p2.close();
    c.fail('test over');
  } finally { win.gt.pdf.restart = was; }
});
