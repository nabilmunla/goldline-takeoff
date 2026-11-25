// v0.13: the backups and the team folder somewhere else; setup codes and names with titles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, symlinkSync, unlinkSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { ProjectSession } from '../src/engine/session';
import { createProject } from '../src/engine/projects';
import { demoBoqOps } from './helpers/demoboq';
import {
  initAccounts, loadAccountStore, accountsDir, getAccount, adminSet, rootsOf, checkLogin, appendOneOff, trustedGet, CFG,
  newAccountOps, firstName, suggestUsername, setBackupFolderOps, backupBase,
} from '../src/engine/accounts';
import { writeBackup, listBackups, listBackupDays, backupDirOf, mergeBackupSets, BackupKeeper } from '../src/engine/backups';
import {
  syncJournals, moveBackupSets, countBackupSets, moveTeamFolder, movedTarget, checkNewTeamFolder, clearOldTeamFolder, samePath, MOVED_FILE, onDisk, parentsOf, whoIsThere, copyTree,
  type CopyFs,
} from '../src/engine/teamfolder';
import type { FsApi } from '../src/engine/types';

const require = createRequire(import.meta.url);
const nodefs: CopyFs = require('../electron/nodefs.cjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'gt13-'));

async function session(dir: string, user: string) {
  const s = new ProjectSession({ fs: nodefs as FsApi, localFs: nodefs as FsApi, projectDir: dir, localDir: tmp(), user, account: user.toLowerCase().replace(/\s+/g, '.'), host: 'PC-' + user, pollMs: 60000, fullScanMs: 0, heartbeatMs: 60000 });
  await s.open();
  return s;
}

const filesUnder = (d: string): string[] => (existsSync(d) ? readdirSync(d, { recursive: true }).map(String).filter((f) => statSync(join(d, f)).isFile()) : []);

// ---------------------------------------------------------------- names
test('titles are not part of a first name or a username', () => {
  assert.equal(firstName('Engr. Tariq Mohamed'), 'Tariq');
  assert.equal(firstName('Dr. Eng. Ahmed Ali'), 'Ahmed');
  assert.equal(firstName('Nabil Munla'), 'Nabil');
  assert.equal(firstName('Engineer Sami'), 'Engineer', 'a word that only starts like a title stays');
  assert.equal(firstName('Engr.'), 'Engr.', 'nothing but a title: said as it is');
  assert.equal(suggestUsername('Engr. Tariq Mohamed'), 'tariq.mohamed');
  assert.equal(suggestUsername('Mr Omar Khan'), 'omar.khan');
});

// ---------------------------------------------------------------- backups elsewhere
test('backups go to the folder an administrator chose, and nowhere else', async () => {
  const data = tmp();
  const chosen = tmp();
  const { dir, meta } = await createProject(nodefs, data, 'Marina', 'Nabil', 'PC1', demoBoqOps());
  const s = await session(dir, 'Nabil');
  const w = await writeBackup({ fs: nodefs, root: data, base: chosen, kind: 'qto', projectDir: dir, folder: 'Marina', projectId: meta.id, projectName: 'Marina', store: s.store, by: 'nabil', host: 'PC1', app: '0.13.0' });
  assert.ok(w.file.startsWith(chosen), 'written in the chosen folder');
  assert.equal(existsSync(join(data, '_backups')), false, 'nothing next to the projects');
  assert.equal((await listBackups(nodefs, data, chosen)).length, 1);
  // a chosen folder that has gone (a dropped drive) is never made again
  await assert.rejects(writeBackup({ fs: nodefs, root: data, base: join(chosen, 'gone'), kind: 'qto', projectDir: dir, folder: 'Marina', projectId: meta.id, projectName: 'Marina', store: s.store, by: 'nabil', host: 'PC1', app: '0.13.0' }), /backups folder is not reachable/);
  assert.equal(existsSync(join(chosen, 'gone')), false);
  await s.close();
});

test('an open project follows a change of backups folder', async () => {
  const data = tmp();
  const chosen = tmp();
  const { dir, meta } = await createProject(nodefs, data, 'Villa', 'Nabil', 'PC1', demoBoqOps());
  const s = await session(dir, 'Nabil');
  let base: string | null = null;
  let now = Date.UTC(2026, 9, 28, 9);
  const k = new BackupKeeper({ fs: nodefs, root: data, kind: 'qto', projectDir: dir, folder: 'Villa', projectId: meta.id, projectName: 'Villa', by: 'nabil', host: 'PC1', app: '0.13.0', session: s, now: () => now, baseOf: () => base, every: 3600 * 1000 });
  await k.opened();
  assert.equal((await listBackupDays(nodefs, backupDirOf(nodefs, data, 'qto', 'Villa', meta.id))).length, 1, 'first one in the usual place');
  base = chosen;
  s.commit([['project', 'note', 'changed']]);
  now += 86400000;
  await k.tick();
  assert.equal((await listBackupDays(nodefs, backupDirOf(nodefs, data, 'qto', 'Villa', meta.id, chosen))).length, 1, 'the next one in the new place');
  await k.closing();
  await s.close();
});

test('roots: the backups folders are an administrator’s to set', async () => {
  const data = tmp();
  await initAccounts(nodefs, data, 'PC1', { username: 'nabil', name: 'Nabil Munla', password: 'admin-pass-1' });
  const s = await session(accountsDir(nodefs, data), 'Nabil');
  s.commit(setBackupFolderOps('team', '\\\\srv\\bak\\team'));
  await appendOneOff(nodefs, accountsDir(nodefs, data), 'Omar', 'omar', 'PC5', setBackupFolderOps('team', '\\\\fileserver\\mine'), 'sneaky');
  await s.close();
  const { store } = await loadAccountStore(nodefs, data);
  const r = rootsOf(store, data);
  assert.equal(r.bak.team, '\\\\srv\\bak\\team', 'a non-administrator can’t send the backups anywhere');
  assert.equal(backupBase(r, 'qto'), '\\\\srv\\bak\\team');
  assert.equal(backupBase(r, 'accounts'), '\\\\srv\\bak\\team');
});

test('moving backups: only the kinds asked for, nothing overwritten, the old ones removed once copied', async () => {
  const data = tmp();
  const to = tmp();
  const e = await createProject(nodefs, data, 'Est A', 'Nabil', 'PC1', demoBoqOps());
  const q = await createProject(nodefs, data, 'QTO A', 'Nabil', 'PC1', []);
  const se = await session(e.dir, 'Nabil');
  const sq = await session(q.dir, 'Ahmed');
  const day = (d: number) => Date.UTC(2026, 9, d, 9);
  for (const d of [20, 21, 22]) await writeBackup({ fs: nodefs, root: data, kind: 'qto', projectDir: e.dir, folder: 'Est A', projectId: e.meta.id, projectName: 'Est A', store: se.store, by: 'nabil', host: 'PC1', app: '0.13.0', now: day(d) });
  await writeBackup({ fs: nodefs, root: data, kind: 'accounts', projectDir: q.dir, folder: 'QTO A', projectId: q.meta.id, projectName: 'QTO A', store: sq.store, by: 'ahmed', host: 'PC2', app: '0.13.0', now: day(22) });
  // today's backup was already written in the new place (the setting was seen first): it stays
  const newer = await writeBackup({ fs: nodefs, root: data, base: to, kind: 'qto', projectDir: e.dir, folder: 'Est A', projectId: e.meta.id, projectName: 'Est A', store: se.store, by: 'nabil', host: 'PC1', app: '0.13.0', now: day(22) });
  const before = readFileSync(newer.file);
  const from = join(data, '_backups');
  assert.equal(await countBackupSets(nodefs, from, ['qto']), 1);
  const r = await moveBackupSets(nodefs, from, to, ['qto']);
  assert.equal(r.moved, 1);
  assert.equal(r.left, 0);
  assert.deepEqual(readFileSync(newer.file), before, 'the newer file in the new place is kept as it was');
  assert.deepEqual((await listBackupDays(nodefs, backupDirOf(nodefs, data, 'qto', 'Est A', e.meta.id, to))).map((d) => d.day), ['2026-10-22', '2026-10-21', '2026-10-20']);
  assert.equal(existsSync(backupDirOf(nodefs, data, 'qto', 'Est A', e.meta.id)), false, 'gone from the old place');
  assert.equal((await listBackups(nodefs, data)).length, 1, 'the take-off’s backups stay');
  assert.equal((await listBackups(nodefs, data))[0].about?.kind, 'accounts');
  await assert.rejects(moveBackupSets(nodefs, from, join(from, 'inner'), ['accounts']), /inside/);
  // what wasn't moved (another place) is still listed with the rest
  await writeBackup({ fs: nodefs, root: data, kind: 'qto', projectDir: e.dir, folder: 'Est A', projectId: e.meta.id, projectName: 'Est A', store: se.store, by: 'nabil', host: 'PC1', app: '0.13.0', now: day(23) });
  const merged = mergeBackupSets([await listBackups(nodefs, data, to), await listBackups(nodefs, data)]).filter((x) => x.about?.kind === 'qto');
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].days.map((d) => d.day), ['2026-10-23', '2026-10-22', '2026-10-21', '2026-10-20']);
  assert.equal(merged[0].dirs?.length, 2);
  await se.close();
  await sq.close();
});

