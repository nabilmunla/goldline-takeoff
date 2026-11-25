// v0.16 review r2 (debug run 1): drawing tabs / binder pages / rename / Go to sheet, the BOQ tab, additional
// items, unlinking, the background estimate sync and the data format. Each test failed before its fix.
// run: node --import tsx --test tests/v16-r2.test.ts
import './stub-window';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Store } from '../src/engine/store';
import { buildModel } from '../src/engine/boq';
import { buildQtoModel, qxId } from '../src/engine/qto/model';
import { scaleFromRatio } from '../src/engine/qto/geometry';
import { mirrorOps, syncEstimate, folderSig, qaGroupId, lineEditOps, type SyncProject } from '../src/engine/qto/bridge';
import { splitBinderOps, planImport } from '../src/engine/qto/revisions';
import { tabTarget } from '../src/ui/takeoff/Sheets16';
import { additionalItemOps, dummyState, unresolvedCount } from '../src/engine/qto/additional';
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
const proj = (store: Store, id: string, readOnly = false): SyncProject => ({
  store, meta: { format: 'takeoff', formatVersion: 1, id, name: id, created: 0, createdBy: '' }, readOnly,
  commit(ops: Op[]): Batch | null { if (readOnly || !ops.length) return null; add(store, ops, 'ahmed'); return {} as Batch; },
});
/** Bill 1 (Earthworks: E1 m2 100, E2 nr 10), Bill 2 (Floor finishes: F1 m2 50) */
function estimate(): Store {
  return storeWith([
    ['g1', 'type', 'group'], ['g1', 'ord', 'a0'], ['g1', 'ref', 'Bill 1'], ['g1', 'desc', 'SUBSTRUCTURE'],
    ['s1', 'type', 'group'], ['s1', 'parent', 'g1'], ['s1', 'ord', 'a0'], ['s1', 'desc', 'Earthworks'],
    ['E1', 'type', 'item'], ['E1', 'parent', 's1'], ['E1', 'ord', 'a0'], ['E1', 'ref', 'A'], ['E1', 'desc', 'Excavation to reduce levels'], ['E1', 'unit', 'm2'], ['E1', 'qty', 100],
    ['E2', 'type', 'item'], ['E2', 'parent', 's1'], ['E2', 'ord', 'a1'], ['E2', 'ref', 'B'], ['E2', 'desc', 'Trial pits'], ['E2', 'unit', 'nr'], ['E2', 'qty', 10],
    ['g2', 'type', 'group'], ['g2', 'ord', 'a1'], ['g2', 'ref', 'Bill 2'], ['g2', 'desc', 'FINISHES'],
    ['s2', 'type', 'group'], ['s2', 'parent', 'g2'], ['s2', 'ord', 'a0'], ['s2', 'desc', 'Floor finishes'],
    ['F1', 'type', 'item'], ['F1', 'parent', 's2'], ['F1', 'ord', 'a0'], ['F1', 'ref', 'A'], ['F1', 'desc', 'Porcelain tiles 600x600'], ['F1', 'unit', 'm2'], ['F1', 'qty', 50],
  ], 'ahmed');
}
/** two areas (100 m² and 25 m²), the BOQ copy of `est` */
function takeoff(est: Store | null): Store {
  const q = storeWith([
    ['project', 'est', 'EST'], ['pg:d1.0', 'sc', S100],
    ['ti:a', 'kind', 'area'], ['ti:a', 'name', 'Planters'], ['sh:a', 'ti', 'ti:a'], ['sh:a', 'dwg', 'd1'], ['sh:a', 'pg', 0], ['sh:a', 'k', 'poly'], ['sh:a', 'p', J(sq(0, 0, 10))],
    ['ti:b', 'kind', 'area'], ['ti:b', 'name', 'Tiles'], ['sh:b', 'ti', 'ti:b'], ['sh:b', 'dwg', 'd1'], ['sh:b', 'pg', 0], ['sh:b', 'k', 'poly'], ['sh:b', 'p', J(sq(300, 0, 5))],
  ], 'omar');
  if (est) add(q, mirrorOps(buildModel(est), q), 'ahmed');
  return q;
}
const syncOnce = (est: Store, q: Store) => syncEstimate(proj(est, 'EST'), [{ id: 'QTO1', p: proj(q, 'QTO1') }]);

