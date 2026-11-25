import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Clock, decodeStamp } from '../src/engine/hlc';
import { encodeLine, decodeLine, splitBytes } from '../src/engine/codec';
import { Store } from '../src/engine/store';
import { ProjectSession, type ConflictNotice } from '../src/engine/session';
import { createProject } from '../src/engine/projects';
import { buildModel, flatten, collapseForLevel, UNFILED } from '../src/engine/boq';
import { demoBoqOps } from './helpers/demoboq';
import type { Batch, FsApi, Op } from '../src/engine/types';

const require = createRequire(import.meta.url);
const nodefs: FsApi = require('../electron/nodefs.cjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = () => mkdtempSync(join(tmpdir(), 'gtest-'));

/** fs wrapper that can be switched "offline" to simulate the share dropping */
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

async function newSession(projectDir: string, user: string, localDir = tmp(), fs: FsApi = nodefs) {
  const s = new ProjectSession({ fs, localFs: nodefs, projectDir, localDir, user, host: 'PC-' + user, pollMs: 60000, fullScanMs: 0, heartbeatMs: 60000 });
  await s.open();
  return s;
}

test('clock: later stamps sort after earlier ones and after anything observed', () => {
  let t = 1000;
  const a = new Clock('a', () => t);
  const s1 = a.tick();
  const s2 = a.tick();
  assert.ok(s2 > s1);
  const b = new Clock('b', () => 500); // b's PC clock is behind
  b.observe(s2);
  const s3 = b.tick();
  assert.ok(s3 > s2, 'edit made after seeing another must win even with a slow clock');
  assert.equal(decodeStamp(s3).writer, 'b');
});

test('codec: round trip, checksum rejects damage, partial lines wait', () => {
  const b: Batch = { s: '0mabcdefg.00000.w', w: 'w', u: 'Nabil', t: 1, o: [['e', 'desc', 'Concrete C40 – "quoted" ✓ عربي']] };
  const line = encodeLine(b);
  assert.deepEqual(decodeLine(line.trimEnd()), b);
  const damaged = line.replace('C40', 'C45');
  assert.equal(decodeLine(damaged.trimEnd()), null);
  const bytes = new TextEncoder().encode(line + line.slice(0, 20));
  const r = splitBytes(bytes);
  assert.equal(r.batches.length, 1);
  assert.equal(r.consumed, new TextEncoder().encode(line).length);
  const r2 = splitBytes(new TextEncoder().encode('garbage-line\n' + line));
  assert.equal(r2.batches.length, 1);
  assert.equal(r2.bad, 1);
});

test('store: any order, any duplicates -> identical result', () => {
  const writers = ['a', 'b', 'c'].map((w) => new Clock(w, () => 1000 + Math.floor(Math.random() * 50)));
  const batches: Batch[] = [];
  for (let i = 0; i < 600; i++) {
    const c = writers[i % 3];
    const ops: Op[] = [];
    for (let k = 0; k < 1 + (i % 4); k++) ops.push(['e' + Math.floor(Math.random() * 20), ['qty', 'rate', 'desc'][k % 3], Math.floor(Math.random() * 100)]);
    batches.push({ s: c.tick(), w: c.writer, u: c.writer, t: 0, o: ops });
  }
  const fp = (list: Batch[]) => { const s = new Store(); for (const b of list) s.apply(b); return s.fingerprint(); };
  const base = fp(batches);
  for (let r = 0; r < 5; r++) {
    const shuffled = [...batches, ...batches.slice(0, 100)].sort(() => Math.random() - 0.5);
    assert.equal(fp(shuffled), base);
  }
});

test('session: two users see each other, same-cell clash converges and notifies', async () => {
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'Test Tower', 'Nabil', 'PC1', demoBoqOps());
  const a = await newSession(dir, 'Nabil');
  const b = await newSession(dir, 'Ahmed');
  const model = buildModel(a.store);
  const item = [...model.byId.values()].find((n) => n.type === 'item')!;
  assert.ok(model.items > 80);

  a.commit([[item.id, 'qty', 111]]);
  await sleep(150);
  await b.tick();
  assert.equal(b.store.get(item.id, 'qty'), 111);

  const notices: ConflictNotice[] = [];
  a.onConflict((n) => notices.push(n));
  b.onConflict((n) => notices.push(n));
  a.commit([[item.id, 'qty', 5]]);
  await sleep(5);
  b.commit([[item.id, 'qty', 7]]);
  await sleep(150);
  await a.tick(); await b.tick();
  assert.equal(a.store.get(item.id, 'qty'), b.store.get(item.id, 'qty'));
  assert.equal(a.store.fingerprint(), b.store.fingerprint());
  assert.equal(notices.length, 1, 'exactly the losing side is told');
  await a.close(); await b.close();
});

