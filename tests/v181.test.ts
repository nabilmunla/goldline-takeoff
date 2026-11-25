// v0.18.1 (Nabil, 11 Nov): substructure - footings, rafts, slabs on grade, retaining walls with waterproofing (bottom,
// sides up to a height, one face or two), blinding (thickness + how far past the edges) and polythene; stair types;
// a beam / wall segment's own figures; a slab's soffit less the drop panels and beams under it; miscellaneous items by
// code, description, finish and unit; finishes above where the wall finish stops; the shadow gap all round only where
// a ceiling meets the walls; format 9. Figures worked out by hand above each check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/engine/store';
import { buildQtoModel, itemQty, measuresFor, needsFormat181, needsFormat18, offsetArea, tagOwn, tagBase, withTagOwn, itemKindLabel, type QtoModel } from '../src/engine/qto/model';
import { scaleFromRatio } from '../src/engine/qto/geometry';
import { memberTypeOps, beamTypeOps, newStructOps, segOwnOps, setSegTagsOps, openingOps } from '../src/engine/qto/ops';
import { structSummary, typeInstances, groupOverrideOps } from '../src/engine/qto/structsum';
import { miscSummary } from '../src/engine/qto/finishes';
import { guessBeamCols, planBeamImport, memberScheduleRows, type BeamIn } from '../src/engine/qto/beamsched';
import { addMiscOps } from '../src/engine/qto/roomops';
import { DATA_FORMAT, FORMAT_V181 } from '../src/engine/version';
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
const rect = (x: number, y: number, w: number, h: number) => [x, y, x + w, y, x + w, y + h, x, y + h];

test('footings: waterproofing under and to the sides (up to a height), blinding 50 mm past the edges, polythene', () => {
  const ops: Op[] = [...base, ...memberTypeOps('ft', { name: 'F1', w: 1.5, d: 1.2, t: 0.6, r: 90, color: '#111' }, 'ft:1').ops,
    ...item('ti:f', 'count', { sk: 'ftg', bt: 'ft:1', wb: true, wsd: true, bln: true, pe: true }), ...sh('sh:1', 'ti:f', 'pt', [1, 1]), ...sh('sh:2', 'ti:f', 'pt', [5, 1])];
  const r = q(ops, 'ti:f');
  // bottom 2 × 1.5 × 1.2 = 3.60 ; sides 2 × 5.4 × 0.6 = 6.48 ; blinding 2 × 1.6 × 1.3 × 0.05 = 0.208 ; polythene 2 × 2.08 = 4.16
  close(r.wph, 3.6); close(r.wpv, 6.48); close(r.blv, 0.208); close(r.pea, 4.16);
  // sides only up to 0.40 ; blinding 100 thick reaching 150 past: 2 × 1.8 × 1.5 × 0.1
  const r2 = q([...ops, ['ti:f', 'wvh', 0.4], ['ti:f', 'blt', 0.1], ['ti:f', 'blx', 0.15]], 'ti:f');
  close(r2.wpv, 2 * 5.4 * 0.4); close(r2.blv, 2 * 1.8 * 1.5 * 0.1); close(r2.pea, 2 * 2.7);
  // a vertical height above its depth: its depth
  close(q([...ops, ['ti:f', 'wvh', 2]], 'ti:f').wpv, 6.48);
  // none of it unless ticked; the measures follow
  const r0 = q(ops.filter((o) => !['wb', 'wsd', 'bln', 'pe'].includes(o[1])), 'ti:f');
  assert.equal(r0.wph + r0.wpv + r0.blv + r0.pea, 0);
  const m = build(ops);
  assert.deepEqual(measuresFor(m.itemById.get('ti:f')!), ['cnt', 'vol', 'form', 'kg', 'wph', 'wpv', 'blv', 'pea']);
  // Times and waste
  const r3 = q([...ops, ['ti:f', 'x', 2], ['ti:f', 'waste', 10]], 'ti:f');
  close(r3.wph, 3.6 * 2 * 1.1); close(r3.blv, 0.208 * 2 * 1.1);
});

