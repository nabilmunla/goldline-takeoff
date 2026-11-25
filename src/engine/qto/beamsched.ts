// v0.16.6 (Nabil, 9 Nov: "what about beam schedules? we have a way to see doors and import them easily") - the beam
// schedule from Excel, as the door schedule (doorsched.ts): find the header row, which column is the beam mark, the
// width, the depth (or one "300 x 600" size), and the steel ratio (kg/m³) if the file has one. Types are matched by
// mark ("B-1" = "b1"). And the marks written on a drawing (B1, B2...) tag the beam segments they sit by.
import type { XWorkbook, XSheet } from '../xlsx';
import type { Op } from '../types';
import { headsAt, headsOne, pairOf, sizeOf, unitOfHeading } from './doorsched';
import { tagKey, type Found } from './autocount';
import { beamTypeOps, memberTypeOps, segTagsManyOps } from './ops';
import { segDist, type Pt } from './geometry';
import { tagBase, tagOwn, withTagOwn, type BeamType, type QtoModel, type Shape } from './model';

export type BeamCol = 'mark' | 'w' | 'd' | 't' | 'sz' | 'r' | 'tr' | 'ri';
/** v0.17 one engine for the three schedules: beams (w × d), columns (w × d, or round: Ø), shear walls (thickness) */
// (v0.18: shear walls counted - 'swall': length × thickness; footings - 'ftg': length × width × depth)
// (v0.18.1: retaining walls - 'rwall': thickness, as core walls; stairs - 'stair': tread, riser, flight width, waist,
// landing thickness)
export type MemberCat = 'beam' | 'col' | 'wall' | 'swall' | 'ftg' | 'rwall' | 'stair';
export const MEMBER_PRE: Record<MemberCat, 'bt' | 'ct' | 'wt' | 'st' | 'ft' | 'rt' | 'sy'> = { beam: 'bt', col: 'ct', wall: 'wt', swall: 'st', ftg: 'ft', rwall: 'rt', stair: 'sy' };
/** a schedule of thicknesses only (core walls, retaining walls) */
export const isThk = (cat: MemberCat) => cat === 'wall' || cat === 'rwall';
export const BEAM_COL_LABEL: Record<BeamCol, string> = { mark: 'Mark', w: 'Width', d: 'Depth', t: 'Depth', sz: 'Size (W × D)', r: 'Steel kg/m³', tr: 'Tread', ri: 'Riser' };
export const colLabel = (cat: MemberCat, k: BeamCol) => (isThk(cat) && k === 'w' ? 'Thickness' : cat === 'col' && k === 'sz' ? 'Size (W × D, or Ø)'
  : cat === 'swall' ? (k === 'w' ? 'Length' : k === 'd' ? 'Thickness' : k === 'sz' ? 'Size (L × T)' : BEAM_COL_LABEL[k])
  : cat === 'ftg' ? (k === 'w' ? 'Length' : k === 'd' ? 'Width' : k === 't' ? 'Depth' : k === 'sz' ? 'Size (L × W × D)' : BEAM_COL_LABEL[k])
  : cat === 'stair' ? (k === 'w' ? 'Flight width' : k === 'd' ? 'Waist' : k === 't' ? 'Landing thickness' : BEAM_COL_LABEL[k]) : BEAM_COL_LABEL[k]);
export type BeamCols = Partial<Record<BeamCol, number>>;
export interface BeamSheetPlan { sheet: string; header: number; heads: Map<number, string>; cols: BeamCols }
export interface BeamIn { name: string; w: number | null; d: number | null; r?: number | null; round?: boolean; t?: number | null; tr?: number | null; ri?: number | null }

const norm = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();
// (v0.17 review: the mark first by what says it - Mark, Type, Beam, Column, Wall - and only then the generic ones (No.,
// Ref, ID): "Sr. No." 1, 2, 3 was taken for the marks and the real "BEAM MARK" left out)
const MARK = /^((beam|column|col|wall|shear ?wall|retaining ?wall|rw|sw|member|footing|ftg|foundation|pad|raft|stair|staircase|st) ?(mark|no\.?|nos?|number|ref\.?|reference|id|type|tag|name|code)?|mark|type|type ?mark)$/;
const MARK2 = /^(ref\.?|reference|tag|name|id|code)$/;