// ---------------------------------------------------------------- journals
test('copying journals: what is missing, once; a file that is there is never changed', async () => {
  const a = tmp();
  const b = tmp();
  await initAccounts(nodefs, a, 'PC1', { username: 'nabil', name: 'Nabil Munla', password: 'admin-pass-1' });
  const r1 = await syncJournals(nodefs, accountsDir(nodefs, a), accountsDir(nodefs, b));
  assert.ok(r1.changes > 0);
  assert.equal((await syncJournals(nodefs, accountsDir(nodefs, a), accountsDir(nodefs, b))).changes, 0, 'nothing twice');
  // more in the old place, in a file both have
  const jn = readdirSync(join(accountsDir(nodefs, b), 'journals'));
  const sizes = jn.map((f) => statSync(join(accountsDir(nodefs, b), 'journals', f)).size);
  const s = await session(accountsDir(nodefs, a), 'Nabil');
  s.commit([['user:nabil', 'name', 'Nabil M.']]);
  await s.close();
  const r2 = await syncJournals(nodefs, accountsDir(nodefs, a), accountsDir(nodefs, b));
  assert.equal(r2.changes, 1);
  assert.deepEqual(jn.map((f) => statSync(join(accountsDir(nodefs, b), 'journals', f)).size), sizes, 'files already there untouched');
  const { store } = await loadAccountStore(nodefs, b);
  assert.equal(getAccount(store, 'nabil')?.name, 'Nabil M.');
});

