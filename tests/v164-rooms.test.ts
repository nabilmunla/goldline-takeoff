// v0.16.4 rooms (Nabil, 6 Nov): bulkheads (running metres, separate by drop - each drop its own rate; the drop =
// the height of the ceiling it hangs from less its underside; it takes that ceiling's code), the ceilings checked
// against the floor (an alert until a note says why), the soffit (what the ceilings under it don't cover; "finish
// above" a ceiling: its own line and code), higher waterproofing upturns on picked sides (like additional walls).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/engine/store';
import { buildQtoModel, type QtoModel } from '../src/engine/qto/model';
import { scaleFromRatio } from '../src/engine/qto/geometry';
import { roomWorking, roomTree } from '../src/engine/qto/rooms';
import { addBulkheadOps, addUpturnOps, setPartExtraOps, ceilingNoteOps, pickEdgeLineOps, duplicateRoomOps } from '../src/engine/qto/roomops';
import { summarize } from '../src/engine/qto/finishes';
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
const room = (id: string, f: Record<string, unknown> = {}): Op[] => [[id, 'kind', 'room'], [id, 'name', 'Lobby'], [id, 'ord', 'a0'], ...Object.entries(f).map(([k, v]) => [id, k, v] as Op)];
const part = (id: string, rm: string, cat: string, kind: 'line' | 'area', f: Record<string, unknown> = {}): Op[] => [[id, 'kind', kind], [id, 'name', String(f.name ?? 'Part')], [id, 'rm', rm], [id, 'rk', 'add'], [id, 'rcat', cat], ...Object.entries(f).filter(([k]) => k !== 'name').map(([k, v]) => [id, k, v] as Op)];
const base: Op[] = [['pg:d1.0', 'sc', S]];
const qty = (m: QtoModel, key: string, rid = 'ti:r') => m.fin.qty.get(rid)!.byKey.get(key);
/** a 6 × 4 room (A 24, P 20) */
const r = (f: Record<string, unknown> = {}) => [...base, ...room('ti:r', { cc: 'GYP-01', ch: 3.0, ...f }), ...shape('sh:r', 'ti:r', 'poly', rectPts(0, 0, 6, 4))];
const build = (ops: Op[]) => buildQtoModel(apply(new Store(), ops), null);

test('bulkhead: running metres, its drop from the main ceiling in its code, the ceiling\'s code', () => {
  const m = build([...r(), ...part('ti:b', 'ti:r', 'ceiling', 'line', { name: 'Bulkhead', ak: 'bh', bh: 2.7 }), ...shape('sh:b', 'ti:b', 'line', J([P(0), P(1), P(6), P(1)]))]);
  const f = qty(m, 'ti:b')!;
  close(f.qty, 6, 'length');
  assert.equal(f.unit, 'm');
  assert.equal(f.type, 'Bulkhead');
  assert.equal(f.code, 'GYP-01 (bulkhead 300 mm)');
  assert.match(f.name, /300 mm drop/);
  // its own rate: a row of its own in the Finishes Summary, apart from the ceiling's m²
  const sum = summarize(m);
  const codes = sum.rows.map((x) => x.code + '|' + x.unit);
  assert.ok(codes.includes('GYP-01|m²') && codes.includes('GYP-01 (bulkhead 300 mm)|m'), codes.join(', '));
  // the main ceiling (auto) is not touched by it
  close(qty(m, 'ceiling')!.qty, 24, 'ceiling');
  assert.ok(roomTree(m.fin.qty.get('ti:r')!).ceiling.children.some((c) => c.f.key === 'ti:b'), 'under the ceiling in the tree');
});

test('bulkheads of two drops: two lines, two codes; Times applies', () => {
  const m = build([...r({ x: 2 }),
    ...part('ti:b1', 'ti:r', 'ceiling', 'line', { ak: 'bh', bh: 2.7 }), ...shape('sh:b1', 'ti:b1', 'line', J([P(0), P(1), P(6), P(1)])),
    ...part('ti:b2', 'ti:r', 'ceiling', 'line', { ak: 'bh', bh: 2.4 }), ...shape('sh:b2', 'ti:b2', 'line', J([P(1), P(0), P(1), P(4)])),
  ]);
  close(qty(m, 'ti:b1')!.qty, 12, 'b1 × 2');
  close(qty(m, 'ti:b2')!.qty, 8, 'b2 × 2');
  assert.equal(qty(m, 'ti:b2')!.code, 'GYP-01 (bulkhead 600 mm)');
});

