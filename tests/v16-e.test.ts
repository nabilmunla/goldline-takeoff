// v0.16 group e, item 27: each person's shapes on a shared take-off.
//  - a shape's owner is who drew it; someone else who changes it becomes a joint owner (co:<username>)
//  - a QS is shown his own shapes (others' to look at, switched on); estimators everyone's or whom they tick
//  - other people's shapes are view only unless "Edit other people's shapes" is on; then a change records
//    joint ownership and says so in the history label
//  - quantities are always everyone's: shown or not, the take-off's total, the BOQ's figure
// run: node --import tsx --test tests/v16-e.test.ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/engine/store';
import { ProjectSession } from '../src/engine/session';
import { createProject } from '../src/engine/projects';
import { buildQtoModel, measureOf, mainMeasure, type QtoModel } from '../src/engine/qto/model';
import { scaleFromRatio } from '../src/engine/qto/geometry';
import { moveShapesOps, splitLineOps, joinLinesOps, openingOps, duplicateItemOps } from '../src/engine/qto/ops';
import { deleteNodesOps } from '../src/engine/qto/listops';
import {
  isMine, jointLabel, mayEdit, ownerOf, ownersOf, ownership, ownerSplit, ownerText, peopleWithShapes, shapesChanged, shownFor, shownPeople,
} from '../src/engine/qto/owners';
import type { FsApi, Op } from '../src/engine/types';

const require = createRequire(import.meta.url);
const nodefs = require('../electron/nodefs.cjs');
const J = JSON.stringify;
const S100 = scaleFromRatio(100);
const P = (m: number) => Math.round((m / S100) * 1000) / 1000;
const R = (v: number) => Math.round(v * 1000) / 1000;
const rect = (x: number, y: number, w: number, h: number) => J([x, y, R(x + P(w)), y, R(x + P(w)), R(y + P(h)), x, R(y + P(h))]);
let seq = 0;
const apply = (st: Store, ops: Op[]) => { seq++; st.apply({ s: String(seq).padStart(10, '0') + '~b', w: 'w', u: 'T', t: seq, o: ops }); return st; };
const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const NAMES: Record<string, string> = { 'sam.carter': 'Sam Carter', 'adam.khan': 'Adam Khan', 'nabil.munla': 'Nabil Munla' };
const nameOf = (u: string) => NAMES[u] ?? u;

/** one sheet at 1:100. "Floor tiles" (Omar's take-off): Omar's 5 × 4 room and Adam's 3 × 2 room; a wall
 *  of Omar's with a door; a length of Adam's; an old shape from before `by` (its take-off's owner's) */
