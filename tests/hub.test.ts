// The BOQ hub (engine/hub.ts): take-offs pull their BOQ copy from it, administrators change it, the combined
// filled BOQ adds the take-offs up, take-offs from before get a hub made from their own copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Store } from '../src/engine/store';
import { ProjectSession } from '../src/engine/session';
import { readProjectStore } from '../src/engine/projects';
import {
  pullOps, pushAdditionalOps, bumpRevOps, canEditBoq, hasBoq, combinedTargets, legacySeedOps, freshest, createHub,
  attachHubOps, attachedTakeoffs, hubOf, legacyHubId, FORMAT_HUB, HUB_FORMAT,
} from '../src/engine/hub';
import { buildQtoModel } from '../src/engine/qto/model';
import type { FsApi, Op } from '../src/engine/types';

const require = createRequire(import.meta.url);
const nodefs: FsApi = require('../electron/nodefs.cjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'hub-'));
let stamp = 0;
const add = (s: Store, ops: Op[], who = 'admin') => s.apply({ s: String(++stamp).padStart(10, '0') + '~t', w: 't', u: who, a: who, t: 0, o: ops });
const J = (x: unknown) => JSON.stringify(x);
/** a change made after everything in the fixture (whose stamps are real clock stamps) */
const addLate = (s: Store, ops: Op[], who = 'admin') => s.apply({ s: 'zzzzzzzzzz' + String(++stamp).padStart(6, '0') + '~t', w: 't', u: who, a: who, t: 0, o: ops });
const sq = (x: number, y: number, s: number) => [x, y, x + s, y, x + s, y + s, x, y + s];

/** a hub with one bill and three lines, imported from a file */
function hubStore(): Store {
  const h = new Store();
  add(h, [
    ['project', 'creator', 'qs1'], ['project', 'fmt', 14],
    ['imp:i1', 'files', J([{ name: 'BOQ.xlsx', sheets: [{ name: 'Bill 2', headerRow: 3, cols: { ref: 0, desc: 1, qty: 3, unit: 2 } }] }])],
    ['g1', 'type', 'group'], ['g1', 'ord', 'a0'], ['g1', 'ref', '2'], ['g1', 'desc', 'Finishes'],
    ['l1', 'type', 'item'], ['l1', 'parent', 'g1'], ['l1', 'ord', 'a0'], ['l1', 'ref', 'A'], ['l1', 'desc', 'Floor tiles'], ['l1', 'unit', 'm2'], ['l1', 'qty', 120], ['l1', 'q0', 120], ['l1', 'src', 'i1:0:0:5'],
    ['l2', 'type', 'item'], ['l2', 'parent', 'g1'], ['l2', 'ord', 'a1'], ['l2', 'ref', 'B'], ['l2', 'desc', 'Skirting'], ['l2', 'unit', 'm'], ['l2', 'qty', 80], ['l2', 'q0', 80], ['l2', 'src', 'i1:0:0:6'],
    ['l3', 'type', 'item'], ['l3', 'parent', 'g1'], ['l3', 'ord', 'a2'], ['l3', 'ref', 'C'], ['l3', 'desc', 'Columns'], ['l3', 'unit', 'nr'], ['l3', 'qty', 10], ['l3', 'q0', 10], ['l3', 'src', 'i1:0:0:7'],
  ]);
  return h;
}
const bRows = (s: Store) => new Map([...s.ents].filter(([k]) => k.startsWith('b:')).map(([k, e]) => [k, J([...e].map(([f, c]) => [f, c.v]).sort())]));

/** a take-off with a 10 x 10 area linked to l1 (scale 1: drawn in metres) */
function takeoff(link = 'b:l1'): Store {
  const q = new Store();
  add(q, [
    ['dwg:d1', 'name', 'A-101.pdf'], ['pg:d1.0', 'sc', 1],
    ['ti:a', 'name', 'Floor'], ['ti:a', 'kind', 'area'],
    ['sh:a', 'ti', 'ti:a'], ['sh:a', 'dwg', 'd1'], ['sh:a', 'pg', 0], ['sh:a', 'k', 'poly'], ['sh:a', 'p', J(sq(0, 0, 10))],
    ['lk:1', 'ti', 'ti:a'], ['lk:1', 'to', link], ['lk:1', 'q', 'area'],
  ], 'qs1');
  return q;
}

test('hub: a take-off pulls the BOQ copy; a second pull does nothing; two take-offs end identical', () => {
  const h = hubStore();
  const q1 = new Store(), q2 = new Store();
  const o1 = pullOps(h, q1);
  assert.ok(o1.length > 10);
  add(q1, o1); add(q2, pullOps(h, q2));
  assert.deepEqual(pullOps(h, q1), [], 'nothing changed: nothing written');
  assert.deepEqual(bRows(q1), bRows(q2));
  assert.equal(q1.get('b:l1', 'desc'), 'Floor tiles');
  assert.equal(q1.get('bi:i1', 'files') !== undefined, true, 'the import record travels (filled copy)');
  assert.equal(q1.get('b:l1', 'rate'), undefined);
});

test('hub: an administrator’s change reaches the take-off; a deleted line is marked deleted, links keep their ids', () => {
  const h = hubStore();
  const q = takeoff();
  add(q, pullOps(h, q));
  add(h, [['l1', 'desc', 'Porcelain floor tiles'], ['l3', 'del', true], ...bumpRevOps(h, 1000)]);
  add(q, pullOps(h, q));
  assert.equal(q.get('b:l1', 'desc'), 'Porcelain floor tiles');
  assert.equal(q.get('b:l3', 'del'), true);
  assert.equal(q.get('project', 'brev'), 1000);
  assert.equal(q.get('lk:1', 'to'), 'b:l1');
  const m = buildQtoModel(q, null);
  assert.equal(Math.round(m.boqQty.get('l1')!.total), 100);
});

test('hub: a PC with an older view of the hub does not put an older copy back', () => {
  const h = hubStore();
  const q = new Store();
  add(h, bumpRevOps(h, 5000));
  add(q, pullOps(h, q));
  // another PC (fresher view) already brought the take-off to revision 6000
  add(q, [['b:l1', 'desc', 'Newer text'], ['project', 'brev', 6000]]);
  assert.deepEqual(pullOps(h, q), [], 'this PC’s hub view (5000) is older: nothing written');
  add(h, [['l1', 'desc', 'Newer text'], ...bumpRevOps(h, 6000)]);
  // (the revision moves past 6000: bumped by one at least)
  assert.ok(pullOps(h, q).every(([e, f]) => e === 'project' && f === 'brev'));
});

test('hub: who may change the BOQ - the maker until a BOQ is in, administrators always', () => {
  const empty = new Store();
  add(empty, [['project', 'creator', 'qs1']]);
  assert.equal(hasBoq(empty), false);
  assert.equal(canEditBoq(empty, { username: 'qs1', isAdmin: false }), true, 'the maker uploads the first BOQ');
  assert.equal(canEditBoq(empty, { username: 'qs2', isAdmin: false }), false, 'another QS does not');
  const h = hubStore();
  assert.equal(hasBoq(h), true);
  assert.equal(canEditBoq(h, { username: 'qs1', isAdmin: false }), false, 'later updates: administrators only');
  assert.equal(canEditBoq(h, { username: 'boss', isAdmin: true }), true);
});

test('hub: the combined filled BOQ adds up the take-offs, worked out on a copy; one not read is counted', () => {
  const h = hubStore();
  const q1 = takeoff('b:l1'), q2 = takeoff('b:l1');
  add(q1, pullOps(h, q1)); add(q2, pullOps(h, q2));
  const before = J([...h.ents].map(([k, e]) => [k, [...e].map(([f, c]) => [f, c.v])]));
  const r = combinedTargets(h, [{ id: 'Q1', store: q1 }, { id: 'Q2', store: q2 }]);
  assert.equal(r.unread, 0);
  const line = r.targets[0].lines.find((l) => l.id === 'l1')!;
  assert.equal(Math.round(line.qs!), 200, 'both take-offs');
  assert.equal(J([...h.ents].map(([k, e]) => [k, [...e].map(([f, c]) => [f, c.v])])), before, 'the hub is not written');
  const one = combinedTargets(h, [{ id: 'Q1', store: q1 }, { id: 'Q2', store: null }]);
  assert.equal(one.unread, 1);
  assert.equal(Math.round(one.targets[0].lines.find((l) => l.id === 'l1')!.qs!), 100);
});

test('hub: an additional item from a take-off becomes a hub line and reaches the combined copy', () => {
  const h = hubStore();
  const q = takeoff();
  add(q, [['dm:x', 'desc', 'Extra handrail'], ['dm:x', 'unit', 'm'], ['dm:x', 'add', true], ['dm:x', 'bill', 'g1'], ['dm:x', 'loc', 'Stair 1'],
    ['ti:r', 'name', 'Rail'], ['ti:r', 'kind', 'len'], ['sh:r', 'ti', 'ti:r'], ['sh:r', 'dwg', 'd1'], ['sh:r', 'pg', 0], ['sh:r', 'k', 'line'], ['sh:r', 'p', J([0, 0, 7, 0])],
    ['lk:r', 'ti', 'ti:r'], ['lk:r', 'to', 'dm:x'], ['lk:r', 'q', 'len']]);
  const ops = pushAdditionalOps(h, { id: 'Q1', store: q });
  assert.ok(ops.some(([e, f, v]) => e === 'qx_x' && f === 'desc' && v === 'Extra handrail'));
  add(h, ops, 'qs1');
  assert.deepEqual(pushAdditionalOps(h, { id: 'Q1', store: q }), [], 'second time: nothing');
  add(q, pullOps(h, q));
  assert.equal(q.get('b:qx_x', 'qa'), 'a', 'the take-off sees it as its additional item');
  const r = combinedTargets(h, [{ id: 'Q1', store: q }]);
  const a = r.targets.flatMap((t) => t.adds).find((x) => x.desc === 'Extra handrail')!;
  assert.equal(Math.round(a.qs!), 7);
});

test('hub: attach rows on both sides; a hub at format 14 is view only for an older app', async () => {
  const pdir = tmp();
  const made = await createHub(nodefs, pdir, { hubId: 'H1', name: 'Tower', user: 'QS One', account: 'qs1' });
  const at = attachHubOps({ id: 'H1', name: 'Tower' }, { id: 'Q1', name: 'Tower - Arch', folder: 'Tower-Arch' });
  const h = new Store(); add(h, at.hub);
  assert.deepEqual(attachedTakeoffs(h).map((x) => x.id), ['Q1']);
  const q = new Store(); add(q, at.qto);
  assert.equal(hubOf(q), 'H1');
  const old = new ProjectSession({ fs: nodefs, localFs: nodefs, projectDir: made.dir, localDir: tmp(), user: 'old', account: 'old', host: 'PC9', pollMs: 60000, fullScanMs: 0, heartbeatMs: 60000, quiet: true, dataFormat: 13 });
  await old.open();
  assert.equal(old.readOnly, true, 'a 0.22.0 app opens a hub view only');
  await old.close();
});

// ---------------------------------------------------------------- Engineer's review (18 Nov): C1, C2, M1, M2, M3, M6
import { rollbackOps, makeBackup } from '../src/engine/backups';
import { ownHubId, HUB_ROLLBACK_SKIP } from '../src/engine/hub';
import { mkdirSync, rmSync, existsSync } from 'node:fs';

test('review C2: a hub not read yet, or a view that doesn’t know a line, never empties the take-off’s copy', () => {
  const h = hubStore();
  add(h, [['project', 'fmt', 14]]);
  const q = new Store();
  add(q, pullOps(h, q));
  const n = [...q.ents.keys()].filter((k) => k.startsWith('b:')).length;
  assert.deepEqual(pullOps(new Store(), q), [], 'an empty hub view (journals not there yet): nothing');
  const behind = new Store();
  add(behind, [['project', 'fmt', 14], ['l1', 'type', 'item'], ['l1', 'ord', 'a0'], ['l1', 'desc', 'Floor tiles'], ['l1', 'parent', 'g1'], ['l1', 'unit', 'm2'], ['l1', 'qty', 120], ['l1', 'q0', 120], ['l1', 'src', 'i1:0:0:5']]);
  const ops = pullOps(behind, q);
  assert.ok(!ops.some(([, f, v]) => f === 'del' && v === true), 'a view behind deletes nothing it doesn’t know');
  add(q, ops);
  assert.equal([...q.ents.keys()].filter((k) => k.startsWith('b:') && q.get(k, 'del') !== true).length, n);
  // a line really deleted in the hub is deleted in the copy
  add(h, [['l2', 'del', true]]);
  add(q, pullOps(h, q));
  assert.equal(q.get('b:l2', 'del'), true);
});

test('review C1/M1: rolling a hub back keeps the take-offs’ additional items and attach rows, and moves the revision on in the same change', () => {
  const h = hubStore();
  add(h, [['project', 'fmt', 14], ['project', 'rev', 100]]);
  const b = makeBackup(h, { kind: 'qto', projectId: 'H', projectName: 'H', folder: 'BOQ-H', dir: '/x', at: Date.UTC(2026, 10, 2), by: 'a', host: 'p', app: 't' });
  const q = takeoff();
  add(q, [['dm:x', 'desc', 'Extra handrail'], ['dm:x', 'unit', 'm'], ['dm:x', 'add', true]]);
  add(h, [...attachHubOps({ id: 'H', name: 'H' }, { id: 'Q1', name: 'Q1', folder: 'Q1' }).hub, ...pushAdditionalOps(h, { id: 'Q1', store: q }), ['l1', 'desc', 'Changed after the backup'], ...bumpRevOps(h, 200)]);
  const rb = [...rollbackOps(h, b, { skip: HUB_ROLLBACK_SKIP }), ...bumpRevOps(h, 300)];
  add(h, rb);
  assert.equal(h.get('l1', 'desc'), 'Floor tiles', 'the BOQ went back');
  assert.equal(h.get('qx_x', 'desc'), 'Extra handrail', 'the additional item stays');
  assert.equal(h.get('qx_x', 'del') ?? null, null);
  assert.deepEqual(attachedTakeoffs(h).map((x) => x.id), ['Q1'], 'the attach row stays');
  assert.ok(Number(h.get('project', 'rev')) >= 300, 'the revision only moves on');
  assert.deepEqual(pushAdditionalOps(h, { id: 'Q1', store: q }), [], 'nothing to push again');
  const r = combinedTargets(h, [{ id: 'Q1', store: q }]);
  assert.ok(r.targets.flatMap((t) => t.adds).some((a) => a.desc === 'Extra handrail'), 'the combined copy still has it');
});

test('review M2/M3: a take-off’s own hub has one id on every PC; a folder left half made is finished, not lost', async () => {
  assert.equal(ownHubId('Q 1/2'), 'q-Q12');
  const pdir = tmp();
  const [a, b] = await Promise.all([1, 2].map(() => createHub(nodefs, pdir, { hubId: ownHubId('Q1'), name: 'T', user: 'U', account: 'u' })));
  assert.equal(a.dir, b.dir);
  // a PC stopped after claiming the folder: no project.json, no journals
  const half = join(pdir, 'BOQ-q-Q2');
  mkdirSync(half);
  const made = await createHub(nodefs, pdir, { hubId: 'q-Q2', name: 'T2', user: 'U', account: 'u', waitTries: 2 });
  assert.ok(made.meta, 'finished here');
  assert.ok(existsSync(join(half, 'project.json')));
  const s = await readProjectStore(nodefs, half);
  assert.equal(s.get('project', 'fmt'), FORMAT_HUB);
  rmSync(pdir, { recursive: true, force: true });
});

test('review M6: rolling back a take-off leaves its BOQ copy, so the freshest copy of a group stays the freshest', () => {
  const a = new Store(), b = new Store();
  add(a, [['b:l1', 'bt', 'item'], ['b:l1', 'desc', 'Old text']]);
  const backupA = makeBackup(a, { kind: 'qto', projectId: 'A', projectName: 'A', folder: 'A', dir: '/a', at: Date.UTC(2026, 10, 1), by: 'q', host: 'p', app: 't' });
  add(b, [['b:l1', 'bt', 'item'], ['b:l1', 'desc', 'New text']]);
  add(a, [['sh:z', 'k', 'poly']]);
  const ops = rollbackOps(a, backupA, { skip: ['b:', 'bi:'] });
  assert.ok(!ops.some(([e]) => e.startsWith('b:')), 'no b: row touched');
  add(a, ops);
  assert.equal(freshest([a, b]), b);
});
