// v0.18.1 (Nabil, 11 Nov: "it should be required by default to insert a code for the soffit. then additional items
// will be false ceilings") - rooms soffit first: the soffit is what the false ceilings don't cover (drawn over each
// other: once); a full-room false ceiling is what the drawn ones leave of the room; the soffit's code is asked for
// while it has m²; a new room starts so, and copies the last room of its name (its full false ceilings too); a room
// from before converts with its figures kept. Worked out by hand above each check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/engine/store';
import { buildQtoModel, type QtoModel } from '../src/engine/qto/model';
import { scaleFromRatio } from '../src/engine/qto/geometry';
import { roomWorking, planUnionArea } from '../src/engine/qto/rooms';
import { newRoomOps, soffitFirstOps, fromTemplate } from '../src/engine/qto/roomops';
import type { Op, Batch } from '../src/engine/types';

let seq = 0;
const batch = (ops: Op[], u = 'T'): Batch => { seq++; return { s: String(seq).padStart(10, '0') + '~' + u, w: 'w' + u, u, t: seq, o: ops } as Batch; };
const apply = (st: Store, ops: Op[], u = 'T') => { st.apply(batch(ops, u)); return st; };
const close = (a: unknown, b: number, msg = '', eps = 1e-6) => assert.ok(typeof a === 'number' && Math.abs(a - b) < eps, `${msg} ${a} != ${b}`);
const S = scaleFromRatio(100);
const P = (x: number) => x / S;
const J = JSON.stringify;
const rectPts = (x0: number, y0: number, w: number, h: number) => J([P(x0), P(y0), P(x0 + w), P(y0), P(x0 + w), P(y0 + h), P(x0), P(y0 + h)]);
const shape = (id: string, ti: string, k: 'poly' | 'line', p: string): Op[] => [[id, 'ti', ti], [id, 'dwg', 'd1'], [id, 'pg', 0], [id, 'k', k], [id, 'p', p]];
const room = (id: string, f: Record<string, unknown> = {}): Op[] => [[id, 'kind', 'room'], [id, 'name', 'Bedroom'], [id, 'ord', 'a0'], ...Object.entries(f).map(([k, v]) => [id, k, v] as Op)];
const part = (id: string, rm: string, cat: string, kind: 'line' | 'area', f: Record<string, unknown> = {}): Op[] => [[id, 'kind', kind], [id, 'name', String(f.name ?? 'False ceiling')], [id, 'rm', rm], [id, 'rk', String(f.rk ?? 'add')], [id, 'rcat', cat], ...Object.entries(f).filter(([k]) => k !== 'name' && k !== 'rk').map(([k, v]) => [id, k, v] as Op)];
const base: Op[] = [['pg:d1.0', 'sc', S]];
const qty = (m: QtoModel, key: string, rid = 'ti:r') => m.fin.qty.get(rid)!.byKey.get(key);
const flags = (m: QtoModel, rid = 'ti:r') => m.fin.qty.get(rid)!.flags;
/** a 6 × 4 room (A 24, P 20), 3.2 m to the soffit */
const r = (f: Record<string, unknown> = {}) => [...base, ...room('ti:r', { cs: true, cc: 'PT-05', rmh: 3.2, ...f }), ...shape('sh:r', 'ti:r', 'poly', rectPts(0, 0, 6, 4))];
const build = (ops: Op[]) => buildQtoModel(apply(new Store(), ops), null);

test('a full-room false ceiling is what the drawn ones leave; the soffit is then all covered', () => {
  // GF-01 full at 2.7; MR board 2 × 2 = 4 drawn at 2.6: GF-01 = 24 - 4 = 20, MR 4, soffit 0
  const ops = [...r(), ...part('ti:gf', 'ti:r', 'ceiling', 'area', { fcode: 'GF-01', lv: 2.7, full: true }),
    ...part('ti:mr', 'ti:r', 'ceiling', 'area', { fcode: 'MR-01', lv: 2.6 }), ...shape('sh:mr', 'ti:mr', 'poly', rectPts(0, 0, 2, 2))];
  let m = build(ops);
  close(qty(m, 'ti:gf')!.qty, 20, 'GF-01 = room less the MR board');
  close(qty(m, 'ti:mr')!.qty, 4, 'MR board');
  close(qty(m, 'ceiling')!.qty, 0, 'soffit all covered');
  assert.ok(!flags(m).includes('soffitCode') && !flags(m).includes('addOverlap'), flags(m).join());
  assert.ok(roomWorking(m, 'ti:r').some((l) => /full room area 24\.00 − the false ceilings drawn 4\.00 = 20\.00/.test(l)), roomWorking(m, 'ti:r').join('\n'));
  // anti-fungal above GF-01: its 20 m², not the room's 24
  m = build([...ops, ['ti:gf', 'fa', true], ['ti:gf', 'fac', 'AF-01']]);
  close(qty(m, 'ti:gf>above')!.qty, 20, 'above GF-01');
  // no soffit code with all of it covered: not asked for
  m = build([...ops.filter((o) => !(o[0] === 'ti:r' && o[1] === 'cc'))]);
  assert.ok(!flags(m).includes('soffitCode'));
  // two full ones: flagged
  m = build([...ops, ...part('ti:g2', 'ti:r', 'ceiling', 'area', { fcode: 'GF-02', lv: 2.8, full: true })]);
  assert.ok(flags(m).includes('twoFull'));
});

