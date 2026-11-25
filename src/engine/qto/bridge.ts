// The two directions between an estimation project and its take-off projects.
//
//  estimation -> take-off : a price-free copy of the BOQ lines (structure, ref,
//                           description, unit, BOQ qty, page). Never a rate, amount,
//                           package, company or status. Written by the estimator's app.
//  take-off -> estimation : the quantity measured for each BOQ line ("tq").
//                           Written by the estimator's app into the estimation project.
//
// QS never open the estimation project, so the only way anything reaches them is
// through the copy below. Keep that list of fields short and price-free.
//
// v0.16 - additional items: a QS's additional item (dm:<id> with add, bill, loc) and a temporary line not
// resolved once the BOQ is there (dm:<id>, not matched) each reach the estimate as a line of their own,
// "qx_<id>", in the heading "Additional items (QS)" at the end of its bill ("qa_<bill id>"; one not
// resolved, or without a bill: "qa_end" at the end of the BOQ). Ids come from the take-off's ids, so
// any number of apps write the same rows. See additionalOps for who owns which field.
import { generateKeyBetween } from 'fractional-indexing';
import type { BoqModel, BoqNode, PurgeCheck } from '../boq';
import { UNFILED, buildModel, readSuggestion, type QaSuggestion } from '../boq';
import type { Batch, FsApi, ProjectMeta } from '../types';
import type { Store } from '../store';
import { FORMAT_V16 } from '../version';
import type { Op, Value } from '../types';
import { buildQtoModel, qxId, measureOf, type QtoModel, type Dummy, type Measure } from './model';

/** The only BOQ fields that ever leave the estimation project. (v0.16: qa, loc, qby, own - additional items) */
// v0.16.2 src: where the line came from (importId:file:sheet:row) - the take-off side makes the filled copy too
// (v0.16.3 q0: the consultant's quantity at import - the filled copy finds a line's row by it after the estimator
// changed the BOQ quantity)
export const MIRROR_FIELDS = ['bt', 'par', 'ord', 'ref', 'desc', 'unit', 'qty', 'page', 'qa', 'loc', 'qby', 'own', 'src', 'q0'] as const;

function desired(n: BoqNode): Record<(typeof MIRROR_FIELDS)[number], Value> {
  const qa = n.qa;
  return {
    bt: n.type, par: n.parent, ord: n.ord, ref: n.ref, desc: n.desc, unit: n.type === 'group' ? '' : n.unit, qty: n.type === 'item' ? n.qty : null, page: n.page,
    qa: qa?.k ?? null, loc: qa && qa.k !== 'g' ? qa.loc || null : null, qby: qa && qa.k !== 'g' ? qa.by || null : null, own: qa && qa.k !== 'g' && qa.own ? true : null,
    src: n.src || null,
    q0: n.type === 'item' ? n.q0 : null,
  };
}

/** Ops that bring the take-off project's BOQ copy up to date. Empty when nothing changed. */
export function mirrorOps(boq: BoqModel, qto: Store): Op[] {
  const ops: Op[] = [];
  const want = new Set<string>();
  for (const n of boq.byId.values()) {
    if (n.id === UNFILED) continue;
    const eid = 'b:' + n.id;
    want.add(eid);
    const d = desired(n);
    if (qto.get(eid, 'del') === true) ops.push([eid, 'del', null]);
    for (const f of MIRROR_FIELDS) {
      const cur = qto.get(eid, f);
      const v = d[f];
      if ((cur ?? null) !== (v ?? null)) ops.push([eid, f, v ?? null]);
    }
  }
  // v0.16.2 the import records (files, sheets, header rows, columns - nothing priced): bi:<importId>
  for (const [id, files] of boq.imports ?? []) if (qto.get('bi:' + id, 'files') !== files) ops.push(['bi:' + id, 'files', files]);
  // lines deleted (or purged) in the estimation project
  for (const [eid, ent] of qto.ents) {
    if (!eid.startsWith('b:') || want.has(eid)) continue;
    if (ent.get('del')?.v !== true && ent.has('bt')) ops.push([eid, 'del', true]);
  }
  return ops;
}

// 12 significant digits: every real decimal kept, only the float noise that would differ between PCs
// (adding the same shapes in another order) is dropped, so two PCs never rewrite each other's value
export const roundQty = (x: number) => Number(x.toPrecision(12));

/**
 * Ops that write take-off quantities into the estimation project ("tq" on each item).
 * totals: BOQ line id -> measured quantity, summed over every attached take-off project.
 * Lines with no linked take-off get tq = null.
 */
