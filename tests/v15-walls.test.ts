// v0.15: walls (doors and openings placed on them, lintels), beams (types, formwork, steel), segment
// tags kept through every geometry edit, duplicating a take-off, the door schedule, data format 3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/engine/store';
import { buildQtoModel, measuresFor, needsFormat3, nearestSeg, segLensAt } from '../src/engine/qto/model';
import { scaleFromRatio } from '../src/engine/qto/geometry';
import {
  insertVertexOps, deleteVertexOps, splitLineOps, splitLineAtOps, explodeLineOps, joinLinesOps, setSegTagsOps, replacePointsOps,
  openingOps, reassignOpeningsOps, newShapesIn, duplicateItemOps, doorRowsOps, copyShapesOps, moveShapesOps, beamTypeOps,
  planDoorImport, applyDoorPlanOps, deleteDoorOps, renameDoorOps,
} from '../src/engine/qto/ops';
import { unitFactor, unitMismatch, measureForUnit } from '../src/engine/qto/units';
import { exportQto } from '../src/engine/qto/export';
import { unzipSync, strFromU8 } from 'fflate';
import type { Op } from '../src/engine/types';

let stamp = 0;
function storeWith(ops: Op[], who = 'nabil'): Store {
  const s = new Store();
  s.apply({ s: String(++stamp).padStart(10, '0') + '~t', w: 't', u: who, t: 0, o: ops, a: who });
  return s;
}
function add(s: Store, ops: Op[], who = 'nabil') {
  s.apply({ s: String(++stamp).padStart(10, '0') + '~t', w: 't', u: who, t: 0, o: ops, a: who });
}
const J = (v: unknown) => JSON.stringify(v);
const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const S100 = scaleFromRatio(100);
/** sheet points for `m` metres at 1:100 */
const P = (m: number) => m / S100;

/** a wall 10 m + 6 m (an L), 3 m high, 0.2 m thick */
function wallStore() {
  return storeWith([
    ['pg:d1.0', 'sc', S100],
    ['ti:w', 'kind', 'wall'], ['ti:w', 'name', 'Blockwork 200'], ['ti:w', 'ord', 'a0'], ['ti:w', 'h', 3], ['ti:w', 'd', 0.2],
    ['sh:w1', 'ti', 'ti:w'], ['sh:w1', 'dwg', 'd1'], ['sh:w1', 'pg', 0], ['sh:w1', 'k', 'line'], ['sh:w1', 'p', J([100, 100, 100 + P(10), 100, 100 + P(10), 100 + P(6)])],
    ['ds:a', 'tag', 'D01'], ['ds:a', 'sw', 1.0], ['ds:a', 'sh', 2.2], ['ds:a', 'cw', 0.9], ['ds:a', 'ch', 2.1], ['ds:a', 'ord', 'a0'],
    ['ds:b', 'tag', 'D02'], ['ds:b', 'cw', 0.8], ['ds:b', 'ch', 2.1], ['ds:b', 'ord', 'a1'],
  ]);
}

