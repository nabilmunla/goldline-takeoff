// Plane geometry for take-off shapes.
// All shape coordinates are in "sheet points": the page as you see it (rotation
// applied), origin top-left, 1 unit = 1 PDF point (1/72 inch on the paper).
// Zoom and render quality never change these numbers, so a quantity can only
// change when somebody changes a shape or a scale.

export type Pt = [number, number];

/** flat [x0,y0,x1,y1,...] -> points */
export function toPts(flat: number[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

/**
 * Points as kept in the project: to 0.001 pt (0.35 µm on the paper). Until v0.12.2 it was 0.01 pt,
 * which at 1:500 is up to 2 mm in reality per corner - a typed 3.5 m could come back 3.498 m with
 * 3 decimals shown. Shapes kept at 0.01 pt stay as they are.
 */
export function toFlat(pts: Pt[]): number[] {
  const out: number[] = [];
  for (const [x, y] of pts) out.push(round3(x), round3(y));
  return out;
}
const round3 = (x: number) => Math.round(x * 1000) / 1000;

export const round2 = (x: number) => Math.round(x * 100) / 100;

/** signed area (shoelace); positive = counter-clockwise in a y-down system means clockwise on screen */
export function signedArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export const polyArea = (p: Pt[]) => (p.length < 3 ? 0 : Math.abs(signedArea(p)));

export function polyLength(p: Pt[], closed = false): number {
  let l = 0;
  for (let i = 1; i < p.length; i++) l += dist(p[i - 1], p[i]);
  if (closed && p.length > 2) l += dist(p[p.length - 1], p[0]);
  return l;
}

export const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);

export function pointInPoly(pt: Pt, poly: Pt[]): boolean {
  let inside = false;
  const [x, y] = pt;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** distance from p to segment ab, and the closest point on it */
export function segDist(p: Pt, a: Pt, b: Pt): { d: number; q: Pt; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const q: Pt = [a[0] + t * dx, a[1] + t * dy];
  return { d: dist(p, q), q, t };
}

/** distance from p to a polyline (or closed polygon outline) */
export function polylineDist(p: Pt, pts: Pt[], closed: boolean): number {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, segDist(p, pts[i - 1], pts[i]).d);
  if (closed && pts.length > 2) best = Math.min(best, segDist(p, pts[pts.length - 1], pts[0]).d);
  if (pts.length === 1) best = dist(p, pts[0]);
  return best;
}

export interface Box { x0: number; y0: number; x1: number; y1: number }

export function bbox(pts: Pt[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

export const boxHit = (b: Box, p: Pt, pad = 0) => p[0] >= b.x0 - pad && p[0] <= b.x1 + pad && p[1] >= b.y0 - pad && p[1] <= b.y1 + pad;

/** area-weighted centroid of a polygon (falls back to the vertex average) */
export function centroid(p: Pt[]): Pt {
  const a = signedArea(p);
  if (Math.abs(a) < 1e-9) {
    const n = p.length || 1;
    return [p.reduce((s, q) => s + q[0], 0) / n, p.reduce((s, q) => s + q[1], 0) / n];
  }
  let cx = 0, cy = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % n];
    const f = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  return [cx / (6 * a), cy / (6 * a)];
}

/**
 * Constrain the next point to horizontal / vertical / 45° from the previous one
 * (hold Shift while drawing). Angles are on the sheet as shown.
 */
export function ortho(prev: Pt, p: Pt): Pt {
  const dx = p[0] - prev[0];
  const dy = p[1] - prev[1];
  const ang = Math.atan2(dy, dx);
  const step = Math.PI / 4;
  const a = Math.round(ang / step) * step;
  const len = Math.hypot(dx, dy) * Math.cos(ang - a);
  return [prev[0] + Math.cos(a) * len, prev[1] + Math.sin(a) * len];
}

/** points per metre on the paper: 1 pt = 25.4/72 mm */
export const PT_MM = 25.4 / 72;

/** metres in reality for one sheet point, at a drawing scale 1:n printed on its true paper size */
export const scaleFromRatio = (n: number) => (PT_MM / 1000) * n;

/** "1:n" for a scale in metres per point, if it is (nearly) a whole ratio */
export function ratioOf(mPerPt: number): number | null {
  const n = mPerPt / (PT_MM / 1000);
  const r = Math.round(n);
  return r > 0 && Math.abs(n - r) / r < 0.002 ? r : null;
}

export const STANDARD_SCALES = [1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 750, 1000, 1250, 1500, 2000, 2500, 5000];

/** Finds "SCALE 1:100" style marks in text (title blocks, viewport labels). Most frequent first. */
export function scalesInText(text: string): number[] {
  const counts = new Map<number, number>();
  const re = /(?:scale|sc\.?)\s*[:=]?\s*1\s*[:/]\s*(\d{1,5})(?![\d.])/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 10000) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map((e) => e[0]);
}

// ---------------------------------------------------------------- arcs
// A segment from a to b can be an arc. It is stored as its "bulge" (as in DXF/AutoCAD
// polylines): b = tan(θ/4), θ = the angle the arc turns through, signed (positive =
// the direction in which angles grow on the sheet). 0 = straight, ±1 = half circle.
// Quantities use the exact arc; drawing and hit tests use a fine polyline of it.

/** included angle (signed) of a segment with bulge `b` */
export const arcAngle = (b: number) => 4 * Math.atan(b);

/** centre and radius of the arc a -> b with bulge `b` (null when straight) */
export function arcCircle(a: Pt, b: Pt, bulge: number): { c: Pt; r: number; a0: number; th: number } | null {
  if (!bulge || Math.abs(bulge) < 1e-9) return null;
  const th = arcAngle(bulge);
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const ch = Math.hypot(dx, dy);
  if (ch < 1e-12) return null;
  const h = ch / 2 / Math.tan(th / 2); // signed distance from the chord's middle to the centre
  const c: Pt = [(a[0] + b[0]) / 2 - (dy / ch) * h, (a[1] + b[1]) / 2 + (dx / ch) * h];
  const r = ch / 2 / Math.abs(Math.sin(th / 2));
  return { c, r, a0: Math.atan2(a[1] - c[1], a[0] - c[0]), th };
}

/** the bulge of the arc that starts at a, ends at b and passes through p (0 if they are in line) */
export function bulgeThrough(a: Pt, b: Pt, p: Pt): number {
  // signed angle at p, between p->a and p->b: the arc's angle is 2·(π − that)
  const ax = a[0] - p[0], ay = a[1] - p[1], bx = b[0] - p[0], by = b[1] - p[1];
  // p on an end: no arc to speak of (the angle there is noise)
  const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (Math.hypot(ax, ay) < chord * 1e-3 || Math.hypot(bx, by) < chord * 1e-3) return 0;
  const cross = ax * by - ay * bx;
  const dot = ax * bx + ay * by;
  if (Math.abs(cross) < 1e-9 * (Math.hypot(ax, ay) * Math.hypot(bx, by) + 1e-12)) return 0;
  const ang = Math.atan2(cross, dot); // in (-π, π)
  const th = 2 * (Math.sign(ang) * Math.PI - ang);
  // p on the arc: the arc turns the other way round from the chord than p's angle says
  // (kept short of a full circle, where the bulge runs away to infinity)
  const lim = Math.tan((175 / 180) * (Math.PI / 2));
  return Math.max(-lim, Math.min(lim, Math.tan(-th / 4)));
}

/** points along the arc (a excluded, b included) */
export function arcPoints(a: Pt, b: Pt, bulge: number, step = Math.PI / 96): Pt[] {
  const k = arcCircle(a, b, bulge);
  if (!k) return [b];
  const n = Math.max(4, Math.ceil(Math.abs(k.th) / step));
  const out: Pt[] = [];
  for (let i = 1; i < n; i++) {
    const t = k.a0 + (k.th * i) / n;
    out.push([k.c[0] + k.r * Math.cos(t), k.c[1] + k.r * Math.sin(t)]);
  }
  out.push(b);
  return out;
}

/** the middle point of the segment a -> b (on the arc when it is one) */
export function segMid(a: Pt, b: Pt, bulge: number): Pt {
  const k = arcCircle(a, b, bulge);
  if (!k) return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const t = k.a0 + k.th / 2;
  return [k.c[0] + k.r * Math.cos(t), k.c[1] + k.r * Math.sin(t)];
}

export function segLength(a: Pt, b: Pt, bulge: number): number {
  const k = arcCircle(a, b, bulge);
  return k ? k.r * Math.abs(k.th) : dist(a, b);
}

const bAt = (bul: number[] | undefined, i: number) => (bul && bul[i]) || 0;
export const hasArcs = (bul: number[] | undefined) => !!bul && bul.some((x) => Math.abs(x) > 1e-9);

/** the outline as a fine polyline (closed outlines: the closing arc included, last point not repeated) */
export function flatten(pts: Pt[], bul: number[] | undefined, closed: boolean): Pt[] {
  if (!hasArcs(bul) || pts.length < 2) return pts;
  const out: Pt[] = [pts[0]];
  const n = pts.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const b = bAt(bul, i);
    const nx = pts[(i + 1) % n];
    if (Math.abs(b) > 1e-9) out.push(...arcPoints(pts[i], nx, b));
    else out.push(nx);
  }
  if (closed) out.pop(); // back at the first point
  return out;
}

