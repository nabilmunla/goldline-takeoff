// v0.16.6 (Nabil, 9 Nov: "what about beam schedules? we have a way to see doors and import them easily") - the beam
// schedule from Excel (mark, width, depth or one size, the steel ratio when given), matched by mark; and the marks on
// a drawing tagging the beam segments they sit by (proposed, then kept).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeXlsx } from '../src/engine/xlsxwrite';
import { readXlsx } from '../src/engine/xlsx';
import { Store } from '../src/engine/store';
import { buildQtoModel } from '../src/engine/qto/model';
import { scaleFromRatio } from '../src/engine/qto/geometry';
import { beamTypeOps } from '../src/engine/qto/ops';
import { analyseBeamSchedule, beamRows, guessBeamCols, planBeamImport, applyBeamPlanOps, beamTagProposals, beamTagOps } from '../src/engine/qto/beamsched';
import type { Op, Batch } from '../src/engine/types';

let seq = 0;
const apply = (st: Store, ops: Op[]) => { seq++; st.apply({ s: String(seq).padStart(10, '0') + '~T', w: 'wT', u: 'T', t: seq, o: ops } as Batch); return st; };
const close = (a: unknown, b: number, msg = '') => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-6, `${msg} ${a} != ${b}`);

test('a beam schedule: mark, B, D in mm; a heading row and a note in the table skipped', () => {
  const wb = readXlsx(writeXlsx([{ name: 'Beams', rows: [
    ['BEAM SCHEDULE'],
    ['Beam Mark', 'B (mm)', 'D (mm)', 'Top reinforcement', 'Bottom reinforcement', 'Stirrups'],
    ['GROUND FLOOR'],
    ['B1', 300, 600, '4T16', '4T20', 'T10@150'],
    ['B2', 250, 500, '3T16', '3T16', 'T10@200'],
    ['B-3', '400', '750', '', '', ''],
    ['Note: all beams C40'],
  ] }]));
  const plan = analyseBeamSchedule(wb)!;
  assert.ok(plan, 'found');
  assert.equal(plan.header, 2);
  assert.equal(plan.cols.r, undefined, 'bars are not a steel ratio');
  const r = beamRows(wb, plan);
  assert.deepEqual(r.map((x) => x.name), ['B1', 'B2', 'B-3']);
  close(r[0].w, 0.3); close(r[0].d, 0.6); close(r[2].d, 0.75);
});

test('one size column ("300 x 600") and a steel ratio column', () => {
  const wb = readXlsx(writeXlsx([{ name: 'S', rows: [
    ['Type', 'Size (W x D)', 'Steel (kg/m3)'],
    ['RB1', '300x700', 160],
    ['RB2', '250 × 500 mm', '140 kg/m3'],
  ] }]));
  const plan = analyseBeamSchedule(wb)!;
  const r = beamRows(wb, plan);
  assert.equal(r.length, 2);
  close(r[0].w, 0.3); close(r[0].d, 0.7); close(r[0].r, 160);
  close(r[1].w, 0.25); close(r[1].d, 0.5); close(r[1].r, 140);
});

test('headings read: Width / Depth / Mark; "Overall depth"; a no-ratio file', () => {
  const c = guessBeamCols(new Map([[1, 'Mark'], [2, 'Width'], [3, 'Overall Depth'], [4, 'Remarks']]));
  assert.deepEqual(c, { mark: 1, w: 2, d: 3 });
});

test('import against the schedule: new, changed (each field), the same; a typed ratio kept when the file has none', () => {
  const st = apply(new Store(), [...beamTypeOps({ name: 'B1', w: 0.3, d: 0.6, r: 150, color: '#111' }, 'bt:1').ops, ...beamTypeOps({ name: 'B2', w: 0.25, d: 0.45, r: null, color: '#222' }, 'bt:2').ops,
    ...beamTypeOps({ name: 'B9', w: 0.2, d: 0.4, r: null, color: '#333' }, 'bt:9').ops]);
  const m = buildQtoModel(st, null);
  const plan = planBeamImport(m, [{ name: 'b-1', w: 0.3, d: 0.6, r: null }, { name: 'B2', w: 0.25, d: 0.5 }, { name: 'B3', w: 0.4, d: 0.75, r: 170 }, { name: 'B3', w: 9, d: 9 }]);
  assert.deepEqual(plan.rows.map((r) => r.k), ['same', 'changed', 'new']);
  assert.deepEqual(plan.rows[1].ch, [['d', 0.45, 0.5]]);
  assert.deepEqual(plan.dupes, ['B3']);
  assert.deepEqual(plan.missing.map((t) => t.name), ['B9']);
  const take = new Map<string, true>(plan.rows.map((r) => [r.key, true]));
  const r = applyBeamPlanOps(plan, take, ['#a', '#b'], m.beamTypes.length);
  assert.equal(r.added, 1); assert.equal(r.updated, 1);
  apply(st, r.ops);
  const m2 = buildQtoModel(st, null);
  const b3 = m2.beamTypes.find((t) => t.name === 'B3')!;
  close(b3.d, 0.75); close(b3.r, 170);
  close(m2.beamTypes.find((t) => t.id === 'bt:2')!.d, 0.5);
  close(m2.beamTypes.find((t) => t.id === 'bt:1')!.r, 150, 'the ratio typed in the app stays');
});

