// v0.18 (Nabil, 9-11 Nov): rooms with a Room height - the wall finish by the ceiling over each stretch of wall
// (several ceilings at several heights, a wall partly under one, parts with none), the walls above the finish up to
// the soffit (anti-fungal…), plaster (full height / typed / stops with the finish), an elevation that stands for its
// plan edges, miscellaneous items. Every figure here is worked out by hand in the comment above it; the last tests
// check random rooms against an independent calculation, and that a room without a Room height is what it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/engine/store';
import { buildQtoModel, type QtoModel } from '../src/engine/qto/model';
import { scaleFromRatio } from '../src/engine/qto/geometry';
import { roomWorking, roomTree } from '../src/engine/qto/rooms';
import { addMiscOps, miscUnitOps, dupMiscOps, wallReplaceOps, duplicateRoomOps } from '../src/engine/qto/roomops';
import { summarize } from '../src/engine/qto/finishes';
import type { Op, Batch } from '../src/engine/types';

let seq = 0;
const batch = (ops: Op[], u = 'T'): Batch => { seq++; return { s: String(seq).padStart(10, '0') + '~' + u, w: 'w' + u, u, t: seq, o: ops } as Batch; };
const apply = (st: Store, ops: Op[], u = 'T') => { st.apply(batch(ops, u)); return st; };
const close = (a: unknown, b: number, msg = '', eps = 1e-6) => assert.ok(typeof a === 'number' && Math.abs(a - b) < eps, `${msg}: ${a} != ${b}`);
const S = scaleFromRatio(100), S50 = scaleFromRatio(50);
const J = JSON.stringify;
const P = (x: number) => x / S;
const poly = (s: number, pts: [number, number][]) => J(pts.flatMap(([x, y]) => [x / s, y / s]));
const rect = (s: number, x0: number, y0: number, w: number, h: number) => poly(s, [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]]);
const shape = (id: string, ti: string, k: 'poly' | 'line' | 'pt', p: string, dwg = 'd1'): Op[] => [[id, 'ti', ti], [id, 'dwg', dwg], [id, 'pg', 0], [id, 'k', k], [id, 'p', p]];
const room = (id: string, f: Record<string, unknown> = {}): Op[] => [[id, 'kind', 'room'], [id, 'name', 'Lobby'], [id, 'ord', 'a0'], ...Object.entries(f).map(([k, v]) => [id, k, v] as Op)];
const part = (id: string, rm: string, cat: string, kind: 'line' | 'area' | 'count', f: Record<string, unknown> = {}, rk = 'add'): Op[] => [[id, 'kind', kind], [id, 'name', String(f.name ?? 'Part')], [id, 'rm', rm], [id, 'rk', rk], [id, 'rcat', cat], ...Object.entries(f).filter(([k]) => k !== 'name').map(([k, v]) => [id, k, v] as Op)];
const opening = (id: string, sh: string, x: number, y: number, w: number, h: number, sill: number): Op[] => [[id, 'sh', sh], [id, 'x', P(x)], [id, 'y', P(y)], [id, 'k', 'open'], [id, 'w', w], [id, 'h', h], [id, 'sill', sill]];
const base: Op[] = [['pg:d1.0', 'sc', S], ['pg:d2.0', 'sc', S50]];
const build = (ops: Op[]) => buildQtoModel(apply(new Store(), ops), null);
const Q = (m: QtoModel, rid = 'ti:r') => m.fin.qty.get(rid)!;
const qty = (m: QtoModel, key: string, rid = 'ti:r') => Q(m, rid).byKey.get(key);

/** a 6 × 4 room (P 20, A 24), skirting 0.10, wall finish PT-01, room height 3.50 */
const r = (f: Record<string, unknown> = {}): Op[] => [...base, ...room('ti:r', { wc: 'PT-01', hs: 0.1, rmh: 3.5, ...f }), ...shape('sh:r', 'ti:r', 'poly', rect(S, 0, 0, 6, 4))];
/** the soffit is the main ceiling; ceiling A at 2.70 over x 0..4 (all of y), ceiling B at 2.40 over x 4..6, y 0..2;
 *  x 4..6, y 2..4 has no false ceiling.
 *  walls: bottom (y 0): 4 m under A, 2 m under B · right (x 6): 2 m under B, 2 m open to the soffit ·
 *  top (y 4): 2 m open, 4 m under A · left: 4 m under A   ->  A 12 m, B 4 m, none 4 m */
