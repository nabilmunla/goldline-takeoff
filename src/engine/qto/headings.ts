// Headings in a list organised by the team — the take-off list (hd:) and the drawing list (dh:):
// create, rename, move (drag and drop), remove. Headings and what is under one parent share one
// order; moving a heading moves everything under it (they point at it, not the other way round).
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { randomId } from '../ids';
import type { Op, Value } from '../types';
import type { QtoModel, TreeNode, TreeView } from './model';

export type DropAt = { par: string; before: string | null };

interface Spec {
  /** id prefix of new headings */
  hp: string;
  /** a leaf's fields: its heading and its order */
  par: string;
  ord: string;
  /** what "top level" is written as for a leaf (drawings: "/" so they don't fall back to their folder headings) */
  root: Value;
  /** also written when a leaf is placed by hand */
  extra: [string, Value][];
}
const SPEC: Record<TreeView['kind'], Spec> = {
  items: { hp: 'hd:', par: 'par', ord: 'ord', root: null, extra: [['grp', null]] },
  drawings: { hp: 'dh:', par: 'dpar', ord: 'dord', root: '/', extra: [] },
};

const kids = (tv: TreeView, par: string) => tv.tree.get(par) ?? [];
const isHead = (tv: TreeView, id: string) => tv.headingById.has(id);
const parOf = (tv: TreeView, id: string) => tv.headingById.get(id)?.par ?? tv.leafPar.get(id) ?? '';

/** every heading and leaf under a heading (not the heading itself) */
export function descendants(tv: TreeView, hid: string): { headings: string[]; items: string[] } {
  const out = { headings: [] as string[], items: [] as string[] };
  const walk = (p: string) => {
    for (const n of kids(tv, p)) {
      if (n.t === 'h') { out.headings.push(n.id); walk(n.id); } else out.items.push(n.id);
    }
  };
  walk(hid);
  return out;
}

/** is `a` the heading `h` or somewhere under it? */
export function isUnder(tv: TreeView, a: string, h: string): boolean {
  let p: string | undefined = a;
  const seen = new Set<string>();
  while (p && !seen.has(p)) {
    if (p === h) return true;
    seen.add(p);
    p = tv.headingById.get(p)?.par;
  }
  return false;
}

/** ops that make a heading made from a group / folder name a real one (no-op for real headings) */
function materialize(tv: TreeView, hid: string): Op[] {
  const h = tv.headingById.get(hid);
  if (!h || !h.virtual) return [];
  const ops: Op[] = h.par ? materialize(tv, h.par) : [];
  // (del: null — the same id may have been a heading once, removed since)
  ops.push([hid, 'del', null], [hid, 'name', h.name], [hid, 'par', h.par || null]);
  if (h.ord) ops.push([hid, 'ord', h.ord]);
  return ops;
}

const placeOps = (tv: TreeView, n: TreeNode, par: string, ord: string): Op[] => {
  const sp = SPEC[tv.kind];
  if (n.t === 'h') return [...materialize(tv, n.id), [n.id, 'par', par || null], [n.id, 'ord', ord]];
  return [[n.id, sp.par, par || sp.root], [n.id, sp.ord, ord], ...sp.extra.map(([f, v]) => [n.id, f, v] as Op)];
};

/**
 * order keys for `count` nodes placed before `before` (null = at the end) among `list` (of heading `par`).
 * When some of the list has never been placed by hand (no order key), the whole list is numbered as shown.
 */
function keysAt(tv: TreeView, par: string, list: TreeNode[], before: string | null, count: number): { keys: string[]; fix: Op[] } {
  const i = before ? list.findIndex((n) => n.id === before) : -1;
  const at = i < 0 ? list.length : i;
  const lo = at > 0 ? list[at - 1].ord || null : null;
  const hi = at < list.length ? list[at].ord || null : null;
  try {
    if (list.some((n) => !n.ord)) throw new Error('unordered');
    if (lo && hi && lo >= hi) throw new Error('order');
    return { keys: generateNKeysBetween(lo, hi, count), fix: [] };
  } catch {
    const all = generateNKeysBetween(null, null, list.length + count);
    const fix: Op[] = [];
    list.forEach((n, j) => fix.push(...placeOps(tv, n, par, all[j < at ? j : j + count])));
    return { keys: all.slice(at, at + count), fix };
  }
}

/**
 * Move headings and leaves (in the order given) to a place in the list.
 * Things under a heading that is also being moved stay where they are in it.
 * Returns [] when the move makes no sense (a heading into itself).
 */
