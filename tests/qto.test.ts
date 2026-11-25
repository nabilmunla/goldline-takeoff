// Take-off engine: quantities, deductions, links, the price-free BOQ copy, QS access.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/engine/store';
import { buildModel } from '../src/engine/boq';
import { demoBoqOps } from './helpers/demoboq';
import { buildQtoModel, hitShape, measuresFor, scaleAt } from '../src/engine/qto/model';
import { scaleFromRatio, ratioOf, scalesInText, polyArea, ortho, PT_MM } from '../src/engine/qto/geometry';
import { mirrorOps, takeoffQtyOps, MIRROR_FIELDS, attachedQtos, attachOps } from '../src/engine/qto/bridge';
import { rootsOf, setRootsOps, type Account } from '../src/engine/accounts';
import type { Op, Value } from '../src/engine/types';

let stamp = 0;
function storeWith(ops: Op[], who = 'nabil'): Store {
  const s = new Store();
  s.apply({ s: String(++stamp).padStart(10, '0') + '~t', w: 't', u: who, t: 0, o: ops, a: who });
  return s;
}
function add(s: Store, ops: Op[], who = 'nabil') {
  s.apply({ s: String(++stamp).padStart(10, '0') + '~t', w: 't', u: who, t: 0, o: ops, a: who });
}
const J = (v: unknown) => JSON.stringify(v);
const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// 1:100 on true paper size: 1 sheet point = 3.5278 cm in reality.
const S100 = scaleFromRatio(100);
/** a square of side `m` metres (at 1:100) starting at x,y sheet points */
const sq = (x: number, y: number, m: number) => { const s = m / S100; return [x, y, x + s, y, x + s, y + s, x, y + s]; };

test('geometry: scales, ratios, scale text, ortho', () => {
  close(S100, 0.0352777, 1e-6);
  assert.equal(ratioOf(S100), 100);
  assert.equal(ratioOf(S100 * 1.013), null);
  assert.deepEqual(scalesInText('PLAN  SCALE 1:100 @ A0 ... Section Scale: 1 : 50 ... SCALE 1:100'), [100, 50]);
  close(polyArea([[0, 0], [10, 0], [10, 10], [0, 10]]), 100);
  const o = ortho([0, 0], [10, 1]);
  close(o[1], 0);
  close(PT_MM, 0.352777, 1e-5);
});

test('quantities: area with holes (threshold per hole), multiplier, waste, depth', () => {
  const s = storeWith([
    ['pg:d1.0', 'sc', S100],
    ['ti:slab', 'kind', 'area'], ['ti:slab', 'name', 'Screed'], ['ti:slab', 'd', 0.05], ['ti:slab', 'dmin', 1], ['ti:slab', 'x', 2], ['ti:slab', 'waste', 10],
    // 10 m x 10 m room with a 2x2 m shaft (deducted) and a 0.5x0.5 m column (kept: <= 1 m²)
    ['sh:a', 'ti', 'ti:slab'], ['sh:a', 'dwg', 'd1'], ['sh:a', 'pg', 0], ['sh:a', 'k', 'poly'], ['sh:a', 'p', J(sq(100, 100, 10))],
    ['sh:a', 'holes', J([sq(120, 120, 2), sq(200, 200, 0.5)])],
  ]);
  const m = buildQtoModel(s, null);
  const q = m.qty.get('ti:slab')!;
  close(q.area, (100 - 4) * 2 * 1.1, 1e-6);
  close(q.vol, (100 - 4) * 2 * 1.1 * 0.05, 1e-6);
  close(q.perim, (40 + 8) * 2 * 1.1, 1e-6); // the deducted shaft adds its edge, the kept column does not
  assert.equal(q.shapes, 1);
});

test('quantities: walls by length x height, windows measured once and deducted from several items', () => {
  const s = storeWith([
    ['pg:d1.0', 'sc', S100],
    ['ti:win', 'kind', 'count'], ['ti:win', 'name', 'W1 window'], ['ti:win', 'ow', 1.5], ['ti:win', 'oh', 2],
    ['ti:dr', 'kind', 'count'], ['ti:dr', 'name', 'Small vent'], ['ti:dr', 'ow', 0.5], ['ti:dr', 'oh', 0.5],
    ['ti:blk', 'kind', 'line'], ['ti:blk', 'name', 'Blockwork 200'], ['ti:blk', 'h', 3], ['ti:blk', 'dmin', 1], ['ti:blk', 'ded', J(['ti:win', 'ti:dr'])],
    ['ti:pnt', 'kind', 'line'], ['ti:pnt', 'name', 'Paint'], ['ti:pnt', 'h', 3], ['ti:pnt', 'x', 2], ['ti:pnt', 'ded', J(['ti:win'])],
    // a 20 m wall
    ['sh:w', 'ti', 'ti:blk'], ['sh:w', 'dwg', 'd1'], ['sh:w', 'pg', 0], ['sh:w', 'k', 'line'], ['sh:w', 'p', J([0, 0, 20 / S100, 0])],
    ['sh:w2', 'ti', 'ti:pnt'], ['sh:w2', 'dwg', 'd1'], ['sh:w2', 'pg', 0], ['sh:w2', 'k', 'line'], ['sh:w2', 'p', J([0, 0, 20 / S100, 0])],
    // 3 windows, 2 vents
    ['sh:c1', 'ti', 'ti:win'], ['sh:c1', 'dwg', 'd1'], ['sh:c1', 'pg', 0], ['sh:c1', 'k', 'pt'], ['sh:c1', 'p', J([5, 5])],
    ['sh:c2', 'ti', 'ti:win'], ['sh:c2', 'dwg', 'd1'], ['sh:c2', 'pg', 0], ['sh:c2', 'k', 'pt'], ['sh:c2', 'p', J([15, 5])], ['sh:c2', 'm', 2],
    ['sh:v1', 'ti', 'ti:dr'], ['sh:v1', 'dwg', 'd1'], ['sh:v1', 'pg', 0], ['sh:v1', 'k', 'pt'], ['sh:v1', 'p', J([25, 5, 35, 5])],
  ]);
  const m = buildQtoModel(s, null);
  assert.equal(m.qty.get('ti:win')!.cnt, 3);
  close(m.qty.get('ti:win')!.area, 9);
  const blk = m.qty.get('ti:blk')!;
  close(blk.len, 20, 1e-9);
  close(blk.gross, 60);
  close(blk.area, 60 - 9); // vents are 0.25 m² each: under the 1 m² threshold, left in
  assert.equal(blk.keptOpenings, 2);
  const pnt = m.qty.get('ti:pnt')!;
  close(pnt.area, 120 - 18); // 2 faces (×2), so the windows come off both faces
  assert.deepEqual(measuresFor(m.itemById.get('ti:blk')!), ['area', 'len', 'cnt']);
});

