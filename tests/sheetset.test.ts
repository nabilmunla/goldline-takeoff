// A bound set's sheet numbers and titles read across the set (src/engine/qto/sheetset.ts, ported with the PDF
// Editor 0.13's tests/sheets.test.ts - its links between sheets aside), then how the take-off's import uses
// it (revisions.ts readSet, planImport) and the same through the drawing engine's own words. Invented
// numbers and generated pages only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokensOf, tokensOfWords, sheetIndex, plainNumbersOk, repeatedNos, type PageToks } from '../src/engine/qto/sheetset';

type W = { s: string; x: number; y: number; h?: number };
/** a page's text the way the drawing engine gives it: one box per character, lines by '\n' */
function chars(lines: W[][]) {
  let text = '';
  const box: number[] = [];
  const put = (c: string, b: number[]) => { text += c; box.push(...b); };
  lines.forEach((l, li) => {
    if (li) put('\n', [NaN, NaN, NaN, NaN]);
    l.forEach((w, wi) => {
      const h = w.h ?? 8;
      if (wi) put(' ', [NaN, NaN, NaN, NaN]);
      [...w.s].forEach((c, k) => put(c, [w.x + k * 0.6 * h, w.y, w.x + (k + 1) * 0.6 * h, w.y + h]));
    });
  });
  return { text, box: new Float32Array(box) };
}
const MM = 72 / 25.4;
const A1 = { w: 841 * MM, h: 594 * MM };
const A4 = { w: 210 * MM, h: 297 * MM };

/** a sheet with a title block in the right strip */
function sheet(page: number, no: string | null, title: string, body: W[][] = [], size = A1, label?: string): PageToks {
  const { w, h } = size;
  const tb = (dx: number, dy: number, s: string, hh = 8): W[] => [{ s, x: w - dx * MM, y: h - dy * MM, h: hh }];
  const lines: W[][] = [
    ...body,
    tb(150, 120, 'PROJECT PRJ-0042 SAMPLE TOWER'),
    tb(150, 100, title.split('|')[0], 10),
    ...(title.includes('|') ? [tb(150, 100 - 5, title.split('|')[1], 10)] : []),
    tb(150, 70, 'DATE 16.11.2026'),
    tb(100, 70, 'SCALE 1:100'),
    tb(150, 55, 'REV C02'),
    tb(60, 55, 'STATUS IFC'),
  ];
  if (no) lines.push([{ s: 'DWG NO', x: w - 150 * MM, y: h - 40 * MM, h: 6 }, { s: no, x: w - 120 * MM, y: h - 40 * MM, h: 12 }]);
  return tokensOf(page, chars(lines), w, h, label);
}

function setA(n = 40, opts: { dup?: number; none?: number } = {}) {
  const pages: PageToks[] = [];
  for (let i = 0; i < n; i++) {
    const no = i === opts.none ? null : i === opts.dup ? 'A-101' : `A-${101 + i}`;
    const body: W[][] = [];
    if (i === 0) body.push([{ s: 'SEE', x: 300, y: 300 }, { s: 'A-103', x: 330, y: 300 }]);
    if (i === 1) body.push([{ s: '5', x: 400, y: 400 }, { s: '/', x: 410, y: 400 }, { s: 'A-105', x: 420, y: 400 }]);
    if (i === 2) body.push([{ s: 'REFER', x: 400, y: 500 }, { s: 'TO', x: 440, y: 500 }, { s: 'A-999', x: 460, y: 500 }]); // not in the set
    body.push([{ s: 'ROOM', x: 800, y: 800 }, { s: '101', x: 840, y: 800 }]);
    body.push([{ s: 'LEVEL', x: 900, y: 900 }, { s: '02', x: 940, y: 900 }]);
    pages.push(sheet(i, no, i % 3 ? `FLOOR PLAN LEVEL ${i}` : `SECTION ${String.fromCharCode(65 + (i % 26))}-${i}|DETAILS`, body));
  }
  return pages;
}

