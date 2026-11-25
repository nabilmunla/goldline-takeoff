// v0.16.2 - the team's feedback 2 (5 Nov 2026), the parts that are engine:
// - the Location list of an additional item showed numbers (1.6836000000000002, 19.294249999999998…): a door
//   schedule's "Area" column (m²) had been read as the doors' location. A number is never a location.
// - the Finishes Summary to Excel: the view as shown (levels, filters, saved breakdown), subtotals, the parts.
// - a shadow gap with a code is in the summary (with no code it is listed apart, as every finish without one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readXlsx } from '../src/engine/xlsx';
import { writeXlsx } from '../src/engine/xlsxwrite';
import { analyseDoorSchedule, doorRows } from '../src/engine/qto/doorsched';
import { knownLocations } from '../src/engine/qto/additional';
import { Store } from '../src/engine/store';
import { buildQtoModel } from '../src/engine/qto/model';
import { scaleFromRatio } from '../src/engine/qto/geometry';
import { summarize } from '../src/engine/qto/finishes';
import { finishesSheets } from '../src/ui/takeoff/finexport';
import type { Op, Batch } from '../src/engine/types';

let seq = 0;
const apply = (st: Store, o: Op[]) => { seq++; st.apply({ s: String(seq).padStart(10, '0') + '~T', w: 'wT', u: 'T', t: seq, o } as Batch); return st; };
const S = scaleFromRatio(100);
const P = (x: number) => x / S;
const rect = (x0: number, y0: number, w: number, h: number) => JSON.stringify([P(x0), P(y0), P(x0 + w), P(y0), P(x0 + w), P(y0 + h), P(x0), P(y0 + h)]);
const room = (id: string, name: string, x0: number, f: Record<string, unknown>): Op[] => [
  [id, 'kind', 'room'], [id, 'name', name], [id, 'ord', 'a' + id], ...Object.entries(f).map(([k, v]) => [id, k, v] as Op),
  ['sh:' + id, 'ti', id], ['sh:' + id, 'dwg', 'd1'], ['sh:' + id, 'pg', 0], ['sh:' + id, 'k', 'poly'], ['sh:' + id, 'p', rect(x0, 0, 5, 4)],
];

test('a door schedule\'s "Area" column of numbers is not the doors\' location; the Location list never offers a number', () => {
  const w = readXlsx(writeXlsx([{ name: 'Door Schedule', rows: [
    ['Door No.', 'Area', 'Width (mm)', 'Height (mm)', 'Description'],
    ['D01', 1.6836000000000002, 900, 2100, 'Single leaf timber'],
    ['D02', 'Kitchen', 1000, 2100, 'Single leaf timber'],
  ] }]));
  const plan = analyseDoorSchedule(w)!;
  assert.equal(plan.cols.loc, 2, 'the "Area" heading is still the location column (a text there is a location)');
  const rows = doorRows(w, plan);
  assert.equal(rows.find((r) => r.tag === 'D01')!.loc ?? '', '');
  assert.equal(rows.find((r) => r.tag === 'D02')!.loc, 'Kitchen');
  // a schedule imported before (numbers stored as locations): never offered
  const locs = knownLocations({ dummies: [{ loc: 'Roof' }, { loc: '3.74' }] as never, doors: [{ loc: '19.294249999999998' }, { loc: '16.4865' }, { loc: 'Level 3' }] as never, boqById: new Map() });
  assert.deepEqual(locs, ['Level 3', 'Roof']);
});

test('the shadow gap with a code is in the summary; without one it is listed apart ("has no code")', () => {
  const st = apply(new Store(), [['pg:d1.0', 'sc', S], ...room('ti:r1', 'Bedroom', 0, { fc: 'FL-02', cc: 'CL-01', gc: 'SG-01', gm: 'all' }), ...room('ti:r2', 'Study', 10, { fc: 'FL-02', gm: 'all' })]);
  const m = buildQtoModel(st, null);
  const s = summarize(m);
  assert.deepEqual(s.rows.map((r) => [r.code, r.unit, Math.round(r.qty * 1000) / 1000]), [['CL-01', 'm²', 20], ['FL-02', 'm²', 40], ['SG-01', 'm', 18]]);
  assert.deepEqual(s.uncoded.map((a) => [a.roomName, a.reason]).sort(), [['Study', 'Ceiling finish has no code'], ['Study', 'Shadow gap has no code']]);
});

