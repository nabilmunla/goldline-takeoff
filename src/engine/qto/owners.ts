// v0.16 (group e, item 27): whose shapes are whose on a shared take-off.
//
// A shape's owner is who drew it (`by` on sh:; a shape from before `by` existed: its take-off's owner).
// Someone else who changes it (an estimator with "Edit other people's shapes" on) becomes a joint owner:
// `co:<username>` = true on the shape - one field per person, so two people editing the same shape on two
// PCs at once both stay recorded (a list in one field would keep only the last writer). The owner stays.
// Pieces of a split / join carry the owners of what they were made from.
//
// What is SHOWN is per person and per PC (a QS sees his own by default); what is COUNTED is always
// everyone's - quantities never depend on who looks (the BOQ, the estimate, every total).
import type { Op } from '../types';
import { itemQty, mainMeasure, measureOf, type Measure, type QtoModel, type Shape, type TItem } from './model';
import { ROOM_SETTING_FIELDS } from './rooms';
import { codeKey, covers, type FinFilter } from './finishes';

export const CO = 'co:';

type ItemsOnly = Pick<QtoModel, 'itemById'>;

/** who drew it ('' = nobody known: an old shape of a take-off without an owner) */
export function ownerOf(m: ItemsOnly, s: Pick<Shape, 'by' | 'ti'>): string {
  return s.by || m.itemById.get(s.ti)?.owner || '';
}

/** who it belongs to: who drew it, then the joint owners */
export function ownersOf(m: ItemsOnly, s: Pick<Shape, 'by' | 'ti' | 'co'>): string[] {
  const o = ownerOf(m, s);
  return [...(o ? [o] : []), ...(s.co ?? []).filter((u) => u && u !== o)];
}

/** it is this person's: drew it, changed it since (joint owner), or nobody is known to own it */
export function isMine(m: ItemsOnly, s: Pick<Shape, 'by' | 'ti' | 'co'>, me: string): boolean {
  const o = ownerOf(m, s);
  return !o || o === me || !!s.co?.includes(me);
}

/** may this person change it: theirs, or other people's while they may edit those (estimators / admins, switched on) */
export const mayEdit = (m: ItemsOnly, s: Pick<Shape, 'by' | 'ti' | 'co'>, me: string, editOthers: boolean) => editOthers || isMine(m, s, me);

/**
 * Shown on the drawing for a choice of people: `shown` = the usernames whose shapes are shown, null = everyone's.
 * A shape is shown when any of its owners is chosen; a shape nobody is known to own always is.
 */
export function shownFor(m: ItemsOnly, s: Pick<Shape, 'by' | 'ti' | 'co'>, shown: ReadonlySet<string> | null): boolean {
  if (!shown) return true;
  const o = ownerOf(m, s);
  if (!o || shown.has(o)) return true;
  return !!s.co?.some((u) => shown.has(u));
}

/**
 * What one person is shown: a QS his own (and, switched on, everyone else's to look at); estimators and
 * administrators everyone's, or the people they tick. null = everyone's.
 */
export function shownPeople(o: { qs: boolean; me: string; showOthers: boolean; pick: ReadonlySet<string> | null }): ReadonlySet<string> | null {
  if (o.qs) return o.showOthers ? null : new Set([o.me]);
  return o.pick;
}

/** the people with shapes in the take-off (who drew them, and joint owners), the most shapes first, then by name */
export function peopleWithShapes(m: Pick<QtoModel, 'itemById' | 'shapes'>): { username: string; n: number }[] {
  const n = new Map<string, number>();
  for (const s of m.shapes) for (const u of ownersOf(m, s)) n.set(u, (n.get(u) ?? 0) + 1);
  return [...n].map(([username, k]) => ({ username, n: k })).sort((a, b) => b.n - a.n || a.username.localeCompare(b.username));
}