/** a page of a specification: clause numbers, dates, prose */
function prose(page: number, size = A4): PageToks {
  const lines: W[][] = [];
  for (let k = 0; k < 40; k++) lines.push([{ s: `${3 + (page % 5)}.${k % 9}.${k}`, x: 20 * MM, y: (30 + k * 6) * MM, h: 9 }, { s: 'The Contractor shall provide all labour 2026 and materials', x: 40 * MM, y: (30 + k * 6) * MM, h: 9 }]);
  lines.push([{ s: `SECTION 08 71 00 - ${page + 1}`, x: 90 * MM, y: 285 * MM, h: 8 }]);
  lines.push([{ s: 'Issued 16.11.2026', x: 160 * MM, y: 285 * MM, h: 8 }]);
  return tokensOf(page, chars(lines), size.w, size.h);
}

test('a drawing set: every sheet number, most titles', () => {
  const idx = sheetIndex(setA());
  assert.equal(idx.sheets.length, 40);
  for (let i = 0; i < 40; i++) assert.equal(idx.sheets[i].no, `A-${101 + i}`, 'page ' + i);
  const titled = idx.sheets.filter((s, i) => s.title === (i % 3 ? `FLOOR PLAN LEVEL ${i}` : `SECTION ${String.fromCharCode(65 + (i % 26))}-${i} DETAILS`)).length;
  assert.ok(titled >= 36, `titles right: ${titled} of 40 (${idx.sheets.slice(0, 4).map((s) => s.title).join(' | ')})`);
  // the project number, the date, the scale and the revision code are not sheet numbers
  assert.ok(!idx.sheets.some((s) => /2603|C02|1-100|2026/.test(s.key)));
});

test('a number on two pages: the first page is the one it finds; a sheet with no title block has no number', () => {
  const pages = setA(40, { dup: 7, none: 9 });
  pages[5] = sheet(5, 'A-106', 'FLOOR PLAN LEVEL 5', [[{ s: 'SEE', x: 300, y: 300 }, { s: 'A-101', x: 330, y: 300 }]]);
  const idx = sheetIndex(pages);
  assert.equal(idx.sheets.find((s) => s.page === 9), undefined);
  assert.equal(idx.byKey.get('A-101'), 0);
  assert.equal(idx.sheets.length, 39);
});

test('a specification finds nothing (rule R)', () => {
  const pages = Array.from({ length: 50 }, (_, i) => prose(i));
  const idx = sheetIndex(pages);
  assert.equal(idx.sheets.length, 0);
});

test('a mixed set: the drawings only', () => {
  const pages: PageToks[] = [];
  for (let i = 0; i < 12; i++) pages.push(sheet(i, `S-${201 + i}`, `STRUCTURE ${i}`));
  for (let i = 0; i < 30; i++) pages.push(prose(12 + i));
  const idx = sheetIndex(pages);
  assert.deepEqual(idx.sheets.map((s) => s.page), Array.from({ length: 12 }, (_, i) => i));
});

test('nothing to read: no pages, one page, pages with no text', () => {
  assert.equal(sheetIndex([]).sheets.length, 0);
  assert.equal(sheetIndex([sheet(0, 'A-101', 'PLAN')]).sheets.length, 0);
  const empty = Array.from({ length: 5 }, (_, i) => tokensOf(i, { text: '', box: new Float32Array(0) }, A1.w, A1.h));
  const idx = sheetIndex(empty);
  assert.equal(idx.sheets.length, 0);
  assert.equal(idx.noText, 5);
  assert.equal(tokensOf(0, null as never, 0, 0).text, false);
});

test('page labels that look like drawing numbers count when the title blocks say nothing', () => {
  const pages = Array.from({ length: 6 }, (_, i) => tokensOf(i, chars([[{ s: 'plain drawing', x: 100, y: 100 }]]), A1.w, A1.h, `M-${301 + i}`));
  assert.deepEqual(sheetIndex(pages).sheets.map((s) => s.no), ['M-301', 'M-302', 'M-303', 'M-304', 'M-305', 'M-306']);
  const roman = Array.from({ length: 6 }, (_, i) => tokensOf(i, chars([[{ s: 'x', x: 1, y: 1 }]]), A1.w, A1.h, ['i', 'ii', 'iii', '1', '2', '3'][i]));
  assert.equal(sheetIndex(roman).sheets.length, 0);
});

