// v0.16 Finishes module ENGINE (FEEDBACK items 28-33, ROOM-SPEC.md): rooms, their quantities and working,
// additional / linked finishes, waterproofing, codes, the Finishes Summary, portion links to the BOQ.
// Every test fails on 0.15.1 (no rooms, no m.fin).
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

// ---------------------------------------------------------------- ROOM-SPEC section 9
test('Master Bedroom: floor, ceiling, shadow gap, skirting, wall, wallpaper behind the bed (deduct on) - to the figure', () => {
  const st = apply(new Store(), [...base, ...bedroom(),
    ...part('ti:wp', 'ti:r1', 'wall', { name: 'Wallpaper', fcode: 'WP-03', h: 2.9, bl: 0.1 }),
    ...shape('sh:wp', 'ti:wp', 'line', J([P(5), P(0), P(5), P(4)])), // the 4.00 edge behind the bed
  ]);
  const m = buildQtoModel(st, null);
  const q = m.fin.qty.get('ti:r1')!;
  close(q.P, 18); close(q.A, 20);
  close(qty(m, 'ti:r1', 'floor'), 20); close(qty(m, 'ti:r1', 'ceiling'), 20); close(qty(m, 'ti:r1', 'gap'), 18);
  close(qty(m, 'ti:r1', 'skirting'), 17.1);
  close(qty(m, 'ti:r1', 'ti:wp'), 11.6);
  close(qty(m, 'ti:r1', 'wall'), 36.55);
  assert.deepEqual(q.flags, []);
  // the tree the take-off list shows
  const t = roomTree(q);
  assert.deepEqual([t.floor.f.qty, t.wall!.children.map((c) => c.f.key), t.ceiling.children.map((c) => c.f.key), t.wp], [q.byKey.get('floor')!.qty, ['ti:wp'], ['gap'], null]);
  // without the wallpaper the wall finish is 48.15
  const st2 = apply(new Store(), [...base, ...bedroom()]);
  close(qty(buildQtoModel(st2, null), 'ti:r1', 'wall'), 48.15);
  // Show working: the arithmetic as ROOM-SPEC writes it
  const w = roomWorking(m, 'ti:r1').join('\n');
  for (const t of ['P (wall edges) = 18.00 m', '18.00 × (3.00 − 0.10) = 52.20', '0.90 × 2.00 = 1.80', '1.50 × 1.50 = 2.25', '= 48.15', 'Wallpaper WP-03 (additional, deducted) 11.60', '= 36.55 m²', 'Skirting SK-01 (height 0.10) = P 18.00 − D1 0.90 = 17.10 m', '4.00 × 2.90 = 11.60 m²'])
    assert.ok(w.includes(t), 'working has: ' + t + '\n' + w);
});

test('Bathroom: wall tiles without skirting, waterproofing floor + upturn 0.30', () => {
  const st = apply(new Store(), [...base,
    ...room('ti:b', 'Bathroom', { wc: 'WT-01', hw: 2.7, fc: 'FT-01', pc: 'WP-01', pm: 'up', pu: 0.3 }),
    ...shape('sh:b', 'ti:b', 'poly', rectPts(0, 0, 2.5, 2)),
    ...door('op:bd', 'sh:b', 1, 0, 'ds:d2'),
  ]);
  const m = buildQtoModel(st, null);
  close(m.fin.qty.get('ti:b')!.P, 9); close(m.fin.qty.get('ti:b')!.A, 5);
  close(qty(m, 'ti:b', 'wall'), 22.62);
  assert.equal(fq(m, 'ti:b', 'skirting'), undefined, 'no skirting (Hs 0, no code)');
  close(qty(m, 'ti:b', 'wph'), 5);
  close(qty(m, 'ti:b', 'wpv'), 2.46);
  // (v0.16.4 one code for both: one each - separate rows in the Finishes Summary, each linked on its own)
  assert.equal(fq(m, 'ti:b', 'wph')!.code, 'WP-01 (horizontal)');
  assert.equal(fq(m, 'ti:b', 'wpv')!.code, 'WP-01 (vertical)');
  // horizontal and vertical are two atoms (never added together)
  const wp = m.fin.atoms.filter((a) => a.code.startsWith('WP-01'));
  assert.deepEqual(wp.map((a) => a.type).sort(), ['Horizontal WP', 'Vertical WP']);
});

test('Kitchen with the 4.00 edge open to the living room: P = 10; floor and ceiling 12; wall, skirting, vertical WP on 10 m', () => {
  const st = apply(new Store(), [...base,
    ...room('ti:k', 'Kitchen', { fc: 'FT-02', cc: 'CL-01', wc: 'PT-01', hw: 3, kc: 'SK-01', hs: 0.1, pc: 'WP-01', pm: 'up', pu: 0.3 }),
    ...shape('sh:k', 'ti:k', 'poly', rectPts(0, 0, 4, 3)), ['sh:k', 'sg', J(['~o', null, null, null])],
  ]);
  const m = buildQtoModel(st, null);
  const q = m.fin.qty.get('ti:k')!;
  close(q.P, 10); close(q.open, 4); close(q.A, 12);
  close(qty(m, 'ti:k', 'floor'), 12); close(qty(m, 'ti:k', 'ceiling'), 12);
  close(qty(m, 'ti:k', 'wall'), 10 * 2.9); close(qty(m, 'ti:k', 'skirting'), 10); close(qty(m, 'ti:k', 'wpv'), 3);
});

test('Ten typical apartments: the same Bedroom with Times 10 - every quantity × 10', () => {
  const st = apply(new Store(), [...base, ...bedroom('ti:r1', 0, { x: 10, pc: 'WP-02', pm: 'full', pl: 1.8 }),
    ...part('ti:wp', 'ti:r1', 'wall', { name: 'Wallpaper', fcode: 'WP-03', h: 2.9, bl: 0.1 }), ...shape('sh:wp', 'ti:wp', 'line', J([P(5), P(0), P(5), P(4)]))]);
  const one = buildQtoModel(apply(new Store(), [...base, ...bedroom('ti:r1', 0, { pc: 'WP-02', pm: 'full', pl: 1.8 }),
    ...part('ti:wp', 'ti:r1', 'wall', { name: 'Wallpaper', fcode: 'WP-03', h: 2.9, bl: 0.1 }), ...shape('sh:wp', 'ti:wp', 'line', J([P(5), P(0), P(5), P(4)]))]), null);
  const m = buildQtoModel(st, null);
  for (const k of ['floor', 'ceiling', 'gap', 'skirting', 'wall', 'ti:wp', 'wph', 'wpv']) close(qty(m, 'ti:r1', k), qty(one, 'ti:r1', k)! * 10, k, 1e-8);
  close(qty(m, 'ti:r1', 'wall'), 365.5, 'wall', 1e-8);
  close(qty(m, 'ti:r1', 'skirting'), 171, 'skirting', 1e-8);
  assert.ok(roomWorking(m, 'ti:r1').join('\n').includes('× 10 (Times)'));
});