test('a raft and a slab on grade: bottom = its area, sides = perimeter × height, blinding / polythene over the outline grown all round', () => {
  // an L: (0,0) (10,0) (10,4) (4,4) (4,8) (0,8): area 56, perimeter 36; grown 0.05: 56 + 36 × 0.05 + 0.05² × (5 convex − 1 concave = 4) = 57.81
  const L = [0, 0, 10, 0, 10, 4, 4, 4, 4, 8, 0, 8];
  for (const sk of ['raft', 'sog'] as const) {
    const ops: Op[] = [...base, ...item('ti:r', 'area', { sk, d: 0.5, sr: 100, wb: true, wsd: true, wvh: 0.3, bln: true, pe: true }), ...sh('sh:r', 'ti:r', 'poly', L)];
    const r = q(ops, 'ti:r');
    close(r.vol, 28, sk); close(r.form, 18, sk + ' formwork: its sides only');
    close(r.wph, 56); close(r.wpv, 36 * 0.3); close(r.pea, 56 + 1.8 + 0.01); close(r.blv, (56 + 1.8 + 0.01) * 0.05);
  }
  const m = build([...base, ...item('ti:r', 'area', { sk: 'sog', d: 0.15 }), ...sh('sh:r', 'ti:r', 'poly', rect(0, 0, 4, 3))]);
  const s = m.shapes[0];
  close(offsetArea(m, s, 12, 0.1), 12 + 14 * 0.1 + 4 * 0.01, 'a rectangle grown 0.10');
  assert.equal(itemKindLabel(m.itemById.get('ti:r')!), 'Slab on grade');
  // a slab on grade may have mesh
  close(q([...base, ...item('ti:r', 'area', { sk: 'sog', d: 0.15, mesh: true }), ...sh('sh:r', 'ti:r', 'poly', rect(0, 0, 4, 3))], 'ti:r').area, 12);
});

test('retaining walls: a wall of its own schedule; waterproofing one face (or two) up to a height, openings off it', () => {
  const ops: Op[] = [...base, ...memberTypeOps('rt', { name: 'RW1', w: 0.3, d: null, r: 120, color: '#111' }, 'rt:1').ops,
    ...item('ti:w', 'wall', { sk: 'rw', h: 3, bt: 'rt:1', wsd: true }), ...sh('sh:w', 'ti:w', 'line', [0, 0, 10, 0])];
  const r = q(ops, 'ti:w');
  // 10 × 3 × 0.3 = 9 m³ ; formwork 60 ; WP one face 30
  close(r.vol, 9); close(r.form, 60); close(r.kg, 1080); close(r.wpv, 30);
  close(q([...ops, ['ti:w', 'wfc', 2], ['ti:w', 'wvh', 2]], 'ti:w').wpv, 40, 'two faces to 2.00');
  close(q([...ops, ['ti:w', 'wb', true]], 'ti:w').wph, 3, 'under it: 10 × 0.30');
  // an opening 1.0 × 1.0 on it: off the concrete and off the waterproofing (one face, below its top)
  const r2 = q([...ops, ...openingOps({ sh: 'sh:w', x: P(5), y: 0, k: 'open', door: null, tag: '', w: 1, h: 1, lint: true }).ops], 'ti:w');
  close(r2.vol, 9 - 0.3); close(r2.wpv, 29); close(r2.lcnt, 0, 'no lintel');
  const m = build(ops);
  assert.equal(m.rwTypes.length, 1);
  assert.equal(itemKindLabel(m.itemById.get('ti:w')!), 'Retaining wall');
  // a core wall's types are not a retaining wall's
  close(q([...base, ...memberTypeOps('wt', { name: 'CW', w: 0.25, d: null, r: null, color: '#111' }, 'wt:1').ops, ...item('ti:w2', 'wall', { sk: 'rw', h: 3, bt: 'wt:1' }), ...sh('sh:w2', 'ti:w2', 'line', [0, 0, 10, 0])], 'ti:w2').vol, 0);
});

