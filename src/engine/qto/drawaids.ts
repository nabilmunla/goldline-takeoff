// v0.16 drawing aids and node edits on the sheet (group a): ortho (horizontal / vertical only), the
// perpendicular snap onto take-offs already drawn, window / crossing selection, a node put in exactly
// on an outline (the shape unchanged), an end segment set to a typed length, walls and beams drawn as
// bands of their real width, clearing a sheet's scale.
// Pure geometry on sheet points (see geometry.ts): no drawing, no React.
import { arcCircle, dist, pointInPoly, segDist, splitArc, type Box, type Pt } from './geometry';
import { beamTypeOf, tagOwn, pageKey, shapeQtyAt, type QtoModel, type Shape, type TItem } from './model';
import type { Op } from '../types';

/** the point constrained to horizontal or vertical from `prev` (ortho: 0° / 90° only) */
export function orthoHV(prev: Pt, p: Pt): Pt {
  return Math.abs(p[0] - prev[0]) >= Math.abs(p[1] - prev[1]) ? [p[0], prev[1]] : [prev[0], p[1]];
}

/** one segment of an outline: a -> b, an arc when bulge != 0 */
export interface Seg { a: Pt; b: Pt; bulge: number }

/** the segments of a shape's outline (and its cut-outs), for snapping and hit tests */
export function segsOf(s: Pick<Shape, 'k' | 'pts' | 'b' | 'holes'>): Seg[] {
  if (s.k === 'pt') return [];
  const out: Seg[] = [];
  const n = s.pts.length;
  for (let i = 0; i < (s.k === 'poly' ? n : n - 1); i++) out.push({ a: s.pts[i], b: s.pts[(i + 1) % n], bulge: s.b[i] || 0 });
  for (const h of s.holes) for (let i = 0; i < h.length; i++) out.push({ a: h[i], b: h[(i + 1) % h.length], bulge: 0 });
  return out;
}

/** how far round an arc a point's angle is, as a fraction of the arc (0 = a, 1 = b; outside 0..1: off the arc) */
function arcFrac(k: { c: Pt; a0: number; th: number }, p: Pt): number {
  const tw = 2 * Math.PI;
  let d = Math.atan2(p[1] - k.c[1], p[0] - k.c[0]) - k.a0;
  d = ((d % tw) + tw) % tw;
  if (k.th < 0) d -= tw;
  return d / k.th;
}

/** distance from p to a segment (an arc: to the curve) */
export function segDistTo(p: Pt, g: Seg): number {
  const k = arcCircle(g.a, g.b, g.bulge);
  if (!k) return segDist(p, g.a, g.b).d;
  const f = arcFrac(k, p);
  if (f >= 0 && f <= 1) return Math.abs(dist(p, k.c) - k.r);
  return Math.min(dist(p, g.a), dist(p, g.b));
}

/** the point of a segment nearest to p (on the curve for an arc), and how far along it is (0..1) */
export function nearestOnSeg(p: Pt, g: Seg): { q: Pt; t: number; d: number } {
  const k = arcCircle(g.a, g.b, g.bulge);
  if (!k) { const r = segDist(p, g.a, g.b); return { q: r.q, t: r.t, d: r.d }; }
  const f = arcFrac(k, p);
  if (f >= 0 && f <= 1) {
    const ang = Math.atan2(p[1] - k.c[1], p[0] - k.c[0]);
    const q: Pt = [k.c[0] + k.r * Math.cos(ang), k.c[1] + k.r * Math.sin(ang)];
    return { q, t: f, d: dist(p, q) };
  }
  return dist(p, g.a) <= dist(p, g.b) ? { q: g.a, t: 0, d: dist(p, g.a) } : { q: g.b, t: 1, d: dist(p, g.b) };
}

/**
 * The foot of the perpendicular from `from` onto a segment - only when it lies on the segment (null
 * otherwise). An arc: the point where the line from its centre through `from` meets it.
 */
export function perpFoot(from: Pt, g: Seg): Pt | null {
  const k = arcCircle(g.a, g.b, g.bulge);
  if (!k) {
    const dx = g.b[0] - g.a[0], dy = g.b[1] - g.a[1];
    const l2 = dx * dx + dy * dy;
    if (l2 < 1e-12) return null;
    const t = ((from[0] - g.a[0]) * dx + (from[1] - g.a[1]) * dy) / l2;
    if (t < -1e-9 || t > 1 + 1e-9) return null;
    return [g.a[0] + t * dx, g.a[1] + t * dy];
  }
  const d = dist(from, k.c);
  if (d < 1e-9) return null;
  const q: Pt = [k.c[0] + ((from[0] - k.c[0]) / d) * k.r, k.c[1] + ((from[1] - k.c[1]) / d) * k.r];
  const f = arcFrac(k, q);
  return f >= -1e-9 && f <= 1 + 1e-9 ? q : null;
}

