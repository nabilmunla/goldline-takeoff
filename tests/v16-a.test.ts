// v0.16 group a: clearing a sheet's scale, ortho + the ⊥ snap, window / crossing selection, nodes put in
// exactly on an outline (the shape and its quantity unchanged) and taken out, an end segment set to a typed
// length, walls / beams as bands of their real width, the one list of keys.
// run: node --import tsx --test tests/v16-a.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/engine/store';
import { buildQtoModel, type Shape } from '../src/engine/qto/model';
import { scaleFromRatio, flatten, bbox, segLength, type Pt } from '../src/engine/qto/geometry';
import { insertVertexOps, deleteVertexOps, vertexOps, openingOps } from '../src/engine/qto/ops';
import {
  orthoHV, perpFoot, perpSnap, segsOf, boxPicks, nearestEdge, nodeOnEdge, isEndNode, endNodeForLength,
  bandWidthOf, bandHalf, bandOutline, clearScaleOps, shapesLosingScale,
} from '../src/engine/qto/drawaids';
import { parseTypedLength } from '../src/ui/takeoff/SheetCanvas';
import { QTO_KEYS, QTO_KEY_ROWS } from '../src/ui/takeoff/keymap';
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
/** sheet points for `m` metres at 1:100 (kept to 0.001 pt, as the app keeps them) */
const P = (m: number) => Math.round((m / S100) * 1000) / 1000;
const shape = (k: 'poly' | 'line' | 'pt', pts: Pt[], b: number[] = [], sg: (string | null)[] = []): Shape => {
  const flat = flatten(pts, b, k === 'poly');
  return { id: 'sh:x', ti: 'ti:x', dwg: 'd1', pg: 0, k, pts, b, flat, holes: [], m: 1, box: bbox(flat), by: '', rv: '', sg };
};

test('ortho: horizontal or vertical only from the last node (no 45° any more)', () => {
  assert.deepEqual(orthoHV([0, 0], [10, 3]), [10, 0]);
  assert.deepEqual(orthoHV([0, 0], [3, -10]), [0, -10]);
  // a near-diagonal goes to the bigger of the two, never to 45°
  assert.deepEqual(orthoHV([5, 5], [15, 14]), [15, 5]);
});

test('⊥ snap: the foot of the perpendicular from the last node onto a nearby take-off - only where it lies on it', () => {
  const wall = { a: [0, 100] as Pt, b: [200, 100] as Pt, bulge: 0 };
  assert.deepEqual(perpFoot([50, 0], wall), [50, 100]);
  assert.equal(perpFoot([250, 0], wall), null, 'the foot past the end of the wall: no snap');
  // the pointer near the wall (within the tolerance), the point = the foot, wherever along the wall the pointer is
  const hit = perpSnap([50, 0], [120, 104], [wall], 12);
  assert.ok(hit);
  assert.deepEqual(hit!.p, [50, 100]);
  assert.equal(perpSnap([50, 0], [120, 130], [wall], 12), null, 'pointer too far from the wall');
  // the nearest element to the pointer wins
  const other = { a: [0, 110] as Pt, b: [200, 110] as Pt, bulge: 0 };
  assert.deepEqual(perpSnap([50, 0], [120, 108.5], [wall, other], 12)!.p, [50, 110]);
  // an arc: the foot lies where the line from its centre through the node meets it
  const arc = { a: [100, 0] as Pt, b: [-100, 0] as Pt, bulge: 1 }; // half circle round (0,0), radius 100
  const f = perpFoot([0, 300], arc) ?? perpFoot([0, -300], arc);
  assert.ok(f);
  close(Math.hypot(f![0], f![1]), 100);
  close(f![0], 0);
  // segments of an area's outline and its cut-outs
  const area = { ...shape('poly', [[0, 0], [10, 0], [10, 10], [0, 10]]), holes: [[[2, 2], [4, 2], [4, 4]] as Pt[]] };
  assert.equal(segsOf(area).length, 4 + 3);
});

