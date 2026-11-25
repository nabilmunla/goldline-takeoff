// Changes to a take-off project, as journal ops.
import { generateKeyBetween } from 'fractional-indexing';
import { randomId } from '../ids';
import { crc32hex } from '../crc32';
import { ID_SALT } from '../legacy';
import type { Op } from '../types';
import { toFlat, hasArcs, splitArc, dist, type Pt } from './geometry';
import { ITEM_COLORS, nearestSeg, doorTagKey, SK_KIND, tagOwn, withTagOwn, type SegOwn, type StructKind, type Kind, type QtoModel, type Shape, type ShapeKind, type Measure, type Opening } from './model';
import type { Template } from './templates';
import { endOf, headingForGroup } from './headings';
import { deleteRoomOps, duplicateRoomOps } from './roomops';

const J = (v: unknown) => JSON.stringify(v);

export function nextColor(m: QtoModel): string {
  const used = new Map<string, number>();
  for (const it of m.items) used.set(it.color, (used.get(it.color) ?? 0) + 1);
  return [...ITEM_COLORS].sort((a, b) => (used.get(a) ?? 0) - (used.get(b) ?? 0))[0];
}

/**
 * A new take-off item, at the end of heading `par`. Without a heading, a typical
 * (template) one goes under the heading named after its group.
 */
/** v0.17 a new structural take-off (slab, drop panel, columns, shear wall): its base kind with `sk`, named for it */
const SK_NAME: Record<Exclude<StructKind, ''>, string> = { slab: 'Slab', drop: 'Drop panels', col: 'Columns', shear: 'Core walls', sw: 'Shear walls', ftg: 'Footings', raft: 'Raft', stair: 'Stair', sog: 'Slab on grade', rw: 'Retaining walls' };
export function newStructOps(m: QtoModel, owner: string, sk: Exclude<StructKind, ''>, par = ''): { id: string; ops: Op[] } {
  const r = newItemOps(m, owner, SK_KIND[sk], undefined, par);
  const n = m.items.filter((i) => i.sk === sk).length + 1;
  for (const o of r.ops) if (o[0] === r.id && o[1] === 'name') o[2] = SK_NAME[sk] + ' ' + n;
  r.ops.push([r.id, 'sk', sk]);
  // (v0.18.1 a new slab: its soffit less the drop panels and beams under it - existing slabs keep their figures)
  if (sk === 'slab') r.ops.push([r.id, 'fdx', true]);
  // (a slab's / shear wall's / column's concrete counts every opening and hole: nothing left in)
  return r;
}
/** v0.17 a column type / shear wall type (as beamTypeOps): ct: / wt: */
export function memberTypeOps(pre: 'bt' | 'ct' | 'wt' | 'st' | 'ft' | 'rt' | 'sy', t: { name: string; w: number | null; d: number | null; r: number | null; color: string; round?: boolean; t?: number | null; tr?: number | null; ri?: number | null }, id = pre + ':' + randomId(8)): { id: string; ops: Op[] } {
  const ops: Op[] = [[id, 'name', t.name.trim()], [id, 'w', t.w], [id, 'd', t.d], [id, 'r', t.r], [id, 'color', t.color], [id, 'del', null]];
  if (pre === 'ct') ops.push([id, 'round', t.round ? true : null]);
  // (v0.18 a footing type: its depth)
  if (pre === 'ft' || pre === 'sy') ops.push([id, 't', t.t ?? null]);
  // (v0.18.1 a stair type: tread and riser)
  if (pre === 'sy') ops.push([id, 'tr', t.tr ?? null], [id, 'ri', t.ri ?? null]);
  return { id, ops };
}

export function newItemOps(m: QtoModel, owner: string, kind: Kind, t?: Template, par = ''): { id: string; ops: Op[] } {
  const id = 'ti:' + randomId(10);
  const ops: Op[] = [];
  if (!par && t?.group) {
    const h = headingForGroup(m, t.group);
    ops.push(...h.ops);
    par = h.id;
  }
  // a heading made a moment ago (ops above) is not in the model yet: put the take-off first in it
  const { ord, fix } = m.headingById.has(par) || !par ? endOf(m.itemTree, par) : { ord: generateKeyBetween(null, null), fix: [] };
  ops.push(...fix);
  const n = m.items.filter((i) => i.kind === kind).length + 1;
  const name = t?.name ?? KIND_NAME[kind] + ' ' + n;
  ops.push([id, 'kind', kind], [id, 'name', name], [id, 'color', nextColor(m)], [id, 'owner', owner], [id, 'ord', ord], [id, 'par', par || null]);
  if (t) {
    if (t.h !== undefined) ops.push([id, 'h', t.h]);
    if (t.d !== undefined) ops.push([id, 'd', t.d]);
    if (t.dmin !== undefined) ops.push([id, 'dmin', t.dmin]);
    if (t.ow !== undefined) ops.push([id, 'ow', t.ow]);
    if (t.oh !== undefined) ops.push([id, 'oh', t.oh]);
    if (t.x !== undefined) ops.push([id, 'x', t.x]);
  }
  return { id, ops };
}

const KIND_NAME: Record<Kind, string> = { area: 'Area', line: 'Length', count: 'Count', wall: 'Wall', beam: 'Beam', room: 'Room' };

/** rv: fingerprint of the drawing revision on screen (so the shape is flagged when the sheet gets a new revision) */
export function shapeOps(ti: string, dwg: string, pg: number, k: ShapeKind, pts: Pt[], by: string, m = 1, rv = '', b?: number[], sg?: (string | null)[]): { id: string; ops: Op[] } {
  const id = 'sh:' + randomId(12);
  const ops: Op[] = [[id, 'ti', ti], [id, 'dwg', dwg], [id, 'pg', pg], [id, 'k', k], [id, 'p', J(toFlat(pts))], [id, 'by', by]];
  if (m !== 1) ops.push([id, 'm', m]);
  if (rv) ops.push([id, 'rv', rv]);
  if (k !== 'pt' && hasArcs(b)) ops.push([id, 'b', bulJ(b!, segCount(k, pts.length))]);
  if (k !== 'pt' && sg && sg.some((t) => t)) ops.push([id, 'sg', tagJ(sg, segCount(k, pts.length))]);
  return { id, ops };
}