export function moveNodesOps(tv: TreeView, ids: string[], to: DropAt): Op[] {
  const set = new Set(ids);
  const top = ids.filter((id) => {
    for (let p = parOf(tv, id); p; p = tv.headingById.get(p)?.par ?? '') if (set.has(p)) return false;
    return true;
  });
  if (!top.length) return [];
  if (to.par && top.some((id) => isHead(tv, id) && isUnder(tv, to.par, id))) return [];
  const ops: Op[] = [];
  if (to.par) ops.push(...materialize(tv, to.par));
  const list = kids(tv, to.par).filter((n) => !set.has(n.id));
  const before = to.before && set.has(to.before) ? null : to.before;
  const { keys, fix } = keysAt(tv, to.par, list, before, top.length);
  ops.push(...fix);
  top.forEach((id, i) => ops.push(...placeOps(tv, { t: isHead(tv, id) ? 'h' : 'i', id, ord: '' }, to.par, keys[i])));
  return ops;
}

export function newHeadingOps(tv: TreeView, name: string, par = '', before: string | null = null): { id: string; ops: Op[] } {
  const id = SPEC[tv.kind].hp + randomId(10);
  const ops: Op[] = par ? materialize(tv, par) : [];
  const { keys, fix } = keysAt(tv, par, kids(tv, par), before, 1);
  ops.push(...fix, [id, 'name', name.trim() || 'Heading'], [id, 'par', par || null], [id, 'ord', keys[0]]);
  return { id, ops };
}

export function renameHeadingOps(tv: TreeView, hid: string, name: string): Op[] {
  const h = tv.headingById.get(hid);
  if (!h || !name.trim()) return [];
  return [...materialize(tv, hid), [hid, 'name', name.trim()]];
}

/**
 * Remove a heading. withContents=false: what was under it moves up one level, in place.
 * withContents=true: everything under it is deleted too (restorable from history).
 */
export function removeHeadingOps(tv: TreeView, hid: string, withContents: boolean, delLeaf: (id: string) => Op[]): Op[] {
  const h = tv.headingById.get(hid);
  if (!h) return [];
  const ops: Op[] = [];
  if (withContents) {
    const d = descendants(tv, hid);
    for (const id of d.items) ops.push(...delLeaf(id), ...SPEC[tv.kind].extra.map(([f, v]) => [id, f, v] as Op));
    for (const x of d.headings) if (!tv.headingById.get(x)?.virtual) ops.push([x, 'del', true]);
  } else {
    const children = kids(tv, hid);
    const parent = kids(tv, h.par);
    const at = parent.findIndex((n) => n.id === hid);
    const after = parent[at + 1]?.id ?? null;
    const sibl = parent.filter((n) => n.id !== hid);
    if (h.par) ops.push(...materialize(tv, h.par));
    const { keys, fix } = keysAt(tv, h.par, sibl, after, children.length);
    ops.push(...fix);
    children.forEach((n, i) => ops.push(...placeOps(tv, n, h.par, keys[i])));
  }
  if (!h.virtual) ops.push([hid, 'del', true]);
  else {
    // a heading made from a folder/group: it would come back from the names; keep it, emptied, as removed
    ops.push([hid, 'name', h.name], [hid, 'del', true]);
  }
  return ops;
}

/** heading a new take-off from a typical (template) goes under when nothing is chosen: its group, by name */
export function headingForGroup(m: QtoModel, group: string): { id: string; ops: Op[] } {
  const tv = m.itemTree;
  const g = group.trim().toLowerCase();
  const h = tv.headings.find((x) => x.name.trim().toLowerCase() === g);
  if (h) return { id: h.id, ops: materialize(tv, h.id) };
  const id = 'hd:g' + groupKey(group);
  const { keys } = keysAt(tv, '', kids(tv, ''), null, 1);
  return { id, ops: [[id, 'del', null], [id, 'name', group.trim()], [id, 'par', null], [id, 'ord', keys[0]]] };
}
function groupKey(name: string) {
  let h = 0x811c9dc5;
  for (const ch of name.trim().toLowerCase()) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

/** order key for a new leaf at the end of a heading */
export function endOf(tv: TreeView, par: string): { ord: string; fix: Op[] } {
  const { keys, fix } = keysAt(tv, par, kids(tv, par), null, 1);
  return { ord: keys[0], fix };
}

/** leaves in list order (depth first) */
export function leavesInOrder(tv: TreeView): string[] {
  const out: string[] = [];
  const walk = (p: string) => { for (const n of kids(tv, p)) n.t === 'i' ? out.push(n.id) : walk(n.id); };
  walk('');
  return out;
}

export const _unused = generateKeyBetween;
