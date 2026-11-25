// v0.16 group b1: drawing tabs (14), bound sets ("binder" PDFs) as a sheet per page (15), Go to sheet (18).
// run: node --import tsx --test tests/v16-b1.test.ts
import './stub-window';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Store } from '../src/engine/store';
import type { Op, Batch, FsApi } from '../src/engine/types';
import { buildQtoModel, filePage, isOldBinder, isPageSheet, sheetTitle, usesPageSheets } from '../src/engine/qto/model';
import { planImport, newSheetOps, newRevisionOps, splitBinderOps, sheetFromPageText, makeCurrentOps, type PageScan, type PageWord } from '../src/engine/qto/revisions';
import { exportQto } from '../src/engine/qto/export';
import { scaleFromRatio } from '../src/engine/qto/geometry';
import { openTab, closeTab, retarget, sheetsOfItem, MAX_TABS, type SheetTab } from '../src/ui/takeoff/Sheets16';
import { ProjectSession } from '../src/engine/session';
import { createProject } from '../src/engine/projects';

const require = createRequire(import.meta.url);
const nodefs: FsApi = require('../electron/nodefs.cjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'gtv16b1-'));
const J = (v: unknown) => JSON.stringify(v);
const S100 = scaleFromRatio(100);
const M = 1 / S100;
let k = 0;
const mk = (o: Op[], w = 'pc1'): Batch => ({ s: String(++k).padStart(12, '0') + '~' + w, w, u: w, t: 0, o, a: w });
const apply = (s: Store, ops: Op[], w = 'pc1') => s.apply(mk(ops, w));
const near = (a: number, b: number, eps = 5e-3) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const f = (p: string, i = 0) => ({ path: p, rel: p.split('\\').pop()!, size: 1000 + i, mtime: 5000 + i });
const ctx = { user: 'QS1', issue: 'PTA 01', unc: () => '', now: 1 };
const w = (t: string, x0: number, y0: number, h = 10): PageWord => ({ t, x0, y0, x1: x0 + t.length * h * 0.6, y1: y0 + h });

// ---------------------------------------------------------------- reading a page's title block
test('sheet number from a page: the code next to "Drawing No.", else the drawing number in the title block; read as a file name is', () => {
  const page = { w: 1000, h: 700 };
  // labelled, in two words, number on the same line
  let r = sheetFromPageText([w('GROUND', 100, 100), w('FLOOR', 160, 100), w('D-01', 300, 300), w('DRAWING', 700, 640), w('NO.', 760, 640), w('P101-ABC-DWG-AR-11030', 800, 640), w('DRAWING', 700, 610), w('TITLE:', 760, 610), w('Ground', 820, 610), w('Floor', 870, 610), w('Plan', 910, 610)], page);
  assert.equal(r.no, 'P101-ABC-DWG-AR-11030');
  assert.equal(r.sheet, 'AR-11030', 'the same sheet number a file of that name gets');
  assert.equal(r.title, 'Ground Floor Plan');
  // labelled, number on the line below
  r = sheetFromPageText([w('DWG', 700, 600), w('NO:', 730, 600), w('A-101', 700, 615), w('B-12', 400, 300)], page);
  assert.equal(r.sheet, 'A-101');
  // no label: the drawing-number-like code in the title block wins over room / door tags and dates elsewhere
  r = sheetFromPageText([w('B-101', 200, 200), w('D-01', 300, 300), w('2026-10-14', 820, 660), w('P04-B1-AR-1001', 820, 650), w('AR-1001', 100, 100)], page);
  assert.equal(r.sheet, 'AR-1001');
  assert.equal(r.pre, 'P04B1');
  // nothing like a drawing number: nothing
  assert.deepEqual(sheetFromPageText([w('D-01', 10, 10), w('L-02', 30, 30), w('1:100', 40, 40), w('KITCHEN', 50, 50)], page).sheet, '');
  assert.equal(sheetFromPageText([], page).sheet, '');
});

// ---------------------------------------------------------------- importing a bound set
const scan3: PageScan = { n: 3, pages: [{ sheet: 'A-101', title: 'Ground floor', pre: '' }, { sheet: '', title: '', pre: '' }, { sheet: 'A-103', title: '', pre: '' }] };
const binderPath = 'S:\\PTA01\\TOWER Architectural Set.pdf';

test('a bound set comes in as a sheet per page: its own row, sheet number and title from its text, else "<file> p.N"', () => {
  const rows = planImport([f(binderPath), f('S:\\PTA01\\A-201 Sections.pdf', 1)], { drawings: [], revisions: new Map() } as any, () => '', new Map([[binderPath, scan3]]));
  assert.deepEqual(rows.map((r) => [r.sheet, r.title, r.fp, r.fpn, r.action]), [
    ['A-101', 'Ground floor', 0, 3, 'new'],
    ['', 'TOWER Architectural Set p.2', 1, 3, 'new'],
    ['A-103', 'TOWER Architectural Set p.3', 2, 3, 'new'],
    ['A-201', 'Sections', undefined, undefined, 'new'],
  ]);
  // without the scan (the file could not be read): one row, as before
  assert.equal(planImport([f(binderPath)], { drawings: [], revisions: new Map() } as any).length, 1);
  const st = new Store();
  const ops = rows.flatMap((r) => newSheetOps(r, ctx).ops);
  assert.ok(usesPageSheets(ops as any), 'marked for the data format bump');
  apply(st, ops);
  const m = buildQtoModel(st, null);
  assert.equal(m.drawings.length, 4);
  const pages = m.drawings.filter(isPageSheet);
  assert.deepEqual(pages.map((d) => [d.fp, d.fpn, d.pages, d.path]), [[0, 3, 1, binderPath], [1, 3, 1, binderPath], [2, 3, 1, binderPath]]);
  assert.equal(new Set(pages.map((d) => d.id)).size, 3, 'an id per page');
  // the same set brought in by someone else at the same time: the same ids (one set of sheets)
  assert.deepEqual(rows.slice(0, 3).map((r) => newSheetOps(r, ctx).id), pages.map((d) => d.id).sort((a, b) => rows.findIndex((r) => newSheetOps(r, ctx).id === a) - rows.findIndex((r) => newSheetOps(r, ctx).id === b)));
  assert.deepEqual(pages.map((d) => filePage(d, 0)), [0, 1, 2], 'each shows its page of the file');
  assert.equal(sheetTitle(pages[1]), 'TOWER Architectural Set p.2');
  // nothing about them is an old multi-page drawing
  assert.ok(!m.drawings.some(isOldBinder));
  // brought in again: left out whole
  assert.deepEqual(planImport([f(binderPath)], m, () => '', new Map([[binderPath, scan3]])).map((r) => r.action), ['skip']);
});

test('a later bound set: its pages find their sheets by sheet number, else by position when it has as many pages; a single PDF can be a page\'s next revision', () => {
  const st = new Store();
  apply(st, planImport([f(binderPath)], { drawings: [], revisions: new Map() } as any, () => '', new Map([[binderPath, scan3]])).flatMap((r) => newSheetOps(r, ctx).ops));
  let m = buildQtoModel(st, null);
  const byFp = (fp: number) => m.drawings.find((d) => d.fp === fp)!.id;
  // Rev B of the set, pages reordered: A-103 first; page 2 has no number either (the same page)
  const revB = 'S:\\PTA02\\TOWER Architectural Set Rev B.pdf';
  const scanB: PageScan = { n: 3, pages: [{ sheet: 'A-103', title: '', pre: '' }, { sheet: '', title: '', pre: '' }, { sheet: 'A-101', title: '', pre: '' }] };
  const rows = planImport([f(revB, 2)], m, () => '', new Map([[revB, scanB]]));
  assert.deepEqual(rows.map((r) => [r.fp, r.action, r.target]), [[0, 'rev', byFp(2)], [1, 'rev', byFp(1)], [2, 'rev', byFp(0)]]);
  // another page count, page without a number: a new sheet (nothing to go by)
  const scan4: PageScan = { n: 4, pages: [{ sheet: 'A-101', title: '', pre: '' }, { sheet: '', title: '', pre: '' }, { sheet: '', title: '', pre: '' }, { sheet: '', title: '', pre: '' }] };
  const rows4 = planImport([f(revB, 2)], m, () => '', new Map([[revB, scan4]]));
  assert.deepEqual(rows4.map((r) => r.action), ['rev', 'new', 'new', 'new']);
  // the revision taken: page 3 of Rev B is now A-101's file; the earlier one kept, with its page
  const a101 = m.dwgById.get(byFp(0))!;
  const shapeOps: Op[] = [['ti:a', 'kind', 'area'], ['ti:a', 'name', 'Floor'], ['pg:' + a101.id + '.0', 'sc', S100], ['sh:1', 'ti', 'ti:a'], ['sh:1', 'dwg', a101.id], ['sh:1', 'pg', 0], ['sh:1', 'k', 'poly'], ['sh:1', 'p', J([0, 0, 10 * M, 0, 10 * M, 10 * M, 0, 10 * M])], ['sh:1', 'rv', 'h-old']];
  apply(st, [...shapeOps, [a101.id, 'hash', 'h-old']]);
  m = buildQtoModel(st, null);
  apply(st, rows.flatMap((r) => (r.action === 'rev' ? newRevisionOps(m, m.dwgById.get(r.target!)!, { ...r.file, name: r.name, fp: r.fp, fpn: r.fpn }, { ...ctx, rev: 'Rev B' }) : [])));
  m = buildQtoModel(st, null);
  const now = m.dwgById.get(a101.id)!;
  assert.deepEqual([now.fp, now.fpn, now.pages, now.path], [2, 3, 1, revB]);
  const was = m.revisions.get(a101.id)![0];
  assert.deepEqual([was.fp, was.path], [0, binderPath]);
  near(m.qty.get('ti:a')!.area, 100);
  // (opened: its fingerprint known) measured on the earlier revision: to check
  apply(st, [[a101.id, 'hash', 'h-new']]);
  m = buildQtoModel(st, null);
  assert.ok(m.stale.has('sh:1'), 'measured on the earlier revision: to check');
  // a single PDF of A-101 later: the page's next revision, no longer a page of a set
  const single = 'S:\\PTA03\\A-101_Rev C.pdf';
  const r1 = planImport([f(single, 3)], m, () => '');
  assert.deepEqual([r1[0].action, r1[0].target], ['rev', a101.id]);
  apply(st, newRevisionOps(m, m.dwgById.get(a101.id)!, { ...r1[0].file, name: r1[0].name, fp: r1[0].fp, fpn: r1[0].fpn }, { ...ctx, rev: 'Rev C', now: 5 }));
  m = buildQtoModel(st, null);
  assert.deepEqual([m.dwgById.get(a101.id)!.fp, m.dwgById.get(a101.id)!.path], [undefined, single]);
  assert.deepEqual(m.revisions.get(a101.id)!.map((r) => r.fp), [2, 0], 'its earlier revisions keep their pages');
  // and back: Rev B (page 3 of that set) made current again
  apply(st, makeCurrentOps(m.dwgById.get(a101.id)!, m.revisions.get(a101.id)![0], 'QS1', 9));
  m = buildQtoModel(st, null);
  assert.deepEqual([m.dwgById.get(a101.id)!.fp, m.dwgById.get(a101.id)!.path, m.dwgById.get(a101.id)!.pages], [2, revB, 1]);
});

// ---------------------------------------------------------------- splitting a drawing measured before 0.16
function oldBinder(): Op[] {
  const d = 'dwg:old';
  const sq = (x: number) => J([x, 0, x + 10 * M, 0, x + 10 * M, 10 * M, x, 10 * M]);
  return [
    [d, 'name', 'Set.pdf'], [d, 'path', 'S:\\Set.pdf'], [d, 'hash', 'h2'], [d, 'size', 5], [d, 'mtime', 6], [d, 'pages', 3], [d, 'title', 'Arch set'], [d, 'grp', 'PTA'],
    ['rv:r1', 'dwg', d], ['rv:r1', 'path', 'S:\\Set old.pdf'], ['rv:r1', 'name', 'Set old.pdf'], ['rv:r1', 'hash', 'h1'], ['rv:r1', 'pages', 4], ['rv:r1', 'superseded', 2],
    ['pg:' + d + '.0', 'sc', S100], ['pg:' + d + '.0', 'scl', '1:100'], ['pg:' + d + '.1', 'sc', S100 * 2], ['pg:' + d + '.1', 'scl', '1:200'], ['pg:' + d + '.2', 'sc', S100],
    ['ti:a', 'kind', 'area'], ['ti:a', 'name', 'Floor'], ['ti:c', 'kind', 'count'], ['ti:c', 'name', 'Doors'],
    ['sh:p0', 'ti', 'ti:a'], ['sh:p0', 'dwg', d], ['sh:p0', 'pg', 0], ['sh:p0', 'k', 'poly'], ['sh:p0', 'p', sq(0)], ['sh:p0', 'rv', 'h2'],
    ['sh:p1', 'ti', 'ti:a'], ['sh:p1', 'dwg', d], ['sh:p1', 'pg', 1], ['sh:p1', 'k', 'poly'], ['sh:p1', 'p', sq(0)], ['sh:p1', 'rv', 'h1'],
    ['sh:p2', 'ti', 'ti:a'], ['sh:p2', 'dwg', d], ['sh:p2', 'pg', 2], ['sh:p2', 'k', 'poly'], ['sh:p2', 'p', sq(0)], ['sh:p2', 'rv', 'h2'], ['sh:p2', 'opg', 3],
    ['sh:c1', 'ti', 'ti:c'], ['sh:c1', 'dwg', d], ['sh:c1', 'pg', 1], ['sh:c1', 'k', 'pt'], ['sh:c1', 'p', J([5, 5])],
    // off the page: page 4 of the earlier revision, which had 4
    ['sh:off', 'ti', 'ti:a'], ['sh:off', 'dwg', d], ['sh:off', 'pg', 3], ['sh:off', 'k', 'poly'], ['sh:off', 'p', sq(0)], ['sh:off', 'rv', 'h1'],
    // deleted (an undo of its delete must bring it back onto its page)
    ['sh:gone', 'ti', 'ti:a'], ['sh:gone', 'dwg', d], ['sh:gone', 'pg', 2], ['sh:gone', 'k', 'poly'], ['sh:gone', 'p', sq(0)], ['sh:gone', 'del', true],
    ['sr:v', 'dwg', d], ['sr:v', 'pg', 1], ['sr:v', 'r', J([0, 0, 50, 50])], ['sr:v', 'sc', S100], ['sr:v', 'scl', '1:100'],
    ['nt:n', 'text', 'check this'], ['nt:n', 'on', 'ti:a'], ['nt:n', 'dwg', d], ['nt:n', 'pg', 2], ['nt:n', 'x', 10], ['nt:n', 'y', 10], ['nt:n', 'by', 'QS1'], ['nt:n', 't', 1],
  ];
}

test('Split into separate sheets: everything goes with its page, nothing counted differently, nothing lost', () => {
  const st = new Store();
  apply(st, oldBinder());
  const m0 = buildQtoModel(st, null);
  assert.ok(isOldBinder(m0.dwgById.get('dwg:old')!));
  const qa = m0.qty.get('ti:a')!.area, qc = m0.qty.get('ti:c')!.cnt;
  const r = splitBinderOps(st, m0, m0.dwgById.get('dwg:old')!, [{ sheet: 'A-101', title: 'Ground floor' }, null, { sheet: 'A-103', title: '' }], 'QS1', 7);
  assert.equal(r.ids.length, 3);
  assert.ok(usesPageSheets(r.ops as any));
  apply(st, r.ops);
  const m = buildQtoModel(st, null);
  assert.ok(!m.dwgById.has('dwg:old'), 'the drawing itself is gone from the list');
  const [a, b, c] = r.ids.map((id) => m.dwgById.get(id)!);
  assert.deepEqual([a, b, c].map((d) => [d.fp, d.fpn, d.pages, d.path, d.hash, d.grp]), [[0, 3, 1, 'S:\\Set.pdf', 'h2', 'PTA'], [1, 3, 1, 'S:\\Set.pdf', 'h2', 'PTA'], [2, 3, 1, 'S:\\Set.pdf', 'h2', 'PTA']]);
  assert.deepEqual([a, b, c].map((d) => [d.sheet, sheetTitle(d)]), [['A-101', 'Ground floor'], ['', 'Arch set p.2'], ['A-103', 'Arch set p.3']]);
  // quantities: the same (each page kept its own scale)
  near(m.qty.get('ti:a')!.area, qa);
  assert.equal(m.qty.get('ti:c')!.cnt, qc);
  const on = (id: string) => m.shapes.find((s) => s.id === id)!;
  assert.deepEqual([on('sh:p0').dwg, on('sh:p0').pg, on('sh:p1').dwg, on('sh:c1').dwg, on('sh:p2').dwg], [a.id, 0, b.id, b.id, c.id]);
  assert.equal(m.pages.get(b.id + '.0')!.scl, '1:200');
  assert.deepEqual(m.regions.map((x) => [x.dwg, x.pg]), [[b.id, 0]]);
  assert.deepEqual(m.notes.map((n) => [n.dwg, n.pg]), [[c.id, 0]]);
  // to check: the same shapes as before
  assert.deepEqual([...m.stale].sort(), [...m0.stale].sort());
  // off the page: still reported, on the last sheet, as many pages on (so "See them on" shows page 4 of the earlier file)
  assert.equal(m.offPage.get(c.id), 1);
  const off = m.offPageShapes.get(c.id)![0];
  assert.equal(filePage(m.revisions.get(c.id)![0], off.pg), 3);
  // measured on page 4 of the earlier revision, moved onto page 3: Compare still shows page 4
  assert.equal(filePage(m.revisions.get(c.id)![0], on('sh:p2').opg!), 3);
  // earlier revisions: each page has its page of it
  assert.deepEqual(r.ids.map((id) => m.revisions.get(id)!.map((x) => [x.fp, x.hash, x.path])), [[[0, 'h1', 'S:\\Set old.pdf']], [[1, 'h1', 'S:\\Set old.pdf']], [[2, 'h1', 'S:\\Set old.pdf']]]);
  // the deleted shape went with its page (undoing its delete brings it back there)
  assert.equal(st.get('sh:gone', 'dwg'), c.id);
  // Excel export: by sheet, with the page sheets' names
  const x = exportQto(m, { project: 'P', by: 'QS1' });
  assert.ok(x.length > 1000);
  // what is measured on each sheet ("Go to sheet")
  // (in the drawing list's order: by sheet number, as separate sheets are - "A-101", "A-103", then "Arch set p.2")
  assert.deepEqual(sheetsOfItem(m, 'ti:a').map((s) => [s.dwg, s.ids.length]), [[a.id, 1], [c.id, 1], [b.id, 1]]);
  near(sheetsOfItem(m, 'ti:a').reduce((t, s) => t + s.v, 0), qa);
});

test('Split into separate sheets is one undo step: everything back as it was; redo splits again', async () => {
  const { dir } = await createProject(nodefs, tmp(), 'Split binder', 'QS1', 'PC1', oldBinder(), undefined, 'takeoff');
  const s = new ProjectSession({ fs: nodefs, localFs: nodefs, projectDir: dir, localDir: tmp(), user: 'QS1', host: 'PC-1', pollMs: 60000, fullScanMs: 0, heartbeatMs: 60000 });
  await s.open();
  const values = () => {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [id, ent] of s.store.ents) { const o: Record<string, unknown> = {}; for (const [kk, c] of ent) if (c.v !== null && c.v !== undefined) o[kk] = c.v; if (Object.keys(o).length) out[id] = o; }
    return out;
  };
  const before = values();
  const m0 = buildQtoModel(s.store, null);
  const r = splitBinderOps(s.store, m0, m0.dwgById.get('dwg:old')!, [], 'QS1');
  s.commit(r.ops, 'Split into separate sheets');
  assert.equal(buildQtoModel(s.store, null).drawings.length, 3);
  s.undo();
  const m1 = buildQtoModel(s.store, null);
  assert.deepEqual(m1.drawings.map((d) => d.id), ['dwg:old']);
  const after = values();
  // (what the split made is in the bin: no values left on it)
  for (const id of Object.keys(after)) if (!(id in before)) assert.ok(after[id].del === true || Object.keys(after[id]).every((kk) => kk === 'del'), 'left over: ' + id + ' ' + J(after[id]));
  for (const id of Object.keys(before)) assert.deepEqual(after[id], before[id], id);
  near(m1.qty.get('ti:a')!.area, m0.qty.get('ti:a')!.area);
  s.redo();
  assert.equal(buildQtoModel(s.store, null).drawings.length, 3);
  await s.close();
});

