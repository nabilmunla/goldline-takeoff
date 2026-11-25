// Consultant page numbers.
//
// Estimators find and quote BOQ lines the consultant's way: "page CONCRETE WORKS/3, item C".
// The page of each line is read at import, from the best source the workbook has:
//   1. labels  - page numbers printed in cells of the sheet (e.g. "B/2" in the page furniture)
//   2. print   - the page number in the sheet's printed header/footer (&P, often "&A/&P"):
//                the pages come from the sheet's page breaks; where a stretch is longer than
//                a printed page (Excel's own automatic breaks are not saved in the file) the
//                breaks are worked out from the row heights and marked "estimated"
//   3. counted - pages counted at "To Collection" / "Carried forward" lines
//   4. estimated - nothing else: row heights against the paper size
// and can always be corrected by hand with a bit of help (renumber, new page from here,
// join pages, rename the prefix), see the *Ops functions below.
import type { XPrint, XSheet } from './xlsx';
import type { Op, Value } from './types';
import type { BoqModel, BoqNode } from './boq';

export type PageMethod = 'labels' | 'print' | 'counted' | 'estimated' | 'none';

export const PAGE_METHOD_LABEL: Record<PageMethod, string> = {
  labels: 'page numbers printed in the sheet',
  print: 'the printed page number (page setup and page breaks)',
  counted: 'counted at the “To Collection” lines',
  estimated: 'estimated from the row heights and paper size',
  none: 'no pages',
};

// ------------------------------------------------------------ header / footer
/**
 * The page label pattern from the sheet's printed header/footer, e.g. "&C&\"Arial\"&8&A/&P" -> "{A}/{P}".
 * Returns null when no header/footer prints the page number.
 */
