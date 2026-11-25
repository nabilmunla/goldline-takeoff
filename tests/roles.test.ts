// Two roles (Goldline Takeoff): administrators (3 at most) and quantity surveyors. Accounts from the
// estimation versions keep working: an estimator reads as a quantity surveyor, a viewer stays view only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/engine/store';
import { listAccounts, adminSet, readRole, ROLE_LABEL, MAX_ADMINS } from '../src/engine/accounts';
import { canCreateTakeoffs } from '../src/engine/access';
import type { Op } from '../src/engine/types';

let n = 0;
const add = (s: Store, ops: Op[], who: string) => s.apply({ s: String(++n).padStart(10, '0') + '~t', w: 't', u: who, a: who, t: 0, o: ops });

test('roles: stored roles of any version read as Administrator / Quantity surveyor (viewers stay view only)', () => {
  assert.equal(readRole('admin'), 'admin');
  assert.equal(readRole('estimator'), 'qs');
  assert.equal(readRole('qs'), 'qs');
  assert.equal(readRole('viewer'), 'viewer');
  assert.equal(readRole(undefined), 'qs');
  assert.deepEqual(Object.keys(ROLE_LABEL).sort(), ['admin', 'qs', 'viewer']);
  const s = new Store();
  add(s, [['user:boss', 'name', 'Boss'], ['user:boss', 'role', 'admin'], ['user:boss', 'active', true]], 'boss');
  add(s, [['user:est', 'name', 'Old estimator'], ['user:est', 'role', 'estimator'], ['user:est', 'active', true]], 'boss');
  add(s, [['user:v', 'name', 'Viewer'], ['user:v', 'role', 'viewer'], ['user:v', 'active', true]], 'boss');
  const by = new Map(listAccounts(s).map((a) => [a.username, a]));
  assert.equal(by.get('est')!.role, 'qs');
  assert.equal(s.get('user:est', 'role'), 'estimator', 'the stored value is never rewritten');
  assert.equal(canCreateTakeoffs(by.get('est')!), true, 'a quantity surveyor starts take-offs');
  assert.equal(canCreateTakeoffs(by.get('v')!), false);
});

test('roles: at most three administrators count (a team that had more keeps the first three)', () => {
  assert.equal(MAX_ADMINS, 3);
  const s = new Store();
  add(s, [['user:a1', 'name', 'A1'], ['user:a1', 'role', 'admin'], ['user:a1', 'active', true]], 'a1');
  for (const u of ['a2', 'a3', 'a4']) add(s, [['user:' + u, 'name', u], ['user:' + u, 'role', 'admin'], ['user:' + u, 'active', true]], 'a1');
  const admins = adminSet(s);
  assert.equal(admins.size, 3);
  assert.equal(admins.has('a4'), false, 'the fourth acts as a quantity surveyor');
});

test('roles: a person working alone is the first administrator and can do everything', () => {
  const s = new Store();
  add(s, [['user:solo', 'name', 'Solo'], ['user:solo', 'role', 'admin'], ['user:solo', 'active', true]], 'solo');
  assert.deepEqual([...adminSet(s)], ['solo']);
  assert.equal(canCreateTakeoffs(listAccounts(s)[0]), true);
});
