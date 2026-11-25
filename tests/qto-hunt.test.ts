// v0.12.2 take-off hunt: what the QS sessions, the engine repros and the closing runs found, kept fixed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { unzipSync, strFromU8 } from 'fflate';
import { Store } from '../src/engine/store';
import type { Op, Batch, FsApi } from '../src/engine/types';
import { buildQtoModel, flattenMirror } from '../src/engine/qto/model';
import { splitLineOps, splitLineAtOps, explodeLineOps, joinLinesOps, addHoleOps, vertexOps, deleteVertexOps } from '../src/engine/qto/ops';
import { moveNodesOps } from '../src/engine/qto/headings';
import { exportQto } from '../src/engine/qto/export';
import { unitFactor, measureForUnit } from '../src/engine/qto/units';
import { scaleFromRatio, type Pt } from '../src/engine/qto/geometry';
import { newSheetOps, planImport, moveOffPageOps, type ImportRow } from '../src/engine/qto/revisions';
import { ProjectSession } from '../src/engine/session';
import { createProject } from '../src/engine/projects';

const require = createRequire(import.meta.url);
const nodefs: FsApi = require('../electron/nodefs.cjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'gtqto-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const J = (v: unknown) => JSON.stringify(v);
const S100 = scaleFromRatio(100);
const S50 = scaleFromRatio(50);
const M = 1 / S100; // sheet points per metre at 1:100

let k = 0;
const mk = (o: Op[], w = 'pc1'): Batch => ({ s: String(++k).padStart(12, '0') + '~' + w, w, u: w, t: 0, o, a: w });
const storeOf = (...opss: Op[][]) => { const s = new Store(); for (const o of opss) s.apply(mk(o)); return s; };
const apply = (s: Store, ops: Op[], w = 'pc1') => s.apply(mk(ops, w));
const shapeEnt = (id: string, ti: string, kk: 'poly' | 'line' | 'pt', p: number[], extra: Op[] = [], dwg = 'dwg:d1', pg = 0): Op[] =>
  [[id, 'ti', ti], [id, 'dwg', dwg], [id, 'pg', pg], [id, 'k', kk], [id, 'p', J(p)], ...extra];
const pts = (f: number[]): Pt[] => f.reduce<Pt[]>((o, _, i) => (i % 2 ? o : [...o, [f[i], f[i + 1]]]), []);
const sq = (x: number, y: number, w: number, h = w) => [x, y, x + w * M, y, x + w * M, y + h * M, x, y + h * M].map((v) => Math.round(v * 100) / 100);
// sheet points are kept to 0.001 pt (0.01 pt before v0.12.3), so drawn metres come back within a fraction of a millimetre
const near = (a: number, b: number, eps = 5e-3) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('split, split into segments and join: the drawn length stays the same and the old shape goes', () => {
  const st = storeOf([['pg:dwg:d1.0', 'sc', S100], ['ti:sk', 'kind', 'line'], ['ti:sk', 'name', 'Skirting'],
    ...shapeEnt('sh:s', 'ti:sk', 'line', [0, 0, 4 * M, 0, 4 * M, 6 * M])]);
  const len = () => buildQtoModel(st, null).qty.get('ti:sk')!.len;
  near(len(), 10);
  const r = splitLineOps(buildQtoModel(st, null).shapes[0], 1, 'QS1')!;
  assert.ok(r.ops.some((o) => o[0] === 'sh:s' && o[1] === 'del' && o[2] === true), 'the original is deleted');
  assert.equal(r.ids.length, 2);
  apply(st, r.ops);
  let m = buildQtoModel(st, null);
  assert.deepEqual(m.shapes.map((s) => s.id).sort(), [...r.ids].sort());
  near(len(), 10);
  const [a, c] = m.shapes;
  apply(st, joinLinesOps(c, a, 1, undefined, 'QS1')!);
  m = buildQtoModel(st, null);
  assert.equal(m.shapes.length, 1);
  assert.ok(!r.ids.includes(m.shapes[0].id), 'the join is a new shape');
  near(len(), 10);
  apply(st, explodeLineOps(m.shapes[0], 'QS1').ops);
  assert.equal(buildQtoModel(st, null).shapes.length, 2);
  near(len(), 10);
});

test('undo of a split after someone else changed one part: nothing is undone, nothing counted twice', async () => {
  for (const second of [(id: string): Op[] => [[id, 'ti', 'ti:sk2']], (id: string): Op[] => [[id, 'm', 2]]]) {
    const { dir } = await createProject(nodefs, tmp(), 'Split undo', 'QS1', 'PC1', [['pg:dwg:d.0', 'sc', S100],
      ['ti:sk', 'kind', 'line'], ['ti:sk', 'name', 'Skirting'], ['ti:sk2', 'kind', 'line'], ['ti:sk2', 'name', 'Skirting (wet areas)'],
      ...shapeEnt('sh:s', 'ti:sk', 'line', [0, 0, 4 * M, 0, 4 * M, 6 * M], [], 'dwg:d')], undefined, 'takeoff');
    const open = async (u: string) => { const s = new ProjectSession({ fs: nodefs, localFs: nodefs, projectDir: dir, localDir: tmp(), user: u, host: 'PC-' + u, pollMs: 60000, fullScanMs: 0, heartbeatMs: 60000 }); await s.open(); return s; };
    const a = await open('QS1'), b = await open('QS2');
    const total = (s: ProjectSession) => { const m = buildQtoModel(s.store, null); const q = (t: string) => m.qty.get(t)!; return q('ti:sk').len + q('ti:sk2').len; };
    const r = splitLineOps(buildQtoModel(a.store, null).shapes[0], 1, 'QS1')!;
    a.commit(r.ops, 'Split at the corner');
    await sleep(30); await b.tick();
    b.commit(second(r.ids[1]), 'QS2 works on one part');
    await sleep(30); await a.tick();
    const before = total(a);
    const u = a.undo();
    assert.ok(u && u.skipped > 0, 'the undo says it could not be done');
    await sleep(30); await b.tick(); await a.tick();
    near(total(a), before); near(total(b), before);
    assert.ok(!buildQtoModel(b.store, null).shapes.some((s) => s.id === 'sh:s'), 'the original does not come back beside the parts');
    await a.close(); await b.close();
  }
});

test('the same shapes arriving in another order give the same quantity to the last digit (every PC writes the same)', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let t = 0; t < 300; t++) {
    const rects = [0, 1, 2, 3].map(() => {
      const x = Math.round(rnd() * 200000) / 100, y = Math.round(rnd() * 200000) / 100, w = Math.round((5 + rnd() * 300) * 100) / 100, h = Math.round((5 + rnd() * 300) * 100) / 100;
      return [x, y, x + w, y, x + w, y + h, x, y + h];
    });
    const head: Op[] = [['pg:dwg:d1.0', 'sc', S100], ['ti:a', 'kind', 'area'], ['ti:a', 'name', 'Floor tiling'], ['b:L1', 'bt', 'item'], ['b:L1', 'desc', 'Floor tiling'],
      ['b:L1', 'unit', 'm2'], ['lk:1', 'ti', 'ti:a'], ['lk:1', 'to', 'b:L1'], ['lk:1', 'q', 'area']];
    const shp = rects.map((p, i) => mk(shapeEnt('sh:' + i, 'ti:a', 'poly', p), i % 2 ? 'pc2' : 'pc1'));
    const h = mk(head);
    const s1 = new Store(), s2 = new Store();
    for (const b of [h, ...shp]) s1.apply(b);
    for (const b of [h, ...[...shp].reverse()]) s2.apply(b);
    assert.equal(buildQtoModel(s1, null).boqQty.get('L1')!.total, buildQtoModel(s2, null).boqQty.get('L1')!.total);
  }
});

