// Excel BOQ import: reader + rules, on small hand-made workbooks and (when present) the real
// sample BOQs (your own work) (set BOQ_SAMPLES to the folder holding priced-a/ and priced-b/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { readXlsx } from '../src/engine/xlsx';
import { analyseFile, analyseSheet, tidyFileTitles, checkSheet, planToOps, parseNumber, statusOf, cleanFileNames, type FilePlan } from '../src/engine/boqimport';
import { Store } from '../src/engine/store';
import { buildModel } from '../src/engine/boq';
import type { Op } from '../src/engine/types';

type Cell = string | number | null | { v: string | number; b?: boolean; u?: boolean };
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const col = (c: number) => String.fromCharCode(64 + c);

/** builds a real .xlsx (zip of XML) from rows; cells can be bold */
function makeXlsx(sheets: { name: string; rows: Cell[][]; hidden?: boolean }[]): Uint8Array {
  const shared: string[] = [];
  const si = (s: string) => { let i = shared.indexOf(s); if (i < 0) { i = shared.length; shared.push(s); } return i; };
  const files: Record<string, Uint8Array> = {};
  sheets.forEach((sh, k) => {
    const rows = sh.rows.map((r, ri) => {
      const cells = r.map((c, ci) => {
        if (c === null) return '';
        const o = typeof c === 'object' ? c : { v: c };
        const s = o.b && o.u ? 3 : o.b ? 1 : o.u ? 2 : 0;
        const ref = col(ci + 1) + (ri + 1);
        return typeof o.v === 'number' ? `<c r="${ref}" s="${s}"><v>${o.v}</v></c>` : `<c r="${ref}" s="${s}" t="s"><v>${si(o.v)}</v></c>`;
      }).join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    }).join('');
    files[`xl/worksheets/sheet${k + 1}.xml`] = strToU8(`<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`);
  });
  files['xl/workbook.xml'] = strToU8(`<workbook xmlns:r="r"><sheets>${sheets.map((s, k) => `<sheet name="${esc(s.name)}" sheetId="${k + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${k + 1}"/>`).join('')}</sheets></workbook>`);
  files['xl/_rels/workbook.xml.rels'] = strToU8(`<Relationships>${sheets.map((_s, k) => `<Relationship Id="rId${k + 1}" Target="worksheets/sheet${k + 1}.xml"/>`).join('')}</Relationships>`);
  files['xl/sharedStrings.xml'] = strToU8(`<sst>${shared.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`);
  files['xl/styles.xml'] = strToU8(`<styleSheet><fonts><font><sz val="9"/></font><font><b/><sz val="9"/></font><font><u/></font><font><b/><u/></font></fonts><cellXfs><xf fontId="0"/><xf fontId="1"/><xf fontId="2"/><xf fontId="3"/></cellXfs></styleSheet>`);
  return zipSync(files);
}

const H = (v: string) => ({ v, b: true, u: true });
const HEAD = ['Item', 'Description', 'Quantity', 'Unit', 'Rate', 'Amount'];

function applyOps(ops: Op[]) {
  const st = new Store();
  // the importer splits nothing here; apply as batches of 4000 like the app
  for (let i = 0; i < ops.length; i += 4000) st.apply({ s: '0000000000000-' + String(i).padStart(6, '0') + '-t', w: 't', u: 'T', t: 0, o: ops.slice(i, i + 4000) });
  return st;
}

test('import: numbers and statuses as consultants write them', () => {
  assert.equal(parseNumber('4,224'), 4224);
  assert.equal(parseNumber(' 1,250.50 '), 1250.5);
  assert.equal(parseNumber('(500)'), -500);
  assert.equal(parseNumber('Rate Only'), null);
  assert.deepEqual(statusOf('Rate only'), { st: null, ro: true, keep: false });
  assert.equal(statusOf('INCLUDED').st, 'incl');
  assert.equal(statusOf('Included in additional').st, 'incl');
  assert.equal(statusOf('NA').st, 'na');
  assert.equal(statusOf('SYPPLY BY EMPLOYER').st, 'emp');
  assert.equal(statusOf('PS OPTIONAL').st, 'opt');
  assert.equal(statusOf('Provisional Sum').st, 'ps');
  assert.deepEqual(cleanFileNames(['2-2026.07.13-PROJ-A- Bill 02- Pod.xlsx', '3-2026.07.13-PROJ-A- Bill 03- TA.xlsx']), ['Bill 02- Pod', 'Bill 03- TA']);
});

