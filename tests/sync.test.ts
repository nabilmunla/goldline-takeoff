// Sync and data safety fixes (v0.10 bug hunt): account claims vs clock skew, outboxes per project
// folder, undo of created rows, big changes, values normalised, purges after demotion, malformed lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { encodeLine, decodeLine } from '../src/engine/codec';
import { encodeStamp } from '../src/engine/hlc';
import { Store } from '../src/engine/store';
import { ProjectSession } from '../src/engine/session';
import { createProject } from '../src/engine/projects';
import { buildModel, isPurged } from '../src/engine/boq';
import { demoBoqOps } from './helpers/demoboq';
import { initAccounts, loadAccountStore, newAccountOps, claimAccount, checkLogin, accountsDir, adminAtFn } from '../src/engine/accounts';
import type { Batch, FsApi } from '../src/engine/types';

const require = createRequire(import.meta.url);
const nodefs: FsApi = require('../electron/nodefs.cjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = () => mkdtempSync(join(tmpdir(), 'gtsync-'));

function flakyFs(base: FsApi) {
  const state = { down: false };
  const guard = <T extends (...a: any[]) => any>(f: T): T =>
    (async (...a: any[]) => {
      if (state.down) throw Object.assign(new Error('network path not found'), { code: 'ENETUNREACH' });
      return f(...a);
    }) as T;
  const fs: FsApi = {
    join: base.join,
    mkdirp: guard(base.mkdirp), list: guard(base.list), readText: guard(base.readText), readFrom: guard(base.readFrom),
    append: guard(base.append), writeAtomic: guard(base.writeAtomic), remove: guard(base.remove), exists: guard(base.exists),
  };
  return { fs, state };
}
async function newSession(projectDir: string, user: string, localDir = tmp(), fs: FsApi = nodefs, account?: string) {
  const s = new ProjectSession({ fs, localFs: nodefs, projectDir, localDir, user, account, host: 'PC-' + user, pollMs: 60000, fullScanMs: 0, heartbeatMs: 60000 });
  await s.open();
  return s;
}

test('accounts: a claim made on a PC whose clock is behind the admin\'s still wins (code used up)', async () => {
  const data = tmp();
  await initAccounts(nodefs, data, 'PC1', { username: 'nabil.munla', name: 'Nabil Munla', password: 'admin-pass-1' });
  // the admin's PC is 5 minutes fast: its "add person" is stamped in the future
  const fast = () => Date.now() + 5 * 60 * 1000;
  const s = new ProjectSession({ fs: nodefs, localFs: nodefs, projectDir: accountsDir(nodefs, data), localDir: tmp(), user: 'Nabil Munla', account: 'nabil.munla', host: 'PC1', pollMs: 60000, fullScanMs: 0, heartbeatMs: 60000, now: fast });
  await s.open();
  const { ops, code } = await newAccountOps('nabil.munla', { username: 'sara.khan', name: 'Sara Khan', role: 'qs' });
  s.commit(ops, 'Add person');
  await s.close();
  let { store } = await loadAccountStore(nodefs, data);
  const r = await claimAccount(nodefs, data, 'PC2', store, 'sara.khan', code, 'ahmed-pass-1');
  assert.equal(r.ok, true);
  ({ store } = await loadAccountStore(nodefs, data));
  assert.equal((await checkLogin(store, 'sara.khan', 'ahmed-pass-1')).ok, true, 'the new password counts');
  assert.equal((await claimAccount(nodefs, data, 'PC3', store, 'sara.khan', code, 'hijack-pass-9')).ok, false, 'the code is used up');
});

test('accounts: a first set-up that wrote its journal but not project.json is not offered again', async () => {
  const data = tmp();
  await initAccounts(nodefs, data, 'PC1', { username: 'nabil.munla', name: 'Nabil Munla', password: 'admin-pass-1' });
  await nodefs.remove(join(accountsDir(nodefs, data), 'project.json'));
  assert.equal((await loadAccountStore(nodefs, data)).exists, true);
  await assert.rejects(initAccounts(nodefs, data, 'PC9', { username: 'intruder', name: 'X', password: 'intruder-pass' }));
});

test('outbox: offline edits never replay into a copied project folder (same id)', async () => {
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'Tower', 'Nabil', 'PC1', demoBoqOps());
  const copy = join(data, 'Tower copy');
  cpSync(dir, copy, { recursive: true });
  const local = tmp();
  const { fs, state } = flakyFs(nodefs);
  const a = await newSession(dir, 'Nabil', local, fs);
  const item = [...buildModel(a.store).byId.values()].find((n) => n.type === 'item')!;
  state.down = true;
  a.commit([[item.id, 'desc', 'offline in the original']]);
  await sleep(150);
  a.kill();
  // the copy is opened first on this PC: it must not get the original's edit
  const c = await newSession(copy, 'Nabil', local);
  assert.notEqual(c.store.get(item.id, 'desc'), 'offline in the original');
  await c.close();
  // the original gets it
  const a2 = await newSession(dir, 'Nabil', local);
  for (let i = 0; i < 30 && a2.pendingCount; i++) await sleep(100);
  const b = await newSession(dir, 'Ahmed');
  assert.equal(b.store.get(item.id, 'desc'), 'offline in the original');
  await a2.close(); await b.close();
});

