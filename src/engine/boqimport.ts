// Excel BOQ import: rules, not AI.
//
// 1. analyseFile(): for every sheet, find the column header row (Item / Description /
//    Qty / Unit / Rate / Amount), then classify every row:
//      item     - has a unit or a quantity (or a ref plus a rate/amount/status)
//      note     - description text that belongs to the items below it ("description line")
//      head     - bold text with nothing else on the row
//      skip     - page furniture (repeated page headers), repeated column headers,
//                 "To Collection" / "Carried to..." rows, collection and summary pages,
//                 "(CONT'D)" headings and headings repeated on every page
//    Heading levels come from CAPS > numbered ("5.01", "8.2") > other bold text, and are
//    corrected by the "(CONT'D)" blocks that consultants print at each page break,
//    which spell out the real heading chain.
// 2. planToOps(): turns the (possibly user-corrected) plan into project rows.
// Nothing is dropped silently: every skipped row is counted with its reason, and the
// reconciliation compares what came in with what the sheet says.
import { generateNKeysBetween } from 'fractional-indexing';
import type { XWorkbook, XSheet } from './xlsx';
import type { Op, Value } from './types';
import { randomId } from './ids';
import type { Status } from './boq';
import { applyPattern, pageBreaks, pageIndexOf, pagePattern, type PageMethod } from './pages';

export type ColKey = 'ref' | 'desc' | 'qty' | 'unit' | 'rate' | 'amt';
export type ColMap = Partial<Record<ColKey, number>> & { desc: number };
export const COL_LABEL: Record<ColKey, string> = { ref: 'Item', desc: 'Description', qty: 'Qty', unit: 'Unit', rate: 'Rate', amt: 'Amount' };

export type RowKind = 'item' | 'note' | 'head' | 'skip';
export type SkipWhy = 'top' | 'page' | 'header' | 'collection' | 'summary' | 'cont' | 'title' | 'blank' | 'user';
export const SKIP_LABEL: Record<SkipWhy, string> = {
  top: 'title block at the top',
  page: 'page header (repeated on every page)',
  header: 'repeated column headings',
  collection: '"To collection" / "Carried to…" lines',
  summary: 'collection and summary pages',
  cont: '"(CONT\'D)" and repeated headings',
  title: 'bill title (used as the bill name)',
  blank: 'rows with only zeros or stray numbers',
  user: 'left out by you',
};


export interface SrcRow {
  /** sheet row number (1-based) */
  r: number;
  kind: RowKind;
  why?: SkipWhy;
  /** its kind or level was set by hand in the preview (kept when a column is changed) */
  user?: boolean;
  ref: string;
  desc: string;
  unit: string;
  qty: number | null;
  rate: number | null;
  amt: number | null;
  /** status found in the row (Included, N/A, PS…) */
  st: Status | null;
  /** the original text, kept when it says more than the status label */
  stx: string;
  /** "Rate only" */
  ro: boolean;
  /** this line is a provisional sum */
  ps: boolean;
  page: string;
  /** the page was worked out (Excel's automatic page break), not read from the file */
  pest?: boolean;
  bold: boolean;
  /** heading depth inside the sheet: 1 = directly under the sheet */
  level: number;
}

export interface SheetPlan {
  name: string;
  include: boolean;
  /** why it was left out (shown next to the sheet) */
  reason: string;
  headerRow: number;
  cols: ColMap | null;
  /** the sheet as a bill: e.g. ref "Bill 02", title "SITEWORK - SECTION B" */
  ref: string;
  title: string;
  rows: SrcRow[];
  /** a priced BOQ (rates or amounts present) */
  priced: boolean;
  /** "To Collection" totals printed in the sheet (priced BOQs) */
  collected: number;
  /** last "Carried to … summary / tender" amount printed in the sheet */
  carried: number | null;
  /** cells showing an Excel error (#REF!, #N/A…) where a quantity, rate or amount should be */
  errCells: number;
  /** rows hidden in Excel (with something in them): left out, as Excel leaves them out of the print */
  hiddenRows?: number;
  /** quantities written as text that were read with their unit ("25 m2") */
  qtyFromText?: number;
  /** how the consultant's page numbers were found */
  pages: { method: PageMethod; count: number; est: number; pattern: string | null; listed: number };
}

export interface FilePlan {
  name: string;
  ref: string;
  title: string;
  sheets: SheetPlan[];
}