test('two QS move two headings into each other at once: every PC shows the same tree and exports the same file', () => {
  const bA = mk([['hd:A', 'name', 'Tower A'], ['hd:A', 'ord', 'a0'], ['ti:1', 'kind', 'area'], ['ti:1', 'name', 'Plaster'], ['ti:1', 'par', 'hd:A'], ['ti:1', 'ord', 'a0'],
    ['pg:dwg:d.0', 'sc', S100], ...shapeEnt('sh:1', 'ti:1', 'poly', [0, 0, 100, 0, 100, 100, 0, 100], [], 'dwg:d')], 'pc1');
  const bB = mk([['hd:B', 'name', 'Tower B'], ['hd:B', 'ord', 'a1'], ['ti:2', 'kind', 'area'], ['ti:2', 'name', 'Paint'], ['ti:2', 'par', 'hd:B'], ['ti:2', 'ord', 'a0'],
    ...shapeEnt('sh:2', 'ti:2', 'poly', [0, 0, 200, 0, 200, 200, 0, 200], [], 'dwg:d')], 'pc2');
  const base = new Store(); base.apply(bA); base.apply(bB);
  const m0 = buildQtoModel(base, null);
  const m1 = mk(moveNodesOps(m0.itemTree, ['hd:A'], { par: 'hd:B', before: null }), 'pc1');
  const m2 = mk(moveNodesOps(m0.itemTree, ['hd:B'], { par: 'hd:A', before: null }), 'pc2');
  const X = new Store(); for (const b of [bA, bB, m1, m2]) X.apply(b);
  const Y = new Store(); for (const b of [bB, bA, m2, m1]) Y.apply(b);
  const [mx, my] = [buildQtoModel(X, null), buildQtoModel(Y, null)];
  assert.deepEqual((mx.tree.get('') ?? []).map((n) => n.id), (my.tree.get('') ?? []).map((n) => n.id));
  assert.ok((mx.tree.get('') ?? []).length > 0, 'the loop is broken: something is at the top');
  const when = new Date(0);
  assert.deepEqual(exportQto(mx, { project: 'p', by: 'x', when }), exportQto(my, { project: 'p', by: 'x', when }));
});

