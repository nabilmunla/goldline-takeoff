// v0.16 rooms ON THE DRAWING (group g1): the geometry the take-off view needs to draw a room and to edit
// it - no React here, so every rule can be unit-tested (tests/v16-g1.test.ts).
//
// - a length drawn for an additional wall finish / skirting runs ALONG the room's outline: its nodes are
//   projected onto the outline and the outline's own nodes between two of them are put in (the short way
//   round), so it follows the outline round a corner instead of cutting across it (alongOutline);
// - editing an outline (a node moved / deleted, an edge made an arc) takes its doors / openings and the
//   lengths drawn along it with it, so they stay where they were on their edges (outlineFollowOps);
// - moving, copying and deleting an outline does the same to what goes with it (withAttached...);
// - the edge flags (open edge, shadow gap) toggled from the drawing (edgeToggleOps);
// - what the eye toggles hide, with a room's own finishes (hiddenWithRooms).
import type { Op } from '../types';
import { nearestSeg, type QtoModel, type Shape } from './model';
import { arcPoints, dist, segDist, signedArea, type Pt } from './geometry';
import { copyShapesOps, replacePointsOps } from './ops';
import { attachedShapes, setEdgeOps, setShadowGapOps } from './roomops';
import { arcAt, arcFrac, edgeFlags, EDGE_GAP, EDGE_OPEN } from './rooms';
import type { Hidden } from './listops';

const EPS = 1e-6;
const r2 = (x: number) => Math.round(x * 100) / 100;
const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** is this shape a room's outline? */
export const isRoomOutline = (m: Pick<QtoModel, 'itemById'>, s: Pick<Shape, 'ti' | 'k'>) => s.k === 'poly' && m.itemById.get(s.ti)?.kind === 'room';

/** a segment tag as text for people: the edge flags (open edge '~o', shadow gap '~g') taken out */
export function tagText(t: string | null | undefined): string | null {
  if (!t) return null;
  const x = t.split(EDGE_OPEN).join('').split(EDGE_GAP).join('');
  return x || null;
}

/** the outlines of a room on one sheet (id order) */
export function roomOutlines(m: Pick<QtoModel, 'shapesByItem'>, roomId: string, dwg: string, pg: number): Shape[] {
  return (m.shapesByItem.get(roomId) ?? []).filter((s) => s.k === 'poly' && s.dwg === dwg && s.pg === pg);
}

/** the outline nearest to these points (summed over them; then by id) - as the engine files a stretch */
export function nearestOutline(outlines: Shape[], pts: Pt[]): Shape | null {
  let best: { s: Shape; d: number } | null = null;
  for (const s of outlines) {
    let d = 0;
    for (const p of pts) d += nearestSeg(s, p).d;
    if (!best || d < best.d - 1e-9) best = { s, d };
  }
  return best?.s ?? null;
}

/** the outline as a closed polyline (arcs as fine pieces) with, for each of its points, the length to it */
interface Ring { f: Pt[]; cum: number[]; T: number }
function ringOf(s: Pick<Shape, 'flat'>): Ring {
  const f = s.flat;
  const cum: number[] = [];
  let T = 0;
  for (let i = 0; i < f.length; i++) { cum.push(T); T += dist(f[i], f[(i + 1) % f.length]); }
  return { f, cum, T };
}
/** the point of a ring nearest p: where it is, how far along the ring, how far from p */
function onRing(r: Ring, p: Pt): { q: Pt; c: number; d: number } {
  let best = { q: r.f[0], c: 0, d: Infinity };
  for (let i = 0; i < r.f.length; i++) {
    const a = r.f[i], b = r.f[(i + 1) % r.f.length];
    const h = segDist(p, a, b);
    if (h.d < best.d - 1e-12) best = { q: h.q, c: r.cum[i] + h.t * dist(a, b), d: h.d };
  }
  return best;
}

