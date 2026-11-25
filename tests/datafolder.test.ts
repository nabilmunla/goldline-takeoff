// This PC's data folder (electron/datafolder.cjs): what an earlier version kept in a folder of another
// name is copied into the new one once - settings, remembered views, logs - and its unsent changes (the
// outbox) are taken over exactly once, the earlier folder staying where it is. Fake folder trees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, readProjectStore } from '../src/engine/projects';
import { ProjectSession } from '../src/engine/session';
import type { FsApi } from '../src/engine/types';

const require = createRequire(import.meta.url);
const D = require('../electron/datafolder.cjs');
const nodefs: FsApi = require('../electron/nodefs.cjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'gt-datafolder-'));
// the product folder an earlier version used: found by its fingerprint, so it is put together here
const OLD = ['G', 'C', 'C'].join('') + ' Estimation';

/** a PC as an earlier version left it: Local AppData\<old>\profile-default with settings, views, caches, unsent changes */
function oldPc(o: { roaming?: boolean } = {}) {
  const local = tmp(), roaming = tmp();
  const prof = join(o.roaming ? roaming : local, OLD, 'profile-default');
  mkdirSync(join(prof, 'Local Storage', 'leveldb'), { recursive: true });
  mkdirSync(join(prof, 'qto-cache', 'heavy'), { recursive: true });
  mkdirSync(join(prof, 'Cache'), { recursive: true });
  mkdirSync(join(prof, 'logs'), { recursive: true });
  writeFileSync(join(prof, 'settings.json'), JSON.stringify({ dataRoot: '\\\\fileserver\\projects', lastUser: 'qs1' }));
  writeFileSync(join(prof, 'settings.json.bak'), '{}');
  writeFileSync(join(prof, 'Local Storage', 'leveldb', '000003.log'), 'view-only flags');
  writeFileSync(join(prof, 'qto-cache', 'sheet.pdf'), 'x'.repeat(1000));
  writeFileSync(join(prof, 'Cache', 'data_0'), 'cache');
  writeFileSync(join(prof, 'logs', 'app.log'), 'old log\n');
  const newDir = join(local, 'Goldline Takeoff', 'data', 'profile-default');
  return { local, roaming, prof, newDir, run: () => D.migrateDataFolder({ newDir, localRoot: local, roamingRoot: roaming, profile: 'default' }) };
}

test('no earlier folder: nothing is created, nothing is copied', () => {
  const local = tmp();
  const newDir = join(local, 'Goldline Takeoff', 'data', 'profile-default');
  const r = D.migrateDataFolder({ newDir, localRoot: local, roamingRoot: tmp(), profile: 'default' });
  assert.equal(r.from, null);
  assert.equal(existsSync(newDir), false);
});

test('a folder of another name that is not the earlier one is left alone', () => {
  const local = tmp();
  mkdirSync(join(local, 'Some Other App', 'profile-default'), { recursive: true });
  writeFileSync(join(local, 'Some Other App', 'profile-default', 'settings.json'), '{}');
  const newDir = join(local, 'Goldline Takeoff', 'data', 'profile-default');
  assert.equal(D.migrateDataFolder({ newDir, localRoot: local, roamingRoot: tmp(), profile: 'default' }).from, null);
});

test('settings, views and logs are copied once; the drawing cache moved; other caches left; the earlier folder otherwise untouched', () => {
  const pc = oldPc();
  const r = pc.run();
  assert.equal(r.copied, true);
  assert.equal(r.from, pc.prof);
  assert.deepEqual(JSON.parse(readFileSync(join(pc.newDir, 'settings.json'), 'utf8')).dataRoot, '\\\\fileserver\\projects');
  assert.equal(readFileSync(join(pc.newDir, 'Local Storage', 'leveldb', '000003.log'), 'utf8'), 'view-only flags');
  assert.equal(readFileSync(join(pc.newDir, 'logs', 'app.log'), 'utf8'), 'old log\n');
  assert.equal(existsSync(join(pc.newDir, 'Cache')), false);
  assert.equal(existsSync(join(pc.newDir, D.MARKER)), true);
  // nothing of the earlier folder was deleted; only its drawing cache was moved over (one rename)
  assert.equal(readFileSync(join(pc.prof, 'settings.json'), 'utf8').includes('lastUser'), true);
  assert.equal(readFileSync(join(pc.newDir, 'qto-cache', 'sheet.pdf'), 'utf8'), 'x'.repeat(1000), 'the drawing cache is moved, not fetched again');
  assert.equal(existsSync(join(pc.prof, 'qto-cache')), false);
  // the settings are now this folder's own: what the person changes later is not undone by a second start
  writeFileSync(join(pc.newDir, 'settings.json'), JSON.stringify({ dataRoot: '\\\\fileserver\\moved' }));
  const again = pc.run();
  assert.equal(again.copied, false);
  assert.equal(JSON.parse(readFileSync(join(pc.newDir, 'settings.json'), 'utf8')).dataRoot, '\\\\fileserver\\moved');
});

test('a PC that only has the roaming profile of the earlier version is found there; Local wins when both exist', () => {
  const a = oldPc({ roaming: true });
  assert.equal(a.run().from, join(a.roaming, OLD, 'profile-default'));
  const b = oldPc();
  mkdirSync(join(b.roaming, OLD, 'profile-default'), { recursive: true });
  writeFileSync(join(b.roaming, OLD, 'profile-default', 'settings.json'), '{"dataRoot":"roaming"}');
  const r = b.run();
  assert.equal(r.from, b.prof);
  assert.notEqual(JSON.parse(readFileSync(join(b.newDir, 'settings.json'), 'utf8')).dataRoot, 'roaming');
});

test('the earlier folder is found by its name in any case, and another profile name maps to its own folder', () => {
  const local = tmp();
  mkdirSync(join(local, OLD.toUpperCase(), 'profile-qs2'), { recursive: true });
  writeFileSync(join(local, OLD.toUpperCase(), 'profile-qs2', 'settings.json'), '{"dataRoot":"d"}');
  const newDir = join(local, 'Goldline Takeoff', 'data', 'profile-qs2');
  const r = D.migrateDataFolder({ newDir, localRoot: local, roamingRoot: tmp(), profile: 'qs2' });
  assert.equal(r.copied, true);
  assert.equal(existsSync(join(local, 'Goldline Takeoff', 'data', 'profile-default')), false);
});

test('a copy that fails on the settings is not marked: it is tried again at the next start', () => {
  const pc = oldPc();
  mkdirSync(pc.newDir, { recursive: true });
  mkdirSync(join(pc.newDir, 'settings.json')); // can't be written as a file: the copy of settings.json fails
  const r = pc.run();
  assert.equal(r.copied, false);
  assert.match(r.note, /settings/);
  assert.equal(existsSync(join(pc.newDir, D.MARKER)), false);
  rmSync(join(pc.newDir, 'settings.json'), { recursive: true });
  assert.equal(pc.run().copied, true);
});

// ---------------------------------------------------------------- the outbox: unsent changes
/** the earlier version closed with a change the share never got: its queue file is in the earlier outbox */
async function unsent(pc: ReturnType<typeof oldPc>) {
  const share = tmp();
  const { dir } = await createProject(nodefs, share, 'P', 'Setup', 'PC0', [['e1', 'qty', 1]], undefined, 'takeoff');
  // the share is out of reach while the person works: the change waits in the outbox of the earlier folder
  const down: FsApi = { ...nodefs, append: async (p: string, t: string) => { if (p.startsWith(share)) throw new Error('network path not found'); return nodefs.append(p, t); }, writeAtomic: async (p: string, t: string) => { if (p.startsWith(share) && !p.endsWith('project.json')) throw new Error('network path not found'); return nodefs.writeAtomic(p, t); } };
  const s = new ProjectSession({ fs: down, localFs: nodefs, projectDir: dir, localDir: pc.prof, user: 'QS One', account: 'qs1', host: 'PC-1', pollMs: 3600000, fullScanMs: 0, heartbeatMs: 3600000, dataFormat: 1 });
  await s.open();
  s.commit([['e1', 'qty', 4242]], 'offline edit');
  await (s as any).localChain;
  await s.close();
  return { share, dir };
}
const logsIn = (d: string) => readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e) => readdirSync(join(d, e.name)).filter((f) => f.endsWith('.log')).map((f) => join(d, e.name, f)));

