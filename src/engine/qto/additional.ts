// v0.16 additional items, on the take-off's side (item 20).
//
// An additional item is an item the BOQ doesn't have: a QS adds one once the BOQ is there (description,
// unit, bill, location) - a "dm:" entity with add = true. Temporary lines made before the BOQ came work
// as before; once it is there each must be resolved by the QS: matched to a BOQ line (map) or kept as an
// additional item (add + bill + location). Each additional item, and each temporary line not resolved yet,
// reaches the estimate as a line of its own (qx_<id>, bridge.ts additionalOps); an estimator can relink
// an additional item to an existing BOQ item (map): it then shows as a sub-item of that item and its
// quantity counts in that item's Take-off figure, never in the BOQ quantity.
import { generateKeyBetween } from 'fractional-indexing';
import type { Op } from '../types';
import { randomId } from '../ids';
import { qxId, dmOfQx, type Dummy, type Link, type MirrorRow, type QtoModel, type TargetQty } from './model';

/** what an additional item / temporary line is now */
export type DummyState = 'temp' | 'open' | 'add' | 'matched' | 'relinked';
export const hasBoq = (m: Pick<QtoModel, 'boqById'>) => {
  for (const r of m.boqById.values()) if (r.bt === 'item' && !r.qa) return true;
  return false;
};
/**
 * temp: a temporary line, no BOQ yet · open: a temporary line not resolved now that the BOQ is here ·
 * add: an additional item · matched: a temporary line matched to its BOQ line · relinked: an additional
 * item relinked to a BOQ item (a sub-item of it)
 */
export function dummyState(m: Pick<QtoModel, 'boqById'>, d: Dummy, boq = hasBoq(m)): DummyState {
  if (d.map) return d.add ? 'relinked' : 'matched';
  if (d.add) return 'add';
  return boq ? 'open' : 'temp';
}
/** temporary lines not resolved now that the BOQ is here (flagged on the BOQ tab) */
export const unresolvedCount = (m: QtoModel) => (m.dummies.length && hasBoq(m) ? m.dummies.filter((d) => !d.map && !d.add).length : 0);
export const DUMMY_STATE_LABEL: Record<DummyState, string> = {
  temp: 'Temporary line', open: 'Not resolved – QS', add: 'Additional – QS', matched: 'Matched', relinked: 'Relinked',
};

/** the estimate's copy of an additional item's line, if it has reached the take-off */
export const lineOf = (m: Pick<QtoModel, 'boqById'>, d: Pick<Dummy, 'id'>): MirrorRow | null => m.boqById.get(qxId(d.id)) ?? null;
/** the take-off's own additional item behind a line of the BOQ copy (qx_<id>), if it is this take-off's */
export const dummyOfLine = (m: Pick<QtoModel, 'dummyById'>, lineId: string): Dummy | null => { const d = dmOfQx(lineId); return d ? m.dummyById.get(d) ?? null : null; };

/** as the estimate has it now (description, unit, bill, location): the estimate wins once it has the line */
export interface AddView { desc: string; unit: string; ref: string; bill: string; loc: string; by: string; own: boolean; removed: boolean }
export function addView(m: QtoModel, d: Dummy, removedInEstimate = false): AddView {
  const l = lineOf(m, d);
  if (!l) return { desc: d.desc, unit: d.unit, ref: d.ref, bill: d.bill, loc: d.loc, by: d.byName || d.by, own: false, removed: removedInEstimate };
  return { desc: l.desc, unit: l.unit, ref: l.ref, bill: billOfRow(m, l.id) ?? d.bill, loc: l.loc, by: l.qby || d.byName || d.by, own: l.own, removed: false };
}

/** the bill (top-level heading of the BOQ copy) a row is in */
export function billOfRow(m: Pick<QtoModel, 'boqById'>, id: string): string | null {
  let r = m.boqById.get(id);
  let guard = 0;
  while (r && r.par && guard++ < 64) r = m.boqById.get(r.par);
  return r && r.bt === 'group' && r.qa !== 'g' ? r.id : null;
}
/** bills a QS can put an additional item in */
export const billChoices = (m: Pick<QtoModel, 'boqRoots'>) => m.boqRoots.filter((r) => r.bt === 'group' && r.qa !== 'g');
export const billLabel = (m: Pick<QtoModel, 'boqById'>, id: string) => {
  const b = id ? m.boqById.get(id) : null;
  return b ? [b.ref, b.desc].filter(Boolean).join(' · ') : '';
};

