// Changing what a BOQ line IS (heading / item / description line) and its level,
// without ever changing the order lines appear in. Each change is a single batch,
// so one Undo reverts it completely.
//
//  Make heading   : the line becomes a heading; the lines after it (up to the next
//                   heading at the same level) move under it.
//  Make item/desc : a heading turns into a plain line; whatever was under it moves up
//                   one level, staying exactly where it was on screen.
//  Level down     : the line moves into the heading directly above it (same level).
//  Level up       : the line moves out of its heading. A heading takes the lines after
//                   it along (they become its content); a plain line can only level up
//                   if it is the last line under its heading.
import { generateNKeysBetween } from 'fractional-indexing';
import { UNFILED, type BoqModel, type BoqNode, type NodeType } from './boq';
import type { Op } from './types';

export function siblingsOf(model: BoqModel, parent: string | null): BoqNode[] {
  if (parent) return model.byId.get(parent)?.children ?? [];
  return model.roots.filter((r) => r.id !== UNFILED);
}

/** Sort keys for `count` new rows placed right after sibs[afterIndex]; re-keys the tail if keys collide. */
function keysAfter(sibs: BoqNode[], afterIndex: number, count: number): { keys: string[]; tailOps: Op[] } {
  const lo = afterIndex >= 0 ? sibs[afterIndex].ord || null : null;
  const next = sibs[afterIndex + 1];
  const hi = next ? next.ord || null : null;
  try {
    if (lo !== null && hi !== null && lo >= hi) throw new Error('collision');
    return { keys: generateNKeysBetween(lo, hi, count), tailOps: [] };
  } catch {
    // keys were equal or broken (e.g. two people inserted at the same spot): re-key everything after
    const tail = sibs.slice(afterIndex + 1);
    const all = generateNKeysBetween(lo && lo < '￿' ? lo : null, null, count + tail.length);
    return { keys: all.slice(0, count), tailOps: tail.map((t, i) => [t.id, 'ord', all[count + i]] as Op) };
  }
}

export function canChangeType(n: BoqNode | null | undefined): boolean {
  return !!n && n.id !== UNFILED;
}

export function changeTypeOps(model: BoqModel, id: string, to: NodeType): Op[] {
  const n = model.byId.get(id);
  if (!n || n.type === to || n.id === UNFILED) return [];
  const ops: Op[] = [];
  if (to === 'group') {
    // following plain lines (until the next heading) move under the new heading
    const sibs = siblingsOf(model, n.parent);
    const i = sibs.findIndex((x) => x.id === id);
    for (let k = i + 1; k < sibs.length && sibs[k].type !== 'group'; k++) ops.push([sibs[k].id, 'parent', id]);
    ops.push([id, 'type', 'group']);
    return ops;
  }
  if (n.type === 'group') {
    // contents move up one level and stay exactly where they were on screen
    const sibs = siblingsOf(model, n.parent);
    const i = sibs.findIndex((x) => x.id === id);
    const kids = n.children;
    if (kids.length) {
      const { keys, tailOps } = keysAfter(sibs, i, kids.length);
      kids.forEach((c, k) => {
        ops.push([c.id, 'parent', n.parent], [c.id, 'ord', keys[k]]);
      });
      ops.push(...tailOps);
    }
  }
  ops.push([id, 'type', to]);
  return ops;
}

export function canIndent(model: BoqModel, id: string): boolean {
  const n = model.byId.get(id);
  if (!n) return false;
  const sibs = siblingsOf(model, n.parent);
  const i = sibs.findIndex((x) => x.id === id);
  return i > 0 && sibs[i - 1].type === 'group';
}

/** Level down: move into the heading directly above (at the same level), as its last line. */
export function indentOps(model: BoqModel, id: string): Op[] {
  const n = model.byId.get(id);
  if (!n || !canIndent(model, id)) return [];
  const sibs = siblingsOf(model, n.parent);
  const target = sibs[sibs.findIndex((x) => x.id === id) - 1];
  const { keys, tailOps } = keysAfter(target.children, target.children.length - 1, 1);
  return [[id, 'parent', target.id], [id, 'ord', keys[0]], ...tailOps];
}

export function canOutdent(model: BoqModel, id: string): boolean {
  const n = model.byId.get(id);
  if (!n || !n.parent) return false;
  const p = model.byId.get(n.parent);
  if (!p) return false;
  if (n.type === 'group') return true;
  const sibs = p.children;
  return sibs[sibs.length - 1]?.id === id;
}

/** Level up: move out of the parent heading, right after it. */
export function outdentOps(model: BoqModel, id: string): Op[] {
  const n = model.byId.get(id);
  if (!n || !n.parent || !canOutdent(model, id)) return [];
  const p = model.byId.get(n.parent)!;
  const ops: Op[] = [];
  const outer = siblingsOf(model, p.parent);
  const pi = outer.findIndex((x) => x.id === p.id);
  const { keys, tailOps } = keysAfter(outer, pi, 1);
  ops.push([id, 'parent', p.parent], [id, 'ord', keys[0]], ...tailOps);
  if (n.type === 'group') {
    // lines that came after it under the old heading now belong to it
    const i = p.children.findIndex((x) => x.id === id);
    const following = p.children.slice(i + 1);
    if (following.length) {
      const own = n.children;
      const r = keysAfter(own, own.length - 1, following.length);
      following.forEach((f, k) => ops.push([f.id, 'parent', id], [f.id, 'ord', r.keys[k]]));
      ops.push(...r.tailOps);
    }
  }
  return ops;
}