test('import: furniture, collections, CONT\'D, statuses and lump sums on a small priced BOQ', () => {
  const page = (n: number): Cell[][] => [
    ['CLIENT SOMEONE LLC', null, null, null, 'BILL 02', `B/${n}`],
    ['BILL OF QUANTITIES'],
    ['BILL 02 - PODIUM'],
    HEAD,
  ];
  const rows: Cell[][] = [
    ...page(1),
    [null, H('SITE WORK')],
    [null, H('Excavation')],
    [null, 'Excavation in all materials'],
    ['A', 'To pile caps', '4,224', 'm3', 12, 50688],
    ['B', 'To raft', '100', 'm3', null, 'Included'],
    [null, H('Dewatering')],
    ['C', 'Dewatering system', 1, 'Item', null, 'Rate Only'],
    ['To Collection AED', null, null, null, null, 50688],
    ['Issued on: today'],
    ...page(2),
    [null, H('SITE WORK (CONT\'D)')],
    [null, H('Dewatering (CONT\'D)')],
    ['A', 'Maintenance of dewatering', 180, 'Days', 10, 1800],
    [null, { v: 'Structural steel; lump sum', b: false }, null, null, 406800, 406800],
    ['B', 'Columns', 3815, 'kg', null, 'INCLUDED'],
    ['C', 'Signage (PROVISIONAL SUM)', 1, 'P.S', null, 600000],
    ['To Collection AED', null, null, null, null, 1008600],
    ...page(3),
    [null, H('COLLECTION')],
    [null, 'Total Brought Forward from Page No.'],
    [null, 'Page : B/1', null, null, null, 50688],
    [null, 'Page : B/2', null, null, null, 1008600],
    ['Carried To Bill Summary Page AED', null, null, null, null, 1059288],
  ];
  const wb = readXlsx(makeXlsx([{ name: 'Bill 02', rows }, { name: 'Cover', rows: [['BILL NO. 02'], ['PODIUM']] }]));
  const sp = analyseSheet(wb, 'Bill 02');
  assert.equal(sp.include, true);
  assert.equal(sp.ref, 'Bill 02');
  assert.equal(sp.title, 'PODIUM');
  const items = sp.rows.filter((r) => r.kind === 'item');
  assert.deepEqual(items.map((r) => r.desc), ['To pile caps', 'To raft', 'Dewatering system', 'Maintenance of dewatering', 'Structural steel; lump sum', 'Columns', 'Signage (PROVISIONAL SUM)']);
  assert.equal(items[0].qty, 4224);
  assert.equal(items[0].page, 'B/1');
  assert.equal(items[3].page, 'B/2');
  assert.equal(items[1].st, 'incl');
  assert.equal(items[2].ro, true);
  assert.equal(items[6].ps, true);
  // CONT'D headings were not created again; Maintenance sits under the original "Dewatering"
  const heads = sp.rows.filter((r) => r.kind === 'head').map((r) => `${r.level}:${r.desc}`);
  assert.deepEqual(heads, ['1:SITE WORK', '2:Excavation', '2:Dewatering']);
  const c = checkSheet('x', sp, true);
  assert.equal(c.imported, 1059288);
  assert.equal(c.collected, 1059288);
  assert.equal(c.skipped.summary, 5); // COLLECTION, brought forward, 2 page lines, carried to summary
  assert.deepEqual(c.warnings, []);

  // into a project: totals, PS tab, statuses, consultant qty kept
  const f = analyseFile('Priced.xlsx', wb);
  const built = planToOps([f], { withRates: true, groupByFile: true, by: 'test' }, { afterOrd: null, beforeOrd: null });
  const model = buildModel(applyOps(built.ops));
  assert.equal(model.items, 7);
  assert.equal(model.roots.length, 1);
  assert.equal(model.roots[0].ref, 'Bill 02');
  const caps = [...model.byId.values()].find((n) => n.desc === 'To pile caps')!;
  assert.equal(caps.q0, 4224);
  assert.equal(caps.src.split(':').length, 4);
});

test('import: CONT\'D chain corrects a heading level guessed wrong', () => {
  // "Site exploration" follows "Site preparation" with nothing between: guessed as a sibling.
  // The next page's CONT'D block says it sits under it, so the levels are fixed.
  const rows: Cell[][] = [
    HEAD,
    [null, H('SITE WORK')],
    [null, H('Site preparation')],
    [null, H('Site exploration')],
    ['A', 'Clearing', 1, 'Item', null, null],
    ['To Collection', null, null, null, null, 0],
    [null, H('SITE WORK (CONT\'D)')],
    [null, H('Site preparation (CONT\'D)')],
    [null, H('Site exploration (CONT\'D)')],
    ['A', 'Grubbing', 1, 'Item', null, null],
    [null, H('Dewatering')],
    ['B', 'Pumps', 1, 'Item', null, null],
  ];
  const wb = readXlsx(makeXlsx([{ name: 'S', rows }]));
  const heads = analyseSheet(wb, 'S').rows.filter((r) => r.kind === 'head').map((r) => `${r.level}:${r.desc}`);
  assert.deepEqual(heads, ['1:SITE WORK', '2:Site preparation', '3:Site exploration', '2:Dewatering']);
});