test('random text never throws', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const alpha = 'AB-_.0123456789 /\n\rSEE';
  for (let k = 0; k < 200; k++) {
    let text = '';
    const box: number[] = [];
    const n = Math.floor(rnd() * 300);
    for (let i = 0; i < n; i++) { text += alpha[Math.floor(rnd() * alpha.length)]; const x = rnd() * 2000, y = rnd() * 1500; box.push(x, y, rnd() < 0.05 ? NaN : x + rnd() * 10, y + rnd() * 10); }
    const pages = [0, 1, 2, 3].map((p) => tokensOf(p, { text, box: new Float32Array(box) }, rnd() < 0.1 ? 0 : 2000, 1500));
    sheetIndex(pages);
  }
});

test('speed and size: 320 sheets of 400 words', () => {
  const t0 = performance.now();
  const pages: PageToks[] = [];
  for (let i = 0; i < 320; i++) {
    const body: W[][] = Array.from({ length: 40 }, (_, k) => Array.from({ length: 10 }, (_, j) => ({ s: j % 3 ? 'WALL' : `W${k}${j}`, x: 100 + j * 60, y: 100 + k * 30 })));
    pages.push(sheet(i, `E-${1001 + i}`, `POWER LAYOUT ${i}`, body));
  }
  const idx = sheetIndex(pages);
  assert.equal(idx.sheets.length, 320);
  assert.ok(pages.every((p) => p.toks.length <= 400));
  assert.ok(performance.now() - t0 < 4000, 'took ' + Math.round(performance.now() - t0) + ' ms');
});

test('title blocks along the bottom (A3 sets)', () => {
  const A3 = { w: 420 * MM, h: 297 * MM };
  const pages: PageToks[] = [];
  for (let i = 0; i < 20; i++) {
    const y = A3.h - 15 * MM;
    pages.push(tokensOf(i, chars([
      [{ s: 'CLIENT PRJ-0042', x: 20 * MM, y, h: 7 }],
      [{ s: `ELEVATION ${i + 1}`, x: 150 * MM, y: A3.h - 22 * MM, h: 9 }],
      [{ s: `ID-${String(i + 1).padStart(3, '0')}`, x: 300 * MM, y, h: 11 }],
      [{ s: 'REV P01', x: 360 * MM, y, h: 7 }],
      ...(i === 4 ? [[{ s: 'SEE', x: 100, y: 200 }, { s: 'ID-12', x: 130, y: 200 }]] : []),
    ]), A3.w, A3.h));
  }
  const idx = sheetIndex(pages);
  assert.equal(idx.sheets.length, 20);
  assert.equal(idx.sheets[0].no, 'ID-001');
  assert.equal(idx.sheets[3].title, 'ELEVATION 4');
  // "ID-12" written without the zero is sheet ID-012
});

// PLAN 9: on the user's real sets (12 files, 1,684 pages) 44 false sheets came from one spot on 71 A4
// pages of a bill of quantities - the page total at the foot of the amount column: 34 decimals, 8
// whole numbers, 2 others; the plain numbers 2 to 8 digits long, never one length. Generated pages of
// that pattern.

/** a pseudo-random amount with 3 to 8 digits before the point (the measured spread of lengths) */
const amount = (i: number, dec: boolean) => {
  const digits = 3 + ((i * 7 + 3) % 6);
  const v = String(Math.floor(10 ** (digits - 1) * (1 + ((i * 7919) % 8999) / 1000)));
  const whole = v.slice(0, digits).replace(/\B(?=(\d{3})+$)/g, i % 2 ? ',' : '');
  return dec ? `${whole}.${String((i * 37) % 100).padStart(2, '0')}` : whole.replace(/,/g, '');
};
/** a page of a bill of quantities (A4): item, description, quantity, unit, rate, amount; the page
 *  total at the foot of the amount column, in the bottom strip */
function boq(page: number, dec = true): PageToks {
  const lines: W[][] = [];
  for (let k = 0; k < 28; k++) {
    const y = (25 + k * 8) * MM;
    lines.push([
      { s: String.fromCharCode(65 + (k % 8)), x: 12 * MM, y, h: 8 },
      { s: 'Supply and install reinforced concrete to the', x: 22 * MM, y, h: 8 },
      { s: String(10 + ((page + k) % 80)), x: 108 * MM, y, h: 8 },
      { s: 'm3', x: 122 * MM, y, h: 8 },
      { s: dec ? `${450 + k}.00` : String(450 + k), x: 140 * MM, y, h: 8 },
      { s: amount(page * 31 + k, dec), x: 170 * MM, y, h: 8 },
    ]);
  }
  lines.push([{ s: 'Carried to collection', x: 60 * MM, y: 262 * MM, h: 9 }, { s: amount(page, dec), x: 120 * MM, y: 262 * MM, h: 9 }]);
  return tokensOf(page, chars(lines), A4.w, A4.h);
}

