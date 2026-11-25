// v0.17.1 (Feedback 3: "the Finalize sheet will have a section for finishes, for blockwork, and for structural
// elements"; "a grouping option for structural elements: rows Columns, Beams, Footings..., columns Concrete qty,
// Steel ratio, Steel, Formwork; ... group by subheading: all columns under subheading GF calculated together").
// The Structure and Blockwork summaries: read only - totals of the take-offs as they stand, by element (or heading),
// each row with the take-offs behind it, and which of them are linked to the BOQ for each quantity.
import { itemKindLabel, tagBase, tagOwn, type SegOwn, colTypeOf, segLensAt, shapeOverridden, type Measure, type QtoModel, type Shape, type TItem } from './model';

import { segOwnOps, shapeOverrideOps } from './ops';
import type { Op } from '../types';

export type SumMode = 'struct' | 'block';
/** el: by element › take-off; type: by element › type; h0: top heading › element; head: own heading › element */
export type SumGroup = 'el' | 'type' | 'h0' | 'head';
export interface SumFilter { heads?: string[]; q?: string }
export interface SumCol { ms: Measure; label: string; unit: string; link: boolean }
export interface SumRow {
  id: string;
  label: string;
  /** what was measured: "12 nr", "86.40 m" (elements of one kind only) */
  meas: { qty: number; unit: string } | null;
  qty: Partial<Record<Measure, number>>;
  /** the take-offs behind the row */
  items: string[];
  /** per quantity: the take-offs giving it, and those of them linked to the BOQ with it */
  give: Partial<Record<Measure, string[]>>;
  linked: Partial<Record<Measure, string[]>>;
  /** steel ÷ concrete (kg/m³); null: no concrete */
  ratio: number | null;
  /** a take-off row: its id (shown in the list when clicked); a type row: no links (links are per take-off) */
  ti?: string;
  type?: boolean;
  children: SumRow[];
}

export const STRUCT_COLS: SumCol[] = [
  { ms: 'vol', label: 'Concrete', unit: 'm³', link: true },
  { ms: 'form', label: 'Formwork', unit: 'm²', link: true },
  { ms: 'kg', label: 'Steel', unit: 'kg', link: true },
  // v0.18 (Feedback 3, 8): slabs ticked "A254 mesh" - their area (the column is shown when a slab has it)
  { ms: 'area', label: 'Mesh A254', unit: 'm²', link: true },
  // v0.18.1 substructure (each shown when something in view has it)
  { ms: 'wph', label: 'WP horizontal', unit: 'm²', link: true },
  { ms: 'wpv', label: 'WP vertical', unit: 'm²', link: true },
  { ms: 'blv', label: 'Blinding', unit: 'm³', link: true },
  { ms: 'pea', label: 'Polythene', unit: 'm²', link: true },
];
export const BLOCK_COLS: SumCol[] = [
  { ms: 'area', label: 'Area', unit: 'm²', link: true },
  { ms: 'len', label: 'Length', unit: 'm', link: true },
  { ms: 'vol', label: 'Volume', unit: 'm³', link: true },
  { ms: 'lcnt', label: 'Lintels', unit: 'nr', link: true },
  { ms: 'llen', label: 'Lintels', unit: 'm', link: true },
  { ms: 'lvol', label: 'Lintels', unit: 'm³', link: true },
];
export const sumCols = (mode: SumMode) => (mode === 'struct' ? STRUCT_COLS : BLOCK_COLS);

/** the order of the elements, and what each is measured in */
const EL_ORDER = ['Beam', 'Upstand beam', 'Column', 'Shear wall', 'Slab', 'Drop panel', 'Core wall', 'Stair', 'Footing', 'Raft', 'Slab on grade', 'Retaining wall'];
const elMeas = (it: TItem): Measure => (it.sk === 'col' || it.sk === 'sw' || it.sk === 'ftg' ? 'cnt' : it.sk === 'slab' || it.sk === 'drop' || it.sk === 'shear' || it.sk === 'raft' || it.sk === 'stair' || it.sk === 'sog' || it.sk === 'rw' ? 'area' : 'len');
const PLURAL: Record<string, string> = { Beam: 'Beams', 'Upstand beam': 'Upstand beams', Column: 'Columns', Slab: 'Slabs', 'Drop panel': 'Drop panels', 'Core wall': 'Core walls', 'Shear wall': 'Shear walls', 'Slab on grade': 'Slabs on grade', 'Retaining wall': 'Retaining walls', Footing: 'Footings', Raft: 'Rafts / drawn footings', Stair: 'Stairs' };
const UNIT: Partial<Record<Measure, string>> = { cnt: 'nr', len: 'm', area: 'm²' };

