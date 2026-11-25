// v0.16 (group b2): the take-off list - a heading duplicated with or without its measurements, take-offs
// and headings deleted in one step (one Ctrl+Z brings everything back), show / hide per person, and the
// quantities of one sheet only.
import { generateNKeysBetween } from 'fractional-indexing';
import type { Op, Value } from '../types';
import { randomId } from '../ids';
import { descendants, newHeadingOps, removeHeadingOps } from './headings';
import { copyShapesOps, deleteItemOps } from './ops';
import { itemQty, pageKey, type ItemQty, type QtoModel, type Shape, type TItem, type TreeView } from './model';

// ---------------------------------------------------------------- duplicate a heading
/** settings of a take-off a copy keeps (numbers: written when set) */
const NUM_FIELDS = ['h', 'd', 'waste', 'dmin', 'ow', 'oh', 'lb', 'ld', 'lw', 'st', 'sw'] as const;
const TEXT_FIELDS = ['bt', 'fill', 'lab', 'note'] as const;
/** fields of a take-off that are its place, its identity or rebuilt for the copy: never copied raw */
const OWN_FIELDS = new Set(['kind', 'name', 'color', 'owner', 'ord', 'par', 'grp', 'del', 'priv', 'x', 'ded', ...NUM_FIELDS, ...TEXT_FIELDS]);
/** v0.16 a take-off's link to a room (or to one of its finishes) */
const ROOM_LINK_FIELDS = new Set(['rm', 'rk', 'rcat', 'rded', 'rh']);

/**
 * Copy a heading with its sub-headings and take-offs, right after the original, named "<name> (copy)".
 * withValues: the take-offs' shapes too (same sheets, same places, doors and openings on walls).
 * BOQ links are never copied (the copies would count twice). Openings a take-off deducts that are
 * copied with it are deducted from the copy as their copies. `extra`: other fields of a take-off as
 * stored (fields added by later versions), copied as they are.
 */
