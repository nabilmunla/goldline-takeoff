// Turns the flat merged store into the BOQ tree: bills > sections > ... > lines.
// Every entity with a "type" field is a row:
//   group = heading, item = BOQ line, note = description line (text only)
// Hierarchy is "parent" + "ord" (fractional sort keys, so inserting between rows
// never renumbers anything). Nothing is ever hidden silently: rows whose parent is
// missing go to "Unfiled".
import type { Store } from './store';
import type { Cell } from './types';

export type NodeType = 'group' | 'item' | 'note';
/** pricing status wording a consultant's BOQ line can carry at import (the import reads it; nothing prices on it any more) */
export type Status = 'incl' | 'na' | 'emp' | 'opt' | 'ps' | 'txt';
export const STATUS_LABEL: Record<Status, string> = {
  incl: 'Included', na: 'N/A', emp: 'By employer', opt: 'Optional', ps: 'PS', txt: 'Note',
};
export interface BoqNode {
  id: string;
  type: NodeType;
  parent: string | null;
  ord: string;
  ref: string;
  desc: string;
  unit: string;
  qty: number | null;
  /** group: number of lines under it (item: 1) */
  items: number;
  /** number of build-up lines: always 0 now (the estimate is gone); engine/qto/bridge.ts still reads it */
  bu: number;
  depth: number;
  children: BoqNode[];
  deleted: boolean;
  /** page reference from the consultant's BOQ (e.g. "B/2") */
  page: string;
  /** the page was estimated at import (a page break Excel works out itself), not read */
  pageEst: boolean;
  /** consultant's quantity at import (null if not imported) */
  q0: number | null;
  /** quantity measured in the linked take-off projects (null = not measured) */
  tq: number | null;
  /** 0.21: the take-off's other measures of the shapes behind this line (formwork, steel...), for TQ* names */
  tqm: Record<string, number> | null;
  /** where it came from: importId:file:sheet:row */
  src: string;
  /** v0.16: made from a take-off - a QS's additional item or temporary line (engine/qto/bridge.ts) */
  qa: QaInfo | null;
}

/**
 * v0.16: a row the take-off sync made (engine/qto/bridge.ts additionalOps). k: a = additional item
 * (a line the BOQ doesn't have, suggested by a QS), n = a temporary line the QS has not resolved yet,
 * g = the "Additional items (QS)" heading of a bill.
 */
export interface QaInfo {
  k: 'a' | 'n' | 'g';
  /** who added it in the take-off, and where it is */
  by: string;
  loc: string;
  /** the take-off project it came from */
  qto: string;
  /** the estimator changed the QS's suggestion (description, unit, ref, bill, location) or priced it */
  own: boolean;
  /** no longer in the take-off, kept because the estimator worked on it */
  gone: boolean;
}

/** what the take-off sync last suggested for a line (see bridge.ts): parent, desc, unit, ref, location, qty */
export interface QaSuggestion { p: string | null; d: string; u: string; r: string; l: string; q: number | null }
export function readSuggestion(v: unknown): QaSuggestion | null {
  if (typeof v !== 'string' || !v) return null;
  try { const o = JSON.parse(v); return o && typeof o === 'object' ? { p: o.p ?? null, d: String(o.d ?? ''), u: String(o.u ?? ''), r: String(o.r ?? ''), l: String(o.l ?? ''), q: typeof o.q === 'number' ? o.q : null } : null; } catch { return null; }
}

export interface BoqModel {
  roots: BoqNode[];
  byId: Map<string, BoqNode>;
  items: number;
  deletedCount: number;
  /** v0.16.2: the import records (imp:<id> -> its files, sheets, header rows, columns as JSON) - for the filled copy */
  imports?: Map<string, string>;
}

export const UNFILED = '__unfiled__';

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
/** the take-off measures stored on a line (JSON); anything damaged reads as none */
function tqmOf(v: unknown): Record<string, number> | null {
  if (typeof v !== 'string' || !v) return null;
  try {
    const o = JSON.parse(v);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const out: Record<string, number> = {};
    for (const [k, x] of Object.entries(o)) if (typeof x === 'number' && Number.isFinite(x)) out[k] = x;
    return out;
  } catch { return null; }
}

/**
 * "Empty recycle bin" marks rows as purged. A purge only counts if it was made by
 * an administrator (admins = usernames with the admin role). Purged rows never come
 * back through the app; the raw history still holds them, as a last-resort safety net.
 */