/** a take-off of the summary: structural elements (beams, and anything with `sk`) / blockwork walls */
export function inSummary(it: TItem, mode: SumMode): boolean {
  return mode === 'struct' ? it.kind === 'beam' || !!it.sk : it.kind === 'wall' && !it.sk;
}
/** the element a take-off is ("Columns", "200 mm walls") */
export function elementOf(it: TItem, mode: SumMode): string {
  if (mode === 'block') return it.d ? Math.round(it.d * 1000) + ' mm walls' : 'Walls (no thickness)';
  const k = itemKindLabel(it);
  return PLURAL[k] ?? k;
}
const elRank = (label: string) => { const i = EL_ORDER.findIndex((k) => (PLURAL[k] ?? k) === label); return i < 0 ? 99 : i; };

/** the headings a take-off is under (its own first, then up) */
function headsOf(m: Pick<QtoModel, 'headingById'>, par: string): string[] {
  const out: string[] = [];
  for (let h = par, n = 0; h && n < 20; n++) { out.push(h); h = m.headingById.get(h)?.par ?? ''; }
  return out;
}
export function underHeads(m: Pick<QtoModel, 'headingById'>, par: string, heads: string[] | undefined): boolean {
  if (!heads || !heads.length) return true;
  const up = headsOf(m, par);
  return up.length ? up.some((h) => heads.includes(h)) : heads.includes('');
}
const headPath = (m: Pick<QtoModel, 'headingById'>, par: string) => headsOf(m, par).reverse().map((h) => m.headingById.get(h)?.name ?? '').join(' › ');

function typeName(m: QtoModel, t: string): string {
  if (!t) return '(no type)';
  // (v0.18.1 a stair's parts by type: "ST1 flights")
  if (/\|[fl]$/.test(t)) return typeName(m, t.slice(0, -2)) + (t.endsWith('|l') ? ' landings' : ' flights');
  return (m.beamTypeById.get(t) ?? m.colTypeById.get(t) ?? m.wallTypeById.get(t) ?? m.swTypeById.get(t) ?? m.ftgTypeById.get(t) ?? m.rwTypeById.get(t) ?? m.stairTypeById.get(t))?.name ?? (t.includes(':') ? '(type removed)' : t);
}