test('bulkhead under another ceiling of the room: its height and its code', () => {
  const m = build([...r(),
    ...part('ti:fc', 'ti:r', 'ceiling', 'area', { name: 'False ceiling', fcode: 'FC-02', lv: 2.8 }), ...shape('sh:fc', 'ti:fc', 'poly', rectPts(0, 0, 3, 4)),
    ...part('ti:b', 'ti:r', 'ceiling', 'line', { ak: 'bh', bh: 2.5, bp: 'ti:fc' }), ...shape('sh:b', 'ti:b', 'line', J([P(1), P(0), P(1), P(4)])),
  ]);
  assert.equal(qty(m, 'ti:b')!.code, 'FC-02 (bulkhead 300 mm)');
});

test('bulkhead whose drop is not known: no code, flagged, said; not below its ceiling: the same', () => {
  const m = build([...r({ ch: null }), ...part('ti:b', 'ti:r', 'ceiling', 'line', { ak: 'bh', bh: 2.7 }), ...shape('sh:b', 'ti:b', 'line', J([P(0), P(1), P(6), P(1)]))]);
  assert.equal(qty(m, 'ti:b')!.code, '');
  assert.match(qty(m, 'ti:b')!.note ?? '', /height of the ceiling is not set/);
  assert.ok(m.fin.qty.get('ti:r')!.flags.includes('bhHeight'));
  const m2 = build([...r(), ...part('ti:b', 'ti:r', 'ceiling', 'line', { ak: 'bh', bh: 3.2 }), ...shape('sh:b', 'ti:b', 'line', J([P(0), P(1), P(6), P(1)]))]);
  assert.match(qty(m2, 'ti:b')!.note ?? '', /not below the ceiling/);
});

test('a bulkhead is not an additional ceiling: nothing off the ceiling, not a link target, not hatched area', () => {
  const st = apply(new Store(), r());
  const m0 = buildQtoModel(st, null);
  const b = addBulkheadOps(m0, 'T', 'ti:r', { bh: 2.7 })!;
  apply(st, b.ops);
  const m = buildQtoModel(st, null);
  assert.equal(m.itemById.get(b.id)!.kind, 'line');
  assert.equal(m.fin.partById.get(b.id)!.ak, 'bh');
  close(qty(m, 'ceiling')!.qty, 24, 'ceiling unchanged');
  // picking an edge of the outline: a length along it; picked again: out
  const outline = m.shapes.find((x) => x.id === 'sh:r')!;
  const p1 = pickEdgeLineOps(m, b.id, outline, 0, 'T');
  assert.ok(!('error' in p1) && p1.on);
  apply(st, (p1 as { ops: Op[] }).ops);
  const m2 = buildQtoModel(st, null);
  close(qty(m2, b.id)!.qty, 6, 'picked bottom edge', 1e-4);
  const p2 = pickEdgeLineOps(m2, b.id, m2.shapes.find((x) => x.id === 'sh:r')!, 0, 'T');
  assert.ok(!('error' in p2) && !p2.on, 'picked again: comes out');
  apply(st, (p2 as { ops: Op[] }).ops);
  close(qty(buildQtoModel(st, null), b.id)!.qty, 0, 'out');
});