test('wall: length x height, a door from the schedule deducted at its structural size, its lintel counted', () => {
  const s = wallStore();
  let m = buildQtoModel(s, null);
  close(m.qty.get('ti:w')!.area, 16 * 3);
  close(m.qty.get('ti:w')!.vol, 16 * 3 * 0.2);
  // a door D01 on the first segment, an opening 1.2 x 1.0 (no lintel) on the second, a door D02 (clear size only)
  add(s, openingOps({ sh: 'sh:w1', x: 100 + P(4), y: 100.4, k: 'door', door: 'ds:a', tag: '', w: null, h: null, lint: true }).ops);
  add(s, openingOps({ sh: 'sh:w1', x: 100 + P(10) + 0.3, y: 100 + P(3), k: 'open', door: null, tag: 'duct', w: 1.2, h: 1.0, lint: false }).ops);
  add(s, openingOps({ sh: 'sh:w1', x: 100 + P(7), y: 100, k: 'door', door: 'ds:b', tag: '', w: null, h: null, lint: true }).ops);
  m = buildQtoModel(s, null);
  const q = m.qty.get('ti:w')!;
  const ded = 1.0 * 2.2 + 1.2 * 1.0 + 0.8 * 2.1;
  close(q.dedArea, ded);
  close(q.area, 48 - ded);
  close(q.vol, (48 - ded) * 0.2);
  assert.equal(q.doors, 2);
  assert.equal(q.opens, 1);
  // lintels: (W + 0.20 each side) x wall thickness 0.20 x depth 0.20; none over the duct
  assert.equal(q.lcnt, 2);
  close(q.llen, (1.0 + 0.4) + (0.8 + 0.4));
  close(q.lvol, ((1.0 + 0.4) + (0.8 + 0.4)) * 0.2 * 0.2);
  // the openings sit on the right segments
  const ops = m.openingsByShape.get('sh:w1')!;
  assert.deepEqual(ops.map((o) => o.seg).sort(), [0, 0, 1]);
  // doors counted per schedule row
  assert.equal(m.doorCount.get('ds:a'), 1);
  assert.equal(m.doorCount.get('ds:b'), 1);
  assert.deepEqual(measuresFor(m.itemById.get('ti:w')!), ['area', 'len', 'vol', 'lvol', 'llen', 'lcnt', 'cnt']);
});

test('wall: lintel settings, breadth = the wall thickness (else its own), small openings left in, repeats', () => {
  const s = wallStore();
  add(s, [['ti:w', 'd', null], ['ti:w', 'lb', 0.15], ['ti:w', 'ld', 0.25], ['ti:w', 'lw', 0.1], ['ti:w', 'dmin', 1]]);
  add(s, openingOps({ sh: 'sh:w1', x: 100 + P(4), y: 100, k: 'door', door: 'ds:a', tag: '', w: null, h: null, lint: true }).ops);
  add(s, openingOps({ sh: 'sh:w1', x: 100 + P(5), y: 100, k: 'open', door: null, tag: '', w: 0.9, h: 0.9, lint: true }).ops);
  add(s, [['sh:w1', 'm', 3]]);
  const q = buildQtoModel(s, null).qty.get('ti:w')!;
  close(q.dedArea, 2.2 * 3); // the 0.81 m² opening is left in (up to 1 m²)
  assert.equal(q.keptOpenings, 3);
  close(q.area, 48 * 3 - 2.2 * 3);
  // lintels: breadth 0.10 (no wall thickness), depth 0.25, bearing 0.15 each side - over both (×3 floors)
  close(q.llen, ((1.0 + 0.3) + (0.9 + 0.3)) * 3);
  close(q.lvol, ((1.0 + 0.3) + (0.9 + 0.3)) * 0.1 * 0.25 * 3);
  // with a thickness set, it is the lintel breadth
  add(s, [['ti:w', 'd', 0.25]]);
  close(buildQtoModel(s, null).qty.get('ti:w')!.lvol, ((1.0 + 0.3) + (0.9 + 0.3)) * 0.25 * 0.25 * 3);
});

test('door links take the number of doors placed (private walls left out); a removed schedule row stops counting', () => {
  const s = wallStore();
  add(s, openingOps({ sh: 'sh:w1', x: 100 + P(4), y: 100, k: 'door', door: 'ds:a', tag: '', w: null, h: null, lint: true }).ops);
  add(s, openingOps({ sh: 'sh:w1', x: 100 + P(6), y: 100, k: 'door', door: 'ds:a', tag: '', w: null, h: null, lint: true }).ops);
  add(s, [['b:door', 'bt', 'item'], ['b:door', 'desc', 'Door D01'], ['b:door', 'unit', 'nr'], ['lk:1', 'ti', 'ds:a'], ['lk:1', 'to', 'b:door'], ['lk:1', 'q', 'cnt']]);
  let m = buildQtoModel(s, null);
  close(m.boqQty.get('door')!.total, 2);
  assert.equal(m.boqQty.get('door')!.parts[0].item.name, 'Door D01');
  add(s, [['ti:w', 'priv', true]]);
  m = buildQtoModel(s, null);
  assert.equal(m.boqQty.get('door')?.total ?? 0, 0);
  add(s, [['ti:w', 'priv', null], ['ds:a', 'del', true]]);
  m = buildQtoModel(s, null);
  assert.equal(m.boqQty.get('door'), undefined);
  assert.equal(m.links.length, 0);
});