/** locations used before in this take-off (additional items, the door schedule), for suggestions */
export function knownLocations(m: Pick<QtoModel, 'dummies' | 'doors' | 'boqById'>): string[] {
  const set = new Map<string, string>();
  // (v0.16.2 never a plain number: door schedules imported before took an "Area" column of m² as the location)
  const add = (x: string) => { const t = x.trim(); if (t && !/^[-+]?\d+(\.\d+)?$/.test(t) && !set.has(t.toLowerCase())) set.set(t.toLowerCase(), t); };
  for (const d of m.dummies) add(d.loc);
  for (const r of m.boqById.values()) if (r.loc) add(r.loc);
  for (const d of m.doors) add(d.loc);
  return [...set.values()].sort((a, b) => a.localeCompare(b));
}

export interface AddFields { desc: string; unit: string; ref?: string; bill: string; loc: string }

/** a new additional item (the BOQ doesn't have it) */
export function additionalItemOps(m: Pick<QtoModel, 'dummies'>, f: AddFields, by: { username: string; name: string }): { id: string; ops: Op[] } {
  const id = 'dm:' + randomId(10);
  const last = m.dummies[m.dummies.length - 1];
  let ord: string;
  try { ord = generateKeyBetween(last?.ord || null, null); } catch { ord = generateKeyBetween(null, null); }
  return {
    id,
    ops: [
      [id, 'ref', f.ref?.trim() || null], [id, 'desc', f.desc.trim()], [id, 'unit', f.unit.trim() || null], [id, 'ord', ord],
      [id, 'add', true], [id, 'bill', f.bill || null], [id, 'loc', f.loc.trim() || null], [id, 'by', by.username], [id, 'byName', by.name],
    ],
  };
}

/** a temporary line resolved as an additional item (who added it: kept, else the one resolving it) */
export function keepAsAdditionalOps(d: Dummy, f: Pick<AddFields, 'bill' | 'loc'> & Partial<AddFields>, by: { username: string; name: string }): Op[] {
  const ops: Op[] = [[d.id, 'add', true], [d.id, 'bill', f.bill || null], [d.id, 'loc', f.loc.trim() || null], [d.id, 'map', null]];
  if (f.desc !== undefined && f.desc.trim() && f.desc.trim() !== d.desc) ops.push([d.id, 'desc', f.desc.trim()]);
  if (f.unit !== undefined && f.unit.trim() !== d.unit) ops.push([d.id, 'unit', f.unit.trim() || null]);
  if (!d.by) ops.push([d.id, 'by', by.username], [d.id, 'byName', by.name]);
  return ops;
}

/** the QS changes his suggestion (only fields that changed) */
export function editAdditionalOps(d: Dummy, f: Partial<AddFields>): Op[] {
  const ops: Op[] = [];
  if (f.desc !== undefined && f.desc.trim() && f.desc.trim() !== d.desc) ops.push([d.id, 'desc', f.desc.trim()]);
  if (f.unit !== undefined && f.unit.trim() !== d.unit) ops.push([d.id, 'unit', f.unit.trim() || null]);
  if (f.ref !== undefined && f.ref.trim() !== d.ref) ops.push([d.id, 'ref', f.ref.trim() || null]);
  if (f.bill !== undefined && f.bill !== d.bill) ops.push([d.id, 'bill', f.bill || null]);
  if (f.loc !== undefined && f.loc.trim() !== d.loc) ops.push([d.id, 'loc', f.loc.trim() || null]);
  return ops;
}

/** may this person still change this additional item from the take-off? (a QS: his own, until the estimator changed it) */
export function canEditSuggestion(m: QtoModel, d: Dummy, me: string, estimator: boolean): boolean {
  if (estimator) return true;
  if (d.by && d.by !== me) return false;
  return !lineOf(m, d)?.own;
}

/** a link to a line of the BOQ copy that is this take-off's own additional item goes to the item itself */
export function linkTarget(m: Pick<QtoModel, 'dummyById'>, to: string): string {
  if (!to.startsWith('b:')) return to;
  const d = dummyOfLine(m, to.slice(2));
  return d ? d.id : to;
}