const two = (f: Record<string, unknown> = {}): Op[] => [...r({ cs: true, ...f }),
  ...part('ti:ca', 'ti:r', 'ceiling', 'area', { name: 'Ceiling A', fcode: 'GB-01', lv: 2.7 }), ...shape('sh:ca', 'ti:ca', 'poly', rect(S, 0, 0, 4, 4)),
  ...part('ti:cb', 'ti:r', 'ceiling', 'area', { name: 'Ceiling B', fcode: 'GB-02', lv: 2.4 }), ...shape('sh:cb', 'ti:cb', 'poly', rect(S, 4, 0, 2, 2))];

test('no false ceiling anywhere: the wall finish goes to the room height; nothing above it', () => {
  const m = build(r());
  close(qty(m, 'wall')!.qty, 20 * 3.4, 'P 20 × (3.50 − 0.10)');
  assert.equal(qty(m, 'band'), undefined);
  assert.equal(qty(m, 'plaster'), undefined, 'no plaster code: no plaster');
  assert.deepEqual(Q(m).zones.map((z) => [+z.len.toFixed(6), z.top, z.fc]), [[20, 3.5, null]]);
});

test('one ceiling over the whole room (auto, 2.70): finish to 2.80; the walls above it to the soffit; plaster full height', () => {
  const m = build(r({ cc: 'GB-01', ch: 2.7, bc: 'AF-01', plc: 'PL-01' }));
  close(qty(m, 'wall')!.qty, 20 * 2.7, '20 × (2.70 + 0.10 − 0.10)');
  close(qty(m, 'band')!.qty, 20 * 0.7, '20 × (3.50 − 2.80)');
  assert.equal(qty(m, 'band')!.code, 'AF-01');
  close(qty(m, 'plaster')!.qty, 70, '20 × 3.50');
  const rows = summarize(m).rows.map((x) => x.code + '|' + x.unit + '|' + x.qty.toFixed(2));
  for (const want of ['PT-01|m²|54.00', 'AF-01|m²|14.00', 'PL-01|m²|70.00']) assert.ok(rows.includes(want), want + ' in ' + rows.join(', '));
  const t = roomTree(Q(m));
  assert.ok(t.band && t.plaster && t.misc.length === 0);
});

test('finish above the false ceiling typed (0.25); a ceiling at / above the room height is no false ceiling', () => {
  const m = build(r({ cc: 'GB-01', ch: 2.7, fe: 0.25, bc: 'AF-01' }));
  close(qty(m, 'wall')!.qty, 20 * 2.85);
  close(qty(m, 'band')!.qty, 20 * 0.55);
  // 3.45 + 0.10 would pass the soffit: stopped at 3.50, nothing above
  const m2 = build(r({ cc: 'GB-01', ch: 3.45 }));
  close(qty(m2, 'wall')!.qty, 20 * 3.4);
  assert.equal(qty(m2, 'band'), undefined);
  const m3 = build(r({ cc: 'GB-01', ch: 3.5 }));
  close(qty(m3, 'wall')!.qty, 20 * 3.4);
  assert.equal(qty(m3, 'band'), undefined);
});

test('two ceilings at two heights and a part with none - walls partly under each', () => {
  const m = build(two({ bc: 'AF-01', plc: 'PL-01' }));
  // A 12 × (2.80 − 0.10) = 32.40 · B 4 × (2.50 − 0.10) = 9.60 · none 4 × (3.50 − 0.10) = 13.60
  close(qty(m, 'wall')!.qty, 55.6, 'wall finish');
  // above A 12 × 0.70 = 8.40 · above B 4 × 1.00 = 4.00
  close(qty(m, 'band')!.qty, 12.4, 'walls above the false ceilings');
  close(qty(m, 'plaster')!.qty, 70, 'plaster full height');
  assert.deepEqual(Q(m).zones.map((z) => [+z.len.toFixed(6), +z.top.toFixed(6), z.fc]), [[4, 2.5, 2.4], [12, 2.8, 2.7], [4, 3.5, null]]);
  const w = roomWorking(m, 'ti:r').join('\n');
  assert.match(w, /under the ceiling at 2\.70 .*: 12\.00 × \(2\.80 − 0\.10\) = 32\.40/);
  assert.match(w, /under the ceiling at 2\.40 .*: 4\.00 × \(2\.50 − 0\.10\) = 9\.60/);
  assert.match(w, /no false ceiling \(to the room height\): 4\.00 × \(3\.50 − 0\.10\) = 13\.60/);
  assert.deepEqual(Q(m).flags.filter((f) => f.startsWith('ceil')), []);
});

test('plaster that stops where the finish stops; plaster to a typed height', () => {
  // 12 × 2.80 + 4 × 2.50 + 4 × 3.50 = 57.60
  close(qty(build(two({ plc: 'PL-01', ppf: true })), 'plaster')!.qty, 57.6);
  close(qty(build(two({ plc: 'PL-01', php: 3 })), 'plaster')!.qty, 60, '20 × 3.00');
  // anti-fungal with no plaster at all
  const m = build(two({ bc: 'AF-01' }));
  assert.equal(qty(m, 'plaster'), undefined);
  close(qty(m, 'band')!.qty, 12.4);
});