test('beam: segments tagged with beam types - concrete, formwork, steel per type; slab taken off the depth', () => {
  const s = storeWith([
    ['pg:d1.0', 'sc', S100],
    ...beamTypeOps({ name: 'B1', w: 0.3, d: 0.6, r: 120, color: '#123456' }, 'bt:b1').ops,
    ...beamTypeOps({ name: 'B2', w: 0.25, d: 0.5, r: 100, color: '#654321' }, 'bt:b2').ops,
    ['ti:b', 'kind', 'beam'], ['ti:b', 'name', 'Beams L1'], ['ti:b', 'bt', 'bt:b2'], ['ti:b', 'st', 0.2],
    // 5 m (B1), 4 m (untagged: the default B2), 3 m (B1)
    ['sh:b1', 'ti', 'ti:b'], ['sh:b1', 'dwg', 'd1'], ['sh:b1', 'pg', 0], ['sh:b1', 'k', 'line'],
    ['sh:b1', 'p', J([0, 0, P(5), 0, P(5), P(4), P(8), P(4)])], ['sh:b1', 'sg', J(['bt:b1', null, 'bt:b1'])],
  ]);
  const m = buildQtoModel(s, null);
  const q = m.qty.get('ti:b')!;
  close(q.len, 12);
  const v1 = 8 * 0.3 * 0.4, v2 = 4 * 0.25 * 0.3;
  close(q.vol, v1 + v2);
  close(q.form, 8 * (0.3 + 0.8) + 4 * (0.25 + 0.6));
  close(q.kg, v1 * 120 + v2 * 100);
  close(q.byTag.get('bt:b1')!.len, 8);
  close(q.byTag.get('bt:b2')!.vol, v2);
  assert.equal(q.untyped, 0);
  assert.deepEqual(measuresFor(m.itemById.get('ti:b')!), ['vol', 'len', 'form', 'kg', 'cnt']);
  // without a default type the untagged 4 m has no size: it is reported, not guessed
  add(s, [['ti:b', 'bt', null]]);
  const q2 = buildQtoModel(s, null).qty.get('ti:b')!;
  close(q2.untyped, 4);
  close(q2.vol, v1);
});

test('segment lengths at their own scale; nearest segment', () => {
  const s = storeWith([
    ['pg:d1.0', 'sc', S100],
    ['sr:v', 'dwg', 'd1'], ['sr:v', 'pg', 0], ['sr:v', 'r', J([500, 0, 900, 400])], ['sr:v', 'sc', scaleFromRatio(20)],
    ['ti:l', 'kind', 'line'], ['ti:l', 'name', 'Kerb'],
    ['sh:l', 'ti', 'ti:l'], ['sh:l', 'dwg', 'd1'], ['sh:l', 'pg', 0], ['sh:l', 'k', 'line'], ['sh:l', 'p', J([100, 100, 400, 100, 600, 100])],
  ]);
  const m = buildQtoModel(s, null);
  const sl = segLensAt(m, m.shapes[0]);
  close(sl.lens[0]!, 300 * S100);
  close(sl.lens[1]!, 100 * S100 + 100 * scaleFromRatio(20));
  assert.equal(sl.mixed, true);
  close(m.qty.get('ti:l')!.len, sl.lens[0]! + sl.lens[1]!);
  assert.equal(nearestSeg(m.shapes[0], [500, 120]).seg, 1);
});

