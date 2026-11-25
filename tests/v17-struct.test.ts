// v0.17.0 structural elements (Nabil, 9 Nov): slabs and drop panels (area × thickness; formwork soffit + edges; steel
// by ratio), columns (counted, each its type's section × the take-off's height), shear walls (wall × its type's
// thickness, formwork both faces, openings off), upstand beams (full depth on the slab, both sides, no soffit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/engine/store';
import { buildQtoModel, measuresFor, needsFormat17, itemQty, itemKindLabel } from '../src/engine/qto/model';
import { scaleFromRatio } from '../src/engine/qto/geometry';
import { beamTypeOps, memberTypeOps, newStructOps, openingOps } from '../src/engine/qto/ops';
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
const q = (ops: Op[], id: string) => { const m = buildQtoModel(storeWith(ops), null); return itemQty(m, m.itemById.get(id)!); };

test('a slab: area × thickness; formwork the soffit and its edges; steel by its ratio', () => {
  const r = q([...base, ...item('ti:s', 'area', { sk: 'slab', d: 0.2, sr: 100 }), ...sh('sh:s', 'ti:s', 'poly', [0, 0, 5, 0, 5, 4, 0, 4])], 'ti:s');
  close(r.area, 20); close(r.vol, 4); close(r.form, 20 + 18 * 0.2, 'form'); close(r.kg, 400);
});

test('a drop panel: the same - its thickness the projection below the slab', () => {
  const r = q([...base, ...item('ti:d', 'area', { sk: 'drop', d: 0.15, sr: 80 }), ...sh('sh:d', 'ti:d', 'poly', [0, 0, 2, 0, 2, 2, 0, 2])], 'ti:d');
  close(r.vol, 0.6); close(r.form, 4 + 8 * 0.15); close(r.kg, 48);
});

test('columns: each its type (own, else the default) × the height; round ones; one without a type is said', () => {
  const ops: Op[] = [...base, ...memberTypeOps('ct', { name: 'C1', w: 0.4, d: 0.6, r: 200, color: '#111' }, 'ct:1').ops,
    ...memberTypeOps('ct', { name: 'C2', w: 0.5, d: null, r: null, color: '#222', round: true }, 'ct:2').ops,
    ...item('ti:c', 'count', { sk: 'col', h: 3, bt: 'ct:1', sr: 150 }),
    ...sh('sh:c1', 'ti:c', 'pt', [1, 1]), ...sh('sh:c2', 'ti:c', 'pt', [5, 1]), ...sh('sh:c3', 'ti:c', 'pt', [9, 1], { mt: 'ct:2' })];
  const r = q(ops, 'ti:c');
  close(r.cnt, 3);
  const vRound = Math.PI * 0.25 * 0.25 * 3;
  close(r.vol, 2 * 0.24 * 3 + vRound, 'vol');
  close(r.form, 2 * 2 * 3 + Math.PI * 0.5 * 3, 'form');
  close(r.kg, 2 * 0.72 * 200 + vRound * 150, 'kg: C2 has no ratio - the take-off\'s');
  close(r.len, 9, 'their length: 3 × 3.00');
  const r2 = q([...ops.filter((o) => !(o[0] === 'ti:c' && o[1] === 'bt'))], 'ti:c');
  close(r2.untyped, 2, 'no default type: two without a type');
});

test('a shear wall: its type\'s thickness × the height, formwork both faces; an opening comes off all three', () => {
  const ops: Op[] = [...base, ...memberTypeOps('wt', { name: 'SW1', w: 0.25, d: null, r: 120, color: '#333' }, 'wt:1').ops,
    ...item('ti:w', 'wall', { sk: 'shear', h: 3, bt: 'wt:1' }), ...sh('sh:w', 'ti:w', 'line', [0, 0, 10, 0])];
  const r = q(ops, 'ti:w');
  close(r.area, 30); close(r.vol, 7.5); close(r.form, 60); close(r.kg, 900);
  assert.equal(r.lcnt, 0);
  const o = openingOps({ sh: 'sh:w', x: P(5), y: 0, k: 'open', door: null, tag: '', w: 1, h: 2, lint: true, sill: null });
  const r2 = q([...ops, ...o.ops], 'ti:w');
  close(r2.area, 28); close(r2.vol, 7.5 * 28 / 30); close(r2.form, 56); close(r2.kg, 840);
  assert.equal(r2.lcnt, 0, 'no lintel in a concrete wall');
});

test('an upstand beam: the part above the slab (overall depth less the slab), formwork both sides, no soffit', () => {
  const ops = (up: boolean): Op[] => [...base, ...beamTypeOps({ name: 'B1', w: 0.3, d: 0.6, r: 100, color: '#111' }, 'bt:1').ops,
    ...item('ti:b', 'beam', { bt: 'bt:1', st: 0.2, ...(up ? { up: true } : {}) }), ...sh('sh:b', 'ti:b', 'line', [0, 0, 10, 0])];
  const dn = q(ops(false), 'ti:b'), upq = q(ops(true), 'ti:b');
  close(dn.vol, 1.2); close(dn.form, 11);
  close(upq.vol, 1.2); close(upq.form, 8); close(upq.kg, 120);
});

