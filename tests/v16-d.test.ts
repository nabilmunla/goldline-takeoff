// v0.16 group d: the take-off's BOQ tab and the estimator's side of the sync (items 20, 23-26).
// run: node --import tsx --test tests/v16-d.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Store } from '../src/engine/store';
import { buildModel } from '../src/engine/boq';
import { buildQtoModel, qxId, alreadyLinked } from '../src/engine/qto/model';
import { scaleFromRatio } from '../src/engine/qto/geometry';
import { additionalOps, takeoffTotals, takeoffQtyOps, mirrorOps, syncEstimate, qaGroupId, lineEditOps, MIRROR_FIELDS, QA_GROUP_DESC, folderSig, type SyncProject } from '../src/engine/qto/bridge';
import {
  additionalItemOps, keepAsAdditionalOps, linkedItems, unlinkOps, dummyState, linkKind, canEditSuggestion, editAdditionalOps, linkTarget, qtyOf,
  unresolvedCount, addView, knownLocations,
} from '../src/engine/qto/additional';
import { treeRows, collapsedForLevel, closable, crumbOf, ancestors } from '../src/engine/qto/boqtree';
import { ProjectSession } from '../src/engine/session';
import { createProject } from '../src/engine/projects';
import type { FsApi, Op, Batch } from '../src/engine/types';

const require = createRequire(import.meta.url);
const nodefs: FsApi = require('../electron/nodefs.cjs');

let stamp = 0;
function add(s: Store, ops: Op[], who = 'nabil') {
  s.apply({ s: String(++stamp).padStart(10, '0') + '~t', w: 't-' + who, u: who, t: 0, o: ops, a: who });
}
const storeWith = (ops: Op[], who = 'nabil') => { const s = new Store(); add(s, ops, who); return s; };
const J = (v: unknown) => JSON.stringify(v);
const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const S100 = scaleFromRatio(100);
const sq = (x: number, y: number, m: number) => { const s = m / S100; return [x, y, x + s, y, x + s, y + s, x, y + s]; };
/** a project as the sync sees it, on a plain store */
const proj = (store: Store, id: string, readOnly = false): SyncProject => ({
  store, meta: { format: 'takeoff', formatVersion: 1, id, name: id, created: 0, createdBy: '' }, readOnly,
  commit(ops: Op[]): Batch | null { if (readOnly || !ops.length) return null; add(store, ops, 'ahmed'); return {} as Batch; },
});

/** an estimate: Bill 1 (Earthworks: E1 m2 qty 100, E2 nr 10), Bill 2 (Finishes: F1 m2 qty 50) */
function estimate(): Store {
  return storeWith([
    ['g1', 'type', 'group'], ['g1', 'ord', 'a0'], ['g1', 'ref', 'Bill 1'], ['g1', 'desc', 'SUBSTRUCTURE'],
    ['s1', 'type', 'group'], ['s1', 'parent', 'g1'], ['s1', 'ord', 'a0'], ['s1', 'desc', 'Earthworks'],
    ['E1', 'type', 'item'], ['E1', 'parent', 's1'], ['E1', 'ord', 'a0'], ['E1', 'ref', 'A'], ['E1', 'desc', 'Excavation to reduce levels'], ['E1', 'unit', 'm2'], ['E1', 'qty', 100], ['E1', 'rate', 14.5],
    ['E2', 'type', 'item'], ['E2', 'parent', 's1'], ['E2', 'ord', 'a1'], ['E2', 'ref', 'B'], ['E2', 'desc', 'Trial pits'], ['E2', 'unit', 'nr'], ['E2', 'qty', 10], ['E2', 'page', 'B/2'],
    ['g2', 'type', 'group'], ['g2', 'ord', 'a1'], ['g2', 'ref', 'Bill 2'], ['g2', 'desc', 'FINISHES'],
    ['s2', 'type', 'group'], ['s2', 'parent', 'g2'], ['s2', 'ord', 'a0'], ['s2', 'desc', 'Floor finishes'],
    ['F1', 'type', 'item'], ['F1', 'parent', 's2'], ['F1', 'ord', 'a0'], ['F1', 'ref', 'A'], ['F1', 'desc', 'Porcelain tiles 600x600'], ['F1', 'unit', 'm2'], ['F1', 'qty', 50],
  ], 'ahmed');
}
/** a take-off with two areas (100 m² and 25 m²) and the BOQ copy of `est` */
function takeoff(est: Store | null): Store {
  const q = storeWith([
    ['project', 'est', 'EST'], ['pg:d1.0', 'sc', S100],
    ['ti:a', 'kind', 'area'], ['ti:a', 'name', 'Planters'], ['sh:a', 'ti', 'ti:a'], ['sh:a', 'dwg', 'd1'], ['sh:a', 'pg', 0], ['sh:a', 'k', 'poly'], ['sh:a', 'p', J(sq(0, 0, 10))],
    ['ti:b', 'kind', 'area'], ['ti:b', 'name', 'Tiles'], ['sh:b', 'ti', 'ti:b'], ['sh:b', 'dwg', 'd1'], ['sh:b', 'pg', 0], ['sh:b', 'k', 'poly'], ['sh:b', 'p', J(sq(300, 0, 5))],
  ], 'omar');
  if (est) add(q, mirrorOps(buildModel(est), q), 'ahmed');
  return q;
}
const side = (q: Store, id = 'QTO1') => [{ id, model: buildQtoModel(q, null) }];
/** what the estimator's side does once, as the sync does it */
function syncOnce(est: Store, qs: { id: string; store: Store }[]) {
  return syncEstimate(proj(est, 'EST'), qs.map((x) => ({ id: x.id, p: proj(x.store, x.id) })));
}

