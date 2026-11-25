import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/engine/store';
import { buildQtoModel, type QtoModel } from '../src/engine/qto/model';
import { scaleFromRatio } from '../src/engine/qto/geometry';
import { roomWorking, roomTree } from '../src/engine/qto/rooms';
import { attachedShapes, newRoomOps, setRoomOps, setEdgeOps, roomOpeningOps, addFinishOps, linkToRoomOps, unlinkFromRoomOps, setFinishCodeOps, setCeilingModeOps, setWaterproofingOps, setShadowGapOps, setFinishPartOps } from '../src/engine/qto/roomops';
import { summarize, portionLinkOps, rowPredicate, saveBreakdownOps, codeTotals, canonicalCode, suggestCodes, needsFormatFinishes, type FinRow } from '../src/engine/qto/finishes';
import { deleteItemOps, duplicateItemOps, insertVertexOps, linkOps } from '../src/engine/qto/ops';
import { exportQto } from '../src/engine/qto/export';
import { readXlsx } from '../src/engine/xlsx';
import { roundQty } from '../src/engine/qto/bridge';
import type { Op, Batch } from '../src/engine/types';

let seq = 0;
const batch = (ops: Op[], u = 'T'): Batch => { seq++; return { s: String(seq).padStart(10, '0') + '~' + u, w: 'w' + u, u, t: seq, o: ops } as Batch; };
const apply = (st: Store, ops: Op[], u = 'T') => { st.apply(batch(ops, u)); return st; };
const close = (a: unknown, b: number, msg = '', eps = 1e-9) => assert.ok(typeof a === 'number' && Math.abs(a - b) < eps, `${msg} ${a} != ${b}`);
const S = scaleFromRatio(100);
const P = (x: number) => x / S;
const J = JSON.stringify;
/** a rectangle outline x0,y0 w × h (m at 1:100): segment 0 bottom (x0 -> x0+w), 1 right, 2 top, 3 left */
const rectPts = (x0: number, y0: number, w: number, h: number) => J([P(x0), P(y0), P(x0 + w), P(y0), P(x0 + w), P(y0 + h), P(x0), P(y0 + h)]);
const shape = (id: string, ti: string, k: 'poly' | 'line', p: string, dwg = 'd1'): Op[] => [[id, 'ti', ti], [id, 'dwg', dwg], [id, 'pg', 0], [id, 'k', k], [id, 'p', p]];
const room = (id: string, name: string, f: Record<string, unknown> = {}, ord = 'a0'): Op[] => [[id, 'kind', 'room'], [id, 'name', name], [id, 'ord', ord], ...Object.entries(f).map(([k, v]) => [id, k, v] as Op)];
const door = (id: string, sh: string, x: number, y: number, ds = 'ds:d1'): Op[] => [[id, 'sh', sh], [id, 'x', P(x)], [id, 'y', P(y)], [id, 'k', 'door'], [id, 'door', ds]];
const opening = (id: string, sh: string, x: number, y: number, w: number, h: number, sill: number, tag = ''): Op[] => [[id, 'sh', sh], [id, 'x', P(x)], [id, 'y', P(y)], [id, 'k', 'open'], [id, 'w', w], [id, 'h', h], [id, 'sill', sill], ...(tag ? [[id, 'tag', tag] as Op] : [])];
const part = (id: string, rm: string, cat: string, f: Record<string, unknown> = {}): Op[] => [[id, 'kind', cat === 'wall' || cat === 'skirting' ? 'line' : 'area'], [id, 'name', String(f.name ?? 'Additional')], [id, 'rm', rm], [id, 'rk', 'add'], [id, 'rcat', cat], ...Object.entries(f).filter(([k]) => k !== 'name').map(([k, v]) => [id, k, v] as Op)];
const base: Op[] = [['pg:d1.0', 'sc', S], ['ds:d1', 'tag', 'D1'], ['ds:d1', 'sw', 0.9], ['ds:d1', 'sh', 2.1], ['ds:d2', 'tag', 'D2'], ['ds:d2', 'sw', 0.8], ['ds:d2', 'sh', 2.1]];
const fq = (m: QtoModel, rid: string, key: string) => m.fin.qty.get(rid)!.byKey.get(key);
const qty = (m: QtoModel, rid: string, key: string) => fq(m, rid, key)?.qty;