test('a segment’s own figures (beams, core / retaining walls): in its tag, the type kept; group by group from the schedule', () => {
  const bops: Op[] = [...base, ...beamTypeOps({ name: 'B1', w: 0.3, d: 0.6, r: 100, color: '#111' }, 'bt:1').ops,
    ...item('ti:b', 'beam', { bt: 'bt:1' }), ...sh('sh:b', 'ti:b', 'line', [0, 0, 5, 0, 10, 0])];
  const m = build(bops);
  const s = m.shapes[0];
  const own = segOwnOps(s, [1], { w: 0.4, d: 0.8, r: 150 });
  const sg = JSON.parse(String(own.find((o) => o[1] === 'sg')![2]));
  assert.equal(tagBase(sg[1]), null, 'untagged segment: the default type, own figures kept');
  assert.deepEqual(tagOwn(sg[1]), { w: 0.4, d: 0.8, r: 150 });
  const r = q([...bops, ...own], 'ti:b');
  close(r.vol, 5 * 0.18 + 5 * 0.32); close(r.kg, 0.9 * 100 + 1.6 * 150);
  assert.equal(withTagOwn('bt:1#w=0.4', {}), 'bt:1');
  // a segment given another type keeps its own figures
  const m2 = build([...bops, ...own]);
  const t2 = setSegTagsOps(m2.shapes[0], [1], 'bt:1');
  assert.ok(String(t2.find((o) => o[1] === 'sg')![2]).includes('bt:1#w=0.4'));
  // the schedule: B1's instances, one group, a width for all of them
  const g = typeInstances(m, 'beam', 'bt:1');
  assert.equal(g.length, 1); assert.deepEqual(g[0].segs.get('sh:b'), [0, 1]); close(g[0].n, 10);
  const all = groupOverrideOps('beam', g[0], { w: 0.25 });
  close(q([...bops, ...all], 'ti:b').vol, 10 * 0.25 * 0.6);
  // counted elements: their shapes
  const cops: Op[] = [...base, ...memberTypeOps('ct', { name: 'C1', w: 0.4, d: 0.4, r: 100, color: '#111' }, 'ct:1').ops, ...item('ti:c', 'count', { sk: 'col', h: 3, bt: 'ct:1' }), ...sh('sh:1', 'ti:c', 'pt', [1, 1]), ...sh('sh:2', 'ti:c', 'pt', [3, 1])];
  const gc = typeInstances(build(cops), 'col', 'ct:1')[0];
  close(q([...cops, ...groupOverrideOps('col', gc, { w: 0.5, d: 0.5 })], 'ti:c').vol, 2 * 0.25 * 3);
  // a wall segment's own thickness
  const w: Op[] = [...base, ...memberTypeOps('wt', { name: 'CW1', w: 0.25, d: null, r: null, color: '#111' }, 'wt:1').ops, ...item('ti:w', 'wall', { sk: 'shear', h: 3, bt: 'wt:1' }), ...sh('sh:w', 'ti:w', 'line', [0, 0, 4, 0, 8, 0])];
  close(q([...w, ...segOwnOps(build(w).shapes[0], [0], { w: 0.4 })], 'ti:w').vol, 4 * 3 * 0.4 + 4 * 3 * 0.25);
});

test('stair types: a flight takes its type’s sizes (its own, else the take-off’s default type, else the take-off’s)', () => {
  const T = 0.28, R = 0.18, hyp = Math.hypot(T, R);
  const ops: Op[] = [...base, ...memberTypeOps('sy', { name: 'ST1', w: 1.4, d: 0.25, t: 0.25, tr: T, ri: R, r: 150, color: '#111' }, 'sy:1').ops,
    ...item('ti:s', 'area', { sk: 'stair', bt: 'sy:1' }), ...sh('sh:f', 'ti:s', 'poly', rect(0, 0, 1.68, 1.4)), ...sh('sh:l', 'ti:s', 'poly', rect(2, 0, 1.41, 1.46), { sp: 'l' })];
  const r = q(ops, 'ti:s');
  const v = 0.5 * T * R * 1.4 * 6 + hyp * 6 * 1.4 * 0.25 + 1.41 * 1.46 * 0.25;
  close(r.vol, v); close(r.kg, v * 150); close(r.steps, 6);
  assert.ok(r.byTag.has('sy:1|f') && r.byTag.has('sy:1|l'));
  // a second type on one flight
  const r2 = q([...ops, ...memberTypeOps('sy', { name: 'ST2', w: 1.2, d: 0.2, t: 0.2, tr: 0.3, ri: 0.15, r: 100, color: '#111' }, 'sy:2').ops, ...sh('sh:f2', 'ti:s', 'poly', rect(5, 0, 1.5, 1.2), { mt: 'sy:2' })], 'ti:s');
  close(r2.steps, 6 + 5);
  // the schedule from Excel: tread / riser read
  assert.deepEqual(guessBeamCols(new Map([[0, 'Stair'], [1, 'Tread'], [2, 'Riser'], [3, 'Width'], [4, 'Waist'], [5, 'Landing'], [6, 'Steel kg/m3']]), 'stair'), { mark: 0, tr: 1, ri: 2, w: 3, d: 4, t: 5, r: 6 });
  const rows: BeamIn[] = [{ name: 'ST1', w: 1.4, d: 0.25, t: 0.25, tr: 0.3, ri: 0.18 }];
  const plan = planBeamImport({ beamTypes: build(ops).stairTypes }, rows, 'stair');
  assert.deepEqual(plan.rows[0].ch.map((c) => c[0]), ['tr']);
  assert.deepEqual(memberScheduleRows(build(ops).stairTypes, 'stair')[1], ['ST1', 280, 180, 1400, 250, 250, 150]);
});