// ---------------------------------------------------------------- changes to other people's shapes
/** the fields that are a shape's measurement: changing one changes the shape */
// (v0.18.3 an element's own figures, its own type, a stair landing, a counted door are its measurement too:
//  someone else changing them is refused or made joint owner like any change - BUG-006)
const CONTENT = new Set(['p', 'b', 'holes', 'sg', 'k', 'del', 'ti', 'm', 'xw', 'xd', 'xt', 'xh', 'xr', 'xn', 'sp', 'mt', 'door']);

const byIdCache = new WeakMap<object, Map<string, Shape>>();
const shapeIndex = (m: Pick<QtoModel, 'shapes'>) => {
  let x = byIdCache.get(m.shapes);
  if (!x) { x = new Map(m.shapes.map((s) => [s.id, s])); byIdCache.set(m.shapes, x); }
  return x;
};

/**
 * The shapes (already there) a batch of changes changes: their outline, tags, take-off, repeat, deletion, or a door /
 * opening put on, changed on or taken off them. Shapes deleted with their take-off (or room) are not counted: who may
 * delete a take-off is the take-off's question (the list asks it). Fingerprints, pages (a bound set split, a page
 * the new revision lost) and "checked" marks are not changes of the measurement either.
 */
/** a room's measurement (v0.16): its settings and Times; an additional finish's / ceiling area's; a take-off's link to it */
// (v0.16.3 its name, description and heading too: what a Finishes Summary link picks rooms by)
const ROOM_FIELDS = new Set<string>([...ROOM_SETTING_FIELDS, 'x', 'name', 'desc', 'par', 'cnn', 'cnv']);
/** a sheet's scale (and its viewports'): every shape on it changes (v0.16.3) */
const PAGE_SCALE = new Set(['sc', 'scy', 'scy0']);
const PART_FIELDS = new Set(['h', 'bl', 'rded', 'full', 'fcode', 'rcat', 'rm', 'rk', 'del', 'ak', 'lv', 'fa', 'fac', 'bh', 'bp', 'wa']);
const LINK_FIELDS = new Set(['rded', 'rh', 'rcat', 'rm', 'rk']);

/**
 * v0.16.2 (0.16.2 QA hunt BUG-003): a take-off's own settings are part of its measurements - height, waste, Times,
 * unit, deductions, lintels, its finish code (where it counts in the Finishes Summary), its name: changing one
 * changes every shape in it (21 m² of someone's wall become 28 m²). Free for anyone who may edit the project: where
 * it sits in the list (order, heading), its colour and how it is drawn - and private / delete, which the list asks.
 */
// (not 'owner': who a take-off is - and so who its older shapes without their own `by` are - is not anyone's to change)
const ITEM_FREE = new Set(['ord', 'par', 'color', 'fill', 'lab', 'priv', 'del']);
/** a BOQ link of a take-off (lk:) made, changed or removed: the take-off's quantity goes elsewhere (v0.16.2) */
const LINK_ENT = 'lk:';