export function duplicateHeadingOps(
  m: QtoModel,
  hid: string,
  owner: string,
  withValues: boolean,
  extra?: (ti: string) => [string, Value][],
): { id: string; ops: Op[]; items: number; shapes: number; links: number } | null {
  const tv = m.itemTree;
  const h = tv.headingById.get(hid);
  if (!h) return null;
  const sib = tv.tree.get(h.par) ?? [];
  const at = sib.findIndex((n) => n.id === hid);
  const top = newHeadingOps(tv, h.name + ' (copy)', h.par, sib[at + 1]?.id ?? null);
  const ops: Op[] = [...top.ops];
  const map = new Map<string, string>([[hid, top.id]]);
  const d = descendants(tv, hid);
  for (const x of d.headings) map.set(x, 'hd:' + randomId(10));
  for (const x of d.items) if (m.itemById.has(x)) map.set(x, 'ti:' + randomId(10));
  // (v0.16 a room's own finishes - additional ones, manual ceiling areas - are not rows: copied with their room)
  for (const x of d.items) for (const pid of m.roomParts.get(x) ?? []) if (m.itemById.has(pid)) map.set(pid, 'ti:' + randomId(10));
  let items = 0, shapes = 0, links = 0;
  const copyItem = (it: TItem, nid: string, par: string, ord: string, part = false) => {
    ops.push([nid, 'kind', it.kind], [nid, 'name', it.name], [nid, 'color', it.color], [nid, 'owner', owner], [nid, 'ord', ord], [nid, 'par', par]);
    for (const f of NUM_FIELDS) {
      const v = it[f];
      if (v !== null && v !== undefined && !(f === 'waste' && !v)) ops.push([nid, f, v as number]);
    }
    for (const f of TEXT_FIELDS) if (it[f]) ops.push([nid, f, it[f] as string]);
    if (it.x !== 1) ops.push([nid, 'x', it.x]);
    if (it.priv && !part) ops.push([nid, 'priv', true]);
    if (it.ded.length) ops.push([nid, 'ded', JSON.stringify(it.ded.map((x) => map.get(x) ?? x))]);
    // linked to a room (v0.16): to the room's copy when it is copied too, else the copy is not linked (as BOQ
    // links: it would count in that room twice)
    const roomToo = !!it.rm && map.has(it.rm);
    for (const [f, v] of extra?.(it.id) ?? []) {
      if (OWN_FIELDS.has(f) || f.startsWith('dd:') || v === null || v === undefined) continue;
      if (ROOM_LINK_FIELDS.has(f) && !roomToo) continue;
      // (v0.16.4 bp: the ceiling a bulkhead hangs from - the copy's own)
      ops.push([nid, f, (f === 'rm' || f === 'rcat' || f === 'bp') && typeof v === 'string' ? map.get(v) ?? v : v]);
    }
    if (!part) { items++; links += m.linksByItem.get(it.id)?.length ?? 0; }
    if (withValues) {
      for (const s of m.shapesByItem.get(it.id) ?? []) {
        ops.push(...copyShapesOps([s], { dwg: s.dwg, pg: s.pg, rv: s.rv }, s.by, 0, 0, nid, m.openingsByShape).ops);
        shapes++;
      }
    }
    // a room: its own finishes go with it (under the same heading and place, as a room's finishes are made)
    for (const pid of m.roomParts.get(it.id) ?? []) { const pt = m.itemById.get(pid); if (pt && map.has(pid)) copyItem(pt, map.get(pid)!, par, ord, true); }
  };
  // each heading's children get fresh order keys in the order shown (some may never have had one)
  const walk = (par: string) => {
    const list = (tv.tree.get(par) ?? []).filter((n) => (n.t === 'h' ? map.has(n.id) : map.has(n.id) && tv.leafPar.has(n.id)));
    if (!list.length) return;
    const keys = generateNKeysBetween(null, null, list.length);
    list.forEach((n, k) => {
      const nid = map.get(n.id)!;
      if (n.t === 'h') {
        ops.push([nid, 'name', tv.headingById.get(n.id)?.name ?? 'Heading'], [nid, 'par', map.get(par)!], [nid, 'ord', keys[k]]);
        walk(n.id);
      } else copyItem(m.itemById.get(n.id)!, nid, map.get(par)!, keys[k]);
    });
  };
  walk(hid);
  return { id: top.id, ops, items, shapes, links };
}

// ---------------------------------------------------------------- delete in one step
/**
 * Delete take-offs and headings (with everything under them) in one change: the take-offs, their shapes
 * on every sheet and their BOQ links. Undoing that one change brings it all back as it was (place in the
 * list, settings, links). Also says how much goes, for the question asked first.
 */
export function deleteNodesOps(m: QtoModel, ids: Iterable<string>): { ops: Op[]; items: string[]; headings: string[]; shapes: number; links: number } {
  const tv = m.itemTree;
  const sel = [...new Set(ids)].filter((id) => tv.headingById.has(id) || m.itemById.has(id));
  const set = new Set(sel);
  // under a heading that goes too: already in it
  const covered = (id: string) => {
    for (let p = tv.headingById.get(id)?.par ?? tv.leafPar.get(id) ?? ''; p; p = tv.headingById.get(p)?.par ?? '') if (set.has(p)) return true;
    return false;
  };
  const all = new Map<string, Op>();
  const put = (o: Op[]) => { for (const op of o) all.set(op[0] + '\u0000' + op[1], op); };
  const items = new Set<string>(), headings = new Set<string>();
  for (const id of sel) {
    if (covered(id)) continue;
    if (tv.headingById.has(id)) {
      const d = descendants(tv, id);
      headings.add(id);
      d.headings.forEach((x) => headings.add(x));
      d.items.forEach((x) => m.itemById.has(x) && items.add(x));
      put(removeHeadingOps(tv, id, true, (ti) => deleteItemOps(m, ti)));
    } else {
      items.add(id);
      put(deleteItemOps(m, id));
    }
  }
  let shapes = 0, links = 0;
  for (const ti of items) { shapes += m.shapesByItem.get(ti)?.length ?? 0; links += m.linksByItem.get(ti)?.length ?? 0; }
  return { ops: [...all.values()], items: [...items], headings: [...headings], shapes, links };
}