test('the Finishes Summary to Excel: the view as shown, every level open, the parts, what has no code', () => {
  const st = apply(new Store(), [['pg:d1.0', 'sc', S], ...room('ti:r1', 'Bedroom', 0, { fc: 'FL-02', cc: 'CL-01', gc: 'SG-01', gm: 'all' }), ...room('ti:r2', 'Study', 10, { fc: 'FL-02', gm: 'all' })]);
  const m = buildQtoModel(st, null);
  const sheets = finishesSheets(m, ['room'], { types: ['Floor', 'Shadow gap'] }, { project: 'TND02', breakdown: 'By room', when: new Date(2026, 10, 5, 15, 0) });
  const wb = readXlsx(writeXlsx(sheets));
  assert.deepEqual(wb.sheetNames.map((x) => x.name), ['Summary', 'Detail', 'No code']);
  const sr = wb.sheet('Summary').rows;
  // (a blank cell is not written: read back as '')
  // (full values in the file, like Excel - compared at 3 decimals here)
  const r3 = (v: unknown) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
  const row = (r: number) => Array.from({ length: 6 }, (_, i) => r3(sr.get(r)?.[i + 1]?.v ?? ''));
  assert.equal(row(1)[0], 'TND02 — Finishes Summary');
  assert.match(String(row(2)[0]), /Breakdown: By room · grouped by Code \+ unit › Room name/);
  assert.match(String(row(3)[0]), /Shown: Floor, Shadow gap/);
  const body = [...sr.keys()].filter((r) => r >= 6).sort((a, b) => a - b).map(row);
  assert.deepEqual(body[0], ['Code', 'Unit', 'Level', 'Quantity', 'Linked', 'Unlinked']);
  // the ceiling is filtered out; FL-02 with its two rooms under it; SG-01 with the bedroom
  assert.deepEqual(body.slice(1).map((r) => [r[0], r[2], r[3]]), [['FL-02', '', 40], ['FL-02', 'Bedroom', 20], ['FL-02', 'Study', 20], ['SG-01', '', 18], ['SG-01', 'Bedroom', 18]]);
  const det = [...wb.sheet('Detail').rows.entries()].filter(([r]) => r > 6).sort((a, b) => a[0] - b[0]).map(([, c]) => [c[1]?.v, c[4]?.v, r3(c[7]?.v)]);
  assert.deepEqual(det, [['FL-02', 'Bedroom — Floor finish', 20], ['SG-01', 'Bedroom — Shadow gap', 18], ['FL-02', 'Study — Floor finish', 20]]);
  const nc = [...wb.sheet('No code').rows.values()].map((c) => String(c[2]?.v ?? ''));
  assert.ok(nc.some((x) => /Shadow gap has no code/.test(x)), nc.join(' | '));
});

test('a shape with a coordinate that is not a number (a damaged journal) counts nothing - not NaN (0.16.1 QA hunt, S-7)', () => {
  const st = apply(new Store(), [['pg:d1.0', 'sc', S], ['ti:a', 'kind', 'area'], ['ti:a', 'name', 'Slab'], ['ti:a', 'ord', 'a0'],
    ['sh:ok', 'ti', 'ti:a'], ['sh:ok', 'dwg', 'd1'], ['sh:ok', 'pg', 0], ['sh:ok', 'k', 'poly'], ['sh:ok', 'p', rect(0, 0, 2, 2)],
    ['sh:bad', 'ti', 'ti:a'], ['sh:bad', 'dwg', 'd1'], ['sh:bad', 'pg', 0], ['sh:bad', 'k', 'poly'], ['sh:bad', 'p', JSON.stringify([0, 0, 'x', 0, P(1), P(1), 0, P(1)])]]);
  const q = buildQtoModel(st, null).qty.get('ti:a') as { area?: number } | undefined;
  assert.ok(q && Number.isFinite(q.area) && Math.abs(q.area! - 4) < 1e-6, JSON.stringify(q));
});