// ---------------------------------------------------------------- open edges
test('open edges: set with setEdgeOps, kept when a node is inserted on them, no wall / skirting / additional / vertical WP there; doors refused on them', () => {
  const st = apply(new Store(), [...base, ...room('ti:k', 'Kitchen', { wc: 'PT-01', hw: 3, kc: 'SK-01', hs: 0.1, pc: 'WP', pm: 'up', pu: 0.3 }), ...shape('sh:k', 'ti:k', 'poly', rectPts(0, 0, 4, 3)),
    ...part('ti:a', 'ti:k', 'wall', { fcode: 'CL-9', h: 1, bl: 0.9 }), ...shape('sh:a', 'ti:a', 'line', J([P(0), P(0), P(4), P(0), P(4), P(3)]))]);
  let m = buildQtoModel(st, null);
  close(m.fin.qty.get('ti:k')!.P, 14);
  close(qty(m, 'ti:k', 'ti:a'), 7); // along the 4.00 and the 3.00 edges
  apply(st, setEdgeOps(m.shapes.find((s) => s.id === 'sh:k')!, [0], 'open', true));
  m = buildQtoModel(st, null);
  const q = m.fin.qty.get('ti:k')!;
  // (a shape written again keeps its nodes to 0.001 pt, as every edit does: 0.02 mm here)
  const e = 1e-4;
  close(q.P, 10, 'P', e); close(qty(m, 'ti:k', 'skirting'), 10, 'skirting', e); close(qty(m, 'ti:k', 'wpv'), 3, 'wpv', e); close(qty(m, 'ti:k', 'wall'), 10 * 2.9 - 3 * 1, 'wall', e);
  close(qty(m, 'ti:k', 'ti:a'), 3, 'additional only on the wall edge', e);
  close(qty(m, 'ti:k', 'floor'), 12, 'floor', e);
  // a node inserted on the open edge: both halves stay open
  apply(st, insertVertexOps(m.shapes.find((s) => s.id === 'sh:k')!, 0, 0, [P(2), P(0)]));
  m = buildQtoModel(st, null);
  close(m.fin.qty.get('ti:k')!.P, 10, 'P', e);
  // a door on the open edge is refused; on a wall edge it is placed
  const r = roomOpeningOps(m, 'sh:k', { k: 'door', x: P(1), y: P(0), door: 'ds:d1' });
  assert.ok('error' in r);
  const ok = roomOpeningOps(m, 'sh:k', { k: 'door', x: P(4), y: P(1.5), door: 'ds:d1' });
  assert.ok('ops' in ok);
  // back to a wall edge
  apply(st, setEdgeOps(m.shapes.find((s) => s.id === 'sh:k')!, [0, 1], 'open', false));
  m = buildQtoModel(st, null);
  close(m.fin.qty.get('ti:k')!.P, 14, 'P', e);
});

// ---------------------------------------------------------------- additional finishes and doors
const wallRoom = (extra: Op[] = []): Store => apply(new Store(), [...base,
  ...room('ti:r', 'Bedroom', { wc: 'PT-08', hw: 3, kc: 'SK-01', hs: 0.1 }), ...shape('sh:r', 'ti:r', 'poly', rectPts(0, 0, 5, 4)), ...door('op:d', 'sh:r', 1, 0), ...extra]);

test('additional wall finish with a door on its stretch: the door comes off it, the main loses only the rest - deduct on and off', () => {
  // the whole 5.00 edge with the door (centre 1.00, 0.90 wide), from the skirting up to 3.00
  const on = buildQtoModel(wallRoom([...part('ti:a', 'ti:r', 'wall', { fcode: 'WP-03', h: 2.9 }), ...shape('sh:a', 'ti:a', 'line', J([P(0), P(0), P(5), P(0)]))]), null);
  close(qty(on, 'ti:r', 'ti:a'), 5 * 2.9 - 0.9 * 2.0);
  close(qty(on, 'ti:r', 'wall'), 50.4 - 12.7);
  close(qty(on, 'ti:r', 'wall')! + qty(on, 'ti:r', 'ti:a')!, 50.4, 'nothing deducted twice');
  const off = buildQtoModel(wallRoom([...part('ti:a', 'ti:r', 'wall', { fcode: 'WP-03', h: 2.9, rded: false }), ...shape('sh:a', 'ti:a', 'line', J([P(0), P(0), P(5), P(0)]))]), null);
  close(qty(off, 'ti:r', 'ti:a'), 12.7);
  close(qty(off, 'ti:r', 'wall'), 50.4);
  // only part of the door on the stretch (from 1.00 to 5.00: 0.45 of its width)
  const half = buildQtoModel(wallRoom([...part('ti:a', 'ti:r', 'wall', { fcode: 'WP-03', h: 2.9 }), ...shape('sh:a', 'ti:a', 'line', J([P(1), P(0), P(5), P(0)]))]), null);
  close(qty(half, 'ti:r', 'ti:a'), 4 * 2.9 - 0.45 * 2.0);
  close(qty(half, 'ti:r', 'wall'), 50.4 - 10.7);
  // a kitchen splashback 0.90..1.50 over the door: 0.60 of the door's height in its band
  const sb = buildQtoModel(wallRoom([...part('ti:a', 'ti:r', 'wall', { fcode: 'CT-01', h: 0.6, bl: 0.9 }), ...shape('sh:a', 'ti:a', 'line', J([P(0), P(0), P(5), P(0)]))]), null);
  close(qty(sb, 'ti:r', 'ti:a'), 5 * 0.6 - 0.9 * 0.6);
  close(qty(sb, 'ti:r', 'wall'), 50.4 - (3 - 0.54));
  // two additional finishes over the same stretch, both deducted: the main loses that area once
  const two = buildQtoModel(wallRoom([...part('ti:a', 'ti:r', 'wall', { fcode: 'A', h: 2.9 }), ...shape('sh:a', 'ti:a', 'line', J([P(0), P(0), P(5), P(0)])),
    ...part('ti:b', 'ti:r', 'wall', { fcode: 'B', h: 2.9 }), ...shape('sh:b', 'ti:b', 'line', J([P(5), P(0), P(0), P(0)]))]), null);
  close(qty(two, 'ti:r', 'wall'), 50.4 - 12.7);
  // a stretch drawn a little off the outline still lands on it (projected)
  const offL = buildQtoModel(wallRoom([...part('ti:a', 'ti:r', 'wall', { fcode: 'WP-03', h: 2.9 }), ...shape('sh:a', 'ti:a', 'line', J([P(0.2), P(0.03), P(4.8), P(-0.02)]))]), null);
  close(qty(offL, 'ti:r', 'ti:a'), 4.6 * 2.9 - 1.8, 'projected', 1e-6);
  assert.ok(!offL.fin.qty.get('ti:r')!.flags.includes('offOutline'));
});

test('additional skirting with a door: its own length less the door; the main loses exactly that figure', () => {
  const m = buildQtoModel(wallRoom([...part('ti:s', 'ti:r', 'skirting', { fcode: 'SK-02' }), ...shape('sh:s', 'ti:s', 'line', J([P(0), P(0), P(5), P(0)]))]), null);
  close(qty(m, 'ti:r', 'ti:s'), 4.1);
  close(qty(m, 'ti:r', 'skirting'), 17.1 - 4.1);
  const off = buildQtoModel(wallRoom([...part('ti:s', 'ti:r', 'skirting', { fcode: 'SK-02', rded: false }), ...shape('sh:s', 'ti:s', 'line', J([P(0), P(0), P(5), P(0)]))]), null);
  close(qty(off, 'ti:r', 'skirting'), 17.1);
  close(qty(off, 'ti:r', 'ti:s'), 4.1);
});