// ---------------------------------------------------------------- the team folder
async function team() {
  const old = tmp();
  await initAccounts(nodefs, old, 'PC1', { username: 'nabil.munla', name: 'Nabil Munla', password: 'admin-pass-1' });
  const s = await session(accountsDir(nodefs, old), 'Nabil Munla');
  const { ops } = await newAccountOps('nabil.munla', { username: 'sara', name: 'Sara Ali', role: 'qs' });
  s.commit(ops);
  s.commit([['user:sara', 'pw', null]]);
  // a release on the share
  const rel = join(old, '_releases');
  mkdirSync(join(rel, '0.13.0', 'dist'), { recursive: true });
  writeFileSync(join(rel, '0.13.0', 'dist', 'index.html'), '<html>');
  writeFileSync(join(rel, 'Goldline Takeoff Setup 0.13.0.exe'), 'MZ setup');
  writeFileSync(join(rel, 'latest.json'), JSON.stringify({ version: '0.13.0', folder: '0.13.0', files: [{ path: 'dist/index.html' }], setup: { file: 'Goldline Takeoff Setup 0.13.0.exe', size: 8, sha256: '0'.repeat(64) } }));
  // the accounts' backup
  await writeBackup({ fs: nodefs, root: old, kind: 'accounts', projectDir: accountsDir(nodefs, old), folder: '_accounts', projectId: s.meta.id, projectName: 'Accounts', store: s.store, by: 'nabil', host: 'PC1', app: '0.13.0' });
  return { old, s };
}