// ---------------------------------------------------------------- item 26
test('26: one round of the sync writes the Take-off column, and is the same on every PC (estimate not on any screen)', () => {
  const est = estimate();
  const q = takeoff(est);
  add(q, [['lk:1', 'ti', 'ti:b'], ['lk:1', 'to', 'b:F1'], ['lk:1', 'q', 'area']], 'omar');
  assert.equal(est.get('F1', 'tq') ?? null, null, 'nothing measured in the estimate yet');
  const r = syncOnce(est, [{ id: 'QTO1', store: q }]);
  assert.ok(r.complete && r.wrote > 0);
  close(est.get('F1', 'tq') as number, 25);
  assert.equal(est.get('F1', 'qty'), 50, 'the BOQ quantity stays as issued');
  // a second app (same data) writes nothing new; and it is idempotent
  assert.equal(syncOnce(est, [{ id: 'QTO1', store: q }]).wrote, 0);
  const est2 = estimate();
  syncOnce(est2, [{ id: 'QTO1', store: takeoff(est2) }]);
  const q2 = takeoff(est2);
  add(q2, [['lk:1', 'ti', 'ti:b'], ['lk:1', 'to', 'b:F1'], ['lk:1', 'q', 'area']], 'omar');
  syncOnce(est2, [{ id: 'QTO1', store: q2 }]);
  assert.equal(est2.get('F1', 'tq'), est.get('F1', 'tq'), 'two apps: identical figure');
});

test('26: never from a view-only window; a take-off that could not be opened or was linked elsewhere holds the column back', () => {
  const est = estimate();
  const q = takeoff(est);
  add(q, [['lk:1', 'ti', 'ti:b'], ['lk:1', 'to', 'b:F1'], ['lk:1', 'q', 'area']], 'omar');
  assert.equal(syncEstimate(proj(est, 'EST', true), [{ id: 'QTO1', p: proj(q, 'QTO1') }]).wrote, 0);
  assert.equal(est.get('F1', 'tq') ?? null, null);
  const r = syncEstimate(proj(est, 'EST'), [{ id: 'QTO1', p: proj(q, 'QTO1') }, { id: 'QTO2', p: null }]);
  assert.equal(r.complete, false);
  assert.equal(est.get('F1', 'tq') ?? null, null, 'one take-off not read: the column is not written (it could wipe its figures)');
  add(q, [['project', 'est', 'OTHER']], 'omar');
  syncEstimate(proj(est, 'EST'), [{ id: 'QTO1', p: proj(q, 'QTO1') }]);
  assert.equal(est.get('F1', 'tq') ?? null, null, 'a take-off linked to another estimate since is not counted here');
});