// ---- segment tags: one per segment (null = none), kept in step with the corners
/** tags padded / cut to the number of segments */
export function tagsOf(s: Pick<Shape, 'k' | 'pts' | 'sg'>): (string | null)[] {
  const n = segCount(s.k, s.pts.length);
  return Array.from({ length: n }, (_, i) => s.sg?.[i] || null);
}
const tagJ = (sg: (string | null)[], n: number) => J(Array.from({ length: n }, (_, i) => sg[i] || null));
const tagOp = (id: string, k: ShapeKind, sg: (string | null)[], n: number): Op => [id, 'sg', sg.some((t) => t) ? tagJ(sg, segCount(k, n)) : null];
/** tag (or untag: null) some segments of a shape */
export function setSegTagsOps(s: Shape, segs: number[], tag: string | null): Op[] {
  const sg = tagsOf(s);
  let changed = false;
  // (v0.18.1 a segment's own figures stay with it when it is given another type, or back to the take-off's type -
  // fresh eyes: they went with the type before)
  for (const i of segs) { const t = i >= 0 && i < sg.length ? withTagOwn(tag, tagOwn(sg[i])) : null; if (i >= 0 && i < sg.length && sg[i] !== t) { sg[i] = t; changed = true; } }
  // written with the corners they belong to (geomOps): tags alone, against someone adding or removing
  // a corner at the same time, ended up one segment off - a beam type on the wrong beam
  return changed ? geomOps(s, { sg }) : [];
}

/** v0.16.6 several segments of one shape tagged at once, each with its own tag (beam marks read off the drawing) */
export function segTagsManyOps(s: Shape, tags: Map<number, string | null>): Op[] {
  const sg = tagsOf(s);
  let changed = false;
  for (const [i, t] of tags) if (i >= 0 && i < sg.length && sg[i] !== t) { sg[i] = t; changed = true; }
  return changed ? geomOps(s, { sg }) : [];
}

// ---- arcs: one bulge per segment
const segCount = (k: ShapeKind, n: number) => (k === 'poly' ? n : Math.max(0, n - 1));
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
/** bulges padded / cut to the number of segments */
export function bulgesOf(s: Pick<Shape, 'k' | 'pts' | 'b'>): number[] {
  const n = segCount(s.k, s.pts.length);
  return Array.from({ length: n }, (_, i) => s.b?.[i] || 0);
}
const bulJ = (b: number[], n: number) => J(Array.from({ length: n }, (_, i) => r6(b[i] || 0)));
const bulOp = (id: string, k: ShapeKind, b: number[], n: number): Op => [id, 'b', hasArcs(b) ? bulJ(b, segCount(k, n)) : null];

const shift = (pts: Pt[], dx: number, dy: number): Pt[] => pts.map(([x, y]) => [x + dx, y + dy]);

/**
 * A shape's geometry is written whole - corners, arcs and cut-outs together - whenever any
 * of it changes. They are separate cells, so two people editing the same shape at once
 * would otherwise mix one's corners with the other's arcs (arcs on the wrong sides) or
 * leave cut-outs behind where the outline was before a move. Whole, the later edit wins
 * cleanly.
 */
function geomOps(s: Pick<Shape, 'id' | 'k' | 'pts' | 'b' | 'holes'> & { sg?: (string | null)[] }, g: { pts?: Pt[]; b?: number[]; holes?: Pt[][]; sg?: (string | null)[] }): Op[] {
  const pts = g.pts ?? s.pts;
  const ops: Op[] = [[s.id, 'p', J(toFlat(pts))]];
  if (s.k === 'pt') return ops;
  ops.push(bulOp(s.id, s.k, g.b ?? bulgesOf({ k: s.k, pts, b: s.b }), pts.length));
  // (the tags too, whenever there are any: they belong to the segments)
  const sg = g.sg ?? (s.sg && s.sg.some((t) => t) ? tagsOf({ k: s.k, pts, sg: s.sg }) : null);
  if (sg) ops.push(tagOp(s.id, s.k, sg, pts.length));
  if (s.k === 'poly') {
    const holes = g.holes ?? s.holes;
    ops.push([s.id, 'holes', holes.length ? J(holes.map(toFlat)) : null]);
  }
  return ops;
}

/** v0.16 rooms: write a shape's segment tags (edge flags) with its corners, as tags always are */
export const geomTagsOps = (s: Shape, sg: (string | null)[]): Op[] => geomOps(s, { sg });

/** `openings`: the model's openings by shape - the doors and openings on moved walls move with them */
export function moveShapesOps(shapes: Shape[], dx: number, dy: number, openings?: Map<string, Opening[]>): Op[] {
  const ops: Op[] = [];
  for (const s of shapes) {
    ops.push(...geomOps(s, { pts: shift(s.pts, dx, dy), holes: s.holes.map((h) => shift(h, dx, dy)) }));
    for (const o of openings?.get(s.id) ?? []) ops.push([o.id, 'x', r2(o.x + dx)], [o.id, 'y', r2(o.y + dy)]);
  }
  return ops;
}
const r2 = (x: number) => Math.round(x * 100) / 100;

/** copies of shapes: same place on other sheets (typical floors) or moved on this one - with their tags,
 *  and (walls) the doors and openings on them */