/**
 * Perpendicular snap: of the segments within `tol` of the pointer, the nearest one whose perpendicular
 * foot from `from` lies on it gives the point (the foot). null = none near.
 * footNear (v0.18.1, ortho off): only a foot within `tol` of the pointer counts, the nearest foot wins -
 * the pointer has to come to the right angle; with ortho on, being near the line is enough.
 */
export function perpSnap(from: Pt, pointer: Pt, segs: Iterable<Seg>, tol: number, footNear = false): { p: Pt; seg: Seg } | null {
  let best = tol, hit: { p: Pt; seg: Seg } | null = null;
  for (const g of segs) {
    // (a cheap box test first: a sheet can have thousands of segments)
    const k = g.bulge ? null : g;
    if (k && (Math.min(g.a[0], g.b[0]) - tol > pointer[0] || Math.max(g.a[0], g.b[0]) + tol < pointer[0] || Math.min(g.a[1], g.b[1]) - tol > pointer[1] || Math.max(g.a[1], g.b[1]) + tol < pointer[1])) continue;
    const d0 = segDistTo(pointer, g);
    if (d0 >= (footNear ? tol : best)) continue;
    const f = perpFoot(from, g);
    // the segment starting or ending at `from` itself: its foot is `from` - nothing to snap to
    if (!f || dist(f, from) < 1e-6) continue;
    const d = footNear ? dist(f, pointer) : d0;
    if (d >= best) continue;
    best = d;
    hit = { p: f, seg: g };
  }
  return hit;
}

// ---------------------------------------------------------------- window / crossing selection
const inBox = (b: Box, p: Pt) => p[0] >= b.x0 && p[0] <= b.x1 && p[1] >= b.y0 && p[1] <= b.y1;
const orient = (a: Pt, b: Pt, c: Pt) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function segsMeet(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  const on = (p: Pt, q: Pt, r: Pt) => Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  return (o1 === 0 && on(a, b, c)) || (o2 === 0 && on(a, b, d)) || (o3 === 0 && on(c, d, a)) || (o4 === 0 && on(c, d, b));
}
/** a segment ab touches the box (crosses an edge of it or lies in it) */
export function segTouchesBox(a: Pt, b: Pt, bx: Box): boolean {
  if (inBox(bx, a) || inBox(bx, b)) return true;
  if (Math.max(a[0], b[0]) < bx.x0 || Math.min(a[0], b[0]) > bx.x1 || Math.max(a[1], b[1]) < bx.y0 || Math.min(a[1], b[1]) > bx.y1) return false;
  const c: Pt[] = [[bx.x0, bx.y0], [bx.x1, bx.y0], [bx.x1, bx.y1], [bx.x0, bx.y1]];
  for (let i = 0; i < 4; i++) if (segsMeet(a, b, c[i], c[(i + 1) % 4])) return true;
  return false;
}

/**
 * Window (left -> right): the shape lies wholly inside the box. Crossing (right -> left): the box
 * touches it - crosses its outline, holds part of it, or (an area) lies inside it.
 */
export function boxPicks(s: Pick<Shape, 'k' | 'pts' | 'flat' | 'box' | 'holes'>, bx: Box, crossing: boolean): boolean {
  if (!crossing) return s.box.x0 >= bx.x0 && s.box.x1 <= bx.x1 && s.box.y0 >= bx.y0 && s.box.y1 <= bx.y1;
  if (s.box.x1 < bx.x0 || s.box.x0 > bx.x1 || s.box.y1 < bx.y0 || s.box.y0 > bx.y1) return false;
  if (s.k === 'pt') return s.pts.some((p) => inBox(bx, p));
  const f = s.flat;
  for (let i = 1; i < f.length; i++) if (segTouchesBox(f[i - 1], f[i], bx)) return true;
  if (s.k === 'poly') {
    if (f.length > 2 && segTouchesBox(f[f.length - 1], f[0], bx)) return true;
    // a cut-out's edge in the box: part of the area is in it
    for (const h of s.holes) for (let i = 0; i < h.length; i++) if (segTouchesBox(h[i], h[(i + 1) % h.length], bx)) return true;
    // the box inside the area (its fill)
    const c: Pt = [(bx.x0 + bx.x1) / 2, (bx.y0 + bx.y1) / 2];
    if (pointInPoly(c, f) && !s.holes.some((h) => pointInPoly(c, h))) return true;
  }
  return false;
}

