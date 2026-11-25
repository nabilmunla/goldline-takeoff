// Rooms (v0.16 Finishes module): what a room is in the data, its quantities exactly as ROOM-SPEC.md
// sections 2-6 say, its "Show working", and the changes the UI makes to it.
//
// A room is a take-off (`ti:`, kind 'room') whose shapes are its outline (closed areas, cut-outs allowed);
// several outlines add up. Its edges carry their flags in the shape's segment tags (`sg`), so they follow
// every node inserted / deleted / moved exactly like tags do (written with the corners, geomOps):
//   '~o' = open edge (no wall)   '~g' = shadow gap picked on this edge (also on ceiling areas' edges)
// Its doors / openings are the ordinary `op:` entities on its outline shapes (plus `sill`): the model keeps
// them in `roomOpenings` (and `openingsByShape`), never in `openings`, so no door count / total sees them.
// Additional finishes and manual ceiling areas are take-offs of their own (`ti:` kind line / area, with
// rm = the room, rk = 'add' | 'ceil', rcat = floor|wall|skirting|ceiling): drawn, selected, hidden and
// deleted like any take-off, but they live only with their room. An existing take-off linked to a room has
// rm + rk 'link' + rcat (a category, or an additional finish's id) and keeps everything of its own.
//
// Every figure is worked out per outline shape in "perimeter coordinates": metres along the outline from
// its first node (each segment measured where it lies: viewports, X / Y scales - segLensAt), so a door
// (its centre ± half its width) or a stretch drawn along the outline is an interval of that line.
// The changes (ops builders) are in roomops.ts.
import type { Value } from '../types';
import type { Store } from '../store';
import { nearestSeg, openingSize, segLensAt, shapeQtyAt, scaleAt, type QtoModel, type Shape, type TItem, type Opening } from './model';
import { arcCircle, arcPoints, pointInPoly, polyInside, polysOverlap, segDist } from './geometry';
import type { Pt } from './geometry';
import polygonClipping, { type Polygon as PcPolygon, type MultiPolygon as PcMulti } from 'polygon-clipping';

