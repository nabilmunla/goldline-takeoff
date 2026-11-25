// v0.16.2 the filled copy of the consultant's BOQ (Nabil, 5 Nov 2026): the take-off quantities written into a
// NEW copy of the consultant's own Excel file - two columns after the last used one ("Takeoff QS Qty", "Difference"),
// lines the consultant's BOQ doesn't have on a sheet of their own, everything else in the file left as it was.
// The fixture is written by openpyxl (formulas, a merged title, borders, number formats, a print area, a styled
// empty cell far right) - not by our own writer, so the reader / patcher meet a file they didn't make.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { readXlsx } from '../src/engine/xlsx';
import { analyseFile, planToOps } from '../src/engine/boqimport';
import { buildModel } from '../src/engine/boq';
import { Store } from '../src/engine/store';
import type { Op } from '../src/engine/types';
import { targetsFromBoq, targetsFromMirror, fillWorkbook, filledName, QS_HEAD, DIFF_HEAD, ADD_SHEET } from '../src/engine/boqfill';
import { mirrorOps } from '../src/engine/qto/bridge';
import { buildQtoModel } from '../src/engine/qto/model';

const FX = new URL('./fixtures/fill-consultant.xlsx', import.meta.url);
const FX_SHIFTED = new URL('./fixtures/fill-consultant-shifted.xlsx', import.meta.url);

let batch = 0;
function apply(st: Store, ops: Op[]) {
  // every batch its own change id (the store takes a change once)
  for (let i = 0; i < ops.length; i += 4000) st.apply({ s: String(++batch).padStart(13, '0') + '-' + String(i).padStart(6, '0') + '-t', w: 't', u: 'T', t: 0, o: ops.slice(i, i + 4000) });
  return st;
}

/** the consultant's file imported as the app does it, with take-off quantities on some lines */
function project() {
  const bytes = new Uint8Array(readFileSync(FX));
  const f = analyseFile('Consultant BOQ.xlsx', readXlsx(bytes));
  const built = planToOps([f], { withRates: false, groupByFile: true, by: 'test' }, { afterOrd: null, beforeOrd: null });
  const st = apply(new Store(), built.ops);
  const items = [...buildModel(st).byId.values()].filter((n) => n.type === 'item');
  const byRef = new Map(items.map((n) => [n.ref, n]));
  const ops: Op[] = [];
  // measured: 2.1, 2.2, 2.4, 3.1 - 2.3 / 2.5 / 3.2 not measured
  for (const [ref, q] of [['2.1', 118.75], ['2.2', 86.4], ['2.4', 605.5], ['3.1', 931.2]] as const) ops.push([byRef.get(ref)!.id, 'tq', q]);
  // an additional item from a QS under bill 2, and a line added by the estimator (measured)
  const bill2 = buildModel(st).roots.flatMap((r) => [r, ...r.children]).find((n) => n.type === 'group' && /CONCRETE/i.test(n.desc) && n.src.split(':').length === 3)!;
  ops.push(['qx_add1', 'type', 'item'], ['qx_add1', 'parent', bill2.id], ['qx_add1', 'ord', 'zz'], ['qx_add1', 'desc', 'Upstand beams C40'], ['qx_add1', 'unit', 'm3'],
    ['qx_add1', 'qa', 'a'], ['qx_add1', 'qby', 'Ali QS'], ['qx_add1', 'qloc', 'Roof'], ['qx_add1', 'tq', 12.5]);
  ops.push(['own1', 'type', 'item'], ['own1', 'parent', bill2.id], ['own1', 'ord', 'zz1'], ['own1', 'desc', 'Cube tests'], ['own1', 'unit', 'item'], ['own1', 'tq', 3]);
  apply(st, ops);
  return { bytes, st, model: buildModel(st) };
}