/** exact length of a polyline with arcs */
export function pathLength(pts: Pt[], bul: number[] | undefined, closed = false): number {
  let l = 0;
  const n = pts.length;
  for (let i = 0; i < n - 1; i++) l += segLength(pts[i], pts[i + 1], bAt(bul, i));
  if (closed && n > 1 && !(n === 2 && !hasArcs(bul))) l += segLength(pts[n - 1], pts[0], bAt(bul, n - 1));
  return l;
}

/** exact area enclosed by a closed outline with arcs */
export function pathArea(pts: Pt[], bul: number[] | undefined): number {
  if (!hasArcs(bul)) return polyArea(pts);
  const n = pts.length;
  let a = n >= 3 ? signedArea(pts) : 0;
  for (let i = 0; i < n; i++) {
    const k = arcCircle(pts[i], pts[(i + 1) % n], bAt(bul, i));
    if (k) a += ((k.r * k.r) / 2) * (k.th - Math.sin(k.th));
  }
  return Math.abs(a);
}

// ---------------------------------------------------------------- separate X / Y scales
// A drawing can have a different scale up-down (Y) than across (X): a long section drawn with its
// heights exaggerated, a sheet printed stretched (the PDF Editor's split scale, v0.12.5). Lengths are
// then measured with Y stretched to the X scale; an area is the plain area times the ratio (exact:
// the stretch is affine); an arc becomes part of an ellipse, followed in fine chords.

