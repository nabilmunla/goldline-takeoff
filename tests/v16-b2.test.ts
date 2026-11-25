// v0.16 group b2 (take-off list): heading duplicate (19), delete in one step with one undo (21), show / hide
// per person (11), quantities of one sheet (17), shared values of several selected (22).
// run: node --import tsx --test tests/v16-b2.test.ts
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
import { leavesInOrder } from '../src/engine/qto/headings';
import { deleteNodesOps, deleteQuestion, duplicateHeadingOps, headEye, hiddenItemsOf, noneHidden, sharedValue, sheetQty, toggleHeadEye, toggleItemEye, underHidden } from '../src/engine/qto/listops';
import type { FsApi, Op } from '../src/engine/types';

const require = createRequire(import.meta.url);
const nodefs = require('../electron/nodefs.cjs');
const J = JSON.stringify;
const S100 = scaleFromRatio(100);
/** metres on the sheet at 1:100, in sheet points as shapes keep them (0.001 pt) */
const P = (m: number) => Math.round((m / S100) * 1000) / 1000;
let seq = 0;
const apply = (st: Store, ops: Op[]) => { seq++; st.apply({ s: String(seq).padStart(10, '0') + '~b', w: 'w', u: 'T', t: seq, o: ops }); return st; };
const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

/** two sheets at 1:100; heading Finishes > sub-heading Level 1 with an area, a wall with a door, a count
 *  used as an opening (deducted from the wall), plus a take-off at the top level; BOQ lines linked */