test('quantities: skirting length minus door widths; unscaled pages are flagged, counts still count', () => {
  const s = storeWith([
    ['pg:d1.0', 'sc', S100],
    ['ti:door', 'kind', 'count'], ['ti:door', 'name', 'D1'], ['ti:door', 'ow', 0.9],
    ['ti:sk', 'kind', 'line'], ['ti:sk', 'name', 'Skirting'], ['ti:sk', 'ded', J(['ti:door'])],
    ['sh:s', 'ti', 'ti:sk'], ['sh:s', 'dwg', 'd1'], ['sh:s', 'pg', 0], ['sh:s', 'k', 'line'], ['sh:s', 'p', J([0, 0, 10 / S100, 0, 10 / S100, 10 / S100])],
    ['sh:d', 'ti', 'ti:door'], ['sh:d', 'dwg', 'd1'], ['sh:d', 'pg', 0], ['sh:d', 'k', 'pt'], ['sh:d', 'p', J([1, 1, 2, 2])],
    // a shape on a page with no scale yet
    ['sh:u', 'ti', 'ti:sk'], ['sh:u', 'dwg', 'd2'], ['sh:u', 'pg', 0], ['sh:u', 'k', 'line'], ['sh:u', 'p', J([0, 0, 100, 0])],
    ['sh:du', 'ti', 'ti:door'], ['sh:du', 'dwg', 'd2'], ['sh:du', 'pg', 0], ['sh:du', 'k', 'pt'], ['sh:du', 'p', J([1, 1])],
  ]);
  const m = buildQtoModel(s, null);
  const sk = m.qty.get('ti:sk')!;
  close(sk.len, 20 - 3 * 0.9);
  assert.equal(sk.unscaled, 1);
  assert.equal(m.qty.get('ti:door')!.cnt, 3);
});

test('scale regions: a viewport with its own scale wins inside its rectangle', () => {
  const s = storeWith([
    ['pg:d1.0', 'sc', S100],
    // (the 10 m line, 567 pt at 1:50, lies wholly inside the viewport)
    ['sr:r1', 'dwg', 'd1'], ['sr:r1', 'pg', 0], ['sr:r1', 'r', J([500, 500, 1300, 900])], ['sr:r1', 'sc', scaleFromRatio(50)], ['sr:r1', 'scl', '1:50'],
    ['ti:a', 'kind', 'line'], ['ti:a', 'name', 'Detail'],
    ['sh:1', 'ti', 'ti:a'], ['sh:1', 'dwg', 'd1'], ['sh:1', 'pg', 0], ['sh:1', 'k', 'line'], ['sh:1', 'p', J([600, 600, 600 + 10 / scaleFromRatio(50), 600])],
  ]);
  const m = buildQtoModel(s, null);
  close(m.qty.get('ti:a')!.len, 10);
  assert.equal(scaleAt(m, 'd1', 0, [10, 10]).sc, S100);
  assert.equal(scaleAt(m, 'd1', 0, [600, 600]).label, '1:50');
});

test('links: BOQ lines and dummies, dummy mapped to a real line, private take-offs not counted', () => {
  const s = storeWith([
    ['pg:d1.0', 'sc', S100],
    ['ti:f', 'kind', 'area'], ['ti:f', 'name', 'Porcelain'],
    ['sh:f', 'ti', 'ti:f'], ['sh:f', 'dwg', 'd1'], ['sh:f', 'pg', 0], ['sh:f', 'k', 'poly'], ['sh:f', 'p', J(sq(0, 0, 10))],
    ['ti:p', 'kind', 'area'], ['ti:p', 'name', 'Scratch'], ['ti:p', 'priv', true], ['ti:p', 'owner', 'qs.one'],
    ['sh:p', 'ti', 'ti:p'], ['sh:p', 'dwg', 'd1'], ['sh:p', 'pg', 0], ['sh:p', 'k', 'poly'], ['sh:p', 'p', J(sq(0, 0, 5))],
    ['dm:1', 'desc', 'Floor tiles (until the BOQ arrives)'], ['dm:1', 'unit', 'm2'],
    ['lk:1', 'ti', 'ti:f'], ['lk:1', 'to', 'dm:1'], ['lk:1', 'q', 'area'],
    ['lk:2', 'ti', 'ti:f'], ['lk:2', 'to', 'b:i7'], ['lk:2', 'q', 'perim'], ['lk:2', 'f', 1],
    ['lk:3', 'ti', 'ti:p'], ['lk:3', 'to', 'b:i7'], ['lk:3', 'q', 'area'],
  ]);
  let m = buildQtoModel(s, { username: 'qs.two', seeAll: false });
  assert.equal(m.itemById.has('ti:p'), false, 'someone else’s private take-off is hidden');
  close(m.targets.get('dm:1')!.total, 100);
  close(m.boqQty.get('i7')!.total, 40);
  m = buildQtoModel(s, { username: 'qs.one', seeAll: false });
  assert.equal(m.itemById.has('ti:p'), true, 'owner sees it');
  close(m.boqQty.get('i7')!.total, 40, 1e-9); // still not counted
  add(s, [['dm:1', 'map', 'i7']]);
  m = buildQtoModel(s, null);
  close(m.boqQty.get('i7')!.total, 140, 1e-9);
});