/** every link of take-off `ti` that counts to BOQ line `line` (straight, through a temporary line matched to it, dups too) */
export function linksTo(m: Pick<QtoModel, 'linksByItem' | 'dummyById'>, ti: string, line: string): Link[] {
  const own = dummyOfLine(m, line);
  return (m.linksByItem.get(ti) ?? []).filter((l) => l.to === 'b:' + line || (own && l.to === own.id) || (!l.to.startsWith('b:') && m.dummyById.get(l.to)?.map === line));
}

/** what is measured for a line of the BOQ copy (its own additional item's links included), or for 'dm:<id>' */
export function partsOf(m: QtoModel, target: string): TargetQty['parts'] {
  if (target.startsWith('dm:')) return m.targets.get(target)?.parts ?? [];
  const own = dummyOfLine(m, target);
  return [...(m.boqQty.get(target)?.parts ?? []), ...(own && !own.map ? m.targets.get(own.id)?.parts ?? [] : [])];
}
const totalsCache = new WeakMap<QtoModel, Map<string, number>>();
/** what is measured per line of the BOQ copy: as the estimate's Take-off column will show it for this take-off */
export function lineTotals(m: QtoModel): Map<string, number> {
  let t = totalsCache.get(m);
  if (t) return t;
  t = new Map();
  for (const [id, q] of m.boqQty) t.set(id, q.total);
  for (const d of m.dummies) { if (d.map) continue; const q = m.targets.get(d.id); if (q) { const id = qxId(d.id); t.set(id, (t.get(id) ?? 0) + q.total); } }
  totalsCache.set(m, t);
  return t;
}
/** ...for one line (null: nothing linked), or for an additional item / temporary line ('dm:<id>') */
export const qtyOf = (m: QtoModel, target: string): number | null => (target.startsWith('dm:') ? m.targets.get(target)?.total ?? null : lineTotals(m).get(target) ?? null);
/** the BOQ lines with something this person linked (straight, or through a temporary line / additional item) */
export function linesLinkedBy(m: QtoModel, me: string): Set<string> {
  const out = new Set<string>();
  for (const l of m.links) {
    if (l.by !== me) continue;
    if (l.to.startsWith('b:')) out.add(l.to.slice(2));
    else { const d = m.dummyById.get(l.to); if (d) out.add(d.map ?? qxId(d.id)); }
  }
  return out;
}

/** the take-offs linked to a line of the BOQ copy, or to an additional item / temporary line (id 'dm:...'), with every link of each */
export function linkedItems(m: QtoModel, target: string): { ti: string; links: Link[]; v: number }[] {
  const out = new Map<string, { ti: string; links: Link[]; v: number }>();
  const isDm = target.startsWith('dm:');
  for (const p of partsOf(m, target)) {
    const o = out.get(p.link.ti) ?? out.set(p.link.ti, { ti: p.link.ti, links: [], v: 0 }).get(p.link.ti)!;
    o.v += p.v;
  }
  // every link of each (a second one counted once too: unlinking must leave it really unlinked)
  for (const l of m.links) {
    if (isDm ? l.to !== target : !linksTo(m, l.ti, target).some((x) => x.id === l.id)) continue;
    const o = out.get(l.ti) ?? out.set(l.ti, { ti: l.ti, links: [], v: 0 }).get(l.ti)!;
    o.links.push(l);
  }
  return [...out.values()];
}

/** unlinking (item 24): only the links go - the take-off and its shapes stay */
export const unlinkOps = (links: Pick<Link, 'id'>[]): Op[] => links.map((l) => [l.id, 'del', true] as Op);

/** what a take-off is linked to, for its mark in the take-off list: none · BOQ item · additional item */
export function linkKind(m: QtoModel, ti: string): { k: 'none' | 'boq' | 'add'; n: number; open: number } {
  const ls = m.linksByItem.get(ti) ?? [];
  if (!ls.length) return { k: 'none', n: 0, open: 0 };
  const boq = hasBoq(m);
  let add = 0, open = 0;
  for (const l of ls) {
    const d = l.to.startsWith('b:') ? dummyOfLine(m, l.to.slice(2)) : m.dummyById.get(l.to);
    if (!d) { if (l.to.startsWith('b:') && m.boqById.get(l.to.slice(2))?.qa) add++; continue; }
    const st = dummyState(m, d, boq);
    if (st === 'add') add++;
    if (st === 'open') { add++; open++; }
  }
  return { k: add ? 'add' : 'boq', n: ls.length, open };
}