/** "Delete Floor tiles and all its measurements?" - or how many take-offs and shapes go */
export function deleteQuestion(m: QtoModel, ids: string[]): { title: string; detail: string } {
  const r = deleteNodesOps(m, ids);
  const sh = `${r.shapes} shape${r.shapes === 1 ? '' : 's'}`;
  const heads = ids.filter((id) => m.itemTree.headingById.has(id));
  if (ids.length === 1 && !heads.length) {
    const it = m.itemById.get(ids[0]);
    return { title: `Delete ${it?.name ?? 'this take-off'} and all its measurements?`, detail: `${sh} on every sheet${r.links ? ` and ${r.links} BOQ link${r.links === 1 ? '' : 's'}` : ''}. Ctrl+Z brings it back.` };
  }
  const n = `${r.items.length} take-off${r.items.length === 1 ? '' : 's'}`;
  if (heads.length === 1 && ids.length === 1) {
    const h = m.itemTree.headingById.get(heads[0])!;
    return { title: `Delete the heading ${h.name} and everything under it?`, detail: `Everything under it goes: ${n} with ${sh}${r.headings.length > 1 ? `, ${r.headings.length - 1} sub-heading${r.headings.length > 2 ? 's' : ''}` : ''}. Ctrl+Z brings it all back.` };
  }
  return {
    title: `Delete ${n} and all their measurements?`,
    detail: `${sh} on every sheet${heads.length ? `; everything under the ${heads.length === 1 ? 'heading' : heads.length + ' headings'} picked goes too` : ''}. Ctrl+Z brings it all back.`,
  };
}

// ---------------------------------------------------------------- show / hide (per person)
export interface Hidden { items: Set<string>; heads: Set<string> }
export const noneHidden = (): Hidden => ({ items: new Set(), heads: new Set() });

/** the take-offs not drawn: hidden themselves or under a hidden heading (the take-offs' own toggles stay) */
export function hiddenItemsOf(tv: TreeView, h: Hidden, roomParts?: Map<string, string[]>): Set<string> {
  const out = new Set<string>();
  if (!h.items.size && !h.heads.size) return out;
  const headHidden = new Map<string, boolean>();
  const hid = (id: string): boolean => {
    const k = headHidden.get(id);
    if (k !== undefined) return k;
    headHidden.set(id, false); // (a loop: not hidden)
    const hd = tv.headingById.get(id);
    const v = !!hd && (h.heads.has(id) || (!!hd.par && hid(hd.par)));
    headHidden.set(id, v);
    return v;
  };
  for (const [ti, par] of tv.leafPar) if (h.items.has(ti) || (par && hid(par))) out.add(ti);
  // v0.16 (g2): a room's own finishes (additional finishes, ceiling areas - not rows of the tree) are hidden
  // with their room, or by their own eye (on their line under the room)
  if (roomParts) for (const [rm, ps] of roomParts) for (const pid of ps) if (out.has(rm) || h.items.has(pid)) out.add(pid);
  return out;
}

/** hidden on its own or by a heading between it and `top` (top itself and the headings above it not counted) */
function hiddenBelow(tv: TreeView, ti: string, top: string, h: Hidden): boolean {
  if (h.items.has(ti)) return true;
  for (let p = tv.leafPar.get(ti) ?? ''; p && p !== top; p = tv.headingById.get(p)?.par ?? '') if (h.heads.has(p)) return true;
  return false;
}

/** a heading's eye: everything under it shown, nothing, or some (as if the headings above it were shown) */
export function headEye(tv: TreeView, hid: string, h: Hidden): 'all' | 'none' | 'mixed' {
  if (h.heads.has(hid)) return 'none';
  const items = descendants(tv, hid).items.filter((x) => tv.leafPar.has(x));
  if (!items.length) return 'all';
  const n = items.filter((x) => hiddenBelow(tv, x, hid, h)).length;
  return n === 0 ? 'all' : n === items.length ? 'none' : 'mixed';
}

