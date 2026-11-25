// v0.16.2 - the bugs of the 0.16.2 QA hunt (DeepSeek, 5 Nov 2026), the engine parts:
// BUG-001 the consultant inserted a column: the Filled Copy found the row by its item ref and subtracted the column
//         the quantity USED to be in (description text: #VALUE! in Excel). The columns are read again from the
//         file's own header row; a quantity cell with text in it is never this line's quantity.
// BUG-003 a QS could change another person's take-off settings (height, waste, Times, code, name) and link / unlink it:
//         their measurements changed for everyone. A take-off's settings are part of the shapes in it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { readXlsx } from '../src/engine/xlsx';
import { analyseFile, planToOps } from '../src/engine/boqimport';
import { buildModel } from '../src/engine/boq';
import { Store } from '../src/engine/store';
import { targetsFromBoq, fillWorkbook } from '../src/engine/boqfill';
import { buildQtoModel } from '../src/engine/qto/model';
import { ownership } from '../src/engine/qto/owners';
import { scaleFromRatio } from '../src/engine/qto/geometry';
import type { Op, Batch } from '../src/engine/types';

let seq = 0;
const apply = (st: Store, o: Op[], u = 'T') => { seq++; st.apply({ s: String(seq).padStart(13, '0') + '-000000-' + u, w: 'w' + u, u, t: seq, o } as Batch); return st; };

test('BUG-001: a column inserted by the consultant - the difference is against the quantity where it is now', () => {
  const orig = new Uint8Array(readFileSync(new URL('./fixtures/fill-consultant.xlsx', import.meta.url)));
  const st = apply(new Store(), planToOps([analyseFile('Consultant BOQ.xlsx', readXlsx(orig))], { withRates: false, groupByFile: true, by: 'test' }, { afterOrd: null, beforeOrd: null }).ops);
  const l21 = [...buildModel(st).byId.values()].find((n) => n.ref === '2.1')!;
  apply(st, [[l21.id, 'tq', 118.75]]);
  const t = targetsFromBoq(buildModel(st))[0];
  const shifted = new Uint8Array(readFileSync(new URL('./fixtures/fill-consultant-colshift.xlsx', import.meta.url)));
  const r = fillWorkbook(shifted, t);
  assert.equal(r.filled, 1, JSON.stringify(r.skipped));
  const x1 = strFromU8(unzipSync(r.bytes)['xl/worksheets/sheet1.xml']);
  // the sheet now runs A..G: the new columns are H and I; Qty is in D
  assert.match(x1, /<c r="H5"[^>]*><v>118\.75<\/v><\/c><c r="I5"[^>]*><f>H5-D5<\/f><v>-1\.75<\/v><\/c>/);
  assert.equal(readXlsx(r.bytes).sheet('Bill 2 - Concrete').rows.get(3)?.[8]?.v, 'Measured Qty');
});

test('BUG-001: a row whose quantity cell holds text is left out, even with the right item ref', () => {
  const orig = new Uint8Array(readFileSync(new URL('./fixtures/fill-consultant.xlsx', import.meta.url)));
  const st = apply(new Store(), planToOps([analyseFile('Consultant BOQ.xlsx', readXlsx(orig))], { withRates: false, groupByFile: true, by: 'test' }, { afterOrd: null, beforeOrd: null }).ops);
  const l21 = [...buildModel(st).byId.values()].find((n) => n.ref === '2.1')!;
  apply(st, [[l21.id, 'tq', 118.75]]);
  const t = targetsFromBoq(buildModel(st))[0];
  // a column inserted AND no header row to find the columns again: the import's quantity column (C) now holds the
  // description - the item ref (A) still matches, but that row is left out, not given a difference against text
  const r = fillWorkbook(new Uint8Array(readFileSync(new URL('./fixtures/fill-consultant-colshift-nohead.xlsx', import.meta.url))), t);
  assert.equal(r.filled, 0);
  assert.ok(r.skipped.some((s) => s.ref === '2.1' && /holds something else/.test(s.why)));
});