test('a page sheet: one page, its shapes at page 0, a shape left past it is off the page; a 0.15 multi-page drawing is unchanged', () => {
  const st = new Store();
  apply(st, [['dwg:p', 'name', 'Set.pdf'], ['dwg:p', 'path', 'S:\\Set.pdf'], ['dwg:p', 'fp', 4], ['dwg:p', 'fpn', 9], ['dwg:p', 'pages', 9], ['pg:dwg:p.0', 'sc', S100],
    ['dwg:o', 'name', 'Old.pdf'], ['dwg:o', 'path', 'S:\\Old.pdf'], ['dwg:o', 'pages', 5],
    ['ti:l', 'kind', 'line'], ['ti:l', 'name', 'Skirting'],
    ['sh:a', 'ti', 'ti:l'], ['sh:a', 'dwg', 'dwg:p'], ['sh:a', 'pg', 0], ['sh:a', 'k', 'line'], ['sh:a', 'p', J([0, 0, 4 * M, 0])],
    ['sh:b', 'ti', 'ti:l'], ['sh:b', 'dwg', 'dwg:p'], ['sh:b', 'pg', 1], ['sh:b', 'k', 'line'], ['sh:b', 'p', J([0, 0, 4 * M, 0])]]);
  const m = buildQtoModel(st, null);
  const p = m.dwgById.get('dwg:p')!;
  assert.deepEqual([p.pages, p.fp, filePage(p, 0)], [1, 4, 4], 'a sheet of one page, whatever "pages" says');
  near(m.qty.get('ti:l')!.len, 4);
  assert.equal(m.offPage.get('dwg:p'), 1);
  const o = m.dwgById.get('dwg:o')!;
  assert.ok(isOldBinder(o) && !isPageSheet(o));
  assert.deepEqual([o.pages, filePage(o, 3)], [5, 3]);
});

