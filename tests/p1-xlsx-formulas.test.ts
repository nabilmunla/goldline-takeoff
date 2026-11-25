// P1 (PLAN-PRELIMS): readXlsx(bytes, { formulas: true }) keeps cell formulas, shared formulas expanded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { readXlsx, type XCell } from '../src/engine/xlsx';

const DIR = process.env.PRELIMS_DIR || '';
const R10 = `${DIR}/Prelims R10- Revised as per Org. Chart.xlsm`;
const skip = existsSync(R10) ? false : `the Prelims samples are not in ${DIR} (set PRELIMS_DIR): real-file tests skipped`;

function book(sheetData: string): Uint8Array {
  const wb = '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>';
  const sh = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>`;
  return zipSync({ 'xl/workbook.xml': strToU8(wb), 'xl/_rels/workbook.xml.rels': strToU8(rels), 'xl/worksheets/sheet1.xml': strToU8(sh) });
}
const cell = (wb: ReturnType<typeof readXlsx>, name: string, r: number, c: number): XCell | undefined => wb.sheet(name).rows.get(r)?.[c];

const rows: string[] = [];
rows.push('<row r="9"><c r="C9"><v>2</v></c><c r="D9"><v>3</v></c><c r="E9"><f t="shared" ref="E9:E15" si="0">C9*D9</f><v>6</v></c><c r="F9"><f>$C$5+\'Staff &amp; Summery\'!$C$2+\'Staff &amp; Summery\'!C2+"A1"</f><v>0</v></c></row>');
for (let r = 10; r <= 15; r++) rows.push(`<row r="${r}"><c r="E${r}"><f t="shared" si="0"/><v>${r}</v></c></row>`);
rows.push('<row r="20"><c r="A20"><f t="shared" ref="A20:B21" si="1">$C$5+\'Staff &amp; Summery\'!C2+SUM(D1:D3)+LOG10(A1)&amp;"A1 B2"</f><v>1</v></c></row>');
rows.push('<row r="21"><c r="A21"><f t="shared" si="1"/><v>1</v></c><c r="B21"><f t="shared" si="1"/><v>1</v></c></row>');
const bytes = book(rows.join(''));

test('P1: shared formula followers get shifted references', () => {
  const wb = readXlsx(bytes, { formulas: true });
  assert.equal(cell(wb, 'S1', 9, 5)?.f, 'C9*D9');
  for (let r = 10; r <= 15; r++) assert.equal(cell(wb, 'S1', r, 5)?.f, `C${r}*D${r}`);
  assert.equal(cell(wb, 'S1', 12, 5)?.v, 12); // cached value untouched
});

test('P1: $ parts, quoted sheet names and string literals are respected', () => {
  const wb = readXlsx(bytes, { formulas: true });
  assert.equal(cell(wb, 'S1', 9, 6)?.f, `$C$5+'Staff & Summery'!$C$2+'Staff & Summery'!C2+"A1"`);
  assert.equal(cell(wb, 'S1', 20, 1)?.f, `$C$5+'Staff & Summery'!C2+SUM(D1:D3)+LOG10(A1)&"A1 B2"`);
  // A21: one row down; B21: one row down and one column right
  assert.equal(cell(wb, 'S1', 21, 1)?.f, `$C$5+'Staff & Summery'!C3+SUM(D2:D4)+LOG10(A2)&"A1 B2"`);
  assert.equal(cell(wb, 'S1', 21, 2)?.f, `$C$5+'Staff & Summery'!D3+SUM(E2:E4)+LOG10(B2)&"A1 B2"`);
});

test('P1: the default call keeps no formula text', () => {
  const wb = readXlsx(bytes);
  assert.equal(cell(wb, 'S1', 10, 5)?.f, undefined);
  assert.equal(cell(wb, 'S1', 10, 5)?.v, 10);
  const a = readXlsx(bytes).sheet('S1'), b = readXlsx(bytes, { formulas: true }).sheet('S1');
  assert.equal(a.maxRow, b.maxRow);
  assert.equal(a.maxCol, b.maxCol);
});

test('P1: real R10 formulas', { skip }, () => {
  const wb = readXlsx(new Uint8Array(readFileSync(R10)), { formulas: true });
  const nm = (p: string) => wb.sheetNames.find((s) => s.name.startsWith(p))!.name;
  assert.equal(cell(wb, nm('Running cost'), 10, 5)?.f, 'C10*D10');
  assert.equal(cell(wb, nm('Machinery'), 13, 4)?.f, 'D10');
});