export function takeoffQtyOps(boq: BoqModel, est: Store, totals: Map<string, number>, measures?: Map<string, Partial<Record<Measure, number>>>): Op[] {
  const ops: Op[] = [];
  for (const n of boq.byId.values()) {
    // a line made a heading or a description keeps no take-off figure (it would look counted)
    if (n.type !== 'item') {
      if ((est.get(n.id, 'tq') ?? null) !== null) ops.push([n.id, 'tq', null]);
      if ((est.get(n.id, 'tqm') ?? null) !== null) ops.push([n.id, 'tqm', null]);
      continue;
    }
    const t = totals.get(n.id);
    const v = t === undefined ? null : roundQty(t);
    const cur = est.get(n.id, 'tq');
    if ((cur ?? null) !== v) ops.push([n.id, 'tq', v]);
    if (measures) {
      const tm = tqmText(measures.get(n.id));
      if ((est.get(n.id, 'tqm') ?? null) !== tm) ops.push([n.id, 'tqm', tm]);
    }
  }
  return ops;
}

// ---------------------------------------------------------------- v0.16 additional items
/** the heading "Additional items (QS)" at the end of a bill, and the one at the end of the BOQ */
export const qaGroupId = (billId: string | null) => (billId ? 'qa_' + billId : 'qa_end');
export const QA_GROUP_DESC = 'Additional items (QS)';

/** a take-off linked to the estimate, as the sync reads it */
export interface SyncTakeoff {
  id: string;
  model: QtoModel;
}

/**
 * What every linked take-off measured, per estimate line (summed over the take-offs): the BOQ lines
 * (boqQty: links straight to them and through matched temporary lines) and the lines additional items
 * and temporary lines not resolved yet became (qx_<id>, from what is linked to them). Every app adds in
 * the same order (take-offs by id), so the figures are the same to the digit on every PC.
 */
export function takeoffTotals(qtos: SyncTakeoff[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const t of [...qtos].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    for (const [id, q] of t.model.boqQty) totals.set(id, (totals.get(id) ?? 0) + q.total);
    for (const d of t.model.dummies) {
      if (d.map) continue;
      const q = t.model.targets.get(d.id);
      if (q) { const id = qxId(d.id); totals.set(id, (totals.get(id) ?? 0) + q.total); }
    }
  }
  return totals;
}

/**
 * 0.21 (M4-01): the other measures of the shapes behind each estimate line - the formwork, steel, area...
 * of the slabs whose volume makes a concrete line - so a build-up reads them (TQFORM, TQKG...) instead of a
 * figure typed twice (SA-11, SA-24). Each shape gives them in the share it gives the line (its link's
 * factor); door counters and Finishes portions give none. Metric, as measured.
 */
export const TQ_MEASURES: Measure[] = ['vol', 'form', 'kg', 'area', 'len', 'perim', 'cnt', 'wph', 'wpv', 'blv', 'pea'];
export function takeoffMeasures(qtos: SyncTakeoff[]): Map<string, Partial<Record<Measure, number>>> {
  const out = new Map<string, Partial<Record<Measure, number>>>();
  const add = (id: string, parts: { link: { f: number; dup?: boolean; ti: string }; item: { id: string }; fl?: string }[], m: QtoModel) => {
    for (const p of parts) {
      if (p.fl || p.link.dup || p.link.ti.startsWith('ds:')) continue;
      const iq = m.qty.get(p.item.id);
      if (!iq) continue;
      const rec = out.get(id) ?? out.set(id, {}).get(id)!;
      for (const ms of TQ_MEASURES) {
        const v = measureOf(iq, ms) * p.link.f;
        if (v) rec[ms] = (rec[ms] ?? 0) + v;
      }
    }
  };
  for (const t of [...qtos].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    for (const [id, q] of t.model.boqQty) add(id, q.parts, t.model);
    // (review M3 F12) additional items / temporary lines not matched yet: their own line, as takeoffTotals does
    for (const d of t.model.dummies ?? []) {
      if (d.map) continue;
      const q = t.model.targets?.get(d.id);
      if (q) add(qxId(d.id), q.parts, t.model);
    }
  }
  return out;
}
/** the measures as stored on the estimate line: JSON, rounded like the quantities, in a fixed order */
export function tqmText(m: Partial<Record<Measure, number>> | undefined): string | null {
  if (!m) return null;
  const o: Record<string, number> = {};
  for (const ms of TQ_MEASURES) if (m[ms]) o[ms] = roundQty(m[ms]!);
  return Object.keys(o).length ? JSON.stringify(o) : null;
}