// ---------------------------------------------------------------- item 26: the background sync's trigger
test('26: a QS who worked while no estimator\'s app was looking is still seen (same journal names, it grew)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v16r2-sig-'));
  const { dir } = await createProject(nodefs, root, 'Sig take-off', 'Omar', 'PC1', [['project', 'name', 'x']], 'omar', 'takeoff');
  const local = mkdtempSync(join(tmpdir(), 'v16r2-l-'));
  // the QS opens the take-off, links something, closes (the same journal file every session of his on this PC)
  const work = async (n: number) => {
    const s = new ProjectSession({ fs: nodefs, localFs: nodefs, projectDir: dir, localDir: local, user: 'omar', account: 'omar', host: 'PC1', pollMs: 60000, fullScanMs: 60000, heartbeatMs: 60000 });
    await s.open();
    s.commit([['ti:x' + n, 'name', 'Planters ' + n], ['ti:x' + n, 'kind', 'count']], 'New take-off');
    for (let i = 0; i < 50 && s.pendingCount; i++) await new Promise((r) => setTimeout(r, 50));
    await s.close();
  };
  // ...and a while later someone else's app tidies his presence file away (10 minutes after he left)
  const tidy = () => { for (const f of readdirSync(join(dir, 'presence'))) rmSync(join(dir, 'presence', f)); };
  await work(1);
  const withPresence = await folderSig(nodefs, dir);
  tidy();
  const a = await folderSig(nodefs, dir);
  assert.equal(a, withPresence, 'his presence file going away is not a change (no needless sync)');
  // the estimator's app was closed (it saved `a`); the QS works again and leaves; his presence is tidied away
  await work(2);
  tidy();
  const b = await folderSig(nodefs, dir);
  assert.notEqual(b, a, 'his journal grew: the take-off must be synced when the estimator\'s app starts');
  // the size of a journal nobody is writing is read once and kept by the caller
  const idle = new Map<string, number>();
  const c1 = await folderSig(nodefs, dir, idle);
  assert.equal(c1, b);
  assert.ok(idle.size > 0);
  let reads = 0;
  const counting: FsApi = { ...nodefs, readFrom: (p, o, n) => { reads++; return nodefs.readFrom(p, o, n); } };
  assert.equal(await folderSig(counting, dir, idle), b);
  assert.equal(reads, 0, 'not read again every few seconds');
});

// ---------------------------------------------------------------- item 20: a take-off out of reach
test('20: an app that can\'t read every take-off leaves an additional item\'s quantity alone (no tug of war with one that can)', () => {
  const est = estimate();
  const q1 = takeoff(est), q2 = takeoff(est);
  const r = additionalItemOps(buildQtoModel(q1, null), { desc: 'Precast planters', unit: 'm2', bill: 'g2', loc: 'Podium' }, { username: 'omar', name: 'Omar' });
  add(q1, [...r.ops, ['lk:1', 'ti', 'ti:a'], ['lk:1', 'to', r.id], ['lk:1', 'q', 'area']], 'omar');
  const both = (p2: SyncProject | null) => syncEstimate(proj(est, 'EST'), [{ id: 'Q1', p: proj(q1, 'Q1') }, { id: 'Q2', p: p2 }]);
  both(proj(q2, 'Q2'));
  // a second QS links his take-off to that line (in his BOQ copy)
  add(q2, mirrorOps(buildModel(est), q2), 'ahmed');
  add(q2, [['lk:2', 'ti', 'ti:a'], ['lk:2', 'to', 'b:' + qxId(r.id)], ['lk:2', 'q', 'area']], 'sami');
  both(proj(q2, 'Q2'));
  close(est.get(qxId(r.id), 'qty') as number, 200);
  // an estimator's PC that can't reach the second take-off (slow share) writes nothing about it
  assert.equal(both(null).wrote, 0);
  close(est.get(qxId(r.id), 'qty') as number, 200);
  close(est.get(qxId(r.id), 'tq') as number, 200);
});