test('ceilings against the floor: manual areas short of it - flagged until a note, asked again when the figures change', () => {
  const ops = [...r({ cm: 'manual' }), [ 'ti:c', 'kind', 'area'] as Op, ['ti:c', 'name', 'Ceiling areas'] as Op, ['ti:c', 'rm', 'ti:r'] as Op, ['ti:c', 'rk', 'ceil'] as Op, ['ti:c', 'rcat', 'ceiling'] as Op,
    ...shape('sh:c', 'ti:c', 'poly', rectPts(0, 0, 4, 4))];
  const st = apply(new Store(), ops);
  let m = buildQtoModel(st, null);
  let q = m.fin.qty.get('ti:r')!;
  assert.equal(q.ceil.equal, false);
  close(q.ceil.covered, 16, 'covered');
  assert.ok(q.flags.includes('ceilFloor'));
  apply(st, ceilingNoteOps(m, 'ti:r', 'Open to the sky over the light well'));
  m = buildQtoModel(st, null);
  q = m.fin.qty.get('ti:r')!;
  assert.ok(!q.flags.includes('ceilFloor') && q.flags.includes('ceilNoted'));
  assert.equal(q.ceil.noted, 'Open to the sky over the light well');
  // the ceiling area redrawn: the note was for other figures - asked again
  apply(st, [['sh:c', 'p', rectPts(0, 0, 5, 4)]]);
  m = buildQtoModel(st, null);
  assert.ok(m.fin.qty.get('ti:r')!.flags.includes('ceilFloor'));
  // drawn to cover the floor: equal, nothing to say
  apply(st, [['sh:c', 'p', rectPts(0, 0, 6, 4)]]);
  assert.equal(buildQtoModel(st, null).fin.qty.get('ti:r')!.ceil.equal, true);
  // auto: always the floor
  assert.equal(build(r()).fin.qty.get('ti:r')!.ceil.equal, true);
});

test('soffit: the floor less the ceilings under it; finish above a ceiling: its own line, its own code', () => {
  const ops = [...r({ cs: true, cc: 'PT-SOF' }),
    ...part('ti:fc', 'ti:r', 'ceiling', 'area', { name: 'False ceiling', fcode: 'GYP-02', lv: 2.7 }), ...shape('sh:fc', 'ti:fc', 'poly', rectPts(0, 0, 3, 4)),
  ];
  let m = build(ops);
  close(qty(m, 'ceiling')!.qty, 24 - 12, 'soffit = A - false ceiling');
  close(qty(m, 'ti:fc')!.qty, 12, 'false ceiling its own');
  assert.equal(m.fin.qty.get('ti:r')!.ceil.equal, true);
  // the false ceiling's deduct switch does not matter under a soffit (it always hides it)
  m = build([...ops, ['ti:fc', 'rded', false]]);
  close(qty(m, 'ceiling')!.qty, 12, 'deduct off: the same');
  // anti-fungal above the false ceiling
  m = build([...ops, ['ti:fc', 'fa', true], ['ti:fc', 'fac', 'AF-01']]);
  const above = qty(m, 'ti:fc>above')!;
  close(above.qty, 12, 'above');
  assert.equal(above.code, 'AF-01 (SFT)');
  assert.equal(qty(m, 'ceiling')!.code, 'PT-SOF (SFT)', 'the soffit: its code marked SFT');
  close(qty(m, 'ceiling')!.qty, 12, 'soffit paint unchanged');
  assert.ok(roomWorking(m, 'ti:r').some((l) => /Soffit PT-SOF \(SFT\) = A 24\.00 − the false ceilings under it 12\.00/.test(l)), roomWorking(m, 'ti:r').join('\n'));
  // a soffit with no finish: no code, said, kept out of the summary - v0.18.1 (Nabil: soffit first, its code
  // required): flagged while it has m² no false ceiling covers
  m = build(r({ cs: true, cc: null }));
  assert.equal(qty(m, 'ceiling')!.code, '');
  assert.match(qty(m, 'ceiling')!.note ?? '', /The soffit needs its code/);
  assert.ok(m.fin.qty.get('ti:r')!.flags.includes('soffitCode'));
  // a bulkhead under the soffit drops from its height
  m = build([...r({ cs: true, ch: 3.3 }), ...part('ti:b', 'ti:r', 'ceiling', 'line', { ak: 'bh', bh: 2.7 }), ...shape('sh:b', 'ti:b', 'line', J([P(0), P(1), P(6), P(1)]))]);
  assert.equal(qty(m, 'ti:b')!.code, 'GYP-01 (bulkhead 600 mm)');
});

