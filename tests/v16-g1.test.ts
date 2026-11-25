// v0.16 group g1: rooms ON THE DRAWING (FEEDBACK items 28-32, ROOM-SPEC.md) - the geometry the take-off view
// uses to draw and edit a room (src/engine/qto/roomdraw.ts): a length drawn along the outline, what follows an
// outline edited / moved / copied / deleted, edges toggled open / shadow gap from the drawing, what the eye
// toggles hide. Every test fails on the baseline (no roomdraw.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/engine/store';
import { buildQtoModel, type QtoModel, type Shape } from '../src/engine/qto/model';
import { scaleFromRatio, pointInPoly, type Pt } from '../src/engine/qto/geometry';
import { deleteVertexOps, insertVertexOps, moveShapesOps, setBulgeOps, shapeOps, vertexOps } from '../src/engine/qto/ops';
import { setCeilingModeOps } from '../src/engine/qto/roomops';
import { edgeFlags } from '../src/engine/qto/rooms';
import {
  alongOutline, copyWithRoomsOps, deleteShapesOps, edgeAt, edgeFlagFits, edgeToggleOps, hiddenWithRooms, insideNormal, insideSign,
  isRoomOutline, nearestOutline, outlineFollowOps, projectOnOutline, roomDoorRefusal, roomOutlines, tagText, withAttached,
} from '../src/engine/qto/roomdraw';
import { exportQto } from '../src/engine/qto/export';
import { readXlsx } from '../src/engine/xlsx';
import type { Op, Batch } from '../src/engine/types';

let seq = 0;
const batch = (ops: Op[], u = 'T'): Batch => { seq++; return { s: String(seq).padStart(10, '0') + '~' + u, w: 'w' + u, u, t: seq, o: ops } as Batch; };
const apply = (st: Store, ops: Op[], u = 'T') => { st.apply(batch(ops, u)); return st; };
const close = (a: unknown, b: number, msg = '', eps = 1e-6) => assert.ok(typeof a === 'number' && Math.abs(a - b) < eps, `${msg} ${a} != ${b}`);
const S = scaleFromRatio(100);
const P = (x: number) => x / S;
const M = (p: Pt): Pt => [p[0] * S, p[1] * S];
const J = JSON.stringify;
const rectPts = (x0: number, y0: number, w: number, h: number) => J([P(x0), P(y0), P(x0 + w), P(y0), P(x0 + w), P(y0 + h), P(x0), P(y0 + h)]);
const shape = (id: string, ti: string, k: 'poly' | 'line', p: string, dwg = 'd1'): Op[] => [[id, 'ti', ti], [id, 'dwg', dwg], [id, 'pg', 0], [id, 'k', k], [id, 'p', p]];
const room = (id: string, name: string, f: Record<string, unknown> = {}): Op[] => [[id, 'kind', 'room'], [id, 'name', name], [id, 'ord', 'a0'], ...Object.entries(f).map(([k, v]) => [id, k, v] as Op)];
const door = (id: string, sh: string, x: number, y: number, ds = 'ds:d1'): Op[] => [[id, 'sh', sh], [id, 'x', P(x)], [id, 'y', P(y)], [id, 'k', 'door'], [id, 'door', ds]];
const opening = (id: string, sh: string, x: number, y: number, w: number, h: number, sill: number): Op[] => [[id, 'sh', sh], [id, 'x', P(x)], [id, 'y', P(y)], [id, 'k', 'open'], [id, 'w', w], [id, 'h', h], [id, 'sill', sill]];
const part = (id: string, rm: string, cat: string, f: Record<string, unknown> = {}, rk = 'add'): Op[] => [[id, 'kind', cat === 'wall' || cat === 'skirting' ? 'line' : 'area'], [id, 'name', String(f.name ?? 'Additional')], [id, 'rm', rm], [id, 'rk', rk], [id, 'rcat', cat], ...Object.entries(f).filter(([k]) => k !== 'name').map(([k, v]) => [id, k, v] as Op)];
const base: Op[] = [['pg:d1.0', 'sc', S], ['pg:d2.0', 'sc', S], ['ds:d1', 'tag', 'D1'], ['ds:d1', 'sw', 0.9], ['ds:d1', 'sh', 2.1]];
const qty = (m: QtoModel, rid: string, key: string) => m.fin.qty.get(rid)!.byKey.get(key)?.qty;
const sh = (m: QtoModel, id: string) => m.shapes.find((s) => s.id === id)!;
/** length of a polyline in metres (1:100) */
const lenM = (pts: Pt[]) => pts.reduce((a, p, i) => (i ? a + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) * S : 0), 0);

