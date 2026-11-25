// 0.23.1: a PC set up before Goldline Takeoff - its shortcuts take the new name (electron/legacy.cjs
// renameOldShortcuts). The old names are put together from pieces here, as in the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('../electron/legacy.cjs');

const OLD = ['Goldline ' + ['Estim', 'ating'].join(''), ['GC', 'C'].join('') + ' ' + ['Estim', 'ation'].join('')];
const EXE = 'C:\\Apps\\Old\\app.exe';

test('old shortcuts pointing at this exe take the new name; others are left', () => {
  const a = mkdtempSync(join(tmpdir(), 'lnk-a-')), b = mkdtempSync(join(tmpdir(), 'lnk-b-')), c = mkdtempSync(join(tmpdir(), 'lnk-c-'));
  const targets: Record<string, string> = {};
  const put = (dir: string, name: string, target: string) => { const p = join(dir, name); writeFileSync(p, 'x'); targets[p] = target; };
  put(a, OLD[0] + '.lnk', EXE); put(a, 'Something else.lnk', EXE);
  put(b, OLD[1] + '.lnk', EXE.toUpperCase()); // the same exe, other case
  put(c, OLD[0] + '.lnk', 'C:\\Other\\other.exe'); // not ours
  const d = mkdtempSync(join(tmpdir(), 'lnk-d-')); put(d, OLD[0] + '.lnk', EXE); put(d, 'Goldline Takeoff.lnk', EXE); // already has one
  const read = (p: string) => (p in targets ? { target: targets[p] } : null);
  const done = L.renameOldShortcuts([a, b, c, d, join(a, 'missing'), null], EXE, read);
  assert.equal(done.length, 2);
  assert.deepEqual(readdirSync(a).sort(), ['Goldline Takeoff.lnk', 'Something else.lnk']);
  assert.deepEqual(readdirSync(b), ['Goldline Takeoff.lnk']);
  assert.deepEqual(readdirSync(c), [OLD[0] + '.lnk'], 'another program\'s shortcut: left');
  assert.equal(readdirSync(d).length, 2, 'a "Goldline Takeoff" shortcut is there already: nothing renamed');
  // again: nothing left to do
  assert.equal(L.renameOldShortcuts([a, b], EXE, read).length, 0);
  // a shortcut that can't be read, or a folder without rights: no error
  const e = mkdtempSync(join(tmpdir(), 'lnk-e-')); mkdirSync(join(e, OLD[0] + '.lnk'));
  assert.doesNotThrow(() => L.renameOldShortcuts([e], EXE, () => { throw new Error('no'); }));
});