test('segment tags follow every edit: corners added / removed, split, split into segments, join (reversed), continued', () => {
  const s = storeWith([
    ['pg:d1.0', 'sc', S100],
    ['ti:l', 'kind', 'line'], ['ti:l', 'name', 'Beam run'],
    ['sh:l', 'ti', 'ti:l'], ['sh:l', 'dwg', 'd1'], ['sh:l', 'pg', 0], ['sh:l', 'k', 'line'], ['sh:l', 'p', J([0, 0, 100, 0, 100, 100, 200, 100])],
  ]);
  let m = buildQtoModel(s, null);
  add(s, setSegTagsOps(m.shapes[0], [0, 2], 'B1'));
  m = buildQtoModel(s, null);
  assert.deepEqual(m.shapes[0].sg, ['B1', null, 'B1']);
  // a corner in the middle of segment 0: both halves B1
  add(s, insertVertexOps(m.shapes[0], 0, 0, [50, 0]));
  m = buildQtoModel(s, null);
  assert.deepEqual(m.shapes[0].sg, ['B1', 'B1', null, 'B1']);
  // the corner at index 2 (100,0) removed: segments 1 and 2 become one (keeps segment 1's tag)
  add(s, deleteVertexOps(m.shapes[0], 0, 2));
  m = buildQtoModel(s, null);
  assert.deepEqual(m.shapes[0].sg, ['B1', 'B1', 'B1']);
  add(s, setSegTagsOps(m.shapes[0], [1], 'B2'));
  m = buildQtoModel(s, null);
  assert.deepEqual(m.shapes[0].sg, ['B1', 'B2', 'B1']);
  // split at corner 2
  const sp = splitLineOps(m.shapes[0], 2, 'nabil')!;
  add(s, sp.ops);
  m = buildQtoModel(s, null);
  const parts = sp.ids.map((id) => m.shapes.find((x) => x.id === id)!);
  assert.deepEqual(parts[0].sg, ['B1', 'B2']);
  assert.deepEqual(parts[1].sg, ['B1']);
  // join them back, the second reversed first
  const rev = { ...parts[1], pts: [...parts[1].pts].reverse() };
  add(s, [[parts[1].id, 'p', J(rev.pts.flat())]]);
  m = buildQtoModel(s, null);
  const a = m.shapes.find((x) => x.id === parts[0].id)!, c = m.shapes.find((x) => x.id === parts[1].id)!;
  const jo = joinLinesOps(a, c, 1, () => false, 'nabil')!;
  add(s, jo);
  m = buildQtoModel(s, null);
  assert.equal(m.shapes.length, 1);
  assert.deepEqual(m.shapes[0].sg, ['B1', 'B2', 'B1']);
  // split at a point in segment 1: both pieces of it keep B2
  const sa = splitLineAtOps(m.shapes[0], 1, [100, 50], 'nabil')!;
  add(s, sa.ops);
  m = buildQtoModel(s, null);
  assert.deepEqual(sa.ids.map((id) => m.shapes.find((x) => x.id === id)!.sg), [['B1', 'B2'], ['B2', 'B1']]);
  // into separate segments
  const ex = explodeLineOps(m.shapes.find((x) => x.id === sa.ids[0])!, 'nabil');
  add(s, ex.ops);
  m = buildQtoModel(s, null);
  assert.deepEqual(ex.ids.map((id) => m.shapes.find((x) => x.id === id)!.sg), [['B1'], ['B2']]);
  // continued: the old segments keep their tags, the new one has none
  const last = m.shapes.find((x) => x.id === sa.ids[1])!;
  add(s, replacePointsOps(last, [...last.pts, [300, 100]]));
  m = buildQtoModel(s, null);
  assert.deepEqual(m.shapes.find((x) => x.id === sa.ids[1])!.sg, ['B2', 'B1', null]);
  assert.ok(needsFormat3(setSegTagsOps(m.shapes[0], [0], 'X') as [string, string, unknown][]));
});