export function copyShapesOps(shapes: Shape[], to: { dwg: string; pg: number; rv?: string }, by: string, dx = 0, dy = 0, ti?: string, openings?: Map<string, Opening[]>): { ids: string[]; ops: Op[] } {
  const ops: Op[] = [];
  const ids: string[] = [];
  for (const s of shapes) {
    const r = shapeOps(ti ?? s.ti, to.dwg, to.pg, s.k, shift(s.pts, dx, dy), by, s.m, to.rv ?? '', s.b, s.sg);
    if (s.holes.length) r.ops.push([r.id, 'holes', J(s.holes.map((h) => toFlat(shift(h, dx, dy))))]);
    // (v0.17 a column keeps its own type)
    if (s.mt) r.ops.push([r.id, 'mt', s.mt]);
    // (v0.18 its own figures, a stair's landing)
    for (const f of ['xw', 'xd', 'xt', 'xh', 'xr', 'xn'] as const) if (s[f] !== undefined) r.ops.push([r.id, f, s[f]!]);
    if (s.sp) r.ops.push([r.id, 'sp', s.sp]);
    // (v0.18.3 a door counter's point keeps its door: the copy counts the doors it shows - BUG-002)
    if (s.door) r.ops.push([r.id, 'door', s.door]);
    ops.push(...r.ops);
    for (const o of openings?.get(s.id) ?? []) ops.push(...openingOps({ ...o, sh: r.id, x: o.x + dx, y: o.y + dy }).ops);
    ids.push(r.id);
  }
  return { ids, ops };
}

export function insertVertexOps(s: Shape, ring: number, after: number, p: Pt): Op[] {
  if (ring === 0) {
    const pts = [...s.pts.slice(0, after + 1), p, ...s.pts.slice(after + 1)];
    const b = bulgesOf(s);
    const a = s.pts[after], c = s.pts[(after + 1) % s.pts.length];
    const halves = b[after] ? splitArc(a, c, b[after], p).b : [0, 0];
    // both halves of a tagged segment keep its tag
    const sg = tagsOf(s);
    const nsg = s.k === 'pt' ? undefined : [...sg.slice(0, after), sg[after] ?? null, sg[after] ?? null, ...sg.slice(after + 1)];
    return geomOps(s, { pts, b: [...b.slice(0, after), ...halves, ...b.slice(after + 1)], sg: nsg && nsg.some((t) => t) ? nsg : undefined });
  }
  return geomOps(s, { holes: s.holes.map((h, hi) => (hi === ring - 1 ? [...h.slice(0, after + 1), p, ...h.slice(after + 1)] : h)) });
}

/** remove a corner; refuses (returns []) when the shape would fall apart */
export function deleteVertexOps(s: Shape, ring: number, idx: number): Op[] {
  if (ring === 0 && closedLine(s) && (idx === 0 || idx === s.pts.length - 1)) {
    // a closed line's first corner (= its last): its two sides become one and the line closes at the
    // next corner, as an area's would (removing only one end opened it and took a side out of the length)
    const n = s.pts.length;
    if (n - 2 < 3) return [];
    const b = bulgesOf(s), t = tagsOf(s);
    const pts = [...s.pts.slice(1, n - 1), s.pts[1]];
    const nb = [...b.slice(1, n - 2), 0];
    const nt = [...t.slice(1, n - 2), t[n - 2] ?? t[0] ?? null];
    return geomOps(s, { pts, b: nb, sg: t.some((x) => x) ? nt : undefined });
  }
  if (ring === 0) {
    const min = s.k === 'poly' ? 3 : 2;
    if (s.pts.length - 1 < min) return [];
    const pts = s.pts.filter((_, i) => i !== idx);
    const b = bulgesOf(s), n = s.pts.length;
    let nb: number[];
    if (s.k === 'poly') nb = idx === 0 ? [...b.slice(1, n - 1), 0] : [...b.slice(0, idx - 1), 0, ...b.slice(idx + 1)];
    else nb = idx === 0 ? b.slice(1) : idx === n - 1 ? b.slice(0, n - 2) : [...b.slice(0, idx - 1), 0, ...b.slice(idx + 1)];
    // tags the same way: the two segments that become one keep the first one's tag
    const t = tagsOf(s);
    let nt: (string | null)[];
    if (s.k === 'poly') nt = idx === 0 ? [...t.slice(1, n - 1), t[n - 1] ?? null] : [...t.slice(0, idx - 1), t[idx - 1] ?? t[idx] ?? null, ...t.slice(idx + 1)];
    else nt = idx === 0 ? t.slice(1) : idx === n - 1 ? t.slice(0, n - 2) : [...t.slice(0, idx - 1), t[idx - 1] ?? t[idx] ?? null, ...t.slice(idx + 1)];
    return geomOps(s, { pts, b: nb, sg: t.some((x) => x) ? nt : undefined });
  }
  const h = s.holes[ring - 1];
  // (v0.16: a cut-out keeps 3 nodes - deleting a node no longer takes the whole cut-out away; right-click ›
  // Remove its cut-outs does that)
  if (!h || h.length - 1 < 3) return [];
  return geomOps(s, { holes: s.holes.map((hh, hi) => (hi === ring - 1 ? hh.filter((_, i) => i !== idx) : hh)) });
}

export function replacePointsOps(s: Shape, pts: Pt[], b?: number[], sg?: (string | null)[]): Op[] {
  // (a line continued: its segments keep their tags, the new ones have none - v0.17: or as given, nodes put in
  // between: the tags of the segments after them move on with them)
  return geomOps(s, { pts, b: b ?? bulgesOf(s), sg: sg && sg.some((t) => t) ? sg : sg ? undefined : s.sg.some((t) => t) ? tagsOf({ k: s.k, pts, sg: s.sg }) : undefined });
}

/** make one segment an arc (bulge) or straight again (0) */
export function setBulgeOps(s: Shape, seg: number, bulge: number): Op[] {
  const b = bulgesOf(s);
  if (seg < 0 || seg >= b.length) return [];
  b[seg] = bulge;
  return geomOps(s, { b });
}