test('openings: each comes off what it stands in - one across two ceilings, one above a ceiling, one where there is none', () => {
  const m = build([...two({ bc: 'AF-01', plc: 'PL-01' }),
    ...opening('op:d', 'sh:r', 2, 0, 0.9, 2.1, 0),      // a door under A
    ...opening('op:w', 'sh:r', 6, 3, 1.2, 1.5, 1.8),    // a window where there is no false ceiling (1.80 to 3.30)
    ...opening('op:x', 'sh:r', 4, 0, 2.0, 1.0, 2.0)]);  // a high window 2.00 to 3.00, half under A, half under B
  // wall: 55.60 − door 0.9 × 2.0 (1.80) − window 1.2 × 1.5 (1.80) − high window: A half 1.0 × 0.8 + B half 1.0 × 0.5 (1.30)
  close(qty(m, 'wall')!.qty, 55.6 - 1.8 - 1.8 - 1.3, 'wall finish');
  // above: 12.40 − high window: over A 1.0 × 0.2 + over B 1.0 × 0.5 (0.70)
  close(qty(m, 'band')!.qty, 12.4 - 0.7, 'above the ceilings');
  // plaster: 70 − 0.9 × 2.1 − 1.2 × 1.5 − 2.0 × 1.0
  close(qty(m, 'plaster')!.qty, 70 - 1.89 - 1.8 - 2, 'plaster');
});

test('a typed wall height still wins: one height all round; what is above it under a false ceiling is still measured', () => {
  const m = build(two({ hw: 3, bc: 'AF-01' }));
  close(qty(m, 'wall')!.qty, 20 * 2.9);
  // under A and B (16 m): 3.00 to 3.50
  close(qty(m, 'band')!.qty, 16 * 0.5);
});

test('nothing above the false ceiling (bn); no code yet: measured, with a note, kept out of the summary', () => {
  assert.equal(qty(build(two({ bn: true })), 'band'), undefined);
  const m = build(two());
  close(qty(m, 'band')!.qty, 12.4);
  assert.match(qty(m, 'band')!.note ?? '', /No code/);
  assert.ok(!summarize(m).rows.some((x) => Math.abs(x.qty - 12.4) < 1e-6));
});

test('Times multiplies everything; a second outline adds up', () => {
  const m = build(two({ x: 3, bc: 'AF-01', plc: 'PL-01' }));
  close(qty(m, 'wall')!.qty, 55.6 * 3);
  close(qty(m, 'band')!.qty, 12.4 * 3);
  close(qty(m, 'plaster')!.qty, 210);
  // a second outline (3 × 3, P 12) with no ceiling over it: + 12 × 3.40
  const m2 = build([...two(), ...shape('sh:r2', 'ti:r', 'poly', rect(S, 10, 0, 3, 3))]);
  close(qty(m2, 'wall')!.qty, 55.6 + 12 * 3.4);
});

test('an additional wall finish with no height of its own goes as high as the wall finish does over each stretch', () => {
  // along the bottom wall (6 m): 4 m under A up to 2.80, 2 m under B up to 2.50, from the skirting
  const m = build([...two(), ...part('ti:w', 'ti:r', 'wall', 'line', { name: 'Timber', fcode: 'WD-01' }), ...shape('sh:w', 'ti:w', 'line', poly(S, [[0, 0], [6, 0]]))]);
  close(qty(m, 'ti:w')!.qty, 4 * 2.7 + 2 * 2.4, 'timber');
  close(qty(m, 'wall')!.qty, 55.6 - 15.6, 'wall finish less the timber');
  // with its own height 1.20 from the floor (bl 0): 6 × 1.20; off the main only above the skirting: 6 × 1.10
  const m2 = build([...two(), ...part('ti:w', 'ti:r', 'wall', 'line', { name: 'Dado', fcode: 'WD-02', h: 1.2, bl: 0 }), ...shape('sh:w', 'ti:w', 'line', poly(S, [[0, 0], [6, 0]]))]);
  close(qty(m2, 'ti:w')!.qty, 7.2);
  close(qty(m2, 'wall')!.qty, 55.6 - 6.6);
});

test('manual ceilings (drawn areas of the main ceiling) at their own heights; the stretch under none goes to the room height', () => {
  const m = build([...r({ cc: 'GB-01', cm: 'manual', ch: 2.7, bc: 'AF-01' }),
    ...part('ti:c1', 'ti:r', 'ceiling', 'area', { name: 'Ceiling' }, 'ceil'), ...shape('sh:c1', 'ti:c1', 'poly', rect(S, 0, 0, 3, 4))]);
  // under the drawn ceiling (room's 2.70): 3 + 4 + 3 = 10 m × 2.70 ; the rest 10 m × 3.40
  close(qty(m, 'wall')!.qty, 10 * 2.7 + 10 * 3.4);
  close(qty(m, 'band')!.qty, 10 * 0.7);
});