test('cut-outs that no longer fit (moved onto each other, outside the outline, crossing it) are not deducted, and are flagged', () => {
  const room = () => storeOf([['pg:dwg:d1.0', 'sc', S100], ['ti:f', 'kind', 'area'], ['ti:f', 'name', 'Floor tiling'], ...shapeEnt('sh:r', 'ti:f', 'poly', sq(100, 100, 10))]);
  const h1 = pts(sq(100 + 1 * M, 100 + 1 * M, 2)), h2 = pts(sq(100 + 6 * M, 100 + 6 * M, 2));
  // two shafts, then the second dragged corner by corner onto the first
  let st = room();
  apply(st, addHoleOps(buildQtoModel(st, null).shapes[0], h1));
  apply(st, addHoleOps(buildQtoModel(st, null).shapes[0], h2));
  near(buildQtoModel(st, null).qty.get('ti:f')!.area, 92);
  for (let i = 0; i < 4; i++) apply(st, vertexOps(buildQtoModel(st, null).shapes[0], 2, i, h1[i]));
  let q = buildQtoModel(st, null).qty.get('ti:f')!;
  near(q.area, 96); assert.equal(q.badHoles, 1);
  // the room shrunk so the shaft is outside it
  st = storeOf([['pg:dwg:d1.0', 'sc', S100], ['ti:f', 'kind', 'area'], ['ti:f', 'name', 'Floor tiling'], ...shapeEnt('sh:r', 'ti:f', 'poly', sq(100, 100, 10), [['sh:r', 'holes', J([h2.flat()])]])]);
  near(buildQtoModel(st, null).qty.get('ti:f')!.area, 96);
  apply(st, vertexOps(buildQtoModel(st, null).shapes[0], 0, 1, [100 + 5 * M, 100]));
  apply(st, vertexOps(buildQtoModel(st, null).shapes[0], 0, 2, [100 + 5 * M, 100 + 10 * M]));
  q = buildQtoModel(st, null).qty.get('ti:f')!;
  near(q.area, 50); assert.equal(q.badHoles, 1);
  // a corner of the room deleted: the shaft now crosses the outline
  st = storeOf([['pg:dwg:d1.0', 'sc', S100], ['ti:f', 'kind', 'area'], ['ti:f', 'name', 'Floor tiling'], ...shapeEnt('sh:r', 'ti:f', 'poly', sq(100, 100, 10), [['sh:r', 'holes', J([h2.flat()])]])]);
  apply(st, deleteVertexOps(buildQtoModel(st, null).shapes[0], 0, 2));
  q = buildQtoModel(st, null).qty.get('ti:f')!;
  near(q.area, 50); assert.equal(q.badHoles, 1);
});