async function openAndClose(dir: string, localDir: string) {
  const s = new ProjectSession({ fs: nodefs, localFs: nodefs, projectDir: dir, localDir, user: 'QS One', account: 'qs1', host: 'PC-1', pollMs: 3600000, fullScanMs: 0, heartbeatMs: 3600000, dataFormat: 1 });
  await s.open();
  for (let i = 0; i < 100 && s.pendingCount; i++) await new Promise((r) => setTimeout(r, 50));
  await s.close();
}

test('unsent changes: copied into the new outbox, the earlier queue marked as taken, sent once', async () => {
  const pc = oldPc();
  const { dir } = await unsent(pc);
  const oldLogs = logsIn(join(pc.prof, 'outbox')).filter((f) => readFileSync(f, 'utf8').includes('\n'));
  assert.equal(oldLogs.length, 1, 'the change waits in the earlier outbox');
  const text = readFileSync(oldLogs[0], 'utf8');
  assert.equal((await readProjectStore(nodefs, dir)).get('e1', 'qty'), 1, 'the share does not have it yet');

  const r = pc.run();
  assert.equal(r.outbox.taken >= 1, true);
  // the new outbox has the queue, whole; the earlier one no longer offers it
  const nl = logsIn(join(pc.newDir, 'outbox'));
  assert.equal(nl.some((f) => readFileSync(f, 'utf8') === text), true);
  assert.equal(logsIn(join(pc.prof, 'outbox')).some((f) => readFileSync(f, 'utf8').includes('\n')), false);
  assert.equal(existsSync(oldLogs[0] + D.MOVED), true);
  assert.equal(readFileSync(oldLogs[0] + D.MOVED, 'utf8'), text, 'the earlier file is kept, renamed');

  // the new app opens the project: the change reaches the share
  await openAndClose(dir, pc.newDir);
  assert.equal((await readProjectStore(nodefs, dir)).get('e1', 'qty'), 4242);
  const journalLines = () => readdirSync(join(dir, 'journals')).map((f) => readFileSync(join(dir, 'journals', f), 'utf8')).join('').split('\n').filter((l) => l.includes('4242')).length;
  assert.equal(journalLines(), 1, 'on the share once');

  // another start of the new app (the sweep runs at every start): nothing is taken twice
  assert.equal(pc.run().outbox.taken, 0);
  await openAndClose(dir, pc.newDir);
  assert.equal(journalLines(), 1);

  // the earlier version started again (a go-back): it finds nothing of that queue to send a second time
  await openAndClose(dir, pc.prof);
  assert.equal(journalLines(), 1, 'the earlier version does not send it again');
});