// ---------------------------------------------------------------- tabs
test('tabs: a sheet opens in its tab, else a new one; the 11th closes the one used longest ago; closing comes back to the last used', () => {
  let n = 0;
  const id = () => 't' + ++n;
  let st = { tabs: [] as SheetTab[], used: [] as string[], cur: null as string | null };
  const open = (dwg: string, pg = 0) => { const r = openTab(st.tabs, st.used, { dwg, pg }, id); st = { ...r }; };
  for (let i = 1; i <= MAX_TABS; i++) open('dwg:' + i);
  assert.equal(st.tabs.length, 10);
  open('dwg:3'); // used again
  assert.equal(st.tabs.length, 10);
  assert.equal(st.cur, 't3');
  open('dwg:11');
  assert.equal(st.tabs.length, 10);
  assert.ok(!st.tabs.some((t) => t.dwg === 'dwg:1'), 'the one used longest ago closed');
  assert.ok(st.tabs.some((t) => t.dwg === 'dwg:3'));
  // closing the current tab: the one used just before it comes up
  open('dwg:5');
  const c = closeTab(st.tabs, st.used, st.cur!, st.cur);
  assert.equal(c.tabs.find((t) => t.id === c.cur)!.dwg, 'dwg:11');
  // closing another: the current stays
  const c2 = closeTab(st.tabs, st.used, 't2', st.cur);
  assert.equal(c2.cur, st.cur);
  // PgUp / PgDn: the tab moves on
  assert.deepEqual(retarget(st.tabs, st.cur!, { dwg: 'dwg:x', pg: 2 }).find((t) => t.id === st.cur)!, { id: st.cur!, dwg: 'dwg:x', pg: 2 });
  // the last one closed: nothing
  const one = openTab([], [], { dwg: 'dwg:a', pg: 0 }, id);
  assert.equal(closeTab(one.tabs, one.used, one.cur, one.cur).cur, null);
});

