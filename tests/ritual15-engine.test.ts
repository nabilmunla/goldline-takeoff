// 0.15.0 pre-release hunt, engine side (debug run 1): walls / beams / segment tags / door schedule /
// auto-count / import matching. Each test was written to fail on the bug it names, then fixed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/engine/store';
import { buildQtoModel, nearestSeg } from '../src/engine/qto/model';
import { scaleFromRatio } from '../src/engine/qto/geometry';
import {
  insertVertexOps, deleteVertexOps, vertexOps, setSegTagsOps, splitLineOps, openingOps, reassignOpeningsOps, newShapesIn,
  planDoorImport, applyDoorPlanOps, doorRowsOps, deleteDoorOps,
} from '../src/engine/qto/ops';
import { analyseDoorSchedule, doorRows, pairOf } from '../src/engine/qto/doorsched';
import { findTags, byTag, type Word } from '../src/engine/qto/autocount';
import { planImport } from '../src/engine/qto/revisions';
import { writeXlsx } from '../src/engine/xlsxwrite';
import { readXlsx, type XWorkbook } from '../src/engine/xlsx';
import type { Batch, Op } from '../src/engine/types';

let stamp = 0;
const batch = (ops: Op[], who = 'nabil', s = String(++stamp).padStart(10, '0') + '~' + who): Batch => ({ s, w: who, u: who, t: 0, o: ops, a: who });
function storeWith(ops: Op[]): Store { const s = new Store(); s.apply(batch(ops)); return s; }
const add = (s: Store, ops: Op[], who = 'nabil') => s.apply(batch(ops, who));
/** the same batches applied in both orders: every PC must end up with the same thing */
function bothOrders(base: Op[], a: Batch, b: Batch): Store[] {
  // (the base first of all: its stamp is below every edit's)
  const b0 = batch(base, 'base', '0000000000~base');
  const one = new Store(), two = new Store();
  one.apply(b0); one.apply(a); one.apply(b);
  two.apply(b0); two.apply(b); two.apply(a);
  return [one, two];
}
const J = (v: unknown) => JSON.stringify(v);
const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const S100 = scaleFromRatio(100);
const P = (m: number) => m / S100;

/** a wall 10 m + 6 m (an L), 3 m high, 0.2 m thick; doors D01 (1.0 x 2.2 structural), D02 (clear 0.8 x 2.1) */
const WALL: Op[] = [
  ['pg:d1.0', 'sc', S100],
  ['ti:w', 'kind', 'wall'], ['ti:w', 'name', 'Blockwork 200'], ['ti:w', 'ord', 'a0'], ['ti:w', 'h', 3], ['ti:w', 'd', 0.2],
  ['sh:w1', 'ti', 'ti:w'], ['sh:w1', 'dwg', 'd1'], ['sh:w1', 'pg', 0], ['sh:w1', 'k', 'line'], ['sh:w1', 'p', J([100, 100, 100 + P(10), 100, 100 + P(10), 100 + P(6)])],
  ['ds:a', 'tag', 'D01'], ['ds:a', 'sw', 1.0], ['ds:a', 'sh', 2.2], ['ds:a', 'cw', 0.9], ['ds:a', 'ch', 2.1], ['ds:a', 'ord', 'a0'],
  ['ds:b', 'tag', 'D02'], ['ds:b', 'cw', 0.8], ['ds:b', 'ch', 2.1], ['ds:b', 'ord', 'a1'],
];

// ---------------------------------------------------------------- door schedule from Excel
test('door schedule re-import: a size the newer file leaves empty is not a change (the size is kept)', () => {
  const s = storeWith(WALL);
  const m = buildQtoModel(s, null);
  // the newer schedule has D01's structural width blank ("TBC") and its height unchanged
  const w = readXlsx(writeXlsx([{ name: 'Doors', rows: [['Tag', 'Description', 'Width', 'Height'], ['D01', '', 'TBC', 2200], ['D02', 'Steel', null, null]] }]));
  const rows = doorRows(w, analyseDoorSchedule(w)!);
  assert.equal(rows[0].sw, null);
  const plan = planDoorImport(m, rows);
  const d01 = plan.rows.find((r) => r.tag === 'D01')!;
  assert.equal(d01.k, 'same', 'nothing to change: ' + J(d01.ch));
  const r = applyDoorPlanOps(m, plan);
  add(s, r.ops);
  const m2 = buildQtoModel(s, null);
  assert.equal(m2.doorById.get('ds:a')!.sw, 1.0);
  assert.equal(m2.doorById.get('ds:b')!.desc, 'Steel');
  assert.equal(m2.doorById.get('ds:b')!.cw, 0.8);
});

