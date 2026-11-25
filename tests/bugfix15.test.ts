// 0.15.0: the fixes for DeepSeek's 0.14.0 bug log (BUG-LOG.md, BH-0xx), ported from the verifiers'
// repro tests. Each test states what must hold now; it failed on 0.14.0.
// (Sessions a failed assertion leaves open are closed by after(): an open session keeps the test
// process alive and swallows the report.)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, existsSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { ProjectSession } from '../src/engine/session';
import { createProject, listProjects } from '../src/engine/projects';
import { encodeLine } from '../src/engine/codec';
import { encodeStamp } from '../src/engine/hlc';
import { Store } from '../src/engine/store';
import { buildModel } from '../src/engine/boq';
import { pageStart, renumberOps } from '../src/engine/pages';
import { ownerOf, accessFor } from '../src/engine/access';
import {
  initAccounts, loadAccountStore, accountsDir, listAccounts, checkLogin, adminSet, rootsOf, appendOneOff, getAccount, newAccountOps, claimAccount,
} from '../src/engine/accounts';
import { writeBackup, readBackup, listBackupDays, backupDirOf, restoreAccounts, makeBackup, restoreOps } from '../src/engine/backups';
import { moveTeamFolder, movedTarget, clearOldTeamFolder, type CopyFs } from '../src/engine/teamfolder';
import type { Batch, FsApi, Op } from '../src/engine/types';

const require = createRequire(import.meta.url);
const nodefs: CopyFs = require('../electron/nodefs.cjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'gt15fix-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const OPEN: ProjectSession[] = [];
after(async () => { for (const s of OPEN.splice(0)) await s.close().catch(() => {}); });
async function session(dir: string, user: string, o: { localDir?: string; host?: string; account?: string; fs?: FsApi } = {}) {
  const s = new ProjectSession({
    fs: (o.fs ?? nodefs) as FsApi, localFs: nodefs as FsApi, projectDir: dir, localDir: o.localDir ?? tmp(), user,
    account: o.account ?? user.toLowerCase().replace(/\s+/g, '.'), host: o.host ?? 'PC-' + user.replace(/\s+/g, ''),
    pollMs: 3600000, fullScanMs: 0, heartbeatMs: 3600000,
  });
  await s.open();
  OPEN.push(s);
  return s;
}
async function drain(s: ProjectSession, ms = 5000) {
  for (let i = 0; i < ms / 20 && s.pendingCount; i++) await sleep(20);
}

// ================================================================ sync (journals)
test('BH-013: a journal deleted while its writer was closed - the writer goes on in a new file and an open reader sees it', async () => {
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'G', 'Setup', 'PC0', [['e1', 'qty', 1]]);
  const wLocal = tmp(); // the writer's PC data folder: same person + PC + folder = the same journal name
  const w = await session(dir, 'Nabil', { localDir: wLocal, host: 'PC-N' });
  w.commit([['e1', 'desc', 'long text so the old file is big ' + 'x'.repeat(400)]]);
  await drain(w);
  const seg = w.currentSegment;
  await w.close();
  const r = await session(dir, 'Ahmed'); // stays open
  assert.ok(String(r.store.get('e1', 'desc')).startsWith('long text'));
  rmSync(join(dir, 'journals', seg)); // a "cleanup", an antivirus quarantine
  const w2 = await session(dir, 'Nabil', { localDir: wLocal, host: 'PC-N' });
  assert.notEqual(w2.currentSegment, seg, 'never written again from the start under a name others read past');
  w2.commit([['e1', 'qty', 4242]]);
  await drain(w2);
  for (let i = 0; i < 3; i++) await r.tick();
  assert.equal(r.store.get('e1', 'qty'), 4242, 'the open reader sees the change');
  const name2 = w2.currentSegment;
  await w2.close();
  // and the PC's later sessions keep that new file (not a new file at every start)
  const w3 = await session(dir, 'Nabil', { localDir: wLocal, host: 'PC-N' });
  assert.equal(w3.currentSegment, name2);
  w3.commit([['e1', 'qty', 5]]);
  await drain(w3);
  for (let i = 0; i < 2; i++) await r.tick();
  assert.equal(r.store.get('e1', 'qty'), 5);
  await w3.close(); await r.close();
});