test('openings go with their wall: moved, copied, and onto the right part of a split', () => {
  const s = wallStore();
  add(s, openingOps({ sh: 'sh:w1', x: 100 + P(2), y: 100, k: 'door', door: 'ds:a', tag: '', w: null, h: null, lint: true }).ops);
  add(s, openingOps({ sh: 'sh:w1', x: 100 + P(10), y: 100 + P(3), k: 'open', door: null, tag: '', w: 1, h: 1, lint: true }).ops);
  let m = buildQtoModel(s, null);
  add(s, moveShapesOps([m.shapes[0]], 10, 20, m.openingsByShape));
  m = buildQtoModel(s, null);
  close(m.openings.find((o) => o.k === 'door')!.x, 100 + P(2) + 10, 0.01);
  // copied to another sheet: the copy has its doors too
  const c = copyShapesOps([m.shapes[0]], { dwg: 'd2', pg: 0 }, 'nabil', 0, 0, undefined, m.openingsByShape);
  add(s, [...c.ops, ['pg:d2.0', 'sc', S100]]);
  m = buildQtoModel(s, null);
  assert.equal(m.openingsByShape.get(c.ids[0])!.length, 2);
  assert.equal(m.doorCount.get('ds:a'), 2);
  // split at the corner: the door goes onto the first part, the opening onto the second
  const w = m.shapes.find((x) => x.id === 'sh:w1')!;
  const sp = splitLineOps(w, 1, 'nabil')!;
  add(s, [...sp.ops, ...reassignOpeningsOps(m.openingsByShape, ['sh:w1'], newShapesIn(sp.ops))]);
  m = buildQtoModel(s, null);
  assert.equal(m.openingsByShape.get(sp.ids[0])?.length, 1);
  assert.equal(m.openingsByShape.get(sp.ids[1])?.length, 1);
  close(m.qty.get('ti:w')!.dedArea, (2.2 + 1) * 2);
});
test('duplicate a take-off: settings, links to the same BOQ lines (and optionally the shapes)', () => {
  const s = wallStore();
  add(s, [['ti:w', 'waste', 5], ['ti:w', 'lb', 0.15], ['lk:1', 'ti', 'ti:w'], ['lk:1', 'to', 'b:x'], ['lk:1', 'q', 'area'], ['lk:2', 'ti', 'ti:w'], ['lk:2', 'to', 'b:y'], ['lk:2', 'q', 'lvol'], ['lk:2', 'f', 2]]);
  add(s, openingOps({ sh: 'sh:w1', x: 100 + P(2), y: 100, k: 'door', door: 'ds:a', tag: '', w: null, h: null, lint: true }).ops);
  let m = buildQtoModel(s, null);
  const d1 = duplicateItemOps(m, 'ti:w', 'nabil', { links: true, shapes: false })!;
  add(s, d1.ops);
  m = buildQtoModel(s, null);
  const it = m.itemById.get(d1.id)!;
  assert.equal(it.name, 'Blockwork 200 (copy)');
  assert.equal(it.kind, 'wall');
  assert.equal(it.h, 3); assert.equal(it.d, 0.2); assert.equal(it.waste, 5); assert.equal(it.lb, 0.15);
  assert.deepEqual(m.linksByItem.get(d1.id)!.map((l) => [l.to, l.q, l.f]).sort(), [['b:x', 'area', 1], ['b:y', 'lvol', 2]]);
  assert.equal(m.shapesByItem.get(d1.id), undefined);
  // right after the original
  assert.equal(m.items[m.items.findIndex((x) => x.id === 'ti:w') + 1].id, d1.id);
  const d2 = duplicateItemOps(m, 'ti:w', 'nabil', { links: false, shapes: true })!;
  add(s, d2.ops);
  m = buildQtoModel(s, null);
  assert.equal(m.linksByItem.get(d2.id), undefined);
  assert.equal(m.shapesByItem.get(d2.id)!.length, 1);
  // (the copy's corners are written rounded to 0.001 pt, as every shape drawn in the app)
  close(m.qty.get(d2.id)!.area, m.qty.get('ti:w')!.area, 1e-3);
  assert.equal(m.doorCount.get('ds:a'), 2);
});