test('openings: a floor-level arch comes off the skirting, a window above it does not; an opening above the wall finish height takes nothing off', () => {
  const st = wallRoom([
    ...opening('op:arch', 'sh:r', 5, 2, 1.2, 2.4, 0, 'Arch'), // right edge, floor level
    ...opening('op:low', 'sh:r', 0, 2, 0.5, 0.3, 0.05, 'Vent'), // sill below the top of the skirting (0.10)
    ...opening('op:at', 'sh:r', 0, 3, 0.5, 0.5, 0.1, 'At'), // sill = the top of the skirting: skirting runs under it
    ...opening('op:win', 'sh:r', 2.5, 4, 1.5, 1.5, 0.9, 'W1'),
  ]);
  const m = buildQtoModel(st, null);
  close(qty(m, 'ti:r', 'skirting'), 18 - 0.9 - 1.2 - 0.5);
  // wall: 52.20 − D1 1.80 − arch 1.2 × 2.3 − vent 0.5 × 0.25 − at 0.5 × 0.5 − W1 2.25
  close(qty(m, 'ti:r', 'wall'), 52.2 - 1.8 - 1.2 * 2.3 - 0.5 * 0.25 - 0.25 - 2.25);
  // tiled to 1.20 only: the 2.10 door comes off up to 1.20, a window from 1.50 takes nothing off
  const t = buildQtoModel(apply(new Store(), [...base, ...room('ti:t', 'Toilet', { wc: 'WT-01', hw: 1.2 }), ...shape('sh:t', 'ti:t', 'poly', rectPts(0, 0, 2, 2)),
    ...door('op:td', 'sh:t', 1, 0), ...opening('op:tw', 'sh:t', 1, 2, 0.6, 1, 1.5, 'W2')]), null);
  close(qty(t, 'ti:t', 'wall'), 8 * 1.2 - 0.9 * 1.2);
  assert.ok(roomWorking(t, 'ti:t').join('\n').includes('W2 0.60 × 1.00 sill 1.50: 0.60 × 0.00 = 0.00'));
});

test('waterproofing: floor with upturn and full wall height (to a level, or to the wall finish height), with a door and a window; own codes', () => {
  const mk = (f: Record<string, unknown>) => buildQtoModel(apply(new Store(), [...base, ...room('ti:b', 'Bathroom', { wc: 'WT-01', hw: 2.7, pc: 'WP-01', ...f }), ...shape('sh:b', 'ti:b', 'poly', rectPts(0, 0, 2.5, 2)),
    ...door('op:bd', 'sh:b', 1, 0, 'ds:d2'), ...opening('op:bw', 'sh:b', 1, 2, 0.6, 0.6, 1.5, 'W')]), null);
  let m = mk({ pm: 'up', pu: 0.3 });
  close(qty(m, 'ti:b', 'wph'), 5); close(qty(m, 'ti:b', 'wpv'), 2.46);
  m = mk({ pm: 'full', pl: 1.8 });
  close(qty(m, 'ti:b', 'wpv'), 9 * 1.8 - 0.8 * 1.8 - 0.6 * 0.3);
  m = mk({ pm: 'full' });
  close(qty(m, 'ti:b', 'wpv'), 9 * 2.7 - 0.8 * 2.1 - 0.6 * 0.6);
  m = mk({ pm: 'up', pu: 0.3, phc: 'WP-H', pvc: 'WP-V' });
  assert.equal(fq(m, 'ti:b', 'wph')!.code, 'WP-H (horizontal)'); assert.equal(fq(m, 'ti:b', 'wpv')!.code, 'WP-V (vertical)');
  close(qty(m, 'ti:b', 'wph')!, 5);
  m = mk({});
  assert.equal(fq(m, 'ti:b', 'wph'), undefined, 'off by default');
});

test('deductions larger than the finish: 0 and the room is flagged', () => {
  const st = apply(new Store(), [...base, ...room('ti:r', 'Store', { fc: 'FL-01', cc: 'CL-01' }), ...shape('sh:r', 'ti:r', 'poly', rectPts(0, 0, 2, 2)),
    ...part('ti:f1', 'ti:r', 'floor', { fcode: 'FL-09', full: true }),
    ...part('ti:f2', 'ti:r', 'floor', { fcode: 'FL-08' }), ...shape('sh:f2', 'ti:f2', 'poly', rectPts(0, 0, 1, 1))]);
  const m = buildQtoModel(st, null);
  const f = fq(m, 'ti:r', 'floor')!;
  assert.equal(f.qty, 0); assert.ok(f.over); close(f.raw, -1);
  assert.ok(m.fin.qty.get('ti:r')!.flags.includes('over'));
  close(qty(m, 'ti:r', 'ti:f1'), 4); close(qty(m, 'ti:r', 'ti:f2'), 1);
  assert.ok(m.fin.atomById.get('ti:r/floor')!.flags.includes('over'));
  assert.ok(roomWorking(m, 'ti:r').join('\n').includes('deductions larger than the finish'));
});

test('ceiling: manual areas, an additional ceiling deducted (antifungal paint) and one on top (false ceiling); shadow gap on picked edges', () => {
  const st = apply(new Store(), [...base, ...room('ti:r', 'Majlis', { cc: 'PT-01', cm: 'manual', gc: 'SG-01', gm: 'pick' }), ...shape('sh:r', 'ti:r', 'poly', rectPts(0, 0, 6, 5)),
    ['sh:r', 'sg', J(['~g', null, null, null])],
    ['ti:c', 'kind', 'area'], ['ti:c', 'name', 'Ceiling areas'], ['ti:c', 'rm', 'ti:r'], ['ti:c', 'rk', 'ceil'], ['ti:c', 'rcat', 'ceiling'],
    ...shape('sh:c', 'ti:c', 'poly', rectPts(0, 0, 6, 4)), // the soffit inside the bulkhead
    ...part('ti:af', 'ti:r', 'ceiling', { name: 'Antifungal paint', fcode: 'PT-05' }), ...shape('sh:af', 'ti:af', 'poly', rectPts(1, 1, 2, 2)), ['sh:af', 'sg', J(['~g', '~g', null, null])],
    ...part('ti:fc', 'ti:r', 'ceiling', { name: 'False ceiling', fcode: 'FC-01', rded: false }), ...shape('sh:fc', 'ti:fc', 'poly', rectPts(1, 1, 2, 2))]);
  const m = buildQtoModel(st, null);
  close(qty(m, 'ti:r', 'ceiling'), 24 - 4);
  close(qty(m, 'ti:r', 'ti:af'), 4); close(qty(m, 'ti:r', 'ti:fc'), 4);
  close(qty(m, 'ti:r', 'gap'), 6 + 2 + 2);
  assert.ok(!m.fin.qty.get('ti:r')!.flags.includes('outsideRoom'));
  // auto again: = A
  apply(st, setCeilingModeOps(m, 'me', 'ti:r', 'auto').ops);
  const m2 = buildQtoModel(st, null);
  close(qty(m2, 'ti:r', 'ceiling'), 30 - 4);
  apply(st, setShadowGapOps(m2, 'ti:r', 'all'));
  close(qty(buildQtoModel(st, null), 'ti:r', 'gap'), 22);
});