/** under a heading that is hidden: its own eye still shows its own setting, faded */
export function underHidden(tv: TreeView, id: string, h: Hidden): boolean {
  for (let p = tv.headingById.get(id)?.par ?? tv.leafPar.get(id) ?? ''; p; p = tv.headingById.get(p)?.par ?? '') if (h.heads.has(p)) return true;
  return false;
}

/**
 * A heading's eye clicked: everything under it hidden (the take-offs' own eyes stay as they are); shown
 * again, each take-off is as it was. When nothing under it would show even then (each hidden on its
 * own), everything under it is shown.
 */
export function toggleHeadEye(tv: TreeView, hid: string, h: Hidden): Hidden {
  const next: Hidden = { items: new Set(h.items), heads: new Set(h.heads) };
  if (headEye(tv, hid, h) !== 'none') { next.heads.add(hid); return next; }
  next.heads.delete(hid);
  if (headEye(tv, hid, next) === 'none') {
    const d = descendants(tv, hid);
    d.items.forEach((x) => next.items.delete(x));
    d.headings.forEach((x) => next.heads.delete(x));
  }
  return next;
}

/** a take-off's own eye clicked */
export function toggleItemEye(ti: string, h: Hidden): Hidden {
  const next: Hidden = { items: new Set(h.items), heads: new Set(h.heads) };
  if (next.items.has(ti)) next.items.delete(ti); else next.items.add(ti);
  return next;
}

export const loadHidden = (key: string): Hidden => {
  try {
    const j = JSON.parse(localStorage.getItem(key) || '{}');
    return { items: new Set(Array.isArray(j.i) ? j.i : []), heads: new Set(Array.isArray(j.h) ? j.h : []) };
  } catch { return noneHidden(); }
};
export const saveHidden = (key: string, h: Hidden) => { try { localStorage.setItem(key, JSON.stringify({ i: [...h.items], h: [...h.heads] })); } catch { /* */ } };

// ---------------------------------------------------------------- quantities on one sheet
/**
 * Each take-off's quantity from the shapes on one sheet only, worked out as its total is (repeats, times,
 * the doors and openings on its walls, waste) - with the openings it deducts as far as they are measured on
 * this sheet. So a take-off measured on one sheet shows here what the list shows, and the sheets of a
 * take-off add up to its total (unless openings it deducts lie on a sheet it has nothing on).
 */
export function sheetQty(m: QtoModel, dwg: string, pg: number): Map<string, ItemQty> {
  const shapes = m.shapesByPage.get(pageKey(dwg, pg)) ?? [];
  const byItem = new Map<string, Shape[]>();
  for (const s of shapes) (byItem.get(s.ti) ?? byItem.set(s.ti, []).get(s.ti)!).push(s);
  const qm = { shapesByItem: byItem, itemById: m.itemById, pages: m.pages, regions: m.regions, openingsByShape: m.openingsByShape, doorById: m.doorById, beamTypeById: m.beamTypeById, colTypeById: m.colTypeById, wallTypeById: m.wallTypeById, swTypeById: m.swTypeById, ftgTypeById: m.ftgTypeById, rwTypeById: m.rwTypeById, stairTypeById: m.stairTypeById, shapesByPage: m.shapesByPage };
  const out = new Map<string, ItemQty>();
  for (const ti of byItem.keys()) {
    const it = m.itemById.get(ti);
    if (it) out.set(ti, itemQty(qm, it));
  }
  return out;
}

// ---------------------------------------------------------------- several selected: shared values
/** one value for all, or 'mixed' */
export function sharedValue<T>(list: T[], get: (x: T) => unknown): { v: unknown; mixed: boolean } {
  if (!list.length) return { v: null, mixed: false };
  const v0 = get(list[0]);
  const same = (a: unknown, b: unknown) => a === b || ((a === null || a === undefined || a === '') && (b === null || b === undefined || b === ''));
  return list.every((x) => same(get(x), v0)) ? { v: v0, mixed: false } : { v: null, mixed: true };
}