test('changes the earlier version queued after a go-back are taken over at the next start', async () => {
  const pc = oldPc();
  pc.run(); // first start of the new version: nothing queued yet
  const { dir } = await unsent(pc); // the earlier version runs again and leaves something in ITS outbox
  assert.equal(logsIn(join(pc.prof, 'outbox')).some((f) => readFileSync(f, 'utf8').includes('\n')), true);
  const r = pc.run();
  assert.equal(r.copied, false, 'the folder is not copied a second time');
  assert.equal(r.outbox.taken >= 1, true);
  await openAndClose(dir, pc.newDir);
  assert.equal((await readProjectStore(nodefs, dir)).get('e1', 'qty'), 4242);
});

test('a queue of the same name already in the new outbox is never overwritten', () => {
  const pc = oldPc();
  const ob = join(pc.prof, 'outbox', 'P_abc123');
  mkdirSync(ob, { recursive: true });
  writeFileSync(join(ob, 'PC-1~w1.log'), 'old queue\n');
  writeFileSync(join(ob, 'target.json'), '{"projectDir":"S:\\\\p"}');
  const nob = join(pc.newDir, 'outbox', 'P_abc123');
  mkdirSync(nob, { recursive: true });
  writeFileSync(join(nob, 'PC-1~w1.log'), 'the new queue\n');
  const r = pc.run();
  assert.equal(r.outbox.taken, 1);
  assert.equal(readFileSync(join(nob, 'PC-1~w1.log'), 'utf8'), 'the new queue\n');
  const names = readdirSync(nob).filter((f) => f.endsWith('.log'));
  assert.equal(names.length, 2);
  assert.equal(names.map((n) => readFileSync(join(nob, n), 'utf8')).sort().join('|'), 'old queue\n|the new queue\n');
  assert.equal(existsSync(join(nob, 'target.json')), true);
});