function project(): Op[] {
  const R = (v: number) => Math.round(v * 1000) / 1000;
  const rect = (x: number, y: number, w: number, h: number) => J([x, y, R(x + P(w)), y, R(x + P(w)), R(y + P(h)), x, R(y + P(h))]);
  return [
    ['dwg:a', 'name', 'A-101.pdf'], ['dwg:a', 'path', 'X:/A-101.pdf'], ['dwg:a', 'pages', 1],
    ['dwg:b', 'name', 'A-102.pdf'], ['dwg:b', 'path', 'X:/A-102.pdf'], ['dwg:b', 'pages', 1],
    ['pg:dwg:a.0', 'sc', S100], ['pg:dwg:b.0', 'sc', S100],
    ['hd:fin', 'name', 'Finishes'], ['hd:fin', 'ord', 'a1'],
    ['hd:l1', 'name', 'Level 1'], ['hd:l1', 'par', 'hd:fin'], ['hd:l1', 'ord', 'a0'],
    ['hd:other', 'name', 'Other'], ['hd:other', 'ord', 'a2'],
    ['ti:area', 'kind', 'area'], ['ti:area', 'name', 'Floor tiles'], ['ti:area', 'color', '#123456'], ['ti:area', 'par', 'hd:l1'], ['ti:area', 'ord', 'a0'], ['ti:area', 'd', 0.05], ['ti:area', 'waste', 5],
    ['ti:area', 'fc', 'FL-02'], // a field a later version adds (finish code): copied as it is
    ['sh:a1', 'ti', 'ti:area'], ['sh:a1', 'dwg', 'dwg:a'], ['sh:a1', 'pg', 0], ['sh:a1', 'k', 'poly'], ['sh:a1', 'p', rect(100, 100, 5, 4)],
    ['sh:a2', 'ti', 'ti:area'], ['sh:a2', 'dwg', 'dwg:b'], ['sh:a2', 'pg', 0], ['sh:a2', 'k', 'poly'], ['sh:a2', 'p', rect(100, 100, 3, 2)], ['sh:a2', 'm', 2],
    ['ti:door', 'kind', 'count'], ['ti:door', 'name', 'Doors'], ['ti:door', 'par', 'hd:l1'], ['ti:door', 'ord', 'a2'], ['ti:door', 'ow', 0.9], ['ti:door', 'oh', 2.1],
    ['sh:c1', 'ti', 'ti:door'], ['sh:c1', 'dwg', 'dwg:a'], ['sh:c1', 'pg', 0], ['sh:c1', 'k', 'pt'], ['sh:c1', 'p', J([300, 300])],
    ['sh:c2', 'ti', 'ti:door'], ['sh:c2', 'dwg', 'dwg:b'], ['sh:c2', 'pg', 0], ['sh:c2', 'k', 'pt'], ['sh:c2', 'p', J([300, 300])],
    ['ti:wall', 'kind', 'wall'], ['ti:wall', 'name', 'Block 200'], ['ti:wall', 'par', 'hd:l1'], ['ti:wall', 'ord', 'a1'], ['ti:wall', 'h', 3], ['ti:wall', 'd', 0.2], ['ti:wall', 'x', 2],
    ['ti:wall', 'ded', J(['ti:door'])],
    ['sh:w1', 'ti', 'ti:wall'], ['sh:w1', 'dwg', 'dwg:a'], ['sh:w1', 'pg', 0], ['sh:w1', 'k', 'line'], ['sh:w1', 'p', J([100, 500, R(100 + P(10)), 500, R(100 + P(10)), R(500 + P(4))])],
    ['op:o1', 'sh', 'sh:w1'], ['op:o1', 'x', R(100 + P(5))], ['op:o1', 'y', 500], ['op:o1', 'k', 'open'], ['op:o1', 'w', 1.2], ['op:o1', 'h', 1.5],
    ['ti:sk', 'kind', 'line'], ['ti:sk', 'name', 'Skirting'], ['ti:sk', 'par', 'hd:fin'], ['ti:sk', 'ord', 'a1'],
    ['sh:s1', 'ti', 'ti:sk'], ['sh:s1', 'dwg', 'dwg:a'], ['sh:s1', 'pg', 0], ['sh:s1', 'k', 'line'], ['sh:s1', 'p', J([0, 0, P(7), 0])],
    ['ti:top', 'kind', 'line'], ['ti:top', 'name', 'Kerbs'], ['ti:top', 'ord', 'a3'],
    ['sh:t1', 'ti', 'ti:top'], ['sh:t1', 'dwg', 'dwg:a'], ['sh:t1', 'pg', 0], ['sh:t1', 'k', 'line'], ['sh:t1', 'p', J([0, 50, P(2), 50])],
    ['b:1', 'bt', 'item'], ['b:1', 'ref', '1.1'], ['b:1', 'desc', 'Tiles'], ['b:1', 'unit', 'm2'], ['b:1', 'ord', 'a0'],
    ['b:2', 'bt', 'item'], ['b:2', 'ref', '1.2'], ['b:2', 'desc', 'Blockwork'], ['b:2', 'unit', 'm2'], ['b:2', 'ord', 'a1'],
    ['lk:1', 'ti', 'ti:area'], ['lk:1', 'to', 'b:1'], ['lk:1', 'q', 'area'],
    ['lk:2', 'ti', 'ti:wall'], ['lk:2', 'to', 'b:2'], ['lk:2', 'q', 'area'],
  ];
}