test('a ceiling drawn a little short of the wall is still over it; one well inside is not; the lowest wins where two overlap', () => {
  // 5 cm short all round: still over every wall
  const m = build([...r({ cs: true }), ...part('ti:ca', 'ti:r', 'ceiling', 'area', { lv: 2.7 }), ...shape('sh:ca', 'ti:ca', 'poly', rect(S, 0.05, 0.05, 5.9, 3.9))]);
  close(qty(m, 'wall')!.qty, 20 * 2.7, 'short by 5 cm');
  // an island 1 m in from every wall: no wall under it
  const m2 = build([...r({ cs: true }), ...part('ti:ca', 'ti:r', 'ceiling', 'area', { lv: 2.7 }), ...shape('sh:ca', 'ti:ca', 'poly', rect(S, 1, 1, 4, 2))]);
  close(qty(m2, 'wall')!.qty, 20 * 3.4);
  // a lower ceiling (2.40, x 0..2) under a higher one (2.70, whole room): 2 + 4 + 2 = 8 m to 2.50, 12 m to 2.80
  const m3 = build([...r({ cs: true }), ...part('ti:ca', 'ti:r', 'ceiling', 'area', { lv: 2.7, full: true }),
    ...part('ti:cb', 'ti:r', 'ceiling', 'area', { lv: 2.4 }), ...shape('sh:cb', 'ti:cb', 'poly', rect(S, 0, 0, 2, 4))]);
  close(qty(m3, 'wall')!.qty, 8 * 2.4 + 12 * 2.7);
});

test('open edges get nothing; an L-shaped room; a ceiling on another sheet is said, not guessed', () => {
  // L: (0,0) (6,0) (6,2) (3,2) (3,4) (0,4): P 20; edge 0 (bottom, 6 m) open -> walls 14 m
  const L = poly(S, [[0, 0], [6, 0], [6, 2], [3, 2], [3, 4], [0, 4]]);
  const m = build([...base, ...room('ti:r', { wc: 'PT-01', hs: 0.1, rmh: 3.5, cs: true, bc: 'AF-01' }), ...shape('sh:r', 'ti:r', 'poly', L), ['sh:r', 'sg', J(['~o'])],
    // a ceiling at 2.70 over the leg x 0..3, y 2..4: walls (3,2)->(3,4) 2 m, (3,4)->(0,4) 3 m, left wall y 2..4 2 m = 7 m
    ...part('ti:ca', 'ti:r', 'ceiling', 'area', { lv: 2.7 }), ...shape('sh:ca', 'ti:ca', 'poly', rect(S, 0, 2, 3, 2))]);
  close(Q(m).P, 14, 'wall edges');
  close(qty(m, 'wall')!.qty, 7 * 2.7 + 7 * 3.4);
  close(qty(m, 'band')!.qty, 7 * 0.7);
  const m2 = build([...r({ cs: true }), ...part('ti:ca', 'ti:r', 'ceiling', 'area', { lv: 2.7 }), ...shape('sh:ca', 'ti:ca', 'poly', rect(S50, 0, 0, 6, 4), 'd2')]);
  assert.ok(Q(m2).flags.includes('ceilElsewhere'));
  close(qty(m2, 'wall')!.qty, 20 * 3.4, 'not guessed: to the room height');
  // a ceiling with no height: said
  const m3 = build([...r({ cs: true }), ...part('ti:ca', 'ti:r', 'ceiling', 'area', {}), ...shape('sh:ca', 'ti:ca', 'poly', rect(S, 0, 0, 6, 4))]);
  assert.ok(Q(m3).flags.includes('ceilLevel'));
});