// ---------------------------------------------------------------- linked take-offs
test('an existing take-off linked to a room: face value, deduct on / off, length to Wall with a height, incompatible refused, unlink', () => {
  const st = wallRoom([
    ['ti:fl', 'kind', 'area'], ['ti:fl', 'name', 'Marble border'], ['ti:fl', 'ord', 'b0'], ['ti:fl', 'fcode', 'MB-01'], ...shape('sh:fl', 'ti:fl', 'poly', rectPts(0, 0, 1, 2)),
    ['ti:ln', 'kind', 'line'], ['ti:ln', 'name', 'Cladding strip'], ['ti:ln', 'ord', 'b1'], ...shape('sh:ln', 'ti:ln', 'line', J([P(0), P(4), P(2), P(4)])),
    ['ti:cn', 'kind', 'count'], ['ti:cn', 'name', 'Lights'], ['ti:cn', 'ord', 'b2'],
    ['ti:r', 'fc', 'FL-01'],
  ]);
  let m = buildQtoModel(st, null);
  const a = linkToRoomOps(m, 'ti:fl', 'ti:r', 'floor');
  assert.ok('ops' in a);
  apply(st, a.ops);
  assert.ok('error' in linkToRoomOps(m, 'ti:cn', 'ti:r', 'floor'));
  assert.ok('error' in linkToRoomOps(m, 'ti:fl', 'ti:r', 'skirting'));
  assert.ok('error' in linkToRoomOps(m, 'ti:ln', 'ti:r', 'wall'), 'a length to Wall needs a height');
  const b = linkToRoomOps(m, 'ti:ln', 'ti:r', 'wall', { h: 1.5, deduct: false });
  assert.ok('ops' in b);
  apply(st, b.ops);
  m = buildQtoModel(st, null);
  close(qty(m, 'ti:r', 'floor'), 20 - 2);
  close(qty(m, 'ti:r', 'ti:fl'), 2);
  assert.equal(fq(m, 'ti:r', 'ti:fl')!.code, 'MB-01');
  close(qty(m, 'ti:r', 'ti:ln'), 3);
  close(qty(m, 'ti:r', 'wall'), 50.4, 'on top: main unchanged');
  // no code of its own: NOT filed under the wall finish's code - out of the summary, listed with a reason
  assert.equal(fq(m, 'ti:r', 'ti:ln')!.code, '');
  assert.ok(!m.fin.atoms.some((x) => x.src.includes('ti:ln')));
  const nc = m.fin.uncoded.find((x) => x.id === 'ti:r/ti:ln')!;
  assert.ok(nc && /no code/.test(nc.reason ?? ''), 'listed with a reason');
  close(nc.qty, 3);
  assert.equal(summarize(m).noCode, m.fin.uncoded.length);
  // the linked take-off is in the summary once, as the room's (not also as a loose take-off)
  assert.equal(m.fin.atoms.filter((x) => x.src.includes('ti:fl')).length, 1);
  assert.equal(m.fin.atomById.get('ti:r/ti:fl')!.roomName, 'Bedroom');
  // still in its own place in the list, quantity of its own unchanged
  assert.ok((m.tree.get('') ?? []).some((n) => n.id === 'ti:fl'));
  close(m.qty.get('ti:fl')!.area, 2);
  apply(st, unlinkFromRoomOps(m, 'ti:fl'));
  m = buildQtoModel(st, null);
  close(qty(m, 'ti:r', 'floor'), 20);
  assert.equal(fq(m, 'ti:r', 'ti:fl'), undefined);
  assert.ok(m.fin.atomById.get('ti:fl'), 'back as a coded take-off of its own');
});

// ---------------------------------------------------------------- scales
test('a room across a viewport edge (area at its middle, perimeter piece by piece) and on a sheet with X / Y scales', () => {
  const S50 = scaleFromRatio(50);
  const st = apply(new Store(), [...base, ['sr:v', 'dwg', 'd1'], ['sr:v', 'pg', 0], ['sr:v', 'r', J([P(3), P(-1), P(10), P(10)])], ['sr:v', 'sc', S50],
    ...room('ti:r', 'Hall', { wc: 'PT-01', hw: 3, kc: 'SK-01', hs: 0.1 }), ...shape('sh:r', 'ti:r', 'poly', rectPts(0, 0, 5, 4))]);
  const m = buildQtoModel(st, null);
  const q = m.fin.qty.get('ti:r')!;
  close(q.A, 20, 'area at the scale of its middle', 1e-8);
  close(q.P, 3 + 1 + 2 + 1 + 3 + 4, 'perimeter piece by piece', 1e-8);
  assert.ok(q.flags.includes('mixed'));
  close(qty(m, 'ti:r', 'skirting'), 14, 'skirting', 1e-8);
  // X / Y: up-down counts at 1:50 (half): 5.00 × 2.00; a wallpaper on the right edge (2.00 real) with a door in its middle
  const xy = apply(new Store(), [...base, ['pg:d1.0', 'scy', S50],
    ...room('ti:r', 'Hall', { wc: 'PT-01', hw: 3 }), ...shape('sh:r', 'ti:r', 'poly', rectPts(0, 0, 5, 4)), ...door('op:d', 'sh:r', 5, 2),
    ...part('ti:a', 'ti:r', 'wall', { fcode: 'WP-01' }), ...shape('sh:a', 'ti:a', 'line', J([P(5), P(0), P(5), P(4)]))]);
  const mx = buildQtoModel(xy, null);
  close(mx.fin.qty.get('ti:r')!.A, 10, 'A', 1e-8);
  close(mx.fin.qty.get('ti:r')!.P, 14, 'P', 1e-8);
  close(qty(mx, 'ti:r', 'ti:a'), 2 * 3 - 0.9 * 2.1, 'additional on the Y edge, door off it', 1e-8);
  close(qty(mx, 'ti:r', 'wall'), 14 * 3 - 1.89 - (6 - 1.89), 'main', 1e-8);
});

