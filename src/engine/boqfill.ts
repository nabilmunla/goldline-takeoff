// v0.16.2 "Filled copy": the consultant's own Excel BOQ, with the take-off quantities written in.
//
// Nabil (5 Nov 2026): the app used by the QS alone (the estimator keeps control of the BOQ); the QS quantities
// go back into the consultant's BOQ as a new column next to theirs, in a NEW copy - never into an existing file.
//
// - Every imported line remembers where it came from (src = importId:file:sheet:row) and every import
//   remembers its files, sheets, header rows and columns (imp:<id> files). So each line finds its row.
// - The copy is the consultant's file untouched except: two new columns after the last used one on each
//   sheet that has lines ("Takeoff QS Qty" and "Difference" = QS - BOQ, a live formula with its value), and one
//   new sheet for lines the consultant's BOQ doesn't have (additional items from a QS, lines added here).
//   Their formulas, merged cells, print setup, macros (.xlsm) stay as they are: nothing is moved.
// - A row is filled only if it still holds that line (its quantity or item ref as imported): a file that
//   changed since the import never gets numbers in the wrong rows. Lines not measured stay blank, not 0.
// No DOM, no Node: the zip and the XML are handled here (fflate), so it runs in the app and in tests.
import { unzipSync, zipSync, strFromU8, strToU8, type Zippable } from 'fflate';
import { readXlsx, colName, cellRef, decodeXml, shiftFormula } from './xlsx';
import { analyseSheet, parseNumber } from './boqimport';
import type { BoqModel, BoqNode } from './boq';

/** a quantity cell as a number: a figure, or a figure typed as text ("2,298"); null when empty or other text */
const qtyOf = (v: unknown): number | null => (typeof v === 'number' ? (Number.isFinite(v) ? v : null) : typeof v === 'string' ? parseNumber(v) : null);
/**
 * The row still holds this line (0.21 Deep ritual: quantities typed as text, as some client BOQs have them, count as
 * figures): its quantity; or its item ref with a quantity cell that is empty, a figure, or - when the import read
 * no quantity there ("Item", "Sum") - text again; or (neither imported) its description. Other text in a quantity
 * cell that had a figure is not this line's quantity: the row is left out, never a difference worked out on it.
 */
function holdsLine(l: { q0: number | null; ref: string; desc?: string }, qv: unknown, rv: unknown, dv: unknown): boolean {
  const qn = qtyOf(qv);
  if (l.q0 !== null && qn !== null && same(qn, l.q0)) return true;
  const qtyOk = qv === undefined || qv === null || qv === '' || qn !== null || l.q0 === null;
  if (!!l.ref && rv !== undefined && rv !== null && norm(String(rv)) === norm(l.ref) && qtyOk) return true;
  return l.q0 === null && !l.ref && typeof dv === 'string' && !!l.desc && norm(dv).startsWith(norm(l.desc).slice(0, 30)) && qtyOk;
}

export interface ImportSheet { name: string; headerRow?: number; cols?: Partial<Record<'ref' | 'desc' | 'qty' | 'unit' | 'rate' | 'amt', number>> }
export interface ImportFile { name: string; sheets: ImportSheet[] }

/** one BOQ line that came from the file */
export interface FillLine { si: number; row: number; ref: string; desc: string; q0: number | null; qs: number | null; id?: string }
/** a line the consultant's file doesn't have (an additional item from a QS, a line added in the app) */
export interface FillAdd { kind: 'qs' | 'app'; bill: string; loc: string; ref: string; desc: string; unit: string; qs: number | null; by: string; id?: string }
/** one file of one import, with everything to write into its copy */
export interface FillTarget { key: string; file: ImportFile; lines: FillLine[]; adds: FillAdd[] }

export interface FillResult {
  bytes: Uint8Array;
  /** lines with a quantity written */
  filled: number;
  /** lines found in the file but not measured (left blank) */
  blank: number;
  /** lines not written: their row doesn't hold them any more, or their sheet is gone */
  skipped: { sheet: string; row: number; ref: string; why: string }[];
  /** rows on the extra sheet */
  added: number;
  addSheet: string | null;
}

export const QS_HEAD = 'Measured Qty';
export const DIFF_HEAD = 'Difference (QS - BOQ)';
export const ADD_SHEET = 'Added lines';

/** importId:file:sheet:row (sheet / row may be missing on headings) */
export function parseSrc(src: string): { imp: string; fi: number; si: number | null; row: number | null } | null {
  const p = src.split(':');
  if (p.length < 2 || !p[0]) return null;
  const fi = Number(p[1]);
  if (!Number.isInteger(fi) || fi < 0) return null;
  const si = p.length > 2 ? Number(p[2]) : NaN;
  const row = p.length > 3 ? Number(p[3]) : NaN;
  return { imp: p[0], fi, si: Number.isInteger(si) && si >= 0 ? si : null, row: Number.isInteger(row) && row > 0 ? row : null };
}

/** the import records of a project: importId -> its files (as written by planToOps) */
export function parseImports(raw: Map<string, string> | undefined): Map<string, ImportFile[]> {
  const out = new Map<string, ImportFile[]>();
  for (const [id, v] of raw ?? []) {
    try {
      const a = JSON.parse(v);
      if (Array.isArray(a)) out.set(id, a.filter((f) => f && typeof f.name === 'string' && Array.isArray(f.sheets)));
    } catch { /* a damaged record: that import can't be filled */ }
  }
  return out;
}