test('an elevation that stands for its plan edges: the wall finish is not taken there - the elevation is', () => {
  // (a room as before 0.18: wall finish to 3.10) 20 × 3.00 = 60; the bottom wall (6 m) measured on its elevation: 15.5 m²
  const old = (f: Record<string, unknown> = {}) => [...base, ...room('ti:r', { wc: 'PT-01', hw: 3.1, hs: 0.1, ...f }), ...shape('sh:r', 'ti:r', 'poly', rect(S, 0, 0, 6, 4))];
  const elev: Op[] = [...part('ti:e', 'ti:r', 'wall', 'area', { name: 'Elevation A', fcode: 'PT-01', wa: true, wr: true }), ...shape('sh:e', 'ti:e', 'poly', rect(S50, 0, 0, 6.2, 2.5), 'd2')];
  const m = build([...old(), ...elev, ...shape('sh:el', 'ti:e', 'line', poly(S, [[0, 0], [6, 0]]))]);
  close(qty(m, 'ti:e')!.qty, 15.5, 'the elevation as drawn');
  close(qty(m, 'wall')!.qty, 60 - 18, 'the wall finish without that wall (6 × 3.00)');
  // a door on that wall is the elevation's business: it does not come off the rest
  const md = build([...old(), ...elev, ...shape('sh:el', 'ti:e', 'line', poly(S, [[0, 0], [6, 0]])), ...opening('op:d', 'sh:r', 2, 0, 0.9, 2.1, 0)]);
  close(qty(md, 'wall')!.qty, 42, 'door on the replaced wall: not taken off twice');
  // no plan edges drawn yet: said; the area comes off as before
  const m2 = build([...old(), ...elev]);
  assert.ok(Q(m2).flags.includes('replNoEdge'));
  close(qty(m2, 'wall')!.qty, 60 - 15.5);
  // a room with ceilings: the stretch under A (4 m to 2.80) and under B (2 m to 2.50) goes
  const m3 = build([...two(), ...elev, ...shape('sh:el', 'ti:e', 'line', poly(S, [[0, 0], [6, 0]]))]);
  close(qty(m3, 'wall')!.qty, 55.6 - 4 * 2.7 - 2 * 2.4);
  // the op: on, off
  const on = wallReplaceOps(build([...old(), ...part('ti:e', 'ti:r', 'wall', 'area', { wa: true })]), 'ti:e', true);
  assert.deepEqual(on, [['ti:e', 'wr', true]]);
});

test('miscellaneous items: counted, a length, a length × height, an area, typed; Times; in the summary by code', () => {
  const m0 = build(r({ x: 2 }));
  const a = addMiscOps(m0, 'T', 'ti:r', { name: 'Vanity unit', code: 'JN-01', mf: 'white lacquer' })!;
  const b = addMiscOps(m0, 'T', 'ti:r', { name: 'Kitchen base cabinets', code: 'JN-02', mu: 'm' })!;
  const c = addMiscOps(m0, 'T', 'ti:r', { name: 'Wardrobe', code: 'JN-03', mu: 'm', h: 2.4 })!;
  const d = addMiscOps(m0, 'T', 'ti:r', { name: 'Mirror', code: 'MR-01', mu: 'm2' })!;
  const e = addMiscOps(m0, 'T', 'ti:r', { name: 'Towel rail', code: 'AC-01', mq: 5 })!;
  const m = build([...r({ x: 2 }), ...a.ops, ...b.ops, ...c.ops, ...d.ops, ...e.ops,
    ...shape('sh:a', a.id, 'pt', J([P(1), P(1), P(2), P(1), P(3), P(1)])),
    ...shape('sh:b', b.id, 'line', poly(S, [[0, 0], [2.4, 0]])),
    ...shape('sh:c', c.id, 'line', poly(S, [[0, 4], [1.8, 4]])),
    ...shape('sh:d', d.id, 'poly', rect(S, 1, 1, 1.2, 0.8))]);
  const f = (id: string) => qty(m, id)!;
  assert.equal(f(a.id).unit, 'nr'); close(f(a.id).qty, 3 * 2, 'vanities × Times');
  assert.equal(f(a.id).fin, 'white lacquer');
  assert.equal(f(b.id).unit, 'm'); close(f(b.id).qty, 2.4 * 2);
  // (v0.18.1 a length with a height: its length in m, and its m² under it)
  assert.equal(f(c.id).unit, 'm'); close(f(c.id).qty, 1.8 * 2, 'length');
  assert.equal(qty(m, c.id + '>area')!.unit, 'm²'); close(qty(m, c.id + '>area')!.qty, 1.8 * 2.4 * 2, 'length × height');
  assert.equal(f(d.id).unit, 'm²'); close(f(d.id).qty, 0.96 * 2);
  close(f(e.id).qty, 10, 'typed 5 × Times');
  assert.equal(roomTree(Q(m)).misc.length, 5);
  // they change nothing else of the room
  close(qty(m, 'floor')!.qty, 48); close(qty(m, 'wall')!.qty, 20 * 3.4 * 2);
  const rows = summarize(m).rows.map((x) => x.code + '|' + x.unit + '|' + x.qty.toFixed(2));
  for (const want of ['JN-01|nr|6.00', 'JN-02|m|4.80', 'JN-03|m|3.60', 'JN-03|m²|8.64', 'MR-01|m²|1.92', 'AC-01|nr|10.00']) assert.ok(rows.includes(want), want + ' in ' + rows.join(', '));
  // its unit changes only while nothing is drawn; a copy keeps what is typed
  assert.ok('error' in (miscUnitOps(m, a.id, 'm') as object));
  assert.deepEqual(miscUnitOps(m, e.id, 'm2'), [[e.id, 'kind', 'area'], [e.id, 'mu', 'm2']]);
  const dup = dupMiscOps(m, 'T', e.id)!;
  assert.ok(dup.ops.some((o) => o[1] === 'mq' && o[2] === 5) && dup.ops.some((o) => o[1] === 'ak' && o[2] === 'misc'));
  // not in the take-off list, not a finish of a category
  assert.ok(!JSON.stringify(m.itemTree).includes(a.id));
  assert.equal(qty(m, a.id)!.cat, null);
});

