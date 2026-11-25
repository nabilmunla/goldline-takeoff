// v0.18 structure, round 2 (Feedback 3, Part A 2, 3, 6-8; Part B E; stairs): a column's slab thickness off its height,
// shear walls counted like columns, footings (counted: L × W × D; drawn: a raft), stairs (Nabil's stairs sheet), mesh
// on a slab, an element's own figures in place of its type's, doors on a plain length, the schedules of the new kinds,
// the Structure summary with every element, format 8.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/engine/store';
import { buildQtoModel, measuresFor, needsFormat18, needsFormat17, itemQty, itemKindLabel, flightSteps } from '../src/engine/qto/model';
import { scaleFromRatio } from '../src/engine/qto/geometry';
import { memberTypeOps, beamTypeOps, newStructOps, openingOps, shapeOverrideOps, copyShapesOps } from '../src/engine/qto/ops';
import { guessBeamCols, planBeamImport, applyBeamPlanOps, memberScheduleRows, type BeamIn } from '../src/engine/qto/beamsched';
import { structSummary } from '../src/engine/qto/structsum';
import { DATA_FORMAT, FORMAT_V18 } from '../src/engine/version';
import type { Op } from '../src/engine/types';

let stamp = 0;
const storeWith = (ops: Op[]) => { const s = new Store(); s.apply({ s: String(++stamp).padStart(10, '0') + '~t', w: 't', u: 'n', t: 0, o: ops, a: 'n' }); return s; };
const J = (v: unknown) => JSON.stringify(v);
const close = (a: number, b: number, msg = '', eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${msg} ${a} != ${b}`);
const S = scaleFromRatio(100);
const P = (m: number) => m / S;
const base: Op[] = [['pg:d1.0', 'sc', S]];
const sh = (id: string, ti: string, k: 'poly' | 'line' | 'pt', pts: number[], f: Record<string, unknown> = {}): Op[] => [[id, 'ti', ti], [id, 'dwg', 'd1'], [id, 'pg', 0], [id, 'k', k], [id, 'p', J(pts.map(P))], ...Object.entries(f).map(([k, v]) => [id, k, v] as Op)];
const item = (id: string, kind: string, f: Record<string, unknown> = {}): Op[] => [[id, 'kind', kind], [id, 'name', id], [id, 'ord', 'a0'], ...Object.entries(f).map(([k, v]) => [id, k, v] as Op)];
const build = (ops: Op[]) => buildQtoModel(storeWith(ops), null);
const q = (ops: Op[], id: string) => { const m = build(ops); return itemQty(m, m.itemById.get(id)!); };

test('columns: the slab thickness comes off the height (floor to floor typed, the slab not counted twice)', () => {
  const ops: Op[] = [...base, ...memberTypeOps('ct', { name: 'C1', w: 0.4, d: 0.6, r: 200, color: '#111' }, 'ct:1').ops,
    ...item('ti:c', 'count', { sk: 'col', h: 3.2, cst: 0.2, bt: 'ct:1' }), ...sh('sh:1', 'ti:c', 'pt', [1, 1]), ...sh('sh:2', 'ti:c', 'pt', [5, 1])];
  const r = q(ops, 'ti:c');
  // 2 × 0.4 × 0.6 × (3.20 − 0.20) = 1.44 ; formwork 2 × 2.0 × 3.0 = 12 ; steel 288
  close(r.vol, 1.44); close(r.form, 12); close(r.kg, 288); close(r.len, 6, 'the columns’ length');
  // without it: as 0.17
  const r0 = q(ops.filter((o) => o[1] !== 'cst'), 'ti:c');
  close(r0.vol, 2 * 0.24 * 3.2);
});

test('shear walls counted like columns: the type gives length × thickness', () => {
  const ops: Op[] = [...base, ...memberTypeOps('st', { name: 'SW1', w: 3, d: 0.25, r: 180, color: '#111' }, 'st:1').ops,
    ...memberTypeOps('ct', { name: 'C1', w: 0.4, d: 0.4, r: 100, color: '#111' }, 'ct:1').ops,
    ...item('ti:w', 'count', { sk: 'sw', h: 3, cst: 0.25, bt: 'st:1' }), ...sh('sh:1', 'ti:w', 'pt', [1, 1]), ...sh('sh:2', 'ti:w', 'pt', [8, 1], { mt: 'ct:1' })];
  const m = build(ops);
  const r = itemQty(m, m.itemById.get('ti:w')!);
  // (a column type is not a shear wall type: the second falls back to the take-off's default, SW1)
  // 2 × 3.0 × 0.25 × 2.75 = 4.125 ; formwork 2 × 6.5 × 2.75 = 35.75 ; steel × 180
  close(r.cnt, 2); close(r.vol, 4.125); close(r.form, 35.75); close(r.kg, 4.125 * 180);
  assert.equal(itemKindLabel(m.itemById.get('ti:w')!), 'Shear wall');
  assert.deepEqual(measuresFor(m.itemById.get('ti:w')!).slice(0, 4), ['cnt', 'vol', 'form', 'kg']);
  assert.equal(m.swTypes.length, 1);
});

test('footings counted: L × W × D of the type, formwork its four sides; one without a depth is said; a drawn raft', () => {
  const ops: Op[] = [...base, ...memberTypeOps('ft', { name: 'F1', w: 1.5, d: 1.5, t: 0.5, r: 90, color: '#111' }, 'ft:1').ops,
    ...memberTypeOps('ft', { name: 'F2', w: 2, d: 1.2, t: null, r: null, color: '#111' }, 'ft:2').ops,
    ...item('ti:f', 'count', { sk: 'ftg', bt: 'ft:1', sr: 100 }), ...sh('sh:1', 'ti:f', 'pt', [1, 1]), ...sh('sh:2', 'ti:f', 'pt', [5, 1]), ...sh('sh:3', 'ti:f', 'pt', [9, 1], { mt: 'ft:2' }),
    ...item('ti:r', 'area', { sk: 'raft', d: 0.6, sr: 110 }), ...sh('sh:r', 'ti:r', 'poly', [0, 0, 10, 0, 10, 8, 0, 8])];
  const m = build(ops);
  const f = itemQty(m, m.itemById.get('ti:f')!);
  // 2 × 1.5 × 1.5 × 0.5 = 2.25 ; sides 2 × 6.0 × 0.5 = 6 ; steel 202.5 ; F2 has no depth: counted, no concrete
  close(f.cnt, 3); close(f.vol, 2.25); close(f.form, 6); close(f.kg, 202.5); close(f.untyped, 1);
  const r = itemQty(m, m.itemById.get('ti:r')!);
  // 80 × 0.6 = 48 ; sides only 36 × 0.6 = 21.6 ; steel 5280
  close(r.vol, 48); close(r.form, 21.6); close(r.kg, 5280);
  assert.equal(itemKindLabel(m.itemById.get('ti:r')!), 'Raft');
});

test('a stair, as the stairs sheet: steps + waist + landing; shutter; steel by ratio', () => {
  // the sheet's "STAIR 1 (RISING 1)": tread 0.28, riser 0.18, 6 steps, width 1.40, waist 0.25, landing 1.41 × 1.46 × 0.25
  const T = 0.28, R = 0.18, n = 6, B = 1.4, waist = 0.25, hyp = Math.sqrt(T * T + R * R);
  const steps = 0.5 * T * R * B * n, ws = hyp * n * B * waist, land = 1.41 * 1.46 * 0.25;
  const shutter = 0.5 * T * R * 2 * n + R * B * n + hyp * n * B + 1.41 * 1.46;
  const ops: Op[] = [...base, ...item('ti:s', 'area', { sk: 'stair', tr: T, ri: R, ow: B, d: waist, st: 0.25, sr: 150 }),
    // the flight on the plan: 6 treads × 0.28 = 1.68 long, 1.40 wide ; the landing 1.41 × 1.46
    ...sh('sh:f', 'ti:s', 'poly', [0, 0, 1.68, 0, 1.68, 1.4, 0, 1.4]),
    ...sh('sh:l', 'ti:s', 'poly', [2, 0, 3.41, 0, 3.41, 1.46, 2, 1.46], { sp: 'l' })];
  const m = build(ops);
  const r = itemQty(m, m.itemById.get('ti:s')!);
  close(r.vol, steps + ws + land, 'concrete'); close(r.form, shutter, 'shutter'); close(r.kg, (steps + ws + land) * 150, 'steel');
  close(r.byTag.get('Flights')!.segs, 6, 'steps from the flight’s area');
  close(r.byTag.get('Landings')!.vol, land);
  // steps typed on the flight win over its area
  const r2 = q([...ops, ['sh:f', 'xn', 7]], 'ti:s');
  close(r2.byTag.get('Flights')!.segs, 7);
  assert.equal(flightSteps({ ow: 1.4, tr: 0.28 }, {}, 1.68 * 1.4), 6);
  // nothing typed yet: said, no figures
  const r3 = q([...base, ...item('ti:s', 'area', { sk: 'stair' }), ...sh('sh:f', 'ti:s', 'poly', [0, 0, 1.68, 0, 1.68, 1.4, 0, 1.4])], 'ti:s');
  close(r3.vol, 0); close(r3.untyped, 1);
});

test('an element’s own figures in place of its type’s: size, height, steel ratio - one or many; back to the type', () => {
  const ops: Op[] = [...base, ...memberTypeOps('ct', { name: 'C1', w: 0.4, d: 0.6, r: 200, color: '#111' }, 'ct:1').ops,
    ...item('ti:c', 'count', { sk: 'col', h: 3, bt: 'ct:1' }), ...sh('sh:1', 'ti:c', 'pt', [1, 1]), ...sh('sh:2', 'ti:c', 'pt', [5, 1]), ...sh('sh:3', 'ti:c', 'pt', [9, 1])];
  const m = build(ops);
  const two = m.shapes.filter((s) => s.id !== 'sh:1');
  const ov = shapeOverrideOps(two, { xw: 0.5, xd: 0.5, xh: 4, xr: 250 });
  assert.equal(ov.length, 8);
  const r = q([...ops, ...ov], 'ti:c');
  // one as its type 0.4 × 0.6 × 3 = 0.72 (× 200) ; two at 0.5 × 0.5 × 4 = 1.0 each (× 250)
  close(r.vol, 0.72 + 2); close(r.kg, 0.72 * 200 + 2 * 250); close(r.form, 2 * 3 + 2 * 2 * 4);
  // back: null on each
  const back = shapeOverrideOps(two, { xw: null, xd: null, xh: null, xr: null });
  const st = storeWith([...ops, ...ov]);
  st.apply({ s: String(++stamp).padStart(10, '0') + '~t', w: 't', u: 'n', t: 0, o: back, a: 'n' });
  const mb = buildQtoModel(st, null);
  close(itemQty(mb, mb.itemById.get('ti:c')!).vol, 3 * 0.72, 'back to the type');
  // a steel ratio of 0 is a figure (plain concrete), not "none"
  close(q([...ops, ...shapeOverrideOps(two, { xr: 0 })], 'ti:c').kg, 0.72 * 200);
  // a copy keeps them
  const m2 = build([...ops, ...ov]);
  const cp = copyShapesOps([m2.shapes.find((s) => s.id === 'sh:2')!], { dwg: 'd1', pg: 0 }, 'n', 10, 0);
  assert.ok(cp.ops.some((o) => o[1] === 'xw' && o[2] === 0.5) && cp.ops.some((o) => o[1] === 'xr' && o[2] === 250));
});

test('own figures on a beam, a core wall, a slab', () => {
  const b: Op[] = [...base, ...beamTypeOps({ name: 'B1', w: 0.3, d: 0.6, r: 100, color: '#111' }, 'bt:1').ops,
    ...item('ti:b', 'beam', { bt: 'bt:1' }), ...sh('sh:1', 'ti:b', 'line', [0, 0, 5, 0]), ...sh('sh:2', 'ti:b', 'line', [0, 2, 5, 2], { xw: 0.4, xd: 0.8, xr: 150 })];
  const r = q(b, 'ti:b');
  close(r.vol, 5 * 0.18 + 5 * 0.32); close(r.kg, 0.9 * 100 + 1.6 * 150);
  const w: Op[] = [...base, ...memberTypeOps('wt', { name: 'CW1', w: 0.25, d: null, r: 120, color: '#111' }, 'wt:1').ops,
    ...item('ti:w', 'wall', { sk: 'shear', h: 3, bt: 'wt:1' }), ...sh('sh:1', 'ti:w', 'line', [0, 0, 4, 0]), ...sh('sh:2', 'ti:w', 'line', [0, 2, 4, 2], { xw: 0.3, xr: 200 })];
  const rw = q(w, 'ti:w');
  close(rw.vol, 4 * 3 * 0.25 + 4 * 3 * 0.3); close(rw.kg, 3 * 120 + 3.6 * 200);
  const s: Op[] = [...base, ...item('ti:s', 'area', { sk: 'slab', d: 0.2, sr: 100 }), ...sh('sh:1', 'ti:s', 'poly', [0, 0, 5, 0, 5, 4, 0, 4]), ...sh('sh:2', 'ti:s', 'poly', [6, 0, 8, 0, 8, 5, 6, 5], { xr: 160 })];
  // 20 × 0.2 × 100 + 10 × 0.2 × 160
  close(q(s, 'ti:s').kg, 400 + 320);
});

test('doors on a plain length: their width off the length; with a height, width × height off the area; never a door count', () => {
  const ops: Op[] = [...base, ['ds:1', 'tag', 'D01'], ['ds:1', 'sw', 0.9], ['ds:1', 'sh', 2.1],
    ...item('ti:k', 'line'), ...sh('sh:k', 'ti:k', 'line', [0, 0, 10, 0]),
    ...openingOps({ sh: 'sh:k', x: P(3), y: 0, k: 'door', door: 'ds:1', tag: 'D01', w: null, h: null, lint: true, ln: true }).ops,
    ...openingOps({ sh: 'sh:k', x: P(7), y: 0, k: 'open', door: null, tag: '', w: 1.2, h: 3.5, lint: true, ln: true }).ops,
    ...item('ti:w', 'wall', { h: 3 }), ...sh('sh:w', 'ti:w', 'line', [0, 5, 10, 5]),
    ...openingOps({ sh: 'sh:w', x: P(3), y: P(5), k: 'door', door: 'ds:1', tag: 'D01', w: null, h: null, lint: true }).ops];
  const m = build(ops);
  const k = itemQty(m, m.itemById.get('ti:k')!);
  close(k.len, 10 - 0.9 - 1.2, 'skirting less the doors');
  close(k.lcnt, 0, 'no lintel on a length');
  assert.equal(m.openings.length, 1, 'only the wall’s door is a door of the schedule’s count');
  assert.ok(m.openingsByShape.get('sh:k')!.every((o) => o.ln && !o.lint));
  // with a height 2.4: 10 × 2.4 − 0.9 × 2.1 − 1.2 × 2.4 (the opening is no higher than the length)
  const m2 = build([...ops, ['ti:k', 'h', 2.4]]);
  close(itemQty(m2, m2.itemById.get('ti:k')!).area, 24 - 1.89 - 2.88);
  // the wall is as it was
  close(itemQty(m, m.itemById.get('ti:w')!).area, 30 - 1.89);
});

test('mesh on a slab; the Structure summary has every element, in building order, with the mesh column', () => {
  const ops: Op[] = [...base,
    ...memberTypeOps('ct', { name: 'C1', w: 0.4, d: 0.4, r: 100, color: '#111' }, 'ct:1').ops, ...memberTypeOps('st', { name: 'SW1', w: 2, d: 0.2, r: 100, color: '#111' }, 'st:1').ops,
    ...memberTypeOps('ft', { name: 'F1', w: 1, d: 1, t: 0.5, r: 100, color: '#111' }, 'ft:1').ops,
    ...item('ti:slab', 'area', { sk: 'slab', d: 0.2, sr: 100, mesh: true }), ...sh('sh:s', 'ti:slab', 'poly', [0, 0, 5, 0, 5, 4, 0, 4]),
    ...item('ti:slab2', 'area', { sk: 'slab', d: 0.2 }), ...sh('sh:s2', 'ti:slab2', 'poly', [0, 0, 2, 0, 2, 2, 0, 2]),
    ...item('ti:col', 'count', { sk: 'col', h: 3, bt: 'ct:1' }), ...sh('sh:c', 'ti:col', 'pt', [1, 1]),
    ...item('ti:sw', 'count', { sk: 'sw', h: 3, bt: 'st:1' }), ...sh('sh:w', 'ti:sw', 'pt', [1, 1]),
    ...item('ti:ftg', 'count', { sk: 'ftg', bt: 'ft:1' }), ...sh('sh:f', 'ti:ftg', 'pt', [1, 1]),
    ...item('ti:raft', 'area', { sk: 'raft', d: 0.5 }), ...sh('sh:r', 'ti:raft', 'poly', [0, 0, 2, 0, 2, 2, 0, 2]),
    ...item('ti:st', 'area', { sk: 'stair', tr: 0.28, ri: 0.18, ow: 1.4, d: 0.25, st: 0.25 }), ...sh('sh:fl', 'ti:st', 'poly', [0, 0, 1.68, 0, 1.68, 1.4, 0, 1.4])];
  const m = build(ops);
  const s = structSummary(m, 'struct', 'el');
  assert.deepEqual(s.rows.map((r) => r.label), ['Columns', 'Shear walls', 'Slabs', 'Stairs', 'Footings', 'Rafts / drawn footings']);
  assert.ok(s.cols.some((c) => c.label === 'Mesh A254'));
  const slabs = s.rows.find((r) => r.label === 'Slabs')!;
  close(slabs.qty.area!, 20, 'mesh: only the slab ticked');
  close(slabs.qty.vol!, 4.8);
  assert.ok(s.rows.every((r) => (r.qty.vol ?? 0) > 0), 'every element has its concrete');
  // no slab with mesh in view: no mesh column
  assert.ok(!structSummary(build(ops.filter((o) => o[1] !== 'mesh')), 'struct', 'el').cols.some((c) => c.label === 'Mesh A254'));
  // by type: the stair's flights with their steps
  const st = structSummary(m, 'struct', 'type').rows.find((r) => r.label === 'Stairs')!;
  assert.deepEqual(st.children.map((c) => [c.label, c.meas?.qty, c.meas?.unit]), [['Flights', 6, 'steps']]);
});

test('the schedules of the new kinds: columns guessed, rows planned, written back', () => {
  const heads = new Map([[0, 'Footing Mark'], [1, 'Length (mm)'], [2, 'Width (mm)'], [3, 'Depth (mm)'], [4, 'Steel (kg/m3)']]);
  assert.deepEqual(guessBeamCols(heads, 'ftg'), { mark: 0, w: 1, d: 2, t: 3, r: 4 });
  assert.deepEqual(guessBeamCols(new Map([[0, 'Mark'], [1, 'Size (L x W x D)']]), 'ftg'), { mark: 0, sz: 1 });
  assert.deepEqual(guessBeamCols(new Map([[0, 'Wall Mark'], [1, 'Length'], [2, 'Thickness']]), 'swall'), { mark: 0, w: 1, d: 2 });
  const rows: BeamIn[] = [{ name: 'F1', w: 1.5, d: 1.5, t: 0.5, r: 90 }, { name: 'F2', w: 2, d: 1.2, t: 0.6 }];
  const have = [{ id: 'ft:1', name: 'F1', w: 1.5, d: 1.5, t: 0.4, r: 90, color: '#111' }];
  const plan = planBeamImport({ beamTypes: have }, rows, 'ftg');
  assert.deepEqual(plan.rows.map((r) => r.k), ['changed', 'new']);
  assert.deepEqual(plan.rows[0].ch, [['t', 0.4, 0.5]]);
  const ap = applyBeamPlanOps(plan, new Map<string, true>(plan.rows.map((r) => [r.key, true])), ['#111'], 1, 'ftg');
  assert.ok(ap.ops.some((o) => o[0] === 'ft:1' && o[1] === 't' && o[2] === 0.5) && ap.ops.some((o) => String(o[0]).startsWith('ft:') && o[1] === 't' && o[2] === 0.6));
  assert.deepEqual(memberScheduleRows(have, 'ftg'), [['Mark', 'Length (mm)', 'Width (mm)', 'Depth (mm)', 'Steel (kg/m3)'], ['F1', 1500, 1500, 400, 90]]);
  assert.deepEqual(memberScheduleRows([{ id: 'st:1', name: 'SW1', w: 3, d: 0.25, r: null, color: '#111' }], 'swall')[1], ['SW1', 3000, 250, null]);
});

test('new take-offs of the new kinds; format 8 marks what 0.17 would get wrong, and nothing else', () => {
  const m = build(base);
  for (const [sk, kind, name] of [['sw', 'count', 'Shear walls 1'], ['ftg', 'count', 'Footings 1'], ['raft', 'area', 'Raft 1'], ['stair', 'area', 'Stair 1']] as const) {
    const r = newStructOps(m, 'n', sk);
    assert.ok(r.ops.some((o) => o[1] === 'kind' && o[2] === kind) && r.ops.some((o) => o[1] === 'sk' && o[2] === sk) && r.ops.some((o) => o[1] === 'name' && o[2] === name), sk);
    assert.ok(needsFormat18(r.ops as [string, string, unknown][]), sk + ' needs format 8');
  }
  assert.equal(FORMAT_V18, 8); assert.ok(DATA_FORMAT >= 8);
  const yes: [string, string, unknown][] = [['ti:1', 'rmh', 3.5], ['ti:1', 'plc', 'PL-01'], ['ti:1', 'bc', 'AF-01'], ['ti:1', 'ak', 'misc'], ['ti:1', 'wr', true], ['ti:1', 'mesh', true], ['ti:1', 'cst', 0.2],
    ['ti:1', 'tr', 0.28], ['sh:1', 'xr', 150], ['sh:1', 'xw', 0.5], ['sh:1', 'sp', 'l'], ['st:1', 'name', 'SW1'], ['ft:1', 'name', 'F1'], ['op:1', 'ln', true]];
  for (const o of yes) assert.ok(needsFormat18([o]), o.join(' '));
  const no: [string, string, unknown][] = [['ti:1', 'sk', 'slab'], ['ti:1', 'sk', 'col'], ['ti:1', 'hw', 3], ['ti:1', 'ak', 'bh'], ['ti:1', 'rmh', null], ['sh:1', 'xr', null], ['ti:1', 'mesh', null], ['ct:1', 'name', 'C1'], ['ti:1', 'st', 0.2], ['sh:1', 'mt', 'ct:1']];
  for (const o of no) assert.ok(!needsFormat18([o]), 'not: ' + o.join(' '));
  assert.ok(needsFormat17([['ti:1', 'sk', 'sw']]), 'and 7 with it');
});

test('review: an own width on a round column is its diameter; an opening on a length with a height comes off by its sill', () => {
  const ops: Op[] = [...base, ...memberTypeOps('ct', { name: 'C2', w: 0.5, d: null, r: null, color: '#222', round: true }, 'ct:2').ops,
    ...item('ti:c', 'count', { sk: 'col', h: 3, bt: 'ct:2' }), ...sh('sh:1', 'ti:c', 'pt', [1, 1]), ...sh('sh:2', 'ti:c', 'pt', [5, 1], { xw: 0.6 })];
  const r = q(ops, 'ti:c');
  close(r.vol, Math.PI * 0.25 * 0.25 * 3 + Math.PI * 0.3 * 0.3 * 3, 'Ø500 + Ø600'); close(r.untyped, 0);
  // with a depth too it is rectangular
  close(q([...ops, ['sh:2', 'xd', 0.4]], 'ti:c').vol, Math.PI * 0.0625 * 3 + 0.6 * 0.4 * 3);
  const ln: Op[] = [...base, ...item('ti:k', 'line', { h: 1.2 }), ...sh('sh:k', 'ti:k', 'line', [0, 0, 10, 0]),
    ...openingOps({ sh: 'sh:k', x: P(3), y: 0, k: 'open', door: null, tag: '', w: 1, h: 1.5, lint: false, ln: true, sill: 1 }).ops];
  // 10 × 1.2 − 1.0 × (1.2 − 1.0)
  close(q(ln, 'ti:k').area, 12 - 0.2);
});