test('session: share goes offline -> edits queue -> delivered on reconnect', async () => {
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'Offline', 'Nabil', 'PC1', demoBoqOps());
  const { fs, state } = flakyFs(nodefs);
  const a = await newSession(dir, 'Nabil', tmp(), fs);
  const b = await newSession(dir, 'Ahmed');
  const item = [...buildModel(a.store).byId.values()].find((n) => n.type === 'item')!;
  state.down = true;
  for (let i = 0; i < 25; i++) a.commit([[item.id, 'qty', i]]);
  await sleep(300);
  assert.equal(a.getStatus().state, 'offline');
  assert.equal(a.pendingCount, 25);
  state.down = false;
  for (let i = 0; i < 40 && a.pendingCount; i++) await sleep(100);
  assert.equal(a.pendingCount, 0);
  await b.tick();
  assert.equal(b.store.get(item.id, 'qty'), 24);
  await a.close(); await b.close();
});

test('session: app crashes while offline -> outbox delivered on next start', async () => {
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'Crash', 'Nabil', 'PC1', demoBoqOps());
  const local = tmp();
  const { fs, state } = flakyFs(nodefs);
  const a = await newSession(dir, 'Nabil', local, fs);
  const item = [...buildModel(a.store).byId.values()].find((n) => n.type === 'item')!;
  state.down = true;
  a.commit([[item.id, 'desc', 'typed just before the crash']]);
  await sleep(200);
  a.kill(); // no flush, no cleanup
  const a2 = await newSession(dir, 'Nabil', local); // restart, share is back
  for (let i = 0; i < 30 && a2.pendingCount; i++) await sleep(100);
  const b = await newSession(dir, 'Ahmed');
  assert.equal(b.store.get(item.id, 'desc'), 'typed just before the crash');
  await a2.close(); await b.close();
});

test('session: torn write is ignored, line written in two halves is applied once complete', async () => {
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'Torn', 'Nabil', 'PC1', demoBoqOps());
  const b = await newSession(dir, 'Ahmed');
  const item = [...buildModel(b.store).byId.values()].find((n) => n.type === 'item')!;
  const line = encodeLine({ s: '0zzzzzzzz.00000.x', w: 'x', u: 'X', t: 0, o: [[item.id, 'qty', 999]] });
  const seg = join(dir, 'journals', 'j_x_manual.log');
  await nodefs.append(seg, line.slice(0, 30));
  await b.tick();
  assert.notEqual(b.store.get(item.id, 'qty'), 999);
  await nodefs.append(seg, line.slice(30));
  await b.tick();
  assert.equal(b.store.get(item.id, 'qty'), 999);
  // garbage in another file never breaks anything
  await nodefs.append(join(dir, 'journals', 'j_y_garbage.log'), 'not json at all\n{"half":');
  await b.tick();
  assert.equal(b.getStatus().corruptLines, 1);
  await b.close();
});