/** a row of either model, reduced to what filling needs */
interface Row { id: string; par: string | null; kind: 'group' | 'item' | 'note'; src: string; ref: string; desc: string; unit: string; q0: number | null; qs: number | null; qa: '' | 'a' | 'n' | 'g'; loc: string; by: string; gone: boolean }

function targetsOf(rows: Row[], imports: Map<string, ImportFile[]>): FillTarget[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const targets = new Map<string, FillTarget>();
  const target = (imp: string, fi: number): FillTarget | null => {
    const key = imp + ':' + fi;
    let t = targets.get(key);
    if (!t) {
      const file = imports.get(imp)?.[fi];
      if (!file) return null;
      t = { key, file, lines: [], adds: [] };
      targets.set(key, t);
    }
    return t;
  };
  // the file a line belongs to: its own src, else the nearest heading above that came from a file
  const home = (r: Row): { t: FillTarget | null; bill: string } => {
    let bill = '';
    let cur: Row | undefined = r;
    for (let guard = 0; cur && guard < 64; guard++, cur = cur.par ? byId.get(cur.par) : undefined) {
      if (cur !== r && cur.kind === 'group' && !bill && cur.qa !== 'g') bill = [cur.ref, cur.desc].filter(Boolean).join(' ');
      const s = cur.src ? parseSrc(cur.src) : null;
      if (s) return { t: target(s.imp, s.fi), bill };
    }
    return { t: null, bill };
  };
  const loose: FillAdd[] = [];
  for (const r of rows) {
    if (r.gone || r.kind !== 'item' || r.qa === 'n') continue;
    const s = r.src ? parseSrc(r.src) : null;
    if (s && s.si !== null && s.row !== null && r.qa !== 'a') {
      const t = target(s.imp, s.fi);
      if (t) { t.lines.push({ si: s.si, row: s.row, ref: r.ref, desc: r.desc, q0: r.q0, qs: r.qs, id: r.id }); continue; }
    }
    // not from a file: an additional item from a QS always; a line added here only if it was measured
    if (r.qa !== 'a' && r.qs === null) continue;
    const h = home(r);
    const add: FillAdd = { kind: r.qa === 'a' ? 'qs' : 'app', bill: h.bill, loc: r.loc, ref: r.ref, desc: r.desc, unit: r.unit, qs: r.qs, by: r.by, id: r.id };
    if (h.t) h.t.adds.push(add); else loose.push(add);
  }
  const list = [...targets.values()].filter((t) => t.lines.length || t.adds.length);
  // lines with no file above them: with the first file (most projects have one)
  if (loose.length && list.length) list[0].adds.push(...loose);
  return list;
}

/** the estimation project: the Take-off column (every linked take-off project) */
export function targetsFromBoq(m: BoqModel): FillTarget[] {
  const rows: Row[] = [];
  for (const n of m.byId.values()) rows.push(rowOfNode(n));
  return targetsOf(rows, parseImports(m.imports));
}
function rowOfNode(n: BoqNode): Row {
  return {
    id: n.id, par: n.parent, kind: n.type === 'group' ? 'group' : n.type === 'item' ? 'item' : 'note', src: n.src, ref: n.ref, desc: n.desc, unit: n.unit,
    q0: n.q0, qs: n.tq, qa: n.qa ? n.qa.k : '', loc: n.qa?.loc ?? '', by: n.qa?.by ?? '', gone: n.deleted,
  };
}

/** the take-off project's copy of the BOQ: what this take-off measured per line */
export function targetsFromMirror(
  mirror: Iterable<{ id: string; bt: 'group' | 'item' | 'note'; par: string | null; src: string; ref: string; desc: string; unit: string; qty: number | null; q0?: number | null; qa: '' | 'a' | 'n' | 'g'; loc: string; qby: string }>,
  imports: Map<string, string>,
  totals: Map<string, number>,
): FillTarget[] {
  const rows: Row[] = [];
  for (const r of mirror) {
    const t = totals.get(r.id);
    // the consultant's quantity at import (a copy made by an older app has none: the BOQ quantity stands in)
    rows.push({ id: r.id, par: r.par, kind: r.bt, src: r.src, ref: r.ref, desc: r.desc, unit: r.unit, q0: r.q0 !== undefined ? r.q0 : r.qty, qs: t === undefined ? null : t, qa: r.qa, loc: r.loc, by: r.qby, gone: false });
  }
  return targetsOf(rows, parseImports(imports));
}

// ---------------------------------------------------------------- the workbook

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (x: number) => String(Number(x.toPrecision(15)));
const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
const same = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