test('a length running out of a 1:50 viewport onto the 1:100 page: each part at its own scale, however it is split or joined', () => {
  const base = () => storeOf([
    ['pg:dwg:d1.0', 'sc', S100], ['sr:vp', 'dwg', 'dwg:d1'], ['sr:vp', 'pg', 0], ['sr:vp', 'r', J([0, 0, 300, 300])], ['sr:vp', 'sc', S50],
    ['ti:w', 'kind', 'line'], ['ti:w', 'name', 'Blockwork 200'], ['ti:w', 'h', 3],
    ...shapeEnt('sh:w', 'ti:w', 'line', [100, 100, 350, 100, 350, 400]),
  ]);
  const want = 200 * S50 + 50 * S100 + 300 * S100;
  const len = (st: Store) => buildQtoModel(st, null).qty.get('ti:w')!.len;
  let st = base();
  near(len(st), want);
  assert.equal(buildQtoModel(st, null).qty.get('ti:w')!.mixed, 1);
  apply(st, splitLineAtOps(buildQtoModel(st, null).shapes[0], 0, [320, 100], 'qs')!.ops);
  near(len(st), want);
  st = base();
  apply(st, explodeLineOps(buildQtoModel(st, null).shapes[0], 'qs').ops);
  near(len(st), want);
  const [a, c] = buildQtoModel(st, null).shapes;
  apply(st, joinLinesOps(c, a, 1, undefined, 'qs')!);
  near(len(st), want);
});

test('a negative scale (typed "-7200") is not used: the sheet counts as not scaled', () => {
  const st = storeOf([
    ['pg:dwg:a.0', 'sc', S100], ['pg:dwg:b.0', 'sc', -S100],
    ['ti:sk', 'kind', 'line'], ['ti:sk', 'name', 'Skirting'],
    ...shapeEnt('sh:1', 'ti:sk', 'line', [0, 0, 30 * M, 0], [], 'dwg:a'),
    ...shapeEnt('sh:2', 'ti:sk', 'line', [0, 0, 10 * M, 0], [], 'dwg:b'),
    ['sr:v', 'dwg', 'dwg:a'], ['sr:v', 'pg', 0], ['sr:v', 'r', J([500, 500, 600, 600])], ['sr:v', 'sc', -1],
  ]);
  const m = buildQtoModel(st, null);
  near(m.qty.get('ti:sk')!.len, 30);
  assert.equal(m.regions.length, 0);
});