/** which column is what, from the headings */
export function guessBeamCols(heads: Map<number, string>, cat: MemberCat = 'beam'): BeamCols {
  const cols: BeamCols = {};
  const set = (k: BeamCol, c: number) => { if (cols[k] === undefined) cols[k] = c; };
  let generic: number | undefined;
  for (const [c, t0] of heads) {
    const t = t0.toLowerCase().replace(/[()[\]:]/g, ' ').replace(/\s+/g, ' ').trim();
    const last = t.split(' ').slice(-2).join(' ');
    if (!/size|width|depth|thick|dia|length/.test(t)) {
      if (MARK.test(t) || MARK.test(last)) { set('mark', c); continue; }
      if (generic === undefined && (MARK2.test(t) || MARK2.test(last))) { generic = c; continue; }
    }
    // (a ratio only - kg per m³: "Top reinforcement" holds bars (4T16), "Total steel (kg)" a weight, "ratio (%)" a percentage)
    if (/kg ?(\/|per) ?m ?(3|³|cu)|\bratio\b/.test(t) && !/%/.test(t)) { set('r', c); continue; }
    if (/\bkg\b|%/.test(t)) continue;
    // (v0.18.1 a stair: tread, riser, flight width, waist, landing thickness)
    if (cat === 'stair') {
      if (/tread|going/.test(t)) { set('tr', c); continue; }
      if (/riser|\brise\b/.test(t)) { set('ri', c); continue; }
      if (/waist/.test(t)) { set('d', c); continue; }
      if (/landing/.test(t)) { set('t', c); continue; }
      if (/width|wide|\bw\b/.test(t)) { set('w', c); continue; }
      continue;
    }
    // (v0.18 a counted shear wall: length and thickness; a footing: length, width, depth)
    if (cat === 'swall' || cat === 'ftg') {
      if (/size|dimension|section|[x×*]/.test(t)) { set('sz', c); continue; }
      if (/\b(length|long|l)\b/.test(t)) { set('w', c); continue; }
      if (cat === 'swall') { if (/thick|\bthk\b|\b(t|b|w|width|breadth)\b/.test(t)) set('d', c); continue; }
      if (/\b(width|wide|breadth|w|b)\b/.test(t)) { set('d', c); continue; }
      if (/\b(depth|deep|height|d|h|t)\b|thick|\bthk\b/.test(t)) { set('t', c); continue; }
      continue;
    }
    // (a shear wall's thickness is its width; a column's diameter too)
    // (a column's "Height" is its storey height, not its section: depth only)
    const isW = /\b(width|wide|breadth|w|b)\b/.test(t) || (isThk(cat) && /thick|\bthk\b|\bt\b/.test(t)) || (cat === 'col' && /diam|\bdia\b|[øØ⌀φ]/.test(t)),
      isD = (cat === 'col' ? /\b(depth|deep|d)\b/ : /\b(depth|deep|height|overall|d|h)\b/).test(t) && !isThk(cat);
    if (/size|dimension|section|\b(b|w|width) ?[x×*] ?(d|h|depth|height)\b/.test(t) && !(isW !== isD && !/[x×*]/.test(t))) { set('sz', c); continue; }
    if (isW && !isD) { set('w', c); continue; }
    if (isD && !isW) { set('d', c); continue; }
  }
  if (cols.mark === undefined && generic !== undefined) cols.mark = generic;
  return cols;
}

/** a column's round size: "Ø500", "500 dia", "500Ø", "D500" (circular) */
function roundOf(v: unknown): number | null {
  const t = String(v ?? '').toLowerCase().replace(/,/g, '');
  const m = t.match(/(?:[ø⌀φ]|dia\.?|diameter)\s*(\d+(?:\.\d+)?)\s*(mm|cm|m)?|(\d+(?:\.\d+)?)\s*(mm|cm|m)?\s*(?:[ø⌀φ]|dia\b|diameter|circ)/);
  if (!m) return null;
  return sizeOf(m[1] ? m[1] + (m[2] ?? '') : m[3] + (m[4] ?? ''));
}