// ---------------------------------------------------------------- codes
test('finish codes: case ignored, one spelling (the first written) on every PC; suggestions; code boxes write that spelling', () => {
  const ops1: Op[] = [...base, ...room('ti:a', 'Bedroom', { wc: 'PT-08', hw: 3 }), ...shape('sh:a', 'ti:a', 'poly', rectPts(0, 0, 4, 4))];
  const ops2: Op[] = [...room('ti:b', 'Majlis', { wc: 'pt-08', hw: 3 }, 'a1'), ...shape('sh:b', 'ti:b', 'poly', rectPts(10, 0, 4, 4))];
  const ops3: Op[] = [['ti:c', 'kind', 'area'], ['ti:c', 'name', 'Lobby walls'], ['ti:c', 'ord', 'a2'], ['ti:c', 'fcode', 'Pt-08 '], ['ti:p', 'kind', 'area'], ['ti:p', 'name', 'x'], ['ti:p', 'fcode', 'PT-01']];
  const b1 = batch(ops1), b2 = batch(ops2), b3 = batch(ops3);
  const A = new Store(); [b1, b2, b3].forEach((b) => A.apply(b));
  const B = new Store(); [b3, b2, b1].forEach((b) => B.apply(b));
  for (const st of [A, B]) {
    const m = buildQtoModel(st, null);
    assert.deepEqual(m.fin.codes.map((c) => c.code), ['PT-01', 'PT-08']);
    const rows = summarize(m).rows;
    assert.equal(rows.length, 2);
    const pt8 = rows.find((r) => r.key === 'pt-08')!;
    assert.equal(pt8.code, 'PT-08');
    assert.equal(pt8.atoms.length, 3);
    assert.equal(canonicalCode(m, 'pT-08'), 'PT-08');
    assert.deepEqual(suggestCodes(m, 'pt').map((c) => c.code), ['PT-01', 'PT-08']);
    assert.deepEqual(suggestCodes(m, '08').map((c) => c.code), ['PT-08']);
    // typing "pt-08" in a code box writes the project's spelling
    assert.deepEqual(setRoomOps(m, 'ti:b', { wc: 'pt-08' }), [['ti:b', 'wc', 'PT-08']]);
    assert.deepEqual(setFinishCodeOps(m, ['ti:c', 'ti:a'], 'pt-08'), [['ti:c', 'fcode', 'PT-08']]);
  }
});

test('one code in two units: two rows and a warning', () => {
  const st = apply(new Store(), [...base, ...room('ti:a', 'Bedroom', { fc: 'X-01', kc: 'X-01', hs: 0.1 }), ...shape('sh:a', 'ti:a', 'poly', rectPts(0, 0, 4, 4))]);
  const m = buildQtoModel(st, null);
  const s = summarize(m);
  assert.deepEqual(s.rows.map((r) => [r.code, r.unit]), [['X-01', 'm'], ['X-01', 'm²']]);
  assert.deepEqual(s.warnings, [{ code: 'X-01', units: ['m', 'm²'] }]);
});

test('an additional finish without a code: not under the main finish\'s code, listed apart (with a reason, exported), its deduction still taken', () => {
  const st = wallRoom([...part('ti:a', 'ti:r', 'wall', { name: 'Wallpaper', h: 2.9 }), ...shape('sh:a', 'ti:a', 'line', J([P(0), P(0), P(5), P(0)]))]);
  const m = buildQtoModel(st, null);
  close(qty(m, 'ti:r', 'wall'), 50.4 - 12.7, 'the deduction still applies');
  assert.equal(fq(m, 'ti:r', 'ti:a')!.code, '');
  const pt = summarize(m).rows.find((r) => r.key === 'pt-08')!;
  close(pt.qty, 50.4 - 12.7, 'the wallpaper is not filed as paint');
  const nc = m.fin.uncoded.find((x) => x.id === 'ti:r/ti:a')!;
  assert.equal(nc.reason, 'Wallpaper (additional wall finish) has no code');
  close(nc.qty, 12.7);
  const s = summarize(m);
  assert.equal(s.noCode, 3, 'wallpaper, floor, ceiling');
  assert.equal(m.fin.noCode, 3);
  const wb = readXlsx(exportQto(m, { project: 'T', by: 'me', when: new Date(0) }));
  const fs = wb.sheet('Finishes');
  const head = fs.rows.get(4)!.map((c) => c?.v);
  const row = [...fs.rows.entries()].filter(([r]) => r > 4).map(([, r]) => r.map((c) => c?.v)).find((r) => String(r[head.indexOf('Finish')]).startsWith('Wallpaper'))!;
  assert.equal(row[head.indexOf('BOQ link')], 'no code (not in the summary)');
});

test('a linked take-off whose own Times differs from its room\'s is flagged (it still counts at face value)', () => {
  const st = apply(new Store(), [...base, ...bedroom('ti:r1', 0, { x: 10 }),
    ['ti:fl', 'kind', 'area'], ['ti:fl', 'name', 'Marble border'], ['ti:fl', 'fcode', 'MB-01'], ['ti:fl', 'rm', 'ti:r1'], ['ti:fl', 'rk', 'link'], ['ti:fl', 'rcat', 'floor'], ...shape('sh:fl', 'ti:fl', 'poly', rectPts(0, 0, 1, 2)),
    ['ti:f2', 'kind', 'area'], ['ti:f2', 'name', 'Rug area'], ['ti:f2', 'x', 10], ['ti:f2', 'fcode', 'MB-02'], ['ti:f2', 'rm', 'ti:r1'], ['ti:f2', 'rk', 'link'], ['ti:f2', 'rcat', 'floor'], ['ti:f2', 'rded', false], ...shape('sh:f2', 'ti:f2', 'poly', rectPts(2, 0, 1, 1))]);
  const m = buildQtoModel(st, null);
  const q = m.fin.qty.get('ti:r1')!;
  assert.ok(q.flags.includes('timesDiffer'));
  assert.deepEqual(q.timesDiffer, ['ti:fl']);
  close(qty(m, 'ti:r1', 'ti:fl'), 2, 'face value');
  close(qty(m, 'ti:r1', 'floor'), 200 - 2);
  assert.equal(fq(m, 'ti:r1', 'ti:fl')!.note, 'Times differs from the room’s (×10)');
  // the same Times: no flag
  apply(st, [['ti:fl', 'x', 10]]);
  const m2 = buildQtoModel(st, null);
  assert.ok(!m2.fin.qty.get('ti:r1')!.flags.includes('timesDiffer'));
  assert.deepEqual(m2.fin.qty.get('ti:r1')!.timesDiffer, []);
});

test('a take-off without a code stays out of the summary and is unchanged; room finishes without a code are listed apart', () => {
  const st = apply(new Store(), [...base, ['ti:x', 'kind', 'area'], ['ti:x', 'name', 'Slab'], ...shape('sh:x', 'ti:x', 'poly', rectPts(0, 0, 2, 2)),
    ...room('ti:r', 'Bedroom', { wc: 'PT-01', hw: 3 }), ...shape('sh:r', 'ti:r', 'poly', rectPts(5, 0, 2, 2))]);
  const m = buildQtoModel(st, null);
  assert.equal(m.fin.atoms.length, 1);
  assert.deepEqual(m.fin.uncoded.map((a) => a.id).sort(), ['ti:r/ceiling', 'ti:r/floor']);
  assert.deepEqual(m.fin.uncoded.map((a) => a.reason).sort(), ['Ceiling finish has no code', 'Floor finish has no code']);
  close(m.qty.get('ti:x')!.area, 4);
});