/** the point of the outline nearest p (on an arc: on the arc itself) and how far it is (sheet points) */
export function projectOnOutline(s: Pick<Shape, 'flat'>, p: Pt): { q: Pt; d: number } {
  const h = onRing(ringOf(s), p);
  return { q: h.q, d: h.d };
}

/**
 * A length drawn along part of an outline, made to run along it: every node onto the outline, and the
 * outline's nodes (an arc's fine points too) between two nodes put in, the short way round. null = it
 * comes to nothing (every node on the same spot).
 */
export function alongOutline(s: Pick<Shape, 'flat'>, pts: Pt[]): Pt[] | null {
  const r = ringOf(s);
  if (r.f.length < 3 || r.T <= EPS || pts.length < 2) return null;
  const on = pts.map((p) => onRing(r, p));
  const out: Pt[] = [on[0].q];
  const push = (q: Pt) => { if (dist(out[out.length - 1], q) > EPS) out.push(q); };
  let total = 0;
  for (let i = 0; i + 1 < on.length; i++) {
    const a = on[i].c, b = on[i + 1].c;
    const fwd = (((b - a) % r.T) + r.T) % r.T;
    const forward = fwd <= r.T - fwd + EPS;
    const span = forward ? fwd : r.T - fwd;
    total += span;
    const mid: { k: number; rel: number }[] = [];
    for (let k = 0; k < r.f.length; k++) {
      const rel = forward ? (((r.cum[k] - a) % r.T) + r.T) % r.T : (((a - r.cum[k]) % r.T) + r.T) % r.T;
      if (rel > EPS && rel < span - EPS) mid.push({ k, rel });
    }
    mid.sort((x, y) => x.rel - y.rel);
    for (const x of mid) push(r.f[x.k]);
    push(on[i + 1].q);
  }
  return total > EPS && out.length >= 2 ? out : null;
}

/** which way an outline turns (+1 / -1): with insideNormal, the side of its edges that is inside */
export const insideSign = (s: Pick<Shape, 'flat'>) => (signedArea(s.flat) >= 0 ? 1 : -1);
/** unit normal of the segment a -> b of an outline, pointing into it (k: insideSign of the outline) */
export function insideNormal(s: Pick<Shape, 'flat'>, a: Pt, b: Pt, k = insideSign(s)): Pt {
  const L = dist(a, b) || 1;
  return [(-(b[1] - a[1]) / L) * k, ((b[0] - a[0]) / L) * k];
}

/** where (segment, along its chord) a point lies on the outline, if it is on it (within tol sheet points) */
const paramOn = (s: Shape, p: Pt, tol: number) => { const n = nearestSeg(s, p); return n.d <= tol ? n : null; };

export type OutlineEdit =
  | { k: 'move'; idx: number; p: Pt }
  | { k: 'delete'; idx: number }
  | { k: 'bulge'; seg: number; b: number };

/**
 * A room outline is edited (outer ring): its doors / openings and the additional finish lengths drawn
 * along it keep their place on their edges - on the edges next to a node moved, the same fraction along
 * them; on the two edges a deleted node joins, the same fraction of the way along the new one. Inserting
 * a node changes no edge, so nothing follows. Returns the ops to commit WITH the outline's own.
 */