// ---- splitting and joining lengths
// A split or a join removes the shape(s) it starts from and makes new ones. Kept as the same shape
// with new points, an edit someone made to it at the same moment on another PC (moving it, dragging
// an end) would bring the whole length back next to the new part - counted twice. Removed, a late
// edit lands on a shape that no longer counts; Undo brings the original back and removes the parts.
// Each new part says which shape(s) it was made from ('of'): if someone else deletes the original
// at the same time (or it is brought back), the parts give way to that instead of bringing the
// whole length back as parts (see buildQtoModel).
const pieceOps = (s: Shape, pts: Pt[], b: number[], by: string, rv = s.rv, of: string[] = [s.id], sg?: (string | null)[]) => {
  const r = shapeOps(s.ti, s.dwg, s.pg, 'line', pts, s.by || by, s.m, rv, b, sg);
  r.ops.push([r.id, 'of', J(of)]);
  return r;
};

/** a length in two at one of its corners (0 < at < last); `ids` = [first part, second part], `id` = the second */
export function splitLineOps(s: Shape, at: number, by: string): { id: string; ids: string[]; ops: Op[] } | null {
  if (s.k !== 'line' || at <= 0 || at >= s.pts.length - 1) return null;
  const b = bulgesOf(s);
  const t = tagsOf(s);
  const a = pieceOps(s, s.pts.slice(0, at + 1), b.slice(0, at), by, s.rv, [s.id], t.slice(0, at));
  const c = pieceOps(s, s.pts.slice(at), b.slice(at), by, s.rv, [s.id], t.slice(at));
  return { id: c.id, ids: [a.id, c.id], ops: [[s.id, 'del', true], ...a.ops, ...c.ops] };
}

/** split a length at a point on one of its segments */
export function splitLineAtOps(s: Shape, seg: number, p: Pt, by: string): { id: string; ids: string[]; ops: Op[] } | null {
  if (s.k !== 'line' || seg < 0 || seg >= s.pts.length - 1) return null;
  const b = bulgesOf(s);
  const a = s.pts[seg], c = s.pts[seg + 1];
  const cut = b[seg] ? splitArc(a, c, b[seg], p) : { p, b: [0, 0] };
  if (dist(cut.p, a) < 0.05) return seg > 0 ? splitLineOps(s, seg, by) : null;
  if (dist(cut.p, c) < 0.05) return seg + 1 < s.pts.length - 1 ? splitLineOps(s, seg + 1, by) : null;
  const pts = [...s.pts.slice(0, seg + 1), cut.p, ...s.pts.slice(seg + 1)];
  const nb = [...b.slice(0, seg), ...cut.b, ...b.slice(seg + 1)];
  const t = tagsOf(s);
  return splitLineOps({ ...s, pts, b: nb, sg: [...t.slice(0, seg), t[seg] ?? null, t[seg] ?? null, ...t.slice(seg + 1)] }, seg + 1, by);
}

/** every segment of a length as a length of its own */
export function explodeLineOps(s: Shape, by: string): { ids: string[]; ops: Op[] } {
  if (s.k !== 'line' || s.pts.length < 3) return { ids: [s.id], ops: [] };
  const b = bulgesOf(s);
  const t = tagsOf(s);
  const ops: Op[] = [[s.id, 'del', true]];
  const ids: string[] = [];
  for (let i = 0; i < s.pts.length - 1; i++) {
    const r = pieceOps(s, [s.pts[i], s.pts[i + 1]], [b[i]], by, s.rv, [s.id], [t[i] ?? null]);
    ops.push(...r.ops);
    ids.push(r.id);
  }
  return { ids, ops };
}

/**
 * two lengths that meet end to end -> one new length (both removed); null if their ends don't meet.
 * `stale`: shapes measured on an earlier revision of the sheet - the joined one stays "to check".
 */
export function joinLinesOps(a: Shape, c: Shape, tol = 0.5, stale?: (s: Shape) => boolean, by = ''): Op[] | null {
  if (a.k !== 'line' || c.k !== 'line' || a.id === c.id) return null;
  // one repeated ×3 and the other ×1 can't become one length without changing the quantity
  if ((a.m || 1) !== (c.m || 1)) return null;
  const rev = (s: Shape) => ({ pts: [...s.pts].reverse(), b: bulgesOf(s).reverse().map((x) => -x), sg: tagsOf(s).reverse() });
  const fw = (s: Shape) => ({ pts: s.pts, b: bulgesOf(s), sg: tagsOf(s) });
  const A0 = a.pts[0], A1 = a.pts[a.pts.length - 1], C0 = c.pts[0], C1 = c.pts[c.pts.length - 1];
  let first: { pts: Pt[]; b: number[]; sg: (string | null)[] }, second: { pts: Pt[]; b: number[]; sg: (string | null)[] };
  if (dist(A1, C0) <= tol) { first = fw(a); second = fw(c); }
  else if (dist(A1, C1) <= tol) { first = fw(a); second = rev(c); }
  else if (dist(A0, C1) <= tol) { first = fw(c); second = fw(a); }
  else if (dist(A0, C0) <= tol) { first = rev(a); second = fw(c); }
  else return null;
  const pts = [...first.pts, ...second.pts.slice(1)];
  const b = [...first.b, ...second.b];
  const rv = stale?.(a) ? a.rv : stale?.(c) ? c.rv : a.rv || c.rv;
  const r = pieceOps(a, pts, b, by, rv, [a.id, c.id], [...first.sg, ...second.sg]);
  return [[a.id, 'del', true], [c.id, 'del', true], ...r.ops];
}

export function addHoleOps(s: Shape, hole: Pt[]): Op[] {
  return geomOps(s, { holes: [...s.holes, hole] });
}

