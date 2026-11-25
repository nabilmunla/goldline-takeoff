// Drawing register and revisions.
//
// A sheet (dwg:) is identified by its sheet number, not by its file. When a new
// issue arrives (PTA 04, an addendum, IFC), each file is matched to its sheet by
// sheet number; the sheet's current file becomes an earlier revision (rv:) and the
// new file becomes current. The take-offs stay on the sheet. Shapes remember the
// revision they were measured on, so the ones drawn on an older revision are
// flagged "to check" until someone compares and confirms them.
import { generateNKeysBetween } from 'fractional-indexing';
import { randomId } from '../ids';
import { crc32hex } from '../crc32';
import { ID_SALT } from '../legacy';
import type { Op } from '../types';
import type { Store } from '../store';
import type { Drawing, QtoModel, Revision, Shape } from './model';
import { bareNumber, drawingNo, drawingNoBare, normName, noZeros, numberTail, sizeKey } from './pairkeys';
import { tokensOfWords, sheetIndex, type PageToks } from './sheetset';

export interface FoundFile {
  path: string;
  /** path relative to the folder that was picked (for grouping) */
  rel: string;
  size: number;
  mtime: number;
}

/**
 * "P101-ABC-DWG-AR-11030-GA L01 Tower A.pdf" -> sheet "AR-11030", title "GA L01 Tower A".
 * Rule: the title starts after the last dash-separated code that contains a digit.
 */
export function sheetFromFile(file: string): { sheet: string; title: string } {
  const { sheet, title } = sheetParts(file);
  return { sheet, title };
}

/**
 * The sheet number, its title, and the codes in front of the number. A sheet is told apart by the
 * number AND those codes (B1's AR-1001 is not B2's), so both come from the same reading of the name:
 * with the codes taken from another reading than the number (0.15.0 before release), "P04-B1-AR-1001"
 * and "P04-B2-AR-1001" were one sheet - one left out of an issue, B2's file taken as B1's new revision.
 */
function sheetParts(file: string): { sheet: string; title: string; pre: string[] } {
  const r = sheetByLastCode(file);
  // the rule above finds nothing ("A-101_C02", "AR-1001 Ground floor", "100101"), or takes codes for
  // the title ("F111.1-AE7-DWG-AR-GA-L04" read as sheet F111.1-AE7, title DWG-AR-GA-L04 - every GA
  // sheet of the issue the same number, all but one left out of the import): the drawing number as
  // Rev Radar reads it, its last two codes the sheet number (v0.15)
  // (a sheet number ending in a number - AR-11030, A-101 - is kept with a title of codes: "...-AR-11030-GA-L01"
  //  is sheet AR-11030 as before 0.15, not GA-L01 - tower A's and tower B's "GA-L01" were one sheet)
  if (r.sheet && (!/^[A-Z0-9.]+(-[A-Z0-9.]+)+$/i.test(r.title.trim()) || /(^|-)\d{3,}$/.test(r.sheet))) return r;
  const stem = file.replace(/\.pdf$/i, '');
  const codes = numberCodes(stem);
  const dn = codes.join('-');
  const num = bareNumber(stem);
  if (codes.length >= 2) {
    const written = drawingNo(stem, true);
    const at = written ? stem.toUpperCase().indexOf(written.toUpperCase()) : -1;
    const rest = at >= 0 ? stem.slice(at + written.length).replace(/^[\s_\-.]+/, '').replace(/[_\s]+(rev(ision)?|r)[\s_.-]?([0-9]{1,3}|[a-z])$/i, '').trim() : '';
    // (a status code left after the number - "_C02" - is not the title)
    const title = /^(P|C|T|D|S|IFC|IFT|IFA|REV)\d{1,2}[A-Z]?$/i.test(rest) || /^(rev(ision)?|r)[\s_.-]?([0-9]{1,3}|[a-z])$/i.test(rest) ? '' : rest;
    return { sheet: codes.slice(-2).join('-'), title, pre: codes.slice(0, -2) };
  }
  if (num) return { sheet: num, title: '', pre: [] };
  if (dn) return { sheet: dn, title: stem.slice(dn.length).replace(/^[\s_\-.]+/, '').trim(), pre: [] };
  return r;
}

/**
 * The drawing number's codes for the sheet number. A status code at its end goes only where it is
 * clearly one: set apart with "_" ("A-101_C02") or right after a number ("100101-C02"). Joined with
 * "-" after a code it is the sheet's own - "P101-AR-GA-P1" / "-P2" are parking levels, T1 / T2
 * towers: taken off, every level of an issue had one number (all but one left out) and the next
 * issue's P2 became a new revision of P1.
 */
function numberCodes(stem: string): string[] {
  const dn = drawingNo(stem);
  if (!dn) return [];
  const parts = dn.split('-');
  const keep = drawingNoBare(dn).split('-').length;
  const written = drawingNo(stem, true);
  let n = parts.length;
  while (n > keep) {
    // the separator written in front of the last code (the number as written has the same length)
    const at = parts.slice(0, n - 1).reduce((t, q) => t + q.length, 0) + (n - 2);
    const sep = written.length === dn.length ? written[at] : '-';
    if (sep === '_' || /^\d{3,}$/.test(parts[n - 2])) n--;
    else break;
  }
  return parts.slice(0, n);
}

/** "P101-ABC-DWG-AR-11030-GA L01 Tower A": the title starts after the last dash-separated code with a digit */
function sheetByLastCode(file: string): { sheet: string; title: string; pre: string[] } {
  const stem = file.replace(/\.pdf$/i, '').replace(/[_\s]+(rev(ision)?|r)[\s_.-]?([0-9]{1,3}|[a-z])$/i, '');
  const parts = stem.split('-');
  // document-system exports: "...-MAINCENTRAL-UNITMIXL01-17567357" — the trailing number is the document id
  if (parts.length >= 3 && /^\d{6,}$/.test(parts[parts.length - 1].trim())) {
    return { sheet: parts[parts.length - 1].trim(), title: parts[parts.length - 2].replace(/_/g, ' ').trim(), pre: [] };
  }
  let last = -1;
  for (let i = 0; i < parts.length - 1; i++) if (/\d/.test(parts[i]) && !/\s/.test(parts[i].trim())) last = i;
  if (last < 0) return { sheet: '', title: stem.trim(), pre: [] };
  const title = parts.slice(last + 1).join('-').trim();
  if (!title) return { sheet: '', title: stem.trim(), pre: [] };
  const code = parts.slice(Math.max(0, last - 1), last + 1).join('-');
  return { sheet: code, title, pre: parts.slice(0, Math.max(0, last - 1)).map((x) => x.trim()) };
}