// ---------------------------------------------------------------- portion links
const twoFloors = (): Op[] => [...base,
  ['hd:gf', 'name', 'Ground floor'], ['hd:gf', 'ord', 'a0'], ['hd:ff', 'name', 'First floor'], ['hd:ff', 'ord', 'a1'],
  ['b:L1', 'bt', 'item'], ['b:L1', 'unit', 'm2'], ['b:L1', 'desc', 'Paint GF'], ['b:L2', 'bt', 'item'], ['b:L2', 'unit', 'm2'], ['b:L2', 'desc', 'Paint FF'], ['b:L3', 'bt', 'item'], ['b:L3', 'unit', 'm2'], ['b:L3', 'desc', 'Paint bedrooms'],
  ...room('ti:liv', 'Living', { wc: 'PT-08', hw: 3, par: 'hd:gf' }), ...shape('sh:liv', 'ti:liv', 'poly', rectPts(0, 0, 5, 5)), // 20 × 3 = 60
  ...room('ti:bed', 'Bedroom', { wc: 'PT-08', hw: 3, par: 'hd:ff' }), ...shape('sh:bed', 'ti:bed', 'poly', rectPts(10, 0, 4, 4)), // 16 × 3 = 48
];
const rowOf = (rows: FinRow[], ...labels: string[]): FinRow => {
  let list = rows, r: FinRow | undefined;
  for (const l of labels) { r = list.find((x) => x.label === l); assert.ok(r, 'row ' + l); list = r!.children; }
  return r!;
};

test('portion links: a row linked follows rooms added under it; an overlapping link is refused with the links it overlaps; unlinked shown', () => {
  const st = apply(new Store(), twoFloors());
  let m = buildQtoModel(st, null);
  let rows = summarize(m, ['h0']).rows;
  const gf = rowOf(rows, 'PT-08 (m²)', 'Ground floor');
  close(gf.qty, 60);
  const l1 = portionLinkOps(m, rowPredicate(gf), 'b:L1');
  assert.ok(l1.ok);
  apply(st, l1.ops);
  m = buildQtoModel(st, null);
  close(m.boqQty.get('L1')!.total, 60);
  assert.equal(m.boqQty.get('L1')!.parts[0].fl, l1.id);
  rows = summarize(m, ['h0']).rows;
  const code = rowOf(rows, 'PT-08 (m²)');
  close(code.qty, 108); close(code.linked, 60); close(code.unlinked, 48);
  assert.deepEqual(codeTotals(m), [{ code: 'PT-08', unit: 'm²', total: 108, linked: 60, unlinked: 48 }]);
  // the whole code now overlaps the ground floor link: refused, listing it
  const all = portionLinkOps(m, rowPredicate(code), 'b:L2');
  assert.ok(!all.ok && all.overlaps.map((o) => o.id).join() === l1.id);
  const ff = portionLinkOps(m, rowPredicate(rowOf(rows, 'PT-08 (m²)', 'First floor')), 'b:L2');
  assert.ok(ff.ok);
  apply(st, ff.ops);
  // a room added under the ground floor joins its link
  apply(st, [...room('ti:k', 'Kitchen', { wc: 'pt-08', hw: 3, par: 'hd:gf' }, 'a5'), ...shape('sh:k', 'ti:k', 'poly', rectPts(20, 0, 2, 2))]);
  m = buildQtoModel(st, null);
  close(m.boqQty.get('L1')!.total, 60 + 24);
  close(m.boqQty.get('L2')!.total, 48);
  // and grows with its room
  apply(st, [['ti:liv', 'hw', 3.5]]);
  m = buildQtoModel(st, null);
  close(m.boqQty.get('L1')!.total, 70 + 24);
  close(summarize(m).rows[0].unlinked, 0);
  // the estimate's figure (EstTakeoff sums boqQty; takeoffQtyOps writes roundQty)
  assert.equal(roundQty(m.boqQty.get('L1')!.total), 94);
});

test('portion links: a room later under two links counts in the older one (on every PC) and is flagged; a breakdown change leaves links alone', () => {
  const st = apply(new Store(), twoFloors());
  let m = buildQtoModel(st, null);
  const l1 = portionLinkOps(m, rowPredicate(rowOf(summarize(m, ['h0']).rows, 'PT-08 (m²)', 'Ground floor')), 'b:L1');
  assert.ok(l1.ok);
  const b1 = batch(l1.ops);
  st.apply(b1);
  m = buildQtoModel(st, null);
  const l2 = portionLinkOps(m, rowPredicate(rowOf(summarize(m, ['room']).rows, 'PT-08 (m²)', 'Bedroom')), 'b:L3');
  assert.ok(l2.ok, 'bedrooms: only the first floor one so far, not linked yet');
  assert.equal(buildQtoModel(apply(new Store(), [...twoFloors(), ...l2.ops]), null).fin.linkById.get(l2.id)!.label, 'PT-08 › Bedroom');
  const b2 = batch(l2.ops);
  st.apply(b2);
  const b3 = batch([...room('ti:gb', 'Bedroom', { wc: 'PT-08', hw: 3, par: 'hd:gf' }, 'a6'), ...shape('sh:gb', 'ti:gb', 'poly', rectPts(30, 0, 3, 3))]);
  st.apply(b3);
  const check = (mm: QtoModel) => {
    close(mm.boqQty.get('L1')!.total, 60 + 36);
    close(mm.boqQty.get('L3')!.total, 48);
    const a = mm.fin.atomById.get('ti:gb/wall')!;
    assert.equal(a.link, l1.id);
    assert.ok(a.flags.includes('twoLinks'));
    assert.deepEqual(mm.fin.linkById.get(l2.id)!.shared, ['ti:gb/wall']);
    const row = rowOf(summarize(mm, ['h0']).rows, 'PT-08 (m²)', 'Ground floor');
    assert.ok(row.twoLinks);
  };
  check(buildQtoModel(st, null));
  // the same on a PC that got the changes in another order
  const other = new Store();
  other.apply(batch(twoFloors()));
  [b3, b2, b1].forEach((b) => other.apply(b));
  check(buildQtoModel(other, null));
  // saved breakdowns: made, changed - the links stay as they are
  m = buildQtoModel(st, null);
  const bd = saveBreakdownOps(m, { name: 'By floor', by: ['h0'] });
  apply(st, bd.ops);
  const before = JSON.stringify([...st.ents].filter(([id]) => id.startsWith('fl:')).map(([id, e]) => [id, [...e].map(([f, c]) => [f, c.v])]));
  apply(st, saveBreakdownOps(buildQtoModel(st, null), { name: 'By floor and type', by: ['h0', 'type'], filter: { q: 'bed' } }, bd.id).ops);
  m = buildQtoModel(st, null);
  assert.deepEqual(m.fin.breakdowns.map((b) => [b.name, b.by, b.flt]), [['By floor and type', ['h0', 'type'], { q: 'bed' }]]);
  assert.equal(JSON.stringify([...st.ents].filter(([id]) => id.startsWith('fl:')).map(([id, e]) => [id, [...e].map(([f, c]) => [f, c.v])])), before);
  close(m.boqQty.get('L1')!.total, 96);
});