// ---------------------------------------------------------------- 19
test('19: "Duplicate with take-off values" copies the heading, sub-headings, take-offs, settings and shapes (same sheets, same places) - not the BOQ links', () => {
  const st = apply(new Store(), project());
  const m = buildQtoModel(st, null);
  const raw = (ti: string) => [...(st.ents.get(ti) ?? new Map())].map(([f, c]) => [f, c.v] as [string, any]);
  const r = duplicateHeadingOps(m, 'hd:fin', 'nabil', true, raw)!;
  assert.ok(r);
  assert.equal(r.items, 4);
  assert.equal(r.shapes, 6);
  apply(st, r.ops);
  const m2 = buildQtoModel(st, null);
  // named "<name> (copy)", right after the original, before "Other"
  const top = (m2.itemTree.tree.get('') ?? []).filter((n) => n.t === 'h').map((n) => m2.headingById.get(n.id)!.name);
  assert.deepEqual(top, ['Finishes', 'Finishes (copy)', 'Other']);
  const copy = m2.headings.find((h) => h.name === 'Finishes (copy)')!;
  const sub = m2.headings.find((h) => h.par === copy.id)!;
  assert.equal(sub.name, 'Level 1');
  // the take-offs in the same order, same names and settings
  const leavesUnder = (hid: string): string[] => (m2.itemTree.tree.get(hid) ?? []).flatMap((n) => (n.t === 'h' ? leavesUnder(n.id) : [m2.itemById.get(n.id)!.name]));
  assert.deepEqual(leavesUnder(copy.id), leavesUnder('hd:fin'));
  assert.deepEqual(leavesUnder(copy.id), ['Floor tiles', 'Block 200', 'Doors', 'Skirting']);
  const area2 = m2.items.find((it) => it.name === 'Floor tiles' && it.id !== 'ti:area')!;
  const wall2 = m2.items.find((it) => it.name === 'Block 200' && it.id !== 'ti:wall')!;
  const door2 = m2.items.find((it) => it.name === 'Doors' && it.id !== 'ti:door')!;
  assert.ok(area2 && wall2 && door2);
  assert.equal(area2.par, sub.id);
  assert.equal(area2.color, '#123456');
  assert.equal(area2.d, 0.05);
  assert.equal(area2.waste, 5);
  assert.equal(st.get(area2.id, 'fc'), 'FL-02', 'a field of a later version is copied too');
  assert.equal(wall2.x, 2);
  assert.deepEqual(wall2.ded, [door2.id], 'the wall deducts the copied doors, not the original ones');
  assert.equal(area2.owner, 'nabil');
  // the same quantities (shapes on the same sheets at the same places; the wall's opening too)
  for (const [a, b] of [['ti:area', area2.id], ['ti:wall', wall2.id], ['ti:door', door2.id]]) {
    const qa = m2.qty.get(a)!, qb = m2.qty.get(b)!;
    for (const k of ['area', 'len', 'cnt', 'vol', 'dedArea', 'opens'] as const) close(qb[k], qa[k]);
  }
  const shapesA = (m2.shapesByItem.get('ti:area') ?? []).map((s) => s.dwg + J(s.pts) + s.m).sort();
  const shapesB = (m2.shapesByItem.get(area2.id) ?? []).map((s) => s.dwg + J(s.pts) + s.m).sort();
  assert.deepEqual(shapesB, shapesA);
  // no BOQ links: the BOQ lines count as before
  assert.equal(m2.linksByItem.get(area2.id)?.length ?? 0, 0);
  assert.equal(m2.linksByItem.get(wall2.id)?.length ?? 0, 0);
  close(m2.boqQty.get('1')!.total, m.boqQty.get('1')!.total);
  close(m2.boqQty.get('2')!.total, m.boqQty.get('2')!.total);
});

test('19: "Duplicate without values" copies headings and take-offs (names, settings, colours), nothing measured', () => {
  const st = apply(new Store(), project());
  const m = buildQtoModel(st, null);
  const r = duplicateHeadingOps(m, 'hd:l1', 'nabil', false)!;
  assert.equal(r.shapes, 0);
  apply(st, r.ops);
  const m2 = buildQtoModel(st, null);
  const copy = m2.headings.find((h) => h.name === 'Level 1 (copy)')!;
  assert.equal(copy.par, 'hd:fin', 'beside the original, in the same heading');
  const kids = (m2.itemTree.tree.get('hd:fin') ?? []).map((n) => m2.headingById.get(n.id)?.name ?? m2.itemById.get(n.id)?.name);
  assert.deepEqual(kids, ['Level 1', 'Level 1 (copy)', 'Skirting']);
  const inCopy = (m2.itemTree.tree.get(copy.id) ?? []).map((n) => m2.itemById.get(n.id)!);
  assert.deepEqual(inCopy.map((x) => x.name), ['Floor tiles', 'Block 200', 'Doors']);
  assert.deepEqual(inCopy.map((x) => x.color), ['#123456', ...['ti:wall', 'ti:door'].map((id) => m.itemById.get(id)!.color)]);
  for (const it of inCopy) assert.equal(m2.qty.get(it.id)!.shapes, 0);
  assert.equal(inCopy[1].h, 3);
  assert.equal(inCopy[2].ow, 0.9);
});