test('BH-013: the re-created file growing past the old read position loses nothing either', async () => {
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'G', 'Setup', 'PC0', [['e1', 'qty', 1]]);
  const wLocal = tmp();
  const w = await session(dir, 'Nabil', { localDir: wLocal, host: 'PC-N' });
  w.commit([['e1', 'desc', 'x'.repeat(400)]]);
  await drain(w);
  const seg = w.currentSegment;
  await w.close();
  const r = await session(dir, 'Ahmed');
  rmSync(join(dir, 'journals', seg));
  const w2 = await session(dir, 'Nabil', { localDir: wLocal, host: 'PC-N' });
  w2.commit([['e1', 'qty', 4242]]);
  await drain(w2);
  await r.tick();
  for (let i = 0; i < 6; i++) { w2.commit([['e' + (10 + i), 'desc', 'y'.repeat(120)]]); await drain(w2); }
  for (let i = 0; i < 3; i++) await r.tick();
  assert.equal(r.store.get('e1', 'qty'), 4242, `corrupt lines counted: ${r.getStatus().corruptLines}`);
  assert.equal(r.store.get('e15', 'desc'), 'y'.repeat(120));
  await w2.close(); await r.close();
});

test('BH-013: a journal replaced by an older, shorter copy (folder restored) while its writer was closed', async () => {
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'G', 'Setup', 'PC0', [['e1', 'qty', 1]]);
  const wLocal = tmp();
  const w = await session(dir, 'Nabil', { localDir: wLocal, host: 'PC-N' });
  w.commit([['e1', 'qty', 2]]);
  await drain(w);
  const seg = w.currentSegment;
  const snapshot = readFileSync(join(dir, 'journals', seg)); // "yesterday's" copy
  w.commit([['e1', 'desc', 'z'.repeat(400)]]);
  await drain(w);
  await w.close();
  const r = await session(dir, 'Ahmed');
  writeFileSync(join(dir, 'journals', seg), snapshot); // IT restores the folder from a snapshot
  const w2 = await session(dir, 'Nabil', { localDir: wLocal, host: 'PC-N' });
  w2.commit([['e1', 'qty', 99]]);
  await drain(w2);
  for (let i = 0; i < 3; i++) await r.tick();
  assert.equal(r.store.get('e1', 'qty'), 99);
  await w2.close(); await r.close();
});

test('BH-013: without this PC\'s record of how far it wrote (an older version, a new profile) an open reader still reads a journal that became shorter from the start', async () => {
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'G', 'Setup', 'PC0', [['e1', 'qty', 1]]);
  const wLocal = tmp();
  const w = await session(dir, 'Nabil', { localDir: wLocal, host: 'PC-N' });
  w.commit([['e1', 'desc', 'x'.repeat(400)]]);
  await drain(w);
  const seg = w.currentSegment;
  await w.close();
  const r = await session(dir, 'Ahmed');
  rmSync(join(dir, 'journals', seg));
  // the record kept on the writer's PC is gone too: it writes the same name from the start, as 0.14 did
  for (const f of readdirSync(wLocal, { recursive: true }).map(String)) if (/seg-.*\.json$/.test(f)) rmSync(join(wLocal, f));
  const w2 = await session(dir, 'Nabil', { localDir: wLocal, host: 'PC-N' });
  assert.equal(w2.currentSegment, seg);
  w2.commit([['e1', 'qty', 31]]);
  await drain(w2);
  await r.tick();
  assert.equal(r.store.get('e1', 'qty'), 31, 'the reader saw the file get shorter and read it again');
  await w2.close(); await r.close();
});