test('undo/redo, and undo leaves alone a field someone else changed since', async () => {
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'Undo', 'Nabil', 'PC1', demoBoqOps());
  const a = await newSession(dir, 'Nabil');
  const b = await newSession(dir, 'Ahmed');
  const items = [...buildModel(a.store).byId.values()].filter((n) => n.type === 'item');
  const [i1, i2] = items;
  const orig1 = a.store.get(i1.id, 'qty');
  a.commit([[i1.id, 'qty', 1], [i2.id, 'qty', 2]]);
  await sleep(50);
  await b.tick();
  b.commit([[i2.id, 'qty', 22]]);
  await sleep(50);
  await a.tick();
  const r = a.undo()!;
  assert.equal(r.skipped, 1);
  assert.equal(a.store.get(i1.id, 'qty'), orig1);
  assert.equal(a.store.get(i2.id, 'qty'), 22);
  a.redo();
  assert.equal(a.store.get(i1.id, 'qty'), 1);
  await a.close(); await b.close();
});

test('undo twice on the same field goes back twice (own changes are not "someone else")', async () => {
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'Undo2', 'Nabil', 'PC1', demoBoqOps());
  const a = await newSession(dir, 'Nabil');
  const b = await newSession(dir, 'Ahmed');
  const it = [...buildModel(a.store).byId.values()].find((n) => n.type === 'item')!;
  const orig = a.store.get(it.id, 'qty');
  a.commit([[it.id, 'qty', 10]]);
  a.commit([[it.id, 'qty', 20]]);
  a.commit([[it.id, 'qty', 30]]);
  for (const want of [20, 10, orig]) {
    const r = a.undo()!;
    assert.equal(r.skipped, 0);
    assert.equal(a.store.get(it.id, 'qty'), want);
  }
  a.redo(); a.redo();
  assert.equal(a.store.get(it.id, 'qty'), 20);
  // someone else changes it meanwhile: the next undo leaves their value alone
  await sleep(50); await b.tick();
  b.commit([[it.id, 'qty', 99]]);
  await sleep(50); await a.tick();
  assert.equal(a.undo()!.skipped, 1);
  assert.equal(a.store.get(it.id, 'qty'), 99);
  await a.close(); await b.close();
});

test('presence: users see each other and what they are working on', async () => {
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'Presence', 'Nabil', 'PC1', demoBoqOps());
  const a = await newSession(dir, 'Nabil');
  const b = await newSession(dir, 'Ahmed');
  a.setFocus({ sel: 'x1', detail: 'x1' });
  await sleep(400);
  await b.tick();
  const users = b.activeUsers();
  assert.equal(users.length, 1);
  assert.equal(users[0].u, 'Nabil');
  assert.equal(users[0].detail, 'x1');
  await a.close();
  await b.tick();
  assert.equal(b.activeUsers().length, 0, 'closing removes presence');
  await b.close();
});

test('boq model: totals, outline levels, deleted rows, orphans', async () => {
  const s = new Store();
  const c = new Clock('w');
  s.apply({ s: c.tick(), w: 'w', u: 'u', t: 0, o: demoBoqOps() });
  const m = buildModel(s);
  assert.equal(m.items, [...m.byId.values()].filter((n) => n.type === 'item').length);
  assert.equal(flatten(m, collapseForLevel(m, 1)).length, m.roots.length);
  const lvl2 = flatten(m, collapseForLevel(m, 2)).length;
  assert.ok(lvl2 > m.roots.length && lvl2 < flatten(m, new Set()).length);
  const anItem = [...m.byId.values()].find((n) => n.type === 'item')!;
  s.apply({ s: c.tick(), w: 'w', u: 'u', t: 0, o: [[anItem.id, 'del', true], ['orph', 'type', 'item'], ['orph', 'parent', 'nope'], ['orph', 'ord', 'a0'], ['orph', 'qty', 2], ['orph', 'rate', 3]] });
  const m2 = buildModel(s);
  assert.equal(m2.byId.has(anItem.id), false);
  assert.equal(m2.deletedCount, 1);
  assert.equal(m2.roots[m2.roots.length - 1].id, UNFILED);
  assert.equal(m2.roots[m2.roots.length - 1].items, 1);
  assert.ok(flatten(m2, new Set(), 'blockwork').length > 3);
});