test('a bill of quantities finds no sheets: amounts with a decimal point are no sheet numbers', () => {
  const pages = Array.from({ length: 40 }, (_, i) => boq(i));
  // the collection page: the page totals again, at the left (outside the title band)
  pages.push(tokensOf(40, chars(Array.from({ length: 20 }, (_, i) => [{ s: `Page ${i + 1}`, x: 20 * MM, y: (30 + i * 9) * MM, h: 8 }, { s: amount(i, true), x: 45 * MM, y: (30 + i * 9) * MM, h: 8 }])), A4.w, A4.h));
  const idx = sheetIndex(pages);
  assert.deepEqual(idx.sheets.map((s) => s.no), []);
});

test('a schedule of whole quantities finds no sheets: plain numbers of many lengths are no sheet numbers', () => {
  const pages = Array.from({ length: 40 }, (_, i) => boq(i, false));
  assert.deepEqual(sheetIndex(pages).sheets.map((s) => s.no), []);
});

test('a set with a bill of quantities: the drawings only', () => {
  const A3 = { w: 420 * MM, h: 297 * MM };
  const pages: PageToks[] = [];
  for (let i = 0; i < 20; i++) {
    const y = A3.h - 15 * MM;
    pages.push(tokensOf(i, chars([
      [{ s: 'CLIENT PRJ-0042', x: 20 * MM, y, h: 7 }],
      [{ s: `PRJ-AB1-DWG-AR-${10140 + i}`, x: 330 * MM, y, h: 11 }],
      ...(i === 4 ? [[{ s: 'SEE', x: 100, y: 200 }, { s: 'AR-10145', x: 130, y: 200 }]] : []),
    ]), A3.w, A3.h));
  }
  for (let i = 0; i < 40; i++) pages.push(boq(20 + i));
  pages.push(tokensOf(60, chars(Array.from({ length: 20 }, (_, i) => [{ s: 'Page', x: 20 * MM, y: (30 + i * 9) * MM, h: 8 }, { s: amount(20 + i, true), x: 45 * MM, y: (30 + i * 9) * MM, h: 8 }])), A4.w, A4.h));
  const idx = sheetIndex(pages);
  assert.deepEqual(idx.sheets.map((s) => s.page), Array.from({ length: 20 }, (_, i) => i));
});

test('drawing numbers of digits only are still sheet numbers (one length, as written)', () => {
  for (const no of [(i: number) => String(100101 + i), (i: number) => String(i + 1).padStart(4, '0')]) {
    const pages = Array.from({ length: 24 }, (_, i) => sheet(i, no(i), `PLAN ${i}`));
    assert.deepEqual(sheetIndex(pages).sheets.map((s) => s.no), pages.map((_, i) => no(i)));
  }
  assert.equal(plainNumbersOk(['100101', '100102', '100103', '100104', '7']), true);
  assert.equal(plainNumbersOk(['0001', '0002', '0003']), true);
  assert.equal(plainNumbersOk(['512', '1047', '23140', '9027', '880000', '1500']), false);
  assert.equal(plainNumbersOk(['A-101', 'A-102', 'A-103', '512', '23140']), true);
});