function project(): Op[] {
  return [
    ['dwg:a', 'name', 'A-101.pdf'], ['dwg:a', 'path', 'X:/A-101.pdf'], ['dwg:a', 'pages', 1], ['pg:dwg:a.0', 'sc', S100],
    ['ti:area', 'kind', 'area'], ['ti:area', 'name', 'Floor tiles'], ['ti:area', 'owner', 'sam.carter'], ['ti:area', 'ord', 'a0'],
    ['sh:o1', 'ti', 'ti:area'], ['sh:o1', 'dwg', 'dwg:a'], ['sh:o1', 'pg', 0], ['sh:o1', 'k', 'poly'], ['sh:o1', 'p', rect(100, 100, 5, 4)], ['sh:o1', 'by', 'sam.carter'],
    ['sh:a1', 'ti', 'ti:area'], ['sh:a1', 'dwg', 'dwg:a'], ['sh:a1', 'pg', 0], ['sh:a1', 'k', 'poly'], ['sh:a1', 'p', rect(400, 100, 3, 2)], ['sh:a1', 'by', 'adam.khan'],
    ['ti:wall', 'kind', 'wall'], ['ti:wall', 'name', 'Block 200'], ['ti:wall', 'owner', 'sam.carter'], ['ti:wall', 'ord', 'a1'], ['ti:wall', 'h', 3], ['ti:wall', 'd', 0.2],
    ['sh:w1', 'ti', 'ti:wall'], ['sh:w1', 'dwg', 'dwg:a'], ['sh:w1', 'pg', 0], ['sh:w1', 'k', 'line'], ['sh:w1', 'p', J([100, 500, R(100 + P(10)), 500])], ['sh:w1', 'by', 'sam.carter'],
    ['op:d1', 'sh', 'sh:w1'], ['op:d1', 'x', R(100 + P(5))], ['op:d1', 'y', 500], ['op:d1', 'k', 'open'], ['op:d1', 'w', 1.2], ['op:d1', 'h', 1.5],
    ['ti:len', 'kind', 'line'], ['ti:len', 'name', 'Kerbs'], ['ti:len', 'owner', 'sam.carter'], ['ti:len', 'ord', 'a2'],
    ['sh:l1', 'ti', 'ti:len'], ['sh:l1', 'dwg', 'dwg:a'], ['sh:l1', 'pg', 0], ['sh:l1', 'k', 'line'], ['sh:l1', 'p', J([0, 50, P(2), 50, P(2), R(50 + P(3))])], ['sh:l1', 'by', 'adam.khan'],
    ['sh:l2', 'ti', 'ti:len'], ['sh:l2', 'dwg', 'dwg:a'], ['sh:l2', 'pg', 0], ['sh:l2', 'k', 'line'], ['sh:l2', 'p', J([R(P(2)), R(50 + P(3)), R(P(6)), R(50 + P(3))])], ['sh:l2', 'by', 'sam.carter'],
    // from before `by`: the take-off's owner's
    ['sh:old', 'ti', 'ti:len'], ['sh:old', 'dwg', 'dwg:a'], ['sh:old', 'pg', 0], ['sh:old', 'k', 'line'], ['sh:old', 'p', J([0, 800, P(1), 800])],
    ['b:1', 'bt', 'item'], ['b:1', 'ref', '1.1'], ['b:1', 'desc', 'Tiles'], ['b:1', 'unit', 'm2'], ['b:1', 'ord', 'a0'],
    ['lk:1', 'ti', 'ti:area'], ['lk:1', 'to', 'b:1'], ['lk:1', 'q', 'area'],
  ];
}
const model = (st?: Store) => buildQtoModel(st ?? apply(new Store(), project()), null);
const sh = (m: QtoModel, id: string) => m.shapes.find((s) => s.id === id)!;

test('27: a shape is whose drew it; an old shape (no `by`) is its take-off owner\'s; joint owners come from co:<username> fields', () => {
  const st = apply(new Store(), project());
  apply(st, [['sh:o1', 'co:adam.khan', true], ['sh:o1', 'co:nabil.munla', true], ['sh:o1', 'co:zed', null]]);
  const m = model(st);
  assert.equal(ownerOf(m, sh(m, 'sh:a1')), 'adam.khan');
  assert.equal(ownerOf(m, sh(m, 'sh:old')), 'sam.carter', 'before `by`: the take-off owner\'s');
  assert.deepEqual(sh(m, 'sh:o1').co, ['adam.khan', 'nabil.munla'], 'co fields set to true (cleared ones not)');
  assert.deepEqual(ownersOf(m, sh(m, 'sh:o1')), ['sam.carter', 'adam.khan', 'nabil.munla']);
  assert.equal(isMine(m, sh(m, 'sh:o1'), 'adam.khan'), true, 'a joint owner\'s too');
  assert.equal(isMine(m, sh(m, 'sh:a1'), 'sam.carter'), false);
  assert.equal(mayEdit(m, sh(m, 'sh:a1'), 'sam.carter', false), false, 'someone else\'s: view only');
  assert.equal(mayEdit(m, sh(m, 'sh:a1'), 'nabil.munla', true), true, '...unless switched on');
  assert.equal(ownerText(m, sh(m, 'sh:o1'), nameOf), 'by Sam Carter · also edited by Adam Khan, Nabil Munla');
  assert.equal(ownerText(m, sh(m, 'sh:a1'), nameOf), 'by Adam Khan');
  // the people with shapes: the most first
  assert.deepEqual(peopleWithShapes(m), [{ username: 'sam.carter', n: 4 }, { username: 'adam.khan', n: 3 }, { username: 'nabil.munla', n: 1 }]);
});