test('a copy of the room carries the room height, the ceilings and the miscellaneous items', () => {
  const m0 = build(two({ bc: 'AF-01', plc: 'PL-01', fe: 0.2 }));
  const mi = addMiscOps(m0, 'T', 'ti:r', { name: 'Mirror', code: 'MR-01', mq: 2 })!;
  const m1 = build([...two({ bc: 'AF-01', plc: 'PL-01', fe: 0.2 }), ...mi.ops]);
  const cp = duplicateRoomOps(m1, 'ti:r', 'T', { shapes: true })!;
  const m2 = build([...two({ bc: 'AF-01', plc: 'PL-01', fe: 0.2 }), ...mi.ops, ...cp.ops]);
  for (const k of ['wall', 'band', 'plaster', 'floor']) close(qty(m2, k, cp.id)!.qty, qty(m2, k)!.qty, k, 1e-3);
  assert.equal(roomTree(Q(m2, cp.id)).misc.length, 1);
});

test('a room without a Room height is what it was: same figures with and without the new fields set', () => {
  const old = (f: Record<string, unknown> = {}): Op[] => [...base, ...room('ti:r', { wc: 'PT-01', hw: 2.8, hs: 0.1, cc: 'GB-01', ch: 2.7, ...f }), ...shape('sh:r', 'ti:r', 'poly', rect(S, 0, 0, 6, 4)),
    ...opening('op:d', 'sh:r', 2, 0, 0.9, 2.1, 0), ...part('ti:w', 'ti:r', 'wall', 'line', { fcode: 'WD-01' }), ...shape('sh:w', 'ti:w', 'line', poly(S, [[6, 0], [6, 4]]))];
  const a = Q(build(old())), b = Q(build(old({ fe: 0.3, bc: 'AF-01', plc: 'PL-01', ppf: true })));
  assert.deepEqual(b.finishes.map((f) => [f.key, f.qty]), a.finishes.map((f) => [f.key, f.qty]), 'the new fields do nothing without a room height');
  assert.equal(a.byKey.get('band'), undefined);
  // and it equals the same room with a room height and its ceiling at 2.70 (finish to 2.80)
  const z = Q(build([...base, ...room('ti:r', { wc: 'PT-01', hs: 0.1, cc: 'GB-01', ch: 2.7, rmh: 3.5, bn: true }), ...shape('sh:r', 'ti:r', 'poly', rect(S, 0, 0, 6, 4)),
    ...opening('op:d', 'sh:r', 2, 0, 0.9, 2.1, 0), ...part('ti:w', 'ti:r', 'wall', 'line', { fcode: 'WD-01' }), ...shape('sh:w', 'ti:w', 'line', poly(S, [[6, 0], [6, 4]]))]));
  for (const k of ['wall', 'ti:w', 'floor', 'ceiling', 'skirting']) if (a.byKey.get(k)) close(z.byKey.get(k)!.qty, a.byKey.get(k)!.qty, k, 1e-9);
});