export function outlineFollowOps(m: Pick<QtoModel, 'itemById' | 'shapesByItem' | 'roomParts' | 'openingsByShape'>, s: Shape, e: OutlineEdit): Op[] {
  if (!isRoomOutline(m, s)) return [];
  const n = s.pts.length;
  if (n < 3) return [];
  const B = Array.from({ length: n }, (_, i) => s.b[i] || 0);
  // the new place of what is at p (segment seg, chord parameter t) - null: it stays where it is. On an arc it keeps
  // its fraction of the way round (by angle: the chord parameter of a point far round a half circle is near its end)
  const nxt = (i: number) => (i + 1) % n;
  const frac = (seg: number, t: number, p: Pt) => (B[seg] ? arcFrac(s.pts[seg], s.pts[nxt(seg)], B[seg], p) : t);
  let at: (seg: number, t: number, p: Pt) => Pt | null;
  if (e.k === 'move') {
    const np = s.pts.map((q, i) => (i === e.idx ? e.p : q));
    const prev = (e.idx - 1 + n) % n;
    at = (seg, t, p) => (seg === e.idx || seg === prev ? arcAt(np[seg], np[nxt(seg)], B[seg], frac(seg, t, p)) : null);
  } else if (e.k === 'bulge') {
    at = (seg, t, p) => (seg === e.seg ? arcAt(s.pts[seg], s.pts[nxt(seg)], e.b, frac(seg, t, p)) : null);
  } else {
    if (n - 1 < 3) return [];
    const p = (e.idx - 1 + n) % n, nx = (e.idx + 1) % n;
    const L1 = dist(s.pts[p], s.pts[e.idx]), L2 = dist(s.pts[e.idx], s.pts[nx]);
    const L = L1 + L2 || 1;
    // (the merged edge is straight: deleteVertexOps gives it no bulge)
    at = (seg, t, q) => (seg === p ? lerp(s.pts[p], s.pts[nx], (frac(seg, t, q) * L1) / L) : seg === e.idx ? lerp(s.pts[p], s.pts[nx], (L1 + frac(seg, t, q) * L2) / L) : null);
  }
  const ops: Op[] = [];
  for (const o of m.openingsByShape.get(s.id) ?? []) {
    if (!o.room) continue;
    const q = at(o.seg, o.t, [o.x, o.y]);
    if (q && dist(q, [o.x, o.y]) > 0.005) ops.push([o.id, 'x', r2(q[0])], [o.id, 'y', r2(q[1])]);
  }
  // (only the nodes ON the outline follow: within half a point - a length drawn along it is exactly on it)
  for (const ln of attachedShapes(m as QtoModel, s)) {
    if (ln.k !== 'line') continue;
    let changed = false;
    const np = ln.pts.map((q) => {
      const h = paramOn(s, q, 0.5);
      const w = h ? at(h.seg, h.t, q) : null;
      if (w && dist(w, q) > 1e-4) { changed = true; return w; }
      return q;
    });
    if (changed) ops.push(...replacePointsOps(ln, np, ln.b));
  }
  return ops;
}

/** shapes to move with these: the additional finishes / ceiling areas of each room outline in them */
export function withAttached(m: QtoModel, shapes: Shape[]): Shape[] {
  const ids = new Set(shapes.map((s) => s.id));
  const out = [...shapes];
  for (const s of shapes) {
    if (!isRoomOutline(m, s)) continue;
    for (const a of attachedShapes(m, s)) if (!ids.has(a.id)) { ids.add(a.id); out.push(a); }
  }
  return out;
}

/** copies (Alt+drag, Copy to other sheets): room outlines with their doors / openings and what goes with them */
export function copyWithRoomsOps(m: QtoModel, shapes: Shape[], to: { dwg: string; pg: number; rv?: string }, by: string, dx = 0, dy = 0): { ids: string[]; ops: Op[] } {
  return copyShapesOps(withAttached(m, shapes), to, by, dx, dy, undefined, m.openingsByShape);
}

/** delete shapes; a room outline takes its doors / openings and the finishes drawn along / inside it */
export function deleteShapesOps(m: QtoModel, ids: string[]): Op[] {
  const byId = new Map(m.shapes.map((s) => [s.id, s]));
  const list = ids.map((id) => byId.get(id)).filter((s): s is Shape => !!s);
  const ops: Op[] = [];
  const done = new Set<string>();
  for (const s of withAttached(m, list)) {
    if (done.has(s.id)) continue;
    done.add(s.id);
    ops.push([s.id, 'del', true]);
    if (isRoomOutline(m, s)) for (const o of m.openingsByShape.get(s.id) ?? []) ops.push([o.id, 'del', true]);
  }
  return ops;
}