/** Master Bedroom of ROOM-SPEC section 9 (door on the bottom edge, window on the top one) */
const bedroom = (id = 'ti:r1', x0 = 0, extra: Record<string, unknown> = {}): Op[] => [
  ...room(id, 'Master Bedroom', { desc: 'Type A apartment', fc: 'FL-02', wc: 'PT-08', hw: 3, kc: 'SK-01', hs: 0.1, cc: 'CL-01', gc: 'SG-01', gm: 'all', ...extra }),
  ...shape('sh:' + id.slice(3) + 'o', id, 'poly', rectPts(x0, 0, 5, 4)),
  ...door('op:' + id.slice(3) + 'd', 'sh:' + id.slice(3) + 'o', x0 + 1, 0),
  ...opening('op:' + id.slice(3) + 'w', 'sh:' + id.slice(3) + 'o', x0 + 2.5, 4, 1.5, 1.5, 0.9, 'W1'),
];


// ---------------------------------------------------------------- reviewer c1: own numbers
/** Room 6 × 3 (P 18, A 18), Hw 2.40, Hs 0.15; D1 0.90 × 2.10 on the bottom edge at x 1 (0.55..1.45);
 *  arch 1.20 × 2.40 sill 0 on the right edge; high window 1.00 × 0.50 sill 2.00 on the top edge */
const r6 = (extra: Record<string, unknown> = {}): Op[] => [
  ...room('ti:r', 'Living', { fc: 'FL', wc: 'PT', hw: 2.4, kc: 'SK', hs: 0.15, cc: 'CL', ...extra }),
  ...shape('sh:r', 'ti:r', 'poly', rectPts(0, 0, 6, 3)),
  ...door('op:d', 'sh:r', 1, 0),
  ...opening('op:a', 'sh:r', 6, 1.5, 1.2, 2.4, 0, 'A1'),
  ...opening('op:w', 'sh:r', 3, 3, 1.0, 0.5, 2.0, 'W1'),
];
const W0 = 18 * 2.25 - 0.9 * 1.95 - 1.2 * 2.25 - 1.0 * 0.4; // 35.645

test('c1: main wall / skirting with a door, a floor-level arch and a high window', () => {
  const m = buildQtoModel(apply(new Store(), [...base, ...r6()]), null);
  close(qty(m, 'ti:r', 'wall'), W0, 'wall');
  close(qty(m, 'ti:r', 'skirting'), 18 - 0.9 - 1.2, 'skirting');
  // an opening with its sill inside the skirting (0.10 < 0.15) comes off the skirting too
  const m2 = buildQtoModel(apply(apply(new Store(), [...base, ...r6()]), [['op:w', 'sill', 0.1]]), null);
  close(qty(m2, 'ti:r', 'skirting'), 18 - 0.9 - 1.2 - 1.0, 'skirting low sill');
  close(qty(m2, 'ti:r', 'wall'), 18 * 2.25 - 0.9 * 1.95 - 1.2 * 2.25 - 1.0 * 0.45, 'wall low sill');
});

test('c1: two overlapping additional wall finishes, a door on one, deduct on - nothing taken twice', () => {
  const m = buildQtoModel(apply(new Store(), [...base, ...r6(),
    ...part('ti:s', 'ti:r', 'wall', { name: 'Splash', fcode: 'TL', h: 0.6, bl: 0.9 }), ...shape('sh:s', 'ti:s', 'line', J([P(0), P(0), P(3), P(0)])),
    ...part('ti:c', 'ti:r', 'wall', { name: 'Clad', fcode: 'CD', h: 1.2, bl: 0 }), ...shape('sh:c', 'ti:c', 'line', J([P(2), P(0), P(5), P(0)])),
  ]), null);
  close(qty(m, 'ti:r', 'ti:s'), 3 * 0.6 - 0.9 * 0.6, 'splash own', 1e-6);
  close(qty(m, 'ti:r', 'ti:c'), 3 * 1.2, 'clad own', 1e-6);
  close(qty(m, 'ti:r', 'wall'), W0 - (1.2 + 1.35 + 2.1 - 0.54), 'main', 1e-6);
  // deduct off on the cladding: only the splashback comes off
  const m2 = buildQtoModel(apply(new Store(), [...base, ...r6(),
    ...part('ti:s', 'ti:r', 'wall', { name: 'Splash', fcode: 'TL', h: 0.6, bl: 0.9 }), ...shape('sh:s', 'ti:s', 'line', J([P(0), P(0), P(3), P(0)])),
    ...part('ti:c', 'ti:r', 'wall', { name: 'Clad', fcode: 'CD', h: 1.2, bl: 0, rded: false }), ...shape('sh:c', 'ti:c', 'line', J([P(2), P(0), P(5), P(0)])),
  ]), null);
  close(qty(m2, 'ti:r', 'wall'), W0 - 1.26, 'main, cladding on top', 1e-6);
});