export function structSummary(m: QtoModel, mode: SumMode, group: SumGroup = 'el', flt: SumFilter = {}): { rows: SumRow[]; total: SumRow; cols: SumCol[] } {
  const q = (flt.q ?? '').trim().toLowerCase();
  const items = m.items.filter((it) => inSummary(it, mode) && underHeads(m, it.par, flt.heads) && (!q || it.name.toLowerCase().includes(q) || elementOf(it, mode).toLowerCase().includes(q)));
  // (the mesh column only when a slab in view has mesh)
  const has: Partial<Record<Measure, boolean>> = { area: items.some((it) => it.mesh), wph: items.some((it) => it.wb), wpv: items.some((it) => it.wsd), blv: items.some((it) => it.bln), pea: items.some((it) => it.pe) }; // (retaining walls' blinding and polythene too - 0.23.2, DeepSeek #9)
  const cols = sumCols(mode).filter((c) => mode !== 'struct' || !(c.ms in has) || has[c.ms]);
  const blank = (id: string, label: string): SumRow => ({ id, label, meas: null, qty: {}, items: [], give: {}, linked: {}, ratio: null, children: [] });
  const leaf = (it: TItem): SumRow => {
    const iq = m.qty.get(it.id);
    const r = blank(it.id, it.name);
    r.ti = it.id;
    r.items = [it.id];
    if (!iq) return r;
    const links = m.linksByItem.get(it.id) ?? [];
    for (const c of cols) {
      const v = mode === 'struct' && c.ms === 'area' && !it.mesh ? 0 : (iq as unknown as Record<string, number>)[c.ms] ?? 0;
      r.qty[c.ms] = v;
      if (v > 1e-9) {
        r.give[c.ms] = [it.id];
        if (links.some((l) => l.q === c.ms && !l.dup)) r.linked[c.ms] = [it.id];
      }
    }
    if (mode === 'struct') { const ms = elMeas(it); r.meas = { qty: (iq as unknown as Record<string, number>)[ms] ?? 0, unit: UNIT[ms] ?? '' }; }
    else r.meas = { qty: iq.doors + iq.opens, unit: 'openings' };
    r.ratio = (r.qty.vol ?? 0) > 1e-9 && mode === 'struct' ? (r.qty.kg ?? 0) / r.qty.vol! : null;
    return r;
  };
  const addInto = (g: SumRow, r: SumRow) => {
    for (const c of cols) {
      g.qty[c.ms] = (g.qty[c.ms] ?? 0) + (r.qty[c.ms] ?? 0);
      if (r.give[c.ms]) g.give[c.ms] = [...(g.give[c.ms] ?? []), ...r.give[c.ms]!];
      if (r.linked[c.ms]) g.linked[c.ms] = [...(g.linked[c.ms] ?? []), ...r.linked[c.ms]!];
    }
    g.items.push(...r.items);
    if (r.meas) g.meas = g.meas === null ? { ...r.meas } : g.meas.unit === r.meas.unit ? { qty: g.meas.qty + r.meas.qty, unit: g.meas.unit } : { qty: 0, unit: '' };
    g.ratio = (g.qty.vol ?? 0) > 1e-9 && mode === 'struct' ? (g.qty.kg ?? 0) / g.qty.vol! : null;
  };
  const groups = new Map<string, SumRow>();
  const order: string[] = [];
  const total = blank('__total', 'Total');
  for (const it of items) {
    const el = elementOf(it, mode);
    const top = group === 'h0' ? m.headingById.get(headsOf(m, it.par).slice(-1)[0] ?? '')?.name ?? '(no heading)' : group === 'head' ? headPath(m, it.par) || '(no heading)' : '';
    const key = top ? top + '\u0001' + el : el;
    let g = groups.get(key);
    if (!g) { groups.set(key, (g = blank('g:' + key, top ? top + ' › ' + el : el))); order.push(key); }
    const r = leaf(it);
    addInto(g, r);
    addInto(total, r);
    if (group === 'type' && mode === 'struct') {
      // by type: the take-offs' types added up (a type's own figures: no links - those are per take-off)
      const iq = m.qty.get(it.id);
      for (const [t, e] of iq?.byTag ?? []) {
        const id = g.id + '|' + t;
        let tr = g.children.find((x) => x.id === id);
        if (!tr) { tr = blank(id, typeName(m, t)); tr.type = true; g.children.push(tr); }
        tr.qty.vol = (tr.qty.vol ?? 0) + e.vol; tr.qty.form = (tr.qty.form ?? 0) + e.form; tr.qty.kg = (tr.qty.kg ?? 0) + e.kg;
        const ms = elMeas(it);
        const mv = ms === 'cnt' ? e.segs : ms === 'len' ? e.len : 0;
        // (v0.18 a stair's flights: their steps)
        tr.meas = it.sk === 'stair' ? (t === 'Flights' || t.endsWith('|f') ? { qty: (tr.meas?.qty ?? 0) + e.segs, unit: 'steps' } : null) : ms === 'area' ? null : { qty: (tr.meas?.qty ?? 0) + mv, unit: UNIT[ms] ?? '' };
        tr.ratio = (tr.qty.vol ?? 0) > 1e-9 ? (tr.qty.kg ?? 0) / tr.qty.vol! : null;
        if (!tr.items.includes(it.id)) tr.items.push(it.id);
      }
    } else g.children.push(r);
  }
  // elements in their order (within a heading too); headings as they come in the list
  const rank = (key: string) => { const [a, b] = key.includes('\u0001') ? key.split('\u0001') : ['', key]; return [a, b] as const; };
  const headOrder = new Map<string, number>();
  for (const k of order) { const [a] = rank(k); if (!headOrder.has(a)) headOrder.set(a, headOrder.size); }
  const cmpBlock = (a: string, b: string) => (parseInt(a, 10) || 1e9) - (parseInt(b, 10) || 1e9) || a.localeCompare(b);
  const keys = [...order].sort((x, y) => {
    const [ax, bx] = rank(x), [ay, by] = rank(y);
    return (headOrder.get(ax)! - headOrder.get(ay)!) || (mode === 'struct' ? elRank(bx) - elRank(by) || bx.localeCompare(by) : cmpBlock(bx, by));
  });
  const rows = keys.map((k) => groups.get(k)!);
  for (const g of rows) if (group === 'type') g.children.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  return { rows, total, cols };
}