/** may this shape's edges carry this flag? open: a room outline; shadow gap: an outline or a ceiling area of a room */
export function edgeFlagFits(m: QtoModel, s: Shape, flag: 'open' | 'gap'): boolean {
  if (s.k !== 'poly') return false;
  if (isRoomOutline(m, s)) return true;
  if (flag !== 'gap') return false;
  const it = m.itemById.get(s.ti);
  return !!it && (it.rk === 'ceil' || (it.rk === 'add' && m.fin.partById.get(it.id)?.cat === 'ceiling' && !m.fin.partById.get(it.id)?.ak));
}

/**
 * An edge marked / unmarked "Open edge (no wall)" or "Shadow gap here" (one step). An edge with a door or
 * an opening on it cannot be made open (doors go on wall edges only). A shadow gap picked while the room's
 * shadow gap is off or "Entire perimeter" turns it to the picked edges.
 */
export function edgeToggleOps(m: QtoModel, s: Shape, seg: number, flag: 'open' | 'gap'): { ops: Op[]; on: boolean } | { error: string } {
  if (!edgeFlagFits(m, s, flag)) return { error: flag === 'open' ? 'Only the edges of a room can be open.' : 'Shadow gaps go on a room’s edges or its ceiling areas.' };
  if (seg < 0 || seg >= s.pts.length) return { error: 'No edge there.' };
  const f = edgeFlags(s.sg[seg]);
  const on = flag === 'open' ? !f.open : !f.gap;
  if (flag === 'open' && on && (m.openingsByShape.get(s.id) ?? []).some((o) => o.room && o.seg === seg)) return { error: 'This edge has a door or an opening on it: remove it first (doors and openings go on wall edges only).' };
  const ops = setEdgeOps(s, [seg], flag, on);
  if (flag === 'gap' && on) {
    const it = m.itemById.get(s.ti);
    const roomId = it?.kind === 'room' ? it.id : it?.rm ?? '';
    const room = m.fin.roomById.get(roomId);
    if (room && room.gm !== 'pick') ops.push(...setShadowGapOps(m, roomId, 'pick'));
  }
  return { ops, on };
}

/** a door / an opening clicked onto a room's outline at p: why it can't go there (an open edge), else null */
export function roomDoorRefusal(m: Pick<QtoModel, 'shapes' | 'itemById'>, shapeId: string, p: Pt): string | null {
  const s = m.shapes.find((x) => x.id === shapeId);
  if (!s || !isRoomOutline(m, s)) return null;
  return edgeFlags(s.sg[nearestSeg(s, p).seg]).open ? 'This edge is open (no wall): doors and openings go on wall edges only.' : null;
}

/** the edge of these shapes nearest p, within tol sheet points */
export function edgeAt(shapes: Shape[], p: Pt, tol: number): { shape: Shape; seg: number; d: number } | null {
  let best: { shape: Shape; seg: number; d: number } | null = null;
  for (const s of shapes) {
    if (s.k !== 'poly') continue;
    if (p[0] < s.box.x0 - tol || p[0] > s.box.x1 + tol || p[1] < s.box.y0 - tol || p[1] > s.box.y1 + tol) continue;
    const h = nearestSeg(s, p);
    if (h.d <= tol && (!best || h.d < best.d)) best = { shape: s, seg: h.seg, d: h.d };
  }
  return best;
}

/** what is hidden on the drawing, with rooms: a room's own finishes (additional, ceiling areas) go with
 *  their room's eye, or have their own (their id in the hidden take-offs) */
export function hiddenWithRooms(m: Pick<QtoModel, 'roomParts'>, base: Set<string>, h: Hidden): Set<string> {
  let out = base;
  for (const [room, parts] of m.roomParts) {
    for (const p of parts) {
      if (out.has(p) || !(base.has(room) || h.items.has(p))) continue;
      if (out === base) out = new Set(base);
      out.add(p);
    }
  }
  return out;
}