test('a take-off with a code that is linked to the BOQ itself shows as linked, and no portion link takes it again', () => {
  const st = apply(new Store(), [...twoFloors(), ['ti:t', 'kind', 'area'], ['ti:t', 'name', 'Corridor walls'], ['ti:t', 'par', 'hd:gf'], ['ti:t', 'fcode', 'PT-08'], ...shape('sh:t', 'ti:t', 'poly', rectPts(40, 0, 2, 5)),
    ...linkOps('ti:t', 'b:L3', 'area').ops]);
  const m = buildQtoModel(st, null);
  const a = m.fin.atomById.get('ti:t')!;
  assert.ok(a.direct.length === 1 && a.flags.includes('direct'));
  const gf = rowOf(summarize(m, ['h0']).rows, 'PT-08 (m²)', 'Ground floor');
  close(gf.qty, 70); close(gf.linked, 10); close(gf.unlinked, 60);
  // (c1) a link of the row leaves the take-off out (it is linked itself) - it no longer stands in the way
  const r = portionLinkOps(m, rowPredicate(gf), 'b:L1');
  assert.ok(r.ok);
  close(buildQtoModel(apply(new Store(), [...twoFloors(), ['ti:t', 'kind', 'area'], ['ti:t', 'name', 'Corridor walls'], ['ti:t', 'par', 'hd:gf'], ['ti:t', 'fcode', 'PT-08'], ...shape('sh:t', 'ti:t', 'poly', rectPts(40, 0, 2, 5)),
    ...linkOps('ti:t', 'b:L3', 'area').ops, ...r.ops]), null).boqQty.get('L1')!.total, 60);
  close(m.boqQty.get('L3')!.total, 10);
  // filtered to the rooms only (search "Living"): allowed
  const r2 = portionLinkOps(m, rowPredicate(rowOf(summarize(m, ['h0'], { q: 'living' }).rows, 'PT-08 (m²)', 'Ground floor'), { q: 'living' }), 'b:L1');
  assert.ok(r2.ok);
  apply(st, r2.ops);
  close(buildQtoModel(st, null).boqQty.get('L1')!.total, 60);
});

test('doors in rooms are never counted: door schedule counts, door BOQ links and openings on walls are as before', () => {
  const st = apply(new Store(), [...base, ['b:D', 'bt', 'item'], ['b:D', 'unit', 'nr'], ['b:D', 'desc', 'Doors D1'],
    ['ti:w', 'kind', 'wall'], ['ti:w', 'name', 'Block'], ['ti:w', 'h', 3], ...shape('sh:w', 'ti:w', 'line', J([P(0), P(10), P(5), P(10)])), ...door('op:wd', 'sh:w', 2, 10),
    ...bedroom(), ...linkOps('ds:d1', 'b:D', 'cnt').ops]);
  const m = buildQtoModel(st, null);
  assert.equal(m.doorCount.get('ds:d1'), 1);
  assert.deepEqual(m.openings.map((o) => o.id), ['op:wd']);
  assert.deepEqual(m.roomOpenings.map((o) => o.id), ['op:r1d', 'op:r1w']);
  assert.equal(m.boqQty.get('D')!.total, 1);
  assert.equal(m.qty.get('ti:w')!.doors, 1);
  // the Excel export: room doors not on the Openings sheet; a Finishes sheet and a summary by code
  const wb = readXlsx(exportQto(m, { project: 'T', by: 'me', when: new Date(0) }));
  assert.equal([...wb.sheet('Openings').rows.keys()].filter((r) => r > 4).length, 1);
  const fin = wb.sheet('Finishes');
  const head = fin.rows.get(4)!.map((c) => c?.v);
  assert.deepEqual(head.filter((x) => x !== undefined), ['Heading', 'Room', 'Description', 'Finish type', 'Finish', 'Code', 'Quantity', 'Unit', 'Times', 'BOQ link', 'Note']);
  const c = (h: string) => head.indexOf(h);
  const rows = [...fin.rows.entries()].filter(([r]) => r > 4).map(([, row]) => row.map((x) => x?.v));
  const wall = rows.find((r) => r[c('Code')] === 'PT-08')!;
  assert.deepEqual([wall[c('Room')], wall[c('Description')], wall[c('Finish type')], wall[c('Unit')], wall[c('BOQ link')]], ['Master Bedroom', 'Type A apartment', 'Wall', 'm²', 'not linked']);
  close(wall[c('Quantity')], 48.15);
  assert.equal(rows.length, 5, 'floor, wall, skirting, ceiling, shadow gap');
  const bc = wb.sheet('Finishes by code');
  const ch = bc.rows.get(4)!.map((x) => x?.v);
  const byCode = [...bc.rows.entries()].filter(([r]) => r > 4).map(([, row]) => row.map((x) => x?.v));
  assert.deepEqual(byCode.map((r) => r[ch.indexOf('Code')]), ['CL-01', 'FL-02', 'PT-08', 'SG-01', 'SK-01']);
});

test('a room linked straight to the BOQ (lk:) is not counted - room quantities go through the Finishes Summary', () => {
  const st = apply(new Store(), [...base, ['b:L', 'bt', 'item'], ['b:L', 'unit', 'm2'], ...bedroom(), ...linkOps('ti:r1', 'b:L', 'area').ops]);
  assert.equal(buildQtoModel(st, null).boqQty.get('L'), undefined);
});

// ---------------------------------------------------------------- the changes the UI makes
test('ops: a new room takes the last same-name room\'s settings; two people editing different fields both keep theirs; delete / duplicate take its finishes', () => {
  const st = apply(new Store(), [...base, ...bedroom()]);
  let m = buildQtoModel(st, null);
  const r = newRoomOps(m, 'me', { name: 'master bedroom', desc: 'Type B' });
  assert.equal(r.defaults.wc, 'PT-08'); assert.equal(r.defaults.hw, 3);
  apply(st, [...r.ops, ...shape('sh:n', r.id, 'poly', rectPts(20, 0, 5, 4))]);
  m = buildQtoModel(st, null);
  close(qty(m, r.id, 'wall'), 52.2);
  assert.equal(m.fin.roomById.get(r.id)!.desc, 'Type B');
  // two people at once: one the height, the other the code
  const b0 = batch([...base, ...bedroom(), ...r.ops, ...shape('sh:n', r.id, 'poly', rectPts(20, 0, 5, 4))]);
  const x1 = batch(setRoomOps(m, r.id, { hw: 2.8 }), 'A'), x2 = batch(setRoomOps(m, r.id, { wc: 'PT-09' }), 'B');
  const s1 = new Store(), s2 = new Store();
  s1.apply(b0); s1.apply(x1); s1.apply(x2); s2.apply(x2); s2.apply(b0); s2.apply(x1);
  for (const s of [s1, s2]) { const mm = buildQtoModel(s, null); assert.equal(mm.fin.roomById.get(r.id)!.hw, 2.8); assert.equal(mm.fin.roomById.get(r.id)!.wc, 'PT-09'); }
  // an additional finish, made and changed through the builders
  const add = addFinishOps(m, 'me', 'ti:r1', 'wall', { name: 'Wallpaper', code: 'wp-03', h: 2.9 })!;
  apply(st, [...add.ops, ...shape('sh:wp', add.id, 'line', J([P(5), P(0), P(5), P(4)]))]);
  m = buildQtoModel(st, null);
  close(qty(m, 'ti:r1', 'wall'), 36.55);
  assert.ok(!(m.tree.get('') ?? []).some((n) => n.id === add.id), 'not in the list as a take-off of its own');
  assert.deepEqual(m.items.map((i) => i.id).slice(0, 2), ['ti:r1', add.id], 'right after its room');
  // moved with its outline
  assert.deepEqual(attachedShapes(m, m.shapes.find((x) => x.id === 'sh:r1o')!).map((x) => x.id), ['sh:wp']);
  assert.deepEqual(attachedShapes(m, m.shapes.find((x) => x.id === 'sh:n')!), []);
  apply(st, setFinishPartOps(m, add.id, { deduct: false }));
  m = buildQtoModel(st, null);
  close(qty(m, 'ti:r1', 'wall'), 48.15);
  apply(st, setWaterproofingOps(m, 'ti:r1', { mode: 'up', code: 'wp-01', upturn: 0.3 }));
  m = buildQtoModel(st, null);
  close(qty(m, 'ti:r1', 'wph'), 20);
  // duplicate: settings, outline with its door and window (sill kept), additional finish
  const dup = duplicateItemOps(m, 'ti:r1', 'me', { links: false, shapes: true })!;
  apply(st, dup.ops);
  m = buildQtoModel(st, null);
  for (const k of ['floor', 'wall', 'skirting', 'wpv']) close(qty(m, dup.id, k), qty(m, 'ti:r1', k)!, k, 1e-4);
  assert.equal(m.fin.partsByRoom.get(dup.id)!.length, 1);
  // delete: its finishes go with it (and come back with undo - they were only marked deleted)
  const del = deleteItemOps(m, 'ti:r1');
  assert.ok(del.some((o) => o[0] === add.id) && del.some((o) => o[0] === 'op:r1w'));
  apply(st, del);
  m = buildQtoModel(st, null);
  assert.ok(!m.itemById.has('ti:r1') && !m.itemById.has(add.id));
  assert.equal(m.roomOpenings.filter((o) => o.sh === 'sh:r1o').length, 0);
  // (undo writes every value back)
  apply(st, del.map(([e]) => [e, 'del', null] as Op));
  m = buildQtoModel(st, null);
  assert.ok(m.itemById.has(add.id), 'the room back: its additional finish too');
});