test('door schedule rows: a tag already there is updated, new ones added in order', () => {
  const s = wallStore();
  let m = buildQtoModel(s, null);
  const r = doorRowsOps(m, [{ tag: 'D01', desc: 'Flush door', sw: 1.05, sh: 2.25 }, { tag: 'D03', loc: 'Corridor', cw: 1.2, ch: 2.4 }, { tag: '  ' }]);
  assert.equal(r.added, 1);
  assert.equal(r.updated, 1);
  add(s, r.ops);
  m = buildQtoModel(s, null);
  assert.deepEqual(m.doors.map((d) => d.tag), ['D01', 'D02', 'D03']);
  assert.equal(m.doors[0].sw, 1.05);
  assert.equal(m.doors[0].desc, 'Flush door');
  assert.equal(m.doors[2].loc, 'Corridor');
  assert.ok(needsFormat3(r.ops as [string, string, unknown][]));
});

test('door schedule: re-import preview by tag, field by field; placed rows never dropped by an import', () => {
  const s = wallStore();
  add(s, openingOps({ sh: 'sh:w1', x: 100 + P(4), y: 100, k: 'door', door: 'ds:a', tag: 'D01', w: null, h: null, lint: true }).ops);
  let m = buildQtoModel(s, null);
  // a row typed in the app
  add(s, doorRowsOps(m, [{ tag: 'DX1', sw: 0.9, sh: 2.1 }]).ops);
  m = buildQtoModel(s, null);
  assert.equal(m.doors.find((d) => d.tag === 'DX1')!.app, true);
  const plan = planDoorImport(m, [
    { tag: 'd01 ', desc: 'Flush', sw: 1.0, sh: 2.3, cw: 0.9, ch: 2.1 }, // case / spaces: same row; sh changed, desc filled
    { tag: 'D04', sw: 1.5, sh: 2.4 },
    { tag: 'D04', sw: 9, sh: 9 },
  ]);
  const byTag = new Map(plan.rows.map((r) => [r.tag, r]));
  assert.equal(byTag.get('D01')!.k, 'changed');
  assert.deepEqual(byTag.get('D01')!.ch.map((c) => c[0]).sort(), ['desc', 'sh']);
  assert.equal(byTag.get('D04')!.k, 'new');
  assert.deepEqual(plan.dupes, ['D04']);
  // D02 (unplaced, imported) and DX1 (unplaced, added in the app) are not in the file
  assert.deepEqual(plan.missing.map((x) => [x.tag, x.placed, x.app]), [['D02', 0, false], ['DX1', 0, true]]);
  // take only the height of D01 (not the description); drop D02
  const r = applyDoorPlanOps(m, plan, new Map<string, Set<'sh' | 'desc'> | true>([['d01', new Set(['sh'] as const)], ['d04', true]]), ['ds:b']);
  assert.deepEqual([r.added, r.updated, r.removed], [1, 1, 1]);
  add(s, r.ops);
  m = buildQtoModel(s, null);
  assert.deepEqual(m.doors.map((d) => d.tag), ['D01', 'DX1', 'D04']);
  assert.equal(m.doors[0].sh, 2.3);
  assert.equal(m.doors[0].desc, '');
  // the door placed with D01 follows the new height
  close(m.qty.get('ti:w')!.doors, 1);
  // a placed row is never removed by an import
  const p2 = planDoorImport(m, [{ tag: 'D04' }]);
  assert.equal(applyDoorPlanOps(m, p2, undefined, ['ds:a']).removed, 0);
});