test('a slab’s soffit formwork less the drop panels and beams under it (new slabs); an old slab as it was', () => {
  const ops: Op[] = [...base, ...beamTypeOps({ name: 'B1', w: 0.3, d: 0.6, r: null, color: '#111' }, 'bt:1').ops,
    ...item('ti:s', 'area', { sk: 'slab', d: 0.2 }), ...sh('sh:s', 'ti:s', 'poly', rect(0, 0, 10, 8)),
    // a drop panel 2 × 2 inside, one 2 × 2 half outside (1 × 2 under the slab)
    ...item('ti:d', 'area', { sk: 'drop', d: 0.15 }), ...sh('sh:d1', 'ti:d', 'poly', rect(2, 2, 2, 2)), ...sh('sh:d2', 'ti:d', 'poly', rect(9, 5, 2, 2)),
    // a beam 0.30 wide along y = 6 from x = 0 to 12 (10 m under the slab), an upstand (not taken off)
    ...item('ti:b', 'beam', { bt: 'bt:1' }), ...sh('sh:b', 'ti:b', 'line', [0, 6, 12, 6]),
    ...item('ti:u', 'beam', { bt: 'bt:1', up: true }), ...sh('sh:u', 'ti:u', 'line', [0, 1, 10, 1])];
  const gross = 80 + 36 * 0.2;
  close(q(ops, 'ti:s').form, gross, 'an old slab: as before');
  const r = q([...ops, ['ti:s', 'fdx', true]], 'ti:s');
  // (fresh eyes: the beam runs under the half-outside drop panel for 1 m - 0.30 m² counted once: 4 + 2 + 3 − 0.3)
  close(r.soffitOff, 4 + 2 + 10 * 0.3 - 0.3); close(r.form, gross - 8.7);
  // new slabs are made with it on
  assert.ok(newStructOps(build(base), 'n', 'slab').ops.some((o) => o[1] === 'fdx' && o[2] === true));
  // drop panels drawn over each other count once: x 2..5 (6) + the half outside (2) + the beam (3)
  close(q([...ops, ['ti:s', 'fdx', true], ...sh('sh:d3', 'ti:d', 'poly', rect(3, 2, 2, 2))], 'ti:s').soffitOff, 6 + 2 + 3 - 0.3);
  // a beam on the slab's edge (its centre line on the outline): half its width is under the slab - on any edge
  const edge = (pts: number[]) => q([...base, ...beamTypeOps({ name: 'B1', w: 0.3, d: 0.6, r: null, color: '#111' }, 'bt:1').ops,
    ...item('ti:s', 'area', { sk: 'slab', d: 0.2, fdx: true }), ...sh('sh:s', 'ti:s', 'poly', rect(0, 0, 10, 8)),
    ...item('ti:b', 'beam', { bt: 'bt:1' }), ...sh('sh:b', 'ti:b', 'line', pts)], 'ti:s').soffitOff;
  close(edge([0, 0, 10, 0]), 1.5, 'bottom edge'); close(edge([0, 8, 10, 8]), 1.5, 'top edge'); close(edge([10, 0, 10, 8]), 1.2, 'right edge');
  // two beams crossing: the crossing once (10 × 0.3 + 8 × 0.3 − 0.09)
  close(q([...base, ...beamTypeOps({ name: 'B1', w: 0.3, d: 0.6, r: null, color: '#111' }, 'bt:1').ops,
    ...item('ti:s', 'area', { sk: 'slab', d: 0.2, fdx: true }), ...sh('sh:s', 'ti:s', 'poly', rect(0, 0, 10, 8)),
    ...item('ti:b', 'beam', { bt: 'bt:1' }), ...sh('sh:b1', 'ti:b', 'line', [0, 4, 10, 4]), ...sh('sh:b2', 'ti:b', 'line', [5, 0, 5, 8])], 'ti:s').soffitOff, 3 + 2.4 - 0.09);
  // someone else's private beam: not under anyone's slab
  close(q([...ops, ['ti:s', 'fdx', true], ['ti:b', 'priv', true], ['ti:b', 'owner', 'x']], 'ti:s').soffitOff, 4 + 2);
});

