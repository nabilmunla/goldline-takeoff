// v0.12.3: decimals of the measured numbers (m 3, mm 0, m² 2, m³ 3 by default; changeable while
// measuring and after), the same figure on the sheet as in the totals, and the export following both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { Store } from '../src/engine/store';
import type { Op, Batch } from '../src/engine/types';
import { buildQtoModel, shapeQtyAt, type Shape } from '../src/engine/qto/model';
import { scaleFromRatio, flatten, bbox, toFlat, type Pt } from '../src/engine/qto/geometry';
import { exportQto } from '../src/engine/qto/export';
import { nStyle } from '../src/engine/xlsxwrite';
import { FMT_DEFAULTS, fixed, q, m1, m2, m3, mm, decimalsFor, setQtoFmt, qtoFmt } from '../src/ui/takeoff/numfmt';
import { typedLabel } from '../src/ui/takeoff/SheetCanvas';

const J = (v: unknown) => JSON.stringify(v);
let k = 0;
const mk = (o: Op[]): Batch => ({ s: String(++k).padStart(12, '0') + '~pc1', w: 'pc1', u: 'pc1', t: 0, o, a: 'pc1' });
const storeOf = (o: Op[]) => { const s = new Store(); s.apply(mk(o)); return s; };
const S100 = scaleFromRatio(100), S50 = scaleFromRatio(50), S20 = scaleFromRatio(20);

test('defaults: metres 3 decimals, millimetres none, m² 2, m³ 3, counts whole', () => {
  setQtoFmt({ ...FMT_DEFAULTS });
  assert.deepEqual(qtoFmt(), { dm: 3, dmm: 0, da: 2, dv: 3, size: 1, lw: 1, fill: 1, labels: 'hover', tags: 'sel', dim: 0.75 });
  assert.equal(m1(3.5), '3.500 m');
  assert.equal(mm(3.5), '3,500 mm');
  assert.equal(mm(3.5004), '3,500 mm');
  assert.equal(m2(12.3456), '12.35 m²');
  assert.equal(m3(1.12345), '1.123 m³');
  assert.equal(q(12, 'cnt'), '12');
  assert.equal(q(1234.5678, 'len'), '1,234.568');
  assert.equal(q(7.25, 'perim'), '7.250');
  // units as the BOQ / the totals write them
  assert.equal(decimalsFor('m'), 3);
  assert.equal(decimalsFor('m²'), 2);
  assert.equal(decimalsFor('m2'), 2);
  assert.equal(decimalsFor('m³'), 3);
  assert.equal(decimalsFor('nr'), 0);
});

test('shown as Excel shows it: 15 significant digits first, no "-0.000", a count with a fraction is not rounded away', () => {
  assert.equal(fixed(970.1249999999999, 2), '970.13');
  assert.equal(fixed(12.345, 2), '12.35');
  assert.equal(fixed(1.0005, 3), '1.001');
  assert.equal(fixed(-0.0001, 3), '0.000');
  assert.equal(fixed(-0.005, 2), '-0.01');
  assert.equal(fixed(0.1 + 0.2, 3), '0.300');
  assert.equal(fixed(NaN, 2), '—');
  assert.equal(q(2.5, 'nr'), '2.50', 'half a door per link factor stays visible');
  assert.equal(q(3, 'nr'), '3');
});

test('changing the decimals changes every number at once (and only what is shown)', () => {
  setQtoFmt({ ...FMT_DEFAULTS });
  const L = 3.14159;
  assert.equal(q(L, 'len'), '3.142');
  setQtoFmt({ dm: 1 });
  assert.equal(q(L, 'len'), '3.1');
  assert.equal(m1(L), '3.1 m');
  setQtoFmt({ dm: 4, da: 0, dv: 1, dmm: 2 });
  assert.equal(q(L, 'len'), '3.1416');
  assert.equal(m2(L), '3 m²');
  assert.equal(m3(L), '3.1 m³');
  assert.equal(mm(L), '3,141.59 mm');
  setQtoFmt({ dm: 0 });
  assert.equal(m1(2.5), '3 m');
  setQtoFmt({ ...FMT_DEFAULTS });
  assert.equal(q(L, 'len'), '3.142');
});

test('a typed length echoes in metres and millimetres, never rounded away', () => {
  setQtoFmt({ ...FMT_DEFAULTS });
  assert.equal(typedLabel('4200'), '4.200 m (4,200 mm)');
  assert.equal(typedLabel('4.2'), '4.200 m (4,200 mm)');
  assert.equal(typedLabel('4212.5mm'), '4.2125 m (4,212.5 mm)');
  // a point in it and no unit is metres (only a whole number of 100+ is millimetres): the echo makes it plain
  assert.equal(typedLabel('4212.5'), '4,212.500 m (4,212,500 mm)');
  assert.equal(typedLabel('4.21257'), '4.21257 m (4,212.57 mm)');
  setQtoFmt({ dm: 2 });
  assert.equal(typedLabel('4200mm'), '4.20 m (4,200 mm)');
  assert.equal(typedLabel('4215'), '4.215 m (4,215 mm)');
  assert.equal(typedLabel('abc'), 'abc');
  setQtoFmt({ ...FMT_DEFAULTS });
});