/**
 * The codes in front of the sheet number: "P04-B1-AR-1001-…" -> "P04-B1" (building B1). Two files
 * with the same sheet number but other codes in front are different sheets (B1's plan is not a
 * revision of B2's). `last` is the code just in front ("B1"), used to tell them apart on screen.
 */
export function prefixOf(file: string): { key: string; last: string; parts: string[] } {
  const { pre } = sheetParts(file);
  return { key: sheetKey(pre.join('-')), last: pre[pre.length - 1] ?? '', parts: pre };
}

/** comparable form of a file path (drive letters and shares as written, any slashes, any case) */
const fileKey = (p: string) => p.trim().replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();

/** comparable form of a sheet number: "AR-11030" == "ar 11030" == "AR_11030" */
export const sheetKey = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '');

/** revision label written in a file name: "..._Rev C.pdf", "... R02.pdf", "...-rev3.pdf" */
export function revFromFile(file: string): string {
  const m = file.replace(/\.pdf$/i, '').match(/(?:^|[\s_\-(\[])(rev(?:ision)?|r)[\s_.-]?([0-9]{1,3}|[a-z])(?=$|[\s_\-)\].])/i);
  if (!m) return '';
  const v = m[2].toUpperCase();
  return 'Rev ' + (/^\d+$/.test(v) ? v.padStart(2, '0') : v);
}

/**
 * The issue a folder belongs to, from its path: the nearest folder named like an
 * issue ("260814 PTA 03", "Addendum 2", "IFC", "Tender Issue", a 6-digit date).
 */
export function issueFromPath(path: string): string {
  const segs = path.split(/[\\/]/).filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    if (/(^|\s)\d{6}(\s|$)|\b(pta|ift|ifc|ifa|addend|addendum|tender|issue|bulletin|transmittal|rev(ision)?)\b/i.test(s) && !/\.pdf$/i.test(s)) return s.trim();
  }
  return '';
}

const DISC: [RegExp, string][] = [
  [/^(AR|A|ARC|ARCH)$/, 'Architectural'],
  [/^(ST|S|SE|STR|STRUC)$/, 'Structural'],
  [/^(ME|M|MEC|MECH|HVAC|MV)$/, 'Mechanical'],
  [/^(EL|E|ELE|ELEC)$/, 'Electrical'],
  [/^(PL|P|PH|PLB|DR)$/, 'Plumbing & drainage'],
  [/^(FF|FP|FS|FA)$/, 'Fire'],
  [/^(MEP|MP)$/, 'MEP'],
  [/^(LA|LS|L|LAND)$/, 'Landscape'],
  [/^(ID|IN|INT)$/, 'Interiors'],
  [/^(CV|C|CI|CIV|INF)$/, 'Civil'],
  [/^(FA[CÇ]|FC|CW)$/, 'Facade'],
];

/** discipline from the letters in the sheet number ("AR-11030" -> Architectural) */
export function disciplineOf(sheet: string, file = ''): string {
  const find = (codes: string[]) => { for (const c of codes) for (const [re, name] of DISC) if (re.test(c)) return name; return ''; };
  // the sheet number decides ("AR-11030"); the file name only when there is none,
  // and then only its leading codes of two letters or more ("L01" is a level, not Landscape)
  if (sheet) return find(sheet.toUpperCase().split(/[^A-Z]+/).filter(Boolean).reverse());
  const lead = file.toUpperCase().split(/\s/)[0];
  return find(lead.split(/[^A-Z]+/).filter((c) => c.length >= 2).reverse());
}

/** "04 Enlarged Plans\\02 Tower A\\PDF\\x.pdf" -> "04 Enlarged Plans › 02 Tower A" */
export function groupFromRel(rel: string): string {
  const parts = rel.split(/[\\/]/).slice(0, -1).filter((p) => !/^(pdf|pdfs|cad|dwg)$/i.test(p.trim()));
  return parts.join(' › ');
}

export const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

// ---------------------------------------------------------------- import planning
export type ImportAction = 'new' | 'rev' | 'skip';

export interface ImportRow {
  file: FoundFile;
  name: string;
  sheet: string;
  title: string;
  disc: string;
  rev: string;
  grp: string;
  action: ImportAction;
  /** sheet it is a new revision of */
  target: string | null;
  /** why it is skipped / matched */
  why: string;
  /** v0.16: one page of a bound set (a multi-page PDF): the page (from 0) and the file's page count */
  fp?: number;
  fpn?: number;
  /** the file is in the project already (or twice in this issue): nothing to read in it */
  known?: boolean;
}

/**
 * v0.16: what the import found inside a file (it opens each one): its number of pages and, for a bound set
 * of several, each page's sheet number and title as its own title block says (empty: none found)
 */
export interface PageScan {
  n: number;
  /** repeats: read at a spot whose numbers repeat in the set (a set compiled from packages, v0.23) -
   *  the number is the page's, but which earlier sheet it is cannot be told by it */
  pages?: { sheet: string; title: string; pre: string; repeats?: boolean }[];
}

/**
 * What to do with each file of a new issue:
 *  - already in the project (current or earlier revision of a sheet) -> skip
 *  - same sheet number as a sheet already in the project -> new revision of it
 *  - otherwise -> new sheet
 */