test('targets: every imported line with its sheet and row; the additional and own lines apart', () => {
  const { model } = project();
  const ts = targetsFromBoq(model);
  assert.equal(ts.length, 1);
  const t = ts[0];
  assert.equal(t.file.name, 'Consultant BOQ.xlsx');
  assert.equal(t.lines.length, 7);
  assert.deepEqual((({ id: _id, ...l }) => l)(t.lines.find((l) => l.ref === '2.4')!), { si: 0, row: 8, ref: '2.4', desc: 'Slabs C40 250mm thick', q0: 610, qs: 605.5 });
  assert.equal(t.lines.find((l) => l.ref === '3.2')!.qs, null);
  assert.deepEqual(t.adds.map((a) => [a.kind, a.desc, a.qs, a.loc, a.by]), [['qs', 'Upstand beams C40', 12.5, 'Roof', 'Ali QS'], ['app', 'Cube tests', 3, '', '']]);
  assert.match(t.adds[0].bill, /CONCRETE/i);
});

test('the filled copy: the two columns after the last used one, blanks where nothing was measured, the rest untouched', () => {
  const { bytes, model } = project();
  const t = targetsFromBoq(model)[0];
  const r = fillWorkbook(bytes, t);
  assert.equal(r.filled, 4);
  assert.equal(r.blank, 3);
  assert.deepEqual(r.skipped, []);
  assert.equal(r.added, 2);
  assert.equal(r.addSheet, ADD_SHEET);

  const a = readXlsx(bytes), b = readXlsx(r.bytes);
  // sheet 1 used A..F: the new columns are G and H
  const s1 = b.sheet('Bill 2 - Concrete');
  assert.equal(s1.rows.get(3)?.[7]?.v, QS_HEAD);
  assert.equal(s1.rows.get(3)?.[8]?.v, DIFF_HEAD);
  assert.equal(s1.rows.get(5)?.[7]?.v, 118.75);
  assert.equal(s1.rows.get(5)?.[8]?.v, -1.75);
  assert.equal(s1.rows.get(8)?.[7]?.v, 605.5);
  assert.equal(s1.rows.get(7)?.[7]?.v ?? null, null, '2.3 not measured: blank, not 0');
  assert.equal(s1.rows.get(9)?.[7]?.v ?? null, null, '2.5 not measured: blank');
  // sheet 2 has a styled empty cell in H: the new columns go after it (I and J), never on top of it
  const s2 = b.sheet('Bill 3 - Blockwork');
  assert.equal(s2.rows.get(1)?.[9]?.v, QS_HEAD);
  assert.equal(s2.rows.get(2)?.[9]?.v, 931.2);
  assert.ok(Math.abs((s2.rows.get(2)?.[10]?.v as number) - -18.8) < 1e-9);
  assert.equal(s2.rows.get(3)?.[9]?.v ?? null, null);
  // every cell of the consultant's file is still there, with the same value
  for (const sh of a.sheetNames) {
    const x = a.sheet(sh.name), y = b.sheet(sh.name);
    for (const [rn, cells] of x.rows) cells.forEach((c, cn) => { if (c) assert.deepEqual(y.rows.get(rn)?.[cn]?.v, c.v, `${sh.name} r${rn} c${cn}`); });
    assert.deepEqual(y.merges, x.merges);
  }
  // the difference is a live formula; the consultant's own formulas are untouched
  const z = unzipSync(r.bytes);
  const x1 = strFromU8(z['xl/worksheets/sheet1.xml']);
  assert.match(x1, /<c r="H5"[^>]*><f>G5-C5<\/f><v>-1\.75<\/v><\/c>/);
  assert.match(x1, /<f>C5\*E5<\/f>/);
  // the new cells look like the consultant's quantity cells (same style)
  const sOf = (xml: string, ref: string) => new RegExp(`<c r="${ref}"[^>]*\\bs="(\\d+)"`).exec(xml)?.[1];
  assert.equal(sOf(x1, 'G5'), sOf(x1, 'C5'));
  // the new sheet's entry declares its own relationships prefix (this workbook, from openpyxl, declares it per entry)
  assert.match(strFromU8(z['xl/workbook.xml']), /<sheet xmlns:r="[^"]+" name="Added lines"[^>]*r:id="rIdTakeoffFill\d+"\/>/);
  // the extra sheet
  assert.deepEqual(b.sheetNames.map((s) => s.name), ['Bill 2 - Concrete', 'Bill 3 - Blockwork', ADD_SHEET]);
  const ex = b.sheet(ADD_SHEET);
  assert.equal(ex.rows.get(4)?.[1]?.v, 'Additional - QS');
  assert.equal(ex.rows.get(4)?.[5]?.v, 'Upstand beams C40');
  assert.equal(ex.rows.get(4)?.[7]?.v, 12.5);
  assert.equal(ex.rows.get(5)?.[1]?.v, 'Added in Goldline Takeoff');
  // the parts nobody touched are byte for byte the consultant's
  const o = unzipSync(bytes);
  for (const k of Object.keys(o)) if (!/sheet1\.xml$|sheet2\.xml$|workbook\.xml$|workbook\.xml\.rels$|Content_Types/.test(k)) assert.deepEqual(z[k], o[k], k);
});