test('window (left to right) selects what is wholly inside; crossing (right to left) what the box touches', () => {
  const line = shape('line', [[0, 0], [100, 0]]);
  const room = shape('poly', [[0, 0], [100, 0], [100, 100], [0, 100]]);
  const dot = shape('pt', [[50, 50]]);
  const half = { x0: -10, y0: -10, x1: 50, y1: 10 };
  assert.equal(boxPicks(line, half, false), false, 'window: half the line is outside');
  assert.equal(boxPicks(line, half, true), true, 'crossing: it touches the line');
  assert.equal(boxPicks(line, { x0: -10, y0: -10, x1: 110, y1: 10 }, false), true);
  assert.equal(boxPicks(line, { x0: 20, y0: 5, x1: 30, y1: 10 }, true), false, 'crossing near but not touching');
  // a box crossing the line without any end inside it
  assert.equal(boxPicks(line, { x0: 40, y0: -5, x1: 60, y1: 5 }, true), true);
  // a small crossing box inside a room touches its fill
  assert.equal(boxPicks(room, { x0: 40, y0: 40, x1: 45, y1: 45 }, true), true);
  assert.equal(boxPicks(room, { x0: 40, y0: 40, x1: 45, y1: 45 }, false), false);
  assert.equal(boxPicks(dot, { x0: 40, y0: 40, x1: 60, y1: 60 }, true), true);
  assert.equal(boxPicks(dot, { x0: 40, y0: 40, x1: 60, y1: 60 }, false), true);
  assert.equal(boxPicks(dot, { x0: 0, y0: 0, x1: 10, y1: 10 }, true), false);
});

/** a wall 10 m + 6 m, 0.2 thick, a door on its first segment; an arc length; an area; at 1:100 */
function sheetStore() {
  return storeWith([
    ['pg:d1.0', 'sc', S100], ['pg:d1.0', 'scl', '1:100'],
    ['ti:w', 'kind', 'wall'], ['ti:w', 'name', 'Block 200'], ['ti:w', 'ord', 'a0'], ['ti:w', 'h', 3], ['ti:w', 'd', 0.2],
    ['sh:w', 'ti', 'ti:w'], ['sh:w', 'dwg', 'd1'], ['sh:w', 'pg', 0], ['sh:w', 'k', 'line'], ['sh:w', 'p', J([100, 100, 100 + P(10), 100, 100 + P(10), 100 + P(6)])], ['sh:w', 'sg', J(['T1', 'T2'])],
    ['ds:a', 'tag', 'D01'], ['ds:a', 'sw', 1.0], ['ds:a', 'sh', 2.2], ['ds:a', 'ord', 'a0'],
    ['ti:l', 'kind', 'line'], ['ti:l', 'name', 'Kerb'], ['ti:l', 'ord', 'a1'],
    ['sh:l', 'ti', 'ti:l'], ['sh:l', 'dwg', 'd1'], ['sh:l', 'pg', 0], ['sh:l', 'k', 'line'], ['sh:l', 'p', J([400, 400, 400 + P(8), 400])], ['sh:l', 'b', J([0.5])],
    ['ti:a', 'kind', 'area'], ['ti:a', 'name', 'Floor'], ['ti:a', 'ord', 'a2'],
    ['sh:a', 'ti', 'ti:a'], ['sh:a', 'dwg', 'd1'], ['sh:a', 'pg', 0], ['sh:a', 'k', 'poly'], ['sh:a', 'p', J([600, 600, 600 + P(5), 600, 600 + P(5), 600 + P(4), 600, 600 + P(4)])],
  ]);
}