/** ROOM-SPEC section 9 Master Bedroom: 5 × 4, door D1 on the bottom edge, window W1 sill 0.9 on the top edge */
const bedroom = (): Op[] => [
  ...room('ti:r1', 'Master Bedroom', { fc: 'FL-02', wc: 'PT-08', hw: 3, kc: 'SK-01', hs: 0.1, cc: 'CL-01' }),
  ...shape('sh:o', 'ti:r1', 'poly', rectPts(0, 0, 5, 4)),
  ...door('op:d', 'sh:o', 1, 0),
  ...opening('op:w', 'sh:o', 2.5, 4, 1.5, 1.5, 0.9),
];

test('a length drawn for an additional wall finish runs ALONG the outline: projected onto it, round its corners, the short way round', () => {
  const m = buildQtoModel(apply(new Store(), [...base, ...bedroom()]), null);
  const o = sh(m, 'sh:o');
  // roughly along the bottom edge (a little off it): onto it, 3.00 m
  const a = alongOutline(o, [[P(1), P(0.12)], [P(4), P(-0.08)]])!;
  close(lenM(a), 3, 'along the bottom');
  for (const p of a) close(projectOnOutline(o, p).d, 0, 'on the outline');
  // from the bottom edge round the corner up the right edge: the corner node is put in (1 + 2 = 3.00, not the diagonal)
  const b = alongOutline(o, [[P(4), P(0.05)], [P(4.95), P(2)]])!;
  assert.equal(b.length, 3);
  close(lenM(b), 3, 'round the corner');
  assert.deepEqual(M(b[1]).map((x) => Math.round(x * 1000) / 1000), [5, 0]);
  // across the outline's first node, the short way: left edge (0,1) to bottom edge (1,0) = 2.00 (not 16.00)
  close(lenM(alongOutline(o, [[P(0), P(1)], [P(1), P(0)]])!), 2, 'short way round');
  // nothing (every node on one spot)
  assert.equal(alongOutline(o, [[P(2), P(0)], [P(2), P(0.01)]]), null);
  // the whole thing drawn into a wallpaper: the engine deducts exactly it (ROOM-SPEC wallpaper 4.00 × 2.90 = 11.60)
  const pts = alongOutline(o, [[P(5.1), P(0)], [P(5.05), P(4)]])!;
  const st = apply(new Store(), [...base, ...bedroom(), ...part('ti:wp', 'ti:r1', 'wall', { name: 'Wallpaper', fcode: 'WP-03', h: 2.9, bl: 0.1 }), ...shape('sh:wp', 'ti:wp', 'line', J(pts.flat()))]);
  const m2 = buildQtoModel(st, null);
  close(qty(m2, 'ti:r1', 'ti:wp'), 11.6, 'wallpaper');
  close(qty(m2, 'ti:r1', 'wall'), 36.55, 'main paint');
  assert.ok(!m2.fin.qty.get('ti:r1')!.flags.includes('offOutline'));
});

test('a length along an arc edge follows the arc; the nearest outline of a room with two', () => {
  // a 4 × 4 room whose right edge is a half circle (bulge 1)
  const st = apply(new Store(), [...base, ...room('ti:r', 'Hall', { wc: 'PT', hw: 3 }), ...shape('sh:a', 'ti:r', 'poly', rectPts(0, 0, 4, 4)), ['sh:a', 'b', J([0, 1, 0, 0])],
    ...shape('sh:b', 'ti:r', 'poly', rectPts(10, 0, 2, 2))]);
  const m = buildQtoModel(st, null);
  const o = sh(m, 'sh:a');
  const a = alongOutline(o, [[P(4), P(0)], [P(4), P(4)]])!;
  // the half circle of a 4.00 chord: π × 2 = 6.283 (the fine pieces of the arc)
  assert.ok(Math.abs(lenM(a) - Math.PI * 2) < 0.01, 'along the arc ' + lenM(a));
  assert.equal(nearestOutline(roomOutlines(m, 'ti:r', 'd1', 0), [[P(10.5), P(0)], [P(11.5), P(0)]])!.id, 'sh:b');
  assert.equal(nearestOutline(roomOutlines(m, 'ti:r', 'd1', 0), [[P(1), P(0)], [P(2), P(0)]])!.id, 'sh:a');
});

