// Import: sheets matched to their earlier revision when the sheet number alone finds nothing (v0.15:
// Rev Radar's drawing-number rules - status codes, leading zeros, number alone, a prefix added)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planImport } from '../src/engine/qto/revisions';
import { drawingNo, drawingNoBare, looseNo, normName } from '../src/engine/qto/pairkeys';

const f = (p: string, i = 0) => ({ path: p, rel: p.split('\\').pop()!, size: 1, mtime: i });
const sheetOf = (id: string, name: string, sheet = '') => ({ id, path: 'S:\\old\\' + name, name, sheet, unc: '' });
const plan = (olds: ReturnType<typeof sheetOf>[], files: string[]) =>
  planImport(files.map((n, i) => f('X:\\new\\' + n, i)), { drawings: olds, revisions: new Map() } as any).map((r) => [r.name, r.action, r.target]);

test('sheet numbers: names the old rule misread or could not read', async () => {
  const { sheetFromFile, planImport: pi } = await import('../src/engine/qto/revisions');
  assert.deepEqual(sheetFromFile('F111.1-AE7-DWG-AR-GA-L04.pdf'), { sheet: 'GA-L04', title: '' });
  assert.deepEqual(sheetFromFile('A-101_C02.pdf'), { sheet: 'A-101', title: '' });
  assert.deepEqual(sheetFromFile('AR-1001 Ground floor.pdf'), { sheet: 'AR-1001', title: 'Ground floor' });
  assert.deepEqual(sheetFromFile('PRJ-AR-GA-L01_Rev B.pdf'), { sheet: 'GA-L01', title: '' });
  assert.deepEqual(sheetFromFile('100101.pdf'), { sheet: '100101', title: '' });
  // unchanged where it was right
  assert.deepEqual(sheetFromFile('P101-ABC-DWG-AR-11030-GA L01 Tower A_Rev C.pdf'), { sheet: 'AR-11030', title: 'GA L01 Tower A' });
  // GA L01 / L02 / L03 of one issue are three sheets (were all "F111.1-AE7": two left out as earlier revisions)
  const rows = pi(['L01', 'L02', 'L03'].map((l, i) => ({ path: 'R:\\H\\F111.1-AE7-DWG-AR-GA-' + l + '.pdf', rel: '', size: 1, mtime: i })), { drawings: [], revisions: new Map() } as any);
  assert.deepEqual(rows.map((r) => [r.sheet, r.action]), [['GA-L01', 'new'], ['GA-L02', 'new'], ['GA-L03', 'new']]);
});

test('the drawing number as Rev Radar reads it', () => {
  assert.equal(drawingNo('P101-ABC-DWG-AR-10140-GA L04.pdf'), 'P101-ABC-DWG-AR-10140');
  assert.equal(drawingNo('A101 (Rev 2).pdf'), 'A101');
  assert.equal(drawingNoBare('AR-L01-P02'), 'AR-L01');
  assert.equal(looseNo('A-101_C02.pdf'), 'A-101');
  assert.equal(looseNo('GA-L01 Plan.pdf'), looseNo('GA-L1 Plan.pdf'));
  assert.equal(drawingNo('Ground Floor Part 01.pdf'), '');
  assert.notEqual(normName('PRJ-AR-GA-R1.pdf'), normName('PRJ-AR-GA-R2.pdf'));
});

test('a status code in the number (A-101_C02 -> A-101_C03): the next revision of the same sheet', () => {
  assert.deepEqual(plan([sheetOf('dwg:a', 'A-101_C02.pdf')], ['A-101_C03.pdf', 'A-102_C01.pdf']), [['A-101_C03.pdf', 'rev', 'dwg:a'], ['A-102_C01.pdf', 'new', null]]);
});

test('leading zeros dropped in the new issue (GA-L01 -> GA-L1)', () => {
  assert.deepEqual(plan([sheetOf('dwg:a', 'GA-L01 Plan.pdf')], ['GA-L1 Plan.pdf']), [['GA-L1 Plan.pdf', 'rev', 'dwg:a']]);
});

test('the sheet number alone against the full drawing number, both ways', () => {
  assert.deepEqual(plan([sheetOf('dwg:a', 'F111.1-AE7-DWG-AR-100101.pdf')], ['100101.pdf']), [['100101.pdf', 'rev', 'dwg:a']]);
  assert.deepEqual(plan([sheetOf('dwg:a', '100101_C02.pdf')], ['F111.1-AE7-DWG-AR-100101.pdf']), [['F111.1-AE7-DWG-AR-100101.pdf', 'rev', 'dwg:a']]);
});

test('a project prefix added in front of the number', () => {
  assert.deepEqual(plan([sheetOf('dwg:a', 'GA-L04.pdf')], ['F111.1-AE7-DWG-AR-GA-L04.pdf']), [['F111.1-AE7-DWG-AR-GA-L04.pdf', 'rev', 'dwg:a']]);
});

test('anything doubtful stays a new sheet', () => {
  // two full numbers that merely end alike are different drawings
  assert.deepEqual(plan([sheetOf('dwg:a', 'PRJ-AR-GA-01001.pdf')], ['PRJ-ST-GA-01001.pdf']), [['PRJ-ST-GA-01001.pdf', 'new', null]]);
  // the number alone, but two drawings in the project end with it (AR- and ID-)
  assert.deepEqual(plan([sheetOf('dwg:a', 'F1-AR-100101.pdf'), sheetOf('dwg:b', 'F1-ID-100101.pdf')], ['100101.pdf']), [['100101.pdf', 'new', null]]);
  // two files of this issue for the same sheet: the later one updates it, the other is left out
  assert.deepEqual(plan([sheetOf('dwg:a', 'A-101_C02.pdf')], ['A-101_C03.pdf', 'A-101_C04 copy.pdf']).map((r) => r[1]), ['skip', 'rev']);
  // a sheet already updated by its sheet number is not taken again
  assert.deepEqual(plan([sheetOf('dwg:a', 'P101-ABC-DWG-AR-11030-GA L01.pdf', 'AR-11030')], ['P101-ABC-DWG-AR-11030-GA L01_Rev C.pdf', '11030.pdf']), [['P101-ABC-DWG-AR-11030-GA L01_Rev C.pdf', 'rev', 'dwg:a'], ['11030.pdf', 'new', null]]);
});