test('26: totals over several take-offs are summed in take-off id order (same digits on every PC)', () => {
  const est = estimate();
  const a = takeoff(est), b = takeoff(est);
  add(a, [['lk:1', 'ti', 'ti:b'], ['lk:1', 'to', 'b:F1'], ['lk:1', 'q', 'area']], 'omar');
  add(b, [['lk:1', 'ti', 'ti:a'], ['lk:1', 'to', 'b:F1'], ['lk:1', 'q', 'area']], 'omar');
  const t1 = takeoffTotals([{ id: 'B', model: buildQtoModel(b, null) }, { id: 'A', model: buildQtoModel(a, null) }]);
  const t2 = takeoffTotals([{ id: 'A', model: buildQtoModel(a, null) }, { id: 'B', model: buildQtoModel(b, null) }]);
  assert.equal(t1.get('F1'), t2.get('F1'));
  close(t1.get('F1')!, 125);
});

test('26: a folder signature changes only when a journal grows', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v16d-sig-'));
  const { dir } = await createProject(nodefs, root, 'Sig take-off', 'Omar', 'PC1', [['project', 'name', 'x']], 'omar', 'takeoff');
  const s = new ProjectSession({ fs: nodefs, localFs: nodefs, projectDir: dir, localDir: mkdtempSync(join(tmpdir(), 'v16d-l-')), user: 'omar', account: 'omar', host: 'PC1', pollMs: 60000, fullScanMs: 60000, heartbeatMs: 60000 });
  await s.open();
  const a = await folderSig(nodefs, dir);
  assert.equal(await folderSig(nodefs, dir), a, 'nothing written: same signature');
  s.commit([['ti:x', 'name', 'Planters'], ['ti:x', 'kind', 'count']], 'New take-off');
  for (let i = 0; i < 50 && s.pendingCount; i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 400));
  const b = await folderSig(nodefs, dir);
  assert.notEqual(b, a, 'a change in the take-off: a new signature');
  await s.close();
  assert.equal(await folderSig(nodefs, join(root, 'nope')), null, 'a folder out of reach: no signature (not "changed")');
});

// ---------------------------------------------------------------- item 20
test('20: an additional item reaches the estimate as its own line in its bill, flagged, priced like any line', () => {
  const est = estimate();
  const q = takeoff(est);
  const m0 = buildQtoModel(q, null);
  const r = additionalItemOps(m0, { desc: 'Precast planter boxes', unit: 'm2', bill: 'g2', loc: 'Podium' }, { username: 'omar', name: 'Sam Carter' });
  add(q, [...r.ops, ['lk:9', 'ti', 'ti:a'], ['lk:9', 'to', r.id], ['lk:9', 'q', 'area']], 'omar');
  const m = buildQtoModel(q, null);
  assert.equal(dummyState(m, m.dummyById.get(r.id)!), 'add');
  assert.equal(linkKind(m, 'ti:a').k, 'add', 'its take-off shows the amber A+ mark');
  assert.equal(linkKind(m, 'ti:b').k, 'none');
  syncOnce(est, [{ id: 'QTO1', store: q }]);
  const line = qxId(r.id);
  const g = qaGroupId('g2');
  assert.equal(est.get(g, 'type'), 'group');
  assert.equal(est.get(g, 'parent'), 'g2', 'the "Additional items (QS)" heading is in the bill picked');
  assert.equal(est.get(g, 'desc'), QA_GROUP_DESC);
  assert.ok(String(est.get(g, 'ord')) > String(est.get('s2', 'ord')), '...at the end of that bill');
  assert.equal(est.get(line, 'parent'), g);
  assert.equal(est.get(line, 'desc'), 'Precast planter boxes');
  assert.equal(est.get(line, 'qa'), 'a');
  assert.equal(est.get(line, 'qby'), 'Sam Carter');
  assert.equal(est.get(line, 'qloc'), 'Podium');
  close(est.get(line, 'tq') as number, 100);
  const boq = buildModel(est);
  const n = boq.byId.get(line)!;
  assert.equal(n.qa?.k, 'a');
  assert.equal(n.qa?.own, false);
  assert.equal(syncOnce(est, [{ id: 'QTO1', store: q }]).wrote, 0, 'nothing more to write the second time');
  // the BOQ copy brings it back to the take-off: flagged, price-free
  const qm = buildQtoModel(q, null);
  const row = qm.boqById.get(line)!;
  assert.equal(row.qa, 'a');
  assert.equal(row.loc, 'Podium');
  assert.equal(qm.boqById.get(g)!.qa, 'g');
  assert.ok(!MIRROR_FIELDS.includes('rate' as never));
  // the estimator prices it: no price reaches the take-off
  add(est, [[line, 'rate', 120]], 'ahmed');
  syncOnce(est, [{ id: 'QTO1', store: q }]);
  assert.equal(q.get('b:' + line, 'rate'), undefined);
  assert.equal(buildQtoModel(q, null).boqById.get(line)!.own, true, 'priced by the estimator: the QS can no longer change it');
});

