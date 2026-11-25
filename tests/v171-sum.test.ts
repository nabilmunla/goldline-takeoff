// v0.17.1 (Feedback 3) the Structure and Blockwork summaries of Finalize: by element / type / heading, with the
// take-offs behind each row and which of them are linked for each quantity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/engine/store';
import { buildQtoModel } from '../src/engine/qto/model';
import { scaleFromRatio } from '../src/engine/qto/geometry';
import { memberTypeOps, beamTypeOps, linkOps } from '../src/engine/qto/ops';
import { structSummary, structSummaryRows } from '../src/engine/qto/structsum';
import type { Op } from '../src/engine/types';

let stamp = 0;
const storeWith = (ops: Op[]) => { const s = new Store(); s.apply({ s: String(++stamp).padStart(10, '0') + '~t', w: 't', u: 'n', t: 0, o: ops, a: 'n' }); return s; };
const J = (v: unknown) => JSON.stringify(v);
const close = (a: number | undefined, b: number, msg = '') => assert.ok(a !== undefined && Math.abs(a - b) < 1e-6, `${msg} ${a} != ${b}`);
const S = scaleFromRatio(100);
const P = (m: number) => m / S;
const sh = (id: string, ti: string, k: 'poly' | 'line' | 'pt', pts: number[], f: Record<string, unknown> = {}): Op[] => [[id, 'ti', ti], [id, 'dwg', 'd1'], [id, 'pg', 0], [id, 'k', k], [id, 'p', J(pts.map(P))], ...Object.entries(f).map(([k, v]) => [id, k, v] as Op)];
const item = (id: string, kind: string, name: string, f: Record<string, unknown> = {}): Op[] => [[id, 'kind', kind], [id, 'name', name], [id, 'ord', 'a' + id], ...Object.entries(f).map(([k, v]) => [id, k, v] as Op)];
const head = (id: string, name: string, par = '', ord = 'a0'): Op[] => [[id, 'name', name], [id, 'par', par || null], [id, 'ord', ord]];
const ops: Op[] = [['pg:d1.0', 'sc', S],
  ...head('hd:a', 'Block A'), ...head('hd:gf', 'GF', 'hd:a', 'a1'), ...head('hd:1f', '1F', 'hd:a', 'a2'),
  ...memberTypeOps('ct', { name: 'C1', w: 0.4, d: 0.5, r: 200, color: '#1' }, 'ct:1').ops, ...memberTypeOps('ct', { name: 'C2', w: 0.5, d: 0.5, r: 150, color: '#2' }, 'ct:2').ops,
  ...beamTypeOps({ name: 'B1', w: 0.3, d: 0.6, r: 100, color: '#3' }, 'bt:1').ops,
  ...item('ti:cg', 'count', 'GF columns', { sk: 'col', h: 3, bt: 'ct:1', par: 'hd:gf' }), ...sh('sh:c1', 'ti:cg', 'pt', [1, 1]), ...sh('sh:c2', 'ti:cg', 'pt', [5, 1], { mt: 'ct:2' }),
  ...item('ti:c1', 'count', '1F columns', { sk: 'col', h: 3, bt: 'ct:1', par: 'hd:1f' }), ...sh('sh:c3', 'ti:c1', 'pt', [1, 1]),
  ...item('ti:b', 'beam', 'GF beams', { bt: 'bt:1', par: 'hd:gf' }), ...sh('sh:b', 'ti:b', 'line', [0, 0, 10, 0]),
  ...item('ti:s', 'area', 'GF slab', { sk: 'slab', d: 0.2, sr: 100, par: 'hd:gf' }), ...sh('sh:s', 'ti:s', 'poly', [0, 0, 5, 0, 5, 4, 0, 4]),
  ...item('ti:w2', 'wall', 'Internal walls', { h: 3, d: 0.2 }), ...sh('sh:w2', 'ti:w2', 'line', [0, 0, 10, 0]),
  ...item('ti:w1', 'wall', 'Partitions', { h: 3, d: 0.1 }), ...sh('sh:w1', 'ti:w1', 'line', [0, 0, 4, 0]),
  ...item('ti:a', 'area', 'Floor tiles'),
  ...linkOps('ti:cg', 'dm:x', 'vol', 1, 'lk:1').ops, ['dm:x', 'desc', 'Concrete in columns'], ['dm:x', 'unit', 'm3'],
];
const m = buildQtoModel(storeWith(ops), null);