test('import: sheets without BOQ columns, empty and hidden sheets are left out with a reason', () => {
  const wb = readXlsx(makeXlsx([
    { name: 'Cover', rows: [['BILLS OF QUANTITIES'], ['BILL NO. 03'], ['TOWER A']] },
    { name: '02', rows: [['Site Works']] },
    { name: 'SITE WORKS', rows: [HEAD] },
    { name: 'CONCRETE', rows: [HEAD, [null, H('BILL 03 - CONCRETE WORKS')], ['A', 'Blinding', 10, 'm3', null, 0]] },
    { name: 'Old', rows: [HEAD, ['A', 'x', 1, 'm', null, null]], hidden: true },
  ]));
  const f = analyseFile('3-2026-PROJ-A- Bill 03- TA.xlsx', wb);
  tidyFileTitles([f]);
  assert.equal(f.ref, 'Bill 03');
  assert.equal(f.title, 'TOWER A');
  const by = Object.fromEntries(f.sheets.map((s) => [s.name, s.include ? 'in' : s.reason]));
  assert.equal(by['CONCRETE'], 'in');
  assert.match(by['Cover'], /cover|columns/);
  assert.match(by['02'], /columns/);
  assert.equal(by['SITE WORKS'], 'no items');
  assert.equal(by['Old'], 'hidden sheet');
  const cs = f.sheets.find((s) => s.name === 'CONCRETE')!;
  assert.equal(cs.ref, 'Bill 03');
  assert.equal(cs.title, 'CONCRETE WORKS');
});

// ---------------------------------------------------------------- the real samples
const SAMPLES = process.env.BOQ_SAMPLES ?? '';
const haveSamples = !!SAMPLES && existsSync(join(SAMPLES, 'priced-b')) && existsSync(join(SAMPLES, 'priced-a'));

test('import (real): priced BOQ reproduces the Grand Summary to the dirham', { skip: !haveSamples && 'samples not present' }, () => {
  const dir = join(SAMPLES, 'priced-b');
  const name = readdirSync(dir).find((n) => n.endsWith('.xlsx'))!;
  const f = analyseFile(name, readXlsx(new Uint8Array(readFileSync(join(dir, name)))));
  const expect: Record<string, number> = { 'Bill 01': 41872000, 'Bill 02': 102946660, 'Bill 03': 208568317, 'Bill 04': 9281555, 'Bill 05': 10331468, 'Bill 06': 0 };
  for (const s of f.sheets.filter((x) => x.include)) {
    const c = checkSheet(name, s, true);
    assert.equal(c.imported, expect[s.ref], `${s.ref} ${s.title}`);
    if (s.ref !== 'Bill 06') assert.equal(c.collected, expect[s.ref], `${s.ref} collections`);
  }
  const built = planToOps([f], { withRates: true, groupByFile: true, by: 'test' }, { afterOrd: null, beforeOrd: null });
  const model = buildModel(applyOps(built.ops));
  assert.equal(model.roots.length, 6);
  assert.ok(model.items > 4700);
  const ps = [...model.byId.values()].filter((n) => n.isPs && n.type === 'item');
  assert.equal(ps.length, 5);
});