test('moving the team folder: everything the team needs, the projects stay put, everybody is sent on', async () => {
  const { old, s } = await team();
  const to = tmp();
  const proj = await createProject(nodefs, old, 'Tower', 'Nabil', 'PC1', demoBoqOps());
  const roots = rootsOf(s.store, old);
  assert.equal(await checkNewTeamFolder(nodefs, old, old), 'That is the team folder already.');
  assert.match((await checkNewTeamFolder(nodefs, old, join(old, '_accounts', 'x'))) ?? '', /inside _accounts/);
  assert.match((await checkNewTeamFolder(nodefs, old, join(to, 'missing'))) ?? '', /can’t be reached/);
  const other = tmp();
  await initAccounts(nodefs, other, 'PC9', { username: 'x', name: 'X', password: 'other-pass-1' });
  assert.match((await checkNewTeamFolder(nodefs, old, other)) ?? '', /accounts of its own/);
  assert.equal(await checkNewTeamFolder(nodefs, old, to), null);

  const steps: string[] = [];
  const r = await moveTeamFolder({ fs: nodefs, from: old, to, roots, by: { username: 'nabil.munla', name: 'Nabil Munla' }, host: 'PC1', oldStore: s.store, commitOld: (ops, label) => !!s.commit(ops, label), step: (t) => steps.push(t) });
  assert.ok(r.changes > 0 && r.release && r.backups > 0);
  assert.ok(steps.length >= 3);
  // the new folder: same people, same passwords, same accounts id
  const { store } = await loadAccountStore(nodefs, to);
  assert.ok((await checkLogin(store, 'nabil.munla', 'admin-pass-1')).ok, 'the same password works');
  assert.ok(adminSet(store).has('nabil.munla'));
  assert.equal(getAccount(store, 'sara')?.role, 'qs');
  assert.equal(JSON.parse(readFileSync(join(to, '_accounts', 'project.json'), 'utf8')).id, s.meta.id);
  // the projects stay where they are (the folders are written down)
  const nr = rootsOf(store, to);
  assert.ok(samePath(nr.qto, old), 'the take-off folder stays the old team folder');
  assert.ok(existsSync(join(proj.dir, 'project.json')));
  assert.equal(trustedGet(store, CFG, 'movedFrom'), old);
  // the release and the setup, so updates go on from the new folder
  assert.ok(existsSync(join(to, '_releases', 'latest.json')));
  assert.ok(existsSync(join(to, '_releases', '0.13.0', 'dist', 'index.html')));
  assert.ok(existsSync(join(to, '_releases', 'Goldline Takeoff Setup 0.13.0.exe')));
  assert.equal(filesUnder(join(to, '_backups', '_accounts')).filter((f) => f.endsWith('.json.gz')).length, 1, 'the accounts’ backup came along');
  // the old folder sends everybody on
  await new Promise((res) => setTimeout(res, 20));
  const t = await movedTarget(nodefs, old, s.store);
  assert.deepEqual(t, { to, ok: true, cleared: false });
  const fresh = await loadAccountStore(nodefs, old);
  assert.deepEqual(await movedTarget(nodefs, old, fresh.store), { to, ok: true, cleared: false }, 'a PC starting now is sent on too');
  assert.equal(await movedTarget(nodefs, to, store), null, 'the new folder doesn’t send anyone back');
  await s.close();
});

test('only an administrator can send everybody somewhere else', async () => {
  const { old, s } = await team();
  await s.close();
  const evil = tmp();
  mkdirSync(join(evil, '_accounts'), { recursive: true });
  writeFileSync(join(evil, '_accounts', 'project.json'), readFileSync(join(old, '_accounts', 'project.json')));
  await appendOneOff(nodefs, accountsDir(nodefs, old), 'Sara Ali', 'sara', 'PC7', [[CFG, 'movedTo', evil]], 'sneaky');
  const { store } = await loadAccountStore(nodefs, old);
  assert.equal(await movedTarget(nodefs, old, store), null, 'ignored');
  // nor does a note left beside accounts that are there count
  writeFileSync(join(old, '_accounts', MOVED_FILE), JSON.stringify({ format: 'takeoff-moved', to: evil, id: 'x', at: 1, by: 'sara' }));
  assert.equal(await movedTarget(nodefs, old, store), null);
});

test('after the move: a late change in the old folder comes along; the old copy cleared; a PC off since still finds its way', async () => {
  const { old, s } = await team();
  const to = tmp();
  await moveTeamFolder({ fs: nodefs, from: old, to, roots: rootsOf(s.store, old), by: { username: 'nabil.munla', name: 'Nabil Munla' }, host: 'PC1', oldStore: s.store, commitOld: (ops, label) => !!s.commit(ops, label) });
  await s.close();
  // Sara was still signed in to the old folder and changed her name before her PC noticed
  const sara = await session(accountsDir(nodefs, old), 'Sara Ali');
  sara.commit([['user:sara', 'name', 'Sara A. Ali']]);
  await sara.close();
  // her PC follows: brings what only the old folder has
  const r = await syncJournals(nodefs, accountsDir(nodefs, old), accountsDir(nodefs, to));
  assert.ok(r.changes >= 1);
  assert.equal(getAccount((await loadAccountStore(nodefs, to)).store, 'sara')?.name, 'Sara A. Ali');
  // a change only the old folder got after that (a PC that never followed)
  const late = await session(accountsDir(nodefs, old), 'Omar');
  late.commit([['user:nabil.munla', 'lastHost', 'PC-LATE']]);
  await late.close();
  // clearing: brought over first, then removed; the note stays
  const other = tmp();
  await initAccounts(nodefs, other, 'PC9', { username: 'x', name: 'X', password: 'other-pass-1' });
  await assert.rejects(clearOldTeamFolder(nodefs, other, to, backupDirOf(nodefs, to, 'accounts', '', '')), /another team/);
  const c = await clearOldTeamFolder(nodefs, old, to, backupDirOf(nodefs, to, 'accounts', '', ''));
  assert.ok(c.changes >= 1 && c.removed > 0);
  assert.equal(getAccount((await loadAccountStore(nodefs, to)).store, 'nabil.munla')?.lastHost, 'PC-LATE');
  const left = await loadAccountStore(nodefs, old);
  assert.equal(getAccount(left.store, 'nabil.munla'), null, 'nobody left in the old accounts');
  assert.equal(left.exists, true, 'a pointer stays: an older app shows a sign-in nobody can use, not "set up accounts"');
  await assert.rejects(initAccounts(nodefs, old, 'PC-OLD', { username: 'omar', name: 'Omar', password: 'omar-pass-12' }), /meanwhile|Sign in/, 'nobody can set up new accounts there');
  assert.ok(existsSync(join(old, '_accounts', MOVED_FILE)));
  assert.equal(filesUnder(join(old, '_backups', '_accounts')).length, 0, 'the old accounts’ backups went with them');
  assert.ok(filesUnder(join(to, '_backups', '_accounts')).some((f) => f.endsWith('.json.gz')));
  // a PC that was off all along: the note sends it on
  assert.deepEqual(await movedTarget(nodefs, old, null), { to, ok: true, cleared: true });
  // the new folder unreachable from some PC: told, not sent
  const gone = join(tmp(), 'nope');
  const pj = JSON.parse(readFileSync(join(old, '_accounts', 'project.json'), 'utf8'));
  writeFileSync(join(old, '_accounts', 'project.json'), JSON.stringify({ ...pj, moved: { ...pj.moved, to: gone } }));
  assert.equal((await movedTarget(nodefs, old, null))?.ok, false);
});