function beamFromRow(row: { v: unknown }[], cols: BeamCols, units: Partial<Record<BeamCol, 'mm' | 'cm' | 'm' | ''>> = {}, cat: MemberCat = 'beam'): BeamIn | null {
  const cell = (k: BeamCol) => (cols[k] !== undefined ? row[cols[k]!]?.v : undefined);
  const name = norm(cell('mark'));
  // (a mark has a letter: B1, C2, SW3 - a row number is not one)
  if (!name || name.length > 30 || !/[a-z]/i.test(name)) return null;
  const num = (v: unknown) => (typeof v === 'number' ? v : /^\s*\d+(\.\d+)?\s*$/.test(String(v ?? '')) ? Number(v) : NaN);
  // (v0.17 review: "250 THK", "300mm thk" - a thickness written as one)
  const thk = (v: unknown) => (typeof v === 'string' ? v.replace(/\s*(thk|thick(ness)?)\.?\s*$/i, '').trim() : v);
  const inUnit = (k: BeamCol, v0: unknown) => {
    const v = thk(v0);
    const u = units[k], n = num(v);
    if (!u || !Number.isFinite(n) || (u === 'm' && n > 20) || (u === 'mm' && n <= 20) || (u === 'cm' && n <= 10)) return sizeOf(v);
    return sizeOf(String(n) + u);
  };
  // (v0.18.1 a stair: a column for each figure)
  if (cat === 'stair') {
    // (fresh eyes: a column not in the file is not "empty": undefined - an update leaves that figure as it is)
    const g = (k: 'tr' | 'ri' | 'w' | 'd' | 't') => (cols[k] !== undefined ? inUnit(k, cell(k)) : undefined) as number | null;
    const o: BeamIn = { name, w: g('w'), d: g('d'), t: g('t'), tr: g('tr'), ri: g('ri') };
    if (!o.tr || !o.ri) return null;
    if (cols.r !== undefined) { const t = String(cell('r') ?? '').replace(/,/g, '').match(/^\s*(\d+(?:\.\d+)?)/); o.r = t ? Number(t[1]) : null; }
    return o;
  }
  // (v0.18 a counted shear wall "3000 x 250", a footing "1500 x 1500 x 500" - or a column for each figure)
  if (cat === 'swall' || cat === 'ftg') {
    const nums = String(cell('sz') ?? '').toLowerCase().replace(/,/g, '').split(/[x×*]/).map((p) => { const mm = p.match(/(\d+(?:\.\d+)?)\s*(mm|cm|m)?/); return mm ? sizeOf(mm[1] + (mm[2] ?? (units.sz || ''))) : null; });
    const g = (k: 'w' | 'd' | 't', i: number) => (cols[k] !== undefined ? inUnit(k, cell(k)) : null) ?? (cols.sz !== undefined ? nums[i] ?? null : null);
    const o: BeamIn = { name, w: g('w', 0), d: g('d', 1) };
    if (cat === 'ftg') o.t = g('t', 2);
    if (o.w === null || o.d === null || (cat === 'ftg' && !o.t)) return null;
    if (cols.r !== undefined) { const t = String(cell('r') ?? '').replace(/,/g, '').match(/^\s*(\d+(?:\.\d+)?)/); o.r = t ? Number(t[1]) : null; }
    return o;
  }
  let w = cols.w !== undefined ? inUnit('w', cell('w')) : null;
  let d = cols.d !== undefined && !isThk(cat) ? inUnit('d', cell('d')) : null;
  let round = false;
  // (a column: "Ø500" in its size - or its width - column is round)
  if (cat === 'col') for (const k of ['sz', 'w'] as const) { const r = cols[k] !== undefined ? roundOf(cell(k)) : null; if (r && !round) { w = r; d = null; round = true; } }
  // (a size column in the unit its heading names: "Size (cm)" 60 x 60; a column's size wins over a "depth" read elsewhere)
  const szc = cell('sz'), szs = units.sz && typeof szc === 'string' && !/[a-z]/i.test(szc) ? szc + ' ' + units.sz : units.sz && typeof szc === 'number' ? szc + units.sz : szc;
  if (!round && cols.sz !== undefined && (w === null || d === null || cat === 'col')) { const p = pairOf(szs); if (p) { if (w === null || cat === 'col') w = p[0]; if ((d === null || cat === 'col') && !isThk(cat)) d = p[1]; } else if (isThk(cat) && w === null) w = sizeOf(thk(szs)); }
  // a heading row inside the table ("FIRST FLOOR"), a note: no size (a shear wall: its thickness alone)
  if (w === null || (d === null && cat === 'beam') || (d === null && cat === 'col' && !round)) return null;
  const out: BeamIn = { name, w, d };
  if (round) out.round = true;
  if (cols.r !== undefined) {
    const t = String(cell('r') ?? '').replace(/,/g, '').match(/^\s*(\d+(?:\.\d+)?)/);
    out.r = t ? Number(t[1]) : null;
  }
  return out;
}