test('c1: additional skirting partly over the door; waterproofing both modes; Times 3', () => {
  const m = buildQtoModel(apply(new Store(), [...base, ...r6({ x: 3, pc: 'WP', pm: 'full', pl: 1.8 }),
    ...part('ti:k', 'ti:r', 'skirting', { name: 'Steel skirting', fcode: 'SS', h: 0.15 }), ...shape('sh:k', 'ti:k', 'line', J([P(1), P(0), P(3), P(0)])),
  ]), null);
  close(qty(m, 'ti:r', 'ti:k'), (2 - 0.45) * 3, 'add skirting', 1e-6);
  close(qty(m, 'ti:r', 'skirting'), (15.9 - 1.55) * 3, 'main skirting', 1e-6);
  close(qty(m, 'ti:r', 'wpv'), (18 * 1.8 - 0.9 * 1.8 - 1.2 * 1.8) * 3, 'wp full', 1e-6);
  close(qty(m, 'ti:r', 'wph'), 18 * 3, 'wp h', 1e-6);
  const m2 = buildQtoModel(apply(new Store(), [...base, ...r6({ pc: 'WP', pm: 'up', pu: 0.3 })]), null);
  close(qty(m2, 'ti:r', 'wpv'), 18 * 0.3 - 0.9 * 0.3 - 1.2 * 0.3, 'wp up', 1e-6);
});

import { outlineFollowOps } from '../src/engine/qto/roomdraw';
/** 4 × 3 with the top edge (seg 2, (4,3) -> (0,3)) a half circle bulging out: R 2, centre (2,3) */
const arcRoom = (bu: number, extra: Op[] = []): Op[] => [...base,
  ...room('ti:c', 'Majlis', { wc: 'PT', hw: 3, kc: 'SK', hs: 0.1 }),
  ...shape('sh:c', 'ti:c', 'poly', rectPts(0, 0, 4, 3)), ['sh:c', 'b', J([0, 0, bu, 0])], ...extra];
const onArc = (deg: number): [number, number] => [2 + 2 * Math.cos((deg * Math.PI) / 180), 3 + 2 * Math.sin((deg * Math.PI) / 180)];

test('c1: a curved wall - an additional finish along part of the arc, a door off its middle; a node moved keeps the door on its place of the arc', () => {
  // which sign bulges out (A = 12 + 2π)
  let bu = 1;
  if (Math.abs(buildQtoModel(apply(new Store(), arcRoom(1)), null).fin.qty.get('ti:c')!.A - (12 + 2 * Math.PI)) > 1e-3) bu = -1;
  const [x45, y45] = onArc(45), [x135, y135] = onArc(135);
  const st = apply(new Store(), arcRoom(bu, [
    ...part('ti:a', 'ti:c', 'wall', { name: 'Cladding', fcode: 'CD', h: 1, bl: 0.1 }), ...shape('sh:a', 'ti:a', 'line', J([P(4), P(3), P(x45), P(y45)])),
    ...part('ti:k', 'ti:c', 'skirting', { name: 'Marble skirting', fcode: 'MS' }), ...shape('sh:k', 'ti:k', 'line', J([P(x135), P(y135), P(0), P(3)])),
    ...door('op:d', 'sh:c', x135, y135),
  ]));
  const m = buildQtoModel(st, null);
  const q = m.fin.qty.get('ti:c')!;
  close(q.A, 12 + 2 * Math.PI, 'A', 1e-3); close(q.P, 10 + 2 * Math.PI, 'P', 1e-3);
  // a quarter of the half circle: π/2 long
  close(qty(m, 'ti:c', 'ti:a'), Math.PI / 2, 'cladding along 45° of the arc', 1e-3);
  // the last 45° of the arc (π/2) with the door (0.90, centred on 135°) half on it: π/2 − 0.45
  close(qty(m, 'ti:c', 'ti:k'), Math.PI / 2 - 0.45, 'skirting along the last 45°, half the door off', 1e-3);
  // a node of the arc moved a little: the door stays where it was on the arc (not slid to its end)
  const s = m.shapes.find((x) => x.id === 'sh:c')!;
  const ops = outlineFollowOps(m, s, { k: 'move', idx: 3, p: [P(-0.02), P(3)] });
  const nx = ops.find((o) => o[0] === 'op:d' && o[1] === 'x')?.[2] as number | undefined, ny = ops.find((o) => o[0] === 'op:d' && o[1] === 'y')?.[2] as number | undefined;
  const moved = Math.hypot(((nx ?? P(x135)) - P(x135)) * S, ((ny ?? P(y135)) - P(y135)) * S);
  assert.ok(moved < 0.05, 'door moved ' + moved.toFixed(3) + ' m');
});