test('moving back again doesn’t send anybody round in circles', async () => {
  const { old: a, s } = await team();
  const b = tmp();
  await moveTeamFolder({ fs: nodefs, from: a, to: b, roots: rootsOf(s.store, a), by: { username: 'nabil.munla', name: 'Nabil Munla' }, host: 'PC1', oldStore: s.store, commitOld: (ops, label) => !!s.commit(ops, label) });
  await s.close();
  const sb = await session(accountsDir(nodefs, b), 'Nabil Munla');
  assert.equal(await checkNewTeamFolder(nodefs, b, a), null, 'the old folder (same accounts) can take them back');
  await moveTeamFolder({ fs: nodefs, from: b, to: a, roots: rootsOf(sb.store, b), by: { username: 'nabil.munla', name: 'Nabil Munla' }, host: 'PC1', oldStore: sb.store, commitOld: (ops, label) => !!sb.commit(ops, label) });
  await sb.close();
  // B sends people to A; A sends nobody anywhere (even after the last changes of B are copied in)
  await syncJournals(nodefs, accountsDir(nodefs, b), accountsDir(nodefs, a));
  const sa = (await loadAccountStore(nodefs, a)).store;
  assert.equal(await movedTarget(nodefs, a, sa), null);
  assert.deepEqual(await movedTarget(nodefs, b, (await loadAccountStore(nodefs, b)).store), { to: a, ok: true, cleared: false });
  assert.ok(adminSet(sa).has('nabil.munla'));
});

test('a journal line still being written is not copied until it is whole', async () => {
  const a = tmp();
  const b = tmp();
  await initAccounts(nodefs, a, 'PC1', { username: 'nabil', name: 'Nabil Munla', password: 'admin-pass-1' });
  const s = await session(accountsDir(nodefs, a), 'Nabil');
  s.commit([['user:nabil', 'name', 'One']]);
  await s.close();
  const jdir = join(accountsDir(nodefs, a), 'journals');
  const f = readdirSync(jdir).find((x) => /_vm_|PC-Nabil/.test(x)) ?? readdirSync(jdir)[0];
  const text = readFileSync(join(jdir, f), 'utf8');
  const lines = text.trim().split('\n');
  const last = lines[lines.length - 1];
  // a copy of the file with its last line cut in half (being written as we read)
  const c = tmp();
  mkdirSync(join(c, 'journals'), { recursive: true });
  for (const x of readdirSync(jdir)) if (x !== f) writeFileSync(join(c, 'journals', x), readFileSync(join(jdir, x)));
  writeFileSync(join(c, 'journals', f), lines.slice(0, -1).join('\n') + '\n' + last.slice(0, 20));
  writeFileSync(join(c, 'project.json'), readFileSync(join(accountsDir(nodefs, a), 'project.json')));
  const r1 = await syncJournals(nodefs, c, accountsDir(nodefs, b));
  assert.ok(r1.changes >= 1);
  const { store: s1 } = await loadAccountStore(nodefs, b);
  assert.notEqual(getAccount(s1, 'nabil')?.name, 'One', 'the half line is not copied');
  writeFileSync(join(c, 'journals', f), text);
  const r2 = await syncJournals(nodefs, c, accountsDir(nodefs, b));
  assert.equal(r2.changes, 1, 'once whole, it is');
  assert.equal(getAccount((await loadAccountStore(nodefs, b)).store, 'nabil')?.name, 'One');
});