async function badLineScenario(scansBeforeRepair: number) {
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'G', 'Setup', 'PC0', [['e1', 'qty', 1]]);
  const r = await session(dir, 'Ahmed');
  const now = Date.now();
  const mk = (c: number, o: Batch['o']): Batch => ({ s: encodeStamp(now + 1000, c, 'other~w1'), w: 'other~w1', u: 'Other', t: now, o, a: 'other' });
  const l1 = encodeLine(mk(0, [['e1', 'desc', 'first']]));
  const l2 = encodeLine(mk(1, [['e1', 'qty', 777]]));
  const l3 = encodeLine(mk(2, [['e1', 'note', 'third']]));
  // what the reader sees first: line 2's bytes not there yet (zeros), its line break is
  const torn = Buffer.from(l2);
  torn.fill(0, 9, torn.length - 1);
  const file = join(dir, 'journals', 'j_other_pc9_abc123.log');
  writeFileSync(file, Buffer.concat([Buffer.from(l1), torn, Buffer.from(l3)]));
  await r.tick();
  assert.equal(r.store.get('e1', 'note'), 'third');
  assert.equal(r.store.get('e1', 'qty'), 1, 'line 2 not readable yet');
  for (let i = 0; i < scansBeforeRepair; i++) await r.tick();
  // the bytes land (same place, same length)
  const fd = openSync(file, 'r+');
  writeSync(fd, Buffer.from(l2), 0, Buffer.byteLength(l2), Buffer.byteLength(l1));
  closeSync(fd);
  for (let i = 0; i < 13; i++) await r.tick();
  const got = r.store.get('e1', 'qty');
  await r.close();
  return got;
}
test('BH-015: a line still unreadable after 20 scans is still read once its bytes land (tried now and then, never given up)', async () => {
  assert.equal(await badLineScenario(5), 777, 'control: soon after');
  assert.equal(await badLineScenario(21), 777, 'after the 20 tries of 0.14');
  assert.equal(await badLineScenario(60), 777, 'much later');
});

// ================================================================ accounts, team folder
test('BH-007: an accounts folder with its project.json but no journals can be restored from a backup', async () => {
  const root = tmp();
  await initAccounts(nodefs, root, 'PC1', { username: 'nabil', name: 'Nabil Munla', password: 'admin-pass-1' });
  const s = await session(accountsDir(nodefs, root), 'Nabil Munla', { account: 'nabil' });
  await writeBackup({ fs: nodefs, root, kind: 'accounts', projectDir: accountsDir(nodefs, root), folder: '_accounts', projectId: s.meta.id, projectName: 'Accounts', store: s.store, by: 'nabil', host: 'PC1', app: '0.15.0' });
  await s.close();
  const jd = join(accountsDir(nodefs, root), 'journals');
  for (const f of readdirSync(jd)) rmSync(join(jd, f)); // the .log files go, project.json stays
  const r = await loadAccountStore(nodefs, root);
  assert.equal(r.exists, true);
  assert.equal(r.store.top, '', 'nobody in it: the sign-in screen offers the backups (LoginScreen "broken")');
  assert.equal(await movedTarget(nodefs, root, r.store), null, 'not a moved folder');
  const days = await listBackupDays(nodefs, backupDirOf(nodefs, root, 'accounts', '', ''));
  assert.ok(days.length > 0);
  const b = await readBackup(nodefs, days[0].file);
  await restoreAccounts(nodefs, root, 'PC1', b, 'nabil');
  const back = await loadAccountStore(nodefs, root);
  assert.ok((await checkLogin(back.store, 'nabil', 'admin-pass-1')).ok, 'signs in as before');
  // accounts with people in them are still never restored over
  await assert.rejects(restoreAccounts(nodefs, root, 'PC1', b, 'nabil'), /there already/);
});

test('BH-008: a release that can\'t be copied stops the move before anybody is sent on; once put right the move goes through', async () => {
  const old = tmp();
  await initAccounts(nodefs, old, 'PC1', { username: 'nabil.munla', name: 'Nabil Munla', password: 'admin-pass-1' });
  const s = await session(accountsDir(nodefs, old), 'Nabil Munla');
  const rel = join(old, '_releases');
  mkdirSync(join(rel, '0.15.0', 'dist'), { recursive: true });
  writeFileSync(join(rel, '0.15.0', 'dist', 'index.html'), '<html>');
  writeFileSync(join(rel, 'latest.json'), JSON.stringify({ version: '0.15.0', folder: '0.15.0', files: [] }));
  const to = tmp();
  writeFileSync(join(to, '_releases'), 'in the way'); // stands in for no permission / disk full
  const go = () => moveTeamFolder({ fs: nodefs, from: old, to, roots: rootsOf(s.store, old), by: { username: 'nabil.munla', name: 'Nabil Munla' }, host: 'PC1', oldStore: s.store, commitOld: (ops, l) => !!s.commit(ops, l) });
  await assert.rejects(go(), /newest release could not be copied/);
  await drain(s);
  assert.equal(await movedTarget(nodefs, old, (await loadAccountStore(nodefs, old)).store), null, 'nobody was sent to the new folder');
  rmSync(join(to, '_releases'));
  const r = await go();
  assert.equal(r.release, true);
  assert.equal(r.releaseNote, null);
  assert.ok(existsSync(join(to, '_releases', 'latest.json')));
  await s.close();
});