/** workbook sheet name -> its part in the zip ("xl/worksheets/sheet3.xml") */
function sheetParts(files: Record<string, Uint8Array>): { parts: Map<string, string>; wbXml: string; relsXml: string } {
  const wbXml = strFromU8(files['xl/workbook.xml'] ?? new Uint8Array());
  const relsXml = strFromU8(files['xl/_rels/workbook.xml.rels'] ?? new Uint8Array());
  const target = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]*)"/.exec(m[0])?.[1];
    const t = /\bTarget="([^"]*)"/.exec(m[0])?.[1];
    if (id && t) target.set(id, t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, ''));
  }
  const parts = new Map<string, string>();
  for (const m of wbXml.matchAll(/<sheet\b[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(m[0])?.[1];
    const rid = /\b\w+:id="([^"]*)"/.exec(m[0])?.[1];
    if (name !== undefined && rid && target.has(rid)) parts.set(decodeXml(name), target.get(rid)!);
  }
  return { parts, wbXml, relsXml };
}

/** the last column used on a sheet: cells (styled empty ones too), merged ranges and the stated dimension */
function lastCol(xml: string): number {
  let max = 0;
  for (const m of xml.matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"/g)) max = Math.max(max, cellRef(m[1] + '1').c);
  for (const m of xml.matchAll(/<mergeCell\b[^>]*\bref="[A-Z]+\d+:([A-Z]+)\d+"/g)) max = Math.max(max, cellRef(m[1] + '1').c);
  const d = /<dimension\b[^>]*\bref="[A-Z]+\d+:([A-Z]+)\d+"/.exec(xml);
  if (d) max = Math.max(max, cellRef(d[1] + '1').c);
  return max;
}

interface CellOut { row: number; cells: string }

/** new cells added at the end of their rows (they are right of every used column, so the order stays right) */
function patchRows(xml: string, out: Map<number, CellOut>): { xml: string; missing: number[] } {
  const done = new Set<number>();
  const res = xml.replace(/<row\b([^>]*?)(\/>|>([\s\S]*?)<\/row>)/g, (whole, attrs: string, _end: string, inner: string | undefined) => {
    const r = Number(/\br="(\d+)"/.exec(attrs)?.[1]);
    const o = out.get(r);
    if (!o) return whole;
    done.add(r);
    // "spans" is a hint of the columns used: it no longer holds
    const a = attrs.replace(/\s+spans="[^"]*"/, '');
    return `<row${a}>${inner ?? ''}${o.cells}</row>`;
  });
  return { xml: res, missing: [...out.keys()].filter((r) => !done.has(r)) };
}

/** the style of a row's cell in a column (so the new cells look like the consultant's quantity cells) */
function styleAt(xml: string, ref: string): string {
  const m = new RegExp(`<c\\b[^>]*\\br="${ref}"[^>]*>`).exec(xml) ?? new RegExp(`<c\\b[^>]*\\br="${ref}"[^>]*/>`).exec(xml);
  const s = m ? /\bs="(\d+)"/.exec(m[0])?.[1] : undefined;
  return s ? ` s="${s}"` : '';
}

const strCell = (ref: string, text: string, s = '') => `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
const numCell = (ref: string, v: number, s = '') => `<c r="${ref}"${s}><v>${num(v)}</v></c>`;

/**
 * The filled copy of one consultant file. `bytes` = the consultant's .xlsx / .xlsm as it is on disk; the
 * result is a new workbook (the caller writes it to a NEW file).
 */
export function fillWorkbook(bytes: Uint8Array, t: FillTarget): FillResult {
  const files = unzipSync(bytes);
  if (!files['xl/workbook.xml']) throw new Error('This is not an Excel workbook (.xlsx / .xlsm).');
  // v0.16.3 (fresh-eyes review): a workbook written by another program in a form this doesn't patch safely
  // (prefixed tags "<x:row>", single-quoted attributes): refused with the way round - never a copy that is
  // half filled, or a sheet added that Excel doesn't list
  const odd = (xml: string) => /<[a-zA-Z]\w*:(workbook|sheets|sheet|worksheet|sheetData|row|c)\b/.test(xml) || /<(sheet|row|c)\b[^>]*\s(r|name|r:id|sheetId)='/.test(xml);
  const OTHER = 'This workbook was saved by another program in a form the Filled Copy does not change safely. Open it in Excel, Save As .xlsx, and pick that copy.';
  if (odd(strFromU8(files['xl/workbook.xml']))) throw new Error(OTHER);
  const wb = readXlsx(bytes);
  const { parts, wbXml, relsXml } = sheetParts(files);
  const res: FillResult = { bytes, filled: 0, blank: 0, skipped: [], added: 0, addSheet: null };
  const bySheet = new Map<number, FillLine[]>();
  for (const l of t.lines) bySheet.set(l.si, [...(bySheet.get(l.si) ?? []), l]);
  for (const [si, lines] of bySheet) {
    const sp = t.file.sheets[si];
    const part = sp ? parts.get(sp.name) : undefined;
    const qc = sp?.cols?.qty;
    if (!sp || !part || !files[part] || !qc) {
      for (const l of lines) res.skipped.push({ sheet: sp?.name ?? '?', row: l.row, ref: l.ref, why: !qc && part ? 'no quantity column was read at import' : 'the sheet is not in this file' });
      continue;
    }
    const ws = wb.sheet(sp.name);
    let xml = strFromU8(files[part]);
    if (odd(xml)) throw new Error(OTHER);
    // v0.16.2 (QA hunt BUG-001): the columns as they are in THIS file - a column inserted or deleted since the
    // import moves the quantity: found again from the sheet's own header row, as the importer finds it (the
    // import's columns only if the header can't be read)
    // Which columns: the import's, or the header's now - whichever more of the lines are found in (their quantity
    // or item ref where those columns say). A tie keeps the import's: columns picked by hand at the import stand.
    const now = (() => { try { return analyseSheet(wb, sp.name); } catch { return null; } })();
    const score = (c: ImportSheet['cols'] | null | undefined) => {
      if (!c?.qty) return -1;
      let n = 0;
      for (const l of lines) {
        const cells = ws.rows.get(l.row);
        const qv = cells?.[c.qty]?.v, rv = c.ref ? cells?.[c.ref]?.v : undefined;
        if (holdsLine(l, qv, rv, undefined)) n++;
      }
      return n;
    };
    const useNow = !!now?.cols?.qty && score(now.cols) > score(sp.cols);
    const cols = useNow ? now!.cols! : sp.cols!;
    const qc2 = cols.qty!;
    const qcol = colName(qc2), c1 = lastCol(xml) + 1, Q = colName(c1), D = colName(c1 + 1);
    const out = new Map<number, CellOut>();
    for (const l of lines) {
      const cells = ws.rows.get(l.row);
      const qv = cells?.[qc2]?.v;
      const rv = cols.ref ? cells?.[cols.ref]?.v : undefined;
      const dv = cells?.[cols.desc ?? 0]?.v;
      // the row still holds this line: its quantity, or its item ref with a quantity cell that is a number (a
      // revised quantity) or empty, or (neither imported) its description. A quantity cell with text in it is not
      // this line's quantity: the row is left out, never a difference worked out against it.
      const ok = holdsLine(l, qv, rv, dv);
      if (!ok) { res.skipped.push({ sheet: sp.name, row: l.row, ref: l.ref, why: 'that row holds something else now (the file changed since the import)' }); continue; }
      if (l.qs === null) { res.blank++; continue; }
      const s = styleAt(xml, qcol + l.row);
      const bq = qtyOf(qv) ?? 0;
      // (0.21 Deep ritual) their quantity typed as text ("2,298"): the difference as a figure - a formula on a
      // text cell depends on Excel's regional settings
      out.set(l.row, { row: l.row, cells: numCell(Q + l.row, l.qs, s) + (typeof qv === 'number' || qv == null || qv === '' ? `<c r="${D}${l.row}"${s}><f>${Q}${l.row}-${qcol}${l.row}</f><v>${num(l.qs - bq)}</v></c>` : numCell(D + l.row, l.qs - bq, s)) });
      res.filled++;
    }
    const hr = (useNow ? now!.headerRow : 0) || sp.headerRow || 0;
    if (hr > 0) {
      const s = styleAt(xml, qcol + hr);
      const prev = out.get(hr);
      // a header row that is also a line (it never is): the line's cells win
      if (!prev) out.set(hr, { row: hr, cells: strCell(Q + hr, QS_HEAD, s) + strCell(D + hr, DIFF_HEAD, s) });
    }
    const p = patchRows(xml, out);
    xml = widenCols(p.xml, [Q, D], 16);
    for (const r of p.missing) {
      const l = lines.find((x) => x.row === r);
      if (l && l.qs !== null) { res.filled--; res.skipped.push({ sheet: sp.name, row: r, ref: l.ref, why: 'the row is empty in the file' }); }
    }
    xml = xml.replace(/(<dimension\b[^>]*\bref="[A-Z]+\d+:)[A-Z]+(\d+")/, `$1${D}$2`);
    files[part] = strToU8(xml);
  }
  if (t.adds.length) Object.assign(res, addSheet(files, wbXml, relsXml, ADD_SHEET, {
    title: 'Lines the consultant\'s BOQ does not have (from Goldline Takeoff)',
    head: ['Kind', 'Bill', 'Location', 'Item', 'Description', 'Unit', QS_HEAD, 'Added by'],
    widths: [20, 28, 28, 10, 60, 8, 14, 20],
    rows: t.adds.map((a) => [a.kind === 'qs' ? 'Additional - QS' : 'Added in Goldline Takeoff', a.bill, a.loc, a.ref, a.desc, a.unit, a.qs, a.by]),
  }));
  // the same order as the consultant's zip (the new sheet last); the parts compress as usual
  const z: Zippable = {};
  for (const [k, v] of Object.entries(files)) z[k] = [v, { level: /\.(png|jpe?g|gif|emf|wmf|bin)$/i.test(k) ? 0 : 6 }];
  res.bytes = zipSync(z);
  return res;
}

/** the extra sheet: lines the consultant's BOQ doesn't have */
interface AddTable { title: string; head: string[]; widths: number[]; rows: (string | number | null)[][] }
function addSheet(files: Record<string, Uint8Array>, wbXml: string, relsXml: string, base: string, tbl: AddTable): { added: number; addSheet: string } {
  const names = new Set([...wbXml.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => decodeXml(m[1]).toLowerCase()));
  let name = base;
  for (let i = 2; names.has(name.toLowerCase()); i++) name = `${base} ${i}`;
  let n = 1;
  while (files[`xl/worksheets/sheet${n}.xml`]) n++;
  const part = `xl/worksheets/sheet${n}.xml`;
  // the same namespaces / relationship type / content type as the consultant's own sheets (transitional or strict)
  const anySheet = Object.keys(files).find((k) => /^xl\/worksheets\/[^/]+\.xml$/.test(k));
  const ns = (anySheet && /<worksheet\b[^>]*\bxmlns="([^"]*)"/.exec(strFromU8(files[anySheet]))?.[1]) || 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const relType = /Type="([^"]*\/worksheet)"/.exec(relsXml)?.[1] || 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
  const ctXml = strFromU8(files['[Content_Types].xml'] ?? new Uint8Array());
  const ct = /ContentType="([^"]*spreadsheetml\.worksheet\+xml)"/.exec(ctXml)?.[1] || 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
  const rows: string[] = [];
  const row = (r: number, cells: string) => rows.push(`<row r="${r}">${cells}</row>`);
  row(1, strCell('A1', tbl.title));
  row(3, tbl.head.map((h, i) => strCell(colName(i + 1) + 3, h)).join(''));
  tbl.rows.forEach((v, i) => {
    const r = i + 4;
    row(r, v.map((x, j) => (typeof x === 'number' ? numCell(colName(j + 1) + r, x) : x ? strCell(colName(j + 1) + r, x) : '')).join(''));
  });
  const cols = tbl.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${ns}"><cols>${cols}</cols><sheetData>${rows.join('')}</sheetData></worksheet>`;
  files[part] = strToU8(sheetXml);
  const rid = 'rIdTakeoffFill' + n;
  if (!relsXml.includes('</Relationships>') || !wbXml.includes('</sheets>') || !strFromU8(files['[Content_Types].xml'] ?? new Uint8Array()).includes('</Types>')) {
    throw new Error('This workbook was saved by another program in a form the Filled Copy does not change safely. Open it in Excel, Save As .xlsx, and pick that copy.');
  }
  files['xl/_rels/workbook.xml.rels'] = strToU8(relsXml.replace('</Relationships>', `<Relationship Id="${rid}" Type="${relType}" Target="worksheets/sheet${n}.xml"/></Relationships>`));
  // the relationships namespace, declared on the new entry itself (Excel declares it on the root, openpyxl on each
  // sheet entry: declaring it again is always valid)
  const pre = /<sheet\b[^>]*\b(\w+):id="/.exec(wbXml)?.[1] ?? 'r';
  const relNs = new RegExp(`xmlns:${pre}="([^"]*)"`).exec(wbXml)?.[1] ?? 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const ids = [...wbXml.matchAll(/<sheet\b[^>]*\bsheetId="(\d+)"/g)].map((m) => Number(m[1]));
  const sid = (ids.length ? Math.max(...ids) : 0) + 1;
  files['xl/workbook.xml'] = strToU8(wbXml.replace('</sheets>', `<sheet xmlns:${pre}="${relNs}" name="${esc(name)}" sheetId="${sid}" ${pre}:id="${rid}"/></sheets>`));
  files['[Content_Types].xml'] = strToU8(ctXml.replace('</Types>', `<Override PartName="/${part}" ContentType="${ct}"/></Types>`));
  return { added: tbl.rows.length, addSheet: name };
}