export type PurgeCheck = Set<string> | ((account: string, stamp: string) => boolean);
export function isPurged(store: Store, id: string, admins?: PurgeCheck): boolean {
  const c = store.cell(id, 'purged');
  if (!c || c.v !== true) return false;
  if (!admins) return true;
  if (!c.a) return false;
  // who was an administrator when the bin was emptied (a later demotion doesn't bring rows back)
  return typeof admins === 'function' ? admins(c.a, c.s) : admins.has(c.a);
}

const isRowType = (t: unknown): t is NodeType => t === 'group' || t === 'item' || t === 'note';

function readQa(ent: Map<string, Cell>, type: NodeType, parent: string | null, rate: number | null): QaInfo | null {
  const k = ent.get('qa')?.v;
  if (k !== 'a' && k !== 'n' && k !== 'g') return null;
  const g = (f: string) => { const v = ent.get(f)?.v; return typeof v === 'string' ? v : ''; };
  let own = false;
  if (k !== 'g' && type === 'item') {
    const sg = readSuggestion(ent.get('qs')?.v);
    // (a build-up or a status is the estimator's work too; the quantity follows the take-off and is not counted here)
    own = !!sg && (sg.p !== parent || sg.d !== g('desc') || sg.u !== g('unit') || sg.r !== g('ref') || sg.l !== g('qloc')) || rate !== null || !!ent.get('st')?.v;
  }
  return { k, by: g('qby'), loc: g('qloc'), qto: g('qsrc'), own, gone: ent.get('qgone')?.v === true };
}

/**
 * `tq`: the Take-off column worked out live from the linked take-offs, in place of the stored one -
 * for a window that can't write it (View only, a viewer), so what it shows is never out of date.
 */
export function buildModel(store: Store, admins?: PurgeCheck, opts: { tq?: Map<string, number> | null } = {}): BoqModel {
  const byId = new Map<string, BoqNode>();
  const raw = new Map<string, { parent: string | null; del: boolean; purged: boolean }>();
  // the rows (headings, lines, notes) out of every entity (build-up lines, resources... are many more)
  const rowEnts: [string, Map<string, Cell>][] = [];
  for (const [id, ent] of store.ents) {
    if (!isRowType(ent.get('type')?.v)) continue;
    const purged = isPurged(store, id, admins);
    raw.set(id, { parent: (ent.get('parent')?.v as string) ?? null, del: purged || ent.get('del')?.v === true, purged });
    rowEnts.push([id, ent]);
  }
  // a row is hidden if it, or any heading above it, is in the recycle bin
  const hidden = new Map<string, boolean>();
  const isHidden = (id: string, guard = 0): boolean => {
    const known = hidden.get(id);
    if (known !== undefined) return known;
    const r = raw.get(id);
    const h = !r ? false : r.del || (r.parent && guard < 64 && raw.has(r.parent) ? isHidden(r.parent, guard + 1) : false);
    hidden.set(id, h);
    return h;
  };
  let deletedCount = 0;
  for (const [id, ent] of rowEnts) {
    const r = raw.get(id)!;
    if (r.del && !r.purged) deletedCount++;
    if (isHidden(id)) continue;
    const type = ent.get('type')!.v as NodeType;
    const qty = num(ent.get('qty')?.v);
    const rate = num(ent.get('rate')?.v);
    byId.set(id, {
      id, type,
      parent: r.parent,
      ord: String(ent.get('ord')?.v ?? ''),
      ref: String(ent.get('ref')?.v ?? ''),
      desc: String(ent.get('desc')?.v ?? ''),
      unit: String(ent.get('unit')?.v ?? ''),
      qty, items: 0, bu: 0,
      depth: 0, children: [], deleted: false,
      page: String(ent.get('page')?.v ?? ''),
      pageEst: ent.get('pe')?.v === true,
      q0: num(ent.get('q0')?.v),
      tq: opts.tq ? (type === 'item' ? opts.tq.get(id) ?? null : null) : num(ent.get('tq')?.v),
      tqm: type === 'item' ? tqmOf(ent.get('tqm')?.v) : null,
      src: String(ent.get('src')?.v ?? ''),
      qa: readQa(ent, type, r.parent, rate),
    });
  }
  const roots: BoqNode[] = [];
  const orphans: BoqNode[] = [];
  for (const n of byId.values()) {
    if (!n.parent) { roots.push(n); continue; }
    const p = byId.get(n.parent);
    if (p && p.type === 'group') p.children.push(n);
    else orphans.push(n);
  }
  const cmp = (a: BoqNode, b: BoqNode) => (a.ord < b.ord ? -1 : a.ord > b.ord ? 1 : a.id < b.id ? -1 : 1);
  // depth, guarding against cycles
  const visited = new Set<string>();
  const walk = (n: BoqNode, depth: number) => {
    visited.add(n.id);
    n.depth = depth;
    n.children.sort(cmp);
    if (n.type !== 'group') {
      n.items = n.type === 'item' ? 1 : 0;
      return;
    }
    n.items = 0;
    // every row sits in exactly one place: a child already placed (two people moved headings into
    // each other at once - a cycle) is dropped here, so nothing below ever loops or counts twice
    const kids: BoqNode[] = [];
    for (const c of n.children) {
      if (visited.has(c.id)) continue;
      walk(c, depth + 1);
      kids.push(c);
      n.items += c.items;
    }
    n.children = kids;
  };
  roots.sort(cmp);
  for (const r of roots) walk(r, 0);
  // rows that can't be reached from a bill: their parent is gone or is not a heading any more
  // (with everything under them), then rows caught in a cycle of headings
  const lost = orphans.filter((n) => !visited.has(n.id));
  for (const n of byId.values()) if (!visited.has(n.id) && n.parent && byId.has(n.parent) && byId.get(n.parent)!.type === 'group' && !lost.includes(n)) {
    // part of a cycle: take the first of it (by order) as the top of what is shown
    let x = n;
    const seen = new Set<string>();
    while (x.parent && byId.has(x.parent) && !seen.has(x.id)) { seen.add(x.id); x = byId.get(x.parent)!; }
    if (!lost.includes(x) && !visited.has(x.id)) lost.push(x);
  }
  if (lost.length) {
    const u: BoqNode = {
      id: UNFILED, type: 'group', parent: null, ord: '￿', ref: '', desc: 'Unfiled items (parent missing)',
      unit: '', qty: null, items: 0, bu: 0, depth: 0, children: lost, deleted: false,
      page: '', pageEst: false, q0: null, tq: null, tqm: null, src: '', qa: null,
    };
    walk(u, 0);
    roots.push(u);
  }
  let items = 0;
  for (const r of roots) items += r.items;
  const imports = new Map<string, string>();
  for (const [id, ent] of store.ents) if (id.startsWith('imp:') && typeof ent.get('files')?.v === 'string') imports.set(id.slice(4), ent.get('files')!.v as string);
  return { roots, byId, items, deletedCount, imports };
}