test('structure by element: beams, columns, slabs in order; concrete, formwork, steel, kg/m³; plain take-offs left out', () => {
  const s = structSummary(m, 'struct');
  assert.deepEqual(s.rows.map((r) => r.label), ['Beams', 'Columns', 'Slabs']);
  const col = s.rows[1];
  assert.deepEqual(col.children.map((c) => c.label), ['GF columns', '1F columns']);
  close(col.qty.vol, (0.2 + 0.25 + 0.2) * 3, 'columns concrete');
  close(col.meas!.qty, 3); assert.equal(col.meas!.unit, 'nr');
  close(col.ratio!, (0.6 * 200 + 0.75 * 150 + 0.6 * 200) / 1.95);
  assert.deepEqual(col.give.vol, ['ti:cg', 'ti:c1']);
  assert.deepEqual(col.linked.vol, ['ti:cg'], 'one of the two linked for concrete');
  assert.equal(col.linked.form, undefined);
  close(s.total.qty.vol, 1.95 + 10 * 0.3 * 0.6 + 4);
});

test('by type: C1 and C2 across the take-offs (no links on a type row)', () => {
  const col = structSummary(m, 'struct', 'type').rows.find((r) => r.label === 'Columns')!;
  assert.deepEqual(col.children.map((c) => [c.label, c.meas?.qty, c.type]), [['C1', 2, true], ['C2', 1, true]]);
  close(col.children[0].qty.vol, 1.2);
});

test('by subheading: GF › Columns apart from 1F › Columns; the heading filter takes what is under a heading', () => {
  const s = structSummary(m, 'struct', 'head');
  assert.deepEqual(s.rows.map((r) => r.label), ['Block A › GF › Beams', 'Block A › GF › Columns', 'Block A › GF › Slabs', 'Block A › 1F › Columns']);
  assert.deepEqual(structSummary(m, 'struct', 'h0').rows.map((r) => r.label), ['Block A › Beams', 'Block A › Columns', 'Block A › Slabs']);
  assert.deepEqual(structSummary(m, 'struct', 'el', { heads: ['hd:1f'] }).rows.map((r) => [r.label, r.items]), [['Columns', ['ti:c1']]]);
  assert.equal(structSummary(m, 'struct', 'el', { heads: ['hd:a'] }).rows.length, 3);
});

test('blockwork by thickness: thinnest first; area, length, volume; Excel rows', () => {
  const s = structSummary(m, 'block');
  assert.deepEqual(s.rows.map((r) => r.label), ['100 mm walls', '200 mm walls']);
  close(s.rows[1].qty.area, 30); close(s.rows[1].qty.vol, 6); close(s.rows[0].qty.len, 4);
  const x = structSummaryRows(s, 'block');
  assert.equal(x[0][0], 'Walls / take-off');
  assert.equal(x.length, 1 + 4 + 1);
});

// 0.23.2 (DeepSeek #9, #10, #13)
test('retaining walls with blinding and polythene only: the columns are there; waste is in the type rows too', () => {
  const rw: Op[] = [['pg:d1.0', 'sc', S], ...memberTypeOps('rt', { name: 'RW1', w: 0.3, d: null, r: 120, color: '#1' }, 'rt:1').ops,
    ...item('ti:rw', 'wall', 'Retaining wall', { sk: 'rw', h: 3, bt: 'rt:1', bln: true, pe: true }), ...sh('sh:rw', 'ti:rw', 'line', [0, 0, 10, 0])];
  const m1 = buildQtoModel(storeWith(rw), null);
  const s = structSummary(m1, 'struct');
  assert.ok(s.cols.some((c) => c.ms === 'blv'), 'a Blinding column');
  assert.ok(s.cols.some((c) => c.ms === 'pea'), 'a Polythene column');
  assert.ok((s.total.qty.blv ?? 0) > 0 && (s.total.qty.pea ?? 0) > 0, 'with the retaining wall\'s figures');
  // 10 % waste on the columns: the type rows add up to the element row
  const mw = buildQtoModel(storeWith([...ops, ['ti:cg', 'waste', 10]]), null);
  const col = structSummary(mw, 'struct', 'type').rows.find((r) => r.label === 'Columns')!;
  const sum = col.children.reduce((a, c) => a + (c.qty.vol ?? 0), 0);
  close(sum, col.qty.vol!, 'type rows = element');
});

test('the By sheet export gives a typed column its length (from its type)', async () => {
  const { exportQto } = await import('../src/engine/qto/export');
  const { readXlsx } = await import('../src/engine/xlsx');
  const wb = readXlsx(exportQto(m, { project: 'P', by: 'n' }));
  const bs = wb.sheet('By sheet');
  const rows = [...bs.rows.values()].map((r) => [...r]);
  const val = (c: any) => (c && typeof c === 'object' && 'v' in c ? c.v : c);
  const hdr = rows.findIndex((r) => r.some((c) => val(c) === 'Length (m)'));
  const li = rows[hdr].findIndex((c) => val(c) === 'Length (m)');
  const gf = rows.find((r) => r.some((c) => val(c) === 'GF columns'))!;
  assert.ok(Number(val(gf[li])) > 0, 'GF columns length on the sheet: ' + val(gf[li]));
});