export function shapesChanged(m: Pick<QtoModel, 'shapes' | 'openings'> & Partial<Pick<QtoModel, 'itemById' | 'links' | 'regions' | 'doorById' | 'fin'>>, ops: Op[], linksToo = true): Shape[] {
  // (a room's settings, its own finishes and the take-offs linked to it change its quantities as much as its
  // outline does: they count as a change of its outline - who drew it decides, as for a door put on it)
  const rooms = new Set<string>();
  /** take-offs whose settings (or BOQ links) change: every shape in them (v0.16.2) */
  const whole = new Set<string>();
  if (m.itemById) {
    for (const [e, f, v] of ops) {
      if (linksToo && e.startsWith(LINK_ENT)) {
        // a link made (its take-off in the batch), changed or removed (the link already there)
        const ti = f === 'ti' && typeof v === 'string' ? v : m.links?.find((l) => l.id === e)?.ti;
        if (ti && m.itemById.has(ti)) whole.add(ti);
        continue;
      }
      // v0.16.3 (fresh-eyes review) a new shape drawn into a room's own finish (or a take-off linked to a room)
      // changes that room's quantities - as a door put on it does
      if (e.startsWith('sh:') && f === 'ti' && typeof v === 'string') { const it = m.itemById.get(v); if (it?.rm) rooms.add(it.rm); continue; }
      if (!e.startsWith('ti:')) continue;
      const it = m.itemById.get(e);
      // (a room's own finishes count as the room's - below; a take-off linked to a room is its own; its heading is
      // free unless it has a finish code - a Finishes Summary link may pick it by its heading)
      if (it && it.kind !== 'room' && !(it.rm && it.rk !== 'link') && (!ITEM_FREE.has(f) || (f === 'par' && !!it.fcode))) whole.add(e);
      if (it?.kind === 'room') { if (ROOM_FIELDS.has(f)) rooms.add(e); continue; }
      if (f === 'rm' && typeof v === 'string') rooms.add(v); // a new finish of a room, a take-off linked to one
      if (it?.rm && (it.rk === 'link' ? LINK_FIELDS : PART_FIELDS).has(f)) rooms.add(it.rm);
    }
  }
  // v0.16.3 (fresh-eyes review) more ways other people's quantities change:
  // - a sheet's scale, a viewport on it, the drawing removed (for everyone: the shapes on it);
  const pages = new Set<string>(), dwgs = new Set<string>();
  const srAt = new Map<string, { dwg?: string; pg?: number }>();
  for (const [e, f, v] of ops) {
    if (e.startsWith('pg:') && PAGE_SCALE.has(f)) pages.add(e.slice(3));
    else if (e.startsWith('dwg:') && f === 'del' && v === true) dwgs.add(e);
    else if (e.startsWith('sr:')) {
      const r = m.regions?.find((x) => x.id === e);
      const at = srAt.get(e) ?? { dwg: r?.dwg, pg: r?.pg };
      if (f === 'dwg' && typeof v === 'string') at.dwg = v;
      if (f === 'pg' && typeof v === 'number') at.pg = v;
      srAt.set(e, at);
    }
  }
  for (const at of srAt.values()) if (at.dwg !== undefined && at.pg !== undefined) pages.add(at.dwg + '.' + at.pg);
  // - (a QS: the project's tables an estimator keeps) a door schedule row's sizes or BOQ link - the doors of that
  //   row counted anywhere; a Finishes Summary link made or removed - the rooms and take-offs it covers
  const doors = new Set<string>();
  if (linksToo && m.itemById) {
    for (const [e, f] of ops) if (e.startsWith('ds:') && m.doorById?.has(e) && f !== 'ord') doors.add(e);
    for (const [e, f, v] of ops) if (e.startsWith(LINK_ENT)) { const ti = f === 'ti' && typeof v === 'string' ? v : m.links?.find((l) => l.id === e)?.ti; if (ti?.startsWith('ds:') && m.doorById?.has(ti)) doors.add(ti); }
    if (m.fin) {
      const fresh = new Map<string, Record<string, unknown>>();
      for (const [e, f, v] of ops) {
        if (!e.startsWith('fl:')) continue;
        const old = m.fin.linkById.get(e);
        if (old) { for (const a of old.atoms) markAtom(a); continue; }
        (fresh.get(e) ?? fresh.set(e, {}).get(e)!)[f] = v;
      }
      for (const n of fresh.values()) {
        if (typeof n.code !== 'string' || typeof n.unit !== 'string') continue;
        const parse = <T,>(x: unknown, d: T): T => { try { return typeof x === 'string' ? (JSON.parse(x) as T) : d; } catch { return d; } };
        // (nb as written: a portion link of its own code only - without it another room's "(vertical)" part of the
        // same code was counted, and the link was refused as view only - 0.23.2, DeepSeek #15)
        const pred = { key: codeKey(n.code), unit: n.unit, g: parse<[string, string][]>(n.g, []), flt: parse<FinFilter>(n.flt, {}), nb: n.nb === true };
        for (const a of m.fin.atoms) if (covers(pred as never, a)) markAtom(a.id);
      }
    }
  }
  function markAtom(id: string) {
    const a = m.fin?.atomById.get(id);
    if (!a || !m.itemById) return;
    for (const x of [a.room, ...a.src]) {
      const it = x ? m.itemById.get(x) : undefined;
      if (!it) continue;
      if (it.kind === 'room') rooms.add(it.id); else if (it.rm && it.rk !== 'link') rooms.add(it.rm); else whole.add(it.id);
    }
  }
  if (!rooms.size && !whole.size && !pages.size && !dwgs.size && !doors.size && !ops.some((o) => o[0].startsWith('sh:') || o[0].startsWith('op:'))) return [];
  const idx = shapeIndex(m);
  const goneItems = new Set(ops.filter((o) => o[0].startsWith('ti:') && o[1] === 'del' && o[2] === true).map((o) => o[0]));
  const out = new Map<string, Shape>();
  const add = (s: Shape | undefined, f: string) => { if (s && !(f === 'del' && goneItems.has(s.ti)) && !goneItems.has(s.ti)) out.set(s.id, s); };
  let opIdx: Map<string, string> | null = null;
  const newOn = new Map<string, string>();
  for (const [e, f, v] of ops) if (e.startsWith('op:') && f === 'sh' && typeof v === 'string') newOn.set(e, v);
  for (const [e, f] of ops) {
    if (e.startsWith('sh:')) { if (CONTENT.has(f)) add(idx.get(e), f); continue; }
    if (!e.startsWith('op:')) continue;
    opIdx ??= new Map(m.openings.map((o) => [o.id, o.sh]));
    const on = newOn.get(e) ?? opIdx.get(e);
    if (on) add(idx.get(on), f);
  }
  if (rooms.size) for (const s of m.shapes) if (s.k === 'poly' && rooms.has(s.ti) && m.itemById?.get(s.ti)?.kind === 'room') add(s, 'p');
  if (whole.size) for (const s of m.shapes) if (whole.has(s.ti)) add(s, 'p');
  if (pages.size || dwgs.size) for (const s of m.shapes) if (dwgs.has(s.dwg) || pages.has(s.dwg + '.' + s.pg)) add(s, 'p');
  if (doors.size) {
    const walls = new Set(m.openings.filter((o) => o.door && doors.has(o.door)).map((o) => o.sh));
    for (const s of m.shapes) if (walls.has(s.id) || (s.door && doors.has(s.door))) add(s, 'p');
  }
  return [...out.values()];
}