test('editing a room outline: its doors / openings and the lengths drawn along it keep their place (node moved, node deleted, arc)', () => {
  const st = apply(new Store(), [...base, ...bedroom(),
    ...part('ti:wp', 'ti:r1', 'wall', { name: 'Wallpaper', fcode: 'WP-03', h: 2.9, bl: 0.1 }), ...shape('sh:wp', 'ti:wp', 'line', J([P(5), P(0), P(5), P(4)])),
    // (a plain area take-off nearby: never touched)
    ['ti:x', 'kind', 'line'], ['ti:x', 'name', 'Other'], ...shape('sh:x', 'ti:x', 'line', J([P(5), P(0), P(6), P(0)]))]);
  let m = buildQtoModel(st, null);
  // node 1 (5,0) dragged to (6,0): the bottom edge is 6 long - the door stays a fifth of the way along it
  const o = sh(m, 'sh:o');
  const follow = outlineFollowOps(m, o, { k: 'move', idx: 1, p: [P(6), P(0)] });
  assert.ok(!follow.some((x) => x[0] === 'sh:x'), 'other take-offs are not touched');
  assert.ok(!follow.some((x) => x[0] === 'op:w'), 'the window on the top edge does not move');
  apply(st, [...vertexOps(o, 0, 1, [P(6), P(0)]), ...follow]);
  m = buildQtoModel(st, null);
  const d = m.roomOpenings.find((x) => x.id === 'op:d')!;
  close(d.x * S, 1.2, 'door x', 1e-3); close(d.y * S, 0, 'door y', 1e-3);
  // the wallpaper's foot went with the node: it still lies on the outline, its length is the new right edge
  const wp = sh(m, 'sh:wp');
  close(M(wp.pts[0])[0], 6, 'wallpaper foot', 1e-3);
  const right = Math.hypot(1, 4);
  close(qty(m, 'ti:r1', 'ti:wp'), right * 2.9, 'wallpaper on the slanted edge', 1e-4);
  assert.ok(!m.fin.qty.get('ti:r1')!.flags.includes('offOutline'));
  // the door is still deducted from the skirting (it sits on its edge)
  close(qty(m, 'ti:r1', 'skirting'), 6 + right + 5 + 4 - 0.9, 'skirting', 1e-4);

  // an arc on the top edge: the window goes onto the arc (still on its edge, still deducted)
  const o2 = sh(m, 'sh:o');
  apply(st, [...setBulgeOps(o2, 2, 0.4), ...outlineFollowOps(m, o2, { k: 'bulge', seg: 2, b: 0.4 })]);
  m = buildQtoModel(st, null);
  const w = m.roomOpenings.find((x) => x.id === 'op:w')!;
  assert.equal(w.seg, 2);
  assert.ok(projectOnOutline(sh(m, 'sh:o'), [w.x, w.y]).d * S < 0.02, 'window on the arc');

  // node 1 deleted: the bottom and right edges become one - the door keeps its share of the way along it
  const o3 = sh(m, 'sh:o');
  const f3 = outlineFollowOps(m, o3, { k: 'delete', idx: 1 });
  apply(st, [...deleteVertexOps(o3, 0, 1), ...f3]);
  m = buildQtoModel(st, null);
  const d3 = m.roomOpenings.find((x) => x.id === 'op:d')!;
  assert.equal(d3.seg, 0);
  assert.ok(projectOnOutline(sh(m, 'sh:o'), [d3.x, d3.y]).d * S < 0.005, 'door on the new edge');
  // inserting a node changes no edge: nothing follows
  assert.deepEqual(outlineFollowOps(m, sh(m, 'sh:wp'), { k: 'move', idx: 0, p: [0, 0] }), [], 'not a room outline: nothing');
});