test('BH-008: a latest.json that can\'t be read: the move goes on and says no release was copied', async () => {
  const old = tmp();
  await initAccounts(nodefs, old, 'PC1', { username: 'nabil.munla', name: 'Nabil Munla', password: 'admin-pass-1' });
  const s = await session(accountsDir(nodefs, old), 'Nabil Munla');
  mkdirSync(join(old, '_releases'), { recursive: true });
  writeFileSync(join(old, '_releases', 'latest.json'), '{ "version": "0.15.0", ');
  const to = tmp();
  const r = await moveTeamFolder({ fs: nodefs, from: old, to, roots: rootsOf(s.store, old), by: { username: 'nabil.munla', name: 'Nabil Munla' }, host: 'PC1', oldStore: s.store, commitOld: (ops, l) => !!s.commit(ops, l) });
  assert.equal(r.release, false);
  assert.match(String(r.releaseNote), /No release was copied/);
  await s.close();
});

const mover = { username: 'nabil.munla', name: 'Nabil Munla' };
async function twoMoves(clearA: boolean) {
  const A = tmp(), B = tmp(), C = tmp();
  await initAccounts(nodefs, A, 'PC1', { username: 'nabil.munla', name: 'Nabil Munla', password: 'admin-pass-1' });
  const sa = await session(accountsDir(nodefs, A), 'Nabil Munla');
  await moveTeamFolder({ fs: nodefs, from: A, to: B, roots: rootsOf(sa.store, A), by: mover, host: 'PC1', oldStore: sa.store, commitOld: (ops, l) => !!sa.commit(ops, l) });
  await sa.close();
  if (clearA) await clearOldTeamFolder(nodefs, A, B, backupDirOf(nodefs, B, 'accounts', '', ''));
  const sb = await session(accountsDir(nodefs, B), 'Nabil Munla');
  await moveTeamFolder({ fs: nodefs, from: B, to: C, roots: rootsOf(sb.store, B), by: mover, host: 'PC1', oldStore: sb.store, commitOld: (ops, l) => !!sb.commit(ops, l) });
  await sb.close();
  await clearOldTeamFolder(nodefs, B, C, backupDirOf(nodefs, C, 'accounts', '', ''));
  return { A, B, C };
}
test('BH-009: a PC two moves behind (A -> B -> C, B cleared) is sent on to C', async () => {
  {
    const { B, C } = await twoMoves(false);
    assert.deepEqual(await movedTarget(nodefs, B, null), { to: C, ok: true, cleared: true }, 'one move behind (as before)');
  }
  {
    const { A, C } = await twoMoves(false);
    const r = await loadAccountStore(nodefs, A);
    const t = await movedTarget(nodefs, A, r.exists ? r.store : null);
    assert.deepEqual(t && { to: t.to, ok: t.ok }, { to: C, ok: true }, 'A still holding the accounts');
  }
  {
    const { A, C } = await twoMoves(true);
    const r = await loadAccountStore(nodefs, A);
    const t = await movedTarget(nodefs, A, r.exists ? r.store : null);
    assert.deepEqual(t && { to: t.to, ok: t.ok }, { to: C, ok: true }, 'A cleared too (two pointers)');
  }
});

test('BH-011: a setup code claimed twice at the same moment works once', async () => {
  const data = tmp();
  await initAccounts(nodefs, data, 'PC1', { username: 'nabil.munla', name: 'Nabil Munla', password: 'admin-pass-1' });
  const s = await session(accountsDir(nodefs, data), 'Nabil Munla', { account: 'nabil.munla' });
  const { ops, code } = await newAccountOps('nabil.munla', { username: 'ahmed', name: 'Sara Khan', role: 'qs' });
  s.commit(ops, 'Add person');
  await s.close();
  const { store } = await loadAccountStore(nodefs, data);
  const [a, b] = await Promise.all([
    claimAccount(nodefs, data, 'PC2', store, 'ahmed', code, 'first-pass-1'),
    claimAccount(nodefs, data, 'PC3', store, 'ahmed', code, 'second-pass-2'),
  ]);
  assert.equal([a, b].filter((x) => x.ok).length, 1, 'one claim is told it worked, the other that the code was just used');
  const after = (await loadAccountStore(nodefs, data)).store;
  const winner = a.ok ? 'first-pass-1' : 'second-pass-2', loser = a.ok ? 'second-pass-2' : 'first-pass-1';
  assert.ok((await checkLogin(after, 'ahmed', winner)).ok, 'the one told "ok" signs in with their password');
  assert.equal((await checkLogin(after, 'ahmed', loser)).ok, false);
});