/** how much a sheet point counts up-down compared with across (1 = the same scale both ways) */
export const yRatio = (sc: number | null | undefined, scy: number | null | undefined): number => (sc && scy && sc > 0 && scy > 0 && Math.abs(scy / sc - 1) > 1e-9 ? scy / sc : 1);

/** a segment's length with Y counted `ry` times (in X-scale sheet points) */
export function segLengthY(a: Pt, b: Pt, bulge: number, ry: number): number {
  if (ry === 1) return segLength(a, b, bulge);
  if (!bulge || Math.abs(bulge) < 1e-9) return Math.hypot(b[0] - a[0], (b[1] - a[1]) * ry);
  let l = 0;
  let p = a;
  for (const q of arcPoints(a, b, bulge, Math.PI / 720)) { l += Math.hypot(q[0] - p[0], (q[1] - p[1]) * ry); p = q; }
  return l;
}

/** pathLength with Y counted `ry` times */
export function pathLengthY(pts: Pt[], bul: number[] | undefined, closed: boolean, ry: number): number {
  if (ry === 1) return pathLength(pts, bul, closed);
  let l = 0;
  const n = pts.length;
  for (let i = 0; i < n - 1; i++) l += segLengthY(pts[i], pts[i + 1], bAt(bul, i), ry);
  if (closed && n > 1 && !(n === 2 && !hasArcs(bul))) l += segLengthY(pts[n - 1], pts[0], bAt(bul, n - 1), ry);
  return l;
}

/** polyLength with Y counted `ry` times */
export function polyLengthY(p: Pt[], closed: boolean, ry: number): number {
  if (ry === 1) return polyLength(p, closed);
  let l = 0;
  for (let i = 1; i < p.length; i++) l += Math.hypot(p[i][0] - p[i - 1][0], (p[i][1] - p[i - 1][1]) * ry);
  if (closed && p.length > 2) l += Math.hypot(p[0][0] - p[p.length - 1][0], (p[0][1] - p[p.length - 1][1]) * ry);
  return l;
}

/** "1:100", or "X 1:100 · Y 1:20" when up-down has a scale of its own */
export function scaleText(sc: number | null, label: string, scy?: number | null, labelY?: string): string {
  if (!sc) return '';
  const lx = label || (ratioOf(sc) ? '1:' + ratioOf(sc) : 'calibrated');
  if (yRatio(sc, scy) === 1) return lx;
  const ly = labelY || (ratioOf(scy!) ? '1:' + ratioOf(scy!) : 'calibrated');
  return `X ${lx} · Y ${ly}`;
}

