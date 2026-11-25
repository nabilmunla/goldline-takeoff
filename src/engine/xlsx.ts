// Minimal, fast .xlsx reader for BOQ import.
// Reads exactly what the importer needs and nothing else: cell values (cached formula
// results), bold/underline/italic, merged ranges, hidden rows/sheets, and the print setup
// (page breaks, header/footer, paper, scale, row heights) to work out the printed pages.
// No DOM, no Node APIs: runs in the app, in a worker and in tests.
import { unzipSync, strFromU8 } from 'fflate';

export interface XFont {
  b: boolean;
  i: boolean;
  u: boolean;
  sz: number;
}

export interface XCell {
  /** value: text, number, boolean or null (errors come through as their text, e.g. "#REF!") */
  v: string | number | boolean | null;
  /** style index (into fonts via cellXfs) */
  s: number;
  /** formula text without the leading '=' (only with readXlsx(bytes, { formulas: true }); shared formulas expanded) */
  f?: string;
}

export interface XSheet {
  name: string;
  state: 'visible' | 'hidden' | 'veryHidden';
  /** rows by 1-based row number; each row is an array indexed by 1-based column (sparse) */
  rows: Map<number, XCell[]>;
  maxRow: number;
  maxCol: number;
  merges: { r1: number; c1: number; r2: number; c2: number }[];
  hiddenRows: Set<number>;
  hiddenCols: Set<number>;
  /** how the sheet prints: page breaks, header/footer, paper, scale, row heights */
  print: XPrint;
}

/** print setup of a sheet (everything needed to know which page a row prints on) */
export interface XPrint {
  /** first rows (1-based) of the pages that start at a manual page break, ascending */
  breaks: number[];
  /** header and footer texts with their Excel codes (&P, &A, &L…), first page / even pages included */
  hf: string[];
  /** the number printed on the first page, when set in Page Setup */
  firstPage: number | null;
  /** zoom in % (when not fitted to pages) */
  scale: number;
  fitToPage: boolean;
  fitW: number;
  fitH: number;
  /** Excel paper size code (9 = A4, 1 = Letter, 8 = A3…) */
  paper: number;
  landscape: boolean;
  /** margins in inches */
  margins: { l: number; r: number; t: number; b: number };
  /** print area rows / columns (null = whole sheet) */
  area: { r1: number; r2: number; c1: number; c2: number } | null;
  /** rows repeated at the top of every page */
  titles: { r1: number; r2: number } | null;
  /** row heights in points, only where they differ from the default */
  rowHt: Map<number, number>;
  defaultHt: number;
  /** column widths in characters, where set */
  colW: Map<number, number>;
  defaultColW: number;
  /** pixel width of a digit in the workbook's normal font (for column widths) */
  digitPx: number;
}

export interface XWorkbook {
  sheetNames: { name: string; state: XSheet['state'] }[];
  /** parses one sheet (lazily, so a 30-sheet workbook opens fast) */
  sheet(name: string): XSheet;
  font(s: number): XFont;
  /** decimals the cell's number format shows (null: general / not a fixed number of decimals) */
  decimals?(s: number): number | null;
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeXml(s: string): string {
  if (s.indexOf('&') >= 0) {
    s = s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) =>
      e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e],
    );
  }
  // Excel escapes control characters as _xHHHH_
  if (s.indexOf('_x') >= 0) s = s.replace(/_x([0-9a-fA-F]{4})_/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
  return s;
}

const attr = (tag: string, name: string): string | null => {
  // double or single quotes (some generators write name='value')
  const m = new RegExp('\\b' + name + '=(?:"([^"]*)"|\'([^\']*)\')').exec(tag);
  return m ? m[1] ?? m[2] : null;
};
/** "<x:c r=…>" (a namespace prefix on every tag, written by some exporters) -> "<c r=…>" */
const unprefix = (xml: string) => (/<[a-zA-Z0-9]+:(?:worksheet|sheetData|row|c|sst|si|t|workbook|sheet|styleSheet|font|xf)\b/.test(xml) ? xml.replace(/<(\/?)[a-zA-Z0-9]+:(?=[a-zA-Z])/g, '<$1') : xml);

/** "AB12" -> { r: 12, c: 28 } */
export function cellRef(ref: string): { r: number; c: number } {
  let c = 0, i = 0;
  for (; i < ref.length; i++) {
    const ch = ref.charCodeAt(i);
    if (ch < 65 || ch > 90) break;
    c = c * 26 + (ch - 64);
  }
  return { r: parseInt(ref.slice(i), 10), c };
}