test('BH-011: a claim whose password could not be written does not use the code up', async () => {
  const data = tmp();
  await initAccounts(nodefs, data, 'PC1', { username: 'nabil.munla', name: 'Nabil Munla', password: 'admin-pass-1' });
  const s = await session(accountsDir(nodefs, data), 'Nabil Munla', { account: 'nabil.munla' });
  const { ops, code } = await newAccountOps('nabil.munla', { username: 'ahmed', name: 'Sara Khan', role: 'qs' });
  s.commit(ops, 'Add person');
  await s.close();
  const { store } = await loadAccountStore(nodefs, data);
  let fail = true;
  const flaky = { ...nodefs, append: async (p: string, t: string) => { if (fail) { fail = false; throw new Error('the network name is no longer available'); } return nodefs.append(p, t); } };
  await assert.rejects(claimAccount(flaky, data, 'PC2', store, 'ahmed', code, 'first-pass-1'), /network name/);
  const r = await claimAccount(nodefs, data, 'PC2', store, 'ahmed', code, 'first-pass-1');
  assert.equal(r.ok, true, 'tried again: it works');
  assert.ok((await checkLogin((await loadAccountStore(nodefs, data)).store, 'ahmed', 'first-pass-1')).ok);
});

async function movedAndClosed() {
  const old = tmp(), to = tmp();
  await initAccounts(nodefs, old, 'PC1', { username: 'nabil.munla', name: 'Nabil Munla', password: 'admin-pass-1' });
  const s = await session(accountsDir(nodefs, old), 'Nabil Munla');
  await moveTeamFolder({ fs: nodefs, from: old, to, roots: rootsOf(s.store, old), by: mover, host: 'PC1', oldStore: s.store, commitOld: (ops, l) => !!s.commit(ops, l) });
  await s.close();
  return { old, to, oldJ: nodefs.join(accountsDir(nodefs, old), 'journals') };
}
const lateSignIn = async (old: string) => {
  const st = (await loadAccountStore(nodefs, old)).store;
  await appendOneOff(nodefs, accountsDir(nodefs, old), 'Nabil Munla', 'nabil.munla', 'PC-LATE', [['user:nabil.munla', 'lastHost', 'PC-LATE']], 'Signed in', st);
};
test('BH-012: clearing the old team folder never deletes a change written there after the last copy', async () => {
  {
    // written between the copy and the removal (a PC still on the old folder signs in)
    const { old, to, oldJ } = await movedAndClosed();
    let lists = 0;
    const fs = { ...nodefs, list: async (p: string) => { if (p === oldJ && ++lists === 3) await lateSignIn(old); return nodefs.list(p); } };
    await clearOldTeamFolder(fs as CopyFs, old, to, backupDirOf(nodefs, to, 'accounts', '', ''));
    assert.equal(getAccount((await loadAccountStore(nodefs, to)).store, 'nabil.munla')?.lastHost, 'PC-LATE');
  }
  {
    // written while the files are being removed
    const { old, to, oldJ } = await movedAndClosed();
    let fired = false;
    const fs = { ...nodefs, remove: async (p: string) => { if (!fired && p.startsWith(oldJ)) { fired = true; await lateSignIn(old); } return nodefs.remove(p); } };
    await clearOldTeamFolder(fs as CopyFs, old, to, backupDirOf(nodefs, to, 'accounts', '', ''));
    assert.ok(fired);
    assert.equal(getAccount((await loadAccountStore(nodefs, to)).store, 'nabil.munla')?.lastHost, 'PC-LATE');
  }
});