// 0.23.1 (PC check: an 870 MB set's sheets were all titled with the project's name)
test('page title: "Drawing title" wins over "Job title"; a title of a few lines, in reading order', () => {
  const page = { w: 2384, h: 1684 };
  // a 4 pt label, 7-9 pt lines whose words' tops differ by a point, centred (left edges differ)
  const words: PageWord[] = [
    w('JOB', 2174, 1436, 4), w('TITLE', 2187, 1436, 4), w(':', 2206, 1437, 3),
    w('NORTH', 2204, 1450, 7), w('HARBOUR', 2236, 1449, 7), w('HOMES', 2280, 1449, 7), w('AT', 2316, 1450, 7),
    w('SAMPLE', 2196, 1461, 7), w('BAY', 2236, 1460, 8),
    w('DRAWING', 2174, 1504, 4), w('TITLE', 2204, 1504, 4), w(':', 2222, 1505, 3),
    w('GROUND', 2206, 1515, 9), w('FLOOR', 2246, 1516, 9), w('PLAN', 2290, 1515, 8),
    w('VILLA', 2194, 1529, 9), w('TYPE', 2226, 1530, 8), w('-RED', 2256, 1529, 8), w('DUNE', 2306, 1529, 9),
    w('PLOT-A', 2239, 1543, 9),
    w('PROJECT', 2174, 1571, 4), w('NO.', 2203, 1571, 4),
    w('Drawing', 2174, 1618, 6), w('No', 2197, 1618, 4), w(':', 2207, 1619, 3), w('Ab-101', 2224, 1635, 8),
  ];
  const r = sheetFromPageText(words, page);
  assert.equal(r.title, 'GROUND FLOOR PLAN VILLA TYPE -RED DUNE PLOT-A');
  // only a "Job title" on the page: not taken for the sheet's title
  assert.equal(sheetFromPageText(words.filter((x) => x.y0 < 1500 || x.y0 > 1560), page).title, '');
  // a bare "Title" label still is
  assert.equal(sheetFromPageText([w('TITLE', 700, 600, 6), w('Section', 700, 610), w('A-A', 760, 610), w('DWG', 700, 640), w('NO', 730, 640), w('S-201', 760, 640)], { w: 1000, h: 700 }).title, 'Section A-A');
});