test('door schedule re-import: a deleted row brought back keeps what the file does not say', () => {
  const s = storeWith([...WALL, ['ds:b', 'loc', 'Stair']]);
  let m = buildQtoModel(s, null);
  add(s, deleteDoorOps(m, 'ds:b'));
  m = buildQtoModel(s, null);
  // a file without a Location column brings D02 back
  const plan = planDoorImport(m, [{ tag: 'D02', desc: 'Steel', cw: 0.85, ch: 2.1 }]);
  assert.equal(plan.rows[0].k, 'back');
  add(s, applyDoorPlanOps(m, plan).ops);
  m = buildQtoModel(s, null);
  const d = m.doorById.get('ds:b')!;
  assert.equal(d.loc, 'Stair');
  assert.equal(d.cw, 0.85);
});

test('door schedule from Excel: the header row right under a title (merged over the table or not)', () => {
  const rows = [['DOOR SCHEDULE'], ['Door No.', 'Description', 'Width', 'Height', 'Location'], ['D01', 'Flush door', 900, 2100, 'Bedroom'], ['D02', 'Steel door', 1000, 2200, 'Stair']];
  const w = readXlsx(writeXlsx([{ name: 'Sheet1', rows }]));
  const p = analyseDoorSchedule(w);
  assert.ok(p, 'found');
  assert.equal(p!.header, 2);
  assert.deepEqual([p!.cols.tag, p!.cols.desc, p!.cols.sw, p!.cols.sh, p!.cols.loc], [1, 2, 3, 4, 5]);
  assert.deepEqual(doorRows(w, p!).map((r) => [r.tag, r.sw, r.sh]), [['D01', 0.9, 2.1], ['D02', 1, 2.2]]);
  // the title merged across the table's width
  const sh = w.sheet('Sheet1');
  sh.merges.push({ r1: 1, c1: 1, r2: 1, c2: 5 });
  const merged: XWorkbook = { ...w, sheet: (n: string) => (n === 'Sheet1' ? sh : w.sheet(n)) };
  const p2 = analyseDoorSchedule(merged);
  assert.ok(p2, 'found under a merged title');
  assert.deepEqual([p2!.header, p2!.cols.tag, p2!.cols.sw, p2!.cols.sh], [2, 1, 3, 4]);
});

test('door sizes written in one cell: a double door "2 x 900 x 2100", "W900 x H2100", "90 x 210 cm"', () => {
  assert.deepEqual(pairOf('2 x 900 x 2100'), [1.8, 2.1]);
  assert.deepEqual(pairOf('D/L 2x900x2100'), [1.8, 2.1]);
  assert.deepEqual(pairOf('W900 x H2100'), [0.9, 2.1]);
  assert.deepEqual(pairOf('900(W) x 2100(H)'), [0.9, 2.1]);
  assert.deepEqual(pairOf('90 x 210 cm'), [0.9, 2.1]);
  // unchanged: a leaf thickness after the size, units on each, metres
  assert.deepEqual(pairOf('900 x 2100 x 45'), [0.9, 2.1]);
  assert.deepEqual(pairOf('900 x 2.1 m'), [0.9, 2.1]);
  assert.deepEqual(pairOf('900W x 2100H'), [0.9, 2.1]);
  assert.equal(pairOf('TBC'), null);
});

// ---------------------------------------------------------------- two PCs at once
test('two PCs bringing in the same door schedule at once get one row per door, not two', () => {
  const base: Op[] = [['ti:w', 'kind', 'wall'], ['ti:w', 'name', 'W']];
  const rows = [{ tag: 'D01', sw: 1, sh: 2.2 }, { tag: 'D02', sw: 0.9, sh: 2.1 }];
  const m0 = buildQtoModel(storeWith(base), null);
  const a = batch(applyDoorPlanOps(m0, planDoorImport(m0, rows)).ops, 'omar');
  const b = batch(applyDoorPlanOps(m0, planDoorImport(m0, rows)).ops, 'rami');
  for (const st of bothOrders(base, a, b)) {
    const m = buildQtoModel(st, null);
    assert.deepEqual(m.doors.map((d) => d.tag), ['D01', 'D02']);
  }
  // the same new tag typed in the door picker on two PCs: one row
  const c = batch(doorRowsOps(m0, [{ tag: 'D-X1', sw: 0.9, sh: 2.1 }]).ops, 'omar');
  const d = batch(doorRowsOps(m0, [{ tag: 'd-x1 ' }]).ops, 'rami');
  for (const st of bothOrders(base, c, d)) assert.equal(buildQtoModel(st, null).doors.length, 1);
});