// PLAN 9.2: titles on the user's real sets (483 sheets, A3 and A2): none was found. Measured there: the
// title band holds 85 lines on the median sheet (162 at the 90th percentile) and the title's lines come
// late in the text, past the 60 kept; the title sits 30 mm above the number and takes 1 to 3 lines, its
// first line shared by many sheets; the number stands alone on its line, next to its spot. Generated
// A3 sheets of that pattern.
const A3L = { w: 420 * MM, h: 297 * MM };
const LEVELS = ['LEVEL 01', 'LEVEL 02', 'TYPICAL FLOOR'];
const TWORDS = ['FLOOR PLAN', 'REFLECTED CEILING', 'WALL SETTING OUT', 'FINISHES LAYOUT', 'DOOR SCHEDULE', 'SECTIONS', 'ELEVATIONS', 'TOILET DETAILS'];
const realTitle = (i: number) => `${LEVELS[i % 3]} ${TWORDS[i % 8]} ZONE ${String.fromCharCode(65 + Math.floor(i / 8))}`;
function a3(i: number, o: { legend?: number; alone?: boolean; notes?: boolean } = {}): PageToks {
  const { w, h } = A3L;
  const at = (dx: number, dy: number, s: string, hh = 8): W => ({ s, x: w - dx * MM, y: h - dy * MM, h: hh });
  const lines: W[][] = [];
  // a legend down the right strip, the same on every sheet, first in the text
  for (let k = 0; k < (o.legend ?? 0); k++) lines.push([at(110, 280 - k * 2.6, `LEGEND ITEM ${String.fromCharCode(65 + (k % 26))}${String.fromCharCode(65 + Math.floor(k / 26))} FINISH TYPE`, 6)]);
  // sheet notes, different on each sheet, far from the title block
  if (o.notes) lines.push([at(110, 200, `NOTES FOR ${TWORDS[(i * 3) % 8]} ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(66 + (i % 25))} ONLY`, 7)]);
  lines.push([at(110, 70, 'PROJECT PRJ-0042 SAMPLE TOWER', 8)]);
  lines.push([at(110, 62, 'DRAWING TITLE', 6)]);
  // the title: three lines, the first shared by a third of the sheets
  const t = realTitle(i).split(/ (?=REFLECTED|FLOOR PLAN|WALL|FINISHES|DOOR|SECTIONS|ELEVATIONS|TOILET|ZONE)/);
  t.forEach((s, k) => lines.push([at(45, 55 - k * 3.5, s, 8)]));
  lines.push([at(110, 30, 'SCALE 1:100'), at(80, 30, 'DATE 16.11.2026')]);
  const no = `PRJ-AB1-DWG-AR-${10140 + i}`;
  lines.push(o.alone ? [at(38, 25, no, 10)] : [at(70, 25, 'DWG NO', 6), at(38, 25, no, 10)]);
  return tokensOf(i, chars(lines), w, h);
}

test('a title after more than 60 lines of the title band is found', () => {
  const pages = Array.from({ length: 24 }, (_, i) => a3(i, { legend: 80 }));
  const idx = sheetIndex(pages);
  assert.equal(idx.sheets.length, 24);
  assert.deepEqual(idx.sheets.map((s) => s.title), pages.map((_, i) => realTitle(i)));
});

test('a title of several lines whose first line repeats is found whole', () => {
  const pages = Array.from({ length: 24 }, (_, i) => a3(i));
  assert.deepEqual(sheetIndex(pages).sheets.map((s) => s.title), pages.map((_, i) => realTitle(i)));
});

test('the number on its own line is no title; notes that differ per sheet are no title either', () => {
  const pages = Array.from({ length: 24 }, (_, i) => a3(i, { alone: true, notes: true, legend: 70 }));
  const idx = sheetIndex(pages);
  assert.deepEqual(idx.sheets.map((s) => s.no), pages.map((_, i) => `PRJ-AB1-DWG-AR-${10140 + i}`));
  assert.deepEqual(idx.sheets.map((s) => s.title), pages.map((_, i) => realTitle(i)));
});

// PLAN 9.3: the user's A1 set (228 pages) holds 112 sheet numbers, up to 8 times each, the copies far
// apart (a tender set compiled from packages): no spot differed on 90 % of its pages and it got no
// sheets. Generated sets of that pattern, and the spots that must still find nothing.
/** 60 sheets: 40 numbers, the first 20 again at the end; page 3 refers to a repeated sheet, a sheet
 *  there once, the end of a number bare and with DETAIL before it */