export function pagePattern(hf: string[]): string | null {
  for (const raw of hf) {
    if (!/&P/i.test(raw.replace(/&&/g, ''))) continue;
    // split into the left / centre / right sections; keep the one with the page number
    // "&&" is a printed "&": protect it before looking at the codes
    const sections = raw.replace(/_x000D_/gi, '').replace(/&&/g, '\u0001').split(/&[LCR]/);
    const sec = sections.find((x) => /&P/i.test(x)) ?? '';
    const line = sec.split(/\r?\n/).find((l) => /&P/i.test(l)) ?? sec;
    let t = line
      .replace(/&"[^"]*"/g, '') // font
      .replace(/&K(?:[0-9A-Fa-f]{6}|\d\d[+-]\d{3})/g, '') // colour
      .replace(/&\d+/g, '') // size
      .replace(/&P([+-]\d+)?/gi, (_m, off: string | undefined) => '{P' + (off ?? '') + '}')
      .replace(/&N/gi, '{N}')
      .replace(/&A/gi, '{A}')
      .replace(/&[DTFZG]/gi, '')
      .replace(/&[BIUESXYOH]/gi, '')
      .replace(/\u0001/g, '&');
    // "Page 3 of 10" -> "3";  "{A}/{P}/{N}" -> "{A}/{P}"
    t = t.replace(/\s*(?:of|\/|-)\s*\{N\}/i, '').replace(/\{N\}/g, '');
    t = t.replace(/^\s*(?:page|pg\.?|p\.)\s*/i, '');
    t = t.replace(/\s+/g, ' ').trim();
    if (!/\{P/.test(t)) continue;
    return t;
  }
  return null;
}

export function applyPattern(pattern: string, sheet: string, n: number): string {
  return pattern.replace(/\{A\}/g, sheet.trim()).replace(/\{P([+-]\d+)?\}/g, (_m, off: string | undefined) => String(n + (off ? Number(off) : 0)));
}

// ------------------------------------------------------------ where the pages break
const PAPER_PT: Record<number, [number, number]> = {
  1: [612, 792], // Letter
  5: [612, 1008], // Legal
  8: [842, 1191], // A3
  9: [595.3, 841.9], // A4
  11: [419.5, 595.3], // A5
};

export interface PageBreaks {
  /** first sheet row of each printed page, ascending; the first is the start of the printed rows */
  starts: number[];
  /** for each page: the break at its start was worked out (not saved in the file) */
  est: boolean[];
  /** printable body height of one page in points (used for the estimate) */
  capacity: number;
}

/** sheet rows that print: the print area if it makes sense, else up to the last row with something in it */
function printedRows(sh: XSheet): { r1: number; r2: number } {
  const a = sh.print.area;
  const last = sh.maxRow || 1;
  if (a) {
    const r2 = Math.min(a.r2, last);
    // a print area that leaves most of the sheet out is a leftover, not the BOQ
    if (r2 - a.r1 + 1 >= 0.5 * last) return { r1: a.r1, r2 };
  }
  return { r1: 1, r2: last };
}

/** width in points of the printed columns */
function contentWidth(pr: XPrint, sh: XSheet): number {
  const c1 = pr.area?.c1 ?? 1;
  const c2 = Math.min(pr.area?.c2 ?? sh.maxCol, Math.max(sh.maxCol, 1));
  let px = 0;
  for (let c = c1; c <= c2; c++) {
    const w = pr.colW.get(c) ?? pr.defaultColW;
    if (w > 0) px += Math.trunc(w * pr.digitPx + 5);
  }
  return px * 0.75;
}

/**
 * Where the printed pages of a sheet start. Manual page breaks are taken as they are; pages
 * longer than a printed page get Excel's automatic breaks, worked out from the row heights.
 * The page height is learnt from the manual breaks when there are enough of them (the
 * consultant set them where Excel would), else from paper, margins and scale.
 */
export function pageBreaks(sh: XSheet): PageBreaks {
  const pr = sh.print;
  const { r1, r2 } = printedRows(sh);
  const titles = pr.titles && pr.titles.r2 >= pr.titles.r1 ? pr.titles : null;
  const isTitle = (r: number) => !!titles && r >= titles.r1 && r <= titles.r2;
  const H = (r: number) => (sh.hiddenRows.has(r) ? 0 : pr.rowHt.get(r) ?? pr.defaultHt);
  let titlesH = 0;
  if (titles) for (let r = titles.r1; r <= titles.r2; r++) titlesH += H(r);
  const body = (a: number, b: number) => { let h = 0; for (let r = a; r <= b; r++) if (!isTitle(r)) h += H(r); return h; };

  const manual = pr.breaks.filter((b) => b > r1 && b <= r2);
  const segStarts = [r1, ...manual];
  const segEnd = (i: number) => (i + 1 < segStarts.length ? segStarts[i + 1] - 1 : r2);

  // page height from the page setup (paper, margins, scale; the font makes it approximate)
  let [w, h] = PAPER_PT[pr.paper] ?? PAPER_PT[9];
  if (pr.landscape) [w, h] = [h, w];
  const ph = h - (pr.margins.t + pr.margins.b) * 72;
  const pw = w - (pr.margins.l + pr.margins.r) * 72;
  let scale = pr.scale / 100;
  if (pr.fitToPage) {
    const cw = contentWidth(pr, sh);
    const sW = pr.fitW > 0 && cw > 0 ? Math.min(1, (pw * pr.fitW) / cw) : 1;
    const total = body(r1, r2);
    const sH = pr.fitH > 0 && total > 0 ? Math.min(1, (ph * pr.fitH - titlesH * (pr.fitH - 1)) / total) : 1;
    scale = Math.min(sW, sH);
  }
  let capacity = Math.max(100, ph / Math.max(0.1, scale) - titlesH);
  // better: learnt from the consultant's manual breaks, when they were set at full pages
  // (most pages about the same height, and close to what the page setup gives)
  if (manual.length >= 2) {
    const hs: number[] = [];
    for (let i = 0; i < segStarts.length - 1; i++) hs.push(body(segStarts[i], segEnd(i)));
    const sorted = [...hs].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const full = hs.filter((x) => x >= 0.8 * med && x <= 1.25 * med);
    const learnt = Math.max(...full) + 2;
    if (full.length >= 2 && learnt >= 0.75 * capacity && learnt <= 2.5 * capacity) capacity = learnt;
  }

  const starts: number[] = [];
  const est: boolean[] = [];
  for (let i = 0; i < segStarts.length; i++) {
    const a = segStarts[i], b = segEnd(i);
    starts.push(a);
    est.push(false);
    let acc = 0;
    for (let r = a; r <= b; r++) {
      if (isTitle(r)) continue;
      const hr = H(r);
      if (acc > 0 && acc + hr > capacity) {
        starts.push(r);
        est.push(true);
        acc = hr;
      } else acc += hr;
    }
  }
  return { starts, est, capacity };
}

/** page index (0-based) of a sheet row */
export function pageIndexOf(starts: number[], r: number): number {
  let lo = 0, hi = starts.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= r) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// ------------------------------------------------------------ page labels
/** "CONCRETE WORKS/3" -> { pre: "CONCRETE WORKS/", n: 3, post: "" };  "B/2a" -> pre "B/", 2, "a" */
export function splitLabel(label: string): { pre: string; n: number; post: string } | null {
  const m = /^(.*?)(\d+)(\D{0,3})$/.exec(label.trim());
  if (!m) return null;
  return { pre: m[1], n: Number(m[2]), post: m[3] };
}
export const joinLabel = (pre: string, n: number, post = '') => pre + n + post;

/** compare page labels in reading order: "B/2" < "B/10" */
export function cmpLabel(a: string, b: string): number {
  const x = splitLabel(a), y = splitLabel(b);
  if (x && y && x.pre === y.pre) return x.n - y.n || x.post.localeCompare(y.post);
  return a.localeCompare(b, undefined, { numeric: true });
}

// ------------------------------------------------------------ lines in page order
/** priced lines and description lines (the ones that carry a page) under a node, in BOQ order */
export function pagedLines(model: BoqModel, under: BoqNode | null): BoqNode[] {
  const out: BoqNode[] = [];
  const walk = (list: BoqNode[]) => {
    for (const n of list) {
      if (n.type === 'group') walk(n.children);
      else out.push(n);
    }
  };
  walk(under ? (under.type === 'group' ? under.children : [under]) : model.roots);
  return out;
}

/** the headings above a line, top-level bill first */
export function chainOf(model: BoqModel, n: BoqNode): BoqNode[] {
  const out: BoqNode[] = [];
  let x = n.parent ? model.byId.get(n.parent) : undefined;
  for (let guard = 0; x && guard < 200; guard++) { out.unshift(x); x = x.parent ? model.byId.get(x.parent) : undefined; }
  return out;
}

/** the top-level bill a line sits in (itself for a top-level row) */
export function billOf(model: BoqModel, n: BoqNode): BoqNode {
  return chainOf(model, n)[0] ?? n;
}

/** the page of a heading: the page its first line is on */
export function headingPage(n: BoqNode): string {
  if (n.type !== 'group') return n.page;
  for (const c of n.children) {
    const p = headingPage(c);
    if (p) return p;
  }
  return '';
}

// ------------------------------------------------------------ editing pages by hand
const set = (ops: Op[], n: BoqNode, label: string) => {
  if (n.page !== label) ops.push([n.id, 'page', label as Value]);
  if (n.pageEst) ops.push([n.id, 'pe', null]);
};

/** give these lines one page label */
export function setPageOps(nodes: BoqNode[], label: string): Op[] {
  const ops: Op[] = [];
  for (const n of nodes) if (n.type !== 'group') set(ops, n, label.trim());
  return ops;
}

/**
 * A new page starts at `from` (a line in the middle of its page): it and everything after it
 * in the same numbering (same prefix, same bill) moves one page on.
 */
export function newPageFromOps(model: BoqModel, from: BoqNode): Op[] {
  const sp = splitLabel(from.page);
  if (!sp) return [];
  const lines = pagedLines(model, billOf(model, from));
  const i = lines.indexOf(from);
  const ops: Op[] = [];
  for (let k = i; k < lines.length; k++) {
    const x = splitLabel(lines[k].page);
    if (!x || x.pre !== sp.pre || x.n < sp.n) continue;
    set(ops, lines[k], joinLabel(x.pre, x.n + 1, x.post));
  }
  return ops;
}

/** the page that `at` is on joins the page before it: it and every later page move one page back */
export function joinPageOps(model: BoqModel, at: BoqNode): Op[] {
  const sp = splitLabel(at.page);
  if (!sp || sp.n <= 0) return [];
  const lines = pagedLines(model, billOf(model, at));
  // from the first line of this page
  let i = lines.indexOf(at);
  while (i > 0 && lines[i - 1].page === at.page) i--;
  const ops: Op[] = [];
  for (let k = i; k < lines.length; k++) {
    const x = splitLabel(lines[k].page);
    if (!x || x.pre !== sp.pre || x.n < sp.n) continue;
    set(ops, lines[k], joinLabel(x.pre, x.n - 1, x.post));
  }
  return ops;
}

export interface RenumberOpts {
  /** "B/" -> B/1, B/2… */
  prefix: string;
  start: number;
  /** where a new page starts: where the page label changes now, at each heading of a level, or every N lines */
  by: 'keep' | 'heading' | 'every';
  /** heading depth for 'heading' (0 = each bill, 1 = each section…) */
  depth?: number;
  every?: number;
}

/** number the pages of the lines under the given headings (or the given lines) */
/**
 * The "starting at" box of Number the pages: a whole number from 1, else null (nothing can be
 * applied). An emptied box is not page 0 - Number('') is 0, and the whole bill was numbered C/0
 * (BH-018).
 */
export function pageStart(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

export function renumberOps(model: BoqModel, scope: BoqNode[], o: RenumberOpts): { ops: Op[]; pages: number } {
  const ops: Op[] = [];
  // lines in BOQ order, without duplicates when a heading and its children are both picked
  const seen = new Set<string>();
  const lines: BoqNode[] = [];
  const add = (n: BoqNode) => { for (const l of n.type === 'group' ? pagedLines(model, n) : [n]) if (!seen.has(l.id)) { seen.add(l.id); lines.push(l); } };
  const order = new Map<string, number>();
  pagedLines(model, null).forEach((l, i) => order.set(l.id, i));
  for (const n of scope) add(n);
  lines.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  if (!lines.length) return { ops, pages: 0 };
  let n = o.start;
  let prevPage: string | null = null;
  let prevHead: string | null = null;
  let count = 0;
  const headAt = (l: BoqNode) => {
    const chain = chainOf(model, l);
    return chain[Math.min(o.depth ?? 0, chain.length - 1)]?.id ?? '';
  };
  lines.forEach((l, i) => {
    if (i > 0) {
      let brk = false;
      if (o.by === 'keep') brk = l.page !== prevPage;
      else if (o.by === 'heading') brk = headAt(l) !== prevHead;
      else brk = count >= Math.max(1, o.every ?? 40);
      if (brk) { n++; count = 0; }
    }
    prevPage = l.page;
    prevHead = o.by === 'heading' ? headAt(l) : null;
    count++;
    set(ops, l, joinLabel(o.prefix, n));
  });
  return { ops, pages: n - o.start + 1 };
}

/** replace the start of page labels: "CONCRETE WORKS/" -> "Bill 03/" (in the given lines) */
export function renamePrefixOps(lines: BoqNode[], from: string, to: string): { ops: Op[]; changed: number } {
  const ops: Op[] = [];
  let changed = 0;
  for (const l of lines) {
    if (l.type === 'group' || !l.page.startsWith(from)) continue;
    ops.push([l.id, 'page', (to + l.page.slice(from.length)) as Value]);
    changed++;
  }
  return { ops, changed };
}

/** the prefixes in use under a heading (or the whole project), most used first */
export function prefixesIn(lines: BoqNode[]): { pre: string; lines: number; pages: number }[] {
  const m = new Map<string, { lines: number; pages: Set<string> }>();
  for (const l of lines) {
    if (!l.page) continue;
    const pre = splitLabel(l.page)?.pre ?? l.page;
    const e = m.get(pre) ?? { lines: 0, pages: new Set() };
    e.lines++;
    e.pages.add(l.page);
    m.set(pre, e);
  }
  return [...m.entries()].map(([pre, e]) => ({ pre, lines: e.lines, pages: e.pages.size })).sort((a, b) => b.lines - a.lines);
}

// ------------------------------------------------------------ finding pages
export interface PageHit {
  page: string;
  /** first line on that page */
  first: BoqNode;
  bill: BoqNode;
  lines: number;
}

/** every page in the project in BOQ order (one entry per page per bill) */
export function allPages(model: BoqModel): PageHit[] {
  const out: PageHit[] = [];
  let last: PageHit | null = null;
  for (const l of pagedLines(model, null)) {
    if (!l.page) { last = null; continue; }
    const bill = billOf(model, l);
    if (last && last.page === l.page && last.bill === bill) { last.lines++; continue; }
    // the same label again later in the same bill (moved lines): count it with the first one
    const again = out.find((h) => h.page === l.page && h.bill === bill);
    if (again) { again.lines++; last = again; continue; }
    last = { page: l.page, first: l, bill, lines: 1 };
    out.push(last);
  }
  return out;
}

const normQ = (s: string) => s.toLowerCase().replace(/\s+/g, '');
/** pages matching what was typed: exact first, then the number alone, then "starts with" */
export function findPages(pages: PageHit[], q: string): PageHit[] {
  const t = normQ(q);
  if (!t) return pages.slice(0, 50);
  const exact: PageHit[] = [], num: PageHit[] = [], starts: PageHit[] = [], has: PageHit[] = [];
  for (const p of pages) {
    const k = normQ(p.page);
    if (k === t) exact.push(p);
    else if (/^\d+$/.test(t) && String(splitLabel(p.page)?.n) === t) num.push(p);
    else if (k.startsWith(t)) starts.push(p);
    else if (k.includes(t) || normQ(p.bill.ref + p.bill.desc).includes(t)) has.push(p);
  }
  return [...exact, ...num, ...starts, ...has].slice(0, 80);
}

/** how to quote a line the consultant's way: "Bill 02 · page CONCRETE WORKS/3 · item C — Concrete grade C40…" */
export function quoteLine(model: BoqModel, n: BoqNode): string {
  const bill = billOf(model, n);
  const parts: string[] = [];
  const b = [bill.ref, bill.desc].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (b && bill !== n) parts.push(b);
  if (n.page) parts.push('page ' + n.page);
  if (n.ref) parts.push('item ' + n.ref);
  const d = n.desc.replace(/\s+/g, ' ').trim();
  return parts.join(' · ') + (d ? ' — ' + (d.length > 90 ? d.slice(0, 88) + '…' : d) : '');
}