// ---------------------------------------------------------------- nodes
/** the edge of a shape nearest to p (any ring; ring 0 = the outline, 1.. = cut-outs) and the point on it */
export function nearestEdge(s: Pick<Shape, 'k' | 'pts' | 'b' | 'holes'>, p: Pt): { ring: number; seg: number; q: Pt; d: number } | null {
  if (s.k === 'pt') return null;
  let best: { ring: number; seg: number; q: Pt; d: number } | null = null;
  const rings = [s.pts, ...s.holes];
  rings.forEach((r, ri) => {
    const closed = ri > 0 || s.k === 'poly';
    for (let i = 0; i < (closed ? r.length : r.length - 1); i++) {
      const g: Seg = { a: r[i], b: r[(i + 1) % r.length], bulge: ri === 0 ? s.b[i] || 0 : 0 };
      const n = nearestOnSeg(p, g);
      if (!best || n.d < best.d) best = { ring: ri, seg: i, q: n.q, d: n.d };
    }
  });
  return best;
}

/** where a new node goes on edge `seg` of ring `ring` near p: exactly on it (on the curve for an arc) */
export function nodeOnEdge(s: Pick<Shape, 'pts' | 'b' | 'holes'>, ring: number, seg: number, p: Pt): Pt {
  const r = ring === 0 ? s.pts : s.holes[ring - 1];
  const a = r[seg], b = r[(seg + 1) % r.length];
  const bulge = ring === 0 ? s.b[seg] || 0 : 0;
  if (bulge) return splitArc(a, b, bulge, p).p;
  return segDist(p, a, b).q;
}

/** a line's first / last node (an open line: a closed outline has no ends) */
export function isEndNode(s: Pick<Shape, 'k' | 'pts'>, ring: number, idx: number): boolean {
  if (s.k !== 'line' || ring !== 0 || s.pts.length < 2) return false;
  if (s.pts.length >= 3 && dist(s.pts[0], s.pts[s.pts.length - 1]) < 0.01) return false;
  return idx === 0 || idx === s.pts.length - 1;
}

/**
 * An end node moved so that the end segment is exactly `len` metres long, along its direction now
 * (an arc keeps its shape, scaled). `realLen`: the real length of a segment (scale, viewports).
 * null: not an end, nothing to go by (no scale, a zero-length segment).
 */
export function endNodeForLength(s: Pick<Shape, 'k' | 'pts' | 'b'>, idx: number, len: number, realLen: (a: Pt, b: Pt, bulge: number) => number | null): Pt | null {
  const n = s.pts.length;
  if (s.k !== 'line' || n < 2 || !(len > 0) || (idx !== 0 && idx !== n - 1)) return null;
  const nb = idx === 0 ? s.pts[1] : s.pts[n - 2];
  const end = s.pts[idx];
  const bulge = (idx === 0 ? s.b[0] : s.b[n - 2]) || 0;
  const cur = idx === 0 ? realLen(end, nb, bulge) : realLen(nb, end, bulge);
  if (cur === null || !(cur > 1e-9)) return null;
  // the segment scaled about the other end: lengths scale with it (also across and up-down scales,
  // and an arc with the same bulge)
  let k = len / cur;
  let q: Pt = [nb[0] + (end[0] - nb[0]) * k, nb[1] + (end[1] - nb[1]) * k];
  // a segment crossing a viewport's edge is not measured in proportion: a few more steps get it exact
  for (let i = 0; i < 4; i++) {
    const got = idx === 0 ? realLen(q, nb, bulge) : realLen(nb, q, bulge);
    if (got === null || !(got > 1e-9) || Math.abs(got - len) < 1e-9 * Math.max(1, len)) break;
    k *= len / got;
    q = [nb[0] + (end[0] - nb[0]) * k, nb[1] + (end[1] - nb[1]) * k];
  }
  return q;
}

// ---------------------------------------------------------------- walls and beams as bands
/** the real width (m) a segment of a wall / beam is drawn at; null = drawn as a line */
export function bandWidthOf(m: Pick<QtoModel, 'beamTypeById'>, it: TItem | undefined, s: Pick<Shape, 'k' | 'sg'>, seg: number): number | null {
  if (!it || s.k !== 'line') return null;
  if (it.kind === 'wall') return it.d && it.d > 0 ? it.d : null;
  if (it.kind === 'beam') {
    const tag = s.sg?.[seg] ?? null, bt = beamTypeOf(m, it, tag), w = tagOwn(tag).w ?? bt?.w;
    return w && w > 0 ? w : null;
  }
  return null;
}