const compiledNo = (i: number) => `PRJ-AB1-DWG-AR-${10101 + (i < 40 ? i : i - 40)}`;
const compiled = (size = A1) => Array.from({ length: 60 }, (_, i) => sheet(i, compiledNo(i), `PLAN ${i}`, i === 3 ? [
  [{ s: 'SEE', x: 300, y: 300 }, { s: 'PRJ-AB1-DWG-AR-10110', x: 330, y: 300 }],
  [{ s: 'SEE', x: 300, y: 340 }, { s: 'PRJ-AB1-DWG-AR-10130', x: 330, y: 340 }],
  [{ s: 'TYPE', x: 300, y: 380 }, { s: '10131', x: 350, y: 380 }],
  [{ s: 'DETAIL', x: 300, y: 420 }, { s: '10132', x: 350, y: 420 }],
] : [], size));

test('a set holding some sheets twice: every page numbered, marked as read where numbers repeat', () => {
  const pages = compiled();
  const idx = sheetIndex(pages);
  assert.deepEqual(idx.sheets.map((s) => s.no), pages.map((_, i) => compiledNo(i)));
  assert.ok(idx.sheets.every((s) => s.repeats));
});

test('repeating numbers are not taken on A4 paper, nor codes that repeat more', () => {
  assert.equal(sheetIndex(compiled(A4)).sheets.length, 0);
  // a zone code (8 values on 60 pages) and plain numbers that repeat are no sheet numbers
  const zone = Array.from({ length: 60 }, (_, i) => sheet(i, `ZONE-${i % 8}A`, `PLAN ${i}`));
  assert.equal(sheetIndex(zone).sheets.length, 0);
  assert.equal(repeatedNos(['A-1', 'A-2', 'A-1', 'A-2', 'A-3'], ['A-1', 'A-2', 'A-1', 'A-2', 'A-3']), false);
  const ten = Array.from({ length: 20 }, (_, i) => `A-${i % 10}`);
  assert.equal(repeatedNos(ten.map((x) => x.replace('A-', 'A')), ten), true);
  assert.equal(repeatedNos(ten, ten.map((x) => x.replace('A-', ''))), false);
});

// ---------------------------------------------------------------- the take-off's import (revisions.ts readSet)
import * as mupdf from 'mupdf';
import { readFileSync } from 'node:fs';
import { readSetPage, readSet, planImport, sheetFromPageText, type PageScan, type PageWord, type SetPage } from '../src/engine/qto/revisions';
import * as pf from '../src/ui/takeoff/pdfcore';

/** the same text as words, the way the take-off's drawing engine gives them (pdfcore pageWords) */
function wordsOf(lines: W[][]): PageWord[] {
  const out: PageWord[] = [];
  for (const l of lines) for (const w of l) {
    const h = w.h ?? 8;
    let k = 0;
    for (const part of w.s.split(' ')) {
      if (part) out.push({ t: part, x0: w.x + k * 0.6 * h, y0: w.y, x1: w.x + (k + part.length) * 0.6 * h, y1: w.y + h });
      k += part.length + 1;
    }
  }
  return out;
}
/** a sheet (title block at the right) as words: number with its "DWG NO" label, title, the usual fields */
function sheetWords(no: string | null, title: string, size = A1): { words: PageWord[]; size: { w: number; h: number } } {
  const { w, h } = size;
  const tb = (dx: number, dy: number, s: string, hh = 8): W[] => [{ s, x: w - dx * MM, y: h - dy * MM, h: hh }];
  const lines: W[][] = [[{ s: 'GROUND', x: 300, y: 300 }, { s: 'D-01', x: 400, y: 300 }], tb(150, 120, 'PROJECT PRJ-0042 SAMPLE TOWER'), tb(150, 100, title, 10), tb(150, 70, 'DATE 16.11.2026'), tb(100, 70, 'SCALE 1:100'), tb(150, 55, 'REV C02')];
  if (no) lines.push([{ s: 'DWG NO', x: w - 150 * MM, y: h - 40 * MM, h: 6 }, { s: no, x: w - 120 * MM, y: h - 40 * MM, h: 12 }]);
  return { words: wordsOf(lines), size };
}
/** a page of a bill of quantities as words - with a "Drawing No." column that names drawings, the bait for a page-by-page reading */
function boqWords(page: number): { words: PageWord[]; size: { w: number; h: number } } {
  const lines: W[][] = [[{ s: 'Item Description Drawing No. Qty Unit Rate Amount', x: 12 * MM, y: 18 * MM, h: 8 }]];
  for (let k = 0; k < 20; k++) {
    const y = (25 + k * 9) * MM;
    lines.push([{ s: String.fromCharCode(65 + (k % 8)), x: 12 * MM, y, h: 8 }, { s: 'Blockwork 200 mm to the', x: 22 * MM, y, h: 8 }, { s: `PRJ-AB1-DWG-AR-${10140 + ((page + k) % 12)}`, x: 80 * MM, y, h: 8 }, { s: String(10 + k), x: 128 * MM, y, h: 8 }, { s: amount(page * 31 + k, true), x: 170 * MM, y, h: 8 }]);
  }
  lines.push([{ s: 'Carried to collection', x: 60 * MM, y: 262 * MM, h: 9 }, { s: amount(page, true), x: 120 * MM, y: 262 * MM, h: 9 }]);
  return { words: wordsOf(lines), size: A4 };
}
const read = (list: { words: PageWord[]; size: { w: number; h: number } }[]): SetPage[] => list.map((p, i) => readSetPage(i, p.words, p.size));