test('outbox: another account\'s queued edits stay for them; a torn outbox line is dropped, the rest delivered', async () => {
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'Shared PC', 'Nabil', 'PC1', demoBoqOps());
  const local = tmp();
  const { fs, state } = flakyFs(nodefs);
  const a = new ProjectSession({ fs, localFs: nodefs, projectDir: dir, localDir: local, user: 'Nabil', account: 'nabil', host: 'PC1', pollMs: 60000, fullScanMs: 0, heartbeatMs: 60000 });
  await a.open();
  const item = [...buildModel(a.store).byId.values()].find((n) => n.type === 'item')!;
  state.down = true;
  a.commit([[item.id, 'qty', 4242]]);
  await sleep(150);
  a.kill();
  // a torn tail in that outbox (power cut mid-append)
  const obRoot = join(local, 'outbox');
  const sub = readdirSync(obRoot)[0];
  const f = readdirSync(join(obRoot, sub))[0];
  await nodefs.append(join(obRoot, sub, f), '3f2a91c0 {"s":"0mzz');
  // Sara signs in on the same PC: Nabil's edit is not published under her session
  const s = new ProjectSession({ fs: nodefs, localFs: nodefs, projectDir: dir, localDir: local, user: 'Sara', account: 'sara', host: 'PC1', pollMs: 60000, fullScanMs: 0, heartbeatMs: 60000 });
  await s.open();
  assert.notEqual(s.store.get(item.id, 'qty'), 4242);
  await s.close();
  // Nabil again: delivered
  const a2 = new ProjectSession({ fs: nodefs, localFs: nodefs, projectDir: dir, localDir: local, user: 'Nabil', account: 'nabil', host: 'PC1', pollMs: 60000, fullScanMs: 0, heartbeatMs: 60000 });
  await a2.open();
  for (let i = 0; i < 30 && a2.pendingCount; i++) await sleep(100);
  const b = await newSession(dir, 'Ahmed');
  assert.equal(b.store.get(item.id, 'qty'), 4242);
  // and the next edit is not glued to the torn line
  a2.commit([[item.id, 'qty', 77]]);
  for (let i = 0; i < 30 && a2.pendingCount; i++) await sleep(100);
  await b.tick();
  assert.equal(b.store.get(item.id, 'qty'), 77);
  await a2.close(); await b.close();
});

test('undo of an added row: to the recycle bin (restorable), left alone if someone filled it in', async () => {
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'Undo add', 'Nabil', 'PC1', demoBoqOps());
  const a = await newSession(dir, 'Nabil');
  const b = await newSession(dir, 'Ahmed');
  const g = [...buildModel(a.store).byId.values()].find((n) => n.type === 'group')!;
  a.commit([['iNEW1', 'type', 'item'], ['iNEW1', 'parent', g.id], ['iNEW1', 'ord', 'zz'], ['iNEW1', 'desc', 'mine']], 'Add item');
  a.undo();
  assert.equal(a.store.get('iNEW1', 'del'), true);
  assert.equal(a.store.get('iNEW1', 'type'), 'item', 'still a row: it is in the recycle bin');
  a.redo();
  assert.equal(a.store.get('iNEW1', 'del'), null);
  // added, then Ahmed prices it: Nabil's undo leaves it
  a.commit([['iNEW2', 'type', 'item'], ['iNEW2', 'parent', g.id], ['iNEW2', 'ord', 'zz1'], ['iNEW2', 'desc', 'mine too']], 'Add item');
  for (let i = 0; i < 20 && a.pendingCount; i++) await sleep(50);
  await b.tick();
  b.commit([['iNEW2', 'qty', 250], ['iNEW2', 'rate', 85]]);
  for (let i = 0; i < 20 && b.pendingCount; i++) await sleep(50);
  await a.tick();
  const r = a.undo();
  assert.equal(r?.skipped, 1);
  assert.notEqual(a.store.get('iNEW2', 'del'), true);
  assert.equal(a.store.get('iNEW2', 'qty'), 250);
  await a.close(); await b.close();
});