test('BOQ lines in square feet, feet, cubic feet…: the metric take-off is converted', () => {
  near(unitFactor('sq.ft', 'area'), 10.7639104, 1e-6);
  near(unitFactor('SFT', 'area'), 10.7639104, 1e-6);
  near(unitFactor('ft', 'len'), 3.2808399, 1e-6);
  near(unitFactor('cft', 'vol'), 35.3146667, 1e-6);
  assert.equal(unitFactor('m2', 'area'), 1);
  assert.equal(measureForUnit('sq.ft'), 'area');
  assert.equal(measureForUnit('Rft'), 'len');
  assert.equal(measureForUnit('cu.yd'), 'vol');
  const st = storeOf([['pg:dwg:d1.0', 'sc', S100], ['ti:f', 'kind', 'area'], ['ti:f', 'name', 'Floor tiles'], ...shapeEnt('sh:1', 'ti:f', 'poly', sq(10, 10, 10)),
    ['b:F1', 'bt', 'item'], ['b:F1', 'desc', 'Floor tiles'], ['b:F1', 'unit', 'sq.ft'], ['lk:1', 'ti', 'ti:f'], ['lk:1', 'to', 'b:F1'], ['lk:1', 'q', 'area']]);
  const m = buildQtoModel(st, null);
  near(m.boqQty.get('F1')!.total, m.qty.get('ti:f')!.area / 0.09290304, 1e-6);
  near(m.boqQty.get('F1')!.total, 1076.39, 0.1);
});

test('the export lists the BOQ in its own order, not the order lines were added', () => {
  const st = storeOf([['pg:dwg:d.0', 'sc', S100], ['ti:a', 'kind', 'area'], ['ti:a', 'name', 'Tiles'], ...shapeEnt('sh:1', 'ti:a', 'poly', [0, 0, 100, 0, 100, 100, 0, 100], [], 'dwg:d'),
    ['b:G', 'bt', 'group'], ['b:G', 'ref', 'Bill 5'], ['b:G', 'desc', 'Finishes'], ['b:G', 'ord', 'a0'],
    ['b:L1', 'bt', 'item'], ['b:L1', 'par', 'G'], ['b:L1', 'ref', '5.01'], ['b:L1', 'desc', 'Floor tiles'], ['b:L1', 'unit', 'm2'], ['b:L1', 'ord', 'a0'],
    ['b:L3', 'bt', 'item'], ['b:L3', 'par', 'G'], ['b:L3', 'ref', '5.03'], ['b:L3', 'desc', 'Wall tiles'], ['b:L3', 'unit', 'm2'], ['b:L3', 'ord', 'a2'],
    ['lk:1', 'ti', 'ti:a'], ['lk:1', 'to', 'b:L1'], ['lk:1', 'q', 'area'], ['lk:3', 'ti', 'ti:a'], ['lk:3', 'to', 'b:L3'], ['lk:3', 'q', 'area']]);
  apply(st, [['b:L2', 'bt', 'item'], ['b:L2', 'par', 'G'], ['b:L2', 'ref', '5.02'], ['b:L2', 'desc', 'Skirting tiles'], ['b:L2', 'unit', 'm2'], ['b:L2', 'ord', 'a1'],
    ['lk:2', 'ti', 'ti:a'], ['lk:2', 'to', 'b:L2'], ['lk:2', 'q', 'area']]);
  const m = buildQtoModel(st, null);
  assert.deepEqual(flattenMirror(m).filter((r) => r.bt === 'item').map((r) => r.ref), ['5.01', '5.02', '5.03']);
  const x = strFromU8(unzipSync(exportQto(m, { project: 'p', by: 'x', when: new Date(0) }))['xl/worksheets/sheet3.xml']);
  const refs = [...x.matchAll(/<t xml:space="preserve">(5\.0\d)<\/t>/g)].map((r) => r[1]);
  assert.deepEqual(refs, ['5.01', '5.02', '5.03']);
});