test('a bound set with a bill of quantities: sheet numbers and titles for the drawings, nothing from the bill (the page-by-page reading took its drawing references)', () => {
  const list = [
    ...Array.from({ length: 12 }, (_, i) => sheetWords(`PRJ-AB1-DWG-AR-${10140 + i}`, `FLOOR PLAN LEVEL ${i + 1}`)),
    ...Array.from({ length: 30 }, (_, i) => boqWords(i)),
  ];
  const pages = readSet(read(list));
  assert.deepEqual(pages.slice(0, 12).map((p) => p.sheet), Array.from({ length: 12 }, (_, i) => `AR-${10140 + i}`), 'read as a file name is: the sheet number, codes in front kept apart');
  assert.deepEqual(pages.slice(0, 12).map((p) => p.title), Array.from({ length: 12 }, (_, i) => `FLOOR PLAN LEVEL ${i + 1}`), 'a title for every sheet');
  assert.ok(pages.slice(0, 12).every((p) => p.pre === 'PRJAB1DWG' && !p.repeats));
  assert.deepEqual(pages.slice(12).filter((p) => p.sheet || p.title), [], 'nothing from the bill of quantities');
  // (up to 0.22: each page on its own - the bill's pages each "had" a sheet number, the sheets no title)
  const before = list.map((p) => sheetFromPageText(p.words, p.size));
  const falseBefore = before.slice(12).filter((r) => r.sheet).length;
  const titledBefore = before.slice(0, 12).filter((r) => r.title).length;
  console.log(`   bill pages given a sheet number: ${falseBefore} -> 0; sheets with a title: ${titledBefore} -> 12`);
  assert.ok(falseBefore > 0, 'the old reading was fooled by the bill');
});

test('a set compiled from packages (numbers repeat): every page numbered and marked; the import keeps the numbers but never matches a repeated one to an earlier sheet', () => {
  const no = (i: number) => `PRJ-AB1-DWG-AR-${10101 + (i < 40 ? i : i - 40)}`;
  const pages = readSet(read(Array.from({ length: 60 }, (_, i) => sheetWords(no(i), `PLAN ${i}`))));
  assert.deepEqual(pages.map((p) => p.sheet), Array.from({ length: 60 }, (_, i) => no(i).replace('PRJ-AB1-DWG-', '')));
  assert.ok(pages.every((p) => p.repeats));
  // (up to 0.22 the same set: no number on a page whose number was on another - 40 of 60 blank)
  const scan: PageScan = { n: 60, pages };
  const file = { path: '/x/Set.pdf', rel: 'Set.pdf', size: 1, mtime: 1 };
  const old = (sheet: string, id: string) => ({ id, sheet, name: sheet + '.pdf', path: '/old/' + sheet + '.pdf', title: '', pages: 1 });
  const m = { drawings: [old('AR-10105', 'd1'), old('AR-10130', 'd2')], revisions: new Map() } as any;
  const rows = planImport([file], m, () => '', new Map([[file.path, scan]]));
  assert.equal(rows.length, 60);
  assert.deepEqual(rows.filter((r) => !r.sheet).map((r) => r.fp), [], 'every page keeps its number');
  assert.deepEqual(rows.filter((r) => r.action === 'rev').map((r) => [r.fp, r.target]), [[29, 'd2']], 'only a number that is once in the set finds its earlier sheet (AR-10105 is on pages 5 and 45: neither is matched)');
});