test('hit test: inside a room, on a line, near a count point; not inside a hole', () => {
  const s = storeWith([
    ['ti:a', 'kind', 'area'], ['ti:a', 'name', 'A'],
    ['sh:a', 'ti', 'ti:a'], ['sh:a', 'dwg', 'd'], ['sh:a', 'pg', 0], ['sh:a', 'k', 'poly'], ['sh:a', 'p', J([0, 0, 100, 0, 100, 100, 0, 100])], ['sh:a', 'holes', J([[40, 40, 60, 40, 60, 60, 40, 60]])],
  ]);
  const sh = buildQtoModel(s, null).shapes[0];
  assert.equal(hitShape(sh, [10, 10], 2), true);
  assert.equal(hitShape(sh, [50, 50], 2), false);
  assert.equal(hitShape(sh, [101, 50], 2), true);
  assert.equal(hitShape(sh, [150, 50], 2), false);
});

test('BOQ copy for QS: only price-free fields, follows edits and deletions, nothing priced leaks', () => {
  const est = storeWith(demoBoqOps());
  const boq = buildModel(est);
  const qto = new Store();
  const ops = mirrorOps(boq, qto);
  assert.ok(ops.length > 100);
  for (const [, f] of ops) assert.ok((MIRROR_FIELDS as readonly string[]).includes(f) || f === 'del', 'unexpected field ' + f);
  const json = JSON.stringify(ops);
  for (const n of boq.byId.values()) if (n.rate !== null) assert.ok(!json.includes('"rate"'), 'rate leaked');
  add(qto, ops);
  assert.deepEqual(mirrorOps(boq, qto), [], 'second pass: nothing to do');
  const item = [...boq.byId.values()].find((n) => n.type === 'item')!;
  add(est, [[item.id, 'desc', 'Changed text'], [item.id, 'rate', 999]]);
  const ops2 = mirrorOps(buildModel(est), qto);
  assert.deepEqual(ops2, [['b:' + item.id, 'desc', 'Changed text']], 'a rate change sends nothing');
  add(est, [[item.id, 'del', true]]);
  assert.deepEqual(mirrorOps(buildModel(est), qto), [['b:' + item.id, 'del', true]]);
});

test('take-off quantities flow back into the estimation project (tq) and clear when unlinked', () => {
  const est = storeWith(demoBoqOps());
  const boq = buildModel(est);
  const item = [...boq.byId.values()].find((n) => n.type === 'item')!;
  let ops = takeoffQtyOps(boq, est, new Map([[item.id, 123.45678]]));
  assert.deepEqual(ops, [[item.id, 'tq', 123.45678]], 'every decimal of the measured quantity reaches the estimate');
  add(est, ops);
  // only float noise (another PC adding the shapes in another order) is not a change
  assert.deepEqual(takeoffQtyOps(boq, est, new Map([[item.id, 123.45678 + 1e-13]])), []);
  assert.deepEqual(takeoffQtyOps(boq, est, new Map([[item.id, 123.4568]])), [[item.id, 'tq', 123.4568]]);
  ops = takeoffQtyOps(boq, est, new Map());
  assert.deepEqual(ops, [[item.id, 'tq', null]]);
  const a = attachOps('E1', 'Tower', { id: 'Q1', name: 'Tower take-off', folder: 'Tower-take-off' });
  add(est, a.est);
  assert.deepEqual(attachedQtos(est), [{ id: 'Q1', name: 'Tower take-off', folder: 'Tower-take-off' }]);
});

test('folders: projects can live away from the team folder', () => {
  const s = new Store();
  assert.equal(rootsOf(s, 'S:\\QS').qto, 'S:\\QS');
  add(s, [['user:nabil', 'role', 'admin']]);
  // only an administrator moves the folders
  add(s, setRootsOps({ qto: 'P:\\Elsewhere' }), 'omar');
  assert.equal(rootsOf(s, 'S:\\QS').qto, 'S:\\QS', 'a non-administrator cannot move the take-off folder');
  add(s, setRootsOps({ qto: 'R:\\TakeOff' }));
  assert.equal(rootsOf(s, 'S:\\QS').qto, 'R:\\TakeOff');
  add(s, setRootsOps({ qto: '' }));
  assert.equal(rootsOf(s, 'S:\\QS').qto, 'S:\\QS', 'empty: back to the team folder');
});

// ---------------------------------------------------------------- v0.7: drawing register & revisions, editing shapes
import { revFromFile, issueFromPath, disciplineOf, planImport, newSheetOps, newRevisionOps, markCheckedOps, makeCurrentOps, sheetFromFile, sheetKey } from '../src/engine/qto/revisions';
import { insertVertexOps, deleteVertexOps, replacePointsOps, shapeOps } from '../src/engine/qto/ops';
import { parseTypedLength } from '../src/ui/takeoff/SheetCanvas';

test('revisions: names, revs, issues, disciplines', () => {
  assert.equal(revFromFile('P101-AR-11030-GA L01_Rev C.pdf'), 'Rev C');
  assert.equal(revFromFile('ST-200 Slab R2.pdf'), 'Rev 02');
  assert.equal(revFromFile('AR-100 Ground floor.pdf'), '');
  assert.equal(revFromFile('Room finishes schedule.pdf'), '');
  assert.deepEqual(sheetFromFile('P101-ABC-DWG-AR-11030-GA L01 Tower A_Rev C.pdf'), { sheet: 'AR-11030', title: 'GA L01 Tower A' });
  assert.equal(sheetKey('AR-11030'), sheetKey('ar 11030'));
  assert.deepEqual(sheetFromFile('PBB-AGI-XX-ZZ-M3-AR-MAINCENTRAL-UNITMIXL01-17567357.pdf'), { sheet: '17567357', title: 'UNITMIXL01' });
  assert.deepEqual(sheetFromFile('P101-ABC-DWG-AR-11030-GA L01 Tower A.pdf'), { sheet: 'AR-11030', title: 'GA L01 Tower A' });
  assert.equal(issueFromPath('R:\\Tenders\\T-226\\Received\\260814 PTA 03\\Arch\\PDF\\x.pdf'), '260814 PTA 03');
  assert.equal(issueFromPath('R:\\Tenders\\T-226\\Received\\Addendum 2\\x.pdf'), 'Addendum 2');
  assert.equal(issueFromPath('D:\\Drawings\\Arch\\x.pdf'), '');
  assert.equal(disciplineOf('AR-11030'), 'Architectural');
  assert.equal(disciplineOf('ST-200'), 'Structural');
  assert.equal(disciplineOf('', 'random.pdf'), '');
  assert.equal(disciplineOf('AR-01006', 'P101-ABC-DWG-AR-01006-Area Calculations - L01.pdf'), 'Architectural');
  assert.equal(disciplineOf('', 'Level L01 plan.pdf'), '');
  assert.equal(disciplineOf('', 'ST_slab.pdf'), 'Structural');
});