/** the bills of the estimate's BOQ a QS can put an additional item in (top-level headings) */
export function billsOf(boq: BoqModel): BoqNode[] {
  return boq.roots.filter((r) => r.type === 'group' && r.id !== UNFILED && r.qa?.k !== 'g');
}

const endKey = (last: string | null): string => {
  try { return generateKeyBetween(last || null, null); } catch { return (last || 'a0') + 'V'; }
};

interface Want { id: string; qto: string; d: Dummy; k: 'a' | 'n'; group: string; bill: string | null; q: number | null }

/**
 * Ops that bring the estimate's lines for additional items (and temporary lines not resolved) up to
 * date with the linked take-offs. Run by the estimator's side only (an estimator / administrator app
 * that may edit the estimate - with it open, or in the background), never by a QS's app.
 *
 * Who owns what, once the line is there:
 *  - The QS suggests: description, unit, ref, bill, location (and the quantity, which follows the
 *    take-off). Each suggested field is written while the estimate still has what was last suggested
 *    (kept in `qs`); once the estimator changes a field in the estimate (any app, any version), that
 *    field is the estimator's and the QS's later changes to it are not applied. What the estimate has
 *    is what the take-off shows (through the BOQ copy: qa, loc, qby, own).
 *  - Prices, statuses, build-ups: always the estimator's (never suggested, never sent to the QS).
 *  - Matched to / relinked to a BOQ line (dm.map): the line goes (recycle bin, `qdel`), its quantity
 *    counts in that BOQ line's Take-off column; unmatched again, it comes back as it was.
 *  - Removed from the take-off (or the take-off unlinked - only judged when every linked take-off
 *    could be read: `complete`): the line goes if the estimator never touched it, else it stays as the
 *    estimator's, marked `qgone`.
 *  - A line the estimator deleted is left deleted (only the sync's own deletes are undone).
 * `totals`: takeoffTotals of the same take-offs.
 */