test('a node put in by double-click: exactly on the outline, nothing changes (lengths, areas, arcs, tags, doors); deleting one refused when the shape would fall apart', () => {
  const s = sheetStore();
  add(s, openingOps({ sh: 'sh:w', x: 100 + P(7), y: 100, k: 'door', door: 'ds:a', tag: '', w: null, h: null, lint: true }).ops);
  const m0 = buildQtoModel(s, null);
  const q0 = { w: m0.qty.get('ti:w')!, l: m0.qty.get('ti:l')!, a: m0.qty.get('ti:a')! };
  const sh = (m: typeof m0, id: string) => m.shapes.find((x) => x.id === id)!;
  // the wall: a double-click a little off its first segment, at 3 m
  const w = sh(m0, 'sh:w');
  const ew = nearestEdge(w, [100 + P(3), 100.6])!;
  assert.equal(ew.seg, 0);
  const pw = nodeOnEdge(w, ew.ring, ew.seg, [100 + P(3), 100.6]);
  close(pw[1], 100);
  add(s, insertVertexOps(w, 0, ew.seg, pw));
  // the arc length: the new node on the curve, two arcs of the same curve
  const l = sh(m0, 'sh:l');
  const el = nearestEdge(l, [400 + P(2), 370])!;
  const pl = nodeOnEdge(l, 0, el.seg, [400 + P(2), 370]);
  add(s, insertVertexOps(l, 0, el.seg, pl));
  // the area: on its top edge
  const a = sh(m0, 'sh:a');
  const ea = nearestEdge(a, [600 + P(2), 599])!;
  add(s, insertVertexOps(a, 0, ea.seg, nodeOnEdge(a, 0, ea.seg, [600 + P(2), 599])));
  const m1 = buildQtoModel(s, null);
  const w1 = sh(m1, 'sh:w'), l1 = sh(m1, 'sh:l'), a1 = sh(m1, 'sh:a');
  assert.equal(w1.pts.length, 4);
  assert.deepEqual(w1.sg, ['T1', 'T1', 'T2'], 'both halves keep the segment tag');
  assert.equal(l1.pts.length, 3);
  assert.ok(l1.b[0] && l1.b[1], 'two arcs');
  assert.equal(a1.pts.length, 5);
  const q1 = { w: m1.qty.get('ti:w')!, l: m1.qty.get('ti:l')!, a: m1.qty.get('ti:a')! };
  close(q1.w.len, q0.w.len, 1e-5);
  close(q1.w.area, q0.w.area, 1e-5);
  close(q1.w.dedArea, q0.w.dedArea, 1e-9);
  assert.equal(q1.w.doors, 1, 'the door stays');
  const o1 = m1.openingsByShape.get('sh:w')![0];
  assert.equal(o1.seg, 1, 'the door (at 7 m) is on the second half of the old first segment now');
  close(q1.l.len, q0.l.len, 1e-5);
  close(q1.a.area, q0.a.area, 1e-5);
  close(q1.a.perim, q0.a.perim, 1e-5);
  // deleting: the new node back out = as before; a 2-node line / 3-node area refuse
  add(s, deleteVertexOps(w1, 0, 1));
  assert.equal(buildQtoModel(s, null).shapes.find((x) => x.id === 'sh:w')!.pts.length, 3);
  const two = shape('line', [[0, 0], [10, 0]]);
  assert.deepEqual(deleteVertexOps(two, 0, 0), [], 'a line keeps at least 2 nodes');
  const tri = shape('poly', [[0, 0], [10, 0], [5, 5]]);
  assert.deepEqual(deleteVertexOps(tri, 0, 1), [], 'an area keeps at least 3 nodes');
});

test('an end grip and a typed length: the end segment exactly that long along its direction, tags and arcs kept', () => {
  const s = sheetStore();
  const m0 = buildQtoModel(s, null);
  const w = m0.shapes.find((x) => x.id === 'sh:w')!;
  assert.equal(isEndNode(w, 0, 0), true);
  assert.equal(isEndNode(w, 0, 2), true);
  assert.equal(isEndNode(w, 0, 1), false, 'a middle node is not an end');
  const closedLine = shape('line', [[0, 0], [10, 0], [10, 10], [0, 0]]);
  assert.equal(isEndNode(closedLine, 0, 0), false, 'a closed outline has no ends');
  const real = (a: Pt, b: Pt, bulge: number) => segLength(a, b, bulge) * S100;
  // the last segment (6 m, going down) -> 4.2 m
  const q = endNodeForLength(w, 2, 4.2, real)!;
  close(q[0], 100 + P(10));
  close(real(w.pts[1], q, 0), 4.2, 1e-9);
  // the first segment (10 m, from the start) -> 12.5 m: the start moves back along the wall
  const q2 = endNodeForLength(w, 0, 12.5, real)!;
  close(q2[1], 100);
  close(real(q2, w.pts[1], 0), 12.5, 1e-9);
  add(s, vertexOps(w, 0, 2, q));
  const m1 = buildQtoModel(s, null);
  const w1 = m1.shapes.find((x) => x.id === 'sh:w')!;
  assert.deepEqual(w1.sg, ['T1', 'T2'], 'its tags stay');
  // (points are kept to 0.001 pt: 0.035 mm at 1:100)
  close(m1.qty.get('ti:w')!.len, 10 + 4.2, 5e-5);
  close(m1.qty.get('ti:w')!.area, (10 + 4.2) * 3, 1e-4);
  // an arc segment: its length (along the arc) set, the same curve scaled
  const l = m1.shapes.find((x) => x.id === 'sh:l')!;
  const ql = endNodeForLength(l, 1, 5, real)!;
  close(real(l.pts[0], ql, l.b[0]), 5, 1e-9);
  // across and up-down scales different: the length is the real one
  const xy = (a: Pt, b: Pt) => Math.hypot((b[0] - a[0]) * 0.02, (b[1] - a[1]) * 0.05);
  const slant = shape('line', [[0, 0], [30, 40]]);
  const qs = endNodeForLength(slant, 1, 3, (a, b) => xy(a, b))!;
  close(xy([0, 0], qs), 3, 1e-9);
  assert.equal(endNodeForLength(slant, 1, 3, () => null), null, 'no scale: nothing');
});