function revProject() {
  const d = 'dwg:a';
  const s = storeWith([
    [d, 'name', 'AR-100-Ground floor.pdf'], [d, 'path', 'R:\\R\\PTA 01\\AR-100-Ground floor.pdf'], [d, 'hash', 'h1'], [d, 'size', 10], [d, 'mtime', 1], [d, 'pages', 1],
    [d, 'sheet', 'AR-100'], [d, 'title', 'Ground floor'], [d, 'rev', 'Rev A'], [d, 'issue', 'PTA 01'],
    ['ti:1', 'kind', 'area'], ['ti:1', 'name', 'Tiles'], ['ti:1', 'color', '#f00'], ['ti:1', 'ord', 'a0'],
    ['pg:dwg:a.0', 'sc', S100],
    ['sh:old', 'ti', 'ti:1'], ['sh:old', 'dwg', d], ['sh:old', 'pg', 0], ['sh:old', 'k', 'poly'], ['sh:old', 'p', J(sq(0, 0, 4))],
    ['sh:new', 'ti', 'ti:1'], ['sh:new', 'dwg', d], ['sh:new', 'pg', 0], ['sh:new', 'k', 'poly'], ['sh:new', 'p', J(sq(200, 0, 2))], ['sh:new', 'rv', 'h1'],
  ]);
  return s;
}

test('revisions: a new issue is matched by sheet number, old shapes become "to check"', () => {
  const s = revProject();
  let m = buildQtoModel(s, null);
  assert.equal(m.stale.size, 0, 'nothing to check while there is one revision');
  const found = [
    { path: 'R:\\R\\PTA 02\\AR-100-Ground floor_Rev B.pdf', rel: 'PTA 02\\AR-100-Ground floor_Rev B.pdf', size: 11, mtime: 2 },
    { path: 'R:\\R\\PTA 02\\AR-101-First floor.pdf', rel: 'PTA 02\\AR-101-First floor.pdf', size: 12, mtime: 2 },
    { path: 'R:\\R\\PTA 01\\AR-100-Ground floor.pdf', rel: 'x', size: 10, mtime: 1 },
  ];
  const plan = planImport(found, m);
  assert.deepEqual(plan.map((r) => r.action), ['rev', 'new', 'skip']);
  assert.equal(plan[0].target, 'dwg:a');
  assert.equal(plan[0].rev, 'Rev B');
  const ctx = { user: 'qs1', issue: 'PTA 02', unc: () => '', now: 5 };
  add(s, newRevisionOps(m, m.dwgById.get('dwg:a')!, plan[0].file, { ...ctx, rev: plan[0].rev }));
  add(s, newSheetOps(plan[1], ctx).ops);
  m = buildQtoModel(s, null);
  assert.equal(m.drawings.length, 2);
  const d = m.dwgById.get('dwg:a')!;
  assert.equal(d.rev, 'Rev B');
  assert.equal(d.issue, 'PTA 02');
  assert.equal(d.hash, '', 'new file: fingerprint taken when first opened');
  const revs = m.revisions.get('dwg:a')!;
  assert.equal(revs.length, 1);
  assert.equal(revs[0].hash, 'h1');
  assert.equal(revs[0].rev, 'Rev A');
  // the new file is opened: its fingerprint is recorded
  add(s, [['dwg:a', 'hash', 'h2']]);
  m = buildQtoModel(s, null);
  assert.deepEqual([...m.stale].sort(), ['sh:new', 'sh:old']);
  assert.equal(m.staleByDwg.get('dwg:a'), 2);
  // quantities are not touched by a revision
  close(m.shapes.find((x) => x.id === 'sh:old')!.pts.length, 4);
  // checked
  add(s, markCheckedOps(m.shapes.filter((x) => x.id === 'sh:old'), 'h2'));
  m = buildQtoModel(s, null);
  assert.deepEqual([...m.stale], ['sh:new']);
  // a shape drawn on the new revision is not stale
  add(s, shapeOps('ti:1', 'dwg:a', 0, 'poly', [[0, 0], [1, 0], [1, 1]], 'qs1', 1, 'h2').ops);
  m = buildQtoModel(s, null);
  assert.equal(m.stale.size, 1);
  // a re-import of the same issue skips everything
  assert.ok(planImport(found.slice(0, 2), m).every((r) => r.action === 'skip'));
  // going back to Rev A
  add(s, makeCurrentOps(m.dwgById.get('dwg:a')!, m.revisions.get('dwg:a')![0], 'nabil'));
  m = buildQtoModel(s, null);
  assert.equal(m.dwgById.get('dwg:a')!.hash, 'h1');
  assert.equal(m.revisions.get('dwg:a')![0].hash, 'h2');
  assert.deepEqual([...m.stale].sort().length, 2, 'now the shapes checked on Rev B are the ones to check');
});