test('a very big change is written as several lines and read back whole; odd numbers are normalised', async () => {
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'Big', 'Nabil', 'PC1', []);
  const a = await newSession(dir, 'Nabil');
  const long = 'x'.repeat(1000);
  const ops = Array.from({ length: 6000 }, (_x, i) => ['e' + i, 'desc', long + i] as [string, string, string]);
  ops.push(['n1', 'qty', NaN as unknown as number], ['n2', 'qty', Infinity as unknown as number], ['n3', 'qty', -0]);
  a.commit(ops, 'Huge paste');
  for (let i = 0; i < 50 && a.pendingCount; i++) await sleep(100);
  const segs = readdirSync(join(dir, 'journals'));
  const lines = segs.flatMap((n) => readFileSync(join(dir, 'journals', n), 'utf8').split('\n').filter(Boolean));
  assert.ok(lines.length >= 3 && lines.every((l) => l.length < 3 * 1024 * 1024), `split into ${lines.length} lines`);
  assert.equal(a.store.get('n1', 'qty'), null);
  assert.equal(a.store.get('n2', 'qty'), null);
  assert.ok(Object.is(a.store.get('n3', 'qty'), 0));
  const b = await newSession(dir, 'Ahmed');
  assert.equal(b.store.get('e5999', 'desc'), long + 5999);
  assert.equal(a.store.fingerprint(), b.store.fingerprint(), 'both PCs hold the same values');
  a.undo();
  assert.equal(a.store.get('e10', 'del'), true);
  await a.close(); await b.close();
});

test('recycle bin: a purge stays a purge after its administrator is demoted or leaves', () => {
  const acc = new Store();
  const st = (t: number, w: string) => encodeStamp(t, 0, w);
  acc.apply({ s: st(900, 'a'), w: 'a', u: 'Boss', t: 0, a: 'boss', o: [['user:boss', 'role', 'admin']] });
  acc.apply({ s: st(1000, 'a'), w: 'a', u: 'Boss', t: 0, a: 'boss', o: [['user:sara', 'role', 'admin'], ['user:sara', 'active', true]] });
  const proj = new Store();
  proj.apply({ s: st(2000, 'b'), w: 'b', u: 'B', t: 0, o: [['r1', 'type', 'item'], ['r1', 'del', true]] });
  proj.apply({ s: st(3000, 'c'), w: 'c', u: 'Sara', t: 0, a: 'sara', o: [['r1', 'purged', true]] });
  // later Sara leaves
  acc.apply({ s: st(4000, 'a'), w: 'a', u: 'Boss', t: 0, a: 'boss', o: [['user:sara', 'active', false], ['user:sara', 'role', 'qs']] });
  const was = adminAtFn(acc);
  assert.equal(isPurged(proj, 'r1', was), true);
  // a purge written by someone who was never an administrator does not count
  proj.apply({ s: st(5000, 'd'), w: 'd', u: 'Omar', t: 0, a: 'omar', o: [['r2', 'type', 'item'], ['r2', 'del', true], ['r2', 'purged', true]] });
  assert.equal(isPurged(proj, 'r2', was), false);
  // nor one Sara writes after she left
  proj.apply({ s: st(6000, 'c'), w: 'c', u: 'Sara', t: 0, a: 'sara', o: [['r3', 'type', 'item'], ['r3', 'del', true], ['r3', 'purged', true]] });
  assert.equal(isPurged(proj, 'r3', was), false);
});

test('codec: a line with a good checksum but malformed changes or stamp is rejected whole', () => {
  const ok: Batch = { s: '0mabcdefg.00000.w', w: 'w', u: 'U', t: 1, o: [['e', 'f', 1]] };
  assert.ok(decodeLine(encodeLine(ok).trimEnd()));
  for (const bad of [
    { ...ok, o: [null] }, { ...ok, o: [['e', 'f']] }, { ...ok, o: [['e', 5, 1]] }, { ...ok, o: [['e', 'f', { x: 1 }]] }, { ...ok, s: '~' },
  ]) assert.equal(decodeLine(encodeLine(bad as unknown as Batch).trimEnd()), null, JSON.stringify(bad));
});

test('read-only: undo keeps the step instead of throwing it away', async () => {
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'RO', 'Nabil', 'PC1', demoBoqOps());
  const a = await newSession(dir, 'Nabil');
  const item = [...buildModel(a.store).byId.values()].find((n) => n.type === 'item')!;
  a.commit([[item.id, 'qty', 5]]);
  a.setReadOnly(true);
  assert.equal(a.undo(), null);
  a.setReadOnly(false);
  assert.ok(a.canUndo());
  await a.close();
});