/** a line that ends where it starts (a wall's rectangle / circle drawn as its outline): its first corner is its last */
const closedLine = (s: Pick<Shape, 'k' | 'pts'>) => s.k === 'line' && s.pts.length >= 3 && dist(s.pts[0], s.pts[s.pts.length - 1]) < 0.01;

export function vertexOps(s: Shape, ring: number, idx: number, p: Pt): Op[] {
  // the first / last corner of a closed line: both ends move (one alone opened the outline - a room's
  // wall a gap short at the corner that was dragged)
  const ends = ring === 0 && closedLine(s) && (idx === 0 || idx === s.pts.length - 1);
  if (ring === 0) return geomOps(s, { pts: s.pts.map((q, i) => (i === idx || (ends && (i === 0 || i === s.pts.length - 1)) ? p : q)) });
  return geomOps(s, { holes: s.holes.map((h, hi) => (hi === ring - 1 ? h.map((q, i) => (i === idx ? p : q)) : h)) });
}

export function linkOps(ti: string, to: string, q: Measure, f = 1): { id: string; ops: Op[] } {
  const id = 'lk:' + randomId(10);
  return { id, ops: [[id, 'ti', ti], [id, 'to', to], [id, 'q', q], [id, 'f', f === 1 ? null : f]] };
}

export function dummyOps(m: QtoModel, d: { ref: string; desc: string; unit: string; grp?: string }): { id: string; ops: Op[] } {
  const id = 'dm:' + randomId(10);
  const last = m.dummies[m.dummies.length - 1];
  let ord: string;
  try { ord = generateKeyBetween(last?.ord || null, null); } catch { ord = generateKeyBetween(null, null); }
  return { id, ops: [[id, 'ref', d.ref.trim() || null], [id, 'desc', d.desc.trim()], [id, 'unit', d.unit.trim() || null], [id, 'grp', d.grp?.trim() || null], [id, 'ord', ord]] };
}

/**
 * Remove a temporary line. Matched to a BOQ line, its links move onto that line (the BOQ keeps
 * the quantity); not matched, its links go with it. All restorable with Undo.
 */
export function removeDummyOps(m: QtoModel, id: string): { ops: Op[]; moved: number; dropped: number } {
  const d = m.dummyById.get(id);
  const ops: Op[] = [[id, 'del', true]];
  let moved = 0, dropped = 0;
  const real = d?.map && m.boqById.has(d.map) ? 'b:' + d.map : null;
  for (const l of m.links) {
    if (l.to !== id) continue;
    // already linked straight to that line with the same measure: this one would be a double
    const twin = real && m.links.some((x) => x.id !== l.id && x.ti === l.ti && x.to === real && x.q === l.q);
    if (real && !twin) { ops.push([l.id, 'to', real]); moved++; }
    else { ops.push([l.id, 'del', true]); dropped++; }
  }
  return { ops, moved, dropped };
}

export function noteOps(n: { on: string; text: string; to: 'est' | 'me'; by: string; byName: string; dwg?: string | null; pg?: number | null; x?: number | null; y?: number | null }): { id: string; ops: Op[] } {
  const id = 'nt:' + randomId(10);
  return {
    id,
    ops: [
      [id, 'on', n.on || null], [id, 'text', n.text.trim()], [id, 'to', n.to], [id, 'by', n.by], [id, 'byName', n.byName], [id, 't', Date.now()],
      [id, 'dwg', n.dwg ?? null], [id, 'pg', n.pg ?? null], [id, 'x', n.x ?? null], [id, 'y', n.y ?? null],
    ],
  };
}

/** Delete a take-off item: its shapes and links go with it (all restorable from history). */
export function deleteItemOps(m: QtoModel, ti: string): Op[] {
  // v0.16: a room takes its outline's doors / openings and its own finishes with it
  if (m.itemById.get(ti)?.kind === 'room') return deleteRoomOps(m, ti);
  const ops: Op[] = [[ti, 'del', true]];
  for (const s of m.shapesByItem.get(ti) ?? []) ops.push([s.id, 'del', true]);
  for (const l of m.linksByItem.get(ti) ?? []) ops.push([l.id, 'del', true]);
  return ops;
}

// ---- walls: doors and openings placed on them (v0.15)
export function openingOps(o: Pick<Opening, 'sh' | 'x' | 'y' | 'k' | 'door' | 'tag' | 'w' | 'h' | 'lint'> & { sill?: number | null; ln?: boolean }): { id: string; ops: Op[] } {
  const id = 'op:' + randomId(10);
  return {
    id,
    ops: [
      [id, 'sh', o.sh], [id, 'x', r2(o.x)], [id, 'y', r2(o.y)], [id, 'k', o.k], [id, 'door', o.door || null], [id, 'tag', o.tag || null],
      [id, 'w', o.w ?? null], [id, 'h', o.h ?? null], [id, 'lint', o.lint && !o.ln ? null : false],
      // (v0.18 on a plain length: its width comes off the length - never a door of the schedule's count, no lintel)
      ...(o.ln ? [[id, 'ln', true] as Op] : []),
      // (v0.16: an opening in a room has a sill - copies keep it)
      ...(o.sill ? [[id, 'sill', o.sill] as Op] : []),
    ],
  };
}

/**
 * The doors / openings of shapes that are being replaced by new ones (a split, a join, split into
 * segments): each goes onto the new part it lies on - they would otherwise stay with the removed shape.
 */
export function reassignOpeningsOps(openings: Map<string, Opening[]>, from: string[], parts: { id: string; k: ShapeKind; pts: Pt[]; b?: number[] }[]): Op[] {
  const ops: Op[] = [];
  for (const f of from) {
    for (const o of openings.get(f) ?? []) {
      let best: { id: string; d: number } | null = null;
      for (const p of parts) {
        const d = nearestSeg(p, [o.x, o.y]).d;
        if (!best || d < best.d) best = { id: p.id, d };
      }
      if (best) ops.push([o.id, 'sh', best.id]);
    }
  }
  return ops;
}