test('two people bringing in the same drawing file get one sheet; a removed sheet\'s id is not taken again', () => {
  const row = (path: string): ImportRow => ({ file: { path, size: 1000, mtime: 5 } as any, name: path.split('/').pop()!, sheet: 'AR-11030', title: 'GA L01', disc: 'Architectural', rev: 'A', grp: '', action: 'new', target: null, why: '' });
  const unc = () => '';
  const a = newSheetOps(row('S:/Proj/Drawings/AR-11030.pdf'), { user: 'Omar', issue: 'IFC', unc });
  const b = newSheetOps(row('s:\\proj\\drawings\\AR-11030.pdf'), { user: 'Sara', issue: 'IFC', unc });
  assert.equal(a.id, b.id);
  const st = storeOf(a.ops, b.ops);
  assert.equal(buildQtoModel(st, null).drawings.length, 1);
  apply(st, [[a.id, 'del', true]]);
  const c = newSheetOps(row('S:/Proj/Drawings/AR-11030.pdf'), { user: 'Omar', issue: 'IFC', unc, taken: (id) => st.ents.has(id) });
  assert.notEqual(c.id, a.id);
});

test('split or join while someone else deletes the same length: the delete is not undone by the parts', () => {
  const head: Op[] = [['pg:dwg:d1.0', 'sc', S100], ['ti:w', 'kind', 'line'], ['ti:w', 'name', 'Blockwork'],
    ...shapeEnt('sh:w', 'ti:w', 'line', [0, 0, 4 * M, 0, 4 * M, 6 * M]), ...shapeEnt('sh:x', 'ti:w', 'line', [4 * M, 6 * M, 4 * M, 9 * M])];
  const len = (st: Store) => buildQtoModel(st, null).qty.get('ti:w')!.len;
  const base = mk(head, 'pc0');
  const m0 = buildQtoModel((() => { const s = new Store(); s.apply(base); return s; })(), null);
  const wall = m0.shapes.find((s) => s.id === 'sh:w')!, stub = m0.shapes.find((s) => s.id === 'sh:x')!;
  // Omar splits the wall; Nabil deletes it at the same time - later stamp wins the delete: gone
  const split = mk(splitLineOps(wall, 1, 'omar')!.ops, 'omar');
  const del = mk([['sh:w', 'del', true]], 'nabil');
  for (const order of [[base, split, del], [base, del, split]]) {
    const st = new Store(); for (const b of order) st.apply(b);
    near(len(st), 3); // only the stub: the wall stays deleted, on every PC
  }
  // the original brought back after a split (from an old copy, a restore): never both
  const st2 = new Store(); for (const b of [base, split, mk([['sh:w', 'del', null]], 'nabil')]) st2.apply(b);
  near(len(st2), 13);
  // Omar joins wall + stub while Nabil deletes the stub: the wall comes back on its own (not lost)
  const join = mk(joinLinesOps(wall, stub, 1, undefined, 'omar')!, 'omar');
  const del2 = mk([['sh:x', 'del', true]], 'nabil');
  const st3 = new Store(); for (const b of [base, join, del2]) st3.apply(b);
  near(len(st3), 10);
  assert.deepEqual(buildQtoModel(st3, null).shapes.map((s) => s.id), ['sh:w']);
  // nobody else involved: split, join as usual
  const st4 = new Store(); for (const b of [base, join]) st4.apply(b);
  near(len(st4), 13);
  assert.equal(buildQtoModel(st4, null).shapes.length, 1);
});

test('split, undo, redo: the parts are back after the redo', async () => {
  const { dir } = await createProject(nodefs, tmp(), 'Split redo', 'QS1', 'PC1', [['pg:dwg:d.0', 'sc', S100],
    ['ti:sk', 'kind', 'line'], ['ti:sk', 'name', 'Skirting'], ...shapeEnt('sh:s', 'ti:sk', 'line', [0, 0, 4 * M, 0, 4 * M, 6 * M], [], 'dwg:d')], undefined, 'takeoff');
  const a = new ProjectSession({ fs: nodefs, localFs: nodefs, projectDir: dir, localDir: tmp(), user: 'QS1', host: 'PC-1', pollMs: 60000, fullScanMs: 0, heartbeatMs: 60000 });
  await a.open();
  const m = () => buildQtoModel(a.store, null);
  const r = splitLineOps(m().shapes[0], 1, 'QS1')!;
  a.commit(r.ops, 'Split');
  assert.equal(m().shapes.length, 2); near(m().qty.get('ti:sk')!.len, 10);
  a.undo();
  assert.deepEqual(m().shapes.map((s) => s.id), ['sh:s']); near(m().qty.get('ti:sk')!.len, 10);
  a.redo();
  assert.equal(m().shapes.length, 2); near(m().qty.get('ti:sk')!.len, 10);
  await a.close();
});