test('BH-029: a project with no recorded owner is never given to one of two people with the same name', () => {
  const t0 = Date.UTC(2026, 9, 1);
  const mk = (c: number, o: Op[], a = 'boss'): Batch => ({ s: encodeStamp(t0 + c * 1000, 0, 'w~' + a), w: 'w~' + a, u: a, t: t0, o, a });
  const setup = mk(1, [['user:boss', 'name', 'Boss'], ['user:boss', 'role', 'admin'], ['user:boss', 'active', true]]);
  const ahmed1 = mk(2, [['user:ahmed.ali', 'name', 'Ahmed'], ['user:ahmed.ali', 'role', 'qs'], ['user:ahmed.ali', 'active', true]]);
  const ahmed2 = mk(3, [['user:ahmed.karim', 'name', 'Ahmed'], ['user:ahmed.karim', 'role', 'qs'], ['user:ahmed.karim', 'active', true]]);
  const pcA = new Store(); for (const b of [setup, ahmed1, ahmed2]) pcA.apply(b);
  const pcB = new Store(); for (const b of [setup, ahmed2, ahmed1]) pcB.apply(b);
  const old = { id: 'p1', name: 'Old tower', createdBy: 'Ahmed' }; // from before owners were recorded
  assert.equal(ownerOf(pcA, old), null);
  assert.equal(ownerOf(pcB, old), null, 'the same on every PC');
  const karim = (st: Store) => accessFor(st, adminSet(st), listAccounts(st).find((a) => a.username === 'ahmed.karim')!, old);
  assert.equal(karim(pcA), 'none');
  assert.equal(karim(pcB), 'none');
  // one person of that name, or the creator's username: still found
  const one = new Store(); for (const b of [setup, ahmed1]) one.apply(b);
  assert.equal(ownerOf(one, old), 'ahmed.ali');
  assert.equal(ownerOf(pcA, { id: 'p3', name: 'X', createdBy: 'ahmed.karim' }), 'ahmed.karim');
  assert.equal(ownerOf(pcA, { id: 'p2', name: 'New', owner: 'ahmed.karim', createdBy: 'Ahmed' }), 'ahmed.karim', 'an owner in project.json wins');
});

// ================================================================ the start screen's lists
test('BH-027: the project list reads several projects at once (at most 8) and keeps their order', async () => {
  let inFlight = 0, peak = 0;
  const op = async <T>(v: T) => { inFlight++; peak = Math.max(peak, inFlight); await sleep(3); inFlight--; return v; };
  const fs: any = {
    join: (...p: string[]) => p.join('/'),
    exists: () => op(true),
    list: (dir: string) => {
      if (dir.endsWith('/Projects')) return op(Array.from({ length: 40 }, (_, i) => ({ name: 'P' + String(i).padStart(2, '0'), isDir: true })));
      if (dir.endsWith('/presence')) return op([{ name: 'u.json', isDir: false }]);
      return op([]);
    },
    readText: (p: string) => p.endsWith('project.json')
      ? op(JSON.stringify({ id: p, name: p.split('/')[2], format: 'takeoff', created: 5 })) // all created at the same moment: the folder order decides
      : op(JSON.stringify({ u: 'x', ts: Date.now() })),
  };
  const t0 = Date.now();
  const list = await listProjects(fs, 'X:', Date.now(), 'takeoff');
  assert.equal(list.length, 40);
  assert.deepEqual(list.map((e) => e.folder), Array.from({ length: 40 }, (_, i) => 'P' + String(i).padStart(2, '0')));
  assert.ok(peak > 1 && peak <= 8, 'several at once, never more than 8 (peak ' + peak + ')');
  assert.ok(list.every((e) => e.activeUsers.length === 1));
  assert.ok(Date.now() - t0 < 40 * 4 * 3, 'faster than one at a time');
});

// ================================================================ money, grid, import
let seq = 0;
function apply(st: Store, ops: Op[], m?: string) {
  seq++;
  st.apply({ s: String(seq).padStart(10, '0'), w: 'w', u: 'T', t: seq, o: ops, ...(m ? { m } : {}) });
  return st;
}
const group = (id: string, parent: string | null, ord: string, desc = id): Op[] => [[id, 'type', 'group'], [id, 'parent', parent], [id, 'ord', ord], [id, 'desc', desc]];
const item = (id: string, parent: string, ord: string, qty: number | null, rate: number | null, extra: Op[] = []): Op[] => [
  [id, 'type', 'item'], [id, 'parent', parent], [id, 'ord', ord], [id, 'desc', id], [id, 'unit', 'nr'], [id, 'qty', qty], [id, 'rate', rate], ...extra,
];

