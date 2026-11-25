// v0.16 (items 23 / 25): the take-off's BOQ tab as a tree - bill › section › sub-section › item ›
// sub-item (an additional item relinked to that item). What is shown for a given expanded state, search
// and "Show" choice; windowed by the panel (10,000+ lines).
import type { Dummy, MirrorRow, QtoModel } from './model';
import { lineTotals, linesLinkedBy } from './additional';

export type BoqShow = 'all' | 'linked' | 'open' | 'mine' | 'diff' | 'add';
export const BOQ_SHOW_LABEL: Record<BoqShow, string> = {
  all: 'All', linked: 'Linked', open: 'Not linked', mine: 'Linked by me', diff: 'Differs > 5 %', add: 'Additional items',
};

export type TreeRow =
  | { k: 'row'; id: string; r: MirrorRow; depth: number; kids: boolean; open: boolean; hit: boolean }
  /** an additional item relinked to a BOQ item: shown under it with its own description and quantity */
  | { k: 'sub'; id: string; d: Dummy; depth: number; parent: string; hit: boolean };

/** additional items relinked to each BOQ item (sub-items), in the take-off's order */
export function subItems(m: Pick<QtoModel, 'dummies' | 'boqById'>): Map<string, Dummy[]> {
  const out = new Map<string, Dummy[]>();
  for (const d of m.dummies) if (d.add && d.map && m.boqById.has(d.map)) (out.get(d.map) ?? out.set(d.map, []).get(d.map)!).push(d);
  return out;
}

/** every word of the search in the ref, description, page (the consultant's code) or location */
export function searchMatch(q: string): ((hay: string) => boolean) | null {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  return (hay: string) => { const h = hay.toLowerCase(); return words.every((w) => h.includes(w)); };
}
const hayOf = (r: MirrorRow) => r.ref + ' ' + r.desc + ' ' + r.page + ' ' + r.loc;

/** does a BOQ item pass the "Show" choice (`mine`: linesLinkedBy for "Linked by me") */
export function showsItem(m: QtoModel, r: MirrorRow, show: BoqShow, mine?: Set<string>): boolean {
  if (show === 'all') return true;
  const t = lineTotals(m).get(r.id);
  if (show === 'linked') return t !== undefined;
  if (show === 'open') return t === undefined;
  if (show === 'diff') return t !== undefined && r.qty !== null && r.qty !== 0 && Math.abs(t - r.qty) / Math.abs(r.qty) > 0.05;
  if (show === 'mine') return !!mine?.has(r.id);
  return !!r.qa;
}

/**
 * The rows shown: headings and items as expanded (`collapsed`: ids of rows closed), sub-items under
 * their item. With a search or a "Show" choice: only what matches (and the headings above it, opened -
 * a match is never hidden by a closed heading), matches marked `hit`.
 */
export function treeRows(m: QtoModel, o: { collapsed: Set<string>; q?: string; show?: BoqShow; me?: string }): TreeRow[] {
  const subs = subItems(m);
  const match = searchMatch(o.q ?? '');
  const show = o.show ?? 'all';
  const out: TreeRow[] = [];
  const filtered = !!match || show !== 'all';
  const mine = show === 'mine' ? linesLinkedBy(m, o.me ?? '') : undefined;
  const seen = new Set<string>();
  if (!filtered) {
    const visit = (r: MirrorRow, depth: number) => {
      if (seen.has(r.id)) return;
      seen.add(r.id);
      const sub = subs.get(r.id) ?? [];
      const kids = r.children.length > 0 || sub.length > 0;
      const open = kids && !o.collapsed.has(r.id);
      out.push({ k: 'row', id: r.id, r, depth, kids, open, hit: false });
      if (!open) return;
      for (const c of r.children) visit(c, depth + 1);
      for (const d of sub) out.push({ k: 'sub', id: d.id, d, depth: depth + 1, parent: r.id, hit: false });
    };
    for (const r of m.boqRoots) visit(r, 0);
    return out;
  }
  // which rows match (hit / item passing the filter) and which have a match somewhere under them (inner)
  const self = new Set<string>();
  const inner = new Set<string>();
  const subHit = new Set<string>();
  const done = new Set<string>();
  const mark = (r: MirrorRow): boolean => {
    if (done.has(r.id)) return false;
    done.add(r.id);
    let k = false;
    for (const c of r.children) k = mark(c) || k;
    if (r.bt === 'item') {
      const passes = showsItem(m, r, show, mine);
      if (passes && match) for (const d of subs.get(r.id) ?? []) if (match(d.ref + ' ' + d.desc + ' ' + d.loc)) { subHit.add(d.id); k = true; }
      if (passes && (!match || match(hayOf(r)))) self.add(r.id);
    } else if (match && show === 'all' && match(hayOf(r))) self.add(r.id);
    if (k) inner.add(r.id);
    return k || self.has(r.id);
  };
  for (const r of m.boqRoots) mark(r);
  const visit = (r: MirrorRow, depth: number, inHit: boolean) => {
    if (seen.has(r.id)) return;
    const isHit = self.has(r.id);
    if (!isHit && !inner.has(r.id) && !inHit) return;
    seen.add(r.id);
    const sub = subs.get(r.id) ?? [];
    const kids = r.children.length > 0 || sub.length > 0;
    // above a match: opened (a match is never hidden by a closed heading); a heading that matches, or
    // anything under it, as expanded
    const open = kids && (inner.has(r.id) || ((inHit || isHit) && !o.collapsed.has(r.id)));
    out.push({ k: 'row', id: r.id, r, depth, kids, open, hit: isHit && !!match });
    if (!open) return;
    const under = inHit || (isHit && r.bt === 'group');
    for (const c of r.children) visit(c, depth + 1, under);
    for (const d of sub) if (under || isHit || subHit.has(d.id) || !match) out.push({ k: 'sub', id: d.id, d, depth: depth + 1, parent: r.id, hit: subHit.has(d.id) });
  };
  for (const r of m.boqRoots) visit(r, 0, false);
  return out;
}

/** rows that can be closed (headings, and items with sub-items) */
export function closable(m: QtoModel): { id: string; depth: number }[] {
  const subs = subItems(m);
  const out: { id: string; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (r: MirrorRow, depth: number) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    if (r.children.length || subs.has(r.id)) out.push({ id: r.id, depth });
    for (const c of r.children) visit(c, depth + 1);
  };
  for (const r of m.boqRoots) visit(r, 0);
  return out;
}

/** "Show levels": 1 = bills only, 2 = + sections, 3 = + sub-sections, 0 = everything */
export function collapsedForLevel(m: QtoModel, level: number): Set<string> {
  if (!level) return new Set();
  return new Set(closable(m).filter((x) => x.depth >= level - 1).map((x) => x.id));
}

/** the rows above a row (bill first) */
export function ancestors(m: Pick<QtoModel, 'boqById'>, id: string): string[] {
  const out: string[] = [];
  let r = m.boqById.get(id);
  let guard = 0;
  while (r && r.par && guard++ < 64) { out.unshift(r.par); r = m.boqById.get(r.par); }
  return out;
}

/** "Bill 2 › Earthworks": where a row sits (the bill and section above it, or itself) */
export function crumbOf(m: Pick<QtoModel, 'boqById'>, id: string): string {
  const ids = [...ancestors(m, id), id].filter((x) => m.boqById.get(x)?.bt === 'group').slice(0, 2);
  return ids.map((x) => { const r = m.boqById.get(x)!; return r.depth === 0 && r.ref ? r.ref + ' ' + r.desc : r.desc; }).join(' › ');
}