// ---------------------------------------------------------------- random rooms against an independent calculation
/** a small seeded generator (the same rooms on every run) */
const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
test('random rooms (ceilings at random places and heights, openings anywhere): the engine against walking round the walls a millimetre at a time', () => {
  const rnd = rng(20261111);
  const r2 = (lo: number, hi: number, step = 0.05) => Math.round((lo + rnd() * (hi - lo)) / step) * step;
  for (let n = 0; n < 60; n++) {
    const W = r2(3, 9, 0.5), D = r2(3, 7, 0.5), H = r2(3, 4.5, 0.1), Hs = r2(0, 0.15, 0.05), fe = r2(0, 0.3, 0.05);
    const cs = rnd() < 0.5, ch = cs ? null : r2(2.4, H + 0.2, 0.1);
    const ceils: { x: number; y: number; w: number; h: number; lv: number }[] = [];
    for (let i = 0, k = Math.floor(rnd() * 4); i < k; i++) {
      // (sides kept half a metre off the walls unless on them: the engine looks 12 cm in)
      const x = rnd() < 0.5 ? 0 : r2(0.5, W - 1.5, 0.5), y = rnd() < 0.5 ? 0 : r2(0.5, D - 1.5, 0.5);
      const w = rnd() < 0.4 ? W - x : Math.min(W - x, r2(1, W - x, 0.5)), h = rnd() < 0.4 ? D - y : Math.min(D - y, r2(1, D - y, 0.5));
      if (W - (x + w) > 1e-9 && W - (x + w) < 0.5) continue;
      if (D - (y + h) > 1e-9 && D - (y + h) < 0.5) continue;
      ceils.push({ x, y, w, h, lv: r2(2.2, H + 0.2, 0.1) });
    }
    const ops: { at: number; w: number; h: number; sill: number; x: number; y: number }[] = [];
    for (let i = 0, k = Math.floor(rnd() * 4); i < k; i++) {
      // on the bottom wall (y 0) or the right wall (x W), clear of the corners and of each other
      const onB = rnd() < 0.5, len = onB ? W : D, w = r2(0.6, 1.2, 0.1), c = r2(0.8, len - 0.8, 0.1);
      const at = onB ? c : W + c;
      if (ops.some((o) => Math.abs(o.at - at) < (o.w + w) / 2 + 0.05)) continue;
      ops.push({ at, w, h: r2(0.5, 2.4, 0.1), sill: rnd() < 0.5 ? 0 : r2(0.3, 2.6, 0.1), x: onB ? c : W, y: onB ? 0 : c });
    }
    const all: Op[] = [...base, ...room('ti:r', { wc: 'PT-01', hs: Hs, rmh: H, fe, cs: cs || null, ch, cc: 'GB-01', bc: 'AF-01', plc: 'PL-01' }), ...shape('sh:r', 'ti:r', 'poly', rect(S, 0, 0, W, D))];
    ceils.forEach((c, i) => all.push(...part('ti:c' + i, 'ti:r', 'ceiling', 'area', { lv: c.lv }), ...shape('sh:c' + i, 'ti:c' + i, 'poly', rect(S, c.x, c.y, c.w, c.h))));
    ops.forEach((o, i) => all.push(...opening('op:' + i, 'sh:r', o.x, o.y, o.w, o.h, o.sill)));
    const m = build(all);
    // --- independently: walk round the walls in 1 mm steps (bottom, right, top, left)
    const step = 0.001, Pm = 2 * (W + D);
    let wall = 0, band = 0, plaster = 0;
    const ov = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
    for (let s = step / 2; s < Pm; s += step) {
      let x: number, y: number;
      if (s < W) { x = s; y = 0.06; } else if (s < W + D) { x = W - 0.06; y = s - W; } else if (s < 2 * W + D) { x = W - (s - W - D); y = D - 0.06; } else { x = 0.06; y = D - (s - 2 * W - D); }
      let fc: number | null = null;
      const over = ceils.filter((c) => x > c.x && x < c.x + c.w && y > c.y && y < c.y + c.h).sort((a, b) => a.lv - b.lv)[0];
      if (over) fc = over.lv < H - 1e-9 ? over.lv : null;
      else if (!cs && ch !== null && ch < H - 1e-9) fc = ch;
      const top = fc !== null ? Math.min(fc + fe, H) : H;
      const o = ops.find((q) => Math.abs(q.at - s) < q.w / 2);
      wall += step * (Math.max(0, top - Hs) - (o ? ov(o.sill, o.sill + o.h, Hs, top) : 0));
      plaster += step * (H - (o ? ov(o.sill, o.sill + o.h, 0, H) : 0));
      if (fc !== null) band += step * (H - top - (o ? ov(o.sill, o.sill + o.h, top, H) : 0));
    }
    const tol = 0.03 + 0.004 * (ceils.length + ops.length) * H;
    const tag = `room ${n} (${W}×${D}, H ${H}, ${ceils.length} ceilings, ${ops.length} openings)`;
    close(qty(m, 'wall')!.qty, wall, tag + ' wall', tol);
    close(qty(m, 'plaster')!.qty, plaster, tag + ' plaster', tol);
    close(qty(m, 'band')?.qty ?? 0, band, tag + ' band', tol);
    // and the stretches add up to the walls
    close(Q(m).zones.reduce((t, z) => t + z.len, 0), Pm, tag + ' zones', 1e-6);
  }
});