/** the summary as Excel rows (what is on screen: groups, then their rows) */
export function structSummaryRows(s: { rows: SumRow[]; total: SumRow; cols: SumCol[] }, mode: SumMode): (string | number | null)[][] {
  const r3 = (v: number | undefined) => (v === undefined ? null : Math.round(v * 1000) / 1000);
  const head = [mode === 'struct' ? 'Element / take-off' : 'Walls / take-off', mode === 'struct' ? 'Measured' : 'Doors + openings', mode === 'struct' ? 'Unit' : '', ...s.cols.map((c) => `${c.label} (${c.unit})`), ...(mode === 'struct' ? ['Steel ratio (kg/m³)'] : [])];
  const line = (r: SumRow, pad: string): (string | number | null)[] => [pad + r.label, r.meas && r.meas.unit ? r3(r.meas.qty) : null, mode === 'struct' ? r.meas?.unit ?? '' : '', ...s.cols.map((c) => r3(r.qty[c.ms])), ...(mode === 'struct' ? [r.ratio === null ? null : Math.round(r.ratio * 10) / 10] : [])];
  const out: (string | number | null)[][] = [head];
  for (const g of s.rows) { out.push(line(g, '')); for (const c of g.children) out.push(line(c, '    ')); }
  out.push(line(s.total, ''));
  return out;
}

// ---------------------------------------------------------------- v0.18 a schedule type's instances (Feedback 3, 7)
export interface TypeGroup {
  ti: string;
  /** "GF › Columns 1" */
  label: string;
  /** its heading ('' = top level) and every heading above it (the schedule's heading filter) */
  par: string;
  /** the elements of this type in the take-off: counted ones, drawn flights / landings, or the drawn beams / walls
   *  with a segment of it - and, for those, the segments of this type */
  shapes: Shape[];
  segs: Map<string, number[]>;
  /** how many (nr), or their length of this type (m) */
  n: number;
  unit: 'nr' | 'm';
  /** how many of them have figures of their own; a figure they all share (else 'mixed'; null = none of their own) */
  own: number;
  xr: number | null | 'mixed';
  xw: number | null | 'mixed';
  xd: number | null | 'mixed';
  xt: number | null | 'mixed';
}
export type InstCat = 'beam' | 'col' | 'wall' | 'swall' | 'ftg' | 'rwall' | 'stair';
const LINE_CATS = new Set<InstCat>(['beam', 'wall', 'rwall']);
/**
 * The instances of a schedule's type, take-off by take-off (under its headings): a type is a heading with its
 * instances - each takes the type's figures unless it has its own (v0.18.1: segments of a drawn beam / wall each).
 */