test('a queue that can not be taken over yet is left where it is and tried again', () => {
  const pc = oldPc();
  const ob = join(pc.prof, 'outbox', 'P_abc123');
  mkdirSync(ob, { recursive: true });
  writeFileSync(join(ob, 'PC-1~w1.log'), 'old queue\n');
  mkdirSync(join(pc.newDir, 'outbox'), { recursive: true });
  writeFileSync(join(pc.newDir, 'outbox', 'P_abc123'), 'a file where the folder should be'); // the copy can't be made
  const r = pc.run();
  assert.equal(r.outbox.taken, 0);
  assert.equal(r.outbox.waiting >= 1, true);
  assert.equal(existsSync(join(ob, 'PC-1~w1.log')), true, 'still offered by the earlier folder');
  rmSync(join(pc.newDir, 'outbox', 'P_abc123'));
  assert.equal(pc.run().outbox.taken, 1);
});

// ---------------------------------------------------------------- sweep B 3, 4 (and the rename's cache)
const fsMod = require('node:fs');
/** fs.copyFileSync wrapped for one run (datafolder.cjs looks it up at each call) */
function withCopy(hook: (src: string, dst: string, copy: (a: string, b: string) => void) => void, run: () => unknown) {
  const orig = fsMod.copyFileSync;
  fsMod.copyFileSync = (a: string, b: string) => hook(String(a), String(b), orig);
  try { return run(); } finally { fsMod.copyFileSync = orig; }
}
const allLogText = (d: string) => (existsSync(d) ? logsIn(d).map((f) => readFileSync(f, 'utf8')).join('') : '');

test('sweep B 3: an earlier version still writing while its queue is taken over loses nothing', () => {
  for (const where of ['by its name', 'into the file being copied']) {
    const pc = oldPc();
    const ob = join(pc.prof, 'outbox', 'P_abc123');
    mkdirSync(ob, { recursive: true });
    const q = join(ob, 'PC-1~w1.log');
    writeFileSync(q, 'change 1\n');
    let once = false;
    // the earlier version appends a change right after the copy: by the queue's name (each append opens the
    // file by name), or into the open file itself (a write that was under way)
    withCopy((a, b, copy) => { copy(a, b); if (!once && a.startsWith(ob)) { once = true; fsMod.appendFileSync(where === 'by its name' ? q : a, 'change 2\n'); } }, () => pc.run());
    pc.run(); // the next start
    assert.match(allLogText(join(pc.newDir, 'outbox')), /change 1\n[\s\S]*change 2\n|change 2\n[\s\S]*change 1\n/, where);
    assert.equal(allLogText(join(pc.prof, 'outbox')), '', 'nothing left offered by the earlier folder');
  }
});

test('sweep B 4: a profile folder that could not be copied whole is not left half copied, and is copied at a later start', () => {
  const pc = oldPc();
  writeFileSync(join(pc.prof, 'Local Storage', 'leveldb', '000005.ldb'), 'table');
  writeFileSync(join(pc.prof, 'Local Storage', 'leveldb', 'LOCK'), '');
  withCopy((a, b, copy) => { if (a.endsWith('000005.ldb')) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); copy(a, b); }, () => pc.run());
  assert.equal(existsSync(join(pc.newDir, 'settings.json')), true);
  assert.equal(existsSync(join(pc.newDir, 'Local Storage')), false, 'not half a Local Storage');
  pc.run();
  assert.equal(readFileSync(join(pc.newDir, 'Local Storage', 'leveldb', '000005.ldb'), 'utf8'), 'table');
  assert.equal(readFileSync(join(pc.newDir, 'Local Storage', 'leveldb', '000003.log'), 'utf8'), 'view-only flags');
  assert.equal(existsSync(join(pc.newDir, 'Local Storage', 'leveldb', 'LOCK')), false, 'a lock file is never copied');
  // never into one the new app has made of its own since
  const pc2 = oldPc();
  withCopy((a, b, copy) => { if (a.endsWith('000003.log')) throw new Error('EBUSY'); copy(a, b); }, () => pc2.run());
  mkdirSync(join(pc2.newDir, 'Local Storage', 'leveldb'), { recursive: true });
  writeFileSync(join(pc2.newDir, 'Local Storage', 'leveldb', '000001.log'), 'new');
  pc2.run();
  assert.deepEqual(readdirSync(join(pc2.newDir, 'Local Storage', 'leveldb')), ['000001.log']);
});