test('miscellaneous items by code, description, finish and unit; a wall finish above where the finish stops is said', () => {
  const room = (id: string): Op[] => [[id, 'kind', 'room'], [id, 'name', 'K'], [id, 'ord', 'a0'], [id, 'rmh', 3.5], [id, 'cs', true], [id, 'wc', 'PT-01'], ...sh('sh:' + id, id, 'poly', rect(0, 0, 6, 4))];
  const m0 = build([...base, ...room('ti:r')]);
  const a = addMiscOps(m0, 'n', 'ti:r', { name: 'Wardrobe', code: 'JN-01', mq: 2, mf: 'oak' })!;
  const b = addMiscOps(m0, 'n', 'ti:r', { name: 'Wardrobe', code: 'JN-01', mq: 1, mf: 'white' })!;
  const c = addMiscOps(m0, 'n', 'ti:r', { name: 'Vanity', code: 'JN-01', mq: 3 })!;
  const m = build([...base, ...room('ti:r'), ...a.ops, ...b.ops, ...c.ops]);
  const rows = miscSummary(m).rows.map((r) => [r.code, r.descs[0], r.fins[0] ?? '', r.unit, r.qty]);
  assert.deepEqual(rows, [['JN-01', 'Vanity', '', 'nr', 3], ['JN-01', 'Wardrobe', 'oak', 'nr', 2], ['JN-01', 'Wardrobe', 'white', 'nr', 1]]);
  // tiles to 3.20 under a ceiling at 2.40 (finish stops at 2.50): said
  const m2 = build([...base, ...room('ti:r'), ['ti:ca', 'kind', 'area'], ['ti:ca', 'name', 'C'], ['ti:ca', 'rm', 'ti:r'], ['ti:ca', 'rk', 'add'], ['ti:ca', 'rcat', 'ceiling'], ['ti:ca', 'lv', 2.4], ['ti:ca', 'full', true],
    ['ti:t', 'kind', 'line'], ['ti:t', 'name', 'Tiles'], ['ti:t', 'rm', 'ti:r'], ['ti:t', 'rk', 'add'], ['ti:t', 'rcat', 'wall'], ['ti:t', 'h', 3.1], ['ti:t', 'bl', 0.1], ...sh('sh:t', 'ti:t', 'line', [0, 0, 6, 0])]);
  assert.ok(m2.fin.qty.get('ti:r')!.flags.includes('aboveFinish'));
  assert.match(m2.fin.qty.get('ti:r')!.byKey.get('ti:t')!.note ?? '', /higher than the wall finish/);
});

test('the shadow gap all round: only where a ceiling meets the walls (not a ceiling’s free edges, not under the bare soffit)', () => {
  const room = (f: Record<string, unknown>): Op[] => [['ti:r', 'kind', 'room'], ['ti:r', 'name', 'R'], ['ti:r', 'ord', 'a0'], ['ti:r', 'gm', 'all'], ['ti:r', 'gc', 'SG-01'], ...Object.entries(f).map(([k, v]) => ['ti:r', k, v] as Op), ...sh('sh:r', 'ti:r', 'poly', rect(0, 0, 6, 4))];
  const gap = (ops: Op[]) => build([...base, ...ops]).fin.qty.get('ti:r')!.byKey.get('gap')!.qty;
  close(gap(room({ cc: 'GB-01' })), 20, 'the room’s own ceiling: all of P');
  // the soffit, a false ceiling over x 0..4: its edges on the walls = 4 + 4 + 4 = 12 (its free edge at x = 4 not)
  const ca: Op[] = [['ti:ca', 'kind', 'area'], ['ti:ca', 'name', 'C'], ['ti:ca', 'rm', 'ti:r'], ['ti:ca', 'rk', 'add'], ['ti:ca', 'rcat', 'ceiling'], ['ti:ca', 'lv', 2.7], ...sh('sh:ca', 'ti:ca', 'poly', rect(0, 0, 4, 4))];
  close(gap([...room({ cs: true }), ...ca]), 12);
  // manual ceilings: the same
  const cm: Op[] = [['ti:cm', 'kind', 'area'], ['ti:cm', 'name', 'C'], ['ti:cm', 'rm', 'ti:r'], ['ti:cm', 'rk', 'ceil'], ['ti:cm', 'rcat', 'ceiling'], ...sh('sh:cm', 'ti:cm', 'poly', rect(0, 0, 4, 4))];
  close(gap([...room({ cm: 'manual', cc: 'GB-01' }), ...cm]), 12);
});