/** the sheet and row that look most like a beam schedule's header */
export function analyseBeamSchedule(wb: XWorkbook, cat: MemberCat = 'beam'): BeamSheetPlan | null {
  let best: { score: number; plan: BeamSheetPlan } | null = null;
  for (const { name, state } of wb.sheetNames) {
    if (state !== 'visible') continue;
    let sh: XSheet;
    try { sh = wb.sheet(name); } catch { continue; }
    for (let r = 1; r <= Math.min(sh.maxRow, 40); r++) {
      for (const heads of [headsAt(sh, r), headsOne(sh, r)]) {
        if (heads.size < 2) continue;
        const cols = guessBeamCols(heads, cat);
        if (cols.mark === undefined || !(cat === 'stair' ? cols.tr !== undefined && cols.ri !== undefined : cols.sz !== undefined || (cols.w !== undefined && (cols.d !== undefined || cat !== 'beam')))) continue;
        let data = 0;
        for (let rr = r + 1; rr <= Math.min(sh.maxRow, r + 60); rr++) { const row = sh.rows.get(rr); if (row && beamFromRow(row, cols, {}, cat)) data++; }
        if (!data) continue;
        const score = data * 10 + (cols.r !== undefined ? 2 : 0);
        if (!best || score > best.score) best = { score, plan: { sheet: name, header: r, heads, cols } };
      }
    }
  }
  return best?.plan ?? null;
}

/** the beams of a schedule sheet, with the columns as chosen */
export function beamRows(wb: XWorkbook, plan: Pick<BeamSheetPlan, 'sheet' | 'header' | 'cols'>, cat: MemberCat = 'beam'): BeamIn[] {
  const sh = wb.sheet(plan.sheet);
  const out: BeamIn[] = [];
  if (plan.cols.mark === undefined) return out;
  const heads = headsAt(sh, plan.header);
  const units: Partial<Record<BeamCol, 'mm' | 'cm' | 'm' | ''>> = {};
  for (const k of ['w', 'd', 't', 'sz', 'tr', 'ri'] as const) if (plan.cols[k] !== undefined) units[k] = unitOfHeading(heads.get(plan.cols[k]!) ?? '');
  for (let r = plan.header + 1; r <= sh.maxRow; r++) {
    if (sh.hiddenRows.has(r)) continue;
    const row = sh.rows.get(r);
    const b = row ? beamFromRow(row, plan.cols, units, cat) : null;
    if (b) out.push(b);
  }
  return out;
}

// ---------------------------------------------------------------- the import: what is new, what changed
export type BeamField = 'w' | 'd' | 'r' | 'round' | 't' | 'tr' | 'ri';
export interface BeamPlanRow { k: 'new' | 'changed' | 'same'; key: string; row: BeamIn; id?: string; ch: [BeamField, number | boolean | null, number | boolean | null][] }
export interface BeamPlan { rows: BeamPlanRow[]; dupes: string[]; missing: BeamType[] }
const eq = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < 1e-6);

