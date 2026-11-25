// Regression tests for the v0.10 bug hunt (structure, new issue).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/engine/store';
import { buildModel, flatten } from '../src/engine/boq';
import { movingRows } from '../src/engine/structure';
import { analyseFile, planToOps, tidyFileTitles } from '../src/engine/boqimport';
import { readXlsx } from '../src/engine/xlsx';
import { matchIssue, issueOps } from '../src/engine/revise';
import type { Op } from '../src/engine/types';

let seq = 0;
function apply(st: Store, ops: Op[]) {
  for (let i = 0; i < ops.length; i += 4000) { seq++; st.apply({ s: String(seq).padStart(10, '0'), w: 'w', u: 'T', t: seq, o: ops.slice(i, i + 4000) }); }
  return st;
}
const group = (id: string, parent: string | null, ord: string, desc = id): Op[] => [[id, 'type', 'group'], [id, 'parent', parent], [id, 'ord', ord], [id, 'desc', desc]];
const item = (id: string, parent: string, ord: string, qty: number | null, rate: number | null, extra: Op[] = []): Op[] => [
  [id, 'type', 'item'], [id, 'parent', parent], [id, 'ord', ord], [id, 'desc', id], [id, 'unit', 'm2'], [id, 'qty', qty], [id, 'rate', rate], ...extra,
];

test('structure: two headings moved into each other at once - no endless loop, each row shown once', () => {
  const st = apply(new Store(), [...group('B', null, 'a0'), ...group('A', 'B', 'a0'), ...item('x', 'A', 'a0', 10, 5), ...item('y', 'B', 'a1', 1, 7)]);
  // the clash: A into B (as it was) and B into A
  apply(st, [['B', 'parent', 'A']]);
  const m = buildModel(st);
  const rows = flatten(m, new Set());
  const ids = rows.map((r) => r.node.id);
  assert.equal(new Set(ids).size, ids.length, 'no row twice');
  assert.ok(ids.includes('x') && ids.includes('y'));
  assert.equal(m.items, 2);
  flatten(m, new Set(), 'x');
});

test('structure: rows under an orphaned heading are shown once, counts not doubled', () => {
  const st = apply(new Store(), [...group('G', 'gone', 'a0'), ...group('H', 'G', 'a0'), ...item('i1', 'H', 'a0', 10, 5), ...item('i2', 'H', 'a1', 10, 10)]);
  const m = buildModel(st);
  const rows = flatten(m, new Set());
  assert.equal(rows.length, 1 + 3 + 0 + 1, 'Unfiled, G, H, i1, i2');
  assert.equal(m.items, 2);
  assert.equal(m.byId.get('H')!.items, 2);
});

test('structure: moving rows of a big selection is quick', () => {
  const ops: Op[] = [...group('B', null, 'a0')];
  for (let i = 0; i < 15000; i++) ops.push(...item('i' + i, 'B', 'a' + String(i).padStart(6, '0'), 1, 1));
  const m = buildModel(apply(new Store(), ops));
  const ids = ['B', ...Array.from({ length: 15000 }, (_x, i) => 'i' + i)];
  const t0 = performance.now();
  const mv = movingRows(m, ids);
  const ms = performance.now() - t0;
  assert.equal(mv.length, 1);
  assert.ok(ms < 300, `${ms.toFixed(0)} ms`);
});

test('new issue: sheets pair by bill number, never across towers', { skip: !(process.env.BOQ_SAMPLES && existsSync(join(process.env.BOQ_SAMPLES, 'priced-a'))) && 'samples not present' }, () => {
  const dir = join(process.env.BOQ_SAMPLES ?? '', 'priced-a');
  const pick = (re: RegExp) => readdirSync(dir).filter((n) => re.test(n)).sort().map((n) => analyseFile(n, readXlsx(new Uint8Array(readFileSync(join(dir, n))))));
  const proj = pick(/Bill 0[23]/);
  tidyFileTitles(proj);
  const st = new Store();
  apply(st, planToOps(proj, { withRates: false, groupByFile: true, by: 'T' }, { afterOrd: null, beforeOrd: null }).ops);
  const m = buildModel(st);
  const issue = [...pick(/Bill 04/), ...pick(/Bill 03/)];
  tidyFileTitles(issue);
  const u = matchIssue(m, st, issue);
  const towerB = u.pairs.filter((p) => /Bill 04/.test(p.file));
  assert.ok(towerB.length > 5 && towerB.every((p) => p.bill === null), 'Tower B sheets pair with nothing in a Podium + Tower A project');
  const towerA = u.pairs.filter((p) => /Bill 03/.test(p.file) && p.bill);
  assert.ok(towerA.length > 5);
  const pagesChanged = u.matches.filter((x) => x.pageChanged).length;
  assert.equal(pagesChanged, 0, 'Tower A against itself: nothing changes');
  // update quantities: a typed quantity on a lump sum (no consultant qty) stays
  const lump = [...m.byId.values()].find((n) => n.type === 'item' && n.q0 === null && n.src);
  if (lump) {
    apply(st, [[lump.id, 'qty', 1]]);
    const m2 = buildModel(st);
    const u2 = matchIssue(m2, st, proj);
    const r = issueOps(u2, proj, { refs: true, qty: true, by: 'T' });
    assert.equal(r.qty, 0);
  }
});