test('door schedule: deleting a placed row keeps its doors (last size, flagged); the tag coming back revives the row', () => {
  const s = wallStore();
  add(s, openingOps({ sh: 'sh:w1', x: 100 + P(4), y: 100, k: 'door', door: 'ds:a', tag: 'D01', w: null, h: null, lint: true }).ops);
  add(s, [['lk:d', 'ti', 'ds:a'], ['lk:d', 'to', 'b:x'], ['lk:d', 'q', 'cnt'], ['lk:d', 'f', 1]]);
  let m = buildQtoModel(s, null);
  const before = m.qty.get('ti:w')!;
  add(s, deleteDoorOps(m, 'ds:a'));
  m = buildQtoModel(s, null);
  assert.equal(m.doorById.has('ds:a'), false);
  const o = m.openings[0];
  assert.equal(o.uns, true);
  assert.equal(o.door, null);
  const q = m.qty.get('ti:w')!;
  close(q.area, before.area); // still deducted with D01's structural size
  close(q.lvol, before.lvol);
  assert.equal(m.links.some((l) => l.id === 'lk:d'), false);
  // typed again in the door picker: the same row comes back, with its link, and the door is on it
  const r = doorRowsOps(m, [{ tag: 'd01', sw: 1.0, sh: 2.2 }]);
  assert.deepEqual(r.ids, ['ds:a']);
  add(s, r.ops);
  m = buildQtoModel(s, null);
  assert.equal(m.openings[0].door, 'ds:a');
  assert.equal(m.openings[0].uns, false);
  assert.equal(m.links.some((l) => l.id === 'lk:d'), true);
  assert.equal(m.doorCount.get('ds:a'), 1);
  // rename: refused onto another row's tag; the placed doors follow
  assert.equal(renameDoorOps(m, 'ds:a', ' d02 '), null);
  add(s, renameDoorOps(m, 'ds:a', 'D01A')!);
  m = buildQtoModel(s, null);
  assert.equal(m.openings[0].tag, 'D01A');
  assert.equal(m.openings[0].door, 'ds:a');
});

test('units: steel in kg or tonnes; formwork is an area; lintels are volumes / lengths / numbers', () => {
  assert.equal(measureForUnit('kg'), 'kg');
  assert.equal(measureForUnit('Tonne'), 'kg');
  close(unitFactor('t', 'kg'), 0.001);
  assert.equal(unitFactor('kg', 'kg'), 1);
  assert.equal(unitMismatch('m2', 'form'), false);
  assert.equal(unitMismatch('m3', 'lvol'), false);
  assert.equal(unitMismatch('m', 'llen'), false);
  assert.equal(unitMismatch('nr', 'lcnt'), false);
  assert.equal(unitMismatch('m3', 'kg'), true);
  close(unitFactor('ft', 'llen'), 3.280839895013123);
});

test('data format 3 only for what older apps would misread', () => {
  assert.equal(needsFormat3([['ti:a', 'kind', 'line'], ['sh:a', 'p', '[]'], ['lk:a', 'q', 'area']]), false);
  assert.equal(needsFormat3([['ti:a', 'kind', 'wall']]), true);
  assert.equal(needsFormat3([['ti:a', 'kind', 'beam']]), true);
  assert.equal(needsFormat3([['sh:a', 'sg', null]]), false);
  assert.equal(needsFormat3([['lk:a', 'q', 'kg']]), true);
  assert.equal(needsFormat3([['lk:a', 'ti', 'ds:x']]), true);
  assert.equal(needsFormat3([['op:a', 'sh', 'sh:1']]), true);
  assert.equal(needsFormat3([['bt:a', 'name', 'B1']]), true);
});

test('export: segments, totals by tag, doors and openings sheets', () => {
  const s = wallStore();
  add(s, openingOps({ sh: 'sh:w1', x: 100 + P(2), y: 100, k: 'door', door: 'ds:a', tag: '', w: null, h: null, lint: true }).ops);
  add(s, [['sh:w1', 'sg', J(['Ext', null])]]);
  const m = buildQtoModel(s, null);
  const files = unzipSync(exportQto(m, { project: 'T', by: 'me' }));
  const wb = strFromU8(files['xl/workbook.xml']);
  for (const n of ['Segments', 'By tag', 'Doors', 'Openings']) assert.ok(wb.includes(`name="${n}"`), n);
  const all = Object.keys(files).filter((k) => k.startsWith('xl/')).map((k) => strFromU8(files[k])).join('\n');
  assert.ok(all.includes('D01'));
  assert.ok(all.includes('Ext'));
});