/** the file's rows against the schedule (by mark; the same mark twice in the file: the first) */
export function planBeamImport(m: Pick<QtoModel, 'beamTypes'> | { beamTypes: BeamType[] }, rows: BeamIn[], cat: MemberCat = 'beam'): BeamPlan {
  const have = new Map(m.beamTypes.map((t) => [tagKey(t.name), t]));
  const seen = new Set<string>();
  const out: BeamPlanRow[] = [];
  const dupes: string[] = [];
  for (const row of rows) {
    const key = tagKey(row.name);
    if (!key) continue;
    if (seen.has(key)) { dupes.push(row.name); continue; }
    seen.add(key);
    const t = have.get(key);
    if (!t) { out.push({ k: 'new', key, row, ch: [] }); continue; }
    const ch: BeamPlanRow['ch'] = [];
    if (row.w !== undefined && !eq(t.w, row.w)) ch.push(['w', t.w, row.w]);
    if (!isThk(cat) && row.d !== undefined && !eq(t.d, row.d)) ch.push(['d', t.d, row.d]);
    if (cat === 'col' && !!t.round !== !!row.round) ch.push(['round', !!t.round, !!row.round]);
    if ((cat === 'ftg' || cat === 'stair') && row.t !== undefined && !eq(t.t ?? null, row.t ?? null)) ch.push(['t', t.t ?? null, row.t ?? null]);
    if (cat === 'stair') for (const k of ['tr', 'ri'] as const) if (row[k] !== undefined && !eq(t[k] ?? null, row[k] ?? null)) ch.push([k, t[k] ?? null, row[k] ?? null]);
    // (a steel column with nothing in that row keeps the ratio typed in the app)
    if (row.r !== undefined && row.r !== null && !eq(t.r, row.r)) ch.push(['r', t.r, row.r]);
    out.push({ k: ch.length ? 'changed' : 'same', key, row, id: t.id, ch });
  }
  return { rows: out, dupes, missing: m.beamTypes.filter((t) => !seen.has(tagKey(t.name))) };
}

/** the rows taken (by key; a changed row: the fields ticked) as ops; new types get the next colours */
export function applyBeamPlanOps(plan: BeamPlan, take: Map<string, Set<BeamField> | true>, colors: string[], used: number, cat: MemberCat = 'beam'): { ops: Op[]; added: number; updated: number } {
  const ops: Op[] = [];
  let added = 0, updated = 0;
  for (const r of plan.rows) {
    const t = take.get(r.key);
    if (!t) continue;
    if (r.k === 'new') {
      const t = { name: r.row.name, w: r.row.w ?? null, d: isThk(cat) ? null : r.row.d ?? null, r: r.row.r ?? null, color: colors[(used + added) % colors.length], round: r.row.round, t: r.row.t ?? null, tr: r.row.tr ?? null, ri: r.row.ri ?? null };
      ops.push(...(cat === 'beam' ? beamTypeOps(t) : memberTypeOps(MEMBER_PRE[cat], t)).ops);
      added++;
    } else if (r.k === 'changed' && r.id) {
      let n = 0;
      for (const [f, , v] of r.ch) if (t === true || t.has(f)) { ops.push([r.id, f, f === 'round' ? (v ? true : null) : v]); if (f === 'round' && v) ops.push([r.id, 'd', null]); n++; }
      if (n) updated++;
    }
  }
  return { ops, added, updated };
}

// ---------------------------------------------------------------- marks on the drawing -> beam segments
export interface BeamProp {
  shape: string;
  seg: number;
  /** the type it gets */
  bt: string;
  /** the mark as written, and where */
  text: string;
  p: Pt;
  /** its segment's middle (the proposal is drawn between the two) */
  at: Pt;
  /** the segment's tag now; already this type: left out */
  cur: string | null;
  /** the shape's nodes when proposed (changed since: not kept) */
  n: number;
  on: boolean;
  same: boolean;
}

/**
 * Each mark of a beam type found on the sheet goes to the beam segment nearest to it - within a few text heights
 * (a mark sits by its beam: a column's C1 across the room is not a beam's) - and each segment to the mark nearest
 * to it. `beams`: the beam take-offs' shapes on this sheet that can be tagged (shown).
 */