/** a path measured the way the sheet's live readout and labels measure it (TakeoffView.measurePath) */
function measurePath(m: ReturnType<typeof buildQtoModel>, dwg: string, pg: number, pts: Pt[], b: number[], closed: boolean) {
  const flat = flatten(pts, b, closed);
  const s: Shape = { id: '', ti: '', dwg, pg, k: closed ? 'poly' : 'line', pts, b, flat, holes: [], m: 1, box: bbox(flat), by: '', rv: '' };
  const r = shapeQtyAt(m, s, null);
  return r.scaled ? { len: closed ? r.perim : r.len, area: r.area } : null;
}

test('the number on the sheet is the number in the totals: across a viewport edge, and segment by segment', () => {
  // sheet at 1:100 with a 1:20 detail viewport from x = 500 to 900
  const st = storeOf([
    ['pg:d1.0', 'sc', S100],
    ['sr:r1', 'dwg', 'd1'], ['sr:r1', 'pg', 0], ['sr:r1', 'r', J([500, 0, 900, 400])], ['sr:r1', 'sc', S20], ['sr:r1', 'scl', '1:20'],
    ['ti:w', 'kind', 'line'], ['ti:w', 'name', 'Wall'],
    // starts outside (1:100) and ends inside the viewport (1:20)
    ['sh:1', 'ti', 'ti:w'], ['sh:1', 'dwg', 'd1'], ['sh:1', 'pg', 0], ['sh:1', 'k', 'line'], ['sh:1', 'p', J([300, 100, 700, 100, 700, 300])],
  ]);
  const m = buildQtoModel(st, null);
  const total = m.qty.get('ti:w')!.len;
  const want = 200 * S100 + 200 * S20 + 200 * S20;
  assert.ok(Math.abs(total - want) < 1e-9, `${total} != ${want}`);
  const s = m.shapes[0];
  // what the old label did: the whole length at its first point's scale (1:100) - 2.5x too long
  const firstPointOnly = (400 + 200) * S100;
  assert.ok(Math.abs(firstPointOnly - total) > 5, 'the old way was visibly wrong here');
  const lab = shapeQtyAt(m, s, null);
  assert.equal(m1(lab.len), m1(total));
  assert.equal(lab.mixed, true);
  // segment labels add up to the total
  const segs = [0, 1].map((i) => measurePath(m, 'd1', 0, [s.pts[i], s.pts[i + 1]], [0], false)!.len);
  assert.ok(Math.abs(segs[0] + segs[1] - total) < 1e-9);
  // the live readout while drawing the same path gives the same figure
  assert.equal(m1(measurePath(m, 'd1', 0, s.pts, [0, 0], false)!.len), m1(total));
  // an area is taken at the scale of its middle (inside the viewport here, though it starts outside)
  const poly: Pt[] = [[480, 50], [880, 50], [880, 250], [480, 250]];
  const a = measurePath(m, 'd1', 0, poly, [0, 0, 0, 0], true)!;
  assert.ok(Math.abs(a.area - 400 * 200 * S20 * S20) < 1e-9);
  // no scale for part of it: no number (rather than a wrong one)
  const st2 = storeOf([['sr:r1', 'dwg', 'd2'], ['sr:r1', 'pg', 0], ['sr:r1', 'r', J([500, 0, 900, 400])], ['sr:r1', 'sc', S50]]);
  assert.equal(measurePath(buildQtoModel(st2, null), 'd2', 0, [[300, 100], [700, 100]], [0], false), null);
});

test('standard scales: 1:100 and 1:50 at true paper size (A1 sheet, 1 pt = 25.4/72 mm)', () => {
  // 3.5 m at 1:100 is 35 mm on paper = 99.2126 pt; at 1:50 it is 70 mm
  const pt = (mmOnPaper: number) => mmOnPaper / (25.4 / 72);
  const st = storeOf([['pg:d1.0', 'sc', S100], ['pg:d1.1', 'sc', S50], ['ti:l', 'kind', 'line'], ['ti:l', 'name', 'L'],
    ['sh:a', 'ti', 'ti:l'], ['sh:a', 'dwg', 'd1'], ['sh:a', 'pg', 0], ['sh:a', 'k', 'line'], ['sh:a', 'p', J([0, 0, pt(35), 0])],
    ['sh:b', 'ti', 'ti:l'], ['sh:b', 'dwg', 'd1'], ['sh:b', 'pg', 1], ['sh:b', 'k', 'line'], ['sh:b', 'p', J([0, 0, pt(70), 0])]]);
  const m = buildQtoModel(st, null);
  for (const s of m.shapes) assert.equal(m1(shapeQtyAt(m, s, null).len), '3.500 m');
  assert.equal(m1(m.qty.get('ti:l')!.len), '7.000 m');
});