export function additionalOps(boq: BoqModel, est: Store, qtos: SyncTakeoff[], totals: Map<string, number>, complete: boolean): Op[] {
  const ops: Op[] = [];
  const put = (e: string, f: string, v: Value) => { if ((est.get(e, f) ?? null) !== (v ?? null)) ops.push([e, f, v ?? null]); };
  const bills = new Set(billsOf(boq).map((b) => b.id));
  let hasBoq = false;
  for (const n of boq.byId.values()) if (n.type === 'item' && !n.qa) { hasBoq = true; break; }
  const sorted = [...qtos].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const want = new Map<string, Want>();
  const matched = new Set<string>();
  const known = new Set<string>(sorted.map((t) => t.id));
  for (const t of sorted) {
    for (const d of t.model.dummies) {
      const id = qxId(d.id);
      if (want.has(id)) continue;
      if (d.map) { matched.add(id); continue; }
      const k: 'a' | 'n' | null = d.add ? 'a' : hasBoq ? 'n' : null;
      if (!k) continue;
      const bill = k === 'a' && bills.has(d.bill) ? d.bill : null;
      const t0 = totals.get(id);
      want.set(id, { id, qto: t.id, d, k, group: qaGroupId(bill), bill, q: t0 === undefined ? null : roundQty(t0) });
    }
  }
  // headings: made when a line needs one (and brought back if deleted - a line under a deleted heading
  // would be hidden: no line of a take-off may go missing from the estimate)
  const lastOrd = new Map<string, string | null>();
  const lastIn = (parent: string | null): string | null => {
    const k = parent ?? '';
    if (lastOrd.has(k)) return lastOrd.get(k)!;
    const kids = parent ? boq.byId.get(parent)?.children ?? [] : boq.roots.filter((r) => r.id !== UNFILED);
    let last: string | null = null;
    for (const c of kids) if (!last || c.ord > last) last = c.ord;
    lastOrd.set(k, last);
    return last;
  };
  const nextOrd = (parent: string | null) => { const o = endKey(lastIn(parent)); lastOrd.set(parent ?? '', o); return o; };
  const groupReady = new Set<string>();
  /** lines moved to another heading this time (their old heading may be left empty) */
  const movedOut = new Set<string>();
  const ensureGroup = (gid: string, bill: string | null) => {
    if (groupReady.has(gid)) return;
    groupReady.add(gid);
    const ent = est.ents.get(gid);
    if (!ent || !ent.has('type')) {
      ops.push([gid, 'type', 'group'], [gid, 'parent', bill], [gid, 'ord', nextOrd(bill)], [gid, 'ref', ''], [gid, 'desc', QA_GROUP_DESC], [gid, 'qa', 'g'], [gid, 'del', null]);
      return;
    }
    put(gid, 'del', null);
    put(gid, 'qdel', null);
    put(gid, 'qa', 'g');
  };
  for (const w of [...want.values()].sort((a, b) => (a.qto < b.qto ? -1 : a.qto > b.qto ? 1 : a.d.ord < b.d.ord ? -1 : a.d.ord > b.d.ord ? 1 : a.id < b.id ? -1 : 1))) {
    const ent = est.ents.get(w.id);
    const sugg: QaSuggestion = { p: w.group, d: w.d.desc, u: w.d.unit, r: w.d.ref, l: w.d.loc, q: w.q };
    const fresh = !ent || !ent.has('type');
    // deleted by the estimator: left so (the take-off says it was removed in the estimate)
    if (!fresh && est.get(w.id, 'del') === true && est.get(w.id, 'qdel') !== true) continue;
    if (fresh) {
      ensureGroup(w.group, w.bill);
      ops.push(
        [w.id, 'type', 'item'], [w.id, 'parent', w.group], [w.id, 'ord', nextOrd(w.group)], [w.id, 'ref', w.d.ref || null], [w.id, 'desc', w.d.desc], [w.id, 'unit', w.d.unit || null],
        [w.id, 'qty', w.q], [w.id, 'tq', w.q], [w.id, 'qa', w.k], [w.id, 'qsrc', w.qto], [w.id, 'qby', w.d.byName || null], [w.id, 'qloc', w.d.loc || null], [w.id, 'qs', JSON.stringify(sugg)], [w.id, 'del', null],
      );
      continue;
    }
    const was = readSuggestion(est.get(w.id, 'qs')) ?? { p: (est.get(w.id, 'parent') as string) ?? null, d: String(est.get(w.id, 'desc') ?? ''), u: String(est.get(w.id, 'unit') ?? ''), r: String(est.get(w.id, 'ref') ?? ''), l: String(est.get(w.id, 'qloc') ?? ''), q: null };
    const next: QaSuggestion = { ...was };
    const cur = (f: string) => est.get(w.id, f) ?? null;
    // a field the estimator hasn't changed (it still holds what was suggested) takes the new suggestion
    const take = (key: keyof QaSuggestion, field: string, v: string | number | null, blank: string | null = '') => {
      const c = cur(field);
      const same = key === 'q' ? c === was.q : (c ?? blank ?? '') === ((was[key] as string | null) ?? blank ?? '');
      if (!same || ((was[key] ?? null) === (v ?? null))) return false;
      ops.push([w.id, field, v === '' ? null : v]);
      (next as any)[key] = v;
      return true;
    };
    if ((cur('parent') ?? null) === (was.p ?? null) && was.p !== w.group) {
      ensureGroup(w.group, w.bill);
      ops.push([w.id, 'parent', w.group], [w.id, 'ord', nextOrd(w.group)]);
      next.p = w.group;
      movedOut.add(w.id);
    } else if ((cur('parent') ?? null) === w.group) ensureGroup(w.group, w.bill);
    take('d', 'desc', w.d.desc);
    take('u', 'unit', w.d.unit);
    take('r', 'ref', w.d.ref);
    take('l', 'qloc', w.d.loc);
    // (the quantity only from every take-off: another take-off may link to this line too - an app that
    //  could not read one would write a smaller figure, and an app that could would write it back)
    if (complete) take('q', 'qty', w.q, null);
    put(w.id, 'del', null);
    put(w.id, 'qdel', null);
    put(w.id, 'qa', w.k);
    put(w.id, 'qsrc', w.qto);
    put(w.id, 'qby', w.d.byName || null);
    put(w.id, 'qgone', null);
    const js = JSON.stringify(next);
    if (js !== est.get(w.id, 'qs')) ops.push([w.id, 'qs', js]);
  }
  // lines no longer wanted
  const going = new Set<string>();
  for (const n of boq.byId.values()) {
    if (n.type !== 'item' || !n.qa || n.qa.k === 'g' || want.has(n.id)) continue;
    if (matched.has(n.id)) { ops.push([n.id, 'del', true], [n.id, 'qdel', true]); going.add(n.id); continue; }
    // its take-off is open and the line is gone from it, or (everything read) its take-off is no longer linked
    if (!(known.has(n.qa.qto) || complete)) continue;
    if (n.qa.gone) continue;
    const touched = n.qa.own || n.bu > 0;
    if (!touched) { ops.push([n.id, 'del', true], [n.id, 'qdel', true]); going.add(n.id); }
    else ops.push([n.id, 'qgone', true]);
  }
  // headings left empty by the sync go too (one the estimator put lines in stays)
  for (const n of boq.byId.values()) {
    if (n.type !== 'group' || n.qa?.k !== 'g' || groupReady.has(n.id)) continue;
    if (n.children.every((c) => going.has(c.id) || movedOut.has(c.id))) ops.push([n.id, 'del', true], [n.id, 'qdel', true]);
  }
  return ops;
}

