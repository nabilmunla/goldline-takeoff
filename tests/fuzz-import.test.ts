// Adversarial import: random consultant-like workbooks, odd and hostile XML, damaged and truncated
// files. Every file must either import (no exception, no NaN / Infinity anywhere, totals that add up)
// or be refused with a readable message - and never hang.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { readXlsx, type XWorkbook } from '../src/engine/xlsx';
import { analyseFile, planToOps, checkSheet } from '../src/engine/boqimport';
import { Store } from '../src/engine/store';
import { buildModel } from '../src/engine/boq';
import type { Op } from '../src/engine/types';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (c: number) => { let s = ''; for (c++; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s; return s; };

type XC = { t: 'n'; v: string } | { t: 's'; v: string } | { t: 'inline'; v: string } | { t: 'e'; v: string } | { t: 'b'; v: string } | { t: 'str'; v: string; f: string };

/** a workbook built from raw cells, with knobs for odd structures */
function book(sheets: { name: string; rows: (XC | null)[][]; extra?: string; hidden?: boolean }[], o: { noShared?: boolean; noStyles?: boolean; rich?: boolean } = {}) {
  const shared: string[] = [];
  const si = (s: string) => { let i = shared.indexOf(s); if (i < 0) { i = shared.length; shared.push(s); } return i; };
  const files: Record<string, Uint8Array> = {};
  sheets.forEach((sh, k) => {
    const rows = sh.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => {
      if (!c) return '';
      const ref = colName(ci) + (ri + 1);
      const s = ` s="${ci % 3}"`;
      switch (c.t) {
        case 'n': return `<c r="${ref}"${s}><v>${esc(c.v)}</v></c>`;
        case 's': return o.noShared ? `<c r="${ref}" t="inlineStr"${s}><is><t>${esc(c.v)}</t></is></c>` : `<c r="${ref}" t="s"${s}><v>${si(c.v)}</v></c>`;
        case 'inline': return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(c.v)}</t></is></c>`;
        case 'e': return `<c r="${ref}" t="e"><v>${esc(c.v)}</v></c>`;
        case 'b': return `<c r="${ref}" t="b"><v>${c.v}</v></c>`;
        case 'str': return `<c r="${ref}" t="str"><f>${esc(c.f)}</f><v>${esc(c.v)}</v></c>`;
      }
    }).join('')}</row>`).join('');
    files[`xl/worksheets/sheet${k + 1}.xml`] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData>${sh.extra ?? ''}</worksheet>`);
  });
  files['xl/workbook.xml'] = strToU8(`<workbook xmlns:r="r"><sheets>${sheets.map((s, k) => `<sheet name="${esc(s.name)}" sheetId="${k + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${k + 1}"/>`).join('')}</sheets></workbook>`);
  files['xl/_rels/workbook.xml.rels'] = strToU8(`<Relationships>${sheets.map((_s, k) => `<Relationship Id="rId${k + 1}" Target="worksheets/sheet${k + 1}.xml"/>`).join('')}</Relationships>`);
  if (!o.noShared) files['xl/sharedStrings.xml'] = strToU8(`<sst>${shared.map((s) => o.rich ? `<si><r><rPr><b/></rPr><t>${esc(s.slice(0, 3))}</t></r><r><t xml:space="preserve">${esc(s.slice(3))}</t></r></si>` : `<si><t>${esc(s)}</t></si>`).join('')}</sst>`);
  if (!o.noStyles) files['xl/styles.xml'] = strToU8(`<styleSheet><fonts><font><sz val="9"/></font><font><b/><sz val="9"/></font><font><u/></font></fonts><cellXfs><xf fontId="0"/><xf fontId="1"/><xf fontId="2"/></cellXfs></styleSheet>`);
  return zipSync(files);
}

const WORDS = ['Excavation', 'Concrete', 'C40', 'blockwork', 'Plaster', 'Tiles', 'Provisional Sum', 'INCLUDED', 'Rate only', 'NA', 'By Employer', "CONT'D", 'To Collection', 'Carried to summary', 'BILL NO. 02', 'SUBSTRUCTURE', 'Item', 'Description', 'Qty', 'Unit', 'Rate', 'Amount', 'م٢', 'خرسانة', '& < > " \'', 'ﬁ', '‏', '\t', '  ', 'B/2', 'Page 3', 'TOTAL'];
const UNITS = ['m2', 'm3', 'Lm', 'nr', 'item', 'kg', 'LS', 'P.S', 'Sum', 'm²', ''];

function randomRows(r: () => number, n: number): (XC | null)[][] {
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const num = (): string => {
    const k = r();
    if (k < 0.5) return String(Math.round(r() * 1e6) / 100);
    if (k < 0.6) return '0';
    if (k < 0.7) return '-' + String(Math.round(r() * 1e4));
    // Excel keeps 15 digits and nothing near the double limit ever appears in a BOQ
    if (k < 0.75) return '999999999999999';
    if (k < 0.8) return '1E+15';
    if (k < 0.85) return '0.001';
    if (k < 0.9) return '12345678901234567890';
    return pick(['NaN', 'Infinity', '', ' ', '1,250.50', '(500)', '1.2.3']);
  };
  const text = (): string => {
    const k = r();
    if (k < 0.02) return 'x'.repeat(40000);
    let s = '';
    for (let i = 0, m = 1 + Math.floor(r() * 6); i < m; i++) s += pick(WORDS) + ' ';
    return s.trim();
  };
  const cell = (c: number): XC | null => {
    const k = r();
    if (k < 0.25) return null;
    if (c === 2 || c === 4 || c === 5) return k < 0.8 ? { t: 'n', v: num() } : { t: 's', v: k < 0.9 ? num() : text() };
    if (c === 3) return { t: 's', v: pick(UNITS) };
    if (k < 0.3) return { t: 'e', v: pick(['#REF!', '#DIV/0!', '#N/A', '#VALUE!']) };
    if (k < 0.33) return { t: 'b', v: pick(['0', '1']) };
    if (k < 0.36) return { t: 'str', v: text(), f: 'A1&B1' };
    if (k < 0.4) return { t: 'inline', v: text() };
    return { t: 's', v: c === 0 ? pick(['A', 'B', '1.1', '2.03', 'a)', '', text()]) : text() };
  };
  const rows: (XC | null)[][] = [];
  for (let i = 0; i < n; i++) {
    if (r() < 0.05) { rows.push(['Item', 'Description', 'Qty', 'Unit', 'Rate', 'Amount'].map((v) => ({ t: 's', v }))); continue; }
    const width = r() < 0.03 ? 40 : 6 + Math.floor(r() * 3);
    rows.push(Array.from({ length: width }, (_, c) => cell(c)));
  }
  return rows;
}

const finite = (x: unknown) => typeof x !== 'number' || Number.isFinite(x);

/** everything the app does with a workbook, from reading to the summary */
function importAll(bytes: Uint8Array, name = 'Bill 02.xlsx') {
  const t0 = Date.now();
  let wb: XWorkbook;
  try { wb = readXlsx(bytes); } catch (e: any) { assert.ok(typeof e?.message === 'string' && e.message.length > 5, 'a readable message'); return { refused: e.message as string, ms: Date.now() - t0 }; }
  const f = analyseFile(name, wb);
  for (const sp of f.sheets) checkSheet(name, sp, true);
  const built = planToOps([f], { withRates: true, groupByFile: true, by: 'fuzz' }, { afterOrd: null, beforeOrd: null });
  for (const op of built.ops) assert.ok(finite(op[2]), 'no NaN/Infinity value written: ' + JSON.stringify(op) + ' ' + String(op[2]));
  const st = new Store();
  for (let i = 0; i < built.ops.length; i += 4000) st.apply({ s: '0000000000000-' + String(i).padStart(6, '0') + '-f', w: 'f', u: 'F', t: 0, o: built.ops.slice(i, i + 4000) as Op[] });
  const m = buildModel(st);
  assert.ok(Number.isFinite(m.items), 'item count finite');
  return { items: built.counts.items, ms: Date.now() - t0 };
}

test('import fuzz: random consultant-like workbooks import or refuse, quickly, with a finite item count', () => {
  let items = 0, slowest = 0;
  for (let seed = 1; seed <= 120; seed++) {
    const r = rng(seed);
    const sheets = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, k) => ({ name: k === 0 && r() < 0.2 ? 'Bill <02> & "Pod"' : 'Sheet ' + (k + 1), rows: randomRows(r, 20 + Math.floor(r() * 300)), hidden: r() < 0.1 }));
    const bytes = book(sheets, { noShared: r() < 0.15, noStyles: r() < 0.15, rich: r() < 0.2 });
    let res;
    try { res = importAll(bytes); } catch (e: any) { assert.fail(`seed ${seed}: ${e?.stack ?? e}`); }
    if ('items' in res) items += res.items;
    slowest = Math.max(slowest, res.ms);
  }
  assert.ok(items > 1000, 'it really imported things: ' + items);
  assert.ok(slowest < 4000, 'slowest workbook ' + slowest + ' ms');
});

test('import fuzz: odd structures and hostile XML', () => {
  const base = randomRows(rng(99), 40);
  const cases: [string, Uint8Array][] = [
    ['huge cell refs', book([{ name: 'S', rows: [[{ t: 's', v: 'Item' }]], extra: '' }]).slice()],
    ['merge over the whole sheet', book([{ name: 'S', rows: base, extra: '<mergeCells count="1"><mergeCell ref="A1:XFD1048576"/></mergeCells>' }])],
    ['10k row breaks', book([{ name: 'S', rows: base, extra: `<rowBreaks>${'<brk id="5" max="16383" man="1"/>'.repeat(10000)}</rowBreaks>` }])],
    ['columns block over 16k columns', book([{ name: 'S', rows: base, extra: '' }])],
    ['empty workbook', zipSync({ 'xl/workbook.xml': strToU8('<workbook><sheets></sheets></workbook>') })],
    ['sheet pointing outside', zipSync({ 'xl/workbook.xml': strToU8('<workbook xmlns:r="r"><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>'), 'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="../../../../etc/passwd"/></Relationships>') })],
    ['shared string index out of range', zipSync({ 'xl/workbook.xml': strToU8('<workbook xmlns:r="r"><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>'), 'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/s.xml"/></Relationships>'), 'xl/worksheets/s.xml': strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>99999</v></c><c r="B1" t="s"><v>-1</v></c><c r="C1" t="s"><v>abc</v></c></row></sheetData></worksheet>'), 'xl/sharedStrings.xml': strToU8('<sst><si><t>x</t></si></sst>') })],
    ['cells without refs, rows out of order, duplicate cells', zipSync({ 'xl/workbook.xml': strToU8('<workbook xmlns:r="r"><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>'), 'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/s.xml"/></Relationships>'), 'xl/worksheets/s.xml': strToU8('<worksheet><sheetData><row r="5"><c><v>1</v></c><c><v>2</v></c></row><row r="2"><c r="B2"><v>3</v></c><c r="B2"><v>4</v></c></row><row><c r="XFD1048576"><v>5</v></c></row><row r="0"><c r="A0"><v>6</v></c></row></sheetData></worksheet>') })],
    ['numeric character references and entities', book([{ name: 'S', rows: [[{ t: 'inline', v: 'Item' }, { t: 'inline', v: '&#x1F600; &#9999999; &#0; &unknown; &amp;amp;' }, { t: 'n', v: '1' }, { t: 's', v: 'm2' }, { t: 'n', v: '5' }, { t: 'n', v: '5' }]] }])],
    ['DOCTYPE with entities (billion laughs)', zipSync({ 'xl/workbook.xml': strToU8('<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><workbook xmlns:r="r"><sheets><sheet name="&lol2;" r:id="rId1"/></sheets></workbook>'), 'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/s.xml"/></Relationships>'), 'xl/worksheets/s.xml': strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&lol2;</t></is></c></row></sheetData></worksheet>') })],
    ['unclosed tags everywhere', zipSync({ 'xl/workbook.xml': strToU8('<workbook xmlns:r="r"><sheets><sheet name="S" r:id="rId1"'), 'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/s.xml"'), 'xl/worksheets/s.xml': strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>abc') })],
    ['old .xls bytes', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array(500).fill(0)])],
    ['a PDF renamed .xlsx', strToU8('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF')],
    ['empty file', new Uint8Array(0)],
  ];
  // a cols block that claims 16k columns
  {
    const files = unzipSync(book([{ name: 'S', rows: base }]));
    files['xl/worksheets/sheet1.xml'] = strToU8(new TextDecoder().decode(files['xl/worksheets/sheet1.xml']).replace('<sheetData>', '<cols><col min="1" max="16384" width="9" hidden="1"/><col min="-5" max="1e12" width="NaN"/></cols><sheetData>'));
    cases[3][1] = zipSync(files);
  }
  {
    const files = unzipSync(book([{ name: 'S', rows: [[{ t: 's', v: 'Item' }]] }]));
    files['xl/worksheets/sheet1.xml'] = strToU8('<worksheet><dimension ref="A1:XFD1048576"/><sheetData><row r="1048576"><c r="XFD1048576" t="inlineStr"><is><t>far away</t></is></c></row><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>');
    cases[0][1] = zipSync(files);
  }
  for (const [name, bytes] of cases) {
    const t0 = Date.now();
    try { importAll(bytes); } catch (e: any) { assert.fail(`${name}: ${e?.stack ?? e}`); }
    assert.ok(Date.now() - t0 < 5000, `${name}: took ${Date.now() - t0} ms`);
  }
});

test('import fuzz: damaged and truncated files are refused or read, never crash', () => {
  const r = rng(7);
  const good = book([{ name: 'Bill 02', rows: randomRows(rng(5), 200) }, { name: 'Bill 03', rows: randomRows(rng(6), 200) }]);
  let refused = 0, read = 0;
  for (let i = 0; i < 300; i++) {
    const b = good.slice();
    const k = r();
    if (k < 0.4) for (let j = 0; j < 1 + Math.floor(r() * 20); j++) b[Math.floor(r() * b.length)] = Math.floor(r() * 256);
    let bytes: Uint8Array = b;
    if (k >= 0.4 && k < 0.7) bytes = b.slice(0, Math.floor(r() * b.length));
    if (k >= 0.7) { // damage inside the XML instead of the zip
      const files = unzipSync(good);
      const keys = Object.keys(files);
      const key = keys[Math.floor(r() * keys.length)];
      const t = new TextDecoder().decode(files[key]);
      const at = Math.floor(r() * t.length);
      files[key] = strToU8(t.slice(0, at) + ['<', '>', '"', '&', '</row>', '<c r="ZZZ0">', '\u0000', ''][Math.floor(r() * 8)] + t.slice(at + Math.floor(r() * 50)));
      bytes = zipSync(files);
    }
    try {
      const res = importAll(bytes);
      if ('refused' in res) refused++; else read++;
    } catch (e: any) { assert.fail(`case ${i}: ${e?.stack ?? e}`); }
  }
  assert.ok(refused > 20 && read > 20, `refused ${refused}, read ${read}`);
});