test('27: shown - a QS his own (others\' switched on); estimators everyone\'s or the people ticked', () => {
  const m = model();
  const qs = shownPeople({ qs: true, me: 'sam.carter', showOthers: false, pick: null });
  const seen = (sel: ReadonlySet<string> | null) => m.shapes.filter((s) => shownFor(m, s, sel)).map((s) => s.id).sort();
  assert.deepEqual(seen(qs), ['sh:l2', 'sh:o1', 'sh:old', 'sh:w1'], 'the QS sees only his own (the old one is his take-off\'s)');
  assert.equal(shownPeople({ qs: true, me: 'sam.carter', showOthers: true, pick: new Set(['x']) }), null, 'switched on: everyone\'s (an estimator\'s pick is not his)');
  assert.equal(shownPeople({ qs: false, me: 'adam.khan', showOthers: false, pick: null }), null, 'an estimator: everyone\'s by default');
  assert.deepEqual(seen(shownPeople({ qs: false, me: 'adam.khan', showOthers: false, pick: new Set(['adam.khan']) })), ['sh:a1', 'sh:l1']);
  // a joint owner's pick shows the shape too
  const st = apply(new Store(), project());
  apply(st, [['sh:o1', 'co:adam.khan', true]]);
  const m2 = model(st);
  assert.ok(shownFor(m2, sh(m2, 'sh:o1'), new Set(['adam.khan'])));
  // a shape nobody is known to own (an old shape of a take-off without an owner) is always shown, and anyone's
  const st3 = apply(new Store(), project());
  apply(st3, [['ti:area', 'owner', null], ['sh:o1', 'by', null]]);
  const m3 = model(st3);
  assert.ok(shownFor(m3, sh(m3, 'sh:o1'), new Set(['zed'])) && isMine(m3, sh(m3, 'sh:o1'), 'zed'));
});

test('27: quantities are everyone\'s whoever looks - the take-off total and the BOQ figure; the split adds up to the total', () => {
  const m = model();
  const it = m.itemById.get('ti:area')!;
  const total = measureOf(m.qty.get('ti:area')!, mainMeasure(it));
  close(total, 5 * 4 + 3 * 2, 1e-3);
  close(m.boqQty.get('1')!.total, total, 1e-9);
  // joint owners (a field 0.15 apps don't know) change no figure
  const st = apply(new Store(), project());
  apply(st, [['sh:o1', 'co:adam.khan', true], ['sh:a1', 'co:sam.carter', true]]);
  const m2 = model(st);
  close(measureOf(m2.qty.get('ti:area')!, 'area'), total, 1e-12);
  close(m2.boqQty.get('1')!.total, total, 1e-12);
  // Yours · others for Omar
  const sp = ownerSplit(m, it, (s) => isMine(m, s, 'sam.carter'))!;
  assert.ok(sp);
  close(sp.mine, 20, 1e-3);
  close(sp.others, 6, 1e-3);
  close(sp.mine + sp.others, total, 1e-9);
  assert.equal(sp.nOthers, 1);
  assert.equal(ownerSplit(m, m.itemById.get('ti:wall')!, (s) => isMine(m, s, 'sam.carter')), null, 'nothing of anyone else: no split');
});