test('backups that can’t all be copied stay in the old place', async () => {
  const data = tmp();
  const to = tmp();
  const { dir, meta } = await createProject(nodefs, data, 'Est B', 'Nabil', 'PC1', demoBoqOps());
  const s = await session(dir, 'Nabil');
  for (const d of [20, 21]) await writeBackup({ fs: nodefs, root: data, kind: 'qto', projectDir: dir, folder: 'Est B', projectId: meta.id, projectName: 'Est B', store: s.store, by: 'nabil', host: 'PC1', app: '0.13.0', now: Date.UTC(2026, 9, d, 9) });
  await s.close();
  // the server refuses the second file (disk full, no permission)
  let n = 0;
  const flaky: CopyFs = { ...nodefs, copy: async (a: string, b: string) => { if (++n === 2) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }); return nodefs.copy!(a, b); } };
  const r = await moveBackupSets(flaky, join(data, '_backups'), to, ['qto']);
  assert.equal(r.moved, 0);
  assert.equal(r.left, 1, 'counted as not moved');
  assert.match(r.error ?? '', /no space/);
  assert.equal((await listBackupDays(nodefs, backupDirOf(nodefs, data, 'qto', 'Est B', meta.id))).length, 2, 'both days still in the old place');
});

test('a moved folder pointing at another team’s accounts is not followed', async () => {
  const { old, s } = await team();
  const other = tmp();
  await initAccounts(nodefs, other, 'PC9', { username: 'x', name: 'X', password: 'other-pass-1' });
  s.commit([[CFG, 'movedTo', other]]);
  const t = await movedTarget(nodefs, old, s.store);
  assert.equal(t?.ok, false);
  assert.match(t?.why ?? '', /another team/);
  await s.close();
  // the team folder can move one level up (the old one sits inside the new one)
  const parent = tmp();
  const inner = join(parent, 'Team');
  mkdirSync(inner);
  assert.equal(await checkNewTeamFolder(nodefs, old, parent), null);
});


// ---------------------------------------------------------------- review fixes (debug run 2)
test('parentsOf: drive letters, server paths, Linux paths', () => {
  assert.deepEqual(parentsOf('S:\\Est\\Team'), ['S:\\Est', 'S:\\']);
  assert.deepEqual(parentsOf('\\\\srv\\share\\Est\\Team\\'), ['\\\\srv\\share\\Est', '\\\\srv\\share']);
  assert.deepEqual(parentsOf('/tmp/a/b'), ['/tmp/a', '/tmp', '/']);
});

test('one folder under two names (S:\\ and \\\\server\\share) is one folder: nothing is "moved" onto itself and deleted', async () => {
  const real = tmp();
  const alias = join(tmp(), 'X-drive');
  symlinkSync(real, alias);
  assert.equal(await onDisk(nodefs, alias, real), 'same');
  assert.equal(await onDisk(nodefs, join(alias, 'sub'), real), null, 'a folder that is not there has nothing to lose');
  mkdirSync(join(real, 'sub'));
  assert.equal(await onDisk(nodefs, alias, join(real, 'sub')), 'b-in-a');
  assert.equal(await onDisk(nodefs, join(real, 'sub'), alias), 'a-in-b');
  assert.deepEqual(readdirSync(real), ['sub'], 'no marker left behind');
  // backups "moved" to the same folder by its other name: all still there
  const { dir, meta } = await createProject(nodefs, real, 'Marina', 'Nabil', 'PC1', demoBoqOps());
  const s = await session(dir, 'Nabil');
  for (const d of [20, 21]) await writeBackup({ fs: nodefs, root: real, kind: 'qto', projectDir: dir, folder: 'Marina', projectId: meta.id, projectName: 'Marina', store: s.store, by: 'nabil', host: 'PC1', app: '0.13.0', now: Date.UTC(2026, 9, d, 9) });
  await s.close();
  const r = await moveBackupSets(nodefs, join(alias, '_backups'), join(real, '_backups'), ['qto']);
  assert.equal(r.moved, 0);
  assert.equal(filesUnder(join(real, '_backups')).filter((f) => f.endsWith('.json.gz')).length, 2, 'both backups still there');
  // the team folder "moved" onto itself, or its "old copy" cleared when it is the live one: refused
  await initAccounts(nodefs, real, 'PC1', { username: 'nabil', name: 'Nabil Munla', password: 'admin-pass-1' });
  assert.match((await checkNewTeamFolder(nodefs, alias, real)) ?? '', /under another name/);
  await assert.rejects(clearOldTeamFolder(nodefs, alias, real, backupDirOf(nodefs, real, 'accounts', '', '')), /under another name/);
  assert.equal((await loadAccountStore(nodefs, real)).exists, true, 'the live accounts are untouched');
});