test('editing shapes: add / delete corners, continue a line, typed lengths', () => {
  const s = revProject();
  let m = buildQtoModel(s, null);
  const sh = m.shapes.find((x) => x.id === 'sh:old')!;
  add(s, insertVertexOps(sh, 0, 0, [50, -10]));
  m = buildQtoModel(s, null);
  const s2 = m.shapes.find((x) => x.id === 'sh:old')!;
  assert.equal(s2.pts.length, 5);
  assert.deepEqual(s2.pts[1], [50, -10]);
  add(s, deleteVertexOps(s2, 0, 1));
  m = buildQtoModel(s, null);
  const s3 = m.shapes.find((x) => x.id === 'sh:old')!;
  assert.equal(s3.pts.length, 4);
  close(m.qty.get('ti:1')!.area, 16 + 4, 0.01);
  const tri = { ...s3, pts: s3.pts.slice(0, 3) };
  assert.deepEqual(deleteVertexOps(tri, 0, 0), [], 'an area keeps at least three corners');
  const line = { ...s3, k: 'line' as const, pts: [[0, 0], [10, 0]] as [number, number][] };
  assert.deepEqual(deleteVertexOps(line, 0, 0), []);
  assert.equal(replacePointsOps(line, [[0, 0], [10, 0], [10, 10]])[0][1], 'p');
  assert.equal(parseTypedLength('4.2'), 4.2);
  assert.equal(parseTypedLength('4200'), 4.2);
  assert.equal(parseTypedLength('4200mm'), 4.2);
  assert.equal(parseTypedLength('420 cm'), 4.2);
  assert.equal(parseTypedLength('12'), 12);
  assert.equal(parseTypedLength('3,5'), 3.5);
  assert.equal(parseTypedLength('abc'), null);
  assert.equal(parseTypedLength('0'), null);
});

// ---------------------------------------------------------------- v0.8: headings tree, arcs, split / join
import { groupHeadingId, headingPath } from '../src/engine/qto/model';
import { moveNodesOps, newHeadingOps, removeHeadingOps, renameHeadingOps } from '../src/engine/qto/headings';
import { newItemOps, setBulgeOps, splitLineOps, splitLineAtOps, explodeLineOps, joinLinesOps, deleteItemOps, bulgesOf } from '../src/engine/qto/ops';
import { TEMPLATES } from '../src/engine/qto/templates';

function treeProject() {
  return storeWith([
    ['ti:a', 'kind', 'area'], ['ti:a', 'name', 'Tiles'], ['ti:a', 'grp', 'Finishes'], ['ti:a', 'ord', 'a0'],
    ['ti:b', 'kind', 'line'], ['ti:b', 'name', 'Skirting'], ['ti:b', 'grp', 'Finishes'], ['ti:b', 'ord', 'a1'],
    ['ti:c', 'kind', 'line'], ['ti:c', 'name', 'Block 200'], ['ti:c', 'grp', 'Masonry'], ['ti:c', 'ord', 'a2'],
    ['ti:d', 'kind', 'count'], ['ti:d', 'name', 'Doors'], ['ti:d', 'ord', 'a3'],
  ]);
}
const names = (m: ReturnType<typeof buildQtoModel>, par = '') => (m.tree.get(par) ?? []).map((n) => (n.t === 'h' ? '#' + m.headingById.get(n.id)!.name : m.itemById.get(n.id)!.name));

test('headings: old groups become headings, drag and drop moves whole subtrees', () => {
  const s = treeProject();
  let m = buildQtoModel(s, null);
  const fin = groupHeadingId('Finishes'), mas = groupHeadingId('Masonry');
  assert.deepEqual(names(m), ['#Finishes', '#Masonry', 'Doors']);
  assert.deepEqual(names(m, fin), ['Tiles', 'Skirting']);
  assert.ok(m.headingById.get(fin)!.virtual);
  assert.equal(groupHeadingId(' finishes '), fin, 'same id on every PC, whatever the case');
  // a subheading in Finishes, Skirting into it
  const sub = newHeadingOps(m.itemTree, 'Tower A', fin);
  add(s, sub.ops);
  m = buildQtoModel(s, null);
  assert.equal(m.headingById.get(fin)!.virtual, false, 'made real when something is put in it');
  add(s, moveNodesOps(m.itemTree, ['ti:b'], { par: sub.id, before: null }));
  m = buildQtoModel(s, null);
  assert.deepEqual(names(m, fin), ['Tiles', '#Tower A']);
  assert.deepEqual(names(m, sub.id), ['Skirting']);
  assert.equal(headingPath(m, m.itemById.get('ti:b')!.par), 'Finishes › Tower A');
  // drag Finishes (with everything under it) under Masonry, before Block 200
  add(s, moveNodesOps(m.itemTree, [fin], { par: mas, before: 'ti:c' }));
  m = buildQtoModel(s, null);
  assert.deepEqual(names(m), ['#Masonry', 'Doors']);
  assert.deepEqual(names(m, mas), ['#Finishes', 'Block 200']);
  assert.equal(headingPath(m, m.itemById.get('ti:b')!.par), 'Masonry › Finishes › Tower A');
  assert.deepEqual(m.items.map((i) => i.name), ['Tiles', 'Skirting', 'Block 200', 'Doors'], 'items listed in tree order');
  // a heading can't go into itself
  assert.deepEqual(moveNodesOps(m.itemTree, [mas], { par: sub.id, before: null }), []);
  // several at once, to the top level end
  add(s, moveNodesOps(m.itemTree, ['ti:c', 'ti:a'], { par: '', before: null }));
  m = buildQtoModel(s, null);
  assert.deepEqual(names(m), ['#Masonry', 'Doors', 'Block 200', 'Tiles']);
  // rename, remove keeping contents, remove with contents
  add(s, renameHeadingOps(m.itemTree, mas, 'Walls'));
  m = buildQtoModel(s, null);
  assert.equal(m.headingById.get(mas)!.name, 'Walls');
  add(s, removeHeadingOps(m.itemTree, fin, false, (ti) => deleteItemOps(m, ti)));
  m = buildQtoModel(s, null);
  assert.deepEqual(names(m, mas), ['#Tower A']);
  add(s, removeHeadingOps(m.itemTree, mas, true, (ti) => deleteItemOps(m, ti)));
  m = buildQtoModel(s, null);
  assert.deepEqual(names(m), ['Doors', 'Block 200', 'Tiles']);
  assert.ok(!m.itemById.has('ti:b'), 'deleted with its heading');
  // a typical take-off goes under the heading of its group
  const t = TEMPLATES[0];
  const r = newItemOps(m, 'qs1', t.kind, t);
  add(s, r.ops);
  m = buildQtoModel(s, null);
  assert.equal(headingPath(m, m.itemById.get(r.id)!.par), t.group);
  const r2 = newItemOps(m, 'qs1', t.kind, t);
  add(s, r2.ops);
  m = buildQtoModel(s, null);
  assert.equal(m.itemById.get(r2.id)!.par, m.itemById.get(r.id)!.par, 'same heading, not a second one');
});