export interface Ownership {
  /** other people's shapes it changes that this person may not change (view only): the batch must not go */
  locked: Shape[];
  /** other people's shapes it changes (this person may: they become a joint owner) */
  joint: Shape[];
  /** the joint-owner fields to add to the batch */
  ops: Op[];
}

/**
 * Who owns what a batch changes. Other people's shapes: refused (`locked`) unless this person may edit them; when
 * they may, they become a joint owner (`co:<me>`). New pieces made from shapes (a split, a join: `of`) keep the
 * owners of what they were made from - their own `by` (pieceOps keeps the first one's) and the others as joint owners,
 * this person too when what they were made from was not theirs.
 */
export function ownership(m: Pick<QtoModel, 'shapes' | 'openings' | 'itemById'> & Partial<Pick<QtoModel, 'links' | 'regions' | 'doorById' | 'fin'>>, ops: Op[], me: string, editOthers: boolean, opts: { boq?: boolean } = {}): Ownership {
  // (opts.boq: an estimator / administrator - they keep the BOQ: linking a take-off to it is theirs to do, whoever
  // measured it; a QS links only his own measurements)
  const changed = shapesChanged(m, ops, !opts.boq);
  const others = changed.filter((s) => !isMine(m, s, me));
  const locked = editOthers ? [] : others;
  const extra: Op[] = [];
  if (!locked.length) {
    for (const s of others) extra.push([s.id, CO + me, true]);
    // pieces of a split / join
    const idx = shapeIndex(m);
    const by = new Map<string, string>();
    for (const [e, f, v] of ops) if (e.startsWith('sh:') && f === 'by' && typeof v === 'string') by.set(e, v);
    for (const [e, f, v] of ops) {
      if (!e.startsWith('sh:') || f !== 'of' || typeof v !== 'string' || idx.has(e)) continue;
      let of: unknown;
      try { of = JSON.parse(v); } catch { continue; }
      if (!Array.isArray(of)) continue;
      const src = of.map((id) => idx.get(String(id))).filter((x): x is Shape => !!x);
      if (!src.length) continue;
      const own = by.get(e) ?? '';
      const co = new Set<string>();
      for (const s of src) for (const u of ownersOf(m, s)) co.add(u);
      if (src.some((s) => !isMine(m, s, me))) co.add(me);
      co.delete(own);
      co.delete('');
      for (const u of [...co].sort()) extra.push([e, CO + u, true]);
    }
  }
  return { locked, joint: locked.length ? [] : others, ops: extra };
}