test('boq model: deleting a heading hides everything under it (not "unfiled")', () => {
  const s = new Store();
  const c = new Clock('w');
  s.apply({ s: c.tick(), w: 'w', u: 'u', t: 0, o: demoBoqOps() });
  const m = buildModel(s);
  const bill = m.roots[1];
  s.apply({ s: c.tick(), w: 'w', u: 'u', t: 0, o: [[bill.id, 'del', true]] });
  const m2 = buildModel(s);
  assert.equal(m2.roots.length, m.roots.length - 1);
  assert.ok(!m2.roots.some((r) => r.id === UNFILED));
  assert.equal(m2.deletedCount, 1);
  s.apply({ s: c.tick(), w: 'w', u: 'u', t: 0, o: [[bill.id, 'del', false]] });
  assert.equal(buildModel(s).items, m.items);
});

import { hashSecret, verifySecret, initAccounts, loadAccountStore, checkLogin, newAccountOps, claimAccount, adminSet, accountsDir, normCode, resetPasswordOps } from '../src/engine/accounts';
import { isPurged } from '../src/engine/boq';

test('accounts: hashes verify, wrong secrets fail, nothing stored in clear', async () => {
  const h = await hashSecret('Correct Horse 9', 1000);
  assert.ok(!h.includes('Correct'));
  assert.equal(await verifySecret('Correct Horse 9', h), true);
  assert.equal(await verifySecret('correct horse 9', h), false);
  assert.equal(await verifySecret('x', null), false);
  assert.equal(normCode(' k7qf 3xpd '), 'K7QF-3XPD');
});

test('accounts: first admin, add person with one-time code, they set password, roles sync', async () => {
  const data = tmp();
  const admin = await initAccounts(nodefs, data, 'PC1', { username: 'Nabil.Munla', name: 'Nabil Munla', password: 'admin-pass-1' });
  assert.equal(admin.username, 'nabil.munla');
  assert.equal(admin.role, 'admin');
  let { store } = await loadAccountStore(nodefs, data);
  assert.deepEqual(await checkLogin(store, 'nabil.munla', 'nope'), { ok: false, reason: 'wrong' });
  assert.equal((await checkLogin(store, 'NABIL.MUNLA', 'admin-pass-1')).ok, true);

  // admin adds Ahmed through a live session on the accounts folder
  const s = new ProjectSession({ fs: nodefs, localFs: nodefs, projectDir: accountsDir(nodefs, data), localDir: tmp(), user: 'Nabil Munla', account: 'nabil.munla', host: 'PC1', pollMs: 60000, fullScanMs: 0, heartbeatMs: 60000 });
  await s.open();
  const { ops, code } = await newAccountOps('nabil.munla', { username: 'sara.khan', name: 'Sara Khan', role: 'qs' });
  s.commit(ops, 'Add person');
  await s.close();

  ({ store } = await loadAccountStore(nodefs, data));
  assert.deepEqual(await checkLogin(store, 'sara.khan', ''), { ok: false, reason: 'needs-setup' });
  const bad = await claimAccount(nodefs, data, 'PC2', store, 'sara.khan', 'AAAA-AAAA', 'ahmed-pass-1');
  assert.equal(bad.ok, false);
  const good = await claimAccount(nodefs, data, 'PC2', store, 'sara.khan', code.toLowerCase(), 'ahmed-pass-1');
  assert.equal(good.ok, true);
  ({ store } = await loadAccountStore(nodefs, data));
  assert.equal((await checkLogin(store, 'sara.khan', 'ahmed-pass-1')).ok, true);
  const again = await claimAccount(nodefs, data, 'PC2', store, 'sara.khan', code, 'hijack-pass');
  assert.equal(again.ok, false, 'a used code cannot be reused');
  assert.deepEqual([...adminSet(store)], ['nabil.munla']);

  // reset password -> new code, old password stops working
  const s2 = new ProjectSession({ fs: nodefs, localFs: nodefs, projectDir: accountsDir(nodefs, data), localDir: tmp(), user: 'Nabil Munla', account: 'nabil.munla', host: 'PC1', pollMs: 60000, fullScanMs: 0, heartbeatMs: 60000 });
  await s2.open();
  const r = await resetPasswordOps('sara.khan');
  s2.commit(r.ops, 'Reset password');
  s2.commit([['user:sara.khan', 'active', false]], 'Deactivate');
  await s2.close();
  ({ store } = await loadAccountStore(nodefs, data));
  assert.deepEqual(await checkLogin(store, 'sara.khan', 'ahmed-pass-1'), { ok: false, reason: 'inactive' });
});

