// Deep ritual 0.21 - the sweep findings that survive in the take-off-only app (S4: xlsx writer).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { writeXlsx } from '../src/engine/xlsxwrite';
import { readXlsx } from '../src/engine/xlsx';

test('S4: a sheet name with an apostrophe makes a valid filter range (quote doubled)', () => {
  const bytes = writeXlsx([{ name: "Client's Works", header: 1, rows: [['A', 'B'], [1, 2], [3, 4]] } as any]);
  const wbx = strFromU8(unzipSync(bytes)['xl/workbook.xml']);
  assert.match(wbx, /'Client''s Works'!\$A\$1:\$B\$3/);
  assert.equal(readXlsx(bytes).sheetNames[0].name, "Client's Works");
});