export interface Row {
  node: BoqNode;
  collapsed: boolean;
}

/** Which lines a view shows. Headings are shown when something under them is shown. */
export type LinePredicate = (n: BoqNode) => boolean;

export function flatten(model: BoqModel, collapsed: Set<string>, filter = '', pred?: LinePredicate): Row[] {
  const out: Row[] = [];
  const f = filter.trim().toLowerCase();
  const textMatch = (n: BoqNode) =>
    !f || n.desc.toLowerCase().includes(f) || n.ref.toLowerCase().includes(f) || n.unit.toLowerCase() === f ||
    (!!n.page && n.page.toLowerCase() === f);
  if (!f && !pred) {
    const visit = (n: BoqNode) => {
      const isCol = n.type === 'group' && collapsed.has(n.id);
      out.push({ node: n, collapsed: isCol });
      if (!isCol) for (const c of n.children) visit(c);
    };
    for (const r of model.roots) visit(r);
    return out;
  }
  // filtered: which rows have something visible inside them?
  const keep = new Map<string, boolean>();
  const mark = (n: BoqNode): boolean => {
    let k: boolean;
    if (n.type === 'group') {
      k = false;
      for (const c of n.children) k = mark(c) || k;
      if (!k && f && !pred && textMatch(n)) k = true;
    } else k = (!pred || pred(n)) && textMatch(n);
    keep.set(n.id, k);
    return k;
  };
  for (const r of model.roots) mark(r);
  const visit = (n: BoqNode) => {
    if (!keep.get(n.id)) return;
    // text search ignores collapse so matches are never hidden; package views respect it
    const isCol = !f && n.type === 'group' && collapsed.has(n.id);
    out.push({ node: n, collapsed: isCol });
    if (!isCol) for (const c of n.children) visit(c);
  };
  for (const r of model.roots) visit(r);
  return out;
}

/** Groups to collapse so that only `level` levels of headings are open (Excel-style outline levels). */
export function collapseForLevel(model: BoqModel, level: number): Set<string> {
  const s = new Set<string>();
  for (const n of model.byId.values()) if (n.type === 'group' && n.depth >= level - 1) s.add(n.id);
  if (model.roots.some((r) => r.id === UNFILED) && level <= 1) s.add(UNFILED);
  return s;
}