/** "BOQ Vol 3.xlsx" -> "BOQ Vol 3 - Filled Copy.xlsx" (.xlsm stays .xlsm) */
export function filledName(name: string): string {
  const m = /^(.*?)(\.xlsx|\.xlsm)?$/i.exec(name)!;
  return `${m[1]} - Filled Copy${m[2] ?? '.xlsx'}`;
}

// ---------------------------------------------------------------- 0.21 (M3-03 a): the PRICED copy
// The consultant's file, a NEW copy, with our printed selling rates and amounts in their own rate and amount
// columns (amount = printed rate x quantity; a formula they have in the amount cell is kept, with its value).
// Items not priced as such (included, n/a, excluded...) get their wording in the amount cell. The same
// safety as the Filled Copy: a row that no longer holds its line is refused, never written into. Lines the
// consultant's BOQ doesn't have go on their own sheet with their rates. Excel works the totals out again
// when the copy is opened (fullCalcOnLoad).
export const PRICED_SHEET = 'Takeoff priced lines';
export interface PriceOf { rate: number | null; amount: number | null; text: string | null }
export interface PriceLine extends FillLine { p: PriceOf; /** the BOQ quantity here (null: a lump sum) */ qty?: number | null }
export interface PriceAdd extends FillAdd { p: PriceOf; qty: number | null }
export interface PriceTarget { key: string; file: ImportFile; lines: PriceLine[]; adds: PriceAdd[] }
export interface PriceResult {
  bytes: Uint8Array;
  /** lines written with a rate and amount / with a wording */
  priced: number;
  texts: number;
  /** Σ of the amounts written (rows of the consultant's sheets + the extra sheet) */
  total: number;
  skipped: { sheet: string; row: number; ref: string; why: string }[];
  added: number;
  addSheet: string | null;
  /** sheets with no rate / amount column: written in two new columns at the end */
  newCols: string[];
  /** amounts written as figures in place of their formula: a lump sum, or their quantity differs from ours */
  asValues: number;
}

