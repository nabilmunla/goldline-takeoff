// The person's store of downloaded copies (electron/versions.cjs) and the old layout's marks
// (electron/legacy.cjs): which copy runs, set aside, go back, the setup run again, tidying.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const V = require('../electron/versions.cjs');
const L = require('../electron/legacy.cjs');

const RT = '44.10.0';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gt-store-'));
function copy(dir: string, v: string, ready: Record<string, unknown> | null = { runtime: RT }) {
  fs.mkdirSync(path.join(dir, 'electron'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: v }));
  fs.writeFileSync(path.join(dir, 'electron', 'main.cjs'), '// ' + v);
  fs.writeFileSync(path.join(dir, 'dist', 'index.html'), '<html>');
  if (ready) fs.writeFileSync(path.join(dir, 'ready.json'), JSON.stringify({ version: v, ...ready }));
  return dir;
}

test('the newest good copy runs; the built-in one wins a tie; other runtimes, unready and set-aside copies never', () => {
  const d = tmp(), builtin = copy(path.join(d, 'app'), '0.23.0', null), store = path.join(d, 'store');
  assert.equal(V.choose(builtin, store, RT).builtin, true, 'nothing downloaded: the built-in copy');
  copy(path.join(store, '0.23.0'), '0.23.0');
  assert.equal(V.choose(builtin, store, RT).builtin, true, 'same version: the built-in copy');
  copy(path.join(store, '0.24.0'), '0.24.0');
  copy(path.join(store, '0.25.0'), '0.25.0', { runtime: '99.0.0' });
  copy(path.join(store, '0.26.0'), '0.26.0', null);
  copy(path.join(store, '0.27.0-rc1'), '0.27.0-rc1');
  copy(path.join(store, 'junk'), 'junk');
  assert.equal(V.choose(builtin, store, RT).version, '0.27.0-rc1');
  V.setAside(path.join(store, '0.27.0-rc1'), 'test');
  assert.equal(V.choose(builtin, store, RT).version, '0.24.0', 'set aside: the next one');
  V.pin(store, '0.23.0');
  const p = V.choose(builtin, store, RT);
  assert.ok(p.version === '0.23.0' && p.builtin, 'gone back: the pinned version (the built-in copy)');
  V.pin(store, '');
  assert.equal(V.choose(builtin, store, RT).version, '0.24.0');
  fs.rmSync(d, { recursive: true, force: true });
});

test('a copy whose window never came up twice is set aside at the next start; a second instance is no start', () => {
  const d = tmp(), dir = copy(path.join(d, 'store', '0.24.0'), '0.24.0');
  assert.ok(V.beginStart(dir));
  const before = V.readJson(path.join(dir, 'starts.json'));
  assert.ok(V.beginStart(dir));
  V.undoStart(dir, before); // (another Goldline Takeoff already ran)
  assert.equal(V.readJson(path.join(dir, 'starts.json')).n, 1);
  assert.ok(V.beginStart(dir));
  assert.equal(V.beginStart(dir), false, 'two failed starts: set aside');
  assert.ok(fs.existsSync(path.join(dir, 'bad.json')));
  const ok = copy(path.join(d, 'store', '0.25.0'), '0.25.0');
  V.beginStart(ok);
  V.startedOk(ok);
  assert.ok(!fs.existsSync(path.join(ok, 'starts.json')), 'its window came up: the count is cleared');
  fs.rmSync(d, { recursive: true, force: true });
});

test('the setup run again: its version runs, newer downloads and a go-back choice go (once)', () => {
  const d = tmp(), store = path.join(d, 'store'), inst = path.join(d, 'inst');
  fs.mkdirSync(inst, { recursive: true });
  copy(path.join(store, '0.23.0'), '0.23.0');
  copy(path.join(store, '0.24.0'), '0.24.0');
  copy(path.join(store, '0.22.5'), '0.22.5');
  V.pin(store, '0.24.0');
  assert.equal(V.setupRan(store, inst, '0.23.0'), '', 'no install.json: nothing');
  fs.writeFileSync(path.join(inst, 'install.json'), JSON.stringify({ version: '0.23.0', installed: '2026-11-18T10:00:00Z' }));
  assert.match(V.setupRan(store, inst, '0.23.0'), /installed: choice dropped, removed/);
  assert.deepEqual(fs.readdirSync(store).filter((n) => V.VERSION_NAME.test(n)).sort(), ['0.22.5']);
  assert.equal(V.pinned(store), '');
  copy(path.join(store, '0.24.0'), '0.24.0');
  assert.equal(V.setupRan(store, inst, '0.23.0'), '', 'the same setup is not new again');
  assert.ok(fs.existsSync(path.join(store, '0.24.0')));
  fs.rmSync(d, { recursive: true, force: true });
});

test('tidy: keeps the running copy, the one before, newer ones and the pinned one; never the install', () => {
  const d = tmp(), store = path.join(d, 'store');
  for (const v of ['0.22.9', '0.23.0', '0.23.1', '0.24.0', '0.25.0']) copy(path.join(store, v), v);
  fs.mkdirSync(path.join(store, 'downloads'), { recursive: true });
  fs.writeFileSync(path.join(store, 'downloads', 'app-v0.24.0.zip'), 'x');
  fs.writeFileSync(path.join(store, 'downloads', 'app-v0.26.0.zip.part'), 'x');
  V.pin(store, '0.22.9');
  V.tidy(store, '0.24.0');
  assert.deepEqual(fs.readdirSync(store).filter((n) => V.VERSION_NAME.test(n)).sort(), ['0.22.9', '0.23.1', '0.24.0', '0.25.0']);
  assert.deepEqual(fs.readdirSync(path.join(store, 'downloads')), []);
  fs.rmSync(d, { recursive: true, force: true });
});

test('the old layout (0.22.0): marks its starter reads, go back', () => {
  const d = tmp(), base = path.join(d, 'resources', 'app');
  const b = copy(path.join(base, 'versions', '0.23.0'), '0.23.0', null);
  copy(path.join(base, 'versions', '0.22.0'), '0.22.0', null);
  fs.writeFileSync(path.join(base, 'boot.cjs'), '// old starter');
  fs.writeFileSync(path.join(base, 'current.json'), JSON.stringify({ version: '0.23.0', previous: '0.22.0', bad: [] }));
  fs.writeFileSync(path.join(base, 'boot-state.json'), JSON.stringify({ '0.23.0': { starts: 2 } }));
  assert.ok(L.isLegacy(b) && !L.isLegacy(base) && L.baseOf(b) === base);
  assert.equal(L.markHealthy(b, '0.23.0'), true);
  assert.deepEqual(L.readState(base)['0.23.0'], { starts: 2, ok: true, failed: null });
  assert.equal(L.markHealthy(b, '0.23.0'), false, 'once');
  assert.equal(L.previousOf(b, '0.23.0'), '0.22.0');
  assert.equal(L.rollback(b, '0.23.0'), '0.22.0');
  assert.deepEqual(L.readCurrent(base).bad, ['0.23.0']);
  assert.equal(L.rollback(b, '0.23.0'), false, 'only from the version current.json names');
  // a store copy is no old-layout version
  const s = copy(path.join(d, 'store', '0.24.0'), '0.24.0');
  assert.ok(!L.isLegacy(s) && L.markHealthy(s, '0.24.0') === false && L.previousOf(s, '0.24.0') === null);
  fs.rmSync(d, { recursive: true, force: true });
});