test('format 9 marks what 0.18.0 would get wrong, and nothing else', () => {
  assert.equal(DATA_FORMAT, 14); assert.equal(FORMAT_V181, 9); // 0.19 build-up variables / groups = 10; 0.20 composites / packages = 11; 0.21 % of tender lines = 12; 0.22 selling rules = 13
  const yes: [string, string, unknown][] = [['ti:1', 'sk', 'sog'], ['ti:1', 'sk', 'rw'], ['ti:1', 'wb', true], ['ti:1', 'wsd', true], ['ti:1', 'bln', true], ['ti:1', 'pe', true], ['ti:1', 'fdx', true],
    ['rt:1', 'name', 'RW1'], ['sy:1', 'name', 'ST1'], ['lk:1', 'q', 'wpv'], ['lk:1', 'q', 'blv'], ['sh:1', 'sg', J(['bt:1#w=0.4'])], ['sh:1', 'mt', 'sy:1'], ['fl:1', 'g', J([['item', 'wardrobe']])]];
  for (const o of yes) assert.ok(needsFormat181([o]), o.join(' '));
  const no: [string, string, unknown][] = [['ti:1', 'sk', 'slab'], ['ti:1', 'sk', 'ftg'], ['ti:1', 'wb', null], ['lk:1', 'q', 'vol'], ['sh:1', 'sg', J(['bt:1'])], ['sh:1', 'mt', 'ct:1'], ['fl:1', 'g', J([['type', 'Wall']])], ['ti:1', 'rmh', 3]];
  for (const o of no) assert.ok(!needsFormat181([o]), 'not: ' + o.join(' '));
  assert.ok(needsFormat18([['ti:1', 'sk', 'ftg']]));
});

// ---------------------------------------------------------------- ⊥ snap (Nabil, 11 Nov: "it should snap to perpendicular
// ... especially when ortho or shift are held. but even if not")
import { perpSnap } from '../src/engine/qto/drawaids';
import { snap as drawingSnap, type SnapIndex } from '../src/ui/takeoff/pdfcore';

test('⊥ snap: ortho = near the line, the foot anywhere on it; ortho off = only near the foot', () => {

  // a line (100,0) → (100,400), from (0,50): the foot of the perpendicular is (100,50)
  const wall = { a: [100, 0] as [number, number], b: [100, 400] as [number, number], bulge: 0 };
  // ortho: pointer 8 off the line, 150 away from the foot - still the foot
  assert.deepEqual(perpSnap([0, 50], [108, 200], [wall], 12)!.p, [100, 50]);
  // ortho off: that far from the foot it is not taken; within 12 of the foot it is
  assert.equal(perpSnap([0, 50], [108, 200], [wall], 12, true), null);
  assert.deepEqual(perpSnap([0, 50], [104, 58], [wall], 12, true)!.p, [100, 50]);
  // two lines near: the nearer foot wins (ortho off)
  const w2 = { a: [110, 0] as [number, number], b: [110, 400] as [number, number], bulge: 0 };
  assert.deepEqual(perpSnap([0, 50], [109, 52], [wall, w2], 12, true)!.p, [110, 50]);
});

test('the drawing snap hands back the lines near the pointer (for the ⊥ snap onto the drawing itself)', () => {
  // one cell, two lines: (100,0)-(100,400) and (300,0)-(300,400)
  const seg = new Float32Array([100, 0, 100, 400, 300, 0, 300, 400]);
  const ix = { seg, fl: new Uint8Array(2), n: 2, cols: 1, rows: 1, cw: 1000, ch: 1000, start: new Int32Array([0, 2]), ids: new Int32Array([0, 1]), w: 1000, h: 1000 } as unknown as SnapIndex;
  const near: number[] = [];
  const hit = drawingSnap(ix, 105, 150, 11, near);
  assert.deepEqual(near, [100, 0, 100, 400], 'only the line within 11 of the pointer');
  assert.equal(hit?.k, 'on');
  const none: number[] = [];
  drawingSnap(ix, 200, 200, 11, none);
  assert.deepEqual(none, []);
});