test('segment tags and corners changed at once on two PCs stay in step (a beam type never lands on another segment)', () => {
  const base: Op[] = [
    ['pg:d1.0', 'sc', S100], ['bt:b1', 'name', 'B1'], ['bt:b1', 'w', 0.3], ['bt:b1', 'd', 0.6], ['bt:b2', 'name', 'B2'], ['bt:b2', 'w', 0.2], ['bt:b2', 'd', 0.4],
    ['ti:b', 'kind', 'beam'], ['ti:b', 'name', 'Beams'],
    ['sh:b', 'ti', 'ti:b'], ['sh:b', 'dwg', 'd1'], ['sh:b', 'pg', 0], ['sh:b', 'k', 'line'], ['sh:b', 'p', J([0, 0, P(4), 0, P(4), P(3), P(10), P(3)])],
    ['sh:b', 'sg', J(['bt:b1', null, 'bt:b1'])],
  ];
  const m0 = buildQtoModel(storeWith(base), null);
  const s0 = m0.shapes[0];
  // Omar adds a corner in the middle of the first segment; Rami (later) types the second segment B2
  const a = batch(insertVertexOps(s0, 0, 0, [P(2), 0]), 'omar', '0000000001~omar');
  const b = batch(setSegTagsOps(s0, [1], 'bt:b2'), 'rami', '0000000002~rami');
  for (const st of bothOrders(base, a, b)) {
    const m = buildQtoModel(st, null);
    const s = m.shapes[0];
    // whichever edit wins, the tags are those written with the corners they belong to
    const segs = s.pts.length - 1;
    const want = segs === 4 ? ['bt:b1', 'bt:b1', null, 'bt:b1'] : ['bt:b1', 'bt:b2', 'bt:b1'];
    assert.deepEqual(s.sg.slice(0, segs).map((x) => x ?? null), want);
    // B1 is 4 + 6 m whatever happened (corners are written to 0.001 pt)
    close(m.qty.get('ti:b')!.byTag.get('bt:b1')!.len, 10, 1e-3);
  }
});

test('a door placed on a wall while someone else splits that wall still counts (on the part it is on)', () => {
  const m0 = buildQtoModel(storeWith(WALL), null);
  const w = m0.shapes[0];
  const sp = splitLineOps(w, 1, 'omar')!;
  const a = batch([...sp.ops, ...reassignOpeningsOps(m0.openingsByShape, ['sh:w1'], newShapesIn(sp.ops))], 'omar');
  const b = batch(openingOps({ sh: 'sh:w1', x: 100 + P(10), y: 100 + P(3), k: 'door', door: 'ds:a', tag: 'D01', w: null, h: null, lint: true }).ops, 'rami');
  for (const st of bothOrders(WALL, a, b)) {
    const m = buildQtoModel(st, null);
    const q = m.qty.get('ti:w')!;
    assert.equal(q.doors, 1);
    close(q.dedArea, 2.2);
    assert.equal(m.doorCount.get('ds:a'), 1);
    assert.equal(m.openings[0].sh, sp.ids[1], 'on the second part (where it was put)');
  }
});