/** the new shapes written by some ops (a split, a join): their ids, kinds, corners and arcs */
export function newShapesIn(ops: Op[]): { id: string; k: ShapeKind; pts: Pt[]; b: number[] }[] {
  const by = new Map<string, { id: string; k: ShapeKind; pts: Pt[]; b: number[] }>();
  for (const [id, f, v] of ops) {
    if (!id.startsWith('sh:')) continue;
    const e = by.get(id) ?? by.set(id, { id, k: 'line', pts: [], b: [] }).get(id)!;
    if (f === 'k') e.k = v as ShapeKind;
    if (f === 'p' && typeof v === 'string') { try { const a = JSON.parse(v) as number[]; e.pts = []; for (let i = 0; i + 1 < a.length; i += 2) e.pts.push([a[i], a[i + 1]]); } catch { /* not a shape */ } }
    // (arcs: a door on a curved part goes by the arc, as the model places it)
    if (f === 'b' && typeof v === 'string') { try { e.b = (JSON.parse(v) as number[]).map((x) => (Number.isFinite(x) ? x : 0)); } catch { /* none */ } }
  }
  return [...by.values()].filter((e) => e.pts.length && ops.some((o) => o[0] === e.id && o[1] === 'ti'));
}

// ---- beam types (v0.15)
export function beamTypeOps(t: { name: string; w: number | null; d: number | null; r: number | null; color: string }, id = 'bt:' + randomId(8)): { id: string; ops: Op[] } {
  return { id, ops: [[id, 'name', t.name.trim()], [id, 'w', t.w], [id, 'd', t.d], [id, 'r', t.r], [id, 'color', t.color], [id, 'del', null]] };
}

// ---- the door schedule (v0.15)
export interface DoorIn { tag: string; desc?: string; loc?: string; sw?: number | null; sh?: number | null; cw?: number | null; ch?: number | null }

const DOOR_FIELDS = ['desc', 'loc', 'sw', 'sh', 'cw', 'ch'] as const;
export type DoorField = (typeof DOOR_FIELDS)[number];
const normTag = doorTagKey;
/**
 * A new schedule row's id comes from its tag, not drawn at random: two PCs bringing in the same
 * schedule at once (or typing the same new tag in the door picker) write ONE row, not every door
 * twice with the doors and links split between the copies. Random only when that id is already
 * someone else's (a row renamed since, or deleted under another tag).
 */
function doorIdFor(tag: string, used: Set<string>): string {
  const k = normTag(tag);
  const id = 'ds:t' + crc32hex(k) + crc32hex(ID_SALT + k);
  return used.has(id) ? 'ds:' + randomId(8) : id;
}
const idsInUse = (m: Pick<QtoModel, 'doors'> & Partial<Pick<QtoModel, 'doorsGone'>>) => new Set<string>([...m.doors.map((d) => d.id), ...(m.doorsGone?.values() ?? [])]);
const doorVal = (f: DoorField, v: unknown): string | number | null =>
  f === 'desc' || f === 'loc' ? (String(v ?? '').trim() || null) : typeof v === 'number' && v > 0 ? Math.round(v * 1e4) / 1e4 : null;

/** one row of a re-import, against the schedule as it is */
export interface DoorDiff {
  tag: string;
  /** new: not in the schedule; changed: some fields differ; same: nothing to do; back: a deleted row's tag */
  k: 'new' | 'changed' | 'same' | 'back';
  id: string | null;
  /** the fields that differ: [field, now, from the file] */
  ch: [DoorField, string | number | null, string | number | null][];
  row: DoorIn;
}
/** what an import would do: rows of the file, and rows of the schedule the file doesn't have */
export interface DoorPlan {
  rows: DoorDiff[];
  /** schedule rows not in the file: how many doors are placed with each (only unplaced ones can go) */
  missing: { id: string; tag: string; placed: number; app: boolean }[];
  /** tags twice in the file (the first is used) */
  dupes: string[];
}

/**
 * Compare a door schedule file with the schedule (by tag, ignoring case and spaces at the ends). A
 * field the file leaves empty is not a change (a file without a "Location" column keeps the locations).
 */
/** schedule rows by tag; two rows with one tag (an old race): the first, as the model puts doors on them */
function firstByTag<T>(m: Pick<QtoModel, 'doors'>, val: (d: QtoModel['doors'][number]) => T): Map<string, T> {
  const out = new Map<string, T>();
  for (const d of m.doors) if (!out.has(normTag(d.tag))) out.set(normTag(d.tag), val(d));
  return out;
}

export function planDoorImport(m: Pick<QtoModel, 'doors' | 'doorsGone' | 'openings'>, rows: DoorIn[]): DoorPlan {
  const byTag = firstByTag(m, (d) => d);
  const seen = new Set<string>();
  const out: DoorDiff[] = [];
  const dupes: string[] = [];
  for (const r of rows) {
    const t = normTag(r.tag || '');
    if (!t) continue;
    if (seen.has(t)) { dupes.push(r.tag.trim()); continue; }
    seen.add(t);
    const had = byTag.get(t);
    if (!had) { out.push({ tag: r.tag.trim(), k: m.doorsGone.has(t) ? 'back' : 'new', id: m.doorsGone.get(t) ?? null, ch: [], row: r }); continue; }
    const ch: DoorDiff['ch'] = [];
    for (const f of DOOR_FIELDS) {
      if (r[f] === undefined) continue;
      const nv = doorVal(f, r[f]);
      // empty in the file (a blank cell, "TBC", "-"): not a change - sizes included. A blank width
      // taken as "no size" took the door out of the wall's deductions and its lintel out (ticked by default)
      if (nv === null) continue;
      const ov = doorVal(f, had[f]);
      if (nv !== ov) ch.push([f, ov, nv]);
    }
    out.push({ tag: had.tag, k: ch.length ? 'changed' : 'same', id: had.id, ch, row: r });
  }
  const placed = new Map<string, number>();
  for (const o of m.openings) if (o.k === 'door' && o.door) placed.set(o.door, (placed.get(o.door) ?? 0) + 1);
  const missing = m.doors.filter((d) => !seen.has(normTag(d.tag))).map((d) => ({ id: d.id, tag: d.tag, placed: placed.get(d.id) ?? 0, app: d.app }));
  return { rows: out, missing, dupes };
}

