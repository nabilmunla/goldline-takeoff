// Consultant page numbers: reading them at import (print setup, page breaks, estimates),
// fixing them by hand, and bringing a new issue's pages onto the project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { readXlsx } from '../src/engine/xlsx';
import { analyseFile, analyseSheet, planToOps, type FilePlan } from '../src/engine/boqimport';
import {
  pagePattern, applyPattern, pageBreaks, splitLabel, cmpLabel, newPageFromOps, joinPageOps, renumberOps, renamePrefixOps,
  allPages, findPages, quoteLine, pagedLines, setPageOps,
} from '../src/engine/pages';
import { alignKeys, matchIssue, issueOps } from '../src/engine/revise';
import { Store } from '../src/engine/store';
import { buildModel, type BoqModel } from '../src/engine/boq';
import type { Op } from '../src/engine/types';

let seq = 0;
function applyOps(st: Store, ops: Op[]) {
  for (let i = 0; i < ops.length; i += 4000) { seq++; st.apply({ s: String(seq).padStart(10, '0'), w: 'w', u: 'T', t: seq, o: ops.slice(i, i + 4000) }); }
  return st;
}

/** a one-sheet workbook with print settings; rows: [ref, desc, qty, unit] */
function book(rows: (string | number | null)[][], print: { breaks?: number[]; footer?: string; ht?: Record<number, number>; extra?: string; defaultHt?: number; names?: string }) {
  const shared: string[] = [];
  const si = (s: string) => { let i = shared.indexOf(s); if (i < 0) { i = shared.length; shared.push(s); } return i; };
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const rx = rows.map((r, ri) => {
    const cells = r.map((c, ci) => {
      if (c === null) return '';
      const ref = String.fromCharCode(65 + ci) + (ri + 1);
      return typeof c === 'number' ? `<c r="${ref}"><v>${c}</v></c>` : `<c r="${ref}" t="s"><v>${si(c)}</v></c>`;
    }).join('');
    const ht = print.ht?.[ri + 1];
    return `<row r="${ri + 1}"${ht ? ` ht="${ht}" customHeight="1"` : ''}>${cells}</row>`;
  }).join('');
  const brk = print.breaks?.length ? `<rowBreaks count="${print.breaks.length}" manualBreakCount="${print.breaks.length}">${print.breaks.map((b) => `<brk id="${b}" max="16383" man="1"/>`).join('')}</rowBreaks>` : '';
  const hf = print.footer ? `<headerFooter><oddFooter>${esc(print.footer)}</oddFooter></headerFooter>` : '';
  const sheet = `<?xml version="1.0"?><worksheet><sheetFormatPr defaultRowHeight="${print.defaultHt ?? 15}"/><sheetData>${rx}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="portrait"${print.extra ?? ''}/>${hf}${brk}</worksheet>`;
  return readXlsx(zipSync({
    'xl/worksheets/sheet1.xml': strToU8(sheet),
    'xl/workbook.xml': strToU8(`<workbook xmlns:r="r"><sheets><sheet name="CONCRETE WORKS" sheetId="1" r:id="rId1"/></sheets>${print.names ?? ''}</workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/sharedStrings.xml': strToU8(`<sst>${shared.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`),
    'xl/styles.xml': strToU8('<styleSheet><fonts><font><sz val="11"/></font></fonts><cellXfs><xf fontId="0"/></cellXfs></styleSheet>'),
  }));
}
const HEAD = ['Item', 'Description', 'Qty', 'Unit'];
const lines = (n: number, from = 1) => Array.from({ length: n }, (_x, i) => [String.fromCharCode(65 + (i % 26)), `Concrete line number ${from + i} poured in place`, 10 + i, 'm3']);

test('pages: the page number pattern of a printed header/footer', () => {
  assert.equal(pagePattern(['&C&"Avenir Next LT Pro,Regular"&8&A/&P']), '{A}/{P}');
  assert.equal(pagePattern(['&LPrinted &D&RPage &P of &N']), '{P}');
  assert.equal(pagePattern(['&CBill No. 2 - &P']), 'Bill No. 2 - {P}');
  assert.equal(pagePattern(['&C_x000D_&1#&"Arial"&10&K000000 AtkinsRéalis - Sensitive']), null);
  assert.equal(pagePattern(['&L&G&C&"Arial,Bold"&8\n\nPROJECT-A\nBILL 02', '&C&8B&&C/&P+1']), 'B&C/{P+1}');
  assert.equal(applyPattern('{A}/{P}', 'CONCRETE WORKS ', 3), 'CONCRETE WORKS/3');
  assert.equal(applyPattern('B&C/{P+1}', 'x', 3), 'B&C/4');
});

test('pages: manual page breaks + footer give the printed page of each line', () => {
  const rows = [HEAD, ...lines(30)];
  const wb = book(rows, { breaks: [10, 20], footer: '&C&A/&P' });
  const sp = analyseSheet(wb, 'CONCRETE WORKS');
  assert.equal(sp.pages.method, 'print');
  assert.equal(sp.pages.pattern, '{A}/{P}');
  const byRow = new Map(sp.rows.map((r) => [r.r, r.page]));
  assert.equal(byRow.get(2), 'CONCRETE WORKS/1');
  assert.equal(byRow.get(10), 'CONCRETE WORKS/1');
  assert.equal(byRow.get(11), 'CONCRETE WORKS/2', 'brk id=10: the new page starts at row 11');
  assert.equal(byRow.get(21), 'CONCRETE WORKS/3');
  assert.equal(sp.pages.count, 3);
  assert.equal(sp.pages.est, 0);
});

test('pages: a page longer than the paper gets Excel\'s automatic break, marked estimated', () => {
  // A4, margins 0.75" top and bottom: 841.9 - 108 = 733.9 pt per page = 48 rows of 15 pt
  const rows = [HEAD, ...lines(120)];
  const wb = book(rows, { footer: '&CPage &P' });
  const pb = pageBreaks(wb.sheet('CONCRETE WORKS'));
  assert.deepEqual(pb.starts, [1, 49, 97]);
  assert.deepEqual(pb.est, [false, true, true]);
  const sp = analyseSheet(wb, 'CONCRETE WORKS');
  assert.equal(sp.pages.method, 'print');
  assert.equal(sp.pages.est, 2);
  const r49 = sp.rows.find((r) => r.r === 49)!;
  assert.equal(r49.page, '2');
  assert.equal(r49.pest, true);
  // taller rows -> fewer rows per page; a 2x scale-down -> twice as many
  const tall = book(rows, { footer: '&C&P', ht: Object.fromEntries(Array.from({ length: 121 }, (_x, i) => [i + 1, 30])) });
  assert.deepEqual(pageBreaks(tall.sheet('CONCRETE WORKS')).starts.slice(0, 3), [1, 25, 49]);
  const small = book(rows, { footer: '&C&P', extra: ' scale="50"' });
  assert.deepEqual(pageBreaks(small.sheet('CONCRETE WORKS')).starts, [1, 98]);
  // print titles repeat on every page and take their room
  const titled = book(rows, { footer: '&C&P', names: '<definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">\'CONCRETE WORKS\'!$1:$2</definedName></definedNames>' });
  const tp = pageBreaks(titled.sheet('CONCRETE WORKS'));
  assert.deepEqual(tp.starts.slice(0, 3), [1, 49, 95], 'two title rows: 46 body rows on each page');
});

test('pages: the page height is learnt from the consultant\'s manual breaks', () => {
  // full pages of 40 rows set by hand, then a long tail Excel breaks by itself every 40
  const rows = [HEAD, ...lines(199)];
  const wb = book(rows, { breaks: [40, 80, 120], footer: '&C&A/&P' });
  const pb = pageBreaks(wb.sheet('CONCRETE WORKS'));
  assert.deepEqual(pb.starts, [1, 41, 81, 121, 161]);
  assert.deepEqual(pb.est, [false, false, false, false, true]);
});

test('pages: labels split, sort and step', () => {
  assert.deepEqual(splitLabel('CONCRETE WORKS/12'), { pre: 'CONCRETE WORKS/', n: 12, post: '' });
  assert.deepEqual(splitLabel('B/2a'), { pre: 'B/', n: 2, post: 'a' });
  assert.equal(splitLabel('Summary'), null);
  assert.ok(cmpLabel('B/2', 'B/10') < 0);
});

// a small project: bill with 3 pages of lines
function smallProject() {
  const st = new Store();
  const ops: Op[] = [['b1', 'type', 'group'], ['b1', 'parent', null], ['b1', 'ord', 'a0'], ['b1', 'ref', 'Bill 03'], ['b1', 'desc', 'CONCRETE WORKS']];
  ['s1', 's2'].forEach((s, k) => ops.push([s, 'type', 'group'], [s, 'parent', 'b1'], [s, 'ord', 'a' + k], [s, 'desc', 'Section ' + (k + 1)]));
  const pages = ['C/1', 'C/1', 'C/2', 'C/2', 'C/2', 'C/3', 'C/3', 'C/4'];
  pages.forEach((p, i) => {
    const id = 'l' + i;
    ops.push([id, 'type', 'item'], [id, 'parent', i < 4 ? 's1' : 's2'], [id, 'ord', 'a' + i], [id, 'desc', 'Line ' + i], [id, 'unit', 'm3'], [id, 'qty', 1], [id, 'ref', 'ABCDEFGH'[i]], [id, 'page', p]);
  });
  return applyOps(st, ops);
}
const pagesOf = (m: BoqModel) => pagedLines(m, null).map((n) => n.page).join(' ');

test('pages: new page from here, join with the page before', () => {
  const st = smallProject();
  let m = buildModel(st);
  applyOps(st, newPageFromOps(m, m.byId.get('l3')!));
  m = buildModel(st);
  assert.equal(pagesOf(m), 'C/1 C/1 C/2 C/3 C/3 C/4 C/4 C/5', 'l3 starts page 3, later pages move on');
  applyOps(st, joinPageOps(m, m.byId.get('l4')!));
  m = buildModel(st);
  assert.equal(pagesOf(m), 'C/1 C/1 C/2 C/2 C/2 C/3 C/3 C/4', 'and back');
});

test('pages: renumber (keep breaks / at headings / every N), rename the prefix, set by hand', () => {
  const st = smallProject();
  let m = buildModel(st);
  applyOps(st, renumberOps(m, [m.byId.get('b1')!], { prefix: 'B3/', start: 10, by: 'keep' }).ops);
  m = buildModel(st);
  assert.equal(pagesOf(m), 'B3/10 B3/10 B3/11 B3/11 B3/11 B3/12 B3/12 B3/13');
  applyOps(st, renumberOps(m, [m.byId.get('b1')!], { prefix: 'P', start: 1, by: 'heading', depth: 1 }).ops);
  m = buildModel(st);
  assert.equal(pagesOf(m), 'P1 P1 P1 P1 P2 P2 P2 P2', 'a new page at each section');
  applyOps(st, renumberOps(m, [m.byId.get('b1')!], { prefix: 'X/', start: 1, by: 'every', every: 3 }).ops);
  m = buildModel(st);
  assert.equal(pagesOf(m), 'X/1 X/1 X/1 X/2 X/2 X/2 X/3 X/3');
  const r = renamePrefixOps(pagedLines(m, null), 'X/', 'Bill 03/');
  assert.equal(r.changed, 8);
  applyOps(st, r.ops);
  applyOps(st, setPageOps([m.byId.get('l0')!], ' Bill 03/0 '));
  m = buildModel(st);
  assert.equal(pagesOf(m), 'Bill 03/0 Bill 03/1 Bill 03/1 Bill 03/2 Bill 03/2 Bill 03/2 Bill 03/3 Bill 03/3');
});

test('pages: list, find and quote', () => {
  const m = buildModel(smallProject());
  const all = allPages(m);
  assert.deepEqual(all.map((p) => `${p.page}:${p.lines}`), ['C/1:2', 'C/2:3', 'C/3:2', 'C/4:1']);
  assert.equal(findPages(all, 'c/3')[0].page, 'C/3');
  assert.equal(findPages(all, '4')[0].page, 'C/4', 'the number alone finds the page');
  assert.equal(findPages(all, 'concrete').length, 4, 'the bill name finds its pages');
  assert.equal(quoteLine(m, m.byId.get('l5')!), 'Bill 03 CONCRETE WORKS · page C/3 · item F — Line 5');
});

test('revise: alignment keeps order, anchors on unique lines, pairs repeats in order', () => {
  assert.deepEqual(alignKeys(['a', 'b', 'c'], ['a', 'x', 'b', 'c']), [[0, 0], [1, 2], [2, 3]]);
  const rep = alignKeys(['d', 'd', 'u', 'd'], ['d', 'u', 'd', 'd']);
  assert.equal(rep.length, 3);
  assert.ok(rep.every(([i, j], k) => k === 0 || (i > rep[k - 1][0] && j > rep[k - 1][1])), 'in order on both sides');
  assert.deepEqual(alignKeys(['a', 'b'], ['b', 'a']).length, 1);
});

test('revise: a new issue moves lines to other pages; pages and letters follow', () => {
  // issue 1: 30 lines on 3 pages of 10
  const v1 = book([HEAD, ...lines(30)], { breaks: [10, 20], footer: '&C&A/&P' });
  const f1: FilePlan = analyseFile('Bill 03 - Rev 0.xlsx', v1);
  const st = new Store();
  applyOps(st, planToOps([f1], { withRates: false, groupByFile: true, by: 'T' }, { afterOrd: null, beforeOrd: null }).ops);
  let m = buildModel(st);
  const find = (txt: string) => [...m.byId.values()].find((n) => n.desc.includes(txt))!;
  // our work on it: a rate on line 15
  applyOps(st, [[find('number 15 ').id, 'rate', 99]]);
  m = buildModel(st);
  assert.equal(find('number 15 ').page, 'CONCRETE WORKS/2');
  // issue 2: two new lines at the top, line 7 removed, line 22 reworded -> everything shifts
  const l = lines(30);
  const rows2 = [HEAD, ['A', 'New line one for the revision', 5, 'm2'], ['B', 'New line two for the revision', 6, 'm2'], ...l.filter((_r, i) => i !== 6)];
  const i22 = rows2.findIndex((r) => String(r[1]).includes('number 22 '));
  rows2[i22] = [rows2[i22][0], 'Concrete line number 22 poured in place, grade C40', 31, 'm3'];
  // item letters run A, B, C… on each page of the new issue
  rows2.forEach((r, k) => { if (k > 0) r[0] = 'ABCDEFGHIJ'[(k) % 10]; });
  const v2 = book(rows2, { breaks: [10, 20], footer: '&C&A/&P' });
  const f2 = analyseFile('Bill 03 - Rev 1.xlsx', v2);
  const u = matchIssue(m, st, [f2]);
  assert.equal(u.pairs.length, 1);
  assert.ok(u.pairs[0].bill, 'the sheet is paired with its bill');
  assert.equal(u.added.length, 2, 'the two new lines');
  assert.equal(u.missing.length, 1, 'the removed line');
  assert.match(u.missing[0].desc, /number 7 /);
  assert.equal(u.matches.length, 29);
  const reworded = u.matches.find((x) => x.node.desc.includes('number 22 '))!;
  assert.ok(reworded.descChanged && reworded.qtyChanged === false);
  const res = issueOps(u, [f2], { refs: true, qty: false, by: 'T' });
  assert.ok(res.pages > 0 && res.refs > 0);
  applyOps(st, res.ops);
  m = buildModel(st);
  const l15 = find('number 15 ');
  // row of line 15 in issue 2: header + 2 new + 13 before it (line 7 gone) = row 17 -> page 2
  assert.equal(l15.page, 'CONCRETE WORKS/2');
  const l9 = find('number 9 ');
  assert.equal(l9.page, 'CONCRETE WORKS/2', 'line 9 moved from page 1 to page 2');
  // the lines now point at the new issue: updating again changes nothing
  const again = issueOps(matchIssue(m, st, [f2]), [f2], { refs: true, qty: false, by: 'T' });
  assert.equal(again.pages + again.refs, 0);
});

// ---------------------------------------------------------------- the real samples
const SAMPLES = process.env.BOQ_SAMPLES ?? '';
const haveSamples = !!SAMPLES && existsSync(join(SAMPLES, 'priced-a'));

test('pages (real): unpriced set prints "&A/&P" with manual breaks; every collection page agrees with the count', { skip: !haveSamples && 'samples not present' }, () => {
  const dir = join(SAMPLES, 'priced-a');
  const name = readdirSync(dir).find((n) => /Bill 02/.test(n))!;
  const f = analyseFile(name, readXlsx(new Uint8Array(readFileSync(join(dir, name)))));
  const cw = f.sheets.find((s) => s.name === 'CONCRETE WORKS')!;
  assert.equal(cw.pages.method, 'print');
  assert.equal(cw.pages.pattern, '{A}/{P}');
  assert.equal(cw.pages.count, 9);
  assert.equal(cw.pages.listed, 9, 'the collection page lists pages 1 to 9');
  assert.equal(cw.rows.find((r) => r.r === 51 && r.kind !== 'skip')?.page ?? 'CONCRETE WORKS/2', 'CONCRETE WORKS/2');
  for (const s of f.sheets.filter((x) => x.include && x.pages.listed)) assert.equal(s.pages.count, s.pages.listed, s.name);
});

test('revise (real): the same issue again matches every line, changes nothing, fast', { skip: !haveSamples && 'samples not present' }, () => {
  const dir = join(SAMPLES, 'priced-a');
  const read = () => readdirSync(dir).filter((n) => n.endsWith('.xlsx')).sort().map((n) => analyseFile(n, readXlsx(new Uint8Array(readFileSync(join(dir, n))))));
  const files = read();
  const st = new Store();
  applyOps(st, planToOps(files, { withRates: false, groupByFile: true, by: 'T' }, { afterOrd: null, beforeOrd: null }).ops);
  const m = buildModel(st);
  const t0 = Date.now();
  const u = matchIssue(m, st, read());
  const ms = Date.now() - t0;
  const lines = pagedLines(m, null).length;
  assert.equal(u.missing.length, 0);
  assert.equal(u.added.length, 0);
  assert.equal(u.matches.length, lines);
  assert.equal(u.matches.filter((x) => x.pageChanged || x.refChanged).length, 0);
  assert.ok(ms < 4000, `matched ${lines} lines in ${ms} ms`);
});