test('recycle bin: purge only counts when an admin did it', () => {
  const s = new Store();
  const c = new Clock('w');
  s.apply({ s: c.tick(), w: 'w', u: 'u', t: 0, o: demoBoqOps() });
  const m = buildModel(s);
  const [i1, i2] = [...m.byId.values()].filter((n) => n.type === 'item');
  s.apply({ s: c.tick(), w: 'w', u: 'Ahmed', a: 'ahmed', t: 0, o: [[i1.id, 'del', true], [i2.id, 'del', true]] });
  s.apply({ s: c.tick(), w: 'w', u: 'Ahmed', a: 'ahmed', t: 0, o: [[i1.id, 'purged', true]] });
  s.apply({ s: c.tick(), w: 'w', u: 'Nabil', a: 'nabil', t: 0, o: [[i2.id, 'purged', true]] });
  const admins = new Set(['nabil']);
  assert.equal(isPurged(s, i1.id, admins), false, 'QS purge ignored');
  assert.equal(isPurged(s, i2.id, admins), true);
  const m2 = buildModel(s, admins);
  assert.equal(m2.deletedCount, 1, 'only the non-purged row is still in the bin');
  s.apply({ s: c.tick(), w: 'w', u: 'X', a: 'x', t: 0, o: [[i2.id, 'del', false]] });
  assert.equal(buildModel(s, admins).byId.has(i2.id), false, 'a purged row cannot be restored');
});

import { changeTypeOps, indentOps, outdentOps, canIndent, canOutdent } from '../src/engine/structure';

function demoStore() {
  const s = new Store();
  const c = new Clock('w');
  s.apply({ s: c.tick(), w: 'w', u: 'u', t: 0, o: demoBoqOps() });
  const apply = (o: Op[]) => { if (o.length) s.apply({ s: c.tick(), w: 'w', u: 'u', t: 0, o }); };
  return { s, apply };
}
const order = (s: Store) => flatten(buildModel(s), new Set()).map((r) => r.node.id).join(',');

test('line types: item <-> description: a description is not counted as an item', () => {
  const { s, apply } = demoStore();
  const m = buildModel(s);
  const it = [...m.byId.values()].find((n) => n.type === 'item')!;
  apply(changeTypeOps(m, it.id, 'note'));
  const m2 = buildModel(s);
  assert.equal(m2.byId.get(it.id)!.type, 'note');
  assert.equal(m2.items, m.items - 1);
  apply(changeTypeOps(m2, it.id, 'item'));
  assert.equal(buildModel(s).items, m.items, 'it counts again once it is an item');
});

test('make heading: the lines after it move under it, order on screen unchanged', () => {
  const { s, apply } = demoStore();
  const m = buildModel(s);
  const wrong = [...m.byId.values()].find((n) => n.desc === 'SLABS AND BEAMS')!;
  const sibsAfter = m.byId.get(wrong.parent!)!.children.slice(m.byId.get(wrong.parent!)!.children.findIndex((x) => x.id === wrong.id) + 1);
  const o1 = order(s);
  apply(changeTypeOps(m, wrong.id, 'group'));
  const m2 = buildModel(s);
  assert.equal(order(s), o1);
  assert.equal(m2.byId.get(wrong.id)!.type, 'group');
  assert.deepEqual(m2.byId.get(wrong.id)!.children.map((c) => c.id), sibsAfter.map((c) => c.id));
  assert.equal(m2.items, m.items - 1, 'a heading is not a counted item');
  // and back: heading -> item puts its lines back one level up, same order
  apply(changeTypeOps(m2, wrong.id, 'item'));
  assert.equal(order(s), o1);
  assert.equal(buildModel(s).byId.get(sibsAfter[0].id)!.parent, wrong.parent);
});