test('moving / copying / deleting a room outline takes its doors, openings (sill kept) and its own finishes with it', () => {
  const st = apply(new Store(), [...base, ...bedroom(),
    ...part('ti:wp', 'ti:r1', 'wall', { name: 'Wallpaper', h: 2.9, bl: 0.1 }), ...shape('sh:wp', 'ti:wp', 'line', J([P(5), P(0), P(5), P(4)])),
    ...part('ti:fc', 'ti:r1', 'ceiling', { name: 'False ceiling', rded: false }), ...shape('sh:fc', 'ti:fc', 'poly', rectPts(1, 1, 2, 2))]);
  let m = buildQtoModel(st, null);
  const before = { wall: qty(m, 'ti:r1', 'wall')!, wp: qty(m, 'ti:r1', 'ti:wp')!, fc: qty(m, 'ti:r1', 'ti:fc')!, sk: qty(m, 'ti:r1', 'skirting')! };
  assert.deepEqual(withAttached(m, [sh(m, 'sh:o')]).map((s) => s.id).sort(), ['sh:fc', 'sh:o', 'sh:wp']);
  // moved 10 m to the right: the same figures
  apply(st, moveShapesOps(withAttached(m, [sh(m, 'sh:o')]), P(10), 0, m.openingsByShape));
  m = buildQtoModel(st, null);
  for (const [k, v] of Object.entries({ wall: before.wall, 'ti:wp': before.wp, 'ti:fc': before.fc, skirting: before.sk })) close(qty(m, 'ti:r1', k), v, 'moved ' + k, 1e-4);
  close(sh(m, 'sh:wp').pts[0][0] * S, 15, 'wallpaper moved', 1e-3);
  // copied to another sheet: a second outline of the room with its door, window (sill 0.9) and finishes
  const c = copyWithRoomsOps(m, [sh(m, 'sh:o')], { dwg: 'd2', pg: 0 }, 'T');
  assert.equal(c.ids.length, 3);
  apply(st, c.ops);
  m = buildQtoModel(st, null);
  assert.equal(m.roomOpenings.length, 4);
  assert.ok(m.roomOpenings.some((o) => o.sh === c.ids[0] && o.k === 'open' && o.sill === 0.9));
  assert.equal(m.openings.length, 0, 'never wall openings');
  close(qty(m, 'ti:r1', 'wall'), before.wall * 2, 'two outlines', 1e-3); close(qty(m, 'ti:r1', 'ti:wp'), before.wp * 2, 'wallpaper ×2', 1e-3);
  // deleting the copy's outline takes its door, window and the finishes drawn with it
  const del = deleteShapesOps(m, [c.ids[0]]);
  const gone = new Set(del.map((x) => x[0]));
  for (const id of c.ids) assert.ok(gone.has(id));
  assert.equal(m.roomOpenings.filter((o) => gone.has(o.id)).length, 2);
  assert.ok(!gone.has('sh:o') && !gone.has('op:d') && !gone.has('ti:r1'), 'the room and its first outline stay');
  apply(st, del);
  m = buildQtoModel(st, null);
  close(qty(m, 'ti:r1', 'wall'), before.wall, 'back to one', 1e-3);
  // a plain shape: just itself
  assert.deepEqual(deleteShapesOps(m, ['sh:wp']), [['sh:wp', 'del', true]]);
});

test('edges toggled from the drawing: open edge (not with a door on it), shadow gap (the room turns to picked edges); ceiling areas take a shadow gap only', () => {
  const st = apply(new Store(), [...base, ...bedroom(), ['ti:r1', 'gc', 'SG-01'], ['ti:r1', 'gm', 'all']]);
  let m = buildQtoModel(st, null);
  close(m.fin.qty.get('ti:r1')!.P, 18);
  // the bottom edge has the door: refused
  const r0 = edgeToggleOps(m, sh(m, 'sh:o'), 0, 'open');
  assert.ok('error' in r0 && /door/.test(r0.error));
  // the right edge (4.00) open: P 14, wall finish and skirting drop
  const wall0 = qty(m, 'ti:r1', 'wall')!;
  const r1 = edgeToggleOps(m, sh(m, 'sh:o'), 1, 'open');
  assert.ok('ops' in r1 && r1.on);
  apply(st, r1.ops);
  m = buildQtoModel(st, null);
  close(m.fin.qty.get('ti:r1')!.P, 14, 'P', 1e-4);
  close(qty(m, 'ti:r1', 'wall'), wall0 - 4 * 2.9, 'wall finish', 1e-4);
  assert.ok(edgeFlags(sh(m, 'sh:o').sg[1]).open);
  // a door clicked onto the open edge is refused (said at the click)
  assert.match(roomDoorRefusal(m, 'sh:o', [P(5), P(2)]) ?? '', /open/);
  assert.equal(roomDoorRefusal(m, 'sh:o', [P(0), P(2)]), null);
  // and back
  const r2 = edgeToggleOps(m, sh(m, 'sh:o'), 1, 'open');
  assert.ok('ops' in r2 && !r2.on);
  apply(st, r2.ops);
  m = buildQtoModel(st, null);
  close(m.fin.qty.get('ti:r1')!.P, 18, 'P back', 1e-4);
  // a shadow gap on the left edge: the room's shadow gap turns from "entire perimeter" to the edges picked
  close(qty(m, 'ti:r1', 'gap'), 18, 'entire', 1e-4);
  const g = edgeToggleOps(m, sh(m, 'sh:o'), 3, 'gap');
  assert.ok('ops' in g && g.ops.some((x) => x[0] === 'ti:r1' && x[1] === 'gm' && x[2] === 'pick'));
  apply(st, g.ops);
  m = buildQtoModel(st, null);
  close(qty(m, 'ti:r1', 'gap'), 4, 'picked', 1e-4);
  // a manual ceiling area: its edges take a shadow gap, never "open"; a floor area takes neither
  const cm = setCeilingModeOps(m, 'T', 'ti:r1', 'manual');
  apply(st, [...cm.ops, ...shapeOps(cm.ceil!, 'd1', 0, 'poly', [[P(0), P(0)], [P(5), P(0)], [P(5), P(4)], [P(0), P(4)]], 'T').ops,
    ...part('ti:fl', 'ti:r1', 'floor', { name: 'Shower tiles' }), ...shape('sh:fl', 'ti:fl', 'poly', rectPts(0, 0, 1, 1))]);
  m = buildQtoModel(st, null);
  const ceil = m.shapesByItem.get(cm.ceil!)![0];
  assert.ok(edgeFlagFits(m, ceil, 'gap') && !edgeFlagFits(m, ceil, 'open'));
  assert.ok(!edgeFlagFits(m, sh(m, 'sh:fl'), 'gap'));
  assert.ok('error' in edgeToggleOps(m, ceil, 0, 'open'));
  const g2 = edgeToggleOps(m, ceil, 1, 'gap');
  assert.ok('ops' in g2);
  apply(st, g2.ops);
  m = buildQtoModel(st, null);
  close(qty(m, 'ti:r1', 'gap'), 8, 'outline 4 + ceiling 4', 1e-4);
  // picking: the edge under the pointer, of the shapes being picked
  const hit = edgeAt([sh(m, 'sh:o')], [P(2.5), P(4.05)], P(0.2))!;
  assert.equal(hit.seg, 2);
  assert.equal(edgeAt([sh(m, 'sh:o')], [P(2.5), P(2)], P(0.2)), null);
});