test('higher upturn on picked sides: its height there, in place of the room\'s upturn; a door on it comes off', () => {
  const wp = { pm: 'up', pu: 0.3, pc: 'WP-01' };
  // shower along the left edge (4 m) at 1.8 m
  const st = apply(new Store(), [...r(wp)]);
  let m = buildQtoModel(st, null);
  close(qty(m, 'wpv')!.qty, 20 * 0.3, 'before');
  const u = addUpturnOps(m, 'T', 'ti:r', { h: 1.8 })!;
  apply(st, u.ops);
  m = buildQtoModel(st, null);
  const pk = pickEdgeLineOps(m, u.id, m.shapes.find((x) => x.id === 'sh:r')!, 3, 'T');
  apply(st, (pk as { ops: Op[] }).ops);
  m = buildQtoModel(st, null);
  close(qty(m, u.id)!.qty, 4 * 1.8, 'upturn its own', 1e-4);
  assert.equal(qty(m, u.id)!.code, 'WP-01 (vertical)', 'the vertical code (one code for both: its vertical row) unless its own');
  close(qty(m, 'wpv')!.qty, 16 * 0.3, 'main: the rest of the perimeter', 1e-4);
  // with a door on that edge (0.9 × 2.1): off the upturn up to 1.8, and not off the main there twice
  apply(st, [['op:d', 'sh', 'sh:r'], ['op:d', 'x', P(0)], ['op:d', 'y', P(2)], ['op:d', 'k', 'open'], ['op:d', 'w', 0.9], ['op:d', 'h', 2.1], ['op:d', 'sill', 0]]);
  m = buildQtoModel(st, null);
  close(qty(m, u.id)!.qty, 4 * 1.8 - 0.9 * 1.8, 'door off the upturn', 1e-4);
  close(qty(m, 'wpv')!.qty, 16 * 0.3, 'main unchanged', 1e-4);
  // own code
  apply(st, [[u.id, 'fcode', 'WP-SH']]);
  assert.equal(qty(buildQtoModel(st, null), u.id)!.code, 'WP-SH (vertical)');
  // under Vertical in the tree
  assert.ok(roomTree(buildQtoModel(st, null).fin.qty.get('ti:r')!).wp!.v.children.some((c) => c.f.key === u.id));
});

test('a room copied: its bulkheads hang from the copy\'s own ceilings', () => {
  const st = apply(new Store(), [...r(),
    ...part('ti:fc', 'ti:r', 'ceiling', 'area', { name: 'False ceiling', fcode: 'FC-02', lv: 2.8 }), ...shape('sh:fc', 'ti:fc', 'poly', rectPts(0, 0, 3, 4)),
    ...part('ti:b', 'ti:r', 'ceiling', 'line', { ak: 'bh', bh: 2.5, bp: 'ti:fc' }), ...shape('sh:b', 'ti:b', 'line', J([P(1), P(0), P(1), P(4)])),
  ]);
  const m = buildQtoModel(st, null);
  const d = duplicateRoomOps(m, 'ti:r', 'T', { shapes: true })!;
  apply(st, d.ops);
  const m2 = buildQtoModel(st, null);
  const parts = m2.fin.partsByRoom.get(d.id)!;
  const fc = parts.find((x) => x.it.name === 'False ceiling')!, bh = parts.find((x) => x.ak === 'bh')!;
  assert.equal(bh.bp, fc.id);
  assert.equal(m2.fin.qty.get(d.id)!.byKey.get(bh.id)!.code, 'FC-02 (bulkhead 300 mm)');
  void setPartExtraOps;
});

test('fresh-eyes review: a link made on the bare waterproofing code before the split still covers both (said); the split codes are the same in every room', async () => {
  const { portionLinkOps } = await import('../src/engine/qto/finishes');
  const st = apply(new Store(), [...r({ pm: 'up', pu: 0.3, pc: 'WP-01' }), ['b:1', 'ref', '1.1'], ['b:1', 'unit', 'm2'], ['b:1', 'desc', 'Waterproofing']]);
  let m = buildQtoModel(st, null);
  assert.equal(qty(m, 'wph')!.code, 'WP-01 (horizontal)');
  // (a 0.16.3 link: code WP-01, m², no groups)
  apply(st, [['fl:old', 'code', 'WP-01'], ['fl:old', 'unit', 'm²'], ['fl:old', 'g', '[]'], ['fl:old', 'to', 'b:1']]);
  m = buildQtoModel(st, null);
  const l = m.fin.linkById.get('fl:old')!;
  close(l.qty, 24 + 20 * 0.3, 'still both, never 0');
  assert.equal(l.split, true);
  // another room with the vertical code typed in full: the same row
  const m2 = build([...r({ pm: 'up', pu: 0.3, pc: 'WP-01', pvc: 'WP-01 (vertical)' })]);
  assert.equal(qty(m2, 'wpv')!.code, 'WP-01 (vertical)');
  void portionLinkOps;
});