test('walls and beams as bands: the wall thickness / the beam type width, as wide in reality across and up-down', () => {
  const s = sheetStore();
  add(s, [
    ['bt:b1', 'name', 'B1'], ['bt:b1', 'w', 0.3], ['bt:b1', 'd', 0.6],
    ['bt:b2', 'name', 'B2'], ['bt:b2', 'w', 0.45], ['bt:b2', 'd', 0.7],
    ['ti:b', 'kind', 'beam'], ['ti:b', 'name', 'Beams'], ['ti:b', 'ord', 'a3'], ['ti:b', 'bt', 'bt:b1'],
    ['sh:b', 'ti', 'ti:b'], ['sh:b', 'dwg', 'd1'], ['sh:b', 'pg', 0], ['sh:b', 'k', 'line'], ['sh:b', 'p', J([0, 0, 100, 0, 100, 100])], ['sh:b', 'sg', J([null, 'bt:b2'])],
  ]);
  const m = buildQtoModel(s, null);
  const sh = (id: string) => m.shapes.find((x) => x.id === id)!;
  assert.equal(bandWidthOf(m, m.itemById.get('ti:w'), sh('sh:w'), 0), 0.2);
  assert.equal(bandWidthOf(m, m.itemById.get('ti:b'), sh('sh:b'), 0), 0.3, 'untyped segment: the take-off\'s type');
  assert.equal(bandWidthOf(m, m.itemById.get('ti:b'), sh('sh:b'), 1), 0.45, 'typed segment: its own type');
  assert.equal(bandWidthOf(m, m.itemById.get('ti:l'), sh('sh:l'), 0), null, 'a length: a line');
  // half of 0.2 m at 1:100, across a horizontal wall (up-down): 0.1 m in sheet points
  close(bandHalf(0.2, 1, 0, S100, S100), 0.1 / S100);
  // up-down at another scale: a horizontal wall's band is measured up-down
  close(bandHalf(0.2, 1, 0, 0.01, 0.02), 0.1 / 0.02);
  // the outline: 0.2 m wide everywhere, mitred at the corner (an L)
  const ring = bandOutline([[0, 0], [P(10), 0], [P(10), P(6)]], 0.1, S100, S100, false)[0];
  assert.equal(ring.length, 6);
  close(ring[0][1] - ring[5][1], 0.2 / S100 * (ring[0][1] > ring[5][1] ? 1 : -1));
  close(Math.abs(ring[0][1] - ring[5][1]) * S100, 0.2, 1e-9);
  close(Math.abs(ring[1][0] - ring[4][0]) * S100, 0.2, 1e-9);
  close(Math.abs(ring[1][1] - ring[4][1]) * S100, 0.2, 1e-9);
  // closed (a room's walls drawn as a rectangle): two rings, outside and inside
  const rect = bandOutline([[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]], 0.1, S100, S100, true);
  assert.equal(rect.length, 2);
  assert.equal(rect[0].length, 4);
  // different scales across / up-down: the band is 0.2 m both ways in reality
  const xy = bandOutline([[0, 0], [100, 0], [100, 100]], 0.1, 0.01, 0.02, false)[0];
  close(Math.abs(xy[0][1] - xy[5][1]) * 0.02, 0.2, 1e-9);
  close(Math.abs(xy[2][0] - xy[3][0]) * 0.01, 0.2, 1e-9);
});