test('BH-018: an emptied "starting at" box is not page 0', () => {
  assert.equal(pageStart(''), null);
  assert.equal(pageStart('  '), null);
  assert.equal(pageStart('0'), null);
  assert.equal(pageStart('007'), 7);
  assert.equal(pageStart('12'), 12);
  // and a good start numbers from it
  const st = new Store();
  apply(st, group('B', null, 'a0', 'Bill 1'));
  for (let i = 0; i < 3; i++) apply(st, item('i' + i, 'B', 'a' + i, 1, 1, [['i' + i, 'page', 'C/' + (i + 1)]]));
  const m = buildModel(st);
  const r = renumberOps(m, [m.byId.get('B')!], { prefix: 'C/', start: pageStart('5')!, by: 'keep', depth: 1, every: 40 });
  assert.deepEqual(r.ops.filter((o) => o[1] === 'page').map((o) => o[2]), ['C/5', 'C/6', 'C/7']);
});

test('BH-035: "Delete forever" on a heading - its lines do not come back in a restored backup', () => {
  const st = new Store();
  apply(st, group('B', null, 'a0'));
  apply(st, group('H', 'B', 'a0', 'Doomed section'));
  apply(st, group('H2', 'H', 'a0', 'Doomed sub-section'));
  apply(st, item('x', 'H', 'a0', 10, 100));
  apply(st, item('z', 'H2', 'a0', 2, null));
  apply(st, item('y', 'B', 'a1', 1, 7));
  apply(st, [['H', 'del', true]]);
  apply(st, [['H', 'purged', true]]); // the confirmed id only, as the recycle bin writes it
  const live = buildModel(st);
  assert.equal(live.items, 1);
  const b = makeBackup(st, { kind: 'qto', projectId: 'p', projectName: 'P', folder: 'P', dir: '/x', at: Date.now(), by: 'nabil', host: 'PC1', app: '0.12.1' });
  const copy = apply(new Store(), restoreOps(b));
  const cm = buildModel(copy);
  assert.equal(cm.items, live.items, `copy items ${cm.items}; roots: ${cm.roots.map((r) => r.desc).join(' | ')}`);
  assert.ok(![...copy.ents.keys()].some((id) => id === 'x' || id === 'z' || id === 'H2'), 'the rows under it are left out');
});

// 0.23.2 (DeepSeek #1): an accounts backup without its journal lines (an earlier version's) restored with no
// administrator at all - the right administrator's name and password were refused
test('an accounts backup without journal lines: its administrators are administrators again, both in the check and after the restore', async () => {
  const { storeFromBackup } = await import('../src/engine/backups');
  const root = tmp();
  await initAccounts(nodefs, root, 'PC1', { username: 'nabil', name: 'Nabil Munla', password: 'admin-pass-1' });
  const s = await session(accountsDir(nodefs, root), 'Nabil Munla', { account: 'nabil' });
  await writeBackup({ fs: nodefs, root, kind: 'accounts', projectDir: accountsDir(nodefs, root), folder: '_accounts', projectId: s.meta.id, projectName: 'Accounts', store: s.store, by: 'nabil', host: 'PC1', app: '0.15.0' });
  await s.close();
  const days = await listBackupDays(nodefs, backupDirOf(nodefs, root, 'accounts', '', ''));
  const b = await readBackup(nodefs, days[0].file);
  delete (b as any).lines; // as an earlier version wrote it
  assert.deepEqual([...adminSet(storeFromBackup(b))], ['nabil'], 'the sign-in check sees the administrator');
  const jd = join(accountsDir(nodefs, root), 'journals');
  for (const f of readdirSync(jd)) rmSync(join(jd, f));
  await restoreAccounts(nodefs, root, 'PC1', b, 'nabil');
  const back = await loadAccountStore(nodefs, root);
  assert.deepEqual([...adminSet(back.store)], ['nabil'], 'still an administrator after the restore');
  assert.ok((await checkLogin(back.store, 'nabil', 'admin-pass-1')).ok);
});