test('fresh-eyes review: soffit with a ceiling take-off linked (deducted) - it hides the soffit too, never counted twice', () => {
  const m = build([...r({ cs: true, cc: 'PT-SOF' }),
    ['ti:g', 'kind', 'area'], ['ti:g', 'name', 'Gypsum'], ['ti:g', 'fcode', 'GYP'], ['ti:g', 'rm', 'ti:r'], ['ti:g', 'rk', 'link'], ['ti:g', 'rcat', 'ceiling'],
    ...shape('sh:g', 'ti:g', 'poly', rectPts(0, 0, 3, 4))]);
  close(qty(m, 'ceiling')!.qty, 12, 'soffit 24 - linked 12');
});

test('fresh-eyes review: a bulkhead whose ceiling was removed says so (no code), never quietly re-parented', () => {
  const m = build([...r(),
    ...part('ti:fc', 'ti:r', 'ceiling', 'area', { name: 'False ceiling', fcode: 'FC-02', lv: 2.8, del: true }), ...shape('sh:fc', 'ti:fc', 'poly', rectPts(0, 0, 3, 4)),
    ...part('ti:b', 'ti:r', 'ceiling', 'line', { ak: 'bh', bh: 2.5, bp: 'ti:fc' }), ...shape('sh:b', 'ti:b', 'line', J([P(1), P(0), P(1), P(4)])),
  ]);
  assert.equal(qty(m, 'ti:b')!.code, '');
  assert.match(qty(m, 'ti:b')!.note ?? '', /was removed/);
  assert.ok(m.fin.qty.get('ti:r')!.flags.includes('bhHeight'));
});

test('format 5: a room with a soffit, a bulkhead or a higher upturn - older apps open the take-off view only', async () => {
  const { needsFormat164 } = await import('../src/engine/qto/model');
  const { FORMAT_V164, DATA_FORMAT } = await import('../src/engine/version');
  assert.equal(FORMAT_V164, 5);
  assert.ok(DATA_FORMAT >= 5);
  assert.ok(needsFormat164([['ti:b', 'ak', 'bh']]) && needsFormat164([['ti:u', 'ak', 'up']]) && needsFormat164([['ti:r', 'cs', true]]));
  assert.ok(!needsFormat164([['ti:r', 'cs', null]]) && !needsFormat164([['ti:r', 'ch', 3]]) && !needsFormat164([['ti:r', 'cnn', 'open to the sky']]));
  const st = apply(new Store(), r());
  const b = addBulkheadOps(buildQtoModel(st, null), 'T', 'ti:r')!;
  assert.ok(needsFormat164(b.ops as [string, string, unknown][]), 'the ops that make a bulkhead mark it');
});

// ---------------- second review (6 Nov, afternoon)
test('second review: a link made now on a bare waterproofing code takes its own code only (a planter coded WP-01 - not every room\'s split waterproofing)', async () => {
  const { portionLinkOps } = await import('../src/engine/qto/finishes');
  const st = apply(new Store(), [...r({ pm: 'up', pu: 0.3, pc: 'WP-01' }), ['b:1', 'ref', '1.1'], ['b:1', 'unit', 'm2'], ['b:1', 'desc', 'Planter WP'],
    ['ti:pl', 'kind', 'area'], ['ti:pl', 'name', 'Planter'], ['ti:pl', 'fcode', 'WP-01'], ...shape('sh:pl', 'ti:pl', 'poly', rectPts(10, 0, 2, 2))]);
  const m = buildQtoModel(st, null);
  const l = portionLinkOps(m, { code: 'WP-01', unit: 'm²', g: [], flt: {} }, 'b:1');
  assert.ok(l.ok, JSON.stringify(l));
  apply(st, (l as { ops: Op[] }).ops);
  const m2 = buildQtoModel(st, null);
  const k = m2.fin.linkById.get((l as { id: string }).id)!;
  close(k.qty, 4, 'the planter only');
  assert.ok(!k.split);
  // and the split rows can still be linked on their own
  assert.ok(portionLinkOps(m2, { code: 'WP-01 (horizontal)', unit: 'm²', g: [], flt: {} }, 'b:1').ok);
});