export function planImport(found: FoundFile[], m: Pick<QtoModel, 'drawings' | 'revisions'>, unc: (p: string) => string = () => '', scans?: Map<string, PageScan>): ImportRow[] {
  /** a bound set: one row per page (v0.16) */
  const binder = (f: FoundFile) => { const sc = scans?.get(f.path); return sc && sc.n > 1 ? sc : null; };
  // files already in the project, by the path they were brought in by and by their share's path
  // (the same folder picked once as S:\… and once as \\server\… is the same files)
  const known = new Map<string, string>();
  const knowAs = (p: string, u: string | undefined, why: string) => {
    known.set(fileKey(p), why);
    if (u) known.set(fileKey(u), why);
  };
  for (const d of m.drawings) knowAs(d.path, d.unc, 'already in the project');
  for (const [, list] of m.revisions) for (const r of list) knowAs(r.path, r.unc, 'an earlier revision, already in the project');
  const knownAs = (p: string) => known.get(fileKey(p)) ?? (unc(p) ? known.get(fileKey(unc(p))) : undefined);
  // each sheet already in the project: its sheet number (as corrected in the register, and as its
  // file names it) and the codes in front of it
  // (a page of a bound set: its own sheet number only - the file's name is the set's, and so are the codes in it)
  const sheets = m.drawings.map((d) => {
    const keys = new Set<string>();
    if (d.sheet) keys.add(sheetKey(d.sheet));
    if (d.fp !== undefined) return { d, keys, pre: '' };
    const fromName = sheetFromFile(d.name).sheet;
    if (fromName && d.sheet && sheetKey(d.sheet).endsWith(sheetKey(fromName))) keys.add(sheetKey(fromName));
    return { d, keys, pre: prefixOf(d.name).key };
  });
  const byName = new Map<string, Drawing>();
  for (const d of m.drawings) if (d.fp === undefined) byName.set(d.name.toLowerCase(), d);
  // the codes in front of each sheet number in this issue (filled in below, before any match is made)
  const issuePres = new Map<string, Set<string>>();
  const findSheet = (k: string, pre: string): Drawing | undefined => {
    const c = sheets.filter((x) => x.keys.has(k) && (x.pre === pre || !x.pre || !pre));
    const same = c.find((x) => x.pre === pre);
    if (same) return same.d;
    // fitting only because one side has no codes in front: when that is one sheet for one file. A plain
    // "GA-L04" against tower A's and tower B's GA-L04 went to whichever came first (a wrong match moves
    // the take-offs onto the other tower's drawing); so did tower A's and B's files against a plain one
    if (c.length !== 1 || (issuePres.get(k)?.size ?? 0) > 1) return undefined;
    return c[0].d;
  };
  // one sheet number twice in this issue (Rev B and Rev C side by side): the latest revision is
  // the one brought in, the other is left out (it can still be picked by hand). Same number with
  // other codes in front (building B1 / B2) are two sheets.
  const idKey = (name: string, sheet: string) => sheetKey(sheet) + '|' + prefixOf(name).key;
  const best = new Map<string, FoundFile>();
  const better = (a: FoundFile, b: FoundFile) => {
    const c = revFromFile(baseName(a.path)).localeCompare(revFromFile(baseName(b.path)), undefined, { numeric: true, sensitivity: 'base' });
    return c > 0 || (c === 0 && a.mtime > b.mtime);
  };
  for (const f of found) {
    const { sheet } = sheetFromFile(baseName(f.path));
    if (!sheet || knownAs(f.path) || binder(f)) continue;
    const k = idKey(baseName(f.path), sheet), was = best.get(k);
    if (!was || better(f, was)) best.set(k, f);
  }
  // sheet numbers that stand for more than one sheet: shown with the code in front ("B1-AR-1001")
  const pres = new Map<string, Map<string, string[]>>();
  const addPre = (k: string, pre: { key: string; parts: string[] }) => { if (!pre.key) return; const s = pres.get(k) ?? new Map<string, string[]>(); s.set(pre.key, pre.parts); pres.set(k, s); };
  for (const x of sheets) if (x.d.fp === undefined) for (const k of x.keys) addPre(k, prefixOf(x.d.name));
  for (const f of best.values()) {
    const k = sheetKey(sheetFromFile(baseName(f.path)).sheet), pre = prefixOf(baseName(f.path));
    addPre(k, pre);
    (issuePres.get(k) ?? issuePres.set(k, new Set()).get(k)!).add(pre.key);
  }
  // the fewest codes in front that tell it from the others ("B1" of P04-B1 / P04-B2; "TA-AR" of
  // TA-AR / TB-AR, where the code just in front - AR - is the same for both)
  const telling = (k: string, pf: { key: string; parts: string[] }) => {
    const others = [...(pres.get(k)?.entries() ?? [])].filter(([key]) => key !== pf.key).map(([, parts]) => parts);
    for (let j = 1; j < pf.parts.length; j++) {
      const tail = sheetKey(pf.parts.slice(-j).join('-'));
      if (!others.some((o) => sheetKey(o.slice(-j).join('-')) === tail)) return pf.parts.slice(-j).join('-');
    }
    return pf.parts.join('-');
  };
  const taken = new Set<string>();
  const seenPath = new Set<string>();
  const rows: ImportRow[] = [];
  for (const f of found) {
    const name = baseName(f.path);
    const { sheet: bare, title } = sheetFromFile(name);
    const pf = prefixOf(name);
    const sheet = bare && pf.last && (pres.get(sheetKey(bare))?.size ?? 0) > 1 ? telling(sheetKey(bare), pf) + '-' + bare : bare;
    const row: ImportRow = { file: f, name, sheet, title, disc: disciplineOf(bare, name), rev: revFromFile(name), grp: groupFromRel(f.rel), action: 'new', target: null, why: 'new sheet' };
    const k = knownAs(f.path);
    if (k) { row.action = 'skip'; row.why = k; row.known = true; rows.push(row); continue; }
    if (seenPath.has(f.path.toLowerCase())) { row.action = 'skip'; row.why = 'the same file twice'; row.known = true; rows.push(row); continue; }
    seenPath.add(f.path.toLowerCase());
    const sc = binder(f);
    if (sc) { rows.push(...binderRows(f, sc, row, sheets, findSheet, taken)); continue; }
    const top = bare ? best.get(idKey(name, bare)) : undefined;
    if (top && top !== f) {
      row.action = 'skip';
      row.why = `${baseName(top.path)} is a later revision of the same sheet in this issue`;
      rows.push(row);
      continue;
    }
    const match = (bare && (findSheet(sheetKey(bare), pf.key) ?? (sheet !== bare ? findSheet(sheetKey(sheet), pf.key) : undefined))) || (!bare ? byName.get(name.toLowerCase()) : undefined);
    if (match && !taken.has(match.id)) {
      row.action = 'rev';
      row.target = match.id;
      row.why = bare ? `same sheet number as ${match.sheet}` : 'same file name';
      taken.add(match.id);
    } else if (match) {
      // a second new sheet with that number would be a duplicate
      row.action = 'skip';
      row.why = 'another file in this issue already updates ' + (match.sheet || match.name);
    }
    rows.push(row);
  }
  matchLoosely(rows, m.drawings, taken);
  return rows;
}

/**
 * New sheets whose sheet number found no sheet: matched the way Rev Radar pairs issues (v0.15) - by
 * the drawing number without its status code and leading zeros ("A-101_C02" -> "A-101", "GA-L01" ->
 * "GA-L1"), then a sheet named by its number alone against the full number ("100101.pdf" /
 * "F111.1-AE7-DWG-AR-100101.pdf"), then a project prefix added in front ("GA-L04" /
 * "F111-AE7-DWG-AR-GA-L04"). Each only where it is unique in the project AND in this issue: a
 * wrong match would move take-offs onto another drawing, so anything doubtful stays a new sheet
 * (it can still be made a revision by hand).
 */
