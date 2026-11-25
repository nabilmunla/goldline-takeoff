// v0.16.1 doors that are not on a wall (concrete cores, drywall / glass partitions): counted with the Count tool's
// door mode into a DOOR COUNTER - a count take-off with `dc` whose points each carry `door` (the schedule row).
// They count in the door schedule ("Placed") like doors on walls, so the schedule row's BOQ link takes them; the
// counter itself has no BOQ link of its own (it would count them twice). No lintel. Its doors can be deducted from
// an area / length take-off (Deduct openings from…) at each door's schedule size.
import type { Op } from '../types';
import { scaleAt, type QtoModel } from './model';
import { newItemOps, shapeOps } from './ops';
import type { Pt } from './geometry';

export const DOOR_COUNTER_NAME = 'Doors (not on walls)';

/** the door counter new doors go into: the active one, else the project's first shared one, else a new one */
export function doorCounterOps(m: QtoModel, by: string, par: string, active?: string | null): { id: string; ops: Op[] } {
  const a = active ? m.itemById.get(active) : undefined;
  if (a?.dc) return { id: a.id, ops: [] };
  const found = m.items.find((it) => it.dc && !it.priv);
  if (found) return { id: found.id, ops: [] };
  const r = newItemOps(m, by, 'count', undefined, par);
  const ops = r.ops.map((o) => (o[0] === r.id && o[1] === 'name' ? ([o[0], o[1], DOOR_COUNTER_NAME] as Op) : o));
  ops.push([r.id, 'dc', true]);
  return { id: r.id, ops };
}

/** one door counted at p on a sheet */
export function doorCountOps(ti: string, dwg: string, pg: number, p: Pt, door: string, by: string, rv = ''): { id: string; ops: Op[] } {
  const r = shapeOps(ti, dwg, pg, 'pt', [p], by, 1, rv);
  r.ops.push([r.id, 'door', door]);
  return r;
}

/** how close (sheet points) two marks of one door must be to be the same door: 0.5 m at the scale there, else 20 pt */
export function sameDoorTol(m: QtoModel, dwg: string, pg: number, p: Pt): number {
  const sc = scaleAt(m, dwg, pg, p);
  return sc.sc ? 0.5 / sc.sc : 20;
}

/**
 * null when that door can be counted at p; else why not: the same door is already there - placed on a wall,
 * or counted with a door counter (a click twice, or Count by tag run twice).
 */
export function doorCountRefusal(m: QtoModel, dwg: string, pg: number, p: Pt, door: string): string | null {
  const tol = sameDoorTol(m, dwg, pg, p);
  const tag = m.doorById.get(door)?.tag ?? 'That door';
  const near = (q: Pt) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= tol;
  for (const o of m.openings) {
    if (o.k !== 'door' || o.door !== door) continue;
    const s = m.shapes.find((x) => x.id === o.sh);
    if (s && s.dwg === dwg && s.pg === pg && near([o.x, o.y])) return `${tag} is already counted here, on the wall.`;
  }
  for (const s of m.shapes) {
    if (s.k !== 'pt' || s.door !== door || s.dwg !== dwg || s.pg !== pg) continue;
    if (near(s.pts[0])) return `${tag} is already counted here.`;
  }
  return null;
}