test('second review: a link on a split waterproofing code marks format 5 (0.16.3 would write 0 for it)', async () => {
  const { needsFormat164 } = await import('../src/engine/qto/model');
  assert.ok(needsFormat164([['fl:x', 'code', 'WP-01 (vertical)']]));
  assert.ok(!needsFormat164([['fl:x', 'code', 'WP-01']]));
});

test('second review: a heading copied - its bulkhead hangs from the copy\'s own ceiling', async () => {
  const { duplicateHeadingOps } = await import('../src/engine/qto/listops');
  const st = apply(new Store(), [...r(), ['hd:a', 'kind', 'heading'], ['hd:a', 'name', 'Level 1'], ['hd:a', 'ord', 'a0'], ['ti:r', 'par', 'hd:a'],
    ...part('ti:fc', 'ti:r', 'ceiling', 'area', { name: 'False ceiling', fcode: 'FC-02', lv: 2.8 }), ...shape('sh:fc', 'ti:fc', 'poly', rectPts(0, 0, 3, 4)),
    ...part('ti:b', 'ti:r', 'ceiling', 'line', { ak: 'bh', bh: 2.5, bp: 'ti:fc' }), ...shape('sh:b', 'ti:b', 'line', J([P(1), P(0), P(1), P(4)])),
  ]);
  const m = buildQtoModel(st, null);
  const raw = (ti: string) => [...(st.ents.get(ti) ?? new Map())].map(([f, c]) => [f, c.v] as [string, any]);
  const d = duplicateHeadingOps(m, 'hd:a', 'T', true, raw);
  assert.ok(d, 'copied');
  apply(st, d!.ops);
  const m2 = buildQtoModel(st, null);
  const rooms = m2.fin.rooms.filter((x) => x.id !== 'ti:r');
  assert.equal(rooms.length, 1);
  const bh = m2.fin.partsByRoom.get(rooms[0].id)!.find((x) => x.ak === 'bh')!;
  assert.equal(m2.fin.qty.get(rooms[0].id)!.byKey.get(bh.id)!.code, 'FC-02 (bulkhead 300 mm)');
});

test('second review: a bulkhead\'s own code (under a soffit with no finish it is the only way it gets one)', () => {
  const m = build([...r({ cs: true, cc: null, ch: 3.0 }), ...part('ti:b', 'ti:r', 'ceiling', 'line', { ak: 'bh', bh: 2.7, fcode: 'BH-01' }), ...shape('sh:b', 'ti:b', 'line', J([P(0), P(1), P(6), P(1)]))]);
  assert.equal(qty(m, 'ti:b')!.code, 'BH-01 (bulkhead 300 mm)');
});

test('second review: manual ceilings - an additional ceiling counted on top covers its part of the floor (no alert)', () => {
  const ops = [...r({ cm: 'manual' }), ['ti:c', 'kind', 'area'] as Op, ['ti:c', 'name', 'Ceiling areas'] as Op, ['ti:c', 'rm', 'ti:r'] as Op, ['ti:c', 'rk', 'ceil'] as Op, ['ti:c', 'rcat', 'ceiling'] as Op,
    ...shape('sh:c', 'ti:c', 'poly', rectPts(0, 0, 3, 4)),
    ...part('ti:fc', 'ti:r', 'ceiling', 'area', { name: 'Gypsum', fcode: 'GYP-02', rded: false }), ...shape('sh:fc', 'ti:fc', 'poly', rectPts(3, 0, 3, 4))];
  const q = build(ops).fin.qty.get('ti:r')!;
  assert.equal(q.ceil.equal, true, String(q.ceil.covered));
});