export function colName(c: number): string {
  let s = '';
  while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); }
  return s;
}

/** all <t> texts inside one shared-string / inline-string item (rich text runs joined, phonetic runs skipped) */
function textOf(xml: string): string {
  xml = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  // the self-closing form first: "<t/>" must not run on to the next "</t>"
  const re = /<t\b[^>]*\/>|<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out += m[1] ?? '';
  return decodeXml(out);
}

function parseSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const out: string[] = [];
  const re = /<si\b[^>]*\/>|<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1] ? textOf(m[1]) : '');
  return out;
}

/** number formats built into Excel that show a fixed number of decimals (id -> decimals) */
const BUILTIN_DECIMALS: Record<number, number> = { 1: 0, 2: 2, 3: 0, 4: 2, 10: 2, 11: 2, 39: 2, 40: 2 };

function parseStyles(xml: string | null): { fonts: XFont[]; xfFont: number[]; xfDecimals: (number | null)[] } {
  const fonts: XFont[] = [];
  const xfFont: number[] = [];
  const xfDecimals: (number | null)[] = [];
  if (!xml) return { fonts, xfFont, xfDecimals };
  // custom number formats: how many decimals they show ("0.00" -> 2, "#,##0.000" -> 3)
  const custom = new Map<number, number | null>();
  {
    const re = /<numFmt\b([^>]*)\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) {
      const id = Number(attr(m[1], 'numFmtId'));
      const code = decodeXml(attr(m[1], 'formatCode') ?? '').split(';')[0].replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '');
      const d = /0\.(0+)/.exec(code);
      custom.set(id, d ? d[1].length : /0/.test(code) ? 0 : null);
    }
  }
  const fontsBlock = /<fonts\b[^>]*>([\s\S]*?)<\/fonts>/.exec(xml)?.[1] ?? '';
  const fre = /<font\b[^>]*\/>|<font\b[^>]*>([\s\S]*?)<\/font>/g;
  let m: RegExpExecArray | null;
  while ((m = fre.exec(fontsBlock))) {
    const f = m[1] ?? '';
    const flag = (tag: string) => {
      const t = new RegExp('<' + tag + '\\b([^>]*)/?>').exec(f);
      if (!t) return false;
      const v = attr(t[1], 'val');
      return !(v === '0' || v === 'false' || v === 'none');
    };
    const sz = Number(attr(/<sz\b[^>]*>/.exec(f)?.[0] ?? '', 'val') ?? 11);
    fonts.push({ b: flag('b'), i: flag('i'), u: flag('u'), sz: Number.isFinite(sz) ? sz : 11 });
  }
  const xfsBlock = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? '';
  const xre = /<xf\b([^>]*)\/?>/g;
  while ((m = xre.exec(xfsBlock))) {
    xfFont.push(Number(attr(m[1], 'fontId') ?? 0));
    const nf = Number(attr(m[1], 'numFmtId') ?? 0);
    xfDecimals.push(custom.has(nf) ? custom.get(nf)! : BUILTIN_DECIMALS[nf] ?? null);
  }
  return { fonts, xfFont, xfDecimals };
}

/**
 * Shift the relative references of a formula by (dr, dc) rows / columns ($ parts stay). Text inside "..." and '...'
 * (string literals, quoted sheet names) is left alone; a reference followed by "(" is a function name (LOG10).
 */
export function shiftFormula(f: string, dr: number, dc: number): string {
  return f.split(/("[^"]*"|'[^']*')/).map((part, i) => (i % 2 ? part : part.replace(/(?<![A-Za-z0-9_.])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\d(A-Za-z_])/g, (_m, ca: string, col: string, ra: string, row: string) => {
    const c = ca ? col : colName(Math.max(1, cellRef(col + '1').c + dc));
    const r = ra ? row : String(Math.max(1, Number(row) + dr));
    return `${ca}${c}${ra}${r}`;
  }))).join('');
}

export interface ReadOptions {
  /** keep each cell's formula in XCell.f (default false: formula text is not even looked at) */
  formulas?: boolean;
  /** (review M5 R13) refuse a workbook that unpacks to more than this (bytes, as its zip says): in all, and per part */
  maxUnpacked?: { total: number; entry: number };
}

/** the workbook unpacks to more than ReadOptions.maxUnpacked allows (nothing was unpacked) */
export class TooBigUnpacked extends Error {}