test('level down / level up keep the on-screen order and round-trip', () => {
  const { s, apply } = demoStore();
  const m = buildModel(s);
  const bill = m.roots[1];
  const [s1, s2, s3] = bill.children;
  const o1 = order(s);
  assert.equal(canIndent(m, s1.id), false, 'nothing above at the same level');
  assert.equal(canIndent(m, s2.id), true);
  apply(indentOps(m, s2.id));
  let m2 = buildModel(s);
  assert.equal(order(s), o1);
  assert.equal(m2.byId.get(s2.id)!.parent, s1.id);
  assert.equal(m2.byId.get(s2.id)!.depth, 2);
  // level up a heading: following lines under the old heading become its content
  apply(outdentOps(m2, s2.id));
  m2 = buildModel(s);
  assert.equal(order(s), o1);
  assert.equal(m2.byId.get(s2.id)!.parent, bill.id);
  assert.equal(m2.byId.get(s3.id)!.parent, bill.id);
  // a plain line can only level up if it is the last line under its heading
  const sec = m2.byId.get(s3.id)!;
  assert.equal(canOutdent(m2, sec.children[0].id), false);
  assert.equal(canOutdent(m2, sec.children[sec.children.length - 1].id), true);
  apply(outdentOps(m2, sec.children[sec.children.length - 1].id));
  assert.equal(order(s), o1);
  assert.equal(buildModel(s).items, m.items);
});

test('accounts: no more than 3 administrators count', async () => {
  const data = tmp();
  await initAccounts(nodefs, data, 'PC1', { username: 'a1', name: 'A1', password: 'password-1' });
  const s = new ProjectSession({ fs: nodefs, localFs: nodefs, projectDir: accountsDir(nodefs, data), localDir: tmp(), user: 'A1', account: 'a1', host: 'PC1', pollMs: 60000, fullScanMs: 0, heartbeatMs: 60000 });
  await s.open();
  for (const u of ['a2', 'a3', 'a4']) {
    const { ops } = await newAccountOps('a1', { username: u, name: u.toUpperCase(), role: 'admin' });
    s.commit(ops);
  }
  await s.close();
  const { store } = await loadAccountStore(nodefs, data);
  assert.deepEqual([...adminSet(store)].sort(), ['a1', 'a2', 'a3']);
});

import { accessFor, getAcl, newProjectAclOps, setPersonAccessOps, setEveryoneOps, setOwnerOps, activityLog, canCreateTakeoffs } from '../src/engine/access';
import { listAccounts, signInOps, userId } from '../src/engine/accounts';