// ---- BUG-003
const S = scaleFromRatio(100);
const P = (x: number) => x / S;
const line = (id: string, ti: string, by: string): Op[] => [[id, 'ti', ti], [id, 'dwg', 'd1'], [id, 'pg', 0], [id, 'k', 'line'], [id, 'p', JSON.stringify([0, 0, P(7), 0])], [id, 'by', by]];
function wallsOf() {
  const st = apply(new Store(), [['pg:d1.0', 'sc', S],
    ['ti:a', 'kind', 'line'], ['ti:a', 'name', 'Wall 1'], ['ti:a', 'ord', 'a0'], ['ti:a', 'owner', 'qs.a'], ['ti:a', 'h', 3], ...line('sh:a', 'ti:a', 'qs.a'),
    ['ti:b', 'kind', 'line'], ['ti:b', 'name', 'Wall 2'], ['ti:b', 'ord', 'a1'], ['ti:b', 'owner', 'qs.b'], ['ti:b', 'h', 3], ...line('sh:b', 'ti:b', 'qs.b'),
    ['ti:e', 'kind', 'line'], ['ti:e', 'name', 'Wall 3'], ['ti:e', 'ord', 'a2'], ['ti:e', 'owner', 'qs.a'],
    ['lk:a', 'ti', 'ti:a'], ['lk:a', 'to', 'b:x1']]);
  return buildQtoModel(st, null);
}

test('BUG-003: a QS can\'t change the settings of a take-off with someone else\'s measurements in it', () => {
  const m = wallsOf();
  for (const f of ['h', 'waste', 'x', 'fcode', 'name', 'ded', 'owner']) {
    const o = ownership(m, [['ti:a', f, 4]], 'qs.b', false, { boq: false });
    assert.deepEqual(o.locked.map((s) => s.id), ['sh:a'], f);
  }
  // his own take-off; one with nothing measured yet; where it sits in the list and its colour: free
  assert.equal(ownership(m, [['ti:b', 'h', 4]], 'qs.b', false).locked.length, 0);
  assert.equal(ownership(m, [['ti:e', 'h', 4]], 'qs.b', false).locked.length, 0);
  for (const f of ['ord', 'par', 'color']) assert.equal(ownership(m, [['ti:a', f, 'x']], 'qs.b', false).locked.length, 0, f);
});

test('BUG-003: an estimator changes them only with "Edit other people\'s shapes" on, and becomes a joint owner', () => {
  const m = wallsOf();
  assert.equal(ownership(m, [['ti:a', 'h', 4]], 'est', false, { boq: true }).locked.length, 1);
  const o = ownership(m, [['ti:a', 'h', 4]], 'est', true, { boq: true });
  assert.equal(o.locked.length, 0);
  assert.deepEqual(o.ops, [['sh:a', 'co:est', true]]);
});

test('BUG-003: BOQ links - a QS links / unlinks only his own measurements; an estimator links any (he keeps the BOQ)', () => {
  const m = wallsOf();
  // unlink A's link, link A's take-off: a QS (B) - refused; his own - fine
  assert.equal(ownership(m, [['lk:a', 'del', true]], 'qs.b', false, { boq: false }).locked.length, 1);
  assert.equal(ownership(m, [['lk:n', 'ti', 'ti:a'], ['lk:n', 'to', 'b:x2']], 'qs.b', false, { boq: false }).locked.length, 1);
  assert.equal(ownership(m, [['lk:n', 'ti', 'ti:b'], ['lk:n', 'to', 'b:x2']], 'qs.b', false, { boq: false }).locked.length, 0);
  // an estimator: links any take-off, with no joint mark (a link is not a change of the shapes)
  const e = ownership(m, [['lk:a', 'del', true], ['lk:n', 'ti', 'ti:a'], ['lk:n', 'to', 'b:x2']], 'est', false, { boq: true });
  assert.equal(e.locked.length, 0);
  assert.deepEqual(e.ops, []);
});