test('20: temporary lines - work as before without a BOQ; once it is here, not resolved ones are flagged on both sides; Keep moves them into the bill', () => {
  const empty = new Store();
  const q = takeoff(null);
  add(q, [['dm:t1', 'desc', 'Planters (until the BOQ arrives)'], ['dm:t1', 'unit', 'm2'], ['dm:t1', 'ord', 'a0'], ['lk:1', 'ti', 'ti:a'], ['lk:1', 'to', 'dm:t1'], ['lk:1', 'q', 'area']], 'omar');
  let m = buildQtoModel(q, null);
  assert.equal(dummyState(m, m.dummyById.get('dm:t1')!), 'temp');
  assert.equal(unresolvedCount(m), 0);
  assert.equal(additionalOps(buildModel(empty), empty, side(q), takeoffTotals(side(q)), true).length, 0, 'no BOQ yet: nothing goes to the estimate');
  // the BOQ arrives
  const est = estimate();
  add(q, mirrorOps(buildModel(est), q), 'ahmed');
  m = buildQtoModel(q, null);
  assert.equal(dummyState(m, m.dummyById.get('dm:t1')!), 'open');
  assert.equal(unresolvedCount(m), 1, 'flagged in the take-off');
  syncOnce(est, [{ id: 'QTO1', store: q }]);
  const line = qxId('dm:t1');
  assert.equal(est.get(line, 'qa'), 'n', 'flagged "Not resolved – QS" in the estimate');
  assert.equal(est.get(line, 'parent'), 'qa_end');
  assert.equal(est.get('qa_end', 'parent') ?? null, null, 'one heading at the end of the BOQ for those without a bill');
  close(est.get(line, 'tq') as number, 100);
  // the QS keeps it as an additional item in Bill 1
  m = buildQtoModel(q, null);
  add(q, keepAsAdditionalOps(m.dummyById.get('dm:t1')!, { bill: 'g1', loc: 'Level 3' }, { username: 'omar', name: 'Sam Carter' }), 'omar');
  m = buildQtoModel(q, null);
  assert.equal(dummyState(m, m.dummyById.get('dm:t1')!), 'add');
  assert.equal(unresolvedCount(m), 0);
  syncOnce(est, [{ id: 'QTO1', store: q }]);
  assert.equal(est.get(line, 'qa'), 'a');
  assert.equal(est.get(line, 'parent'), qaGroupId('g1'), 'moved into Bill 1\'s heading');
  assert.equal(est.get(line, 'qloc'), 'Level 3');
  assert.equal(est.get('qa_end', 'del'), true, 'the empty end heading goes');
  assert.deepEqual(knownLocations(buildQtoModel(q, null)), ['Level 3'], 'the location is suggested next time');
});

test('20: Match a temporary line not resolved - its line in the estimate goes, its quantity counts in the BOQ line', () => {
  const est = estimate();
  const q = takeoff(est);
  add(q, [['dm:t1', 'desc', 'Floor tiles'], ['dm:t1', 'unit', 'm2'], ['dm:t1', 'ord', 'a0'], ['lk:1', 'ti', 'ti:b'], ['lk:1', 'to', 'dm:t1'], ['lk:1', 'q', 'area']], 'omar');
  syncOnce(est, [{ id: 'QTO1', store: q }]);
  assert.equal(est.get(qxId('dm:t1'), 'qa'), 'n');
  add(q, [['dm:t1', 'map', 'F1']], 'omar');
  syncOnce(est, [{ id: 'QTO1', store: q }]);
  assert.equal(est.get(qxId('dm:t1'), 'del'), true);
  close(est.get('F1', 'tq') as number, 25);
});