test('false ceilings drawn over each other: the soffit loses that area once (flagged)', () => {
  // 3 × 4 = 12 and 4 × 4 = 16 from x 2: union x 0..6 = 24 - overlap 1 × 4 = 4 → 12 + 16 - 4 = 24 → soffit 0
  const m = build([...r(), ...part('ti:a', 'ti:r', 'ceiling', 'area', { fcode: 'GF-01', lv: 2.7 }), ...shape('sh:a', 'ti:a', 'poly', rectPts(0, 0, 3, 4)),
    ...part('ti:b', 'ti:r', 'ceiling', 'area', { fcode: 'GF-02', lv: 2.7 }), ...shape('sh:b', 'ti:b', 'poly', rectPts(2, 0, 4, 4))]);
  close(qty(m, 'ceiling')!.qty, 0, 'soffit: 24 - union 24');
  assert.ok(flags(m).includes('addOverlap'));
  // a 1 × 1 apart: union 12 + 1
  const m2 = build([...r(), ...part('ti:a', 'ti:r', 'ceiling', 'area', { fcode: 'GF-01', lv: 2.7 }), ...shape('sh:a', 'ti:a', 'poly', rectPts(0, 0, 3, 4)),
    ...part('ti:b', 'ti:r', 'ceiling', 'area', { fcode: 'GF-02', lv: 2.7 }), ...shape('sh:b', 'ti:b', 'poly', rectPts(5, 3, 1, 1))]);
  close(qty(m2, 'ceiling')!.qty, 24 - 13, 'soffit 11');
  assert.ok(!flags(m2).includes('addOverlap'));
});

test('the soffit\'s code is asked for while it has m²; the room height too', () => {
  let m = build(r({ cc: null }));
  assert.ok(flags(m).includes('soffitCode'));
  m = build(r({ rmh: null }));
  assert.ok(flags(m).includes('noRoomHeight'));
  m = build(r());
  assert.ok(!flags(m).includes('soffitCode') && !flags(m).includes('noRoomHeight'));
});

test('planUnionArea: overlapping squares once; × n or one alone: as they are', () => {
  const sq = (x: number, y: number, a: number) => ({ dwg: 'd', pg: 0, m: 1, flat: [[x, y], [x + a, y], [x + a, y + a], [x, y + a]], holes: [] }) as never;
  const area = (s: { flat: number[][] }) => (s.flat[1][0] - s.flat[0][0]) ** 2;
  close(planUnionArea([sq(0, 0, 2), sq(1, 1, 2)], area as never), 7, '4 + 4 - 1');
  close(planUnionArea([sq(0, 0, 2)], area as never), 4);
});

test('a new room: soffit first; named as the last Bedroom: its settings and its full-room false ceilings', () => {
  const st = apply(new Store(), [...r({ name: 'Bedroom' }), ...part('ti:gf', 'ti:r', 'ceiling', 'area', { fcode: 'GF-01', lv: 2.7, full: true, fa: true, fac: 'AF-01' }), ['ti:r', 'born', 1]]);
  let m = buildQtoModel(st, null);
  const blank = newRoomOps(m, 'T', { name: '' });
  assert.ok(blank.ops.some((o) => o[1] === 'cs' && o[2] === true), 'cs on a new room');
  const nr = newRoomOps(m, 'T', { name: 'Bedroom' });
  apply(st, [...nr.ops, ...shape('sh:n', nr.id, 'poly', rectPts(10, 0, 3, 3))]);
  m = buildQtoModel(st, null);
  const room2 = m.fin.roomById.get(nr.id)!;
  assert.equal(room2.cs, true);
  assert.equal(room2.cc, 'PT-05');
  close(room2.rmh, 3.2);
  const parts = (m.fin.partsByRoom.get(nr.id) ?? []).filter((p) => p.rk === 'add');
  assert.equal(parts.length, 1, 'its full false ceiling copied');
  assert.equal(parts[0].code, 'GF-01'); close(parts[0].lv, 2.7); assert.equal(parts[0].full, true); assert.equal(parts[0].fa, true); assert.equal(parts[0].fac, 'AF-01');
  close(m.fin.qty.get(nr.id)!.byKey.get(parts[0].id)!.qty, 9, '3 × 3');
  close(m.fin.qty.get(nr.id)!.byKey.get('ceiling')!.qty, 0, 'soffit covered');
});