test('arcs: exact lengths and areas, editing keeps them', () => {
  const d = 'dwg:a';
  const R = 3 / S100; // 3 m radius in sheet points
  const s = storeWith([
    ['pg:dwg:a.0', 'sc', S100],
    ['ti:l', 'kind', 'line'], ['ti:l', 'name', 'Curved wall'], ['ti:l', 'ord', 'a0'],
    ['ti:r', 'kind', 'area'], ['ti:r', 'name', 'Round room'], ['ti:r', 'ord', 'a1'],
    // quarter circle radius 3 m, then 2 m straight
    ['sh:l', 'ti', 'ti:l'], ['sh:l', 'dwg', d], ['sh:l', 'pg', 0], ['sh:l', 'k', 'line'], ['sh:l', 'p', J([0, 0, R, R, R, R + 2 / S100])], ['sh:l', 'b', J([Math.tan(Math.PI / 8), 0])],
    // a circle radius 3 m
    ['sh:c', 'ti', 'ti:r'], ['sh:c', 'dwg', d], ['sh:c', 'pg', 0], ['sh:c', 'k', 'poly'], ['sh:c', 'p', J([0, 0, 2 * R, 0])], ['sh:c', 'b', J([1, 1])],
  ]);
  let m = buildQtoModel(s, null);
  close(m.qty.get('ti:l')!.len, (Math.PI * 3) / 2 + 2, 0.005);
  close(m.qty.get('ti:r')!.area, Math.PI * 9, 0.02);
  close(m.qty.get('ti:r')!.perim, Math.PI * 6, 0.005);
  // the arc can be straightened and bent again
  const l = m.shapes.find((x) => x.id === 'sh:l')!;
  add(s, setBulgeOps(l, 0, 0));
  m = buildQtoModel(s, null);
  close(m.qty.get('ti:l')!.len, 3 * Math.SQRT2 + 2, 0.005);
  add(s, setBulgeOps(m.shapes.find((x) => x.id === 'sh:l')!, 0, Math.tan(Math.PI / 8)));
  m = buildQtoModel(s, null);
  // split on the arc: the two parts add up, both still arcs
  const r = splitLineAtOps(m.shapes.find((x) => x.id === 'sh:l')!, 0, [R * 0.3, R * 0.05], 'qs1')!;
  add(s, r.ops);
  m = buildQtoModel(s, null);
  close(m.qty.get('ti:l')!.len, (Math.PI * 3) / 2 + 2, 0.005);
  assert.equal(m.shapesByItem.get('ti:l')!.length, 2);
  // (a split makes two new shapes; the one split is removed)
  assert.ok(!m.shapes.some((x) => x.id === 'sh:l'));
  assert.ok(m.shapes.find((x) => x.id === r.ids[0])!.b[0] !== 0 && m.shapes.find((x) => x.id === r.id)!.b[0] !== 0);
  // and joined back
  const j = joinLinesOps(m.shapes.find((x) => x.id === r.ids[0])!, m.shapes.find((x) => x.id === r.id)!)!;
  add(s, j);
  m = buildQtoModel(s, null);
  assert.equal(m.shapesByItem.get('ti:l')!.length, 1);
  close(m.qty.get('ti:l')!.len, (Math.PI * 3) / 2 + 2, 0.005);
  // corner delete next to an arc: that part becomes straight; insert keeps the arc's halves
  const one = m.shapesByItem.get('ti:l')![0];
  assert.equal(bulgesOf(one).length, one.pts.length - 1);
});

test('split a segmented length into separate lengths; join two that meet', () => {
  const s = storeWith([
    ['pg:dwg:a.0', 'sc', S100],
    ['ti:w', 'kind', 'line'], ['ti:w', 'name', 'Walls'], ['ti:w', 'ord', 'a0'],
    ['sh:w', 'ti', 'ti:w'], ['sh:w', 'dwg', 'dwg:a'], ['sh:w', 'pg', 0], ['sh:w', 'k', 'line'], ['sh:w', 'p', J([0, 0, 100, 0, 100, 50, 0, 50])],
  ]);
  let m = buildQtoModel(s, null);
  const total = m.qty.get('ti:w')!.len;
  const w = m.shapes[0];
  assert.equal(splitLineOps(w, 0, 'x'), null, 'not at an end');
  const a = splitLineOps(w, 1, 'qs1')!;
  add(s, a.ops);
  m = buildQtoModel(s, null);
  assert.equal(m.shapes.length, 2);
  close(m.qty.get('ti:w')!.len, total);
  add(s, joinLinesOps(m.shapes[0], m.shapes[1])!);
  m = buildQtoModel(s, null);
  assert.equal(m.shapes.length, 1);
  assert.equal(m.shapes[0].pts.length, 4);
  const e = explodeLineOps(m.shapes[0], 'qs1');
  add(s, e.ops);
  m = buildQtoModel(s, null);
  assert.equal(m.shapes.length, 3);
  close(m.qty.get('ti:w')!.len, total);
  // a split piece measured as something else
  add(s, [[e.ids[1], 'ti', 'ti:x'], ['ti:x', 'kind', 'line'], ['ti:x', 'name', 'Block 100'], ['ti:x', 'ord', 'a1']]);
  m = buildQtoModel(s, null);
  close(m.qty.get('ti:w')!.len + m.qty.get('ti:x')!.len, total);
  close(m.qty.get('ti:x')!.len, 50 * S100);
});