function isUnder(m: QtoModel, h: string, top: string): boolean {
  for (let p = h; p; p = m.headingById.get(p)?.par ?? '') if (p === top) return true;
  return false;
}

// ---------------------------------------------------------------- 21
const OPEN: ProjectSession[] = [];
after(async () => { for (const s of OPEN.splice(0)) await s.close().catch(() => {}); });
async function session() {
  const data = mkdtempSync(join(tmpdir(), 'v16b2-'));
  const { dir } = await createProject(nodefs as FsApi, data, 'T', 'Nabil', 'PC1', [], 'nabil', 'takeoff');
  const s = new ProjectSession({ fs: nodefs as FsApi, localFs: nodefs as FsApi, projectDir: dir, localDir: mkdtempSync(join(tmpdir(), 'v16b2l-')), user: 'Nabil', account: 'nabil', host: 'PC1', pollMs: 3600000, fullScanMs: 0, heartbeatMs: 3600000 });
  await s.open();
  OPEN.push(s);
  return s;
}
/** everything a person sees of the take-offs: settings, place in the list, shapes on every sheet, links, quantities */
function snapshot(m: QtoModel) {
  return {
    items: m.items.map((it) => ({ ...it })),
    order: leavesInOrder(m.itemTree),
    heads: m.headings.map((h) => [h.id, h.name, h.par, h.ord]),
    shapes: m.shapes.map((s) => [s.id, s.ti, s.dwg, s.pg, J(s.pts), s.m]),
    links: m.links.map((l) => [l.id, l.ti, l.to, l.q, l.f]),
    openings: m.openings.map((o) => [o.id, o.sh]),
    qty: [...m.qty].map(([k, q]) => [k, q.area, q.len, q.cnt, q.vol]),
    boq: [...m.boqQty].map(([k, v]) => [k, v.total]),
  };
}

test('21: deleting take-offs / a heading is one step; one Ctrl+Z brings back the take-offs, their shapes on every sheet, settings, place and BOQ links exactly', async () => {
  const s = await session();
  s.commit(project(), 'setup');
  const before = snapshot(buildQtoModel(s.store, null));
  const m = buildQtoModel(s.store, null);
  // a heading (everything under it) and a take-off elsewhere, together
  const r = deleteNodesOps(m, ['hd:fin', 'ti:top', 'ti:area' /* under the heading: counted once */]);
  assert.deepEqual(r.items.sort(), ['ti:area', 'ti:door', 'ti:sk', 'ti:top', 'ti:wall']);
  assert.equal(r.shapes, 7);
  assert.equal(r.links, 2);
  s.commit(r.ops, 'Deleted');
  const gone = buildQtoModel(s.store, null);
  assert.equal(gone.items.length, 0);
  assert.equal(gone.shapes.length, 0);
  assert.equal(gone.links.length, 0);
  assert.equal(gone.headings.filter((h) => h.id !== 'hd:other').length, 0);
  const u = s.undo();
  assert.ok(u && !u.refused && u.skipped === 0);
  assert.deepEqual(snapshot(buildQtoModel(s.store, null)), before);
  assert.equal(s.canUndo(), true, 'the setup is still there to undo: the delete was one step');
});

test('21: the question says what goes', () => {
  const m = buildQtoModel(apply(new Store(), project()), null);
  const one = deleteQuestion(m, ['ti:area']);
  assert.equal(one.title, 'Delete Floor tiles and all its measurements?');
  assert.match(one.detail, /2 shapes on every sheet and 1 BOQ link/);
  const h = deleteQuestion(m, ['hd:fin']);
  assert.match(h.title, /Finishes and everything under it/);
  assert.match(h.detail, /Everything under it goes: 4 take-offs with 6 shapes, 1 sub-heading/);
  const many = deleteQuestion(m, ['ti:top', 'ti:sk']);
  assert.equal(many.title, 'Delete 2 take-offs and all their measurements?');
  assert.match(many.detail, /^2 shapes/);
});