// ---------------------------------------------------------------- walls
test('a door on a curved wall goes on the arc it was put on, not on the straight wall next to it', () => {
  // a half-circle wall (0,0) -> (100,0) bulging up the sheet, then a straight wall going on from its end
  const r = 50;
  const shape = { k: 'line' as const, pts: [[0, 0], [100, 0], [100, -80]] as [number, number][], b: [1, 0] };
  // the arc's middle is 50 pt off its chord; a door on the arc 30° from its end
  const a = Math.PI / 6;
  const onArc: [number, number] = [50 + r * Math.cos(a), -r * Math.sin(a)];
  // (which way the arc bulges: from the model's own flattening)
  const m = buildQtoModel(storeWith([['pg:d1.0', 'sc', S100], ['ti:l', 'kind', 'wall'], ['ti:l', 'name', 'W'], ['sh:l', 'ti', 'ti:l'], ['sh:l', 'dwg', 'd1'], ['sh:l', 'pg', 0], ['sh:l', 'k', 'line'], ['sh:l', 'p', J(shape.pts.flat())], ['sh:l', 'b', J(shape.b)]]), null);
  const s = m.shapes[0];
  const up = s.flat.some((p) => p[1] < -1);
  const door: [number, number] = up ? onArc : [onArc[0], -onArc[1]];
  if (!up) shape.pts[2] = [100, 80];
  const s2 = { ...s, pts: shape.pts };
  assert.equal(nearestSeg(s2, door).seg, 0);
});

// ---------------------------------------------------------------- auto-count by tag
test('auto-count: a tag is not glued onto a word in front of it that starts the same ("DOOR D01", a stacked tag)', () => {
  const W = (t: string, x: number, y: number, w: number, h = 7.4): Word => ({ t, x0: x, y0: y, x1: x + w, y1: y + h });
  // as PDFium gives them: "DOOR" and "D01" a space apart (no space character between them)
  const words = [W('DOOR', 100.8, 287.6, 28.8), W('D01', 133.6, 287.8, 15.5), W('D-B', 806.2, 845.1, 5.8, 4.9), W('DRT05', 809.5, 846.3, 9.7, 6.8)];
  const found = byTag(findTags(words, 'D', 'starts')).map((g) => g.text);
  assert.deepEqual(found.sort(), ['D01', 'DRT05']);
  // pieces of one tag are still read together
  assert.deepEqual(findTags([W('D', 50, 10, 3, 4), W('01', 53.5, 10, 6, 4)], 'D', 'starts').map((f) => f.text), ['D01']);
});

// ---------------------------------------------------------------- import: matching a new issue to the sheets
const f = (p: string, i = 0) => ({ path: p, rel: p.split('\\').pop()!, size: 1, mtime: i });
/** a project made by bringing in `olds`, then `news` brought in: [name, action, the file it updates] */
function issue(olds: string[], news: string[]) {
  const first = planImport(olds.map((n, i) => f('S:\\old\\' + n, i)), { drawings: [], revisions: new Map() } as never);
  const drawings = first.filter((r) => r.action === 'new').map((r, i) => ({ id: 'dwg:' + i, name: r.name, path: r.file.path, unc: '', sheet: r.sheet }));
  const rows = planImport(news.map((n, i) => f('X:\\new\\' + n, i)), { drawings, revisions: new Map() } as never);
  return { first: first.map((r) => [r.name, r.action]), rows: rows.map((r) => [r.name, r.action, r.target ? drawings.find((d) => d.id === r.target)!.name : null]) };
}

test('import: sheets whose number is only told apart by the building / tower codes in front are never merged', () => {
  // one issue with both buildings: both brought in (0.15 left one out as "a later revision")
  assert.deepEqual(issue(['P04-B1-AR-1001.pdf', 'P04-B2-AR-1001.pdf'], []).first, [['P04-B1-AR-1001.pdf', 'new'], ['P04-B2-AR-1001.pdf', 'new']]);
  assert.deepEqual(issue(['P101-ABC-DWG-AR-11030-GA-L01.pdf', 'P101-ABC-DWG-AR-12030-GA-L01.pdf'], []).first.map((r) => r[1]), ['new', 'new']);
  // B2's drawing is not a new revision of B1's; tower A's is not tower B's
  assert.deepEqual(issue(['P04-B1-AR-1001.pdf'], ['P04-B2-AR-1001.pdf']).rows, [['P04-B2-AR-1001.pdf', 'new', null]]);
  assert.deepEqual(issue(['TA-AR-GA-L01_C02.pdf', 'TB-AR-GA-L01_C02.pdf'], ['TA-AR-GA-L01_C03.pdf']).rows, [['TA-AR-GA-L01_C03.pdf', 'rev', 'TA-AR-GA-L01_C02.pdf']]);
  assert.deepEqual(issue(['PRJ-TA-AR-L01.pdf'], ['PRJ-TB-AR-L01.pdf']).rows, [['PRJ-TB-AR-L01.pdf', 'new', null]]);
  assert.deepEqual(issue(['B1-AR-101.pdf'], ['B2-AR-101.pdf']).rows, [['B2-AR-101.pdf', 'new', null]]);
  // still matched: the same sheet with its next status code, the same codes in front
  assert.deepEqual(issue(['P04-B1-AR-1001_C01.pdf', 'P04-B2-AR-1001_C01.pdf'], ['P04-B2-AR-1001_C02.pdf']).rows, [['P04-B2-AR-1001_C02.pdf', 'rev', 'P04-B2-AR-1001_C01.pdf']]);
});