export const TYPE_LABEL: Record<NodeType, string> = { group: 'Heading', item: 'Item', note: 'Description line' };

// ---------- moving rows (drag and drop, Alt+Up/Down) ----------
export type DropWhere = 'before' | 'after' | 'into';

function isInside(model: BoqModel, n: BoqNode, ancestor: string): boolean {
  let p = n.parent;
  for (let guard = 0; p && guard < 64; guard++) {
    if (p === ancestor) return true;
    p = model.byId.get(p)?.parent ?? null;
  }
  return false;
}

/** The rows that actually move: the selection minus rows inside a selected heading (they come along). */
export function movingRows(model: BoqModel, ids: string[]): BoqNode[] {
  // selected headings in a set, then one walk up from each row (not every row against every heading)
  const heads = new Set(ids.filter((id) => model.byId.get(id)?.type === 'group'));
  const out: BoqNode[] = [];
  for (const id of ids) {
    const n = model.byId.get(id);
    if (!n || n.id === UNFILED) continue;
    let covered = false;
    if (heads.size) {
      let p = n.parent;
      for (let guard = 0; p && guard < 64; guard++) {
        if (heads.has(p)) { covered = true; break; }
        p = model.byId.get(p)?.parent ?? null;
      }
    }
    if (!covered) out.push(n);
  }
  return out;
}

/** Can these rows be dropped there? (not on themselves, a heading not into its own content) */
export function canMoveRows(model: BoqModel, ids: string[], targetId: string, where: DropWhere): boolean {
  const t = model.byId.get(targetId);
  if (!t || t.id === UNFILED) return false;
  if (where === 'into' && t.type !== 'group') return false;
  const moving = movingRows(model, ids);
  if (!moving.length) return false;
  if (moving.some((m) => m.id === targetId)) return false;
  const parent = where === 'into' ? t.id : t.parent;
  for (const m of moving) {
    if (m.type !== 'group') continue;
    if (parent === m.id) return false;
    const pn = parent ? model.byId.get(parent) : null;
    if (pn && isInside(model, pn, m.id)) return false;
  }
  return true;
}

/**
 * Moves rows (in the order given = on-screen order) before / after a row, or into a
 * heading (as its last lines). Headings take everything under them. One batch, one undo.
 */
export function moveRowsOps(model: BoqModel, ids: string[], targetId: string, where: DropWhere): Op[] {
  if (!canMoveRows(model, ids, targetId, where)) return [];
  const t = model.byId.get(targetId)!;
  const moving = movingRows(model, ids);
  const mset = new Set(moving.map((m) => m.id));
  const parent = where === 'into' ? t.id : t.parent;
  const sibs = siblingsOf(model, parent).filter((x) => !mset.has(x.id));
  const ti = sibs.findIndex((x) => x.id === t.id);
  const after = where === 'into' ? sibs.length - 1 : where === 'before' ? ti - 1 : ti;
  const { keys, tailOps } = keysAfter(sibs, after, moving.length);
  const ops: Op[] = [];
  moving.forEach((m, k) => {
    if (m.parent !== parent) ops.push([m.id, 'parent', parent]);
    ops.push([m.id, 'ord', keys[k]]);
  });
  return [...ops, ...tailOps];
}

/** Alt+Up / Alt+Down: move the selected rows past their neighbour (same heading). */
export function nudgeRowsOps(model: BoqModel, ids: string[], dir: -1 | 1): Op[] {
  const moving = movingRows(model, ids);
  if (!moving.length) return [];
  const parent = moving[0].parent;
  if (moving.some((m) => m.parent !== parent)) return [];
  const sibs = siblingsOf(model, parent);
  const idx = moving.map((m) => sibs.findIndex((x) => x.id === m.id)).sort((a, b) => a - b);
  const neighbour = dir < 0 ? sibs[idx[0] - 1] : sibs[idx[idx.length - 1] + 1];
  if (!neighbour) return [];
  return moveRowsOps(model, moving.map((m) => m.id), neighbour.id, dir < 0 ? 'before' : 'after');
}

/**
 * Cut + paste: put the rows right below `targetId` as it looks on screen. An open heading:
 * at the start of its content. A closed heading or a line: right after it.
 */
export function placeBelowOps(model: BoqModel, ids: string[], targetId: string, targetOpen: boolean): Op[] {
  const t = model.byId.get(targetId);
  if (!t) return [];
  if (t.type === 'group' && targetOpen) {
    const moving = new Set(movingRows(model, ids).map((m) => m.id));
    const firstOther = t.children.find((c) => !moving.has(c.id));
    return firstOther ? moveRowsOps(model, ids, firstOther.id, 'before') : moveRowsOps(model, ids, t.id, 'into');
  }
  return moveRowsOps(model, ids, targetId, 'after');
}

/** "Move to…": at the start or the end of a heading */
export function moveIntoOps(model: BoqModel, ids: string[], headingId: string, at: 'start' | 'end'): Op[] {
  const h = model.byId.get(headingId);
  if (!h || h.type !== 'group') return [];
  if (at === 'end') return moveRowsOps(model, ids, headingId, 'into');
  return placeBelowOps(model, ids, headingId, true);
}