export function typeInstances(m: QtoModel, cat: InstCat, typeId: string): TypeGroup[] {
  const out: TypeGroup[] = [];
  const want = (it: TItem) => (cat === 'beam' ? it.kind === 'beam' : cat === 'wall' ? it.sk === 'shear' : cat === 'rwall' ? it.sk === 'rw' : cat === 'col' ? it.sk === 'col' : cat === 'swall' ? it.sk === 'sw' : cat === 'stair' ? it.sk === 'stair' : it.sk === 'ftg');
  const pre = cat === 'beam' ? 'bt:' : cat === 'rwall' ? 'rt:' : 'wt:';
  const same = (vs: (number | undefined)[]): number | null | 'mixed' => { const u = new Set(vs); return u.size > 1 ? 'mixed' : vs[0] ?? null; };
  for (const it of m.items) {
    if (!want(it)) continue;
    const shapes: Shape[] = [];
    const segs = new Map<string, number[]>();
    const owns: SegOwn[] = [];
    let n = 0;
    for (const s of m.shapesByItem.get(it.id) ?? []) {
      if (LINE_CATS.has(cat)) {
        if (s.k !== 'line') continue;
        const sl = segLensAt(m, s);
        let len = 0;
        const mine: number[] = [];
        sl.lens.forEach((L, i) => { const tag = tagBase(s.sg[i] ?? null); const t = tag && tag.startsWith(pre) ? tag : it.bt; if (t === typeId) { mine.push(i); owns.push(tagOwn(s.sg[i] ?? null)); if (L !== null) len += L * s.m; } });
        if (mine.length) { shapes.push(s); segs.set(s.id, mine); n += len; }
      } else if (cat === 'stair') {
        if (s.k !== 'poly' || ((s.mt && m.stairTypeById.has(s.mt) ? s.mt : it.bt) !== typeId)) continue;
        shapes.push(s); n += s.m;
      } else if (s.k === 'pt' && (colTypeOf(m, it, s.mt)?.id ?? '') === typeId) { shapes.push(s); n += s.m; }
    }
    if (!shapes.length) continue;
    const line = LINE_CATS.has(cat);
    const ownN = line ? owns.filter((o) => o.w !== undefined || o.d !== undefined || o.r !== undefined).length + shapes.filter(shapeOverridden).length : shapes.filter(shapeOverridden).length;
    out.push({
      ti: it.id, label: (headPath(m, it.par) ? headPath(m, it.par) + ' › ' : '') + it.name, par: it.par, shapes, segs, n: n * (it.x || 1), unit: line ? 'm' : 'nr', own: ownN,
      xr: line ? same(owns.map((o) => o.r)) : same(shapes.map((s) => s.xr)),
      xw: line ? same(owns.map((o) => o.w)) : same(shapes.map((s) => s.xw)),
      xd: line ? same(owns.map((o) => o.d)) : same(shapes.map((s) => s.xd)),
      xt: same(shapes.map((s) => s.xt)),
    });
  }
  return out;
}
/** v0.18.1 figures of their own for every instance of a group (null: back to the type's) */
export function groupOverrideOps(cat: InstCat, g: TypeGroup, patch: Partial<Record<'w' | 'd' | 't' | 'r', number | null>>): Op[] {
  if (LINE_CATS.has(cat)) {
    const ops: Op[] = [];
    const p: Partial<Record<'w' | 'd' | 'r', number | null>> = {};
    if (patch.w !== undefined) p.w = patch.w;
    if (patch.d !== undefined) p.d = patch.d;
    if (patch.r !== undefined) p.r = patch.r;
    for (const s of g.shapes) ops.push(...segOwnOps(s, g.segs.get(s.id) ?? [], p));
    // (fresh eyes: "back to the type" - figures typed on a whole wall / beam go too, where all of it is of this type)
    if (p.w === null && p.d === null && p.r === null) {
      const whole = g.shapes.filter((s) => (g.segs.get(s.id)?.length ?? 0) >= s.pts.length - 1);
      ops.push(...shapeOverrideOps(whole, { xw: null, xd: null, xr: null, xh: null }));
    }
    return ops;
  }
  const map: Partial<Record<'xw' | 'xd' | 'xt' | 'xr', number | null>> = {};
  if (patch.w !== undefined) map.xw = patch.w;
  if (patch.d !== undefined) map.xd = patch.d;
  if (patch.t !== undefined) map.xt = patch.t;
  if (patch.r !== undefined) map.xr = patch.r;
  return shapeOverrideOps(g.shapes, map);
}