test('Excel export: lengths, areas and volumes with the decimals set; every decimal kept in the cell', () => {
  const st = storeOf([['pg:d1.0', 'sc', S100], ['ti:l', 'kind', 'line'], ['ti:l', 'name', 'Skirting'], ['ti:a', 'kind', 'area'], ['ti:a', 'name', 'Tiles'], ['ti:a', 'd', 0.05],
    ['sh:l', 'ti', 'ti:l'], ['sh:l', 'dwg', 'd1'], ['sh:l', 'pg', 0], ['sh:l', 'k', 'line'], ['sh:l', 'p', J([0, 0, 1 / S100 * 3.14159, 0])],
    ['sh:a', 'ti', 'ti:a'], ['sh:a', 'dwg', 'd1'], ['sh:a', 'pg', 0], ['sh:a', 'k', 'poly'], ['sh:a', 'p', J([0, 0, 100, 0, 100, 100, 0, 100])]]);
  const m = buildQtoModel(st, null);
  const xlsx = (dec?: { len: number; area: number; vol: number }) => unzipSync(exportQto(m, { project: 'p', by: 'x', when: new Date(0), dec }));
  const styles = strFromU8(xlsx()['xl/styles.xml']);
  assert.match(styles, /<cellXfs count="13">/);
  assert.equal((styles.split('<cellXfs')[1].split('</cellXfs>')[0].match(/<xf /g) ?? []).length, 13);
  assert.match(styles, /formatCode="#,##0.0"/);
  assert.match(styles, /formatCode="#,##0.0000"/);
  const IDX: Record<string, number> = { n2: 3, n3: 4, n0: 5, n1: 9, n4: 10 };
  const cells = (b: ReturnType<typeof xlsx>) => {
    const sh = strFromU8(b['xl/worksheets/sheet1.xml']);
    return [...sh.matchAll(/<c r="([A-Z]+)(\d+)"(?: s="(\d+)")?(?: t="\w+")?>(?:<v>([^<]*)<\/v>|<is><t[^>]*>([^<]*)<\/t><\/is>)?<\/c>/g)].map((r) => ({ col: r[1], row: Number(r[2]), s: Number(r[3] ?? 0), v: r[4] ?? r[5] ?? '' }));
  };
  const row = (b: ReturnType<typeof xlsx>, name: string) => {
    const c = cells(b);
    const hit = c.find((x) => x.v === name);
    assert.ok(hit, 'row for ' + name + ' (inline strings expected)');
    return c.filter((x) => x.row === hit!.row);
  };
  const at = (r: ReturnType<typeof row>, col: string) => r.find((x) => x.col === col)!;
  let r = row(xlsx(), 'Skirting');
  assert.equal(at(r, 'F').s, IDX[nStyle(3)], 'length: 3 decimals by default');
  assert.ok(Math.abs(Number(at(r, 'F').v) - 3.14159) < 1e-9, 'the cell has every decimal: ' + at(r, 'F').v);
  r = row(xlsx(), 'Tiles');
  assert.equal(at(r, 'G').s, IDX.n2, 'area: 2 decimals by default');
  assert.equal(at(r, 'H').s, IDX.n3, 'volume: 3 decimals by default');
  r = row(xlsx({ len: 1, area: 4, vol: 0 }), 'Tiles');
  assert.equal(at(r, 'G').s, IDX.n4);
  assert.equal(at(r, 'H').s, IDX.n0);
  assert.equal(at(r, 'I').s, IDX.n1, 'perimeter is a length');
});

test('a typed 3.5 m comes back 3.500 m at any scale, also on a slant (points kept to 0.001 pt)', () => {
  for (const ratio of [20, 50, 100, 200, 500, 1000, 2500]) {
    const sc = scaleFromRatio(ratio);
    for (const deg of [0, 17, 33.3, 45, 71]) {
      const a: Pt = [123.4567, 456.789];
      const L = 3.5 / sc, r = (deg * Math.PI) / 180;
      const b: Pt = [a[0] + L * Math.cos(r), a[1] + L * Math.sin(r)];
      const st = storeOf([['pg:d1.0', 'sc', sc], ['ti:l', 'kind', 'line'], ['ti:l', 'name', 'L'],
        ['sh:a', 'ti', 'ti:l'], ['sh:a', 'dwg', 'd1'], ['sh:a', 'pg', 0], ['sh:a', 'k', 'line'], ['sh:a', 'p', J(toFlat([a, b]))]]);
      const len = buildQtoModel(st, null).qty.get('ti:l')!.len;
      assert.equal(m1(len), '3.500 m', `1:${ratio} at ${deg}°: ${len}`);
      assert.ok(Math.abs(len - 3.5) < 0.0005, `1:${ratio} at ${deg}°: off by ${((len - 3.5) * 1000).toFixed(3)} mm`);
    }
  }
});