function matchLoosely(rows: ImportRow[], drawings0: Drawing[], taken: Set<string>) {
  // (pages of bound sets: they have their sheet numbers already, and the file's name is the set's - a page
  //  sheet is known here by its sheet number)
  const open = rows.filter((r) => r.action === 'new' && r.fp === undefined);
  const drawings = drawings0.map((d) => (d.fp === undefined ? d : { ...d, name: d.sheet })).filter((d) => d.name);
  if (!open.length || !drawings.length) return;
  const issue = rows.filter((r) => r.action !== 'skip' && r.fp === undefined);
  // (the drawing number without leading zeros, and without a status code only where it is clearly one -
  //  numberCodes: Rev Radar's looseNo also takes off "-P2" after a code, and P101-AR-GA-P2 (parking
  //  level 2) became the next revision of P101-AR-GA-P1)
  const loose = (name: string) => noZeros(numberCodes(name.replace(/\.pdf$/i, '')).join('-'));
  const tiers: { how: string; key: (name: string) => string; pair?: (a: string, b: string) => boolean }[] = [
    { how: 'drawing number', key: loose },
    { how: 'sheet number', key: (n) => bareNumber(n) || numberTail(n) },
    { how: 'drawing number with a prefix', key: loose, pair: (a, b) => a !== b && (a.endsWith('-' + b) || b.endsWith('-' + a)) && Math.min(a.split('-').length, b.split('-').length) >= 2 },
  ];
  for (const t0 of tiers) {
    // each name's key worked out once (worked out for every pair it was 9 s for an issue of 574 files
    // against 548 sheets, none matching by sheet number - the import dialog frozen meanwhile)
    const memo = new Map<string, string>();
    const t = { ...t0, key: (n: string) => { let v = memo.get(n); if (v === undefined) { v = t0.key(n); memo.set(n, v); } return v; } };
    const free = drawings.filter((d) => !taken.has(d.id));
    const same = t.pair ?? ((a: string, b: string) => a === b);
    for (const r of open) {
      if (r.action !== 'new') continue;
      const k = t.key(r.name);
      if (!k || (t.pair && !/\d/.test(k))) continue;
      const hits = free.filter((d) => { const dk = t.key(d.name); return !!dk && same(k, dk); });
      if (hits.length !== 1) continue;
      const dk = t.key(hits[0].name);
      // the sheet-number tier: one of the two IS the bare number (two full numbers that merely end
      // alike - PRJ-AR-GA-01001 / PRJ-ST-GA-01001 - are different drawings)
      if (t.how === 'sheet number' && !bareNumber(r.name) && !bareNumber(hits[0].name)) continue;
      // unique both ways: no other sheet in the project and no other file of this issue has it
      if (drawings.filter((d) => { const x = t.key(d.name); return !!x && (same(k, x) || same(dk, x)); }).length !== 1) continue;
      if (issue.filter((x) => { const y = t.key(x.name); return !!y && (same(y, dk) || same(y, k)); }).length !== 1) continue;
      r.action = 'rev';
      r.target = hits[0].id;
      r.why = `same ${t.how} as ${hits[0].sheet || hits[0].name}`;
      taken.add(hits[0].id);
    }
  }
}

/**
 * The rows of a bound set (v0.16): each page as a sheet of its own. Its sheet number (read from the page's title
 * block) finds the sheet it is a new revision of, as a file's does; a page without one, or whose number finds
 * nothing, is the same page of the set it replaces - when the set it replaces (the one the other pages found,
 * or one of the same name but its revision) has as many pages as this one.
 */