test('clear scale: the sheet\'s own scale goes (both ways); viewports keep theirs; the shapes that would lose their quantity are counted first; one undo step', () => {
  const s = sheetStore();
  // an up-down scale too, and a viewport at 1:50 holding a count and a length of its own
  add(s, [['pg:d1.0', 'scy', S100 * 2], ['pg:d1.0', 'scyl', '1:200'], ['pg:d1.0', 'w', 2384], ['pg:d1.0', 'h', 1684],
    ['sr:v', 'dwg', 'd1'], ['sr:v', 'pg', 0], ['sr:v', 'r', J([1000, 1000, 1500, 1500])], ['sr:v', 'sc', scaleFromRatio(50)], ['sr:v', 'scl', '1:50'],
    ['ti:c', 'kind', 'count'], ['ti:c', 'name', 'Lights'], ['ti:c', 'ord', 'a4'],
    ['sh:c', 'ti', 'ti:c'], ['sh:c', 'dwg', 'd1'], ['sh:c', 'pg', 0], ['sh:c', 'k', 'pt'], ['sh:c', 'p', J([50, 50])],
    ['sh:v', 'ti', 'ti:l'], ['sh:v', 'dwg', 'd1'], ['sh:v', 'pg', 0], ['sh:v', 'k', 'line'], ['sh:v', 'p', J([1100, 1100, 1200, 1100])],
  ]);
  const m0 = buildQtoModel(s, null);
  const losing = shapesLosingScale(m0, 'd1', 0).map((x) => x.id).sort();
  assert.deepEqual(losing, ['sh:a', 'sh:l', 'sh:w'], 'the count needs no scale; the length in the viewport keeps its own');
  const ops = clearScaleOps('d1', 0);
  assert.deepEqual(ops.map((o) => o[1]).sort(), ['h', 'sc', 'scl', 'scy', 'scy0', 'scyl', 'scyl0', 'w']);
  assert.ok(ops.every((o) => o[0] === 'pg:d1.0' && o[2] === null));
  add(s, ops);
  const m1 = buildQtoModel(s, null);
  const pi = m1.pages.get('d1.0')!;
  assert.equal(pi.sc, null);
  assert.equal(pi.scy, null);
  assert.equal(m1.regions.length, 1, 'the viewport keeps its scale');
  assert.equal(m1.qty.get('ti:w')!.unscaled, 1);
  assert.equal(m1.qty.get('ti:c')!.cnt, 1);
  assert.equal(shapesLosingScale(m1, 'd1', 0).length, 0, 'nothing more to lose');
});

test('typed lengths keep their reading: 4.2 = m, 4200 = mm, 420cm', () => {
  assert.equal(parseTypedLength('4.2'), 4.2);
  assert.equal(parseTypedLength('4200'), 4.2);
  assert.equal(parseTypedLength('420cm'), 4.2);
  assert.equal(parseTypedLength('4200mm'), 4.2);
  assert.equal(parseTypedLength('42'), 42);
});

test('one list of keys: every key of the take-off is in it, the ruler on Q, M the magnifier, F8 ortho', () => {
  const all = QTO_KEY_ROWS.flatMap((r) => r.keys);
  for (const k of ['V', 'A', 'L', 'C', 'B', 'E', 'H', 'Q', 'S', 'W', 'N', 'P', 'R', 'O', 'T', 'D', 'G', 'F8', 'M', 'Shift', 'Alt+wheel', 'Shift+C', 'Esc', 'Space', 'Del', 'Home', 'PgUp', 'PgDn', '←', 'Wheel', 'Middle-drag', 'Right-drag', 'Space+drag', 'Ctrl+Z', 'Ctrl+Y', 'Backspace', 'Enter', 'Double-click', 'F2']) {
    assert.ok(all.includes(k), 'missing from the key list: ' + k);
  }
  const text = QTO_KEY_ROWS.map((r) => r.keys.join(' ') + ' ' + r.what).join('\n');
  assert.match(text, /Q[^\n]*ruler|ruler[^\n]*/i);
  assert.ok(QTO_KEY_ROWS.find((r) => r.keys.includes('M'))!.what.startsWith('Magnifier'));
  assert.ok(!QTO_KEY_ROWS.some((r) => /Ctrl\+click a (corner|node)/i.test(r.what)), 'Ctrl+click is selection only');
  assert.match(text, /Shift\+wheel|sideways/);
  assert.match(text, /does not pan/);
  assert.ok(QTO_KEYS.length >= 6);
});