test('import: a sheet number ending in a number keeps its pre-0.15 reading when the title is codes ("...-AR-11030-GA-L01")', async () => {
  const { sheetFromFile } = await import('../src/engine/qto/revisions');
  assert.deepEqual(sheetFromFile('P101-ABC-DWG-AR-11030-GA-L01.pdf'), { sheet: 'AR-11030', title: 'GA-L01' });
  assert.deepEqual(issue(['P101-ABC-DWG-AR-11030-GA-L01.pdf', 'P101-ABC-DWG-AR-12030-GA-L01.pdf'], ['P101-ABC-DWG-AR-12030-GA-L01_Rev B.pdf']).rows, [['P101-ABC-DWG-AR-12030-GA-L01_Rev B.pdf', 'rev', 'P101-ABC-DWG-AR-12030-GA-L01.pdf']]);
});

test('import: parking / podium levels written like status codes (GA-P1, GA-P2) are different sheets', () => {
  assert.deepEqual(issue(['P101-AR-GA-P1.pdf', 'P101-AR-GA-P2.pdf'], []).first.map((r) => r[1]), ['new', 'new']);
  assert.deepEqual(issue(['P101-AR-GA-P1.pdf'], ['P101-AR-GA-P2.pdf']).rows, [['P101-AR-GA-P2.pdf', 'new', null]]);
  assert.deepEqual(issue(['P101-AR-GA-P01.pdf', 'P101-AR-GA-P02.pdf'], ['P101-AR-GA-P02.pdf']).rows.map((r) => r[2]), ['P101-AR-GA-P02.pdf']);
  // a real status code after the sheet number still goes
  assert.deepEqual(issue(['A-101_C02.pdf'], ['A-101_C03.pdf']).rows, [['A-101_C03.pdf', 'rev', 'A-101_C02.pdf']]);
  assert.deepEqual(issue(['100101-C02.pdf'], ['100101-C03.pdf']).rows, [['100101-C03.pdf', 'rev', '100101-C02.pdf']]);
});

test('import: a sheet number that fits sheets of two buildings is not given to either', () => {
  // the project has tower A's and tower B's L04; the new file says only "GA-L04"
  assert.deepEqual(issue(['TA-AR-GA-L04 Plan.pdf', 'TB-AR-GA-L04 Plan.pdf'], ['GA-L04 Plan.pdf']).rows.map((r) => r[1]), ['new']);
  // the project has a plain GA-L04; the issue brings tower A's and tower B's
  assert.deepEqual(issue(['GA-L04 Plan.pdf'], ['TA-AR-GA-L04 Plan.pdf', 'TB-AR-GA-L04 Plan.pdf']).rows.map((r) => r[1]), ['new', 'new']);
});

test('a door placed while someone else deletes its schedule row keeps the row\'s last size (deducted, lintel)', () => {
  const m0 = buildQtoModel(storeWith(WALL), null);
  const a = batch(deleteDoorOps(m0, 'ds:a'), 'omar');
  const b = batch(openingOps({ sh: 'sh:w1', x: 100 + P(4), y: 100, k: 'door', door: 'ds:a', tag: 'D01', w: null, h: null, lint: true }).ops, 'rami');
  for (const st of bothOrders(WALL, a, b)) {
    const m = buildQtoModel(st, null);
    const o = m.openings[0];
    assert.equal(o.uns, true);
    const q = m.qty.get('ti:w')!;
    close(q.dedArea, 2.2);
    close(q.llen, 1.0 + 0.4);
  }
});

