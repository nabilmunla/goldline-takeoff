// 0.15.0 fixes in the app's shell (electron/main.cjs) and the window's handle on the PDF engines,
// from DeepSeek's 0.14.0 bug log: BH-001 (log size, problem report), BH-002 (a damaged settings
// file), BH-003 (a settings write that fails), BH-033 (an engine that stops answering).
// The window stand-in first: it must be in place before anything from src/ui is loaded.
import { calls } from './harness/window';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { PdfEngine } from '../src/ui/takeoff/pdfengine';

const require = createRequire(import.meta.url);
const loadMain = require('./harness/main.cjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newProfile = () => { const d = join(mkdtempSync(join(tmpdir(), 'gt15shell-')), 'userData'); mkdirSync(d, { recursive: true }); return d; };
const logOf = (ud: string) => { try { return readFileSync(join(ud, 'logs', 'app.log'), 'utf8'); } catch { return ''; } };
const GOOD = { dataRoot: '\\\\srv\\tenders\\Goldline Takeoff', lastUsername: 'nabil', theme: 'dark', accBackups: 'D:\\acc-backups', width: 1600, height: 900 };

// ---------------------------------------------------------------- BH-002 / BH-003: settings
test('BH-002: a settings file found damaged while the app runs - the settings in use go on, the next save does not wipe them', async () => {
  const ud = newProfile();
  const sp = join(ud, 'settings.json');
  writeFileSync(sp, JSON.stringify(GOOD, null, 2));
  const M = loadMain(ud);
  assert.equal((await M.invoke('app:info')).dataRoot, GOOD.dataRoot);
  writeFileSync(sp, readFileSync(sp, 'utf8').slice(0, 40)); // cut short
  const i2 = await M.invoke('app:info');
  assert.equal(i2.dataRoot, GOOD.dataRoot, 'the shared folder is not lost');
  assert.equal(i2.lastUsername, 'nabil');
  assert.equal(i2.accBackups, GOOD.accBackups);
  assert.match(String(i2.settingsNote), /could not be read/, 'said once on the screen');
  assert.equal((await M.invoke('app:info')).settingsNote, null, 'once');
  const bad = readdirSync(ud).filter((f) => f.startsWith('settings.json.bad-'));
  assert.equal(bad.length, 1, 'the damaged file is kept aside');
  assert.equal(readFileSync(join(ud, bad[0]), 'utf8').length, 40);
  assert.match(logOf(ud), /settings\.json is damaged/);
  await M.invoke('settings:set', { theme: 'light' });
  const now = JSON.parse(readFileSync(sp, 'utf8'));
  assert.equal(now.dataRoot, GOOD.dataRoot, 'the next save keeps everything');
  assert.equal(now.theme, 'light');
});

test('BH-002: a settings file found damaged at a start - the copy kept at the last good save is used', async () => {
  const ud = newProfile();
  const sp = join(ud, 'settings.json');
  const M1 = loadMain(ud);
  await M1.invoke('settings:set', GOOD);
  assert.ok(existsSync(sp + '.bak'), 'a copy of the last good settings is kept');
  writeFileSync(sp, '{"dataRoot": "\\\\\\\\srv'); // damaged between two runs
  const M2 = loadMain(ud); // the next start
  const i = await M2.invoke('app:info');
  assert.equal(i.dataRoot, GOOD.dataRoot);
  assert.equal(i.theme, 'dark');
  assert.match(String(i.settingsNote), /last good copy/);
  // a PC that never had settings is still a new PC, with nothing to say
  const M3 = loadMain(newProfile());
  const n = await M3.invoke('app:info');
  assert.equal(n.lastUsername, null);
  assert.equal(n.settingsNote, null);
});

test('BH-003: a settings file that can\'t be written makes the save say so instead of throwing (the close goes on)', async () => {
  const ud = newProfile();
  mkdirSync(join(ud, 'settings.json')); // stands in for: the disk full, the profile's server away, antivirus holding it
  const M = loadMain(ud);
  const r = await M.invoke('settings:set', { theme: 'light' });
  assert.equal(r, false, 'not saved - and no exception');
  assert.match(logOf(ud), /settings could not be saved/);
  // the app goes on with what it was told
  assert.equal((await M.invoke('app:info')).theme, 'light');
});

// ---------------------------------------------------------------- BH-001: the log
test('BH-001: the log starts again past 10 MB (the one before kept), and the problem report reads only its end', async () => {
  const ud = newProfile();
  const M = loadMain(ud);
  const logs = join(ud, 'logs');
  mkdirSync(logs, { recursive: true });
  const line = new Date().toISOString() + ' renderer: sheet A-101 GA PLAN LEVEL 01.pdf ready in 412 ms (local copy)\n';
  const fd = openSync(join(logs, 'app.log'), 'w');
  const chunk = Buffer.from(line.repeat(10000));
  for (let n = 0; n < 11e6; n += chunk.length) writeSync(fd, chunk);
  writeSync(fd, Buffer.from('2026-10-29T10:00:00.000Z the last line before\n'));
  closeSync(fd);
  M.listeners.get('log')({}, 'the first line after');
  assert.ok(statSync(join(logs, 'app.old.log')).size > 10e6, 'the full one is kept as app.old.log');
  assert.ok(statSync(join(logs, 'app.log')).size < 1000, 'app.log starts again');
  const r = await M.invoke('app:report');
  const tail = String(r.log).trim().split('\n');
  assert.ok(tail.length <= 400 && tail.length > 300, 'the last lines: ' + tail.length);
  assert.match(tail[tail.length - 1], /renderer: the first line after/);
  assert.match(tail[tail.length - 2], /the last line before/, 'the end of the one before comes first');
});

test('BH-001: the problem report on a big log reads only its end, quickly', async () => {
  const ud = newProfile();
  const M = loadMain(ud);
  const logs = join(ud, 'logs');
  mkdirSync(logs, { recursive: true });
  const line = 'x'.repeat(90) + '\n';
  const fd = openSync(join(logs, 'app.log'), 'w');
  const chunk = Buffer.from(line.repeat(20000));
  for (let n = 0; n < 60e6; n += chunk.length) writeSync(fd, chunk);
  writeSync(fd, Buffer.from('the very last line\n'));
  closeSync(fd);
  const t0 = performance.now();
  const r = await M.invoke('app:report');
  const ms = performance.now() - t0;
  const tail = String(r.log).split('\n');
  assert.ok(tail.length <= 400);
  assert.ok(tail.includes('the very last line'));
  assert.ok(ms < 200, 'not the whole file: ' + Math.round(ms) + ' ms');
});

// ---------------------------------------------------------------- BH-033: an engine that stops answering
const win = (globalThis as any).window;
function attach(name: string, token: string, restarted = false, code = 0) {
  const { port1, port2 } = new MessageChannel();
  win.postMessage({ type: 'gt-pdf-port', name, restarted, code, token }, '*', [port2]);
  return port1;
}

test('BH-033: an engine that stops answering is replaced; the call it was on fails with a message, the calls behind it go to the new one', async () => {
  const restarted: string[] = [];
  const was = win.gt.pdf.restart;
  win.gt.pdf.restart = async (n: string) => { restarted.push(n); return true; };
  try {
    const e = new PdfEngine('hang-a', null);
    const c = e.clients.draw;
    c.hangMs = 250;
    const engine = attach('hang-a', c.token); // takes the calls, never answers (stuck inside PDFium)
    const got: number[] = [];
    engine.on('message', (m: any) => got.push(m.id));
    const t0 = Date.now();
    const stuck = c.call('render', { key: 'k', pg: 0 }).then(() => null, (err: any) => err);
    const behind = c.call('text', { key: 'k', pg: 0 }).then(() => null, (err: any) => err);
    const err = await stuck;
    assert.ok(err && err.hung, 'the call it was on fails');
    assert.ok(!err.retry, 'and is not asked again (it would hang the new engine too)');
    assert.match(err.message, /stopped answering/);
    assert.ok(Date.now() - t0 >= 240, 'not before it had been silent that long');
    assert.deepEqual(restarted, ['hang-a'], 'a fresh engine is asked for');
    // the fresh engine takes over: what waited behind the stuck call is asked again there
    const fresh = attach('hang-a', c.token, true, 75);
    const b = await behind;
    assert.ok(b && b.retry, 'asked again in the new engine');
    engine.close(); fresh.close();
    c.fail('test over');
  } finally {
    win.gt.pdf.restart = was;
  }
});

test('BH-033: an engine that is slow but answering is never taken as stuck', async () => {
  const restarted: string[] = [];
  const was = win.gt.pdf.restart;
  win.gt.pdf.restart = async (n: string) => { restarted.push(n); return true; };
  try {
    const e = new PdfEngine('hang-b', null);
    const c = e.clients.draw;
    c.hangMs = 300;
    const engine = attach('hang-b', c.token);
    // one answer every 120 ms, in order: a long queue of slow pages
    const queue: number[] = [];
    engine.on('message', (m: any) => queue.push(m.id));
    const timer = setInterval(() => { const id = queue.shift(); if (id !== undefined) engine.postMessage({ id, ok: true, heap: 10 }); }, 120);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => c.call('render', { key: 'k', pg: i }).then(() => 'ok', (err: any) => String(err?.message))));
    clearInterval(timer);
    assert.deepEqual(results, Array(8).fill('ok'));
    assert.deepEqual(restarted, []);
    // and an idle engine is never "stuck" (nothing waits on it)
    await sleep(400);
    assert.deepEqual(restarted, []);
    engine.close();
    c.fail('test over');
  } finally {
    win.gt.pdf.restart = was;
  }
  void calls;
});
