// Door schedules from Excel (v0.15)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeXlsx } from '../src/engine/xlsxwrite';
import { readXlsx } from '../src/engine/xlsx';
import { analyseDoorSchedule, doorRows, sizeOf, pairOf } from '../src/engine/qto/doorsched';

const wb = (rows: (string | number | null)[][], name = 'Door Schedule') => readXlsx(writeXlsx([{ name: 'Notes', rows: [['Project X'], ['nothing here']] }, { name, rows }]));

test('two-row headings: structural and clear openings, mm, a heading row inside the table', () => {
  const w = wb([
    ['DOOR SCHEDULE'],
    [],
    ['Door No.', 'Description', 'Location', 'Structural Opening', null, 'Clear Opening', null, 'Qty'],
    [null, null, null, 'Width', 'Height', 'Width', 'Height'],
    ['GROUND FLOOR'],
    ['D01', 'Flush timber door', 'Bedroom', 1000, 2200, 900, 2100, 4],
    ['D02', 'Steel door, FR60', 'Stair', '1100', '2250', 1000, 2150, 2],
    ['D03', 'Glazed door', 'Lobby', null, null, '1.2', '2.4'],
  ]);
  const p = analyseDoorSchedule(w)!;
  assert.equal(p.sheet, 'Door Schedule');
  assert.equal(p.header, 4);
  assert.deepEqual([p.cols.tag, p.cols.desc, p.cols.loc, p.cols.sw, p.cols.sh, p.cols.cw, p.cols.ch], [1, 2, 3, 4, 5, 6, 7]);
  const r = doorRows(w, p);
  assert.deepEqual(r.map((x) => x.tag), ['D01', 'D02', 'D03']);
  assert.deepEqual([r[0].sw, r[0].sh, r[0].cw, r[0].ch], [1, 2.2, 0.9, 2.1]);
  assert.deepEqual([r[1].sw, r[1].sh], [1.1, 2.25]);
  assert.deepEqual([r[2].sw, r[2].cw, r[2].ch], [null, 1.2, 2.4]);
  assert.equal(r[1].desc, 'Steel door, FR60');
  assert.equal(r[2].loc, 'Lobby');
});

test('one size column "900 x 2100"; plain Width / Height are the structural opening', () => {
  const w = wb([['Tag', 'Type', 'Size (W x H)', 'Room'], ['DR-1', 'Single', '900 x 2100', 'Office'], ['DR-2', 'Double', '1800×2400', 'Hall']]);
  const p = analyseDoorSchedule(w)!;
  const r = doorRows(w, p);
  assert.deepEqual(r.map((x) => [x.tag, x.sw, x.sh, x.loc]), [['DR-1', 0.9, 2.1, 'Office'], ['DR-2', 1.8, 2.4, 'Hall']]);
  const w2 = wb([['Mark', 'Width', 'Height'], ['A', 900, 2100]]);
  const r2 = doorRows(w2, analyseDoorSchedule(w2)!);
  assert.deepEqual([r2[0].sw, r2[0].sh, r2[0].cw], [0.9, 2.1, undefined]);
});

test('no door schedule in the file', () => {
  assert.equal(analyseDoorSchedule(wb([['Item', 'Description', 'Qty', 'Rate'], ['1', 'Concrete', 10, 400]])), null);
});

test('sizes', () => {
  assert.equal(sizeOf(900), 0.9);
  assert.equal(sizeOf('2.1'), 2.1);
  assert.equal(sizeOf('2100mm'), 2.1);
  assert.equal(sizeOf('210 cm'), 2.1);
  assert.equal(sizeOf('n/a'), null);
  assert.deepEqual(pairOf('900W x 2100H'), [0.9, 2.1]);
  assert.deepEqual(pairOf('0.9 x 2.1 m'), [0.9, 2.1]);
});

test('"Clear opening" / "Structural opening" columns holding "900x2100": read as sizes', () => {
  const w = wb([['Tag', 'Description', 'Structural opening', 'Clear opening'], ['D1', 'Single', '1000x2200', '900x2100'], ['D2', 'Double', '1900 x 2250', '1800 x 2150']]);
  const r = doorRows(w, analyseDoorSchedule(w)!);
  assert.deepEqual(r.map((x) => [x.tag, x.sw, x.sh, x.cw, x.ch]), [['D1', 1, 2.2, 0.9, 2.1], ['D2', 1.9, 2.25, 1.8, 2.15]]);
});

test('a unit in the heading: "Width (cm)" 90 is 0.9 m; "(m)" 0.9 is 0.9 m; "(mm)" 900', async () => {
  const { unitOfHeading } = await import('../src/engine/qto/doorsched');
  assert.equal(unitOfHeading('Structural Width (cm)'), 'cm');
  assert.equal(unitOfHeading('Clear height in m'), 'm');
  assert.equal(unitOfHeading('W [mm]'), 'mm');
  assert.equal(unitOfHeading('Width'), '');
  const w = wb([['Tag', 'Width (cm)', 'Height (cm)', 'Clear W (m)', 'Clear H (m)'], ['D1', 90, 210, 0.8, 2.05], ['D2', '100', '220', '0.9', '2.1']]);
  const r = doorRows(w, analyseDoorSchedule(w)!);
  assert.deepEqual(r.map((x) => [x.tag, x.sw, x.sh, x.cw, x.ch]), [['D1', 0.9, 2.1, 0.8, 2.05], ['D2', 1, 2.2, 0.9, 2.1]]);
});

test('a heading unit that cannot be right for the number is ignored (2100 under "(m)", 0.9 under "(mm)")', () => {
  const w = wb([['Tag', 'Width (mm)', 'Height (m)'], ['D1', 0.9, 2100]]);
  const r = doorRows(w, analyseDoorSchedule(w)!);
  assert.deepEqual(r.map((x) => [x.sw, x.sh]), [[0.9, 2.1]]);
});