test('a wall marks the project format 3: 0.14.0 (format 2) opens it view only, 0.15 works on', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createRequire } = await import('node:module');
  const { ProjectSession } = await import('../src/engine/session');
  const { createProject } = await import('../src/engine/projects');
  const { DATA_FORMAT, BASE_FORMAT, FORMAT_WALLS } = await import('../src/engine/version');
  const nodefs = createRequire(import.meta.url)('../electron/nodefs.cjs');
  const tmp = () => mkdtempSync(join(tmpdir(), 'gtwall-'));
  const open = async (dir: string, user: string, appVersion: string, dataFormat: number, markFormat?: number) => {
    const s = new ProjectSession({ fs: nodefs, localFs: nodefs, projectDir: dir, localDir: tmp(), user, account: user.toLowerCase(), host: 'PC-' + user, pollMs: 60000, fullScanMs: 0, heartbeatMs: 60000, appVersion, dataFormat, markFormat });
    await s.open();
    return s;
  };
  assert.equal(DATA_FORMAT, 14); // v0.22.0 selling rules; v0.21.0 % of tender lines; v0.20.0 composite resources, packages; v0.19.0 build-up variables, groups, off lines, templates; v0.18.1 substructure, stair types, own figures per segment; v0.18.0 rooms by their ceilings, structure round 2; v0.17.0 structural; v0.16.5: an additional wall as an area; v0.16.4: soffit / bulkheads / upturns (v0.16.0's 4: rooms; format 3 stays what walls mark)
  const { dir } = await createProject(nodefs, tmp(), 'Walls', 'Omar', 'PC1', []);
  // a plain length: still readable by 0.14.0
  const a = await open(dir, 'Omar', '0.15.0', DATA_FORMAT, BASE_FORMAT);
  const plain: Op[] = [['ti:l', 'kind', 'line'], ['ti:l', 'name', 'Skirting']];
  if (needsFormat3(plain as [string, string, unknown][])) a.needFormat(FORMAT_WALLS);
  a.commit(plain);
  assert.equal(a.formatSeen().fmt, 1);
  await a.close();
  const old = await open(dir, 'Rami', '0.14.0', 2);
  assert.equal(old.readOnly, false);
  await old.close();
  // a wall with a door: format 3
  const b = await open(dir, 'Omar', '0.15.0', DATA_FORMAT, BASE_FORMAT);
  const wall: Op[] = [['ti:w', 'kind', 'wall'], ['ti:w', 'name', 'Blockwork'], ['ds:a', 'tag', 'D01']];
  assert.ok(needsFormat3(wall as [string, string, unknown][]));
  b.needFormat(FORMAT_WALLS);
  b.commit(wall);
  assert.equal(b.formatSeen().fmt, 3);
  await b.close();
  const old2 = await open(dir, 'Rami', '0.14.0', 2);
  assert.equal(old2.readOnly, true);
  assert.equal(old2.newerApp, '0.15.0');
  await old2.close();
  const c = await open(dir, 'Omar', '0.15.0', DATA_FORMAT, BASE_FORMAT);
  assert.equal(c.readOnly, false);
  await c.close();
});

test('door tags compared without separators: "D-11" in a newer Excel is the schedule\'s D11', async () => {
  const { planDoorImport: plan } = await import('../src/engine/qto/ops');
  const s = wallStore();
  add(s, [['ds:c', 'tag', 'D11'], ['ds:c', 'sw', 1.1], ['ds:c', 'ord', 'a2']]);
  const m = buildQtoModel(s, null);
  const p = plan(m, [{ tag: 'D-11', sw: 1.2 }]);
  assert.equal(p.rows[0].k, 'changed');
  assert.equal(p.rows[0].id, 'ds:c');
  assert.ok(!p.missing.some((x) => x.tag === 'D11'));
});

test('a beam type this PC does not know: the take-off\'s default type', async () => {
  const { beamTypeOf } = await import('../src/engine/qto/model');
  const m = { beamTypeById: new Map([['bt:a', { id: 'bt:a', name: 'B1', w: 0.3, d: 0.6, r: 100, color: '#000' }]]) } as any;
  assert.equal(beamTypeOf(m, { bt: 'bt:a' } as any, 'bt:zz')?.name, 'B1');
  assert.equal(beamTypeOf(m, { bt: '' } as any, 'bt:zz'), null);
});