test('27: other people\'s shapes are view only - a move, a reshape, a delete, tags, a door on them, a split or join is refused', () => {
  const m = model();
  const me = 'sam.carter';
  const a1 = sh(m, 'sh:a1');
  const refused = (ops: Op[]) => ownership(m, ops, me, false).locked.map((s) => s.id);
  assert.deepEqual(refused(moveShapesOps([a1], 10, 10)), ['sh:a1'], 'moved');
  assert.deepEqual(refused([['sh:a1', 'del', true]]), ['sh:a1'], 'deleted');
  assert.deepEqual(refused([['sh:a1', 'm', 3]]), ['sh:a1'], 'repeated');
  assert.deepEqual(refused([['sh:a1', 'ti', 'ti:len']]), ['sh:a1'], 'moved to another take-off');
  assert.deepEqual(refused([['sh:l1', 'sg', J(['x', null])]]), ['sh:l1'], 'tagged (typed onto)');
  assert.deepEqual(refused(splitLineOps(sh(m, 'sh:l1'), 1, me)!.ops), ['sh:l1'], 'split');
  const join = joinLinesOps(sh(m, 'sh:l1'), sh(m, 'sh:l2'), 0.5, undefined, me);
  assert.ok(join);
  assert.deepEqual(refused(join!), ['sh:l1'], 'joined with one of his own');
  // a door put on / changed on someone else's wall
  const m2 = model(apply(apply(new Store(), project()), [['sh:w1', 'by', 'adam.khan']]));
  assert.deepEqual(ownership(m2, [['op:d1', 'w', 0.9]], me, false).locked.map((s) => s.id), ['sh:w1'], 'a door on it changed');
  const put = openingOps({ sh: 'sh:w1', seg: 0, x: R(100 + P(2)), y: 500, k: 'open', w: 1, h: 2 } as never);
  assert.deepEqual(ownership(m2, put.ops, me, false).locked.map((s) => s.id), ['sh:w1'], 'a door put on it');
  // his own: nothing refused, nothing added
  const own = ownership(m, moveShapesOps([sh(m, 'sh:o1')], 5, 5), me, false);
  assert.deepEqual([own.locked.length, own.joint.length, own.ops.length], [0, 0, 0]);
  // not changes of the measurement: a fingerprint, a page, "checked"
  assert.equal(shapesChanged(m, [['sh:a1', 'rv', 'abc'], ['sh:a1', 'pg', 0], ['sh:a1', 'opg', null]]).length, 0);
  // deleted with their take-off: the list's question (askDelete), not refused here
  assert.equal(ownership(m, deleteNodesOps(m, ['ti:area']).ops, me, false).locked.length, 0);
  // copies of his own take-off (Duplicate with shapes) change nothing of anyone's
  const dup = duplicateItemOps(m, 'ti:wall', me, { links: false, shapes: true })!;
  assert.equal(ownership(m, dup.ops, me, false).locked.length, 0);
});

test('27: switched on, a change of someone else\'s shape keeps its owner and adds the editor as a joint owner, in the history label', () => {
  const st = apply(new Store(), project());
  const m = model(st);
  const me = 'nabil.munla';
  const ops = moveShapesOps([sh(m, 'sh:o1')], 10, 0);
  const own = ownership(m, ops, me, true);
  assert.equal(own.locked.length, 0);
  assert.deepEqual(own.joint.map((s) => s.id), ['sh:o1']);
  assert.deepEqual(own.ops, [['sh:o1', 'co:nabil.munla', true]]);
  assert.equal(jointLabel('Moved', own.joint, m, nameOf, 'Nabil Munla'), "Moved — Sam Carter's shape, also edited by Nabil Munla");
  assert.equal(jointLabel('Moved', [sh(m, 'sh:o1'), sh(m, 'sh:a1')], m, nameOf, 'Nabil Munla'), "Moved — Sam Carter and Adam Khan's shapes, also edited by Nabil Munla");
  assert.equal(jointLabel('Moved', [], m, nameOf, 'Nabil Munla'), 'Moved', 'his own: the label as it was');
  apply(st, [...ops, ...own.ops]);
  const m2 = model(st);
  const o1 = sh(m2, 'sh:o1');
  assert.equal(o1.by, 'sam.carter', 'still Omar\'s');
  assert.deepEqual(o1.co, ['nabil.munla']);
  assert.equal(ownerText(m2, o1, nameOf), 'by Sam Carter · also edited by Nabil Munla');
  // now it is his too: no longer view only for him, still shown when he ticks only himself
  assert.ok(mayEdit(m2, o1, me, false));
  assert.ok(shownFor(m2, o1, new Set([me])));
  // a second change by a joint owner adds nothing
  assert.equal(ownership(m2, moveShapesOps([o1], 1, 0), me, false).ops.length, 0);
});