test('two people adding openings to the same wall at once: both are deducted', () => {
  const head = mk([['pg:dwg:d1.0', 'sc', S100], ['ti:w', 'kind', 'line'], ['ti:w', 'name', 'Blockwork'], ['ti:w', 'h', 3],
    ...shapeEnt('sh:w', 'ti:w', 'line', [0, 0, 10 * M, 0]),
    ['ti:d', 'kind', 'count'], ['ti:d', 'name', 'Door D1'], ['ti:d', 'ow', 1], ['ti:d', 'oh', 2], ...shapeEnt('sh:d', 'ti:d', 'pt', [1, 1]),
    ['ti:v', 'kind', 'count'], ['ti:v', 'name', 'Window W1'], ['ti:v', 'ow', 1.5], ['ti:v', 'oh', 2], ...shapeEnt('sh:v', 'ti:v', 'pt', [2, 2])], 'pc0');
  // what each one's screen writes (Panels): the list plus that opening's own field
  const a = mk([['ti:w', 'ded', J(['ti:d'])], ['ti:w', 'dd:ti:d', true]], 'nabil');
  const b = mk([['ti:w', 'ded', J(['ti:v'])], ['ti:w', 'dd:ti:v', true]], 'omar');
  for (const order of [[head, a, b], [head, b, a]]) {
    const st = new Store(); for (const x of order) st.apply(x);
    const m = buildQtoModel(st, null);
    assert.deepEqual([...m.itemById.get('ti:w')!.ded].sort(), ['ti:d', 'ti:v']);
    near(m.qty.get('ti:w')!.area, 30 - 2 - 3);
  }
  // one taken off again: gone, the other stays
  const st = new Store(); for (const x of [head, a, b, mk([['ti:w', 'ded', J(['ti:v'])], ['ti:w', 'dd:ti:d', false]], 'nabil')]) st.apply(x);
  assert.deepEqual(buildQtoModel(st, null).itemById.get('ti:w')!.ded, ['ti:v']);
});

test('sheet numbers with a building or zone code in front: B1 and B2 are two sheets, never revisions of each other', () => {
  const f = (p: string, i = 0) => ({ path: p, rel: p.split('\\').pop()!, size: 1, mtime: i });
  const rows = planImport([f('S:\\P04\\P04-B1-AR-1001-Ground Floor Plan.pdf'), f('S:\\P04\\P04-B2-AR-1001-Ground Floor Plan.pdf')], { drawings: [], revisions: new Map() } as any);
  assert.deepEqual(rows.map((r) => [r.sheet, r.action]), [['B1-AR-1001', 'new'], ['B2-AR-1001', 'new']]);
  const m = { drawings: [{ id: 'dwg:b1', path: 'S:\\B1\\P04-B1-AR-1001-Ground Floor Plan.pdf', name: 'P04-B1-AR-1001-Ground Floor Plan.pdf', sheet: 'AR-1001', unc: '' }], revisions: new Map() } as any;
  const later = planImport([f('S:\\B2\\P04-B2-AR-1001-Ground Floor Plan.pdf', 9), f('S:\\B1b\\P04-B1-AR-1001-Ground Floor Plan_Rev B.pdf', 9)], m);
  assert.equal(later[0].action, 'new');
  assert.deepEqual([later[1].action, later[1].target], ['rev', 'dwg:b1']);
  // the usual case is unchanged: same codes in front, a new revision
  const pm = { drawings: [{ id: 'dwg:a', path: 'S:\\P\\P101-ABC-DWG-AR-11030-GA L01.pdf', name: 'P101-ABC-DWG-AR-11030-GA L01.pdf', sheet: 'AR-11030', unc: '' }], revisions: new Map() } as any;
  assert.deepEqual(planImport([f('S:\\Q\\P101-ABC-DWG-AR-11030-GA L01_Rev C.pdf')], pm).map((r) => [r.action, r.target]), [['rev', 'dwg:a']]);
});