/** the history's words for a change of other people's shapes: "Moved node — Sara Khan's shape, also edited by Omar Ali" */
export function jointLabel(label: string, joint: Shape[], m: ItemsOnly, nameOf: (u: string) => string, meName: string): string {
  if (!joint.length) return label;
  const owners = [...new Set(joint.map((s) => ownerOf(m, s)).filter(Boolean))].map(nameOf);
  const whose = owners.length === 1 ? owners[0] + "'s" : owners.length === 2 ? owners.join(' and ') + "'s" : 'other people\'s';
  return `${label} — ${whose} shape${joint.length > 1 ? 's' : ''}, also edited by ${meName}`;
}

/** "by Sara Khan · also edited by Omar Ali" */
export function ownerText(m: ItemsOnly, s: Pick<Shape, 'by' | 'ti' | 'co'>, nameOf: (u: string) => string): string {
  const o = ownerOf(m, s);
  const co = (s.co ?? []).filter((u) => u && u !== o);
  return (o ? 'by ' + nameOf(o) : 'by nobody known') + (co.length ? ' · also edited by ' + co.map(nameOf).join(', ') : '');
}

// ---------------------------------------------------------------- yours / others' in a total
/**
 * A take-off's main quantity split between one person's shapes and everyone else's - to explain a total that the
 * shapes they see don't add up to. Openings deducted from other take-offs are shared out in proportion (so the two
 * always add up to the total, which stays everyone's). null: no shapes of anyone else.
 */
export function ownerSplit(m: QtoModel, it: TItem, isTheirs: (s: Shape) => boolean): { ms: Measure; mine: number; others: number; nOthers: number } | null {
  const list = m.shapesByItem.get(it.id) ?? [];
  const mine = list.filter(isTheirs);
  const nOthers = list.length - mine.length;
  if (!nOthers) return null;
  const ms = mainMeasure(it);
  const total = measureOf(m.qty.get(it.id) ?? itemQty(m, it), ms);
  const part = (shapes: Shape[]) => {
    const by = new Map(m.shapesByItem);
    by.set(it.id, shapes);
    // (depth 2: without the openings of other take-offs - those are shared out below)
    return measureOf(itemQty({ shapesByItem: by, itemById: m.itemById, pages: m.pages, regions: m.regions, openingsByShape: m.openingsByShape, doorById: m.doorById, beamTypeById: m.beamTypeById, colTypeById: m.colTypeById, wallTypeById: m.wallTypeById, swTypeById: m.swTypeById, ftgTypeById: m.ftgTypeById, rwTypeById: m.rwTypeById, stairTypeById: m.stairTypeById, shapesByPage: m.shapesByPage }, it, 2), ms);
  };
  const a = part(mine), b = part(list.filter((s) => !isTheirs(s)));
  const g = a + b;
  const yours = g > 0 ? (total * a) / g : 0;
  return { ms, mine: yours, others: total - yours, nOthers };
}