test('measures, names, format 7', () => {
  const m = buildQtoModel(storeWith([...item('ti:s', 'area', { sk: 'slab' }), ...item('ti:c', 'count', { sk: 'col' }), ...item('ti:w', 'wall', { sk: 'shear' }), ...item('ti:x', 'line', { sk: 'slab' }), ...item('ti:b', 'beam', { up: true })]), null);
  assert.deepEqual(measuresFor(m.itemById.get('ti:s')!).slice(0, 4), ['vol', 'area', 'form', 'kg']);
  assert.deepEqual(measuresFor(m.itemById.get('ti:c')!).slice(0, 4), ['cnt', 'vol', 'form', 'kg']);
  assert.equal(m.itemById.get('ti:x')!.sk, '', 'a length is never a slab');
  assert.equal(itemKindLabel(m.itemById.get('ti:w')!), 'Core wall');
  assert.equal(itemKindLabel(m.itemById.get('ti:b')!), 'Upstand beam');
  const r = newStructOps(m, 'n', 'col');
  assert.ok(r.ops.some((o) => o[1] === 'kind' && o[2] === 'count') && r.ops.some((o) => o[1] === 'sk' && o[2] === 'col') && r.ops.some((o) => o[1] === 'name' && /^Columns/.test(String(o[2]))));
  assert.ok(needsFormat17(r.ops as [string, string, unknown][]));
  assert.ok(needsFormat17([['ct:1', 'name', 'C1']]) && needsFormat17([['sh:1', 'mt', 'ct:1']]) && needsFormat17([['sh:1', 'sg', '[null,"wt:1"]']]));
  assert.ok(!needsFormat17([['ti:a', 'sk', null]]) && !needsFormat17([['sh:1', 'sg', '[null,"bt:1"]']]));
});

// ---------------- the review (9 Nov)
test('review: a column copied keeps its own type', async () => {
  const { copyShapesOps } = await import('../src/engine/qto/ops');
  const ops: Op[] = [...base, ...memberTypeOps('ct', { name: 'C1', w: 0.4, d: 0.4, r: null, color: '#1' }, 'ct:1').ops, ...memberTypeOps('ct', { name: 'C2', w: 1, d: 1, r: null, color: '#2' }, 'ct:2').ops,
    ...item('ti:c', 'count', { sk: 'col', h: 3, bt: 'ct:1' }), ...sh('sh:c', 'ti:c', 'pt', [1, 1], { mt: 'ct:2' })];
  const st = storeWith(ops);
  const m = buildQtoModel(st, null);
  const c = copyShapesOps([m.shapes.find((x) => x.id === 'sh:c')!], { dwg: 'd1', pg: 0 }, 'n', 10, 0);
  assert.ok(c.ops.some((o) => o[1] === 'mt' && o[2] === 'ct:2'));
});

test('review: an opening on a shear wall comes off its own segment\'s thickness', async () => {
  const ops: Op[] = [...base, ...memberTypeOps('wt', { name: 'SW4', w: 0.4, d: null, r: null, color: '#1' }, 'wt:4').ops, ...memberTypeOps('wt', { name: 'SW2', w: 0.2, d: null, r: null, color: '#2' }, 'wt:2').ops,
    ...item('ti:w', 'wall', { sk: 'shear', h: 3 }), ...sh('sh:w', 'ti:w', 'line', [0, 0, 10, 0, 20, 0], { sg: J(['wt:4', 'wt:2']) })];
  const o = openingOps({ sh: 'sh:w', x: P(15), y: 0, k: 'open', door: null, tag: '', w: 2, h: 2, lint: true, sill: null });
  const r = q([...ops, ...o.ops], 'ti:w');
  close(r.vol, 12 + 6 - 4 * 0.2, 'off the 200 wall: 17.2');
  close(r.form, 120 - 8);
});

test('review: no height is not "without a type"', () => {
  const r = q([...base, ...memberTypeOps('ct', { name: 'C1', w: 0.4, d: 0.4, r: null, color: '#1' }, 'ct:1').ops, ...item('ti:c', 'count', { sk: 'col', bt: 'ct:1' }), ...sh('sh:c', 'ti:c', 'pt', [1, 1])], 'ti:c');
  assert.equal(r.untyped, 0);
  close(r.vol, 0);
});

test('review: 0.16.5 / 0.16.6 things marked format 6 (a 0.16.4 app opens them view only)', async () => {
  const { needsFormat165 } = await import('../src/engine/qto/model');
  assert.ok(needsFormat165([['fl:a', 'code', 'PT-05 (SFT)']]) && needsFormat165([['fl:a', 'nb', true]]) && needsFormat165([['ti:b', 'ak', 'bh']]));
  assert.ok(!needsFormat165([['fl:a', 'code', 'PT-05']]) && !needsFormat165([['ti:u', 'ak', 'up']]));
});