// ---------------------------------------------------------------- the fresh eyes' finds (11 Nov), each worked by hand
import { duplicateItemOps } from '../src/engine/qto/ops';
import { soffitFirstOps } from '../src/engine/qto/roomops';

test('fresh eyes: a duplicate keeps waterproofing, blinding, polythene, the soffit tick, mesh', () => {
  const ops = [...base, ...item('ti:g', 'area', { sk: 'sog', d: 0.15, wb: true, wsd: true, bln: true, blx: 0.1, pe: true, mesh: true }), ...sh('sh:g', 'ti:g', 'poly', rect(0, 0, 10, 10))];
  const m = build(ops);
  const d = duplicateItemOps(m, 'ti:g', 'n', { links: false, shapes: true })!;
  const m2 = build([...ops, ...d.ops]);
  const a = itemQty(m2, m2.itemById.get('ti:g')!), b = itemQty(m2, m2.itemById.get(d.id)!);
  for (const k of ['wph', 'wpv', 'blv', 'pea', 'area', 'vol'] as const) close(b[k], a[k], 'copy ' + k, 1e-2);
  assert.equal(m2.itemById.get(d.id)!.mesh, true);
});

test('fresh eyes: a typed quantity of a misc length with a height is its area (as 0.18.0 had it)', () => {
  const room: Op[] = [['ti:r', 'kind', 'room'], ['ti:r', 'name', 'K'], ['ti:r', 'ord', 'a0'], ...sh('sh:r', 'ti:r', 'poly', rect(0, 0, 6, 4))];
  const a = addMiscOps(build([...base, ...room]), 'n', 'ti:r', { name: 'Panel', code: 'GP-1', mu: 'm', h: 2.5, mq: 12 })!;
  const m = build([...base, ...room, ...a.ops]);
  const f = m.fin.qty.get('ti:r')!;
  close(f.byKey.get(a.id + '>area')!.qty, 12, 'm² as typed'); close(f.byKey.get(a.id)!.qty, 12 / 2.5, 'its length');
  assert.equal(m.fin.warnings.length, 0, 'm and m² of one item: no unit warning');
});

test('fresh eyes: a deducted linked ceiling comes off a full-room false ceiling; Convert keeps a bulkhead\'s ceiling', () => {
  const room = (f: Record<string, unknown>): Op[] => [['ti:r', 'kind', 'room'], ['ti:r', 'name', 'R'], ['ti:r', 'ord', 'a0'], ['ti:r', 'rmh', 3.2], ...Object.entries(f).map(([k, v]) => ['ti:r', k, v] as Op), ...sh('sh:r', 'ti:r', 'poly', rect(0, 0, 6, 4))];
  // a 2 × 2 area take-off linked to the ceiling (deducted)
  const link: Op[] = [...item('ti:l', 'area', { fcode: 'CL-9' }), ...sh('sh:l', 'ti:l', 'poly', rect(0, 0, 2, 2)), ['ti:l', 'rm', 'ti:r'], ['ti:l', 'rk', 'link'], ['ti:l', 'rcat', 'ceiling']];
  const full: Op[] = [['ti:f', 'kind', 'area'], ['ti:f', 'name', 'F'], ['ti:f', 'rm', 'ti:r'], ['ti:f', 'rk', 'add'], ['ti:f', 'rcat', 'ceiling'], ['ti:f', 'lv', 2.7], ['ti:f', 'fcode', 'GYP-01'], ['ti:f', 'full', true]];
  let m = build([...base, ...room({ cs: true, cc: 'PT-05' }), ...full, ...link]);
  const fq0 = m.fin.qty.get('ti:r')!;
  close(fq0.byKey.get('ti:f')!.qty, 20, 'full = 24 − the linked 4'); close(fq0.byKey.get('ceiling')!.qty, 0, 'soffit 0');
  assert.ok(!fq0.flags.includes('over'));
  // an old room with a bulkhead under its own ceiling (2.70 − 2.40 = 300 mm): converted, it keeps its ceiling and code
  const bh: Op[] = [['ti:b', 'kind', 'line'], ['ti:b', 'name', 'B'], ['ti:b', 'rm', 'ti:r'], ['ti:b', 'rk', 'add'], ['ti:b', 'rcat', 'ceiling'], ['ti:b', 'ak', 'bh'], ['ti:b', 'bh', 2.4], ...sh('sh:b', 'ti:b', 'line', [0, 1, 6, 1])];
  const st = storeWith([...base, ...room({ cc: 'GYP-01', ch: 2.7 }), ...bh]);
  m = buildQtoModel(st, null);
  const before = m.fin.qty.get('ti:r')!.byKey.get('ti:b')!;
  st.apply({ s: '9999999999~t', w: 't', u: 'n', t: 0, o: soffitFirstOps(m, 'n', 'ti:r').ops, a: 'n' });
  m = buildQtoModel(st, null);
  const after = m.fin.qty.get('ti:r')!.byKey.get('ti:b')!;
  assert.equal(after.code, before.code, 'bulkhead code ' + before.code); close(after.qty, before.qty);
});