import { ownership } from '../src/engine/qto/owners';
test('c1: a room drawn by one QS - another QS may not change its heights, Times, finishes or links (view only); an estimator who may becomes a joint owner', () => {
  const st = apply(new Store(), [...base, ...r6(), ['ti:r', 'owner', 'qs.a'], ['sh:r', 'by', 'qs.a'],
    ...part('ti:s', 'ti:r', 'wall', { name: 'Splash', fcode: 'TL', h: 0.6, bl: 0.9, owner: 'qs.a' }), ...shape('sh:s', 'ti:s', 'line', J([P(0), P(0), P(3), P(0)])), ['sh:s', 'by', 'qs.a'],
    // qs.b's own area, and his own room
    ['ti:t', 'kind', 'area'], ['ti:t', 'name', 'Tiles'], ['ti:t', 'owner', 'qs.b'], ['ti:t', 'fcode', 'FT'], ...shape('sh:t', 'ti:t', 'poly', rectPts(0, 0, 1, 1)), ['sh:t', 'by', 'qs.b'],
    ...room('ti:rb', 'Store', { fc: 'FL' }), ['ti:rb', 'owner', 'qs.b'], ...shape('sh:rb', 'ti:rb', 'poly', rectPts(10, 0, 2, 2)), ['sh:rb', 'by', 'qs.b'],
  ]);
  const m = buildQtoModel(st, null);
  const locked = (ops: Op[], who = 'qs.b', may = false) => ownership(m, ops, who, may).locked.map((s) => s.id);
  assert.deepEqual(locked(setRoomOps(m, 'ti:r', { hw: 3 })), ['sh:r'], 'wall height');
  assert.deepEqual(locked([['ti:r', 'x', 4]]), ['sh:r'], 'Times');
  assert.deepEqual(locked(setFinishPartOps(m, 'ti:s', { deduct: false })), ['sh:r'], 'an additional finish of it');
  assert.deepEqual(locked(addFinishOps(m, 'qs.b', 'ti:r', 'ceiling', { full: true })!.ops), ['sh:r'], 'a new additional finish in it');
  const lk = linkToRoomOps(m, 'ti:t', 'ti:r', 'floor');
  assert.ok('ops' in lk);
  assert.deepEqual(locked(lk.ops), ['sh:r'], 'his take-off linked to it (comes off its floor)');
  // his own room, his own take-off's code: free
  assert.deepEqual(locked(setRoomOps(m, 'ti:rb', { hw: 3 })), []);
  assert.deepEqual(locked([['ti:t', 'fcode', 'FT-2']]), []);
  // (v0.16.3: the room's name is NOT free any more - a Finishes Summary link may pick rooms by their name, so a
  // rename moves the room's quantities out of it; the fresh-eyes review showed 54 m² leaving the BOQ that way)
  assert.deepEqual(locked([['ti:r', 'name', 'Living room']]), ['sh:r']);
  // its owner: free; an estimator with "Edit other people's shapes" on: a joint owner of the outline
  assert.deepEqual(locked(setRoomOps(m, 'ti:r', { hw: 3 }), 'qs.a'), []);
  assert.deepEqual(ownership(m, setRoomOps(m, 'ti:r', { hw: 3 }), 'est.c', true).ops, [['sh:r', 'co:est.c', true]]);
});

test('c1: two deducted additional ceilings drawn over the same part of the room are flagged (the main would lose that area twice); side by side they are not', () => {
  const mk = (x2: number) => buildQtoModel(apply(new Store(), [...base, ...r6(),
    ...part('ti:g1', 'ti:r', 'ceiling', { name: 'Gypsum', fcode: 'GY' }), ...shape('sh:g1', 'ti:g1', 'poly', rectPts(0, 0, 2, 3)),
    ...part('ti:g2', 'ti:r', 'ceiling', { name: 'MR gypsum', fcode: 'MR' }), ...shape('sh:g2', 'ti:g2', 'poly', rectPts(x2, 0, 2, 3)),
    ...part('ti:fc', 'ti:r', 'ceiling', { name: 'False ceiling', fcode: 'FC', rded: false }), ...shape('sh:fc', 'ti:fc', 'poly', rectPts(0, 0, 6, 3)),
  ]), null);
  const over = mk(1);
  close(qty(over, 'ti:r', 'ceiling'), 18 - 6 - 6, 'each at its own area');
  assert.ok(over.fin.qty.get('ti:r')!.flags.includes('addOverlap'), 'flagged');
  assert.ok(/twice/.test(fq(over, 'ti:r', 'ti:g2')!.note ?? ''), 'the later one says so');
  const side = mk(2);
  assert.ok(!side.fin.qty.get('ti:r')!.flags.includes('addOverlap'), 'side by side (the false ceiling on top is not deducted)');
});