test('marks on the drawing: each to the beam segment it sits by; already that type left out; far marks ignored', () => {
  const S = scaleFromRatio(100);
  const J = JSON.stringify;
  const st = apply(new Store(), [['pg:d1.0', 'sc', S], ...beamTypeOps({ name: 'B1', w: 0.3, d: 0.6, r: null, color: '#111' }, 'bt:1').ops,
    ...beamTypeOps({ name: 'B2', w: 0.25, d: 0.5, r: null, color: '#222' }, 'bt:2').ops,
    ['ti:b', 'kind', 'beam'], ['ti:b', 'name', 'GF beams'], ['ti:b', 'ord', 'a0'],
    // an L: segment 0 along the bottom (0,0)-(200,0), segment 1 up (200,0)-(200,150) - sheet points
    ['sh:b', 'ti', 'ti:b'], ['sh:b', 'dwg', 'd1'], ['sh:b', 'pg', 0], ['sh:b', 'k', 'line'], ['sh:b', 'p', J([0, 0, 200, 0, 200, 150])], ['sh:b', 'sg', J([null, 'bt:2'])],
  ]);
  const m = buildQtoModel(st, null);
  const word = (t: string, x: number, y: number) => ({ text: t, p: [x, y] as [number, number], x0: x - 5, y0: y - 2.5, x1: x + 5, y1: y + 2.5 });
  const props = beamTagProposals(m.shapes, [
    { bt: 'bt:1', f: word('B1', 100, -6) }, // over segment 0
    { bt: 'bt:2', f: word('B2', 206, 75) }, // by segment 1: tagged B2 already
    { bt: 'bt:1', f: word('B1', 100, -40) }, // far (a column mark across the room)
    { bt: 'bt:1', f: word('B1', 110, 9) }, // also by segment 0, further: the nearer wins
  ]);
  assert.equal(props.length, 2);
  const p0 = props.find((x) => x.seg === 0)!;
  assert.ok(p0.on && p0.bt === 'bt:1' && Math.abs(p0.p[1] + 6) < 1e-9);
  const p1 = props.find((x) => x.seg === 1)!;
  assert.ok(p1.same && !p1.on, 'tagged B2 already: left out');
  apply(st, beamTagOps(m.shapes, props));
  const s = buildQtoModel(st, null).shapes.find((x) => x.id === 'sh:b')!;
  assert.deepEqual(s.sg, ['bt:1', 'bt:2']);
});

test('review: schedule traps - Sr. No. is not the mark, total kg / % not a ratio, a column\'s Height not its depth', () => {
  const wb = readXlsx(writeXlsx([{ name: 'S', rows: [
    ['Sr. No.', 'Beam Mark', 'Width (mm)', 'Depth (mm)', 'Total steel (kg)', 'Reinf. ratio (%)'],
    [1, 'B1', 300, 600, 850, 1.5],
    [2, 'B2', 250, 500, 600, 1.2],
  ] }]));
  const r = beamRows(wb, analyseBeamSchedule(wb)!);
  assert.deepEqual(r.map((x) => x.name), ['B1', 'B2']);
  assert.equal(r[0].r, undefined, 'no ratio column');
  const wc = readXlsx(writeXlsx([{ name: 'C', rows: [['Column', 'Size', 'Height (m)'], ['C1', '400x600', 3.6], ['C2', 'φ600', 3.6]] }]));
  const rc = beamRows(wc, analyseBeamSchedule(wc, 'col')!, 'col');
  close(rc[0].w, 0.4); close(rc[0].d, 0.6, 'not the 3.6 m height');
  assert.ok(rc[1].round); close(rc[1].w, 0.6);
});

test('review: shear walls "WALL | THK" with "250 THK"; "Width x Depth (mm)" one size column', () => {
  const ww = readXlsx(writeXlsx([{ name: 'W', rows: [['WALL', 'THK'], ['SW1', '250 THK'], ['SW2', '300mm thk'], ['SW3', 200]] }]));
  const rw = beamRows(ww, analyseBeamSchedule(ww, 'wall')!, 'wall');
  assert.deepEqual(rw.map((x) => [x.name, x.w]), [['SW1', 0.25], ['SW2', 0.3], ['SW3', 0.2]]);
  const wb = readXlsx(writeXlsx([{ name: 'B', rows: [['Mark', 'Width x Depth (mm)'], ['B1', '300 x 700']] }]));
  const rb = beamRows(wb, analyseBeamSchedule(wb)!);
  close(rb[0].w, 0.3); close(rb[0].d, 0.7);
});