function parseSheet(name: string, state: XSheet['state'], xml: string, shared: string[], names: { area: string | null; titles: string | null }, digitPx: number, withF = false): XSheet {
  const masters = withF ? new Map<string, { r: number; c: number; f: string }>() : null;
  const rows = new Map<number, XCell[]>();
  const hiddenRows = new Set<number>();
  const hiddenCols = new Set<number>();
  const rowHt = new Map<number, number>();
  const colW = new Map<number, number>();
  let maxRow = 0, maxCol = 0;

  const colsBlock = /<cols\b[^>]*>([\s\S]*?)<\/cols>/.exec(xml)?.[1];
  if (colsBlock) {
    const re = /<col\b([^>]*)\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(colsBlock))) {
      const a = Number(attr(m[1], 'min')), b = Number(attr(m[1], 'max'));
      const hid = attr(m[1], 'hidden') === '1' || attr(m[1], 'hidden') === 'true';
      const w = Number(attr(m[1], 'width') ?? NaN);
      for (let c = a; c <= Math.min(b, a + 200); c++) {
        if (hid) hiddenCols.add(c);
        if (Number.isFinite(w)) colW.set(c, hid ? 0 : w);
      }
    }
  }

  const dataStart = xml.indexOf('<sheetData');
  const dataEnd = xml.indexOf('</sheetData>');
  const data = dataStart >= 0 && dataEnd > dataStart ? xml.slice(dataStart, dataEnd) : '';
  const rowRe = /<row\b([^>]*?)(\/>|>([\s\S]*?)<\/row>)/g;
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let rm: RegExpExecArray | null;
  let autoRow = 0;
  while ((rm = rowRe.exec(data))) {
    const rAttr = attr(rm[1], 'r');
    const r = rAttr ? Number(rAttr) : autoRow + 1;
    autoRow = r;
    if (attr(rm[1], 'hidden') === '1' || attr(rm[1], 'hidden') === 'true') hiddenRows.add(r);
    const ht = attr(rm[1], 'ht');
    if (ht !== null) rowHt.set(r, Number(ht));
    const body = rm[3];
    if (!body) continue;
    const cells: XCell[] = [];
    let autoCol = 0;
    let any = false;
    cellRe.lastIndex = 0;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(body))) {
      const a = cm[1];
      const ref = attr(a, 'r');
      const c = ref ? cellRef(ref).c : autoCol + 1;
      autoCol = c;
      const t = attr(a, 't');
      const s = Number(attr(a, 's') ?? 0);
      const inner = cm[2] ?? '';
      let v: XCell['v'] = null;
      if (t === 'inlineStr') {
        const is = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner)?.[1];
        v = is !== undefined ? textOf(is) : null;
      } else {
        const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        if (raw !== undefined) {
          if (t === 's') v = shared[Number(raw)] ?? '';
          else if (t === 'str' || t === 'e') v = decodeXml(raw);
          else if (t === 'b') v = raw === '1';
          else {
            const n = Number(raw);
            v = Number.isFinite(n) ? n : decodeXml(raw);
          }
        }
      }
      let f: string | undefined;
      if (masters) {
        const fm = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(inner);
        if (fm) {
          const fa = fm[1];
          const si = attr(fa, 'si');
          const txt = fm[2] !== undefined ? decodeXml(fm[2]) : '';
          if (attr(fa, 't') === 'shared' && si !== null) {
            if (txt) { masters.set(si, { r, c, f: txt }); f = txt; }
            else {
              const mst = masters.get(si);
              if (mst) f = shiftFormula(mst.f, r - mst.r, c - mst.c);
            }
          } else if (txt) f = txt;
        }
      }
      if (v === null && !s && f === undefined) continue;
      cells[c] = f === undefined ? { v, s } : { v, s, f };
      if (v !== null && v !== '') { any = true; if (c > maxCol) maxCol = c; }
    }
    if (cells.length) rows.set(r, cells);
    if (any && r > maxRow) maxRow = r;
  }

  const merges: XSheet['merges'] = [];
  const mBlock = /<mergeCells\b[^>]*>([\s\S]*?)<\/mergeCells>/.exec(xml)?.[1];
  if (mBlock) {
    const re = /<mergeCell\b[^>]*ref="([A-Z]+\d+):([A-Z]+\d+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(mBlock))) {
      const a = cellRef(m[1]), b = cellRef(m[2]);
      merges.push({ r1: a.r, c1: a.c, r2: b.r, c2: b.c });
    }
  }
  const print = parsePrint(xml, dataEnd, names, rowHt, colW, digitPx);
  return { name, state, rows, maxRow, maxCol, merges, hiddenRows, hiddenCols, print };
}