test('27: pieces of a split / join of someone else\'s keep its owner, with the editor and the other owners as joint owners', () => {
  const st = apply(new Store(), project());
  const m = model(st);
  const me = 'nabil.munla';
  const r = splitLineOps(sh(m, 'sh:l1'), 1, me)!;
  const own = ownership(m, r.ops, me, true);
  apply(st, [...r.ops, ...own.ops]);
  const m2 = model(st);
  for (const id of r.ids) {
    const p = sh(m2, id);
    assert.equal(p.by, 'adam.khan', 'a piece is still Adam\'s');
    assert.deepEqual(p.co, ['nabil.munla'], 'and the editor\'s');
  }
  // join Omar's with Adam's (Omar's first): Omar's, Adam and the editor joint owners
  const st2 = apply(new Store(), project());
  const n = model(st2);
  const ops = joinLinesOps(sh(n, 'sh:l2'), sh(n, 'sh:l1'), 0.5, undefined, me)!;
  assert.ok(ops);
  const o2 = ownership(n, ops, me, true);
  apply(st2, [...ops, ...o2.ops]);
  const n2 = model(st2);
  const joined = n2.shapes.find((s) => s.ti === 'ti:len' && s.id !== 'sh:old')!;
  assert.ok(joined && !['sh:l1', 'sh:l2'].includes(joined.id));
  assert.deepEqual(ownersOf(n2, joined).sort(), ['adam.khan', 'nabil.munla', 'sam.carter']);
});

// ---------------------------------------------------------------- one Ctrl+Z
const OPEN: ProjectSession[] = [];
after(async () => { for (const s of OPEN) await s.close(); });
test('27: the joint-owner mark is part of the change - one Ctrl+Z takes both back', async () => {
  const data = mkdtempSync(join(tmpdir(), 'v16e-'));
  const { dir } = await createProject(nodefs as FsApi, data, 'T', 'Nabil', 'PC1', [], 'nabil', 'takeoff');
  const s = new ProjectSession({ fs: nodefs as FsApi, localFs: nodefs as FsApi, projectDir: dir, localDir: mkdtempSync(join(tmpdir(), 'v16el-')), user: 'Nabil', account: 'nabil.munla', host: 'PC1', pollMs: 3600000, fullScanMs: 0, heartbeatMs: 3600000 });
  await s.open();
  OPEN.push(s);
  s.commit(project(), 'setup');
  const m = buildQtoModel(s.store, null);
  const ops = moveShapesOps([sh(m, 'sh:a1')], 10, 0);
  const own = ownership(m, ops, 'nabil.munla', true);
  s.commit([...ops, ...own.ops], jointLabel('Moved', own.joint, m, nameOf, 'Nabil Munla'));
  const m2 = buildQtoModel(s.store, null);
  assert.deepEqual(sh(m2, 'sh:a1').co, ['nabil.munla']);
  const u = s.undo();
  assert.ok(u && !u.refused);
  const m3 = buildQtoModel(s.store, null);
  assert.equal(sh(m3, 'sh:a1').co, undefined);
  assert.equal(J(sh(m3, 'sh:a1').pts), J(sh(m, 'sh:a1').pts));
});