test('drawing list: folder headings by default, sheets dragged under own headings, sheet-number order', () => {
  const dw = (id: string, sheet: string, grp: string): Op[] => [[id, 'name', sheet + '.pdf'], [id, 'path', 'Y:\\' + sheet + '.pdf'], [id, 'sheet', sheet], [id, 'grp', grp]];
  const s = storeWith([
    ...dw('dwg:1', 'AR-110', '04 Plans › Tower A'), ...dw('dwg:2', 'AR-102', '04 Plans › Tower A'), ...dw('dwg:3', 'AR-200', '04 Plans'),
    ...dw('dwg:4', 'ST-001', ''),
  ]);
  let m = buildQtoModel(s, null);
  const tv = m.dwgTree;
  const nm = (par: string) => (m.dwgTree.tree.get(par) ?? []).map((n) => (n.t === 'h' ? '#' + m.dwgTree.headingById.get(n.id)!.name : m.dwgById.get(n.id)!.sheet));
  assert.deepEqual(nm(''), ['#04 Plans', 'ST-001']);
  const plans = tv.headings[0].id, towA = tv.headings[1].id;
  assert.deepEqual(nm(plans), ['AR-200', '#Tower A'].sort((a, b) => a.replace('#', '').localeCompare(b.replace('#', ''))));
  assert.deepEqual(nm(towA), ['AR-102', 'AR-110'], 'by sheet number until placed by hand');
  // own heading "Typical floors", AR-110 dragged into it, ST-001 before it
  const h = newHeadingOps(m.dwgTree, 'Typical floors');
  add(s, h.ops);
  m = buildQtoModel(s, null);
  add(s, moveNodesOps(m.dwgTree, ['dwg:1'], { par: h.id, before: null }));
  m = buildQtoModel(s, null);
  assert.deepEqual(nm(h.id), ['AR-110']);
  assert.deepEqual(nm(towA), ['AR-102']);
  add(s, moveNodesOps(m.dwgTree, ['dwg:4'], { par: '', before: h.id }));
  m = buildQtoModel(s, null);
  const top = nm('');
  assert.ok(top.indexOf('ST-001') === top.indexOf('#Typical floors') - 1, 'placed right before it: ' + top.join(', '));
  // to the top level: stays there (does not fall back to its folder)
  add(s, moveNodesOps(m.dwgTree, ['dwg:2'], { par: '', before: null }));
  m = buildQtoModel(s, null);
  assert.equal(nm('').at(-1), 'AR-102');
  assert.equal(m.dwgById.get('dwg:2')!.grp, '04 Plans › Tower A', 'the folder is still known (Folder view)');
  // drag the whole "04 Plans" heading into "Typical floors"
  add(s, moveNodesOps(m.dwgTree, [plans], { par: h.id, before: null }));
  m = buildQtoModel(s, null);
  assert.deepEqual(nm(h.id), ['AR-110', '#04 Plans']);
});

// ---------------------------------------------------------------- v0.10 bug hunt
import { removeDummyOps, moveShapesOps, vertexOps } from '../src/engine/qto/ops';
import { clashingTargets, UNKNOWN_RV } from '../src/engine/qto/revisions';
import { selfCrosses, polyInside, polysOverlap, bulgeThrough } from '../src/engine/qto/geometry';

test('fixes: private openings are never deducted from shared take-offs; ×0 is not a factor', () => {
  const s = storeWith([
    ['pg:d1.0', 'sc', S100],
    ['ti:win', 'kind', 'count'], ['ti:win', 'name', 'W'], ['ti:win', 'ow', 1], ['ti:win', 'oh', 1], ['ti:win', 'priv', true], ['ti:win', 'owner', 'qs.one'],
    ['ti:blk', 'kind', 'line'], ['ti:blk', 'name', 'Block'], ['ti:blk', 'h', 3], ['ti:blk', 'ded', J(['ti:win'])], ['ti:blk', 'x', 0],
    ['sh:w', 'ti', 'ti:blk'], ['sh:w', 'dwg', 'd1'], ['sh:w', 'pg', 0], ['sh:w', 'k', 'line'], ['sh:w', 'p', J([0, 0, 10 / S100, 0])], ['sh:w', 'm', 0],
    ['sh:c', 'ti', 'ti:win'], ['sh:c', 'dwg', 'd1'], ['sh:c', 'pg', 0], ['sh:c', 'k', 'pt'], ['sh:c', 'p', J([5, 5])],
  ]);
  for (const who of [{ username: 'qs.one', seeAll: false }, { username: 'qs.two', seeAll: false }]) {
    close(buildQtoModel(s, who).qty.get('ti:blk')!.area, 30); // the same for the owner and for everyone else
  }
});

test('fixes: one take-off linked to a BOQ line twice counts once per measure', () => {
  const s = storeWith([
    ['pg:d1.0', 'sc', S100],
    ['ti:f', 'kind', 'area'], ['ti:f', 'name', 'Floor'],
    ['sh:f', 'ti', 'ti:f'], ['sh:f', 'dwg', 'd1'], ['sh:f', 'pg', 0], ['sh:f', 'k', 'poly'], ['sh:f', 'p', J(sq(0, 0, 10))],
    ['dm:1', 'desc', 'Tiles'], ['dm:1', 'unit', 'm2'], ['dm:1', 'map', 'i7'],
    ['lk:a', 'ti', 'ti:f'], ['lk:a', 'to', 'b:i7'], ['lk:a', 'q', 'area'],
    ['lk:b', 'ti', 'ti:f'], ['lk:b', 'to', 'dm:1'], ['lk:b', 'q', 'area'],
  ]);
  const m = buildQtoModel(s, null);
  close(m.boqQty.get('i7')!.total, 100);
  assert.equal(m.links.find((l) => l.id === 'lk:b')!.dup, true);
});

test('fixes: removing a matched temporary line moves its links onto the BOQ line', () => {
  const s = storeWith([
    ['pg:d1.0', 'sc', S100],
    ['ti:f', 'kind', 'area'], ['ti:f', 'name', 'Floor'],
    ['sh:f', 'ti', 'ti:f'], ['sh:f', 'dwg', 'd1'], ['sh:f', 'pg', 0], ['sh:f', 'k', 'poly'], ['sh:f', 'p', J(sq(0, 0, 10))],
    ['b:i7', 'ref', 'A1'], ['b:i7', 'desc', 'Tiles'], ['b:i7', 'unit', 'm2'], ['b:i7', 'bt', 'item'],
    ['dm:1', 'desc', 'Tiles'], ['dm:1', 'unit', 'm2'], ['dm:1', 'map', 'i7'],
    ['lk:b', 'ti', 'ti:f'], ['lk:b', 'to', 'dm:1'], ['lk:b', 'q', 'area'],
  ]);
  let m = buildQtoModel(s, null);
  assert.ok(m.boqById.has('i7'));
  const r = removeDummyOps(m, 'dm:1');
  assert.equal(r.moved, 1);
  add(s, r.ops);
  m = buildQtoModel(s, null);
  close(m.boqQty.get('i7')!.total, 100);
});