/** "$A$1:$F$547" / "$1:$2" (sheet name already removed) -> rows and columns */
function parseRange(s: string): { r1: number; r2: number; c1: number; c2: number } | null {
  const m = /^\$?([A-Z]{0,3})\$?(\d*):\$?([A-Z]{0,3})\$?(\d*)$/.exec(s.trim());
  if (!m) return null;
  const col = (t: string) => (t ? cellRef(t + '1').c : 0);
  return { c1: col(m[1]) || 1, r1: m[2] ? Number(m[2]) : 1, c2: col(m[3]) || 16384, r2: m[4] ? Number(m[4]) : 1048576 };
}
/** the parts of a defined name that belong to one sheet: "'Bill 2'!$A$1:$F$9,'Bill 2'!$1:$2" -> ["$A$1:$F$9", "$1:$2"] */
function rangesOf(def: string): string[] {
  return def.split(',').map((p) => p.trim()).filter((p) => p && !p.includes('#REF')).map((p) => p.slice(p.lastIndexOf('!') + 1));
}

function parsePrint(xml: string, dataEnd: number, names: { area: string | null; titles: string | null }, rowHt: Map<number, number>, colW: Map<number, number>, digitPx: number): XPrint {
  // print settings come after the cell data; the sheet format before it
  const tail = dataEnd >= 0 ? xml.slice(dataEnd) : xml;
  const head = xml.slice(0, Math.max(0, xml.indexOf('<sheetData')));
  const fmt = /<sheetFormatPr\b([^>]*)\/?>/.exec(head)?.[1] ?? '';
  const defaultHt = Number(attr(fmt, 'defaultRowHeight') ?? 15) || 15;
  const baseW = Number(attr(fmt, 'baseColWidth') ?? 8);
  const defaultColW = Number(attr(fmt, 'defaultColWidth') ?? NaN) || baseW + 0.43;
  const breaks: number[] = [];
  const rb = /<rowBreaks\b[^>]*>([\s\S]*?)<\/rowBreaks>/.exec(tail)?.[1];
  if (rb) {
    const re = /<brk\b([^>]*)\/?>/g;
    let m: RegExpExecArray | null;
    // id = the number of rows above the break: the new page starts at row id + 1
    while ((m = re.exec(rb))) { const id = Number(attr(m[1], 'id')); if (Number.isFinite(id) && id > 0) breaks.push(id + 1); }
    breaks.sort((a, b) => a - b);
  }
  const ps = /<pageSetup\b([^>]*)\/?>/.exec(tail)?.[1] ?? '';
  const pr = /<pageSetUpPr\b([^>]*)\/?>/.exec(head)?.[1] ?? '';
  const pm = /<pageMargins\b([^>]*)\/?>/.exec(tail)?.[1] ?? '';
  const num = (t: string, k: string, d: number) => { const v = Number(attr(t, k)); return attr(t, k) !== null && Number.isFinite(v) ? v : d; };
  const hf: string[] = [];
  const hfb = /<headerFooter\b[^>]*>([\s\S]*?)<\/headerFooter>/.exec(tail)?.[1];
  if (hfb) {
    const re = /<(oddFooter|oddHeader|firstFooter|firstHeader|evenFooter|evenHeader)\b[^>]*>([\s\S]*?)<\/\1>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(hfb))) hf.push(decodeXml(m[2]));
  }
  const fp = attr(ps, 'useFirstPageNumber');
  let area: XPrint['area'] = null, titles: XPrint['titles'] = null;
  if (names.area) for (const p of rangesOf(names.area)) { const r = parseRange(p); if (r) { area = r; break; } }
  if (names.titles) for (const p of rangesOf(names.titles)) {
    const r = parseRange(p);
    if (r && /^\$?\d+:\$?\d+$/.test(p.trim())) { titles = { r1: r.r1, r2: r.r2 }; break; }
  }
  return {
    breaks,
    hf,
    firstPage: fp === '1' || fp === 'true' ? num(ps, 'firstPageNumber', 1) : null,
    scale: num(ps, 'scale', 100),
    fitToPage: attr(pr, 'fitToPage') === '1' || attr(pr, 'fitToPage') === 'true',
    fitW: num(ps, 'fitToWidth', 1),
    fitH: num(ps, 'fitToHeight', 1),
    paper: num(ps, 'paperSize', 9),
    landscape: attr(ps, 'orientation') === 'landscape',
    margins: { l: num(pm, 'left', 0.7), r: num(pm, 'right', 0.7), t: num(pm, 'top', 0.75), b: num(pm, 'bottom', 0.75) },
    area,
    titles,
    rowHt,
    defaultHt,
    colW,
    defaultColW,
    digitPx,
  };
}

