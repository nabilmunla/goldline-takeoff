// Backups of take-offs and BOQ hubs (Goldline Takeoff): automatic days, backups made by hand, rolling a project
// back (one change on top, undoable), a copy as a new project, and broken backup files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Store } from '../src/engine/store';
import { ProjectSession } from '../src/engine/session';
import { createProject, readProjectStore } from '../src/engine/projects';
import {
  writeBackup, writeManualBackup, listBackupDays, listBackups, readBackup, restoreOps, rollbackOps, decodeBackup, encodeBackup,
  backupDirOf, MANUAL_KEEP, BackupKeeper, type BackupFs,
} from '../src/engine/backups';
import { buildQtoModel } from '../src/engine/qto/model';
import { pullOps } from '../src/engine/hub';
import type { FsApi, Op } from '../src/engine/types';

const require = createRequire(import.meta.url);
const nodefs: FsApi & BackupFs = require('../electron/nodefs.cjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'bk-'));
const J = (x: unknown) => JSON.stringify(x);
const sq = (x: number, y: number, s: number) => [x, y, x + s, y, x + s, y + s, x, y + s];
const DAY = 86400000;
const T0 = Date.UTC(2026, 10, 2, 10);

async function open(dir: string, who = 'qs1') {
  const s = new ProjectSession({ fs: nodefs, localFs: nodefs, projectDir: dir, localDir: tmp(), user: who, account: who, host: 'PC-' + who, pollMs: 60000, fullScanMs: 0, heartbeatMs: 60000, quiet: true });
  await s.open();
  return s;
}
/** a take-off with two measured areas */
async function takeoffOnShare() {
  const root = tmp();
  const ops: Op[] = [
    ['pg:d1.0', 'sc', 1], ['dwg:d1', 'name', 'A-101.pdf'],
    ['ti:a', 'name', 'Floor'], ['ti:a', 'kind', 'area'],
    ['sh:1', 'ti', 'ti:a'], ['sh:1', 'dwg', 'd1'], ['sh:1', 'pg', 0], ['sh:1', 'k', 'poly'], ['sh:1', 'p', J(sq(0, 0, 10))],
    ['sh:2', 'ti', 'ti:a'], ['sh:2', 'dwg', 'd1'], ['sh:2', 'pg', 0], ['sh:2', 'k', 'poly'], ['sh:2', 'p', J(sq(20, 0, 5))],
  ];
  const p = await createProject(nodefs, root, 'Tower – Arch', 'QS One', 'PC1', ops, 'qs1', 'takeoff');
  return { root, dir: p.dir, meta: p.meta, folder: p.dir.split(/[\\/]/).pop()! };
}
const area = (s: Store) => Math.round(buildQtoModel(s, null).itemTotals?.get?.('ti:a')?.total ?? [...buildQtoModel(s, null).shapes.values()].filter((x: any) => !x.deleted).length);
const bk = (t: Awaited<ReturnType<typeof takeoffOnShare>>, store: Store, now: number, extra: object = {}) =>
  ({ fs: nodefs, root: t.root, kind: 'qto' as const, projectDir: t.dir, folder: t.folder, projectId: t.meta.id, projectName: t.meta.name, store, by: 'qs1', host: 'PC1', app: 'test', now, ...extra });
/** what a user sees: every value, except the bookkeeping of the project entity */
function state(s: Store): string {
  const out: [string, [string, unknown][]][] = [];
  for (const [id, ent] of [...s.ents].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (id === 'project') continue;
    const fields = [...ent].filter(([, c]) => c.v !== null && c.v !== undefined).map(([f, c]) => [f, c.v] as [string, unknown]).sort(([a], [b]) => (a < b ? -1 : 1));
    if (ent.get('del')?.v === true) continue; // deleted = not there
    if (fields.length) out.push([id, fields]);
  }
  return J(out);
}

test('backups: the daily backup and backups made by hand live side by side; the clean-up never removes a hand-made one', async () => {
  const t = await takeoffOnShare();
  const s = await readProjectStore(nodefs, t.dir);
  const dir = backupDirOf(nodefs, t.root, 'qto', t.folder, t.meta.id);
  await writeBackup(bk(t, s, T0));
  const m1 = await writeManualBackup({ ...bk(t, s, T0 + 3600_000), note: 'Before the new issue' });
  const m2 = await writeManualBackup(bk(t, s, T0 + 3600_000)); // same second: the next one
  assert.notEqual(m1.file, m2.file);
  // 0.23.2 (DeepSeek #20): two at the very same moment (two PCs): two files, neither replaced
  // (each one's look at the name waits for the other's, as on two PCs)
  const waiting = new Map<string, () => void>();
  const raceFs: any = { ...nodefs, exists: async (p: string) => {
    if (/[\\/]m-[^\\/]+\.json\.gz$/.test(p)) {
      const other = waiting.get(p);
      if (other) { waiting.delete(p); other(); } else await new Promise<void>((r) => { waiting.set(p, r); setTimeout(() => { waiting.delete(p); r(); }, 300); });
    }
    return nodefs.exists(p);
  } };
  const both = await Promise.all([writeManualBackup({ ...bk(t, s, T0 + 7200_000), fs: raceFs }), writeManualBackup({ ...bk(t, s, T0 + 7200_000), fs: raceFs })]);
  assert.notEqual(both[0].file, both[1].file);
  for (const b of both) await readBackup(nodefs, b.file);
  assert.equal(readdirSync(dir).filter((f) => f.startsWith('.claim-')).length, 0, 'no claim files left');
  for (const b of both) rmSync(b.file);
  assert.equal((await listBackupDays(nodefs, dir)).length, 1, 'the daily list (clean-up) sees only the day files');
  const all = await listBackupDays(nodefs, dir, { manual: true });
  assert.equal(all.filter((d) => d.manual).length, 2);
  assert.match(all.find((d) => d.manual)!.day, /^2026-11-02 \d\d:\d\d:\d\d$/);
  assert.equal((await readBackup(nodefs, m1.file)).note, 'Before the new issue');
  // 120 days of daily backups with clean-up: the hand-made ones stay
  for (let d = 1; d <= 120; d++) await writeBackup(bk(t, s, T0 + d * DAY, { prune: true }));
  const after = await listBackupDays(nodefs, dir, { manual: true });
  assert.equal(after.filter((d) => d.manual).length, 2, 'hand-made backups survive the clean-up');
  assert.ok(after.filter((d) => !d.manual).length < 40, 'old days thinned out as before');
  const sets = await listBackups(nodefs, t.root);
  assert.equal(sets.length, 1);
  assert.equal(sets[0].days.filter((d) => d.manual).length, 2, 'the backups list shows them');
});

test('backups: only the last MANUAL_KEEP hand-made backups are kept', async () => {
  const t = await takeoffOnShare();
  const s = await readProjectStore(nodefs, t.dir);
  for (let i = 0; i < MANUAL_KEEP + 5; i++) await writeManualBackup(bk(t, s, T0 + i * 60_000));
  const dir = backupDirOf(nodefs, t.root, 'qto', t.folder, t.meta.id);
  const m = (await listBackupDays(nodefs, dir, { manual: true })).filter((d) => d.manual);
  assert.equal(m.length, MANUAL_KEEP);
  assert.ok(m.every((d) => d.day >= '2026-11-02'), 'the newest kept');
});

test('backups: rolling back brings the backup’s state back as one change - edits, additions and deletions - and can be undone', async () => {
  const t = await takeoffOnShare();
  const s = await open(t.dir);
  const before = state(s.store);
  const b = (await readBackup(nodefs, (await writeManualBackup(bk(t, s.store, T0))).file));
  // work after the backup: a shape moved, one deleted, a new one, a renamed take-off, a link
  s.commit([['sh:1', 'p', J(sq(0, 0, 12))], ['sh:2', 'del', true], ['sh:3', 'ti', 'ti:a'], ['sh:3', 'dwg', 'd1'], ['sh:3', 'pg', 0], ['sh:3', 'k', 'poly'], ['sh:3', 'p', J(sq(50, 0, 3))], ['ti:a', 'name', 'Floor finish'], ['lk:9', 'ti', 'ti:a'], ['lk:9', 'to', 'dm:x'], ['lk:9', 'q', 'area']], 'Work');
  const worked = state(s.store);
  assert.notEqual(worked, before);
  const ops = rollbackOps(s.store, b);
  s.commit(ops, 'Rolled back to ' + b.day);
  assert.equal(state(s.store), before, 'exactly the backup’s state');
  assert.equal(s.store.get('sh:3', 'del'), true, 'what was added since is deleted');
  assert.equal(s.store.get('sh:2', 'del') ?? null, null, 'what was deleted since is back');
  // the roll back is a change like any other: undo returns the work
  s.undo();
  assert.equal(state(s.store), worked, 'undo of the roll back');
  s.redo();
  assert.equal(state(s.store), before);
  await s.close();
  // and on the share, for everyone (journals only grew)
  assert.equal(state(await readProjectStore(nodefs, t.dir)), before);
});

test('backups: a roll back of a take-off on a BOQ hub leaves its BOQ copy and its hub alone', async () => {
  const t = await takeoffOnShare();
  const s = await open(t.dir);
  const hub = new Store();
  hub.apply({ s: '0000000001~h', w: 'h', u: 'a', a: 'a', t: 0, o: [['project', 'fmt', 14], ['l1', 'type', 'item'], ['l1', 'ord', 'a0'], ['l1', 'desc', 'Tiles'], ['l1', 'unit', 'm2'], ['l1', 'qty', 10], ['project', 'rev', 5]] });
  s.commit([['project', 'hub', 'H1'], ['project', 'hubName', 'Tower']], 'Attached');
  const b = await readBackup(nodefs, (await writeManualBackup(bk(t, s.store, T0))).file);
  s.commit(pullOps(hub, s.store), 'BOQ copy updated');
  s.commit([['sh:1', 'p', J(sq(0, 0, 11))]], 'Work');
  s.commit(rollbackOps(s.store, b, { skip: ['b:', 'bi:'] }), 'Rolled back');
  assert.equal(s.store.get('b:l1', 'desc'), 'Tiles', 'the BOQ copy stays (it comes from the hub)');
  assert.equal(s.store.get('project', 'hub'), 'H1');
  assert.equal(s.store.get('project', 'brev'), 5, 'the hub revision it holds stays');
  assert.equal(s.store.get('sh:1', 'p'), J(sq(0, 0, 10)), 'the take-off itself went back');
  await s.close();
});

test('backups: a copy from a backup is a new project with the backup’s content; the original is untouched', async () => {
  const t = await takeoffOnShare();
  const s0 = await readProjectStore(nodefs, t.dir);
  const b = await readBackup(nodefs, (await writeBackup(bk(t, s0, T0))).file);
  const files0 = readdirSync(join(t.dir, 'journals'));
  const c = await createProject(nodefs, t.root, 'Tower – Arch (copy)', 'Admin', 'PC9', restoreOps(b), 'admin', 'takeoff');
  const s1 = await readProjectStore(nodefs, c.dir);
  assert.notEqual(c.meta.id, t.meta.id);
  assert.equal(state(s1), state(s0));
  assert.match(String(s1.get('project', 'restoredFrom')), /backup of 2026-11-02/);
  assert.deepEqual(readdirSync(join(t.dir, 'journals')), files0, 'the original project is not written');
});

test('backups: a broken or foreign backup file says so instead of crashing', async () => {
  const d = tmp();
  const f = join(d, '2026-11-02.json.gz');
  writeFileSync(f, Buffer.from('not a backup at all'));
  await assert.rejects(readBackup(nodefs, f));
  assert.throws(() => decodeBackup(new Uint8Array([31, 139, 8, 0, 1, 2, 3])));
  const foreign = encodeBackup({ format: 'something-else', ents: [] } as any);
  assert.throws(() => decodeBackup(foreign), /not a .* backup file/);
  // a cut-off file (copy interrupted)
  const t = await takeoffOnShare();
  const s = await readProjectStore(nodefs, t.dir);
  const good = await writeBackup(bk(t, s, T0));
  const bytes = await nodefs.readBytes(good.file);
  const cut = join(d, 'cut.json.gz');
  writeFileSync(cut, bytes!.subarray(0, Math.floor(bytes!.length / 2)));
  await assert.rejects(readBackup(nodefs, cut));
});

test('backups: the automatic keeper backs up an open take-off on opening and after a change on closing', async () => {
  const t = await takeoffOnShare();
  const s = await open(t.dir);
  let now = T0;
  const k = new BackupKeeper({ fs: nodefs, root: t.root, kind: 'qto', projectDir: t.dir, folder: t.folder, projectId: t.meta.id, projectName: t.meta.name, by: 'qs1', host: 'PC1', app: 'test', session: s, now: () => now } as any);
  await k.opened();
  const dir = backupDirOf(nodefs, t.root, 'qto', t.folder, t.meta.id);
  assert.equal((await listBackupDays(nodefs, dir)).length, 1, 'a backup on opening');
  now = T0 + DAY;
  s.commit([['sh:1', 'p', J(sq(0, 0, 9))]], 'Work');
  await (k as any).closing?.() ?? (k as any).close?.();
  const days = await listBackupDays(nodefs, dir);
  assert.ok(days.length >= 1);
  const last = await readBackup(nodefs, days[0].file);
  assert.equal(last.ents.find(([id]) => id === 'sh:1')?.[1].find(([f]) => f === 'p')?.[1], J(sq(0, 0, 9)), 'the newest backup holds the change');
  await s.close();
});