test('20: who owns which field - the estimator\'s change wins; the QS\'s other suggestions still apply; relink and back', () => {
  const est = estimate();
  const q = takeoff(est);
  const r = additionalItemOps(buildQtoModel(q, null), { desc: 'Planter boxes', unit: 'm2', bill: 'g2', loc: 'Podium' }, { username: 'omar', name: 'Sam Carter' });
  add(q, [...r.ops, ['lk:9', 'ti', 'ti:a'], ['lk:9', 'to', r.id], ['lk:9', 'q', 'area']], 'omar');
  syncOnce(est, [{ id: 'QTO1', store: q }]);
  const line = qxId(r.id);
  let m = buildQtoModel(q, null);
  assert.equal(canEditSuggestion(m, m.dummyById.get(r.id)!, 'omar', false), true, 'the QS edits his own suggestion…');
  assert.equal(canEditSuggestion(m, m.dummyById.get(r.id)!, 'sara', false), false, '…not another QS\'s');
  // the estimator renames it (from the take-off's BOQ tab: in the estimate)
  add(est, lineEditOps(buildModel(est), est, line, { desc: 'Precast planters 1200x600' }), 'ahmed');
  // the QS then changes the description and the unit of his suggestion
  add(q, editAdditionalOps(buildQtoModel(q, null).dummyById.get(r.id)!, { desc: 'Planters (GRC)', unit: 'nr' }), 'omar');
  syncOnce(est, [{ id: 'QTO1', store: q }]);
  assert.equal(est.get(line, 'desc'), 'Precast planters 1200x600', 'the estimator\'s description wins');
  assert.equal(est.get(line, 'unit'), 'nr', 'the unit the estimator never touched follows the QS');
  m = buildQtoModel(q, null);
  assert.equal(addView(m, m.dummyById.get(r.id)!).desc, 'Precast planters 1200x600', 'the take-off shows the estimate\'s version');
  assert.equal(canEditSuggestion(m, m.dummyById.get(r.id)!, 'omar', false), false, 'changed by the estimator: no longer the QS\'s to change');
  assert.equal(canEditSuggestion(m, m.dummyById.get(r.id)!, 'ahmed', true), true, 'the estimator still can');
  // the estimator moves it to Bill 1, then relinks it to E1
  add(est, lineEditOps(buildModel(est), est, line, { bill: 'g1', loc: 'Roof' }), 'ahmed');
  assert.equal(est.get(line, 'parent'), qaGroupId('g1'));
  add(est, [[line, 'rate', 95]], 'ahmed');
  add(q, [[r.id, 'map', 'E1']], 'ahmed');
  m = buildQtoModel(q, null);
  assert.equal(dummyState(m, m.dummyById.get(r.id)!), 'relinked');
  assert.equal(linkKind(m, 'ti:a').k, 'boq', 'relinked: the take-off shows the teal BOQ mark');
  syncOnce(est, [{ id: 'QTO1', store: q }]);
  assert.equal(est.get(line, 'del'), true, 'the flagged line goes');
  close(est.get('E1', 'tq') as number, 100);
  assert.equal(est.get('E1', 'qty'), 100, 'never added to the BOQ quantity');
  // shown under E1 as a sub-item with its own description and quantity
  m = buildQtoModel(q, null);
  const rows = treeRows(m, { collapsed: new Set() });
  const sub = rows.find((x) => x.k === 'sub')!;
  assert.ok(sub && sub.k === 'sub' && sub.parent === 'E1' && sub.d.desc === 'Planters (GRC)');
  close(qtyOf(m, r.id)!, 100);
  assert.ok(rows.find((x) => x.id === 'E1' && x.k === 'row' && x.kids), 'E1 gets a chevron');
  // back on its own line: it comes back as it was (price and all)
  add(q, [[r.id, 'map', null]], 'ahmed');
  syncOnce(est, [{ id: 'QTO1', store: q }]);
  assert.equal(est.get(line, 'del') ?? null, null);
  assert.equal(est.get(line, 'rate'), 95);
  assert.equal(est.get(line, 'desc'), 'Precast planters 1200x600');
});