test('a file that changed since the import: no number lands in a wrong row', () => {
  const { model } = project();
  const t = targetsFromBoq(model)[0];
  const r = fillWorkbook(new Uint8Array(readFileSync(FX_SHIFTED)), t);
  // bill 2's rows moved down one: none of its lines is written; bill 3 is as it was
  assert.equal(r.filled, 1);
  assert.equal(r.skipped.filter((s) => s.sheet === 'Bill 2 - Concrete').length, 5);
  assert.match(r.skipped[0].why, /holds something else/);
  const s1 = readXlsx(r.bytes).sheet('Bill 2 - Concrete');
  for (const [, cells] of s1.rows) assert.equal(typeof cells[7]?.v === 'number', false);
});

test('the take-off side: the BOQ copy carries each line\'s source and the import records (nothing priced)', () => {
  const { st, model, bytes } = project();
  const qto = new Store();
  apply(qto, mirrorOps(model, qto));
  const m = buildQtoModel(qto, null);
  assert.equal(m.boqImports.size, 1);
  const row = [...m.boqById.values()].find((r) => r.ref === '2.2')!;
  assert.match(row.src, /^[^:]+:0:0:6$/);
  // this take-off measured 2.2 only
  const t = targetsFromMirror(m.boqById.values(), m.boqImports, new Map([[row.id, 84]]))[0];
  const r = fillWorkbook(bytes, t);
  assert.equal(r.filled, 1);
  assert.equal(readXlsx(r.bytes).sheet('Bill 2 - Concrete').rows.get(6)?.[7]?.v, 84);
  // nothing priced went into the copy
  for (const ent of qto.ents.values()) for (const f of ['rate', 'amount', 'cost']) assert.equal(ent.has(f), false);
  void st;
});

test('the name of the copy', () => {
  assert.equal(filledName('BOQ Vol 3.xlsx'), 'BOQ Vol 3 - Filled Copy.xlsx');
  assert.equal(filledName('Bills.XLSM'), 'Bills - Filled Copy.XLSM');
  assert.equal(filledName('Bills'), 'Bills - Filled Copy.xlsx');
});

test('filled copy: the two new columns get a readable width, the client’s own widths are left alone', async () => {
  const { widenCols } = await import('../src/engine/boqfill');
  const none = '<worksheet><sheetData><row r="1"/></sheetData></worksheet>';
  assert.match(widenCols(none, ['G', 'H'], 16), /<cols><col min="7" max="7" width="16" customWidth="1"\/><col min="8" max="8" width="16" customWidth="1"\/><\/cols><sheetData/);
  const own = '<worksheet><cols><col min="1" max="2" width="30" customWidth="1"/><col min="8" max="8" width="5" customWidth="1"/></cols><sheetData/></worksheet>';
  const out = widenCols(own, ['G', 'H'], 16);
  assert.match(out, /<col min="1" max="2" width="30" customWidth="1"\/><col min="7" max="7" width="16" customWidth="1"\/><col min="8" max="8" width="5" customWidth="1"\/>/, 'sorted; their H width kept');
  assert.equal(widenCols(out, ['G', 'H'], 16), out, 'twice: no change');
});