test('fixes: a shape edit writes corners, arcs and cut-outs together', () => {
  const s = storeWith([
    ['ti:a', 'kind', 'area'], ['ti:a', 'name', 'A'],
    ['sh:a', 'ti', 'ti:a'], ['sh:a', 'dwg', 'd'], ['sh:a', 'pg', 0], ['sh:a', 'k', 'poly'], ['sh:a', 'p', J([0, 0, 100, 0, 100, 100, 0, 100])],
    ['sh:a', 'b', J([0, 0.3, 0, 0])], ['sh:a', 'holes', J([[40, 40, 60, 40, 60, 60, 40, 60]])],
  ]);
  const sh = buildQtoModel(s, null).shapes[0];
  for (const ops of [moveShapesOps([sh], 5, 5), vertexOps(sh, 0, 1, [110, 0])]) {
    assert.deepEqual(ops.map((o) => o[1]).sort(), ['b', 'holes', 'p']);
  }
});

test('fixes: cut-out and outline checks; arcs through an end are straight', () => {
  const room: [number, number][] = [[0, 0], [100, 0], [100, 100], [0, 100]];
  assert.equal(selfCrosses(room), false);
  assert.equal(selfCrosses([[0, 0], [100, 100], [100, 0], [0, 100]]), true, 'figure of eight');
  assert.equal(polyInside([[10, 10], [20, 10], [20, 20]], room), true);
  assert.equal(polyInside([[90, 90], [120, 90], [120, 120]], room), false);
  assert.equal(polysOverlap([[10, 10], [30, 10], [30, 30], [10, 30]], [[20, 20], [40, 20], [40, 40], [20, 40]]), true);
  assert.equal(polysOverlap([[10, 10], [20, 10], [20, 20], [10, 20]], [[50, 50], [60, 50], [60, 60]]), false);
  assert.equal(bulgeThrough([0, 0], [10, 0], [0, 0.000001]), 0);
  assert.ok(Number.isFinite(bulgeThrough([0, 0], [10, 0], [9.99, 0.01])));
});

test('fixes: overlapping viewports - the smaller one wins on every PC; joins need the same repeat', () => {
  const mk = (order: string[]) => {
    const ops: Op[] = [];
    const reg: Record<string, Op[]> = {
      'sr:big': [['sr:big', 'dwg', 'd'], ['sr:big', 'pg', 0], ['sr:big', 'r', J([0, 0, 100, 100])], ['sr:big', 'sc', 1], ['sr:big', 'scl', 'big']],
      'sr:small': [['sr:small', 'dwg', 'd'], ['sr:small', 'pg', 0], ['sr:small', 'r', J([10, 10, 20, 20])], ['sr:small', 'sc', 2], ['sr:small', 'scl', 'small']],
    };
    for (const k of order) ops.push(...reg[k]);
    return scaleAt(buildQtoModel(storeWith(ops), null), 'd', 0, [15, 15]).label;
  };
  assert.equal(mk(['sr:big', 'sr:small']), 'small');
  assert.equal(mk(['sr:small', 'sr:big']), 'small');
  const s = storeWith([
    ['ti:l', 'kind', 'line'], ['ti:l', 'name', 'L'],
    ['sh:1', 'ti', 'ti:l'], ['sh:1', 'dwg', 'd'], ['sh:1', 'pg', 0], ['sh:1', 'k', 'line'], ['sh:1', 'p', J([0, 0, 10, 0])], ['sh:1', 'm', 3],
    ['sh:2', 'ti', 'ti:l'], ['sh:2', 'dwg', 'd'], ['sh:2', 'pg', 0], ['sh:2', 'k', 'line'], ['sh:2', 'p', J([10, 0, 20, 0])],
  ]);
  const [a, c] = buildQtoModel(s, null).shapes.sort((x, y) => (x.id < y.id ? -1 : 1));
  assert.equal(joinLinesOps(a, c), null);
});

test('fixes: bringing in drawings - one sheet twice in an issue, the same file twice, two revisions of one sheet', () => {
  const s = revProject();
  const m = buildQtoModel(s, null);
  const found = [
    { path: 'R:\\R\\PTA 03\\AR-100-Ground floor_Rev B.pdf', rel: 'x', size: 11, mtime: 2 },
    { path: 'R:\\R\\PTA 03\\AR-100-Ground floor_Rev C.pdf', rel: 'x', size: 11, mtime: 3 },
    { path: 'R:\\R\\PTA 03\\AR-200-Roof_Rev A.pdf', rel: 'x', size: 11, mtime: 3 },
    { path: 'R:\\R\\PTA 03\\AR-200-Roof_Rev A.pdf', rel: 'x', size: 11, mtime: 3 },
  ];
  const plan = planImport(found, m);
  assert.deepEqual(plan.map((r) => r.action), ['skip', 'rev', 'new', 'skip']);
  assert.equal(plan[1].target, 'dwg:a');
  assert.deepEqual(clashingTargets([{ action: 'rev', target: 'dwg:a' }, { action: 'rev', target: 'dwg:a' }]), ['dwg:a']);
  // shapes that never said which file they were drawn on still get flagged after a revision
  const s2 = revProject();
  add(s2, [['dwg:a', 'hash', null]]);
  const m2 = buildQtoModel(s2, null);
  const ops = newRevisionOps(m2, m2.dwgById.get('dwg:a')!, found[1], { user: 'x', issue: 'PTA 03', unc: () => '', rev: 'Rev C' });
  assert.ok(ops.some((o) => o[0] === 'sh:old' && o[1] === 'rv' && o[2] === UNKNOWN_RV));
});