function resolvePath(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const p of target.split('/')) {
    if (p === '..') parts.pop();
    else if (p !== '.') parts.push(p);
  }
  return parts.join('/');
}

export function readXlsx(bytes: Uint8Array, opts?: ReadOptions): XWorkbook {
  const withF = opts?.formulas === true;
  let files: Record<string, Uint8Array>;
  const cap = opts?.maxUnpacked;
  let total = 0, over = '';
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (!(f.name.endsWith('.xml') || f.name.endsWith('.rels'))) return false;
        if (cap) {
          total += f.originalSize;
          if (f.originalSize > cap.entry || total > cap.total) { over ||= f.name; return false; }
        }
        return !over;
      },
    });
  } catch {
    throw new Error('This is not an .xlsx file (or it is damaged). Old .xls files must be saved as .xlsx first.');
  }
  if (over && cap) throw new TooBigUnpacked(`This workbook unpacks to more than ${Math.round((total > cap.total ? cap.total : cap.entry) / 1048576)} MB of sheets (${over.split('/').pop()}). A Prelims workbook is a few MB inside too: it is not opened here. Save a copy without the oversized sheet, or check the file.`);
  const text = (p: string) => (files[p] ? unprefix(strFromU8(files[p])) : null);
  const wbXml = text('xl/workbook.xml');
  if (!wbXml) throw new Error('This file has no workbook inside. Is it really an Excel workbook?');
  const rels = text('xl/_rels/workbook.xml.rels') ?? '';
  const relMap = new Map<string, string>();
  {
    const re = /<Relationship\b([^>]*)\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rels))) {
      const id = attr(m[1], 'Id'), target = attr(m[1], 'Target');
      if (id && target) relMap.set(id, resolvePath('xl/workbook.xml', target));
    }
  }
  const sheetNames: XWorkbook['sheetNames'] = [];
  const paths = new Map<string, string>();
  // print area / print titles, by the sheet's position in the workbook
  const defNames = new Map<string, { area: string | null; titles: string | null }>();
  {
    const re = /<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(wbXml))) {
      const nm = attr(m[1], 'name');
      const at = attr(m[1], 'localSheetId');
      if (at === null || (nm !== '_xlnm.Print_Area' && nm !== '_xlnm.Print_Titles')) continue;
      const e = defNames.get(at) ?? { area: null, titles: null };
      if (nm === '_xlnm.Print_Area') e.area = decodeXml(m[2]); else e.titles = decodeXml(m[2]);
      defNames.set(at, e);
    }
  }
  const sheetIdx = new Map<string, number>();
  {
    const re = /<sheet\b([^>]*)\/?>/g;
    let m: RegExpExecArray | null;
    let idx = -1;
    while ((m = re.exec(wbXml))) {
      idx++;
      const name = decodeXml(attr(m[1], 'name') ?? '');
      const st = attr(m[1], 'state');
      const state: XSheet['state'] = st === 'hidden' ? 'hidden' : st === 'veryHidden' ? 'veryHidden' : 'visible';
      const rid = /\br:id="([^"]*)"/.exec(m[1])?.[1] ?? attr(m[1], 'id');
      const p = rid ? relMap.get(rid) : undefined;
      if (!p || !files[p]) continue; // chart sheets, dialog sheets…
      sheetNames.push({ name, state });
      paths.set(name, p);
      sheetIdx.set(name, idx);
    }
  }
  const shared = parseSharedStrings(text('xl/sharedStrings.xml'));
  const { fonts, xfFont, xfDecimals } = parseStyles(text('xl/styles.xml'));
  // the normal font sets how wide a "character" of column width is (Calibri 11: 7 px)
  const digitPx = Math.max(5, Math.round((fonts[0]?.sz ?? 11) * 0.64));
  const cache = new Map<string, XSheet>();
  const plain: XFont = { b: false, i: false, u: false, sz: 11 };
  return {
    sheetNames,
    sheet(name: string) {
      let s = cache.get(name);
      if (!s) {
        const p = paths.get(name);
        if (!p) throw new Error('No sheet called ' + name);
        const st = sheetNames.find((x) => x.name === name)!.state;
        s = parseSheet(name, st, text(p) ?? '', shared, defNames.get(String(sheetIdx.get(name))) ?? { area: null, titles: null }, digitPx, withF);
        cache.set(name, s);
      }
      return s;
    },
    font(s: number) {
      return fonts[xfFont[s] ?? 0] ?? plain;
    },
    decimals(s: number) {
      return xfDecimals[s] ?? null;
    },
  };
}