test('two schedule rows with one tag (an old race): an import updates the row the placed doors go by', () => {
  const s = storeWith([...WALL, ['ds:z', 'tag', 'd01'], ['ds:z', 'ord', 'a2'], ['ds:z', 'sw', 1.5]]);
  add(s, openingOps({ sh: 'sh:w1', x: 100 + P(4), y: 100, k: 'door', door: null, tag: 'D01', w: null, h: null, lint: true }).ops);
  let m = buildQtoModel(s, null);
  assert.equal(m.openings[0].door, 'ds:a');
  const plan = planDoorImport(m, [{ tag: 'D01', sw: 1.2, sh: 2.2 }]);
  assert.equal(plan.rows[0].id, 'ds:a');
  add(s, applyDoorPlanOps(m, plan).ops);
  m = buildQtoModel(s, null);
  close(m.qty.get('ti:w')!.dedArea, 1.2 * 2.2);
  assert.deepEqual(doorRowsOps(m, [{ tag: 'D01', desc: 'x' }]).ids, ['ds:a']);
});

test('import: matching a big issue by drawing number stays quick (the import dialog waited ~5-9 s)', () => {
  // a project brought in before 0.15: no sheet numbers (names like "A-1001_C02"), so every file of the
  // new issue is matched the loose way
  const drawings = Array.from({ length: 550 }, (_, i) => ({ id: 'dwg:' + i, name: `PRJ-A-${1000 + i}_C02.pdf`, path: `S:\\old\\PRJ-A-${1000 + i}_C02.pdf`, unc: '', sheet: '' }));
  const files = Array.from({ length: 575 }, (_, i) => f(`X:\\new\\PRJ-A-${1000 + i}_C03.pdf`, i));
  const t = performance.now();
  const rows = planImport(files, { drawings, revisions: new Map() } as never);
  const ms = performance.now() - t;
  assert.equal(rows.filter((r) => r.action === 'rev').length, 550);
  assert.equal(rows.filter((r) => r.action === 'new').length, 25);
  assert.ok(ms < 2000, `took ${Math.round(ms)} ms`);
});

test('a closed wall (a rectangle drawn as a line): its first corner is its last - moved or removed, it stays closed', () => {
  const rect: [number, number][] = [[0, 0], [P(10), 0], [P(10), P(6)], [0, P(6)], [0, 0]];
  const s = storeWith([['pg:d1.0', 'sc', S100], ['ti:w', 'kind', 'wall'], ['ti:w', 'name', 'Room'], ['ti:w', 'h', 3],
    ['sh:r', 'ti', 'ti:w'], ['sh:r', 'dwg', 'd1'], ['sh:r', 'pg', 0], ['sh:r', 'k', 'line'], ['sh:r', 'p', J(rect.flat())], ['sh:r', 'sg', J(['N', 'E', 'S', 'W'])]]);
  const m = buildQtoModel(s, null);
  close(m.qty.get('ti:w')!.len, 32);
  // the corner dragged 1 m to the left: both ends go (the outline used to open, 1 m short of the corner)
  for (const idx of [0, 4]) {
    const s2 = storeWith([['pg:d1.0', 'sc', S100], ['ti:w', 'kind', 'wall'], ['ti:w', 'name', 'Room'], ['sh:r', 'ti', 'ti:w'], ['sh:r', 'dwg', 'd1'], ['sh:r', 'pg', 0], ['sh:r', 'k', 'line'], ['sh:r', 'p', J(rect.flat())]]);
    add(s2, vertexOps(buildQtoModel(s2, null).shapes[0], 0, idx, [P(-1), 0]));
    const sh = buildQtoModel(s2, null).shapes[0];
    assert.deepEqual(sh.pts[0], sh.pts[4], 'still closed (corner ' + idx + ')');
    close(buildQtoModel(s2, null).qty.get('ti:w')!.len, 11 + 6 + 10 + Math.hypot(1, 6), 1e-3);
  }
  // the first corner removed: its two sides become one (closed at the next corner), tags with them
  add(s, deleteVertexOps(m.shapes[0], 0, 0));
  const m2 = buildQtoModel(s, null);
  const sh = m2.shapes[0];
  assert.equal(sh.pts.length, 4);
  assert.deepEqual(sh.pts[0], sh.pts[3]);
  close(m2.qty.get('ti:w')!.len, 6 + 10 + Math.hypot(10, 6), 1e-3);
  assert.deepEqual(sh.sg, ['E', 'S', 'W']);
  // a closed triangle keeps its three corners
  assert.deepEqual(deleteVertexOps(sh, 0, 0), []);
});