test('import (real): unpriced, 8 files with many sheets', { skip: !haveSamples && 'samples not present' }, () => {
  const dir = join(SAMPLES, 'priced-a');
  const files: FilePlan[] = readdirSync(dir).filter((n) => n.endsWith('.xlsx')).sort()
    .map((n) => analyseFile(n, readXlsx(new Uint8Array(readFileSync(join(dir, n))))));
  tidyFileTitles(files);
  assert.deepEqual(files.map((f) => `${f.ref} ${f.title}`.trim()), ['GS', 'Bill 01 GENERAL REQUIREMENTS', 'Bill 02 PODIUM', 'Bill 03 TOWER A', 'Bill 04 TOWER B', 'Bill 05 TOWER C', 'Bill 06 EXTERNAL WORKS', 'Bill 07 DAYWORKS']);
  const included = files.flatMap((f) => f.sheets.filter((s) => s.include).map((s) => f.ref + '/' + s.name));
  assert.ok(!included.some((n) => /cover|preamble|sum$|\/\d\d$/i.test(n)), 'cover, preambles, summaries and title pages are left out');
  const items = files.reduce((a, f) => a + f.sheets.filter((s) => s.include).reduce((b, s) => b + s.rows.filter((r) => r.kind === 'item').length, 0), 0);
  assert.ok(items > 14000, 'items: ' + items);
  // MEP: the repeated "5.01 Sanitary Fixtures" heading is one heading with the rooms under it
  const mep = files[3].sheets.find((s) => s.name === 'MEP WORKS')!;
  const heads = mep.rows.filter((r) => r.kind === 'head');
  const sanitary = heads.filter((r) => /^5\.01 Sanitary/.test(r.desc));
  assert.equal(sanitary.length, 1);
  const rooms = heads.filter((r) => /^(Bathroom|Powder Room|Maid room|Kitchen Fixtures)/.test(r.desc));
  assert.ok(rooms.length >= 4 && rooms.every((r) => r.level === sanitary[0].level + 1));
  // collection pages ("COLLECTION 01", "Bill-19 MEP/12") and "Brought / Back forward from page 54" are page furniture
  const junk = files.flatMap((f) => f.sheets.filter((s) => s.include).flatMap((s) => s.rows.filter((r) => r.kind !== 'skip' && (/^(back|brought)\s+forward/i.test(r.desc) || /^collection\s*\d+$/i.test(r.desc) || /^Bill-\d+ MEP\/\d+$/.test(r.desc)))));
  assert.deepEqual(junk.map((r) => r.desc), []);
  const built = planToOps(files, { withRates: false, groupByFile: true, by: 'test' }, { afterOrd: null, beforeOrd: null });
  const model = buildModel(applyOps(built.ops));
  assert.equal(model.roots.length, 7);
  assert.equal(model.items, items);
});

test('xlsx: empty shared strings and runs (<si/>, <t/>), single-quoted attributes, x:-prefixed XML', () => {
  const wb = readXlsx(zipSync({
    'xl/workbook.xml': strToU8(`<x:workbook xmlns:x="x" xmlns:r="r"><x:sheets><x:sheet name='S1' sheetId="1" r:id="rId1"/></x:sheets></x:workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(`<x:worksheet><x:sheetData><x:row r="1"><x:c r="A1" t="s"><x:v>1</x:v></x:c><x:c r="B1" t="s"><x:v>2</x:v></x:c><x:c r='C1' s='1'><x:v>7</x:v></x:c></x:row></x:sheetData></x:worksheet>`),
    'xl/sharedStrings.xml': strToU8(`<x:sst><x:si/><x:si><x:t>after empty</x:t></x:si><x:si><x:r><x:t/></x:r><x:r><x:t>rich</x:t></x:r></x:si></x:sst>`),
    'xl/styles.xml': strToU8('<styleSheet><fonts><font/><font><b/></font></fonts><cellXfs><xf fontId="0"/><xf fontId="1"/></cellXfs></styleSheet>'),
  }));
  const row = wb.sheet('S1').rows.get(1)!;
  assert.equal(row[1].v, 'after empty');
  assert.equal(row[2].v, 'rich');
  assert.equal(row[3].v, 7);
  assert.equal(wb.font(row[3].s).b, true, '<font/> does not shift the fonts after it');
});

// 0.23.2 (DeepSeek #3): a column picked by hand threw away the rows classified by hand, and ticked a sheet left out
test('import: changing a column keeps the rows classified by hand and a sheet left out', async () => {
  const { remapSheet } = await import('../src/engine/boqimport');
  const rows: Cell[][] = [
    HEAD,
    [null, H('SITE WORK')],
    ['A', 'To pile caps', '4,224', 'm3', 12, 50688],
    ['B', 'To raft', '100', 'm3', 3, 300],
    [null, 'A note that is really a heading'],
    ['C', 'Dewatering system', 1, 'Item', 5, 5],
  ];
  const wb = readXlsx(makeXlsx([{ name: 'S', rows }]));
  const sp = analyseSheet(wb, 'S');
  const raft = sp.rows.find((r) => r.desc === 'To raft')!;
  raft.kind = 'skip'; raft.why = 'user'; raft.user = true; // left out by hand
  const note = sp.rows.find((r) => r.desc === 'A note that is really a heading')!;
  note.kind = 'head'; note.level = 2; note.user = true;
  sp.include = false; // the sheet left out by hand
  const cols = { ...sp.cols! };
  delete (cols as any).amt; // a column changed by hand
  const next = remapSheet(wb, sp, cols as any);
  assert.equal(next.include, false, 'still left out');
  const r2 = next.rows.find((r) => r.desc === 'To raft')!;
  assert.equal(r2.kind, 'skip');
  const n2 = next.rows.find((r) => r.desc === 'A note that is really a heading')!;
  assert.equal(n2.kind, 'head'); assert.equal(n2.level, 2);
  assert.equal(next.rows.find((r) => r.desc === 'To pile caps')!.kind, 'item', 'the rest read again');
});