/** cut an arc at (the point of the arc nearest to) p: that point and the two halves' bulges */
export function splitArc(a: Pt, b: Pt, bulge: number, p: Pt): { p: Pt; b: [number, number] } {
  const k = arcCircle(a, b, bulge);
  if (!k) return { p, b: [0, 0] };
  let d = Math.atan2(p[1] - k.c[1], p[0] - k.c[0]) - k.a0;
  // angle travelled from a in the arc's direction
  const tw = 2 * Math.PI;
  d = ((d % tw) + tw) % tw;
  if (k.th < 0) d = d - tw;
  let f = d / k.th;
  if (f < 0 || f > 1) f = dist(p, a) <= dist(p, b) ? 0 : 1; // beyond the arc: the nearer end
  f = Math.max(0, Math.min(1, f));
  const t = k.a0 + k.th * f;
  return { p: [k.c[0] + k.r * Math.cos(t), k.c[1] + k.r * Math.sin(t)], b: [Math.tan((k.th * f) / 4), Math.tan((k.th * (1 - f)) / 4)] };
}

// ---- outline checks (cut-outs inside their area, outlines that cross themselves)
const orient = (a: Pt, b: Pt, c: Pt) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
/** segments ab and cd cross (touching at an end does not count) */
export function segsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  const e = 1e-9;
  return ((o1 > e && o2 < -e) || (o1 < -e && o2 > e)) && ((o3 > e && o4 < -e) || (o3 < -e && o4 > e));
}
const edges = (p: Pt[], closed: boolean): [Pt, Pt][] => {
  const out: [Pt, Pt][] = [];
  for (let i = 1; i < p.length; i++) out.push([p[i - 1], p[i]]);
  if (closed && p.length > 2) out.push([p[p.length - 1], p[0]]);
  return out;
};
/** an outline whose sides cross each other (a figure of eight): its area is meaningless */
export function selfCrosses(p: Pt[], closed = true): boolean {
  const es = edges(p, closed);
  if (es.length > 3000) return false; // a traced curve: too many sides to check, assume fine
  for (let i = 0; i < es.length; i++)
    for (let j = i + 2; j < es.length; j++) {
      if (closed && i === 0 && j === es.length - 1) continue; // neighbours through the closing side
      if (segsCross(es[i][0], es[i][1], es[j][0], es[j][1])) return true;
    }
  return false;
}
function anyCross(a: Pt[], b: Pt[]): boolean {
  const ea = edges(a, true), eb = edges(b, true);
  for (const [p, q] of ea) for (const [r, s] of eb) if (segsCross(p, q, r, s)) return true;
  return false;
}
/** on a side of the outline (within tol sheet points: points are stored to 0.01) */
function onEdge(p: Pt, poly: Pt[], tol: number): boolean {
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if (segDist(p, poly[j], poly[i]).d <= tol) return true;
  return false;
}
/** 'in', 'on' (a side) or 'out' - the same answer on every side of the outline (left or right, top or bottom) */
export function whereIn(p: Pt, poly: Pt[], tol = 0.02): 'in' | 'on' | 'out' {
  if (onEdge(p, poly, tol)) return 'on';
  return pointInPoly(p, poly) ? 'in' : 'out';
}
/** test points of an outline: its corners and the middles of its sides */
const probes = (p: Pt[]): Pt[] => [...p, ...edges(p, true).map(([a, b]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as Pt)];
/** inner lies wholly inside outer (touching its sides is fine: a shaft against a wall) */
export function polyInside(inner: Pt[], outer: Pt[]): boolean {
  if (inner.length < 3 || outer.length < 3) return false;
  if (probes(inner).some((p) => whereIn(p, outer) === 'out')) return false;
  if (inner.length * outer.length <= 4e6 && anyCross(inner, outer)) return false;
  // all on the sides (the same outline twice): its middle must be inside
  if (inner.every((p) => whereIn(p, outer) === 'on')) return whereIn(centroid(inner), outer) !== 'out';
  return true;
}
/** two outlines share some area (side by side, touching, is not overlapping; the same outline twice is) */
export function polysOverlap(a: Pt[], b: Pt[]): boolean {
  if (a.length < 3 || b.length < 3) return false;
  if (a.length * b.length <= 4e6 && anyCross(a, b)) return true;
  if (probes(a).some((p) => whereIn(p, b) === 'in') || probes(b).some((p) => whereIn(p, a) === 'in')) return true;
  // every corner and middle on the other's sides: the same outline (or one inside the other edge to edge)
  return whereIn(centroid(a), b) === 'in' || whereIn(centroid(b), a) === 'in';
}