function binderRows(f: FoundFile, sc: PageScan, base: ImportRow, sheets: { d: Drawing; keys: Set<string>; pre: string }[], findSheet: (k: string, pre: string) => Drawing | undefined, taken: Set<string>): ImportRow[] {
  const stem = base.name.replace(/\.pdf$/i, '');
  const out: ImportRow[] = [];
  const seen = new Set<string>();
  // (each number counted once for the set, not by going through every page for every page: a set of
  // thousands of pages took seconds - sweep B 22)
  const onPages = new Map<string, number>();
  for (const x of sc.pages ?? []) if (x?.sheet) { const k = sheetKey(x.sheet); onPages.set(k, (onPages.get(k) ?? 0) + 1); }
  for (let i = 0; i < sc.n; i++) {
    const pg = sc.pages?.[i];
    // (one number on two pages of the set: the text was misread on one of them - neither is trusted;
    // unless the set's numbers repeat (v0.23: a set compiled from packages): each keeps its number,
    // but none of them is matched to an earlier sheet by it - which one is meant cannot be told)
    let sheet = pg?.sheet ?? '';
    if (sheet && !pg?.repeats && (seen.has(sheetKey(sheet)) || (onPages.get(sheetKey(sheet)) ?? 0) > 1)) sheet = '';
    if (sheet) seen.add(sheetKey(sheet));
    out.push({
      ...base, sheet, title: pg?.title || stem + ' p.' + (i + 1), disc: disciplineOf(sheet, sheet ? '' : base.name),
      action: 'new', target: null, why: `page ${i + 1} of ${sc.n}, a new sheet`, fp: i, fpn: sc.n,
    });
  }
  const groupKey = (d: Drawing) => fileKey(d.unc || d.path);
  const byNumber = new Map<number, Drawing>();
  const inRows = new Map<string, number>();
  for (const x of out) if (x.sheet) { const k = sheetKey(x.sheet); inRows.set(k, (inRows.get(k) ?? 0) + 1); }
  const twice = (k: string) => (inRows.get(k) ?? 0) > 1;
  out.forEach((r, i) => {
    if (!r.sheet || twice(sheetKey(r.sheet))) return;
    const d = findSheet(sheetKey(r.sheet), sc.pages?.[i]?.pre ?? '');
    // (not a whole multi-page drawing brought in before 0.16: one page in place of all of it would leave what
    //  was measured on its other pages off the page - it is split first; until then the page is a new sheet)
    if (d && !(d.fp === undefined && d.pages > 1)) byNumber.set(i, d);
  });
  // the set this one replaces: where most of its pages' numbers went; else one of the same name
  const votes = new Map<string, number>();
  for (const d of byNumber.values()) if (d.fp !== undefined) votes.set(groupKey(d), (votes.get(groupKey(d)) ?? 0) + 1);
  let old = [...votes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? '';
  if (!old) {
    const nn = normName(base.name);
    const same = new Set(sheets.filter((x) => x.d.fp !== undefined && normName(x.d.name) === nn).map((x) => groupKey(x.d)));
    if (same.size === 1) old = [...same][0];
  }
  const oldPages = old ? sheets.map((x) => x.d).filter((d) => d.fp !== undefined && groupKey(d) === old) : [];
  const sameCount = oldPages.length > 0 && oldPages.some((d) => d.fpn === sc.n);
  out.forEach((r, i) => {
    const d = byNumber.get(i);
    if (d && !taken.has(d.id)) {
      r.action = 'rev'; r.target = d.id; r.why = `page ${i + 1}: same sheet number as ${d.sheet}`; taken.add(d.id);
    } else if (d) {
      r.action = 'skip'; r.why = 'another file in this issue already updates ' + (d.sheet || d.title || d.name);
    }
  });
  if (sameCount) {
    out.forEach((r, i) => {
      if (r.action !== 'new') return;
      const d = oldPages.find((x) => x.fp === i && !taken.has(x.id));
      if (!d) return;
      r.action = 'rev'; r.target = d.id; r.why = `page ${i + 1}, as in ${d.name}`; taken.add(d.id);
    });
  }
  return out;
}

// ---------------------------------------------------------------- sheet number from a page's text (v0.16)
export interface PageWord { t: string; x0: number; y0: number; x1: number; y1: number }

const DATE_LIKE = /^(\d{4}[-_.]\d{1,2}[-_.]\d{1,2}|\d{1,2}[-_.]\d{1,2}[-_.]\d{2,4})$/;
/** a word that could be a drawing number: codes joined by - _ . with letters and digits ("P101-ABC-DWG-AR-11030", "A-101") */
function drawingNoLike(t: string): boolean {
  const w = t.replace(/[:;,]+$/, '');
  if (w.length < 5 || !/^[A-Z0-9]+(?:[-_.][A-Z0-9]+)+$/i.test(w) || DATE_LIKE.test(w)) return false;
  if (!/[A-Z]/i.test(w) || !/\d/.test(w)) return false;
  const parts = w.split(/[-_.]/);
  // (a door tag "D-01", a grid "B-12", a level "L-02" are not; "A-101", "AR-11030" are)
  return parts.length >= 3 || parts.some((p) => /^\d{3,}$/.test(p) || /^[A-Z]{1,4}\d{3,}$/i.test(p));
}
const isNoLabel = (a: string, b?: string) => {
  const x = a.toUpperCase().replace(/[.:#]+$/g, '');
  if (/^(DWG|DRG|DRAWING|SHEET)[\s.]*(NO|NUMBER|NUM)$/.test(x)) return 1;
  if (/^(DWG|DRG|DRAWING|SHEET)$/.test(x) && b && /^(NO|NO\.|NUMBER|NUM|#)[.:]*$/i.test(b)) return 2;
  return 0;
};

/**
 * A page's sheet number (and title, where a "Title" label names it) from its words, as the title block writes
 * them: the code next to a "Drawing No." / "Dwg No" / "Sheet No" label; else the longest drawing-number-like
 * code, those in the title block (bottom / right of the sheet) and in bigger letters first. The number is then
 * read as a file name is (`sheetFromFile`: "P101-ABC-DWG-AR-11030" -> sheet AR-11030, codes P101-ABC-DWG in
 * front), so a page and a file of the same drawing get the same sheet number. Nothing found: empty.
 */
export function sheetFromPageText(words: PageWord[], page: { w: number; h: number }): { sheet: string; title: string; pre: string; no: string } {
  const none = { sheet: '', title: '', pre: '', no: '' };
  if (!words.length) return none;
  const hOf = (w: PageWord) => Math.max(0.5, w.y1 - w.y0);
  const sameLine = (a: PageWord, b: PageWord) => Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.4 * Math.min(hOf(a), hOf(b));
  // the words to the right of a label on its line, else those under it (the next lines, starting about where it does)
  const after = (lab: PageWord, labEnd: PageWord) => {
    const h = hOf(lab);
    const right = words.filter((w) => w !== lab && w !== labEnd && sameLine(w, labEnd) && w.x0 >= labEnd.x1 - 0.5 && w.x0 - labEnd.x1 < 30 * h).sort((a, b) => a.x0 - b.x0);
    const below = words.filter((w) => w.y0 >= lab.y1 - 0.2 * h && w.y0 - lab.y1 < 4 * h && w.x1 > lab.x0 - 2 * h && w.x0 < lab.x0 + 30 * h).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    return { right, below };
  };
  const clean = (t: string) => t.replace(/[:;,]+$/, '').trim();
  let no = '';
  for (let i = 0; i < words.length && !no; i++) {
    const kind = isNoLabel(words[i].t, words[i + 1]?.t);
    if (!kind) continue;
    const end = kind === 2 ? words[i + 1] : words[i];
    const { right, below } = after(words[i], end);
    const hit = [...right, ...below].find((w) => drawingNoLike(w.t) || /^[A-Z]{0,4}\d{3,}[A-Z]?$/i.test(clean(w.t)));
    if (hit) no = clean(hit.t);
  }
  if (!no) {
    const hs = words.map(hOf).sort((a, b) => a - b);
    const mid = hs[Math.floor(hs.length / 2)] || 1;
    let best = -1;
    for (const w of words) {
      const t = clean(w.t);
      if (!drawingNoLike(t)) continue;
      const parts = t.split(/[-_.]/).length;
      const inBlock = (w.x0 > page.w * 0.6 && w.y0 > page.h * 0.55) || w.x0 > page.w * 0.8 || w.y0 > page.h * 0.85;
      const score = parts * 10 + t.length + (inBlock ? 40 : 0) + Math.min(4, hOf(w) / mid) * 6;
      if (score > best) { best = score; no = t; }
    }
  }
  if (!no) return none;
  const r = sheetParts(no);
  const sheet = r.sheet || no;
  // the title: next to a "Drawing title" / "Sheet title" label first, then a bare "Title" - never a "Job title",
  // "Project title"... (0.23.1, PC check: every sheet of an 870 MB set was titled with the project's name, the
  // "JOB TITLE" field above "DRAWING TITLE")
  const stop = (w: PageWord, k: number, list: PageWord[]) => isNoLabel(w.t, list[k + 1]?.t) || /^(SCALE|DATE|REV|REVISION|DRAWN|CHECKED|PROJECT|CLIENT)[.:]*$/i.test(w.t);
  // the words under a label line by line (a title's words differ in height by a point: sorted by their tops
  // alone they came out of order, "HARBOUR VILLAS PHASE AT")
  // and a title's next lines (a villa type, a plot under "GROUND FLOOR PLAN") while they follow closely - up to 3
  const lines = (lab: PageWord, first: PageWord[]) => {
    if (!first.length) return [];
    const h = hOf(lab);
    // (as wide as the title's letters, not the label's: a 4 pt label over 9 pt title lines cut "BLISS" off)
    const wide = 30 * Math.max(h, ...first.map(hOf));
    const near = words.filter((w) => w.y0 >= lab.y1 - 0.2 * h && w.y0 - lab.y1 < 4 * h + 40 && w.x1 > lab.x0 - 2 * h && w.x0 < lab.x0 + wide).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    const out: PageWord[][] = [];
    for (const w of near) { const l = out.find((x) => sameLine(x[0], w)); if (l) l.push(w); else out.push([w]); }
    const top = (l: PageWord[]) => Math.min(...l.map((w) => w.y0));
    const bot = (l: PageWord[]) => Math.max(...l.map((w) => w.y1));
    const lh = (l: PageWord[]) => Math.max(...l.map(hOf));
    const start = out.findIndex((l) => l.some((w) => first.includes(w)));
    if (start < 0) return [];
    const keep = [out[start]];
    for (let k = start + 1; k < out.length && keep.length < 3; k++) {
      const prev = keep[keep.length - 1];
      if (top(out[k]) - bot(prev) > 0.9 * lh(prev) || Math.abs(lh(out[k]) - lh(prev)) > 0.35 * lh(prev)) break;
      keep.push(out[k]);
    }
    return keep.flatMap((l) => l.sort((a, b) => a.x0 - b.x0));
  };
  const take = (list: PageWord[]) => { const o: string[] = []; for (let k = 0; k < list.length && o.length < 10; k++) { if (stop(list[k], k, list)) break; o.push(list[k].t); } return o.join(' ').replace(/^[:\-\s]+/, '').trim(); };
  let title = '';
  for (const named of [true, false]) {
    for (let i = 0; i < words.length && !title; i++) {
      const t = words[i].t.toUpperCase().replace(/:+$/, '');
      const prev = (words[i - 1]?.t ?? '').toUpperCase().replace(/[.:]+$/, '');
      const two = t === 'TITLE' && /^(DRAWING|SHEET|DWG)$/.test(prev);
      const one = /^(DRAWING|SHEET)TITLE$/.test(t);
      if (named ? !(two || one) : (t !== 'TITLE' || /^(JOB|PROJECT|CLIENT|CONTRACT|SCHEME|SITE|PACKAGE|PLOT)$/.test(prev))) continue;
      const lab = two ? words[i - 1] : words[i];
      const { right, below } = after(lab, words[i]);
      const cand = take(right) || take(lines(lab, below));
      if (/[A-Z]/i.test(cand) && cand.length >= 3) title = cand.slice(0, 80);
    }
    if (title) break;
  }
  return { sheet, title, pre: sheetKey(r.pre.join('-')), no };
}

// ---------------------------------------------------------------- a bound set's sheets (v0.23)
/** one page of a bound set as read (scanPdf): its title-block candidates, and what its own text says */
export interface SetPage { toks: PageToks; own: { sheet: string; title: string; pre: string } }
/** a page's words -> what the set reading needs of it (the words themselves are not kept) */
export function readSetPage(page: number, words: PageWord[], size: { w: number; h: number }): SetPage {
  return { toks: tokensOfWords(page, words, size.w, size.h), own: sheetFromPageText(words, size) };
}
const MM = 72 / 25.4;
/** drawing paper: A3 and up (a bill of quantities, a specification: A4) */
const drawingPaper = (t: PageToks) => Math.min(t.w, t.h) >= 270 * MM;
/**
 * v0.23 (the PDF Editor 0.13's reading, sheetset.ts): each page's sheet number and title, read across
 * the set - per page size, the spot where a number sits on most pages and differs on each, and the
 * title near it. Read as a file name is (sheetParts: "P101-ABC-DWG-AR-11030" -> sheet AR-11030, codes in
 * front), as before.
 *  - a page of a size that has such a spot: the number there and its title (else, the page's own
 *    labelled title); one with nothing there (a cover): nothing
 *  - a page of a size with no spot (a bill of quantities, a specification, prose - or too few pages of
 *    that size to tell): its own title block as before 0.23 (sheetFromPageText), on drawing paper only
 *    - an A4 page's "numbers" are a bill's amounts and a spec's clause numbers
 */
export function readSet(pages: SetPage[]): NonNullable<PageScan['pages']> {
  const idx = sheetIndex(pages.map((p) => p.toks));
  const at = new Map(idx.sheets.map((x) => [x.page, x]));
  const spot = new Set(idx.sheets.map((x) => sizeKey(pages.find((p) => p.toks.page === x.page)!.toks)));
  return pages.map((p) => {
    const x = at.get(p.toks.page);
    if (x) {
      const r = sheetParts(x.no);
      return { sheet: r.sheet || x.no, title: x.title || p.own.title, pre: sheetKey(r.pre.join('-')), ...(x.repeats ? { repeats: true } : {}) };
    }
    if (!spot.has(sizeKey(p.toks)) && drawingPaper(p.toks)) return { ...p.own };
    return { sheet: '', title: '', pre: '' };
  });
}

/** sheets that two rows would both update (one would wipe out the other) */
export function clashingTargets(rows: Pick<ImportRow, 'action' | 'target'>[]): string[] {
  const n = new Map<string, number>();
  for (const r of rows) if (r.action === 'rev' && r.target) n.set(r.target, (n.get(r.target) ?? 0) + 1);
  return [...n].filter(([, k]) => k > 1).map(([t]) => t);
}

export interface ImportCtx {
  user: string;
  issue: string;
  /** UNC path for a drive path ('' if not on a mapped drive) */
  unc: (path: string) => string;
  now?: number;
  /** an id already used in the project (a sheet removed earlier): a new sheet must not take it */
  taken?: (id: string) => boolean;
}

/**
 * Ids made from the file itself, not drawn at random: two people bringing in the same drawings at the
 * same time (one of them offline) get ONE sheet, not every sheet twice; two bringing in the same new
 * revision get one earlier-revision record.
 */
const idOf = (pre: string, key: string) => pre + crc32hex(key) + crc32hex(ID_SALT + key);
export function sheetIdFor(path: string, unc: string, fp?: number): string { return idOf('dwg:f', fileKey(unc || path) + (fp !== undefined ? '#p' + fp : '')); }
const revIdFor = (d: Drawing) => idOf('rv:f', d.id + '|' + (d.hash || fileKey(d.unc || d.path) + '|' + d.mtime + '|' + d.size));

/** Ops for one "new sheet" row. */
export function newSheetOps(row: ImportRow, ctx: ImportCtx): { id: string; ops: Op[] } {
  const f = row.file;
  let id = sheetIdFor(f.path, ctx.unc(f.path) || '', row.fp);
  if (ctx.taken?.(id)) id = 'dwg:' + randomId(10);
  return {
    id,
    ops: [
      [id, 'name', row.name], [id, 'path', f.path], [id, 'unc', ctx.unc(f.path) || null], [id, 'size', f.size], [id, 'mtime', f.mtime],
      [id, 'grp', row.grp || null], [id, 'sheet', row.sheet || null], [id, 'title', row.title], [id, 'disc', row.disc || null],
      [id, 'rev', row.rev || null], [id, 'issue', ctx.issue || null], [id, 'added', ctx.now ?? Date.now()], [id, 'addedBy', ctx.user],
      // (a page of a bound set: which page, of how many; the sheet itself has one page)
      ...(row.fp !== undefined ? [[id, 'fp', row.fp], [id, 'fpn', row.fpn ?? null], [id, 'pages', 1]] as Op[] : []),
    ],
  };
}

/**
 * The sheet's current file becomes an earlier revision; the new file becomes current.
 * Shapes on the sheet that don't yet say which revision they were measured on are
 * stamped with the outgoing one, so they show up as "to check".
 */
export function newRevisionOps(m: Pick<QtoModel, 'shapesByPage' | 'shapes'>, d: Drawing, file: FoundFile & { name?: string; fp?: number; fpn?: number }, ctx: ImportCtx & { rev: string }): Op[] {
  const now = ctx.now ?? Date.now();
  const rv = revIdFor(d);
  const ops: Op[] = [
    [rv, 'dwg', d.id], [rv, 'name', d.name], [rv, 'path', d.path], [rv, 'unc', d.unc || null], [rv, 'hash', d.hash || null], [rv, 'size', d.size],
    [rv, 'mtime', d.mtime], [rv, 'pages', d.pages || null], [rv, 'rev', d.rev || null], [rv, 'issue', d.issue || null], [rv, 'added', d.added || null],
    [rv, 'addedBy', d.addedBy || null], [rv, 'superseded', now],
    [d.id, 'name', file.name ?? baseName(file.path)], [d.id, 'path', file.path], [d.id, 'unc', ctx.unc(file.path) || null], [d.id, 'size', file.size],
    [d.id, 'mtime', file.mtime], [d.id, 'hash', null], [d.id, 'pages', file.fp !== undefined ? 1 : null], [d.id, 'rev', ctx.rev || null], [d.id, 'issue', ctx.issue || null],
    [d.id, 'added', now], [d.id, 'addedBy', ctx.user],
    // v0.16: the page of a bound set it was / is now (a single file in place of a page: no page)
    ...pageOps(rv, d), ...pageOps(d.id, file, true),
  ];
  ops.push(...stampUnknownOps(m, d));
  return ops;
}

/**
 * The file at the same path was replaced (re-issued under the same name): keep a
 * record of the old one (comparable only where a PC still has a copy of it) and
 * take the new one as current.
 */
export function replacedInPlaceOps(m: Pick<QtoModel, 'shapes'>, d: Drawing, now: { hash: string; size: number; mtime: number; pages: number }, ctx: { user: string; rev: string; issue: string; at?: number }): Op[] {
  const at = ctx.at ?? Date.now();
  const rv = revIdFor(d);
  const ops: Op[] = [
    [rv, 'dwg', d.id], [rv, 'name', d.name], [rv, 'path', d.path], [rv, 'unc', d.unc || null], [rv, 'hash', d.hash || null], [rv, 'size', d.size],
    [rv, 'mtime', d.mtime], [rv, 'pages', d.pages || null], [rv, 'rev', d.rev || null], [rv, 'issue', d.issue || null], [rv, 'added', d.added || null],
    [rv, 'addedBy', d.addedBy || null], [rv, 'superseded', at], ...pageOps(rv, d),
    [d.id, 'hash', now.hash], [d.id, 'size', now.size], [d.id, 'mtime', now.mtime], [d.id, 'pages', d.fp !== undefined ? 1 : now.pages],
    [d.id, 'rev', ctx.rev || null], [d.id, 'issue', ctx.issue || null], [d.id, 'added', at], [d.id, 'addedBy', ctx.user],
  ];
  ops.push(...stampUnknownOps(m, d));
  return ops;
}

/**
 * Shapes that don't say which file they were measured on belong to the outgoing one. Its
 * fingerprint may not be known yet (nobody opened that file since it came in): then they get
 * a marker that matches no file, so they still show up as "to check".
 */
export const UNKNOWN_RV = 'rv?';
function stampUnknownOps(m: Pick<QtoModel, 'shapes'>, d: Drawing): Op[] {
  const out: Op[] = [];
  for (const s of m.shapes) if (s.dwg === d.id && !s.rv) out.push([s.id, 'rv', d.hash || UNKNOWN_RV]);
  return out;
}

/** "I've compared it: these shapes are right on the current revision." */
/**
 * Shapes on a page the drawing's new revision no longer has, moved onto one of its pages to be
 * checked and adjusted there: they remember the page they were measured on (so Compare shows it)
 * and stay "to check" until marked checked.
 */
export function moveOffPageOps(list: { id: string; pg: number; rv: string }[], toPg: number): Op[] {
  return list.flatMap((x) => [[x.id, 'pg', toPg], [x.id, 'opg', x.pg], ...(x.rv ? [] : [[x.id, 'rv', 'moved'] as Op])] as Op[]);
}

export function markCheckedOps(shapes: Shape[], current: string): Op[] {
  return shapes.filter((s) => s.rv !== current).map((s) => [s.id, 'rv', current] as Op);
}

/** Go back: an earlier revision becomes current again (the newer file becomes a revision). */
export function makeCurrentOps(d: Drawing, r: Revision, user: string, at = Date.now(), m?: Pick<QtoModel, 'shapes'>): Op[] {
  const rv = 'rv:' + randomId(10);
  return [
    ...(m ? stampUnknownOps(m, d) : []),
    [rv, 'dwg', d.id], [rv, 'name', d.name], [rv, 'path', d.path], [rv, 'unc', d.unc || null], [rv, 'hash', d.hash || null], [rv, 'size', d.size],
    [rv, 'mtime', d.mtime], [rv, 'pages', d.pages || null], [rv, 'rev', d.rev || null], [rv, 'issue', d.issue || null], [rv, 'added', d.added || null],
    [rv, 'addedBy', d.addedBy || null], [rv, 'superseded', at], ...pageOps(rv, d),
    [r.id, 'del', true],
    [d.id, 'name', r.name], [d.id, 'path', r.path], [d.id, 'unc', r.unc || null], [d.id, 'hash', r.hash || null], [d.id, 'size', r.size], [d.id, 'mtime', r.mtime],
    [d.id, 'pages', r.fp !== undefined ? 1 : r.pages || null], [d.id, 'rev', r.rev || null], [d.id, 'issue', r.issue || null], [d.id, 'added', at], [d.id, 'addedBy', user],
    ...pageOps(d.id, r, true),
  ];
}

/** v0.16: the page of a bound set an entity (sheet, earlier revision) is; `clear`: also when it is a whole file */
function pageOps(id: string, x: { fp?: number; fpn?: number }, clear = false): Op[] {
  if (x.fp !== undefined) return [[id, 'fp', x.fp], [id, 'fpn', x.fpn ?? null]];
  return clear ? [[id, 'fp', null], [id, 'fpn', null]] : [];
}

/**
 * v0.16: "Split into separate sheets" - a multi-page drawing brought in before 0.16 becomes one sheet per page
 * (the file is not touched). Everything on its pages moves with them: shapes (also deleted ones, so an undo
 * of their delete brings them back onto the page), scales, viewports, notes; its earlier revisions are kept
 * for each page; shapes on pages the current file no longer has stay off the page of its last sheet (as many
 * pages on), so they are still reported, to be seen on the earlier revision and moved. The drawing itself is
 * removed (Undo puts everything back as it was: one step). `names`: each page's sheet number and title.
 */
/** the sheet page k of a drawing becomes when it is split (the same id on every PC: two splits make one set of sheets) */
export const pageSheetId = (dwgId: string, k: number) => idOf('dwg:p', dwgId + '#' + k);
export function splitBinderOps(store: Pick<Store, 'ents' | 'get'>, m: Pick<QtoModel, 'revisions' | 'dwgTree'>, d: Drawing, names: ({ sheet: string; title: string } | null)[], user: string, at = Date.now()): { ops: Op[]; ids: string[] } {
  const n = Math.max(1, d.pages);
  const ids = Array.from({ length: n }, (_, k) => pageSheetId(d.id, k));
  const ops: Op[] = [];
  const raw = (f: string) => store.get(d.id, f) ?? null;
  const stem = d.name.replace(/\.pdf$/i, '');
  // in the list where the drawing was, in page order (placed by hand: right after it)
  const dpar = raw('dpar'), dord = typeof raw('dord') === 'string' ? (raw('dord') as string) : '';
  let keys: (string | null)[] = ids.map(() => null);
  if (dord) {
    const sib = m.dwgTree.tree.get(d.dpar) ?? [];
    const next = sib.slice(sib.findIndex((x) => x.id === d.id) + 1).find((x) => x.ord && x.ord > dord)?.ord ?? null;
    try { keys = generateNKeysBetween(dord, next, n); } catch { keys = ids.map(() => null); }
  }
  ids.forEach((id, k) => {
    const nm = names[k];
    const sheet = nm?.sheet || (n === 1 ? d.sheet : '');
    ops.push(
      [id, 'name', d.name], [id, 'path', d.path], [id, 'unc', d.unc || null], [id, 'hash', d.hash || null], [id, 'size', d.size], [id, 'mtime', d.mtime],
      [id, 'pages', 1], [id, 'fp', k], [id, 'fpn', n], [id, 'grp', d.grp || null], [id, 'sheet', sheet || null],
      [id, 'title', nm?.title || (d.title || stem) + ' p.' + (k + 1)], [id, 'disc', d.disc || null], [id, 'rev', d.rev || null], [id, 'issue', d.issue || null],
      [id, 'added', d.added || at], [id, 'addedBy', d.addedBy || user],
      [id, 'dpar', dpar], [id, 'dord', keys[k]],
    );
  });
  // where a page's things go: page k onto sheet k; past the last page, off the last sheet's page
  const to = (pg: number): [string, number] => (pg < n ? [ids[pg], 0] : [ids[n - 1], pg - (n - 1)]);
  for (const [eid, ent] of store.ents) {
    const pre = eid.slice(0, eid.indexOf(':') + 1);
    if (pre !== 'sh:' && pre !== 'sr:' && pre !== 'nt:') continue;
    if (ent.get('dwg')?.v !== d.id) continue;
    const pg0 = Number(ent.get('pg')?.v ?? 0);
    const pg = Number.isFinite(pg0) && pg0 >= 0 ? Math.floor(pg0) : 0;
    const [nd, np] = to(pg);
    ops.push([eid, 'dwg', nd], [eid, 'pg', np]);
    // (measured on page j of an earlier revision: that page, counted from this sheet's page)
    const opg = ent.get('opg')?.v;
    if (pre === 'sh:' && typeof opg === 'number') ops.push([eid, 'opg', opg - (pg < n ? pg : n - 1)]);
  }
  // scales: each page's own
  for (let k = 0; k < n; k++) {
    const from = store.ents.get('pg:' + d.id + '.' + k);
    if (!from) continue;
    for (const [f, c] of from) if (c.v !== null && c.v !== undefined) ops.push(['pg:' + ids[k] + '.0', f, c.v]);
  }
  // earlier revisions: each page has its page of each one (one that had fewer pages: not for the pages past them)
  for (const r of m.revisions.get(d.id) ?? []) {
    for (let k = 0; k < n; k++) {
      if (r.pages > 0 && k >= r.pages) continue;
      const rv = idOf('rv:p', ids[k] + '|' + r.id);
      ops.push(
        [rv, 'dwg', ids[k]], [rv, 'name', r.name], [rv, 'path', r.path], [rv, 'unc', r.unc || null], [rv, 'hash', r.hash || null], [rv, 'size', r.size],
        [rv, 'mtime', r.mtime], [rv, 'pages', 1], [rv, 'fp', k], [rv, 'fpn', r.pages || null], [rv, 'rev', r.rev || null], [rv, 'issue', r.issue || null],
        [rv, 'added', r.added || null], [rv, 'addedBy', r.addedBy || null], [rv, 'superseded', r.superseded || null],
      );
    }
  }
  ops.push([d.id, 'del', true]);
  return { ops, ids };
}

/** "Rev B · 260901 PTA 02"; without either: the date it was brought in */
export const revLabel = (x: { rev: string; issue: string; added?: number }) =>
  [x.rev, x.issue].filter(Boolean).join(' · ') || (x.added ? 'as of ' + new Date(x.added).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : 'no revision given');