test('20: removed from the take-off - an untouched line goes, a priced one stays (marked); one the estimator deleted is not brought back', () => {
  const est = estimate();
  const q = takeoff(est);
  const mk = (desc: string) => { const r = additionalItemOps(buildQtoModel(q, null), { desc, unit: 'm2', bill: 'g1', loc: '' }, { username: 'omar', name: 'Omar' }); add(q, r.ops, 'omar'); return r.id; };
  const a = mk('Untouched'), b = mk('Priced'), c = mk('Deleted by the estimator');
  syncOnce(est, [{ id: 'QTO1', store: q }]);
  add(est, [[qxId(b), 'rate', 10], [qxId(c), 'del', true]], 'ahmed');
  add(q, [[a, 'del', true], [b, 'del', true]], 'omar');
  syncOnce(est, [{ id: 'QTO1', store: q }]);
  assert.equal(est.get(qxId(a), 'del'), true);
  assert.equal(est.get(qxId(b), 'del') ?? null, null);
  assert.equal(est.get(qxId(b), 'qgone'), true);
  assert.equal(buildModel(est).byId.get(qxId(b))!.qa?.gone, true);
  assert.equal(est.get(qxId(c), 'del'), true, 'deleted by the estimator: left deleted');
  assert.ok(buildQtoModel(q, null).boqGone.has(qxId(c)) || !buildQtoModel(q, null).boqById.has(qxId(c)));
});

test('20: a link to the BOQ copy\'s line of the take-off\'s own additional item goes to the item (counted once)', () => {
  const est = estimate();
  const q = takeoff(est);
  const r = additionalItemOps(buildQtoModel(q, null), { desc: 'Planters', unit: 'm2', bill: 'g2', loc: '' }, { username: 'omar', name: 'Omar' });
  add(q, [...r.ops, ['lk:9', 'ti', 'ti:a'], ['lk:9', 'to', r.id], ['lk:9', 'q', 'area']], 'omar');
  syncOnce(est, [{ id: 'QTO1', store: q }]);
  const m = buildQtoModel(q, null);
  assert.equal(linkTarget(m, 'b:' + qxId(r.id)), r.id);
  assert.ok(alreadyLinked(m, 'ti:a', r.id));
});

// ---------------------------------------------------------------- item 24
test('24: the take-offs linked to a line, and unlinking only removes the links (one step brings them back)', () => {
  const est = estimate();
  const q = takeoff(est);
  add(q, [['dm:t1', 'desc', 'Tiles'], ['dm:t1', 'map', 'F1'], ['lk:1', 'ti', 'ti:b'], ['lk:1', 'to', 'b:F1'], ['lk:1', 'q', 'area'], ['lk:2', 'ti', 'ti:a'], ['lk:2', 'to', 'dm:t1'], ['lk:2', 'q', 'area'], ['lk:3', 'ti', 'ti:b'], ['lk:3', 'to', 'dm:t1'], ['lk:3', 'q', 'area']], 'omar');
  let m = buildQtoModel(q, null);
  const li = linkedItems(m, 'F1');
  assert.deepEqual(li.map((x) => x.ti).sort(), ['ti:a', 'ti:b']);
  assert.equal(li.find((x) => x.ti === 'ti:b')!.links.length, 2, 'every link of it (the second one, counted once, too)');
  close(li.find((x) => x.ti === 'ti:b')!.v, 25);
  const ops = unlinkOps(li.flatMap((x) => x.links));
  assert.ok(ops.every((o) => o[0].startsWith('lk:') && o[1] === 'del'), 'only links are touched');
  add(q, ops, 'omar');
  m = buildQtoModel(q, null);
  assert.equal(linkedItems(m, 'F1').length, 0);
  assert.equal(m.itemById.size, 2, 'the take-offs stay');
  assert.equal(m.shapes.length, 2, '...with their shapes');
  assert.equal(linkKind(m, 'ti:b').k, 'none', 'shown unlinked in the take-off list');
});