export function beamTagProposals(beams: Shape[], marks: { bt: string; f: Found }[]): BeamProp[] {
  const best = new Map<string, BeamProp & { dist: number }>();
  for (const { bt, f } of marks) {
    const h = Math.max(1, Math.min(f.x1 - f.x0, f.y1 - f.y0));
    const reach = Math.min(60, Math.max(12, h * 6));
    let hit: { s: Shape; seg: number; d: number } | null = null;
    for (const s of beams) {
      if (s.k !== 'line' && s.k !== 'poly') continue;
      const n = s.k === 'poly' ? s.pts.length : s.pts.length - 1;
      for (let i = 0; i < n; i++) {
        const d = segDist(f.p, s.pts[i], s.pts[(i + 1) % s.pts.length]).d;
        if (d <= reach && (!hit || d < hit.d)) hit = { s, seg: i, d };
      }
    }
    if (!hit) continue;
    const k = hit.s.id + ':' + hit.seg;
    const was = best.get(k);
    if (was && was.dist <= hit.d) continue;
    const a = hit.s.pts[hit.seg], b = hit.s.pts[(hit.seg + 1) % hit.s.pts.length];
    const cur = hit.s.sg[hit.seg] ?? null;
    const same = tagBase(cur) === bt;
    best.set(k, { shape: hit.s.id, seg: hit.seg, bt, text: f.text, p: f.p, at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], cur, same, on: !same, n: hit.s.pts.length, dist: hit.d });
  }
  return [...best.values()].map(({ dist: _d, ...x }) => x);
}

/** the proposals kept: each shape's segments tagged in one go */
export function beamTagOps(shapes: Shape[], props: BeamProp[]): Op[] {
  const by = new Map<string, Map<number, string>>();
  for (const x of props) if (x.on && !x.same) (by.get(x.shape) ?? by.set(x.shape, new Map()).get(x.shape)!).set(x.seg, x.bt);
  const ops: Op[] = [];
  // (v0.18.1 a segment's own figures stay with it)
  for (const [id, tags] of by) { const s = shapes.find((y) => y.id === id); if (s) ops.push(...segTagsManyOps(s, new Map([...tags].map(([i, t]) => [i, withTagOwn(t, tagOwn(s.sg[i]))])))); }
  return ops;
}

/** v0.17 a schedule as Excel rows (export): mark, sizes in mm, steel ratio */
export function memberScheduleRows(types: BeamType[], cat: MemberCat): (string | number | null)[][] {
  const mm = (v: number | null) => (v === null ? null : Math.round(v * 1000 * 10) / 10);
  // (a round column: "Ø500" in its width - read back as round)
  if (cat === 'swall') return [['Mark', 'Length (mm)', 'Thickness (mm)', 'Steel (kg/m3)'], ...types.map((t) => [t.name, mm(t.w), mm(t.d), t.r])];
  if (cat === 'stair') return [['Mark', 'Tread (mm)', 'Riser (mm)', 'Flight width (mm)', 'Waist (mm)', 'Landing thickness (mm)', 'Steel (kg/m3)'], ...types.map((t) => [t.name, mm(t.tr ?? null), mm(t.ri ?? null), mm(t.w), mm(t.d), mm(t.t ?? null), t.r])];
  if (cat === 'ftg') return [['Mark', 'Length (mm)', 'Width (mm)', 'Depth (mm)', 'Steel (kg/m3)'], ...types.map((t) => [t.name, mm(t.w), mm(t.d), mm(t.t ?? null), t.r])];
  const head = isThk(cat) ? ['Mark', 'Thickness (mm)', 'Steel (kg/m3)'] : cat === 'col' ? ['Mark', 'Width / Ø (mm)', 'Depth (mm)', 'Steel (kg/m3)'] : ['Mark', 'Width (mm)', 'Depth (mm)', 'Steel (kg/m3)'];
  return [head, ...types.map((t) => (isThk(cat) ? [t.name, mm(t.w), t.r] : cat === 'col' ? [t.name, t.round ? 'Ø' + mm(t.w) : mm(t.w), t.round ? null : mm(t.d), t.r] : [t.name, mm(t.w), mm(t.d), t.r]))];
}