test('c1: the summary - subtotals add up, search and type filters, a linked take-off that is also linked itself counted once, the BOQ figures', () => {
  const st = apply(new Store(), [...base,
    ['hd:gf', 'name', 'Ground floor'], ['hd:gf', 'ord', 'a0'], ['hd:ff', 'name', 'First floor'], ['hd:ff', 'ord', 'a1'],
    ['b:W', 'bt', 'item'], ['b:W', 'unit', 'm2'], ['b:W', 'desc', 'Paint GF'], ['b:T', 'bt', 'item'], ['b:T', 'unit', 'm2'], ['b:T', 'desc', 'Feature paint'],
    // GF: Toilet 2 × 2 (P 8, wall 8 × 2.5 = 20; ceiling 4 PT), Majlis 5 × 4 (P 18 × 2.5 = 45); FF: Toilet 2 × 2 Times 2 (40)
    ...room('ti:t1', 'Toilet', { wc: 'PT', hw: 2.5, cc: 'PT', par: 'hd:gf', desc: 'Guest toilet' }), ...shape('sh:t1', 'ti:t1', 'poly', rectPts(0, 0, 2, 2)),
    ...room('ti:mj', 'Majlis', { wc: 'PT', hw: 2.5, par: 'hd:gf' }, 'a1'), ...shape('sh:mj', 'ti:mj', 'poly', rectPts(5, 0, 5, 4)),
    ...room('ti:t2', 'Toilet', { wc: 'PT', hw: 2.5, par: 'hd:ff', x: 2 }), ...shape('sh:t2', 'ti:t2', 'poly', rectPts(20, 0, 2, 2)),
    // an area take-off with the same code, linked to the Majlis wall (deducted) and linked straight to the BOQ itself: 3 × 2.5
    ['ti:fp', 'kind', 'area'], ['ti:fp', 'name', 'Feature wall'], ['ti:fp', 'fcode', 'pt'], ['ti:fp', 'par', 'hd:gf'], ...shape('sh:fp', 'ti:fp', 'poly', rectPts(30, 0, 3, 2.5)),
    ['ti:fp', 'rm', 'ti:mj'], ['ti:fp', 'rk', 'link'], ['ti:fp', 'rcat', 'wall'], ...linkOps('ti:fp', 'b:T', 'area').ops,
  ]);
  let m = buildQtoModel(st, null);
  close(qty(m, 'ti:mj', 'wall'), 45 - 7.5, 'Majlis wall less the feature wall');
  const top = summarize(m, ['h0', 'type', 'room']).rows;
  assert.equal(top.length, 1, 'pt and PT one code');
  const pt = top[0];
  close(pt.qty, 20 + 4 + 37.5 + 7.5 + 40, 'code total');
  close(pt.linked, 7.5, 'the feature wall counts as linked (its own link)');
  const sum = (r: FinRow): void => { if (r.children.length) { close(r.children.reduce((a, c) => a + c.qty, 0), r.qty, 'subtotal ' + r.label, 1e-9); r.children.forEach(sum); } };
  sum(pt);
  // search "toilet": both toilets (20 + 4 + 40); walls only: 20 + 37.5 + 7.5 + 40
  close(summarize(m, [], { q: 'toilet' }).rows[0].qty, 64, 'search');
  close(summarize(m, [], { types: ['Wall'] }).rows[0].qty, 105, 'walls');
  // link PT › Ground floor: the rooms there, not the feature wall again
  const gf = pt.children.find((c) => c.label === 'Ground floor')!;
  const l = portionLinkOps(m, rowPredicate(gf), 'b:W');
  assert.ok(l.ok);
  apply(st, l.ops);
  m = buildQtoModel(st, null);
  close(m.boqQty.get('W')!.total, 20 + 4 + 37.5, 'GF link');
  close(m.boqQty.get('T')!.total, 7.5, 'the feature wall, once');
  close(summarize(m).rows[0].unlinked, 40, 'FF toilet still unlinked');
});