test('the flags are not tags: tagText; the inside of an outline whichever way it was drawn', () => {
  assert.equal(tagText('~o'), null);
  assert.equal(tagText('~g~o'), null);
  assert.equal(tagText('W1~g'), 'W1');
  assert.equal(tagText(null), null);
  for (const pts of [[[0, 0], [10, 0], [10, 5], [0, 5]], [[0, 0], [0, 5], [10, 5], [10, 0]]] as Pt[][]) {
    const s = { flat: pts } as Pick<Shape, 'flat'>;
    const k = insideSign(s);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const n = insideNormal(s, a, b, k);
      const mid: Pt = [(a[0] + b[0]) / 2 + n[0] * 0.5, (a[1] + b[1]) / 2 + n[1] * 0.5];
      assert.ok(pointInPoly(mid, pts), 'inside, edge ' + i);
    }
  }
});

test('the eye toggles: a room hidden hides its own finishes; a finish can be hidden on its own', () => {
  const st = apply(new Store(), [...base, ...bedroom(), ...part('ti:wp', 'ti:r1', 'wall'), ...shape('sh:wp', 'ti:wp', 'line', J([P(5), P(0), P(5), P(4)]))]);
  const m = buildQtoModel(st, null);
  const none = { items: new Set<string>(), heads: new Set<string>() };
  assert.deepEqual([...hiddenWithRooms(m, new Set(), none)], []);
  assert.deepEqual([...hiddenWithRooms(m, new Set(['ti:r1']), { items: new Set(['ti:r1']), heads: new Set() })].sort(), ['ti:r1', 'ti:wp']);
  assert.deepEqual([...hiddenWithRooms(m, new Set(), { items: new Set(['ti:wp']), heads: new Set() })], ['ti:wp']);
  assert.ok(isRoomOutline(m, sh(m, 'sh:o')) && !isRoomOutline(m, sh(m, 'sh:wp')));
});

test('room doors / openings stay out of every door count, the door schedule and the wall lists of the export', () => {
  const st = apply(new Store(), [...base, ...bedroom(), ['ti:w', 'kind', 'wall'], ['ti:w', 'name', 'Block 200'], ['ti:w', 'h', 3], ...shape('sh:w', 'ti:w', 'line', J([P(20), P(0), P(30), P(0)])), ...door('op:wd', 'sh:w', 22, 0)]);
  const m = buildQtoModel(st, null);
  assert.deepEqual(m.openings.map((o) => o.id), ['op:wd']);
  assert.deepEqual(m.roomOpenings.map((o) => o.id).sort(), ['op:d', 'op:w']);
  assert.equal(m.doorCount.get('ds:d1'), 1, 'one door counted: the wall one');
  const wb = readXlsx(exportQto(m, { project: 'P', by: 'T', when: new Date(0) }));
  // the export's door / opening list: the wall's door only
  assert.equal([...wb.sheet('Openings').rows.keys()].filter((r) => r > 4).length, 1);
});