// ---------------- the Finishes Summary by finish type (Nabil's layout, 6 Nov)
test('by finish type: a column per type with its codes and total; a code on walls and ceilings is in both, never added together; filters apply', async () => {
  const { summarizeByType } = await import('../src/engine/qto/finishes');
  const { finishesSheets } = await import('../src/ui/takeoff/finexport');
  const m = build([...r({ fc: 'TL-01', wc: 'PT-05', cc: 'PT-05', hw: 3, kc: 'SK-01', hs: 0.1 }),
    ...room('ti:r2', { cc: 'PT-05', fc: 'TL-02' }), ...shape('sh:r2', 'ti:r2', 'poly', rectPts(10, 0, 2, 2)),
    ['ti:pl', 'kind', 'area'], ['ti:pl', 'name', 'Planter'], ['ti:pl', 'fcode', 'WP-01'], ...shape('sh:pl', 'ti:pl', 'poly', rectPts(20, 0, 2, 2))]);
  const cols = summarizeByType(m);
  const col = (t: string) => cols.find((c) => c.type === t)!;
  assert.deepEqual(cols.map((c) => c.type), ['Floor', 'Wall', 'Skirting', 'Ceiling', 'Other']);
  assert.deepEqual(col('Floor').rows.map((x) => [x.code, Math.round(x.qty * 100) / 100]), [['TL-01', 24], ['TL-02', 4]]);
  close(col('Floor').totals[0].qty, 28, 'floor total');
  // PT-05: walls (20 × (3 - 0.1) = 58) and ceilings (24 + 4) - each in its own column
  close(col('Wall').rows.find((x) => x.code === 'PT-05')!.qty, 20 * 2.9, 'walls');
  close(col('Ceiling').rows.find((x) => x.code === 'PT-05')!.qty, 28, 'ceilings');
  assert.equal(col('Ceiling').rows.find((x) => x.code === 'PT-05')!.n, 2);
  // filters: Show Floor only; a search
  assert.deepEqual(summarizeByType(m, { types: ['Floor'] }).map((c) => c.type), ['Floor']);
  assert.deepEqual(summarizeByType(m, { types: ['None' as never] }), []);
  // the Excel sheet: pairs of columns, totals on top
  const sh = finishesSheets(m, [], {}, { project: 'P', breakdown: null, byType: true });
  assert.equal(sh[0].name, 'By finish type');
  const hr = sh[0].rows.find((x) => Array.isArray(x) && (x[0] as { v?: string })?.v === 'Floor')!;
  assert.deepEqual(hr.map((x) => (x as { v: string }).v), ['Floor', 'Qty', 'Wall', 'Qty', 'Skirting', 'Qty', 'Ceiling', 'Qty', 'Other take-offs', 'Qty']);
  assert.equal(finishesSheets(m, [], {}, { project: 'P', breakdown: null })[0].name, 'Summary', 'the list view: as before');
});

test('the soffit\'s code is marked SFT (Nabil): apart from a ceiling with the same code; a link made on the bare code before still covers it', async () => {
  const m = build([...r({ cs: true, cc: 'PT-05' }), ...room('ti:r2', { cc: 'PT-05' }), ...shape('sh:r2', 'ti:r2', 'poly', rectPts(10, 0, 2, 2))]);
  assert.equal(m.fin.qty.get('ti:r')!.byKey.get('ceiling')!.code, 'PT-05 (SFT)');
  assert.equal(m.fin.qty.get('ti:r2')!.byKey.get('ceiling')!.code, 'PT-05');
  const { needsFormat164 } = await import('../src/engine/qto/model');
  assert.ok(needsFormat164([['fl:x', 'code', 'PT-05 (SFT)']]));
  // typed with it already: not twice
  assert.equal(build(r({ cs: true, cc: 'PT-05 (SFT)' })).fin.qty.get('ti:r')!.byKey.get('ceiling')!.code, 'PT-05 (SFT)');
});

test('the code list: every code (not the first 12), the ones used for that kind of finish first', async () => {
  const { suggestCodes, codesUsedFor } = await import('../src/engine/qto/finishes');
  const ops: Op[] = [...r({ fc: 'AA-01', pm: 'up', pu: 0.3, pc: 'WP-07' })];
  for (let i = 0; i < 20; i++) ops.push(...room('ti:x' + i, { fc: 'B-' + String(i).padStart(2, '0') }), ...shape('sh:x' + i, 'ti:x' + i, 'poly', rectPts(10 + i * 3, 0, 2, 2)));
  const m = build(ops);
  const all = suggestCodes(m, '');
  assert.ok(all.some((c) => c.code === 'WP-07'), 'WP-07 in the list without typing');
  const wp = codesUsedFor(m, 'wp');
  assert.deepEqual([...wp], ['wp-07']);
  assert.equal(suggestCodes(m, '', Infinity, wp)[0].code, 'WP-07', 'first in a waterproofing box');
  assert.equal(suggestCodes(m, 'wp')[0].code, 'WP-07');
});