test('access: QS see their own projects only, admins everything, viewers only what is shared, read-only', async () => {
  const data = tmp();
  await initAccounts(nodefs, data, 'PC1', { username: 'boss', name: 'Boss', password: 'password-1' });
  const s = new ProjectSession({ fs: nodefs, localFs: nodefs, projectDir: accountsDir(nodefs, data), localDir: tmp(), user: 'Boss', account: 'boss', host: 'PC1', pollMs: 60000, fullScanMs: 0, heartbeatMs: 60000 });
  await s.open();
  for (const [u, role] of [['est1', 'qs'], ['est2', 'qs'], ['view1', 'viewer']] as const) {
    const { ops } = await newAccountOps('boss', { username: u, name: u.toUpperCase(), role });
    s.commit(ops, 'Add person');
  }
  const p1 = { id: 'p1', name: 'T1 – Tower', format: 'takeoff' };
  const p2 = { id: 'p2', name: 'T2 – Villas', format: 'takeoff' };
  s.commit(newProjectAclOps(p1, 'est1'), 'Created project T1 – Tower');
  s.commit(newProjectAclOps(p2, 'boss'), 'Created project T2 – Villas');
  const st = s.store;
  const acc = (u: string) => listAccounts(st).find((a) => a.username === u)!;
  const admins = adminSet(st);
  // owner edits, others nothing, admin edits everything
  assert.equal(accessFor(st, admins, acc('est1'), p1), 'edit');
  assert.equal(accessFor(st, admins, acc('est2'), p1), 'none');
  assert.equal(accessFor(st, admins, acc('view1'), p1), 'none');
  assert.equal(accessFor(st, admins, acc('boss'), p1), 'edit');
  assert.equal(accessFor(st, admins, acc('est1'), p2), 'none');
  // admin shares: est2 view, viewer edit (capped to view)
  s.commit(setPersonAccessOps('p1', 'est2', 'view'), 'Gave EST2 view access to T1');
  s.commit(setPersonAccessOps('p1', 'view1', 'edit'), 'Gave VIEW1 edit access to T1');
  assert.equal(accessFor(st, admins, acc('est2'), p1), 'view');
  assert.equal(accessFor(st, admins, acc('view1'), p1), 'view');
  // everyone view, then per-person edit wins; removing per-person falls back to everyone
  s.commit(setEveryoneOps('p2', 'view'));
  assert.equal(accessFor(st, admins, acc('est1'), p2), 'view');
  s.commit(setPersonAccessOps('p2', 'est1', 'edit'));
  assert.equal(accessFor(st, admins, acc('est1'), p2), 'edit');
  s.commit(setPersonAccessOps('p2', 'est1', 'none'));
  assert.equal(accessFor(st, admins, acc('est1'), p2), 'view');
  assert.equal(getAcl(st, p2).people.size, 0);
  // owner handed over
  s.commit(setOwnerOps('p1', 'est2'));
  assert.equal(accessFor(st, admins, acc('est2'), p1), 'edit');
  assert.equal(accessFor(st, admins, acc('est1'), p1), 'none');
  // deactivated: nothing
  s.commit([[userId('est2'), 'active', false]], 'Deactivated');
  assert.equal(accessFor(st, admins, acc('est2'), p1), 'none');
  // old projects without an owner record: matched by creator name, else admins only
  assert.equal(accessFor(st, admins, acc('est1'), { id: 'old', name: 'Old', createdBy: 'EST1', format: 'takeoff' }), 'edit');
  assert.equal(accessFor(st, admins, acc('est1'), { id: 'old2', name: 'Old2', createdBy: 'Someone gone', format: 'takeoff' }), 'none');
  // permissions
  assert.equal(canCreateTakeoffs(acc('view1')), false);
  assert.equal(canCreateTakeoffs(acc('est1')), true);
  // activity log: newest first, readable, no hashes
  s.commit(signInOps('est1', 'PC-7'), 'Signed in');
  const log = activityLog(st);
  assert.match(log[0].text, /^signed in on PC-7$/);
  assert.ok(log.some((e) => e.text === 'added EST1 as quantity surveyor' && e.byName === 'Boss'));
  assert.ok(log.some((e) => e.text === 'added VIEW1 as viewer (view only)'));
  assert.ok(log.some((e) => e.text === 'gave EST2 view access to T1' && e.kind === 'access'));
  assert.ok(log.some((e) => e.text === 'deactivated EST2'));
  assert.ok(!log.some((e) => /pbkdf2/.test(e.text)));
  assert.equal(listAccounts(st).find((a) => a.username === 'est1')!.lastHost, 'PC-7');
  await s.close();
});

test('session: read-only sessions refuse every change', async () => {
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'RO', 'Nabil', 'PC1', demoBoqOps(), 'nabil');
  const s = new ProjectSession({ fs: nodefs, localFs: nodefs, projectDir: dir, localDir: tmp(), user: 'V', account: 'v', host: 'PC2', readOnly: true, pollMs: 60000, fullScanMs: 0, heartbeatMs: 60000 });
  await s.open();
  const before = s.store.batchCount;
  assert.equal(s.commit([['x', 'desc', 'hack']]), null);
  assert.equal(s.store.batchCount, before);
  assert.equal(s.meta.owner, 'nabil');
  await s.close();
});