// ---------------------------------------------------------------- items 23 / 25
function bigTakeoff() {
  const est = estimate();
  const q = takeoff(est);
  add(q, [['lk:1', 'ti', 'ti:b'], ['lk:1', 'to', 'b:F1'], ['lk:1', 'q', 'area']], 'omar');
  add(q, [['lk:2', 'ti', 'ti:a'], ['lk:2', 'to', 'b:E1'], ['lk:2', 'q', 'area']], 'sara');
  return buildQtoModel(q, null);
}
test('25: the BOQ as a tree - chevrons where there is something under, collapse, levels', () => {
  const m = bigTakeoff();
  let rows = treeRows(m, { collapsed: new Set() });
  assert.deepEqual(rows.map((r) => r.id), ['g1', 's1', 'E1', 'E2', 'g2', 's2', 'F1']);
  assert.deepEqual(rows.filter((r) => r.k === 'row' && r.kids).map((r) => r.id), ['g1', 's1', 'g2', 's2']);
  rows = treeRows(m, { collapsed: new Set(['s1']) });
  assert.deepEqual(rows.map((r) => r.id), ['g1', 's1', 'g2', 's2', 'F1']);
  assert.deepEqual(treeRows(m, { collapsed: collapsedForLevel(m, 1) }).map((r) => r.id), ['g1', 'g2'], 'Bills');
  assert.deepEqual(treeRows(m, { collapsed: collapsedForLevel(m, 2) }).map((r) => r.id), ['g1', 's1', 'g2', 's2'], '+ Sections');
  assert.deepEqual(treeRows(m, { collapsed: collapsedForLevel(m, 0) }).length, 7, 'All');
  assert.deepEqual(treeRows(m, { collapsed: new Set(closable(m).map((x) => x.id)) }).map((r) => r.id), ['g1', 'g2'], 'Collapse all');
  assert.equal(crumbOf(m, 'E2'), 'Bill 1 SUBSTRUCTURE › Earthworks');
  assert.deepEqual(ancestors(m, 'E2'), ['g1', 's1']);
});

test('25: search by ref, description or code opens the tree to each match and marks it; Show filters', () => {
  const m = bigTakeoff();
  const all = new Set(closable(m).map((x) => x.id));
  let rows = treeRows(m, { collapsed: all, q: 'trial' });
  assert.deepEqual(rows.map((r) => r.id), ['g1', 's1', 'E2'], 'a match is never hidden by a closed heading');
  assert.equal(rows.find((r) => r.id === 'E2')!.k === 'row' && (rows.find((r) => r.id === 'E2') as any).hit, true);
  rows = treeRows(m, { collapsed: new Set(), q: 'b/2' });
  assert.deepEqual(rows.map((r) => r.id), ['g1', 's1', 'E2'], 'the consultant\'s page code');
  rows = treeRows(m, { collapsed: new Set(), show: 'linked' });
  assert.deepEqual(rows.map((r) => r.id), ['g1', 's1', 'E1', 'g2', 's2', 'F1']);
  rows = treeRows(m, { collapsed: new Set(), show: 'open' });
  assert.deepEqual(rows.map((r) => r.id), ['g1', 's1', 'E2']);
  rows = treeRows(m, { collapsed: new Set(), show: 'mine', me: 'omar' });
  assert.deepEqual(rows.map((r) => r.id), ['g2', 's2', 'F1'], 'Linked by me: what this person linked');
  rows = treeRows(m, { collapsed: new Set(), show: 'diff' });
  assert.deepEqual(rows.map((r) => r.id), ['g2', 's2', 'F1'], 'Differs > 5 %: 25 against 50');
});

test('25: 10,000 lines - the tree is worked out quickly', () => {
  const ops: Op[] = [];
  for (let b = 0; b < 10; b++) {
    ops.push(['b:g' + b, 'bt', 'group'], ['b:g' + b, 'ord', 'a' + b], ['b:g' + b, 'desc', 'Bill ' + b]);
    for (let s = 0; s < 20; s++) {
      const sid = `s${b}_${s}`;
      ops.push(['b:' + sid, 'bt', 'group'], ['b:' + sid, 'par', 'g' + b], ['b:' + sid, 'ord', 'a' + String(s).padStart(2, '0')], ['b:' + sid, 'desc', 'Section ' + s]);
      for (let i = 0; i < 50; i++) { const id = `i${b}_${s}_${i}`; ops.push(['b:' + id, 'bt', 'item'], ['b:' + id, 'par', sid], ['b:' + id, 'ord', 'a' + String(i).padStart(2, '0')], ['b:' + id, 'desc', 'Line ' + i + ' concrete'], ['b:' + id, 'unit', 'm3'], ['b:' + id, 'qty', i]); }
    }
  }
  const m = buildQtoModel(storeWith(ops), null);
  const t = Date.now();
  for (let k = 0; k < 5; k++) { treeRows(m, { collapsed: new Set() }); treeRows(m, { collapsed: new Set(), q: 'line 4' }); }
  const ms = (Date.now() - t) / 10;
  assert.equal(treeRows(m, { collapsed: new Set() }).length, 10 + 200 + 10000);
  assert.ok(ms < 150, `${ms.toFixed(0)} ms per tree`);
});