/**
 * Half the band, in sheet points, across a segment running (ux, uy) (a unit vector on the sheet), at
 * the scale there: `sx` / `sy` metres per sheet point across / up-down.
 */
export function bandHalf(w: number, ux: number, uy: number, sx: number, sy: number): number {
  const nx = -uy, ny = ux;
  const m = Math.hypot(nx * sx, ny * sy);
  return m > 0 ? w / 2 / m : 0;
}

/** a run of a wall's / beam's segments drawn as one band: its outline ring(s) in sheet points */
export interface BandRun { rings: Pt[][]; color: string | null; w: number; sx: number; sy: number }

/**
 * The outline of a band `half` metres either side of a path (sheet points), at `sx` / `sy` metres per
 * sheet point across / up-down: one ring for an open path (butt ends, mitred corners), two (outside
 * and inside) for a closed one. Worked out in metres, so a band is as wide across as up-down in reality.
 */
export function bandOutline(path: Pt[], half: number, sx: number, sy: number, closed: boolean): Pt[][] {
  if (!(half > 0) || !(sx > 0) || !(sy > 0)) return [];
  // in metres, without repeated points (a closed path: without its repeated first point)
  const P: Pt[] = [];
  for (const [x, y] of path) {
    const q: Pt = [x * sx, y * sy];
    if (!P.length || dist(P[P.length - 1], q) > 1e-9) P.push(q);
  }
  if (closed && P.length > 2 && dist(P[0], P[P.length - 1]) < 1e-6) P.pop();
  if (P.length < 2 || (closed && P.length < 3)) closed = false;
  if (P.length < 2) return [];
  const n = P.length;
  const ns = closed ? n : n - 1;
  const nrm: Pt[] = [];
  for (let i = 0; i < ns; i++) {
    const a = P[i], b = P[(i + 1) % n];
    const L = dist(a, b) || 1;
    nrm.push([-(b[1] - a[1]) / L, (b[0] - a[0]) / L]);
  }
  const left: Pt[] = [], right: Pt[] = [];
  for (let j = 0; j < n; j++) {
    let o: Pt;
    const nPrev = closed ? nrm[(j - 1 + ns) % ns] : j > 0 ? nrm[j - 1] : null;
    const nNext = closed ? nrm[j % ns] : j < ns ? nrm[j] : null;
    if (!nPrev) o = [nNext![0] * half, nNext![1] * half];
    else if (!nNext) o = [nPrev[0] * half, nPrev[1] * half];
    else {
      const mx = nPrev[0] + nNext[0], my = nPrev[1] + nNext[1];
      const ml = Math.hypot(mx, my);
      if (ml < 1e-9) o = [nNext[0] * half, nNext[1] * half];
      else {
        const ux = mx / ml, uy = my / ml;
        const cos = ux * nNext[0] + uy * nNext[1];
        // (a very sharp corner: the mitre kept to 4× the half width)
        const k = Math.min(half / Math.max(cos, 1e-9), half * 4);
        o = [ux * k, uy * k];
      }
    }
    left.push([(P[j][0] + o[0]) / sx, (P[j][1] + o[1]) / sy]);
    right.push([(P[j][0] - o[0]) / sx, (P[j][1] - o[1]) / sy]);
  }
  return closed ? [left, right] : [[...left, ...right.reverse()]];
}

// ---------------------------------------------------------------- clearing a sheet's scale
/** the ops that take a sheet's own scale off (both directions); viewports keep theirs */
export function clearScaleOps(dwg: string, pg: number): Op[] {
  const k = 'pg:' + pageKey(dwg, pg);
  return ['sc', 'scl', 'scy', 'scyl', 'scy0', 'scyl0', 'w', 'h'].map((f) => [k, f, null] as Op);
}

/** the shapes on a sheet that would have no scale (no quantity) with the sheet's own scale cleared */
export function shapesLosingScale(m: Pick<QtoModel, 'pages' | 'regions' | 'shapesByPage'>, dwg: string, pg: number): Shape[] {
  const key = pageKey(dwg, pg);
  const pi = m.pages.get(key);
  if (!pi?.sc) return [];
  const pages = new Map(m.pages);
  pages.set(key, { ...pi, sc: null, scy: null });
  const without = { pages, regions: m.regions };
  return (m.shapesByPage.get(key) ?? []).filter((s) => s.k !== 'pt' && shapeQtyAt(m, s, null).scaled && !shapeQtyAt(without, s, null).scaled);
}