test('private: a private room is its owner\'s only, its finishes with it; a private take-off never changes a shared room', () => {
  const ops: Op[] = [...base, ...bedroom(), ['ti:r1', 'priv', true], ['ti:r1', 'owner', 'omar'],
    ...part('ti:wp', 'ti:r1', 'wall', { fcode: 'WP-03', h: 2.9, priv: true, owner: 'omar' }), ...shape('sh:wp', 'ti:wp', 'line', J([P(5), P(0), P(5), P(4)])),
    ...room('ti:s', 'Hall', { wc: 'PT-01', hw: 3 }, 'a1'), ...shape('sh:s', 'ti:s', 'poly', rectPts(20, 0, 4, 4)),
    ['ti:x', 'kind', 'area'], ['ti:x', 'name', 'Scratch'], ['ti:x', 'priv', true], ['ti:x', 'owner', 'omar'], ['ti:x', 'rm', 'ti:s'], ['ti:x', 'rk', 'link'], ['ti:x', 'rcat', 'wall'], ...shape('sh:x', 'ti:x', 'poly', rectPts(20, 0, 1, 1))];
  const st = apply(new Store(), ops);
  const omar = buildQtoModel(st, { username: 'omar', seeAll: false }), ahmed = buildQtoModel(st, { username: 'ahmed', seeAll: false });
  close(qty(omar, 'ti:r1', 'wall'), 36.55);
  assert.ok(!ahmed.itemById.has('ti:r1') && !ahmed.itemById.has('ti:wp'));
  // the shared hall: the same on both PCs (the private take-off linked to it is left out)
  close(qty(omar, 'ti:s', 'wall'), 48); close(qty(ahmed, 'ti:s', 'wall'), 48);
  // the summary (and so every BOQ figure) is the same for everyone: private rooms are not in it
  assert.equal(JSON.stringify(omar.fin.atoms), JSON.stringify(ahmed.fin.atoms));
  // made shared: its additional finish is seen with it, whatever it said of itself
  apply(st, [['ti:r1', 'priv', null]]);
  close(qty(buildQtoModel(st, { username: 'ahmed', seeAll: false }), 'ti:r1', 'wall'), 36.55);
});

test('the same totals whatever order the changes arrive in', () => {
  const batches = [
    batch(twoFloors()),
    batch([...part('ti:a', 'ti:liv', 'wall', { fcode: 'WP-03', h: 2.9 }), ...shape('sh:a', 'ti:a', 'line', J([P(0), P(0), P(5), P(0)]))]),
    batch(door('op:x', 'sh:liv', 1, 0)),
    batch(opening('op:y', 'sh:liv', 2.5, 5, 1.5, 1.5, 0.9)),
    batch([['sh:liv', 'sg', J([null, '~o', null, null])]]),
    batch([['ti:bed', 'x', 3], ['ti:bed', 'kc', 'SK-01'], ['ti:bed', 'hs', 0.1]]),
    batch([['fl:1', 'code', 'PT-08'], ['fl:1', 'unit', 'm²'], ['fl:1', 'g', J([['h0', 'hd:gf']])], ['fl:1', 'to', 'b:L1']]),
    batch([['fl:2', 'code', 'pt-08'], ['fl:2', 'unit', 'm²'], ['fl:2', 'g', J([])], ['fl:2', 'to', 'b:L2']]),
  ];
  const result = (order: Batch[]) => {
    const st = new Store();
    for (const b of order) st.apply(b);
    const m = buildQtoModel(st, null);
    return JSON.stringify([[...m.boqQty].map(([k, v]) => [k, v.total]).sort(), m.fin.atoms.map((a) => [a.id, a.qty, a.link]), m.fin.codes]);
  };
  const ref = result(batches);
  const rnd = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let k = 1; k <= 6; k++) {
    const r = rnd(k);
    const order = [...batches].sort(() => r() - 0.5);
    assert.equal(result(order), ref);
  }
  const m = buildQtoModel((() => { const st = new Store(); batches.forEach((b) => st.apply(b)); return st; })(), null);
  // fl:1 (older) has the ground floor; fl:2 (all PT-08, newer) the rest, the ground floor flagged as under two links
  assert.ok(m.fin.linkById.get('fl:1')!.qty > 0 && m.fin.linkById.get('fl:2')!.qty > 0);
  assert.ok(m.fin.atomById.get('ti:liv/wall')!.flags.includes('twoLinks'));
});

test('the data format: rooms, room links, portion links, breakdowns and sills need the new format; a finish code alone does not', () => {
  assert.ok(needsFormatFinishes([['ti:x', 'kind', 'room']]));
  assert.ok(needsFormatFinishes([['ti:x', 'rm', 'ti:r']]));
  assert.ok(needsFormatFinishes([['fl:x', 'to', 'b:1']]));
  assert.ok(needsFormatFinishes([['fb:x', 'name', 'a']]));
  assert.ok(needsFormatFinishes([['op:x', 'sill', 0.9]]));
  assert.ok(!needsFormatFinishes([['ti:x', 'fcode', 'PT-01'], ['ti:x', 'kind', 'area'], ['ti:x', 'rm', null]]));
});