/**
 * Apply an import plan: 'take' says which rows (by tag) and, for changed ones, which fields to take
 * from the file (default: all); 'drop' lists schedule rows to remove (placed ones are never removed by
 * an import - delete them in the table). A deleted row whose tag comes back is revived (its BOQ links too).
 */
export function applyDoorPlanOps(m: Pick<QtoModel, 'doors'> & Partial<Pick<QtoModel, 'doorsGone'>>, plan: DoorPlan, take?: Map<string, Set<DoorField> | true>, drop: string[] = []): { ops: Op[]; added: number; updated: number; removed: number } {
  const ops: Op[] = [];
  let last = m.doors[m.doors.length - 1]?.ord || null;
  let added = 0, updated = 0, removed = 0;
  const used = idsInUse(m);
  for (const r of plan.rows) {
    const tk = take ? take.get(normTag(r.tag)) : true;
    if (!tk || r.k === 'same') continue;
    if (r.k === 'changed') {
      let n = 0;
      for (const [f, , nv] of r.ch) if (tk === true || tk.has(f)) { ops.push([r.id!, f, nv]); n++; }
      if (n) updated++;
      continue;
    }
    const id = r.id ?? doorIdFor(r.row.tag, used);
    used.add(id);
    let ord: string;
    try { ord = generateKeyBetween(last, null); } catch { ord = generateKeyBetween(null, null); }
    last = ord;
    ops.push([id, 'tag', r.row.tag.trim()], [id, 'ord', ord], [id, 'del', null], [id, 'src', null]);
    // a row brought back keeps what the file does not say (its location when the file has no
    // Location column, a size left blank); a new row gets the file's row as it is
    for (const f of DOOR_FIELDS) {
      const v = r.row[f] === undefined ? null : doorVal(f, r.row[f]);
      if (r.k === 'back' && v === null) continue;
      ops.push([id, f, v]);
    }
    added++;
  }
  const placed = new Set(plan.missing.filter((x) => x.placed > 0).map((x) => x.id));
  for (const id of drop) if (!placed.has(id) && plan.missing.some((x) => x.id === id)) { ops.push([id, 'del', true]); removed++; }
  return { ops, added, updated, removed };
}

/**
 * Rows typed in the app (the schedule table, or a tag not in the schedule typed in the door picker):
 * a tag already there is updated, a deleted one revived, a new one added after the last.
 */
export function doorRowsOps(m: Pick<QtoModel, 'doors' | 'doorsGone'>, rows: DoorIn[], app = true): { ops: Op[]; added: number; updated: number; ids: string[] } {
  const ops: Op[] = [];
  const byTag = firstByTag(m, (d) => d.id);
  let last = m.doors[m.doors.length - 1]?.ord || null;
  let added = 0, updated = 0;
  const ids: string[] = [];
  const used = idsInUse(m);
  for (const r of rows) {
    const tag = (r.tag || '').trim();
    if (!tag) continue;
    let id = byTag.get(normTag(tag));
    if (!id) {
      id = m.doorsGone.get(normTag(tag)) ?? doorIdFor(tag, used);
      used.add(id);
      let ord: string;
      try { ord = generateKeyBetween(last, null); } catch { ord = generateKeyBetween(null, null); }
      last = ord;
      ops.push([id, 'tag', tag], [id, 'ord', ord], [id, 'del', null], [id, 'src', app ? 'a' : null]);
      added++;
      byTag.set(normTag(tag), id);
    } else updated++;
    for (const f of DOOR_FIELDS) if (r[f] !== undefined) ops.push([id, f, doorVal(f, r[f])]);
    ids.push(id);
  }
  return { ops, added, updated, ids };
}

/** rename a schedule row's tag (refused when another row has it); the doors placed with it follow */
export function renameDoorOps(m: Pick<QtoModel, 'doors' | 'openings'>, id: string, tag: string): Op[] | null {
  const t = tag.trim();
  if (!t || m.doors.some((d) => d.id !== id && normTag(d.tag) === normTag(t))) return null;
  const ops: Op[] = [[id, 'tag', t]];
  for (const o of m.openings) if (o.k === 'door' && o.door === id) ops.push([o.id, 'tag', t], [o.id, 'door', id]);
  return ops;
}

/**
 * Delete a schedule row. The doors placed with it stay on their walls with the row's last size
 * (still deducted, counted and lintelled, flagged "not in the schedule"); the tag coming back
 * (typed or imported) puts them back on the schedule.
 */
export function deleteDoorOps(m: Pick<QtoModel, 'doorById' | 'openings'>, id: string): Op[] {
  const d = m.doorById.get(id);
  if (!d) return [];
  const ops: Op[] = [[id, 'del', true]];
  const w = d.sw ?? d.cw, h = d.sh ?? d.ch;
  for (const o of m.openings) if (o.k === 'door' && o.door === id) ops.push([o.id, 'w', w], [o.id, 'h', h], [o.id, 'tag', d.tag]);
  return ops;
}

/**
 * A copy of a take-off: its settings, optionally its links to the BOQ (same lines, measures,
 * factors) and its shapes (with their tags; walls with their doors and openings).
 */
