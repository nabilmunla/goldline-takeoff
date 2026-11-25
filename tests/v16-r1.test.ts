// v0.16 debug run 1 (reviewer r1): drawing tools and the take-off panel - each test failed before its fix.
// run: node --import tsx --test tests/v16-r1.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/engine/store';
import { buildQtoModel } from '../src/engine/qto/model';
import { scaleFromRatio } from '../src/engine/qto/geometry';
import { duplicateHeadingOps } from '../src/engine/qto/listops';
import type { Op } from '../src/engine/types';

let seq = 0;
const apply = (st: Store, ops: Op[]) => { seq++; st.apply({ s: String(seq).padStart(10, '0') + '~r', w: 'w', u: 'T', t: seq, o: ops }); return st; };
const S = scaleFromRatio(100);
/** metres at 1:100 in sheet points, as shapes keep them (0.001 pt) */
const P = (x: number) => Math.round((x / S) * 1000) / 1000;
const J = JSON.stringify;
const close = (a: number | undefined, b: number, msg = '') => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-3, `${msg} ${a} != ${b}`);
const rect = (x0: number, y0: number, w: number, h: number) => J([P(x0), P(y0), P(x0 + w), P(y0), P(x0 + w), P(y0 + h), P(x0), P(y0 + h)]);
const shape = (id: string, ti: string, k: string, p: string): Op[] => [[id, 'ti', ti], [id, 'dwg', 'dwg:d1'], [id, 'pg', 0], [id, 'k', k], [id, 'p', p]];
const raw = (st: Store) => (ti: string) => [...(st.ents.get(ti) ?? new Map())].map(([f, c]) => [f, c.v] as [string, any]);

/** heading "Level 1": a room (wall finish 3 m, a wallpaper behind the bed deducted from it), a floor tile area
 *  linked to the room's Floor; heading "Other": a length linked to the same room's Skirting */
function rooms(): Op[] {
  return [
    ['dwg:d1', 'name', 'A.pdf'], ['dwg:d1', 'path', 'X:/A.pdf'], ['dwg:d1', 'pages', 1], ['pg:dwg:d1.0', 'sc', S],
    ['hd:h', 'name', 'Level 1'], ['hd:h', 'ord', 'a0'], ['hd:o', 'name', 'Other'], ['hd:o', 'ord', 'a1'],
    ['ti:r', 'kind', 'room'], ['ti:r', 'name', 'Bed'], ['ti:r', 'par', 'hd:h'], ['ti:r', 'ord', 'a0'], ['ti:r', 'fc', 'FL-01'], ['ti:r', 'wc', 'PT-01'], ['ti:r', 'hw', 3], ['ti:r', 'kc', 'SK-01'],
    ...shape('sh:r', 'ti:r', 'poly', rect(0, 0, 5, 4)),
    ['ti:wp', 'kind', 'line'], ['ti:wp', 'name', 'Wallpaper'], ['ti:wp', 'par', 'hd:h'], ['ti:wp', 'ord', 'a0'], ['ti:wp', 'rm', 'ti:r'], ['ti:wp', 'rk', 'add'], ['ti:wp', 'rcat', 'wall'], ['ti:wp', 'h', 2.9], ['ti:wp', 'fcode', 'WP-01'],
    ...shape('sh:wp', 'ti:wp', 'line', J([P(5), P(0), P(5), P(4)])),
    ['ti:fl', 'kind', 'area'], ['ti:fl', 'name', 'Tiles'], ['ti:fl', 'par', 'hd:h'], ['ti:fl', 'ord', 'a1'], ['ti:fl', 'rm', 'ti:r'], ['ti:fl', 'rk', 'link'], ['ti:fl', 'rcat', 'floor'], ['ti:fl', 'fcode', 'FL-09'],
    ...shape('sh:fl', 'ti:fl', 'poly', rect(0, 0, 2, 2)),
    ['ti:sk', 'kind', 'line'], ['ti:sk', 'name', 'Marble skirting'], ['ti:sk', 'par', 'hd:o'], ['ti:sk', 'ord', 'a0'], ['ti:sk', 'rm', 'ti:r'], ['ti:sk', 'rk', 'link'], ['ti:sk', 'rcat', 'skirting'],
    ...shape('sh:sk', 'ti:sk', 'line', J([P(0), P(0), P(1), P(0)])),
  ];
}
const qtys = (m: ReturnType<typeof buildQtoModel>, rid: string) => Object.fromEntries([...m.fin.qty.get(rid)!.byKey.entries()].map(([k, v]) => [k, v.qty]));

test('19: duplicating a heading does not change the rooms that were there - a take-off linked to a room outside it is copied unlinked', () => {
  const st = apply(new Store(), rooms());
  const m = buildQtoModel(st, null);
  const before = qtys(m, 'ti:r');
  close(before.floor, 16, 'floor less the linked tiles');
  close(before.skirting, 17, 'skirting less the linked marble');
  for (const withValues of [true, false]) {
    const st2 = apply(new Store(), rooms());
    const r = duplicateHeadingOps(buildQtoModel(st2, null), 'hd:o', 'me', withValues, raw(st2))!;
    apply(st2, r.ops);
    const m2 = buildQtoModel(st2, null);
    assert.deepEqual(qtys(m2, 'ti:r'), before, `the room is as it was (${withValues ? 'with' : 'without'} values)`);
    const copy = m2.items.find((x) => x.name === 'Marble skirting' && x.id !== 'ti:sk')!;
    assert.ok(copy, 'the take-off is copied');
    assert.ok(!copy.rk && !copy.rm, 'not linked to the room (as BOQ links)');
  }
});