test('too few pages of a size to tell: drawing paper is read page by page as before; A4 is not', () => {
  const a4 = (no: string): { words: PageWord[]; size: { w: number; h: number } } => ({ words: wordsOf([[{ s: 'DWG NO', x: 100, y: 780, h: 6 }, { s: no, x: 150, y: 780, h: 10 }]]), size: A4 });
  const pages = readSet(read([sheetWords('PRJ-AB1-DWG-AR-20001', 'SITE PLAN'), sheetWords('PRJ-AB1-DWG-AR-20002', 'ROOF PLAN'), a4('PRJ-AB1-DWG-AR-20003'), a4('PRJ-AB1-DWG-AR-20004')]));
  assert.deepEqual(pages.map((p) => p.sheet), ['AR-20001', 'AR-20002', '', '']);
});

test('the same through the drawing engine: a generated set of A3 sheets and a bill of quantities, read from PDFium\'s words', async () => {
  const d = new mupdf.PDFDocument();
  const font = d.addSimpleFont(new mupdf.Font('Helvetica'));
  const A3W = 1190.55, A3H = 841.89, A4W = 595.28, A4H = 841.89;
  // (PDF space: y up - text placed from the bottom)
  const tx = (x: number, y: number, size: number, s: string) => `BT /F1 ${size} Tf ${x.toFixed(1)} ${y.toFixed(1)} Td (${s}) Tj ET`;
  const titles = ['GROUND FLOOR PLAN', 'FIRST FLOOR PLAN', 'ROOF PLAN', 'SECTION A-A', 'ELEVATIONS NORTH', 'DOOR SCHEDULE', 'TOILET DETAILS', 'STAIR DETAILS'];
  for (let i = 0; i < 8; i++) {
    const c = [tx(80, 700, 10, 'ROOM 101'), tx(300, 500, 10, 'D-01'), tx(A3W - 300, 150, 8, 'PROJECT PRJ-0042 SAMPLE TOWER'), tx(A3W - 300, 120, 11, titles[i]), tx(A3W - 300, 90, 8, 'SCALE 1:100'), tx(A3W - 300, 60, 6, 'DWG NO'), tx(A3W - 220, 60, 12, `PRJ-AB1-DWG-AR-${30100 + i}`), '0 G 1 w 40 40 m 1150 40 l 1150 800 l S'].join(' ');
    d.insertPage(-1, d.addPage([0, 0, A3W, A3H], 0, { Font: { F1: font } }, c));
  }
  for (let p = 0; p < 4; p++) {
    const rows = Array.from({ length: 20 }, (_, k) => [tx(34, 780 - k * 25, 8, String.fromCharCode(65 + k % 8)), tx(62, 780 - k * 25, 8, 'Blockwork 200 mm'), tx(230, 780 - k * 25, 8, `PRJ-AB1-DWG-AR-${30100 + (k % 8)}`), tx(480, 780 - k * 25, 8, amount(p * 31 + k, true))].join(' '));
    d.insertPage(-1, d.addPage([0, 0, A4W, A4H], 0, { Font: { F1: font } }, [tx(34, 810, 8, 'Item Description Drawing No. Amount'), ...rows, tx(340, 100, 9, amount(p, true))].join(' ')));
  }
  const bytes = d.saveToBuffer('').asUint8Array().slice();
  try { pf.mustP(); } catch {
    const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
    await pf.startEngine(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);
  }
  const { pages } = pf.openDoc('set', bytes.buffer as ArrayBuffer);
  const doc = pf.docs.get('set')!;
  const got = readSet(pages.map((size, i) => readSetPage(i, pf.pageWords(doc, i), size)));
  pf.closeDoc('set');
  assert.deepEqual(got.slice(0, 8).map((p) => p.sheet), Array.from({ length: 8 }, (_, i) => `AR-${30100 + i}`));
  assert.deepEqual(got.slice(0, 8).map((p) => p.title), titles);
  assert.deepEqual(got.slice(8).map((p) => p.sheet + p.title), ['', '', '', ''], 'the bill: nothing');
});