test('a room from before 0.18.1 (its ceiling a false ceiling): converted, its figures the same; a new room named after it too', () => {
  // auto: GYP-01 at 2.7 over the room, an additional CL-02 (deducted) 2 × 2: GYP-01 = 20, CL-02 = 4
  const old = [...base, ...room('ti:o', { cc: 'GYP-01', ch: 2.7, rmh: 3.2, born: 1, wc: 'PT-01' }), ...shape('sh:o', 'ti:o', 'poly', rectPts(0, 0, 6, 4)),
    ...part('ti:c2', 'ti:o', 'ceiling', 'area', { fcode: 'CL-02', lv: 2.6 }), ...shape('sh:c2', 'ti:c2', 'poly', rectPts(0, 0, 2, 2))];
  const st = apply(new Store(), old);
  let m = buildQtoModel(st, null);
  close(qty(m, 'ceiling', 'ti:o')!.qty, 20, 'before: main 24 - 4');
  const wallBefore = m.fin.qty.get('ti:o')!.byKey.get('wall')?.qty;
  // a new room named after it: soffit first, a full false ceiling GYP-01 at 2.7, no soffit code
  const t = fromTemplate(m, 'T', { id: 'ti:new', par: '', ord: 'b0' }, 'Bedroom');
  assert.equal(t.settings.cs, true); assert.equal(t.settings.cc, ''); assert.equal(t.n, 1);
  const cv = soffitFirstOps(m, 'T', 'ti:o');
  apply(st, cv.ops);
  m = buildQtoModel(st, null);
  const fc = (m.fin.partsByRoom.get('ti:o') ?? []).find((p) => p.rk === 'add' && p.full)!;
  close(qty(m, fc.id, 'ti:o')!.qty, 20, 'after: the full false ceiling GYP-01 = 24 - CL-02');
  assert.equal(fc.code, 'GYP-01'); close(fc.lv, 2.7);
  close(qty(m, 'ti:c2', 'ti:o')!.qty, 4);
  close(qty(m, 'ceiling', 'ti:o')!.qty, 0, 'soffit: all covered');
  close(m.fin.qty.get('ti:o')!.byKey.get('wall')?.qty, wallBefore as number, 'walls the same');
  // manual: its drawn ceiling areas become the false ceiling
  const st2 = apply(new Store(), [...base, ...room('ti:o', { cc: 'GYP-01', ch: 2.7, cm: 'manual', rmh: 3.2 }), ...shape('sh:o', 'ti:o', 'poly', rectPts(0, 0, 6, 4)),
    ...part('ti:ca', 'ti:o', 'ceiling', 'area', { name: 'Ceiling areas', rk: 'ceil' }), ...shape('sh:ca', 'ti:ca', 'poly', rectPts(0, 0, 6, 3))]);
  m = buildQtoModel(st2, null);
  close(qty(m, 'ceiling', 'ti:o')!.qty, 18, 'before: drawn 18');
  apply(st2, soffitFirstOps(m, 'T', 'ti:o').ops);
  m = buildQtoModel(st2, null);
  close(qty(m, 'ti:ca', 'ti:o')!.qty, 18, 'the false ceiling 18');
  assert.equal((m.fin.partsByRoom.get('ti:o') ?? []).find((p) => p.id === 'ti:ca')!.code, 'GYP-01');
  close(qty(m, 'ceiling', 'ti:o')!.qty, 6, 'the soffit: the rest, 6');
  assert.ok(m.fin.qty.get('ti:o')!.flags.includes('soffitCode'), 'and its code asked for');
});

// 0.23.2 (DeepSeek #37): the soffit code above a false ceiling is in the code list and spelled one way
test('the code above a false ceiling: in the code list, one spelling across rooms', async () => {
  const { codeList } = await import('../src/engine/qto/finishes');
  const two = [...r(), ...part('ti:gf', 'ti:r', 'ceiling', 'area', { fcode: 'GF-01', lv: 2.7, full: true, fa: true, fac: 'AF-01' }),
    ...room('ti:r2', { cs: true, cc: 'PT-05', rmh: 3.2 }), ...shape('sh:r2', 'ti:r2', 'poly', rectPts(10, 0, 6, 4)),
    ...part('ti:gf2', 'ti:r2', 'ceiling', 'area', { fcode: 'GF-01', lv: 2.7, full: true, fa: true, fac: 'af-01' })];
  const m = build(two);
  // (the summary's and the export's lines: the finish code atoms)
  const above = m.fin.atoms.filter((a) => /^af-01/i.test(a.code)).map((a) => a.code);
  assert.equal(above.length, 2, 'both rooms: ' + m.fin.atoms.map((a) => a.code).join(', '));
  assert.equal(above[0], above[1], 'one spelling');
  assert.ok(codeList(m).some((c) => c.code.toLowerCase().startsWith('af-01')), 'in the code list: ' + codeList(m).map((c) => c.code).join(', '));
});