export function duplicateItemOps(m: QtoModel, ti: string, owner: string, opts: { links: boolean; shapes: boolean }): { id: string; ops: Op[] } | null {
  const it = m.itemById.get(ti);
  if (!it) return null;
  // v0.16: a room with its settings, outline (edges, doors, openings) and its own finishes
  if (it.kind === 'room') return duplicateRoomOps(m, ti, owner, opts);
  const r = newItemOps(m, owner, it.kind, undefined, it.par);
  // right after the original in its heading
  const sib = (m.tree.get(it.par) ?? []);
  const i = sib.findIndex((n) => n.id === it.id);
  let ord: string | null = null;
  try { ord = generateKeyBetween(it.ord || null, sib[i + 1]?.ord || null); } catch { ord = null; }
  const ops: Op[] = r.ops.map((o) => (o[1] === 'name' ? [o[0], 'name', it.name + ' (copy)'] as Op : o[1] === 'color' ? [o[0], 'color', it.color] as Op : o[1] === 'ord' && ord ? [o[0], 'ord', ord] as Op : o));
  const id = r.id;
  for (const f of ['h', 'd', 'waste', 'dmin', 'ow', 'oh', 'lb', 'ld', 'lw', 'st', 'sw'] as const) {
    const v = it[f];
    if (v !== null && v !== undefined && !(f === 'waste' && !v)) ops.push([id, f, v as number]);
  }
  if (it.x !== 1) ops.push([id, 'x', it.x]);
  if (it.bt) ops.push([id, 'bt', it.bt]);
  // (v0.17 a structural element stays one; its steel ratio; an upstand)
  if (it.sk) ops.push([id, 'sk', it.sk]);
  if (it.sr !== null && it.sr !== undefined) ops.push([id, 'sr', it.sr]);
  if (it.up) ops.push([id, 'up', true]);
  // (v0.18 / v0.18.1 everything else a structural take-off keeps: mesh, the slab under columns, a stair's tread and
  // riser, the slab's soffit less drops / beams, waterproofing, blinding, polythene - its links' measures come from them)
  if (it.dc) ops.push([id, 'dc', true]);
  if (it.mesh) ops.push([id, 'mesh', true]);
  if (it.fdx) ops.push([id, 'fdx', true]);
  for (const f of ['cst', 'tr', 'ri', 'wvh', 'blt', 'blx'] as const) { const v = it[f]; if (v !== null && v !== undefined) ops.push([id, f, v]); }
  for (const f of ['wb', 'wsd', 'bln', 'pe'] as const) if (it[f]) ops.push([id, f, true]);
  if (it.wfc === 2) ops.push([id, 'wfc', 2]);
  if (it.fcode) ops.push([id, 'fcode', it.fcode]);
  if (it.fill) ops.push([id, 'fill', it.fill]);
  if (it.lab) ops.push([id, 'lab', it.lab]);
  if (it.priv) ops.push([id, 'priv', true]);
  if (it.ded.length) ops.push([id, 'ded', J(it.ded)]);
  if (opts.links) for (const l of m.linksByItem.get(it.id) ?? []) ops.push(...linkOps(id, l.to, l.q, l.f).ops);
  if (opts.shapes) {
    for (const s of m.shapesByItem.get(it.id) ?? []) {
      const c = copyShapesOps([s], { dwg: s.dwg, pg: s.pg, rv: s.rv }, s.by, 0, 0, id, m.openingsByShape);
      ops.push(...c.ops);
    }
  }
  return { id, ops };
}

/** v0.18 (Feedback 3, 7) figures of their own on the elements picked - or back to their type's / take-off's (null).
 *  xw, xd, xt, xh: sizes (m); xr: steel kg/m³; xn: a stair flight's steps; sp: 'l' = a stair's landing */
export function shapeOverrideOps(shapes: Pick<Shape, 'id'>[], patch: Partial<Record<'xw' | 'xd' | 'xt' | 'xh' | 'xr' | 'xn', number | null>> & { sp?: 'l' | null }): Op[] {
  const ops: Op[] = [];
  for (const s of shapes) for (const [f, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    ops.push([s.id, f, f === 'sp' ? (v === 'l' ? 'l' : null) : typeof v === 'number' && (f === 'xr' ? v >= 0 : v > 0) ? v : null]);
  }
  return ops;
}

// ---------------------------------------------------------------- v0.18 images on a sheet
/** an image put on a sheet (its file is already in the project's images folder) - or put somewhere else / on another sheet */
export function imageOps(o: { id?: string; dwg: string; pg: number; box: { x0: number; y0: number; x1: number; y1: number }; file: string; name: string; by: string; pub?: boolean }): { id: string; ops: Op[] } {
  const id = o.id ?? 'im:' + randomId(10);
  const r = (v: number) => Math.round(v * 100) / 100;
  return { id, ops: [[id, 'dwg', o.dwg], [id, 'pg', o.pg], [id, 'x0', r(o.box.x0)], [id, 'y0', r(o.box.y0)], [id, 'x1', r(o.box.x1)], [id, 'y1', r(o.box.y1)], [id, 'file', o.file], [id, 'name', o.name], [id, 'by', o.by], [id, 'pub', o.pub ? true : null], [id, 'del', null]] };
}

/** v0.18.1 a beam's / concrete wall's segments with figures of their own (null: back to the type's), in their tags */
export function segOwnOps(s: Shape, segs: number[], patch: Partial<Record<'w' | 'd' | 'r', number | null>>): Op[] {
  const tags = new Map<number, string | null>();
  for (const i of segs) {
    const cur = s.sg[i] ?? null, own = { ...tagOwn(cur) } as SegOwn;
    for (const k of ['w', 'd', 'r'] as const) { const v = patch[k]; if (v === undefined) continue; if (v === null) delete own[k]; else own[k] = v; }
    tags.set(i, withTagOwn(cur, own));
  }
  return segTagsManyOps(s, tags);
}