/** the priced copy's targets: every item with a price (`priceOf` null = nothing to write) */
export function priceTargetsFromBoq(m: BoqModel, priceOf: (n: BoqNode) => PriceOf | null): PriceTarget[] {
  const rows: Row[] = [];
  const pr = new Map<string, PriceOf>();
  for (const n of m.byId.values()) {
    const r = rowOfNode(n);
    if (n.type === 'item') {
      const p = priceOf(n);
      if (p) pr.set(n.id, p);
      // (the fill rule adds lines made here only when "measured": every priced one is)
      r.qs = p ? 0 : null;
      if (!p && r.qa === 'a') r.gone = true;
    }
    rows.push(r);
  }
  return targetsOf(rows, parseImports(m.imports)).map((t) => ({
    key: t.key, file: t.file,
    lines: t.lines.filter((l) => l.id && pr.has(l.id)).map((l) => ({ ...l, p: pr.get(l.id!)!, qty: m.byId.get(l.id!)?.qty ?? null })),
    adds: t.adds.filter((a) => a.id && pr.has(a.id)).map((a) => ({ ...a, p: pr.get(a.id!)!, qty: m.byId.get(a.id!)?.qty ?? null })),
  })).filter((t) => t.lines.length || t.adds.length);
}

const strInto = (ref: string, text: string, old: string | null) => {
  const s = old ? /\bs="(\d+)"/.exec(old)?.[1] : undefined;
  return strCell(ref, text, s ? ` s="${s}"` : '');
};