// ---------------------------------------------------------------- the fresh-eyes review's finds (11 Nov)
test('review: an elevation no longer standing for its plan edges - the edges go, nothing is taken off twice; it is always deducted while it does', () => {
  const old = (): Op[] => [...base, ...room('ti:r', { wc: 'PT-01', hw: 3.1, hs: 0.1 }), ...shape('sh:r', 'ti:r', 'poly', rect(S, 0, 0, 6, 4))];
  const elev = (f: Record<string, unknown>): Op[] => [...part('ti:e', 'ti:r', 'wall', 'area', { name: 'Elevation A', fcode: 'PT-01', wa: true, ...f }), ...shape('sh:e', 'ti:e', 'poly', rect(S50, 0, 0, 6.2, 2.5), 'd2'), ...shape('sh:el', 'ti:e', 'line', poly(S, [[0, 0], [6, 0]]))];
  // (the edges still there, wr off: only the area comes off - 60 − 15.5)
  close(qty(build([...old(), ...elev({})]), 'wall')!.qty, 44.5, 'wr off, its edges still drawn');
  const m = build([...old(), ...elev({ wr: true })]);
  const off = wallReplaceOps(m, 'ti:e', false) as Op[];
  assert.ok(off.some((o) => o[0] === 'sh:el' && o[1] === 'del' && o[2] === true), 'unticking removes the plan edges');
  // "deduct" off on one that replaces the wall: still replaces it (never the wall twice)
  close(qty(build([...old(), ...elev({ wr: true, rded: false })]), 'wall')!.qty, 42, 'wr with rded false');
});

test('review: a ceiling "on top" above the room’s own ceiling leaves that ceiling over the wall', () => {
  // main ceiling (auto) at 2.60 → finish to 2.70; an on-top ceiling at 3.00 over half the room changes nothing on the walls
  const m = build([...r({ cc: 'GB-01', ch: 2.6, bc: 'AF-01' }), ...part('ti:ca', 'ti:r', 'ceiling', 'area', { lv: 3, rded: false }), ...shape('sh:ca', 'ti:ca', 'poly', rect(S, 0, 0, 3, 4))]);
  close(qty(m, 'wall')!.qty, 20 * 2.6);
  close(qty(m, 'band')!.qty, 20 * 0.8);
  // deducted (it takes the main ceiling's place there): 10 m to 3.10, 10 m to 2.70
  const m2 = build([...r({ cc: 'GB-01', ch: 2.6 }), ...part('ti:ca', 'ti:r', 'ceiling', 'area', { lv: 3 }), ...shape('sh:ca', 'ti:ca', 'poly', rect(S, 0, 0, 3, 4))]);
  close(qty(m2, 'wall')!.qty, 10 * 3.0 + 10 * 2.6);
});

test('review: waterproofing to the full wall height follows the wall finish; a door by an open edge comes off whole', () => {
  // ceiling 2.60 → finish top 2.70: vertical WP 20 × 2.70 (not the soffit's 3.50)
  const m = build(r({ cc: 'GB-01', ch: 2.6, pm: 'full', pc: 'WP-01' }));
  close(qty(m, 'wpv')!.qty, 54);
  // a typed level still wins
  close(qty(build(r({ cc: 'GB-01', ch: 2.6, pm: 'full', pc: 'WP-01', pl: 1.8 })), 'wpv')!.qty, 36);
  // right edge open (segment 1); an opening 1.0 × 2.0 centred 0.2 m from that corner on the bottom wall
  const open = (f: Record<string, unknown>): Op[] => [...base, ...room('ti:r', { wc: 'PT-01', ...f }), ...shape('sh:r', 'ti:r', 'poly', rect(S, 0, 0, 6, 4)), ['sh:r', 'sg', J([null, '~o'])], ...opening('op:1', 'sh:r', 5.8, 0, 1, 2, 0)];
  const a = qty(build(open({ hw: 3.5 })), 'wall')!.qty, b = qty(build(open({ rmh: 3.5 })), 'wall')!.qty;
  close(a, 16 * 3.5 - 2, 'as before'); close(b, a, 'the same in a room with a Room height');
});

test('review: a length with a door on it, linked to Wall with a height of its own', () => {
  const ops: Op[] = [...r({ wc: '' }), [ 'ds:1', 'tag', 'D01'], ['ds:1', 'sw', 0.9], ['ds:1', 'sh', 2.1],
    ['ti:k', 'kind', 'line'], ['ti:k', 'name', 'Panelling'], ['ti:k', 'rm', 'ti:r'], ['ti:k', 'rk', 'link'], ['ti:k', 'rcat', 'wall'], ['ti:k', 'rh', 3], ['ti:k', 'fcode', 'WD-01'],
    ...shape('sh:k', 'ti:k', 'line', poly(S, [[0, 9], [10, 9]])), ['op:1', 'sh', 'sh:k'], ['op:1', 'x', P(3)], ['op:1', 'y', P(9)], ['op:1', 'k', 'door'], ['op:1', 'door', 'ds:1'], ['op:1', 'ln', true]];
  // 10 × 3.00 − 0.9 × 2.1 = 28.11
  close(qty(build(ops), 'ti:k')!.qty, 28.11);
});