const ringArea = (r: [number, number][] | Pt[]) => { let a = 0; for (let i = 0, n = r.length; i < n; i++) { const p = r[i], q = r[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; };
const multiArea = (mp: PcMulti) => mp.reduce((t, poly) => t + poly.reduce((u, ring, i) => u + (i ? -1 : 1) * ringArea(ring), 0), 0);
/**
 * v0.18.1 the area false ceilings drawn over each other cover, counted once (m²): their union, sheet by sheet; at
 * each sheet's scale (m² per sheet unit², from the shapes' own figures). A piece × n or two scales on one sheet:
 * their plain sum (said elsewhere: drawn over each other is flagged).
 */
export function planUnionArea(shapes: Shape[], areaOf: (s: Shape) => number): number {
  const by = new Map<string, Shape[]>();
  for (const s of shapes) (by.get(s.dwg + '#' + s.pg) ?? by.set(s.dwg + '#' + s.pg, []).get(s.dwg + '#' + s.pg)!).push(s);
  let tot = 0;
  for (const g of by.values()) {
    const sum = g.reduce((t, s) => t + areaOf(s), 0);
    if (g.length === 1 || g.some((s) => s.m !== 1)) { tot += sum; continue; }
    const raw = (s: Shape) => ringArea(s.flat) - s.holes.reduce((t, h) => t + ringArea(h), 0);
    const ks = g.map((s) => { const r = raw(s); return r > 1e-9 ? areaOf(s) / r : NaN; });
    if (ks.some((k) => !Number.isFinite(k) || Math.abs(k - ks[0]) > Math.abs(ks[0]) * 1e-6)) { tot += sum; continue; }
    const geom = (s: Shape): PcPolygon => [s.flat.map((p) => [p[0], p[1]] as [number, number]), ...s.holes.map((h) => h.map((p) => [p[0], p[1]] as [number, number]))];
    try { tot += multiArea(polygonClipping.union(geom(g[0]), ...g.slice(1).map(geom))) * ks[0]; } catch { tot += sum; }
  }
  return tot;
}

export type FinCat = 'floor' | 'wall' | 'skirting' | 'ceiling';
export const FIN_CATS: FinCat[] = ['floor', 'wall', 'skirting', 'ceiling'];
export type FinishType = 'Floor' | 'Wall' | 'Plaster' | 'Above ceiling' | 'Skirting' | 'Ceiling' | 'Bulkhead' | 'Shadow gap' | 'Horizontal WP' | 'Vertical WP' | 'Miscellaneous' | 'Other';
export const FINISH_TYPES: FinishType[] = ['Floor', 'Wall', 'Plaster', 'Above ceiling', 'Skirting', 'Ceiling', 'Bulkhead', 'Shadow gap', 'Horizontal WP', 'Vertical WP', 'Miscellaneous', 'Other'];
export const CAT_TYPE: Record<FinCat, FinishType> = { floor: 'Floor', wall: 'Wall', skirting: 'Skirting', ceiling: 'Ceiling' };
export const CAT_UNIT: Record<FinCat, 'm²' | 'm'> = { floor: 'm²', wall: 'm²', skirting: 'm', ceiling: 'm²' };
export const CAT_NAME: Record<FinCat, string> = { floor: 'Floor finish', wall: 'Wall finish', skirting: 'Skirting', ceiling: 'Ceiling finish' };
/** segment-tag flags of a room's (or a ceiling area's) edges */
export const EDGE_OPEN = '~o';
export const EDGE_GAP = '~g';
const EPS = 1e-9;

/** The settings of a room (codes and heights): what "a new room offers from the last room with the same name" */
export interface RoomSettings {
  fc: string; wc: string; hw: number | null; kc: string; hs: number | null;
  cc: string; cm: 'auto' | 'manual'; gc: string; gm: '' | 'all' | 'pick';
  pc: string; pm: '' | 'up' | 'full'; pu: number | null; pl: number | null; phc: string; pvc: string;
  /** v0.16.4 the main ceiling's height above FFL 0 (a bulkhead under it drops from there); cs: the main ceiling is
   *  the soffit (the slab's underside): it is what no other ceiling of the room covers */
  ch: number | null; cs: boolean;
  /** v0.18 (Nabil, 9-11 Nov) the room height above FFL 0 (to the soffit). A room that has one is measured by the
   *  ceiling over each stretch of its walls: the wall finish goes up to that ceiling + fe (0.10 unless typed), to the
   *  room height where there is no false ceiling (a typed wall height hw still wins); the walls above the finish, up
   *  to the soffit, are a finish of their own (bc: anti-fungal paint… - bn: nothing there); plaster (plc) goes to the
   *  room height, to a typed height (php), or stops where the finish stops (ppf). null: the room as before 0.18. */
  rmh: number | null; fe: number | null; php: number | null; ppf: boolean; plc: string; bc: string; bn: boolean;
}
export const ROOM_SETTING_FIELDS = ['fc', 'wc', 'hw', 'kc', 'hs', 'cc', 'cm', 'gc', 'gm', 'pc', 'pm', 'pu', 'pl', 'phc', 'pvc', 'ch', 'cs', 'rmh', 'fe', 'php', 'ppf', 'plc', 'bc', 'bn'] as const;
export const CODE_FIELDS = new Set(['fc', 'wc', 'kc', 'cc', 'gc', 'pc', 'phc', 'pvc', 'plc', 'bc']);
export const LEN_FIELDS = new Set(['hw', 'hs', 'pu', 'pl', 'ch', 'rmh', 'fe', 'php']);
/** v0.18 how far above a false ceiling the wall finish goes, unless the room says otherwise */
export const FINISH_ABOVE_FC = 0.1;

export interface Room extends RoomSettings {
  id: string;
  it: TItem;
  name: string;
  desc: string;
  /** Times (×N): multiplies every quantity of the room, deductions included */
  times: number;
  /** heading ('' = top level) */
  par: string;
  /** stamp of its creation (the 'kind' cell): "the last room with the same name" */
  born: string;
  /** v0.16.4 the ceilings do not cover the floor and that is right (open to the sky, no ceiling): the note, and the
   *  figures it was written for ("ceiling|floor", 2 dp) - other figures later: asked again */
  cnn: string;
  cnv: string;
}

/** an additional finish ('add'), a manual ceiling area ('ceil') or an existing take-off linked to the room ('link') */
export interface RoomPart {
  id: string;
  it: TItem;
  room: string;
  rk: 'add' | 'ceil' | 'link';
  cat: FinCat;
  /** 'link': what it shows under - the category, or an additional finish's id */
  under: string;
  /** its own finish code ('' = none) */
  code: string;
  /** deducted from the main finish of its category (default on) */
  ded: boolean;
  /** additional wall / skirting: height (null = up to the wall finish height / the skirting height), bottom level (null = top of the skirting) */
  h: number | null;
  bl: number | null;
  /** additional floor / ceiling over the full room area */
  full: boolean;
  /** a length linked to Wall: its height (null = the take-off's own height) */
  rh: number | null;
  /** v0.16.4 an additional finish that is a bulkhead (cat ceiling, a length) or a higher waterproofing upturn (cat
   *  wall, a length along the outline; h = its height) - not an additional finish of its category */
  ak: '' | 'bh' | 'up' | 'misc';
  /** a ceiling (manual area / additional ceiling): its height above FFL 0 */
  lv: number | null;
  /** a ceiling under the soffit: the soffit above it is finished too (fa), with this code (fac) */
  fa: boolean;
  fac: string;
  /** a bulkhead: its underside above FFL 0, and the ceiling it hangs from ('' = the main ceiling) */
  bh: number | null;
  bp: string;
  /** v0.16.5 an additional wall finish drawn as an area (cladding of an odd shape on an elevation): its own m² */
  wa: boolean;
  /** v0.18 an area drawn on an elevation that stands for a stretch of the plan (its lengths drawn along the
   *  outline): the wall finish is not taken there (P × height, with its openings) - the area drawn is */
  wr: boolean;
  /** v0.18 a miscellaneous item of the room (ak 'misc': kitchen cabinets, wardrobes, vanities, mirrors…): what it is
   *  counted in ('nr' | 'm' | 'm2' - a length with a height is an area), a typed quantity in place of what is drawn
   *  (null = as drawn), its finish (a note: "white lacquer") */
  mu: 'nr' | 'm' | 'm2';
  mq: number | null;
  mf: string;
}

export interface RoomFinish {
  /** 'floor' | 'wall' | 'skirting' | 'ceiling' | 'gap' | 'wph' | 'wpv' for the room's own; else the part's id */
  key: string;
  type: FinishType;
  cat: FinCat | null;
  role: 'main' | 'add' | 'link';
  name: string;
  /** the code as written on it ('' = none: kept out of the summary - never the code of the finish it shows under) */
  code: string;
  unit: 'm²' | 'm' | 'nr';
  /** the quantity: Times applied, deductions taken, never below 0 */
  qty: number;
  /** before the clamp (below 0: deductions larger than the finish) */
  raw: number;
  over: boolean;
  /** additional / linked: deducted from the main finish */
  ded?: boolean;
  /** where it shows in the room: a main key ('wall'...) or, for a link to an additional finish, its id */
  under?: string;
  /** ids it comes from: the room (and the part / take-off) */
  src: string[];
  /** something to check on this finish (not drawn, incompatible link, no height, off the outline...) */
  note?: string;
  /** (roomTree only) the room has no main finish of this kind: a place for its additional / linked ones */
  none?: boolean;
  /** v0.18 a miscellaneous item's finish (a note) */
  fin?: string;
}

/** v0.18 a stretch of a room's walls and what is over it: the false ceiling's height (null = none: the soffit) and
 *  where the wall finish stops there (lengths: one room, shape repeats in, before Times) */
export interface WallZone { len: number; top: number; fc: number | null }

export interface RoomOpeningQ {
  id: string;
  shape: string;
  seg: number;
  k: 'door' | 'open';
  tag: string;
  w: number | null;
  h: number | null;
  sill: number;
  /** on an open edge: not deducted (an open edge has no wall) */
  onOpen: boolean;
}

export interface RoomQty {
  id: string;
  /** floor area (cut-outs off), wall perimeter (wall edges), open edges' length, outline length - all × shape repeats, before Times */
  A: number;
  P: number;
  open: number;
  N: number;
  finishes: RoomFinish[];
  byKey: Map<string, RoomFinish>;
  openings: RoomOpeningQ[];
  /** linked take-offs whose own Times differs from the room's (they count at face value: say so) */
  timesDiffer: string[];
  /** v0.16.4 the ceilings against the floor (one room, before Times): equal unless a note says why not */
  ceil: { covered: number; A: number; equal: boolean; noted: string };
  /** v0.18 a room with a Room height: its walls by the ceiling over them (lowest finish first); else empty */
  zones: WallZone[];
  /** 'over' (deductions larger than a finish), 'unscaled', 'mixed' (across a viewport edge), 'badHoles' (cut-outs
   *  not deducted), 'noOutline', 'notArea' (a length drawn as the outline), 'doorOnOpen' (not deducted), 'noSize'
   *  (a door / opening without a size), 'offOutline' (an additional length not along the outline), 'notDrawn',
   *  'noHeight', 'incompatible' (a linked take-off that can't go there), 'outsideRoom' (an area not inside the outline),
   *  'timesDiffer' (a linked take-off's own Times is not the room's: timesDiffer lists them), 'addOverlap' (deducted
   *  additional floor / ceiling areas drawn over each other: that area comes off the main twice), 'ceilFloor' (v0.16.4:
   *  the ceilings do not cover the floor, no note), 'ceilNoted' (they don't, a note says why), 'bhHeight' (a
   *  bulkhead's drop not known: its height or its ceiling's missing, not below that ceiling, or its ceiling removed),
   *  v0.18.3 'fcAbove' (a false ceiling set above the room height: not measured)
   *  v0.18.1 'soffitCode' (soffit with m², no code), 'noRoomHeight' (a soffit room without its height), 'twoFull'
   *  (two full-room false ceilings) */
  flags: string[];
}

// ------------------------------------------------------------------ reading
const numV = (v: Value | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const nonneg = (v: Value | undefined) => { const n = numV(v); return n !== null && n >= 0 ? n : null; };
const pos = (v: Value | undefined) => { const n = numV(v); return n !== null && n > 0 ? n : null; };
const strV = (v: Value | undefined) => (v === null || v === undefined ? '' : String(v).trim());

export function readRoom(store: Store, it: TItem): Room {
  const g = (f: string) => store.get(it.id, f);
  return {
    id: it.id, it, name: it.name, desc: strV(g('desc')), times: it.x || 1, par: it.par, born: store.cell(it.id, 'kind')?.s ?? '',
    fc: strV(g('fc')), wc: strV(g('wc')), hw: nonneg(g('hw')), kc: strV(g('kc')), hs: nonneg(g('hs')),
    cc: strV(g('cc')), cm: g('cm') === 'manual' ? 'manual' : 'auto', gc: strV(g('gc')), gm: g('gm') === 'all' ? 'all' : g('gm') === 'pick' ? 'pick' : '',
    pc: strV(g('pc')), pm: g('pm') === 'up' ? 'up' : g('pm') === 'full' ? 'full' : '', pu: nonneg(g('pu')), pl: nonneg(g('pl')), phc: strV(g('phc')), pvc: strV(g('pvc')),
    ch: nonneg(g('ch')), cs: g('cs') === true, cnn: strV(g('cnn')), cnv: strV(g('cnv')),
    rmh: pos(g('rmh')), fe: nonneg(g('fe')), php: pos(g('php')), ppf: g('ppf') === true, plc: strV(g('plc')), bc: strV(g('bc')), bn: g('bn') === true,
  };
}

export function readPart(store: Store, it: TItem): RoomPart | null {
  if (!it.rm || !it.rk) return null;
  const g = (f: string) => store.get(it.id, f);
  const rc = strV(g('rcat'));
  const cat = (FIN_CATS as string[]).includes(rc) ? (rc as FinCat) : null;
  // (v0.18 a miscellaneous item: no category - 'floor' stands in, never read: everything by category leaves `ak` out)
  const misc = it.rk === 'add' && g('ak') === 'misc';
  // a link may show under an additional finish (its id): its category is that finish's, resolved later
  if (!cat && !misc && !(it.rk === 'link' && rc.startsWith('ti:'))) return null;
  return {
    id: it.id, it, room: it.rm, rk: it.rk, cat: misc ? 'floor' : cat ?? 'wall', under: misc ? 'misc' : rc, code: it.fcode ?? '', ded: misc ? false : (it.rk === 'add' && cat === 'wall' && g('wa') === true && g('wr') === true) || g('rded') !== false,
    h: it.rk === 'add' ? it.h : null, bl: nonneg(g('bl')), full: g('full') === true, rh: numV(g('rh')) !== null && numV(g('rh'))! > 0 ? numV(g('rh')) : null,
    ak: misc ? 'misc' : it.rk === 'add' && (g('ak') === 'bh' || g('ak') === 'up') ? (g('ak') as 'bh' | 'up') : '',
    lv: nonneg(g('lv')), fa: g('fa') === true, fac: strV(g('fac')), bh: nonneg(g('bh')), bp: strV(g('bp')),
    wa: it.rk === 'add' && cat === 'wall' && !misc && g('wa') === true,
    wr: it.rk === 'add' && cat === 'wall' && !misc && g('wa') === true && g('wr') === true,
    mu: g('mu') === 'm' ? 'm' : g('mu') === 'm2' ? 'm2' : 'nr', mq: misc ? nonneg(g('mq')) : null, mf: strV(g('mf')),
  };
}

/**
 * v0.16.5 (Nabil, 9 Nov: "why do I need to fill the underside height if I am already drawing it on a ceiling line,
 * and the ceiling height is filled?") - a bulkhead picked / drawn along the edge of one of the room's ceilings
 * (a false ceiling at 2.70) has that ceiling's height as its underside. The ceiling it hangs from (its top: the soffit /
 * the room's ceiling, or another ceiling of the room) is never its underside. Several ceilings along it: the lowest.
 * null: not along any ceiling with a height (its Underside box says it).
 */
/** the main ceiling's height: as typed - the soffit's, when not typed, is the room height (v0.18) */
export const mainLevel = (room: Pick<Room, 'ch' | 'cs' | 'rmh'>): number | null => room.ch ?? (room.cs ? room.rmh : null);

export function bulkheadUnderside(m: Pick<QtoModel, 'shapesByItem'>, room: Room, parts: RoomPart[], p: RoomPart): { h: number; name: string; code: string; mixed: boolean } | null {
  // (hung from the room's own ceiling / the soffit: its ceiling areas are that ceiling, not under it)
  const cands = parts.filter((x) => x.id !== p.bp && ((x.rk === 'ceil' && !!p.bp && !room.cs) || (x.rk === 'add' && x.cat === 'ceiling' && !x.ak)))
    .map((x) => ({ x, h: x.rk === 'ceil' ? x.lv ?? mainLevel(room) : x.lv }))
    .filter((c): c is { x: RoomPart; h: number } => c.h !== null);
  if (!cands.length) return null;
  const TOL = 3; // sheet points (picked edges are exact copies; drawn ones snap to them)
  const onRing = (q: Pt, ring: Pt[]) => ring.some((a, i) => segDist(q, a, ring[(i + 1) % ring.length]).d <= TOL);
  const heights = new Set<number>();
  let best: { h: number; name: string; code: string } | null = null;
  for (const ln of m.shapesByItem.get(p.id) ?? []) {
    if (ln.k !== 'line' || ln.pts.length < 2) continue;
    const q = [...ln.pts, ...ln.pts.slice(1).map((b, i) => [(ln.pts[i][0] + b[0]) / 2, (ln.pts[i][1] + b[1]) / 2] as Pt)];
    let here: { h: number; name: string; code: string } | null = null;
    for (const c of cands) {
      for (const s of m.shapesByItem.get(c.x.id) ?? []) {
        if (s.k !== 'poly' || s.dwg !== ln.dwg || s.pg !== ln.pg) continue;
        if (q.every((pt) => onRing(pt, s.flat))) { if (!here || c.h < here.h) here = { h: c.h, name: c.x.rk === 'ceil' ? 'the ceiling' : c.x.it.name, code: c.x.rk === 'ceil' ? room.cc : c.x.code }; }
      }
    }
    if (!here) continue;
    heights.add(Math.round(here.h * 1000));
    if (!best || here.h < best.h) best = here;
  }
  return best ? { ...best, mixed: heights.size > 1 } : null;
}

export const edgeFlags = (tag: string | null | undefined) => ({ open: !!tag && tag.includes(EDGE_OPEN), gap: !!tag && tag.includes(EDGE_GAP) });
/** a segment tag with a flag set or cleared (any text of the tag kept) */
export function withEdgeFlag(tag: string | null | undefined, flag: string, on: boolean): string | null {
  const base = (tag ?? '').split(EDGE_OPEN).join('').split(EDGE_GAP).join('');
  const f = edgeFlags(tag);
  const open = flag === EDGE_OPEN ? on : f.open, gap = flag === EDGE_GAP ? on : f.gap;
  const out = base + (open ? EDGE_OPEN : '') + (gap ? EDGE_GAP : '');
  return out || null;
}

// ------------------------------------------------------------------ intervals along an outline
type Iv = [number, number];
const merge = (ivs: Iv[]): Iv[] => {
  const s = ivs.filter((x) => x[1] - x[0] > EPS).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Iv[] = [];
  for (const x of s) {
    const l = out[out.length - 1];
    if (l && x[0] <= l[1] + EPS) l[1] = Math.max(l[1], x[1]);
    else out.push([x[0], x[1]]);
  }
  return out;
};
const ivLen = (ivs: Iv[]) => { let t = 0; for (const x of ivs) t += x[1] - x[0]; return t; };
const ivAnd = (a: Iv[], b: Iv[]): Iv[] => {
  const out: Iv[] = [];
  for (const x of a) for (const y of b) { const lo = Math.max(x[0], y[0]), hi = Math.min(x[1], y[1]); if (hi - lo > EPS) out.push([lo, hi]); }
  return merge(out);
};
/** a less b */
const ivSub = (a: Iv[], b: Iv[]): Iv[] => {
  let cur = a.map((x) => [x[0], x[1]] as Iv);
  for (const y of b) {
    const nx: Iv[] = [];
    for (const x of cur) {
      if (y[1] <= x[0] + EPS || y[0] >= x[1] - EPS) { nx.push(x); continue; }
      if (y[0] - x[0] > EPS) nx.push([x[0], y[0]]);
      if (x[1] - y[1] > EPS) nx.push([y[1], x[1]]);
    }
    cur = nx;
  }
  return merge(cur);
};
/** an interval going round a closed outline of length T (start anywhere, wraps past the end) */
const cyc = (start: number, len: number, T: number): Iv[] => {
  if (T <= 0 || len <= 0) return [];
  if (len >= T - EPS) return [[0, T]];
  const s = ((start % T) + T) % T, e = s + len;
  return e <= T + EPS ? [[s, Math.min(e, T)]] : [[s, T], [0, e - T]];
};
/** the height two vertical ranges share */
export const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

interface Rect { s: Iv[]; z0: number; z1: number }
/** area of the union of rectangles (perimeter intervals × height ranges), optionally only inside one more rectangle */
function unionArea(rects: Rect[], clip?: Rect): number {
  const xs = new Set<number>();
  const rs: { a: number; b: number; z0: number; z1: number }[] = [];
  for (const r of rects) for (const iv of r.s) if (r.z1 - r.z0 > EPS) { rs.push({ a: iv[0], b: iv[1], z0: r.z0, z1: r.z1 }); xs.add(iv[0]); xs.add(iv[1]); }
  if (!rs.length) return 0;
  if (clip) for (const iv of clip.s) { xs.add(iv[0]); xs.add(iv[1]); }
  const X = [...xs].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i + 1 < X.length; i++) {
    const a = X[i], b = X[i + 1], mid = (a + b) / 2;
    if (b - a <= EPS) continue;
    if (clip && !clip.s.some((iv) => mid > iv[0] && mid < iv[1])) continue;
    let zs: Iv[] = rs.filter((r) => mid > r.a && mid < r.b).map((r) => [r.z0, r.z1] as Iv);
    if (clip) zs = zs.map((z) => [Math.max(z[0], clip.z0), Math.min(z[1], clip.z1)] as Iv);
    area += ivLen(merge(zs)) * (b - a);
  }
  return area;
}

// ------------------------------------------------------------------ one outline shape
interface OpenGeo { o: Opening; q: RoomOpeningQ; iv: Iv[]; w: number | null; h: number | null; sill: number }
interface Outline {
  s: Shape;
  rep: number;
  scaled: boolean;
  lens: number[];
  cum: number[];
  T: number;
  open: boolean[];
  gap: boolean[];
  /** wall edges as intervals, their length (one copy) */
  W: Iv[];
  P: number;
  openLen: number;
  A: number;
  mixed: boolean;
  badHoles: number;
  ops: OpenGeo[];
}

type GeoModel = Pick<QtoModel, 'pages' | 'regions' | 'doorById' | 'openingsByShape'>;

/**
 * How far round an arc (0..1 of its length) the point of the arc nearest p is - by its angle, not by its
 * chord: a point 45° round a half circle is a quarter of the way, though only 15% along the chord.
 * Not an arc: the chord parameter of p.
 */
export function arcFrac(a: Pt, c: Pt, bulge: number, p: Pt): number {
  const k = arcCircle(a, c, bulge);
  const dx = c[0] - a[0], dy = c[1] - a[1], l2 = dx * dx + dy * dy;
  if (!k) return l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  const sw = Math.abs(k.th), T = 2 * Math.PI;
  const ang = (Math.atan2(p[1] - k.c[1], p[0] - k.c[0]) - k.a0) * Math.sign(k.th);
  const x = ((ang % T) + T) % T;
  if (x <= sw) return sw > 0 ? x / sw : 0;
  return x - sw < T - x ? 1 : 0; // off the arc's sweep: its nearer end
}
/** the point f (0..1 of its length) round an arc a -> c (a straight segment: f along it) */
export function arcAt(a: Pt, c: Pt, bulge: number, f: number): Pt {
  const k = arcCircle(a, c, bulge);
  if (!k) return [a[0] + (c[0] - a[0]) * f, a[1] + (c[1] - a[1]) * f];
  const t = k.a0 + k.th * f;
  return [k.c[0] + k.r * Math.cos(t), k.c[1] + k.r * Math.sin(t)];
}

/** metres along the outline from its first node to the point at t of segment `seg` (p: the point itself) */
function posOn(m: GeoModel, g: Pick<Outline, 's' | 'lens' | 'cum'>, seg: number, t: number, p?: Pt): number {
  const s = g.s;
  const L = g.lens[seg] ?? 0;
  // an arc: by the angle round it (the chord's fraction only when the point is not known)
  if (s.b[seg]) return g.cum[seg] + (p ? arcFrac(s.pts[seg], s.pts[(seg + 1) % s.pts.length], s.b[seg], p) : t) * L;
  const a = s.pts[seg], c = s.pts[(seg + 1) % s.pts.length];
  if (!a || !c) return g.cum[seg] ?? 0;
  const q: Pt = [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t];
  const part = segLensAt(m, { dwg: s.dwg, pg: s.pg, k: 'line', pts: [a, q], b: [] }).lens[0];
  return g.cum[seg] + Math.min(L, part ?? t * L);
}

function outlineOf(m: GeoModel, s: Shape): Outline {
  const sl = segLensAt(m, s);
  const lens = sl.lens.map((x) => x ?? 0);
  const cum: number[] = [];
  let T = 0;
  for (const l of lens) { cum.push(T); T += l; }
  const tags = Array.from({ length: lens.length }, (_, i) => s.sg[i] ?? null);
  const open = tags.map((t) => edgeFlags(t).open), gap = tags.map((t) => edgeFlags(t).gap);
  const W = merge(lens.map((l, i) => [cum[i], cum[i] + l] as Iv).filter((_, i) => !open[i]));
  let P = 0, openLen = 0;
  lens.forEach((l, i) => (open[i] ? (openLen += l) : (P += l)));
  const aq = shapeQtyAt(m, s, null);
  const g: Outline = { s, rep: s.m, scaled: sl.scaled && aq.scaled, lens, cum, T, open, gap, W, P, openLen, A: aq.area, mixed: !!aq.mixed || sl.mixed, badHoles: aq.badHoles, ops: [] };
  for (const o of m.openingsByShape.get(s.id) ?? []) {
    if (!o.room) continue;
    const z = openingSize(m, o);
    const sill = o.k === 'door' ? 0 : Math.max(0, o.sill ?? 0);
    const onOpen = !!open[o.seg];
    const tag = (o.k === 'door' ? (o.door ? m.doorById.get(o.door)?.tag : '') || o.tag || 'Door' : o.tag || 'Opening');
    const q: RoomOpeningQ = { id: o.id, shape: s.id, seg: o.seg, k: o.k, tag, w: z.w, h: z.h, sill, onOpen };
    const c = posOn(m, g, o.seg, o.t, [o.x, o.y]);
    g.ops.push({ o, q, iv: z.w ? cyc(c - z.w / 2, z.w, T) : [], w: z.w, h: z.h, sill });
  }
  return g;
}

/** a stretch drawn along the outline (a length's nodes projected onto it), and how far its nodes were off it (m) */
function stretchOn(m: GeoModel, g: Outline, line: Shape): { iv: Iv[]; off: number } {
  const cs: number[] = [];
  let off = 0;
  for (const p of line.pts) {
    const ns = nearestSeg(g.s, p);
    cs.push(posOn(m, g, ns.seg, ns.t, p));
    const sc = scaleAt(m, line.dwg, line.pg, p).sc ?? 0;
    off = Math.max(off, ns.d * sc);
  }
  const T = g.T;
  const out: Iv[] = [];
  for (let i = 0; i + 1 < cs.length; i++) {
    // each piece of the drawn line goes the short way round between its two nodes
    const f = (((cs[i + 1] - cs[i]) % T) + T) % T;
    out.push(...(f <= T - f + EPS ? cyc(cs[i], f, T) : cyc(cs[i + 1], T - f, T)));
  }
  return { iv: merge(out), off };
}

/** v0.18 how far inside the wall line a ceiling is looked for (m): a ceiling drawn a little short of the wall is still over it */
const COVER_INSET = 0.12;
/** a stretch this short between two stretches under the same ceiling is under it too (m) */
const COVER_GAP = 0.3;
/**
 * v0.18 (Nabil, 11 Nov: "one room could have multiple ceilings at multiple heights ... even the same wall could
 * have a part covered with false ceiling, and another without") - where an area drawn in the room (a ceiling) is
 * over the room's walls: the stretches of the outline (wall edges, metres along it) whose inner side lies under
 * the area. Worked out edge by edge: the edge moved 12 cm into the room is cut where it crosses the area's
 * boundary; each piece is under the area or not. Exact for straight edges (arcs: by their chords).
 */
function coverOn(m: GeoModel, g: Outline, c: Shape): Iv[] {
  if (c.k !== 'poly' || c.dwg !== g.s.dwg || c.pg !== g.s.pg) return [];
  const ring = c.flat, room = g.s.flat;
  if (ring.length < 3) return [];
  const out: Iv[] = [];
  const n = g.s.pts.length;
  for (let i = 0; i < n; i++) {
    if (g.open[i] || !(g.lens[i] > EPS)) continue;
    const a = g.s.pts[i], b = g.s.pts[(i + 1) % n];
    const pts: Pt[] = g.s.b[i] ? [a, ...arcPoints(a, b, g.s.b[i])] : [a, b];
    const k = pts.length - 1;
    for (let j = 0; j < k; j++) {
      const p = pts[j], q = pts[j + 1];
      const dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy);
      if (L < 1e-9) continue;
      const mid: Pt = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      const sc = scaleAt(m, g.s.dwg, g.s.pg, mid).sc ?? 0;
      if (!(sc > 0)) continue;
      // the side of the edge the room is on (a narrow nib: looked for nearer the wall)
      let off: Pt | null = null;
      for (const d of [COVER_INSET / sc, COVER_INSET / sc / 4]) {
        for (const sg of [1, -1]) {
          const o: Pt = [(-dy / L) * d * sg, (dx / L) * d * sg];
          if (pointInPoly([mid[0] + o[0], mid[1] + o[1]], room)) { off = o; break; }
        }
        if (off) break;
      }
      if (!off) continue;
      const P0: Pt = [p[0] + off[0], p[1] + off[1]];
      const rx = dx, ry = dy;
      const ts = [0, 1];
      for (let e = 0; e < ring.length; e++) {
        const c1 = ring[e], c2 = ring[(e + 1) % ring.length];
        const sx = c2[0] - c1[0], sy = c2[1] - c1[1];
        const den = rx * sy - ry * sx;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((c1[0] - P0[0]) * sy - (c1[1] - P0[1]) * sx) / den;
        const u = ((c1[0] - P0[0]) * ry - (c1[1] - P0[1]) * rx) / den;
        if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
      }
      ts.sort((x, y) => x - y);
      const s0 = g.cum[i] + (g.lens[i] * j) / k, sl = g.lens[i] / k;
      for (let e = 0; e + 1 < ts.length; e++) {
        if (ts[e + 1] - ts[e] < 1e-9) continue;
        const tm = (ts[e] + ts[e + 1]) / 2;
        if (pointInPoly([P0[0] + rx * tm, P0[1] + ry * tm], ring)) out.push([s0 + sl * ts[e], s0 + sl * ts[e + 1]]);
      }
    }
  }
  // (a ceiling drawn a little short of the walls leaves slivers at the corners: a gap that small is under it too)
  const cov = merge(out);
  const closed: Iv[] = [];
  for (let i = 0; i < cov.length; i++) {
    const a = cov[i], nx = cov[(i + 1) % cov.length];
    closed.push(a);
    const gap = i + 1 < cov.length ? nx[0] - a[1] : nx[0] + g.T - a[1];
    if (gap > EPS && gap <= COVER_GAP) closed.push(...cyc(a[1], gap, g.T));
  }
  return ivAnd(merge(closed), g.W);
}

/** the outline a drawn length lies along: on its sheet, the nearest (summed over its nodes), then by id */
function outlineFor(gs: Outline[], line: Shape): Outline | null {
  let best: { g: Outline; d: number } | null = null;
  for (const g of gs) {
    if (g.s.dwg !== line.dwg || g.s.pg !== line.pg) continue;
    let d = 0;
    for (const p of line.pts) d += nearestSeg(g.s, p).d;
    if (!best || d < best.d - 1e-9) best = { g, d };
  }
  return best?.g ?? null;
}

// ------------------------------------------------------------------ the quantities
const f2 = (x: number) => (Math.abs(x) < 0.005 ? 0 : x).toFixed(2);
/** v0.16.4 a code with what it is on ("WP-01 (vertical)", "PT-05 (SFT)" - the soffit); '' stays '' */
export const WP_SPLIT = /^(.*\S)\s+\((horizontal|vertical|SFT)\)$/i;
export function wpCode(code: string, side: 'horizontal' | 'vertical' | 'SFT'): string {
  const c = code.trim();
  if (!c) return '';
  const m = WP_SPLIT.exec(c);
  return (m ? m[1] : c) + ` (${side})`;
}
const codeTxt = (c: string) => (c ? ' ' + c : '');

export interface RoomCtx {
  m: Pick<QtoModel, 'pages' | 'regions' | 'doorById' | 'openingsByShape' | 'shapesByItem' | 'qty' | 'itemById'>;
  room: Room;
  parts: RoomPart[];
}

/**
 * A room's finishes, exactly as ROOM-SPEC.md sections 2-6. `work` (optional) gets the arithmetic line by
 * line ("Show working"). Every sum is taken in id order (shapes, openings, parts): the same figure on every PC.
 */
export function roomQty(ctx: RoomCtx, work?: string[]): RoomQty {
  const { m, room } = ctx;
  const W = (t: string) => { if (work) work.push(t); };
  const flags = new Set<string>();
  const N = room.times;
  const shapes = m.shapesByItem.get(room.id) ?? [];
  const gs: Outline[] = [];
  for (const s of shapes) {
    if (s.k !== 'poly') { flags.add('notArea'); continue; }
    const g = outlineOf(m, s);
    if (!g.scaled) { flags.add('unscaled'); continue; }
    if (g.mixed) flags.add('mixed');
    if (g.badHoles) flags.add('badHoles');
    gs.push(g);
  }
  if (!shapes.length) flags.add('noOutline');
  const Hs = room.hs ?? 0;
  // v0.18 a room with a Room height (H): measured by the ceiling over each stretch of its walls (zones below);
  // one without is measured as before - every figure the same
  const H = room.rmh ?? 0;
  const zoned = H > 0;
  const typedHw = (room.hw ?? 0) > 0;
  const Hw = zoned && !typedHw ? H : room.hw ?? 0;
  const FE = room.fe ?? FINISH_ABOVE_FC;
  const hasSkirt = (room.hs ?? 0) > 0 || !!room.kc;
  const hasWall = (room.hw ?? 0) > 0 || !!room.wc;
  const sum = (f: (g: Outline) => number) => { let t = 0; for (const g of gs) t += f(g) * g.rep; return t; };
  const A = sum((g) => g.A), P = sum((g) => g.P), openLen = sum((g) => g.openLen);
  const reps = (f: (g: Outline) => number, unit = '') => gs.map((g) => f2(f(g)) + (g.rep !== 1 ? ' ×' + g.rep : '')).join(' + ') + unit;
  const nTxt = N !== 1 ? ` × ${N} (Times)` : '';
  if (work) W(`${room.name}${room.desc ? ' — ' + room.desc : ''}${N !== 1 ? ' × ' + N : ''}`);
  if (work) W(`A (floor area, cut-outs off) = ${gs.length ? reps((g) => g.A) : '0.00'}${gs.length > 1 ? ' = ' + f2(A) : ''} m²`);
  if (work) W(`P (wall edges${openLen > EPS ? `; open edges ${f2(openLen)} m left out` : ''}) = ${gs.length ? reps((g) => g.P) : '0.00'}${gs.length > 1 ? ' = ' + f2(P) : ''} m`);

  // the room's doors and openings (on wall edges, with a size)
  const openings: RoomOpeningQ[] = [];
  for (const g of gs) for (const x of g.ops) {
    openings.push(x.q);
    if (x.q.onOpen) flags.add('doorOnOpen');
    else if (!x.w || !x.h) flags.add('noSize');
  }
  const counted = (x: OpenGeo) => !x.q.onOpen && !!x.w;
  const withArea = (x: OpenGeo) => counted(x) && !!x.h;
  const opName = (x: OpenGeo) => x.q.tag + (x.w ? ' ' + f2(x.w) + (x.h ? ' × ' + f2(x.h) : '') : '') + (x.q.k === 'open' && x.sill ? ' sill ' + f2(x.sill) : '');
  const parts = [...ctx.parts].sort((a, b) => (a.id < b.id ? -1 : 1));
  const adds = (cat: FinCat) => parts.filter((p) => p.rk === 'add' && p.cat === cat && !p.ak);
  /** v0.16.4 bulkheads and higher waterproofing upturns */
  const bulkheads = parts.filter((p) => p.rk === 'add' && p.ak === 'bh');
  const upturns = parts.filter((p) => p.rk === 'add' && p.ak === 'up');
  const links = (cat: FinCat) => parts.filter((p) => p.rk === 'link' && p.cat === cat);
  const finishes: RoomFinish[] = [];
  const push = (f: RoomFinish) => { if (f.raw < -EPS) { f.over = true; flags.add('over'); } finishes.push(f); return f; };
  const mk = (key: string, type: FinishType, cat: FinCat | null, role: RoomFinish['role'], name: string, code: string, unit: 'm²' | 'm' | 'nr', raw: number, src: string[], extra: Partial<RoomFinish> = {}): RoomFinish =>
    ({ key, type, cat, role, name, code, unit, qty: Math.max(0, raw), raw, over: false, src, ...extra });

  // --- v0.18 what is over each stretch of the walls: the false ceiling drawn over it (the lowest, where several
  // are), else the room's own ceiling when it is not the soffit and has a height, else none (the soffit)
  interface FcZone { iv: Iv[]; fc: number | null }
  const fcZones = new Map<Outline, FcZone[]>();
  if (zoned) {
    const drawn = parts.filter((p) => (p.rk === 'ceil' && !room.cs && room.cm === 'manual') || (p.rk === 'add' && p.cat === 'ceiling' && !p.ak))
      .map((p) => ({ p, lv: p.rk === 'ceil' ? p.lv ?? room.ch : p.lv }));
    const mainFc = !room.cs && room.cm === 'auto' && room.ch !== null && room.ch < H - EPS ? room.ch : null;
    // (a ceiling "on top" - not deducted - leaves the room's own ceiling in place under it: what is over the wall
    // there is the lower of the two)
    for (const c of drawn) if (c.p.rk === 'add' && !c.p.ded && mainFc !== null && (c.lv === null || c.lv > mainFc)) c.lv = mainFc;
    // (lowest first: what is seen from below)
    drawn.sort((a, b) => (a.lv ?? Infinity) - (b.lv ?? Infinity) || (a.p.id < b.p.id ? -1 : 1));
    if (!room.cs && room.cm === 'auto' && room.ch === null && room.cc) flags.add('ceilLevel');
    for (const c of drawn) {
      const polys = (m.shapesByItem.get(c.p.id) ?? []).filter((x) => x.k === 'poly');
      if (c.lv === null && (c.p.full || polys.length)) flags.add('ceilLevel');
      if (!c.p.full && polys.length && !polys.some((x) => gs.some((g) => g.s.dwg === x.dwg && g.s.pg === x.pg))) flags.add('ceilElsewhere');
    }
    for (const g of gs) {
      let rest = g.W;
      const zs: FcZone[] = [];
      for (const c of drawn) {
        if (!rest.length) break;
        let cov: Iv[] = [];
        if (c.p.full) cov = g.W;
        else { for (const x of m.shapesByItem.get(c.p.id) ?? []) cov.push(...coverOn(m, g, x)); cov = merge(cov); }
        const z = ivAnd(rest, cov);
        if (!z.length) continue;
        rest = ivSub(rest, cov);
        zs.push({ iv: z, fc: c.lv !== null && c.lv < H - EPS ? c.lv : null });
      }
      if (rest.length) zs.push({ iv: rest, fc: mainFc });
      fcZones.set(g, zs);
    }
  }
  /** where the wall finish stops over a stretch: a typed wall height; else the ceiling + FE, never above the soffit */
  const topOf = (fc: number | null) => (typedHw ? Hw : fc !== null ? Math.min(fc + FE, H) : H);
  interface Zone { iv: Iv[]; len: number; top: number; fc: number | null; full: boolean }
  /** an outline's wall edges by the height the wall finish stops at (one zone, the whole of it, for a room as before) */
  const wallZones = (g: Outline): Zone[] => {
    if (!zoned || typedHw) return [{ iv: g.W, len: g.P, top: Hw, fc: null, full: true }];
    const by = new Map<string, Zone>();
    for (const z of fcZones.get(g) ?? []) {
      const top = topOf(z.fc), k = top.toFixed(6) + (z.fc === null ? 'n' : 'c');
      const have = by.get(k);
      if (have) { have.iv = merge([...have.iv, ...z.iv]); have.len = ivLen(have.iv); }
      else by.set(k, { iv: z.iv, len: ivLen(z.iv), top, fc: z.fc, full: false });
    }
    return [...by.values()].sort((a, b) => a.top - b.top || (a.fc === null ? 1 : 0) - (b.fc === null ? 1 : 0));
  };
  /** how much of a door / opening stands in a stretch (0..1 of its width) */
  // (of the part of it on wall edges: one that runs over an open edge still comes off whole, as it always did)
  const share = (x: OpenGeo, iv: Iv[], g: Outline) => { const l = ivLen(ivAnd(x.iv, g.W)); return l > EPS ? ivLen(ivAnd(x.iv, iv)) / l : 0; };
  const zones: WallZone[] = [];
  if (zoned) {
    const by = new Map<string, WallZone>();
    for (const g of gs) for (const z of fcZones.get(g) ?? []) {
      const top = topOf(z.fc), k = top.toFixed(6) + '|' + (z.fc === null ? '' : z.fc.toFixed(6));
      const have = by.get(k);
      if (have) have.len += ivLen(z.iv) * g.rep; else by.set(k, { len: ivLen(z.iv) * g.rep, top, fc: z.fc });
    }
    zones.push(...[...by.values()].sort((a, b) => a.top - b.top || (a.fc ?? Infinity) - (b.fc ?? Infinity)));
  }

  // --- additional wall / skirting finishes: their stretches along each outline (union per part)
  interface Stretch { g: Outline; iv: Iv[] }
  const stretches = new Map<string, Stretch[]>();
  const free = new Map<string, number>(); // drawn off every outline: their plain length
  for (const p of [...adds('wall'), ...adds('skirting'), ...upturns]) {
    const byG = new Map<Outline, Iv[]>();
    let freeLen = 0;
    for (const ln of m.shapesByItem.get(p.id) ?? []) {
      if (ln.k !== 'line') continue;
      const g = outlineFor(gs, ln);
      if (!g) { flags.add('offOutline'); freeLen += shapeQtyAt(m, ln, null).len; continue; }
      const st = stretchOn(m, g, ln);
      if (st.off > 0.15) flags.add('offOutline');
      byG.set(g, merge([...(byG.get(g) ?? []), ...st.iv]));
    }
    // (open edges get no wall finish and no skirting: only the wall edges of the stretch count)
    stretches.set(p.id, [...byG].map(([g, iv]) => ({ g, iv: ivAnd(iv, g.W) })));
    free.set(p.id, freeLen);
  }

  // ---------------- floor
  /** an area drawn inside the room (additional floor / ceiling, manual ceiling); one not inside any outline is flagged */
  const inside = (s: Shape) => gs.some((g) => g.s.dwg === s.dwg && g.s.pg === s.pg && polyInside(s.flat, g.s.flat));
  const areaOf = (s: Shape): number => {
    const q = shapeQtyAt(m, s, null);
    if (!q.scaled) flags.add('unscaled');
    if (gs.length && !inside(s)) flags.add('outsideRoom');
    return q.area * s.m;
  };
  const addArea = (p: RoomPart): number => {
    if (p.full) return A;
    let a = 0;
    for (const s of m.shapesByItem.get(p.id) ?? []) if (s.k === 'poly') a += areaOf(s);
    return a;
  };
  /** what a linked take-off brings, at face value (its own Times, deductions and waste) */
  const linkQty = (p: RoomPart): { v: number; note?: string } => {
    const it = p.it, q = m.qty.get(it.id);
    if (!q) return { v: 0 };
    const isLine = it.kind === 'line' || it.kind === 'wall';
    if (it.kind === 'area' && p.cat !== 'skirting') return { v: q.area };
    if (isLine && p.cat === 'skirting') return { v: q.len };
    if (isLine && p.cat === 'wall') {
      if (p.rh) {
        // (v0.18 doors / openings on the length: off the linked height by their own height, not the whole of it)
        let v = q.len * p.rh;
        const k = (it.x || 1) * (1 + (it.waste || 0) / 100);
        for (const s of m.shapesByItem.get(it.id) ?? []) for (const o of m.openingsByShape.get(s.id) ?? []) {
          if (!o.ln) continue;
          const z = openingSize(m, o);
          if (!z.w) continue;
          const oh = z.h ? Math.min(z.h, p.rh) : p.rh;
          // (a length with no height had the door's width off its length: back on above the door; one with a height had nothing off its length)
          v += (it.h ? -z.w * oh : z.w * (p.rh - oh)) * s.m * k;
        }
        return { v: Math.max(0, v) };
      }
      if (it.h) return { v: q.area };
      return { v: 0, note: 'A length linked to Wall needs a height.' };
    }
    return { v: 0, note: 'This take-off cannot be linked to ' + CAT_NAME[p.cat] + '.' };
  };
  // its own code only: one without is kept out of the summary (fin.uncoded), never filed under the main's code
  const partCode = (p: RoomPart) => p.code;
  const timesDiffer: string[] = [];
  /** the additional finishes and linked take-offs of a category: their own figures, and what they take off the main */
  const extras = (cat: FinCat, own: (p: RoomPart) => number): { list: RoomFinish[]; dedSum: number; dedTxt: string[] } => {
    const list: RoomFinish[] = [];
    let dedSum = 0;
    const dedTxt: string[] = [];
    // floor / ceiling: deducted areas drawn over each other would take that area off the main twice - said, not hidden
    const dedAreas: { full: boolean; s: Shape[] }[] = [];
    const twice = (p: RoomPart): boolean => {
      if (!p.ded || (cat !== 'floor' && cat !== 'ceiling')) return false;
      // (v0.18.1 under a soffit a full-room false ceiling is what the drawn ones leave: no overlap with them)
      if (room.cs && cat === 'ceiling' && p.full) return false;
      const me = { full: p.full, s: p.full ? [] : (m.shapesByItem.get(p.id) ?? []).filter((x) => x.k === 'poly') };
      const hit = dedAreas.some((o) => (o.full && (me.full || me.s.length)) || (me.full && o.s.length) || o.s.some((a) => me.s.some((b) => a.dwg === b.dwg && a.pg === b.pg && polysOverlap(a.flat, b.flat))));
      dedAreas.push(me);
      return hit;
    };
    for (const p of adds(cat)) {
      const v = own(p) * N;
      const notDrawn = !p.full && !(m.shapesByItem.get(p.id) ?? []).length;
      if (notDrawn) flags.add('notDrawn');
      const dbl = twice(p);
      if (dbl) flags.add('addOverlap');
      const f = mk(p.id, CAT_TYPE[cat], cat, 'add', p.it.name, partCode(p), CAT_UNIT[cat], v, [room.id, p.id], { ded: p.ded, under: cat, note: notDrawn ? 'Not drawn yet.' : dbl ? (room.cs && cat === 'ceiling' ? 'Drawn over another false ceiling: both counted there (the soffit loses it once) - check which one is right.' : 'Drawn over another deducted finish: that area comes off the main twice.') : undefined });
      list.push(f);
      // (walls and skirting: what comes off the main is worked out from the stretches together below)
      if (p.ded && (cat === 'floor' || cat === 'ceiling')) { dedSum += v; if (work) dedTxt.push(`− ${p.it.name}${codeTxt(f.code)} (additional) ${f2(v)}`); }
    }
    for (const p of links(cat)) {
      const lq = linkQty(p);
      if (lq.note) flags.add('incompatible');
      // (at face value - its own Times: when that is not the room's, say so)
      const tx = p.it.x || 1;
      if (tx !== N) { timesDiffer.push(p.id); flags.add('timesDiffer'); }
      const note = lq.note ?? (tx !== N ? `Times differs from the room’s (×${N})` : undefined);
      const f = mk(p.id, CAT_TYPE[cat], cat, 'link', p.it.name, partCode(p), CAT_UNIT[cat], lq.v, [room.id, p.id], { ded: p.ded, under: p.under, note });
      list.push(f);
      if (p.ded) { dedSum += lq.v; if (work) dedTxt.push(`− ${p.it.name}${codeTxt(f.code)} (linked take-off) ${f2(lq.v)}`); }
    }
    return { list, dedSum, dedTxt };
  };
  const writeExtras = (list: RoomFinish[], how: (f: RoomFinish) => string, rel?: (f: RoomFinish) => string | null) => {
    if (!work) return;
    for (const f of list) W(`  ${f.role === 'add' ? '+' : '↳'} ${f.name}${codeTxt(f.code)} (${rel?.(f) ?? `${f.role === 'add' ? 'additional' : 'linked take-off'}, ${f.ded ? 'deducted from the main' : 'on top'}`}) = ${how(f)}${f.note ? ' — ' + f.note : ''}`);
  };

  {
    const ex = extras('floor', addArea);
    const raw = A * N - ex.dedSum;
    push(mk('floor', 'Floor', 'floor', 'main', 'Floor finish', room.fc, 'm²', raw, [room.id]));
    if (work) W(`Floor finish${codeTxt(room.fc)} = A ${f2(A)}${nTxt}${ex.dedTxt.length ? ' ' + ex.dedTxt.join(' ') : ''} = ${f2(Math.max(0, raw))} m²${raw < -EPS ? ' (deductions larger than the finish: 0)' : ''}`);
    writeExtras(ex.list, (f) => (parts.find((p) => p.id === f.key)?.full ? `full room area ${f2(A)}` : 'area drawn') + `${f.role === 'add' && N !== 1 ? nTxt : ''} = ${f2(f.qty)} m²`);
    ex.list.forEach(push);
  }

  // ---------------- wall finish
  // (no main wall finish set up: its additional finishes and linked take-offs still count - on their own)
  if (hasWall || adds('wall').length || links('wall').length) {
    if (hasWall && Hw <= 0) flags.add('noHeight');
    const addW = adds('wall');
    const lines: string[] = [];
    let gross = 0, doorDed = 0, loss = 0;
    const own = new Map<string, number>();
    const ownTxt = new Map<string, string>();
    // each deducted finish alone (for the working): its band inside the main band, and the openings already off there
    const alone = new Map<string, { band: number; doors: number }>();
    const zoneTxt: string[] = [];
    const replaced = new Set<string>();
    /** additional wall finishes going higher than where the wall finish stops over them (the lowest such top) */
    const aboveTop = new Map<string, number>();
    for (const g of gs) {
      for (const z of wallZones(g)) {
      const zb = hasWall ? Math.max(0, z.top - Hs) : 0;
      gross += z.len * zb * g.rep;
      if (work && !z.full) zoneTxt.push(`  ${z.fc !== null ? `under the ceiling at ${f2(z.fc)} (+ ${f2(FE)} above it${z.top < z.fc + FE - EPS ? ', stopped at the soffit' : ''})` : `no false ceiling (to the room height)`}: ${f2(z.len)} × (${f2(z.top)} − ${f2(Hs)}) = ${f2(z.len * zb)}${g.rep !== 1 ? ' ×' + g.rep : ''}`);
      for (const x of g.ops) {
        if (!withArea(x)) continue;
        const sh = z.full ? 1 : share(x, z.iv, g);
        if (sh <= EPS) continue;
        const ov = overlap(x.sill, x.sill + x.h!, Hs, z.top);
        doorDed += x.w! * sh * ov * g.rep;
        if (work) lines.push(`  − ${opName(x)}: ${f2(x.w! * sh)} × ${f2(ov)} = ${f2(x.w! * sh * ov)}${g.rep !== 1 ? ' ×' + g.rep : ''}`);
      }
      // the deducted additional finishes' bands inside the main band, less what their doors already took off
      const rects: Rect[] = [];
      for (const p of addW) {
        const st = stretches.get(p.id)?.find((x) => x.g === g);
        if (!st) continue;
        // (an area's own lengths are the plan edges it stands for - only while it does)
        if (p.wa && !p.wr) continue;
        const siv = z.full ? st.iv : ivAnd(st.iv, z.iv);
        if (!z.full && !siv.length) continue;
        // (v0.18) an elevation's area that stands for these plan edges: the wall finish is not taken there at all
        if (p.wa && p.wr) {
          if (!siv.length) continue;
          replaced.add(p.id);
          if (p.ded) {
            const r: Rect = { s: siv, z0: Hs, z1: z.top };
            rects.push(r);
            const al = alone.get(p.id) ?? { band: 0, doors: 0 };
            al.band += unionArea([r]) * g.rep;
            for (const x of g.ops) if (withArea(x)) al.doors += unionArea([r], { s: x.iv, z0: x.sill, z1: x.sill + x.h! }) * g.rep;
            alone.set(p.id, al);
          }
          continue;
        }
        const z0 = p.bl ?? Hs, hh = p.h ?? Math.max(0, z.top - z0), z1 = z0 + hh;
        // (v0.18.1 Feedback 3, C: finishes on a wall must stay within where the wall finish stops - said, not cut)
        if (!z.full && zoned && z1 > z.top + EPS && siv.length) aboveTop.set(p.id, Math.min(aboveTop.get(p.id) ?? Infinity, z.top));
        let a = ivLen(siv) * hh;
        for (const x of g.ops) if (withArea(x)) a -= ivLen(ivAnd(x.iv, siv)) * overlap(x.sill, x.sill + x.h!, z0, z1);
        own.set(p.id, (own.get(p.id) ?? 0) + a * g.rep);
        if (work) ownTxt.set(p.id, (ownTxt.has(p.id) ? ownTxt.get(p.id) + ' + ' : '') + `${f2(ivLen(siv))} × ${f2(hh)}${g.ops.some((x) => withArea(x) && ivLen(ivAnd(x.iv, siv)) > EPS) ? ' − openings on it' : ''}${g.rep !== 1 ? ' ×' + g.rep : ''}`);
        if (p.ded) {
          const r: Rect = { s: siv, z0: Math.max(z0, Hs), z1: Math.min(z1, z.top) };
          rects.push(r);
          const al = alone.get(p.id) ?? { band: 0, doors: 0 };
          al.band += unionArea([r]) * g.rep;
          for (const x of g.ops) if (withArea(x)) al.doors += unionArea([r], { s: x.iv, z0: x.sill, z1: x.sill + x.h! }) * g.rep;
          alone.set(p.id, al);
        }
      }
      if (rects.length) {
        let l = unionArea(rects);
        for (const x of g.ops) if (withArea(x)) l -= unionArea(rects, { s: x.iv, z0: x.sill, z1: x.sill + x.h! });
        loss += Math.max(0, l) * g.rep;
      }
      }
    }
    // (v0.16.5) drawn as an area (an elevation): that area as it is - deducted, all of it comes off the main
    for (const p of addW) {
      if (!p.wa) continue;
      let a = 0;
      const parts: string[] = [];
      for (const s of m.shapesByItem.get(p.id) ?? []) {
        if (s.k !== 'poly') continue;
        const q = shapeQtyAt(m, s, null);
        if (!q.scaled) flags.add('unscaled');
        a += q.area * s.m;
        parts.push(f2(q.area * s.m));
      }
      own.set(p.id, a);
      if (work) ownTxt.set(p.id, parts.length > 1 ? parts.join(' + ') + ' (areas drawn)' : (parts[0] ?? '0.00') + ' (area drawn)');
      // (v0.18 one that stands for its plan edges took the wall finish off there, above - not its area again)
      if (p.wr && !replaced.has(p.id)) flags.add('replNoEdge');
      if (p.ded && !replaced.has(p.id)) {
        loss += a;
        alone.set(p.id, { band: a, doors: 0 });
      }
    }
    // drawn off every outline: their plain length × height (no doors known), the part inside the band off the main
    for (const p of addW) {
      const fl = free.get(p.id) ?? 0;
      if (fl <= EPS) continue;
      const z0 = p.bl ?? Hs, hh = p.h ?? Math.max(0, Hw - z0);
      own.set(p.id, (own.get(p.id) ?? 0) + fl * hh);
      if (p.ded) {
        const b = fl * overlap(z0, z0 + hh, Hs, Hw);
        loss += b;
        const al = alone.get(p.id) ?? { band: 0, doors: 0 };
        al.band += b;
        alone.set(p.id, al);
      }
    }
    const ex = extras('wall', (p) => own.get(p.id) ?? 0);
    for (const x of ex.list) { const t = aboveTop.get(x.key); if (t !== undefined && !x.note) { x.note = `Goes higher than the wall finish over some of its walls (it stops at ${f2(t)} there): check its height.`; flags.add('aboveFinish'); } }
    const raw = (gross - doorDed - loss) * N - ex.dedSum;
    if (!hasWall) {
      if (work) W('Wall finish: none set up (no code, no height) - its additional finishes and linked take-offs count on their own');
      writeExtras(ex.list, (x) => (x.role === 'add' ? (ownTxt.get(x.key) ?? '0.00') + nTxt : 'its own quantity') + ` = ${f2(x.qty)} m²`);
      ex.list.forEach(push);
    } else {
    const f = push(mk('wall', 'Wall', 'wall', 'main', 'Wall finish', room.wc, 'm²', raw, [room.id]));
    if (work && !zoneTxt.length) W(`Wall finish${codeTxt(room.wc)} = P ${f2(P)} × (${f2(Hw)} − ${f2(Hs)}) = ${f2(gross)}`);
    if (work && zoneTxt.length) { W(`Wall finish${codeTxt(room.wc)}, by the ceiling over each stretch of wall (room height ${f2(H)}):`); zoneTxt.forEach((l) => W(l)); W(`  = ${f2(gross)}`); }
    if (work) lines.forEach((l) => W(l));
    if (work && alone.size) {
      if (lines.length) W(`  = ${f2(gross - doorDed)}`);
      let sumAlone = 0;
      for (const v of alone.values()) sumAlone += v.band - v.doors;
      if (Math.abs(sumAlone - loss) < 1e-6) {
        for (const p of addW) {
          const al = alone.get(p.id);
          if (!al) continue;
          if (work) W(`  − ${p.it.name}${codeTxt(partCode(p))} (${replaced.has(p.id) ? 'measured on its elevation: the wall it stands for' : 'additional, deducted'}) ${f2(al.band)}${al.doors > EPS ? ` less the openings already off there ${f2(al.doors)} = ${f2(al.band - al.doors)}` : ''}`);
        }
      } else W(`  − additional finishes deducted (where they overlap, counted once; less the openings already off there) ${f2(loss)}`);
    }
    if (N !== 1) W(`  = ${f2(gross - doorDed - loss)}${nTxt} = ${f2((gross - doorDed - loss) * N)}`);
    if (work) ex.dedTxt.forEach((t) => W('  ' + t));
    if (work) W(`  = ${f2(f.qty)} m²${f.over ? ' (deductions larger than the finish: 0)' : ''}`);
    writeExtras(ex.list, (x) => (x.role === 'add' ? (ownTxt.get(x.key) ?? '0.00') + nTxt : 'its own quantity') + ` = ${f2(x.qty)} m²`);
    ex.list.forEach(push);
    }
  }

  // ---------------- v0.18 plaster, and the walls above the finish (rooms with a Room height)
  if (zoned) {
    // plaster: every wall edge from the floor to the room height - or a typed height, or where the finish stops
    if (room.plc || room.php !== null || room.ppf) {
      let gross = 0, ded = 0;
      const lines: string[] = [];
      for (const g of gs) for (const z of wallZones(g)) {
        const top = room.ppf ? z.top : room.php ?? H;
        gross += z.len * top * g.rep;
        if (work && room.ppf && !z.full) lines.push(`  ${f2(z.len)} × ${f2(top)}${g.rep !== 1 ? ' ×' + g.rep : ''}`);
        for (const x of g.ops) {
          if (!withArea(x)) continue;
          const sh = z.full ? 1 : share(x, z.iv, g);
          const ov = overlap(x.sill, x.sill + x.h!, 0, top);
          if (sh <= EPS || ov <= EPS) continue;
          ded += x.w! * sh * ov * g.rep;
          if (work) lines.push(`  − ${opName(x)}: ${f2(x.w! * sh)} × ${f2(ov)} = ${f2(x.w! * sh * ov)}${g.rep !== 1 ? ' ×' + g.rep : ''}`);
        }
      }
      const f = push(mk('plaster', 'Plaster', null, 'main', 'Plaster', room.plc, 'm²', (gross - ded) * N, [room.id], { note: room.plc ? undefined : 'Plaster with no code: give it one.' }));
      if (work) {
        W(`Plaster${codeTxt(room.plc)} = ${room.ppf ? 'P × the height the wall finish stops at' : `P ${f2(P)} × ${f2(room.php ?? H)}${room.php === null ? ' (room height)' : ''}`} = ${f2(gross)}`);
        lines.forEach((l) => W(l));
        W(`  = ${f2(gross - ded)}${nTxt} = ${f2(f.qty)} m²`);
      }
    }
    // the walls above the finish, up to the soffit - only where a false ceiling is (anti-fungal paint…)
    if (!room.bn) {
      let gross = 0, ded = 0;
      const lines: string[] = [];
      for (const g of gs) for (const z of fcZones.get(g) ?? []) {
        if (z.fc === null) continue;
        const from = Math.min(topOf(z.fc), H), bh = H - from, len = ivLen(z.iv);
        if (bh <= EPS || len <= EPS) continue;
        gross += len * bh * g.rep;
        if (work) lines.push(`  above the ceiling at ${f2(z.fc)}: ${f2(len)} × (${f2(H)} − ${f2(from)}) = ${f2(len * bh)}${g.rep !== 1 ? ' ×' + g.rep : ''}`);
        for (const x of g.ops) {
          if (!withArea(x)) continue;
          const sh = share(x, z.iv, g), ov = overlap(x.sill, x.sill + x.h!, from, H);
          if (sh <= EPS || ov <= EPS) continue;
          ded += x.w! * sh * ov * g.rep;
          if (work) lines.push(`  − ${opName(x)}: ${f2(x.w! * sh)} × ${f2(ov)} = ${f2(x.w! * sh * ov)}${g.rep !== 1 ? ' ×' + g.rep : ''}`);
        }
      }
      if (gross > EPS) {
        const f = push(mk('band', 'Above ceiling', null, 'main', 'Walls above false ceiling', room.bc, 'm²', (gross - ded) * N, [room.id], { note: room.bc ? undefined : 'No code for the walls above the false ceiling: give one (anti-fungal paint…) or say nothing goes there.' }));
        if (work) {
          W(`Walls above false ceiling${codeTxt(room.bc)} (from where the wall finish stops, up to the soffit):`);
          lines.forEach((l) => W(l));
          W(`  = ${f2(gross - ded)}${nTxt} = ${f2(f.qty)} m²`);
        }
      }
    }
  }

  // ---------------- skirting
  if (hasSkirt || adds('skirting').length || links('skirting').length) {
    const floorLevel = (x: OpenGeo, top: number) => counted(x) && (x.sill <= EPS || x.sill < top - EPS);
    const addK = adds('skirting');
    const lines: string[] = [];
    let ded = 0, loss = 0;
    const own = new Map<string, number>();
    const ownTxt = new Map<string, string>();
    for (const g of gs) {
      for (const x of g.ops) {
        if (!floorLevel(x, Hs)) continue;
        ded += x.w! * g.rep;
        if (work) lines.push(`− ${x.q.tag} ${f2(x.w!)}${g.rep !== 1 ? ' ×' + g.rep : ''}`);
      }
      const U: Iv[] = [];
      for (const p of addK) {
        const st = stretches.get(p.id)?.find((x) => x.g === g);
        if (!st) continue;
        const top = p.h ?? Hs;
        let l = ivLen(st.iv);
        for (const x of g.ops) if (floorLevel(x, top)) l -= ivLen(ivAnd(x.iv, st.iv));
        own.set(p.id, (own.get(p.id) ?? 0) + l * g.rep);
        if (work) ownTxt.set(p.id, (ownTxt.has(p.id) ? ownTxt.get(p.id) + ' + ' : '') + `${f2(ivLen(st.iv))}${g.ops.some((x) => floorLevel(x, top) && ivLen(ivAnd(x.iv, st.iv)) > EPS) ? ' − doors on it' : ''}${g.rep !== 1 ? ' ×' + g.rep : ''}`);
        if (p.ded) U.push(...st.iv);
      }
      if (U.length) {
        const u = merge(U);
        let l = ivLen(u);
        for (const x of g.ops) if (floorLevel(x, Hs)) l -= ivLen(ivAnd(x.iv, u));
        loss += Math.max(0, l) * g.rep;
      }
    }
    for (const p of addK) { const fl = free.get(p.id) ?? 0; if (fl > EPS) { own.set(p.id, (own.get(p.id) ?? 0) + fl); if (p.ded) loss += fl; } }
    const ex = extras('skirting', (p) => own.get(p.id) ?? 0);
    const raw = (P - ded - loss) * N - ex.dedSum;
    if (!hasSkirt) {
      if (work) W('Skirting: none set up (no code, no height) - its additional skirting and linked take-offs count on their own');
      writeExtras(ex.list, (x) => (x.role === 'add' ? (ownTxt.get(x.key) ?? '0.00') + nTxt : 'its own quantity') + ` = ${f2(x.qty)} m`);
      ex.list.forEach(push);
    } else {
    const f = push(mk('skirting', 'Skirting', 'skirting', 'main', 'Skirting', room.kc, 'm', raw, [room.id]));
    if (work) W(`Skirting${codeTxt(room.kc)}${Hs ? ' (height ' + f2(Hs) + ')' : ''} = P ${f2(P)} ${lines.join(' ')}${loss > EPS ? ' − additional skirting deducted ' + f2(loss) : ''}${nTxt}${ex.dedTxt.length ? ' ' + ex.dedTxt.join(' ') : ''} = ${f2(f.qty)} m${f.over ? ' (deductions larger than the finish: 0)' : ''}`);
    writeExtras(ex.list, (x) => (x.role === 'add' ? (ownTxt.get(x.key) ?? '0.00') + nTxt : 'its own quantity') + ` = ${f2(x.qty)} m`);
    ex.list.forEach(push);
    }
  }

  // ---------------- ceiling (+ shadow gap, bulkheads)
  const ceilCheck = { covered: A, A, equal: true, noted: '' };
  {
    const ceils = parts.filter((p) => p.rk === 'ceil');
    const addC = adds('ceiling');
    let base = A;
    let ex: { list: RoomFinish[]; dedSum: number; dedTxt: string[] };
    let raw: number;
    let f: RoomFinish;
    if (room.cs) {
      // v0.16.4 the soffit (the slab's underside): what no other ceiling of the room covers - a false ceiling
      // under it hides it (no paint above one, unless "finish above" says so: its own line below)
      // v0.18.1 (Nabil, 11 Nov: soffit first) the false ceilings drawn cover their union (over each other: once, and
      // flagged); a full-room false ceiling is what the drawn ones leave of the room - all of it covered then
      // (v0.18.3 a false ceiling set above the room height can't be under the soffit: flagged, not measured, and the
      // soffit stays - BUG-003)
      const H0 = room.rmh ?? 0;
      const aboveSoffit = (p: RoomPart) => H0 > 0 && p.lv !== null && p.lv > H0 + EPS;
      const underC = addC.filter((p) => !aboveSoffit(p));
      if (underC.length < addC.length) flags.add('fcAbove');
      const fulls = underC.filter((p) => p.full), drawnFc = underC.filter((p) => !p.full);
      const drawnShapes = drawnFc.flatMap((p) => (m.shapesByItem.get(p.id) ?? []).filter((x) => x.k === 'poly'));
      const drawnCov = Math.min(A, planUnionArea(drawnShapes, areaOf));
      if (fulls.length > 1) flags.add('twoFull');
      // (a take-off linked to the ceiling, deducted: a ceiling of its own there - off the full-room false ceiling when
      // there is one, else off the soffit; at face value, for one room: ÷ its Times)
      const linkDed0 = links('ceiling').filter((p) => p.ded).reduce((t, p) => t + linkQty(p).v, 0);
      const fcArea = (p: RoomPart) => (aboveSoffit(p) ? 0 : p.full ? Math.max(0, A - drawnCov - linkDed0 / (N || 1)) : addArea(p));
      const covered = fulls.length ? A : drawnCov;
      base = A - covered;
      ex = extras('ceiling', fcArea);
      const linkDed = fulls.length ? 0 : ex.list.filter((x) => x.role === 'link' && x.ded).reduce((t, x) => t + x.qty, 0);
      ex.dedSum = 0;
      raw = base * N - linkDed;
      // (Nabil: the soffit's finish is a BOQ item of its own - "PT-05 (SFT)", apart from a ceiling's PT-05)
      f = push(mk('ceiling', 'Ceiling', 'ceiling', 'main', room.cc ? 'Soffit finish' : 'Soffit (no finish)', wpCode(room.cc, 'SFT'), 'm²', raw, [room.id]));
      if (!room.cc) f.note = f.qty > EPS ? 'The soffit needs its code (it has m² no false ceiling covers).' : 'All under false ceilings: no soffit finish.';
      if (!room.cc && f.qty > EPS) flags.add('soffitCode');
      if (!((room.rmh ?? 0) > 0) && gs.length) flags.add('noRoomHeight');
      if (work) W(`Soffit${codeTxt(wpCode(room.cc, 'SFT'))} = A ${f2(A)}${covered > EPS ? ` − the false ceilings under it ${fulls.length ? '(full room) ' : ''}${f2(covered)}` : ''} = ${f2(base)}${nTxt}${linkDed > EPS ? ` − linked ceilings ${f2(linkDed)}` : ''} = ${f2(f.qty)} m²${f.over ? ' (the ceilings under it are larger than the room: 0)' : ''}`);
      writeExtras(ex.list.map((x) => (x.role === 'add' ? { ...x, ded: false } : x)), (x) => (parts.find((p) => p.id === x.key)?.full ? `full room area ${f2(A)}${drawnCov > EPS ? ` − the false ceilings drawn ${f2(drawnCov)}` : ''}${linkDed0 > EPS ? ` − linked ceilings ${f2(linkDed0 / (N || 1))}` : ''}` : 'area drawn') + `${x.role === 'add' && N !== 1 ? nTxt : ''} = ${f2(x.qty)} m²`,
        (x) => (x.role === 'add' ? 'false ceiling under the soffit' : null));
      ex.list.forEach(push);
      // the soffit above a ceiling finished all the same (anti-fungal paint over a false ceiling...)
      for (const p of addC) {
        if (!p.fa) continue;
        const v = fcArea(p) * N;
        const fa = push(mk(p.id + '>above', 'Ceiling', 'ceiling', 'add', 'Soffit above ' + p.it.name, wpCode(p.fac, 'SFT'), 'm²', v, [room.id, p.id], { under: p.id, ded: false, note: p.fac ? undefined : 'Finish above with no code: give it one.' }));
        if (work) W(`  + soffit above ${p.it.name}${codeTxt(wpCode(p.fac, 'SFT'))} = ${f2(fa.qty)} m²`);
      }
    } else {
      if (room.cm === 'manual') {
        base = 0;
        for (const p of ceils) for (const s of m.shapesByItem.get(p.id) ?? []) if (s.k === 'poly') base += areaOf(s);
        if (!ceils.some((p) => (m.shapesByItem.get(p.id) ?? []).length)) flags.add('notDrawn');
      }
      ex = extras('ceiling', addArea);
      raw = base * N - ex.dedSum;
      f = push(mk('ceiling', 'Ceiling', 'ceiling', 'main', 'Ceiling finish', room.cc, 'm²', raw, [room.id, ...ceils.map((p) => p.id)]));
      if (work) W(`Ceiling finish${codeTxt(room.cc)} (${room.cm === 'manual' ? 'manual: areas drawn' : 'auto: = A'}) ${f2(base)}${nTxt}${ex.dedTxt.length ? ' ' + ex.dedTxt.join(' ') : ''} = ${f2(f.qty)} m²${f.over ? ' (deductions larger than the finish: 0)' : ''}`);
      writeExtras(ex.list, (x) => (parts.find((p) => p.id === x.key)?.full ? `full room area ${f2(A)}` : 'area drawn') + `${x.role === 'add' && N !== 1 ? nTxt : ''} = ${f2(x.qty)} m²`);
      ex.list.forEach(push);
      // v0.16.4 the ceilings should cover the floor: drawn by hand (manual), they may not - said until a note says why
      if (room.cm === 'manual' && gs.length) {
        // (every ceiling of the room: the main one as drawn - a deducted additional ceiling is inside it - and
        // the additional / linked ceilings counted on top of it)
        let tot = base;
        for (const x of ex.list) {
          if (x.ded) continue;
          const pp = x.role === 'add' ? parts.find((p) => p.id === x.key) : null;
          tot += pp ? addArea(pp) : x.qty / (N || 1);
        }
        const key = `${f2(tot)}|${f2(A)}`;
        ceilCheck.covered = tot;
        if (Math.abs(tot - A) > Math.max(0.01, A * 0.001)) {
          ceilCheck.equal = false;
          if (room.cnn && room.cnv === key) { ceilCheck.noted = room.cnn; flags.add('ceilNoted'); } else flags.add('ceilFloor');
          if (work) W(`  Ceilings ${f2(tot)} m² ≠ floor ${f2(A)} m²${ceilCheck.noted ? ' — noted: ' + ceilCheck.noted : ''}`);
        }
      }
    }
    if (room.gm) {
      let L = 0;
      // (v0.18.1 Nabil, 11 Nov: "entire perimeter should not count the edges that are not snapped to the room edges;
      // free edges do not have a shadow gap by default") - where a ceiling meets the walls: all of them under the room's
      // own ceiling (auto, not the soffit); else only the stretches of wall under the ceilings drawn
      if (room.gm === 'all' && !room.cs && room.cm === 'auto') L = P;
      else if (room.gm === 'all') {
        const drawnC = parts.filter((p) => (p.rk === 'ceil' && room.cm === 'manual' && !room.cs) || (p.rk === 'add' && p.cat === 'ceiling' && !p.ak));
        for (const g of gs) {
          let cov: Iv[] = [];
          for (const p of drawnC) {
            if (p.full) { cov = g.W; break; }
            for (const sh of m.shapesByItem.get(p.id) ?? []) cov.push(...coverOn(m, g, sh));
          }
          L += ivLen(ivAnd(merge(cov), g.W)) * g.rep;
        }
      } else {
        for (const g of gs) g.lens.forEach((l, i) => { if (g.gap[i]) L += l * g.rep; });
        // ceiling edges: the manual ceiling areas and the additional ceilings
        for (const p of [...ceils, ...adds('ceiling')]) for (const s of m.shapesByItem.get(p.id) ?? []) {
          if (s.k !== 'poly' || !s.sg.some((t) => edgeFlags(t).gap)) continue;
          const sl = segLensAt(m, s);
          sl.lens.forEach((l, i) => { if (l !== null && edgeFlags(s.sg[i]).gap) L += l * s.m; });
        }
      }
      push(mk('gap', 'Shadow gap', null, 'main', 'Shadow gap', room.gc, 'm', L * N, [room.id], { under: 'ceiling' }));
      if (work) W(`Shadow gap${codeTxt(room.gc)} (${room.gm === 'all' ? (!room.cs && room.cm === 'auto' ? 'entire perimeter = P' : 'all round, where the ceilings drawn meet the walls') : 'edges picked'}) = ${f2(L)}${nTxt} = ${f2(L * N)} m`);
    }

    // v0.16.4 bulkheads: running metres, one line each, its drop in its code (each drop has its own rate)
    for (const p of bulkheads) {
      let len = 0;
      for (const s of m.shapesByItem.get(p.id) ?? []) {
        if (s.k !== 'line') continue;
        const q = shapeQtyAt(m, s, null);
        if (!q.scaled) flags.add('unscaled');
        len += q.len * s.m;
      }
      const up = p.bp ? parts.find((x) => x.id === p.bp && (x.rk === 'ceil' || (x.rk === 'add' && x.cat === 'ceiling' && !x.ak))) ?? null : null;
      // (the ceiling it hung from was removed: said - never quietly under another one)
      const lost = !!p.bp && !up;
      const level = up ? (up.rk === 'ceil' ? up.lv ?? mainLevel(room) : up.lv) : mainLevel(room);
      const upCode = up ? (up.rk === 'ceil' ? room.cc : up.code) : room.cc;
      const upName = up ? (up.rk === 'ceil' ? 'the ceiling' : up.it.name) : room.cs ? 'the soffit' : 'the ceiling';
      // (v0.16.5 its underside: the ceiling whose edge it runs along - unless given)
      const along = bulkheadUnderside(m, room, parts, p);
      const auto = p.bh === null ? along : null;
      const under = p.bh ?? auto?.h ?? null;
      const drop = level !== null && under !== null ? level - under : null;
      const mm = drop !== null ? Math.round(drop * 1000) : 0;
      let note: string | undefined;
      if (lost) note = 'The ceiling it hangs from was removed: pick the ceiling it is under.';
      else if (drop === null) note = level === null ? `The height of ${upName} is not set: the drop is not known.` : 'Not along a ceiling with a height: give its underside height (the drop is not known).';
      else if (auto?.mixed) note = 'It runs along ceilings of different heights: make a bulkhead for each drop.';
      else if (mm <= 0) note = `It is not below ${upName}.`;
      if (note) flags.add('bhHeight');
      if (!(m.shapesByItem.get(p.id) ?? []).length) { flags.add('notDrawn'); note = note ?? 'Not drawn yet.'; }
      // (its own code if it has one - an exposed soffit has none - else the ceiling's; the drop always in it)
      // (v0.16.5 its underside taken from a ceiling's edge: that ceiling's finish - a false ceiling's bulkhead is its board,
      // not the soffit's. An underside typed keeps the top's, as in 0.16.4: a 0.16.4 bulkhead - its underside always
      // typed - keeps its code, and the Finishes Summary links made on it)
      const bcode = p.code || auto?.code || upCode;
      const code = !note && bcode ? `${bcode} (bulkhead ${mm} mm)` : '';
      const name = p.it.name + (mm > 0 && drop !== null ? ` — ${mm} mm drop` : '');
      const b = push(mk(p.id, 'Bulkhead', 'ceiling', 'add', name, code, 'm', len * N, [room.id, p.id], { under: 'ceiling', note }));
      if (work) W(`  + ${name}${codeTxt(code)} (under ${upName}${level !== null ? ' at ' + f2(level) : ''}, underside ${under !== null ? f2(under) + (p.bh === null && auto ? ' - ' + auto.name : '') : '?'}) = ${f2(len)}${nTxt} = ${f2(b.qty)} m${note ? ' — ' + note : ''}`);
    }
  }

  // ---------------- waterproofing (horizontal and vertical never added together)
  if (room.pm || upturns.length) {
    // (v0.16.4 Nabil: horizontal and vertical go to separate BOQ items: every waterproofing code says which it is -
    // "WP-01 (horizontal)", "WP-01 (vertical)" - the same in every room, so each has its row in the Finishes Summary;
    // a link made on the bare code before still covers them: finishes.ts covers / base)
    const hc = wpCode(room.phc || room.pc, 'horizontal'), vc = wpCode(room.pvc || room.pc, 'vertical');
    if (room.pm) {
      push(mk('wph', 'Horizontal WP', null, 'main', 'Waterproofing horizontal', hc, 'm²', A * N, [room.id]));
      if (work) W(`Waterproofing horizontal${codeTxt(hc)} = A ${f2(A)}${nTxt} = ${f2(A * N)} m²`);
    }
    // (v0.18 "full wall height" with no level typed, in a room measured by its ceilings: as high as the wall finish
    // goes - over several ceilings, their heights by the length of wall under each)
    let fullH = Hw;
    if (zoned && !typedHw && room.pm === 'full' && room.pl === null) {
      let a = 0, l = 0;
      for (const g of gs) for (const z of wallZones(g)) { a += z.len * z.top * g.rep; l += z.len * g.rep; }
      if (l > EPS) fullH = a / l;
    }
    const L = !room.pm ? 0 : room.pm === 'up' ? room.pu ?? 0 : room.pl ?? fullH;
    if (room.pm && L <= 0) flags.add('noHeight');
    let v = 0, loss = 0;
    const lines: string[] = [];
    // v0.16.4 higher upturns (showers, a cistern tank's walls): each its own height along its stretch, in place of
    // the room's upturn there (that stretch comes off the main, less the openings already off it)
    const own = new Map<string, number>();
    const ownTxt = new Map<string, string>();
    for (const g of gs) {
      v += g.P * L * g.rep;
      for (const x of g.ops) {
        if (!withArea(x)) continue;
        const ov = overlap(x.sill, x.sill + x.h!, 0, L);
        v -= x.w! * ov * g.rep;
        if (work && ov > EPS) lines.push(`− ${opName(x)}: ${f2(x.w!)} × ${f2(ov)} = ${f2(x.w! * ov)}${g.rep !== 1 ? ' ×' + g.rep : ''}`);
      }
      const U: Iv[] = [];
      for (const p of upturns) {
        const st = stretches.get(p.id)?.find((x) => x.g === g);
        if (!st) continue;
        const hu = p.h ?? 0;
        let a = ivLen(st.iv) * hu;
        for (const x of g.ops) if (withArea(x)) a -= ivLen(ivAnd(x.iv, st.iv)) * overlap(x.sill, x.sill + x.h!, 0, hu);
        own.set(p.id, (own.get(p.id) ?? 0) + a * g.rep);
        if (work) ownTxt.set(p.id, (ownTxt.has(p.id) ? ownTxt.get(p.id) + ' + ' : '') + `${f2(ivLen(st.iv))} × ${f2(hu)}${g.ops.some((x) => withArea(x) && ivLen(ivAnd(x.iv, st.iv)) > EPS) ? ' − openings on it' : ''}${g.rep !== 1 ? ' ×' + g.rep : ''}`);
        U.push(...st.iv);
      }
      if (U.length && L > 0) {
        const u = merge(U);
        let l = ivLen(u) * L;
        for (const x of g.ops) if (withArea(x)) l -= ivLen(ivAnd(x.iv, u)) * overlap(x.sill, x.sill + x.h!, 0, L);
        loss += Math.max(0, l) * g.rep;
      }
    }
    for (const p of upturns) {
      const fl = free.get(p.id) ?? 0;
      if (fl > EPS) { own.set(p.id, (own.get(p.id) ?? 0) + fl * (p.h ?? 0)); loss += fl * L; }
    }
    if (room.pm) {
      const f = push(mk('wpv', 'Vertical WP', null, 'main', 'Waterproofing vertical', vc, 'm²', (v - loss) * N, [room.id]));
      if (work) W(`Waterproofing vertical${codeTxt(vc)} (${room.pm === 'up' ? 'floor with upturn ' + f2(L) : 'full wall height to ' + f2(L)}) = P ${f2(P)} × ${f2(L)} = ${f2(P * L)} ${lines.join(' ')}${loss > EPS ? ' − higher upturns\' stretches ' + f2(loss) : ''}${nTxt} = ${f2(f.qty)} m²${f.over ? ' (deductions larger than the finish: 0)' : ''}`);
    } else if (work) W('Waterproofing: none set up - its higher upturns count on their own');
    for (const p of upturns) {
      const hu = p.h ?? 0;
      const notDrawn = !(m.shapesByItem.get(p.id) ?? []).length;
      if (notDrawn) flags.add('notDrawn');
      if (hu <= 0) flags.add('noHeight');
      const code = p.code ? wpCode(p.code, 'vertical') : vc;
      const x = push(mk(p.id, 'Vertical WP', null, 'add', p.it.name + (hu > 0 ? ` — upturn ${f2(hu)} m` : ''), code, 'm²', (own.get(p.id) ?? 0) * N, [room.id, p.id], { under: 'wpv', ded: true, note: notDrawn ? 'Not drawn yet.' : hu <= 0 ? 'Its height is not set.' : undefined }));
      if (work) W(`  + ${x.name}${codeTxt(code)} (higher upturn, in place of the room's there) = ${ownTxt.get(p.id) ?? '0.00'}${nTxt} = ${f2(x.qty)} m²`);
    }
  }
  // ---------------- v0.18 miscellaneous items (kitchen cabinets, wardrobes, vanities, mirrors…): as drawn - or typed
  for (const p of parts) {
    if (p.ak !== 'misc') continue;
    const q = m.qty.get(p.id);
    // (v0.18.1 Feedback 3, F: a length with a height is reported in m - the height kept with it - and its m² too)
    const withH = p.mu === 'm' && (p.h ?? 0) > 0;
    // (a length's own measure is the length; the line's own height must not turn it into an area)
    const drawn = !q ? 0 : p.mu === 'nr' ? q.cnt : p.mu === 'm' ? q.len : q.area;
    // (a typed quantity of a length with a height is its area, m² - as it was typed in 0.18.0: the length = that ÷ h)
    const v = (p.mq !== null && withH ? p.mq / p.h! : p.mq ?? drawn) * N;
    const none = p.mq === null && !(m.shapesByItem.get(p.id) ?? []).length;
    if (q && q.unscaled && p.mq === null && p.mu !== 'nr') flags.add('unscaled');
    const unit = p.mu === 'nr' ? 'nr' : p.mu === 'm' ? 'm' : 'm²';
    const f = push(mk(p.id, 'Miscellaneous', null, 'add', p.it.name, p.code, unit, v, [room.id, p.id], { under: 'misc', ded: false, fin: p.mf || undefined, note: none ? 'Not measured yet: draw it, or type its quantity.' : undefined }));
    if (work) W(`Miscellaneous: ${p.it.name}${codeTxt(p.code)}${p.mf ? ' (' + p.mf + ')' : ''} = ${p.mq !== null ? (withH ? `typed ${f2(p.mq)} m² ÷ ${f2(p.h!)}` : 'typed ' + f2(p.mq)) : p.mu === 'nr' ? `${q?.cnt ?? 0} counted` : f2(drawn) + ' drawn'}${nTxt} = ${p.mu === 'nr' ? String(Math.round(f.qty * 100) / 100) : f2(f.qty)} ${unit}${withH ? ` (${f2(p.h!)} high)` : ''}`);
    if (withH) {
      const fa = push(mk(p.id + '>area', 'Miscellaneous', null, 'add', p.it.name, p.code, 'm²', f.qty * p.h!, [room.id, p.id], { under: p.id, ded: false, fin: p.mf || undefined }));
      if (work) W(`  its area: ${f2(f.qty)} × ${f2(p.h!)} = ${f2(fa.qty)} m²`);
    }
  }

  const byKey = new Map(finishes.map((f) => [f.key, f]));
  if (work && flags.has('over')) W('Flagged: deductions larger than the finish (shown as 0).');
  timesDiffer.sort();
  return { id: room.id, A, P, open: openLen, N, finishes, byKey, openings, timesDiffer, ceil: ceilCheck, zones, flags: [...flags].sort() };
}

/** a room's finishes as the take-off tree shows them (UI-TREE "Room"): each main finish with its additional
 *  finishes and linked take-offs under it (a take-off linked to an additional finish under that one) */
export interface FinishNode { f: RoomFinish; children: FinishNode[] }
export interface RoomTree {
  floor: FinishNode;
  wall: FinishNode | null;
  skirting: FinishNode | null;
  /** the shadow gap is one of the ceiling's children (key 'gap') */
  ceiling: FinishNode;
  /** horizontal and vertical waterproofing (null = off) */
  wp: { h: FinishNode; v: FinishNode } | null;
  /** v0.18 plaster, the walls above the false ceiling, the miscellaneous items */
  plaster: FinishNode | null;
  band: FinishNode | null;
  misc: FinishNode[];
}
export function roomTree(q: RoomQty): RoomTree {
  const node = (f: RoomFinish): FinishNode => ({ f, children: [] });
  const nodes = new Map(q.finishes.map((f) => [f.key, node(f)]));
  // (wall / skirting not set up but with additional / linked ones: an empty main to show them under)
  for (const c of ['wall', 'skirting'] as const) {
    if (nodes.has(c) || !q.finishes.some((f) => f.cat === c)) continue;
    nodes.set(c, node({ key: c, type: CAT_TYPE[c], cat: c, role: 'main', name: CAT_NAME[c], code: '', unit: CAT_UNIT[c], qty: 0, raw: 0, over: false, src: [q.id], none: true }));
  }
  for (const f of q.finishes) {
    if (f.role === 'main' && f.key !== 'gap') continue;
    const up = nodes.get(f.under && nodes.has(f.under) ? f.under : f.cat ?? '');
    if (up && up !== nodes.get(f.key)) up.children.push(nodes.get(f.key)!);
  }
  // (v0.16.4 higher upturns with no waterproofing set up: empty mains to show them under)
  if (!nodes.has('wpv') && q.finishes.some((f) => f.under === 'wpv')) {
    for (const [k, t, n] of [['wph', 'Horizontal WP', 'Waterproofing horizontal'], ['wpv', 'Vertical WP', 'Waterproofing vertical']] as const) {
      nodes.set(k, node({ key: k, type: t, cat: null, role: 'main', name: n, code: '', unit: 'm²', qty: 0, raw: 0, over: false, src: [q.id], none: true }));
    }
    const v = nodes.get('wpv')!;
    for (const f of q.finishes) if (f.under === 'wpv') v.children.push(nodes.get(f.key)!);
  }
  const wph = nodes.get('wph'), wpv = nodes.get('wpv');
  return { floor: nodes.get('floor')!, wall: nodes.get('wall') ?? null, skirting: nodes.get('skirting') ?? null, ceiling: nodes.get('ceiling')!, wp: wph && wpv ? { h: wph, v: wpv } : null,
    plaster: nodes.get('plaster') ?? null, band: nodes.get('band') ?? null, misc: q.finishes.filter((f) => f.type === 'Miscellaneous' && f.under === 'misc').map((f) => nodes.get(f.key)!) };
}

/** "Show working": the arithmetic of a room, line by line (the UI shows it as is) */
export function roomWorking(m: QtoModel, roomId: string): string[] {
  const room = m.fin.roomById.get(roomId);
  if (!room) return [];
  const out: string[] = [];
  roomQty({ m, room, parts: m.fin.partsByRoom.get(roomId) ?? [] }, out);
  return out;
}