// ---------------------------------------------------------------- helpers
const NUM_RE = /^\s*\(?-?[\d,]*\.?\d+\)?\s*$/;
export function parseNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || !NUM_RE.test(v)) return null;
  const neg = /^\s*\(.*\)\s*$/.test(v) || /^\s*-/.test(v);
  const n = Number(v.replace(/[(),\s-]/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

const CONT_RE = /\s*[(\[]?\s*cont(?:inued|['’`*´]?d)\.?\s*[)\]]?\s*$/i;
export const isCont = (s: string) => CONT_RE.test(s);
export const norm = (s: string) =>
  s.replace(CONT_RE, '').toLowerCase().replace(/[’'`*]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// end-of-page lines ("brought forward" lines start a page, so they are summary lines, not terminators)
const TERMINATOR_RE = /^\s*(to\s+collection|carried\s+(to|forward|fwd|over)|c\/f\b|total\s+carried|page\s+total|total\s+to\s+(collection|summary))/i;
const UNIT_WORD_RE = /^(items?|ls|l\.s\.?|lump\s*sum|sum|no\.?|nos\.?|nr\.?|sets?|m|lm|m2|m²|sqm|m3|m³|cum|kg|t|tonnes?|hrs?|hours?|days?|weeks?|months?|%)$/i;
const SUMMARY_HEAD_RE = /^\s*(collection|bill\s+summary|general\s+summary|grand\s+summary|summary|collection\s+page|summary\s+of\s+bill.*)(\s*(no\.?\s*)?\d{1,3})?\s*$/i;
const SUMMARY_ROW_RE = /^\s*((total\s+)?(brought|back|bought)\s+(forward|fwd)|b\/f\b|page\s*:?\s*[a-z0-9]+\s*\/\s*\d+|page\s+no\.?\s*[a-z0-9]+)/i;
const PAGE_RE = /^\s*([A-Z]{1,4}\d?|bill\s*\d+)\s*\/\s*\d+[A-Z]?\s*$/i;
const BILL_TITLE_RE = /^\s*bill\s*(no\.?\s*)?0*(\d+[a-z]?)\b\s*[-–:.]*\s*(.*)$/i;

const HEADER_SYNONYMS: Record<ColKey, RegExp> = {
  ref: /^(item|item\s*no\.?|ref\.?|reference|no\.?|s\.?\s*no\.?|sr\.?\s*no\.?|code)$/i,
  desc: /^(description|item\s+description|description\s+of\s+works?|particulars)$/i,
  qty: /^(qty\.?|quantity|quantities|quant\.?)$/i,
  unit: /^(unit|units|uom|u\.o\.m\.?)$/i,
  rate: /^(rate|unit\s+rate|rate\s*\(?(aed|dhs?|usd)?\)?|rate\s+aed)$/i,
  amt: /^(amount|total|amount\s*\(?(aed|dhs?|usd)?\)?|amount\s+aed|total\s+amount)$/i,
};

function headerOf(texts: Map<number, string>): ColMap | null {
  const found: Partial<Record<ColKey, number>> = {};
  for (const [c, t] of texts) {
    const s = t.replace(/\s+/g, ' ').trim();
    for (const k of Object.keys(HEADER_SYNONYMS) as ColKey[]) {
      if (found[k] === undefined && HEADER_SYNONYMS[k].test(s)) { found[k] = c; break; }
    }
  }
  if (found.desc === undefined) return null;
  const extras = (['qty', 'unit', 'rate', 'amt'] as ColKey[]).filter((k) => found[k] !== undefined).length;
  if (extras < 2 || (found.qty === undefined && found.unit === undefined)) return null;
  return found as ColMap;
}

const isCaps = (s: string) => {
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (letters.length < 3) return false;
  const up = letters.replace(/[^A-Z]/g, '').length;
  return up / letters.length >= 0.9;
};
const NUMBERED_RE = /^\s*\(?(\d+(?:\.\d+)*)[.)]?\s+\S/;
function rankOf(text: string): number {
  if (isCaps(text)) return 30;
  const m = NUMBERED_RE.exec(text);
  if (m) return 20 - (m[1].split('.').length - 1);
  return 10;
}

export function statusOf(text: string): { st: Status | null; ro: boolean; keep: boolean } {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return { st: null, ro: false, keep: false };
  if (/^rate\s*only\.?$/i.test(t)) return { st: null, ro: true, keep: false };
  if (/optional/i.test(t)) return { st: 'opt', ro: false, keep: !/^optional$/i.test(t) };
  if (/^(p\.?\s?s\.?|provisional\s+sums?|prov\.?\s+sum)$/i.test(t)) return { st: 'ps', ro: false, keep: false };
  if (/\bp\.?s\.?\b|provisional/i.test(t) && !/incl/i.test(t)) return { st: 'ps', ro: false, keep: true };
  if (/employer|by\s+client|by\s+others|supply\s+by/i.test(t)) return { st: 'emp', ro: false, keep: !/^by\s+employer$/i.test(t) };
  if (/^incl|included|\bincl\b/i.test(t)) return { st: 'incl', ro: false, keep: !/^incl(uded|\.)?$/i.test(t) };
  if (/^(n\.?\s*\/?\s*a\.?|not\s+applicable|nil|excluded|not\s+required)$/i.test(t)) return { st: 'na', ro: false, keep: !/^n\.?\s*\/?\s*a\.?$/i.test(t) };
  return { st: 'txt', ro: false, keep: true };
}

/** units of things priced as a whole (a rate without a quantity is expected there) */
const LUMP_UNIT_RE = /^(items?|ls|l\.s\.?|lump\s*sum|sum|p\.?\s?s\.?|prov.*|nos?\.?|nr\.?|sets?|lot|%)$/i;
const PS_UNIT_RE = /^(p\.?\s?s\.?|prov\.?\s*sum|provisional\s+sum|ps\s*sum)$/i;
const PS_DESC_RE = /^\s*(allow\s+(the\s+)?|include\s+(the\s+)?|the\s+)?(provisional|prov\.)\s+sums?\b|\(\s*provisional\s+sums?\s*\)\s*$/i;

/** "2-2026.07.13-ABC-TOWER- Bill 02- Pod.xlsx" -> cleaned per the whole set */
export function cleanFileNames(names: string[]): string[] {
  const base = names.map((n) => n.replace(/\.(xlsx|xlsm|xls)$/i, '').replace(/^\s*\d+\s*[-_.]\s*/, ''));
  if (base.length < 2) return base.map((b) => b.trim());
  let pre = base[0];
  for (const b of base) while (pre && !b.startsWith(pre)) pre = pre.slice(0, -1);
  // cut back to a separator so we don't chop a word
  const cut = Math.max(pre.lastIndexOf('-'), pre.lastIndexOf('_'), pre.lastIndexOf(' '));
  pre = cut > 0 ? pre.slice(0, cut + 1) : '';
  pre = pre.replace(/\bbill\s*(no\.?)?\s*$/i, ''); // never cut "Bill 02" in half
  return base.map((b) => (b.slice(pre.length).replace(/^[\s\-_.]+/, '').trim() || b.trim()));
}

export function splitBillTitle(text: string): { ref: string; title: string } | null {
  const m = BILL_TITLE_RE.exec(text.replace(CONT_RE, ''));
  if (!m) return null;
  const n = m[2];
  return { ref: 'Bill ' + (n.length === 1 ? '0' + n : n), title: m[3].replace(/^[-–:.\s]+/, '').trim() };
}

const SKIP_SHEET_RE = /^(cover(\s*page)?|preambles?|summary|sum|grand\s+summary|general\s+summary|index|contents|notes?|instructions?|form\s+of\s+tender|tender\s+summary)$/i;

// ---------------------------------------------------------------- analysis
interface RawRow {
  r: number;
  texts: Map<number, string>;
  nums: Map<number, number>;
  bold: Map<number, boolean>;
  /** decimals the number format shows, for numbers in cells with a fixed format ("3.10") */
  dec: Map<number, number>;
}

function readRows(wb: XWorkbook, sh: XSheet, hidden?: { n: number }): RawRow[] {
  const out: RawRow[] = [];
  const rowsSorted = [...sh.rows.keys()].sort((a, b) => a - b);
  for (const r of rowsSorted) {
    if (sh.hiddenRows.has(r)) {
      if (hidden && (sh.rows.get(r) ?? []).some((c) => c && c.v !== null && c.v !== '')) hidden.n++;
      continue;
    }
    const cells = sh.rows.get(r)!;
    const texts = new Map<number, string>();
    const nums = new Map<number, number>();
    const bold = new Map<number, boolean>();
    const dec = new Map<number, number>();
    for (let c = 1; c < cells.length; c++) {
      const cell = cells[c];
      if (!cell || cell.v === null || cell.v === '' || sh.hiddenCols.has(c)) continue;
      if (typeof cell.v === 'number') {
        nums.set(c, cell.v);
        const d = wb.decimals?.(cell.s);
        if (d !== null && d !== undefined) dec.set(c, d);
      }
      else if (typeof cell.v === 'string') {
        const t = cell.v.replace(/\r/g, '').trim();
        if (!t) continue;
        texts.set(c, t);
      } else continue;
      bold.set(c, wb.font(cell.s).b);
    }
    if (texts.size || nums.size) out.push({ r, texts, nums, bold, dec });
  }
  return out;
}

/** force = columns chosen by the user in the preview (header row number + column numbers) */
/**
 * The sheet read again with other columns (a column picked by hand in the preview). What was set by hand is
 * kept: rows classified by hand keep their kind and level, and a sheet left out stays out (0.23.2, DeepSeek #3:
 * both were lost, and the import wrote another structure than the preview had shown).
 */
export function remapSheet(wb: XWorkbook, cur: SheetPlan, cols: ColMap): SheetPlan {
  const next = analyseSheet(wb, cur.name, { headerRow: cur.headerRow, cols });
  const had = cur.rows.some((r) => r.kind === 'item');
  next.include = had ? cur.include : next.rows.some((r) => r.kind === 'item');
  next.ref = cur.ref; next.title = cur.title;
  const byHand = new Map(cur.rows.filter((r) => r.user).map((r) => [r.r, r]));
  for (const n of next.rows) {
    const o = byHand.get(n.r);
    if (o) { n.kind = o.kind; n.why = o.why; n.level = o.level; n.user = true; }
  }
  return next;
}

export function analyseSheet(wb: XWorkbook, name: string, force?: { headerRow: number; cols: ColMap }): SheetPlan {
  const meta = wb.sheetNames.find((s) => s.name === name)!;
  const plan: SheetPlan = { name, include: false, reason: '', headerRow: 0, cols: null, ref: '', title: name.trim(), rows: [], priced: false, collected: 0, carried: null, errCells: 0, pages: { method: 'none', count: 0, est: 0, pattern: null, listed: 0 } };
  if (meta.state !== 'visible') { plan.reason = 'hidden sheet'; return plan; }
  const sh = wb.sheet(name);
  const hidden = { n: 0 };
  const raw = readRows(wb, sh, hidden);
  plan.hiddenRows = hidden.n;

  // column header row: the first row that looks like Item / Description / Qty / Unit / Rate / Amount
  let header: ColMap | null = null;
  let headerIdx = -1;
  if (force) {
    header = force.cols;
    headerIdx = Math.max(0, raw.findIndex((row) => row.r >= force.headerRow));
    if (raw[headerIdx] && raw[headerIdx].r !== force.headerRow) headerIdx = Math.max(0, headerIdx - 1);
  } else {
    for (let i = 0; i < raw.length && i < 120; i++) {
      const h = headerOf(raw[i].texts);
      if (h) { header = h; headerIdx = i; break; }
    }
  }
  if (!header) {
    plan.reason = SKIP_SHEET_RE.test(name.trim()) ? 'cover / summary page' : 'no BOQ columns (Description, Qty, Unit…)';
    return plan;
  }
  plan.cols = header;
  plan.headerRow = raw[headerIdx].r;
  const headerTexts = raw[headerIdx] ? [...raw[headerIdx].texts.entries()].map(([c, t]) => c + '=' + t.toLowerCase()).join('|') : '';
  const sig = (row: RawRow) => {
    const h = headerOf(row.texts);
    if (h) return h.desc === header!.desc;
    return !!force && [...row.texts.entries()].map(([c, t]) => c + '=' + t.toLowerCase()).join('|') === headerTexts;
  };
  const C = header;
  const textAt = (row: RawRow, c: number | undefined) => (c === undefined ? '' : row.texts.get(c) ?? '');
  const numAt = (row: RawRow, c: number | undefined) => (c === undefined ? null : row.nums.get(c) ?? parseNumber(row.texts.get(c)));
  const firstText = (row: RawRow) => {
    const keys = [...row.texts.keys()].sort((a, b) => a - b);
    return keys.length ? row.texts.get(keys[0])! : '';
  };

  // rows of page furniture: before the first header, and between a terminator and the next header
  const headerIdxs = raw.map((row, i) => (i >= headerIdx && sig(row) ? i : -1)).filter((i) => i >= 0);
  const furniture = new Set<number>();
  for (let i = 0; i < headerIdx; i++) furniture.add(i);
  let page = '';
  let pageNo = 0;
  /** where the printed page numbers are (sheet rows): at the top or the bottom of each page */
  const labelsAt: { r: number; label: string }[] = [];
  const pageOf = new Map<number, string>();
  {
    // what the top of the sheet says (project, bill title, "BILL OF QUANTITIES"…): page furniture
    // repeats it on every page; anything else after a "To Collection" is content (a new section
    // starting mid-page), and an item line always is
    // (the same, or nearly: "EXTERNAL WORKS - PODIUM" on the next part's pages where the top said "- GROUND")
    const wordsOf = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1));
    const topWords: Set<string>[] = [];
    for (let i = 0; i < headerIdx; i++) for (const t of raw[i].texts.values()) topWords.push(wordsOf(t));
    const likeTop = (t: string) => {
      const w = wordsOf(t);
      if (!w.size) return true;
      return topWords.some((x) => { let n = 0; for (const k of w) if (x.has(k)) n++; return n / (w.size + x.size - n) >= 0.6; });
    };
    const furn = (row: RawRow) => {
      if (numAt(row, C.qty) !== null && textAt(row, C.desc)) return false;
      return [...row.texts.values()].every((t) => likeTop(t) || PAGE_RE.test(t) || TERMINATOR_RE.test(t) || /^\s*(page|issued|date|rev(ision)?)\b/i.test(t) || splitBillTitle(t) !== null);
    };
    let hp = 0;
    for (let i = headerIdx + 1; i < raw.length; i++) {
      if (!TERMINATOR_RE.test(firstText(raw[i]))) continue;
      while (hp < headerIdxs.length && headerIdxs[hp] <= i) hp++;
      const next = headerIdxs[hp];
      if (next !== undefined && next - i <= 25) {
        for (let j = i + 1; j < next; j++) {
          if (!furn(raw[j])) break;
          furniture.add(j);
        }
      }
    }
  }
  // explicit page numbers printed in the furniture (e.g. "B/2"), else count pages
  const explicitPages = raw.some((row, i) => furniture.has(i) && [...row.texts.values()].some((t) => PAGE_RE.test(t)));
  const titleFromTop = (() => {
    // bill titles printed in the page headers; if they vary page to page (e.g. "EXTERNAL WORKS - POD",
    // "EXTERNAL WORKS - TOWER") keep the part they share
    const seen: { ref: string; title: string }[] = [];
    raw.forEach((row, i) => {
      if (!furniture.has(i)) return;
      for (const t of row.texts.values()) { const b = splitBillTitle(t); if (b && b.title) { seen.push(b); break; } }
    });
    if (!seen.length) return null;
    const same = seen.filter((b) => b.ref === seen[0].ref).map((b) => b.title);
    let pre = same[0];
    for (const t of same) while (pre && !t.startsWith(pre)) pre = pre.slice(0, -1);
    if (pre !== same[0]) {
      const cut = Math.max(pre.lastIndexOf(' - '), pre.lastIndexOf(' – '));
      pre = (cut > 0 ? pre.slice(0, cut) : pre).replace(/[\s\-–,]+$/, '');
    }
    return { ref: seen[0].ref, title: pre || seen[0].title };
  })();
  if (titleFromTop) { plan.ref = titleFromTop.ref; plan.title = titleFromTop.title; }

  const rows: SrcRow[] = [];
  let inSummary = false;
  let sheetTitleNorm = titleFromTop ? norm(titleFromTop.ref + ' ' + titleFromTop.title) : '';
  let sawContent = false;
  let collected = 0;
  let anyRate = false, anyAmt = false;

  const mk = (row: RawRow, kind: RowKind, why?: SkipWhy): SrcRow => ({
    r: row.r, kind, why, ref: '', desc: '', unit: '', qty: null, rate: null, amt: null, st: null, stx: '', ro: false, ps: false, page, bold: false, level: 0,
  });

  for (let i = 0; i < raw.length; i++) {
    const row = raw[i];
    if (furniture.has(i)) {
      for (const t of row.texts.values()) if (PAGE_RE.test(t)) { page = t.replace(/\s+/g, ''); labelsAt.push({ r: row.r, label: page }); }
      rows.push(mk(row, 'skip', i < headerIdx ? 'top' : 'page'));
      continue;
    }
    if (i === headerIdx || sig(row)) {
      if (!explicitPages && i > headerIdx) { /* a repeated header means a new page */ }
      rows.push(mk(row, 'skip', 'header'));
      continue;
    }
    let lead = firstText(row);
    // "Z | Carried to Summary | 50": the terminator can sit in the description column too
    if (!TERMINATOR_RE.test(lead) && TERMINATOR_RE.test(textAt(row, C.desc))) lead = textAt(row, C.desc);
    if (TERMINATOR_RE.test(lead)) {
      const amt = numAt(row, C.amt) ?? numAt(row, C.rate);
      const s = mk(row, 'skip', inSummary ? 'summary' : 'collection');
      s.desc = lead;
      s.amt = amt;
      if (!inSummary && /^\s*to\s+collection/i.test(lead) && amt) collected += amt;
      if (amt !== null && /summary|tender|bill/i.test(lead)) plan.carried = amt;
      rows.push(s);
      inSummary = false;
      if (!explicitPages) { pageNo++; page = ''; }
      continue;
    }

    let ref = textAt(row, C.ref);
    const refNum = C.ref === undefined ? null : row.nums.get(C.ref) ?? null;
    // a number shown as Excel shows it: 3.1 formatted "0.00" is item 3.10, not 3.1
    if (!ref && refNum !== null && refNum !== 0) { const d = row.dec.get(C.ref!); ref = d !== undefined ? refNum.toFixed(d) : String(refNum); }
    let desc = textAt(row, C.desc);
    // a heading typed in the Item column (often merged across the row): it is the description
    if (!desc && ref && C.ref !== undefined && (ref.length > 12 || /\s/.test(ref) || /^[A-Z][A-Z&'-]{3,}$/.test(ref)) && ![C.qty, C.unit, C.rate, C.amt].some((c) => c !== undefined && (row.nums.has(c) || row.texts.has(c)))) { desc = ref; ref = ''; }
    if (ref.length > 12) ref = ''; // long text in the Item column is not a reference
    // text that sits left of the description column (merged across) counts as description
    if (!desc) for (const [c, t] of row.texts) if (c < C.desc && c !== C.ref) { desc = t; break; }
    const unitText = textAt(row, C.unit);
    const unitNum = C.unit === undefined ? null : row.nums.get(C.unit) ?? null;
    let qty = numAt(row, C.qty);
    let qtyText = qty === null ? textAt(row, C.qty) : '';
    let unitFromQty = '';
    // "25 m2", "1,200.50 m³": a quantity written as text with its unit
    if (qty === null && qtyText) {
      const m = /^\s*(\(?-?[\d,]*\.?\d+\)?)\s*([a-zA-Z²³][a-zA-Z²³.\/]{0,6})\s*$/.exec(qtyText);
      const n = m ? parseNumber(m[1]) : null;
      if (m && n !== null && UNIT_WORD_RE.test(m[2].replace(/\.$/, '') )) { qty = n; unitFromQty = m[2]; qtyText = ''; plan.qtyFromText = (plan.qtyFromText ?? 0) + 1; }
    }
    // an Excel error where a number should be (#REF!, #N/A…): counted, shown as a warning
    for (const c of [C.qty, C.rate, C.amt]) if (c !== undefined && /^#(REF!|N\/A|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!)/.test(textAt(row, c))) plan.errCells++;
    const rate = numAt(row, C.rate);
    const rateText = rate === null ? textAt(row, C.rate) : '';
    const amt = numAt(row, C.amt);
    const amtText = amt === null ? textAt(row, C.amt) : '';
    let unit = unitText && unitNum === null ? unitText : unitFromQty;
    // header-like rows that don't fully match (e.g. summary pages: Item | Description | Page No. | Amount)
    if (HEADER_SYNONYMS.desc.test(desc) && (!ref || HEADER_SYNONYMS.ref.test(ref))) {
      rows.push(mk(row, 'skip', 'header'));
      continue;
    }
    // a 0 left by a formula in the quantity column of a label row is not a quantity
    if (qty === 0 && !unit && !ref) qty = null;
    // an amount against a quantity of 0 (and no rate): the amount is a lump sum, not 0 x something
    if (qty === 0 && amt !== null && amt !== 0 && (rate === null || rate === 0)) qty = null;
    // the unit typed in the quantity column ("Item", "LS")
    if (!unit && qty === null && UNIT_WORD_RE.test(qtyText)) unit = qtyText;

    if (!ref && qty === null && !unit && SUMMARY_HEAD_RE.test((desc || lead).replace(CONT_RE, ''))) {
      inSummary = true;
      const s = mk(row, 'skip', 'summary');
      s.desc = desc || lead;
      rows.push(s);
      continue;
    }
    if (inSummary || SUMMARY_ROW_RE.test(desc || lead)) {
      const s = mk(row, 'skip', 'summary');
      s.desc = desc || lead;
      rows.push(s);
      continue;
    }

    // statuses can be in the amount, rate, unit or even quantity column
    let st: Status | null = null, stx = '', ro = false;
    for (const t of [amtText, rateText, unitText && !/^[a-z0-9.²³/% ]{1,8}$/i.test(unitText) ? unitText : '', qtyText === unit ? '' : qtyText]) {
      if (!t) continue;
      const s = statusOf(t);
      if (s.ro) { ro = true; if (t === unitText) unit = ''; continue; }
      if (s.st && !st) {
        st = s.st;
        if (s.keep) stx = t;
        if (t === unitText) unit = '';
      }
    }
    if (/^rate\s*only$/i.test(unitText)) { ro = true; unit = ''; }
    // a percentage line ("allow 10 %") has a rate that is not money: never extend it
    if (unit === '%' && qty === null) ro = true;

    const bold = !!(row.bold.get(C.desc) ?? [...row.bold.values()].some(Boolean));
    const hasRef = !!ref;
    // "B | Allow for testing and commissioning": an item priced as a lump sum, not a description
    const allowance = hasRef && !unit && qty === null && /^(allow|allowance|provide|include)\b/i.test(desc);
    const isItem = (!!desc || hasRef) && (!!unit || qty !== null || allowance || (hasRef && (rate !== null || (amt !== null && amt !== 0) || st !== null || ro)));
    if (isItem) {
      const s = mk(row, 'item');
      Object.assign(s, { ref, desc, unit, qty, rate, amt, st, stx, ro, bold });
      if (rate !== null && rate !== 0) anyRate = true;
      if (amt !== null && amt !== 0) anyAmt = true;
      s.ps = PS_UNIT_RE.test(unitText.trim()) || PS_DESC_RE.test(desc);
      if (s.ps && st === 'ps') { s.st = null; s.stx = ''; }
      if (!explicitPages) s.page = (plan.ref || name.trim()) + '/' + (pageNo + 1);
      rows.push(s);
      sawContent = true;
      continue;
    }
    // priced BOQs: a lump sum written against a description line or a heading
    const lump = amt !== null && amt !== 0 ? amt : rate !== null && rate !== 0 && C.amt === undefined ? rate : null;
    if (lump !== null && desc && !hasRef) {
      if (!bold || desc.length > 160) {
        const s = mk(row, 'item');
        Object.assign(s, { desc, rate: rate ?? null, amt: lump, bold });
        // "Allow the Provisional Sum for landscaping | 400,000": its amount comes in even unpriced
        s.ps = PS_DESC_RE.test(desc);
        if (!explicitPages) s.page = (plan.ref || name.trim()) + '/' + (pageNo + 1);
        rows.push(s);
        anyAmt = true;
        sawContent = true;
        continue;
      }
      // a heading with an amount: keep the heading, put the amount on a line right under it
      const h = mk(row, 'head');
      Object.assign(h, { desc, bold: true });
      rows.push(h);
      const s = mk(row, 'item');
      Object.assign(s, { desc: rateText || 'Lump sum', rate: null, amt: lump });
      s.ps = PS_DESC_RE.test(desc);
      if (!explicitPages) s.page = (plan.ref || name.trim()) + '/' + (pageNo + 1);
      rows.push(s);
      anyAmt = true;
      sawContent = true;
      continue;
    }
    if (!desc) {
      // numbers with no description: leftovers such as a lone 0 from a formula
      const s = mk(row, 'skip', 'blank');
      rows.push(s);
      continue;
    }
    if (hasRef || !bold || desc.length > 160) {
      const s = mk(row, 'note');
      Object.assign(s, { ref, desc, bold });
      if (!explicitPages) s.page = (plan.ref || name.trim()) + '/' + (pageNo + 1);
      if (isCont(desc) && !hasRef) { s.kind = 'skip'; s.why = 'cont'; }
      rows.push(s);
      if (s.kind === 'note') sawContent = true;
      continue;
    }
    // bold text alone on its row: a heading
    if (SUMMARY_HEAD_RE.test(desc.replace(CONT_RE, ''))) {
      inSummary = true;
      const s = mk(row, 'skip', 'summary');
      s.desc = desc;
      rows.push(s);
      continue;
    }
    const s = mk(row, 'head');
    Object.assign(s, { desc, bold: true });
    // the first "BILL nn - …" heading names the sheet
    const bt = splitBillTitle(desc);
    if (bt && !sawContent && !sheetTitleNorm) {
      plan.ref = bt.ref;
      plan.title = bt.title || plan.title;
      sheetTitleNorm = norm(desc);
      s.kind = 'skip';
      s.why = 'title';
    } else if ((sheetTitleNorm && (norm(desc) === sheetTitleNorm || (bt && norm(bt.ref + ' ' + bt.title) === sheetTitleNorm))) || (bt && sawContent && plan.ref && bt.ref === plan.ref)) {
      // the bill's own title printed again on a later page ("BILL 19 - MEP WORKS - SECTION R")
      s.kind = 'skip';
      s.why = 'cont';
    } else if (!sawContent && !rows.some((x) => x.kind === 'head') && plan.title && norm(desc) === norm(plan.title)) {
      // first heading just repeats the bill title ("PRELIMINARIES AND GENERAL REQUIREMENTS")
      s.kind = 'skip';
      s.why = 'title';
      sheetTitleNorm = sheetTitleNorm || norm(desc);
    }
    rows.push(s);
  }

  // PS headings make everything under them provisional sums (handled when building the tree)
  assignLevels(rows);

  plan.pages = assignPages(sh, name, plan, rows, explicitPages, pageNo, labelsAt);
  plan.rows = rows;
  plan.collected = Math.round(collected * 100) / 100;
  plan.priced = anyRate || anyAmt;
  const items = rows.filter((r) => r.kind === 'item').length;
  if (!items) { plan.reason = 'no items'; return plan; }
  plan.include = !SKIP_SHEET_RE.test(name.trim());
  if (!plan.include) plan.reason = 'cover / summary page';
  return plan;
}

/**
 * The consultant's page of each line, from the best source the sheet has (see pages.ts):
 * page numbers printed in cells > the printed page number of the page setup (page breaks,
 * Excel's own breaks estimated) > pages counted at "To Collection" lines > an estimate.
 */
function assignPages(sh: XSheet, name: string, plan: SheetPlan, rows: SrcRow[], explicit: boolean, counted: number, labelsAt: { r: number; label: string }[] = []): SheetPlan['pages'] {
  const paged = rows.filter((r) => r.kind === 'item' || r.kind === 'note');
  // page numbers printed at the BOTTOM of each page (lines come before the first one): a line is on
  // the page whose number comes next, not the one before it
  if (explicit && labelsAt.length && paged.length && paged[0].r < labelsAt[0].r) {
    let k = 0;
    for (const r of paged) {
      while (k < labelsAt.length && labelsAt[k].r < r.r) k++;
      r.page = (labelsAt[k] ?? labelsAt[labelsAt.length - 1]).label;
    }
  }
  const distinct = () => new Set(paged.map((r) => r.page).filter(Boolean)).size;
  // the collection page lists the pages it collects ("Bill 03 - Concrete Works /9"): a check on the count
  let listed = 0;
  for (const r of rows) {
    if (r.kind !== 'skip' || (r.why !== 'summary' && r.why !== 'collection')) continue;
    const m = /\/\s*(\d{1,4})\s*$/.exec(r.desc);
    if (m) listed = Math.max(listed, Number(m[1]));
  }
  if (explicit) return { method: 'labels', count: distinct(), est: 0, pattern: null, listed: 0 };
  const pattern = pagePattern(sh.print.hf);
  const bill = (plan.ref || name.trim()) + '/';
  if (pattern || sh.print.breaks.length || counted === 0) {
    const pb = pageBreaks(sh);
    const first = sh.print.firstPage ?? 1;
    const estPages = new Set<number>();
    for (const r of paged) {
      const i = pageIndexOf(pb.starts, r.r);
      r.page = pattern ? applyPattern(pattern, name, first + i) : bill + (first + i);
      // without any page breaks or page number in the file, every page is a guess
      r.pest = pb.est[i] || (!pattern && !sh.print.breaks.length) || undefined;
      if (r.pest) estPages.add(i);
    }
    const method: PageMethod = pattern || sh.print.breaks.length ? 'print' : 'estimated';
    return { method, count: distinct(), est: estPages.size, pattern, listed };
  }
  return { method: 'counted', count: distinct(), est: 0, pattern: null, listed };
}

/**
 * Heading levels. A heading closes every open heading of the same or lower rank
 * (CAPS > numbered > other bold), so consecutive equal headings are siblings.
 * Runs of "(CONT'D)" / repeated headings after a page break re-open the chain they
 * name; when that chain shows a heading sitting under an earlier one, the earlier
 * levels are corrected.
 */
export function assignLevels(rows: SrcRow[]) {
  type Open = { idx: number; rank: number; key: string };
  let stack: Open[] = [];
  let runStart: Open[] | null = null; // stack as it was when the current run of headings began
  let runPtr = 0;
  let lastWasHeadRun = false;
  const heads: number[] = []; // indices of heading rows so far

  const levelOf = (idx: number) => rows[idx].level;
  const subtreeEnd = (idx: number, upto: number) => {
    // last row index inside the subtree of heading idx (exclusive bound upto)
    const L = levelOf(idx);
    for (let j = idx + 1; j < upto; j++) if (rows[j].kind === 'head' && rows[j].level <= L) return j;
    return upto;
  };
  const pathTo = (idx: number): Open[] => {
    const path: Open[] = [];
    let L = levelOf(idx);
    path.unshift({ idx, rank: rankOf(rows[idx].desc), key: norm(rows[idx].desc) });
    for (let j = idx - 1; j >= 0 && L > 1; j--) {
      if (rows[j].kind === 'head' && rows[j].level < L) {
        path.unshift({ idx: j, rank: rankOf(rows[j].desc), key: norm(rows[j].desc) });
        L = rows[j].level;
      }
    }
    return path;
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const contentRow = row.kind === 'item' || row.kind === 'note';
    if (contentRow) { lastWasHeadRun = false; continue; }
    const contLike = (row.kind === 'skip' && row.why === 'cont') || row.kind === 'head';
    if (!contLike) continue;
    if (row.kind === 'skip' && row.why === 'cont' && (!row.bold && row.desc && !isCont(row.desc))) continue;
    if (!lastWasHeadRun) { runStart = stack.slice(); runPtr = 0; lastWasHeadRun = true; }

    // the sheet's own title repeated on a new page: back to the top
    if (row.kind === 'skip' && row.why === 'cont' && !row.desc) { stack = []; runPtr = 0; continue; }
    if (row.kind === 'skip' && row.why === 'cont' && row.bold && !isCont(row.desc) && /^\s*bill\b/i.test(row.desc)) { stack = []; runPtr = 0; continue; }
    if (row.kind === 'skip' && row.why === 'cont' && row.bold && splitBillTitle(row.desc)) { stack = []; runPtr = 0; continue; }

    const key = norm(row.desc);
    const explicit = isCont(row.desc);
    // does it continue a heading that was open when this run began?
    const base = runStart ?? [];
    let k = -1;
    for (let j = runPtr; j < base.length; j++) if (base[j].key === key) { k = j; break; }
    if (k >= 0) {
      const top = stack[stack.length - 1];
      const expectedParent = k > 0 ? base[k - 1] : null;
      if (top && expectedParent && top.idx !== expectedParent.idx && rows[base[k].idx].level === rows[top.idx].level) {
        // the CONT'D chain puts base[k] under `top`, which we had as its sibling: fix the levels
        const from = subtreeEnd(top.idx, i);
        for (let j = from; j < i; j++) if (rows[j].kind === 'head' && rows[j].level >= rows[top.idx].level) rows[j].level++;
        stack = [...stack, base[k]];
      } else {
        stack = base.slice(0, k + 1);
      }
      runPtr = k + 1;
      if (row.kind === 'head') { row.kind = 'skip'; row.why = 'cont'; }
      continue;
    }
    if (explicit) {
      // a heading that had already closed: re-open its chain
      let found = -1;
      for (let h = heads.length - 1; h >= 0; h--) if (norm(rows[heads[h]].desc) === key) { found = heads[h]; break; }
      if (found >= 0) stack = pathTo(found);
      if (row.kind === 'head') { row.kind = 'skip'; row.why = 'cont'; }
      continue;
    }
    if (row.kind !== 'head') continue;
    // a new heading
    const rank = rankOf(row.desc);
    while (stack.length && stack[stack.length - 1].rank <= rank) stack.pop();
    row.level = stack.length + 1;
    stack.push({ idx: i, rank, key });
    heads.push(i);
    runStart = stack.slice(); // later repeats in this run compare against the chain including this one
    runPtr = stack.length;
  }
}

/** "BILL NO. 02" followed by "PODIUM" on a cover sheet */
function coverTitle(wb: XWorkbook, sheets: SheetPlan[]): { ref: string; title: string } | null {
  const cover = wb.sheetNames.find((s, i) => /cover/i.test(s.name) || (i === 0 && !sheets[0]?.cols));
  if (!cover) return null;
  const sh = wb.sheet(cover.name);
  const texts: string[] = [];
  for (const r of [...sh.rows.keys()].sort((a, b) => a - b).slice(0, 80)) {
    for (const c of sh.rows.get(r)!) if (c && typeof c.v === 'string' && c.v.trim()) texts.push(c.v.trim());
  }
  for (let i = 0; i < texts.length; i++) {
    const b = splitBillTitle(texts[i]);
    if (!b) continue;
    if (b.title) return b;
    const next = texts[i + 1];
    if (next && !/^rev\b|^\d{4}-\d\d/i.test(next)) return { ref: b.ref, title: next };
  }
  return null;
}

export function analyseFile(name: string, wb: XWorkbook): FilePlan & { fromCover: boolean } {
  const sheets = wb.sheetNames.map((s) => analyseSheet(wb, s.name));
  const cov = coverTitle(wb, sheets);
  if (cov) return { name, ref: cov.ref, title: cov.title, sheets, fromCover: true };
  const bt = splitBillTitle(name.replace(/\.(xlsx|xlsm)$/i, '').replace(/^.*?(bill\b)/i, '$1'));
  return { name, ref: bt?.ref ?? '', title: bt?.title || name.replace(/\.(xlsx|xlsm)$/i, ''), sheets, fromCover: false };
}

/** call once all files are analysed: tidy file titles using the whole set (unless the cover named it) */
export function tidyFileTitles(files: (FilePlan & { fromCover?: boolean })[]) {
  const clean = cleanFileNames(files.map((f) => f.name));
  files.forEach((f, i) => {
    if (f.fromCover) return;
    const bt = splitBillTitle(clean[i]);
    f.ref = bt?.ref ?? '';
    f.title = bt ? bt.title || clean[i] : clean[i];
  });
}

// ---------------------------------------------------------------- reconciliation
export interface SheetCheck {
  file: string;
  sheet: string;
  items: number;
  notes: number;
  heads: number;
  skipped: Partial<Record<SkipWhy, number>>;
  qtyByUnit: { unit: string; qty: number; n: number }[];
  /** amounts as the app will compute them (priced sheets) */
  imported: number;
  /** amounts printed on the item rows */
  source: number;
  collected: number;
  carried: number | null;
  rateOnly: number;
  statuses: number;
  ps: number;
  warnings: string[];
}

/** money rounding that survives binary fractions (970.125 -> 970.13, not 970.12) */
const round2 = (x: number) => {
  const a = Math.abs(x) * 100;
  const f = a - Math.floor(a);
  // binary noise (1.005 × 100 = 100.4999…) only matters right on a half cent: the slow exact
  // path is taken there alone (it allocates a string - too costly for every one of 60,000 lines)
  if (Math.abs(f - 0.5) > Math.max(1e-6, a * 1e-14)) return (x < 0 ? -1 : 1) * Math.round(a) / 100;
  return (x < 0 ? -1 : 1) * Math.round(Number(a.toPrecision(15))) / 100;
};
const r2 = round2;

/** amount the app will work with for an imported line (full precision, like the model) */
export function lineAmount(row: SrcRow, withRates: boolean): number {
  if (row.kind !== 'item' || row.ro || (row.st && row.st !== 'txt')) return 0;
  const rate = importedRate(row, withRates);
  if (rate === null) return 0;
  return row.qty === null ? rate : row.qty * rate;
}

export function importedRate(row: SrcRow, withRates: boolean): number | null {
  if (!withRates && !row.ps) return null;
  if (row.rate !== null && row.rate !== 0) return row.rate;
  // a rate worked out from amount / qty keeps all its decimals (15 significant, as Excel): qty x rate gives the amount back
  if (row.amt !== null && row.amt !== 0 && !row.ro) return row.qty ? Number((row.amt / row.qty).toPrecision(15)) : row.amt;
  if (row.rate === 0 && row.amt === 0 && withRates && row.ps) return null;
  return null;
}

export function checkSheet(file: string, sp: SheetPlan, withRates: boolean): SheetCheck {
  const c: SheetCheck = {
    file, sheet: sp.name, items: 0, notes: 0, heads: 0, skipped: {}, qtyByUnit: [], imported: 0, source: 0,
    collected: sp.collected, carried: sp.carried, rateOnly: 0, statuses: 0, ps: 0, warnings: [],
  };
  const byUnit = new Map<string, { qty: number; n: number }>();
  let noDesc = 0, noUnit = 0, noQty = 0;
  for (const r of sp.rows) {
    if (r.kind === 'skip') { c.skipped[r.why!] = (c.skipped[r.why!] ?? 0) + 1; continue; }
    if (r.kind === 'note') { c.notes++; continue; }
    if (r.kind === 'head') { c.heads++; continue; }
    c.items++;
    if (r.ro) c.rateOnly++;
    if (r.st) c.statuses++;
    if (r.ps) c.ps++;
    if (!r.desc) noDesc++;
    if (!r.unit && r.qty !== null && !r.ro && !r.st) noUnit++; // lump sums have neither
    if (r.unit && r.qty === null && !r.ro && !r.st && !r.ps && r.amt === null && !LUMP_UNIT_RE.test(r.unit.trim())) noQty++;
    const u = r.unit.trim().toLowerCase();
    const e = byUnit.get(u) ?? { qty: 0, n: 0 };
    e.qty += r.qty ?? 0; e.n++;
    byUnit.set(u, e);
    c.imported += lineAmount(r, withRates);
    if (r.amt !== null && !r.ro) c.source += r.amt;
  }
  c.imported = r2(c.imported);
  c.source = r2(c.source);
  c.qtyByUnit = [...byUnit.entries()].map(([unit, v]) => ({ unit, qty: r2(v.qty), n: v.n })).sort((a, b) => b.n - a.n);
  if (noDesc) c.warnings.push(`${noDesc} item${noDesc > 1 ? 's have' : ' has'} no description`);
  if (sp.hiddenRows) c.warnings.push(`${sp.hiddenRows} row${sp.hiddenRows > 1 ? 's are' : ' is'} hidden in Excel and ${sp.hiddenRows > 1 ? 'were' : 'was'} left out (as in the printed BOQ) — show ${sp.hiddenRows > 1 ? 'them' : 'it'} in Excel first if ${sp.hiddenRows > 1 ? 'they' : 'it'} should come in`);
  if (noQty) c.warnings.push(`${noQty} item${noQty > 1 ? 's have' : ' has'} a unit but no quantity — a rate typed there counts as a lump sum; mark ${noQty > 1 ? 'them' : 'it'} “Rate only” if that is what ${noQty > 1 ? 'they are' : 'it is'}`);
  if (noUnit) c.warnings.push(`${noUnit} item${noUnit > 1 ? 's have' : ' has'} a quantity but no unit`);
  if (sp.errCells) c.warnings.push(`${sp.errCells} cell${sp.errCells > 1 ? 's show' : ' shows'} an Excel error (#REF!, #N/A…) instead of a number — check those lines in the file`);
  if (withRates && sp.priced && c.collected && Math.abs(c.collected - c.imported) > 0.5)
    c.warnings.push(`imported ${c.imported.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} but the sheet's "To Collection" lines add up to ${c.collected.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  return c;
}

// ---------------------------------------------------------------- building the project rows
export interface ImportOptions {
  /** import rates/amounts found in the files (priced BOQs) */
  withRates: boolean;
  /** with several files: one bill per file, sheets under it */
  groupByFile: boolean;
  /** who, for the import record */
  by: string;
}

export interface BuiltImport {
  ops: Op[];
  importId: string;
  /** ids of the new top-level rows (to undo the whole import) */
  top: string[];
  counts: { bills: number; heads: number; items: number; notes: number };
}

export function planToOps(files: FilePlan[], opts: ImportOptions, place: { afterOrd: string | null; beforeOrd: string | null }): BuiltImport {
  const importId = randomId(8);
  const ops: Op[] = [];
  const set = (id: string, f: string, v: Value) => { if (v !== null && v !== '' && v !== false) ops.push([id, f, v]); };
  const counts = { bills: 0, heads: 0, items: 0, notes: 0 };
  type N = { id: string; children: N[]; fields: [string, Value][] };
  const topNodes: N[] = [];
  const node = (fields: [string, Value][], prefix: string): N => ({ id: prefix + randomId(10), children: [], fields });
  const files2 = files.map((f) => ({ f, sheets: f.sheets.filter((s) => s.include && s.cols) })).filter((x) => x.sheets.length);
  const multi = opts.groupByFile && files2.length > 1;

  files2.forEach(({ f, sheets }, fi) => {
    let fileNode: N | null = null;
    if (multi && sheets.length > 1) {
      fileNode = node([['type', 'group'], ['ref', f.ref], ['desc', f.title], ['src', `${importId}:${fi}`]], 'g');
      topNodes.push(fileNode);
      counts.bills++;
    }
    sheets.forEach((sp) => {
      const si = f.sheets.indexOf(sp);
      const single = multi && sheets.length === 1;
      const sheetNode = node([
        ['type', 'group'],
        ['ref', sp.ref || (single ? f.ref : '')],
        ['desc', single && !sp.ref ? f.title : sp.title || sp.name],
        ['src', `${importId}:${fi}:${si}`],
      ], 'g');
      (fileNode ? fileNode.children : topNodes).push(sheetNode);
      counts.bills++;
      const stack: { level: number; n: N; ps: boolean }[] = [];
      const container = () => (stack.length ? stack[stack.length - 1].n : sheetNode);
      const inPs = () => stack.some((s) => s.ps);
      for (const r of sp.rows) {
        if (r.kind === 'skip') continue;
        const src = `${importId}:${fi}:${si}:${r.r}`;
        if (r.kind === 'head') {
          while (stack.length && stack[stack.length - 1].level >= r.level) stack.pop();
          const ps = /provisional\s+sums?/i.test(r.desc);
          const h = node([['type', 'group'], ['ref', r.ref], ['desc', r.desc.replace(CONT_RE, '')], ['src', src], ['ps', ps && !inPs() ? true : null]], 'g');
          container().children.push(h);
          stack.push({ level: r.level, n: h, ps });
          counts.heads++;
          continue;
        }
        if (r.kind === 'note') {
          container().children.push(node([['type', 'note'], ['ref', r.ref], ['desc', r.desc], ['page', r.page], ['pe', r.pest || null], ['src', src]], 'n'));
          counts.notes++;
          continue;
        }
        // lines under a provisional-sum heading are provisional sums: their amounts come in unpriced too
        const rate = importedRate(inPs() && !r.ps ? { ...r, ps: true } : r, opts.withRates);
        container().children.push(node([
          ['type', 'item'], ['ref', r.ref], ['desc', r.desc], ['unit', r.unit], ['qty', r.qty], ['q0', r.qty], ['rate', rate],
          ['page', r.page], ['pe', r.pest || null], ['src', src], ['ro', r.ro || null], ['st', r.st], ['stx', r.stx], ['ps', r.ps && !inPs() ? true : null],
        ], 'i'));
        counts.items++;
      }
    });
  });

  const emit = (list: N[], parent: string | null, lo: string | null, hi: string | null) => {
    if (!list.length) return;
    const keys = generateNKeysBetween(lo, hi, list.length);
    list.forEach((n, i) => {
      ops.push([n.id, 'type', n.fields[0][1]]);
      ops.push([n.id, 'parent', parent]);
      ops.push([n.id, 'ord', keys[i]]);
      for (const [f, v] of n.fields.slice(1)) set(n.id, f, v);
      emit(n.children, n.id, null, null);
    });
  };
  emit(topNodes, null, place.afterOrd, place.beforeOrd);
  // the import record (which files, which columns) - needed later to write rates back into the files
  ops.push(['imp:' + importId, 'when', Date.now()]);
  ops.push(['imp:' + importId, 'by', opts.by]);
  ops.push(['imp:' + importId, 'files', JSON.stringify(files2.map(({ f }) => ({
    name: f.name,
    sheets: f.sheets.map((s) => (s.include && s.cols ? { name: s.name, headerRow: s.headerRow, cols: s.cols } : { name: s.name })),
  })))]);
  return { ops, importId, top: topNodes.map((n) => n.id), counts };
}