// ---- v0.16.3 fresh-eyes review: the other ways one person's quantities could be changed by another
const rect = (x0: number, y0: number, w: number, h: number) => JSON.stringify([P(x0), P(y0), P(x0 + w), P(y0), P(x0 + w), P(y0 + h), P(x0), P(y0 + h)]);
function sheetOf() {
  const st = apply(new Store(), [['pg:d1.0', 'sc', S], ['ds:d1', 'tag', 'D1'], ['ds:d1', 'sw', 0.9], ['ds:d1', 'sh', 2.1],
    ['ti:a', 'kind', 'line'], ['ti:a', 'name', 'Wall 1'], ['ti:a', 'ord', 'a0'], ['ti:a', 'owner', 'qs.a'], ['ti:a', 'h', 3], ...line('sh:a', 'ti:a', 'qs.a'),
    // A's room with a floor code, an additional floor finish part of it, and a door counted by A
    ['ti:r', 'kind', 'room'], ['ti:r', 'name', 'Bedroom'], ['ti:r', 'ord', 'a1'], ['ti:r', 'owner', 'qs.a'], ['ti:r', 'fc', 'FL-02'],
    ['sh:r', 'ti', 'ti:r'], ['sh:r', 'dwg', 'd1'], ['sh:r', 'pg', 0], ['sh:r', 'k', 'poly'], ['sh:r', 'p', rect(0, 0, 5, 4)], ['sh:r', 'by', 'qs.a'],
    ['ti:p', 'kind', 'area'], ['ti:p', 'name', 'Rug'], ['ti:p', 'ord', 'a2'], ['ti:p', 'owner', 'qs.a'], ['ti:p', 'rm', 'ti:r'], ['ti:p', 'rk', 'add'], ['ti:p', 'rcat', 'floor'],
    ['ti:dc', 'kind', 'count'], ['ti:dc', 'name', 'Doors (not on walls)'], ['ti:dc', 'ord', 'a3'], ['ti:dc', 'dc', true], ['ti:dc', 'owner', 'qs.a'],
    ['sh:dc', 'ti', 'ti:dc'], ['sh:dc', 'dwg', 'd1'], ['sh:dc', 'pg', 0], ['sh:dc', 'k', 'pt'], ['sh:dc', 'p', JSON.stringify([P(9), P(9)])], ['sh:dc', 'door', 'ds:d1'], ['sh:dc', 'by', 'qs.a'],
    ['fl:1', 'code', 'FL-02'], ['fl:1', 'unit', 'm²'], ['fl:1', 'g', '[]'], ['fl:1', 'to', 'b:x1']]);
  return buildQtoModel(st, null);
}
const lockedFor = (m: ReturnType<typeof sheetOf>, ops: Op[], who: string, opts: { edit?: boolean; boq?: boolean } = {}) => ownership(m, ops, who, !!opts.edit, { boq: !!opts.boq }).locked.map((s) => s.id).sort();

test('v0.16.3: a sheet re-scaled, a viewport put on it, the drawing removed - other people\'s shapes on it follow the rule', () => {
  const m = sheetOf();
  assert.ok(lockedFor(m, [['pg:d1.0', 'sc', S * 2]], 'qs.b').includes('sh:a'));
  assert.ok(lockedFor(m, [['sr:v1', 'dwg', 'd1'], ['sr:v1', 'pg', 0], ['sr:v1', 'r', '[0,0,1,1]'], ['sr:v1', 'sc', S * 2]], 'qs.b').includes('sh:a'));
  assert.ok(lockedFor(m, [['d1', 'del', true]], 'qs.b').length === 0, '(a drawing id without the dwg: prefix is not a drawing)');
  // an estimator: the toggle, as for the shapes themselves
  assert.ok(lockedFor(m, [['pg:d1.0', 'sc', S * 2]], 'est', { boq: true }).includes('sh:a'));
  assert.deepEqual(lockedFor(m, [['pg:d1.0', 'sc', S * 2]], 'est', { boq: true, edit: true }), []);
  // the one who measured everything on it: free
  assert.deepEqual(lockedFor(m, [['pg:d1.0', 'sc', S * 2]], 'qs.a'), []);
});

test('v0.16.3: a room\'s name / description / heading; a shape drawn into its own finish - the room\'s owner decides', () => {
  const m = sheetOf();
  for (const f of ['name', 'desc', 'par']) assert.deepEqual(lockedFor(m, [['ti:r', f, 'X']], 'qs.b'), ['sh:r'], f);
  assert.deepEqual(lockedFor(m, [['sh:new', 'ti', 'ti:p'], ['sh:new', 'dwg', 'd1'], ['sh:new', 'pg', 0], ['sh:new', 'k', 'poly'], ['sh:new', 'p', rect(1, 1, 1, 1)]], 'qs.b'), ['sh:r']);
  assert.deepEqual(lockedFor(m, [['ti:r', 'name', 'X']], 'qs.a'), []);
});

test('v0.16.3: the door schedule and the Finishes Summary links - a QS changes them only where all he touches is his; an estimator keeps them', () => {
  const m = sheetOf();
  // D1's size: A's counted door
  assert.deepEqual(lockedFor(m, [['ds:d1', 'sw', 1.0]], 'qs.b'), ['sh:dc']);
  assert.deepEqual(lockedFor(m, [['ds:d1', 'sw', 1.0]], 'est', { boq: true }), []);
  // the FL-02 link covering A's bedroom: removed, or made again
  assert.deepEqual(lockedFor(m, [['fl:1', 'del', true]], 'qs.b'), ['sh:r']);
  assert.deepEqual(lockedFor(m, [['fl:2', 'code', 'FL-02'], ['fl:2', 'unit', 'm²'], ['fl:2', 'g', '[]'], ['fl:2', 'to', 'b:x2']], 'qs.b'), ['sh:r']);
  assert.deepEqual(lockedFor(m, [['fl:1', 'del', true]], 'est', { boq: true }), []);
  assert.deepEqual(lockedFor(m, [['fl:1', 'del', true]], 'qs.a'), []);
});