/** Attached take-off projects, as recorded in the estimation project ("qto:<take-off project id>"). */
export interface AttachedQto {
  id: string;
  name: string;
  folder: string;
}

export function attachedQtos(est: Store): AttachedQto[] {
  const out: AttachedQto[] = [];
  for (const [id, ent] of est.ents) {
    if (!id.startsWith('qto:') || ent.get('del')?.v === true || !ent.has('folder')) continue;
    out.push({ id: id.slice(4), name: String(ent.get('name')?.v ?? ''), folder: String(ent.get('folder')?.v ?? '') });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function attachOps(estId: string, estName: string, qto: { id: string; name: string; folder: string }): { est: Op[]; qto: Op[] } {
  return {
    est: [['qto:' + qto.id, 'name', qto.name], ['qto:' + qto.id, 'folder', qto.folder], ['qto:' + qto.id, 'del', null]],
    qto: [['project', 'est', estId], ['project', 'estName', estName]],
  };
}

export function detachOps(qtoId: string): { est: Op[]; qto: Op[] } {
  return { est: [['qto:' + qtoId, 'del', true]], qto: [['project', 'est', null], ['project', 'estName', null]] };
}

// ---------------------------------------------------------------- one round of the estimator's side
/** a project as the sync needs it (a ProjectSession) */
export interface SyncProject {
  store: Store;
  meta: ProjectMeta;
  readonly readOnly: boolean;
  commit(ops: Op[], label?: string, opts?: { recordUndo?: boolean }): Batch | null;
  /** marks the project with a data format older apps must open view only (ProjectSession) */
  needFormat?(fmt: number): void;
}

const SYNC_BATCH = 2500;
const putAll = (p: SyncProject, ops: Op[], label: string): number => {
  let n = 0;
  for (let i = 0; i < ops.length; i += SYNC_BATCH) { if (!p.commit(ops.slice(i, i + SYNC_BATCH), label, { recordUndo: false })) break; n += Math.min(SYNC_BATCH, ops.length - i); }
  return n;
};

/**
 * Everything the estimator's side keeps up to date between an estimate and its take-offs, in one go
 * (what useTakeoffLinks does while the estimate is on screen, for an estimate that isn't open):
 * the lines additional items need, the Take-off column, and the price-free BOQ copy in each take-off.
 * `qtos`: every take-off the estimate lists (attachedQtos), with its open project (null: could not be
 * opened) and `newer` when a newer app has worked in it (it is read but not trusted: nothing that
 * depends on all of them is written). A take-off linked to another estimate since is left out.
 * Nothing is written into a project open view only here.
 */
export function syncEstimate(est: SyncProject, qtos: { id: string; p: SyncProject | null; newer?: boolean }[], admins?: PurgeCheck): { wrote: number; complete: boolean } {
  if (est.readOnly) return { wrote: 0, complete: false };
  let wrote = 0;
  const mine = qtos.filter((q) => !!q.p && !q.newer && (!q.p.store.get('project', 'est') || q.p.store.get('project', 'est') === est.meta.id));
  const moved = qtos.filter((q) => !!q.p && !q.newer && !mine.includes(q));
  const complete = mine.length + moved.length === qtos.length;
  const side: SyncTakeoff[] = mine.map((q) => ({ id: q.id, model: buildQtoModel(q.p!.store, null) }));
  const totals = takeoffTotals(side);
  let boq = buildModel(est.store, admins);
  const add = additionalOps(boq, est.store, side, totals, complete);
  // (older apps would empty these lines' Take-off figures: the estimate is marked format 4 first)
  if (add.length) { est.needFormat?.(FORMAT_V16); wrote += putAll(est, add, 'Additional items from the take-off'); boq = buildModel(est.store, admins); }
  if (complete) wrote += putAll(est, takeoffQtyOps(boq, est.store, totals, takeoffMeasures(side)), 'Take-off quantities');
  for (const q of mine) if (!q.p!.readOnly) wrote += putAll(q.p!, mirrorOps(boq, q.p!.store), 'BOQ copy updated');
  return { wrote, complete };
}

/** what an estimator changes about an additional item's line from the take-off (BOQ tab, inside the estimate) */
export interface LineChange { desc?: string; unit?: string; ref?: string; loc?: string; bill?: string }
/**
 * The estimate's ops for it: the line is the estimator's from then on (bridge rule above). A new bill:
 * the line goes to the end of that bill's "Additional items (QS)" heading (made if needed).
 */
export function lineEditOps(boq: BoqModel, est: Store, lineId: string, c: LineChange): Op[] {
  const n = boq.byId.get(lineId);
  if (!n) return [];
  const ops: Op[] = [];
  const set = (f: string, v: string | undefined, cur: string) => { if (v !== undefined && v.trim() !== cur) ops.push([lineId, f, v.trim() || null]); };
  if (c.desc !== undefined && c.desc.trim()) set('desc', c.desc, n.desc);
  set('unit', c.unit, n.unit);
  set('ref', c.ref, n.ref);
  set('qloc', c.loc, n.qa?.loc ?? '');
  if (c.bill !== undefined) {
    const bills = new Set(billsOf(boq).map((b) => b.id));
    const bill = bills.has(c.bill) ? c.bill : null;
    const gid = qaGroupId(bill);
    if (n.parent !== gid) {
      const g = boq.byId.get(gid);
      if (!g) {
        const ent = est.ents.get(gid);
        const kids = bill ? boq.byId.get(bill)?.children ?? [] : boq.roots.filter((r) => r.id !== UNFILED);
        if (!ent || !ent.has('type')) ops.push([gid, 'type', 'group'], [gid, 'parent', bill], [gid, 'ord', endKey(kids.reduce<string | null>((a, x) => (!a || x.ord > a ? x.ord : a), null))], [gid, 'ref', null], [gid, 'desc', QA_GROUP_DESC], [gid, 'qa', 'g']);
        ops.push([gid, 'del', null], [gid, 'qdel', null]);
      }
      const last = (g?.children ?? []).reduce<string | null>((a, x) => (!a || x.ord > a ? x.ord : a), null);
      ops.push([lineId, 'parent', gid], [lineId, 'ord', endKey(last)]);
    }
  }
  return ops;
}

/**
 * what changed in a project folder: the size of each journal - its writer's presence file says it, else the
 * file's own size. (A writer reuses its journal from one session to the next, and a presence file is
 * removed some minutes after its app closed: a QS who worked while no estimator's app was looking left the
 * same journal names behind - only the sizes tell.) `idle`: sizes of journals without a presence file, read
 * once and kept by the caller (such a journal only grows while its writer's presence file is there).
 * (v0.16, the background sync: EstSync.tsx)
 */
export async function folderSig(fs: FsApi, dir: string, idle?: Map<string, number>): Promise<string | null> {
  try {
    if (!(await fs.exists(dir))) return null;
    const live = new Map<string, number>();
    for (const p of await fs.list(fs.join(dir, 'presence'))) {
      if (p.isDir || !p.name.endsWith('.json')) continue;
      const t = await fs.readText(fs.join(dir, 'presence', p.name)).catch(() => null);
      try { const i = t ? JSON.parse(t) : null; if (i?.seg) live.set(String(i.seg), Number(i.size) || 0); } catch { /* being written */ }
    }
    const parts: string[] = [];
    for (const j of await fs.list(fs.join(dir, 'journals'))) {
      if (j.isDir || !j.name.endsWith('.log')) continue;
      const path = fs.join(dir, 'journals', j.name);
      let size = live.get(j.name);
      if (size !== undefined) { live.delete(j.name); idle?.delete(path); }
      else {
        size = idle?.get(path);
        if (size === undefined) { size = (await fs.readFrom(path, 0, 0))?.size ?? 0; idle?.set(path, size); }
      }
      parts.push(j.name + ':' + size);
    }
    for (const [seg, size] of live) parts.push(seg + ':' + size);
    return parts.sort().join('|');
  } catch {
    return null;
  }
}