/**
 * Shared formulas (Excel saves a filled-down "=C5*E5" as one master + children): a master cell whose formula
 * is about to go would take every child's formula with it. Its group is written out as plain formulas first,
 * each child's references moved by its offset from the master (review M3 F4).
 */
function expandShared(xml: string, drop: Set<string>): string {
  const groups = new Set<string>();
  const master = new Map<string, { r: number; c: number; f: string }>();
  for (const m of xml.matchAll(/<c\b[^>]*?\br="([A-Z]+\d+)"[^>]*>\s*<f\b([^>]*)>([^<]*)<\/f>/g)) {
    const a = m[2];
    if (!/\bt="shared"/.test(a) || !/\bref="/.test(a)) continue;
    const si = /\bsi="(\d+)"/.exec(a)?.[1];
    if (si === undefined) continue;
    const at = cellRef(m[1]);
    master.set(si, { r: at.r, c: at.c, f: m[3] });
    if (drop.has(m[1])) groups.add(si);
  }
  if (!groups.size) return xml;
  // the master: a plain formula; each child: its own formula, moved
  return xml.replace(/(<c\b[^>]*?\br="([A-Z]+\d+)"[^>]*>\s*)<f\b([^>]*?)(?:\/>|>([^<]*)<\/f>)/g, (whole, head: string, ref: string, a: string) => {
    if (!/\bt="shared"/.test(a)) return whole;
    const si = /\bsi="(\d+)"/.exec(a)?.[1];
    if (si === undefined || !groups.has(si)) return whole;
    const mst = master.get(si)!;
    const at = cellRef(ref);
    return `${head}<f>${shiftFormula(mst.f, at.r - mst.r, at.c - mst.c)}</f>`;
  });
}
/** many rows' cells in one pass over the sheet (review M3 F11: one regex per line was minutes on a big BOQ) */
function setRowsCells(xml: string, rows: Map<number, Map<number, (old: string | null) => string>>): { xml: string; found: Set<number> } {
  const found = new Set<number>();
  const out = xml.replace(/<row\b([^>]*?)(\/>|>([\s\S]*?)<\/row>)/g, (whole, attrs: string, _e: string, inner: string | undefined) => {
    const r = Number(/\br="(\d+)"/.exec(attrs)?.[1]);
    const cells = rows.get(r);
    if (!cells) return whole;
    found.add(r);
    const have: { c: number; x: string }[] = [];
    for (const m of (inner ?? '').matchAll(/<c\b[^>]*?\br="([A-Z]+)\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)) have.push({ c: cellRef(m[1] + '1').c, x: m[0] });
    const keep = have.filter((h) => !cells.has(h.c));
    for (const [c, mk] of cells) keep.push({ c, x: mk(have.find((h) => h.c === c)?.x ?? null) });
    keep.sort((a, b) => a.c - b.c);
    return `<row${attrs.replace(/\s+spans="[^"]*"/, '')}>${keep.map((k) => k.x).join('')}</row>`;
  });
  return { xml: out, found };
}
const numAs = (ref: string, v: number, old: string | null, keepF: boolean) => {
  const s = old ? /\bs="(\d+)"/.exec(old)?.[1] : undefined;
  const f = keepF && old ? /<f\b[^>]*\/>|<f\b[^>]*>[\s\S]*?<\/f>/.exec(old)?.[0] : undefined;
  return `<c r="${ref}"${s ? ` s="${s}"` : ''}>${f ?? ''}<v>${num(v)}</v></c>`;
};

/** the priced copy of one consultant file (the caller writes it to a NEW file) */
export function pricedWorkbook(bytes: Uint8Array, t: PriceTarget): PriceResult {
  const files = unzipSync(bytes);
  if (!files['xl/workbook.xml']) throw new Error('This is not an Excel workbook (.xlsx / .xlsm).');
  const OTHER = 'This workbook was saved by another program in a form the priced copy does not change safely. Open it in Excel, Save As .xlsx, and pick that copy.';
  const odd = (xml: string) => /<[a-zA-Z]\w*:(workbook|sheets|sheet|worksheet|sheetData|row|c)\b/.test(xml) || /<(sheet|row|c)\b[^>]*\s(r|name|r:id|sheetId)='/.test(xml);
  if (odd(strFromU8(files['xl/workbook.xml']))) throw new Error(OTHER);
  const wb = readXlsx(bytes);
  const { parts, wbXml, relsXml } = sheetParts(files);
  const res: PriceResult = { bytes, priced: 0, texts: 0, total: 0, skipped: [], added: 0, addSheet: null, newCols: [], asValues: 0 };
  const bySheet = new Map<number, PriceLine[]>();
  for (const l of t.lines) bySheet.set(l.si, [...(bySheet.get(l.si) ?? []), l]);
  for (const [si, lines] of bySheet) {
    const sp = t.file.sheets[si];
    const part = sp ? parts.get(sp.name) : undefined;
    if (!sp || !part || !files[part] || !sp.cols?.qty) {
      for (const l of lines) res.skipped.push({ sheet: sp?.name ?? '?', row: l.row, ref: l.ref, why: !sp?.cols?.qty && part ? 'no quantity column was read at import' : 'the sheet is not in this file' });
      continue;
    }
    const ws = wb.sheet(sp.name);
    let xml = strFromU8(files[part]);
    if (odd(xml)) throw new Error(OTHER);
    // the columns as they are now (as the Filled Copy finds them), else the import's
    const now = (() => { try { return analyseSheet(wb, sp.name); } catch { return null; } })();
    const holds = (c: ImportSheet['cols'] | null | undefined, l: FillLine) => {
      if (!c?.qty) return false;
      const cells = ws.rows.get(l.row);
      const qv = cells?.[c.qty]?.v, rv = c.ref ? cells?.[c.ref]?.v : undefined, dv = cells?.[c.desc ?? 0]?.v;
      return holdsLine(l, qv, rv, dv);
    };
    const score = (c: ImportSheet['cols'] | null | undefined) => (c?.qty ? lines.filter((l) => holds(c, l)).length : -1);
    const cols = now?.cols?.qty && score(now.cols) > score(sp.cols) ? now.cols : sp.cols;
    let rc = cols.rate, ac = cols.amt;
    const plan = new Map<number, Map<number, (o: string | null) => string>>();
    if (!rc || !ac) {
      // no rate / amount column in this sheet: two new columns at the end, headed
      const c1 = lastCol(xml) + 1;
      rc = c1; ac = c1 + 1;
      res.newCols.push(sp.name);
      const hr = (now?.headerRow || sp.headerRow || 0);
      if (hr > 0) plan.set(hr, new Map([[rc, (o) => strInto(colName(rc!) + hr, 'Takeoff Rate', o)], [ac, (o) => strInto(colName(ac!) + hr, 'Takeoff Amount', o)]]));
    }
    const drop = new Set<string>();
    const planned: { l: PriceLine; amount: number | null; text: boolean; value: boolean }[] = [];
    for (const l of lines) {
      if (!holds(cols, l)) { res.skipped.push({ sheet: sp.name, row: l.row, ref: l.ref, why: 'that row holds something else now (the file changed since the import)' }); continue; }
      const R = colName(rc!) + l.row, A = colName(ac!) + l.row;
      const cells = plan.get(l.row) ?? new Map<number, (o: string | null) => string>();
      if (l.p.text !== null) {
        cells.set(ac!, (o) => strInto(A, l.p.text!, o));
        drop.add(A);
        planned.push({ l, amount: null, text: true, value: false });
      } else {
        // their amount formula stays when it gives our amount: their quantity is ours (a lump sum - no
        // quantity - or a quantity that differs would work out something else: the figure is written, F5)
        const theirQ = ws.rows.get(l.row)?.[cols.qty!]?.v;
        const keepF = l.qty !== null && l.qty !== undefined && typeof theirQ === 'number' && same(theirQ, l.qty);
        if (l.p.rate !== null) { cells.set(rc!, (o) => numAs(R, l.p.rate!, o, false)); drop.add(R); }
        if (l.p.amount !== null) { cells.set(ac!, (o) => numAs(A, l.p.amount!, o, keepF)); if (!keepF) drop.add(A); }
        // (0.21 sweep S5) rate only: their amount formula would put our rate x their quantity into their totals
        else if (l.p.rate !== null) { cells.set(ac!, (o) => strInto(A, 'Rate only', o)); drop.add(A); }
        planned.push({ l, amount: l.p.amount, text: false, value: l.p.amount !== null && !keepF });
      }
      plan.set(l.row, cells);
    }
    xml = expandShared(xml, drop);
    const w = setRowsCells(xml, plan);
    xml = w.xml;
    for (const x of planned) {
      if (!w.found.has(x.l.row)) { res.skipped.push({ sheet: sp.name, row: x.l.row, ref: x.l.ref, why: 'the row is empty in the file' }); continue; }
      if (x.text) res.texts++;
      else { res.priced++; if (x.amount !== null) res.total += x.amount; if (x.value) res.asValues++; }
    }
    if (res.newCols.includes(sp.name)) xml = xml.replace(/(<dimension\b[^>]*\bref="[A-Z]+\d+:)[A-Z]+(\d+")/, `$1${colName(ac!)}$2`);
    files[part] = strToU8(xml);
  }
  let wbx = strFromU8(files['xl/workbook.xml']);
  if (t.adds.length) {
    Object.assign(res, addSheet(files, wbx, strFromU8(files['xl/_rels/workbook.xml.rels'] ?? new Uint8Array()), PRICED_SHEET, {
      title: 'Priced lines the consultant\'s BOQ does not have (from Goldline Takeoff)',
      head: ['Bill', 'Item', 'Description', 'Unit', 'Quantity', 'Rate', 'Amount'],
      widths: [28, 10, 60, 8, 12, 14, 16],
      rows: t.adds.map((a) => [a.bill, a.ref, a.desc, a.unit, a.qty, a.p.text ?? a.p.rate, a.p.text ? null : a.p.amount]),
    }));
    for (const a of t.adds) if (!a.p.text && a.p.amount !== null) res.total += a.p.amount;
    wbx = strFromU8(files['xl/workbook.xml']);
  }
  // the calculation chain lists formula cells: some are figures or words now - Excel builds it again (F4)
  if (files['xl/calcChain.xml']) {
    delete files['xl/calcChain.xml'];
    const rels = strFromU8(files['xl/_rels/workbook.xml.rels'] ?? new Uint8Array());
    files['xl/_rels/workbook.xml.rels'] = strToU8(rels.replace(/<Relationship\b[^>]*\bTarget="[^"]*calcChain\.xml"[^>]*\/>/g, ''));
    const ct = strFromU8(files['[Content_Types].xml'] ?? new Uint8Array());
    files['[Content_Types].xml'] = strToU8(ct.replace(/<Override\b[^>]*\bPartName="\/xl\/calcChain\.xml"[^>]*\/>/g, ''));
  }
  // Excel works every total out again on opening (their collection pages, summaries)
  if (/<calcPr\b/.test(wbx)) wbx = wbx.replace(/<calcPr\b([^>]*?)(\/?)>/, (_m, a: string, sl: string) => `<calcPr${a.replace(/\s+fullCalcOnLoad="[^"]*"/, '')} fullCalcOnLoad="1"${sl}>`);
  else {
    const before = /<(oleSize|customWorkbookViews|pivotCaches|smartTagPr|smartTagTypes|webPublishing|fileRecoveryPr|webPublishObjects|extLst)\b/.exec(wbx);
    wbx = before ? wbx.slice(0, before.index) + '<calcPr fullCalcOnLoad="1"/>' + wbx.slice(before.index) : wbx.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>');
  }
  files['xl/workbook.xml'] = strToU8(wbx);
  const z: Zippable = {};
  for (const [k, v] of Object.entries(files)) z[k] = [v, { level: /\.(png|jpe?g|gif|emf|wmf|bin)$/i.test(k) ? 0 : 6 }];
  res.bytes = zipSync(z);
  return res;
}

/** "BOQ Vol 3.xlsx" -> "BOQ Vol 3 - Priced.xlsx" */
export function pricedName(name: string): string {
  const m = /^(.*?)(\.xls[xm])$/i.exec(name);
  return m ? `${m[1]} - Priced${m[2]}` : `${name} - Priced.xlsx`;
}

/** our two new columns get a readable width - only where the sheet doesn't already size them (their own
 *  column widths are never changed); <col> entries stay sorted and apart, as Excel requires */
export function widenCols(xml: string, letters: string[], width: number): string {
  const idx = (l: string) => [...l].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const want = letters.map(idx).sort((a, b) => a - b);
  const m = /<cols>([\s\S]*?)<\/cols>/.exec(xml);
  // the sheet's own entries are kept exactly as written (either form: <col .../> or <col ...></col>);
  // ours only go in between, in column order
  const cols: { min: number; max: number; tag: string }[] = [];
  if (m) for (const c of m[1].matchAll(/<col\b[^>]*?(?:\/>|>[\s\S]*?<\/col>)/g)) {
    const min = Number(/\bmin="(\d+)"/.exec(c[0])?.[1]), max = Number(/\bmax="(\d+)"/.exec(c[0])?.[1]);
    cols.push({ min: min || 0, max: max || min || 0, tag: c[0] });
  }
  const add = want.filter((i) => !cols.some((c) => i >= c.min && i <= c.max));
  if (!add.length) return xml;
  let body = m ? m[1] : '';
  for (const i of add) {
    const tag = `<col min="${i}" max="${i}" width="${width}" customWidth="1"/>`;
    const next = cols.find((c) => c.min > i);
    body = next ? body.replace(next.tag, () => tag + next.tag) : body + tag;
    cols.push({ min: i, max: i, tag });
    cols.sort((a, b) => a.min - b.min);
  }
  const block = '<cols>' + body + '</cols>';
  if (m) return xml.replace(m[0], () => block);
  return xml.replace(/<sheetData\b/, block + '<sheetData');
}