test('19: a heading with a room in it - the copy of the room keeps its additional finishes, and what was linked to it is linked to the copy', () => {
  const st = apply(new Store(), rooms());
  const m = buildQtoModel(st, null);
  const before = qtys(m, 'ti:r');
  close(before.wall, 42.4, 'wall less the wallpaper');
  close(before['ti:wp'], 11.6);
  const r = duplicateHeadingOps(m, 'hd:h', 'me', true, raw(st))!;
  assert.equal(r.items, 2, 'the room and the tiles (the wallpaper is part of the room)');
  apply(st, r.ops);
  const m2 = buildQtoModel(st, null);
  assert.deepEqual(qtys(m2, 'ti:r'), before, 'the original room is as it was');
  const room2 = m2.items.find((x) => x.kind === 'room' && x.id !== 'ti:r')!;
  const q2 = qtys(m2, room2.id);
  close(q2.wall, 42.4, 'the copy: wall less its own wallpaper');
  close(q2.floor, 16, 'the copy: floor less the copied tiles');
  const parts = m2.roomParts.get(room2.id) ?? [];
  assert.equal(parts.length, 1, 'its wallpaper copied');
  assert.equal(m2.itemById.get(parts[0])!.fcode, 'WP-01');
  const tiles2 = m2.items.find((x) => x.name === 'Tiles' && x.id !== 'ti:fl')!;
  assert.equal(tiles2.rm, room2.id, 'the copied tiles are linked to the copied room');
  // without values: the room's settings and its finishes, nothing measured
  const st3 = apply(new Store(), rooms());
  const r3 = duplicateHeadingOps(buildQtoModel(st3, null), 'hd:h', 'me', false, raw(st3))!;
  apply(st3, r3.ops);
  const m3 = buildQtoModel(st3, null);
  const room3 = m3.items.find((x) => x.kind === 'room' && x.id !== 'ti:r')!;
  assert.equal((m3.roomParts.get(room3.id) ?? []).length, 1);
  assert.equal((m3.shapesByItem.get(room3.id) ?? []).length, 0);
  assert.deepEqual(qtys(m3, 'ti:r'), before);
});

// ---------------------------------------------------------------- 9 / 6: cut-outs
import { boxPicks } from '../src/engine/qto/drawaids';
import { deleteVertexOps } from '../src/engine/qto/ops';
import { bbox, type Pt } from '../src/engine/qto/geometry';
const area = (outer: Pt[], holes: Pt[][]) => ({ id: 'sh:x', ti: 'ti:x', dwg: 'd1', pg: 0, k: 'poly' as const, pts: outer, b: [], flat: outer, holes, m: 1, box: bbox(outer), by: '', rv: '', sg: undefined });

test('9: a crossing box over the edge of a cut-out touches the area (part of it is on the area)', () => {
  const a = area([[0, 0], [100, 0], [100, 100], [0, 100]], [[[20, 20], [80, 20], [80, 80], [20, 80]]]);
  // from x 15 (on the area) to 30 (in the cut-out): it crosses the cut-out's left edge; its middle is in the cut-out
  assert.equal(boxPicks(a, { x0: 15, y0: 40, x1: 30, y1: 60 }, true), true);
  // wholly in the cut-out: nothing of the area in it
  assert.equal(boxPicks(a, { x0: 30, y0: 30, x1: 40, y1: 40 }, true), false);
});

test('6: deleting a node of a 3-node cut-out is refused (it used to take the whole cut-out away)', () => {
  const a = area([[0, 0], [100, 0], [100, 100], [0, 100]], [[[20, 20], [80, 20], [50, 80]]]);
  assert.deepEqual(deleteVertexOps(a as any, 1, 1), [], 'a cut-out keeps at least 3 nodes');
  const b = area([[0, 0], [100, 0], [100, 100], [0, 100]], [[[20, 20], [80, 20], [80, 80], [20, 80]]]);
  assert.ok(deleteVertexOps(b as any, 1, 1).length > 0, 'a 4-node one loses the node');
});

// ---------------------------------------------------------------- UI rule 7: the key list says what the keys do
import { QTO_KEYS } from '../src/ui/takeoff/keymap';
test('rule 7: the take-off list keys in the "?" / F1 list - Del (asks first), Esc, F2 for take-offs too', () => {
  const list = QTO_KEYS.find((s) => s.title === 'Take-off list')!.rows;
  const del = list.find((r) => r.keys.includes('Del'));
  assert.ok(del && /ask/i.test(del.what), 'Del on the list: deletes the take-offs / headings picked, asking first');
  const f2 = list.find((r) => r.keys.includes('F2'))!;
  assert.ok(/take-off/i.test(f2.what), 'F2 renames a take-off too: ' + f2.what);
  assert.ok(list.some((r) => r.keys.includes('Esc')), 'Esc on the list: nothing picked');
});