test('fresh eyes: format 9 for a wall\'s own height and soffit-first rooms; "Unit #2" is a plain tag', () => {
  assert.ok(needsFormat181([['sh:x', 'xh', 5]]));
  assert.ok(needsFormat181([['ti:r', 'cs', true]]));
  assert.equal(tagBase('Unit #2'), 'Unit #2'); assert.deepEqual(tagOwn('Unit #2'), {});
  assert.equal(tagBase('#3'), '#3');
  assert.equal(tagBase('bt:abc#w=0.4'), 'bt:abc'); assert.equal(tagOwn('#w=0.4').w, 0.4); assert.equal(tagBase('#w=0.4'), null);
  assert.ok(!needsFormat181([['sh:x', 'sg', J(['Unit #2'])]]));
  assert.ok(needsFormat181([['sh:x', 'sg', J(['bt:a#w=0.4'])]]));
});

test('fresh eyes: a concrete wall with only its own height: openings off; retaining wall WP opening × Times, from its sill', () => {
  const ops = [...base, ...memberTypeOps('wt', { name: 'W1', w: 0.3, d: null, r: null, color: '#111' }, 'wt:1').ops,
    ...item('ti:w', 'wall', { sk: 'shear', bt: 'wt:1' }), ...sh('sh:w', 'ti:w', 'line', [0, 0, 10, 0], { xh: 3 })];
  const o = openingOps({ sh: 'sh:w', x: P(5), y: 0, k: 'open', door: null, tag: '', w: 1, h: 1, lint: false, sill: null });
  const r = q([...ops, ...('ops' in o ? o.ops : [])], 'ti:w');
  close(r.vol, 10 * 3 * 0.3 - 0.3, 'vol 9 − 0.3'); close(r.area, 30 - 1, 'area 30 − 1');
  // retaining wall 10 m × 3, WP one face to 2.00, × 2 (Times), an opening 1 × 1 (sill 0): (20 − 1) × 2 = 38
  const rw = [...base, ...memberTypeOps('rt', { name: 'R1', w: 0.3, d: null, r: null, color: '#111' }, 'rt:1').ops,
    ...item('ti:k', 'wall', { sk: 'rw', bt: 'rt:1', h: 3, wsd: true, wvh: 2, x: 2 }), ...sh('sh:k', 'ti:k', 'line', [0, 0, 10, 0])];
  const o2 = openingOps({ sh: 'sh:k', x: P(5), y: 0, k: 'open', door: null, tag: '', w: 1, h: 1, lint: false, sill: null });
  close(q([...rw, ...('ops' in o2 ? o2.ops : [])], 'ti:k').wpv, 38, 'WP × Times, the opening too');
});

test('fresh eyes: updating the stair schedule from a file with tread and riser only leaves the other sizes', () => {
  const m = build([...base, ...memberTypeOps('sy', { name: 'ST1', w: 1.4, d: 0.25, t: 0.25, tr: 0.28, ri: 0.17, r: null, color: '#111' }, 'sy:1').ops]);
  const plan = planBeamImport({ beamTypes: m.stairTypes }, [{ name: 'ST1', w: undefined as unknown as null, d: undefined as unknown as null, t: undefined, tr: 0.3, ri: 0.16 } as BeamIn], 'stair');
  const ch = plan.rows[0].ch.map((c) => c[0]).sort();
  assert.deepEqual(ch, ['ri', 'tr']);
});