test('v0.16.3: a drawing removed (dwg: ids, as the app makes them) with other people\'s shapes on it', () => {
  const st = apply(new Store(), [['pg:dwg:k1.0', 'sc', S], ['dwg:k1', 'path', 'X:/a.pdf'], ['dwg:k1', 'name', 'a.pdf'],
    ['ti:a', 'kind', 'line'], ['ti:a', 'name', 'Wall 1'], ['ti:a', 'ord', 'a0'], ['ti:a', 'owner', 'qs.a'],
    ['sh:a', 'ti', 'ti:a'], ['sh:a', 'dwg', 'dwg:k1'], ['sh:a', 'pg', 0], ['sh:a', 'k', 'line'], ['sh:a', 'p', JSON.stringify([0, 0, P(7), 0])], ['sh:a', 'by', 'qs.a']]);
  const m = buildQtoModel(st, null);
  assert.deepEqual(ownership(m, [['dwg:k1', 'del', true]], 'qs.b', false).locked.map((s) => s.id), ['sh:a']);
  assert.deepEqual(ownership(m, [['pg:dwg:k1.0', 'sc', S / 2]], 'qs.b', false).locked.map((s) => s.id), ['sh:a']);
  assert.equal(ownership(m, [['dwg:k1', 'del', true]], 'qs.a', false).locked.length, 0);
});

test('v0.16.3: a workbook written with prefixed tags (another program) - refused with the way round, never half filled', async () => {
  const { zipSync, strToU8 } = await import('fflate');
  const orig = new Uint8Array(readFileSync(new URL('./fixtures/fill-consultant.xlsx', import.meta.url)));
  const st = apply(new Store(), planToOps([analyseFile('Consultant BOQ.xlsx', readXlsx(orig))], { withRates: false, groupByFile: true, by: 'test' }, { afterOrd: null, beforeOrd: null }).ops);
  const l21 = [...buildModel(st).byId.values()].find((n) => n.ref === '2.1')!;
  apply(st, [[l21.id, 'tq', 118.75]]);
  const t = targetsFromBoq(buildModel(st))[0];
  const z = unzipSync(orig);
  const prefix = (x: string) => x.replace(/<(\/?)(worksheet|sheetData|row|c|v|f|sheets|sheet|workbook)\b/g, '<$1x:$2').replace(/<x:(worksheet|workbook)\b/, '<x:$1 xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"');
  z['xl/worksheets/sheet1.xml'] = strToU8(prefix(strFromU8(z['xl/worksheets/sheet1.xml'])));
  const odd = zipSync(z);
  assert.ok(readXlsx(odd).sheet('Bill 2 - Concrete').rows.get(5), 'the reader takes it (the importer did)');
  assert.throws(() => fillWorkbook(odd, t), /saved by another program.*Save As \.xlsx/);
});

test('v0.16.3: take-off side - the BOQ quantity changed by the estimator: lines are still found by the consultant\'s quantity', async () => {
  const { mirrorOps } = await import('../src/engine/qto/bridge');
  const { targetsFromMirror } = await import('../src/engine/boqfill');
  const orig = new Uint8Array(readFileSync(new URL('./fixtures/fill-consultant.xlsx', import.meta.url)));
  const st = apply(new Store(), planToOps([analyseFile('Consultant BOQ.xlsx', readXlsx(orig))], { withRates: false, groupByFile: true, by: 'test' }, { afterOrd: null, beforeOrd: null }).ops);
  // the estimator raises every quantity by 10 %
  apply(st, [...buildModel(st).byId.values()].filter((n) => n.type === 'item' && n.qty !== null).map((n) => [n.id, 'qty', n.qty! * 1.1] as Op));
  const qto = apply(new Store(), mirrorOps(buildModel(st), new Store()));
  const m = buildQtoModel(qto, null);
  const totals = new Map([...m.boqById.values()].filter((r) => r.bt === 'item' && r.qty !== null).map((r) => [r.id, 1]));
  const t = targetsFromMirror(m.boqById.values(), m.boqImports, totals)[0];
  for (const l of t.lines) l.ref = ''; // no item refs to go by: the quantity alone finds the row
  const r = fillWorkbook(orig, t);
  assert.equal(r.filled, 6, JSON.stringify(r.skipped));
});