// ---------------------------------------------------------------- 11
test('11: hiding a heading hides everything under it without touching the take-offs\' own eyes; shown again, each is as it was; mixed state', () => {
  const m = buildQtoModel(apply(new Store(), project()), null);
  const tv = m.itemTree;
  let h = toggleItemEye('ti:door', noneHidden());
  assert.deepEqual([...hiddenItemsOf(tv, h)], ['ti:door']);
  assert.equal(headEye(tv, 'hd:l1', h), 'mixed');
  assert.equal(headEye(tv, 'hd:fin', h), 'mixed');
  h = toggleHeadEye(tv, 'hd:fin', h); // hide all of Finishes
  assert.deepEqual([...hiddenItemsOf(tv, h)].sort(), ['ti:area', 'ti:door', 'ti:sk', 'ti:wall']);
  assert.equal(headEye(tv, 'hd:fin', h), 'none');
  assert.ok(h.items.has('ti:door') && h.items.size === 1, 'the take-offs\' own eyes are untouched');
  assert.ok(underHidden(tv, 'ti:area', h) && underHidden(tv, 'hd:l1', h));
  h = toggleHeadEye(tv, 'hd:fin', h); // shown again
  assert.deepEqual([...hiddenItemsOf(tv, h)], ['ti:door'], 'each take-off back to its own state');
  // everything under a heading hidden one by one: the heading shows "none"; its eye shows them all
  h = toggleItemEye('ti:area', toggleItemEye('ti:wall', h));
  assert.equal(headEye(tv, 'hd:l1', h), 'none');
  h = toggleHeadEye(tv, 'hd:l1', h);
  assert.equal(headEye(tv, 'hd:l1', h), 'all');
  assert.equal(hiddenItemsOf(tv, h).size, 0);
  assert.equal(headEye(tv, 'hd:other', h), 'all');
});

// ---------------------------------------------------------------- 17
test('17: quantities of one sheet: only that sheet\'s shapes, worked out as the totals are; the sheets add up to the total', () => {
  const m = buildQtoModel(apply(new Store(), project()), null);
  const a = sheetQty(m, 'dwg:a', 0), b = sheetQty(m, 'dwg:b', 0);
  close(a.get('ti:area')!.area, 20 * 1.05, 1e-3); // 5 x 4 m, 5 % waste
  close(b.get('ti:area')!.area, 3 * 2 * 2 * 1.05, 1e-3); // repeated x2
  assert.equal(a.get('ti:door')!.cnt, 1);
  assert.equal(b.has('ti:wall'), false, 'nothing of the wall on the second sheet');
  // the wall: 14 m x 3 m x 2 faces, less its own opening (1.2 x 1.5) and the door counted on this sheet (0.9 x 2.1)
  close(a.get('ti:wall')!.area, (14 * 3 - 1.2 * 1.5 - 0.9 * 2.1) * 2, 1e-3);
  close(a.get('ti:sk')!.len, 7, 1e-3);
  // the sheets add up to each take-off's total (the wall: but for the door counted on the other sheet)
  for (const it of m.items) {
    const ms = mainMeasure(it);
    const sum = [a, b].reduce((t, x) => t + (x.get(it.id) ? measureOf(x.get(it.id)!, ms) : 0), 0);
    close(sum - (it.id === 'ti:wall' ? 0.9 * 2.1 * 2 : 0), measureOf(m.qty.get(it.id)!, ms), 1e-9);
  }
});

// ---------------------------------------------------------------- 22
test('22: several selected - one value for all, or "multiple values"', () => {
  const m = buildQtoModel(apply(new Store(), project()), null);
  const list = ['ti:wall', 'ti:sk', 'ti:top'].map((id) => m.itemById.get(id)!);
  assert.deepEqual(sharedValue(list, (it) => it.h), { v: null, mixed: true });
  assert.deepEqual(sharedValue(list.slice(1), (it) => it.h), { v: null, mixed: false });
  assert.deepEqual(sharedValue(list, (it) => it.fill || null), { v: null, mixed: false });
  assert.deepEqual(sharedValue([m.itemById.get('ti:wall')!, m.itemById.get('ti:wall')!], (it) => it.h), { v: 3, mixed: false });
});