test('the live accounts are never taken for a backup, and the team folder never goes into a backups folder', async () => {
  const team = tmp();
  await initAccounts(nodefs, team, 'PC1', { username: 'nabil', name: 'Nabil Munla', password: 'admin-pass-1' });
  const s = await session(accountsDir(nodefs, team), 'Nabil');
  const S = tmp();
  s.commit(setBackupFolderOps('team', S));
  await writeBackup({ fs: nodefs, root: team, base: S, kind: 'accounts', projectDir: accountsDir(nodefs, team), folder: '_accounts', projectId: s.meta.id, projectName: 'Accounts', store: s.store, by: 'nabil', host: 'PC1', app: '0.13.0' });
  assert.match((await checkNewTeamFolder(nodefs, team, S, rootsOf(s.store, team))) ?? '', /backups folder/);
  await s.close();
  // a folder holding live accounts (as if someone had put them there anyway) is not a backup set
  const Y = tmp();
  mkdirSync(join(Y, 'x'));
  const live = tmp();
  await initAccounts(nodefs, live, 'PC1', { username: 'nabil', name: 'Nabil Munla', password: 'admin-pass-1' });
  assert.equal(await countBackupSets(nodefs, live, ['accounts', 'qto']), 0, 'the live _accounts is not a backup');
  const r = await moveBackupSets(nodefs, live, join(Y, 'x'), ['qto', 'accounts']);
  assert.equal(r.moved, 0);
  assert.equal((await loadAccountStore(nodefs, live)).exists, true);
  assert.equal(await countBackupSets(nodefs, S, ['accounts']), 1, 'a real accounts backup still counts');
});

test('a second move from the old folder is refused; a move needs the old accounts to take the change', async () => {
  const { old, s } = await team();
  const b = tmp();
  await moveTeamFolder({ fs: nodefs, from: old, to: b, roots: rootsOf(s.store, old), by: { username: 'nabil.munla', name: 'Nabil Munla' }, host: 'PC1', oldStore: s.store, commitOld: (o, l) => !!s.commit(o, l) });
  const c = tmp();
  await assert.rejects(moveTeamFolder({ fs: nodefs, from: old, to: c, roots: rootsOf(s.store, old), by: { username: 'nabil.munla', name: 'Nabil Munla' }, host: 'PC2', oldStore: s.store, commitOld: (o, l) => !!s.commit(o, l) }), /already/);
  await s.close();
  // the old accounts can't be changed (view only, a newer version): nothing points anywhere
  const { old: old2, s: s2 } = await team();
  const d = tmp();
  await assert.rejects(moveTeamFolder({ fs: nodefs, from: old2, to: d, roots: rootsOf(s2.store, old2), by: { username: 'nabil.munla', name: 'Nabil Munla' }, host: 'PC1', oldStore: s2.store, commitOld: () => false }), /could not be changed/);
  assert.equal(existsSync(join(old2, '_accounts', MOVED_FILE)), false);
  assert.equal(await movedTarget(nodefs, old2, (await loadAccountStore(nodefs, old2)).store), null);
  await s2.close();
});

test('the projects are pinned as every PC reaches them; the new folder never points at itself', async () => {
  const { old, s } = await team();
  const to = tmp();
  await moveTeamFolder({ fs: nodefs, from: old, to, pinAs: '\\\\srv\\share\\Team', roots: rootsOf(s.store, old), by: { username: 'nabil.munla', name: 'Nabil Munla' }, host: 'PC1', oldStore: s.store, commitOld: (o, l) => !!s.commit(o, l) });
  await s.close();
  // a follower copies the old folder's changes (its "moved to" among them) after the move
  await syncJournals(nodefs, accountsDir(nodefs, old), accountsDir(nodefs, to));
  const { store } = await loadAccountStore(nodefs, to);
  const r = rootsOf(store, to);
  assert.equal(r.qto, '\\\\srv\\share\\Team');
  assert.equal(trustedGet(store, CFG, 'movedFrom'), '\\\\srv\\share\\Team');
  assert.equal(trustedGet(store, CFG, 'movedTo'), null, 'the old "moved to" never wins in the new folder');
  // reached by another name, the new folder still sends nobody anywhere
  const alias = join(tmp(), 'Y-drive');
  symlinkSync(to, alias);
  assert.equal(await movedTarget(nodefs, alias, store), null);
});