test('the same folder picked by drive letter and then by its network path: already in the project', () => {
  const m = { drawings: [{ id: 'dwg:a', path: 'S:\\TND01\\PTA01\\AR-11030 GA.pdf', name: 'AR-11030 GA.pdf', sheet: 'AR-11030', unc: '\\\\srv\\docs\\TND01\\PTA01\\AR-11030 GA.pdf' }], revisions: new Map() } as any;
  const rows = planImport([{ path: '\\\\SRV\\docs\\TND01\\PTA01\\AR-11030 GA.pdf', rel: '', size: 1, mtime: 1 }], m);
  assert.equal(rows[0].action, 'skip');
  // and the other way round (brought in by network path, picked again as S:)
  const m2 = { drawings: [{ id: 'dwg:a', path: '\\\\srv\\docs\\TND01\\PTA01\\AR-11030 GA.pdf', name: 'AR-11030 GA.pdf', sheet: 'AR-11030', unc: '\\\\srv\\docs\\TND01\\PTA01\\AR-11030 GA.pdf' }], revisions: new Map() } as any;
  const rows2 = planImport([{ path: 'S:\\TND01\\PTA01\\AR-11030 GA.pdf', rel: '', size: 1, mtime: 1 }], m2, (p) => p.replace(/^S:/i, '\\\\srv\\docs'));
  assert.equal(rows2[0].action, 'skip');
});

test('a new revision with fewer pages: the shapes left over are listed, not counted, and can be moved onto a page to check', () => {
  const st = storeOf([['pg:dwg:d.0', 'sc', S100], ['dwg:d', 'name', 'A.pdf'], ['dwg:d', 'path', 'S:\\A.pdf'], ['dwg:d', 'hash', 'h2'], ['dwg:d', 'pages', 1],
    ['ti:c', 'kind', 'count'], ['ti:c', 'name', 'Doors'],
    ...shapeEnt('sh:1', 'ti:c', 'pt', [10, 10], [['sh:1', 'rv', 'h1']], 'dwg:d', 2), ...shapeEnt('sh:2', 'ti:c', 'pt', [20, 10], [['sh:2', 'rv', 'h1']], 'dwg:d', 2),
    ...shapeEnt('sh:3', 'ti:c', 'pt', [30, 10], [['sh:3', 'rv', 'h2']], 'dwg:d', 0)]);
  let m = buildQtoModel(st, null);
  assert.equal(m.qty.get('ti:c')!.cnt, 1);
  assert.equal(m.offPage.get('dwg:d'), 2);
  assert.deepEqual(m.offPageShapes.get('dwg:d')!.map((s) => s.id).sort(), ['sh:1', 'sh:2']);
  const x = strFromU8(unzipSync(exportQto(m, { project: 'p', by: 'x', when: new Date(0) }))['xl/worksheets/sheet1.xml']);
  assert.match(x, /2 shape\(s\) on pages the new revision no longer has/);
  apply(st, moveOffPageOps(m.offPageShapes.get('dwg:d')!, 0));
  m = buildQtoModel(st, null);
  assert.equal(m.qty.get('ti:c')!.cnt, 3);
  assert.equal(m.offPage.get('dwg:d') ?? 0, 0);
  assert.equal(m.stale.size, 2, 'the moved ones are to check');
  assert.deepEqual(m.shapes.filter((s) => s.opg !== undefined).map((s) => s.opg), [2, 2]);
});