// ---------------------------------------------------------------- item 15: split while someone measures
test('15: shapes, viewports and notes put on a drawing by a PC that had not seen it split yet go onto their page\'s sheet', () => {
  const d = 'dwg:old';
  const st = storeWith([
    [d, 'name', 'Set.pdf'], [d, 'path', 'S:\\Set.pdf'], [d, 'hash', 'h2'], [d, 'size', 5], [d, 'mtime', 6], [d, 'pages', 3],
    ['pg:' + d + '.0', 'sc', S100], ['pg:' + d + '.1', 'sc', S100], ['pg:' + d + '.2', 'sc', S100],
    ['ti:a', 'kind', 'area'], ['ti:a', 'name', 'Floor'],
    ['sh:p0', 'ti', 'ti:a'], ['sh:p0', 'dwg', d], ['sh:p0', 'pg', 0], ['sh:p0', 'k', 'poly'], ['sh:p0', 'p', J(sq(0, 0, 10))],
  ], 'qs1');
  const m0 = buildQtoModel(st, null);
  const r = splitBinderOps(st, m0, m0.dwgById.get(d)!, [], 'qs1');
  add(st, r.ops, 'qs1');
  // the other QS's PC, a moment behind: a shape on page 2, one on a page past the last, a viewport and a note on page 3
  add(st, [
    ['sh:x', 'ti', 'ti:a'], ['sh:x', 'dwg', d], ['sh:x', 'pg', 1], ['sh:x', 'k', 'poly'], ['sh:x', 'p', J(sq(0, 0, 5))], ['sh:x', 'opg', 2],
    ['sh:off', 'ti', 'ti:a'], ['sh:off', 'dwg', d], ['sh:off', 'pg', 4], ['sh:off', 'k', 'poly'], ['sh:off', 'p', J(sq(0, 0, 5))],
    ['sr:v', 'dwg', d], ['sr:v', 'pg', 2], ['sr:v', 'r', J([0, 0, 50, 50])], ['sr:v', 'sc', S100 * 2], ['sr:v', 'scl', '1:200'],
    ['nt:n', 'text', 'check', ], ['nt:n', 'on', 'ti:a'], ['nt:n', 'dwg', d], ['nt:n', 'pg', 2], ['nt:n', 'x', 10], ['nt:n', 'y', 10], ['nt:n', 'by', 'qs2'], ['nt:n', 't', 1],
  ], 'qs2');
  const m = buildQtoModel(st, null);
  close(m.qty.get('ti:a')!.area, 125);
  assert.deepEqual(m.shapes.find((s) => s.id === 'sh:x')!.dwg, r.ids[1]);
  assert.equal(m.shapes.find((s) => s.id === 'sh:x')!.opg, 1, 'measured on page 3 of an earlier revision: still that page');
  assert.equal(m.offPage.get(r.ids[2]), 1, 'past the last page: reported on the last sheet');
  assert.deepEqual(m.regions.map((x) => [x.dwg, x.pg]), [[r.ids[2], 0]]);
  assert.deepEqual(m.notes.map((n) => [n.dwg, n.pg]), [[r.ids[2], 0]]);
  // the split undone: back on the drawing as they were
  add(st, [[d, 'del', null], ...r.ids.map((id) => [id, 'del', true] as Op), ['sh:p0', 'dwg', d]], 'qs1');
  const m1 = buildQtoModel(st, null);
  assert.deepEqual(m1.shapes.find((s) => s.id === 'sh:x')!.dwg, d);
  close(m1.qty.get('ti:a')!.area, 125);
  // a page's sheet removed: its shapes go with it (not onto another sheet)
  add(st, [[d, 'del', true], ...r.ids.map((id) => [id, 'del', null] as Op), ['sh:p0', 'dwg', r.ids[0]]], 'qs1');
  add(st, [[r.ids[1], 'del', true]], 'qs1');
  close(buildQtoModel(st, null).qty.get('ti:a')!.area, 100);
});

// ---------------------------------------------------------------- item 14: a tab on a drawing split by someone
test('14: a tab (or the sheet remembered from last time) on a drawing someone split goes to its page\'s sheet; a removed one closes', () => {
  const d = 'dwg:old';
  const st = storeWith([[d, 'name', 'Set.pdf'], [d, 'path', 'S:\\Set.pdf'], [d, 'pages', 3], ['dwg:x', 'name', 'Other.pdf'], ['dwg:x', 'path', 'S:\\Other.pdf'], ['dwg:x', 'pages', 1]], 'qs1');
  const m0 = buildQtoModel(st, null);
  assert.deepEqual(tabTarget(m0, { dwg: d, pg: 2 }), { dwg: d, pg: 2 });
  const r = splitBinderOps(st, m0, m0.dwgById.get(d)!, [], 'qs2');
  add(st, r.ops, 'qs2');
  add(st, [['dwg:x', 'del', true]], 'qs2');
  const m = buildQtoModel(st, null);
  assert.deepEqual(tabTarget(m, { dwg: d, pg: 2 }), { dwg: r.ids[2], pg: 0 });
  assert.equal(tabTarget(m, { dwg: d, pg: 7 }), null);
  assert.equal(tabTarget(m, { dwg: 'dwg:x', pg: 0 }), null);
});

// ---------------------------------------------------------------- item 15: a bound set's page and a drawing from before 0.16
test('15: a page of a new bound set is never made the next revision of a whole multi-page drawing from before 0.16', () => {
  const st = storeWith([
    ['dwg:o', 'name', 'AR-100 Architectural set.pdf'], ['dwg:o', 'path', 'S:\\PTA01\\AR-100 Architectural set.pdf'], ['dwg:o', 'pages', 3], ['dwg:o', 'sheet', 'AR-100'],
    ['dwg:s', 'name', 'AR-101.pdf'], ['dwg:s', 'path', 'S:\\PTA01\\AR-101.pdf'], ['dwg:s', 'pages', 1], ['dwg:s', 'sheet', 'AR-101'],
  ]);
  const m = buildQtoModel(st, null);
  const p = 'S:\\PTA02\\Arch issue B.pdf';
  const rows = planImport([{ path: p, rel: 'Arch issue B.pdf', size: 1, mtime: 2 }], m, () => '', new Map([[p, { n: 3, pages: [{ sheet: 'AR-100', title: 'GF', pre: '' }, { sheet: 'AR-101', title: '1F', pre: '' }, { sheet: 'AR-102', title: '2F', pre: '' }] }]]));
  // (its pages 2 and 3 - with what was measured on them - would go off the page)
  assert.deepEqual(rows.map((r) => [r.fp, r.action, r.target]), [[0, 'new', null], [1, 'rev', 'dwg:s'], [2, 'new', null]]);
});

// ---------------------------------------------------------------- item 26: the cost of a take-off that can't be read