test('a note is followed only where the accounts were cleared away; moving back drops an old note', async () => {
  const { old, s } = await team();
  await s.close();
  const evil = tmp();
  mkdirSync(join(evil, '_accounts', 'journals'), { recursive: true });
  writeFileSync(join(evil, '_accounts', 'project.json'), readFileSync(join(old, '_accounts', 'project.json')));
  writeFileSync(join(old, '_accounts', MOVED_FILE), JSON.stringify({ format: 'takeoff-moved', to: evil, id: 'x', at: 1, by: 'x' }));
  unlinkSync(join(old, '_accounts', 'project.json'));
  const r = await loadAccountStore(nodefs, old);
  assert.equal(r.exists, true);
  assert.equal(await movedTarget(nodefs, old, r.store), null, 'journals are there: the note is not followed');
  // A -> B -> A, B cleared: A keeps no note pointing at B
  const { old: a, s: sa } = await team();
  const b = tmp();
  await moveTeamFolder({ fs: nodefs, from: a, to: b, roots: rootsOf(sa.store, a), by: { username: 'nabil.munla', name: 'Nabil Munla' }, host: 'PC1', oldStore: sa.store, commitOld: (o, l) => !!sa.commit(o, l) });
  await sa.close();
  const sb = await session(accountsDir(nodefs, b), 'Nabil Munla');
  await moveTeamFolder({ fs: nodefs, from: b, to: a, roots: rootsOf(sb.store, b), by: { username: 'nabil.munla', name: 'Nabil Munla' }, host: 'PC1', oldStore: sb.store, commitOld: (o, l) => !!sb.commit(o, l) });
  await sb.close();
  await clearOldTeamFolder(nodefs, b, a, backupDirOf(nodefs, a, 'accounts', '', ''));
  assert.equal(existsSync(join(a, '_accounts', MOVED_FILE)), false, 'no stale note in A');
  assert.equal(await movedTarget(nodefs, a, (await loadAccountStore(nodefs, a)).store), null);
  // B was cleared: a pointer project.json, followed by everyone starting there
  assert.equal(JSON.parse(readFileSync(join(b, '_accounts', 'project.json'), 'utf8')).moved?.to, a);
  assert.deepEqual(await movedTarget(nodefs, b, (await loadAccountStore(nodefs, b)).store), { to: a, ok: true, cleared: true });
  // and if A's accounts are lost later, A offers set-up / restore (not "moved")
  rmSync(join(a, '_accounts'), { recursive: true, force: true });
  assert.equal(await movedTarget(nodefs, a, null), null);
});

test('who is still working in the old folder', async () => {
  const { old, s } = await team();
  const here = await whoIsThere(nodefs, old);
  assert.deepEqual(here.map((p) => p.name), ['Nabil Munla']);
  await s.close();
  assert.deepEqual(await whoIsThere(nodefs, old), [], 'closed: gone');
});

test('moving backups leaves a file that was written again since it was copied', async () => {
  const from = tmp();
  const to = tmp();
  mkdirSync(join(from, 'P__1__aaaaaa'));
  writeFileSync(join(from, 'P__1__aaaaaa', 'about.json'), JSON.stringify({ kind: 'qto' }));
  writeFileSync(join(from, 'P__1__aaaaaa', '2026-10-27.json.gz'), 'old day');
  writeFileSync(join(from, 'P__1__aaaaaa', '2026-10-28.json.gz'), 'today');
  // today's file was written in the new place already, and again in the old place AFTER it (a PC
  // that hadn't heard of the new place yet)
  mkdirSync(join(to, 'P__1__aaaaaa'));
  writeFileSync(join(to, 'P__1__aaaaaa', '2026-10-28.json.gz'), 'today, new place');
  const t = Date.now() / 1000;
  utimesSync(join(to, 'P__1__aaaaaa', '2026-10-28.json.gz'), t - 60, t - 60);
  utimesSync(join(from, 'P__1__aaaaaa', '2026-10-28.json.gz'), t, t);
  const r = await moveBackupSets(nodefs, from, to, ['qto']);
  assert.equal(r.left, 1, 'not all of it could go');
  assert.ok(existsSync(join(from, 'P__1__aaaaaa', '2026-10-28.json.gz')), 'the newer file in the old place stays');
  assert.equal(existsSync(join(from, 'P__1__aaaaaa', '2026-10-27.json.gz')), false, 'what was copied is gone from there');
  assert.equal(readFileSync(join(to, 'P__1__aaaaaa', '2026-10-27.json.gz'), 'utf8'), 'old day');
  void copyTree;
});
